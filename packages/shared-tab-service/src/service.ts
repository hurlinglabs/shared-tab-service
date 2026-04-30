import type { Service as TabElectionService } from 'tab-election/hub';
import type { SubscriberCounts } from './lifecycle.js';

export interface SharedTabService<
  Namespace extends string = string,
  Events extends object = {},
> extends TabElectionService<Events> {
  readonly namespace: Namespace;
  /**
   * Optional list of method names on this service that are safe to retry
   * automatically when a leader change interrupts an in-flight call. If a
   * method is listed here, the client proxy will catch a single
   * `LeaderChangedError`, wait for the new leader to settle, and re-issue
   * the call once. Any further error (including a second leader change)
   * propagates to the caller.
   *
   * Idempotency is a property of the method, not the call site — only mark
   * methods whose effect is the same when run twice with the same args.
   *
   * Read by the spoke side at construction time; the hub never invokes it
   * (it's not a function).
   */
  readonly __idempotent?: ReadonlyArray<string>;
  /**
   * Optional hub-side hook fired whenever the aggregate listener counts for
   * any of this service's events change. Use this to gate work on
   * `counts.spokes` — e.g. open a WebSocket on the first subscriber, close it
   * when the last subscriber goes away. `counts.listeners` is provided for
   * services that need finer granularity.
   *
   * The hook is invoked from the lifecycle manager running inside the hub
   * (the leader tab or SharedWorker). It is not called on followers.
   */
  onSubscribersChanged?(counts: SubscriberCounts, eventName: keyof Events & string): void;
}

export function defineService<
  const NS extends string,
  T extends object,
  Events extends object = {},
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
