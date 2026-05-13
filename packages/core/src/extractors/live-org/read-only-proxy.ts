import { ReadOnlyViolationError } from "@sfgraph/shared";

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

function wrapTooling(target: any): any {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "sobject") {
        const original = Reflect.get(t, prop, receiver);
        if (typeof original !== "function") return original;
        return (name: string) => wrapSObject(original.call(t, name), `tooling.sobject(${name})`);
      }
      const val = Reflect.get(t, prop, receiver);
      return typeof val === "function" ? val.bind(t) : val;
    },
  });
}

function wrapBulk(target: any): any {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "load") {
        return (sobjectName: string, operation: string, ...rest: unknown[]) => {
          const op = String(operation || "").toLowerCase();
          if (op !== "query" && op !== "queryall") {
            violation(`bulk.load(${sobjectName}, ${operation})`);
          }
          const orig = Reflect.get(t, prop, receiver);
          return (orig as Function).call(t, sobjectName, operation, ...rest);
        };
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
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    },
  }) as T;
}
