/**
 * Centralized loader for `better-sqlite3` that converts the cryptic native
 * "NODE_MODULE_VERSION X / was compiled against Y" runtime error into a
 * `SfgraphError(E_NATIVE_ABI_MISMATCH, ...)` with actionable, copy-paste
 * recovery commands.
 *
 * The most common cause is an IDE-spawned MCP child running a different Node
 * binary than the shell that did `pnpm install` / `pnpm rebuild`. Cursor and
 * VS Code ship their own Node; if the shell Node ABI differs, the prebuilt
 * binding loaded into the IDE child fails to dlopen.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ErrorCode, SfgraphError } from "@ryanstark24/sfgraph-shared";

type Loader = ((id: string) => unknown) & {
  resolve?: (id: string) => string;
  cache?: Record<string, unknown>;
};

/** ABI mismatch detection heuristic. Matches the V8 / Node-API messages
 *  produced when the loaded `.node` file was compiled against a different
 *  NODE_MODULE_VERSION than the running process. */
export function isAbiMismatch(message: string): boolean {
  return (
    /NODE_MODULE_VERSION/.test(message) ||
    /was compiled against a different Node\.?js version/i.test(message) ||
    /Module did not self-register/i.test(message)
  );
}

interface PackageManagerHint {
  /** Detected package manager (best-effort from npm_config_user_agent). */
  pm: "pnpm" | "npm" | "yarn" | "bun" | "unknown";
  /** Recovery command the user can paste. */
  rebuildCmd: string;
}

function detectPackageManager(): PackageManagerHint {
  const ua = process.env.npm_config_user_agent ?? "";
  if (/pnpm/.test(ua)) return { pm: "pnpm", rebuildCmd: "pnpm rebuild better-sqlite3" };
  if (/yarn/.test(ua)) return { pm: "yarn", rebuildCmd: "yarn rebuild better-sqlite3" };
  if (/bun/.test(ua)) return { pm: "bun", rebuildCmd: "bun pm rebuild better-sqlite3" };
  if (/npm/.test(ua)) return { pm: "npm", rebuildCmd: "npm rebuild better-sqlite3" };
  return { pm: "unknown", rebuildCmd: "npm rebuild better-sqlite3" };
}

/** Attempt to locate the resolved path of the better-sqlite3 binding for
 *  diagnostics. Returns null on failure — never throws. */
function resolveBindingPath(requireFn: Loader): string | null {
  try {
    // require.resolve isn't directly typed on the Loader; round-trip via the
    // module record.
    const mod = requireFn("better-sqlite3") as { name?: string };
    void mod; // touch to ensure load succeeded; caller already handles that path
    return null;
  } catch {
    return null;
  }
}

function formatAbiMismatchMessage(
  original: Error,
  hint: PackageManagerHint,
  bindingPath: string | null,
): string {
  const lines: string[] = [
    "Failed to load native module `better-sqlite3` — ABI mismatch.",
    "",
    `  Node:           ${process.version}  (ABI / NODE_MODULE_VERSION: ${process.versions.modules})`,
    `  exec path:      ${process.execPath}`,
  ];
  if (bindingPath) lines.push(`  binding path:   ${bindingPath}`);
  lines.push(
    "",
    "  Underlying error:",
    `    ${original.message.split("\n")[0]}`,
    "",
    "  Recovery:",
    `    ${hint.rebuildCmd}`,
    "",
    "  Note: when the MCP server is spawned by an IDE (Cursor, VS Code, Claude",
    "  Desktop), the IDE may use a different Node binary than your shell.",
    "  If `sfgraph doctor` reports a mismatch, re-run the rebuild using the",
    "  IDE's Node (or pin an absolute node path via `sfgraph install --local",
    "  --pin-node <path>`).",
  );
  return lines.join("\n");
}

/**
 * If `err` is a native-binding ABI mismatch (matched by `isAbiMismatch`),
 * convert it to a `SfgraphError(E_NATIVE_ABI_MISMATCH, ...)` with the
 * full diagnostic message and recovery commands. Otherwise return null
 * (caller should rethrow the original).
 *
 * Use this around `new Database(...)` calls or in `catch` blocks where
 * `import Database from "better-sqlite3"` was used statically (the binding
 * load is deferred until the first construction in some Node versions).
 */
export function wrapAbiError(err: unknown): SfgraphError | null {
  if (!(err instanceof Error)) return null;
  if (!isAbiMismatch(err.message)) return null;
  const hint = detectPackageManager();
  return new SfgraphError(
    ErrorCode.E_NATIVE_ABI_MISMATCH,
    formatAbiMismatchMessage(err, hint, null),
    { cause: err },
  );
}

/**
 * Locate the better-sqlite3 package directory (where package.json lives)
 * by resolving the module entry and walking up. Returns null on failure —
 * the auto-rebuild path then falls through to the manual error.
 */
function locateBetterSqlite3Dir(req: Loader): string | null {
  try {
    if (typeof req.resolve !== "function") return null;
    let dir = path.dirname(req.resolve("better-sqlite3"));
    // Walk up until we find package.json with the right name. The require.resolve
    // typically lands inside lib/, so 1-3 levels of ".." gets us there.
    for (let i = 0; i < 6; i++) {
      const pkg = path.join(dir, "package.json");
      if (existsSync(pkg)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Compile better-sqlite3 from source against the currently-running Node.
 * Uses the package's own `build-release` npm script, which invokes node-gyp
 * with the right target. process.execPath is inherited via env so node-gyp
 * targets THIS node, not whatever is on PATH.
 *
 * Returns true on success. Prints progress to stderr so the user sees
 * what's happening — a 20-30 second rebuild can otherwise look like a
 * hang.
 */
function rebuildBetterSqlite3(pkgDir: string): boolean {
  process.stderr.write(
    `\nsfgraph: better-sqlite3 native binding doesn't match Node ${process.version} — rebuilding from source…\n`,
  );
  const result = spawnSync("npm", ["run", "build-release"], {
    cwd: pkgDir,
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      // Ensure node-gyp targets the running Node, not whatever default it
      // would pick up from PATH.
      npm_config_target: process.versions.node,
      npm_config_runtime: "node",
      npm_config_target_arch: process.arch,
      npm_config_target_platform: process.platform,
    },
  });
  if (result.status === 0) {
    process.stderr.write("sfgraph: rebuild succeeded — retrying load.\n");
    return true;
  }
  process.stderr.write("sfgraph: rebuild failed; falling back to manual remediation.\n");
  return false;
}

export interface LoadOpts {
  /** When true, on ABI mismatch attempt `npm run build-release` against the
   *  currently-running Node, then retry once. Default false (preserves the
   *  library-callable behaviour for test fixtures). */
  autoRebuild?: boolean;
}

/**
 * Load `better-sqlite3` via the provided `require` (or one we synthesize from
 * import.meta.url). On ABI mismatch:
 *   - if `autoRebuild` is true, attempt a from-source rebuild against the
 *     currently-running Node and retry the load. This eliminates the
 *     "two Nodes on PATH" foot-gun for nvm + Homebrew users.
 *   - otherwise (or if the rebuild fails), throw
 *     `SfgraphError(E_NATIVE_ABI_MISMATCH)` with copy-paste recovery.
 * On any other failure, rethrow as-is.
 */
export function loadBetterSqlite3<T = unknown>(requireFn?: Loader, opts: LoadOpts = {}): T {
  const req: Loader = requireFn ?? (createRequire(import.meta.url) as unknown as Loader);
  try {
    return req("better-sqlite3") as T;
  } catch (e) {
    const err = e as Error;
    if (!isAbiMismatch(err.message)) throw err;

    if (opts.autoRebuild) {
      const pkgDir = locateBetterSqlite3Dir(req);
      if (pkgDir && rebuildBetterSqlite3(pkgDir)) {
        // Bust the require cache so the next call re-dlopens the freshly
        // compiled .node file instead of reusing the in-memory failed module.
        try {
          const r = req as { cache?: Record<string, unknown>; resolve?: (id: string) => string };
          if (r.cache && r.resolve) {
            const k = r.resolve("better-sqlite3");
            delete r.cache[k];
          }
        } catch {
          /* best effort */
        }
        try {
          return req("better-sqlite3") as T;
        } catch (retryErr) {
          // Fall through to the formatted error below.
          err.message = `${err.message}\n\nretry after rebuild also failed: ${(retryErr as Error).message}`;
        }
      }
    }

    const hint = detectPackageManager();
    const bindingPath = resolveBindingPath(req);
    throw new SfgraphError(
      ErrorCode.E_NATIVE_ABI_MISMATCH,
      formatAbiMismatchMessage(err, hint, bindingPath),
      { cause: err },
    );
  }
}
