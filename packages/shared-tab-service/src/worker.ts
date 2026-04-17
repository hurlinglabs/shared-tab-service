import { Hub } from 'tab-election/hub';
import type { SharedTabService } from './service.js';

type ServicesShape = readonly SharedTabService[] | Record<string, SharedTabService>;
type ServicesInput = ServicesShape | (() => Promise<ServicesShape>);

export interface RunSharedTabHubOptions {
  name?: string;
  version?: string;
  services: ServicesInput;
}

function toList(shape: ServicesShape): SharedTabService[] {
  return Array.isArray(shape)
    ? [...shape]
    : Object.values(shape as Record<string, SharedTabService>);
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
      const shape = typeof services === 'function' ? await services() : services;
      for (const service of toList(shape)) hub.register(service);
    },
    name,
    version,
  );
}
