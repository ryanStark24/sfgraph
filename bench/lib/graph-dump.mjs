// Canonical, order- and timestamp-independent dump of an sfgraph SQLite store.
// Pure library: no side effects on import. Imported by bench/graph-diff.mjs and
// by delta-ingest tests in packages/core.
//
// Stream order is plain bytewise (UTF-8) order of the line key:
//   d|<qname>              dead-code scores   ('d' < 'e' < 'n', so these come first)
//   e|<rel>|<src>|<dst>    edges
//   n|<label>|<qname>      nodes
// Tables are visited in order of their key prefix and rows are ordered by the
// lowercased key inside SQL, so a sorted merge of two streams is valid. The
// order is asserted while streaming; tables containing non-ASCII/control/backslash
// characters (where SQLite lower()/BINARY ordering can differ from JS) are
// sorted in memory instead.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import Database from "../../packages/core/node_modules/better-sqlite3/lib/index.js";

const TMP_PREFIXES = [tmpdir(), "/tmp/", "/var/folders/", "/private/var/", "/private/tmp/"];
const isTempPath = (v) => typeof v === "string" && TMP_PREFIXES.some((p) => v.startsWith(p));

// Sorted keys; drops keys ending in "At" and temp-path sourceUri values.
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v)
      .filter((k) => !k.endsWith("At") && !(k === "sourceUri" && isTempPath(v[k])))
      .sort().map((k) => [k, canon(v[k])]))
  : v;

// Keys are written as `key\tpayload` lines, so pipe/tab/newline/backslash in qnames are escaped (injective).
const ESC = { "|": "\\p", "\\": "\\\\", "\t": "\\t", "\n": "\\n", "\r": "\\r" };
const esc = (s) => s.replace(/[|\\\t\n\r]/g, (c) => ESC[c]);

// ASCII-only lowercase, matching SQLite lower() and the NOCASE collation (JS toLowerCase also folds non-ASCII).
const lc = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

const parseJson = (s, fallback) => { try { return JSON.parse(s || fallback); } catch { return JSON.parse(fallback); } };

/** Bytewise (UTF-8) comparison; matches SQLite BINARY collation. */
export function cmpKey(a, b) {
  if (a === b) return 0;
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Total order: key, then payload (ties only arise from duplicate keys). */
const cmpEntry = (x, y) => cmpKey(x.key, y.key) || cmpKey(x.payload, y.payload);

function openDb(dbPath) {
  // better-sqlite3 does not accept file: URIs, so open plainly read-only (the
  // store is WAL; immutable=1 would ignore uncheckpointed WAL content anyway).
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function* tableEntries(db, t, kind, isNode, orgId, includeSourceHash) {
  const where = orgId ? "WHERE org_id = ?" : "";
  const args = orgId ? [orgId] : [];
  const sh = includeSourceHash && isNode ? ", source_hash h" : "";
  const keyCol = isNode ? "lower(qualified_name)" : "lower(src_qname) || '|' || lower(dst_qname)";
  const sql = isNode
    ? `SELECT qualified_name q, attributes a${sh} FROM "${t}" ${where} ORDER BY ${keyCol}`
    : `SELECT src_qname s, dst_qname d, attributes a FROM "${t}" ${where} ORDER BY ${keyCol}`;
  const probe = isNode
    ? `SELECT 1 FROM "${t}" ${where ? where + " AND" : "WHERE"} (qualified_name GLOB '*[^ -~]*' OR instr(qualified_name, char(92)) > 0 OR instr(qualified_name, '|') > 0) LIMIT 1`
    : `SELECT 1 FROM "${t}" ${where ? where + " AND" : "WHERE"} (src_qname GLOB '*[^ -~]*' OR dst_qname GLOB '*[^ -~]*' OR instr(src_qname, char(92)) > 0 OR instr(dst_qname, char(92)) > 0 OR instr(src_qname, '|') > 0 OR instr(dst_qname, '|') > 0) LIMIT 1`;
  const needsSort = !!db.prepare(probe).get(...args);
  const mk = (r) => {
    const key = isNode ? `n|${kind}|${esc(lc(r.q))}` : `e|${kind}|${esc(lc(r.s))}|${esc(lc(r.d))}`;
    const disp = isNode ? `n|${kind}|${esc(r.q)}` : `e|${kind}|${esc(r.s)}|${esc(r.d)}`;
    const attrs = canon(parseJson(r.a, "{}"));
    const payload = JSON.stringify(r.h !== undefined ? { a: attrs, h: r.h } : attrs);
    return { key, disp, payload };
  };
  const it = db.prepare(sql).iterate(...args);
  if (needsSort) {
    const all = [];
    for (const r of it) all.push(mk(r));
    all.sort(cmpEntry);
    yield* all;
  } else {
    for (const r of it) yield mk(r);
  }
}

/**
 * Canonical entries {key, disp, payload} in global sorted order.
 * key is lowercased (matching); disp keeps stored case (display).
 * opts: {orgId, includeSourceHash}
 */
export function* dumpEntries(dbPath, opts = {}) {
  const { orgId, includeSourceHash = false } = opts;
  const db = openDb(dbPath);
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '\\_sfg\\_n\\_%' ESCAPE '\\' OR name LIKE '\\_sfg\\_e\\_%' ESCAPE '\\')").all().map((r) => r.name);
    const tables = names.map((t) => {
      const isNode = t.startsWith("_sfg_n_");
      const kind = t.slice(7);
      return { t, isNode, kind, prefix: `${isNode ? "n" : "e"}|${kind}|` };
    }).sort((x, y) => cmpKey(x.prefix, y.prefix));

    let prev = "";
    const check = (e, where) => {
      if (prev !== "" && cmpKey(prev, e.key) > 0) throw new Error(`graph-dump: stream not sorted in ${where}: ${JSON.stringify(prev)} > ${JSON.stringify(e.key)}`);
      prev = e.key;
      return e;
    };

    const hasDead = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_sfgraph_dead_code_scores'").get();
    if (hasDead) {
      const rows = db.prepare(`SELECT qualified_name q, confidence c, reasons r FROM _sfgraph_dead_code_scores ${orgId ? "WHERE org_id = ?" : ""}`).all(...(orgId ? [orgId] : []));
      const es = rows.map((r) => ({
        key: `d|${esc(lc(r.q))}`, disp: `d|${esc(r.q)}`,
        payload: JSON.stringify({ c: r.c, r: parseJson(r.r, "[]").slice().sort() }),
      })).sort(cmpEntry);
      for (const e of es) yield check(e, "dead-code scores");
    }
    // 'e' tables sort before 'n' tables bytewise; the dead-code block ('d') is already emitted first.
    for (const { t, isNode, kind } of tables) {
      for (const e of tableEntries(db, t, kind, isNode, orgId, includeSourceHash)) yield check(e, t);
    }
  } finally {
    db.close();
  }
}

/** Sorted `key\tpayload` lines. */
export function* dumpLines(dbPath, opts = {}) {
  for (const e of dumpEntries(dbPath, opts)) yield `${e.key}\t${e.payload}`;
}

/** Async-iterable alias matching the planned interface. */
export async function* dumpGraph(dbPath, opts = {}) { yield* dumpLines(dbPath, opts); }

/** Entries from a .jsonl dump (key\tpayload per line; display key is the lowercased key). */
async function* jsonlEntries(p) {
  const rl = createInterface({ input: createReadStream(p, { encoding: "utf8" }), crlfDelay: Infinity });
  let prev = "";
  for await (const line of rl) {
    if (!line) continue;
    const i = line.indexOf("\t");
    const key = line.slice(0, i);
    if (prev !== "" && cmpKey(prev, key) > 0) throw new Error(`graph-dump: ${p} is not sorted at ${JSON.stringify(key)}`);
    prev = key;
    yield { key, disp: key, payload: line.slice(i + 1) };
  }
}

async function* entriesOf(src, opts) {
  if (src.endsWith(".jsonl")) yield* jsonlEntries(src);
  else yield* dumpEntries(src, opts);
}

function tally(stats, key) {
  const p = key.split("|");
  if (p[0] === "n") { stats.nodes++; stats.byLabel[p[1]] = (stats.byLabel[p[1]] || 0) + 1; }
  else if (p[0] === "e") { stats.edges++; stats.byRel[p[1]] = (stats.byRel[p[1]] || 0) + 1; }
  else stats.dead++;
}

/** Consume an entry stream, returning {hash, nodes, edges, dead, byLabel, byRel}; calls onLine(line) per line. */
export async function hashEntries(entries, onLine) {
  const h = createHash("sha256");
  const stats = { hash: "", nodes: 0, edges: 0, dead: 0, byLabel: {}, byRel: {} };
  for await (const e of entries) {
    const line = `${e.key}\t${e.payload}`;
    h.update(line); h.update("\n");
    tally(stats, e.key);
    if (onLine) onLine(line);
  }
  stats.hash = h.digest("hex");
  return stats;
}

export function hashGraph(dbPath, opts = {}) {
  return hashEntries(entriesOf(dbPath, opts));
}

/** Diff two graphs (sqlite or .jsonl) by sorted merge; never holds a whole graph in memory. */
export async function diffGraphs(a, b, opts = {}) {
  const ia = entriesOf(a, opts)[Symbol.asyncIterator]();
  const ib = entriesOf(b, opts)[Symbol.asyncIterator]();
  const added = [], removed = [], changed = [];
  const by = { added: {}, removed: {}, changed: {} };
  const bump = (kind, key) => { const p = key.split("|"); const g = p[0] === "d" ? "d" : `${p[0]}|${p[1]}`; by[kind][g] = (by[kind][g] || 0) + 1; };
  let x = await ia.next(), y = await ib.next();
  let same = 0;
  while (!x.done || !y.done) {
    const c = x.done ? 1 : y.done ? -1 : cmpKey(x.value.key, y.value.key);
    if (c < 0) { removed.push(x.value.disp); bump("removed", x.value.key); x = await ia.next(); }
    else if (c > 0) { added.push(y.value.disp); bump("added", y.value.key); y = await ib.next(); }
    else {
      if (x.value.payload !== y.value.payload) { changed.push(x.value.disp); bump("changed", x.value.key); } else same++;
      x = await ia.next(); y = await ib.next();
    }
  }
  return {
    added, removed, changed,
    summary: { added: added.length, removed: removed.length, changed: changed.length, same, identical: !added.length && !removed.length && !changed.length, by },
  };
}
