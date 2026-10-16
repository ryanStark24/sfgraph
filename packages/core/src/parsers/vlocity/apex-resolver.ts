import { asOrgId } from "@ryanstark24/sfgraph-shared";
import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { NodeFact } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/index.js";
import type { GraphStore } from "../../storage/interfaces.js";
import { makeEdge } from "../common.js";
import type { ParseContext } from "../contract.js";
import { pruneStaleResolverEdges } from "../resolver-prune.js";
import { remoteMethodsOf } from "./common.js";

/**
 * Link Vlocity Remote Actions (`IP_/OS_/VC_INVOKES_REMOTE → Remote:<cls>`) to
 * real `ApexClass` / `ApexMethod` nodes. Emitted alongside — never replacing —
 * the original `Remote:` edge. Edges merge by key, so re-running is idempotent;
 * earlier output the run no longer derives is pruned.
 *
 * Callee methods are matched by name against existing ApexMethod qnames; arity
 * is never recomputed (the parser's arity counting has known quirks).
 */
export interface VlocityApexResolveResult {
  scanned: number;
  resolvedClass: number;
  resolvedMethod: number;
  ambiguous: number;
  external: number;
}

const METHOD_QNAME_RE = /^ApexMethod:([^.]+)\.([^(]+)\((\d+|\?)\)$/;
const REMOTE_RELS = [
  REL_TYPES.REFERENCES, // opaque DataPack dataSource remotes (REFERENCES -> Remote:<cls>)
  REL_TYPES.IP_INVOKES_REMOTE,
  REL_TYPES.OS_INVOKES_REMOTE,
  REL_TYPES.VC_INVOKES_REMOTE,
  REL_TYPES.OMNI_INVOKES_REMOTE, // native OmniStudio (OmniProcess) Remote Actions
] as const;

export function resolveVlocityApex(
  store: GraphStore,
  orgIdIn: OrgId | string,
  ctx: ParseContext,
): VlocityApexResolveResult {
  const orgId = typeof orgIdIn === "string" ? asOrgId(orgIdIn) : orgIdIn;
  const result: VlocityApexResolveResult = {
    scanned: 0,
    resolvedClass: 0,
    resolvedMethod: 0,
    ambiguous: 0,
    external: 0,
  };

  const methodsByClass = new Map<string, { name: string; node: NodeFact }[]>();
  for (const n of store.listNodesByLabel(orgId, "ApexMethod")) {
    const m = METHOD_QNAME_RE.exec(String(n.qualifiedName));
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const bucket = methodsByClass.get(key) ?? [];
    bucket.push({ name: (m[2] ?? "").toLowerCase(), node: n });
    methodsByClass.set(key, bucket);
  }

  // One edge per (rel, src, dst). inactive=true survives only when every
  // collapsed source edge was inactive.
  const byKey = new Map<string, ReturnType<typeof makeEdge>>();
  const push = (
    e: ReturnType<typeof makeEdge>,
    from: { orgId: OrgId; firstSeenAt: number; attributes: unknown },
  ) => {
    const inactive = (from.attributes as Record<string, unknown>)?.inactive === true;
    const k = `${e.relType}|${e.srcQualifiedName}|${e.dstQualifiedName}`;
    const prev = byKey.get(k);
    if (prev) {
      if (!inactive) {
        const { inactive: _drop, ...rest } = prev.attributes as Record<string, unknown>;
        prev.attributes = rest;
      }
      return;
    }
    byKey.set(k, {
      ...e,
      attributes: inactive ? { ...e.attributes, inactive: true } : e.attributes,
      orgId: from.orgId,
      firstSeenAt: from.firstSeenAt,
    } as ReturnType<typeof makeEdge>);
  };
  const newEdges = byKey;

  for (const rel of REMOTE_RELS) {
    for (const edge of store.listEdgesByDstLike(orgId, "Remote:%", rel)) {
      result.scanned += 1;
      const attrs = edge.attributes as Record<string, unknown>;
      const remoteClass = typeof attrs.remoteClass === "string" ? attrs.remoteClass : "";
      const cls = remoteClass || String(edge.dstQualifiedName).slice("Remote:".length);
      if (!cls || cls === "unknown" || cls.includes("/") || cls.includes(":")) continue;

      const classNode = store.getNode(orgId, `ApexClass:${cls}` as never);
      if (!classNode) {
        result.external += 1;
        continue;
      }
      // One Remote edge per (src, class) can carry several methods.
      const methods = remoteMethodsOf(attrs);
      const remoteMethod = methods[0] ?? "";
      const src = String(edge.srcQualifiedName);
      push(
        makeEdge(ctx, src, REL_TYPES.VLOCITY_INVOKES_APEX, `ApexClass:${cls}`, {
          resolvedBy: "vlocity-apex-resolver",
          via: rel,
          remoteMethod,
          ...(methods.length > 1 ? { remoteMethods: methods } : {}),
        }),
        edge,
      );
      result.resolvedClass += 1;

      const dispatch = (classNode.attributes as Record<string, unknown>).vlocityDispatch as
        | Record<string, string>
        | undefined;
      for (const method of methods) {
        let callee: unknown = method;
        if (dispatch && typeof dispatch === "object") {
          const key = method.toLowerCase();
          callee = Object.hasOwn(dispatch, key) ? dispatch[key] : undefined;
        }
        if (typeof callee !== "string" || !callee) continue;

        const wanted = callee.toLowerCase();
        const candidates = (methodsByClass.get(cls.toLowerCase()) ?? []).filter(
          (c) => c.name === wanted,
        );
        if (candidates.length === 0) continue;
        result.resolvedMethod += 1;
        if (candidates.length > 1) result.ambiguous += 1;
        for (const c of candidates) {
          push(
            makeEdge(
              ctx,
              src,
              REL_TYPES.VLOCITY_INVOKES_APEX_METHOD,
              String(c.node.qualifiedName),
              {
                resolvedBy: "vlocity-apex-resolver",
                via: rel,
                remoteMethod: method,
                ambiguous: candidates.length > 1,
              },
            ),
            edge,
          );
        }
      }
    }
  }

  const previous = [
    ...store.listEdgesByDstLike(orgId, "ApexClass:%", REL_TYPES.VLOCITY_INVOKES_APEX),
    ...store.listEdgesByDstLike(orgId, "ApexMethod:%", REL_TYPES.VLOCITY_INVOKES_APEX_METHOD),
  ];
  pruneStaleResolverEdges(store, orgId, "vlocity-apex-resolver", previous, byKey.values());
  if (byKey.size > 0) store.mergeEdges([...byKey.values()]);
  return result;
}
