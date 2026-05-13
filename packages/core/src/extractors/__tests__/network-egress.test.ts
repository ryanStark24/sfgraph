import dns from "node:dns";
import { describe, expect, it } from "vitest";

const ALLOW = new Set(["localhost", "127.0.0.1", "::1"]);

describe("network egress", () => {
  it("no external DNS resolution during @sfgraph/core import or MCP server construction", async () => {
    const lookups: string[] = [];
    const originalLookup = dns.lookup;
    const originalPromisesLookup = dns.promises.lookup;
    (dns as any).lookup = (hostname: string, ...rest: any[]) => {
      lookups.push(hostname);
      // pretend resolve to loopback so anything attempting still gets a value
      const cb = typeof rest[rest.length - 1] === "function" ? rest[rest.length - 1] : null;
      if (cb) cb(null, "127.0.0.1", 4);
      return undefined as any;
    };
    (dns.promises as any).lookup = async (hostname: string) => {
      lookups.push(hostname);
      return { address: "127.0.0.1", family: 4 };
    };
    try {
      await import("../../index.js");
    } finally {
      (dns as any).lookup = originalLookup;
      (dns.promises as any).lookup = originalPromisesLookup;
    }
    const violations = lookups.filter((h) => !ALLOW.has(h));
    expect(violations).toEqual([]);
  });
});
