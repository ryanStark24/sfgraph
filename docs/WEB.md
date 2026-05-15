# Web visualiser

`sfgraph serve` boots a local web explorer for the ingested graph. It's optional — the MCP stdio surface is fully independent — but it gives a fast visual entry point for exploring relationships, schema, and trace results.

```bash
sfgraph serve                          # binds to http://localhost:7777
sfgraph serve --no-open                # don't auto-open the browser
sfgraph serve --port 8123              # alternate port
sfgraph serve --i-understand-public-bind --host 0.0.0.0   # expose beyond loopback (off by default)
```

The server binds to **loopback only** by default. EADDRINUSE is auto-recovered: if a stale `sfgraph serve` is holding the port, it's killed and the new one takes over. Non-loopback binds require the explicit `--i-understand-public-bind` flag.

## Tabs

- **Trace** — neighborhood graph from a focal node; pairs with `trace_upstream` / `trace_downstream`.
- **Overview** — top-level org topology (hubs, layer counts, freshness signals).
- **Schema** — SObject / field topology, references resolved across layers.
- **Render entire org** button hits `/api/full` for a full 3D force-graph of the ingested org.

## Keyboard shortcuts

- `L` — toggle always-show labels
- `F` — fit graph to viewport
- `Esc` — close panels / popovers

The viewer is an Obsidian-style 3D force-graph (3d-force-graph + three.js). Top-N nearest nodes plus hub overrides get auto-fading labels so the canvas stays legible at any zoom. Source lives in `packages/web/` — vanilla JS, no React, no bundler.
