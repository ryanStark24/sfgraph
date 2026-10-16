import { describe, expect, it } from "vitest";
import type { RawMember } from "../../../interfaces/metadata-source.js";
import { IncompleteSourceError } from "../../retry.js";
import { iterVlocityRecords } from "../../vlocity/runner.js";
import { iterCustomSettings } from "../custom-settings.js";
import { iterFlow } from "../flow.js";
import { iterGenericMetadata } from "../generic-metadata.js";
import { iterIntegration } from "../integration.js";
import { iterOmnistudio } from "../omnistudio.js";
import { iterSecurity } from "../security.js";

/**
 * Sweep of extractors/live-org for the swallowed-error shape behind the
 * Large-org Apex/object gaps: a fetch fails, the extractor `catch {}`s /
 * `continue`s / returns, and the source logs ✓ with members missing. Every
 * case below must (a) keep what was fetched and (b) end with an error naming
 * what was lost, so failSoft records a skip that --retry-skipped re-runs.
 */

const NO_BACKOFF = { retryBackoffMs: 0 };

async function drain(it: AsyncIterable<RawMember>) {
  const names: string[] = [];
  let error: Error | undefined;
  try {
    for await (const m of it) names.push(m.ref.memberName);
  } catch (e) {
    error = e as Error;
  }
  return { names, error };
}

function failureNames(e: Error | undefined): string[] {
  expect(e).toBeInstanceOf(IncompleteSourceError);
  return (e as IncompleteSourceError).failures.map((f) => f.name).sort();
}

/** metadata.list / metadata.read mock. `readFails(name)` rejects any batch
 *  containing that member; `listFails(type)` rejects the list call. */
function mdConn(
  lists: Record<string, string[]>,
  o: { readFails?: (n: string) => boolean; listFails?: (t: string) => boolean } = {},
) {
  return {
    metadata: {
      list: async ([{ type }]: [{ type: string }]) => {
        if (o.listFails?.(type)) throw new Error(`ETIMEDOUT metadata.list ${type}`);
        return (lists[type] ?? []).map((fullName) => ({ fullName, type }));
      },
      read: async (_type: string, names: string[]) => {
        if (names.some((n) => o.readFails?.(n))) throw new Error("socket hang up");
        return names.map((fullName) => ({ fullName }));
      },
    },
  };
}

describe("security / integration — merged sub-stream failures are not swallowed", () => {
  it("security: a failing PermissionSet list surfaces while Profiles still yield", async () => {
    const conn = mdConn(
      { Profile: ["Admin"], PermissionSet: ["PS1"], SharingRules: [] },
      { listFails: (t) => t === "PermissionSet" },
    );
    const { names, error } = await drain(iterSecurity(conn, NO_BACKOFF));
    expect(names).toContain("Admin");
    expect(failureNames(error)).toEqual(["PermissionSet"]);
  });

  it("security: an unreadable member is named", async () => {
    const conn = mdConn(
      { Profile: ["Admin", "Broken"], PermissionSet: [], SharingRules: [] },
      { readFails: (n) => n === "Broken" },
    );
    const { names, error } = await drain(iterSecurity(conn, NO_BACKOFF));
    expect(names).toContain("Admin");
    expect(failureNames(error)).toEqual(["Profile:Broken"]);
  });

  it("integration: a failing NamedCredential list surfaces", async () => {
    const conn = mdConn(
      { NamedCredential: ["NC1"], ExternalServiceRegistration: ["ESR1"] },
      { listFails: (t) => t === "NamedCredential" },
    );
    const { names, error } = await drain(iterIntegration(conn, NO_BACKOFF));
    expect(names).toContain("ESR1");
    expect(failureNames(error)).toEqual(["NamedCredential"]);
  });
});

describe("flow / generic metadata — dropped reads are reported", () => {
  it("flow: an unreadable flow is named, the rest still yield", async () => {
    const conn = mdConn({ Flow: ["F1", "F2", "Bad"] }, { readFails: (n) => n === "Bad" });
    const { names, error } = await drain(iterFlow(conn, NO_BACKOFF));
    expect(names.sort()).toEqual(["F1", "F2"]);
    expect(failureNames(error)).toEqual(["Bad"]);
  });

  it("generic: a failing list is surfaced instead of ending with 0 records", async () => {
    const conn = mdConn({ Layout: ["L1"] }, { listFails: () => true });
    const { names, error } = await drain(iterGenericMetadata(conn, "00D1", "Layout", NO_BACKOFF));
    expect(names).toEqual([]);
    expect(error?.message).toMatch(/metadata\.list Layout/);
  });

  it("generic: a type the org does not support still ends quietly", async () => {
    const conn = {
      metadata: {
        list: async () => {
          throw new Error("INVALID_TYPE: Cannot use: Foo in this organization");
        },
      },
    };
    const { names, error } = await drain(iterGenericMetadata(conn, "00D1", "Foo", NO_BACKOFF));
    expect(names).toEqual([]);
    expect(error).toBeUndefined();
  });

  it("generic: an unreadable member is named under the generic:<Type> label", async () => {
    const conn = mdConn({ Layout: ["L1", "L2"] }, { readFails: (n) => n === "L2" });
    const { names, error } = await drain(iterGenericMetadata(conn, "00D1", "Layout", NO_BACKOFF));
    expect(names).toEqual(["L1"]);
    expect(failureNames(error)).toEqual(["L2"]);
    expect(error?.message).toMatch(/^generic:Layout:/);
  });
});

describe("custom settings — discovery and row fetches", () => {
  function csConn(o: { discoveryFails?: boolean; rowsFail?: (obj: string) => boolean }) {
    return {
      tooling: {
        query: async () => {
          if (o.discoveryFails) throw new Error("ETIMEDOUT");
          return {
            records: [{ QualifiedApiName: "A__c" }],
            done: false,
            nextRecordsUrl: "/q/cs-2",
          };
        },
        queryMore: async () => ({ records: [{ QualifiedApiName: "B__c" }], done: true }),
      },
      query: async (soql: string) => {
        const obj = /FROM (\w+)/.exec(soql)?.[1] ?? "";
        if (o.rowsFail?.(obj)) throw new Error("socket hang up");
        return { records: [{ Id: "1", Value__c: obj }], done: true };
      },
    };
  }

  it("drains every discovery page", async () => {
    const { names, error } = await drain(iterCustomSettings(csConn({}), "00D1", NO_BACKOFF));
    expect(error).toBeUndefined();
    expect(names.sort()).toEqual(["A__c", "B__c"]);
  });

  it("surfaces a failed discovery instead of returning", async () => {
    const { error } = await drain(
      iterCustomSettings(csConn({ discoveryFails: true }), "00D1", NO_BACKOFF),
    );
    expect(error?.message).toMatch(/ETIMEDOUT/);
  });

  it("names a setting whose rows could not be fetched", async () => {
    const { names, error } = await drain(
      iterCustomSettings(csConn({ rowsFail: (o) => o === "B__c" }), "00D1", NO_BACKOFF),
    );
    expect(names).toEqual(["A__c"]);
    expect(failureNames(error)).toEqual(["B__c"]);
  });
});

describe("omnistudio — pagination and child-fetch failures", () => {
  function omniConn(o: { elementsFail?: boolean } = {}) {
    return {
      query: async (soql: string) => {
        if (soql.includes("FROM OmniProcessElement")) {
          if (o.elementsFail) throw new Error("socket hang up");
          return { records: [], done: true };
        }
        if (soql.includes("FROM OmniProcess")) {
          return {
            records: [{ Id: "p1", Name: "OP1" }],
            done: false,
            nextRecordsUrl: "/q/op-2",
          };
        }
        return { records: [], done: true };
      },
      queryMore: async () => ({ records: [{ Id: "p2", Name: "OP2" }], done: true }),
    };
  }

  it("drains every page of the parent query", async () => {
    const { names, error } = await drain(iterOmnistudio(omniConn(), { retry: NO_BACKOFF }));
    expect(error).toBeUndefined();
    expect(names.sort()).toEqual(["OP1", "OP2"]);
  });

  it("names parents whose element graph could not be fetched", async () => {
    const { names, error } = await drain(
      iterOmnistudio(omniConn({ elementsFail: true }), { retry: NO_BACKOFF }),
    );
    expect(names).toEqual([]);
    expect(failureNames(error)).toEqual(["OmniProcess:OP1", "OmniProcess:OP2"]);
  });
});

describe("vlocity — transient query failures surface under the vlocity label", () => {
  const caps = {
    detectedNamespaces: [],
    vlocityNamespaces: ["vlocity_cmt"],
    vlocityLegacy: true,
    vlocityCmt: true,
    omnistudioOncore: false,
    agentforce: false,
    experienceCloud: false,
    sourceTracking: false,
  };

  it("a type query that keeps timing out is named instead of becoming an empty type", async () => {
    const onError: string[] = [];
    const conn = {
      describeGlobal: async () => ({ sobjects: [{ name: "vlocity_cmt__DRBundle__c" }] }),
      query: async () => {
        throw new Error("socket hang up");
      },
    };
    const { error } = await drain(
      iterVlocityRecords(conn, caps, "00D1", (l) => onError.push(l), NO_BACKOFF),
    );
    expect(error).toBeInstanceOf(IncompleteSourceError);
    expect(error?.message).toMatch(/^vlocity: /);
    expect(error?.message).toMatch(/:vlocity_cmt/);
  });

  it("drains every page of a type query", async () => {
    let more = 0;
    const conn = {
      describeGlobal: async () => ({ sobjects: [{ name: "vlocity_cmt__DRBundle__c" }] }),
      query: async (soql: string) =>
        /FROM vlocity_cmt__DRBundle__c/i.test(soql) && !/IN \(/.test(soql)
          ? { records: [{ Id: "d1", Name: "DR1" }], done: false, nextRecordsUrl: "/q/dr-2" }
          : { records: [], done: true },
      queryMore: async () => {
        more += 1;
        return { records: [{ Id: "d2", Name: "DR2" }], done: true };
      },
    };
    const { names, error } = await drain(
      iterVlocityRecords(conn, caps, "00D1", undefined, NO_BACKOFF),
    );
    expect(error).toBeUndefined();
    expect(more).toBeGreaterThan(0);
    expect(names.join(",")).toMatch(/DR2/);
  });
});
