import { describe, expect, it } from "vitest";
import type { RawMember } from "../../../interfaces/metadata-source.js";
import { iterApex, iterOne } from "../apex.js";

/**
 * Qualified names are `ApexClass:<Name>` (COLLATE NOCASE, no namespace), so a
 * local class and a managed-package class with the same name collapse onto
 * one node, and whichever row is merged last wins. In a large live org the managed
 * stub (empty/hidden body) could overwrite the local class's body and
 * attributes. Rule: the local class (NamespacePrefix null) wins; the managed
 * collision is recorded on it as `shadowsManaged: ["<ns>"]`.
 *
 * `TestDataFactory` is only test input — the rule is name-agnostic.
 */

interface Row {
  Id: string;
  Name: string;
  Body: string;
  NamespacePrefix: string | null;
  ApiVersion?: number;
  Status?: string;
}

const LOCAL: Row = {
  Id: "01pLOCAL",
  Name: "TestDataFactory",
  Body: "public class TestDataFactory { public static Account acct() { return new Account(); } }",
  NamespacePrefix: null,
  ApiVersion: 60,
  Status: "Active",
};
const MANAGED: Row = {
  Id: "01pMANAGED",
  Name: "TestDataFactory",
  Body: "(hidden)",
  NamespacePrefix: "vlocity_cmt",
  ApiVersion: 45,
  Status: "Active",
};
const MANAGED_ONLY: Row = {
  Id: "01pMGDONLY",
  Name: "CpqAppHandler",
  Body: "(hidden)",
  NamespacePrefix: "vlocity_cmt",
  ApiVersion: 45,
  Status: "Active",
};
const LOCAL_ONLY: Row = {
  Id: "01pLOCONLY",
  Name: "AccountService",
  Body: "public class AccountService {}",
  NamespacePrefix: null,
  ApiVersion: 60,
  Status: "Active",
};

/** Tooling mock: the class drain pages through `rows` two at a time; any
 *  other ApexClass query (e.g. a Name/NamespacePrefix-only listing) gets the
 *  same rows projected; triggers are empty. */
function fakeConn(rows: Row[], o: { listingFails?: boolean; queryMoreFails?: boolean } = {}) {
  const pages: Row[][] = [];
  for (let i = 0; i < rows.length; i += 2) pages.push(rows.slice(i, i + 2));
  const page = (records: unknown[], i: number, key: string) => ({
    records,
    done: i >= pages.length - 1,
    ...(i < pages.length - 1 ? { nextRecordsUrl: `/q/${key}/${i + 1}` } : {}),
  });
  return {
    tooling: {
      query: async (soql: string) => {
        if (/FROM ApexTrigger/.test(soql)) return { records: [], done: true };
        if (/SELECT Id, Name, Body/.test(soql)) return page(pages[0] ?? [], 0, "body");
        if (o.listingFails) throw new Error("ETIMEDOUT listing");
        return {
          records: rows.map((r) => ({ Name: r.Name, NamespacePrefix: r.NamespacePrefix })),
          done: true,
        };
      },
      queryMore: async (url: string) => {
        if (o.queryMoreFails) throw new Error("ECONNRESET queryMore");
        const i = Number(url.split("/").pop());
        return page(pages[i] ?? [], i, "body");
      },
    },
  };
}

async function drain(it: AsyncIterable<RawMember>) {
  const members: RawMember[] = [];
  let error: Error | undefined;
  try {
    for await (const m of it) members.push(m);
  } catch (e) {
    error = e as Error;
  }
  return { members, error };
}

function classes(members: RawMember[]) {
  return members.filter((m) => m.ref.memberType === "ApexClass");
}

describe("iterApex — a local class wins over a managed class with the same name", () => {
  for (const [label, rows] of [
    ["managed row first", [MANAGED, MANAGED_ONLY, LOCAL, LOCAL_ONLY]],
    ["local row first", [LOCAL, LOCAL_ONLY, MANAGED, MANAGED_ONLY]],
  ] as const) {
    it(`emits only the local class and records the managed collision (${label})`, async () => {
      const { members, error } = await drain(iterApex(fakeConn([...rows]), { retryBackoffMs: 0 }));
      expect(error).toBeUndefined();
      const tdf = classes(members).filter(
        (m) => m.ref.memberName.toLowerCase() === "testdatafactory",
      );
      expect(tdf).toHaveLength(1);
      const only = tdf[0] as RawMember;
      expect(only.ref.namespace).toBeNull();
      const content = JSON.parse(only.content) as {
        body: string;
        metaXml?: string;
        managed?: boolean;
      };
      expect(content.body).toBe(LOCAL.Body);
      expect(content.managed).toBeUndefined();
      expect(content.metaXml).toContain("<apiVersion>60</apiVersion>");
      expect(content.metaXml).toContain("<shadowsManaged>vlocity_cmt</shadowsManaged>");
      // Non-colliding classes are untouched.
      const names = classes(members)
        .map((m) => m.ref.memberName)
        .sort();
      expect(names).toEqual(["AccountService", "CpqAppHandler", "TestDataFactory"]);
      const svc = classes(members).find((m) => m.ref.memberName === "AccountService") as RawMember;
      expect(JSON.parse(svc.content).metaXml).not.toContain("shadowsManaged");
    });
  }

  it("matches names case-insensitively, like the qname", async () => {
    const lower = { ...MANAGED, Name: "testDataFactory" };
    const { members } = await drain(iterApex(fakeConn([lower, LOCAL]), { retryBackoffMs: 0 }));
    expect(classes(members).map((m) => m.ref.namespace)).toEqual([null]);
  });

  it("still never emits the managed stub when the name listing fails, and surfaces the failure", async () => {
    const { members, error } = await drain(
      iterApex(fakeConn([MANAGED, LOCAL, MANAGED_ONLY], { listingFails: true }), {
        retryBackoffMs: 0,
      }),
    );
    const tdf = classes(members).filter((m) => m.ref.memberName === "TestDataFactory");
    expect(tdf.map((m) => m.ref.namespace)).toEqual([null]);
    expect(classes(members).map((m) => m.ref.memberName)).toContain("CpqAppHandler");
    expect(error?.message).toMatch(/ETIMEDOUT listing/);
  });
});

describe("iterApex — listing failed AND the body drain truncated (review M1)", () => {
  it("does not emit a held managed stub whose local twin may be on a lost page", async () => {
    // Page 1 = [MANAGED, MANAGED_ONLY]; page 2 (LOCAL, LOCAL_ONLY) is lost.
    const { members, error } = await drain(
      iterApex(
        fakeConn([MANAGED, MANAGED_ONLY, LOCAL, LOCAL_ONLY], {
          listingFails: true,
          queryMoreFails: true,
        }),
        { retryBackoffMs: 0, retries: 0 },
      ),
    );
    expect(classes(members).map((m) => m.ref.memberName)).not.toContain("TestDataFactory");
    expect(error?.message).toMatch(/ETIMEDOUT listing/);
    expect(error?.message).toMatch(/ECONNRESET queryMore|truncated/);
  });
});

describe("iterOne — prefers the local class", () => {
  it("orders the lookup so a local class beats a managed one with the same name", async () => {
    const seen: string[] = [];
    const conn = {
      tooling: {
        query: async (soql: string) => {
          seen.push(soql);
          const nullsFirst = /ORDER BY NamespacePrefix NULLS FIRST/i.test(soql);
          return { records: nullsFirst ? [LOCAL, MANAGED] : [MANAGED, LOCAL], done: true };
        },
      },
    };
    const m = await iterOne(conn, "TestDataFactory");
    expect(m?.ref.namespace).toBeNull();
    // Same envelope as iterApex (review M2): body + metaXml + shadowsManaged.
    const content = JSON.parse(m?.content ?? "{}") as { body: string; metaXml?: string };
    expect(content.body).toBe(LOCAL.Body);
    expect(content.metaXml).toContain("<apiVersion>60</apiVersion>");
    expect(content.metaXml).toContain("<shadowsManaged>vlocity_cmt</shadowsManaged>");
  });

  it("produces exactly the content iterApex produces for the same class", async () => {
    const bulk = classes(
      (await drain(iterApex(fakeConn([MANAGED, LOCAL]), { retryBackoffMs: 0 }))).members,
    ).find((m) => m.ref.memberName === "TestDataFactory");
    const conn = {
      tooling: { query: async () => ({ records: [LOCAL, MANAGED], done: true }) },
    };
    const one = await iterOne(conn, "TestDataFactory");
    expect(one?.content).toBe(bulk?.content);
  });

  it("stubs a managed-only class body exactly like iterApex", async () => {
    const conn = {
      tooling: {
        query: async (soql: string) =>
          /FROM ApexClass/.test(soql)
            ? { records: [MANAGED_ONLY], done: true }
            : { records: [], done: true },
      },
    };
    const one = await iterOne(conn, "CpqAppHandler");
    const content = JSON.parse(one?.content ?? "{}") as { body: string; managed?: boolean };
    expect(content.body).toBe("");
    expect(content.managed).toBe(true);
  });
});
