import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCmd } from "../commands/install.js";

let home: string;
let logs: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sfgraph-inst-"));
  logs = [];
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("installCmd --dry-run", () => {
  it("logs would-write rows and writes nothing", async () => {
    const rows = await installCmd({
      target: "all",
      dryRun: true,
      homeOverride: home,
      log: (s) => logs.push(s),
    });
    expect(rows.every((r) => r.action === "would-write")).toBe(true);
    expect(logs.join("\n")).toMatch(/\[dry-run\] no files written/);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(existsSync(join(home, ".cursor"))).toBe(false);
  });
});
