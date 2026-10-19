import { appendFileSync, writeFileSync } from "node:fs";

export interface IngestProfileMember {
  qname: string;
  label: string;
  bytes: number;
  parseMs: number;
  writeMs: number;
}

export interface IngestProfiler {
  /** False for the shared no-op; callers can skip building records. */
  readonly enabled: boolean;
  member(rec: IngestProfileMember): void;
  /**
   * A phase record. `ms` is the phase's DURATION, except when `sinceStart` is
   * set: then `ms` is a timestamp, the time from ingest start to that point
   * (`graph-ready`, `embeddings`), and the record carries `sinceStart: true`.
   * Tools that sum phase durations must skip `sinceStart` records.
   */
  phase(name: string, ms: number, sinceStart?: boolean): void;
  close(): void;
}

const FLUSH_EVERY = 500;

const NOOP: IngestProfiler = { enabled: false, member() {}, phase() {}, close() {} };

/**
 * Opt-in ingest profiler. Active only when SFGRAPH_INGEST_PROFILE names a file;
 * otherwise returns a shared no-op. Records are buffered and appended as JSONL
 * every 500 records and on close.
 */
export function createIngestProfiler(
  env: Record<string, string | undefined> = process.env,
): IngestProfiler {
  const file = env.SFGRAPH_INGEST_PROFILE;
  if (!file) return NOOP;
  let buf: string[] = [];
  try {
    writeFileSync(file, "");
  } catch {
    return NOOP;
  }
  const flush = (): void => {
    if (buf.length === 0) return;
    const out = `${buf.join("\n")}\n`;
    buf = [];
    try {
      appendFileSync(file, out);
    } catch {
      // profiling must never break ingest
    }
  };
  const push = (rec: unknown): void => {
    buf.push(JSON.stringify(rec));
    if (buf.length >= FLUSH_EVERY) flush();
  };
  return {
    enabled: true,
    member(rec) {
      push({ t: "member", ...rec });
    },
    phase(name, ms, sinceStart) {
      push(sinceStart ? { t: "phase", name, ms, sinceStart: true } : { t: "phase", name, ms });
    },
    close: flush,
  };
}
