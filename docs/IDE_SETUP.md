# IDE Setup

This document shows how to connect the `sfgraph` MCP server to common IDEs and MCP clients.

The server runs over `stdio`, so each client needs the same core configuration:

- command: Python from this repo's virtual environment
- args: `-m sfgraph.server`
- cwd: the `sfgraph` repo root
- env: `PYTHONPATH=<repo>/src`

## Before You Start

From a fresh machine:

```bash
git clone <your-repo-url>
cd sfgraph
uv sync
npm install
```

Then verify the server starts:

```bash
PYTHONPATH=src .venv/bin/python -m sfgraph.server
```

If you want optional LLM-assisted query behavior, set both:

- `SFGRAPH_ALLOW_NETWORK=1`
- `OPENAI_API_KEY`

Neither is required for normal MCP usage.

## Cursor

Workspace config file:

`<workspace>/.cursor/mcp.json`

Example:

```json
{
  "mcpServers": {
    "sfgraph": {
      "command": "/absolute/path/to/sfgraph/.venv/bin/python",
      "args": ["-m", "sfgraph.server"],
      "cwd": "/absolute/path/to/sfgraph",
      "env": {
        "PYTHONPATH": "/absolute/path/to/sfgraph/src"
      }
    }
  }
}
```

Notes:

- Add `SFGRAPH_ALLOW_NETWORK=1` and `OPENAI_API_KEY` under `env` only if you want optional LLM query-agent support.
- The export directory you ingest must live inside the active workspace root because the MCP server enforces workspace-local paths.

If you publish the npm bootstrap package, an `npx`-based config can be used instead:

```json
{
  "servers": {
    "sfgraph": {
      "command": "npx",
      "args": ["-y", "@ryanstark24/sfgraph-mcp@beta"]
    }
  }
}
```

## VS Code MCP Clients

If you are using a VS Code MCP client such as Cline or Roo Code, the config shape varies slightly, but the process is the same:

- command: `/absolute/path/to/sfgraph/.venv/bin/python`
- args: `["-m", "sfgraph.server"]`
- cwd: `/absolute/path/to/sfgraph`
- env:
  - `PYTHONPATH=/absolute/path/to/sfgraph/src`

If the extension expects a JSON server block, reuse the same structure shown in the Cursor example.

### VS Code Extension Option

This repo also includes a companion VS Code extension at [`extensions/vscode-sfgraph`](../extensions/vscode-sfgraph/README.md).

Use it when you want:

- a one-click dependency install flow
- a start/stop button for the local MCP server
- automatic writing of `.cursor/mcp.json` for the current workspace

Boundary:

- the extension can manage local setup and write workspace config files
- it cannot directly register MCP tools into arbitrary IDE extensions unless those extensions expose a writable config or API

## npm Bootstrap Package

This repo now contains an npm launcher in [`package.json`](../package.json) and [`bin/sfgraph-mcp.js`](../bin/sfgraph-mcp.js).

The launcher is designed for configurations like:

```json
{
  "servers": {
    "sfgraph": {
      "command": "npx",
      "args": ["-y", "@ryanstark24/sfgraph-mcp@beta"]
    }
  }
}
```

Behavior:

- bootstraps a cached Python virtual environment
- installs the Python `sfgraph` package
- sets `NODE_PATH` so the Apex worker can find `web-tree-sitter-sfapex`
- starts `python -m sfgraph.server`

## Claude Desktop

Config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\\Claude\\claude_desktop_config.json`

Example:

```json
{
  "mcpServers": {
    "sfgraph": {
      "command": "/absolute/path/to/sfgraph/.venv/bin/python",
      "args": ["-m", "sfgraph.server"],
      "cwd": "/absolute/path/to/sfgraph",
      "env": {
        "PYTHONPATH": "/absolute/path/to/sfgraph/src"
      }
    }
  }
}
```

Restart Claude Desktop after updating the config.

## Windsurf and Other stdio Clients

Any MCP client that supports launching a local `stdio` server can use `sfgraph`.

Use:

- command: Python executable from `.venv`
- args: `-m sfgraph.server`
- cwd: repo root
- env: `PYTHONPATH=<repo>/src`

## Recommended Per-Project Layout

For clean isolation across multiple Salesforce projects:

```text
workspace/
  sfgraph/
  ProjectA/
    export/
    .sfgraph-data/
  ProjectB/
    export/
    .sfgraph-data/
```

Example ingest commands:

```bash
uv run sfgraph ingest /absolute/path/to/ProjectA/export --data-dir /absolute/path/to/ProjectA/.sfgraph-data
uv run sfgraph ingest /absolute/path/to/ProjectB/export --data-dir /absolute/path/to/ProjectB/.sfgraph-data
```

## Sanity Check After Connecting

Once the IDE detects the server, try:

- `ping`
- `get_ingestion_status`
- `ingest_org("/absolute/path/to/export")`
- `query("what writes to Account.Status__c?")`

If the server starts but queries are empty, ingest the export first.
