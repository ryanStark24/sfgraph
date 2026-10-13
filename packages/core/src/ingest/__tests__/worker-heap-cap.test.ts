import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { createHeapCappedWorker, startupMaxOldSpaceMb } from "../../util/worker-heap-cap.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

describe("startupMaxOldSpaceMb", () => {
  it("reads the flag from NODE_OPTIONS and execArgv; the command line wins", () => {
    expect(startupMaxOldSpaceMb([], "")).toBeNull();
    expect(startupMaxOldSpaceMb([], "--max-old-space-size=8192")).toBe(8192);
    expect(startupMaxOldSpaceMb([], "--inspect --max_old_space_size=4096")).toBe(4096);
    expect(startupMaxOldSpaceMb(["--max-old-space-size", "2048"], "")).toBe(2048);
    expect(startupMaxOldSpaceMb(["--max-old-space-size=3000"], "--max-old-space-size=8192")).toBe(
      3000,
    );
    expect(startupMaxOldSpaceMb([], "--max-semi-space-size=64")).toBeNull();
  });
});

describe("createHeapCappedWorker", () => {
  const fakeWorker = (): Worker => new EventEmitter() as unknown as Worker;

  it("is a plain create() without the flag", () => {
    const flags: string[] = [];
    createHeapCappedWorker(fakeWorker, null, (f) => flags.push(f));
    expect(flags).toEqual([]);
  });

  it("clears the flag while workers start and restores it once all are online or gone", () => {
    const flags: string[] = [];
    const set = (f: string) => void flags.push(f);
    const a = createHeapCappedWorker(fakeWorker, 8192, set);
    const b = createHeapCappedWorker(fakeWorker, 8192, set);
    expect(flags).toEqual(["--max-old-space-size=0"]);
    a.emit("online");
    a.emit("exit", 0); // settles once
    expect(flags).toHaveLength(1);
    b.emit("error", new Error("boom"));
    expect(flags).toEqual(["--max-old-space-size=0", "--max-old-space-size=8192"]);
  });

  it("restores the flag when create() throws", () => {
    const flags: string[] = [];
    expect(() =>
      createHeapCappedWorker(
        () => {
          throw new Error("no threads");
        },
        8192,
        (f) => flags.push(f),
      ),
    ).toThrow("no threads");
    expect(flags).toEqual(["--max-old-space-size=0", "--max-old-space-size=8192"]);
  });

  it("keeps a worker's heap cap under --max-old-space-size, and later workers keep the flag", () => {
    // A child process so the V8 flag is not set in the vitest worker.
    const mod = pathToFileURL(path.join(here, "../../util/worker-heap-cap.ts")).href;
    const script = `
      import { Worker } from "node:worker_threads";
      import { createHeapCappedWorker } from ${JSON.stringify(mod)};
      const limit = 'const g = process.getBuiltinModule; g("node:worker_threads").parentPort.postMessage((g("node:v8").getHeapStatistics().heap_size_limit / 1e6) | 0)';
      const hog = "const h = []; for (;;) h.push(new Array(1000).fill({ x: h.length }));";
      const w = createHeapCappedWorker(
        () => new Worker(hog, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 16 } }),
      );
      w.on("error", (e) => {
        const later = new Worker(limit, { eval: true });
        later.on("message", (mb) => {
          process.stdout.write(JSON.stringify({ code: e.code, laterMb: mb }));
          process.exit(0);
        });
      });
      setTimeout(() => { process.stdout.write(JSON.stringify({ code: "not capped" })); process.exit(0); }, 15000);`;
    const env: NodeJS.ProcessEnv = { ...process.env };
    // biome-ignore lint/performance/noDelete: the flag must come only from the command line
    delete env.NODE_OPTIONS;
    const r = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=4096",
        "--import",
        tsxLoader,
        "--no-warnings",
        "--input-type=module",
        "-e",
        script,
      ],
      { env, encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { code: string; laterMb?: number };
    expect(out.code).toBe("ERR_WORKER_OUT_OF_MEMORY");
    // V8's default is ~2 GB; the restored flag gives later workers ~4 GB.
    expect(out.laterMb).toBeGreaterThan(3500);
  }, 30_000);
});
