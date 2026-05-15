import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serveCmd } from "../commands/serve.js";

/**
 * The web API has no authentication — binding to a non-loopback host leaks
 * the full ingested org graph to anyone reachable on that interface. The
 * CLI refuses to do that without an explicit `--i-understand-public-bind`
 * acknowledgement.
 */

let prevExitCode: typeof process.exitCode;
let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  prevExitCode = process.exitCode;
  process.exitCode = 0;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = prevExitCode;
  errSpy.mockRestore();
  warnSpy.mockRestore();
  vi.restoreAllMocks();
});

describe("serveCmd public-bind guard", () => {
  it("refuses to start on 0.0.0.0 without --i-understand-public-bind", async () => {
    await serveCmd({ port: 0, host: "0.0.0.0", open: false });
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    const calls = errSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes("refusing to bind"))).toBe(true);
  });

  it("refuses to start on a LAN IP without acknowledgement", async () => {
    await serveCmd({ port: 0, host: "192.168.1.10", open: false });
    expect(process.exitCode).toBe(1);
    const calls = errSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes("192.168.1.10"))).toBe(true);
  });

  it("accepts 127.0.0.1 without acknowledgement (default)", async () => {
    // Stub the actual server import so we don't open a socket.
    vi.doMock("@ryanstark24/sfgraph-web", () => ({
      startWebServer: async () => ({
        port: 7777,
        url: "http://127.0.0.1:7777",
        stop: async () => {},
      }),
    }));
    // Race serveCmd against a microtask — it blocks on a never-resolving
    // promise, so we just verify it doesn't early-exit.
    let earlyExit = false;
    const p = serveCmd({ port: 0, host: "127.0.0.1", open: false }).then(() => {
      earlyExit = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(earlyExit).toBe(false);
    expect(process.exitCode).toBe(0);
    void p;
  });

  it("accepts public host when --i-understand-public-bind is set (warns loudly)", async () => {
    vi.doMock("@ryanstark24/sfgraph-web", () => ({
      startWebServer: async () => ({
        port: 7777,
        url: "http://0.0.0.0:7777",
        stop: async () => {},
      }),
    }));
    let earlyExit = false;
    const p = serveCmd({
      port: 0,
      host: "0.0.0.0",
      open: false,
      iUnderstandPublicBind: true,
    }).then(() => {
      earlyExit = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(earlyExit).toBe(false);
    expect(process.exitCode).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    void p;
  });
});
