#!/usr/bin/env node
/**
 * sfgraph pre-publish test kit — Tier 1 (local, no org required).
 *
 * One command → GO / NO-GO for publishing. Runs the full local quality gate
 * AND the release-artifact verification (the layer that catches packaging bugs
 * source-level tests can't — e.g. the 1.2.0 `workspace:*`-in-tarball disaster).
 *
 * Stages, in order (fail-fast):
 *   1. lint        — pnpm -r lint
 *   2. typecheck   — pnpm -r typecheck
 *   3. build       — pnpm -r build  (dist must be fresh for the pack scan)
 *   4. test        — pnpm -r test
 *   5. preflight   — node scripts/preflight-publish.mjs  (packs every publish
 *                    candidate, scans the tarball for workspace:* leaks, checks
 *                    dist freshness, changelog, git tag, clean tree)
 *
 * This script NEVER publishes. It is the gate you run before
 * `pnpm release:publish` (which itself re-runs preflight). Publishing is a
 * pnpm workspace — always `pnpm publish` / `pnpm release:publish`, NEVER
 * `npm publish` (npm ships literal `workspace:*` deps and every install fails).
 *
 * Tier 2 (org-connected validation) cannot run here — it needs an authenticated
 * Vlocity/OmniStudio org. See TESTKIT.md for the Tier-2 checklist.
 *
 * Usage:
 *   node scripts/test-kit.mjs              # full gate
 *   node scripts/test-kit.mjs --skip-tests # skip stage 4 (and preflight tests)
 *
 * Exit 0 = GO (Tier 1 green). Exit 1 = NO-GO.
 */
import { spawnSync } from "node:child_process";

const skipTests = process.argv.includes("--skip-tests");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Each stage: [label, command, args]. Fail-fast — stop at first NO-GO. */
const stages = [
  ["lint", "pnpm", ["-r", "lint"]],
  ["typecheck", "pnpm", ["-r", "typecheck"]],
  ["build", "pnpm", ["-r", "build"]],
  ...(skipTests ? [] : [["test", "pnpm", ["-r", "test"]]]),
  [
    "preflight (pack + tarball scan)",
    "node",
    ["scripts/preflight-publish.mjs", ...(skipTests ? ["--skip-tests"] : [])],
  ],
];

console.log(`\n${BOLD}sfgraph test kit — Tier 1 (local)${RESET}`);
console.log(`${DIM}node ${process.version} · ${stages.length} stages · publish gate only, never publishes${RESET}\n`);

const results = [];
let failed = false;

for (const [label, cmd, args] of stages) {
  process.stdout.write(`▶ ${label} … `);
  const started = Date.now();
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const ok = r.status === 0;
  results.push({ label, ok, secs });
  if (ok) {
    console.log(`${GREEN}PASS${RESET} ${DIM}(${secs}s)${RESET}`);
  } else {
    console.log(`${RED}FAIL${RESET} ${DIM}(${secs}s)${RESET}`);
    // Surface the tail of the failing output so the user sees why without re-running.
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd().split("\n").slice(-25).join("\n");
    console.log(`${DIM}${out}${RESET}\n`);
    failed = true;
    break; // fail-fast
  }
}

console.log(`\n${BOLD}Summary${RESET}`);
for (const { label, ok, secs } of results) {
  console.log(`  ${ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`} ${label} ${DIM}${secs}s${RESET}`);
}

if (failed) {
  console.log(`\n${RED}${BOLD}NO-GO${RESET} — fix the failing stage above, then re-run. Do NOT publish.\n`);
  process.exit(1);
}

console.log(`\n${GREEN}${BOLD}GO${RESET} — Tier 1 green. Next:`);
console.log(`  • Tier 2 (real org): run the checklist in TESTKIT.md on an org-connected machine.`);
console.log(`  • Publish (pnpm workspace): ${BOLD}pnpm release:publish${RESET} ${DIM}(never \`npm publish\`)${RESET}\n`);
process.exit(0);
