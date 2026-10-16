import v8 from "node:v8";
import type { Worker } from "node:worker_threads";

/**
 * `--max-old-space-size` is a process-wide V8 flag. When it is set (often via
 * NODE_OPTIONS, which many Salesforce developers raise for the `sf` CLI), V8
 * applies it to every isolate created afterwards and it overrides a worker's
 * `resourceLimits.maxOldGenerationSizeMb`, so a capped worker is not capped.
 *
 * V8 reads the flag when an isolate is created, so clearing it while a capped
 * worker starts and restoring it once the worker is online keeps the cap
 * without touching the main heap (sized at startup) or later workers.
 */

const FLAG = /^--max[-_]old[-_]space[-_]size(?:=(\d+))?$/;

/** The `--max-old-space-size` (MB) the process was started with, or null. Last one wins. */
export function startupMaxOldSpaceMb(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string = process.env.NODE_OPTIONS ?? "",
): number | null {
  // NODE_OPTIONS is applied before the command-line flags.
  const tokens = [...nodeOptions.split(/\s+/).filter(Boolean), ...execArgv];
  let mb: number | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const m = FLAG.exec(tokens[i] as string);
    if (!m) continue;
    const raw = m[1] ?? tokens[i + 1];
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) mb = n;
  }
  return mb;
}

let starting = 0;

/**
 * Create a worker with `create` so its `resourceLimits` heap cap holds even
 * when the process runs with `--max-old-space-size`. Without that flag this is
 * just `create()`.
 */
export function createHeapCappedWorker(
  create: () => Worker,
  maxOldSpaceMb: number | null = startupMaxOldSpaceMb(),
  setFlags: (flags: string) => void = v8.setFlagsFromString,
): Worker {
  if (maxOldSpaceMb === null) return create();
  if (starting === 0) setFlags("--max-old-space-size=0");
  starting += 1;
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    starting -= 1;
    if (starting === 0) setFlags(`--max-old-space-size=${maxOldSpaceMb}`);
  };
  let worker: Worker;
  try {
    worker = create();
  } catch (e) {
    settle();
    throw e;
  }
  // The isolate exists once the worker is online; error/exit cover a worker
  // that never gets there.
  worker.once("online", settle);
  worker.once("error", settle);
  worker.once("exit", settle);
  return worker;
}
