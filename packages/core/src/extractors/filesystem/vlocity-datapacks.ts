import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { METADATA_CATEGORY } from "../../domain/metadata-category.js";
import type { IndexedMember, RawMember } from "../interfaces/metadata-source.js";
import { memberNameFor, normaliseRow, tryParseJsonField } from "../vlocity-shared/row.js";

export interface DataPackReport {
  skipped: Array<{ path: string; reason: string }>;
  types: Record<string, number>;
}

const NS = "%vlocity_namespace%";
export const EPC_SKIP = new Set([
  "Product2",
  "PriceList",
  "Pricebook2",
  "PricingPlan",
  "PricingVariable",
  "Promotion",
  "AttributeCategory",
  "ProductChildItem",
  "AttributeAssignment",
  "PriceListEntry",
]);
const LOOKUP_TYPES = new Set(["VlocityLookupMatchingKeyObject", "VlocityMatchingKeyObject"]);

async function readJson(p: string): Promise<unknown> {
  return JSON.parse(await readFile(p, "utf8"));
}

async function subdirs(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** Normalise an inlined child record (Element / DRMapItem) and drop lookup-object keys. */
function normaliseChild(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const out = normaliseRow(v as Record<string, unknown>, NS);
  for (const [k, val] of Object.entries(out)) {
    if (
      val &&
      typeof val === "object" &&
      LOOKUP_TYPES.has(String((val as Record<string, unknown>).VlocityDataPackType))
    ) {
      delete out[k];
    }
  }
  return out;
}

export interface DataPackOptions {
  /** Package namespace `%vlocity_namespace%` stands for (e.g. `vlocity_cmt`);
   *  null/undefined leaves the token in place. */
  vlocityNamespace?: string | null;
}

/** Replace the `%vlocity_namespace%` token in a row's string values (object
 *  and field API names in DRMapItem rows) with the real package namespace,
 *  so DataRaptor field targets match the source tree's CustomField qnames. */
function substituteNamespace(v: unknown, ns: string): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = typeof val === "string" && val.includes(NS) ? val.split(NS).join(ns) : val;
  }
  return out;
}

/** Walk `<datapacksRoot>/<Type>/<Key>/<Key>_DataPack.json`, inline sibling
 *  JSON references one level deep, and yield rows shaped like the live-org
 *  Vlocity runner's output so the existing parsers run unchanged. */
export async function* iterDataPacks(
  root: string,
  report: DataPackReport = { skipped: [], types: {} },
  opts: DataPackOptions = {},
): AsyncIterable<RawMember> {
  for await (const e of indexDataPacks(root, report, opts)) {
    const m = await e.load();
    if (m) yield m;
  }
}

/**
 * Task 11c: the packs as index entries. Enumeration reads directories and
 * stats files only: the key is the pack's sourceUri (`file://<..._DataPack.json>`)
 * and the fingerprint covers every file in the pack folder plus the
 * namespace substituted into it. `load()` reads and normalises the pack
 * (null when it is malformed; the reason is added to `report`).
 */
export async function* indexDataPacks(
  root: string,
  report: DataPackReport = { skipped: [], types: {} },
  opts: DataPackOptions = {},
): AsyncIterable<IndexedMember> {
  const ns = opts.vlocityNamespace ?? null;
  for (const type of await subdirs(root)) {
    if (EPC_SKIP.has(type)) continue;
    const typeDir = path.join(root, type);
    for (const key of await subdirs(typeDir)) {
      const dir = path.join(typeDir, key);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (e) {
        report.skipped.push({ path: dir, reason: `unreadable: ${(e as Error).message}` });
        continue;
      }
      const files = new Set(names);
      const packName = files.has(`${key}_DataPack.json`)
        ? `${key}_DataPack.json`
        : [...files].filter((f) => f.endsWith("_DataPack.json")).sort()[0];
      if (!packName) {
        report.skipped.push({ path: dir, reason: "no _DataPack.json" });
        continue;
      }
      const packPath = path.join(dir, packName);
      const parts: string[] = [`ns=${ns ?? ""}`];
      for (const f of [...names].sort()) {
        try {
          const st = await stat(path.join(dir, f));
          if (st.isFile()) parts.push(`${f}:${st.size}:${st.mtimeMs}`);
        } catch {
          parts.push(`${f}:?`);
        }
      }
      yield {
        key: `file://${packPath}`,
        memberType: type,
        fingerprint: parts.join("|"),
        load: () => loadPack(type, dir, files, packName, packPath, ns, report),
      };
    }
  }
}

async function loadPack(
  type: string,
  dir: string,
  files: Set<string>,
  packName: string,
  packPath: string,
  ns: string | null,
  report: DataPackReport,
): Promise<RawMember | null> {
  let row: Record<string, unknown>;
  try {
    const parsed = await readJson(packPath);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    row = parsed as Record<string, unknown>;
  } catch (e) {
    report.skipped.push({ path: packPath, reason: `malformed: ${(e as Error).message}` });
    return null;
  }
  const inlined = new Set<string>();
  const inline = async (v: unknown): Promise<unknown> => {
    if (typeof v === "string" && v.endsWith(".json") && v !== packName && files.has(v)) {
      inlined.add(v);
      try {
        return await readJson(path.join(dir, v));
      } catch {
        return v; // missing/malformed sibling: keep the filename string
      }
    }
    return v;
  };
  for (const [k, v] of Object.entries(row)) {
    if (Array.isArray(v)) {
      row[k] = (await Promise.all(v.map(inline))).map(normaliseChild);
    } else {
      const inl = await inline(v);
      row[k] = Array.isArray(inl) ? inl.map(normaliseChild) : inl;
    }
  }
  const out = normaliseRow(row, NS);
  // Orphan element files: `*_Element_*.json` siblings the pack's Element
  // list does not name are still elements of this OmniScript/IP.
  if (type === "OmniScript" || type === "IntegrationProcedure") {
    const orphans = [...files]
      .filter((f) => /_Element_.*\.json$/.test(f) && f !== packName && !inlined.has(f))
      .sort();
    if (orphans.length > 0) {
      const els: unknown[] = Array.isArray(out.Element) ? [...out.Element] : [];
      for (const f of orphans) {
        try {
          const parsed = await readJson(path.join(dir, f));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            els.push(normaliseChild(parsed));
        } catch (e) {
          report.skipped.push({
            path: path.join(dir, f),
            reason: `malformed orphan element: ${(e as Error).message}`,
          });
        }
      }
      out.Element = els;
    }
  }
  if ((type === "OmniScript" || type === "IntegrationProcedure") && Array.isArray(out.Element)) {
    out.elements = out.Element;
  }
  if (type === "DataRaptor" && Array.isArray(out.DRMapItem)) {
    if (ns) out.DRMapItem = out.DRMapItem.map((r) => substituteNamespace(r, ns));
    out.elements = out.DRMapItem;
  }
  if (type === "VlocityCard" && typeof out.Definition === "string") {
    out.Definition = tryParseJsonField(out.Definition);
  }
  report.types[type] = (report.types[type] ?? 0) + 1;
  const memberName = memberNameFor(type, out, () =>
    report.skipped.push({ path: packPath, reason: "nameFallback: missing Type/SubType" }),
  );
  return {
    ref: {
      category: METADATA_CATEGORY.VLOCITY,
      memberType: type,
      memberName,
      lastModifiedAt: "",
      sourceUri: `file://${packPath}`,
      namespace: null,
    },
    content: JSON.stringify(out),
  };
}
