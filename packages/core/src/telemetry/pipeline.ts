import { validateEvent } from "./event-schema.js";
import type { Sanitizer } from "./sanitizer.js";
import type { TelemetrySink } from "./sinks.js";

export interface TelemetryPipelineOpts {
  sink: TelemetrySink;
  sanitizer: Sanitizer;
  getMachineId: () => string | null;
}

export class TelemetryPipeline {
  private readonly sink: TelemetrySink;
  private readonly sanitizer: Sanitizer;
  private readonly getMachineId: () => string | null;
  private failureCount = 0;

  constructor(opts: TelemetryPipelineOpts) {
    this.sink = opts.sink;
    this.sanitizer = opts.sanitizer;
    this.getMachineId = opts.getMachineId;
  }

  async record(event: Record<string, unknown>): Promise<void> {
    try {
      const validation = validateEvent(event);
      if (!validation.ok) {
        this.failureCount++;
        return;
      }
      const sanitized = this.sanitizer.sanitizeEvent(event);
      const mid = this.getMachineId();
      if (mid) sanitized["machineId"] = mid;
      await this.sink.emit(sanitized);
    } catch {
      this.failureCount++;
    }
  }

  getFailureCount(): number {
    return this.failureCount;
  }
}
