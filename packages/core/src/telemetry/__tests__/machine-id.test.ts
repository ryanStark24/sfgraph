import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOrCreateMachineId, resetMachineId } from "../machine-id.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfgraph-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("machine-id", () => {
  it("returns null when telemetry is disabled", () => {
    expect(getOrCreateMachineId({ telemetryEnabled: false, configDir: dir })).toBeNull();
  });
  it("creates and persists when enabled", () => {
    const id1 = getOrCreateMachineId({ telemetryEnabled: true, configDir: dir });
    const id2 = getOrCreateMachineId({ telemetryEnabled: true, configDir: dir });
    expect(id1).toBeTruthy();
    expect(id1).toBe(id2);
  });
  it("reset generates a new id", () => {
    const id1 = getOrCreateMachineId({ telemetryEnabled: true, configDir: dir });
    const id2 = resetMachineId({ telemetryEnabled: true, configDir: dir });
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });
  it("reset returns null when disabled", () => {
    expect(resetMachineId({ telemetryEnabled: false, configDir: dir })).toBeNull();
  });
});
