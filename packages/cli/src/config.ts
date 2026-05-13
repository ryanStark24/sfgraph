import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TelemetryConfig {
  enabled: boolean;
  sink: "null" | "local";
  sinkPath?: string;
}

export interface SfgraphConfig {
  telemetry: TelemetryConfig;
}

export const DEFAULT_CONFIG: SfgraphConfig = {
  telemetry: { enabled: false, sink: "null" },
};

export function configPath(configDir: string): string {
  return join(configDir, "sfgraph.json");
}

export function readConfig(configDir: string): SfgraphConfig {
  try {
    const raw = readFileSync(configPath(configDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<SfgraphConfig>;
    return {
      telemetry: { ...DEFAULT_CONFIG.telemetry, ...(parsed.telemetry ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function writeConfig(configDir: string, cfg: SfgraphConfig): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath(configDir), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

export function defaultSinkPath(dataDir: string): string {
  return join(dataDir, "telemetry.jsonl");
}
