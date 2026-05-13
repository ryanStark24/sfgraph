import { describe, expect, it } from "vitest";
import { TelemetryPipeline } from "../pipeline.js";
import { Sanitizer } from "../sanitizer.js";
import type { TelemetrySink } from "../sinks.js";

class CapturingSink implements TelemetrySink {
  events: Record<string, unknown>[] = [];
  async emit(e: Record<string, unknown>): Promise<void> {
    this.events.push(e);
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

class ThrowingSink implements TelemetrySink {
  async emit(): Promise<void> {
    throw new Error("boom");
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

describe("TelemetryPipeline", () => {
  it("sanitizes values via sanitizer", async () => {
    const sink = new CapturingSink();
    const p = new TelemetryPipeline({
      sink,
      sanitizer: new Sanitizer(),
      getMachineId: () => "mid-1",
    });
    await p.record({
      kind: "ingest_failure",
      ts: 1,
      category: "ApexClass",
      errorCode: "err at /Users/x",
    });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!["errorCode"]).toBe("err at <path>");
    expect(sink.events[0]!["machineId"]).toBe("mid-1");
  });

  it("skips invalid events without throwing", async () => {
    const sink = new CapturingSink();
    const p = new TelemetryPipeline({
      sink,
      sanitizer: new Sanitizer(),
      getMachineId: () => null,
    });
    await p.record({ kind: "unknown" });
    expect(sink.events).toHaveLength(0);
    expect(p.getFailureCount()).toBe(1);
  });

  it("swallows sink failures", async () => {
    const p = new TelemetryPipeline({
      sink: new ThrowingSink(),
      sanitizer: new Sanitizer(),
      getMachineId: () => null,
    });
    await expect(
      p.record({ kind: "mcp_startup", ts: 1, version: "0.0.0" }),
    ).resolves.toBeUndefined();
    expect(p.getFailureCount()).toBe(1);
  });

  it("does not attach machineId when null", async () => {
    const sink = new CapturingSink();
    const p = new TelemetryPipeline({
      sink,
      sanitizer: new Sanitizer(),
      getMachineId: () => null,
    });
    await p.record({ kind: "mcp_startup", ts: 1, version: "0.0.0" });
    expect(sink.events[0]).not.toHaveProperty("machineId");
  });
});
