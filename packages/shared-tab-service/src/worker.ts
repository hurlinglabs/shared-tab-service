import { Hub } from 'tab-election/hub';
import { assignNamespace } from './client.js';
import type { SharedTabService } from './service.js';

type ServicesRecord = Record<string, SharedTabService>;
type ServicesInput = ServicesRecord | (() => Promise<ServicesRecord>);

export interface RunSharedTabHubOptions {
  name?: string;
  version?: string;
  services: ServicesInput;
}

/**
 * Starts a shared-tab-service hub inside a SharedWorker, dedicated Worker, or any
 * module-scope entry. Call from your worker entry file — the module it lives in will
 * be loaded by the browser when a spoke connects.
 */
export function runSharedTabHub(options: RunSharedTabHubOptions): Hub {
  const { name, version, services } = options;
  return new Hub(
    async (hub) => {
      const record = typeof services === 'function' ? await services() : services;
      for (const [namespace, service] of Object.entries(record)) {
        assignNamespace(service, namespace);
        hub.register(service);
      }
    },
    name,
    version,
  );
}
