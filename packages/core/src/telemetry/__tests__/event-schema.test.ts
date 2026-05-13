import { describe, expect, it } from "vitest";
import { validateEvent } from "../event-schema.js";

describe("validateEvent", () => {
  it("accepts a valid cli_command event", () => {
    expect(
      validateEvent({
        kind: "cli_command",
        ts: 1,
        command: "ingest",
        durationMs: 10,
        exitCode: 0,
      }),
    ).toEqual({ ok: true });
  });

  it("accepts a valid tool_invoked event", () => {
    expect(
      validateEvent({
        kind: "tool_invoked",
        ts: 1,
        tool: "ping",
        durationMs: 1,
        ok: true,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects unknown kind", () => {
    const r = validateEvent({ kind: "bogus", ts: 1 });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown field", () => {
    const r = validateEvent({
      kind: "cli_command",
      ts: 1,
      command: "x",
      durationMs: 1,
      exitCode: 0,
      hacker: "bad",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects wrong type", () => {
    const r = validateEvent({
      kind: "cli_command",
      ts: "not a number",
      command: "x",
      durationMs: 1,
      exitCode: 0,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects missing required field", () => {
    const r = validateEvent({ kind: "cli_command", ts: 1, command: "x", durationMs: 1 });
    expect(r.ok).toBe(false);
  });

  it("rejects non-object event", () => {
    expect(validateEvent(null).ok).toBe(false);
    expect(validateEvent("x").ok).toBe(false);
  });
});
