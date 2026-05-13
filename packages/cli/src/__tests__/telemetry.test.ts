import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  disableCmd,
  enableLocalCmd,
  previewCmd,
  resetIdCmd,
  statusCmd,
} from "../commands/telemetry.js";
import { readConfig } from "../config.js";

let configDir: string;
let dataDir: string;
let logs: string[];
const env = () => ({ configDir, dataDir, log: (s: string) => logs.push(s) });

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "sfgraph-cfg-"));
  dataDir = mkdtempSync(join(tmpdir(), "sfgraph-data-"));
  logs = [];
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("telemetry commands", () => {
  it("round-trips enable then status", async () => {
    await enableLocalCmd(env());
    await statusCmd(env());
    expect(logs.join("\n")).toMatch(/telemetry: enabled/);
    const cfg = readConfig(configDir);
    expect(cfg.telemetry.enabled).toBe(true);
    expect(cfg.telemetry.sink).toBe("local");
  });

  it("disable flips enabled false", async () => {
    await enableLocalCmd(env());
    await disableCmd(env());
    const cfg = readConfig(configDir);
    expect(cfg.telemetry.enabled).toBe(false);
  });

  it("preview sanitizes a sample event", async () => {
    await previewCmd(env());
    const out = logs.join("\n");
    expect(out).toMatch(/<path>/);
    expect(out).not.toMatch(/\/Users\/alice/);
  });

  it("reset-id changes the machine id when enabled", async () => {
    await enableLocalCmd(env());
    const id1 = readFileSync(join(configDir, "machine-id"), "utf8");
    await resetIdCmd(env());
    const id2 = readFileSync(join(configDir, "machine-id"), "utf8");
    expect(id1).not.toBe(id2);
  });

  it("reset-id is a no-op when disabled", async () => {
    await resetIdCmd(env());
    expect(logs.join("\n")).toMatch(/disabled/);
  });
});
