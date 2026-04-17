import type { Hub } from 'tab-election/hub';
import {
  BATCH_EVENT,
  BATCH_METHOD,
  BATCH_NAMESPACE,
  type BatchCall,
  type BatchResult,
  type BatchSettings,
  type BatchedEvent,
} from './batch.js';
import { assignNamespace, type SharedTabService } from './service.js';

/**
 * Register a map of services on the hub. When batching is enabled, wraps each service's
 * init callback so it sees a hub whose `emit` coalesces into a single `__sts_batch:events`
 * broadcast, and registers a `__sts_batch:dispatch` meta-service that fans out batched
 * RPC calls to the correct service instance.
 */
export function registerWithBatching(
  teHub: Hub,
  services: Record<string, SharedTabService>,
  settings: BatchSettings,
): void {
  const serviceMap = new Map<string, SharedTabService>();

  const eventQueue: BatchedEvent[] = [];
  let flushScheduled = false;
  let suspendCount = 0;

  const flush = (): void => {
    flushScheduled = false;
    if (eventQueue.length === 0 || suspendCount > 0) return;
    const batch = eventQueue.splice(0);
    teHub.emit(BATCH_NAMESPACE, BATCH_EVENT, batch);
  };

  const scheduleFlush = (): void => {
    if (flushScheduled || suspendCount > 0) return;
    flushScheduled = true;
    if (settings.flushMs <= 0) queueMicrotask(flush);
    else setTimeout(flush, settings.flushMs);
  };

  const wrappedHub = new Proxy(teHub, {
    get(target, prop, receiver) {
      if (prop === 'emit') {
        return (ns: string, event: string, payload: unknown): void => {
          eventQueue.push({ ns, event, payload });
          scheduleFlush();
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  for (const [namespace, service] of Object.entries(services)) {
    assignNamespace(service, namespace);
    serviceMap.set(namespace, service);

    if (settings.enabled) {
      const original = service.init?.bind(service);
      if (original) {
        (service as SharedTabService & { init: (hub: Hub) => unknown }).init = (_hub) =>
          original(wrappedHub);
      }
    }
    teHub.register(service);
  }

  if (!settings.enabled) return;

  const dispatchBatch = async (calls: BatchCall[]): Promise<BatchResult[]> => {
    suspendCount += 1;
    try {
      const results: BatchResult[] = [];
      for (const call of calls) {
        const svc = serviceMap.get(call.ns) as Record<string, unknown> | undefined;
        const fn = svc ? svc[call.method] : undefined;
        if (typeof fn !== 'function') {
          results.push({ ok: false, error: `unknown method: ${call.ns}.${call.method}` });
          continue;
        }
        try {
          const value = await (fn as (...args: unknown[]) => unknown).apply(svc, call.args);
          results.push({ ok: true, value });
        } catch (err) {
          results.push({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return results;
    } finally {
      suspendCount -= 1;
      if (suspendCount === 0 && eventQueue.length > 0) {
        // All queued events from this batch are flushed as one message, right after the
        // RPC reply goes out.
        queueMicrotask(flush);
      }
    }
  };

  const batchService: SharedTabService & {
    [BATCH_METHOD](calls: BatchCall[]): Promise<BatchResult[]>;
  } = {
    namespace: BATCH_NAMESPACE,
    [BATCH_METHOD]: dispatchBatch,
  };
  teHub.register(batchService);
}
