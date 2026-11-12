import { type OrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { XMLBuilder } from "fast-xml-parser";
import { METADATA_CATEGORY } from "../domain/index.js";
import type { RawMember } from "../extractors/interfaces/metadata-source.js";
import {
  DESCRIBE_GLOBAL_TIMEOUT_MS,
  scheduleData,
  scheduleQuery,
  soqlWithTimeout,
  withTimeout,
} from "../extractors/live-org/rate-limit.js";
import { type RetryOptions, withRetry } from "../extractors/live-org/retry.js";
import { GENERIC_REFS_ATTR } from "../parsers/generic/generic-ref-resolver.js";
import type { GenericRefCandidate } from "../parsers/generic/ref-scanner.js";
import type { GraphStore } from "../storage/interfaces.js";

/**
 * Reference-driven object recovery. The object extractor gates which SObjects
 * it describes (companion tables, big objects, system tables, an
 * EntityDefinition classification); a gate can drop an object that code, flows
 * or metadata in the org nevertheless reference. After the fan-out this step
 * finds SObject names that something references (edge targets that have no
 * node, and generic-scanner candidates) but that have no CustomObject node,
 * checks them against the org's describeGlobal list and describes at most
 * SFGRAPH_RECOVER_OBJECTS_MAX of them (default 50) through the same
 * rate-limited data pool and 12 s per-describe timeout as the object extractor.
 *
 * Cost: nothing when no reference points at a missing object (no API call);
 * otherwise one describeGlobal plus at most `max` describes.
 * Default on; SFGRAPH_RECOVER_OBJECTS=0 turns it off.
 */

export const RECOVER_OBJECTS_DEFAULT_MAX = 50;
const DESCRIBE_TIMEOUT_MS = 12_000;
const CONCURRENCY = 4;
/** Referenced-name collection stops here (a pathological org cannot grow it). */
const MAX_REFERENCED = 5000;
const DANGLING_SCAN_LIMIT = 200_000;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export function recoverObjectsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.SFGRAPH_RECOVER_OBJECTS?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

export function recoverObjectsMax(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.SFGRAPH_RECOVER_OBJECTS_MAX ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : RECOVER_OBJECTS_DEFAULT_MAX;
}

export interface RecoverObjectsResult {
  /** Distinct object names referenced but missing as nodes. */
  missing: number;
  recovered: string[];
  /** Missing names the org does not list in describeGlobal (not real SObjects). */
  notInOrg: number;
  /** Describes that failed or timed out. */
  failed: number;
  /** Names left undescribed by the cap. */
  capped: number;
  /** Names the developer excluded with SFGRAPH_SKIP_SOBJECT. */
  userSkipped: number;
  /** The one summary line (empty when nothing referenced a missing object). */
  summary: string;
}

const EMPTY: RecoverObjectsResult = {
  missing: 0,
  recovered: [],
  notInOrg: 0,
  failed: 0,
  capped: 0,
  userSkipped: 0,
  summary: "",
};

type ProbeStore = GraphStore & {
  existingQnamesNocase?(orgId: OrgId, qnames: Iterable<string>): Set<string>;
  findNodesMentioning?(orgId: OrgId, needles: readonly string[]): Set<string>;
};

/** `CustomObject:X` / `CustomField:X.F` -> `X`, else null. */
function objectNameOfQname(q: string): string | null {
  if (q.startsWith("CustomObject:")) return q.slice("CustomObject:".length);
  if (q.startsWith("CustomField:")) {
    const rest = q.slice("CustomField:".length);
    const dot = rest.indexOf(".");
    return dot > 0 ? rest.slice(0, dot) : null;
  }
  return null;
}

/** Object names that edges point at but that have no node (ordered, deduped). */
function referencedFromDanglingEdges(store: GraphStore, orgId: OrgId, out: Set<string>): void {
  const add = (dst: string): void => {
    if (out.size >= MAX_REFERENCED) return;
    const n = objectNameOfQname(dst);
    if (n && NAME_RE.test(n)) out.add(n);
  };
  if (typeof store.iterateDanglingEdges === "function") {
    const it = store.iterateDanglingEdges(orgId, DANGLING_SCAN_LIMIT);
    try {
      for (const row of it) add(String(row.dst));
    } finally {
      (it as { return?: () => unknown }).return?.();
    }
    return;
  }
  for (const e of store.listDanglingEdges(orgId, DANGLING_SCAN_LIMIT)) {
    add(String(e.dstQualifiedName));
  }
}

/** Object names the generic scanner found in members of types without a parser. */
function referencedFromScanner(store: ProbeStore, orgId: OrgId, out: Set<string>): void {
  if (typeof store.findNodesMentioning !== "function") return;
  for (const q of store.findNodesMentioning(orgId, [GENERIC_REFS_ATTR])) {
    if (out.size >= MAX_REFERENCED) return;
    const node = store.getNode(orgId, asQualifiedName(q));
    const refs = (node?.attributes as Record<string, unknown> | undefined)?.[GENERIC_REFS_ATTR];
    if (!Array.isArray(refs)) continue;
    for (const r of refs as GenericRefCandidate[]) {
      if (r.k === "object" || r.k === "name") {
        if (NAME_RE.test(r.n)) out.add(r.n);
      } else if (r.k === "field") {
        const o = r.n.split(".")[0] ?? "";
        if (NAME_RE.test(o)) out.add(o);
      }
    }
  }
}

function existingObjects(store: ProbeStore, orgId: OrgId, names: string[]): Set<string> {
  const have = new Set<string>();
  if (typeof store.existingQnamesNocase === "function") {
    for (const q of store.existingQnamesNocase(
      orgId,
      names.map((n) => `CustomObject:${n}`),
    )) {
      have.add(q.slice("CustomObject:".length).toLowerCase());
    }
    return have;
  }
  for (const n of names) {
    if (store.getNode(orgId, asQualifiedName(`CustomObject:${n}`))) have.add(n.toLowerCase());
  }
  return have;
}

const xml = new XMLBuilder({ ignoreAttributes: false, format: false, suppressEmptyNode: true });

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

/**
 * The CustomObject-shaped envelope the object parser reads: the same one
 * `iterObject` (extractors/object.ts) builds from a describe, so a recovered
 * object is parsed exactly like a normally-extracted one.
 */
export function buildObjectEnvelope(
  s: { name: string; label?: string; customSetting?: boolean },
  desc: any,
): string {
  const fields: FieldDescribe[] = Array.isArray(desc?.fields) ? desc.fields : [];
  const built = xml.build({
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
  return typeof built === "string" ? built : String(built);
}

export interface RecoverObjectsOpts {
  conn: any;
  graph: GraphStore;
  orgId: OrgId;
  retry?: RetryOptions;
  max?: number;
  env?: NodeJS.ProcessEnv;
  /** Merge one recovered object (parse + write), on the main thread. */
  apply(member: RawMember): Promise<void> | void;
  logger?: { info(m: string, c?: unknown): void; warn(m: string, c?: unknown): void };
}

export async function recoverReferencedObjects(
  opts: RecoverObjectsOpts,
): Promise<RecoverObjectsResult> {
  const env = opts.env ?? process.env;
  const max = opts.max ?? recoverObjectsMax(env);
  const store = opts.graph as ProbeStore;

  const referenced = new Set<string>();
  referencedFromDanglingEdges(store, opts.orgId, referenced);
  referencedFromScanner(store, opts.orgId, referenced);
  if (referenced.size === 0) return EMPTY;
  const have = existingObjects(store, opts.orgId, [...referenced]);
  const skipSet = new Set(
    (env.SFGRAPH_SKIP_SOBJECT ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  let userSkipped = 0;
  const missing: string[] = [];
  for (const n of referenced) {
    if (have.has(n.toLowerCase())) continue;
    if (skipSet.has(n.toLowerCase())) {
      userSkipped += 1;
      continue;
    }
    missing.push(n);
  }
  if (missing.length === 0) return EMPTY;

  // One describeGlobal: only names the org lists are real SObjects.
  const global = (await withRetry(
    () =>
      scheduleQuery(() =>
        soqlWithTimeout(opts.conn.describeGlobal(), "describeGlobal", DESCRIBE_GLOBAL_TIMEOUT_MS),
      ),
    opts.retry ?? {},
  )) as {
    sobjects?: Array<{
      name: string;
      label?: string;
      customSetting?: boolean;
      deprecatedAndHidden?: boolean;
    }>;
  } | null;
  const byLower = new Map<string, { name: string; label?: string; customSetting?: boolean }>();
  for (const s of global?.sobjects ?? []) {
    if (s?.name && !s.deprecatedAndHidden) byLower.set(s.name.toLowerCase(), s);
  }
  const inOrg = missing.map((n) => byLower.get(n.toLowerCase())).filter((s) => s !== undefined);
  const notInOrg = missing.length - inOrg.length;
  const todo = inOrg.slice(0, max);
  const capped = inOrg.length - todo.length;

  const recovered: string[] = [];
  let failed = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const s = todo[next++];
      if (!s) return;
      try {
        const desc = await withRetry(
          () =>
            scheduleData(() =>
              withTimeout(opts.conn.sobject(s.name).describe(), DESCRIBE_TIMEOUT_MS, s.name),
            ),
          opts.retry ?? {},
        );
        if (!desc) {
          failed += 1;
          continue;
        }
        await opts.apply({
          ref: {
            category: METADATA_CATEGORY.OBJECT,
            memberType: "CustomObject",
            memberName: s.name,
            lastModifiedAt: null,
            sourceUri: `sf://describe/${s.name}`,
            namespace: null,
          },
          content: buildObjectEnvelope(s, desc),
        });
        recovered.push(s.name);
      } catch (e) {
        failed += 1;
        opts.logger?.warn("recover-objects: describe failed", {
          name: s.name,
          err: (e as Error).message,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, () => worker()));

  const parts = [
    `${recovered.length} recovered`,
    `${notInOrg} not an SObject in this org`,
    ...(failed ? [`${failed} failed`] : []),
    ...(capped ? [`${capped} over the cap of ${max} (SFGRAPH_RECOVER_OBJECTS_MAX)`] : []),
    ...(userSkipped ? [`${userSkipped} in SFGRAPH_SKIP_SOBJECT`] : []),
  ];
  const summary = `recover-objects: ${missing.length + userSkipped} referenced object(s) had no node: ${parts.join(", ")}${
    recovered.length
      ? ` [${recovered.slice(0, 10).join(", ")}${recovered.length > 10 ? ", …" : ""}]`
      : ""
  }`;
  return { missing: missing.length, recovered, notInOrg, failed, capped, userSkipped, summary };
}
