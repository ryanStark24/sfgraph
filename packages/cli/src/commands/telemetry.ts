import {
  LocalFileSink,
  Sanitizer,
  getOrCreateMachineId,
  resetMachineId,
} from "@ryanstark24/sfgraph-core";
import { getSfgraphPaths } from "@ryanstark24/sfgraph-shared";
import { defaultSinkPath, readConfig, writeConfig } from "../config.js";

export interface TelemetryEnv {
  configDir: string;
  dataDir: string;
  log: (s: string) => void;
}

export function defaultEnv(): TelemetryEnv {
  const p = getSfgraphPaths();
  return { configDir: p.config, dataDir: p.data, log: (s) => console.log(s) };
}

export async function statusCmd(env: TelemetryEnv = defaultEnv()): Promise<void> {
  const cfg = readConfig(env.configDir);
  env.log(`telemetry: ${cfg.telemetry.enabled ? "enabled" : "disabled"}`);
  env.log(`sink: ${cfg.telemetry.sink}`);
  if (cfg.telemetry.sinkPath) env.log(`sinkPath: ${cfg.telemetry.sinkPath}`);
}

export async function enableLocalCmd(env: TelemetryEnv = defaultEnv()): Promise<void> {
  const cfg = readConfig(env.configDir);
  cfg.telemetry.enabled = true;
  cfg.telemetry.sink = "local";
  cfg.telemetry.sinkPath = cfg.telemetry.sinkPath ?? defaultSinkPath(env.dataDir);
  writeConfig(env.configDir, cfg);
  getOrCreateMachineId({ telemetryEnabled: true, configDir: env.configDir });
  env.log("telemetry enabled (local)");
}

export async function disableCmd(env: TelemetryEnv = defaultEnv()): Promise<void> {
  const cfg = readConfig(env.configDir);
  cfg.telemetry.enabled = false;
  writeConfig(env.configDir, cfg);
  env.log("telemetry disabled");
}

export async function previewCmd(env: TelemetryEnv = defaultEnv()): Promise<void> {
  const sample = {
    kind: "cli_command" as const,
    ts: Date.now(),
    command: "ingest --org acme at /Users/alice/code",
    durationMs: 1234,
    exitCode: 0,
  };
  const out = new Sanitizer().sanitizeEvent(sample);
  env.log(JSON.stringify(out, null, 2));
}

export async function purgeCmd(env: TelemetryEnv = defaultEnv()): Promise<void> {
  const cfg = readConfig(env.configDir);
  const path = cfg.telemetry.sinkPath ?? defaultSinkPath(env.dataDir);
  const sink = new LocalFileSink(path);
  await sink.purge();
  env.log(`purged: ${path}`);
}

export async function resetIdCmd(env: TelemetryEnv = defaultEnv()): Promise<void> {
  const cfg = readConfig(env.configDir);
  if (!cfg.telemetry.enabled) {
    env.log("telemetry is disabled; nothing to reset");
    return;
  }
  const id = resetMachineId({ telemetryEnabled: true, configDir: env.configDir });
  env.log(`new machine id: ${id}`);
}
