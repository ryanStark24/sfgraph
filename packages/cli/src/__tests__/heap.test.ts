import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_HEAP_GROWING_PERCENT, applyHeapGrowth } from "../heap.js";
import { run } from "../index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");

function rec() {
  const calls: string[] = [];
  return { calls, set: (f: string) => void calls.push(f) };
}

describe("applyHeapGrowth (cycle 2 T2)", () => {
  it("sets --heap-growing-percent=30 by default", () => {
    const r = rec();
    expect(applyHeapGrowth({}, [], r.set)).toBe(30);
    expect(DEFAULT_HEAP_GROWING_PERCENT).toBe(30);
    expect(r.calls).toEqual(["--heap-growing-percent=30"]);
  });

  it("honours SFGRAPH_HEAP_GROWING_PERCENT; 0 leaves V8's default", () => {
    const r = rec();
    expect(applyHeapGrowth({ SFGRAPH_HEAP_GROWING_PERCENT: "75" }, [], r.set)).toBe(75);
    expect(applyHeapGrowth({ SFGRAPH_HEAP_GROWING_PERCENT: "0" }, [], r.set)).toBeNull();
    expect(r.calls).toEqual(["--heap-growing-percent=75"]);
  });

  it("falls back to the default for a value that is not 1-1000", () => {
    for (const v of ["abc", "-5", "2.5", "5000"]) {
      const r = rec();
      expect(applyHeapGrowth({ SFGRAPH_HEAP_GROWING_PERCENT: v }, [], r.set), v).toBe(30);
    }
  });

  it("keeps a --heap-growing-percent given on the node command line", () => {
    const r = rec();
    expect(applyHeapGrowth({}, ["--heap-growing-percent=80"], r.set)).toBeNull();
    expect(applyHeapGrowth({}, ["--heap_growing_percent=80"], r.set)).toBeNull();
    expect(r.calls).toEqual([]);
  });

  it("keeps a --heap-growing-percent given in NODE_OPTIONS", () => {
    const r = rec();
    for (const no of [
      "--heap-growing-percent=80",
      "--max-old-space-size=4096 --heap_growing_percent=80",
      "  --import x.mjs   --heap-growing-percent 80",
    ]) {
      expect(applyHeapGrowth({ NODE_OPTIONS: no }, [], r.set), no).toBeNull();
    }
    // Other NODE_OPTIONS do not suppress it.
    expect(applyHeapGrowth({ NODE_OPTIONS: "--max-old-space-size=4096" }, [], r.set)).toBe(30);
    expect(r.calls).toEqual(["--heap-growing-percent=30"]);
  });

  it("by default calls v8.setFlagsFromString with the flag (child process)", () => {
    // In a child so no V8 flag is set in the vitest worker. The child wraps
    // v8.setFlagsFromString (the default seam) and reports what it received.
    const heapTs = path.join(here, "..", "heap.ts");
    const script = `
      import v8 from "node:v8";
      const seen = [];
      const orig = v8.setFlagsFromString;
      v8.setFlagsFromString = (f) => { seen.push(f); orig(f); };
      const { applyHeapGrowth } = await import(${JSON.stringify(heapTs)});
      const pct = applyHeapGrowth();
      process.stdout.write(JSON.stringify({ pct, seen }));`;
    const env: NodeJS.ProcessEnv = { ...process.env, SFGRAPH_HEAP_GROWING_PERCENT: "40" };
    delete env.NODE_OPTIONS;
    const r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
      { env, encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ pct: 40, seen: ["--heap-growing-percent=40"] });
  }, 20_000);
});

describe("entry points go through run(), which applies the heap setting first", () => {
  it("run() applies heap growth before parsing the command line", async () => {
    const order: string[] = [];
    await run(["node", "sfgraph", "x"], {
      applyHeapGrowth: () => {
        order.push("heap");
        return 30;
      },
      buildProgram: () => ({
        parseAsync: async (argv: string[]) => {
          order.push(`parse:${argv[2]}`);
        },
      }),
    });
    expect(order).toEqual(["heap", "parse:x"]);
  });

  it("the only shipped bin is apps/sfgraph/bin/sfgraph.mjs, and it calls the CLI's run()", () => {
    const bins: string[] = [];
    for (const top of ["apps", "packages"]) {
      for (const d of readdirSync(path.join(repo, top))) {
        let pkg: { bin?: string | Record<string, string> };
        try {
          pkg = JSON.parse(readFileSync(path.join(repo, top, d, "package.json"), "utf8"));
        } catch {
          continue;
        }
        if (!pkg.bin) continue;
        const entries = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin);
        for (const b of entries) bins.push(path.join(top, d, b));
      }
    }
    expect(bins).toEqual([path.join("apps", "sfgraph", "bin", "sfgraph.mjs")]);
    const src = readFileSync(path.join(repo, "apps/sfgraph/bin/sfgraph.mjs"), "utf8");
    expect(src).toMatch(/const \{ run \} = await import\("@ryanstark24\/sfgraph-cli"\)/);
    expect(src).toMatch(/\brun\(argv\)/);
  });
});
