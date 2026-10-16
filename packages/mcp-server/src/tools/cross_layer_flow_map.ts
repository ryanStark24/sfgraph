import { analyze } from "@ryanstark24/sfgraph-core";
import { REL_TYPES, type RelType } from "@ryanstark24/sfgraph-core";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { QualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";
import { layerOfKind } from "./_plain.js";
import {
  aOrAn,
  andList,
  code,
  isCallRel,
  kindCounts,
  kindInText,
  linkFacts,
  listWithMore,
  nameOf,
  notCountedPhrase,
  pieceCount,
  pieceRole,
  renderReport,
  reportDiagram,
} from "./_report.js";

const inputSchema = z.object({
  org: z.string().min(1),
  entry: z.string().min(1),
  /** Show the Picture (a diagram of at most 25 components); false hides it. */
  mermaid: z.boolean().default(true),
});

/**
 * T15 query I-1: the edges a flow follows, grouped by layer and listed in
 * display order (UI composition and UI -> logic, OmniStudio/Vlocity logic,
 * Flow, Apex, then data). Every rel type in the taxonomy is either here or in
 * `NOT_FOLLOWED` with the reason (a test enforces the partition), so a new
 * rel type cannot silently fall out of the map. REFERENCES is followed only
 * to a CustomObject (a type or schema reference) or, as a static-member read,
 * to an ApexClass (a class whose static member is read); never as a reflection
 * guess.
 */
export const FLOW_RELS: readonly RelType[] = [
  // UI composition and UI -> logic
  REL_TYPES.CALLS_APEX_FROM_LWC,
  REL_TYPES.IMPORTS_APEX,
  REL_TYPES.USES_WIRE,
  REL_TYPES.CONTROLLED_BY,
  REL_TYPES.EXTENDS_CONTROLLER,
  REL_TYPES.INVOKES_REMOTE_ACTION,
  REL_TYPES.LWC_CALLS_IP,
  REL_TYPES.USES_LWC,
  REL_TYPES.EMBEDS_LWC,
  REL_TYPES.EMBEDS_AURA,
  REL_TYPES.EMBEDS_VC,
  REL_TYPES.VC_EMBEDS_LWC,
  REL_TYPES.OS_EMBEDS_OS,
  REL_TYPES.OS_EMBEDS_LWC,
  REL_TYPES.OS_EMBEDS_VC,
  REL_TYPES.OMNI_EMBEDS_UI_CARD,
  // OmniStudio / Vlocity logic
  REL_TYPES.OS_CALLS_IP,
  REL_TYPES.VC_CALLS_IP,
  REL_TYPES.IP_CALLS_IP,
  REL_TYPES.OMNI_CALLS_INTEGRATION_PROCEDURE,
  REL_TYPES.OS_USES_DR,
  REL_TYPES.VC_USES_DR,
  REL_TYPES.IP_CALLS_DR,
  REL_TYPES.OMNI_CALLS_DATA_TRANSFORM,
  REL_TYPES.OMNI_USES_DATA_TRANSFORM,
  REL_TYPES.OS_INVOKES_REMOTE,
  REL_TYPES.VC_INVOKES_REMOTE,
  REL_TYPES.IP_INVOKES_REMOTE,
  REL_TYPES.OMNI_INVOKES_REMOTE,
  REL_TYPES.VLOCITY_INVOKES_APEX,
  REL_TYPES.VLOCITY_INVOKES_APEX_METHOD,
  // Flow
  REL_TYPES.FLOW_INVOKES_APEX,
  REL_TYPES.FLOW_INVOKES_APEX_METHOD,
  REL_TYPES.FLOW_INVOKES_SUBFLOW,
  // Apex
  REL_TYPES.CALLS,
  REL_TYPES.APEX_CALLS_IP,
  REL_TYPES.APEX_CALLS_DR,
  REL_TYPES.CALLS_DR,
  // Data
  REL_TYPES.EXECUTES_SOQL,
  REL_TYPES.EXECUTES_DML,
  REL_TYPES.REFERENCES,
  REL_TYPES.REFERENCES_OBJECT,
  REL_TYPES.READS_FIELD,
  REL_TYPES.WRITES_FIELD,
  REL_TYPES.DR_READS_FIELD,
  REL_TYPES.DR_WRITES_FIELD,
  REL_TYPES.LWC_BINDS_FIELD,
  REL_TYPES.RENDERS_FIELD,
];

/** Rel types the flow map does not follow, by reason. */
export const NOT_FOLLOWED: Readonly<Record<string, string>> = {
  [REL_TYPES.CONTAINS]: "containment: expanded with the container, no hop",
  [REL_TYPES.CONTAINS_METHOD]: "containment: expanded with the container, no hop",
  [REL_TYPES.CONTAINS_COMPONENT]: "containment: expanded with the container, no hop",
  [REL_TYPES.DEFINES_FIELD]: "schema structure, not a runtime step",
  [REL_TYPES.HAS_RECORD_TYPE]: "schema structure, not a runtime step",
  [REL_TYPES.HAS_VALIDATION_RULE]: "schema structure, not a runtime step",
  [REL_TYPES.USES_GLOBAL_VALUE_SET]: "schema structure, not a runtime step",
  [REL_TYPES.DEPENDS_ON_FIELD]: "schema structure, not a runtime step",
  [REL_TYPES.EXTENDS]: "type hierarchy, not a call",
  [REL_TYPES.IMPLEMENTS]: "type hierarchy, not a call",
  [REL_TYPES.OVERRIDES]: "type hierarchy, not a call",
  [REL_TYPES.INSTANCE_OF]: "type hierarchy, not a call",
  [REL_TYPES.IS_TEST_FOR]: "test linkage, not a runtime step",
  [REL_TYPES.EXECUTES_SOSL]: "target is the opaque `SOSL:*`, not a component",
  [REL_TYPES.QUERIES]: "legacy rel, superseded by EXECUTES_SOQL",
  [REL_TYPES.TRIGGERS_ON]: "upstream: the object fires the trigger, not the reverse",
  [REL_TYPES.TRIGGER_FIRES_ON]: "upstream: the object fires the flow, not the reverse",
  [REL_TYPES.WORKFLOW_TRIGGERS]: "upstream: the object fires the rule, not the reverse",
  [REL_TYPES.WORKFLOW_UPDATES_FIELD]: "workflow rules are not flow-map entries",
  [REL_TYPES.APPROVAL_USES_FORMULA]: "approval processes are not flow-map entries",
  [REL_TYPES.FLOW_INVOKES_ACTION]:
    "standard/platform action (email alert, quick action), no downstream logic",
  [REL_TYPES.DR_TRANSFORMS]: "a transform mapping, not a call or a field access",
  [REL_TYPES.LWC_BINDS_PROPERTY]: "unresolved template binding, not a component",
  [REL_TYPES.DISPATCHES_EVENT]: "DOM/component event, no static receiver",
  [REL_TYPES.LISTENS_TO_EVENT]: "DOM/component event, no static receiver",
  [REL_TYPES.PUBLISHES_EVENT]: "platform event bus, no static receiver",
  [REL_TYPES.SUBSCRIBES_TO_EVENT]: "platform event bus, upstream",
  [REL_TYPES.IMPORTS_STATIC_RESOURCE]: "static asset, not a layer",
  [REL_TYPES.IMPORTS_CUSTOM_LABEL]: "static asset, not a layer",
  [REL_TYPES.REFERENCES_LABEL]: "static asset, not a layer",
  [REL_TYPES.CALLS_NAMED_CREDENTIAL]: "external endpoint configuration, not a layer",
  [REL_TYPES.ESR_USES_NAMED_CREDENTIAL]: "external endpoint configuration, not a layer",
  [REL_TYPES.GRANTS]: "security grant",
  [REL_TYPES.GRANTS_OBJECT_ACCESS]: "security grant",
  [REL_TYPES.GRANTS_FIELD_ACCESS]: "security grant",
  [REL_TYPES.GRANTS_APEX_ACCESS]: "security grant",
  [REL_TYPES.GRANTS_PAGE_ACCESS]: "security grant",
  [REL_TYPES.GRANTS_TAB_ACCESS]: "security grant",
  [REL_TYPES.GRANTS_USER_PERMISSION]: "security grant",
  [REL_TYPES.SHARING_GRANTS]: "sharing rule",
  [REL_TYPES.SHARING_TO_GROUP]: "sharing rule",
  [REL_TYPES.SHARING_TO_ROLE]: "sharing rule",
  [REL_TYPES.SHARING_FROM_OWNER_GROUP]: "sharing rule",
  [REL_TYPES.CANONICAL_OF]: "cross-flavor identity, not a step",
  [REL_TYPES.REPORTS_ON]: "analytics, not a runtime path",
  [REL_TYPES.DASHBOARD_USES_REPORT]: "analytics, not a runtime path",
  [REL_TYPES.PLANNER_USES_PLUGIN]: "agent configuration, not a flow-map entry",
  [REL_TYPES.PLUGIN_INVOKES_FUNCTION]: "agent configuration, not a flow-map entry",
  [REL_TYPES.NETWORK_USES_BUNDLE]: "site configuration, not a flow-map entry",
};

/** Data endpoints: listed, never expanded (no formula field -> field reads). */
const LEAF_LABELS: ReadonlySet<string> = new Set(["CustomField", "CustomObject"]);

const labelOf = (q: string): string => q.slice(0, Math.max(0, q.indexOf(":")));

type FlowEdge = { relType: string; dstQualifiedName: string; attributes?: unknown };

/**
 * A static-member REFERENCES edge to an ApexClass: the path reads one of the
 * class's static members, so the class is on the path. The edge does not say
 * which member or whether it is `final`, so any static member counts. Only its
 * class-level edges are followed (field initializers), not its methods'.
 */
function isStaticMemberRead(e: FlowEdge): boolean {
  return (
    e.relType === REL_TYPES.REFERENCES &&
    (e.attributes as { via?: unknown } | undefined)?.via === "static-member" &&
    labelOf(e.dstQualifiedName) === "ApexClass"
  );
}

function followEdge(e: FlowEdge): boolean {
  if (e.relType !== REL_TYPES.REFERENCES) return true;
  if ((e.attributes as { source?: unknown } | undefined)?.source === "reflection") return false;
  return labelOf(e.dstQualifiedName) === "CustomObject" || isStaticMemberRead(e);
}

/** `CustomObject:X` for `CustomField:X.F`, else null. */
function objectOfField(q: string): string | null {
  if (labelOf(q) !== "CustomField") return null;
  const dot = q.indexOf(".", "CustomField:".length);
  return dot > 0 ? `CustomObject:${q.slice("CustomField:".length, dot)}` : null;
}

/** Labels probed when the caller passes a bare name without `Label:`. */
export const ENTRY_LABELS = [
  "LWC",
  "LWCBundle",
  "AuraComponent",
  "ApexPage",
  "Flow",
  "ApexClass",
  "ApexTrigger",
  "OmniScript",
  "OmniProcess",
  "VlocityCard",
  "OmniUiCard",
  "IntegrationProcedure",
  "OmniIntegrationProcedure",
];

export function layerFor(label: string): string {
  if (label === "LWC" || label === "LWCBundle") return "LWC";
  if (label.startsWith("Apex")) return "Apex";
  if (label === "CustomField") return "Field";
  if (label === "CustomObject") return "SOQL";
  return label;
}

defineTool({
  name: "cross_layer_flow_map",
  description:
    "Use for 'how does X flow from UI to data'. From an `entry` (LWC, Aura, page, Flow, Apex, OmniScript, FlexCard, IP): UI, logic and data steps.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const raw = input.entry.trim();
    const entryNode = ctx.graphStore.getNode(ctx.orgId, asQualifiedName(raw));
    const hasOut = (q: QualifiedName) =>
      FLOW_RELS.some((rt) => ctx.graphStore.listEdgesFrom(ctx.orgId, q, rt).length > 0);
    if (!entryNode && !hasOut(asQualifiedName(raw))) {
      // Unknown or label-less entry: say so instead of drawing a one-box
      // diagram the agent could read as "this component has no flow".
      const candidates = raw.includes(":")
        ? []
        : ENTRY_LABELS.map((l) => ctx.graphStore.getNode(ctx.orgId, asQualifiedName(`${l}:${raw}`)))
            .filter((n): n is NonNullable<typeof n> => n !== null)
            .map((n) => String(n.qualifiedName));
      const hint = raw.includes(":")
        ? `No node \`${raw}\` in the graph. Check the spelling with find_nodes (e.g. pattern \`${raw.split(":")[0]}:*${raw.split(":").slice(1).join(":").slice(0, 20)}*\`).`
        : `Entry must be a full \`Label:Name\` qname (e.g. \`LWC:${raw}\`).${candidates.length ? ` Did you mean: ${candidates.map((c) => `\`${c}\``).join(", ")}?` : ` Use find_nodes with pattern \`*:${raw}\` to find it.`}`;
      const bare = !raw.includes(":");
      const report = renderReport({
        title: "Entry not found",
        inShort: [
          bare
            ? `${code(raw)} needs its kind in front of the name, so no flow was traced${candidates.length ? `; it matches ${andList(candidates.map((c) => code(c)))}` : ""}.`
            : `${code(nameOf(raw))} is not in this org's graph, so no flow was traced.`,
        ],
        details: `> ${hint}`,
        next: [
          ...(candidates[0] ? [`Ask again with \`entry: "${candidates[0]}"\`.`] : []),
          "Look up the right name with `find_nodes`, then ask again.",
        ],
      });
      return {
        summary: "entry not found",
        markdown: report,
        data: { found: false, entry: raw, candidates },
        follow_up_tools: ["find_nodes"],
      };
    }
    // Use the stored (canonical-case) qname when the node exists.
    const entry = entryNode ? (entryNode.qualifiedName as QualifiedName) : asQualifiedName(raw);
    const store = ctx.graphStore;
    const org = ctx.orgId;
    type Participant = {
      id: string;
      label: string;
      layer: string;
      role?: "entry" | "standard-field";
    };
    const participants = new Map<string, Participant>();
    const messages: Array<{ fromId: string; toId: string; label: string }> = [];
    const messageKeys = new Set<string>();
    const pseudo = new Map<string, analyze.PseudoKind>();
    const visited = new Set<string>();
    // A user class named like a platform namespace is not platform Apex (review M1).
    const hasClass = analyze.apexTypeExists(store, org);
    // A packaged type with no node (`ns.Type`, `ns` from the org's own
    // `ns__X__c` schema) is a pseudo endpoint (Batch R / S2).
    const isManagedNamespace = analyze.managedNamespaceCheck(store, org);
    // `members: false` = enqueued only for its own (class-level) edges, not
    // its members' (T15 I-2): a class whose static member (a constant, an
    // enum value) is read, or the owner of a reached member. `others: true`
    // marks the second case: the owner also lists the data (objects and
    // fields) its other members read or write, and follows none of their
    // other edges (cycle 3 T7).
    type Item = { q: QualifiedName; members: boolean; others?: boolean };
    const queue: Item[] = [{ q: entry, members: true }];
    visited.add(entry);
    // Owners enqueued without members, and whether their others' data was asked for.
    const ownerVisited = new Map<string, boolean>();
    // The owner of a member entry lists no other members' data: the caller
    // asked for that one method's flow, not its class's.
    const entryOwner = analyze.componentOf(store, org, entry);

    /**
     * The participant a qname is drawn as: an ApexMethod rolls up to its
     * class, a FlowVersion to its Flow, an LWCBundle to its LWC
     * (containment.ts), so a container and its members are one participant.
     */
    const rowCache = new Map<string, string>();
    const rowOf = (q: QualifiedName): string => {
      const hit = rowCache.get(q);
      if (hit) return hit;
      let row: string = q;
      const own = analyze.traversalOwner(store, org, q);
      if (own && own.rule.row !== "member") row = own.owner;
      else {
        const { members, rule } = analyze.traversalMembers(store, org, q);
        if (rule?.row === "member" && members[0]) row = members[0];
      }
      rowCache.set(q, row);
      return row;
    };
    const entryRow = rowOf(entry);
    // The layer comes from the row drawn (a FlowVersion entry is drawn as its
    // Flow), not from the entry qname (review M7).
    const entryRowNode =
      entryRow === entry ? entryNode : store.getNode(org, asQualifiedName(entryRow));
    participants.set(entryRow, {
      id: entryRow,
      label: entryRow,
      layer: entryRowNode ? layerFor(entryRowNode.label) : "Entry",
      role: "entry",
    });
    const addParticipant = (row: string): void => {
      if (participants.has(row)) return;
      const node = store.getNode(org, asQualifiedName(row));
      const p: Participant = { id: row, label: row, layer: layerFor(node?.label ?? "Unknown") };
      // A standard field (no `__<suffix>`) is drawn but not counted.
      if (analyze.isStandardFieldQname(row)) p.role = "standard-field";
      participants.set(row, p);
    };
    const addMessage = (from: string, to: string, rt: string): void => {
      const key = `${from}\u0000${to}\u0000${rt}`;
      if (from === to || messageKeys.has(key)) return;
      messageKeys.add(key);
      messages.push({ fromId: from, toId: to, label: rt });
    };
    // Per-node visit cap, not per-edge step cap: predictable depth and an
    // explicit "_truncated_" marker the user can act on. Only enqueued nodes
    // count; members expanded with their container (a class's methods) are
    // free, so a 120-method controller does not truncate at once (review I4).
    const NODE_CAP = 100;
    let truncated = false;
    let enqueued = 1;
    const enqueue = (q: QualifiedName, members = true, others = false): boolean => {
      if (visited.has(q)) return true;
      if (members) visited.add(q);
      else {
        // A class first enqueued for a constant read is enqueued again when
        // one of its members is reached, to list its other members' data.
        const had = ownerVisited.get(q);
        if (had === true || (had === false && !others)) return true;
        ownerVisited.set(q, others);
      }
      queue.push({ q, members, others });
      enqueued++;
      if (enqueued >= NODE_CAP) {
        truncated = true;
        return false;
      }
      return true;
    };
    // Objects listed for a field on the path, linked after the walk (M-2): no
    // arrow when the same source already links the object itself; otherwise
    // a containment arrow object -> field, never the field's own rel type.
    const objectLinks: Array<{ from: string; obj: string; field: string }> = [];
    // The other members' data adds at most this many rows in all; past it the
    // report says the list was cut.
    const OTHERS_CAP = 100;
    let othersAdded = 0;
    let othersTruncated = false;
    bfs: while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const cur = item.q;
      if (cur !== entry && LEAF_LABELS.has(labelOf(cur))) continue;
      // Containment costs no hop: a class's methods, a Flow's FlowVersion and
      // a bundle's LWC are expanded with it — unless the container was only
      // reached through one of its members.
      const members = item.members ? analyze.traversalMembers(store, org, cur).members : [];
      const sources: QualifiedName[] = [cur, ...members.filter((m) => !visited.has(m))];
      for (const m of sources) if (m !== cur) visited.add(m);
      const from = rowOf(cur);
      // An owner reached through one member also lists the data its other
      // members read or write (objects and fields, which are leaves), but
      // follows none of their calls (T15 I-2 still holds for callees). For a
      // Flow reached through one FlowVersion, that is its other versions'
      // data, as when a Flow is reached directly (every version it holds).
      const siblings = item.others
        ? analyze.traversalMembers(store, org, cur).members.filter((m) => !visited.has(m))
        : [];
      const walk = [
        ...sources.map((q) => ({ q, own: true })),
        ...siblings.map((q) => ({ q, own: false })),
      ];
      for (const { q: src, own } of walk) {
        for (const rt of FLOW_RELS) {
          for (const e of store.listEdgesFrom(org, src, rt)) {
            if (!followEdge(e)) continue;
            const dst = e.dstQualifiedName;
            if (!own && !LEAF_LABELS.has(labelOf(dst))) continue;
            const dstNode = store.getNode(org, dst);
            const kind = analyze.pseudoEndpointKind(dst, dstNode !== null, new Set(), {
              hasClass,
              isManagedNamespace,
            });
            if (kind) {
              // Other members' data is never a pseudo endpoint in practice
              // (objects and fields), so nothing is recorded for it.
              if (own) pseudo.set(dst, kind);
              continue;
            }
            const to = rowOf(dst);
            if (!own) {
              const obj = objectOfField(dst);
              const fresh =
                (participants.has(to) ? 0 : 1) +
                (obj && !participants.has(obj) && store.getNode(org, asQualifiedName(obj)) ? 1 : 0);
              if (othersAdded + fresh > OTHERS_CAP) {
                othersTruncated = true;
                continue;
              }
              othersAdded += fresh;
            }
            addParticipant(to);
            addMessage(from, to, rt);
            // A field read or written on the path puts its object on the path
            // too (a DML on a typed record names only the variable; the
            // record's field writes name the object). Only an object with a
            // node: no invented rows.
            const obj = objectOfField(dst);
            if (obj && store.getNode(org, asQualifiedName(obj))) {
              addParticipant(obj);
              objectLinks.push({ from, obj, field: to });
            }
            // A sibling's data leaf is listed, not enqueued: no visit cap spent.
            if (!own) continue;
            // A static-member read brings the class's own (class-level)
            // edges only, never its methods'.
            if (!enqueue(dst, !isStaticMemberRead(e))) break bfs;
            // A reached member also brings its owner (Batch R / S3), drawn as
            // the member's row. Only the owner's own edges (class-level field
            // initializers, static references) are followed, not its other
            // members' (T15 I-2): reaching ApexMethod:C.m never pulls in the
            // callees of C's sibling methods.
            const owner = analyze.componentOf(store, org, dst);
            if (
              owner !== dst &&
              !enqueue(owner, false, owner !== entryOwner || entryOwner === entry)
            )
              break bfs;
          }
        }
      }
    }
    for (const { from, obj, field } of objectLinks) {
      if (messages.some((m) => m.fromId === from && m.toId === obj)) continue;
      addMessage(obj, field, REL_TYPES.CONTAINS);
    }
    // Remote:X duplicating a participant ApexClass:X is a pseudo endpoint too.
    const lowerIds = new Set([...participants.keys()].map((k) => k.toLowerCase()));
    for (const id of [...participants.keys()]) {
      const p = participants.get(id);
      if (p?.role) continue;
      const kind = analyze.pseudoEndpointKind(id, true, lowerIds, { hasClass });
      if (!kind) continue;
      participants.delete(id);
      pseudo.set(id, kind);
    }
    // Deterministic order: by kind, then id (review M7).
    const pseudoList = [...pseudo].sort(([a, ka], [b, kb]) =>
      analyze.comparePseudo({ pseudoKind: ka, qname: a }, { pseudoKind: kb, qname: b }),
    );
    const shownMessages = messages.filter(
      (m) => participants.has(m.fromId) && participants.has(m.toId),
    );
    // One arrow per participant pair in the diagram, rel types joined in
    // first-seen order; `data.messages` keeps every (from, to, rel).
    const arrows = new Map<string, { fromId: string; toId: string; label: string }>();
    for (const m of shownMessages) {
      const key = `${m.fromId}\u0000${m.toId}`;
      const a = arrows.get(key);
      if (a) a.label = `${a.label}, ${m.label}`;
      else arrows.set(key, { ...m });
    }
    // Lead-in: every counted participant by full qname, grouped by label.
    const counted = [...participants.values()].filter((p) => !p.role).map((p) => p.id);
    const byLabel = new Map<string, string[]>();
    for (const q of counted.sort(analyze.codePointCompare)) {
      const label = q.slice(0, q.indexOf(":")) || "Unknown";
      const g = byLabel.get(label);
      if (g) g.push(q);
      else byLabel.set(label, [q]);
    }
    const mdLines = [
      `Flow from \`${entryRow}\`: ${counted.length} component${counted.length === 1 ? "" : "s"} reached (the entry and standard fields not counted).`,
    ];
    for (const label of [...byLabel.keys()].sort(analyze.codePointCompare)) {
      const g = byLabel.get(label) ?? [];
      mdLines.push("", `### ${label} (${g.length})`, ...g.map((q) => `- ${q}`));
    }
    // The steps in order, one line per pair (the diagram is the report's Picture).
    mdLines.push(
      "",
      `### Steps (${arrows.size})`,
      ...[...arrows.values()].map((a) => `- ${a.fromId} -> ${a.toId}: ${a.label}`),
    );
    if (truncated) {
      mdLines.push(
        "",
        `_truncated_ — BFS hit the ${NODE_CAP}-node ceiling; deeper paths from this entry were not explored.`,
      );
    }
    if (othersTruncated) {
      mdLines.push(
        "",
        `_truncated_ — the data used by other methods of the classes reached hit the ${OTHERS_CAP}-item ceiling; the rest is not listed.`,
      );
    }
    if (pseudo.size > 0) {
      mdLines.push(
        "",
        `_${pseudo.size} pseudo endpoint${pseudo.size === 1 ? "" : "s"} not drawn_ (platform Apex, DML, LWC properties/events, managed-package types): ${pseudoList
          .map(([id]) => id)
          .slice(0, 20)
          .join(
            ", ",
          )}${pseudo.size > 20 ? `, +${pseudo.size - 20} more (narrow the call: a component further along the flow as \`entry\`)` : ""}`,
      );
    }
    // The entry (role "entry") and standard fields (role "standard-field")
    // are drawn but not counted.
    const reachedCount = [...participants.values()].filter((p) => !p.role).length;
    const standardFields = [...participants.values()].filter((p) => p.role === "standard-field");
    if (standardFields.length > 0) {
      mdLines.push(
        "",
        `_${standardFields.length} standard field${standardFields.length === 1 ? "" : "s"} (no \`__c\` suffix) drawn, not counted_: ${listWithMore(
          standardFields.map((p) => p.id),
          20,
        )}`,
      );
    }
    // The report.
    const kindOf = (id: string): string =>
      store.getNode(org, asQualifiedName(id))?.label ?? (labelOf(id) || "component");
    const countedRows = [...participants.values()].filter((p) => !p.role);
    const links = shownMessages.map((m) => ({ from: m.fromId, to: m.toId, rel: m.label }));
    const facts = linkFacts(links, new Set(participants.keys()));
    const layerOrder = ["screen", "logic", "data", "integration", "access", "setup"];
    const layers = [...new Set([...participants.keys()].map((id) => layerOfKind(kindOf(id))))].sort(
      (a, b) => layerOrder.indexOf(a) - layerOrder.indexOf(b),
    );
    const across = layers.length > 1 ? ` across the ${andList(layers)} layers` : "";
    const inShort = [
      countedRows.length
        ? `Starting from ${code(nameOf(entryRow))}, ${aOrAn(kindInText(kindOf(entryRow)))}, the flow reaches ${pieceCount(countedRows.length)}${across}: ${kindCounts(countedRows.map((p) => kindOf(p.id)))}.`
        : `Starting from ${code(nameOf(entryRow))}, ${aOrAn(kindInText(kindOf(entryRow)))}, the flow reaches no other pieces.`,
    ];
    // The main path in words: from the entry, the first call at each step (at most 4 steps), then
    // the fields the pieces on it read and write; a branching flow is told as one path of several.
    const chain = [entryRow];
    for (let i = 0; i < 4; i++) {
      const at = chain.at(-1)!;
      const next = links.find(
        (l) => l.from === at && isCallRel(l.rel) && !chain.includes(l.to) && participants.has(l.to),
      );
      if (!next) break;
      chain.push(next.to);
    }
    if (chain.length > 1) {
      const onPath = new Set(chain);
      // Standard fields are counted apart, as the In short's "Not counted" line does.
      const standard = new Set(standardFields.map((p) => p.id));
      const fieldsBy = (re: RegExp, std: boolean) =>
        new Set(
          links
            .filter((l) => onPath.has(l.from) && re.test(l.rel) && standard.has(l.to) === std)
            .map((l) => l.to),
        ).size;
      const fieldWords = (n: number, s: number) =>
        andList([
          ...(n ? [`${n} ${n === 1 ? "field" : "fields"}`] : []),
          ...(s ? [`${s} standard ${s === 1 ? "field" : "fields"}`] : []),
        ]);
      const reads = fieldWords(fieldsBy(/READS_FIELD$/, false), fieldsBy(/READS_FIELD$/, true));
      const writes = fieldWords(fieldsBy(/WRITES_FIELD$/, false), fieldsBy(/WRITES_FIELD$/, true));
      const uses = [...(reads ? [`read ${reads}`] : []), ...(writes ? [`write ${writes}`] : [])];
      const [first, ...rest] = chain.map((q) => code(nameOf(q)));
      // Branch points: pieces on the path that also call a piece off it (beyond the next step).
      const branches = chain.filter((q, i) =>
        links.some(
          (l) =>
            l.from === q &&
            isCallRel(l.rel) &&
            l.to !== q &&
            l.to !== chain[i + 1] &&
            !onPath.has(l.to) &&
            participants.has(l.to),
        ),
      ).length;
      const path = `${first} calls ${rest.join(", which calls ")}${uses.length ? `; together they ${andList(uses)}` : ""}`;
      inShort.push(
        branches
          ? `One path through it: ${path} (the flow also branches at ${branches} ${branches === 1 ? "step" : "steps"}; all steps are listed under Technical details).`
          : `${path}.`,
      );
    }
    const left: string[] = [];
    if (standardFields.length)
      left.push(
        `${standardFields.length} standard ${standardFields.length === 1 ? "field" : "fields"}`,
      );
    if (pseudoList.length) left.push(notCountedPhrase(pseudoList.map(([, k]) => k)));
    if (left.length) inShort.push(`Not counted: ${andList(left)}.`);
    if (truncated)
      inShort.push("The search stopped at its size limit, so the flow may go further than shown.");
    if (othersTruncated)
      inShort.push(
        "For the classes reached through one method, not all the data used by their other methods is shown: that list stopped at its size limit.",
      );
    const report = renderReport({
      title: `Where the flow from ${nameOf(entryRow)} goes`,
      inShort,
      diagram: input.mermaid
        ? reportDiagram(
            [...participants.values()].map((p) => ({ id: p.id, label: kindOf(p.id) })),
            links,
          )
        : undefined,
      pieces: countedRows.map((p) => {
        const f = facts(p.id);
        return { name: p.id, kind: kindOf(p.id), role: pieceRole({ kind: kindOf(p.id), ...f }) };
      }),
      details: mdLines.join("\n"),
      next: [
        ...(truncated
          ? ["Start from a piece further along the flow as `entry` to see the rest."]
          : []),
        "Run `analyze_field` on a field to see everything that reads or writes it.",
        "Run `trace_downstream` for everything a piece relies on, beyond these flow steps.",
        "Not followed: security grants, type hierarchy, events, static assets, and triggers fired by DML.",
      ],
    });
    return {
      summary: `${reachedCount} participants across layers from ${entryRow}${truncated ? " (truncated)" : ""}`,
      markdown: report,
      data: {
        participants: Array.from(participants.values()),
        messages: shownMessages,
        pseudo: pseudoList.map(([id, pseudoKind]) => ({ id, pseudoKind })),
        truncated,
        ...(othersTruncated ? { otherMethodsDataTruncated: true } : {}),
      },
      follow_up_tools: ["analyze_field", "trace_downstream", "explain_code"],
    };
  },
});
