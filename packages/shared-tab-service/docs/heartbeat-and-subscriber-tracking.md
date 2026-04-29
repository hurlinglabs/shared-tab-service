# Spoke heartbeat & subscriber tracking

This document describes the runtime mechanism that powers
`Service.onSubscribersChanged` and the hub-side subscriber/listener counts.
It corresponds to the design proposal at
[`docs/spec/20260429-spoke-heartbeat-and-subscriber-tracking.md`](../../../docs/spec/20260429-spoke-heartbeat-and-subscriber-tracking.md);
read that for the motivation. This doc is the implementation reference.

## What it gives you

A service can lazily start and stop upstream work (a WebSocket, a polling
loop, a long-lived stream) based on whether anyone is actually listening
across all connected spokes:

```ts
import { defineService, type SharedTabService } from '@hurling/shared-tab-service';

interface BetsEvents extends Record<string, unknown> {
  'bets-changed': { bets: Bet[] };
}

class BetsService implements SharedTabService<'bets', BetsEvents> {
  readonly namespace = 'bets' as const;
  declare readonly __events?: BetsEvents;
  private hub?: Hub;
  private ws?: WebSocket;

  init(hub: Hub) {
    this.hub = hub;
  }

  onSubscribersChanged({ spokes }: { spokes: number; listeners: number }, eventName: string) {
    if (eventName !== 'bets-changed') return;
    if (spokes > 0 && !this.ws) this.openWS();
    else if (spokes === 0) this.closeWS();
  }

  private openWS() {
    this.ws = new WebSocket(URL);
    this.ws.onmessage = (e) => this.hub?.emit(this.namespace, 'bets-changed', JSON.parse(e.data));
  }

  private closeWS() {
    this.ws?.close();
    this.ws = undefined;
  }
}
```

The hook fires whenever the aggregate `{ spokes, listeners }` count for any of
the service's events transitions to a new value. App code that subscribes
via `client.bets.on('bets-changed', …)` is the signal — no `acquire` /
`release` plumbing required.

## What `spokes` and `listeners` mean

| Count       | What it counts                                                                              | Use it for                                                            |
| ----------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `spokes`    | Distinct connected client instances (each `createSharedTabService(…)`) with `count > 0`     | Gating upstream work (open/close a WebSocket, start/stop a poll loop) |
| `listeners` | Total number of `.on(event, …)` callbacks across all spokes                                 | Telemetry, leak detection, debugging                                  |

`spokes` is the right gating signal because in-spoke listener churn (a
React component swapping handlers on a re-render) shouldn't tear down a
WebSocket — `spokes` stays at 1 across that churn while `listeners`
flickers.

> Spokes vs. tabs/windows: a spoke is one client instance. Most apps
> create one spoke per tab/window, in which case `spokes` is effectively a
> tab count. But nothing stops an app from constructing two clients in
> the same tab (e.g. an embedded iframe), and each is a separate spoke
> with its own id. The hub counts spokes, not browser surfaces.

## Configuration

Both `createSharedTabService` (spoke) and `runSharedTabHub` (hub) accept a
`heartbeat` option:

```ts
createSharedTabService({
  name: 'session',
  services: { … },
  heartbeat: true,                       // default — uses { intervalMs: 5000, ttlMs: 15000 }
  // heartbeat: false,                   // disable; no tracking, no hook fires
  // heartbeat: { intervalMs: 5000, ttlMs: 15000 },
});
```

| Option       | Default | Meaning                                                                         |
| ------------ | ------- | ------------------------------------------------------------------------------- |
| `intervalMs` | 5000    | How often the spoke sends a heartbeat to the hub.                               |
| `ttlMs`      | 15000   | How long the hub waits without a heartbeat before declaring a spoke crashed.    |

Defaults give roughly three missed beats before expiry. Tune `ttlMs` shorter
for snappier cleanup at the cost of more false positives on slow spokes.

## How it works

### Spoke side (`SpokeLifecycle`)

* On client construction:
  * Generates a `spokeId` (UUID via `crypto.randomUUID()`, falls back to a
    Math.random-based id in environments without it).
  * Sends a `hello` RPC with `{ spokeId, version }` to the hub.
  * Schedules `hb` RPCs every `intervalMs`.
* On `client.<svc>.on(event, fn)`:
  * Increments a local `(ns, event)` counter.
  * Sends `sub({ spokeId, ns, event, count })` to the hub. The new total
    count is sent (not just deltas), so the hub state is self-correcting.
* On unsubscribe: decrements and sends `sub` with the new count (zero if no
  more local listeners).
* On `client.close()`:
  * Sends `bye({ spokeId })`.
  * In the in-tab leader case, also calls `manager.bye(spokeId)`
    synchronously so close is immediately observable. (RPC bye still fires;
    the manager is idempotent.)

All lifecycle messages bypass user-level batching — they go straight
through the underlying tab-election RPC channel. Lifecycle traffic
shouldn't be coalesced with or starved by user RPC.

### Hub side (`LifecycleManager`)

State:

```
spokes:      Map<spokeId, { id, version, connectedAt, lastSeen, subs: Map<ns, Map<event, count>> }>
aggregate:   Map<ns, Map<event, { spokes, listeners }>>
```

* `hello/hb` updates `lastSeen`.
* `sub` updates the spoke's per-event count and recomputes the affected
  aggregate. If the aggregate value actually changed, the service's
  `onSubscribersChanged({spokes, listeners}, eventName)` is called.
* `bye` removes the spoke and recomputes every `(ns, event)` it
  contributed to.
* A sweep timer (period = `max(50ms, intervalMs / 2)`) calls `bye` for any
  spoke whose `lastSeen` is older than `ttlMs`. Crash safety falls out of
  this — a hard tab kill produces the same observable behaviour as a
  graceful close, just delayed by up to one TTL window.

The manager throttles itself: `recompute` is a no-op if the aggregate hasn't
actually changed for that `(ns, event)`. This means `onSubscribersChanged`
will not fire on every `sub` call, only on aggregate transitions.

### Lifecycle service

Internally registered on the namespace `__sts_lifecycle` (exported as
`LIFECYCLE_NAMESPACE`). Methods: `hello`, `hb`, `sub`, `bye`. This is an
implementation detail — apps shouldn't talk to it directly — but it's a
regular registered Service so the existing tab-election RPC machinery
handles it.

## Reading counts directly

The lifecycle manager is attached to the hub instance as a non-enumerable
`__lifecycle` property:

```ts
const mgr = (hub as any).__lifecycle as LifecycleManager | undefined;
mgr?.getConnectedSpokeCount();
mgr?.getConnectedSpokes();
mgr?.getSubscriberSpokeCount('bets', 'bets-changed');
mgr?.getListenerCount('bets', 'bets-changed');
```

App code with in-tab access to the Hub (in-tab fallback mode) can read
these directly. In SharedWorker / dedicated-Worker mode the hub is in a
different JS context, so apps that want telemetry there should expose
their own service method that delegates to the manager (or wait for
`hub.onLifecycleEvent` from the proposal — not yet implemented).

The same property is also exposed on the client object for tests and
in-tab debugging:

```ts
const { spokeId } = (client as any).__lifecycle as SpokeLifecycle;
```

## Trade-offs and limits

* **Leader transitions reset state.** The aggregate counts live on the
  current leader. If leadership transfers (the leader tab closes,
  recovery fires), the new leader starts with empty state. Spokes do not
  re-send their subscription state on leader change, so any active
  subscriptions go silent until the next listener add/remove. Cross-leader
  state replication is intentionally out of scope (see proposal §non-goals).
* **Best-effort delivery.** Heartbeats and lifecycle RPCs use the same
  transport as everything else; messages can be dropped if the channel is
  closed mid-flight. The TTL sweep is the safety net.
* **In-tab fallback chattiness.** Each tab is also potentially the hub, so
  every tab runs both halves. The interval is configurable; raise it if you
  see overhead.
* **No backwards-compat shim yet.** A spoke that does not send heartbeats
  (e.g. an older client version connecting to a newer hub) will still
  appear connected forever from the hub's view — `lastSeen` is set on
  `hello` but never updated. We will close this gap before this becomes a
  required feature. For now: ensure spoke and hub builds match.

## Files

* `src/lifecycle.ts` — `LifecycleManager`, `SpokeLifecycle`, the lifecycle
  service factory and the heartbeat-option resolver.
* `src/hub.ts` — registers the lifecycle service when `heartbeat !== null`,
  passes the user services map to the manager so it can fire
  `onSubscribersChanged`, stops the sweep timer on `hub.close()`.
* `src/client.ts` — instantiates `SpokeLifecycle`, hooks subscribe /
  unsubscribe in both the batching and direct (`batch: false`) proxies,
  exposes `__lifecycle` on the client.
* `src/lifecycle.test.ts` — unit tests for `LifecycleManager` and
  end-to-end tests over the real Hub + Spoke transport (heartbeat,
  hook firing, multi-client aggregation, crash safety, clean close,
  `heartbeat: false` opt-out, batched + non-batched paths).
