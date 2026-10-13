import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pidStartMs } from "../../util/process-owner.js";
import { IngestLockedError, acquireIngestLock, ingestLockPath } from "../lock.js";

/** A pid that certainly existed and is now gone (a child that already exited). */
const DEAD_PID = (spawnSync(process.execPath, ["-e", ""]).pid as number) ?? 0;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-lock-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ingest lock", () => {
  it("writes <dataDir>/<orgId>.ingest.lock with pid, host and start time; release removes it", () => {
    const lock = acquireIngestLock({ dir, orgId: "00Dabc", orgLabel: "dev" });
    const p = ingestLockPath(dir, "00Dabc");
    expect(lock.path).toBe(p);
    expect(p).toBe(path.join(dir, "00Dabc.ingest.lock"));
    const body = JSON.parse(readFileSync(p, "utf8"));
    expect(body).toMatchObject({ pid: process.pid, host: os.hostname() });
    expect(typeof body.startedAt).toBe("string");
    lock.release();
    expect(existsSync(p)).toBe(false);
  });

  it("a second acquire refuses with the brief's message while the holder is alive", () => {
    const lock = acquireIngestLock({ dir, orgId: "00Dabc", orgLabel: "dev" });
    try {
      let err: unknown;
      try {
        acquireIngestLock({ dir, orgId: "00Dabc", orgLabel: "dev" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(IngestLockedError);
      expect((err as Error).message).toMatch(
        new RegExp(
          `^ingest already running for dev \\(pid ${process.pid} since .+\\); retry later$`,
        ),
      );
    } finally {
      lock.release();
    }
  });

  it("removes a stale lock (dead pid on this host) and takes it", () => {
    const p = ingestLockPath(dir, "00Dabc");
    writeFileSync(
      p,
      JSON.stringify({ pid: DEAD_PID, host: os.hostname(), startedAt: "2026-01-01T00:00:00Z" }),
    );
    const lock = acquireIngestLock({ dir, orgId: "00Dabc", orgLabel: "dev" });
    expect(JSON.parse(readFileSync(p, "utf8")).pid).toBe(process.pid);
    lock.release();
  });

  it("never auto-removes a lock held from another host", () => {
    const p = ingestLockPath(dir, "00Dabc");
    writeFileSync(
      p,
      JSON.stringify({ pid: DEAD_PID, host: "other.example", startedAt: "2026-01-01T00:00:00Z" }),
    );
    expect(() => acquireIngestLock({ dir, orgId: "00Dabc", orgLabel: "dev" })).toThrow(
      new RegExp(
        `ingest already running for dev \\(pid ${DEAD_PID} on host other\.example since .+\\); retry later`,
      ),
    );
    expect(existsSync(p)).toBe(true);
  });

  it("an unparseable lock is live while fresh and stale after 60 s", () => {
    const p = ingestLockPath(dir, "00Dabc");
    writeFileSync(p, "");
    expect(() => acquireIngestLock({ dir, orgId: "00Dabc", orgLabel: "dev" })).toThrow(
      IngestLockedError,
    );
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(p, old, old);
    const lock = acquireIngestLock({ dir, orgId: "00Dabc", orgLabel: "dev" });
    lock.release();
  });

  it("release does not delete a lock another run has since taken", () => {
    const lock = acquireIngestLock({ dir, orgId: "00Dabc", orgLabel: "dev" });
    const p = lock.path;
    writeFileSync(
      p,
      JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: "x", token: "other" }),
    );
    lock.release();
    expect(existsSync(p)).toBe(true);
  });

  it("I-2: a run that read the stale holder before another run broke it does not delete the new lock", () => {
    const p = ingestLockPath(dir, "00Dabc");
    writeFileSync(
      p,
      JSON.stringify({ pid: DEAD_PID, host: os.hostname(), startedAt: "2026-01-01T00:00:00Z" }),
    );
    let a: ReturnType<typeof acquireIngestLock> | undefined;
    let err: unknown;
    try {
      acquireIngestLock({
        dir,
        orgId: "00Dabc",
        orgLabel: "dev",
        // B has judged the lock stale; A breaks it and takes it first.
        _beforeBreak: () => {
          a = acquireIngestLock({ dir, orgId: "00Dabc", orgLabel: "dev" });
        },
      });
    } catch (e) {
      err = e;
    }
    expect(a).toBeDefined();
    expect(err).toBeInstanceOf(IngestLockedError);
    // A's lock is intact.
    const body = JSON.parse(readFileSync(p, "utf8"));
    expect(body.pid).toBe(process.pid);
    a?.release();
    expect(existsSync(p)).toBe(false);
  });

  it("I-3a: a live pid that started after the lock was taken is a reused pid: stale", () => {
    const p = ingestLockPath(dir, "00Dabc");
    // ppid (the vitest runner) is alive, but it started long after 1970.
    writeFileSync(
      p,
      JSON.stringify({
        pid: process.ppid,
        host: os.hostname(),
        startedAt: "1970-01-02T00:00:00Z",
        procStartMs: 86_400_000,
      }),
    );
    if (process.platform === "win32") {
      // No `ps` start time on Windows (pidStartMs is null): a live pid is
      // never judged reused, so the lock is conservatively kept.
      expect(() => acquireIngestLock({ dir, orgId: "00Dabc", orgLabel: "dev" })).toThrow(
        IngestLockedError,
      );
      return;
    }
    const lock = acquireIngestLock({ dir, orgId: "00Dabc", orgLabel: "dev" });
    expect(JSON.parse(readFileSync(p, "utf8")).pid).toBe(process.pid);
    lock.release();
  });

  it("I-3a: a live holder whose recorded start matches is not stale", () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"]);
    try {
      const p = ingestLockPath(dir, "00Dabc");
      const startedAt = new Date().toISOString();
      writeFileSync(
        p,
        // Same reader as the check (N-1): deterministic on Linux too.
        JSON.stringify({
          pid: child.pid,
          host: os.hostname(),
          startedAt,
          procStartMs: pidStartMs(child.pid as number),
        }),
      );
      expect(() => acquireIngestLock({ dir, orgId: "00Dabc", orgLabel: "dev" })).toThrow(
        new RegExp(`pid ${child.pid} since`),
      );
      expect(existsSync(p)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("N-1: the recorded start time comes from the same clock the check reads", () => {
    const lock = acquireIngestLock({ dir, orgId: "00Dabc", orgLabel: "dev" });
    try {
      const body = JSON.parse(readFileSync(ingestLockPath(dir, "00Dabc"), "utf8"));
      const own = pidStartMs(process.pid);
      if (own === null) expect(body.procStartMs).toBeUndefined();
      else expect(body.procStartMs).toBe(own);
    } finally {
      lock.release();
    }
  });

  it("N-2: breaking a stale empty lock never deletes a fresh lock written meanwhile", () => {
    const p = ingestLockPath(dir, "00Dabc");
    writeFileSync(p, "");
    const old = Date.now() / 1000 - 3600;
    utimesSync(p, old, old);
    // Another contender broke it first and is between create and write.
    const err = (() => {
      try {
        acquireIngestLock({
          dir,
          orgId: "00Dabc",
          orgLabel: "dev",
          _beforeBreak: () => {
            rmSync(p);
            writeFileSync(p, "");
          },
        });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(IngestLockedError);
    expect(existsSync(p)).toBe(true);
  });

  it("I-3b: a lock carrying our own pid that this process does not hold is stale", () => {
    const p = ingestLockPath(dir, "00Dabc");
    writeFileSync(
      p,
      JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        startedAt: "2026-01-01T00:00:00Z",
        token: "previous-incarnation",
      }),
    );
    const lock = acquireIngestLock({ dir, orgId: "00Dabc", orgLabel: "dev" });
    expect(JSON.parse(readFileSync(p, "utf8")).token).not.toBe("previous-incarnation");
    lock.release();
  });

  it("cross-process: a lock held by a live other process refuses; once it dies, it is taken", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"]);
    const p = ingestLockPath(dir, "00Dabc");
    writeFileSync(
      p,
      JSON.stringify({ pid: child.pid, host: os.hostname(), startedAt: new Date().toISOString() }),
    );
    expect(() => acquireIngestLock({ dir, orgId: "00Dabc", orgLabel: "dev" })).toThrow(
      IngestLockedError,
    );
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      child.kill("SIGKILL");
    });
    const lock = acquireIngestLock({ dir, orgId: "00Dabc", orgLabel: "dev" });
    expect(JSON.parse(readFileSync(p, "utf8")).pid).toBe(process.pid);
    lock.release();
  });
});
