#!/usr/bin/env node
/**
 * Postinstall verification for @ryanstark24/sfgraph.
 *
 * Three responsibilities, in order:
 *
 *   1. **Re-sign native addons on macOS.** Node addons (`.node` files) ship
 *      with a "linker-signed adhoc" placeholder signature emitted by the
 *      build toolchain. macOS 26+ enforces code-signing strictly and SIGKILLs
 *      any process that tries to `dlopen()` a `.node` file whose pages don't
 *      pass validation. The kill happens at kernel level, bypasses every JS
 *      handler, and produces *silent* mid-run process exits with no error
 *      message. Re-signing with `codesign --force --sign -` (fresh ad-hoc
 *      signature, no developer cert required) makes dyld happy again.
 *      This is run unconditionally on darwin, regardless of whether we end
 *      up rebuilding. Handles both freshly-built addons AND prebuilt ones
 *      whose signatures got mangled in transit (proxies, mirrors, tarball
 *      re-extraction).
 *
 *   2. **Verify better-sqlite3 loads against the current Node ABI.** If it
 *      fails with a NODE_MODULE_VERSION mismatch, run a single
 *      `npm rebuild better-sqlite3` to recompile against this Node, then
 *      re-sign and retry.
 *
 *   3. **Always exit 0** — never fail npm/pnpm/yarn install on a recoverable
 *      issue. Failures print a clear, copy-paste-able recovery command.
 *
 * This file is intentionally self-contained: it runs before
 * @ryanstark24/sfgraph's own JS has been compiled/loaded, so it must not
 * import any workspace package.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");

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
    `[sfgraph postinstall] verifying native deps against Node ${process.version} (ABI ${process.versions.modules}) on ${process.platform}/${process.arch}\n`,
  );
}

/**
 * Walk a directory tree, depth-first, calling `onFile` for every regular
 * file. Skips symlinks to avoid loops; skips deeply-nested `.pnpm` cycles.
 * Defensive: any single-directory readdir failure is swallowed so one
 * permission error doesn't halt the whole walk.
 */
function walkFiles(root, onFile, depth = 0) {
  if (depth > 12) return; // sanity cap
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name === "node_modules" && depth === 0) {
      // Walk into the top-level node_modules.
      walkFiles(join(root, ent.name), onFile, depth + 1);
      continue;
    }
    const full = join(root, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      walkFiles(full, onFile, depth + 1);
    } else if (ent.isFile()) {
      onFile(full);
    }
  }
}

/**
 * Re-sign every `.node` file under PACKAGE_ROOT with a fresh ad-hoc
 * signature. No-op on non-macOS. Failures are logged but never fatal.
 */
function resignNativeAddons() {
  if (process.platform !== "darwin") return { resigned: 0, failed: 0, skipped: true };
  const files = [];
  walkFiles(PACKAGE_ROOT, (p) => {
    if (p.endsWith(".node")) files.push(p);
  });
  if (files.length === 0) {
    return { resigned: 0, failed: 0, skipped: false };
  }
  process.stderr.write(
    `[sfgraph postinstall] re-signing ${files.length} native addon${files.length === 1 ? "" : "s"} with ad-hoc signature (macOS code-signing requirement)\n`,
  );
  let resigned = 0;
  let failed = 0;
  for (const f of files) {
    // Skip zero-byte files defensively (some prebuild caches leave stubs).
    try {
      if (statSync(f).size === 0) continue;
    } catch {
      continue;
    }
    const r = spawnSync("codesign", ["--force", "--sign", "-", "--timestamp=none", f], {
      stdio: "pipe",
      encoding: "utf8",
    });
    if (r.status === 0) {
      resigned += 1;
    } else {
      failed += 1;
      // Don't spam: only show first failure detail.
      if (failed === 1) {
        process.stderr.write(
          `[sfgraph postinstall] codesign failed for ${f}: ${(r.stderr || r.stdout || "").trim().split("\n")[0] || "unknown error"}\n`,
        );
      }
    }
  }
  process.stderr.write(
    `[sfgraph postinstall] codesign: ${resigned} re-signed, ${failed} failed\n`,
  );
  return { resigned, failed, skipped: false };
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
      "  This usually means one of:",
      "    1. The prebuilt binding doesn't match your Node ABI — run:",
      "         npm rebuild better-sqlite3",
      "    2. macOS rejected the binding's code signature (silent SIGKILL).",
      `       Re-sign manually:`,
      `         find "${PACKAGE_ROOT}" -name '*.node' -exec codesign --force --sign - {} \\;`,
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

// Step 1: always re-sign on macOS, before any load attempt. The prebuilt
// binary's "linker-signed adhoc" stamp is exactly what macOS 26 rejects;
// replacing it with a real ad-hoc signature is what makes dlopen work.
resignNativeAddons();

// Step 2: try loading the binding.
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

// Step 3: ABI mismatch — rebuild, re-sign the freshly-built binary, retry.
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

// Step 4: re-sign the freshly-rebuilt addon (this is the critical step on
// macOS 26 — without it, the rebuilt .node will SIGKILL on first dlopen).
resignNativeAddons();

const second = tryLoad();
if (second.ok) {
  process.stderr.write("[sfgraph postinstall] better-sqlite3 OK after rebuild\n");
  process.exit(0);
}

logRecovery(second.err);
process.exit(0);
