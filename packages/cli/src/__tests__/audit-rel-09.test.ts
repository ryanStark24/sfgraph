import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Audit rel-09: on EADDRINUSE `sfgraph serve` SIGTERMs then SIGKILLs whatever
 * process lsof reports on the port, without checking it is an sfgraph process.
 * Correct behaviour: a foreign process (e.g. another dev server) is never
 * signalled.
 *
 * Fully hermetic: child_process is mocked (no real lsof/ps) and process.kill
 * is stubbed, so no real process can be signalled by this test.
 */
const FOREIGN_PID = 2147483000;
const holder = vi.hoisted(() => ({
  cmd: "node /home/dev/other-app/node_modules/.bin/vite --port 7777\n",
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: vi.fn(() => ({ on: () => {}, unref: () => {} })),
    spawnSync: vi.fn((cmd: string) => {
      if (cmd === "lsof" || cmd === "ss" || cmd === "netstat") {
        return { status: 0, stdout: `${FOREIGN_PID}\n`, stderr: "", error: undefined };
      }
      // Any process-identity probe (ps, wmic, ...) sees an unrelated dev server.
      return {
        status: 0,
        stdout: holder.cmd,
        stderr: "",
        error: undefined,
      };
    }),
  };
});

let killSpy: { mock: { calls: unknown[][] } };

beforeEach(() => {
  holder.cmd = "node /home/dev/other-app/node_modules/.bin/vite --port 7777\n";
  killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.doMock("@ryanstark24/sfgraph-web", () => ({
    startWebServer: async () => {
      throw Object.assign(new Error("listen EADDRINUSE: address already in use"), {
        code: "EADDRINUSE",
      });
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("audit rel-09: serve must not kill a foreign process on the port", () => {
  it("does not SIGTERM/SIGKILL a listener that is not sfgraph", async () => {
    const { serveCmd } = await import("../commands/serve.js");
    await Promise.race([
      serveCmd({ port: 7777, host: "127.0.0.1", open: false }).catch(() => {}),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    const signalled = killSpy.mock.calls.filter(
      (c) => c[0] === FOREIGN_PID && c[1] !== 0 && c[1] !== undefined,
    );
    expect(signalled).toEqual([]);
  });

  it("reports the foreign pid and exits non-zero instead", async () => {
    const errSpy = vi.mocked(console.error);
    const { serveCmd } = await import("../commands/serve.js");
    const prev = process.exitCode;
    await serveCmd({ port: 7777, host: "127.0.0.1", open: false });
    expect(process.exitCode).toBe(1);
    process.exitCode = prev;
    const msg = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).toContain(`pid ${FOREIGN_PID}`);
    expect(msg).toMatch(/not an sfgraph server/);
  });

  it("still recycles a stale sfgraph serve holding the port", async () => {
    holder.cmd = "node /usr/local/bin/sfgraph serve --port 7777\n";
    const { serveCmd } = await import("../commands/serve.js");
    await Promise.race([
      serveCmd({ port: 7777, host: "127.0.0.1", open: false }).catch(() => {}),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    expect(killSpy.mock.calls).toContainEqual([FOREIGN_PID, "SIGTERM"]);
  });
});

describe("isSfgraphServeCommand", () => {
  it("recognises sfgraph serve invocations only", async () => {
    const { isSfgraphServeCommand } = await import("../commands/serve.js");
    for (const yes of [
      "node /usr/local/bin/sfgraph serve --port 7777",
      "sfgraph serve",
      "node /Users/dev/.npm/_npx/1/node_modules/@ryanstark24/sfgraph/dist/index.js serve",
      "node /Users/dev/code/sfgraph/packages/cli/dist/index.js serve --port 7777",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\sfgraph.cmd serve",
    ]) {
      expect(isSfgraphServeCommand(yes), yes).toBe(true);
    }
    for (const no of [
      "node /home/dev/other-app/node_modules/.bin/vite --port 7777",
      "node /usr/local/bin/sfgraph ingest --org x",
      "node /Users/dev/code/sfgraph/node_modules/.bin/vite serve",
      "node /Users/dev/code/other/packages/cli/dist/index.js serve",
      "python -m http.server 7777",
      // review M7: `serve` must be the sfgraph subcommand, not any token.
      "node /usr/local/bin/sfgraph ingest --org serve",
      "sfgraph refresh-orgs serve",
      "node /usr/local/bin/sfgraph --port serve",
      "node /home/dev/app/server.js serve sfgraph",
    ]) {
      expect(isSfgraphServeCommand(no), no).toBe(false);
    }
  });
});
