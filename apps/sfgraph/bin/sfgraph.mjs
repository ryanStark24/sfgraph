#!/usr/bin/env node
// To raise Node's heap ceiling (e.g. for very large orgs):
//   NODE_OPTIONS='--max-old-space-size=8192' sfgraph ingest …
// Default Node heap caps at ~4GB; not normally a problem but worth
// trying first if an ingest dies silently mid-run.
import { run } from "@ryanstark24/sfgraph-cli";

// Bare invocation (e.g. `npx sfgraph` from an MCP client config) starts the
// stdio MCP server. Any subcommand or flag (ingest, install, --help, etc.)
// goes through the CLI as-is.
const argv = process.argv.slice(2).length === 0 ? [...process.argv, "mcp"] : process.argv;

// Safety net: under Node 20+, an unhandled promise rejection terminates the
// process by default — which manifested as silent ingest deaths mid-run when
// a parallel batch site had Promise.all-with-orphan-rejections. Log loudly
// so future regressions of that class are visible instead of just looking
// like a clean exit.
process.on("unhandledRejection", (reason) => {
  console.error("[sfgraph] unhandled promise rejection:");
  console.error(reason);
  // Don't process.exit(1) — Node already will after this handler returns
  // with non-zero code if --unhandled-rejections=throw is the default.
  process.exitCode = 1;
});
process.on("uncaughtException", (err) => {
  console.error("[sfgraph] uncaught exception:");
  console.error(err);
  process.exitCode = 1;
});

run(argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
