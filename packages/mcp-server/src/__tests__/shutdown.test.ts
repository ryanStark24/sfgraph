import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installShutdownHandlers } from "../shutdown.js";

describe("installShutdownHandlers", () => {
  it("fires onShutdown on SIGTERM", async () => {
    const signals = new EventEmitter();
    const stdin = new EventEmitter();
    const onShutdown = vi.fn(async () => {});
    installShutdownHandlers({
      onShutdown,
      signalEmitter: signals,
      stdinEmitter: stdin,
      exit: () => {},
    });
    signals.emit("SIGTERM");
    await new Promise((r) => setImmediate(r));
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("fires onShutdown on SIGINT", async () => {
    const signals = new EventEmitter();
    const stdin = new EventEmitter();
    const onShutdown = vi.fn(async () => {});
    installShutdownHandlers({
      onShutdown,
      signalEmitter: signals,
      stdinEmitter: stdin,
      exit: () => {},
    });
    signals.emit("SIGINT");
    await new Promise((r) => setImmediate(r));
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("is idempotent on second signal", async () => {
    const signals = new EventEmitter();
    const stdin = new EventEmitter();
    const onShutdown = vi.fn(async () => {});
    installShutdownHandlers({
      onShutdown,
      signalEmitter: signals,
      stdinEmitter: stdin,
      exit: () => {},
    });
    signals.emit("SIGTERM");
    signals.emit("SIGTERM");
    await new Promise((r) => setImmediate(r));
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("fires on stdin end", async () => {
    const signals = new EventEmitter();
    const stdin = new EventEmitter();
    const onShutdown = vi.fn(async () => {});
    installShutdownHandlers({
      onShutdown,
      signalEmitter: signals,
      stdinEmitter: stdin,
      exit: () => {},
    });
    stdin.emit("end");
    await new Promise((r) => setImmediate(r));
    expect(onShutdown).toHaveBeenCalled();
  });

  it("watchdog calls exit(1) if shutdown hangs", async () => {
    const signals = new EventEmitter();
    const stdin = new EventEmitter();
    const exit = vi.fn();
    installShutdownHandlers({
      onShutdown: () => new Promise(() => {}),
      watchdogMs: 10,
      signalEmitter: signals,
      stdinEmitter: stdin,
      exit,
    });
    signals.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 30));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
