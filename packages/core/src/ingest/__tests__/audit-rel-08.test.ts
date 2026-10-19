import { ConsoleLogger, asOrgId } from "@ryanstark24/sfgraph-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetadataSource, RawMember } from "../../extractors/interfaces/metadata-source.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(process.env, "SFGRAPH_DEBUG_INGEST");
  process.exitCode = undefined;
});

function member(name: string): RawMember {
  return {
    ref: { type: "ApexClass", fullName: name, sourceHash: name } as never,
    content: `public class ${name} {}`,
  } as RawMember;
}

// audit rel-08: with SFGRAPH_DEBUG_INGEST=1 the SIGTERM handler swallows the signal.
describe("audit rel-08", () => {
  it("a SIGTERM during a debug ingest stops it (exit/re-raise or abort) instead of being swallowed", async () => {
    process.env.SFGRAPH_DEBUG_INGEST = "1";
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consumed: string[] = [];
    const source: MetadataSource = {
      async *iter() {
        yield member("First");
        consumed.push("First");
        process.emit("SIGTERM");
        await new Promise((r) => setTimeout(r, 20));
        yield member("Second");
        consumed.push("Second");
      },
    };
    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();
    const orgId = asOrgId("00Dxx0000000SIGT");
    let rejected = false;
    try {
      await liveIngest({
        alias: "sig",
        graphStore,
        mode: "full",
        skipSnapshot: true,
        metadataSource: source,
        preResolved: {
          orgId,
          alias: "sig",
          username: "u",
          instanceUrl: "https://x.example",
          apiVersion: "60.0",
          conn: {} as never,
        },
        logger: new ConsoleLogger("error"),
      });
    } catch {
      rejected = true;
    }
    const stopped =
      exit.mock.calls.length > 0 ||
      kill.mock.calls.length > 0 ||
      rejected ||
      !consumed.includes("Second");
    expect(stopped).toBe(true);
  });

  it("when the host handles the signal, the debug handler steps aside instead of re-raising", async () => {
    process.env.SFGRAPH_DEBUG_INGEST = "1";
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let hostSaw = 0;
    const host = () => {
      hostSaw += 1;
    };
    process.on("SIGTERM", host);
    const baseline = process.listenerCount("SIGTERM");
    let duringIngest = -1;
    const source: MetadataSource = {
      async *iter() {
        yield member("First");
        process.emit("SIGTERM");
        duringIngest = process.listenerCount("SIGTERM");
      },
    };
    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();
    const orgId = asOrgId("00Dxx0000000SIGH");
    try {
      await liveIngest({
        alias: "sig",
        graphStore,
        mode: "full",
        skipSnapshot: true,
        metadataSource: source,
        preResolved: {
          orgId,
          alias: "sig",
          username: "u",
          instanceUrl: "https://x.example",
          apiVersion: "60.0",
          conn: {} as never,
        },
        logger: new ConsoleLogger("error"),
      });
    } catch {
      /* the host decides what a signal means */
    } finally {
      process.off("SIGTERM", host);
    }
    expect(hostSaw).toBe(1);
    expect(kill.mock.calls.filter((c) => c[0] === process.pid)).toHaveLength(0);
    // The debug handler removed itself on the signal.
    expect(duringIngest).toBe(baseline);
  });
});
