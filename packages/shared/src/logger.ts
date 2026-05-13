export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class ConsoleLogger implements Logger {
  private readonly threshold: number;

  constructor(level: LogLevel = "info") {
    this.threshold = LEVELS[level];
  }

  private log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < this.threshold) return;
    const payload = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
    if (level === "error") console.error(payload);
    else if (level === "warn") console.warn(payload);
    else console.log(payload);
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.log("debug", msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.log("info", msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.log("warn", msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.log("error", msg, meta);
  }
}
