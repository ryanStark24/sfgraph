/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConsoleLogger, asOrgId } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import {
  type RecordedRequest,
  defaultResponder,
  json,
  makeRealConnection,
} from "../../extractors/live-org/__tests__/_real-jsforce.js";
import { wrapConnectionReadOnly } from "../../extractors/live-org/read-only-proxy.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { liveIngest } from "../live-ingest.js";

function soql(req: RecordedRequest): string {
  const q = /[?&]q=([^&]*)/.exec(req.url)?.[1] ?? "";
  return decodeURIComponent(q.replace(/\+/g, " "));
}

describe("liveIngest through the guarded real jsforce Connection", () => {
  it("completes a full ingest; every request is a GET or a read-only SOAP call; writes still fail", async () => {
    const real = makeRealConnection((req) => {
      if (!req.soapOp) {
        const path = req.url.split("?")[0] ?? "";
        if (/\/sobjects\/[^/]+\/describe$/.test(path)) {
          return {
            status: 404,
            ...json([{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }]),
          };
        }
        if (path.includes("/tooling/query") && /FROM ApexClass\b/.test(soql(req))) {
          return json({
            totalSize: 1,
            done: true,
            records: [
              {
                Id: "01p000000000001AAA",
                Name: "AcmeGreeter",
                Body: "public class AcmeGreeter { public void greet() {} }",
                LastModifiedDate: "2025-01-01T00:00:00.000+0000",
                ApiVersion: 60,
                Status: "Active",
              },
            ],
          });
        }
      }
      return defaultResponder(req);
    });
    const conn = wrapConnectionReadOnly(real.conn);

    const graphStore = new SqliteGraphStore({ dbPath: ":memory:" });
    await graphStore.init();
    const orgId = asOrgId("00Dxx0000000REAAAA");
    const result = await liveIngest({
      alias: "real-conn",
      graphStore,
      mode: "full",
      preResolved: {
        orgId,
        alias: "real-conn",
        username: "ro@example.invalid",
        instanceUrl: "https://example.invalid",
        apiVersion: "60.0",
        conn,
      },
      logger: new ConsoleLogger("error"),
      skipSnapshot: true,
    });

    expect(result.membersProcessed).toBeGreaterThan(0);
    expect(graphStore.countNodes(orgId)).toBeGreaterThan(0);
    const names = graphStore.listQnamesByLabel(orgId, "ApexClass").map(String);
    expect(names).toContain("ApexClass:AcmeGreeter");

    // The transport saw real reads, and only reads.
    expect(real.requests.length).toBeGreaterThan(5);
    const bad = real.requests.filter(
      (r) => !(r.method === "GET" || r.method === "HEAD" || (r.method === "POST" && r.soapOp)),
    );
    expect(bad).toEqual([]);
    const soapOps = new Set(real.requests.filter((r) => r.soapOp).map((r) => r.soapOp));
    for (const op of soapOps) {
      expect([
        "listMetadata",
        "readMetadata",
        "describeMetadata",
        "retrieve",
        "checkStatus",
        "checkRetrieveStatus",
      ]).toContain(op);
    }
    expect(real.requests.some((r) => r.soapOp === "describeMetadata")).toBe(true);

    // After the ingest the same connection still refuses writes at the transport.
    const before = real.requests.length;
    await expect(real.conn.apex.post("/x", {})).rejects.toThrow(/refused POST/);
    await expect(real.conn.sobject("Account").create({ Name: "x" })).rejects.toThrow(
      /refused POST/,
    );
    expect(real.requests.length).toBe(before);
  }, 60_000);
});
