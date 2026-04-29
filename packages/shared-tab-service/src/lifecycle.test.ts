import { afterEach, describe, expect, it } from 'vitest';
import type { Hub } from 'tab-election/hub';
import { createSharedTabService, type SharedTabService } from './index.js';
import {
  LifecycleManager,
  type ConnectedSpoke,
  type SubscriberCounts,
} from './lifecycle.js';

/**
 * End-to-end tests for the heartbeat + subscriber-tracking layer described in
 * docs/proposals/spoke-heartbeat-and-subscriber-tracking.md.
 *
 * The aggregate counts and the `Service.onSubscribersChanged` hook are what
 * services use to lazily start and stop upstream work (e.g. open a WebSocket
 * only while at least one tab subscribes to a given event). These tests
 * exercise that contract over the real Hub + Spoke transport.
 */

const flush = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

const waitFor = async (
  predicate: () => boolean,
  { timeoutMs = 1500, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out');
    }
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

interface TickerEvents extends Record<string, unknown> {
  tick: { n: number };
  other: { ok: boolean };
}

interface TickerCalls {
  starts: number;
  stops: number;
  changes: Array<{ counts: SubscriberCounts; eventName: string }>;
}

const makeTickerService = (
  calls: TickerCalls,
): SharedTabService<'ticker', TickerEvents> & {
  hub?: Hub;
  current(): Promise<number>;
} => {
  let n = 0;
  return {
    namespace: 'ticker',
    init(hub: Hub) {
      this.hub = hub;
    },
    onSubscribersChanged(counts: SubscriberCounts, eventName: string) {
      calls.changes.push({ counts: { ...counts }, eventName });
      if (eventName !== 'tick') return;
      if (counts.spokes > 0 && calls.starts === calls.stops) calls.starts += 1;
      else if (counts.spokes === 0 && calls.starts > calls.stops) calls.stops += 1;
    },
    async current() {
      return n;
    },
  };
};

const getHubLifecycle = (
  client: { __lifecycle?: unknown } & { isLeader: boolean },
): LifecycleManager => {
  // The in-tab Hub stashes the manager on itself. The client doesn't expose the
  // hub directly, so dig in via the global state — but only the leader has the
  // manager, so we tap through the spoke's worker reference. We can't reach it
  // cleanly without going through internals; instead, drive the test through
  // observable behavior (counts via service hook + getConnectedSpokes via the
  // exposed __lifecycle on the elected hub). The simpler path: each test
  // creates a single in-tab client whose own hub is the leader; we can fetch
  // the manager off the underlying Hub via the unique name lookup.
  // To keep the tests black-box, we expose the manager through a side-channel:
  // we capture it via the service.init hook below in tests that need it.
  void client;
  throw new Error('use captureHub() instead');
};
void getHubLifecycle;

interface CaptureBox {
  hub?: Hub;
  manager?: LifecycleManager;
}

const captureService = (
  box: CaptureBox,
  namespace: 'cap',
): SharedTabService<'cap'> & { ping(): Promise<'pong'> } => ({
  namespace,
  init(hub: Hub) {
    box.hub = hub;
    const m = (hub as unknown as { __lifecycle?: LifecycleManager }).__lifecycle;
    if (m) box.manager = m;
  },
  async ping() {
    return 'pong' as const;
  },
});

describe('LifecycleManager (unit)', () => {
  const services = new Map<string, SharedTabService>();
  const settings = { intervalMs: 50, ttlMs: 120 };

  it('hello / hb update lastSeen and getConnectedSpokes', () => {
    let now = 1000;
    const m = new LifecycleManager(settings, services, () => now);
    m.hello('s1', '1.0.0');
    m.hello('s2');
    expect(m.getConnectedSpokeCount()).toBe(2);
    const spokes = m.getConnectedSpokes();
    expect(spokes.find((s) => s.id === 's1')?.version).toBe('1.0.0');

    now = 1100;
    m.hb('s1');
    const s1 = m.getConnectedSpokes().find((s: ConnectedSpoke) => s.id === 's1');
    expect(s1?.lastSeen).toBe(1100);
  });

  it('sub aggregates tabs (dedup per spoke) and listeners (sum)', () => {
    let now = 0;
    const m = new LifecycleManager(settings, services, () => now);
    m.hello('s1');
    m.hello('s2');

    m.sub('s1', 'ticker', 'tick', 1);
    expect(m.getSubscriberSpokeCount('ticker', 'tick')).toBe(1);
    expect(m.getListenerCount('ticker', 'tick')).toBe(1);

    m.sub('s1', 'ticker', 'tick', 3); // s1 added two more local listeners
    expect(m.getSubscriberSpokeCount('ticker', 'tick')).toBe(1);
    expect(m.getListenerCount('ticker', 'tick')).toBe(3);

    m.sub('s2', 'ticker', 'tick', 2);
    expect(m.getSubscriberSpokeCount('ticker', 'tick')).toBe(2);
    expect(m.getListenerCount('ticker', 'tick')).toBe(5);

    m.sub('s1', 'ticker', 'tick', 0); // s1 dropped to zero — tab count goes down
    expect(m.getSubscriberSpokeCount('ticker', 'tick')).toBe(1);
    expect(m.getListenerCount('ticker', 'tick')).toBe(2);
  });

  it('sweep expires spokes whose lastSeen is older than ttl, dropping their counts', () => {
    let now = 0;
    const calls: TickerCalls = { starts: 0, stops: 0, changes: [] };
    const svcMap = new Map<string, SharedTabService>();
    const ticker = makeTickerService(calls);
    svcMap.set('ticker', ticker);

    const m = new LifecycleManager({ intervalMs: 50, ttlMs: 100 }, svcMap, () => now);
    m.hello('crashed');
    m.sub('crashed', 'ticker', 'tick', 1);
    expect(calls.changes.at(-1)).toEqual({ counts: { spokes: 1, listeners: 1 }, eventName: 'tick' });

    // Time advances past TTL with no heartbeat — sweep evicts s1.
    now = 200;
    m.sweep();
    expect(m.getConnectedSpokeCount()).toBe(0);
    expect(m.getSubscriberSpokeCount('ticker', 'tick')).toBe(0);
    expect(calls.changes.at(-1)).toEqual({ counts: { spokes: 0, listeners: 0 }, eventName: 'tick' });
  });

  it('only fires onSubscribersChanged when aggregate actually changes', () => {
    let now = 0;
    const calls: TickerCalls = { starts: 0, stops: 0, changes: [] };
    const svcMap = new Map<string, SharedTabService>();
    svcMap.set('ticker', makeTickerService(calls));
    const m = new LifecycleManager(settings, svcMap, () => now);
    m.hello('s1');

    m.sub('s1', 'ticker', 'tick', 1);
    m.sub('s1', 'ticker', 'tick', 1); // no change
    m.sub('s1', 'ticker', 'tick', 1);
    expect(calls.changes).toHaveLength(1);
    expect(calls.changes[0]).toEqual({ counts: { spokes: 1, listeners: 1 }, eventName: 'tick' });
  });
});

describe('end-to-end: spoke heartbeat + subscriber tracking', () => {
  it('hub sees the spoke after a fresh client is created', async () => {
    const box: CaptureBox = {};
    const cap = captureService(box, 'cap');
    const calls: TickerCalls = { starts: 0, stops: 0, changes: [] };
    const ticker = makeTickerService(calls);

    const client = trackClient(
      createSharedTabService({
        name: 'lc-hello',
        services: { cap, ticker },
        heartbeat: { intervalMs: 60, ttlMs: 200 },
      }),
    );

    await client.cap.ping();
    await waitFor(() => box.manager !== undefined && box.manager.getConnectedSpokeCount() >= 1);
    expect(box.manager!.getConnectedSpokes().length).toBe(1);
  });

  it('tracks tabs / listeners and fires onSubscribersChanged on subscribe + unsubscribe', async () => {
    const box: CaptureBox = {};
    const cap = captureService(box, 'cap');
    const calls: TickerCalls = { starts: 0, stops: 0, changes: [] };
    const ticker = makeTickerService(calls);

    const client = trackClient(
      createSharedTabService({
        name: 'lc-hook',
        services: { cap, ticker },
        heartbeat: { intervalMs: 60, ttlMs: 300 },
      }),
    );

    await client.cap.ping();
    await waitFor(() => box.manager !== undefined);

    const off1 = client.ticker.on('tick', () => {});
    await waitFor(() => calls.starts === 1, { timeoutMs: 1000 });
    expect(box.manager!.getSubscriberSpokeCount('ticker', 'tick')).toBe(1);
    expect(box.manager!.getListenerCount('ticker', 'tick')).toBe(1);

    // Second listener in the same tab: tabs stays at 1, listeners goes to 2.
    const off2 = client.ticker.on('tick', () => {});
    await waitFor(() => box.manager!.getListenerCount('ticker', 'tick') === 2);
    expect(box.manager!.getSubscriberSpokeCount('ticker', 'tick')).toBe(1);
    expect(calls.starts).toBe(1); // tabs didn't transition; service does NOT restart

    // Unsubscribe one — still one listener left.
    off1();
    await waitFor(() => box.manager!.getListenerCount('ticker', 'tick') === 1);
    expect(box.manager!.getSubscriberSpokeCount('ticker', 'tick')).toBe(1);
    expect(calls.stops).toBe(0); // tabs still > 0

    // Last listener gone — tabs drops to 0, service stops.
    off2();
    await waitFor(() => calls.stops === 1, { timeoutMs: 1000 });
    expect(box.manager!.getSubscriberSpokeCount('ticker', 'tick')).toBe(0);
    expect(box.manager!.getListenerCount('ticker', 'tick')).toBe(0);
  });

  it('two clients sharing a hub aggregate to tabs=2 and partition correctly on close', async () => {
    // Both hubs run with the same name, so leader election picks one. Whichever
    // wins runs its services' init — and both captureServices share `box`, so
    // we always pick up the elected hub's manager.
    const box: CaptureBox = {};
    const calls: TickerCalls = { starts: 0, stops: 0, changes: [] };
    const ticker1 = makeTickerService(calls);
    const ticker2 = makeTickerService({ starts: 0, stops: 0, changes: [] });

    const a = trackClient(
      createSharedTabService({
        name: 'lc-multi',
        services: { cap: captureService(box, 'cap'), ticker: ticker1 },
        heartbeat: { intervalMs: 60, ttlMs: 300 },
      }),
    );
    const b = trackClient(
      createSharedTabService({
        name: 'lc-multi',
        services: { cap: captureService(box, 'cap'), ticker: ticker2 },
        heartbeat: { intervalMs: 60, ttlMs: 300 },
      }),
    );

    await a.cap.ping();
    await b.cap.ping();
    await waitFor(() => box.manager !== undefined && box.manager.getConnectedSpokeCount() >= 2);

    a.ticker.on('tick', () => {});
    b.ticker.on('tick', () => {});
    await waitFor(() => box.manager!.getSubscriberSpokeCount('ticker', 'tick') === 2, {
      timeoutMs: 1500,
    });
    expect(box.manager!.getListenerCount('ticker', 'tick')).toBe(2);

    // Close the FOLLOWER. Closing the leader would tear down the manager and
    // trigger leader transition; that scenario is intentionally out of scope.
    const follower = a.isLeader ? b : a;
    follower.close();
    openClients = openClients.filter((c) => c !== follower);
    await waitFor(() => box.manager!.getSubscriberSpokeCount('ticker', 'tick') === 1, {
      timeoutMs: 1500,
    });
    expect(box.manager!.getConnectedSpokeCount()).toBe(1);
  });

  it('crash safety: a spoke that stops heartbeating is reclaimed within the TTL window', async () => {
    const box: CaptureBox = {};
    const cap = captureService(box, 'cap');
    const calls: TickerCalls = { starts: 0, stops: 0, changes: [] };
    const ticker = makeTickerService(calls);

    const client = trackClient(
      createSharedTabService({
        name: 'lc-crash',
        services: { cap, ticker },
        heartbeat: { intervalMs: 40, ttlMs: 120 },
      }),
    );

    await client.cap.ping();
    client.ticker.on('tick', () => {});
    await waitFor(() => calls.starts === 1, { timeoutMs: 1000 });

    // Simulate a hard tab crash on the spoke side: kill heartbeats, do NOT
    // send `bye`. The hub must reclaim the spoke purely from the missed
    // heartbeats, dropping the listener count to zero and triggering stop.
    const lc = (client as unknown as { __lifecycle: { simulateCrash(): void } }).__lifecycle;
    lc.simulateCrash();

    await waitFor(() => calls.stops === 1, { timeoutMs: 1500 });
    expect(box.manager!.getSubscriberSpokeCount('ticker', 'tick')).toBe(0);
    expect(box.manager!.getConnectedSpokeCount()).toBe(0);
  });

  it('clean close removes the spoke without waiting for the TTL', async () => {
    const box: CaptureBox = {};
    const cap = captureService(box, 'cap');
    const calls: TickerCalls = { starts: 0, stops: 0, changes: [] };
    const ticker = makeTickerService(calls);

    const client = trackClient(
      createSharedTabService({
        name: 'lc-bye',
        services: { cap, ticker },
        heartbeat: { intervalMs: 1000, ttlMs: 5000 }, // long TTL — only a bye can clear it
      }),
    );

    await client.cap.ping();
    client.ticker.on('tick', () => {});
    await waitFor(() => calls.starts === 1, { timeoutMs: 1000 });

    client.close();
    openClients = openClients.filter((c) => c !== client);

    await waitFor(() => calls.stops === 1, { timeoutMs: 500 });
    expect(box.manager!.getConnectedSpokeCount()).toBe(0);
  });

  it('heartbeat: false disables tracking entirely', async () => {
    const box: CaptureBox = {};
    const cap = captureService(box, 'cap');
    const calls: TickerCalls = { starts: 0, stops: 0, changes: [] };
    const ticker = makeTickerService(calls);

    const client = trackClient(
      createSharedTabService({
        name: 'lc-off',
        services: { cap, ticker },
        heartbeat: false,
      }),
    );

    await client.cap.ping();
    client.ticker.on('tick', () => {});
    await flush(80);
    expect(box.manager).toBeUndefined();
    expect(calls.starts).toBe(0);
  });
});

describe('non-batching path also tracks listener counts', () => {
  it('counts listeners attached via the direct stub (batch: false)', async () => {
    const box: CaptureBox = {};
    const cap = captureService(box, 'cap');
    const calls: TickerCalls = { starts: 0, stops: 0, changes: [] };
    const ticker = makeTickerService(calls);

    const client = trackClient(
      createSharedTabService({
        name: 'lc-direct',
        services: { cap, ticker },
        batch: false,
        heartbeat: { intervalMs: 60, ttlMs: 300 },
      }),
    );

    await client.cap.ping();
    const off = client.ticker.on('tick', () => {});
    await waitFor(() => calls.starts === 1, { timeoutMs: 1000 });
    expect(box.manager!.getListenerCount('ticker', 'tick')).toBe(1);
    off();
    await waitFor(() => calls.stops === 1, { timeoutMs: 1000 });
    expect(box.manager!.getSubscriberSpokeCount('ticker', 'tick')).toBe(0);
  });
});
