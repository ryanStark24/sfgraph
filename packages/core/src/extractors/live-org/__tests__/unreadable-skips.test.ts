import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { beforeEach, describe, expect, it } from "vitest";
import { type IngestSkipReport, bulkRetrieve } from "../bulk-retrieve.js";
import type { OrgCapabilities } from "../capabilities.js";
import { iterGenericMetadata } from "../extractors/generic-metadata.js";
import { limiter, readMetadataBatchAdaptive } from "../rate-limit.js";
import { IncompleteSourceError, isPlatformRefusal } from "../retry.js";
import { buildJsforceMock } from "./_jsforce-mock.js";

/**
 * Large-org re-ingest (f6de04f): 12 skipped types, all re-run by auto-retry,
 * all failing again. A skip must mean "data you could recover by retrying".
 * Members the org refuses deterministically (the same server fault on every
 * read) are a separate, non-retryable `unreadable` kind, still listed.
 */

/** A SOAP fault shaped like jsforce's: errorCode `sf:<CODE>`. */
function sfFault(code: string, message: string): Error {
  const e = new Error(message) as Error & { errorCode: string };
  e.name = `sf:${code}`;
  e.errorCode = `sf:${code}`;
  return e;
}

const caps: OrgCapabilities = {
  detectedNamespaces: [],
  vlocityNamespaces: [],
  vlocityLegacy: false,
  vlocityCmt: false,
  omnistudioOncore: false,
  agentforce: false,
  experienceCloud: false,
  sourceTracking: false,
};

function readConn(fail: (type: string, names: string[], call: number) => Error | null) {
  let call = 0;
  return {
    get calls() {
      return call;
    },
    conn: {
      metadata: {
        read: async (type: string, names: string[]): Promise<unknown[]> => {
          call += 1;
          const err = fail(type, names, call);
          if (err) throw err;
          return names.map((n) => ({ fullName: n }));
        },
      },
    },
  };
}

async function drain(it: AsyncIterable<{ ref: { memberName: string; memberType: string } }>) {
  const members: { type: string; name: string }[] = [];
  let error: unknown;
  try {
    for await (const m of it) members.push({ type: m.ref.memberType, name: m.ref.memberName });
  } catch (e) {
    error = e;
  }
  return { members, error };
}

describe("readMetadataBatchAdaptive classifies deterministic refusals as unreadable", () => {
  beforeEach(async () => {
    await limiter.incrementReservoir(10_000);
  });

  async function failureFor(make: (call: number) => Error | null) {
    const f = readConn((_t, _n, call) => make(call));
    let failure: unknown;
    const out = await readMetadataBatchAdaptive(
      f.conn,
      "AssignmentRule",
      [{ fullName: "Lead.R1" }],
      0,
      (_names, e) => {
        failure = e;
      },
    );
    return { out, failure, calls: f.calls };
  }

  it("the same UNKNOWN_EXCEPTION on all 3 attempts → unreadable, message preserved", async () => {
    const r = await failureFor(() =>
      sfFault("UNKNOWN_EXCEPTION", "UNKNOWN_EXCEPTION: unexpected metadata"),
    );
    expect(r.out).toEqual([null]);
    expect(r.calls).toBe(3);
    expect(isPlatformRefusal(r.failure)).toBe(true);
    expect((r.failure as Error).message).toBe("UNKNOWN_EXCEPTION: unexpected metadata");
  });

  it("a gack with the same stack hash but a fresh ErrorId each time is still the same refusal", async () => {
    const r = await failureFor((call) =>
      sfFault(
        "UNKNOWN_EXCEPTION",
        `UNKNOWN_EXCEPTION: An unexpected error occurred. Please include this ErrorId if you contact support: 1204919062-${3000 + call} (1872961130)`,
      ),
    );
    expect(isPlatformRefusal(r.failure)).toBe(true);
  });

  it("different faults across attempts stay retryable", async () => {
    const r = await failureFor((call) =>
      call === 1
        ? sfFault("UNKNOWN_EXCEPTION", "An unexpected error occurred (111)")
        : sfFault("UNKNOWN_EXCEPTION", "An unexpected error occurred (222)"),
    );
    expect(r.failure).toBeDefined();
    expect(isPlatformRefusal(r.failure)).toBe(false);
  });

  it("transient fault codes and code-less errors stay retryable even when repeated", async () => {
    const limit = await failureFor(() =>
      sfFault("REQUEST_LIMIT_EXCEEDED", "REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded."),
    );
    expect(isPlatformRefusal(limit.failure)).toBe(false);
    const hangup = await failureFor(() => new Error("socket hang up"));
    expect(isPlatformRefusal(hangup.failure)).toBe(false);
    const timeout = await failureFor(() => new Error("metadata.read timeout (45000ms)"));
    expect(isPlatformRefusal(timeout.failure)).toBe(false);
  });

  it("an org rejection is unreadable after one call; insufficient access is not", async () => {
    const rej = await failureFor(() =>
      sfFault("UNKNOWN_EXCEPTION", "type is not a valid metadata type for reading"),
    );
    expect(rej.calls).toBe(1);
    expect(isPlatformRefusal(rej.failure)).toBe(true);
    const access = await failureFor(() =>
      sfFault("INSUFFICIENT_ACCESS", "INSUFFICIENT_ACCESS: User does not have EventLogRead."),
    );
    expect(isPlatformRefusal(access.failure)).toBe(false);
  });
});

describe("iterGenericMetadata — Settings are read under their per-member type", () => {
  beforeEach(async () => {
    await limiter.incrementReservoir(10_000);
  });

  it("reads Settings member X as type XSettings (the bare `Settings` type is unreadable)", async () => {
    const reads: string[] = [];
    const conn = {
      metadata: {
        list: async () => [
          { fullName: "Account", type: "Settings" },
          { fullName: "Chatter", type: "Settings" },
        ],
        read: async (type: string, names: string[]) => {
          reads.push(`${type}:${names.join(",")}`);
          if (type === "Settings") {
            throw sfFault("UNKNOWN_EXCEPTION", "type is not a valid metadata type for reading");
          }
          return names.map((n) => ({ fullName: n, enabled: true }));
        },
      },
    };
    const { members, error } = await drain(iterGenericMetadata(conn, "org1", "Settings"));
    expect(error).toBeUndefined();
    expect(members.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { type: "Settings", name: "Account" },
      { type: "Settings", name: "Chatter" },
    ]);
    expect(reads.sort()).toEqual(["AccountSettings:Account", "ChatterSettings:Chatter"]);
  });
});

describe("iterGenericMetadata — unreadable members and types", () => {
  beforeEach(async () => {
    await limiter.incrementReservoir(10_000);
  });

  it("members the org refuses on every read surface as unreadable failures; the rest are yielded", async () => {
    const conn = {
      metadata: {
        list: async () => [{ fullName: "Good" }, { fullName: "Broken" }],
        read: async (_t: string, names: string[]) => {
          if (names.includes("Broken")) {
            throw sfFault("INVALID_CROSS_REFERENCE_KEY", "invalid cross reference id");
          }
          return names.map((n) => ({ fullName: n }));
        },
      },
    };
    const { members, error } = await drain(iterGenericMetadata(conn, "org1", "NetworkBranding"));
    expect(members.map((m) => m.name)).toEqual(["Good"]);
    expect(error).toBeInstanceOf(IncompleteSourceError);
    const failures = (error as IncompleteSourceError).failures;
    expect(failures.map((f) => f.name)).toEqual(["Broken"]);
    expect(failures.every((f) => isPlatformRefusal(f.error))).toBe(true);
  });

  it("a metadata.list the org refuses identically on every attempt → whole type unreadable", async () => {
    let lists = 0;
    const conn = {
      metadata: {
        list: async () => {
          lists += 1;
          throw sfFault("UNKNOWN_EXCEPTION", "Invalid input. See ManagedTopics documentation.");
        },
        read: async () => [],
      },
    };
    const { error } = await drain(iterGenericMetadata(conn, "org1", "ManagedTopic"));
    expect(lists).toBeGreaterThan(1);
    expect(error).toBeInstanceOf(IncompleteSourceError);
    const failures = (error as IncompleteSourceError).failures;
    expect(failures).toHaveLength(1);
    expect(isPlatformRefusal(failures[0]?.error)).toBe(true);
    expect((error as Error).message).toMatch(/Invalid input/);
  });

  it("a metadata.list that fails transiently is still a plain (retryable) error", async () => {
    const conn = {
      metadata: {
        list: async () => {
          throw new Error("socket hang up");
        },
        read: async () => [],
      },
    };
    const { error } = await drain(iterGenericMetadata(conn, "org1", "Widget"));
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(IncompleteSourceError);
  });
});

describe("bulkRetrieve — unreadable members are a separate, non-retryable skip kind", () => {
  beforeEach(async () => {
    await limiter.incrementReservoir(10_000);
  });

  function connFor(read: (type: string, names: string[]) => unknown[]) {
    const conn = buildJsforceMock({
      metadataDescribe: [{ xmlName: "Widget", childXmlNames: [] }],
      metadataList: {
        Widget: [{ fullName: "Ok" }, { fullName: "Refused" }, { fullName: "Flaky" }],
      },
    });
    conn.metadata.read = async (type: string, names: string[]) => read(type, names);
    return conn;
  }

  async function skipsFor(conn: unknown) {
    const skipReport: IngestSkipReport = { skips: [] };
    for await (const _ of bulkRetrieve(conn, caps, asOrgId("org_1"), {
      skipReport,
      onlyLabels: new Set(["generic:Widget"]),
    })) {
      /* consume */
    }
    return skipReport.skips;
  }

  it("all-refused failures → one `unreadable` skip naming the member and first error", async () => {
    const skips = await skipsFor(
      connFor((_t, names) => {
        if (names.includes("Refused") || names.includes("Flaky")) {
          throw sfFault("UNKNOWN_EXCEPTION", "targetObject is invalid");
        }
        return names.map((n) => ({ fullName: n }));
      }),
    );
    expect(skips).toHaveLength(1);
    expect(skips[0]?.label).toBe("generic:Widget");
    expect(skips[0]?.category).toBe("unreadable");
    expect(skips[0]?.reason).toMatch(/Refused/);
    expect(skips[0]?.reason).toMatch(/targetObject is invalid/);
  });

  it("mixed failures → an `unreadable` entry AND a retryable entry for the same label", async () => {
    const skips = await skipsFor(
      connFor((_t, names) => {
        if (names.includes("Refused"))
          throw sfFault("UNKNOWN_EXCEPTION", "targetObject is invalid");
        if (names.includes("Flaky")) throw new Error("socket hang up");
        return names.map((n) => ({ fullName: n }));
      }),
    );
    const byCat = Object.fromEntries(skips.map((s) => [s.category, s.reason]));
    expect(Object.keys(byCat).sort()).toEqual(["unknown", "unreadable"]);
    expect(byCat.unreadable).toMatch(/Refused/);
    expect(byCat.unreadable).not.toMatch(/Flaky/);
    expect(byCat.unknown).toMatch(/Flaky/);
    expect(byCat.unknown).not.toMatch(/Refused/);
  });
});
