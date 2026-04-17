import { Hub } from 'tab-election/hub';
import { type BatchOption, resolveBatchSettings } from './batch.js';
import { registerWithBatching } from './hub.js';
import type { SharedTabService } from './service.js';

type ServicesRecord = Record<string, SharedTabService>;
type ServicesInput = ServicesRecord | (() => Promise<ServicesRecord>);

export interface RunSharedTabHubOptions {
  name?: string;
  version?: string;
  services: ServicesInput;
  /** Default `true`. Coalesces RPC calls and events into batched messages. Pass `false` to opt out, or `{ flushMs }` to flush on a timer (default `0` = microtask). */
  batch?: BatchOption;
}

/**
 * Starts a shared-tab-service hub inside a SharedWorker, dedicated Worker, or any
 * module-scope entry. Call from your worker entry file — the module it lives in will
 * be loaded by the browser when a spoke connects.
 */
export function runSharedTabHub(options: RunSharedTabHubOptions): Hub {
  const { name, version, services, batch } = options;
  const settings = resolveBatchSettings(batch);
  return new Hub(
    async (hub) => {
      const record = typeof services === 'function' ? await services() : services;
      registerWithBatching(hub, record, settings);
    },
    name,
    version,
  );
}
