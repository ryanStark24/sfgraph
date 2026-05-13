import { asOrgId } from "@sfgraph/shared";
import { describe, expect, it, vi } from "vitest";
import { iterChanges } from "../source-member.js";

function row(
  memberType: string,
  memberName: string,
  isNameObsolete = false,
  lastModified = "2025-01-02T10:00:00Z",
) {
  return {
    Id: `${memberType}-${memberName}`,
    MemberType: memberType,
    MemberName: memberName,
    RevisionCounter: 1,
    IsNameObsolete: isNameObsolete,
    LastModifiedDate: lastModified,
  };
}

describe("iterChanges (SourceMember)", () => {
  it("issues a tooling SOQL filtered by sinceIso", async () => {
    const seen: string[] = [];
    const conn = {
      tooling: {
        query: async (soql: string) => {
          seen.push(soql);
          return { records: [row("ApexClass", "Foo")], done: true };
        },
      },
    };
    const out: string[] = [];
    for await (const r of iterChanges(conn as any, asOrgId("org_1"), "2025-01-01T00:00:00Z")) {
      out.push(r.memberType);
    }
    expect(out).toEqual(["ApexClass"]);
    expect(seen[0]).toContain("LastModifiedDate > 2025-01-01T00:00:00Z");
    expect(seen[0]).toContain("FROM SourceMember");
  });

  it("flags deletions with obsolete=true", async () => {
    const conn = {
      tooling: {
        query: async () => ({
          records: [row("ApexClass", "Gone", true)],
          done: true,
        }),
      },
    };
    const refs: any[] = [];
    for await (const r of iterChanges(conn as any, asOrgId("org_1"), "2025-01-01T00:00:00Z")) {
      refs.push(r);
    }
    expect(refs[0].obsolete).toBe(true);
    expect(refs[0].memberName).toBe("Gone");
  });

  it("paginates via nextRecordsUrl", async () => {
    const query = vi.fn(async () => ({
      records: [row("ApexClass", "A")],
      done: false,
      nextRecordsUrl: "/services/data/v60.0/query/page2",
    }));
    const queryMore = vi.fn(async () => ({
      records: [row("ApexClass", "B")],
      done: true,
    }));
    const conn = { tooling: { query, queryMore } };
    const names: string[] = [];
    for await (const r of iterChanges(conn as any, asOrgId("o"), "2025-01-01T00:00:00Z")) {
      names.push(r.memberName);
    }
    expect(names).toEqual(["A", "B"]);
    expect(queryMore).toHaveBeenCalledTimes(1);
  });

  it("formats since-timestamp literally (no quoting)", async () => {
    let captured = "";
    const conn = {
      tooling: {
        query: async (soql: string) => {
          captured = soql;
          return { records: [], done: true };
        },
      },
    };
    for await (const _r of iterChanges(conn as any, asOrgId("o"), "2025-06-15T12:34:56Z")) {
      // empty
    }
    expect(captured).toMatch(/LastModifiedDate > 2025-06-15T12:34:56Z/);
    expect(captured).not.toContain("'2025");
  });
});
