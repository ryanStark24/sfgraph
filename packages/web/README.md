# @ryanstark24/sfgraph-web

Local web visualiser for an ingested sfgraph org. Boots via `sfgraph serve` (or `node dist/index.js` from this package) and serves a 3D force-graph viewer plus a small REST surface against the per-org SQLite store.

## What it does

- **Trace tab** — neighborhood graph from a focal node; pairs with the `trace_upstream` / `trace_downstream` MCP tools when you want a visual companion to the markdown output.
- **Overview tab** — top-level org topology: hubs by degree, layer counts, freshness signals.
- **Schema tab** — SObject/field topology with references resolved across layers.
- **Render entire org** button — hits `/api/full` for a full 3D force-graph of the ingested org. Obsidian-style auto-fading labels: top-N nearest nodes plus hubs stay labeled at any zoom.

## Security model

- Binds to **loopback only by default** (`127.0.0.1:7777`).
- Non-loopback binds require the explicit `--i-understand-public-bind` flag on `sfgraph serve`. Without that flag, attempts to set `--host 0.0.0.0` are rejected at startup.
- No authentication. The viewer is intended for local-machine use only. If you opt into a public bind, you are responsible for putting it behind your own auth/firewall.
- EADDRINUSE auto-recovery: if a stale `sfgraph serve` is already holding the port, it's terminated and the new one takes over.

## Tech stack

- Vanilla JS + [`3d-force-graph`](https://github.com/vasturiano/3d-force-graph) + [`three.js`](https://threejs.org/).
- **No React, no bundler.** The `public/` directory is served as-is.
- Server is a tiny Node HTTP listener that reads the per-org SQLite file. It does not write to the graph.

## Running in dev

```bash
# From repo root
pnpm --filter @ryanstark24/sfgraph-web build
cd packages/web && node dist/index.js

# Or via the published CLI (after `pnpm -r build`)
sfgraph serve
sfgraph serve --no-open                 # don't open a browser
sfgraph serve --port 8123               # alternate port
sfgraph serve --i-understand-public-bind --host 0.0.0.0
```

## Keyboard shortcuts

- `L` — toggle always-show labels on every node
- `F` — fit the graph to the viewport
- `Esc` — close the open side panel / popover

## REST endpoints

All endpoints are read-only.

| Path | Purpose |
|---|---|
| `GET /api/orgs` | List ingested orgs with last-sync timestamps |
| `GET /api/search?q=…&org=…` | Type-ahead node search by qname/label |
| `GET /api/neighborhood?org=…&qname=…&hops=N` | Subgraph around a focal node |
| `GET /api/overview?org=…` | Hubs, layer counts, freshness buckets |
| `GET /api/full?org=…` | Full org graph (nodes + edges) — backs "Render entire org" |
| `GET /api/schema?org=…` | SObject / field topology |
| `GET /api/rel-types?org=…` | Edge relationship-type catalogue |
