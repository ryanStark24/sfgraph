import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ServeHandle, allowedHosts, startWebServer } from "../server.js";

/**
 * Audit sec-03: the web visualiser serves /api/* to any request, whatever the
 * Host header. A DNS-rebinding page (Host: attacker.example) can therefore
 * read the ingested org graph. Correct behaviour: reject requests whose Host
 * is not a loopback name for this server.
 *
 * Uses an empty temp SFGRAPH_DATA_DIR (the variable getSfgraphPaths actually reads) and port 0; no real data is touched.
 */
let tmpHome: string;
let prevHome: string | undefined;
let handle: ServeHandle;

beforeEach(async () => {
  tmpHome = mkdtempSync(path.join(tmpdir(), "sfg-web-sec03-"));
  prevHome = process.env.SFGRAPH_DATA_DIR;
  process.env.SFGRAPH_DATA_DIR = tmpHome;
  handle = await startWebServer({ port: 0, host: "127.0.0.1", log: () => {} });
});

afterEach(async () => {
  await handle.stop();
  // biome-ignore lint/performance/noDelete: assigning undefined to process.env coerces to the string "undefined"
  if (prevHome === undefined) delete process.env.SFGRAPH_DATA_DIR;
  else process.env.SFGRAPH_DATA_DIR = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function get(
  urlPath: string,
  hostHeader: string,
  extra: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: handle.port,
        path: urlPath,
        method: "GET",
        headers: { Host: hostHeader, ...extra },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("audit sec-03: web API Host header allowlist", () => {
  it("rejects /api requests carrying a foreign Host header (DNS rebinding)", async () => {
    const status = await get("/api/orgs", "attacker.example");
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  }, 30_000);

  it("still serves /api requests with a loopback Host header", async () => {
    const status = await get("/api/orgs", `127.0.0.1:${handle.port}`);
    expect(status).toBe(200);
  }, 30_000);

  it("accepts localhost:<port> and rejects a foreign Host on non-api paths too", async () => {
    expect(await get("/api/orgs", `localhost:${handle.port}`)).toBe(200);
    expect(await get("/api/orgs", "127.0.0.1:1")).toBe(403);
    expect(await get("/", "attacker.example")).toBe(403);
  }, 30_000);

  it("checks the Origin header when a browser sends one", async () => {
    const h = `127.0.0.1:${handle.port}`;
    expect(await get("/api/orgs", h, { Origin: `http://${h}` })).toBe(200);
    expect(await get("/api/orgs", h, { Origin: "http://attacker.example" })).toBe(403);
    expect(await get("/api/orgs", h, { Origin: "null" })).toBe(403);
  }, 30_000);
});

describe("allowedHosts", () => {
  it("lists loopback names with the port, plus an explicit non-loopback bind", () => {
    expect([...allowedHosts("127.0.0.1", 7777)].sort()).toEqual(
      ["127.0.0.1:7777", "[::1]:7777", "localhost:7777"].sort(),
    );
    expect(allowedHosts("192.168.1.5", 7777).has("192.168.1.5:7777")).toBe(true);
    expect(allowedHosts("127.0.0.1", 80).has("localhost")).toBe(true);
    expect(allowedHosts("127.0.0.1", 7777).has("localhost")).toBe(false);
  });
});
