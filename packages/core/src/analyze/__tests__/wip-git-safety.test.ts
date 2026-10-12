import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitChangedFiles } from "../wip-changed-files.js";

// T14 batch L review I2: wip runs git on a project the user points it at,
// which may be an untrusted clone. Repo-local config must not get to run
// commands: core.fsmonitor, hooks, clean/process filters, external diff.

let dir: string;
let marks: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-gitsafe-"));
  marks = mkdtempSync(path.join(tmpdir(), "sfg-gitsafe-marks-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(marks, { recursive: true, force: true });
});

/** Set-up only: git with every repo-local command hook disabled. */
const g = (...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    { cwd: dir, stdio: "ignore" },
  );

function repo(): void {
  mkdirSync(path.join(dir, "force-app/classes"), { recursive: true });
  writeFileSync(path.join(dir, "force-app/classes/A.cls"), "public class A {}");
  writeFileSync(path.join(dir, "force-app/classes/B.cls"), "public class B {}");
  writeFileSync(path.join(dir, ".gitattributes"), "*.cls filter=evil diff=evil\n");
  g("init", "-q");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
}

const mark = (name: string) => path.join(marks, name);
const touchCmd = (name: string) => `touch '${mark(name)}'`;

describe("gitChangedFiles never runs repo-configured commands", () => {
  it("ignores core.fsmonitor", () => {
    repo();
    g("config", "core.fsmonitor", `${touchCmd("fsmonitor")}; false`);
    writeFileSync(path.join(dir, "force-app/classes/A.cls"), "public class A { }");
    const changed = gitChangedFiles(dir);
    expect(existsSync(mark("fsmonitor"))).toBe(false);
    expect(changed && [...changed].map((f) => path.relative(dir, f))).toEqual([
      "force-app/classes/A.cls",
    ]);
  });

  for (const driver of ["clean", "process"] as const) {
    it(`ignores a ${driver} filter, textconv and an external diff`, () => {
      repo();
      const cmd = driver === "clean" ? `${touchCmd("filter")}; cat` : touchCmd("filter");
      g("config", `filter.evil.${driver}`, `sh -c "${cmd}"`);
      g("config", "filter.evil.required", "true");
      g("config", "diff.evil.textconv", `sh -c "${touchCmd("textconv")}; cat"`);
      g("config", "diff.external", `sh -c "${touchCmd("extdiff")}"`);
      // Same content, new mtime: git must re-hash B.cls (running the filter).
      const b = path.join(dir, "force-app/classes/B.cls");
      utimesSync(b, new Date(), new Date(Date.now() + 5000));
      writeFileSync(path.join(dir, "force-app/classes/A.cls"), "public class A { }");
      const changed = gitChangedFiles(dir);
      // `filter` is the marker that matters: `diff HEAD --name-only` never
      // produces a patch, so git runs no textconv or external diff whatever
      // the config says. The textconv / extdiff markers (and the
      // `--no-textconv` / `--no-ext-diff` / `diff.external=` overrides) are
      // defence in depth and cannot fire with `--name-only`.
      for (const m of ["filter", "textconv", "extdiff"]) {
        expect(existsSync(mark(m)), m).toBe(false);
      }
      expect(changed && [...changed].map((f) => path.relative(dir, f)).sort()).toEqual([
        "force-app/classes/A.cls",
      ]);
    });
  }

  it("ignores submodules (a moved or dirty submodule runs no git inside it)", () => {
    repo();
    const sub = path.join(dir, "sub");
    mkdirSync(sub);
    const gs = (...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.hooksPath=/dev/null", ...args],
        { cwd: sub, stdio: "ignore" },
      );
    gs("init", "-q");
    writeFileSync(path.join(sub, "x.txt"), "1");
    gs("add", "-A");
    gs("commit", "-q", "-m", "s1");
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sub, encoding: "utf8" }).trim();
    g("update-index", "--add", "--cacheinfo", `160000,${sha},sub`);
    g("commit", "-q", "-m", "add gitlink");
    // Move the submodule's HEAD and dirty it: without --ignore-submodules
    // `diff HEAD` reports `sub` (and inspects the submodule's work tree).
    writeFileSync(path.join(sub, "x.txt"), "2");
    gs("commit", "-q", "-am", "s2");
    writeFileSync(path.join(sub, "x.txt"), "3");
    writeFileSync(path.join(dir, "force-app/classes/A.cls"), "public class A { }");
    const changed = gitChangedFiles(dir);
    expect(changed && [...changed].map((f) => path.relative(dir, f)).sort()).toEqual([
      "force-app/classes/A.cls",
    ]);
  });

  it("logs at debug when the git signal is skipped for an unsafe driver name", () => {
    repo();
    g("config", "filter.a=b.clean", "cat");
    const debug: Array<[string, Record<string, unknown> | undefined]> = [];
    const logger = {
      debug: (m: string, meta?: Record<string, unknown>) => debug.push([m, meta]),
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    expect(gitChangedFiles(dir, logger)).toBeNull();
    expect(debug).toHaveLength(1);
    expect(debug[0]?.[0]).toMatch(/git signal skipped/);
  });
});
