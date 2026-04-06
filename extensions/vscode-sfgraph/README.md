# sfgraph VS Code Extension

This extension adds a small control surface for local `sfgraph` development and usage inside VS Code.

## Commands

- `sfgraph: Install Dependencies`
- `sfgraph: Start MCP Server`
- `sfgraph: Stop MCP Server`
- `sfgraph: Write Cursor MCP Config`

## What It Automates

- Runs `uv sync` and `npm install` in the repo
- Starts `python -m sfgraph.server` using the local `.venv` when available
- Adds a status bar button to start or stop the MCP server
- Writes a ready-to-use `.cursor/mcp.json` entry for the current workspace

## Limitation

It can write config files for IDEs that store MCP settings in workspace files, but it cannot directly register tools inside every third-party IDE unless that IDE exposes a public config format or API.
