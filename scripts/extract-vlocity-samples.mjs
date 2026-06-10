// Extract a sample dataset for each Vlocity DataPack type from the live org,
// for development on the main machine. Reuses the tool's vendored
// QueryDefinitions to know each type's SObject + filter, but swaps the SELECT
// list for FIELDS(ALL) so we capture the COMPLETE record structure (every
// field) of a few real records — exactly what a dev needs to build/extend a
// parser for that type. Writes one JSON file per type + a manifest.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const ORG = "PLDT_DEV_Anshul";
const NS = "vlocity_cmt";
const OUT = `${process.env.HOME}/Desktop/sfgraph-capture/vlocity-samples`;
const PER_TYPE = 2;
mkdirSync(OUT, { recursive: true });

const yml = readFileSync(
  new URL("../packages/core/src/extractors/live-org/vlocity/query-definitions.yml", import.meta.url),
  "utf8",
);

// Parse "<Key>:\n  VlocityDataPackType: X\n  query: <maybe multi-line>"
const blocks = yml.split(/\n(?=[A-Za-z0-9_]+:\n)/);
const defs = [];
for (const b of blocks) {
  const type = b.match(/VlocityDataPackType:\s*([A-Za-z0-9_]+)/)?.[1];
  let query = b.match(/query:\s*([\s\S]*?)(?=\n[A-Za-z0-9_]+:\n|\n*$)/)?.[1];
  if (!type || !query) continue;
  query = query.replace(/\s+/g, " ").trim().replace(/%vlocity_namespace%/g, NS);
  const obj = query.match(/from\s+([A-Za-z0-9_]+)/i)?.[1];
  if (!obj) continue;
  // Keep any WHERE filter (e.g. IsProcedure=true distinguishes IP from OmniScript)
  const where = query.match(/\bwhere\b([\s\S]*)$/i)?.[1]?.trim();
  let soql = `SELECT FIELDS(ALL) FROM ${obj}`;
  if (where) soql += ` WHERE ${where}`;
  soql += ` LIMIT ${PER_TYPE}`;
  defs.push({ type, obj, soql });
}

const manifest = [];
for (const d of defs) {
  let status = "ok";
  let records = [];
  try {
    const out = execFileSync(
      "sf",
      ["data", "query", "-o", ORG, "-q", d.soql, "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
    );
    const parsed = JSON.parse(out);
    records = (parsed.result?.records ?? []).map((r) => {
      const { attributes, ...rest } = r;
      return rest;
    });
    if (records.length === 0) status = "empty";
  } catch (e) {
    status = "error:" + String(e.message || e).split("\n")[0].slice(0, 80);
  }
  const file = `${OUT}/${d.type}.json`;
  writeFileSync(
    file,
    JSON.stringify({ type: d.type, sobject: d.obj, soql: d.soql, count: records.length, records }, null, 2),
  );
  manifest.push({ type: d.type, sobject: d.obj, status, sampled: records.length });
  console.log(`${status === "ok" ? "✓" : status === "empty" ? "∅" : "✗"} ${d.type.padEnd(28)} ${d.obj.padEnd(42)} ${records.length} rec`);
}
writeFileSync(`${OUT}/_manifest.json`, JSON.stringify({ org: ORG, namespace: NS, perType: PER_TYPE, types: manifest }, null, 2));
console.log(`\nTotal types: ${manifest.length} | ok: ${manifest.filter(m=>m.status==='ok').length} | empty: ${manifest.filter(m=>m.status==='empty').length} | error: ${manifest.filter(m=>m.status.startsWith('error')).length}`);
console.log("written to", OUT);
