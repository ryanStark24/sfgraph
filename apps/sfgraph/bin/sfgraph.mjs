#!/usr/bin/env node
// To raise Node's heap ceiling (e.g. for very large orgs):
//   NODE_OPTIONS='--max-old-space-size=8192' sfgraph ingest …
// Default Node heap caps at ~4GB; not normally a problem but worth
// trying first if an ingest dies silently mid-run.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// PREFLIGHT: ensure the better-sqlite3 native binding matches the Node ABI
// before any sfgraph code is imported. Critical because graph-store.ts uses
// a static `import Database from "better-sqlite3"` — by the time that line
// evaluates, it's too late to recover from an ABI mismatch.
//
// Common trigger: machines with both nvm Node and Homebrew Node on PATH.
// Each `pnpm install` builds the prebuild for whichever Node was active
// at install time; switching shells breaks the binding.
preflightNativeDeps();

const { run } = await import("@ryanstark24/sfgraph-cli");

function preflightNativeDeps() {
  // apps/sfgraph doesn't declare better-sqlite3 as a direct dep, so a plain
  // `createRequire(import.meta.url)('better-sqlite3')` throws MODULE_NOT_FOUND
  // and the ABI-mismatch check below never fires. Resolve from sfgraph-core
  // instead — that package owns the dep.
  // apps/sfgraph only declares sfgraph-cli as a direct dep — sfgraph-core
  // (which owns the better-sqlite3 dep) is two hops away. Chain through the
  // cli to reach core, then resolve better-sqlite3 from core's view of the
  // module graph. This is the exact path the runtime uses, just done early.
  const binReq = createRequire(import.meta.url);
  let req;
  try {
    const cliPath = binReq.resolve("@ryanstark24/sfgraph-cli");
    const cliReq = createRequire(cliPath);
    const corePath = cliReq.resolve("@ryanstark24/sfgraph-core");
    req = createRequire(corePath);
  } catch {
    // sfgraph-core not yet linked (fresh checkout). Skip preflight; the
    // CLI's own startup will surface the missing-module error clearly.
    return;
  }
  try {
    // Loading the JS wrapper alone doesn't dlopen the .node file — that's
    // deferred to the first Database() construction. Force the dlopen now
    // by instantiating an in-memory DB and immediately closing it. Cheap
    // (~1ms) and catches the ABI mismatch up front.
    const Database = req("better-sqlite3");
    const probe = new Database(":memory:");
    probe.close();
    return;
  } catch (e) {
    const msg = String(e?.message ?? e);
    const abiMismatch =
      /NODE_MODULE_VERSION/.test(msg) ||
      /was compiled against a different Node\.?js version/i.test(msg) ||
      /Module did not self-register/i.test(msg);
    if (!abiMismatch) {
      // Some other failure — let the normal startup path surface it through
      // sfgraph-core's `loadBetterSqlite3` formatted error.
      return;
    }
    process.stderr.write(
      `\nsfgraph: better-sqlite3 native binding doesn't match Node ${process.version} (ABI ${process.versions.modules}).\n` +
        `Rebuilding from source — this takes ~20 seconds and only happens once per Node version.\n\n`,
    );
    const dir = locateBetterSqlite3(req);
    if (!dir) {
      process.stderr.write(
        "sfgraph: couldn't locate the better-sqlite3 package — run `pnpm rebuild better-sqlite3` manually.\n",
      );
      process.exit(1);
    }
    const r = spawnSync("npm", ["run", "build-release"], {
      cwd: dir,
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...process.env,
        npm_config_target: process.versions.node,
        npm_config_runtime: "node",
        npm_config_target_arch: process.arch,
        npm_config_target_platform: process.platform,
      },
    });
    if (r.status !== 0) {
      process.stderr.write("\nsfgraph: auto-rebuild failed. Run `pnpm rebuild better-sqlite3` manually.\n");
      process.exit(1);
    }
    process.stderr.write("sfgraph: rebuild succeeded — continuing.\n\n");
  }
}

function locateBetterSqlite3(req) {
  try {
    let dir = path.dirname(req.resolve("better-sqlite3"));
    for (let i = 0; i < 6; i++) {
      if (existsSync(path.join(dir, "package.json"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    /* fall through */
  }
  return null;
}

// Bare invocation (e.g. `npx sfgraph` from an MCP client config) starts the
// stdio MCP server. Any subcommand or flag (ingest, install, --help, etc.)
// goes through the CLI as-is.
const argv = process.argv.slice(2).length === 0 ? [...process.argv, "mcp"] : process.argv;

// Safety net: log and then crash on unhandled rejection / uncaught exception.
// Previously these handlers set `exitCode = 1` but didn't terminate, so the
// MCP server would keep running with poisoned state and every subsequent
// clean shutdown returned exit 1. Calling `exit(1)` after flushing stderr
// is the correct response — the partial state is no longer trustworthy.
process.on("unhandledRejection", (reason) => {
  console.error("[sfgraph] unhandled promise rejection:");
  console.error(reason);
  setTimeout(() => process.exit(1), 50).unref();
});
process.on("uncaughtException", (err) => {
  console.error("[sfgraph] uncaught exception:");
  console.error(err);
  setTimeout(() => process.exit(1), 50).unref();
});

// beforeExit fires ONLY on clean event-loop drain (never on signal/abort).
// If this prints before the ingest's own "fan-out complete" log, it means
// the loop drained while real work was still pending — the silent-exit
// failure mode we hit on cumulative jsforce/Bottleneck idle. The fan-out
// installs a ref'd keep-alive timer to prevent this, so seeing this log
// during an ingest is a regression worth investigating.
process.on("beforeExit", (code) => {
  if (process.env.SFGRAPH_DEBUG_INGEST === "1") {
    const handles =
      typeof process._getActiveHandles === "function" ? process._getActiveHandles().length : "?";
    const requests =
      typeof process._getActiveRequests === "function" ? process._getActiveRequests().length : "?";
    console.error(
      `[sfgraph] beforeExit code=${code} activeHandles=${handles} activeRequests=${requests}`,
    );
  }
});

run(argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
