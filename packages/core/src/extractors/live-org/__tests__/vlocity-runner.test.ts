import { beforeEach, describe, expect, it } from "vitest";
import type { RawMember } from "../../interfaces/metadata-source.js";
import type { OrgCapabilities } from "../capabilities.js";
import { limiter } from "../rate-limit.js";
import { iterVlocityRecords, loadVlocityRegistry } from "../vlocity/runner.js";

const baseCaps: OrgCapabilities = {
  detectedNamespaces: [],
  vlocityNamespaces: [],
  vlocityLegacy: false,
  vlocityCmt: false,
  omnistudioOncore: false,
  agentforce: false,
  experienceCloud: false,
  sourceTracking: false,
};

function recordingConn(): { conn: { query: (soql: string) => Promise<unknown> }; soqls: string[] } {
  const soqls: string[] = [];
  return {
    soqls,
    conn: {
      query: async (soql: string) => {
        soqls.push(soql);
        return { records: [], done: true };
      },
    },
  };
}

async function collect(iter: AsyncIterable<RawMember>): Promise<RawMember[]> {
  const out: RawMember[] = [];
  for await (const m of iter) out.push(m);
  return out;
}

describe("loadVlocityRegistry", () => {
  it("returns more than 40 entries", () => {
    const reg = loadVlocityRegistry();
    expect(Object.keys(reg).length).toBeGreaterThan(40);
  });

  it("every entry has vlocityDataPackType and query strings; most queries use the namespace placeholder", () => {
    const reg = loadVlocityRegistry();
    let withPlaceholder = 0;
    for (const [key, def] of Object.entries(reg)) {
      expect(typeof def.vlocityDataPackType, `entry ${key}`).toBe("string");
      expect(typeof def.query, `entry ${key}`).toBe("string");
      if (def.query.includes("%vlocity_namespace%")) withPlaceholder++;
    }
    // Vast majority of upstream entries are namespace-bound; a handful target
    // standard objects (e.g. Pricebook2) and do not require substitution.
    expect(withPlaceholder).toBeGreaterThan(Object.keys(reg).length * 0.8);
  });
});

describe("iterVlocityRecords", () => {
  beforeEach(async () => {
    // Refill the shared Bottleneck reservoir so multi-namespace fan-out
    // (~96 queries per test) doesn't stall waiting for the 60s refresh.
    await limiter.incrementReservoir(1000);
  });

  it("substitutes namespace placeholder for a single namespace", { timeout: 20_000 }, async () => {
    const { conn, soqls } = recordingConn();
    const caps: OrgCapabilities = {
      ...baseCaps,
      vlocityNamespaces: ["vlocity_ins"],
      vlocityLegacy: true,
    };
    await collect(iterVlocityRecords(conn, caps, "00Dxx0000000001"));
    expect(soqls.length).toBeGreaterThan(0);
    expect(soqls.every((s) => !s.includes("%vlocity_namespace%"))).toBe(true);
    expect(soqls.some((s) => s.includes("vlocity_ins__"))).toBe(true);
    expect(soqls.some((s) => s.includes("vlocity_cmt__"))).toBe(false);
  });

  it("executes queries for every detected namespace", { timeout: 20_000 }, async () => {
    const { conn, soqls } = recordingConn();
    const caps: OrgCapabilities = {
      ...baseCaps,
      vlocityNamespaces: ["vlocity_cmt", "vlocity_ins"],
      vlocityLegacy: true,
      vlocityCmt: true,
    };
    await collect(iterVlocityRecords(conn, caps, "00Dxx0000000001"));
    expect(soqls.some((s) => s.includes("vlocity_cmt__"))).toBe(true);
    expect(soqls.some((s) => s.includes("vlocity_ins__"))).toBe(true);
  });

  it("executes no SOQL when no Vlocity namespaces are detected", async () => {
    const { conn, soqls } = recordingConn();
    await collect(iterVlocityRecords(conn, baseCaps, "00Dxx0000000001"));
    expect(soqls).toEqual([]);
  });
});
