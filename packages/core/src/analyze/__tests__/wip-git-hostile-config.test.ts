import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeTimes } from "../../extractors/filesystem/change-times.js";
import { gitChangedFiles, safeGitEnv } from "../wip-changed-files.js";

/**
 * A project folder is untrusted. A repository config with a promisor remote
 * (`extensions.partialClone`) plus one missing tree object makes git run the
 * remote's `uploadpack` command (or an `ext::` URL) to lazy-fetch it. Both
 * git readers must never start it, whichever way the folder was delivered:
 *  - route A: the folder's own `.git/config` is hostile (unpacked archive);
 *  - route B: a subfolder of an ordinary clone laid out as a bare repository.
 */

const hasGit = spawnSync("git", ["--version"]).status === 0;
const MD = "force-app/main/default/classes";
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "a",
  GIT_AUTHOR_EMAIL: "a@example.com",
  GIT_COMMITTER_NAME: "a",
  GIT_COMMITTER_EMAIL: "a@example.com",
};

type Variant = "uploadpack" | "file-allow" | "ext";
let dir: string;
let marker: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function seed(root: string): void {
  mkdirSync(path.join(root, MD), { recursive: true });
  writeFileSync(
    path.join(root, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }),
  );
  writeFileSync(path.join(root, MD, "A.cls"), "public class A {}");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
}

function hostileConfig(file: string, variant: Variant): void {
  const set = (k: string, v: string) => git(dir, "config", "-f", file, k, v);
  set("core.repositoryformatversion", "1");
  set("extensions.partialClone", "origin");
  set("remote.origin.promisor", "true");
  if (variant === "ext") {
    set("remote.origin.url", `ext::sh -c touch% ${marker}`);
    set("protocol.ext.allow", "always");
  } else {
    set("remote.origin.url", path.join(dir, "nonexistent-remote.git"));
    set("remote.origin.uploadpack", `touch ${marker}; false`);
    if (variant === "file-allow") set("protocol.file.allow", "always");
  }
}

function dropTree(objectsDir: string, gitDir: string, spec: string): void {
  const h = git(dir, `--git-dir=${gitDir}`, "rev-parse", spec).trim();
  rmSync(path.join(objectsDir, h.slice(0, 2), h.slice(2)), { force: true });
}

/** Route A: seeded repo, hostile .git/config, root tree deleted, tar round trip. */
function routeA(variant: Variant): string {
  const src = path.join(dir, "a-src", "proj");
  seed(src);
  dropTree(path.join(src, ".git", "objects"), path.join(src, ".git"), "HEAD^{tree}");
  hostileConfig(path.join(src, ".git", "config"), variant);
  utimesSync(path.join(src, MD, "A.cls"), new Date("2020-01-01"), new Date("2020-01-01"));
  execFileSync("tar", ["cf", path.join(dir, "a.tar"), "-C", path.join(dir, "a-src"), "proj"]);
  const out = path.join(dir, "a");
  mkdirSync(out);
  execFileSync("tar", ["xf", path.join(dir, "a.tar"), "-C", out]);
  return path.join(out, "proj");
}

/** Route B: bare-layout `sample/` inside an ordinary clone, classes tree deleted. */
function routeB(variant: Variant): string {
  const seedDir = path.join(dir, "b-seed");
  seed(seedDir);
  const carrier = path.join(dir, "b-carrier");
  const sample = path.join(carrier, "sample");
  mkdirSync(sample, { recursive: true });
  writeFileSync(path.join(carrier, "README.md"), "carrier");
  cpSync(path.join(seedDir, "sfdx-project.json"), path.join(sample, "sfdx-project.json"));
  cpSync(path.join(seedDir, "force-app"), path.join(sample, "force-app"), { recursive: true });
  for (const n of ["HEAD", "objects", "refs"])
    cpSync(path.join(seedDir, ".git", n), path.join(sample, n), { recursive: true });
  dropTree(path.join(sample, "objects"), path.join(seedDir, ".git"), `HEAD:${MD}`);
  writeFileSync(path.join(sample, "config"), "");
  git(dir, "config", "-f", path.join(sample, "config"), "core.bare", "false");
  git(dir, "config", "-f", path.join(sample, "config"), "core.worktree", ".");
  hostileConfig(path.join(sample, "config"), variant);
  git(carrier, "init", "-q", "-b", "main");
  git(carrier, "add", "-A");
  git(carrier, "commit", "-q", "-m", "carrier");
  const clone = path.join(dir, "b-clone");
  git(dir, "clone", "-q", carrier, clone);
  return path.join(clone, "sample");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-hostile-git-"));
  marker = path.join(dir, "MARKER");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!hasGit)("untrusted project folder: git never starts a fetch or command", () => {
  const variants: Variant[] = ["uploadpack", "file-allow", "ext"];
  for (const variant of variants) {
    for (const [name, build] of [
      ["route A (hostile .git/config)", routeA],
      ["route B (embedded bare repository)", routeB],
    ] as const) {
      it(`${name}, ${variant}: marker never created`, async () => {
        const root = build(variant);
        expect(existsSync(marker)).toBe(false);
        gitChangedFiles(root);
        expect(existsSync(marker)).toBe(false);
        const times = await ChangeTimes.load(root, [path.join(root, "force-app")]);
        expect(existsSync(marker)).toBe(false);
        if (name.startsWith("route B")) {
          // The embedded bare repository is refused: no git signal, mtime times.
          expect(gitChangedFiles(root)).toBeNull();
          expect(times.lookup(path.join(root, MD, "A.cls"))).not.toBeNull();
        }
        expect(existsSync(marker)).toBe(false);
      });
    }
  }

  it("a normal repository still reports changed files and commit times", async () => {
    const root = path.join(dir, "normal");
    seed(root);
    writeFileSync(path.join(root, MD, "A.cls"), "public class A { void x() {} }");
    writeFileSync(path.join(root, MD, "B.cls"), "public class B {}");
    const changed = gitChangedFiles(root);
    expect(changed).not.toBeNull();
    expect([...(changed as Set<string>)].sort()).toEqual([
      path.join(root, MD, "A.cls"),
      path.join(root, MD, "B.cls"),
    ]);
    const times = await ChangeTimes.load(root, [path.join(root, "force-app")]);
    expect(times.lookup(path.join(root, MD, "A.cls"))).not.toBeNull();
  });

  it("safeGitEnv denies every transport and lazy fetch", () => {
    const e = safeGitEnv();
    expect(e.GIT_ALLOW_PROTOCOL).toBe("none");
    expect(e.GIT_NO_LAZY_FETCH).toBe("1");
    expect(e.GIT_TERMINAL_PROMPT).toBe("0");
  });
});
