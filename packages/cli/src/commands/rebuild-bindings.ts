import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Rebuild the better-sqlite3 native binding against the *current* Node
 * runtime. The published npm package ships prebuilts for common Node
 * versions, but users on very new Node releases (no prebuilt yet) or who
 * upgraded Node after install will hit "bindings file not found" / ABI
 * mismatch errors. `npm rebuild better-sqlite3 --build-from-source`
 * produces a binding matching `process.versions.modules`, which fixes
 * both classes.
 *
 * Strategy:
 *   1. Locate the better-sqlite3 install root via `require.resolve`.
 *      Walking up from that to its package root gives us the directory
 *      `npm rebuild` needs to run in.
 *   2. Prefer the package manager that owns the install (pnpm if there's
 *      a `node_modules/.pnpm` sibling, npm otherwise).
 *   3. Stream child stdout/stderr through so the user sees node-gyp
 *      progress live — a 20–60s compile feels less like a hang.
 */
export interface RebuildBindingsOpts {
  /** When true, print what would be run without executing. */
  dryRun?: boolean;
  /** Override the resolved package manager (auto-detected otherwise). */
  packageManager?: "npm" | "pnpm";
}

function detectPackageManager(installRoot: string): "npm" | "pnpm" {
  // installRoot looks like .../node_modules/better-sqlite3 or
  // .../node_modules/.pnpm/better-sqlite3@x.y.z/node_modules/better-sqlite3.
  // The .pnpm segment is the unambiguous tell.
  return installRoot.includes(`${path.sep}.pnpm${path.sep}`) ? "pnpm" : "npm";
}

function findInstallRoot(): string | null {
  // better-sqlite3 isn't a direct dep of @ryanstark24/sfgraph-cli — it's
  // owned by @ryanstark24/sfgraph-core and @ryanstark24/sfgraph-server.
  // Walk through one of those to find the actual binding, matching the
  // resolution chain doctor.ts uses (so we rebuild the SAME copy that
  // would have been loaded at runtime, not a workspace-root duplicate).
  const here = createRequire(import.meta.url);
  const chains = ["@ryanstark24/sfgraph-core", "@ryanstark24/sfgraph-server"];
  for (const chain of chains) {
    try {
      const entry = here.resolve(chain);
      const downstream = createRequire(entry);
      const pkgPath = downstream.resolve("better-sqlite3/package.json");
      return path.dirname(pkgPath);
    } catch {
      // try next chain
    }
  }
  // Last resort: maybe better-sqlite3 IS resolvable directly (CLI ran from
  // a flat install layout, e.g. global npm with no workspace).
  try {
    const pkgPath = here.resolve("better-sqlite3/package.json");
    return path.dirname(pkgPath);
  } catch {
    return null;
  }
}

function workspaceRootFor(installRoot: string): string {
  // For pnpm: walk up past the `.pnpm/<pkg>/node_modules/<pkg>` chain to
  // the workspace root. For npm: parent of node_modules.
  const parts = installRoot.split(path.sep);
  const nodeModulesIdx = parts.lastIndexOf("node_modules");
  if (nodeModulesIdx < 0) return installRoot;
  // For pnpm, there may be a deeper node_modules — find the outermost one.
  const firstNodeModulesIdx = parts.indexOf("node_modules");
  return parts.slice(0, firstNodeModulesIdx).join(path.sep) || path.sep;
}

export async function rebuildBindingsCmd(opts: RebuildBindingsOpts = {}): Promise<void> {
  const installRoot = findInstallRoot();
  if (!installRoot) {
    console.error("sfgraph rebuild-bindings: better-sqlite3 not resolvable from this install.");
    console.error("  Run `npm install` (or `pnpm install`) first, then re-run this command.");
    process.exitCode = 1;
    return;
  }
  if (!existsSync(installRoot)) {
    console.error(`sfgraph rebuild-bindings: resolved install root does not exist: ${installRoot}`);
    process.exitCode = 1;
    return;
  }

  const pm = opts.packageManager ?? detectPackageManager(installRoot);
  const cwd = workspaceRootFor(installRoot);

  // pnpm and npm both accept `rebuild <pkg>`. --build-from-source forces a
  // fresh compile even if a stale prebuilt is cached — necessary when the
  // failure mode is "downloaded prebuilt for wrong ABI."
  const args =
    pm === "pnpm"
      ? ["rebuild", "better-sqlite3"]
      : ["rebuild", "better-sqlite3", "--build-from-source"];

  console.log(`sfgraph rebuild-bindings:`);
  console.log(`  Node:           ${process.version} (ABI ${process.versions.modules})`);
  console.log(`  Package mgr:    ${pm}`);
  console.log(`  Workspace:      ${cwd}`);
  console.log(`  Install root:   ${installRoot}`);
  console.log(`  Command:        ${pm} ${args.join(" ")}`);

  if (opts.dryRun) {
    console.log("  (dry-run — no command executed)");
    return;
  }

  console.log("");
  console.log("Running rebuild — this typically takes 20–60s on first run…");
  console.log("");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(pm, args, { cwd, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${pm} ${args[0]} exited with code ${code}`));
    });
  }).catch((e) => {
    console.error("");
    console.error(`sfgraph rebuild-bindings: failed — ${(e as Error).message}`);
    console.error(
      "  Common causes: no C++ toolchain installed (macOS: xcode-select --install; linux: install build-essential + python3).",
    );
    process.exitCode = 1;
  });

  if (process.exitCode === 1) return;

  // Verify the rebuild actually produced a loadable binding for the
  // current ABI. Doing this here turns "did it work?" from a separate
  // `sfgraph doctor` round-trip into a single command.
  try {
    const req = createRequire(import.meta.url);
    // Clear any cached failure from earlier in this process.
    delete (req.cache as Record<string, unknown> | undefined)?.[
      req.resolve("better-sqlite3")
    ];
    req("better-sqlite3");
    console.log("");
    console.log("✓ better-sqlite3 loads cleanly for the current Node runtime.");
    console.log("  Next: `sfgraph doctor` to verify org DBs open, then resume normal use.");
  } catch (e) {
    console.error("");
    console.error("✗ Rebuild completed but better-sqlite3 still fails to load:");
    console.error(`  ${(e as Error).message.split("\n")[0]}`);
    console.error("  Run `sfgraph doctor` for more detail.");
    process.exitCode = 1;
  }
}
