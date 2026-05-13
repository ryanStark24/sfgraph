import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findProjectRoot,
  linkWorkspace,
  readWorkspace,
  workspaceConfigPath,
  workspaceHashFor,
} from "../workspace.js";

let workDir: string;
const ORIG_HOME = process.env.HOME;
const ORIG_XDG = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-ws-"));
  // Redirect env-paths to tempdir so we don't pollute the user's config.
  process.env.HOME = workDir;
  process.env.XDG_CONFIG_HOME = path.join(workDir, ".config");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  else process.env.HOME = undefined;
  if (ORIG_XDG !== undefined) process.env.XDG_CONFIG_HOME = ORIG_XDG;
  else process.env.XDG_CONFIG_HOME = undefined;
});

describe("workspaceHashFor", () => {
  it("is deterministic and 16 hex chars", () => {
    const a = workspaceHashFor("/some/path");
    const b = workspaceHashFor("/some/path");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("findProjectRoot", () => {
  it("walks up to find sfdx-project.json", () => {
    const root = path.join(workDir, "proj");
    mkdirSync(path.join(root, "nested", "deep"), { recursive: true });
    writeFileSync(path.join(root, "sfdx-project.json"), "{}");
    const found = findProjectRoot(path.join(root, "nested", "deep"));
    expect(found).toBe(root);
  });
});

describe("linkWorkspace / readWorkspace", () => {
  it("writes to expected path and round-trips", async () => {
    const projectRoot = path.join(workDir, "proj");
    mkdirSync(projectRoot, { recursive: true });
    const ws = await linkWorkspace(projectRoot, "myorg", "00DXX0000001abcEAA");
    expect(ws.orgAlias).toBe("myorg");
    expect(ws.orgId).toBe("00DXX0000001abcEAA");
    const expectedPath = workspaceConfigPath(projectRoot);
    expect(expectedPath).toContain("workspaces");
    const read = await readWorkspace(projectRoot);
    expect(read?.orgAlias).toBe("myorg");
    expect(read?.orgId).toBe("00DXX0000001abcEAA");
    expect(read?.linkedAt).toBeTypeOf("number");
  });

  it("idempotent re-link updates linkedAt", async () => {
    const projectRoot = path.join(workDir, "proj2");
    mkdirSync(projectRoot, { recursive: true });
    const first = await linkWorkspace(projectRoot, "a", "00DA");
    await new Promise((r) => setTimeout(r, 5));
    const second = await linkWorkspace(projectRoot, "b", "00DB");
    expect(second.orgAlias).toBe("b");
    expect(second.orgId).toBe("00DB");
    expect(second.linkedAt).toBeGreaterThanOrEqual(first.linkedAt ?? 0);
  });
});
