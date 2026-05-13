export const EVENT_KINDS = [
  "cli_command",
  "tool_invoked",
  "ingest_failure",
  "parse_failure",
  "mcp_startup",
  "mcp_shutdown",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export interface BaseEvent {
  kind: EventKind;
  ts: number;
}

export interface CliCommandEvent extends BaseEvent {
  kind: "cli_command";
  command: string;
  durationMs: number;
  exitCode: number;
}

export interface ToolInvokedEvent extends BaseEvent {
  kind: "tool_invoked";
  tool: string;
  durationMs: number;
  ok: boolean;
}

export interface IngestFailureEvent extends BaseEvent {
  kind: "ingest_failure";
  category: string;
  errorCode: string;
}

export interface ParseFailureEvent extends BaseEvent {
  kind: "parse_failure";
  category: string;
  errorCode: string;
}

export interface McpStartupEvent extends BaseEvent {
  kind: "mcp_startup";
  version: string;
}

export interface McpShutdownEvent extends BaseEvent {
  kind: "mcp_shutdown";
  reason: string;
  durationMs: number;
}

export type TelemetryEvent =
  | CliCommandEvent
  | ToolInvokedEvent
  | IngestFailureEvent
  | ParseFailureEvent
  | McpStartupEvent
  | McpShutdownEvent;

export const ALLOWED_FIELDS_BY_KIND: Record<EventKind, Set<string>> = {
  cli_command: new Set(["kind", "ts", "command", "durationMs", "exitCode"]),
  tool_invoked: new Set(["kind", "ts", "tool", "durationMs", "ok"]),
  ingest_failure: new Set(["kind", "ts", "category", "errorCode"]),
  parse_failure: new Set(["kind", "ts", "category", "errorCode"]),
  mcp_startup: new Set(["kind", "ts", "version"]),
  mcp_shutdown: new Set(["kind", "ts", "reason", "durationMs"]),
};

const FIELD_TYPES: Record<EventKind, Record<string, "string" | "number" | "boolean">> = {
  cli_command: {
    kind: "string",
    ts: "number",
    command: "string",
    durationMs: "number",
    exitCode: "number",
  },
  tool_invoked: {
    kind: "string",
    ts: "number",
    tool: "string",
    durationMs: "number",
    ok: "boolean",
  },
  ingest_failure: { kind: "string", ts: "number", category: "string", errorCode: "string" },
  parse_failure: { kind: "string", ts: "number", category: "string", errorCode: "string" },
  mcp_startup: { kind: "string", ts: "number", version: "string" },
  mcp_shutdown: { kind: "string", ts: "number", reason: "string", durationMs: "number" },
};

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export function validateEvent(event: unknown): ValidationResult {
  if (typeof event !== "object" || event === null) {
    return { ok: false, reason: "event must be an object" };
  }
  const e = event as Record<string, unknown>;
  const kind = e["kind"];
  if (typeof kind !== "string" || !EVENT_KINDS.includes(kind as EventKind)) {
    return { ok: false, reason: `unknown kind: ${String(kind)}` };
  }
  const allowed = ALLOWED_FIELDS_BY_KIND[kind as EventKind];
  const types = FIELD_TYPES[kind as EventKind];
  for (const key of Object.keys(e)) {
    if (!allowed.has(key)) {
      return { ok: false, reason: `unknown field '${key}' for kind ${kind}` };
    }
    const expectedType = types[key];
    if (expectedType && typeof e[key] !== expectedType) {
      return { ok: false, reason: `field '${key}' must be ${expectedType}` };
    }
  }
  for (const required of allowed) {
    if (!(required in e)) {
      return { ok: false, reason: `missing required field '${required}'` };
    }
  }
  return { ok: true };
}
