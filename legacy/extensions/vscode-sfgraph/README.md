# sfgraph VS Code Extension

This extension adds a small control surface for local `sfgraph` development and usage inside VS Code.

## Commands

- `sfgraph: Install Dependencies`
- `sfgraph: Start MCP Server`
- `sfgraph: Stop MCP Server`
- `sfgraph: Write Cursor MCP Config`
- `sfgraph: Show Ingestion Progress`

## What It Automates

- Runs `uv sync` and `npm install` in the repo
- Starts `python -m sfgraph.server` using the local `.venv` when available
- Adds a status bar button to start the MCP server and then shows live ingestion progress
- Polls `ingestion_progress.json` on an interval and updates the status bar with phase and file counts
- Writes a ready-to-use `.cursor/mcp.json` entry for the current workspace

## Progress Polling

When the extension starts the server, it polls the configured `sfgraph` data directory for the latest ingestion progress snapshot.

Relevant settings:

- `sfgraph.dataDir`: override the data directory if you are not using `<repo>/data`
- `sfgraph.progressPollMs`: polling interval in milliseconds

## Limitation

It can write config files for IDEs that store MCP settings in workspace files, but it cannot directly register tools inside every third-party IDE unless that IDE exposes a public config format or API.
