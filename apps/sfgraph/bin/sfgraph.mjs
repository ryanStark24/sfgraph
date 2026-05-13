#!/usr/bin/env node
import { run } from "@sfgraph/cli";

// Bare invocation (e.g. `npx sfgraph` from an MCP client config) starts the
// stdio MCP server. Any subcommand or flag (ingest, install, --help, etc.)
// goes through the CLI as-is.
const argv = process.argv.slice(2).length === 0 ? [...process.argv, "mcp"] : process.argv;

run(argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
