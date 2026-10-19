import { describe, expect, it } from "vitest";
import type { RawMember } from "../../../interfaces/metadata-source.js";
import { SECURITY_READ_BATCH, iterSecurity } from "../security.js";

/**
 * Cycle 2 T2: Profiles are read one per metadata.read call (each is about
 * 2.9 MB of XML on a large live org); the other security types keep 10 per call.
 */
function recordingConn(lists: Record<string, string[]>) {
  const calls: { type: string; names: string[] }[] = [];
  return {
    calls,
    conn: {
      metadata: {
        list: async ([{ type }]: [{ type: string }]) =>
          (lists[type] ?? []).map((fullName) => ({ fullName, type })),
        read: async (type: string, names: string[]) => {
          calls.push({ type, names: [...names] });
          const recs = names.map((fullName) => ({ fullName, custom: "false", note: type }));
          // jsforce returns a bare record for a one-name read.
          return recs.length === 1 ? recs[0] : recs;
        },
      },
    },
  };
}

async function drain(it: AsyncIterable<RawMember>): Promise<RawMember[]> {
  const out: RawMember[] = [];
  for await (const m of it) out.push(m);
  return out;
}

describe("security read batch sizes", () => {
  it("reads each Profile on its own and PermissionSets 10 per call", async () => {
    const profiles = Array.from({ length: 7 }, (_, i) => `P${i}`);
    const permsets = Array.from({ length: 23 }, (_, i) => `PS${i}`);
    const { conn, calls } = recordingConn({
      Profile: profiles,
      PermissionSet: permsets,
      SharingRules: ["Account"],
    });
    const out = await drain(iterSecurity(conn, { retryBackoffMs: 0 }));

    expect(SECURITY_READ_BATCH.Profile).toBe(1);
    const sizes = (t: string) => calls.filter((c) => c.type === t).map((c) => c.names.length);
    expect(sizes("Profile")).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(sizes("PermissionSet").sort((a, b) => a - b)).toEqual([3, 10, 10]);
    expect(sizes("SharingRules")).toEqual([1]);

    // Every member yields once, with the content a batched read would give.
    const byName = new Map(out.map((m) => [`${m.ref.memberType}:${m.ref.memberName}`, m]));
    expect(byName.size).toBe(7 + 23 + 1);
    expect(byName.get("Profile:P3")?.content).toBe(
      "<Profile><fullName>P3</fullName><custom>false</custom><note>Profile</note></Profile>",
    );
    expect(byName.get("PermissionSet:PS12")?.content).toBe(
      "<PermissionSet><fullName>PS12</fullName><custom>false</custom><note>PermissionSet</note></PermissionSet>",
    );
  });
});
