# Proposal: Spoke heartbeat + subscriber tracking

## Motivation

Today the hub knows when _it_ is alive (leader election + heartbeat), but has
no native mechanism to know:

1. How many spokes (tabs) are currently connected.
2. Which spokes have died vs. cleanly disconnected.
3. How many listeners are attached to a given service event.

That last point matters because services often wrap an upstream resource — a
WebSocket subscription, a polling loop, a long-lived stream — that should
ideally only run while at least one tab is interested. Without listener
visibility on the hub side, every consuming app has to layer its own
ref-counting RPC (`acquire` / `release`) on top of the library, with two
problems:

- It's discipline, not a default. New consumers forget; the upstream resource
  ends up running forever.
- It's not crash-safe. If a tab is force-killed (mobile Safari, OOM, bfcache
  eviction), its `release()` never fires and the count leaks until the hub
  itself dies.

The case that prompted this: a bets-table GraphQL subscription that should
only hold a WS connection when at least one tab in the user's session has a
bets table mounted. We currently solve it with manual ref counting and a
written-down rule "remember to release on unmount." That works until it
doesn't.

## Goals

- Hub-side knowledge of which spokes are currently connected.
- Hub-side, per-service listener counts that update as spokes attach/detach.
- A service-level lifecycle hook that fires when subscriber count crosses
  zero (start work) or returns to zero (stop work), so "only run the WS while
  someone is listening" can be the default behaviour.
- Crash-safe. A spoke that vanishes without saying goodbye is detected and
  its contribution to listener counts is reclaimed within a bounded window.
- A logging / telemetry surface so apps can observe spoke churn without
  patching the library.
- Additive. Existing services and apps keep working unchanged.

## Non-goals

- Replacing application-level ref counting for things that are not 1:1 with
  a `ServiceStub.on(...)` listener. We keep an escape hatch but don't try
  to model arbitrary lifetimes.
- Cross-hub federation. Heartbeats are within a single hub instance.
- Guaranteed delivery / ack-based RPC. Heartbeats are best-effort with a TTL.

## Design

### 1. Spoke identity + heartbeat

Every spoke gets a stable `spokeId` (UUID) generated at construction. The
spoke sends a heartbeat message on the existing transport at a configurable
interval (default `5000ms`). The hub tracks `lastSeen` per spoke and expires
entries that miss `N` consecutive beats (default `N = 3`, so ~15s to detect
a dead tab).

**Heartbeats run regardless of `document.hidden`.** A hidden tab is still a
live tab still holding listeners that the hub may have other tabs depending
on (the whole point of a shared service is cross-tab coordination — pausing
one tab's heartbeat would cause false expiries and wrongly tear down work
the foreground tab needs). Browsers throttle background timers to roughly
1 Hz, which is comfortably inside a 5s interval / 15s TTL, so we don't need
visibility hooks here. SharedWorker hubs don't have a `document` anyway;
this only ever matters for in-tab fallback.

The transport is the existing message channel — no new port, no new
BroadcastChannel. Payload is small (`{ t: "hb", id }`).

### 2. Listener-count propagation

Counts live at two different levels of the hierarchy:

- **Hub level**: connected tabs/windows. One count per spoke regardless of
  how many services or events it touches. Falls straight out of the
  heartbeat tracking — `hub.getConnectedSpokes().length`.
- **Service-event level**: listeners per `(namespace, eventName)`. This is
  what services actually gate work on.

Within the service-event level, two derived counts are worth exposing
because they answer different questions:

| Count                                 | Question it answers             | Use case                                                 |
| ------------------------------------- | ------------------------------- | -------------------------------------------------------- |
| **Subscriber tabs** (dedup per spoke) | "Is _anyone_ listening?"        | Gating upstream work — start/stop a WS, a poll, a stream |
| **Total listeners** (per-callback)    | "How many things are wired up?" | Debugging, telemetry, leak detection                     |

Today `ServiceStub.on(event, listener)` is a local EventEmitter add on the
spoke side with no dedup — three components in the same tab calling
`on("updates", …)` register three listeners. The hub doesn't see individual
listeners, it just broadcasts and the spoke fans out locally. Both counts
fall out of what the spoke already knows.

**Mechanism.** On each `on` / unsubscribe, the spoke checks
`emitter.listenerCount(event)` and ships `{ namespace, eventName, count }`
to the hub when the value changes. The hub aggregates per-spoke entries to
derive both counts:

- _Subscriber tab count_ = number of spokes with `count > 0` for this event
- _Total listener count_ = sum of `count` across all spokes for this event

We ship the actual count (not just zero/non-zero transitions) so total
listener telemetry works without an extra channel. The wire cost is
bounded by genuine listener churn, which is small in practice.

Hub API, organised by level:

```ts
// Hub-level: connected tabs/windows
hub.getConnectedSpokeCount(): number
hub.getConnectedSpokes(): ReadonlyArray<{
  id: string
  version?: string
  connectedAt: number
  lastSeen: number
}>

// Service-event-level: listener counts per (namespace, eventName)
hub.getSubscriberTabCount(namespace: string, eventName?: string): number
hub.getListenerCount(namespace: string, eventName?: string): number
hub.onSubscriberCountChange(
  namespace: string,
  listener: (counts: { tabs: number; listeners: number }, eventName: string) => void,
): UnsubscribeFunction
```

When a spoke expires (heartbeat TTL elapsed), its contributions to both
counts are subtracted in one shot, which can trigger an
`onSubscriberCountChange` callback firing with `tabs: 0` — services gated
on this will tear down their upstream work automatically.

The `Service.onSubscribersChanged` lifecycle hook (§3) is gated on the
**tab count**, not the listener count. Almost all "should I be running
right now?" decisions key off "is any tab interested," and that signal is
stable against in-tab listener churn (a component swapping listeners on a
re-render shouldn't tear down a WebSocket). Services that genuinely need
the granular listener number can read it via `getListenerCount()`.

### 2a. Expiry notification (best-effort)

When the hub expires a spoke for missing heartbeats it doesn't know whether
the tab is actually dead or just temporarily hung. We don't try to
distinguish — the hub's responsibility ends at "let you know we let you
go." If the tab really is gone the message goes nowhere; if it unhangs
later, it processes the message and knows it's been disconnected. What
the spoke does with that information (reconnect, surface to the app,
silently die) is up to the consumer, not the library.

**Mechanism:**

1. On expiry the hub posts a fire-and-forget
   `{ type: "expired" }` message to the spoke on the existing transport.
2. The hub then **forgets** the spoke. No tombstones, no late-heartbeat
   handshake, no grace period — the listener contributions are subtracted,
   the lifecycle event fires, and the id is gone.
3. The spoke, on receiving the message (whenever it next processes its
   message queue), emits a local event the app can subscribe to:

   ```ts
   client.onDisconnected(listener: (reason: "expired") => void): UnsubscribeFunction
   ```

   There is no built-in auto-reconnect. The app decides whether to spin up
   a fresh `Spoke`, reload, or do nothing. Most apps will probably want to
   re-create the client; the library shouldn't presume.

4. If a spoke that's been expired tries to send anything (RPC, heartbeat)
   afterwards the hub treats it as an unknown spoke. The spoke can use
   that as an additional signal that it has been disconnected, but the
   notification message is the primary path.

**Why best-effort is enough:**

- A truly dead tab can't act on the message regardless. We're not
  guaranteeing recovery; we're giving a hung-but-recovering tab a chance
  to notice it was let go.
- Tombstones, late-heartbeat handshakes, and listener-count smoothing
  add real complexity (state retention, ack channels, grace timers) for
  the relatively rare case of a tab hanging for >TTL and recovering.
  We can revisit if telemetry shows it happening often.
- Listener counts will briefly dip then recover when the spoke
  reconnects fresh. Services consuming `onSubscribersChanged` should
  already be idempotent about start/stop; if churn becomes a problem in
  practice we can layer smoothing on later.

### 3. Service lifecycle hook

Extend the `Service` interface with an optional method:

```ts
interface Service<Events> {
  // ...existing fields
  onSubscribersChanged?(
    counts: { tabs: number; listeners: number },
    eventName: keyof Events & string,
  ): void;
}
```

Default-on. A service that implements this gets called on every count change
for any of its events. The intended gating signal is `counts.tabs`;
`counts.listeners` is provided for services that need finer granularity. The "only run while listening" pattern becomes:

```ts
class MyService implements SharedTabService<'my', MyEvents> {
  onSubscribersChanged(count: number, eventName: string) {
    if (eventName !== 'updates') return;
    if (count > 0) this.startStream();
    else this.stopStream();
  }
}
```

No `acquire` / `release` RPC for the consumer. The mere fact that they
called `service.on("updates", ...)` is the signal.

### 4. Manual escape hatch

For work that isn't 1:1 with a single event subscription (the bets-table
case actually _is_ 1:1, but not all are), keep an explicit API:

```ts
serviceStub.acquire(): UnsubscribeFunction // returns the release fn
```

This increments a per-service "manual" counter that participates in
`getSubscriberCount(namespace)` but isn't tied to an event. Crash-safe via
the same heartbeat mechanism.

### 5. Telemetry surface

Hub emits library-level events on a dedicated channel:

```ts
hub.onLifecycleEvent(listener: (ev: LifecycleEvent) => void): UnsubscribeFunction

type LifecycleEvent =
  | { type: "spoke_connected"; id: string; version?: string }
  | { type: "spoke_disconnected"; id: string; reason: "closed" | "expired" }
  | { type: "subscriber_count_changed"; namespace: string; eventName: string; tabs: number; listeners: number }
```

Apps pipe this to their own telemetry. No coupling to a specific logger.

## Tradeoffs

- **Heartbeat cost.** Negligible in SharedWorker mode (one port, one timer).
  Slightly more chatty in the in-tab fallback because every spoke is also
  potentially the hub. Make the interval configurable and document the
  default.
- **API surface.** Three new hub methods + one new service hook + one new
  stub method. Sizeable but each carries weight; nothing is purely
  cosmetic.
- **Listener counting overlap.** `onSubscribersChanged` and explicit
  `acquire` both feed `getSubscriberCount`. We accept the overlap — the
  former is the default, the latter is for cases where there's no natural
  event subscription to count.
- **TTL tuning.** Too short → false expiries on a slow tab. Too long →
  upstream resources held after a crash. 15s default is a reasonable
  middle ground for human-perceptible work; expose the knobs.
- **Backwards compatibility.** All additions are optional. Old services
  without `onSubscribersChanged` behave exactly as today. Old spokes
  without heartbeats appear permanently alive to a new hub — we should
  handle that by keying expiry on "spokes that have ever sent a heartbeat"
  during a transition window, then making heartbeats mandatory in a major.

## Open questions

- Should `onSubscribersChanged` be debounced at the library level, or is
  that the service author's job? Leaning library-side with a configurable
  trailing edge to avoid thrash on rapid mount/unmount.
- Per-event vs. per-namespace counts in the lifecycle hook signature —
  worth supporting both, but the default callback signature should be the
  more granular one.
- Do we want `hub.getConnectedSpokes()` to include a per-spoke listener
  breakdown? Useful for debugging, slightly leaky abstraction-wise.
- Heartbeat interval: hub-controlled (push down via config message) or
  spoke-controlled (each spoke decides)? Hub-controlled is simpler to reason
  about.

## Rollout

1. Land `spokeId` + heartbeat plumbing. No public API yet; just internal
   tracking + a debug-only `getConnectedSpokes()`.
2. Add listener-count propagation and `getSubscriberTabCount` /
   `getListenerCount` / `onSubscriberCountChange`.
3. Add `Service.onSubscribersChanged` hook. Document the "self-gating"
   pattern.
4. Add `serviceStub.acquire()` escape hatch.
5. Add `hub.onLifecycleEvent` telemetry surface.
6. Migrate the bets-table-subscription service in the consuming app to
   self-gate via `onSubscribersChanged`, delete its `acquire`/`release`
   plumbing, write that up as the canonical example in the README.
