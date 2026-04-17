# shared-tab-service

**One service. Every tab. Zero duplication.**

Stop opening N WebSockets, N auth sessions, and N polling loops just because your user opened N tabs. `shared-tab-service` lets you define a service **once** and share a single live instance across every tab of your app — with fully typed RPC, typed events, and automatic transport selection under the hood.

```ts
const client = createSharedTabService({ name: 'my-app', services, workerUrl });

// Every tab calls this. Only the leader actually runs it.
const user = await client.auth.getUser();

// Every tab sees this event. Emitted once.
client.prices.on('tick', ({ symbol, price }) => update(symbol, price));
```

### Try it live

Open either in a few tabs at once to watch them share a single service instance in real time:

- **React demo** (benchmark panel + throughput-over-N chart) — [shared-tab-service-vite-react-demo.ahut10.workers.dev](https://shared-tab-service-vite-react-demo.ahut10.workers.dev)
- **Minimal vanilla-TS demo** — [shared-tab-service-vite-demo.ahut10.workers.dev](https://shared-tab-service-vite-demo.ahut10.workers.dev)

## Why you'll like it

- **Typed end-to-end.** Define your service, get a strongly-typed client everywhere — methods, arguments, return values, event names, event payloads. No codegen.
- **Best transport, picked for you.** `SharedWorker` when the browser supports it, a tab-elected leader over `BroadcastChannel` when it doesn't, an SSR-safe stub in Node. No branching in your app code.
- **Transparent batching.** Calls made in the same microtask are coalesced into a single message. Events emitted during a batched call are fanned out in one broadcast. Your code never knows.
- **Tiny surface area.** One function to host the hub, one function to get a client, one helper to declare a service. That's the whole library.
- **Credit where it's due.** Leader election and cross-tab messaging build on the excellent [`tab-election`](https://www.npmjs.com/package/tab-election) library. This package extends that foundation with automatic detection of what your browser supports, so work is offloaded via the most efficient mechanism available — `SharedWorker` when it's there, a tab-elected leader when it isn't.

## What it's good for

- A single shared **WebSocket / SSE / EventSource** feed that every tab subscribes to.
- **De-duping** expensive connections — IndexedDB handles, auth sessions, rate-limited API clients.
- Fanning out **subscriptions and polling** so the server sees one client per user, not one per tab.
- Any state or side-effect you'd rather run **once per browser**, not once per tab.

## Repo layout

This is a pnpm + Turborepo monorepo.

- [`packages/shared-tab-service`](./packages/shared-tab-service) — the library. **[Start here for the full docs, API, and examples.](./packages/shared-tab-service/README.md)**
- `examples/vite-demo` — minimal vanilla-TS Vite demo. **[Live](https://shared-tab-service-vite-demo.ahut10.workers.dev).**
- `examples/vite-react-demo` — React demo with a benchmark panel and a throughput-over-N chart. **[Live](https://shared-tab-service-vite-react-demo.ahut10.workers.dev).**

## Scripts

All tasks are orchestrated by Turborepo. Run from the root:

```bash
pnpm install

pnpm build       # build the library (demos don't need building to run locally)
pnpm dev         # run every package's dev script in parallel (lib watch + demo servers)
pnpm test        # run tests across the workspace
pnpm typecheck   # tsgo --noEmit per package
pnpm checks      # format:check + lint + test + typecheck, all in parallel
pnpm format      # oxfmt rewrite
```

To run an example on its own:

```bash
pnpm -F @hurling/vite-demo dev
pnpm -F @hurling/vite-react-demo dev
```

## License

[Apache-2.0](./LICENSE).
