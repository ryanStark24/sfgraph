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

import { createRequire } from "node:module";
import { ErrorCode, SfgraphError } from "@ryanstark24/sfgraph-shared";

type Loader = (id: string) => unknown;

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
 * Load `better-sqlite3` via the provided `require` (or one we synthesize from
 * import.meta.url). On ABI mismatch, throw `SfgraphError(E_NATIVE_ABI_MISMATCH)`
 * with a copy-paste recovery message; on any other failure, rethrow.
 */
export function loadBetterSqlite3<T = unknown>(requireFn?: Loader): T {
  const req: Loader =
    requireFn ?? (createRequire(import.meta.url) as unknown as Loader);
  try {
    return req("better-sqlite3") as T;
  } catch (e) {
    const err = e as Error;
    if (isAbiMismatch(err.message)) {
      const hint = detectPackageManager();
      const bindingPath = resolveBindingPath(req);
      throw new SfgraphError(
        ErrorCode.E_NATIVE_ABI_MISMATCH,
        formatAbiMismatchMessage(err, hint, bindingPath),
        { cause: err },
      );
    }
    throw err;
  }
}
