import { Hub, Spoke, type ServiceStub } from 'tab-election/hub';
import type { SharedTabService } from './service.js';

type ServicesRecord = Record<string, SharedTabService>;
type ServicesInput = ServicesRecord | (() => Promise<ServicesRecord>);

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
}

const isBrowserLike = (): boolean =>
  typeof self !== 'undefined' &&
  typeof BroadcastChannel !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  typeof (navigator as Navigator & { locks?: unknown }).locks !== 'undefined';
const hasSharedWorker = (): boolean => typeof SharedWorker !== 'undefined';
const hasDedicatedWorker = (): boolean => typeof Worker !== 'undefined';

export function assignNamespace(service: SharedTabService, key: string): void {
  if (service.namespace && service.namespace !== key) {
    throw new Error(
      `shared-tab-service: service key "${key}" does not match service.namespace "${service.namespace}"`,
    );
  }
  (service as { namespace: string }).namespace = key;
}

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
  } = options;

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
        for (const [namespace, service] of Object.entries(record)) {
          assignNamespace(service, namespace);
          hub.register(service);
        }
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

  const client = new Proxy(Object.create(null) as Record<string, unknown>, {
    get: (_, prop) => {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'close') {
        return () => {
          spoke.close();
          inTabHub?.close();
        };
      }
      if (prop === 'isLeader') return spoke.isLeader;
      if (prop === 'onLeaderChange') return spoke.onLeaderChange.bind(spoke);
      return spoke.getService(prop);
    },
  });

  return client as unknown as CreatedClient<S>;
}
