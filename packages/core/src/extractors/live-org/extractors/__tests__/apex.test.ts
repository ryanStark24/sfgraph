import { describe, expect, it, vi } from "vitest";
import { iterApex } from "../apex.js";

function classRow(name: string, namespacePrefix: string | null = null) {
  return {
    Id: `c-${name}`,
    Name: name,
    Body: `public class ${name} {}`,
    NamespacePrefix: namespacePrefix,
    LastModifiedDate: "2025-01-01T00:00:00Z",
    ApiVersion: 60,
    Status: "Active",
  };
}

/** iterApex first lists `SELECT Name, NamespacePrefix FROM ApexClass` to find
 *  local/managed name collisions; answer that with no rows so the sequential
 *  mocks below only see the body drains. */
function skipNameListing(query: (soql: string) => Promise<unknown>) {
  return (soql: string) =>
    soql.startsWith("SELECT Name, NamespacePrefix FROM ApexClass")
      ? Promise.resolve({ records: [], done: true })
      : query(soql);
}

/** Parse the JSON content envelope iterApex emits. */
function bodyOf(content: string): string {
  return JSON.parse(content).body as string;
}

describe("iterApex", () => {
  it("paginates ApexClass/ApexTrigger via queryMore (does not stop at the first page)", async () => {
    // First call -> ApexClass page1 (more), second -> ApexTrigger page1 (more),
    // then queryMore drains each. Use done/nextRecordsUrl to drive pagination.
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        records: [classRow("ClassA")],
        done: false,
        nextRecordsUrl: "/q/classes/2",
      })
      .mockResolvedValueOnce({
        records: [classRow("TrigA")],
        done: false,
        nextRecordsUrl: "/q/triggers/2",
      });
    const queryMore = vi
      .fn()
      .mockResolvedValueOnce({ records: [classRow("ClassB")], done: true })
      .mockResolvedValueOnce({ records: [classRow("TrigB")], done: true });
    const conn = { tooling: { query: skipNameListing(query), queryMore } };

    const names: string[] = [];
    for await (const m of iterApex(conn as any)) names.push(m.ref.memberName);

    // Both pages of both queries must be present — the second page proves
    // pagination (the original bug stopped after page 1 -> only ClassA/TrigA).
    expect(names).toContain("ClassB");
    expect(names).toContain("TrigB");
    expect(queryMore).toHaveBeenCalledTimes(2);
  });

  it("stubs managed-package bodies to empty but still emits the member", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ records: [classRow("Mgd", "vlocity_cmt")], done: true })
      .mockResolvedValueOnce({ records: [], done: true });
    const conn = { tooling: { query: skipNameListing(query), queryMore: vi.fn() } };

    const out: { name: string; body: string }[] = [];
    for await (const m of iterApex(conn as any))
      out.push({ name: m.ref.memberName, body: bodyOf(m.content) });

    const mgd = out.find((o) => o.name === "Mgd");
    expect(mgd).toBeDefined();
    expect(mgd?.body).toBe("");
  });

  it("keeps unmanaged bodies", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ records: [classRow("Plain")], done: true })
      .mockResolvedValueOnce({ records: [], done: true });
    const conn = { tooling: { query: skipNameListing(query), queryMore: vi.fn() } };

    const out: { name: string; body: string }[] = [];
    for await (const m of iterApex(conn as any))
      out.push({ name: m.ref.memberName, body: bodyOf(m.content) });

    expect(out.find((o) => o.name === "Plain")?.body).toContain("public class Plain");
  });
});

/**
 * Live-ingest regression (large live org, commit 7249072): the ApexClass drain
 * stopped after 18 pages (3,600 of 7,662 rows, ordered by Id) when a
 * `queryMore` call failed mid-stream during a connection blip. The
 * per-stream `catch {}` in iterApex swallowed the error, so the source
 * still reported "apex ✓" and the run reported skips=0 — 1,493 of the
 * 1,738 local classes were silently missing from the graph.
 */
describe("iterApex — mid-pagination queryMore failure", () => {
  const PAGE = 200;
  const TOTAL = 7662;
  const allClasses = Array.from({ length: TOTAL }, (_, i) =>
    classRow(`Cls${String(i).padStart(5, "0")}`, i < 5000 ? "vlocity_cmt" : null),
  );
  const pageOf = (i: number) => ({
    records: allClasses.slice(i * PAGE, (i + 1) * PAGE),
    done: (i + 1) * PAGE >= TOTAL,
    ...((i + 1) * PAGE < TOTAL ? { nextRecordsUrl: `/q/classes/${i + 1}` } : {}),
  });

  /** Fake Tooling connection: 200-row ApexClass pages; `failClassPage(n,
   *  attempt)` decides whether queryMore for page n rejects. */
  function fakeConn(failClassPage: (page: number, attempt: number) => boolean) {
    const attempts = new Map<number, number>();
    const query = vi.fn(async (soql: string) =>
      soql.includes("FROM ApexTrigger")
        ? { records: [classRow("TrigOnly")], done: true }
        : pageOf(0),
    );
    const queryMore = vi.fn(async (url: string) => {
      const page = Number(url.split("/").pop());
      const attempt = (attempts.get(page) ?? 0) + 1;
      attempts.set(page, attempt);
      if (failClassPage(page, attempt)) {
        throw new Error("soql tooling ApexClass more timed out after 60000ms");
      }
      return pageOf(page);
    });
    return { tooling: { query: skipNameListing(query), queryMore } };
  }

  it("retries a transiently failing queryMore and drains every page", async () => {
    const conn = fakeConn((page, attempt) => page === 18 && attempt === 1);
    const classes: string[] = [];
    const triggers: string[] = [];
    for await (const m of iterApex(conn as any, { retryBackoffMs: 0 })) {
      (m.ref.memberType === "ApexClass" ? classes : triggers).push(m.ref.memberName);
    }
    expect(classes).toHaveLength(TOTAL);
    expect(new Set(classes).size).toBe(TOTAL);
    expect(classes).toContain("Cls07661");
    expect(triggers).toEqual(["TrigOnly"]);
  });

  it("surfaces a persistent failure (no silent truncation) after still draining triggers", async () => {
    const conn = fakeConn((page) => page === 18);
    const classes: string[] = [];
    const triggers: string[] = [];
    let thrown: Error | undefined;
    try {
      for await (const m of iterApex(conn as any, { retryBackoffMs: 0 })) {
        (m.ref.memberType === "ApexClass" ? classes : triggers).push(m.ref.memberName);
      }
    } catch (e) {
      thrown = e as Error;
    }
    // Rows already fetched are kept, the independent trigger stream still runs…
    expect(classes).toHaveLength(18 * PAGE);
    expect(triggers).toEqual(["TrigOnly"]);
    // …but the truncation must propagate so failSoft records an `apex` skip
    // (and --retry-skipped can re-run it) instead of logging "apex ✓".
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toMatch(/ApexClass/);
    expect(thrown?.message).toMatch(/3600/);
    expect(thrown?.message).toMatch(/timed out/);
  });
});
