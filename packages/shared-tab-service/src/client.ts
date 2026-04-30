import { Hub, Spoke, type ServiceStub } from 'tab-election/hub';
import {
  BATCH_EVENT,
  BATCH_METHOD,
  BATCH_NAMESPACE,
  type BatchCall,
  type BatchOption,
  type BatchResult,
  type BatchSettings,
  type BatchedEvent,
  resolveBatchSettings,
} from './batch.js';
import { LeaderChangedError, failPendingCalls } from './errors.js';
import { registerWithBatching } from './hub.js';
import {
  LIFECYCLE_NAMESPACE,
  SpokeLifecycle,
  resolveHeartbeatSettings,
  type HeartbeatOption,
  type HeartbeatSettings,
} from './lifecycle.js';
import type { SharedTabService } from './service.js';

/**
 * Manifest of `ns -> set of idempotent method names`, derived from the
 * static services record. Only populated when `services` is provided as a
 * record (not a function); async-resolved services skip retry entirely.
 */
type IdempotentManifest = Map<string, Set<string>>;

const buildIdempotentManifest = (services: ServicesInput): IdempotentManifest => {
  const out: IdempotentManifest = new Map();
  if (typeof services === 'function') return out;
  for (const [ns, svc] of Object.entries(services)) {
    const list = (svc as { __idempotent?: ReadonlyArray<string> }).__idempotent;
    if (Array.isArray(list) && list.length > 0) out.set(ns, new Set(list));
  }
  return out;
};

const isIdempotent = (m: IdempotentManifest, ns: string, method: string): boolean =>
  m.get(ns)?.has(method) ?? false;

/**
 * Wait for the next `onLeaderChange` event, with a short fallback so we don't
 * hang forever if the spoke never observes one (e.g. follower whose hub never
 * gets elected). The retry is a best-effort — if a new leader exists by the
 * time we re-issue, the call goes through; otherwise tab-election's own retry
 * loop in Tab.call covers us.
 */
const waitForLeaderSettle = (spoke: Spoke, fallbackMs = 250): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const off = spoke.onLeaderChange(() => {
      if (done) return;
      done = true;
      off();
      resolve();
    });
    setTimeout(() => {
      if (done) return;
      done = true;
      off();
      resolve();
    }, fallbackMs);
  });

export type ServicesRecord = { [K in string]: SharedTabService<K> };
export type ServicesInput = ServicesRecord | (() => Promise<ServicesRecord>);

type Resolve<S> = S extends () => Promise<infer R> ? R : S;
type Client<S> = S extends ServicesRecord ? { [K in keyof S]: ServiceStub<S[K]> } : never;

export interface SharedTabClient {
  readonly isLeader: boolean;
  onLeaderChange(listener: (isLeader: boolean) => void): () => void;
  close(): void;
}

export type CreatedClient<S extends ServicesInput> = Client<Resolve<S>> & SharedTabClient;

export interface CreateSharedTabServiceOptions<S extends ServicesInput> {
  name: string;
  version?: string;
  /** Record of services keyed by their namespace. The key is authoritative — it's used both as the client property name and as the runtime namespace. */
  services: S;
  /** URL of a worker entry that calls `runSharedTabHub`. When set and supported, the service runs in a SharedWorker (or dedicated Worker) instead of the elected tab. */
  workerUrl?: string | URL;
  /** Default `true`. Set `false` to force the dedicated-Worker or in-tab fallback even when SharedWorker is available. */
  useSharedWorker?: boolean;
  /** Default `true`. Set `false` to skip the dedicated-Worker fallback and go straight to in-tab hub when SharedWorker is unavailable. */
  useDedicatedWorker?: boolean;
  /** Default `true`. Coalesces RPC calls and events into batched messages. Pass `false` to opt out, or `{ flushMs }` to flush on a timer (default `0` = microtask). */
  batch?: BatchOption;
  /** Default `true`. Spoke heartbeat + listener-count tracking. Pass `false` to disable. */
  heartbeat?: HeartbeatOption;
}

const isBrowserLike = (): boolean =>
  typeof self !== 'undefined' &&
  typeof BroadcastChannel !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  typeof (navigator as Navigator & { locks?: unknown }).locks !== 'undefined';
const hasSharedWorker = (): boolean => typeof SharedWorker !== 'undefined';
const hasDedicatedWorker = (): boolean => typeof Worker !== 'undefined';

async function resolveServices(services: ServicesInput): Promise<ServicesRecord> {
  return typeof services === 'function' ? await services() : services;
}

function stubClient(reason: string): CreatedClient<ServicesInput> {
  const err = () => Promise.reject(new Error(`shared-tab-service: ${reason}`));
  const serviceStub = new Proxy(
    {},
    {
      get: (_, prop) => {
        if (prop === 'on') return () => () => {};
        return err;
      },
    },
  );
  const client = new Proxy(
    {},
    {
      get: (_, prop) => {
        if (prop === 'close') return () => {};
        if (prop === 'isLeader') return false;
        if (prop === 'onLeaderChange') return () => () => {};
        return serviceStub;
      },
    },
  );
  return client as CreatedClient<ServicesInput>;
}

interface QueuedCall {
  ns: string;
  method: string;
  args: unknown[];
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  retried?: boolean;
}

type BatchStub = ServiceStub<
  SharedTabService & { [BATCH_METHOD]: (calls: BatchCall[]) => Promise<BatchResult[]> }
>;

type LifecycleStub = {
  hello(args: { spokeId: string; version?: string }): Promise<void>;
  hb(args: { spokeId: string }): Promise<void>;
  sub(args: { spokeId: string; ns: string; event: string; count: number }): Promise<void>;
  bye(args: { spokeId: string }): Promise<void>;
};

/** Build a fire-and-forget dispatcher that goes straight through the tab-election RPC,
 *  bypassing user-level batching so lifecycle traffic can't be starved by it. */
function makeLifecycleDispatch(spoke: Spoke): (method: string, args: unknown) => void {
  const stub = spoke.getService(LIFECYCLE_NAMESPACE) as unknown as LifecycleStub;
  return (method, args) => {
    const fn = (stub as unknown as Record<string, (a: unknown) => Promise<void>>)[method];
    if (typeof fn !== 'function') return;
    fn.call(stub, args).catch(() => {
      /* fire-and-forget */
    });
  };
}

function buildBatchingProxy(
  spoke: Spoke,
  settings: BatchSettings,
  lifecycle: SpokeLifecycle | undefined,
  idempotent: IdempotentManifest,
  close: () => void,
): Record<string, unknown> {
  const batchStub = spoke.getService(BATCH_NAMESPACE) as BatchStub;

  let queue: QueuedCall[] = [];
  let flushScheduled = false;

  const flush = async (): Promise<void> => {
    flushScheduled = false;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    const calls: BatchCall[] = batch.map((c) => ({ ns: c.ns, method: c.method, args: c.args }));
    try {
      const results = await batchStub[BATCH_METHOD](calls);
      for (let i = 0; i < batch.length; i += 1) {
        const r = results[i];
        const q = batch[i];
        if (!q) continue;
        if (r && r.ok) q.resolve(r.value);
        else q.reject(new Error(r && !r.ok ? r.error : 'shared-tab-service: missing batch result'));
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      // The whole batch lost its leader. Per-item idempotent calls retry once
      // against the new leader; non-idempotent calls surface the error.
      if (e instanceof LeaderChangedError) {
        await waitForLeaderSettle(spoke);
        for (const q of batch) {
          if (isIdempotent(idempotent, q.ns, q.method) && !q.retried) {
            q.retried = true;
            queue.push(q);
            scheduleFlush();
          } else {
            q.reject(e);
          }
        }
        return;
      }
      for (const q of batch) q.reject(e);
    }
  };

  const scheduleFlush = (): void => {
    if (flushScheduled) return;
    flushScheduled = true;
    if (settings.flushMs <= 0) queueMicrotask(flush);
    else setTimeout(flush, settings.flushMs);
  };

  const enqueueCall = (ns: string, method: string, args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      queue.push({ ns, method, args, resolve, reject });
      scheduleFlush();
    });

  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  (
    batchStub as unknown as {
      on: (event: typeof BATCH_EVENT, handler: (batch: BatchedEvent[]) => void) => () => void;
    }
  ).on(BATCH_EVENT, (batch) => {
    for (const evt of batch) {
      const set = listeners.get(`${evt.ns}:${evt.event}`);
      if (set) for (const fn of set) fn(evt.payload);
    }
  });

  const subscribe = (
    ns: string,
    event: string,
    handler: (payload: unknown) => void,
  ): (() => void) => {
    const key = `${ns}:${event}`;
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(handler);
    const release = lifecycle?.trackSubscribe(ns, event);
    return () => {
      set?.delete(handler);
      release?.();
    };
  };

  const stubCache = new Map<string, unknown>();
  const getServiceProxy = (ns: string): unknown => {
    const cached = stubCache.get(ns);
    if (cached) return cached;
    const proxy = new Proxy(Object.create(null) as Record<string, unknown>, {
      get(_, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop === 'on') {
          return (event: string, handler: (payload: unknown) => void) =>
            subscribe(ns, event, handler);
        }
        return (...args: unknown[]) => enqueueCall(ns, prop, args);
      },
    });
    stubCache.set(ns, proxy);
    return proxy;
  };

  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'close') return close;
      if (prop === 'isLeader') return spoke.isLeader;
      if (prop === 'onLeaderChange') return spoke.onLeaderChange.bind(spoke);
      if (prop === '__lifecycle') return lifecycle;
      return getServiceProxy(prop);
    },
  }) as Record<string, unknown>;
}

function buildDirectProxy(
  spoke: Spoke,
  lifecycle: SpokeLifecycle | undefined,
  idempotent: IdempotentManifest,
  close: () => void,
): Record<string, unknown> {
  const stubCache = new Map<string, unknown>();
  const wrapMethodWithRetry =
    (ns: string, method: string, fn: (...args: unknown[]) => Promise<unknown>) =>
    async (...args: unknown[]): Promise<unknown> => {
      try {
        return await fn(...args);
      } catch (err) {
        if (err instanceof LeaderChangedError && isIdempotent(idempotent, ns, method)) {
          await waitForLeaderSettle(spoke);
          // Exactly one retry — any error from the retry (including a second
          // LeaderChangedError) propagates.
          return await fn(...args);
        }
        throw err;
      }
    };
  const getServiceProxy = (ns: string): unknown => {
    const cached = stubCache.get(ns);
    if (cached) return cached;
    const inner = spoke.getService(ns) as unknown as Record<string, unknown>;
    const wrapped = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'on') {
          if (!lifecycle) {
            const v = Reflect.get(target, prop) as
              | ((e: string, h: (p: unknown) => void) => () => void)
              | undefined;
            return typeof v === 'function' ? v.bind(target) : v;
          }
          return (event: string, handler: (payload: unknown) => void): (() => void) => {
            const off = (
              target as unknown as {
                on(e: string, h: (p: unknown) => void): () => void;
              }
            ).on(event, handler);
            const release = lifecycle.trackSubscribe(ns, event);
            return () => {
              try {
                off();
              } finally {
                release();
              }
            };
          };
        }
        const v = Reflect.get(target, prop);
        if (typeof v !== 'function') return v;
        if (typeof prop !== 'string') return v.bind(target);
        const bound = v.bind(target) as (...args: unknown[]) => Promise<unknown>;
        return wrapMethodWithRetry(ns, prop, bound);
      },
    });
    stubCache.set(ns, wrapped);
    return wrapped;
  };
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'close') return close;
      if (prop === 'isLeader') return spoke.isLeader;
      if (prop === 'onLeaderChange') return spoke.onLeaderChange.bind(spoke);
      if (prop === '__lifecycle') return lifecycle;
      return getServiceProxy(prop);
    },
  }) as Record<string, unknown>;
}

export function createSharedTabService<const S extends ServicesInput>(
  options: CreateSharedTabServiceOptions<S>,
): CreatedClient<S> {
  const {
    name,
    version,
    services,
    workerUrl,
    useSharedWorker = true,
    useDedicatedWorker = true,
    batch,
    heartbeat,
  } = options;

  const batchSettings = resolveBatchSettings(batch);
  const heartbeatSettings: HeartbeatSettings | null = resolveHeartbeatSettings(heartbeat);

  if (!isBrowserLike()) {
    return stubClient(
      'no browser runtime detected (BroadcastChannel unavailable) — service calls will reject',
    ) as CreatedClient<S>;
  }

  let spoke: Spoke;
  let inTabHub: Hub | undefined;

  const urlString = workerUrl instanceof URL ? workerUrl.href : workerUrl;

  if (urlString && useSharedWorker && hasSharedWorker()) {
    spoke = new Spoke({
      workerUrl: urlString,
      name,
      ...(version !== undefined ? { version } : {}),
      useSharedWorker: true,
    });
  } else if (urlString && useDedicatedWorker && hasDedicatedWorker()) {
    spoke = new Spoke({
      workerUrl: urlString,
      name,
      ...(version !== undefined ? { version } : {}),
      useSharedWorker: false,
    });
  } else {
    inTabHub = new Hub(
      async (hub) => {
        const record = await resolveServices(services);
        registerWithBatching(hub, record, batchSettings, heartbeatSettings);
      },
      name,
      version,
    );
    // Spoke unconditionally calls hub.setOptions({name, version}) which tears
    // down and re-runs leader election. With the values we just passed to the
    // Hub constructor, that re-election is redundant and races with the
    // in-flight one — patch it out when nothing actually changed.
    const originalSetOptions = inTabHub.setOptions.bind(inTabHub);
    inTabHub.setOptions = (opts) => {
      if (inTabHub!.name === opts.name && inTabHub!.version === opts.version) return;
      originalSetOptions(opts);
    };
    spoke = new Spoke({
      workerUrl: inTabHub,
      name,
      ...(version !== undefined ? { version } : {}),
    });
  }

  // Fast-fail: when the spoke observes a leader change, every entry in
  // tab-election's pending-call map represents an RPC waiting on a leader
  // that's gone. Drain them with LeaderChangedError instead of waiting out
  // the 30s baseline timeout. See docs/spec/20260430-leader-change-fast-fail.md.
  //
  // We must NOT drain on this spoke's very first election win when no prior
  // leader existed: the pending calls in `_callDeferreds` map to entries in
  // `_queuedCalls` which `tab-election` is about to process locally. The
  // Tab's `state` event fires only when *another* tab has broadcast leader
  // state to us, so it's a reliable "a prior leader exists/existed" signal.
  let everSawOtherLeader = false;
  const tabEvents = (spoke as unknown as { tab: EventTarget & { _hasLeaderCache?: boolean } }).tab;
  if (tabEvents) {
    tabEvents.addEventListener('state', () => {
      everSawOtherLeader = true;
    });
  }
  spoke.onLeaderChange((isLeader) => {
    if (isLeader && !everSawOtherLeader) return;
    failPendingCalls(spoke, new LeaderChangedError());
  });

  const idempotentManifest = buildIdempotentManifest(services);

  let lifecycle: SpokeLifecycle | undefined;
  if (heartbeatSettings) {
    lifecycle = new SpokeLifecycle(makeLifecycleDispatch(spoke), heartbeatSettings, version);
    lifecycle.start();
  }

  const close = (): void => {
    // If our in-tab hub IS the elected leader, the lifecycle manager lives in
    // this same JS context. Calling bye() locally is synchronous, so callers
    // see the spoke removed before close() returns. The async RPC bye is still
    // sent (it's harmless and necessary when another tab is leader), but for
    // the in-tab leader case the local call is what the test contract relies on.
    if (lifecycle && inTabHub) {
      const mgr = (inTabHub as unknown as { __lifecycle?: { bye(id: string): void } }).__lifecycle;
      if (mgr) mgr.bye(lifecycle.spokeId);
    }
    lifecycle?.stop();
    spoke.close();
    inTabHub?.close();
  };

  const client = batchSettings.enabled
    ? buildBatchingProxy(spoke, batchSettings, lifecycle, idempotentManifest, close)
    : buildDirectProxy(spoke, lifecycle, idempotentManifest, close);

  if (lifecycle) {
    Object.defineProperty(client, '__lifecycle', {
      value: lifecycle,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }

  return client as unknown as CreatedClient<S>;
}
