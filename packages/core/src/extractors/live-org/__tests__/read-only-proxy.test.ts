import { ReadOnlyViolationError } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it, vi } from "vitest";
import { wrapConnectionReadOnly } from "../read-only-proxy.js";

function makeMockConn(): any {
  const fn = (impl?: (...args: any[]) => any) => vi.fn(impl as any) as any;
  const sobjectImpl = (_name: string) => ({
    create: fn(() => ({ id: "001" })),
    insert: fn(),
    update: fn(),
    upsert: fn(),
    delete: fn(),
    del: fn(),
    destroy: fn(),
    createBulk: fn(),
    updateBulk: fn(),
    upsertBulk: fn(),
    deleteBulk: fn(),
    retrieve: fn(() => ({ Id: "x", Name: "Acme" })),
    describe: fn(() => ({ name: "Account" })),
  });
  return {
    sobject: fn(sobjectImpl),
    tooling: { sobject: fn(sobjectImpl), query: fn(() => ({ records: [] })) },
    metadata: {
      create: fn(),
      update: fn(),
      upsert: fn(),
      delete: fn(),
      deploy: fn(),
      rename: fn(),
      read: fn(() => ({})),
      list: fn(() => []),
      describe: fn(() => ({})),
    },
    bulk: { load: fn(() => "loaded") },
    query: fn(() => ({ records: [] })),
    queryMore: fn(),
    queryAll: fn(),
    describe: fn(() => ({})),
    describeGlobal: fn(() => ({})),
    describeSObjects: fn(),
    retrieve: fn(),
    identity: fn(() => ({ user_id: "u" })),
    request: fn(() => ({ ok: true })),
    requestGet: fn(() => ({ ok: true })),
    create: fn(),
    update: fn(),
    upsert: fn(),
    delete: fn(),
    del: fn(),
    destroy: fn(),
    recreate: fn(),
    requestPost: fn(),
    requestPut: fn(),
    requestPatch: fn(),
    requestDelete: fn(),
  };
}

describe("wrapConnectionReadOnly", () => {
  it("blocks sobject().create", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.sobject("Account").create({})).toThrow(ReadOnlyViolationError);
  });
  it("blocks sobject().insert", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.sobject("Account").insert({})).toThrow(ReadOnlyViolationError);
  });
  it("blocks sobject().update", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.sobject("Account").update({})).toThrow(ReadOnlyViolationError);
  });
  it("blocks sobject().upsert", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.sobject("Account").upsert({})).toThrow(ReadOnlyViolationError);
  });
  it("blocks sobject().delete", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.sobject("Account").delete("001")).toThrow(ReadOnlyViolationError);
  });
  it("blocks sobject().del", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.sobject("Account").del("001")).toThrow(ReadOnlyViolationError);
  });
  it("blocks sobject().destroy", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.sobject("Account").destroy("001")).toThrow(ReadOnlyViolationError);
  });
  it("blocks sobject().createBulk", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.sobject("Account").createBulk([])).toThrow(ReadOnlyViolationError);
  });
  it("blocks sobject().updateBulk", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.sobject("Account").updateBulk([])).toThrow(ReadOnlyViolationError);
  });
  it("blocks sobject().upsertBulk", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.sobject("Account").upsertBulk([])).toThrow(ReadOnlyViolationError);
  });
  it("blocks sobject().deleteBulk", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.sobject("Account").deleteBulk([])).toThrow(ReadOnlyViolationError);
  });
  it("blocks tooling.sobject().create", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.tooling.sobject("ApexClass").create({})).toThrow(ReadOnlyViolationError);
  });
  it("blocks tooling.sobject().update", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.tooling.sobject("ApexClass").update({})).toThrow(ReadOnlyViolationError);
  });
  it("blocks tooling.sobject().delete", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.tooling.sobject("ApexClass").delete("x")).toThrow(ReadOnlyViolationError);
  });
  it("blocks metadata.create", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.metadata.create("ApexClass", [])).toThrow(ReadOnlyViolationError);
  });
  it("blocks metadata.update", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.metadata.update("ApexClass", [])).toThrow(ReadOnlyViolationError);
  });
  it("blocks metadata.upsert", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.metadata.upsert("ApexClass", [])).toThrow(ReadOnlyViolationError);
  });
  it("blocks metadata.delete", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.metadata.delete("ApexClass", [])).toThrow(ReadOnlyViolationError);
  });
  it("blocks metadata.deploy", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.metadata.deploy("zip", {})).toThrow(ReadOnlyViolationError);
  });
  it("blocks metadata.rename", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.metadata.rename("ApexClass", "a", "b")).toThrow(ReadOnlyViolationError);
  });
  it("blocks root.create", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => (proxy as any).create()).toThrow(ReadOnlyViolationError);
  });
  it("blocks root.update", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => (proxy as any).update()).toThrow(ReadOnlyViolationError);
  });
  it("blocks root.delete", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => (proxy as any).delete()).toThrow(ReadOnlyViolationError);
  });
  it("blocks root.requestPost", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => (proxy as any).requestPost("/x", {})).toThrow(ReadOnlyViolationError);
  });
  it("blocks root.requestPut", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => (proxy as any).requestPut("/x", {})).toThrow(ReadOnlyViolationError);
  });
  it("blocks root.requestPatch", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => (proxy as any).requestPatch("/x", {})).toThrow(ReadOnlyViolationError);
  });
  it("blocks root.requestDelete", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => (proxy as any).requestDelete("/x")).toThrow(ReadOnlyViolationError);
  });
  it("blocks request with POST method", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.request({ method: "POST", url: "/x" })).toThrow(ReadOnlyViolationError);
  });
  it("blocks request with DELETE method", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.request({ method: "DELETE", url: "/x" })).toThrow(ReadOnlyViolationError);
  });
  it("blocks bulk.load with insert", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.bulk.load("Account", "insert", [])).toThrow(ReadOnlyViolationError);
  });
  it("blocks bulk.load with update", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(() => proxy.bulk.load("Account", "update", [])).toThrow(ReadOnlyViolationError);
  });

  // ---- read pass-through ----
  it("allows query", () => {
    const m = makeMockConn();
    const proxy = wrapConnectionReadOnly(m);
    expect(proxy.query("SELECT Id FROM Account")).toEqual({ records: [] });
    expect(m.query).toHaveBeenCalled();
  });
  it("allows sobject().retrieve", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(proxy.sobject("Account").retrieve("001")).toEqual({ Id: "x", Name: "Acme" });
  });
  it("allows sobject().describe", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(proxy.sobject("Account").describe()).toEqual({ name: "Account" });
  });
  it("allows describe / describeGlobal", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(proxy.describe()).toEqual({});
    expect(proxy.describeGlobal()).toEqual({});
  });
  it("allows identity", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(proxy.identity()).toEqual({ user_id: "u" });
  });
  it("allows tooling.query", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(proxy.tooling.query("SELECT Id FROM ApexClass")).toEqual({ records: [] });
  });
  it("allows metadata.read / list / describe", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(proxy.metadata.read("ApexClass", ["x"])).toEqual({});
    expect(proxy.metadata.list({ type: "ApexClass" })).toEqual([]);
    expect(proxy.metadata.describe()).toEqual({});
  });
  it("allows request with GET string url", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(proxy.request("/services/data/v60.0/sobjects")).toEqual({ ok: true });
  });
  it("allows request with explicit GET method", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(proxy.request({ method: "GET", url: "/x" })).toEqual({ ok: true });
  });
  it("allows bulk.load with query operation", () => {
    const proxy = wrapConnectionReadOnly(makeMockConn());
    expect(proxy.bulk.load("Account", "query", "SELECT Id FROM Account")).toBe("loaded");
  });
});
