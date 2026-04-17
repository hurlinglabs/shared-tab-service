# shared-tab-service

A tiny utility for running one shared service across every tab of a browser app, with fully typed RPC and automatic transport selection (SharedWorker → Tab-election leader → SSR-safe stub).

Monorepo layout:

- [`packages/shared-tab-service`](./packages/shared-tab-service) — the library. [Usage docs here.](./packages/shared-tab-service/README.md)
- `examples/vite-demo` — minimal vanilla-TS Vite demo.
- `examples/vite-react-demo` — React demo with a benchmark panel and a throughput-over-N chart.

## Scripts

All tasks are orchestrated by Turborepo. Run from the root:

```bash
pnpm install

pnpm build       # build the library (demos don't need building to run locally)
pnpm dev         # run every package's dev script in parallel (lib watch + demo servers)
pnpm test        # run tests across the workspace
pnpm typecheck   # tsgo --noEmit per package
pnpm check       # format:check + lint + test + typecheck, all in parallel
pnpm format      # oxfmt rewrite
```

To run a single example:

```bash
pnpm -F @hurling/vite-demo dev
pnpm -F @hurling/vite-react-demo dev
```
