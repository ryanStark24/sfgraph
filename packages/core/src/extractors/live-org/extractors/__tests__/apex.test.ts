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
    const conn = { tooling: { query, queryMore } };

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
    const conn = { tooling: { query, queryMore: vi.fn() } };

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
    const conn = { tooling: { query, queryMore: vi.fn() } };

    const out: { name: string; body: string }[] = [];
    for await (const m of iterApex(conn as any))
      out.push({ name: m.ref.memberName, body: bodyOf(m.content) });

    expect(out.find((o) => o.name === "Plain")?.body).toContain("public class Plain");
  });
});
