import { appendFile, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface TelemetrySink {
  emit(event: Record<string, unknown>): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export class NullSink implements TelemetrySink {
  async emit(): Promise<void> {}
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

export class LocalFileSink implements TelemetrySink {
  private readonly path: string;
  private inited = false;

  constructor(path: string) {
    this.path = path;
  }

  private async init(): Promise<void> {
    if (this.inited) return;
    await mkdir(dirname(this.path), { recursive: true });
    this.inited = true;
  }

  async emit(event: Record<string, unknown>): Promise<void> {
    await this.init();
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
    await appendFile(this.path, line, "utf8");
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}

  async purge(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
  }

  getPath(): string {
    return this.path;
  }
}
