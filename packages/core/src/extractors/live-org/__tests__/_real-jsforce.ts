/* eslint-disable @typescript-eslint/no-explicit-any */
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { soapOperation } from "../transport-guard.js";

/**
 * A REAL jsforce 3.x Connection whose transport is replaced by a recorder.
 * Nothing leaves the process. Every request that reaches the transport is
 * pushed on `requests`; a request the guard refuses never gets there.
 */
const require_ = createRequire(import.meta.url);
const { Connection } = require_("jsforce") as { Connection: new (o: any) => any };

export interface RecordedRequest {
  method: string;
  url: string;
  body?: unknown;
  soapOp?: string;
}

export type Responder = (req: RecordedRequest) => { status?: number; type?: string; body: string };

const SOAP_NS = "http://soap.sforce.com/2006/04/metadata";

export function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="${SOAP_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

export function json(body: unknown): { type: string; body: string } {
  return { type: "application/json", body: JSON.stringify(body) };
}

export function xml(body: string): { type: string; body: string } {
  return { type: "text/xml", body };
}

/** Default responses good enough for every read sfgraph's live extraction makes. */
export function defaultResponder(req: RecordedRequest): ReturnType<Responder> {
  if (req.soapOp) {
    switch (req.soapOp) {
      case "listMetadata":
        return xml(soapEnvelope("<listMetadataResponse><result/></listMetadataResponse>"));
      case "readMetadata":
        return xml(
          soapEnvelope("<readMetadataResponse><result><records/></result></readMetadataResponse>"),
        );
      case "describeMetadata":
        return xml(
          soapEnvelope(
            `<describeMetadataResponse><result>${[
              "ApexClass",
              "ApexTrigger",
              "LightningComponentBundle",
              "Flow",
              "Profile",
              "PermissionSet",
              "CustomObject",
            ]
              .map((n) => `<metadataObjects><xmlName>${n}</xmlName></metadataObjects>`)
              .join(
                "",
              )}<organizationNamespace></organizationNamespace><partialSaveAllowed>true</partialSaveAllowed><testRequired>false</testRequired></result></describeMetadataResponse>`,
          ),
        );
      case "retrieve":
        return xml(
          soapEnvelope(
            "<retrieveResponse><result><done>false</done><id>09S000000000001AAA</id><state>Queued</state></result></retrieveResponse>",
          ),
        );
      case "checkStatus":
        return xml(
          soapEnvelope(
            "<checkStatusResponse><result><done>true</done><id>09S000000000001AAA</id><state>Completed</state></result></checkStatusResponse>",
          ),
        );
      case "checkRetrieveStatus":
        return xml(
          soapEnvelope(
            "<checkRetrieveStatusResponse><result><done>true</done><id>09S000000000001AAA</id><status>Succeeded</status><success>true</success></result></checkRetrieveStatusResponse>",
          ),
        );
      default:
        return xml(soapEnvelope(`<${req.soapOp}Response><result/></${req.soapOp}Response>`));
    }
  }
  const path = req.url.split("?")[0] ?? "";
  if (/\/sobjects\/[^/]+\/describe\/?$/.test(path)) {
    const name = /\/sobjects\/([^/]+)\//.exec(path)?.[1] ?? "X";
    return json({ name, fields: [], childRelationships: [] });
  }
  if (/\/sobjects\/?$/.test(path)) return json({ sobjects: [] });
  if (/\/query(All)?(\/|$)/.test(path)) {
    return json({ totalSize: 0, done: true, records: [] });
  }
  if (/\/chatter\/users\/me|\/id\//.test(path)) return json({ user_id: "005000000000001AAA" });
  return json({});
}

export interface RealConn {
  conn: any;
  requests: RecordedRequest[];
  /** Replace the responder after construction. */
  setResponder(r: Responder): void;
}

export function makeRealConnection(responder: Responder = defaultResponder): RealConn {
  let current = responder;
  const requests: RecordedRequest[] = [];
  const conn = new Connection({
    instanceUrl: "https://example.invalid",
    accessToken: "FAKE_TEST_TOKEN",
    version: "60.0",
  });
  const recorder = {
    httpRequest(req: any) {
      const rec: RecordedRequest = {
        method: String(req.method ?? "GET").toUpperCase(),
        url: String(req.url),
        body: req.body,
      };
      const op = rec.method === "POST" ? soapOperation(req.body) : null;
      if (op) rec.soapOp = op;
      requests.push(rec);
      const out = current(rec);
      const response = {
        statusCode: out.status ?? 200,
        headers: { "content-type": out.type ?? "application/json" },
        body: out.body,
      };
      const p: any = Promise.resolve(response);
      p.stream = () => new PassThrough();
      return p;
    },
  };
  conn._transport = recorder;
  return {
    conn,
    requests,
    setResponder: (r) => {
      current = r;
    },
  };
}
