import { readFile, stat } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_REL_TYPES,
  closeAllStores,
  listOrgs,
  neighborhood,
  overview,
  schema,
  search,
  validOrgId,
} from "./api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  // Resolve to PUBLIC_DIR and reject anything that escapes it (path traversal).
  // Using `path.relative` instead of `startsWith` avoids the classic prefix
  // trap on Windows: `C:\app\public` is a prefix of `C:\app\public_evil\...`
  // but `path.relative(PUBLIC_DIR, abs)` would yield `..\public_evil\...`
  // and be rejected.
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const abs = path.resolve(PUBLIC_DIR, `.${rel}`);
  const insideRel = path.relative(PUBLIC_DIR, abs);
  if (insideRel.startsWith("..") || path.isAbsolute(insideRel)) {
    sendText(res, 403, "forbidden");
    return;
  }
  try {
    const s = await stat(abs);
    if (!s.isFile()) {
      sendText(res, 404, "not found");
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    const body = await readFile(abs);
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    sendText(res, 404, "not found");
  }
}

function parseQuery(url: string): URLSearchParams {
  const idx = url.indexOf("?");
  return new URLSearchParams(idx >= 0 ? url.slice(idx + 1) : "");
}

function requireOrgId(qs: URLSearchParams, res: ServerResponse): string | null {
  const org = qs.get("org");
  if (!org || !validOrgId(org)) {
    sendJson(res, 400, { error: "missing or invalid 'org' query param (expected 15/18-char id)" });
    return null;
  }
  return org;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
  const qs = parseQuery(url);
  const pathOnly = url.split("?")[0];
  try {
    if (pathOnly === "/api/orgs") {
      sendJson(res, 200, await listOrgs());
      return;
    }
    if (pathOnly === "/api/rel-types") {
      sendJson(res, 200, ALL_REL_TYPES);
      return;
    }
    if (pathOnly === "/api/search") {
      const org = requireOrgId(qs, res);
      if (!org) return;
      const q = qs.get("q") ?? "";
      const limit = Math.min(100, Number.parseInt(qs.get("limit") ?? "25", 10) || 25);
      sendJson(res, 200, await search(org, q, limit));
      return;
    }
    if (pathOnly === "/api/neighborhood") {
      const org = requireOrgId(qs, res);
      if (!org) return;
      const qname = qs.get("qname") ?? "";
      if (!qname) {
        sendJson(res, 400, { error: "missing 'qname'" });
        return;
      }
      const depth = Math.min(4, Math.max(1, Number.parseInt(qs.get("depth") ?? "2", 10) || 2));
      const rels = qs.get("rels");
      const relTypes = rels ? rels.split(",").filter(Boolean) : undefined;
      sendJson(res, 200, await neighborhood(org, qname, depth, relTypes));
      return;
    }
    if (pathOnly === "/api/overview") {
      const org = requireOrgId(qs, res);
      if (!org) return;
      const labels = (qs.get("labels") ?? "").split(",").filter(Boolean);
      if (labels.length === 0) {
        sendJson(res, 400, { error: "missing 'labels' (comma-separated)" });
        return;
      }
      const limit = Math.min(5000, Number.parseInt(qs.get("limit") ?? "1500", 10) || 1500);
      sendJson(res, 200, await overview(org, labels, limit));
      return;
    }
    if (pathOnly === "/api/schema") {
      const org = requireOrgId(qs, res);
      if (!org) return;
      const limit = Math.min(5000, Number.parseInt(qs.get("limit") ?? "1500", 10) || 1500);
      sendJson(res, 200, await schema(org, limit));
      return;
    }
    sendJson(res, 404, { error: `unknown api path ${pathOnly}` });
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message ?? String(e) });
  }
}

export interface ServeOpts {
  port?: number;
  host?: string;
  log?: (s: string) => void;
}

export interface ServeHandle {
  port: number;
  url: string;
  stop(): Promise<void>;
}

/**
 * Boot the local web visualiser. Returns a handle the caller can use to
 * stop the server cleanly. The server binds to localhost by default to
 * avoid accidentally exposing the ingested graph on the network.
 */
export async function startWebServer(opts: ServeOpts = {}): Promise<ServeHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 7777;
  const log = opts.log ?? ((s) => console.log(s));

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/api/")) {
      void handleApi(req, res, url);
    } else {
      void serveStatic(res, url.split("?")[0] ?? "/");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}`;
  log(`sfgraph-web listening at ${url}`);

  return {
    port: actualPort,
    url,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeAllStores();
    },
  };
}
