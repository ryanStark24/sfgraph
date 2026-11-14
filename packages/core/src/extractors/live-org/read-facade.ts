/**
 * The read-only view of a Salesforce org that extractors receive.
 *
 * This is an explicit capability facade, not a proxy: it exposes only the read
 * calls sfgraph's live extraction makes. Each method is a closure over a
 * private raw jsforce connection that is never handed out. There is no
 * pass-through of unknown properties, no bound SDK function, and no handle
 * (`_conn`, `connection`, query/locator objects) that points back at the raw
 * connection: results are awaited into plain data, and the one handle that is
 * returned (a metadata retrieve locator) is narrowed to a single method.
 *
 * Inventory of what live extraction calls (packages/core/src/extractors/live-org/**,
 * ingest/live-ingest.ts, ingest/recover-objects.ts):
 *   conn.query / conn.queryMore            SOQL over REST (GET)
 *   conn.tooling.query / queryMore         SOQL over Tooling (GET)
 *   conn.describeGlobal()                  REST (GET)
 *   conn.sobject(n).describe()             REST (GET)
 *   conn.tooling.sobject(n).describe()     Tooling (GET)
 *   conn.identity()                        REST (GET), liveness probe
 *   conn.metadata.list / read / describe   Metadata SOAP (POST, read operations)
 *   conn.metadata.retrieve(req).complete() Metadata SOAP retrieve + status polls
 *   conn.version                           negotiated API version
 *
 * The facade is the first layer. The second is the transport guard in
 * transport-guard.ts, which refuses writes on the real connection even if a
 * future facade method were wrong.
 */

/** A page of SOQL results. Records are plain data. */
export interface QueryPage<T = any> {
  records?: T[];
  done?: boolean;
  totalSize?: number;
  nextRecordsUrl?: string;
}

export interface ReadOnlySObjectHandle {
  describe(): Promise<any>;
}

export interface ReadOnlyQueryApi {
  query<T = any>(soql: string): Promise<QueryPage<T>>;
  queryMore<T = any>(locatorOrUrl: string): Promise<QueryPage<T>>;
  sobject(name: string): ReadOnlySObjectHandle;
}

export interface ReadOnlyRetrieveHandle {
  complete(options?: { details?: boolean }): Promise<any>;
}

export interface ReadOnlyMetadataApi {
  list(queries: Array<{ type: string; folder?: string }>, asOfVersion?: string): Promise<any>;
  read(type: string, fullNames: string[]): Promise<any>;
  describe(asOfVersion?: string): Promise<any>;
  retrieve(request: unknown): ReadOnlyRetrieveHandle;
}

export interface ReadOnlyOrgConnection extends ReadOnlyQueryApi {
  readonly version: string | undefined;
  describeGlobal(): Promise<any>;
  identity(): Promise<any>;
  readonly tooling: ReadOnlyQueryApi;
  readonly metadata: ReadOnlyMetadataApi;
}

type Fn = (...args: any[]) => any;

function requireName(name: unknown, what: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError(`${what}: name must be a non-empty string`);
  }
  return name;
}

/**
 * Add `name` only when the raw object has it, so absence stays detectable
 * (`typeof conn.describeGlobal === "function"`) the way it was before.
 */
function defineIf(
  out: Record<string, unknown>,
  raw: any,
  name: string,
  make: (fn: Fn) => Fn,
): void {
  if (raw && typeof raw[name] === "function") {
    const fn = raw[name] as Fn;
    out[name] = make((...a: any[]) => fn.apply(raw, a));
  }
}

function queryApi(raw: any, label: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // `await` flattens jsforce's Query object (which carries a back-reference to
  // the connection) into the plain result page.
  defineIf(out, raw, "query", (call) => async (soql: string) => await call(soql));
  defineIf(out, raw, "queryMore", (call) => async (loc: string) => await call(loc));
  defineIf(out, raw, "sobject", (call) => (name: string) => {
    const handle = call(requireName(name, `${label}.sobject`));
    return Object.freeze({
      describe: async () => await handle.describe(),
    });
  });
  return out;
}

/** Build the facade over a raw jsforce (or @salesforce/core) connection. */
export function createReadFacade(raw: any): ReadOnlyOrgConnection {
  const root = queryApi(raw, "sobject");
  defineIf(root, raw, "describeGlobal", (call) => async () => await call());
  defineIf(root, raw, "identity", (call) => async () => await call());

  const tooling = raw?.tooling
    ? Object.freeze(queryApi(raw.tooling, "tooling.sobject"))
    : undefined;

  let metadata: ReadOnlyMetadataApi | undefined;
  if (raw?.metadata) {
    const m: Record<string, unknown> = {};
    defineIf(m, raw.metadata, "list", (call) => async (q: unknown, v?: string) => await call(q, v));
    defineIf(m, raw.metadata, "read", (call) => async (t: string, n: string[]) => await call(t, n));
    defineIf(m, raw.metadata, "describe", (call) => async (v?: string) => await call(v));
    defineIf(m, raw.metadata, "retrieve", (call) => (request: unknown) => {
      const locator = call(request);
      // Narrow the locator to one method; it holds the metadata API (and so
      // the connection) in private fields.
      return Object.freeze({
        complete: async (options?: { details?: boolean }) => await locator.complete(options),
      });
    });
    metadata = Object.freeze(m) as unknown as ReadOnlyMetadataApi;
  }

  const facade: Record<string, unknown> = { ...root };
  Object.defineProperty(facade, "version", {
    get: () => (typeof raw?.version === "string" ? raw.version : undefined),
    enumerable: true,
  });
  if (tooling) facade.tooling = tooling;
  if (metadata) facade.metadata = metadata;
  return Object.freeze(facade) as unknown as ReadOnlyOrgConnection;
}
