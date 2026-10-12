import v8 from "node:v8";

/**
 * V8 heap growth for the sfgraph process (cycle 2 T2). Default 30: after each
 * full GC the next one is due once the heap has grown 30% past what survived.
 *
 * Without it, V8 on a 64-bit machine with plenty of RAM lets the heap grow up
 * to 4x the live set before the next full GC. An ingest makes a lot of
 * short-lived garbage: SOAP bodies, parse results and SQLite rows. On
 * a large live org the main heap's live set was about 450 MB, but the heap reached
 * about 1.1 GB. The pages V8 frees stay in RSS on macOS until the OS
 * reclaims them, so the peak RSS follows that high-water mark.
 *
 * Measured on a large Vlocity repo rebuild (with the 256 MB parse-worker cap):
 * 1.52 GB max RSS by default, 1.27 GB at 50, and 1.17 GB at 30, with no
 * change in wall time. The setting applies to every isolate in the process,
 * so parse workers get it too.
 *
 * To change it, set SFGRAPH_HEAP_GROWING_PERCENT=<1-1000>. Set it to 0 to use
 * V8's default. If `--heap-growing-percent` is already on the node command
 * line or in NODE_OPTIONS, that value is kept.
 */
export const DEFAULT_HEAP_GROWING_PERCENT = 30;

/** Returns the percent applied, or null when V8's own setting is left alone. */
export function applyHeapGrowth(
  env: Record<string, string | undefined> = process.env,
  execArgv: readonly string[] = process.execArgv,
  setFlags: (flags: string) => void = v8.setFlagsFromString,
): number | null {
  const explicit = /^--heap[-_]growing[-_]percent\b/;
  if (execArgv.some((a) => explicit.test(a))) return null;
  // Node (v22) rejects this V8 flag in NODE_OPTIONS, but a runtime that
  // accepts it must not have it overridden either.
  const nodeOpts = (env.NODE_OPTIONS ?? "").split(/\s+/).filter(Boolean);
  if (nodeOpts.some((a) => explicit.test(a))) return null;
  const raw = env.SFGRAPH_HEAP_GROWING_PERCENT;
  let pct = DEFAULT_HEAP_GROWING_PERCENT;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n === 0) return null;
    if (Number.isInteger(n) && n > 0 && n <= 1000) pct = n;
  }
  setFlags(`--heap-growing-percent=${pct}`);
  return pct;
}
