import { ReadOnlyViolationError } from "@ryanstark24/sfgraph-shared";

const SOBJECT_WRITE_METHODS = new Set([
  "create",
  "insert",
  "update",
  "upsert",
  "delete",
  "del",
  "destroy",
  "createBulk",
  "updateBulk",
  "upsertBulk",
  "deleteBulk",
]);

const METADATA_WRITE_METHODS = new Set([
  "create",
  "update",
  "upsert",
  "delete",
  "deploy",
  "rename",
]);

/**
 * Tooling API has its own top-level write methods in addition to
 * tooling.sobject(...).create/update/etc. Block them all. Includes
 * 'executeAnonymous' because anonymous Apex can mutate data even though
 * the call itself is technically a "query".
 */
const TOOLING_TOP_LEVEL_WRITE_METHODS = new Set([
  "create",
  "insert",
  "update",
  "upsert",
  "delete",
  "del",
  "destroy",
  "deploy",
  "rename",
  "executeAnonymous",
  "runTests",
  "runTestsAsynchronous",
  "runTestsSynchronous",
  "createAsync",
  "updateAsync",
  "deleteAsync",
  "deployAsync",
  "requestPost",
  "requestPut",
  "requestPatch",
  "requestDelete",
]);

const ROOT_WRITE_METHODS = new Set([
  "create",
  "update",
  "upsert",
  "delete",
  "del",
  "destroy",
  "recreate",
  "requestPost",
  "requestPut",
  "requestPatch",
  "requestDelete",
]);

const SAFE_HTTP_METHODS = new Set(["GET", "HEAD"]);

/**
 * Union of every known write-shaped method name across all jsforce surfaces.
 * Used by `wrapGenericSurface` to default-deny unknown surfaces (soap, apex,
 * chatter, etc.) — anything callable named `create`, `delete`, `deploy`,
 * `upsert`, ... is blocked even when the surface itself isn't explicitly
 * modelled. Adding new write surfaces to jsforce won't silently bypass the
 * proxy this way.
 */
const ANY_WRITE_METHOD = new Set<string>([
  ...SOBJECT_WRITE_METHODS,
  ...METADATA_WRITE_METHODS,
  ...TOOLING_TOP_LEVEL_WRITE_METHODS,
  ...ROOT_WRITE_METHODS,
]);

/**
 * Names of "make me a job/batch" entry points that take an `operation` field.
 * The wrapper inspects the operation and blocks anything not query-shaped.
 */
const JOB_CREATOR_METHODS = new Set(["createJob"]);

function violation(op: string): never {
  throw new ReadOnlyViolationError(
    `read-only Salesforce connection: '${op}' is blocked at runtime`,
  );
}

function blockingFn(name: string): (...args: unknown[]) => unknown {
  return () => violation(name);
}

function wrapSObject(target: any, label: string): any {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "string" && SOBJECT_WRITE_METHODS.has(prop)) {
        return blockingFn(`${label}.${prop}`);
      }
      const val = Reflect.get(t, prop, receiver);
      return typeof val === "function" ? val.bind(t) : val;
    },
  });
}

function wrapMetadata(target: any): any {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "string" && METADATA_WRITE_METHODS.has(prop)) {
        return blockingFn(`metadata.${String(prop)}`);
      }
      const val = Reflect.get(t, prop, receiver);
      return typeof val === "function" ? val.bind(t) : val;
    },
  });
}

function isReadishOperation(op: unknown): boolean {
  const s = String(op ?? "").toLowerCase();
  return s === "query" || s === "queryall";
}

function wrapTooling(target: any): any {
  return new Proxy(target, {
    get(t, prop, receiver) {
      // P0: never expose the back-reference to the raw connection
      // (jsforce stashes the parent conn on `_conn`). Reachable raw it
      // would bypass every check above.
      if (typeof prop === "string" && prop.startsWith("_")) return undefined;
      if (prop === "sobject") {
        const original = Reflect.get(t, prop, receiver);
        if (typeof original !== "function") return original;
        return (name: string) => wrapSObject(original.call(t, name), `tooling.sobject(${name})`);
      }
      // P0 fix: previously only tooling.sobject was wrapped, so callers could
      // hit conn.tooling.delete(...), conn.tooling.executeAnonymous(...),
      // conn.tooling.requestPost(...) etc. directly. Block every top-level
      // tooling write method.
      if (typeof prop === "string" && TOOLING_TOP_LEVEL_WRITE_METHODS.has(prop)) {
        return blockingFn(`tooling.${String(prop)}`);
      }
      // Block conn.tooling.request(...) when method is not GET/HEAD, mirroring
      // the root-level request gate.
      if (prop === "request") {
        const original = Reflect.get(t, prop, receiver);
        if (typeof original !== "function") return original;
        return (...args: unknown[]) => {
          const first = args[0] as unknown;
          if (typeof first === "object" && first !== null) {
            const methodVal = (first as { method?: unknown }).method;
            const method = typeof methodVal === "string" ? methodVal.toUpperCase() : "GET";
            if (!SAFE_HTTP_METHODS.has(method)) violation(`tooling.request(${method})`);
          }
          if (typeof first === "string") {
            const method = typeof args[1] === "string" ? (args[1] as string).toUpperCase() : "GET";
            if (!SAFE_HTTP_METHODS.has(method)) violation(`tooling.request(${method})`);
          }
          return (original as (...a: unknown[]) => unknown).call(t, ...args);
        };
      }
      const val = Reflect.get(t, prop, receiver);
      return typeof val === "function" ? val.bind(t) : val;
    },
  });
}

function wrapBulk(target: any): any {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "string" && prop.startsWith("_")) return undefined;
      if (prop === "load") {
        return (sobjectName: string, operation: string, ...rest: unknown[]) => {
          if (!isReadishOperation(operation)) {
            violation(`bulk.load(${sobjectName}, ${operation})`);
          }
          const orig = Reflect.get(t, prop, receiver);
          return (orig as Function).call(t, sobjectName, operation, ...rest);
        };
      }
      // P0: jsforce also exposes bulk.createJob({ operation }) as a
      // lower-level entry point. Mirror the read-only gate.
      if (typeof prop === "string" && JOB_CREATOR_METHODS.has(prop)) {
        const original = Reflect.get(t, prop, receiver);
        if (typeof original !== "function") return original;
        return (jobOpts: unknown, ...rest: unknown[]) => {
          const op = (jobOpts as { operation?: unknown } | null)?.operation;
          if (!isReadishOperation(op)) violation(`bulk.${String(prop)}(${String(op)})`);
          return (original as (...a: unknown[]) => unknown).call(t, jobOpts, ...rest);
        };
      }
      // P0: bulk.job(jobId).batch(...) chain. Wrap any returned job so its
      // create/update/delete methods are blocked. Read methods (`check`,
      // `list`, `retrieve`) pass through. We only know to block writes here
      // because the chain is too dynamic to enumerate exhaustively.
      if (prop === "job") {
        const original = Reflect.get(t, prop, receiver);
        if (typeof original !== "function") return original;
        return (...args: unknown[]) => {
          const job = (original as (...a: unknown[]) => unknown).call(t, ...args);
          return wrapGenericSurface(job, "bulk.job(...)");
        };
      }
      const val = Reflect.get(t, prop, receiver);
      return typeof val === "function" ? val.bind(t) : val;
    },
  });
}

/**
 * Last-line defence for surfaces we haven't modelled explicitly (soap, apex,
 * chatter, analytics, bulk2, ...). Default-denies any property name from the
 * union write set and hides `_`-prefixed internals.
 */
function wrapGenericSurface(target: any, label: string): any {
  if (target === null || typeof target !== "object") return target;
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "string") {
        if (prop.startsWith("_")) return undefined;
        if (ANY_WRITE_METHOD.has(prop)) {
          return blockingFn(`${label}.${prop}`);
        }
        if (JOB_CREATOR_METHODS.has(prop)) {
          const original = Reflect.get(t, prop, receiver);
          if (typeof original !== "function") return original;
          return (jobOpts: unknown, ...rest: unknown[]) => {
            const op = (jobOpts as { operation?: unknown } | null)?.operation;
            if (!isReadishOperation(op)) {
              violation(`${label}.${String(prop)}(${String(op)})`);
            }
            return (original as (...a: unknown[]) => unknown).call(t, jobOpts, ...rest);
          };
        }
      }
      const val = Reflect.get(t, prop, receiver);
      return typeof val === "function" ? val.bind(t) : val;
    },
  });
}

function wrapRequest(target: any, originalRequest: Function): Function {
  return (info: any, ...rest: unknown[]) => {
    const method = typeof info === "string" ? "GET" : String(info?.method ?? "GET").toUpperCase();
    if (!SAFE_HTTP_METHODS.has(method)) {
      violation(`request(${method})`);
    }
    return originalRequest.call(target, info, ...rest);
  };
}

export function wrapConnectionReadOnly<T extends object>(conn: T): T {
  return new Proxy(conn, {
    get(target, prop, receiver) {
      // P0: hide jsforce internals (_conn, _logger, etc.) so callers can't
      // reach the raw connection and bypass the proxy.
      if (typeof prop === "string" && prop.startsWith("_")) return undefined;
      if (typeof prop === "string" && ROOT_WRITE_METHODS.has(prop)) {
        return blockingFn(prop);
      }
      if (prop === "sobject") {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original !== "function") return original;
        return (name: string) => wrapSObject(original.call(target, name), `sobject(${name})`);
      }
      if (prop === "tooling") {
        const t = Reflect.get(target, prop, receiver);
        return t ? wrapTooling(t) : t;
      }
      if (prop === "metadata") {
        const m = Reflect.get(target, prop, receiver);
        return m ? wrapMetadata(m) : m;
      }
      if (prop === "bulk") {
        const b = Reflect.get(target, prop, receiver);
        return b ? wrapBulk(b) : b;
      }
      if (prop === "request") {
        const r = Reflect.get(target, prop, receiver);
        if (typeof r !== "function") return r;
        return wrapRequest(target, r);
      }
      // P0: any other API surface (soap, bulk2, apex, chatter, analytics,
      // streaming, ...) goes through the generic default-deny wrapper. This
      // prevents `conn.soap.create({})`, `conn.bulk2.createJob({operation:'insert'})`,
      // `conn.apex.post(...)`, etc. from sneaking past the explicit allowlist.
      const val = Reflect.get(target, prop, receiver);
      if (val !== null && typeof val === "object") {
        return wrapGenericSurface(val, String(prop));
      }
      return typeof val === "function" ? val.bind(target) : val;
    },
  }) as T;
}
