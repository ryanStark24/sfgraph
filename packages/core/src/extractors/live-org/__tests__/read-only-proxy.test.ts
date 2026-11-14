/* eslint-disable @typescript-eslint/no-explicit-any */
import { ReadOnlyViolationError } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { wrapConnectionReadOnly } from "../read-only-proxy.js";
import { assertReadOnlyRequest, soapOperation } from "../transport-guard.js";
import { type RealConn, makeRealConnection, soapEnvelope } from "./_real-jsforce.js";

/** Real jsforce 3.x Connection + recorder transport, then wrapped as the extractors get it. */
function setup(): RealConn & { facade: any } {
  const r = makeRealConnection();
  const facade = wrapConnectionReadOnly(r.conn);
  return { ...r, facade };
}

/** Everything reachable from `root` through own/inherited properties, getters and handle-returning calls. */
function reachable(root: unknown, probes: Array<(o: any) => unknown>): Set<unknown> {
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const o = stack.pop();
    if (o === null || (typeof o !== "object" && typeof o !== "function") || seen.has(o)) continue;
    seen.add(o);
    for (let p: any = o; p && p !== Object.prototype && p !== Function.prototype; ) {
      for (const k of Reflect.ownKeys(p)) {
        const d = Object.getOwnPropertyDescriptor(p, k) as PropertyDescriptor;
        if ("value" in d) stack.push(d.value);
        else if (d.get) {
          try {
            stack.push(d.get.call(o));
          } catch {
            /* getter needs receiver state */
          }
        }
      }
      p = Object.getPrototypeOf(p);
    }
    stack.push(Object.getPrototypeOf(o));
    for (const probe of probes) {
      try {
        stack.push(probe(o));
      } catch {
        /* not applicable */
      }
    }
  }
  return seen;
}

describe("read facade: no raw connection is reachable", () => {
  it("exposes exactly the read operations and nothing else", () => {
    const { facade } = setup();
    expect(Object.keys(facade).sort()).toEqual(
      [
        "describeGlobal",
        "identity",
        "metadata",
        "query",
        "queryMore",
        "sobject",
        "tooling",
        "version",
      ].sort(),
    );
    expect(Object.keys(facade.tooling).sort()).toEqual(["query", "queryMore", "sobject"]);
    expect(Object.keys(facade.metadata).sort()).toEqual(["describe", "list", "read", "retrieve"]);
    expect(Object.isFrozen(facade)).toBe(true);
    expect(Object.getPrototypeOf(facade)).toBe(Object.prototype);
  });

  it("has no write methods or generic request surface at any level", () => {
    const { facade } = setup();
    for (const name of [
      "create",
      "insert",
      "update",
      "upsert",
      "delete",
      "del",
      "destroy",
      "recreate",
      "request",
      "requestPost",
      "requestPatch",
      "requestPut",
      "requestDelete",
      "apex",
      "bulk",
      "bulk2",
      "soap",
      "chatter",
      "streaming",
      "analytics",
      "_conn",
      "_transport",
      "connection",
      "conn",
      "raw",
    ]) {
      expect(facade[name], `facade.${name}`).toBeUndefined();
    }
    const so = facade.sobject("Account");
    const tso = facade.tooling.sobject("ApexClass");
    for (const h of [so, tso]) {
      for (const name of [
        "create",
        "insert",
        "update",
        "upsert",
        "delete",
        "del",
        "destroy",
        "_conn",
        "retrieve",
      ]) {
        expect(h[name], `sobject handle .${name}`).toBeUndefined();
      }
    }
    for (const name of [
      "create",
      "update",
      "upsert",
      "delete",
      "deploy",
      "deployRest",
      "rename",
      "cancelDeploy",
      "_conn",
      "checkStatus",
      "checkRetrieveStatus",
      "deployRecentValidation",
    ]) {
      expect(facade.metadata[name], `metadata.${name}`).toBeUndefined();
    }
    for (const name of [
      "create",
      "delete",
      "executeAnonymous",
      "requestPost",
      "request",
      "_conn",
      "runTests",
    ]) {
      expect(facade.tooling[name], `tooling.${name}`).toBeUndefined();
    }
  });

  it("the raw Connection, its transport and its SDK objects are unreachable from the facade", () => {
    const { facade, conn } = setup();
    const forbidden = new Set<unknown>([
      conn,
      conn._transport,
      conn.apex,
      conn.metadata,
      conn.tooling,
      conn.bulk,
      conn.bulk2,
      conn.soap,
    ]);
    const handles = [
      (o: any) => o.sobject?.("Account"),
      (o: any) => o.tooling?.sobject?.("ApexClass"),
      (o: any) => o.retrieve?.({ unpackaged: { types: [] } }),
    ];
    const found = reachable(facade, handles);
    for (const f of forbidden) expect(found.has(f)).toBe(false);
    // Also through a retrieve locator handle.
    const locator = facade.metadata.retrieve({ unpackaged: { types: [] } });
    expect(Object.keys(locator)).toEqual(["complete"]);
    for (const f of forbidden) expect(reachable(locator, []).has(f)).toBe(false);
  });

  it("query results are plain data, not jsforce Query objects", async () => {
    const { facade } = setup();
    const page = await facade.query("SELECT Id FROM Account");
    expect(Object.getPrototypeOf(page)).toBe(Object.prototype);
    expect(page._conn).toBeUndefined();
    expect(typeof page.then).toBe("undefined");
  });

  it("the old reproductions fail: apex.post and sobject()._conn.create are not reachable", () => {
    const { facade } = setup();
    expect(() => facade.apex.post("/audit-only", {})).toThrow(TypeError);
    expect(() => facade.sobject("Account")._conn.create("Account", { Name: "x" })).toThrow(
      TypeError,
    );
    expect(facade.metadata._conn === undefined).toBe(true);
  });
});

describe("transport guard: writes through the REAL jsforce Connection never reach the transport", () => {
  async function refuses(fn: () => unknown): Promise<unknown> {
    let err: unknown;
    try {
      await fn();
    } catch (e) {
      err = e;
    }
    expect(err, "expected a refusal").toBeInstanceOf(ReadOnlyViolationError);
    return err;
  }

  it("refuses apex post/patch/put/delete, naming method and URL", async () => {
    const { conn, requests } = setup();
    const e1 = (await refuses(() => conn.apex.post("/audit-only", { name: "x" }))) as Error;
    expect(e1.message).toContain("POST");
    expect(e1.message).toContain("https://example.invalid/services/apexrest/audit-only");
    await refuses(() => conn.apex.patch("/audit-only", { name: "x" }));
    await refuses(() => conn.apex.put("/audit-only", { name: "x" }));
    await refuses(() => conn.apex.delete("/audit-only"));
    expect(requests).toEqual([]);
  });

  it("refuses sobject create/update/destroy/upsert and the _conn back-reference", async () => {
    const { conn, requests } = setup();
    await refuses(() => conn.sobject("Account").create({ Name: "x" }));
    await refuses(() => conn.sobject("Account").update({ Id: "001000000000001AAA", Name: "y" }));
    await refuses(() => conn.sobject("Account").destroy("001000000000001AAA"));
    await refuses(() => conn.sobject("Account").upsert({ Name: "z", Ext__c: "1" }, "Ext__c"));
    await refuses(() => conn.sobject("Account")._conn.create("Account", { Name: "x" }));
    await refuses(() => conn.metadata._conn.create("Account", { Name: "x" }));
    await refuses(() => conn.create("Account", { Name: "x" }));
    await refuses(() => conn.tooling.sobject("ApexClass").create({ Name: "x", Body: "" }));
    await refuses(() => conn.tooling.executeAnonymous("System.debug(1);"));
    expect(requests).toEqual([]);
  });

  it("refuses Metadata API writes (create/update/upsert/delete/rename/deploy) by SOAP operation", async () => {
    const { conn, requests } = setup();
    await refuses(() => conn.metadata.create("CustomObject", { fullName: "X__c" }));
    await refuses(() => conn.metadata.update("CustomObject", { fullName: "X__c" }));
    await refuses(() => conn.metadata.upsert("CustomObject", { fullName: "X__c" }));
    await refuses(() => conn.metadata.delete("CustomObject", ["X__c"]));
    await refuses(() => conn.metadata.rename("CustomObject", "A__c", "B__c"));
    await refuses(() => conn.metadata.deploy(Buffer.from("zip"), {}).complete());
    await refuses(() => conn.metadata.deployRest(Buffer.from("zip"), {}));
    await refuses(() => conn.metadata.cancelDeploy("0Af000000000001AAA"));
    await refuses(() => conn.metadata.deployRecentValidation({ id: "0Af000000000001AAA" }));
    expect(requests).toEqual([]);
  });

  it("refuses raw request() with a write method, a write URL, or a string-cased method", async () => {
    const { conn, requests } = setup();
    for (const method of ["POST", "post", "PATCH", "PUT", "DELETE", "OPTIONS"]) {
      await refuses(() =>
        conn.request({ method, url: "/services/data/v60.0/sobjects/Account", body: "{}" }),
      );
    }
    await refuses(() =>
      conn.request({
        method: "POST",
        url: "https://example.invalid/services/data/v60.0/composite",
        body: "{}",
      }),
    );
    expect(requests).toEqual([]);
  });

  it("refuses bulk loads and bulk2 jobs that write", async () => {
    const { conn, requests } = setup();
    await refuses(() => conn.bulk.load("Account", "insert", [{ Name: "x" }]));
    await refuses(() =>
      conn.bulk2.loadAndWaitForResults({
        object: "Account",
        operation: "insert",
        input: "Name\nx\n",
      }),
    );
    expect(requests).toEqual([]);
  });

  it("refuses at the transport itself, below conn.request (what SOAP uses)", () => {
    const { conn, requests } = setup();
    expect(() =>
      conn._transport.httpRequest({ method: "POST", url: "https://example.invalid/x" }),
    ).toThrow(ReadOnlyViolationError);
    expect(() =>
      conn._transport.httpRequest({ method: "DELETE", url: "https://example.invalid/x" }),
    ).toThrow(/refused DELETE https:\/\/example\.invalid\/x/);
    expect(requests).toEqual([]);
  });

  it("allows SOAP only by operation name, not by URL", () => {
    const url = "https://example.invalid/services/Soap/m/60.0";
    const body = (inner: string) => soapEnvelope(inner);
    for (const op of [
      "listMetadata",
      "readMetadata",
      "describeMetadata",
      "retrieve",
      "checkStatus",
      "checkRetrieveStatus",
    ]) {
      expect(() =>
        assertReadOnlyRequest({ method: "POST", url, body: body(`<${op}><x>1</x></${op}>`) }),
      ).not.toThrow();
    }
    for (const op of [
      "deployMetadata",
      "deploy",
      "createMetadata",
      "updateMetadata",
      "upsertMetadata",
      "deleteMetadata",
      "renameMetadata",
      "cancelDeploy",
      "deployRecentValidation",
      "login",
      "logout",
    ]) {
      expect(
        () => assertReadOnlyRequest({ method: "POST", url, body: body(`<${op}/>`) }),
        op,
      ).toThrow(ReadOnlyViolationError);
    }
    // read op smuggled next to a write, a write nested in a read, wrong URL, non-string body, mismatched _message
    expect(() =>
      assertReadOnlyRequest({
        method: "POST",
        url,
        body: body("<listMetadata/><deleteMetadata/>"),
      }),
    ).toThrow();
    expect(() =>
      assertReadOnlyRequest({
        method: "POST",
        url,
        body: body(
          "<listMetadata><a/></listMetadata><deleteMetadata><a/></deleteMetadata><listMetadata/>",
        ),
      }),
    ).toThrow();
    expect(() =>
      assertReadOnlyRequest({
        method: "POST",
        url: "https://example.invalid/services/Soap/u/60.0",
        body: body("<listMetadata/>"),
      }),
    ).toThrow();
    expect(() =>
      assertReadOnlyRequest({
        method: "POST",
        url: "https://example.invalid/services/data/v60.0/sobjects/Account",
        body: body("<listMetadata/>"),
      }),
    ).toThrow();
    expect(() =>
      assertReadOnlyRequest({ method: "POST", url, body: Buffer.from(body("<listMetadata/>")) }),
    ).toThrow();
    expect(() =>
      assertReadOnlyRequest({
        method: "POST",
        url,
        body: body("<listMetadata/>"),
        _message: { deleteMetadata: {} },
      }),
    ).toThrow();
    expect(() =>
      assertReadOnlyRequest({ method: "PUT", url, body: body("<listMetadata/>") }),
    ).toThrow();
    expect(
      soapOperation(
        "<soapenv:Envelope><soapenv:Body><ns:readMetadata><a>b</a></ns:readMetadata></soapenv:Body></soapenv:Envelope>",
      ),
    ).toBe("readMetadata");
    expect(soapOperation("not xml")).toBeNull();
  });

  it("is idempotent: wrapping twice does not stack or break reads", async () => {
    const { conn, requests } = setup();
    const again = wrapConnectionReadOnly(conn);
    await again.query("SELECT Id FROM Account");
    expect(requests).toHaveLength(1);
  });
});

describe("every read the live extractors make still reaches the transport", () => {
  it("REST and Tooling reads are GETs", async () => {
    const { facade, requests } = setup();
    await facade.query("SELECT Id FROM Account");
    await facade.queryMore("/services/data/v60.0/query/01gxx-2000");
    await facade.tooling.query("SELECT Id FROM ApexClass");
    await facade.tooling.queryMore("/services/data/v60.0/tooling/query/01gxx-2000");
    await facade.describeGlobal();
    await facade.sobject("Account").describe();
    await facade.tooling.sobject("ApexClass").describe();
    await facade.identity();
    expect(requests.length).toBeGreaterThanOrEqual(8);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    const urls = requests.map((r) => r.url);
    expect(
      urls.some((u) =>
        /\/query\?q=SELECT\+Id\+FROM\+Account|\/query\?q=SELECT%20Id%20FROM%20Account/.test(u),
      ),
    ).toBe(true);
    expect(urls.some((u) => u.includes("/tooling/query"))).toBe(true);
    expect(
      urls.some(
        (u) => u.endsWith("/sobjects/Account/describe") || u.includes("/sobjects/Account/describe"),
      ),
    ).toBe(true);
    expect(facade.version).toBe("60.0");
  });

  it("Metadata list/read/describe go out as read-only SOAP", async () => {
    const { facade, requests } = setup();
    await facade.metadata.list([{ type: "Flow" }]);
    await facade.metadata.read("Flow", ["A", "B"]);
    await facade.metadata.describe("60.0");
    expect(requests.map((r) => [r.method, r.soapOp])).toEqual([
      ["POST", "listMetadata"],
      ["POST", "readMetadata"],
      ["POST", "describeMetadata"],
    ]);
    expect(requests.every((r) => r.url === "https://example.invalid/services/Soap/m/60.0")).toBe(
      true,
    );
  });

  it("Metadata retrieve().complete() sends retrieve and its status polls", async () => {
    const { facade, requests } = setup();
    const res = await facade.metadata
      .retrieve({
        apiVersion: "60.0",
        unpackaged: { types: [{ name: "OmniScript", members: ["*"] }], version: "60.0" },
      })
      .complete({ details: false });
    expect(res).toBeDefined();
    const ops = requests.map((r) => r.soapOp);
    expect(ops[0]).toBe("retrieve");
    expect(ops).toContain("checkRetrieveStatus");
    expect(requests.every((r) => r.method === "POST" && r.soapOp)).toBe(true);
  });
});
