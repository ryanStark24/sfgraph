import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { bulkRetrieve, mergeAsyncIterablesParallel } from "../bulk-retrieve.js";
import type { OrgCapabilities } from "../capabilities.js";
import { buildJsforceMock } from "./_jsforce-mock.js";

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

function mockConn() {
  return buildJsforceMock({
    toolingQueryResults: {
      "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate FROM ApexClass": {
        records: [
          {
            Id: "01p000001",
            Name: "Hello",
            Body: "public class Hello {}",
            LastModifiedDate: "2025-01-01T00:00:00Z",
          },
        ],
        done: true,
      },
      "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate, TableEnumOrId FROM ApexTrigger": {
        records: [],
        done: true,
      },
      "SELECT Id, DeveloperName, NamespacePrefix, LastModifiedDate FROM LightningComponentBundle": {
        records: [],
        done: true,
      },
      "SELECT QualifiedApiName, NamespacePrefix, LastModifiedDate FROM EntityDefinition WHERE IsCustomSetting=false AND IsCustomizable=true":
        { records: [], done: true },
    },
    metadataList: {
      Flow: [],
      Profile: [],
      PermissionSet: [],
      SharingRules: [],
      NamedCredential: [],
      ExternalServiceRegistration: [],
    },
  });
}

async function collect(iter: AsyncIterable<RawMember>): Promise<RawMember[]> {
  const out: RawMember[] = [];
  for await (const m of iter) out.push(m);
  return out;
}

describe("bulkRetrieve", () => {
  it("emits members from core categories when capabilities are off", async () => {
    const conn = mockConn();
    const members = await collect(bulkRetrieve(conn, baseCaps, asOrgId("org_1")));
    const types = members.map((m) => m.ref.memberType).sort();
    expect(types).toContain("ApexClass");
    expect(types).not.toContain("VlocityDataRaptor");
    expect(types).not.toContain("OmniProcess");
  });

  it("gates vlocity off when caps.vlocityCmt is false", async () => {
    const conn = mockConn();
    conn.query = async () => ({
      records: [{ Id: "x", Name: "ShouldNotAppear", LastModifiedDate: "2025-01-01T00:00:00Z" }],
      done: true,
    });
    const members = await collect(bulkRetrieve(conn, baseCaps, asOrgId("org_1")));
    expect(members.find((m) => m.ref.memberType.startsWith("Vlocity"))).toBeUndefined();
  });

  it("activates vlocity + omnistudio when caps say so", async () => {
    const conn = mockConn();
    conn.query = async () => ({
      records: [{ Id: "v1", Name: "DR1", LastModifiedDate: "2025-01-01T00:00:00Z" }],
      done: true,
    });
    conn.tooling.query = async (soql: string) => {
      if (soql.includes("FROM OmniProcess")) {
        return {
          records: [{ Id: "o1", Name: "OP1", LastModifiedDate: "2025-01-01T00:00:00Z" }],
          done: true,
        };
      }
      return { records: [], done: true };
    };
    const caps: OrgCapabilities = {
      ...baseCaps,
      vlocityCmt: true,
      vlocityLegacy: true,
      vlocityNamespaces: ["vlocity_cmt"],
      omnistudioOncore: true,
    };
    const members = await collect(bulkRetrieve(conn, caps, asOrgId("org_1")));
    const types = members.map((m) => m.ref.memberType);
    expect(members.some((m) => m.ref.namespace === "vlocity_cmt")).toBe(true);
    expect(types.some((t) => t.startsWith("Omni"))).toBe(true);
  });
});

describe("mergeAsyncIterablesParallel", () => {
  /** Helper async generator that yields `id` after `delayMs`, then `id+'-end'`
   *  after another `delayMs`. Used to prove that two iterators progress in
   *  parallel rather than one-at-a-time. */
  async function* slowSource(id: string, delayMs: number): AsyncIterable<string> {
    await new Promise((r) => setTimeout(r, delayMs));
    yield `${id}-1`;
    await new Promise((r) => setTimeout(r, delayMs));
    yield `${id}-2`;
  }

  it("drains all iterables concurrently (wall-time ~ max, not sum)", async () => {
    const start = Date.now();
    const out: string[] = [];
    for await (const v of mergeAsyncIterablesParallel(
      slowSource("a", 50),
      slowSource("b", 50),
      slowSource("c", 50),
    )) {
      out.push(v);
    }
    const elapsed = Date.now() - start;
    // Sequential would be ~6 * 50 = 300ms. Parallel is ~2 * 50 = 100ms.
    // Allow a generous ceiling for slow CI; the assertion that matters is
    // "well under the sequential floor of 300ms".
    expect(elapsed).toBeLessThan(250);
    expect(out.sort()).toEqual(["a-1", "a-2", "b-1", "b-2", "c-1", "c-2"]);
  });

  it("interleaves values from sources that finish at different rates", async () => {
    // Fast source yields twice before slow source yields once.
    async function* fast(): AsyncIterable<string> {
      yield "f-1";
      yield "f-2";
    }
    async function* slow(): AsyncIterable<string> {
      await new Promise((r) => setTimeout(r, 30));
      yield "s-1";
    }
    const out: string[] = [];
    for await (const v of mergeAsyncIterablesParallel(fast(), slow())) out.push(v);
    // Fast finishes first; slow shows up after.
    expect(out).toContain("f-1");
    expect(out).toContain("f-2");
    expect(out).toContain("s-1");
    expect(out.indexOf("f-2")).toBeLessThan(out.indexOf("s-1"));
  });

  it("handles empty input array", async () => {
    const out: string[] = [];
    for await (const v of mergeAsyncIterablesParallel<string>()) out.push(v);
    expect(out).toEqual([]);
  });
});
