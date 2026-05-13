/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MockJsforceOpts {
  queryResults?: Record<string, { records: any[]; done?: boolean; nextRecordsUrl?: string }>;
  toolingQueryResults?: Record<string, { records: any[]; done?: boolean; nextRecordsUrl?: string }>;
  describeResults?: Record<string, boolean>;
  toolingDescribeResults?: Record<string, boolean>;
  metadataList?: Record<string, any[]>;
  metadataRead?: Record<string, (names: string[]) => any[]>;
  apiVersion?: string;
  instanceUrl?: string;
  userInfo?: { organizationId?: string };
  /** Increment writeCounter whenever a write method is called (proxy should block before this triggers). */
  writeCounter?: { count: number };
  /** Throw on first call, succeed afterwards (for retry tests). */
  queryThrowOnce?: () => Error | null;
}

export function buildJsforceMock(opts: MockJsforceOpts = {}): any {
  const queryResults = opts.queryResults ?? {};
  const toolingQueryResults = opts.toolingQueryResults ?? {};
  const describeResults = opts.describeResults ?? {};
  const toolingDescribeResults = opts.toolingDescribeResults ?? {};
  const metadataList = opts.metadataList ?? {};
  const metadataRead = opts.metadataRead ?? {};
  const writeCounter = opts.writeCounter ?? { count: 0 };
  const writeFn =
    (label: string) =>
    async (..._a: any[]) => {
      writeCounter.count += 1;
      throw new Error(`mock write '${label}' was not blocked`);
    };

  const queryOnce = opts.queryThrowOnce;

  const conn: any = {
    instanceUrl: opts.instanceUrl ?? "https://example.my.salesforce.com",
    version: opts.apiVersion ?? "60.0",
    userInfo: opts.userInfo ?? { organizationId: "00Dxx0000000001EAA" },
    query: async (soql: string) => {
      if (queryOnce) {
        const err = queryOnce();
        if (err) throw err;
      }
      return queryResults[soql] ?? queryResults["*"] ?? { records: [], done: true };
    },
    queryMore: async (url: string) => queryResults[url] ?? { records: [], done: true },
    request: async () => ({}),
    sobject: (name: string) => ({
      describe: async () => {
        if (describeResults[name] === false) throw new Error(`no such sobject ${name}`);
        if (describeResults[name] === true) return { name };
        // default: throw (sobject doesn't exist unless explicitly allowed)
        throw new Error(`no such sobject ${name}`);
      },
      create: writeFn(`sobject(${name}).create`),
      update: writeFn(`sobject(${name}).update`),
      upsert: writeFn(`sobject(${name}).upsert`),
      delete: writeFn(`sobject(${name}).delete`),
    }),
    tooling: {
      query: async (soql: string) => {
        if (queryOnce) {
          const err = queryOnce();
          if (err) throw err;
        }
        return toolingQueryResults[soql] ?? toolingQueryResults["*"] ?? { records: [], done: true };
      },
      queryMore: async (url: string) => toolingQueryResults[url] ?? { records: [], done: true },
      sobject: (name: string) => ({
        describe: async () => {
          if (toolingDescribeResults[name] === true) return { name };
          throw new Error(`no such tooling sobject ${name}`);
        },
      }),
    },
    metadata: {
      list: async (req: any) => {
        const types = Array.isArray(req) ? req : [req];
        const out: any[] = [];
        for (const t of types) {
          const list = metadataList[t?.type] ?? [];
          for (const e of list) out.push(e);
        }
        return out;
      },
      read: async (type: string, names: string[]) => {
        const fn = metadataRead[type];
        if (fn) return fn(names);
        return names.map((n) => ({ fullName: n }));
      },
      create: writeFn("metadata.create"),
      update: writeFn("metadata.update"),
      deploy: writeFn("metadata.deploy"),
      delete: writeFn("metadata.delete"),
    },
    create: writeFn("conn.create"),
    update: writeFn("conn.update"),
    upsert: writeFn("conn.upsert"),
    delete: writeFn("conn.delete"),
  };
  return conn;
}
