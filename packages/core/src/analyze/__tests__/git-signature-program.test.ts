import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeTimes } from "../../extractors/filesystem/change-times.js";
import { gitChangedFiles } from "../wip-changed-files.js";

/**
 * A project folder is untrusted. Its `.git/config` can set
 * `log.showSignature=true` and name a signature program (`gpg.program`,
 * `gpg.ssh.program`, `gpg.x509.program`); `git log` then runs that program.
 * The ChangeTimes and wip readers must never start it.
 */
const hasGit = spawnSync("git", ["--version"]).status === 0;
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "a",
  GIT_AUTHOR_EMAIL: "a@example.com",
  GIT_COMMITTER_NAME: "a",
  GIT_COMMITTER_EMAIL: "a@example.com",
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let dir: string;
let marker: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-sig-git-"));
  marker = path.join(dir, "MARKER");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!hasGit)("untrusted project folder: git never runs a signature program", () => {
  it("log.showSignature=true with gpg programs: marker never created", async () => {
    const root = path.join(dir, "proj");
    const md = path.join(root, "force-app/main/default/classes");
    mkdirSync(md, { recursive: true });
    writeFileSync(path.join(md, "A.cls"), "public class A {}");
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    const prog = path.join(dir, "evil.sh");
    writeFileSync(prog, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(prog, 0o755);
    git(root, "config", "log.showSignature", "true");
    git(root, "config", "gpg.program", prog);
    git(root, "config", "gpg.ssh.program", prog);
    git(root, "config", "gpg.x509.program", prog);
    // Make HEAD a commit with a signature header, so git has one to verify.
    // The commit must change a file under the scope, or `git log -- <path>` skips it.
    writeFileSync(path.join(md, "A.cls"), "public class A { Integer x; }");
    git(root, "add", "-A");
    const tree = git(root, "write-tree").trim();
    const parent = git(root, "rev-parse", "HEAD").trim();
    const body = `tree ${tree}\nparent ${parent}\nauthor a <a@example.com> 1700000000 +0000\ncommitter a <a@example.com> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n x\n -----END PGP SIGNATURE-----\n\nsigned\n`;
    const objFile = path.join(dir, "commit.txt");
    writeFileSync(objFile, body);
    git(
      root,
      "update-ref",
      "HEAD",
      git(root, "hash-object", "-t", "commit", "-w", "--literally", objFile).trim(),
    );
    // Sanity: an unprotected `git log` runs the program, so this test can fail.
    spawnSync("git", ["log", "--format=%H", "-1"], { cwd: root, env: ENV });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    expect(existsSync(marker)).toBe(false);
    gitChangedFiles(root);
    expect(existsSync(marker)).toBe(false);
    const times = await ChangeTimes.load(root, [path.join(root, "force-app")]);
    expect(existsSync(marker)).toBe(false);
    expect(times.lookup(path.join(md, "A.cls"))).not.toBeNull();
  });
});
