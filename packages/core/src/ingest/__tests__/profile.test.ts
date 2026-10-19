import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createIngestProfiler } from "../profile.js";

describe("ingest profiler", () => {
  it("is a no-op without the env var", () => {
    const p = createIngestProfiler({});
    expect(p.enabled).toBe(false);
    p.member({ qname: "ApexClass:A", label: "ApexClass", bytes: 10, parseMs: 1, writeMs: 2 });
    p.close();
  });
  it("writes member and phase JSONL", () => {
    const f = path.join(mkdtempSync(path.join(tmpdir(), "prof-")), "p.jsonl");
    const p = createIngestProfiler({ SFGRAPH_INGEST_PROFILE: f });
    expect(p.enabled).toBe(true);
    p.member({ qname: "ApexClass:A", label: "ApexClass", bytes: 10, parseMs: 1, writeMs: 2 });
    p.phase("resolver:arity", 5);
    p.close();
    const lines = readFileSync(f, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { t: "member", qname: "ApexClass:A", label: "ApexClass", bytes: 10, parseMs: 1, writeMs: 2 },
      { t: "phase", name: "resolver:arity", ms: 5 },
    ]);
  });
});
