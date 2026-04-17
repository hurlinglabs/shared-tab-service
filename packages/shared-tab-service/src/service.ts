import type { Service as TabElectionService } from 'tab-election/hub';

export interface SharedTabService<
  Namespace extends string = string,
  Events extends Record<string, unknown> = Record<never, never>,
> extends TabElectionService<Events> {
  readonly namespace: Namespace;
}

export function defineService<
  const NS extends string,
  T extends object,
  Events extends Record<string, unknown> = Record<never, never>,
>(namespace: NS, impl: T): T & SharedTabService<NS, Events> {
  return Object.assign(impl, { namespace }) as T & SharedTabService<NS, Events>;
}

export function assignNamespace<NS extends string>(
  service: SharedTabService<NS>,
  key: string,
): void {
  if (service.namespace && service.namespace !== key) {
    throw new Error(
      `shared-tab-service: service key "${key}" does not match service.namespace "${service.namespace}"`,
    );
  }

  // assume will throw if namespace isn't writable
  (service as { namespace: string }).namespace = key;
}
