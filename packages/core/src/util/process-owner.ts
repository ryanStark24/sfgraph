import { spawnSync } from "node:child_process";
import os from "node:os";

/**
 * Ownership checks shared by the ingest lock file and the graph store's
 * bulk-window marker. Both record `{pid, host}` (and a start time) of the
 * process that took them. A pid can only be probed on its own host, so an
 * owner is stale only when it is on THIS host and its pid is dead, or alive
 * but a different process (the pid was reused: it started after the owner
 * recorded itself). An owner on another host (a data dir on a shared or
 * synced volume) is never treated as stale.
 */

/** True when `pid` is a running process here (EPERM: exists but not ours). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function thisHost(): string {
  return os.hostname();
}

/** A missing host (a marker written before hosts were recorded) is this host. */
export function isThisHost(host: string | null | undefined): boolean {
  return host == null || host === "" || host === thisHost();
}

let ownStart: number | null | undefined;
/**
 * This process's start time as `pidStartMs` reads it (N-1: the recorded
 * value and the later check use the same clock and truncation), or null.
 */
export function ownStartMs(): number | null {
  if (ownStart === undefined) ownStart = pidStartMs(process.pid);
  return ownStart;
}

/**
 * Start time (epoch ms, 1 s resolution) of a running process, or null when
 * it cannot be read (no `ps`, Windows, gone, unparseable).
 */
export function pidStartMs(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32") return null;
  try {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      timeout: 2000,
    });
    if (r.status !== 0) return null;
    const t = Date.parse(r.stdout.trim().replace(/\s+/g, " "));
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Both sides of the comparison are `ps lstart` readings of the same process,
 * so they agree; the slack covers a Linux boot-time re-derivation after a
 * small wall-clock step.
 */
const START_TOLERANCE_MS = 2000;

export interface ProcessOwner {
  pid: number;
  host?: string | null;
  /** The owner's process start time, when recorded. */
  procStartMs?: number | null;
  /** When the owner took the lock / marker (its process started before this). */
  takenAtMs?: number | null;
}

/** The owner is on this host and its process is gone (dead, or the pid reused). */
export function ownerIsStale(owner: ProcessOwner): boolean {
  if (!isThisHost(owner.host)) return false;
  if (!pidAlive(owner.pid)) return true;
  const hasProc = typeof owner.procStartMs === "number" && Number.isFinite(owner.procStartMs);
  const hasTaken = typeof owner.takenAtMs === "number" && Number.isFinite(owner.takenAtMs);
  if (!hasProc && !hasTaken) return false;
  const live = pidStartMs(owner.pid);
  if (live === null) return false;
  if (hasProc) return Math.abs(live - (owner.procStartMs as number)) > START_TOLERANCE_MS;
  // The owner's process started before it took the lock; one that started later is another process.
  return live > (owner.takenAtMs as number) + START_TOLERANCE_MS;
}
