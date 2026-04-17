import type { Service as TabElectionService } from 'tab-election/hub';

export interface SharedTabService<
  Events extends Record<string, unknown> = Record<never, never>,
  Namespace extends string = string,
> extends TabElectionService<Events> {
  readonly namespace: Namespace;
}

export function defineService<
  const NS extends string,
  T extends object,
  Events extends Record<string, unknown> = Record<never, never>,
>(namespace: NS, impl: T): T & SharedTabService<Events, NS> {
  return Object.assign(impl as object, { namespace }) as T & SharedTabService<Events, NS>;
}
