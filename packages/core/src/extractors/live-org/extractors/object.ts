import { XMLBuilder } from "fast-xml-parser";
import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleData, scheduleQuery } from "../rate-limit.js";

const xml = new XMLBuilder({ ignoreAttributes: false, format: false, suppressEmptyNode: true });

interface SObjectGlobal {
  name: string;
  label?: string;
  custom?: boolean;
  customSetting?: boolean;
  createable?: boolean;
  queryable?: boolean;
  deprecatedAndHidden?: boolean;
  keyPrefix?: string | null;
}

interface FieldDescribe {
  name: string;
  label?: string;
  type?: string;
  length?: number;
  precision?: number;
  scale?: number;
  unique?: boolean;
  externalId?: boolean;
  nillable?: boolean;
  custom?: boolean;
  referenceTo?: string[];
  relationshipName?: string | null;
  picklistValues?: Array<{ value: string; label?: string; active?: boolean }>;
  calculatedFormula?: string | null;
  inlineHelpText?: string | null;
}

/** Internal entities that describeGlobal returns but have no useful metadata
 *  for our graph (system tables, audit tables, etc.). */
const SKIP_PATTERNS = [
  /__History$/, // history audit tables
  /__Tag$/,
  /__Feed$/,
  /__Share$/, // sharing tables
  /__ChangeEvent$/,
  /__b$/, // big objects (separate handling)
];

function shouldIncludeSObject(s: SObjectGlobal): boolean {
  if (!s.name) return false;
  if (s.deprecatedAndHidden) return false;
  if (!s.queryable) return false;
  for (const re of SKIP_PATTERNS) {
    if (re.test(s.name)) return false;
  }
  return true;
}

/**
 * Iterate every SObject visible to the current user. Uses `describeGlobal()`
 * to enumerate + `sobject(name).describe()` per object to fetch the field
 * map. Works universally for any user with record-read access — no Metadata
 * API permissions, no EntityDefinition Tooling quirks.
 *
 * Each yielded RawMember has content = JSON-stringified envelope matching
 * what the CustomObject parser expects (object-level props + fields list).
 * The parser can derive CustomObject + CustomField nodes from this.
 */
export async function* iterObject(conn: any): AsyncIterable<RawMember> {
  let global: { sobjects?: SObjectGlobal[] } | null = null;
  try {
    global = (await scheduleQuery(() => conn.describeGlobal())) as {
      sobjects?: SObjectGlobal[];
    };
  } catch {
    return; // describeGlobal failed; let fail-soft catch it
  }
  const all = global?.sobjects ?? [];
  const included = all.filter(shouldIncludeSObject);

  const debug = process.env.SFGRAPH_DEBUG_INGEST === "1";
  // SFGRAPH_SKIP_SOBJECT=name1,name2,... lets users work around a specific
  // SObject whose describe crashes jsforce (same failure mode as managed-
  // package LWC bundles — silent SIGKILL on macOS 26+, no error in any
  // log). Skipped objects don't appear in the graph at all.
  const skipSet = new Set(
    (process.env.SFGRAPH_SKIP_SOBJECT ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

  if (debug) {
    console.log(
      `ingest: [debug] object total=${included.length} (filtered from ${all.length}) skip=${skipSet.size}`,
    );
  }

  // Fan out describe() in parallel chunks. Bottleneck's data pool throttles
  // actual concurrency to maxConcurrent (default 10). Was strictly serial:
  // 200 SObjects * ~500ms each = ~100s. With 10-way parallel: ~10s.
  // Chunk size matches a generous ceiling above the pool size so the pool
  // is the real bottleneck, not the chunk barrier.
  const CHUNK = 25;
  for (let i = 0; i < included.length; i += CHUNK) {
    const slice = included.slice(i, i + CHUNK).filter((s) => {
      if (skipSet.has(s.name)) {
        if (debug) console.log(`ingest: [debug] object skip ${s.name} (in SFGRAPH_SKIP_SOBJECT)`);
        return false;
      }
      return true;
    });
    if (debug) {
      console.log(
        `ingest: [debug] object chunk ← ${slice.map((s) => s.name).join(",")}`,
      );
    }
    const descs: Array<{ s: SObjectGlobal; desc: any }> = await Promise.all(
      slice.map(async (s) => {
        try {
          if (debug) console.log(`ingest: [debug] object describe ← ${s.name}`);
          const d = await scheduleData(() => conn.sobject(s.name).describe());
          if (debug)
            console.log(
              `ingest: [debug] object describe ✓ ${s.name} fields=${(d as { fields?: unknown[] })?.fields?.length ?? 0}`,
            );
          return { s, desc: d };
        } catch (e) {
          if (debug)
            console.log(
              `ingest: [debug] object describe ✗ ${s.name}: ${(e as Error)?.message ?? "(unknown)"}`,
            );
          return { s, desc: null };
        }
      }),
    );
    for (const { s, desc } of descs) {
      if (!desc) continue;
      const fields: FieldDescribe[] = Array.isArray(desc?.fields) ? desc.fields : [];

    // Build the CustomObject-shaped envelope expected by the Phase-2 Object
    // parser (which already knows how to walk this structure).
    const objectXml = xml.build({
      CustomObject: {
        fullName: s.name,
        label: desc?.label ?? s.label ?? s.name,
        pluralLabel: desc?.labelPlural ?? null,
        sharingModel: desc?.sharingModel ?? null,
        customSettingsType: s.customSetting ? "List" : null,
        enableHistory: Boolean(desc?.replicateable),
        description: desc?.description ?? null,
        fields: fields.map((f) => ({
          fullName: f.name,
          label: f.label ?? f.name,
          type: f.type ?? "Text",
          length: f.length,
          precision: f.precision,
          scale: f.scale,
          unique: f.unique,
          externalId: f.externalId,
          required: f.nillable === false,
          custom: f.custom,
          referenceTo: f.referenceTo ?? [],
          relationshipName: f.relationshipName ?? null,
          formula: f.calculatedFormula ?? null,
          description: f.inlineHelpText ?? null,
          picklistValues: f.picklistValues ?? [],
        })),
      },
    });

    yield {
      ref: {
        category: METADATA_CATEGORY.OBJECT,
        memberType: "CustomObject",
        memberName: s.name,
        lastModifiedAt: null,
        sourceUri: `sf://describe/${s.name}`,
        namespace: null,
      },
      content: typeof objectXml === "string" ? objectXml : String(objectXml),
    };
    }
  }
}
