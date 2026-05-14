#!/usr/bin/env node
/**
 * Postinstall verification for @ryanstark24/sfgraph-mcp.
 *
 * Loads `better-sqlite3` once; if it fails with a NODE_MODULE_VERSION /
 * ABI-mismatch error, attempts a single `npm rebuild better-sqlite3` against
 * the Node binary that's running this script. Whether the rebuild succeeds
 * or not, this script always exits 0 — we don't want to fail npm/pnpm/yarn
 * install on a recoverable issue. Failures print a clear, copy-paste-able
 * recovery command instead.
 *
 * This file is intentionally self-contained: it runs before
 * @ryanstark24/sfgraph-mcp's own JS has been compiled/loaded, so it must not
 * import any workspace package.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const ABI_MARKERS = [
  /NODE_MODULE_VERSION/,
  /was compiled against a different Node\.?js version/i,
  /Module did not self-register/i,
];

function isAbiError(msg) {
  return ABI_MARKERS.some((rx) => rx.test(msg));
}

function tryLoad() {
  try {
    const req = createRequire(import.meta.url);
    req("better-sqlite3");
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e };
  }
}

function logHeader() {
  process.stderr.write(
    `[sfgraph postinstall] verifying better-sqlite3 against Node ${process.version} (ABI ${process.versions.modules})\n`,
  );
}

function logRecovery(err) {
  process.stderr.write(
    [
      "",
      "[sfgraph postinstall] WARNING — better-sqlite3 native binding failed to load.",
      `  Node:      ${process.version}  (ABI ${process.versions.modules})`,
      `  exec:      ${process.execPath}`,
      `  error:     ${(err?.message ?? String(err)).split("\n")[0]}`,
      "",
      "  This usually means the prebuilt binding doesn't match your Node ABI.",
      "  Try one of:",
      "    npm rebuild better-sqlite3",
      "    pnpm rebuild better-sqlite3",
      "",
      "  If sfgraph is being launched by an IDE (Cursor / VS Code / Claude Desktop)",
      "  whose Node differs from your shell, re-run the rebuild from inside that",
      "  IDE's integrated terminal, or pin the absolute Node path via",
      "  `sfgraph install --local --pin-node <path-to-node>`.",
      "",
    ].join("\n"),
  );
}

logHeader();
const first = tryLoad();
if (first.ok) {
  process.stderr.write("[sfgraph postinstall] better-sqlite3 OK\n");
  process.exit(0);
}

if (!isAbiError(first.err?.message ?? "")) {
  // Some other failure (missing module, etc) — log and bail. Don't fail install.
  logRecovery(first.err);
  process.exit(0);
}

process.stderr.write(
  "[sfgraph postinstall] ABI mismatch detected — attempting `npm rebuild better-sqlite3`...\n",
);
const rebuild = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["rebuild", "better-sqlite3"],
  { stdio: "inherit" },
);

if (rebuild.status !== 0) {
  process.stderr.write("[sfgraph postinstall] rebuild attempt did not exit cleanly.\n");
}

const second = tryLoad();
if (second.ok) {
  process.stderr.write("[sfgraph postinstall] better-sqlite3 OK after rebuild\n");
  process.exit(0);
}

logRecovery(second.err);
process.exit(0);
