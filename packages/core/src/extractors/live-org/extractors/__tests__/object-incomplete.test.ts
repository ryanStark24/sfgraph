import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawMember } from "../../../interfaces/metadata-source.js";
import { limiter } from "../../rate-limit.js";
import { IncompleteSourceError } from "../../retry.js";
import { iterObject } from "../object.js";

/**
 * Live ingest on a large org: `object 750/765 (..., 11 timed out ...)` followed by
 * `object ✓ 754 records`. Describe failures were counted for the progress
 * line and dropped (`desc: null` -> `continue`), and platform events
 * (`__e`, queryable=false in describeGlobal) were filtered out entirely, so
 * 7 retrieved objects never reached the graph and the run reported skips=0.
 */

function entityRow(name: string) {
  return {
    QualifiedApiName: name,
    IsCustomizable: true,
    IsApexTriggerable: true,
    IsDeprecatedAndHidden: false,
    IsCustomSetting: false,
  };
}

function sobj(name: string, queryable = true) {
  return { name, label: name, custom: name.includes("__"), queryable, deprecatedAndHidden: false };
}

interface FakeOpts {
  /** decide whether describe(name) attempt n (1-based) rejects */
  describeFails?: (name: string, attempt: number) => boolean;
  describeGlobalFails?: (attempt: number) => boolean;
  /** decide whether EntityDefinition query attempt n (1-based) rejects */
  entityQueryFails?: (attempt: number) => boolean;
}

function fakeConn(sobjects: ReturnType<typeof sobj>[], o: FakeOpts = {}) {
  const describeAttempts = new Map<string, number>();
  let dgAttempts = 0;
  let edAttempts = 0;
  const names = sobjects.map((s) => s.name);
  return {
    // Like the real Tooling API: EntityDefinition comes back in ONE batch
    // (done:true) and queryMore is refused (review M3).
    tooling: {
      query: async () => {
        edAttempts += 1;
        if (o.entityQueryFails?.(edAttempts)) throw new Error("socket hang up");
        return { records: names.map(entityRow), done: true, totalSize: names.length };
      },
      queryMore: async () => {
        throw new Error("EntityDefinition does not support queryMore()");
      },
    },
    describeGlobal: async () => {
      dgAttempts += 1;
      if (o.describeGlobalFails?.(dgAttempts)) throw new Error("ETIMEDOUT describeGlobal");
      return { sobjects };
    },
    sobject: (name: string) => ({
      describe: async () => {
        const n = (describeAttempts.get(name) ?? 0) + 1;
        describeAttempts.set(name, n);
        if (o.describeFails?.(name, n)) throw new Error(`describe timeout (12000ms): ${name}`);
        return { name, label: name, fields: [{ name: "Id", type: "id" }] };
      },
    }),
  };
}

async function drain(
  it: AsyncIterable<RawMember>,
): Promise<{ names: string[]; error: Error | undefined }> {
  const names: string[] = [];
  let error: Error | undefined;
  try {
    for await (const m of it) names.push(m.ref.memberName);
  } catch (e) {
    error = e as Error;
  }
  return { names, error };
}

describe("iterObject — describe failures are retried and surfaced", () => {
  const objects = [sobj("Account"), sobj("Foo__c"), sobj("Bar__c"), sobj("Baz__mdt")];

  it("retries a transiently failing describe and yields every object", async () => {
    const conn = fakeConn(objects, { describeFails: (n, a) => n === "Foo__c" && a === 1 });
    const { names, error } = await drain(iterObject(conn, { retryBackoffMs: 0 }));
    expect(error).toBeUndefined();
    expect(names.sort()).toEqual(["Account", "Bar__c", "Baz__mdt", "Foo__c"]);
  });

  it("keeps what was fetched and throws an IncompleteSourceError naming the lost objects", async () => {
    const conn = fakeConn(objects, {
      describeFails: (n) => n === "Bar__c" || n === "Baz__mdt",
    });
    const { names, error } = await drain(iterObject(conn, { retryBackoffMs: 0 }));
    expect(names.sort()).toEqual(["Account", "Foo__c"]);
    expect(error).toBeInstanceOf(IncompleteSourceError);
    expect((error as IncompleteSourceError).failures.map((f) => f.name).sort()).toEqual([
      "Bar__c",
      "Baz__mdt",
    ]);
    expect(error?.message).toMatch(/Bar__c/);
    expect(error?.message).toMatch(/describe timeout/);
  });

  it("does not drop platform events because describeGlobal marks them non-queryable", async () => {
    const conn = fakeConn([sobj("Account"), sobj("Order_Event__e", false)]);
    const { names, error } = await drain(iterObject(conn, { retryBackoffMs: 0 }));
    expect(error).toBeUndefined();
    expect(names).toContain("Order_Event__e");
  });

  it("surfaces a persistent describeGlobal failure instead of ending with 0 records", async () => {
    const conn = fakeConn(objects, { describeGlobalFails: () => true });
    const { names, error } = await drain(iterObject(conn, { retryBackoffMs: 0 }));
    expect(names).toEqual([]);
    expect(error?.message).toMatch(/describeGlobal/);
  });

  it("retries a failing EntityDefinition query instead of falling back to the whitelist", async () => {
    // The whitelist fallback silently excludes namespaced custom objects.
    const nsObjects = [sobj("ns__A__c"), sobj("ns__B__c"), sobj("ns__C__c"), sobj("ns__D__c")];
    const conn = fakeConn(nsObjects, { entityQueryFails: (a) => a === 1 });
    const { names, error } = await drain(iterObject(conn, { retryBackoffMs: 0 }));
    expect(error).toBeUndefined();
    expect(names.sort()).toEqual(["ns__A__c", "ns__B__c", "ns__C__c", "ns__D__c"]);
  });
});

/** Review M6: the EntityDefinition probe's outer timeout used to leave the
 *  inner drain retrying (holding Tooling pool slots) after the source had
 *  already fallen back to the static whitelist. */
describe("iterObject — EntityDefinition probe timeout stops the inner drain", () => {
  it("stops re-trying EntityDefinition pages once the probe timed out", async () => {
    const prev = process.env.SFGRAPH_ENTITYDEF_PROBE_TIMEOUT_MS;
    process.env.SFGRAPH_ENTITYDEF_PROBE_TIMEOUT_MS = "100";
    try {
      const conn = fakeConn([sobj("Account")], { entityQueryFails: () => true });
      let qm = 0;
      const orig = conn.tooling.query;
      conn.tooling.query = async () => {
        qm += 1;
        return orig();
      };
      const { names, error } = await drain(iterObject(conn, { retryBackoffMs: 40, retries: 10 }));
      // Static-whitelist fallback still yields Account; the degradation is reported.
      expect(names).toEqual(["Account"]);
      expect(error?.message).toMatch(/EntityDefinition classification/);
      const atTimeout = qm;
      await new Promise((r) => setTimeout(r, 700));
      expect(qm).toBe(atTimeout);
    } finally {
      if (prev === undefined)
        Reflect.deleteProperty(process.env, "SFGRAPH_ENTITYDEF_PROBE_TIMEOUT_MS");
      else process.env.SFGRAPH_ENTITYDEF_PROBE_TIMEOUT_MS = prev;
    }
  });
});

/**
 * Large-org re-ingest (f6de04f): `EntityDefinition does not support
 * queryMore(), use LIMIT to restrict the results to a single batch`. The org
 * has 5758 EntityDefinition rows; the old drain asked for all of them and
 * died on the first page, so classification fell back to the static
 * whitelist on every run. The drain must stay within single-batch queries.
 */
describe("iterObject — EntityDefinition is paged without queryMore", () => {
  // Bucket splits fan out 37 tooling queries per level; keep the shared
  // tooling reservoir from throttling the probe into its timeout.
  beforeEach(async () => {
    await limiter.incrementReservoir(10_000);
  });

  const ED_LIMIT = 2000;

  /** SOQL LIKE pattern -> RegExp with real semantics: `%` any run, `_` any
   *  one char, `\\x` a literal x; case-insensitive. Independent of how the
   *  code escapes, so an unescaped `_` over-matches here as on the server. */
  function likeToRegExp(pattern: string): RegExp {
    let re = "";
    for (let i = 0; i < pattern.length; i += 1) {
      const c = pattern[i] ?? "";
      if (c === "\\") {
        i += 1;
        re += (pattern[i] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      } else if (c === "%") re += ".*";
      else if (c === "_") re += ".";
      else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`, "i");
  }

  function edConn(
    allNames: string[],
    sobjects: ReturnType<typeof sobj>[],
    opts: { countTotal?: number | null } = {},
  ) {
    const queries: string[] = [];
    const fault = (msg: string) =>
      Object.assign(new Error(msg), { errorCode: "EXCEEDED_ID_LIMIT", name: "EXCEEDED_ID_LIMIT" });
    return {
      queries,
      conn: {
        tooling: {
          query: async (soql: string) => {
            queries.push(soql);
            if (/SELECT COUNT\(\) FROM EntityDefinition/i.test(soql)) {
              const total = opts.countTotal === undefined ? allNames.length : opts.countTotal;
              return total === null
                ? { records: [], done: true }
                : { records: [], totalSize: total, done: true };
            }
            let rows = allNames;
            const like = /QualifiedApiName LIKE '((?:[^'\\]|\\.)*)'/i.exec(soql);
            const eq = /QualifiedApiName = '((?:[^'\\]|\\.)*)'/i.exec(soql);
            if (like) {
              const re = likeToRegExp(like[1] ?? "");
              rows = rows.filter((n) => re.test(n));
            } else if (eq) {
              const v = (eq[1] ?? "").replace(/\\(.)/g, "$1").toLowerCase();
              rows = rows.filter((n) => n.toLowerCase() === v);
            }
            const lim = /LIMIT (\d+)/i.exec(soql);
            if (!lim && rows.length > ED_LIMIT) {
              throw fault(
                "EntityDefinition does not support queryMore(), use LIMIT to restrict the results to a single batch",
              );
            }
            const n = lim ? Math.min(Number(lim[1]), ED_LIMIT) : ED_LIMIT;
            return { records: rows.slice(0, n).map(entityRow), done: true, totalSize: rows.length };
          },
          queryMore: async () => {
            throw fault("EntityDefinition does not support queryMore()");
          },
        },
        describeGlobal: async () => ({ sobjects }),
        sobject: (name: string) => ({
          describe: async () => ({ name, label: name, fields: [{ name: "Id", type: "id" }] }),
        }),
      },
    };
  }

  it("classifies every row of a >2000-row EntityDefinition (splitting full buckets)", async () => {
    // 1200 + 1200 namespaced rows share the first letter `N`, so the `N`
    // bucket is full and must be split; the rest fit in one bucket each.
    const names = [
      ...Array.from({ length: 1200 }, (_, i) => `ns__Obj${i}__c`),
      ...Array.from({ length: 1200 }, (_, i) => `nt__Obj${i}__c`),
      ...Array.from({ length: 900 }, (_, i) => `Std${i}`),
      "Account",
      "N",
    ];
    const wanted = [
      sobj("Account"),
      sobj("Std899"),
      sobj("ns__Obj1199__c"),
      sobj("nt__Obj0__c"),
      sobj("nt__Obj777__c"),
    ];
    const { conn, queries } = edConn(names, wanted);
    const { names: got, error } = await drain(iterObject(conn, { retryBackoffMs: 0 }));
    expect(error).toBeUndefined();
    expect(got.sort()).toEqual(wanted.map((s) => s.name).sort());
    // Every row query is a single batch: LIMIT-ed, never queryMore.
    for (const q of queries) {
      if (/COUNT\(\)/.test(q)) continue;
      expect(q).toMatch(/LIMIT 2000/);
    }
  });

  it("small orgs still need just one query", async () => {
    const { conn, queries } = edConn(["Account", "ns__A__c"], [sobj("Account"), sobj("ns__A__c")]);
    const { names: got, error } = await drain(iterObject(conn, { retryBackoffMs: 0 }));
    expect(error).toBeUndefined();
    expect(got.sort()).toEqual(["Account", "ns__A__c"]);
    expect(queries).toHaveLength(1);
  });
  const nsRows = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}__c`);

  it("splits a bucket down to depth 3+ and classifies every row", async () => {
    // 4500 rows share `nsx` — the N, NS and NSX buckets are all full.
    const names = [
      ...nsRows("nsxa__O", 1500),
      ...nsRows("nsxb__O", 1500),
      ...nsRows("nsxc__O", 1500),
    ];
    names.push("Account");
    const wanted = [
      sobj("Account"),
      sobj("nsxa__O0__c"),
      sobj("nsxb__O1499__c"),
      sobj("nsxc__O7__c"),
    ];
    const { conn, queries } = edConn(names, wanted);
    const { names: got, error } = await drain(iterObject(conn, { retryBackoffMs: 0 }));
    expect(error).toBeUndefined();
    expect(got.sort()).toEqual(wanted.map((s) => s.name).sort());
    expect(queries.some((q) => /LIKE 'NSXA%'/i.test(q))).toBe(true);
  });

  it("escapes `_` in a full `X_` bucket so it does not swallow `XA…` rows", async () => {
    // A_ is full (2100 rows) and AB… rows must still be classified exactly once.
    const names = [...nsRows("A_x", 2100), ...nsRows("ABy", 50)];
    const wanted = [sobj("A_x2099__c"), sobj("ABy49__c")];
    const { conn, queries } = edConn(names, wanted);
    const { names: got, error } = await drain(iterObject(conn, { retryBackoffMs: 0 }));
    expect(error).toBeUndefined();
    expect(got.sort()).toEqual(wanted.map((s) => s.name).sort());
    expect(queries.some((q) => q.includes("LIKE 'A\\_%'"))).toBe(true);
  });

  it("classifies a row whose name does not start with a letter (first level covers 0-9 and _)", async () => {
    const names = [...nsRows("Std", 2000), "9Lives__c", "_Odd__c"];
    const wanted = [sobj("9Lives__c"), sobj("_Odd__c"), sobj("Std5__c")];
    const { conn } = edConn(names, wanted);
    const { names: got, error } = await drain(iterObject(conn, { retryBackoffMs: 0 }));
    expect(error).toBeUndefined();
    expect(got.sort()).toEqual(wanted.map((s) => s.name).sort());
  });

  it("a COUNT() mismatch falls back to the static whitelist AND reports it", async () => {
    const names = nsRows("ns__O", 2500);
    const { conn } = edConn(names, [sobj("Account"), sobj("ns__O1__c")], { countTotal: 2600 });
    const { names: got, error } = await drain(iterObject(conn, { retryBackoffMs: 0 }));
    // Static whitelist: the standard object stays, the namespaced one does not.
    expect(got).toContain("Account");
    expect(error?.message).toMatch(/EntityDefinition classification/);
    expect(error?.message).toMatch(/partition incomplete: 2500 of 2600/);
  });

  it("a partition a row short of COUNT() keeps the classification instead of falling back", async () => {
    // A large live org came up 1 short on every run; the whitelist fallback
    // then dropped every namespaced object.
    const names = nsRows("ns__O", 2500);
    const { conn } = edConn(names, [sobj("Account"), sobj("ns__O1__c")], {
      countTotal: names.length + 1,
    });
    const { names: got, error } = await drain(iterObject(conn, { retryBackoffMs: 0 }));
    expect(error).toBeUndefined();
    expect(got).toContain("ns__O1__c");
  });

  it("rows sharing a QualifiedApiName are not mistaken for a partition gap", async () => {
    const names = [...nsRows("ns__O", 2500), "ns__O7__c", "ns__O8__c", ...nsRows("nt__O", 20)];
    const { conn } = edConn(names, [sobj("ns__O7__c"), sobj("nt__O3__c")], {
      // At the tolerated gap (10) counting rows; 2 past it counting unique names.
      countTotal: names.length + 10,
    });
    const { names: got, error } = await drain(iterObject(conn, { retryBackoffMs: 0 }));
    expect(error).toBeUndefined();
    expect(got.sort()).toEqual(["ns__O7__c", "nt__O3__c"]);
  });

  it("a COUNT() without totalSize is treated as unverifiable, not as success", async () => {
    const names = nsRows("ns__O", 2500);
    const { conn } = edConn(names, [sobj("Account")], { countTotal: null });
    const { error } = await drain(iterObject(conn, { retryBackoffMs: 0 }));
    expect(error?.message).toMatch(/COUNT\(\) returned no totalSize/);
  });

  it("a bucket still full at the maximum prefix length throws instead of recursing forever", async () => {
    // 2000+ rows with an identical 90-char prefix: every bucket on the way
    // down is full. The 37-way fan-out at each level only recurses into the
    // one matching character, so this is ~80 x 38 queries.
    // ~3000 queries through the real Tooling pool exceed the 60 s probe
    // ceiling; lift it so the depth guard (not the ceiling) ends the probe.
    vi.stubEnv("SFGRAPH_ENTITYDEF_PROBE_TIMEOUT_MS", "600000");
    const long = "A".repeat(90);
    const names = Array.from({ length: 2001 }, (_, i) => `${long}${i}`);
    const { conn } = edConn(names, [sobj("Account")]);
    const { error } = await drain(iterObject(conn, { retryBackoffMs: 0 }));
    vi.unstubAllEnvs();
    expect(error?.message).toMatch(/still full at max depth/);
  }, 300_000);
});
