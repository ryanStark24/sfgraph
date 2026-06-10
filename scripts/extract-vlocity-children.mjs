// Supplement the per-type Vlocity samples with (a) Product2 (missed by the
// yml parser due to trailing whitespace) and (b) the CHILD objects that hold
// the real content a parser must understand: DRMapItem (DataRaptor field
// mappings — the P2 gap) and Element (OmniScript / IntegrationProcedure /
// VlocityCard step trees). FIELDS(ALL) captures every field of real records.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const ORG = "PLDT_DEV_Anshul";
const OUT = `${process.env.HOME}/Desktop/sfgraph-capture/vlocity-samples`;

const extras = [
  { type: "Product2", soql: "SELECT FIELDS(ALL) FROM Product2 LIMIT 2" },
  {
    type: "_child_DRMapItem",
    note: "DataRaptor field-level mappings (child of DRBundle). The ingest's P2 skip was here — these records ARE fetchable via FIELDS(ALL).",
    soql: "SELECT FIELDS(ALL) FROM vlocity_cmt__DRMapItem__c LIMIT 15",
  },
  {
    type: "_child_Element",
    note: "OmniScript / IntegrationProcedure / VlocityCard step elements (the actual component tree).",
    soql: "SELECT FIELDS(ALL) FROM vlocity_cmt__Element__c LIMIT 15",
  },
];

for (const e of extras) {
  let records = [];
  let status = "ok";
  try {
    const out = execFileSync("sf", ["data", "query", "-o", ORG, "-q", e.soql, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    records = (JSON.parse(out).result?.records ?? []).map(({ attributes, ...r }) => r);
    if (!records.length) status = "empty";
  } catch (err) {
    status = "error:" + String(err.message || err).split("\n")[0].slice(0, 80);
  }
  writeFileSync(
    `${OUT}/${e.type}.json`,
    JSON.stringify({ type: e.type, note: e.note, soql: e.soql, count: records.length, records }, null, 2),
  );
  console.log(`${status === "ok" ? "✓" : status === "empty" ? "∅" : "✗"} ${e.type.padEnd(20)} ${records.length} rec  ${status.startsWith("error") ? status : ""}`);
}
