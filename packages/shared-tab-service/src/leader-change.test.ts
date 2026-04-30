import { afterEach, describe, expect, it } from 'vitest';
import type { Hub } from 'tab-election/hub';
import {
  LeaderChangedError,
  createSharedTabService,
  defineService,
  type SharedTabService,
} from './index.js';
import { failPendingCalls } from './errors.js';

/**
 * Tests for the fast-fail-on-leader-change feature plus opt-in idempotent
 * retry. See docs/spec/20260430-leader-change-fast-fail.md.
 *
 * The model these tests follow: two clients sharing the same hub name. Their
 * in-tab Hubs race for the lock; one wins (leader), the other waits (follower).
 * Closing the leader releases the lock, the follower's Hub takes leadership,
 * and any RPCs the follower had in flight against the dead leader should
 * fail-fast (or transparently retry, for idempotent methods) — not wait out
 * tab-election's 30s baseline timeout.
 */

const flush = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

const waitFor = async (
  predicate: () => boolean,
  { timeoutMs = 1500, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await flush(intervalMs);
  }
};

let openClients: Array<{ close: () => void }> = [];
const trackClient = <T extends { close: () => void }>(c: T): T => {
  openClients.push(c);
  return c;
};

afterEach(() => {
  for (const c of openClients) {
    try {
      c.close();
    } catch {
      /* ignore */
    }
  }
  openClients = [];
});

describe('LeaderChangedError', () => {
  it('is an Error and tagged with code LEADER_CHANGED', () => {
    const err = new LeaderChangedError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LeaderChangedError);
    expect(err.name).toBe('LeaderChangedError');
    expect(err.code).toBe('LEADER_CHANGED');
  });
});

describe('failPendingCalls helper', () => {
  it('rejects every pending deferred and clears the map', () => {
    const rejected: Error[] = [];
    const fakeTab = {
      _callDeferreds: new Map<
        number,
        {
          resolve: (v: unknown) => void;
          reject: (e: Error) => void;
          timeout: ReturnType<typeof setTimeout>;
        }
      >(),
      _sentCalls: new Map<number, ReturnType<typeof setTimeout>>(),
    };
    const noopTimeout = setTimeout(() => {}, 999_999);
    fakeTab._callDeferreds.set(1, {
      resolve: () => {},
      reject: (e) => rejected.push(e),
      timeout: noopTimeout,
    });
    fakeTab._callDeferreds.set(2, {
      resolve: () => {},
      reject: (e) => rejected.push(e),
      timeout: setTimeout(() => {}, 999_999),
    });

    const err = new LeaderChangedError();
    failPendingCalls({ tab: fakeTab }, err);
    expect(rejected).toHaveLength(2);
    for (const e of rejected) expect(e).toBe(err);
    expect(fakeTab._callDeferreds.size).toBe(0);
  });

  it('is a no-op the second time (no double rejection)', () => {
    const rejected: Error[] = [];
    const fakeTab = {
      _callDeferreds: new Map<
        number,
        {
          resolve: (v: unknown) => void;
          reject: (e: Error) => void;
          timeout: ReturnType<typeof setTimeout>;
        }
      >(),
      _sentCalls: new Map<number, ReturnType<typeof setTimeout>>(),
    };
    fakeTab._callDeferreds.set(1, {
      resolve: () => {},
      reject: (e) => rejected.push(e),
      timeout: setTimeout(() => {}, 999_999),
    });

    failPendingCalls({ tab: fakeTab }, new LeaderChangedError());
    failPendingCalls({ tab: fakeTab }, new LeaderChangedError());
    expect(rejected).toHaveLength(1);
  });
});

interface SlowEvents {
  done: { id: number };
}

interface SvcState {
  /** When set, slow()/subscribe()/transfer() awaits this gate before resolving — lets us pin a call mid-flight. */
  gate?: Promise<void>;
  callCount: number;
  subscribeCount: number;
  transferCount: number;
}

const makeState = (): SvcState => ({ callCount: 0, subscribeCount: 0, transferCount: 0 });

const makeSlowService = (
  state: SvcState,
  opts: { idempotent?: ReadonlyArray<string> } = {},
): SharedTabService<'svc', SlowEvents> & {
  hub?: Hub;
  slow(id: number): Promise<number>;
  subscribe(symbol: string): Promise<{ ok: true; symbol: string }>;
  transfer(amount: number): Promise<{ ok: true; amount: number }>;
} => {
  const svc: ReturnType<typeof makeSlowService> = {
    namespace: 'svc',
    init(hub: Hub) {
      this.hub = hub;
    },
    async slow(id: number) {
      state.callCount += 1;
      if (state.gate) await state.gate;
      return id;
    },
    async subscribe(symbol: string) {
      state.subscribeCount += 1;
      if (state.gate) await state.gate;
      return { ok: true as const, symbol };
    },
    async transfer(amount: number) {
      state.transferCount += 1;
      if (state.gate) await state.gate;
      return { ok: true as const, amount };
    },
  };
  if (opts.idempotent) {
    Object.assign(svc, { __idempotent: opts.idempotent });
  }
  return svc;
};

/**
 * Two clients sharing the same name. Returns them tagged so the test can
 * identify which is currently leader.
 */
const makeTwoClientsSharingName = async <S extends Record<string, SharedTabService>>(
  name: string,
  servicesA: () => S,
  servicesB: () => S,
  opts: { batch?: boolean } = {},
): Promise<{
  a: ReturnType<typeof createSharedTabService<S>>;
  b: ReturnType<typeof createSharedTabService<S>>;
}> => {
  const a = trackClient(
    createSharedTabService<S>({
      name,
      services: servicesA(),
      batch: opts.batch ?? false,
      heartbeat: false,
    }),
  );
  // Wait for A to become leader before starting B, so B is deterministically
  // the follower.
  await waitFor(() => a.isLeader === true, { timeoutMs: 2000 });
  const b = trackClient(
    createSharedTabService<S>({
      name,
      services: servicesB(),
      batch: opts.batch ?? false,
      heartbeat: false,
    }),
  );
  return { a, b };
};

describe('direct path: fast-fail on leader change', () => {
  it('rejects in-flight follower calls with LeaderChangedError when the leader closes', async () => {
    const aState = makeState();
    const bState = makeState();
    const { a, b } = await makeTwoClientsSharingName(
      'leader-change-direct-fastfail',
      () => ({ svc: makeSlowService(aState) }),
      () => ({ svc: makeSlowService(bState) }),
    );

    // Pin three in-flight calls on B. The leader (A) accepts them but never
    // returns because we never resolve A's gate.
    let resolveAGate!: () => void;
    aState.gate = new Promise((r) => {
      resolveAGate = r;
    });

    const inflight = [b.svc.slow(1), b.svc.slow(2), b.svc.slow(3)] as Promise<unknown>[];
    // Wait until A has actually started processing — guarantees the calls are
    // past the queue/sent stages and sitting in the deferred map.
    await waitFor(() => aState.callCount === 3, { timeoutMs: 2000 });

    // Kill A. B's hub eventually wins the lock; before that, B's
    // onLeaderChange(true) handler drains the pending deferreds.
    a.close();

    const settled = await Promise.allSettled(inflight);
    for (const s of settled) {
      expect(s.status).toBe('rejected');
      if (s.status === 'rejected') {
        expect(s.reason).toBeInstanceOf(LeaderChangedError);
      }
    }

    // A's gate was never resolved, but the calls are unblocked on B's side.
    resolveAGate();
  });

  it('non-idempotent retry: caller sees LeaderChangedError and method is not re-invoked', async () => {
    const aState = makeState();
    const bState = makeState();
    const { a, b } = await makeTwoClientsSharingName(
      'leader-change-non-idempotent',
      () => ({ svc: makeSlowService(aState) }),
      () => ({ svc: makeSlowService(bState) }),
    );

    let resolveAGate!: () => void;
    aState.gate = new Promise((r) => {
      resolveAGate = r;
    });

    const inflight = b.svc.transfer(100);
    await waitFor(() => aState.callCount === 0 && aState.transferCount === 1, {
      timeoutMs: 2000,
    });

    a.close();

    await expect(inflight).rejects.toBeInstanceOf(LeaderChangedError);
    // transfer was NOT re-issued on the new leader (B's own hub).
    expect(bState.transferCount).toBe(0);

    resolveAGate();
  });
});

describe('idempotent retry', () => {
  it('happy path: marked-idempotent call survives a leader change without surfacing an error', async () => {
    const aState = makeState();
    const bState = makeState();
    const { a, b } = await makeTwoClientsSharingName(
      'leader-change-idempotent-happy',
      () => ({
        svc: makeSlowService(aState, { idempotent: ['subscribe'] }),
      }),
      () => ({
        svc: makeSlowService(bState, { idempotent: ['subscribe'] }),
      }),
    );

    let resolveAGate!: () => void;
    aState.gate = new Promise((r) => {
      resolveAGate = r;
    });

    const inflight = b.svc.subscribe('btc-usd');
    // The call hits A first; transfer/subscribe on A bumps subscribeCount even
    // though it never replies (gate held).
    await waitFor(() => aState.subscribeCount === 1, { timeoutMs: 2000 });

    a.close();

    // After the retry, the call resolves with the new leader (B)'s result.
    const result = await inflight;
    expect(result).toEqual({ ok: true, symbol: 'btc-usd' });
    // B re-executed subscribe (the contract of __idempotent).
    expect(bState.subscribeCount).toBe(1);

    resolveAGate();
  });

  it('flapping leader: retry fails with LeaderChangedError if the new leader also dies', async () => {
    const aState = makeState();
    const bState = makeState();
    const { a, b } = await makeTwoClientsSharingName(
      'leader-change-flapping',
      () => ({
        svc: makeSlowService(aState, { idempotent: ['subscribe'] }),
      }),
      () => ({
        svc: makeSlowService(bState, { idempotent: ['subscribe'] }),
      }),
    );

    // Pin the call on A.
    let resolveAGate!: () => void;
    aState.gate = new Promise((r) => {
      resolveAGate = r;
    });
    // Pin the (eventual) retry on B too — when B becomes leader the retry
    // runs against B's instance, and we want it stuck so we can flap again.
    let resolveBGate!: () => void;
    bState.gate = new Promise((r) => {
      resolveBGate = r;
    });

    const inflight = b.svc.subscribe('btc-usd');
    await waitFor(() => aState.subscribeCount === 1, { timeoutMs: 2000 });

    a.close();
    // Wait for B to take leadership and start running the retry.
    await waitFor(() => b.isLeader === true && bState.subscribeCount === 1, {
      timeoutMs: 2000,
    });

    // Now kill B too — the retry's leader is gone, and there's nobody else
    // to take over. We expect the second LeaderChangedError to propagate
    // (no infinite retry).
    b.close();

    await expect(inflight).rejects.toBeInstanceOf(LeaderChangedError);

    resolveAGate();
    resolveBGate();
  });

  it('non-leader-change errors on retry surface directly (no further retry)', async () => {
    const aState = makeState();
    const failOnB = defineService('svc', {
      __idempotent: ['boom'] as ReadonlyArray<string>,
      async boom() {
        throw new Error('app-level failure on new leader');
      },
    });
    const a = trackClient(
      createSharedTabService({
        name: 'leader-change-retry-app-error',
        services: { svc: makeSlowService(aState, { idempotent: ['boom'] }) },
        batch: false,
        heartbeat: false,
      }),
    );
    await waitFor(() => a.isLeader === true, { timeoutMs: 2000 });

    const b = trackClient(
      createSharedTabService({
        name: 'leader-change-retry-app-error',
        services: { svc: failOnB as unknown as SharedTabService<'svc'> },
        batch: false,
        heartbeat: false,
      }),
    );

    // Pin an in-flight `boom` against A.
    let resolveAGate!: () => void;
    aState.gate = new Promise((r) => {
      resolveAGate = r;
    });
    const inflight = (b as unknown as { svc: { boom: () => Promise<unknown> } }).svc.boom();
    await waitFor(() => aState.callCount === 0, { timeoutMs: 200 }).catch(() => {});

    a.close();

    await expect(inflight).rejects.toThrow(/app-level failure on new leader/);

    resolveAGate();
  });
});

describe('batched path', () => {
  it('flushed batch fast-fails with LeaderChangedError when leader dies', async () => {
    const aState = makeState();
    const bState = makeState();
    const { a, b } = await makeTwoClientsSharingName(
      'leader-change-batched-fastfail',
      () => ({ svc: makeSlowService(aState) }),
      () => ({ svc: makeSlowService(bState) }),
      { batch: true },
    );

    let resolveAGate!: () => void;
    aState.gate = new Promise((r) => {
      resolveAGate = r;
    });

    const inflight = Promise.all([b.svc.slow(1), b.svc.slow(2), b.svc.slow(3)]);
    await waitFor(() => aState.callCount > 0, { timeoutMs: 2000 });

    a.close();

    const result = await Promise.allSettled([inflight]);
    expect(result[0].status).toBe('rejected');
    if (result[0].status === 'rejected') {
      expect(result[0].reason).toBeInstanceOf(LeaderChangedError);
    }

    resolveAGate();
  });

  it('idempotent retry works through the batching path', async () => {
    const aState = makeState();
    const bState = makeState();
    const { a, b } = await makeTwoClientsSharingName(
      'leader-change-batched-idempotent',
      () => ({
        svc: makeSlowService(aState, { idempotent: ['subscribe'] }),
      }),
      () => ({
        svc: makeSlowService(bState, { idempotent: ['subscribe'] }),
      }),
      { batch: true },
    );

    let resolveAGate!: () => void;
    aState.gate = new Promise((r) => {
      resolveAGate = r;
    });

    const inflight = b.svc.subscribe('eth-usd');
    await waitFor(() => aState.subscribeCount === 1, { timeoutMs: 2000 });

    a.close();

    await expect(inflight).resolves.toEqual({ ok: true, symbol: 'eth-usd' });
    expect(bState.subscribeCount).toBe(1);

    resolveAGate();
  });
});
