import { describe, expect, it } from "vitest";
import { INDUSTRIES_STANDARD_SOBJECTS } from "../../../../domain/index.js";
import type { RawMember } from "../../../interfaces/metadata-source.js";
import { IncompleteSourceError } from "../../retry.js";
import { formatObjectGateSummary, iterObject, makeSObjectClassifier } from "../object.js";

function sobj(name: string, queryable = true) {
  return { name, label: name, custom: name.includes("__"), queryable, deprecatedAndHidden: false };
}

const edRelevant = (names: string[], flags = true) => ({
  relevant: new Set(flags ? names : []),
  unclassified: 0,
});

describe("makeSObjectClassifier", () => {
  const classify = makeSObjectClassifier(edRelevant(["Account", "ns__A__c"]));

  it("keeps big objects (__b)", () => {
    expect(classify(sobj("Archive__b"))).toBeNull();
  });

  it("keeps custom change events but still drops standard ones and History/Share/Feed/Tag", () => {
    expect(classify(sobj("Foo__ChangeEvent", false))).toBeNull();
    expect(classify(sobj("AccountChangeEvent", false))).toBe("nonQueryable");
    expect(classify(sobj("AccountChangeEvent"))).toBe("companion");
    for (const n of ["AccountHistory", "AccountShare", "AccountFeed", "AccountTag"]) {
      expect(classify(sobj(n))).toBe("companion");
    }
  });

  it("keeps Data Cloud objects even when non-queryable and absent from EntityDefinition", () => {
    for (const n of ["Individual__dlm", "ssot__Individual__dlm", "Raw__dll", "Score__cio"]) {
      expect(classify(sobj(n, false))).toBeNull();
    }
  });

  it("still gates namespaced custom objects through EntityDefinition", () => {
    expect(classify(sobj("ns__A__c"))).toBeNull();
    expect(classify(sobj("ns__Hidden__c"))).toBe("namespacedEntityDef");
  });

  it("keeps listed Industries objects when EntityDefinition flags are false", () => {
    const noFlags = makeSObjectClassifier(edRelevant(["Account"]));
    expect(noFlags(sobj("FinancialAccount"))).toBeNull();
    expect(noFlags(sobj("InsurancePolicy"))).toBeNull();
    expect(noFlags(sobj("SomeInternalThing"))).toBe("standardEntityDef");
  });

  it("keeps listed Industries objects when the EntityDefinition probe failed", () => {
    const failed = makeSObjectClassifier(null);
    expect(failed(sobj("ProductSellingModel"))).toBeNull();
    expect(failed(sobj("SomeInternalThing"))).toBe("standardFallback");
  });

  it("does not resurrect a non-queryable Industries name", () => {
    expect(classify(sobj("FinancialGoal", false))).toBe("nonQueryable");
  });

  it("exports a sizable Industries allow-list", () => {
    expect(INDUSTRIES_STANDARD_SOBJECTS.size).toBeGreaterThanOrEqual(35);
    expect(INDUSTRIES_STANDARD_SOBJECTS.has("FinancialAccount")).toBe(true);
  });
});

describe("formatObjectGateSummary", () => {
  it("is null when nothing was excluded and one line otherwise", () => {
    const zero = {
      invalid: 0,
      deprecated: 0,
      nonQueryable: 0,
      companion: 0,
      system: 0,
      namespacedEntityDef: 0,
      standardEntityDef: 0,
      standardFallback: 0,
    };
    expect(formatObjectGateSummary(zero, 5)).toBeNull();
    const line = formatObjectGateSummary({ ...zero, companion: 3, standardEntityDef: 2 }, 5);
    expect(line).toContain("excluded 5 of 10");
    expect(line).toContain("companion=3");
    expect(line).not.toContain("\n");
  });
});

describe("iterObject — gates end to end", () => {
  function fakeConn(
    sobjects: ReturnType<typeof sobj>[],
    opts: { edFails?: boolean; describeFails?: string[] },
  ) {
    const describes: string[] = [];
    return {
      describes,
      tooling: {
        query: async () => {
          if (opts.edFails) throw new Error("socket hang up");
          const rows = sobjects
            .filter((s) => s.name === "Account")
            .map((s) => ({
              QualifiedApiName: s.name,
              IsCustomizable: true,
              IsApexTriggerable: true,
              IsDeprecatedAndHidden: false,
              IsCustomSetting: false,
            }));
          return { records: rows, done: true, totalSize: sobjects.length };
        },
        queryMore: async () => {
          throw new Error("no queryMore");
        },
      },
      describeGlobal: async () => ({ sobjects }),
      sobject: (name: string) => ({
        describe: async () => {
          describes.push(name);
          if (opts.describeFails?.includes(name))
            throw new Error(`describe timeout (12000ms): ${name}`);
          return { name, label: name, fields: [{ name: "Id", type: "id" }] };
        },
      }),
    };
  }

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

  it("describes only listed names, reports one gate summary, and records a failed DMO describe as a skip", async () => {
    const conn = fakeConn(
      [
        sobj("Account"),
        sobj("AccountHistory"),
        sobj("SomeInternalThing"),
        sobj("FinancialAccount"),
        sobj("Archive__b"),
        sobj("Foo__ChangeEvent", false),
        sobj("Individual__dlm", false),
      ],
      { describeFails: ["Individual__dlm"] },
    );
    const summaries: string[] = [];
    const { names, error } = await drain(
      iterObject(conn, { retryBackoffMs: 0 }, (l) => summaries.push(l)),
    );
    expect(names.sort()).toEqual(["Account", "Archive__b", "FinancialAccount", "Foo__ChangeEvent"]);
    expect(error).toBeInstanceOf(IncompleteSourceError);
    expect((error as IncompleteSourceError).failures.map((f) => f.name)).toEqual([
      "Individual__dlm",
    ]);
    // The unlisted Industries names (e.g. InsurancePolicy) were never described.
    expect(conn.describes).not.toContain("InsurancePolicy");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("companion=1");
    expect(summaries[0]).toContain("standard-by-EntityDefinition=");
  });

  it("keeps Industries objects when the EntityDefinition probe fails", async () => {
    const conn = fakeConn([sobj("FinancialAccount"), sobj("SomeInternalThing")], { edFails: true });
    const { names, error } = await drain(iterObject(conn, { retryBackoffMs: 0 }));
    expect(names).toEqual(["FinancialAccount"]);
    // The probe failure itself is still reported as an incomplete source.
    expect(error).toBeInstanceOf(IncompleteSourceError);
  });
});
