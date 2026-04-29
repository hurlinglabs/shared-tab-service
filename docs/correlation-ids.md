# How RPC replies stay paired with their callers (correlation IDs)

`shared-tab-service` ships RPC over `BroadcastChannel`, which is a fan-out
broadcast medium — every spoke connected to the channel sees every message.
With many tabs in flight at once, the leader needs a way to make sure the
result of `client.db.getUser('alice')` from tab A doesn't get handed to
`client.db.getUser('bob')` running in tab B. That's the job of the
correlation ID scheme described here. We don't invent it ourselves —
[`tab-election`](https://www.npmjs.com/package/tab-election) provides the
underlying transport — but it's worth documenting because it's the contract
that makes concurrent calls safe to await.

> If you're auditing this, the relevant source is
> `node_modules/tab-election/dist/tab.js` (`Tab.call`, `Tab._onCall`,
> `Tab._onReturn`).

## The pair: `(spokeId, callNumber)`

Every call carries two pieces of routing data:

| Field        | Where it lives                           | What it identifies                |
| ------------ | ---------------------------------------- | --------------------------------- |
| `spokeId`    | `Tab._id` — set in the `Tab` constructor | The tab that originated the call  |
| `callNumber` | `Tab._callCount`, incremented per call   | The specific call within that tab |

`spokeId` is a 16-character random alphanumeric string generated once when the
spoke's `Tab` is constructed. It survives for the life of the tab. Two tabs
running the same code in the same browser get distinct `spokeId`s.

`callNumber` is a monotonically increasing integer, incremented before each
call. It's local to the tab — tab A's call #3 and tab B's call #3 are not
the same call, which is why we need both fields together.

The pair `(spokeId, callNumber)` uniquely identifies an in-flight call
across the whole channel.

## The request flow

1. **Caller side.** `Tab.call(name, ...args)` increments `_callCount`,
   records `(callNumber → { resolve, reject, timeout })` in
   `_callDeferreds`, and broadcasts `onCall(spokeId, callNumber, name, ...args)`
   addressed to the leader.
2. **Leader side.** `Tab._onCall(spokeId, callNumber, name, ...args)`
   dispatches to the registered service method. When it has a result (or an
   error), it broadcasts `onReturn(callNumber, error, result)` addressed
   directly to `spokeId` — not to `All`.
3. **Caller side, again.** `Tab._onReturn(callNumber, error, result)` looks
   up `_callDeferreds.get(callNumber)`, clears the timeout, and resolves or
   rejects the matching promise.

Because the reply is addressed to the originating `spokeId`, other tabs on
the same channel ignore it (their `_isToMe` check filters it out). Inside
the originating tab, `callNumber` picks the right deferred — even with 50
calls in flight, the result for call #17 only ever resolves the promise that
was registered at call #17.

## What this guarantees

- **Concurrent calls don't cross wires.** Any number of `await` chains can
  be in flight at once; each `(spokeId, callNumber)` pair has exactly one
  deferred entry, and `_onReturn` is the only path that resolves it.
- **Other tabs' replies are filtered out.** Replies are addressed to the
  caller's `spokeId`. A tab never sees replies meant for siblings.
- **Errors travel back as rejections.** `_onReturn(cn, error, result)`
  passes a non-null `error` straight to `deferred.reject`, so a `throw`
  inside a leader-side method becomes a rejected promise on the caller.
- **Stuck calls fail loudly.** Each deferred has a 30s timeout; if the
  reply never arrives the deferred is rejected with `Call timed out` and
  removed from the map.

## What this does _not_ try to handle

- **Cross-process correlation between unrelated apps.** `spokeId` is only
  unique within a single `BroadcastChannel`. Different `name` values use
  different channels and are isolated by construction.
- **Replay protection.** A misbehaving leader that re-sends an `onReturn`
  for the same `callNumber` after the deferred is cleared just logs
  `No deferred found for call <n>` and drops it.
- **Survival across leader change.** If the leader dies mid-call the
  deferred eventually times out. State recovery is the caller's
  responsibility — see the [proposal on spoke heartbeat and subscriber
  tracking](./spec/20260429-spoke-heartbeat-and-subscriber-tracking.md) for
  ongoing work in this area.

## Batching: same correlation, one envelope

When `batch: true` (the default), `shared-tab-service` wraps multiple
`(ns, method, args)` triples into a single `__sts_batch.dispatch(calls)`
RPC. The whole batch travels under one `(spokeId, callNumber)` pair. The
leader runs the calls in order and replies with an array of `BatchResult`
in the same order; the spoke-side queue in
[`buildBatchingProxy`](../packages/shared-tab-service/src/client.ts) splits
the array back into per-call resolve/reject pairs by index.

So at the transport layer there is still exactly one correlation ID per
network round-trip, and ordering within a batch is preserved by array
position rather than by ID.

## Tests that pin this down

`packages/shared-tab-service/src/integration.test.ts` includes a test that
fires 50 concurrent `client.counter.echo(...)` calls with distinct payloads
and asserts each promise resolves to the matching input. If anything ever
breaks the request/reply pairing, that test will fail before any user does.
