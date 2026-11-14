import { ReadOnlyViolationError } from "@ryanstark24/sfgraph-shared";

/**
 * Transport-level read-only guard for a real jsforce `Connection`.
 *
 * jsforce 3.x routes HTTP two ways: REST/Tooling/Apex/Bulk calls go through
 * `conn.request(...)`, while the Metadata API (SOAP) builds its own `HttpApi`
 * and sends through `conn._transport.httpRequest(...)` without touching
 * `conn.request`. Both ends are guarded here, so every request made through
 * the connection's request path is checked:
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
 * The method is read once: the request is copied, the copy's method must be a
 * primitive string, and the checked copy (not the caller's object) is what is
 * sent on.
 *
 * Boundary: the guard sits on the connection instance (`conn.request` and
 * `conn._transport.httpRequest`). Code that bypasses the instance and calls
 * jsforce's own prototype or modules directly, for example
 * `Object.getPrototypeOf(conn._transport).httpRequest.call(...)`, is outside
 * it; jsforce 3 has no per-instance HTTP function to wrap below that point.
 * sfgraph code never does this and extractors only receive the read facade.
 *
 * Not covered, because they do not go through the connection's request path:
 * jsforce's OAuth calls (token refresh, and `conn.logout()`, which POSTs to
 * `/services/oauth2/revoke` through its own oauth2 transport and revokes the
 * session token, not org data) and the streaming (CometD) client
 * `conn.streaming`, which opens its own sockets. sfgraph uses none of them and
 * extractors only get the read facade.
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
/** GET endpoints that run Apex and so can write. Matched on the normalised path. */
const STATE_CHANGING_GET =
  /\/tooling\/(?:executeanonymous|runtestsasynchronous|runtestssynchronous)(?:\/|$)/;

/**
 * Normalise a request URL's path the way a server would before routing: parse
 * once against a dummy base, percent-decode once (an encoded slash or
 * backslash, a failed decode, or a leftover `%` is refused), drop `;params`,
 * collapse repeated slashes and lower-case. Returns null when the URL cannot
 * be understood, which the caller treats as a refusal.
 */
function normalisedPath(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url, "https://example.invalid").pathname;
  } catch {
    return null;
  }
  if (/%(?:2f|5c)/i.test(pathname)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("%") || decoded.includes("\\")) return null;
  const segs = decoded
    .split("/")
    .map((x) => (x.split(";")[0] as string).toLowerCase())
    .filter((x) => x !== "" && x !== ".");
  if (segs.includes("..")) return null;
  return `/${segs.join("/")}`;
}

const METADATA_SOAP_PATH =
  /^(?:https?:\/\/[^/?#]+)?\/services\/Soap\/m\/\d+(?:\.\d+)?\/?(?:[?#].*)?$/;

/**
 * Snapshot a request once. The guard decides on, and the transport is given,
 * this snapshot, so a getter or toString that answers differently on a second
 * read cannot change the method after it was checked. The method must be a
 * primitive string (or absent, which jsforce treats as GET) and so must the url;
 * a String object, array, URL or object with toString is refused rather than
 * coerced. The body is only read from the snapshot, once.
 */
function snapshotRequest(req: unknown): {
  method: string;
  url: string;
  passOn: unknown;
  ok: boolean;
} {
  if (typeof req === "string") return { method: "GET", url: req, passOn: req, ok: true };
  if (typeof req !== "object" || req === null) {
    return { method: `<${typeof req}>`, url: "", passOn: req, ok: false };
  }
  const snap: Record<string, unknown> = { ...(req as Record<string, unknown>) };
  const m = snap.method;
  const urlIsString = typeof snap.url === "string";
  const url = urlIsString ? (snap.url as string) : `<${typeof snap.url} url>`;
  // The URL decides which GETs and which SOAP path are allowed, so like the
  // method it must be a primitive string; a URL object is refused, not coerced.
  if (!urlIsString)
    return { method: typeof m === "string" ? m.toUpperCase() : "?", url, passOn: snap, ok: false };
  if (m === undefined) {
    snap.method = "GET";
    return { method: "GET", url, passOn: snap, ok: true };
  }
  if (typeof m !== "string" || m === "") {
    return { method: `<${typeof m} method>`, url, passOn: snap, ok: false };
  }
  const method = m.toUpperCase();
  snap.method = method;
  return { method, url, passOn: snap, ok: true };
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[\w.:-]/;

/**
 * Return the local name (prefix ignored) of the single operation element in a
 * SOAP envelope's Body, or null. A small tolerant scanner: comments, CDATA
 * sections and processing instructions are skipped (they are not elements), a
 * DOCTYPE or any malformed or unbalanced markup fails closed, and the Body
 * must have exactly one child element. Comment or CDATA text that merely looks
 * like an operation is never read as one.
 */
export function soapOperation(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const n = body.length;
  const stack: string[] = [];
  let bodyCount = 0;
  let inBody = false;
  let sawRoot = false;
  const ops: string[] = [];
  let i = 0;
  while (i < n) {
    const lt = body.indexOf("<", i);
    if (lt < 0) break;
    if (body.startsWith("<!--", lt)) {
      const e = body.indexOf("-->", lt + 4);
      if (e < 0) return null;
      i = e + 3;
      continue;
    }
    if (body.startsWith("<![CDATA[", lt)) {
      const e = body.indexOf("]]>", lt + 9);
      if (e < 0) return null;
      i = e + 3;
      continue;
    }
    if (body.startsWith("<?", lt)) {
      const e = body.indexOf("?>", lt + 2);
      if (e < 0) return null;
      i = e + 2;
      continue;
    }
    if (body.startsWith("<!", lt)) return null; // DOCTYPE and anything else
    let p = lt + 1;
    const closing = body[p] === "/";
    if (closing) p += 1;
    if (p >= n || !NAME_START.test(body[p] as string)) return null;
    const nameStart = p;
    while (p < n && NAME_CHAR.test(body[p] as string)) p += 1;
    const name = body.slice(nameStart, p);
    let selfClosing = false;
    // Attributes: name="value" or name='value'; quoted values may contain '>'.
    for (;;) {
      while (p < n && /\s/.test(body[p] as string)) p += 1;
      if (p >= n) return null;
      const ch = body[p] as string;
      if (ch === ">") {
        p += 1;
        break;
      }
      if (ch === "/" && body[p + 1] === ">" && !closing) {
        selfClosing = true;
        p += 2;
        break;
      }
      if (closing || !NAME_START.test(ch)) return null;
      while (p < n && NAME_CHAR.test(body[p] as string)) p += 1;
      while (p < n && /\s/.test(body[p] as string)) p += 1;
      if (body[p] !== "=") return null;
      p += 1;
      while (p < n && /\s/.test(body[p] as string)) p += 1;
      const q = body[p];
      if (q !== '"' && q !== "'") return null;
      const qe = body.indexOf(q, p + 1);
      if (qe < 0) return null;
      if (body.slice(p + 1, qe).includes("<")) return null;
      p = qe + 1;
    }
    i = p;
    const local = name.replace(/^[^:]*:/, "");
    if (closing) {
      if (stack.pop() !== name) return null;
      if (inBody && stack.length === 1) inBody = false;
      continue;
    }
    if (stack.length === 0) {
      if (sawRoot) return null; // a second root element
      sawRoot = true;
    }
    if (stack.length === 1 && local === "Body") {
      bodyCount += 1;
      if (bodyCount > 1) return null;
      if (!selfClosing) {
        stack.push(name);
        inBody = true;
      }
      continue;
    }
    if (inBody && stack.length === 2) ops.push(local);
    if (!selfClosing) stack.push(name);
  }
  if (stack.length !== 0 || bodyCount !== 1 || ops.length !== 1) return null;
  return ops[0] as string;
}

/**
 * Throws {@link ReadOnlyViolationError} unless the request is a read. Returns
 * the request snapshot that was checked: callers must send that value, not the
 * original, so what was checked is what goes on the wire.
 */
export function assertReadOnlyRequest(req: unknown): unknown {
  const { method, url, passOn, ok } = snapshotRequest(req);
  if (ok) {
    if (SAFE_HTTP_METHODS.has(method)) {
      const path = normalisedPath(url);
      if (path !== null && !STATE_CHANGING_GET.test(path)) return passOn;
    } else if (method === "POST" && typeof passOn === "object" && passOn !== null) {
      const r = passOn as { url?: unknown; body?: unknown; _message?: unknown };
      if (typeof r.url === "string" && METADATA_SOAP_PATH.test(r.url)) {
        const op = soapOperation(r.body);
        if (op !== null && SOAP_READ_OPERATIONS.has(op)) {
          // jsforce also carries the pre-serialisation message; if present it
          // must agree with the envelope.
          const keys =
            typeof r._message === "object" && r._message !== null ? Object.keys(r._message) : null;
          if (keys === null || (keys.length === 1 && keys[0] === op)) return passOn;
        }
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
          const checked = assertReadOnlyRequest(req);
          return original.call(this ?? transport, checked, ...rest);
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
      let checked: unknown;
      try {
        checked = assertReadOnlyRequest(req);
      } catch (e) {
        return Promise.reject(e);
      }
      return original.call(this ?? conn, checked, ...rest);
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
