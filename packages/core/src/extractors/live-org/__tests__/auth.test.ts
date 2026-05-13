import { ReadOnlyViolationError, SfgraphError } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { resolveDefaultOrgAlias, resolveOrg } from "../auth.js";
import { buildJsforceMock } from "./_jsforce-mock.js";

const state = { lastUsername: undefined as string | undefined, shouldFail: false };

function makeAuthInfo(opts: { username: string }) {
  return {
    username: opts.username,
    getFields() {
      return {
        username: opts.username,
        orgId: "00Dxx0000000ABCEAA",
        instanceUrl: "https://example.my.salesforce.com",
      };
    },
  };
}

const FakeAuthInfo = {
  async create(opts: { username: string }) {
    state.lastUsername = opts.username;
    if (state.shouldFail) throw new Error("no auth file");
    return makeAuthInfo(opts);
  },
};

const FakeConnection = {
  async create(_opts: { authInfo: unknown }) {
    return buildJsforceMock();
  },
};

describe("resolveOrg", () => {
  it("returns a wrapped connection for a valid alias", async () => {
    state.shouldFail = false;
    const r = await resolveOrg("my-org", { AuthInfo: FakeAuthInfo, Connection: FakeConnection });
    expect(r.alias).toBe("my-org");
    expect(r.orgId).toBe("00Dxx0000000ABCEAA");
    expect(typeof r.conn).toBe("object");
    expect(state.lastUsername).toBe("my-org");
  });

  it("throws SfgraphError E_SF_AUTH when AuthInfo.create fails", async () => {
    state.shouldFail = true;
    await expect(
      resolveOrg("ghost", { AuthInfo: FakeAuthInfo, Connection: FakeConnection }),
    ).rejects.toBeInstanceOf(SfgraphError);
    state.shouldFail = true;
    try {
      await resolveOrg("ghost", { AuthInfo: FakeAuthInfo, Connection: FakeConnection });
    } catch (e) {
      expect((e as SfgraphError).code).toBe("E_SF_AUTH");
      expect((e as SfgraphError).message).toContain("ghost");
    }
  });

  it("resolveDefaultOrgAlias returns target-org from ConfigAggregator", async () => {
    const FakeAggregator = {
      async create() {
        return {
          getInfo(key: string) {
            return key === "target-org" ? { value: "my-default-alias" } : null;
          },
        };
      },
    };
    const alias = await resolveDefaultOrgAlias({ ConfigAggregator: FakeAggregator });
    expect(alias).toBe("my-default-alias");
  });

  it("resolveDefaultOrgAlias returns null when no default is configured", async () => {
    const FakeAggregator = {
      async create() {
        return {
          getInfo() {
            return null;
          },
        };
      },
    };
    const alias = await resolveDefaultOrgAlias({ ConfigAggregator: FakeAggregator });
    expect(alias).toBeNull();
  });

  it("returns a read-only-wrapped connection (writes throw synchronously when invoked)", async () => {
    state.shouldFail = false;
    const r = await resolveOrg("safe", { AuthInfo: FakeAuthInfo, Connection: FakeConnection });
    expect(() => r.conn.sobject("Account").create({ Name: "x" })).toThrowError(
      ReadOnlyViolationError,
    );
    expect(() => r.conn.create("Account", { Name: "x" })).toThrowError(ReadOnlyViolationError);
  });
});
