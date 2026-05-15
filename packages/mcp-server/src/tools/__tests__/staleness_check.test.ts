import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
});

afterEach(async () => {
  await fix.cleanup();
});

describe("staleness_check", () => {
  it("flags stale when last_synced_at is >7 days ago", async () => {
    const db = (
      fix.ctx.graphStore as unknown as {
        db: { prepare: (s: string) => { run: (...args: unknown[]) => void } };
      }
    ).db;
    db.prepare(
      "INSERT INTO _sfgraph_orgs(id, alias, instance_url, api_version, created_at, last_synced_at) VALUES (?,?,?,?,?,?)",
    ).run(fix.orgId, fix.orgId, "https://x", "60.0", 1, Date.now() - 1000 * 60 * 60 * 24 * 10);
    const r = await callTool("staleness_check", { org: fix.orgId });
    const d = r.data as { stale: boolean; ageDays: number | null };
    expect(d.stale).toBe(true);
    expect((d.ageDays ?? 0) >= 7).toBe(true);
    expect(r.summary).toContain("STALE");
  });

  it("returns fresh when last_synced_at is recent", async () => {
    const db = (
      fix.ctx.graphStore as unknown as {
        db: { prepare: (s: string) => { run: (...args: unknown[]) => void } };
      }
    ).db;
    db.prepare(
      "INSERT INTO _sfgraph_orgs(id, alias, instance_url, api_version, created_at, last_synced_at) VALUES (?,?,?,?,?,?)",
    ).run(fix.orgId, fix.orgId, "https://x", "60.0", 1, Date.now() - 1000 * 60 * 60 * 2);
    const r = await callTool("staleness_check", { org: fix.orgId });
    const d = r.data as { stale: boolean; ageDays: number | null };
    expect(d.stale).toBe(false);
    expect(r.summary).toContain("fresh");
  });

  it("treats missing org row as stale with null ageDays", async () => {
    const r = await callTool("staleness_check", { org: fix.orgId });
    const d = r.data as { stale: boolean; ageDays: number | null; recommendation: string };
    expect(d.stale).toBe(true);
    expect(d.ageDays).toBeNull();
    expect(d.recommendation).toContain("missing");
  });

  it("recommendation surfaces the exact sfgraph ingest command when stale", async () => {
    const r = await callTool("staleness_check", { org: "my-alias" });
    const d = r.data as { recommendation: string };
    expect(d.recommendation).toContain("sfgraph ingest --org my-alias");
  });

  it("rejects empty org", async () => {
    await expect(callTool("staleness_check", { org: "" })).rejects.toThrow();
  });

  it("ageDays uses singular vs plural correctly", async () => {
    const db = (
      fix.ctx.graphStore as unknown as {
        db: { prepare: (s: string) => { run: (...args: unknown[]) => void } };
      }
    ).db;
    db.prepare(
      "INSERT INTO _sfgraph_orgs(id, alias, instance_url, api_version, created_at, last_synced_at) VALUES (?,?,?,?,?,?)",
    ).run(fix.orgId, fix.orgId, "https://x", "60.0", 1, Date.now() - 1000 * 60 * 60 * 24);
    const r = await callTool("staleness_check", { org: fix.orgId });
    expect((r.data as { recommendation: string }).recommendation).toMatch(/1 day old/);
  });
});
