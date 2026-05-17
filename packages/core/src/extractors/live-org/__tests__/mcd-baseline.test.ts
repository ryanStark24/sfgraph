import { beforeEach, describe, expect, it } from "vitest";
import { makeTestCtx } from "../../../parsers/__tests__/_harness.js";
import { limiter } from "../rate-limit.js";
import { MCD_LONG_TAIL_TYPES, runMcdBaseline } from "../extractors/mcd-baseline.js";

interface McdRow {
  Id: string;
  MetadataComponentId: string;
  MetadataComponentType: string;
  MetadataComponentName: string;
  MetadataComponentNamespace: string | null;
  RefMetadataComponentId: string;
  RefMetadataComponentType: string;
  RefMetadataComponentName: string;
  RefMetadataComponentNamespace: string | null;
}

function row(overrides: Partial<McdRow>): McdRow {
  return {
    Id: overrides.Id ?? "01q000",
    MetadataComponentId: overrides.MetadataComponentId ?? "00h000",
    MetadataComponentType: overrides.MetadataComponentType ?? "Layout",
    MetadataComponentName: overrides.MetadataComponentName ?? "Account-Account Layout",
    MetadataComponentNamespace: overrides.MetadataComponentNamespace ?? null,
    RefMetadataComponentId: overrides.RefMetadataComponentId ?? "00N000",
    RefMetadataComponentType: overrides.RefMetadataComponentType ?? "CustomField",
    RefMetadataComponentName: overrides.RefMetadataComponentName ?? "Account.Phone",
    RefMetadataComponentNamespace: overrides.RefMetadataComponentNamespace ?? null,
  };
}

function connWithRows(rowsByPredicate: Map<string, McdRow[]>) {
  const queries: string[] = [];
  return {
    queries,
    conn: {
      tooling: {
        query: async (soql: string) => {
          queries.push(soql);
          // Pick the right row set based on the WHERE clause prefix
          // ("MetadataComponentType = 'X'" or "RefMetadataComponentType = 'X'").
          for (const [predicate, rows] of rowsByPredicate.entries()) {
            if (soql.includes(predicate)) return { records: [...rows] };
          }
          return { records: [] };
        },
      },
    },
  };
}

describe("W2-03: MCD baseline extractor", () => {
  beforeEach(async () => {
    await limiter.incrementReservoir(10_000);
  });

  it("emits REFERENCES edges with source='mcd' for the long-tail set", async () => {
    const rows = new Map<string, McdRow[]>([
      [
        "MetadataComponentType = 'Layout'",
        [row({ Id: "1", MetadataComponentName: "Account-Layout", RefMetadataComponentName: "Account.Phone" })],
      ],
    ]);
    const { conn } = connWithRows(rows);
    const result = await runMcdBaseline(conn, {
      orgId: "00Dxx0000000001",
      ctx: makeTestCtx(),
      types: ["Layout"],
    });

    expect(result.edges.length).toBe(1);
    const e = result.edges[0];
    expect(e?.relType).toBe("REFERENCES");
    expect(e?.attributes.source).toBe("mcd");
    expect(String(e?.srcQualifiedName)).toBe("Layout:Account-Layout");
    expect(String(e?.dstQualifiedName)).toBe("CustomField:Account.Phone");
    expect(result.byType.Layout?.asSource).toBe(1);
  });

  it("paginates via Id > lastId when the first page hits the LIMIT cap", async () => {
    // Two pages: first page 2 rows (LIMIT=2), second page 1 row.
    let callIdx = 0;
    const conn = {
      tooling: {
        query: async (soql: string) => {
          callIdx += 1;
          if (callIdx === 1) {
            // First page — returns LIMIT rows so paginator continues.
            return {
              records: [
                row({ Id: "01q001" }),
                row({ Id: "01q002" }),
              ],
            };
          }
          if (callIdx === 2) {
            // Second page — should filter by Id > '01q002'
            expect(soql).toContain("Id > '01q002'");
            return { records: [row({ Id: "01q003" })] };
          }
          // Third page (would only happen if we accidentally kept going)
          return { records: [] };
        },
      },
    };
    const result = await runMcdBaseline(conn, {
      orgId: "00Dxx0000000001",
      ctx: makeTestCtx(),
      types: ["Layout"],
      pageSize: 2,
    });
    expect(result.byType.Layout?.asSource).toBe(3);
    expect(result.byType.Layout?.asTarget).toBe(0);
  });

  it("dedupes edges that surface in both query directions", async () => {
    // Edge: Layout:A → Group:B. Should appear once even though it surfaces
    // in both `MetadataComponentType = 'Layout'` and
    // `RefMetadataComponentType = 'Group'` queries.
    const sharedRow = row({
      Id: "01q001",
      MetadataComponentType: "Layout",
      MetadataComponentName: "A",
      RefMetadataComponentType: "Group",
      RefMetadataComponentName: "B",
    });
    const conn = {
      tooling: {
        query: async (soql: string) => {
          if (soql.includes("MetadataComponentType = 'Layout'")) return { records: [sharedRow] };
          if (soql.includes("RefMetadataComponentType = 'Group'")) return { records: [sharedRow] };
          return { records: [] };
        },
      },
    };
    const result = await runMcdBaseline(conn, {
      orgId: "00Dxx0000000001",
      ctx: makeTestCtx(),
      types: ["Layout", "Group"],
    });
    const layoutToGroup = result.edges.filter(
      (e) =>
        String(e.srcQualifiedName) === "Layout:A" && String(e.dstQualifiedName) === "Group:B",
    );
    expect(layoutToGroup.length).toBe(1);
  });

  it("flags dynamic references when MCD's Id and Name match (isDynamicReference heuristic)", async () => {
    const dynamicRow = row({
      Id: "01q001",
      MetadataComponentId: "00hABC",
      MetadataComponentName: "00hABC", // Id == Name → dynamic
      RefMetadataComponentName: "Account.Phone",
    });
    const conn = connWithRows(
      new Map([["MetadataComponentType = 'Layout'", [dynamicRow]]]),
    );
    const result = await runMcdBaseline(conn.conn, {
      orgId: "00Dxx0000000001",
      ctx: makeTestCtx(),
      types: ["Layout"],
    });
    expect(result.edges[0]?.attributes.dynamic).toBe(true);
  });

  it("surfaces per-type failures via onError instead of swallowing", async () => {
    const errors: Array<{ label: string; message: string }> = [];
    const conn = {
      tooling: {
        query: async (soql: string) => {
          if (soql.includes("MetadataComponentType = 'Layout'")) {
            throw new Error("INSUFFICIENT_ACCESS_OR_READONLY: simulated");
          }
          return { records: [] };
        },
      },
    };
    await runMcdBaseline(conn, {
      orgId: "00Dxx0000000001",
      ctx: makeTestCtx(),
      types: ["Layout"],
      onError: (label, err) => errors.push({ label, message: err.message }),
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.label).toContain("Layout");
    expect(errors[0]?.message).toContain("INSUFFICIENT_ACCESS");
  });

  it("MCD_LONG_TAIL_TYPES covers the documented set", () => {
    expect(MCD_LONG_TAIL_TYPES).toContain("Layout");
    expect(MCD_LONG_TAIL_TYPES).toContain("FieldSet");
    expect(MCD_LONG_TAIL_TYPES).toContain("EmailTemplate");
    expect(MCD_LONG_TAIL_TYPES).toContain("CustomTab");
    expect(MCD_LONG_TAIL_TYPES).toContain("Group");
    expect(MCD_LONG_TAIL_TYPES).toContain("Queue");
  });
});
