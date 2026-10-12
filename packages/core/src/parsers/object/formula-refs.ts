import { STANDARD_SOBJECT_WHITELIST } from "../../domain/index.js";

/**
 * Field references in a formula (formula field, validation rule), resolved
 * against the object the formula lives on.
 *
 *  - bare `Phone__c` / `Name` → the current object's field. A bare name counts
 *    when it is a field we know on this object, or carries the `__c` suffix.
 *  - `Rel__r.F` / `Rel.F` → the lookup field on this object (a real read) and,
 *    when the lookup has exactly one `referenceTo`, `Target.F`. Longer chains
 *    stop after the first hop: the parser only knows this object's fields
 *    (the same no-guess rule as the DataRaptor relationship resolver).
 *    Without a known lookup, a standard SObject relationship name falls back
 *    to the naming convention (`Account.Name` → `Account.Name`); anything
 *    else (`Owner.X`, `CreatedBy.X`) emits nothing rather than a fake object.
 *  - `$Setup.S__c.F`, `$CustomMetadata.T__mdt.Rec.F` → `S__c.F` / `T__mdt.F`;
 *    `$User.F`, `$Profile.F`, `$Organization.F` → that object's field;
 *    `$Label.X` → a CustomLabel reference. Other `$` globals are skipped.
 *
 * Function names (an identifier followed by `(`), string literals and the
 * literals TRUE/FALSE/NULL are never fields.
 */
export interface FormulaFieldInfo {
  apiName: string;
  referenceTo: string[];
  relationshipName: string | null;
}

export interface FormulaRefs {
  /** `Object.Field` targets of READS_FIELD (deduped, original case). */
  fields: string[];
  /** CustomLabel names referenced through `$Label`. */
  labels: string[];
  /**
   * Second-hop targets guessed by convention (`Target.X__c` for `X__r`)
   * because the target object's fields are unknown here, keyed by the
   * emitted `Object.Field` -> the relationship name read (`X__r`). The
   * post-merge formula hop resolver swaps in the field that declares it.
   */
  hops: Record<string, string>;
}

const STANDARD_BY_LOWER = new Map(
  [...STANDARD_SOBJECT_WHITELIST].map((n) => [n.toLowerCase(), n] as const),
);
const LITERALS = new Set(["true", "false", "null"]);
const GLOBAL_OBJECT: Record<string, string> = {
  $user: "User",
  $profile: "Profile",
  $organization: "Organization",
};
/**
 * Standard audit relationships that formula syntax always resolves to User. A
 * queue-ownable owner must be written `Owner:Queue.X` / `Owner:User.X`, so a
 * bare `Owner.` hop is deterministic. Maps relationship -> lookup field.
 */
const USER_RELATIONSHIPS: Record<string, string> = {
  owner: "OwnerId",
  createdby: "CreatedById",
  lastmodifiedby: "LastModifiedById",
};
/** The lookup field behind a relationship name: `X__r` -> `X__c`, `Manager` -> `ManagerId`. */
function relationshipField(rel: string): string {
  return /__r$/i.test(rel) ? `${rel.slice(0, -3)}__c` : `${rel}Id`;
}
const PATH_RE = /\$?[A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*/g;

/** Blank out string literals and `/* *\/` comments in one left-to-right pass. */
function stripStrings(formula: string): string {
  return formula.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/\*[\s\S]*?(?:\*\/|$)/g, (s) =>
    " ".repeat(s.length),
  );
}

export function formulaFieldRefs(
  formula: string,
  objectApiName: string,
  fields: ReadonlyArray<FormulaFieldInfo>,
): FormulaRefs {
  const byName = new Map<string, FormulaFieldInfo>();
  const byRel = new Map<string, FormulaFieldInfo>();
  for (const f of fields) {
    byName.set(f.apiName.toLowerCase(), f);
    if (f.relationshipName) byRel.set(f.relationshipName.toLowerCase(), f);
  }
  const out = new Set<string>();
  const seenLower = new Set<string>();
  const labels = new Set<string>();
  const add = (obj: string, field: string) => {
    const k = `${obj}.${field}`;
    if (seenLower.has(k.toLowerCase())) return;
    seenLower.add(k.toLowerCase());
    out.add(k);
  };
  const hops: Record<string, string> = {};
  // The relationship field read on `target` for the hop `rel` (`X__r` /
  // `Manager`). On this object the declaring field is known; elsewhere a
  // custom `X__r` falls back to `X__c` and is recorded in `hops`.
  const hop = (target: string, rel: string) => {
    if (target.toLowerCase() === objectApiName.toLowerCase()) {
      const relKey = rel.toLowerCase();
      const known = byRel.get(relKey) ?? byRel.get(relKey.replace(/__r$/, ""));
      if (known) {
        add(target, known.apiName);
        return;
      }
    }
    const field = relationshipField(rel);
    add(target, field);
    if (/__r$/i.test(rel)) hops[`${target}.${field}`] = rel;
  };
  const ownField = (name: string): string | null => {
    const known = byName.get(name.toLowerCase());
    if (known) return known.apiName;
    return /__c$/i.test(name) ? name : null;
  };

  const src = stripStrings(formula);
  for (const m of src.matchAll(PATH_RE)) {
    const after = src.slice((m.index ?? 0) + m[0].length);
    if (/^\s*\(/.test(after)) continue; // function call
    const before = src[(m.index ?? 0) - 1] ?? "";
    if (/[\w.]/.test(before)) continue; // tail of a number / other token
    const parts = m[0].split(".").map((p) => p.trim());
    const head = parts[0] ?? "";
    const headLower = head.toLowerCase();

    if (head.startsWith("$")) {
      if (headLower === "$setup" && parts.length >= 3) add(parts[1] ?? "", parts[2] ?? "");
      else if (headLower === "$custommetadata" && parts.length >= 4)
        add(parts[1] ?? "", parts[3] ?? "");
      else if (GLOBAL_OBJECT[headLower] && parts.length === 2)
        add(GLOBAL_OBJECT[headLower] as string, parts[1] ?? "");
      else if (GLOBAL_OBJECT[headLower] && parts.length > 2)
        hop(GLOBAL_OBJECT[headLower] as string, parts[1] ?? "");
      else if (headLower === "$label" && parts.length >= 2) labels.add(parts[1] ?? "");
      continue;
    }

    if (parts.length === 1) {
      if (LITERALS.has(headLower)) continue;
      const f = ownField(head);
      if (f) add(objectApiName, f);
      continue;
    }

    // Relationship hop: `X__r` (custom) or a standard relationship name.
    const relLower = headLower.replace(/__r$/, "");
    const lookup =
      byRel.get(headLower) ??
      byRel.get(relLower) ??
      (/__r$/i.test(head) ? byName.get(`${relLower}__c`) : undefined);
    const userLookup = USER_RELATIONSHIPS[headLower];
    if (lookup || userLookup) {
      add(objectApiName, lookup?.apiName ?? (userLookup as string));
      const target =
        lookup?.referenceTo.length === 1 ? lookup.referenceTo[0] : userLookup ? "User" : undefined;
      // Longer chains stop after the first hop: the relationship field read on the target.
      if (target && parts.length === 2) add(target, parts[1] ?? "");
      else if (target && parts.length > 2) hop(target, parts[1] ?? "");
      continue;
    }
    if (/__r$/i.test(head)) {
      // Unknown custom lookup: the lookup field itself is still read.
      add(objectApiName, `${head.slice(0, -3)}__c`);
      continue;
    }
    const std = STANDARD_BY_LOWER.get(headLower);
    if (std && parts.length === 2) add(std, parts[1] ?? "");
  }
  return { fields: [...out], labels: [...labels], hops };
}
