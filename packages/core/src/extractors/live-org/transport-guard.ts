import { ReadOnlyViolationError } from "@ryanstark24/sfgraph-shared";

/**
 * Transport-level read-only guard for a real jsforce `Connection`.
 *
 * jsforce 3.x routes HTTP two ways: REST/Tooling/Apex/Bulk calls go through
 * `conn.request(...)`, while the Metadata API (SOAP) builds its own `HttpApi`
 * and sends through `conn._transport.httpRequest(...)` without touching
 * `conn.request`. Both ends are guarded here so that no jsforce surface can
 * put a write on the wire:
 *
 *  - GET and HEAD are allowed, except the few Tooling API GET endpoints that
 *    execute code (see {@link STATE_CHANGING_GET}): anonymous Apex and test
 *    runs can issue DML even though they are sent as GET.
 *  - POST is allowed only for Metadata API SOAP calls to
 *    `/services/Soap/m/<version>` whose envelope body is exactly one operation
 *    from {@link SOAP_READ_OPERATIONS}. The operation is read from the
 *    envelope, not inferred from the URL (every Metadata SOAP call, including
 *    `deployMetadata`, uses the same URL).
 *  - Everything else (PATCH, PUT, DELETE, any other POST) is refused with a
 *    {@link ReadOnlyViolationError} naming the method and URL, before the
 *    request reaches the transport.
 *
 * Not covered, because it does not go through the connection's transport: the
 * OAuth token refresh that `@salesforce/core` performs with its own client.
 * That call exchanges a refresh token for an access token and does not touch
 * org data.
 */

/** Metadata API SOAP operations that only read. */
export const SOAP_READ_OPERATIONS: ReadonlySet<string> = new Set([
  "listMetadata",
  "readMetadata",
  "describeMetadata",
  // retrieve() starts a read-only package retrieval; checkStatus and
  // checkRetrieveStatus poll it. None of them change org metadata.
  "retrieve",
  "checkStatus",
  "checkRetrieveStatus",
]);

const SAFE_HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);
/** GET endpoints that run Apex and so can write. Matched on the URL path. */
const STATE_CHANGING_GET =
  /\/tooling\/(?:executeAnonymous|runTestsAsynchronous|runTestsSynchronous)(?:\/|$)/i;
const METADATA_SOAP_PATH =
  /^(?:https?:\/\/[^/?#]+)?\/services\/Soap\/m\/\d+(?:\.\d+)?\/?(?:[?#].*)?$/;

function describeRequest(req: unknown): { method: string; url: string } {
  if (typeof req === "string") return { method: "GET", url: req };
  const r = (req ?? {}) as { method?: unknown; url?: unknown };
  const method = typeof r.method === "string" && r.method ? r.method.toUpperCase() : "GET";
  const url = typeof r.url === "string" ? r.url : String(r.url);
  return { method, url };
}

/**
 * Return the single top-level operation element of a SOAP envelope body, or
 * null when the envelope is not exactly one operation. Fails closed: anything
 * unbalanced or unexpected returns null.
 */
export function soapOperation(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const open = /<((?:[\w.-]+:)?)Body(?:\s[^>]*)?>/.exec(body);
  if (!open) return null;
  const bodyPrefix = open[1] ?? "";
  const start = open.index + open[0].length;
  const closeTag = `</${bodyPrefix}Body>`;
  const end = body.indexOf(closeTag, start);
  if (end < 0) return null;
  // A second Body element anywhere would make "first operation" ambiguous.
  if (new RegExp(`<${bodyPrefix}Body[\\s>]`).test(body.slice(end + closeTag.length))) return null;
  const inner = body.slice(start, end);
  const tag = /<(\/?)([^\s>/!?]+)([^>]*?)(\/?)>/g;
  let depth = 0;
  const topLevel: string[] = [];
  let m: RegExpExecArray | null = tag.exec(inner);
  while (m) {
    const closing = m[1] === "/";
    const selfClosing = m[4] === "/";
    const name = m[2] as string;
    if (closing) {
      depth -= 1;
      if (depth < 0) return null;
    } else {
      if (depth === 0) topLevel.push(name);
      if (!selfClosing) depth += 1;
    }
    m = tag.exec(inner);
  }
  if (depth !== 0 || topLevel.length !== 1) return null;
  const local = (topLevel[0] as string).replace(/^[\w.-]+:/, "");
  return local;
}

/** Throws {@link ReadOnlyViolationError} unless the request is a read. */
export function assertReadOnlyRequest(req: unknown): void {
  const { method, url } = describeRequest(req);
  if (SAFE_HTTP_METHODS.has(method)) {
    const path = url.split(/[?#]/)[0] ?? "";
    if (!STATE_CHANGING_GET.test(path)) return;
  } else if (method === "POST" && typeof req === "object" && req !== null) {
    const r = req as { url?: unknown; body?: unknown; _message?: unknown };
    if (typeof r.url === "string" && METADATA_SOAP_PATH.test(r.url)) {
      const op = soapOperation(r.body);
      if (op !== null && SOAP_READ_OPERATIONS.has(op)) {
        // jsforce also carries the pre-serialisation message; if present it
        // must agree with the envelope.
        const keys =
          typeof r._message === "object" && r._message !== null ? Object.keys(r._message) : null;
        if (keys === null || (keys.length === 1 && keys[0] === op)) return;
      }
    }
  }
  throw new ReadOnlyViolationError(
    `read-only Salesforce connection: refused ${method} ${url.slice(0, 200)} (only GET, HEAD and read-only Metadata API SOAP calls are allowed)`,
  );
}

const guarded = new WeakSet<object>();

/**
 * Install the guard on a real jsforce `Connection` instance: wraps
 * `conn.request` and `conn._transport.httpRequest`. Idempotent. Objects that
 * have neither (test doubles) are left alone.
 */
export function installTransportGuard(conn: unknown): void {
  if (conn === null || typeof conn !== "object") return;
  const c = conn as { request?: unknown; _transport?: { httpRequest?: unknown } };

  const transport = c._transport;
  if (transport && typeof transport === "object" && typeof transport.httpRequest === "function") {
    if (!guarded.has(transport)) {
      const original = transport.httpRequest as (...a: unknown[]) => unknown;
      Object.defineProperty(transport, "httpRequest", {
        value: function guardedHttpRequest(this: unknown, req: unknown, ...rest: unknown[]) {
          assertReadOnlyRequest(req);
          return original.call(this ?? transport, req, ...rest);
        },
        writable: false,
        configurable: false,
        enumerable: false,
      });
      guarded.add(transport);
    }
  }

  if (typeof c.request === "function" && !guarded.has(c.request as object)) {
    const original = c.request as (...a: unknown[]) => unknown;
    const guardedRequest = function guardedRequest(
      this: unknown,
      req: unknown,
      ...rest: unknown[]
    ) {
      try {
        assertReadOnlyRequest(req);
      } catch (e) {
        return Promise.reject(e);
      }
      return original.call(this ?? conn, req, ...rest);
    };
    guarded.add(guardedRequest);
    Object.defineProperty(conn, "request", {
      value: guardedRequest,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }
}
