import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeOrgSnapshot } from "../commands/install.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "sfg-snapmode-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("orgs-snapshot.json permissions", () => {
  it("is written 0600 in a data folder created 0700", async () => {
    const dir = path.join(base, "sfgraph");
    const old = process.umask(0o022);
    try {
      await writeOrgSnapshot(dir);
    } finally {
      process.umask(old);
    }
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, "orgs-snapshot.json")).mode & 0o777).toBe(0o600);
  });
});
