# Proposal: Fast-fail on leader change + opt-in idempotent retry

Status: draft
Author: alistair.hutten
Date: 2026-04-30

## Motivation

`tab-election` keys in-flight RPC deferreds by `(spokeId, callNumber)` and
gives each one a 30s timeout. If the leader dies between the `onCall`
broadcast and the matching `onReturn`, the reply never arrives and the
deferred is rejected only once that 30s timer fires. From the caller's
perspective the call hangs for half a minute and then surfaces as a
generic `Call timed out` — indistinguishable from a leader-side method
that genuinely took 30s.

This is documented today in `docs/correlation-ids.md` under "What this
does _not_ try to handle" as the caller's responsibility. In practice,
that means every consumer either eats the 30s wait or layers their own
detection on top. We can do better in the library: spokes already learn
about leader changes via `tab-election`'s `Spoke.onLeaderChange`, so we
can drain pending deferreds the moment leadership flips.

For methods that are safe to re-issue, the same hook lets us retry
transparently — turning a leader change into a non-event for the
caller.

## Goals

- In-flight calls fail fast with a typed, recoverable error when the
  leader changes mid-request — no 30s wait.
- The error is distinguishable from a real timeout or an app-level
  rejection, so callers can react (or `instanceof`-filter their retry
  logic).
- Optional opt-in idempotent retry for methods the service author marks
  safe.
- All additions are backwards compatible: apps that don't catch the new
  error type just see faster rejections than today.

## Non-goals

- Replicating in-flight call results across leaders. Once the call has
  reached the old leader and that leader has crashed, the result is
  gone — we surface a clean failure, not magic recovery.
- Retrying non-idempotent methods. The default stays "let the caller
  decide," because silent retry of a `transferFunds` is worse than a
  visible failure.
- Distinguishing "leader died" from "leader is hung but recovering."
  We accept that fast-fail can occasionally fire on a leader that
  would have replied moments later.

## Design

### 1. `LeaderChangedError`

A typed error users can `instanceof`-check:

```ts
export class LeaderChangedError extends Error {
  readonly name = 'LeaderChangedError';
  readonly code = 'LEADER_CHANGED';
  constructor(message = 'Leader changed before reply was received') {
    super(message);
  }
}
```

Exported from the package root alongside `createSharedTabService`.

### 2. Drain pending deferreds on leader change

The spoke wrapper subscribes to the underlying `Spoke.onLeaderChange`.
When it fires, every entry in the `tab-election` `Tab._callDeferreds`
map represents a call that was waiting on the previous leader and will
never receive a reply. We reject each with `new LeaderChangedError()`
and clear the map.

```ts
spoke.onLeaderChange(() => {
  failPendingCalls(spoke, new LeaderChangedError());
});
```

#### How we reach the deferred map

`_callDeferreds` is private API on `tab-election`'s `Tab`. Two options:

- **(A) Monkey-patch / cast through.** We already do this elsewhere in
  the codebase (`inTabHub.setOptions` is patched in `client.ts` to
  suppress redundant elections). Same shape: cast `spoke` to access
  the internal tab, walk the map, reject each deferred, clear it.
  Risk: tied to `tab-election` internals; a refactor upstream breaks us.
- **(B) Upstream PR.** Add `tab.failPending(err: Error): void` to
  `tab-election`. Cleaner, and `tab-election` benefits too. Slower to
  ship.

Recommend: ship (A) first behind a feature flag (`heartbeat` is already
the established opt-out pattern), open the PR for (B) in parallel,
swap the implementation when (B) lands.

### 3. Batched calls

The batching proxy in `client.ts` keeps its own queue (`queue: QueuedCall[]`)
of calls that haven't yet been flushed to the leader, plus a set of
already-flushed calls awaiting the batch reply.

On leader change:

- **Queued (not yet flushed):** these are still local — re-flush against
  the new leader once it's available. Don't reject. (The new leader sees
  them as fresh calls and they succeed normally.)
- **Flushed but unreplied:** reject with `LeaderChangedError`, same as
  the direct path. The batch dispatch is one RPC under the hood, and
  that RPC's deferred is what gets drained.

This means batched calls have a slightly nicer fast-fail story than
direct calls — calls that hadn't left the spoke yet aren't visible to
the user as failures at all.

### 4. Opt-in idempotent retry

For methods the author declares safe, the client retries transparently.

#### Declaration

Two options for the surface:

- **(A) Service-level marker:**
  ```ts
  defineService('feed', {
    __idempotent: ['subscribe', 'unsubscribe'] as const,
    async subscribe(symbol: string) {
      /* … */
    },
    async unsubscribe(symbol: string) {
      /* … */
    },
  });
  ```
- **(B) Per-call option:**
  ```ts
  await client.feed.subscribe.idempotent('btc-usd');
  // or
  await client.feed.subscribe('btc-usd', { __idempotent: true });
  ```

Recommend **(A)**. It puts the contract next to the implementation
(the only place that can actually know whether a method is idempotent),
keeps the call site clean, and is amenable to a type-level guard that
restricts `.idempotent` access at compile time. The downside — the
caller can't override per-call — is the right tradeoff: idempotency is
a property of the method, not the invocation.

We may layer (B) on later as an escape hatch for methods that are
"idempotent in this specific context but not in general."

#### Retry behavior

Client proxy reads `__idempotent` at construction time. For matching
methods, on `LeaderChangedError`:

1. Wait for `spoke.isLeader` change to settle (we already have the hook
   that fired the rejection — chain off the same event).
2. Re-issue the call exactly once against the new leader.
3. Any error from the retry — including a second `LeaderChangedError` —
   propagates normally. No infinite loop on a flapping leader.

Pseudocode in the proxy:

```ts
const isIdempotent = (ns: string, method: string): boolean =>
  idempotentMethods.get(ns)?.has(method) ?? false;

const callOnce = (ns, method, args) => /* existing path */;

const callWithRetry = async (ns, method, args) => {
  try {
    return await callOnce(ns, method, args);
  } catch (err) {
    if (err instanceof LeaderChangedError && isIdempotent(ns, method)) {
      await waitForLeaderChange();
      return callOnce(ns, method, args);
    }
    throw err;
  }
};
```

### 5. Discovery of `__idempotent` on the client side

The client doesn't have direct access to the service object — services
live on the leader. Two paths:

- **(A) Compile-time only.** `__idempotent` is a TypeScript construct;
  the proxy reads it from the service definition at
  `createSharedTabService` time on whichever side has the service object
  (in-tab fallback always has it; SharedWorker mode does not). For
  SharedWorker mode we expose it via a one-shot `__describe` RPC at
  spoke construction.
- **(B) Runtime advertisement.** Hub broadcasts a `__describe` event on
  startup with the idempotency manifest; spokes cache it.

Recommend **(A)** with the one-shot describe call. Simpler, avoids a
broadcast for static data, and the manifest is small.

### 6. Public API surface

Additions:

```ts
// exported from the package root
export class LeaderChangedError extends Error {
  /* … */
}

// optional service field
interface SharedTabService<NS, Events> {
  // …existing fields
  readonly __idempotent?: ReadonlyArray<keyof this & string>;
}
```

No changes to `createSharedTabService` options. Fast-fail is on by
default; the only way to "disable" it is to opt out of the spoke
lifecycle entirely (which already exists via `heartbeat: false`, though
the two are independent — fast-fail rides on `Spoke.onLeaderChange`,
not on heartbeats).

## Tradeoffs

- **Reaching into `tab-election` internals.** Documented above. We
  already have one such patch in `client.ts`; adding a second is
  acceptable as long as we open the upstream PR alongside.
- **False fast-fails on a hung-but-recovering leader.** If a leader
  hangs long enough that election picks a new one, then unhangs and
  replies, the original caller has already been rejected. The reply
  arrives at the spoke and is dropped (`No deferred found for call <n>`,
  per `tab-election`). Net: we trade a 30s wait for an occasional
  spurious failure during pathological hangs. Worth it.
- **Idempotent retry doubles execution on partial-success.** If the
  old leader processed `subscribe('btc-usd')` to completion and crashed
  before the reply was sent, the retry runs it again on the new leader.
  For genuinely idempotent methods this is a no-op by definition —
  that's the contract `__idempotent` asserts. Authors who mis-mark a
  method get double execution; the type-level marker plus docs is the
  guard.
- **Type ergonomics.** `__idempotent` as a `readonly` tuple of method
  names lets us narrow at the call site (`client.feed.subscribe` is
  known-idempotent; `client.feed.transfer` is not). This is the same
  pattern as `as const` discriminated unions and works without codegen.

## Test plan

Unit tests:

- New error class: `instanceof Error`, `instanceof LeaderChangedError`,
  `.code === 'LEADER_CHANGED'`.
- `failPendingCalls` rejects every deferred and clears the map; running
  it twice in a row is a no-op (no second rejection).

Integration tests (`integration.test.ts`, leveraging the existing
multi-tab harness):

- **Direct fast-fail.** Tab A holds 3 in-flight `await client.svc.slow()`
  calls; tab B (the leader) crashes via `simulateCrash`. All 3 promises
  reject with `LeaderChangedError` within `intervalMs * 2` (well under
  the 30s baseline).
- **Batched fast-fail.** Same scenario, but with `batch: { flushMs: 50 }`
  and the kill scheduled between the flush and the reply. Calls in the
  flushed batch reject; calls still in the spoke queue succeed against
  the new leader.
- **Idempotent retry — happy path.** Service marks `subscribe` as
  idempotent. Tab A awaits `client.feed.subscribe('btc-usd')`. Leader
  killed mid-call. The promise resolves once with the new leader's
  result; no error propagates.
- **Idempotent retry — flapping leader.** Two leader changes during the
  retry window. The second `LeaderChangedError` propagates (no infinite
  retry).
- **Non-idempotent error path.** Method not in `__idempotent` rejects
  with `LeaderChangedError`; caller sees it.
- **Bound is exactly one retry.** Method in `__idempotent` that throws
  a non-leader-change error on retry surfaces that error directly,
  doesn't retry again.

## Rollout

1. Land `LeaderChangedError` (exported) + fast-fail on `onLeaderChange`
   for the direct path. Backwards compatible — apps see faster
   rejections than today, with a typed error they can opt-in to handle.
2. Extend fast-fail to the batching proxy. Probably reveals latent
   bugs in consumers that assumed 30s timeouts; document the change in
   the changeset.
3. Land `__idempotent` declaration + retry. Pure addition.
4. Open `tab-election` PR for `tab.failPending(err)`. Swap our
   monkey-patch for the upstream API once published.

## Out of scope (tracked separately)

Subscriber state restoration on leader change is a related-but-separate
concern; it lives in
[20260430-subscriber-restoration](./20260430-subscriber-restoration.md)
(if/when split out from `20260430-leader-change-resilience.md`).
