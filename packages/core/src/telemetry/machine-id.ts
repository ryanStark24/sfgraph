import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MachineIdOpts {
  telemetryEnabled: boolean;
  configDir: string;
}

export function getOrCreateMachineId(opts: MachineIdOpts): string | null {
  if (!opts.telemetryEnabled) return null;
  const path = join(opts.configDir, "machine-id");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  } catch {
    // fall through to create
  }
  mkdirSync(opts.configDir, { recursive: true });
  const id = randomUUID();
  writeFileSync(path, id, "utf8");
  return id;
}

export function resetMachineId(opts: MachineIdOpts): string | null {
  if (!opts.telemetryEnabled) return null;
  const path = join(opts.configDir, "machine-id");
  mkdirSync(opts.configDir, { recursive: true });
  const id = randomUUID();
  writeFileSync(path, id, "utf8");
  return id;
}
