import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePrivateDir, restrictDbFiles, restrictFile } from "../private-files.js";

const posix = process.platform !== "win32";
const mode = (p: string): number => statSync(p).mode & 0o777;

let base: string;
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "sfg-private-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!posix)("private files (POSIX)", () => {
  it("creates a missing data folder, and its missing parents, as 0700", () => {
    const dir = path.join(base, "a", "b", "sfgraph");
    const old = process.umask(0o022);
    try {
      ensurePrivateDir(dir);
    } finally {
      process.umask(old);
    }
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.join(base, "a"))).toBe(0o700);
  });

  it("leaves a folder that already exists as it is", () => {
    const dir = path.join(base, "shared");
    mkdirSync(dir, { mode: 0o755 });
    ensurePrivateDir(dir);
    expect(mode(dir)).toBe(0o755);
  });

  it("restricts a file, and a database with its -wal and -shm", () => {
    const f = path.join(base, "x.sqlite");
    for (const s of ["", "-wal", "-shm"]) writeFileSync(`${f}${s}`, "x", { mode: 0o644 });
    restrictFile(f);
    expect(mode(f)).toBe(0o600);
    restrictDbFiles(f);
    expect(mode(`${f}-wal`)).toBe(0o600);
    expect(mode(`${f}-shm`)).toBe(0o600);
  });

  it("does not throw for a missing file", () => {
    expect(() => restrictFile(path.join(base, "nope"))).not.toThrow();
  });
});
