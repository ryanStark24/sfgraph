/**
 * Parse worker entry (spawned by `parsePool` from the compiled
 * `parse-worker.js`). Loads the same parser registry as the main thread (the
 * side-effect parser imports via parse-member, plus the YAML rule parsers),
 * then parses members one at a time, in arrival order, with the same
 * `parseMember` the serial path uses. Parser log calls are recorded and
 * shipped back with the result. A result that is not plain data is not
 * shipped (structured clone could change it); the main thread re-parses it.
 *
 * Raw `console.*` output from code running here (e.g. SFGRAPH_DEBUG_INGEST
 * diagnostics inside a parser) is forwarded to the parent's stdout
 * asynchronously: it is NOT ordered relative to main-thread output. The
 * ingest's own `[trace] parse ←` lines are emitted on the main thread when
 * each result is applied, in member order.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { Logger } from "@ryanstark24/sfgraph-shared";
import { loadAllRules } from "../parsers/rules/_loader.js";
import { type MemberParse, parseMember } from "./parse-member.js";
import type { ParseJobMsg, ParseLogEntry, ParseWorkerData, ParseWorkerMsg } from "./parse-pool.js";

/** True when `v` is built only from primitives, plain objects and arrays. */
export function isPlainData(v: unknown, depth = 0): boolean {
  if (v === null || v === undefined) return true;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (t !== "object") return false; // function, symbol, bigint
  if (depth > 200) return false;
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) return false;
    for (const x of v) if (!isPlainData(x, depth + 1)) return false;
    return true;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const k of Object.keys(v as object)) {
    if (!isPlainData((v as Record<string, unknown>)[k], depth + 1)) return false;
  }
  return true;
}

function plainOutcome(o: MemberParse): boolean {
  if (o.kind !== "parsed") return true;
  const r = o.result;
  return (
    isPlainData(r.nodes) &&
    isPlainData(r.edges) &&
    (r.snippets === undefined || isPlainData(r.snippets))
  );
}

const port = parentPort;
if (port) {
  const { base } = workerData as ParseWorkerData;
  // Attach the listener first so no job can arrive before it; jobs wait on init.
  const init = loadAllRules().then(() => undefined);
  let chain: Promise<void> = init;
  port.on("message", (job: ParseJobMsg) => {
    chain = chain.then(async () => {
      const logs: ParseLogEntry[] = [];
      const rec =
        (level: ParseLogEntry["level"]) =>
        (msg: string, meta?: Record<string, unknown>): void => {
          logs.push(meta === undefined ? { level, msg } : { level, msg, meta });
        };
      const logger: Logger = {
        debug: rec("debug"),
        info: rec("info"),
        warn: rec("warn"),
        error: rec("error"),
      };
      const outcome = await parseMember(job.member.ref, job.member.content, base, logger);
      let reply: ParseWorkerMsg;
      if (!plainOutcome(outcome) || !isPlainData(logs)) {
        reply = { type: "fallback", seq: job.seq, reason: "result is not plain data" };
        port.postMessage(reply);
        return;
      }
      reply = { type: "done", seq: job.seq, outcome, logs };
      try {
        port.postMessage(reply);
      } catch (e) {
        port.postMessage({
          type: "fallback",
          seq: job.seq,
          reason: (e as Error).message,
        } satisfies ParseWorkerMsg);
      }
    });
  });
  // A rule-load failure rejects `init`: crash so the pool falls back to the
  // main thread (which reports the same failure) instead of parsing without
  // the rule parsers.
  init.then(
    () => port.postMessage({ type: "ready" } satisfies ParseWorkerMsg),
    (e: unknown) => {
      throw e;
    },
  );
}
