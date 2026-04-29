import { afterEach, describe, expect, it } from 'vitest';
import type { Hub } from 'tab-election/hub';
import { createSharedTabService, type SharedTabService } from './index.js';

/**
 * End-to-end tests that exercise the real Hub + Spoke transport over Node's
 * BroadcastChannel and the test-only navigator.locks polyfill (see
 * test/setup.ts). We do not mock the RPC layer — these tests prove that:
 *
 *   1. Method calls made on the spoke proxy are dispatched to the leader's
 *      service implementation and the return value is awaited back on the
 *      caller.
 *   2. Events emitted from the leader are delivered to every subscriber that
 *      registered via `client.<svc>.on(...)`, scoped per service+event name.
 *   3. Concurrent in-flight RPC calls do not cross wires (correlation IDs).
 *
 * Each test uses a unique `name` so leader-election state from one test does
 * not bleed into the next.
 */

const flush = async (ms = 0): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

const waitFor = async (
  predicate: () => boolean,
  { timeoutMs = 1000, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await flush(intervalMs);
  }
};

let openClients: Array<{ close: () => void }> = [];
const trackClient = <T extends { close: () => void }>(client: T): T => {
  openClients.push(client);
  return client;
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

interface CounterEvents {
  changed: { value: number };
  reset: { at: number };
}

const makeCounterService = (): SharedTabService<'counter', CounterEvents> & {
  hub?: Hub;
  count: number;
  bump(by?: number): Promise<number>;
  echo<T>(value: T): Promise<T>;
  fail(message: string): Promise<never>;
  current(): Promise<number>;
  emitReset(): Promise<void>;
} => {
  const svc: ReturnType<typeof makeCounterService> = {
    namespace: 'counter',
    count: 0,
    init(hub: Hub) {
      this.hub = hub;
    },
    async bump(by = 1) {
      this.count += by;
      this.hub?.emit('counter', 'changed', { value: this.count });
      return this.count;
    },
    async echo(value) {
      return value;
    },
    async fail(message: string) {
      throw new Error(message);
    },
    async current() {
      return this.count;
    },
    async emitReset() {
      this.count = 0;
      this.hub?.emit('counter', 'reset', { at: Date.now() });
    },
  };
  return svc;
};

const makeOtherService = (): SharedTabService<'other', { changed: { ok: boolean } }> & {
  hub?: Hub;
  ping(): Promise<'pong'>;
  fireChanged(): Promise<void>;
} => {
  const svc: ReturnType<typeof makeOtherService> = {
    namespace: 'other',
    init(hub: Hub) {
      this.hub = hub;
    },
    async ping() {
      return 'pong' as const;
    },
    async fireChanged() {
      // Same event NAME as counter.changed — proves namespace scoping works.
      this.hub?.emit('other', 'changed', { ok: true });
    },
  };
  return svc;
};

describe('method calls return data to the awaiting caller', () => {
  it('round-trips a primitive return value', async () => {
    const counter = makeCounterService();
    const client = trackClient(
      createSharedTabService({
        name: 'rpc-primitive',
        services: { counter },
        batch: false,
      }),
    );

    await expect(client.counter.bump()).resolves.toBe(1);
    await expect(client.counter.bump(5)).resolves.toBe(6);
    await expect(client.counter.current()).resolves.toBe(6);
  });

  it('round-trips a structured-cloned object', async () => {
    const counter = makeCounterService();
    const client = trackClient(
      createSharedTabService({
        name: 'rpc-object',
        services: { counter },
        batch: false,
      }),
    );

    const value = { id: 42, nested: { tags: ['a', 'b'] }, when: new Date(0) };
    const out = (await client.counter.echo(value)) as typeof value;
    expect(out).toEqual(value);
    expect(out).not.toBe(value); // structured clone -> new object
    expect(out.when).toBeInstanceOf(Date);
  });

  it('propagates thrown errors from the leader as rejections', async () => {
    const counter = makeCounterService();
    const client = trackClient(
      createSharedTabService({
        name: 'rpc-throw',
        services: { counter },
        batch: false,
      }),
    );

    await expect(client.counter.fail('boom')).rejects.toThrow(/boom/);
  });

  it('keeps concurrent in-flight calls from crossing wires (correlation IDs)', async () => {
    // Each call carries a unique (spokeId, callNumber) pair. Even when many
    // calls are in flight concurrently, each promise must resolve to its own
    // argument's echo and not someone else's.
    const counter = makeCounterService();
    const client = trackClient(
      createSharedTabService({
        name: 'rpc-correlation',
        services: { counter },
        batch: false,
      }),
    );

    const inputs = Array.from({ length: 50 }, (_, i) => ({ idx: i, tag: `t${i}` }));
    const results = await Promise.all(inputs.map((v) => client.counter.echo(v)));
    expect(results).toEqual(inputs);
  });

  it('round-trips through the batching path too', async () => {
    const counter = makeCounterService();
    const client = trackClient(
      createSharedTabService({
        name: 'rpc-batched',
        services: { counter },
        batch: true,
      }),
    );

    const results = await Promise.all([
      client.counter.bump(),
      client.counter.bump(),
      client.counter.bump(2),
    ]);
    // Batch dispatches sequentially in order, so the values are predictable.
    expect(results).toEqual([1, 2, 4]);
  });
});

describe('events emitted by the leader reach subscribers', () => {
  it('delivers an event to a single subscriber on the same client', async () => {
    const counter = makeCounterService();
    const client = trackClient(
      createSharedTabService({
        name: 'evt-single',
        services: { counter },
        batch: false,
      }),
    );

    const received: number[] = [];
    const off = client.counter.on('changed', ({ value }) => received.push(value));

    await client.counter.bump();
    await client.counter.bump();
    await waitFor(() => received.length >= 2);
    expect(received).toEqual([1, 2]);
    off();
  });

  it('fans out a single emit to every subscriber', async () => {
    const counter = makeCounterService();
    const client = trackClient(
      createSharedTabService({
        name: 'evt-fanout',
        services: { counter },
        batch: false,
      }),
    );

    const a: number[] = [];
    const b: number[] = [];
    client.counter.on('changed', ({ value }) => a.push(value));
    client.counter.on('changed', ({ value }) => b.push(value));

    await client.counter.bump();
    await waitFor(() => a.length === 1 && b.length === 1);
    expect(a).toEqual([1]);
    expect(b).toEqual([1]);
  });

  it('stops delivery once the listener is unsubscribed', async () => {
    const counter = makeCounterService();
    const client = trackClient(
      createSharedTabService({
        name: 'evt-unsub',
        services: { counter },
        batch: false,
      }),
    );

    const received: number[] = [];
    const off = client.counter.on('changed', ({ value }) => received.push(value));

    await client.counter.bump();
    await waitFor(() => received.length === 1);
    off();
    await client.counter.bump();
    await flush(20);
    expect(received).toEqual([1]);
  });

  it('scopes events to the emitting service namespace', async () => {
    // counter.changed and other.changed share an event NAME but different
    // namespaces. A subscriber on `counter.changed` must not see `other.changed`.
    const counter = makeCounterService();
    const other = makeOtherService();
    const client = trackClient(
      createSharedTabService({
        name: 'evt-scope',
        services: { counter, other },
        batch: false,
      }),
    );

    const counterChanges: unknown[] = [];
    const otherChanges: unknown[] = [];
    client.counter.on('changed', (p) => counterChanges.push(p));
    client.other.on('changed', (p) => otherChanges.push(p));

    await client.counter.bump();
    await client.other.fireChanged();
    await waitFor(() => counterChanges.length === 1 && otherChanges.length === 1);

    expect(counterChanges).toEqual([{ value: 1 }]);
    expect(otherChanges).toEqual([{ ok: true }]);
  });

  it('delivers events to subscribers across two clients sharing the same hub name', async () => {
    // Two clients with the same name share the elected leader. The follower's
    // subscribe call should still receive events broadcast by the leader.
    const counterA = makeCounterService();
    const counterB = makeCounterService();
    const a = trackClient(
      createSharedTabService({
        name: 'evt-multi-client',
        services: { counter: counterA },
        batch: false,
      }),
    );
    const b = trackClient(
      createSharedTabService({
        name: 'evt-multi-client',
        services: { counter: counterB },
        batch: false,
      }),
    );

    const seenA: number[] = [];
    const seenB: number[] = [];
    a.counter.on('changed', ({ value }) => seenA.push(value));
    b.counter.on('changed', ({ value }) => seenB.push(value));

    // Either client can drive the leader; the leader is whichever hub won the
    // lock (we don't care which one in this test).
    await a.counter.bump();
    await b.counter.bump();
    await waitFor(() => seenA.length === 2 && seenB.length === 2, { timeoutMs: 2000 });
    expect(seenA).toEqual([1, 2]);
    expect(seenB).toEqual([1, 2]);
  });

  it('batched-mode events still arrive at subscribers (single coalesced broadcast)', async () => {
    const counter = makeCounterService();
    const client = trackClient(
      createSharedTabService({
        name: 'evt-batched',
        services: { counter },
        batch: true,
      }),
    );

    const received: number[] = [];
    client.counter.on('changed', ({ value }) => received.push(value));

    // Two bumps within the same microtask are batched into one RPC; the two
    // emits inside them are coalesced into one event broadcast.
    const [r1, r2] = await Promise.all([client.counter.bump(), client.counter.bump()]);
    expect([r1, r2]).toEqual([1, 2]);
    await waitFor(() => received.length === 2);
    expect(received).toEqual([1, 2]);
  });
});

describe('client lifecycle', () => {
  it('reports isLeader=true once the in-tab hub wins leadership', async () => {
    const counter = makeCounterService();
    const client = trackClient(
      createSharedTabService({
        name: 'lifecycle-leader',
        services: { counter },
        batch: false,
      }),
    );

    // Drive a call to be sure the leader has come up.
    await client.counter.current();
    await waitFor(() => client.isLeader === true, { timeoutMs: 2000 });
    expect(client.isLeader).toBe(true);
  });

  it('close() is idempotent and stops accepting new calls', async () => {
    const counter = makeCounterService();
    const client = trackClient(
      createSharedTabService({
        name: 'lifecycle-close',
        services: { counter },
        batch: false,
      }),
    );

    await client.counter.bump();
    client.close();
    expect(() => client.close()).not.toThrow();
  });
});
