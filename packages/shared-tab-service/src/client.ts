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
import { registerWithBatching } from './hub.js';
import type { SharedTabService } from './service.js';

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
}

type BatchStub = ServiceStub<
  SharedTabService & { [BATCH_METHOD]: (calls: BatchCall[]) => Promise<BatchResult[]> }
>;

function buildBatchingProxy(
  spoke: Spoke,
  settings: BatchSettings,
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
    return () => {
      set?.delete(handler);
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
      return getServiceProxy(prop);
    },
  }) as Record<string, unknown>;
}

function buildDirectProxy(spoke: Spoke, close: () => void): Record<string, unknown> {
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'close') return close;
      if (prop === 'isLeader') return spoke.isLeader;
      if (prop === 'onLeaderChange') return spoke.onLeaderChange.bind(spoke);
      return spoke.getService(prop);
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
  } = options;

  const batchSettings = resolveBatchSettings(batch);

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
        registerWithBatching(hub, record, batchSettings);
      },
      name,
      version,
    );
    spoke = new Spoke({
      workerUrl: inTabHub,
      name,
      ...(version !== undefined ? { version } : {}),
    });
  }

  const close = (): void => {
    spoke.close();
    inTabHub?.close();
  };

  const client = batchSettings.enabled
    ? buildBatchingProxy(spoke, batchSettings, close)
    : buildDirectProxy(spoke, close);

  return client as unknown as CreatedClient<S>;
}
