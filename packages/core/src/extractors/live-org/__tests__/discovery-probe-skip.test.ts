import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { IngestSkipReport } from "../bulk-retrieve.js";
import { bulkRetrieve } from "../bulk-retrieve.js";
import { type OrgCapabilities, probeCapabilities } from "../capabilities.js";
import { buildJsforceMock } from "./_jsforce-mock.js";

/**
 * Review I2: a transient failure in metadata discovery or a capability probe
 * silently removed whole sources (every generic:<Type>, or the whole
 * vlocity / omnistudio estate) with no skip. Discovery must be retried and,
 * if it still fails, surface as a `discovery` skip that `--retry-skipped`
 * re-runs; a probe must distinguish "object absent" (false, no skip) from a
 * transient error (retry, then a skip under the gated source's label).
 */

const caps: OrgCapabilities = {
  detectedNamespaces: [],
  vlocityNamespaces: [],
  vlocityLegacy: false,
  vlocityCmt: false,
  omnistudioOncore: false,
  agentforce: false,
  experienceCloud: false,
  sourceTracking: false,
};

const FLEXI = {
  xmlName: "FlexiPage",
  suffix: "flexipage",
  directoryName: "flexipages",
  childXmlNames: [],
  inFolder: false,
  metaFile: false,
};

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) {
    /* consume */
  }
}

/** Mock whose metadata.describe fails `failures` times before succeeding. */
function connWithFlakyDescribe(failures: number) {
  const conn = buildJsforceMock({ metadataList: { FlexiPage: [] } });
  const calls = { describe: 0, listedTypes: [] as string[] };
  conn.metadata.describe = async () => {
    calls.describe += 1;
    if (calls.describe <= failures) throw new Error("socket hang up (ECONNRESET)");
    return { metadataObjects: [FLEXI] };
  };
  const list = conn.metadata.list;
  conn.metadata.list = async (req: any) => {
    for (const t of Array.isArray(req) ? req : [req]) calls.listedTypes.push(t?.type);
    return list(req);
  };
  return { conn, calls };
}

describe("metadata discovery failures (review I2)", () => {
  it("a discovery call that keeps failing is retried, then recorded as a `discovery` skip", async () => {
    const { conn, calls } = connWithFlakyDescribe(Number.POSITIVE_INFINITY);
    const skipReport: IngestSkipReport = { skips: [] };
    await drain(
      bulkRetrieve(conn, caps, asOrgId("org_1"), {
        skipReport,
        onlyLabels: new Set(["generic:FlexiPage"]),
      }),
    );
    expect(calls.describe).toBeGreaterThan(1);
    const labels = skipReport.skips.map((s) => s.label);
    expect(labels).toContain("discovery");
    expect(skipReport.skips.find((s) => s.label === "discovery")?.reason).toMatch(/ECONNRESET/);
  });

  it("a transient discovery failure recovers on retry and routes generic sources", async () => {
    const { conn, calls } = connWithFlakyDescribe(1);
    const skipReport: IngestSkipReport = { skips: [] };
    await drain(
      bulkRetrieve(conn, caps, asOrgId("org_1"), {
        skipReport,
        onlyLabels: new Set(["generic:FlexiPage"]),
      }),
    );
    expect(calls.describe).toBe(2);
    expect(calls.listedTypes).toContain("FlexiPage");
    expect(skipReport.skips.map((s) => s.label)).not.toContain("discovery");
  });

  it("--retry-skipped with the `discovery` label re-runs every generic source", async () => {
    const { conn, calls } = connWithFlakyDescribe(0);
    const skipReport: IngestSkipReport = { skips: [] };
    await drain(
      bulkRetrieve(conn, caps, asOrgId("org_1"), {
        skipReport,
        onlyLabels: new Set(["discovery"]),
      }),
    );
    expect(calls.listedTypes).toContain("FlexiPage");
    expect(skipReport.skips).toEqual([]);
  });
});

describe("capability probe failures (review I2)", () => {
  /** Make `conn.sobject(name).describe()` fail `failures` times with a
   *  transient error before succeeding. */
  function flakyDescribe(conn: any, name: string, failures: number): { calls: number } {
    const state = { calls: 0 };
    const orig = conn.sobject;
    conn.sobject = (n: string) => {
      if (n !== name) return orig(n);
      return {
        describe: async () => {
          state.calls += 1;
          if (state.calls <= failures)
            throw new Error("describe OmniProcess timed out after 15000ms");
          return { name: n };
        },
      };
    };
    return state;
  }

  it("an absent object is false with no probe error", async () => {
    const caps = await probeCapabilities(buildJsforceMock());
    expect(caps.omnistudioOncore).toBe(false);
    expect(caps.probeErrors ?? []).toEqual([]);
  });

  it("a transient probe failure is retried and recovers", async () => {
    const conn = buildJsforceMock();
    const state = flakyDescribe(conn, "OmniProcess", 1);
    const caps = await probeCapabilities(conn);
    expect(state.calls).toBe(2);
    expect(caps.omnistudioOncore).toBe(true);
    expect(caps.probeErrors ?? []).toEqual([]);
  });

  it("a probe that keeps failing is reported, and bulkRetrieve records a skip for the gated source", async () => {
    const conn = buildJsforceMock();
    flakyDescribe(conn, "OmniProcess", Number.POSITIVE_INFINITY);
    const probed = await probeCapabilities(conn);
    expect(probed.omnistudioOncore).toBe(false);
    expect(probed.probeErrors?.map((p) => [p.probe, p.source])).toEqual([
      ["OmniProcess", "omnistudio"],
    ]);

    const skipReport: IngestSkipReport = { skips: [] };
    await drain(
      bulkRetrieve(conn, probed, asOrgId("org_1"), {
        skipReport,
        onlyLabels: new Set(["omnistudio"]),
      }),
    );
    const skip = skipReport.skips.find((s) => s.label === "omnistudio");
    expect(skip?.reason).toMatch(/OmniProcess.*timed out/);
  });

  it("a failing vlocity namespace probe becomes a `vlocity` skip", async () => {
    const conn = buildJsforceMock();
    flakyDescribe(conn, "vlocity_cmt__DRBundle__c", Number.POSITIVE_INFINITY);
    const probed = await probeCapabilities(conn);
    expect(probed.vlocityLegacy).toBe(false);
    const skipReport: IngestSkipReport = { skips: [] };
    await drain(
      bulkRetrieve(conn, probed, asOrgId("org_1"), { skipReport, onlyLabels: new Set() }),
    );
    // --only with an unrelated label set does not report it...
    expect(skipReport.skips).toEqual([]);
    await drain(bulkRetrieve(conn, probed, asOrgId("org_1"), { skipReport }));
    // ...a full run does.
    expect(skipReport.skips.map((s) => s.label)).toContain("vlocity");
  });
});
