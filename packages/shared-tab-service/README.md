# @hurling/shared-tab-service

**One service. Every tab. Zero duplication.**

Stop opening N WebSockets, N auth sessions, and N polling loops just because your user opened N tabs. `@hurling/shared-tab-service` lets you define a service **once** and share a single live instance across every tab of your app — with fully typed RPC, typed events, and automatic transport selection under the hood.

```ts
const client = createSharedTabService({ name: 'my-app', services, workerUrl });

// Every tab calls this. Only the leader actually runs it.
const user = await client.auth.getUser();

// Every tab sees this event. Emitted once.
client.prices.on('tick', ({ symbol, price }) => update(symbol, price));
```

## Why you'll like it

- **Typed end-to-end.** Define your service, get a strongly-typed client everywhere — methods, arguments, return values, event names, event payloads. No codegen.
- **Best transport, picked for you.** `SharedWorker` when the browser supports it, a tab-elected leader over `BroadcastChannel` when it doesn't, an SSR-safe stub in Node. No branching in your app code.
- **Transparent batching.** Calls made in the same microtask are coalesced into a single message. Events emitted during a batched call are fanned out in one broadcast. Your code never knows.
- **Tiny surface area.** One function to host the hub, one function to get a client, one helper to declare a service. That's the whole library.
- **Credit where it's due.** Leader election and cross-tab messaging build on the excellent [`tab-election`](https://www.npmjs.com/package/tab-election) library. This package extends that foundation with automatic detection of what your browser supports, so work is offloaded via the most efficient mechanism available.

## When to use it

- One tab should hold a shared **WebSocket / EventSource / SSE** connection, and every other tab reads from it.
- Your app opens an expensive **IndexedDB** handle or **auth session** that you'd like to dedupe across tabs.
- You're fanning out **polling / subscriptions** and don't want N tabs all hitting the server.
- Any state or side-effect you'd rather run **once per browser**, not once per tab.

## Install

```bash
pnpm add @hurling/shared-tab-service
# or npm install / yarn add
```

The library is browser-first. Imports resolve safely in Node (SSR, tests) but calls will reject with a clear error unless a browser runtime is detected.

## Quick start

The idiomatic setup is three small files: your **services**, a **worker entry**, and your **app code**.

### 1. Define your service

```ts
// src/services.ts
import type { Hub, SharedTabService } from '@hurling/shared-tab-service';

export interface CounterEvents extends Record<string, unknown> {
  changed: { value: number };
}

export class CounterService implements SharedTabService<CounterEvents, 'counter'> {
  readonly namespace = 'counter' as const;
  readonly __events?: CounterEvents;
  private hub?: Hub;
  private count = 0;

  init(hub: Hub) {
    this.hub = hub;
  }

  async increment(): Promise<number> {
    this.count += 1;
    this.hub?.emit(this.namespace, 'changed', { value: this.count });
    return this.count;
  }

  async get(): Promise<number> {
    return this.count;
  }
}

export const services = {
  counter: new CounterService(),
};
```

The record key (`counter`) is authoritative — it's used as the runtime namespace and as the client property name. If the service declares a different `namespace`, registration throws.

### 2. Worker entry

```ts
// src/shared.worker.ts
import { runSharedTabHub } from '@hurling/shared-tab-service/worker';
import { services } from './services';

runSharedTabHub({
  name: 'my-app',
  services,
});
```

### 3. Client

```ts
// src/main.ts
import { createSharedTabService } from '@hurling/shared-tab-service';
import { services } from './services';

const client = createSharedTabService({
  name: 'my-app',
  services,
  workerUrl: new URL('./shared.worker.ts', import.meta.url), // Vite / webpack / Rollup all understand this
});

// Fully typed RPC
const n = await client.counter.increment();

// Typed events
client.counter.on('changed', ({ value }) => {
  console.log('counter is now', value);
});
```

That's it. Open multiple tabs — they share the same `CounterService` instance.

## Transport modes

`createSharedTabService` picks the transport for you:

| Condition                                             | Transport                 | Notes                                                                         |
| ----------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| `workerUrl` set + browser supports `SharedWorker`     | **SharedWorker**          | One shared process per origin; survives tab closes until the last one goes.   |
| `workerUrl` set + only `Worker` supported             | **dedicated Worker**      | Each tab gets its own worker; tab-election still elects one as authoritative. |
| `workerUrl` missing, or neither worker type available | **in-tab (Tab-election)** | One tab is elected leader; all others RPC to it via `BroadcastChannel`.       |
| No browser runtime (Node, SSR)                        | **stub**                  | All RPC calls reject with a clear error; `.on(...)` is a no-op.               |

Force or skip a mode:

```ts
createSharedTabService({
  name: 'my-app',
  services,
  workerUrl,
  useSharedWorker: false, // skip SharedWorker, fall through to the next option
  useDedicatedWorker: false, // skip dedicated Worker too, force in-tab fallback
});
```

## Defining a service

Two styles, same result:

```ts
// Class (recommended for stateful services)
export class DbService implements SharedTabService<MyEvents, 'db'> {
  readonly namespace = 'db' as const;
  readonly __events?: MyEvents;
  async getUser(id: string) {
    /* … */
  }
}

// Sugar for plain objects (no class ceremony)
import { defineService } from '@hurling/shared-tab-service';

export const db = defineService('db', {
  async getUser(id: string) {
    /* … */
  },
});
```

Every service exposed to the client must live under a key in the `services` record:

```ts
createSharedTabService({
  services: {
    db, // from defineService
    auth: new AuthService(),
    // ...
  },
});
```

## Events

- **Emit from the hub side**: `this.hub.emit(this.namespace, 'eventName', payload)`.
- **Subscribe from the client side**: `client.<namespace>.on('eventName', listener)` returns an unsubscribe function.
- Event names and payloads are typed via the `__events` phantom property on the service.

```ts
const off = client.counter.on('changed', ({ value }) => {
  console.log(value);
});
off(); // stop listening
```

## Batching (default on)

Every `client.X.method(...)` call gets queued and flushed in a microtask as a single batched RPC. Events emitted on the hub side during a batched call are coalesced into one broadcast. This is transparent to your code — your service doesn't know or care.

Controls:

```ts
createSharedTabService({
  batch: false, // opt out — every call goes as its own message
  batch: { flushMs: 4 }, // timer-based flush instead of microtask
  batch: true, // default — microtask flush
});
```

`runSharedTabHub` takes the same option — keep them in sync.

## Lazy services

If you want the worker fallback path to not load your services module in the main bundle:

```ts
const client = createSharedTabService({
  name: 'my-app',
  services: () => import('./services').then((m) => m.services),
  workerUrl,
});
```

When `workerUrl` + SharedWorker is available the main thread never imports `./services`. The worker does. If the library falls back to the in-tab Hub, the loader runs to resolve services on demand.

## Client API

```ts
client.<namespace>.<method>(...args): Promise<Return>
client.<namespace>.on<K>(event: K, listener: (payload) => void): () => void

client.isLeader: boolean                            // true when this tab holds the lock
client.onLeaderChange(fn: (isLeader: boolean) => void): () => void
client.close(): void
```

`isLeader` is always `false` in SharedWorker mode (the worker is the "leader").

## Caveats

- **State lives in the leader's memory**. When a tab-election leader closes, a new tab is elected and services are re-initialized (counters restart from 0, subscriptions re-established, etc.). If you need state to survive leader flips, persist it (IndexedDB / localStorage) and rehydrate in `init`.
- **`postMessage` limits apply** — arguments and return values are structured-cloned. Functions, DOM nodes, and classes-with-methods don't cross the wire.
- **Services are singletons per transport**. There is one instance per elected leader (tab-election) or one per SharedWorker.
- **Namespace keys must be unique** across the `services` record — they're the addressable identifier.

## Examples

Runnable Vite demos live in the repo's `examples/` directory — a vanilla-TS demo and a React app with a benchmark panel and throughput-over-N chart.

## License

[Apache-2.0](./LICENSE).
