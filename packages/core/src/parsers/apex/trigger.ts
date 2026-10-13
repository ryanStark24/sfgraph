import { createHash } from "node:crypto";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import type { SnippetRecord } from "../../storage/interfaces.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import {
  emitClassRefEdges,
  emitDescribeRefEdges,
  emitStaticCallEdges,
  localVarNames,
} from "./class-refs.js";
import {
  aggregateGovernorFacts,
  computeLoopRanges,
  dynamicQueriesInLoop,
  emitDmlEdges,
  emitDynamicSoqlEdges,
  emitFieldAccessEdges,
  parseSoql,
  setDynamicSoqlSkips,
} from "./class.js";
import { stripCommentsAndStrings } from "./common.js";
import { foldDynamicSoql, maskApex } from "./dynamic-soql.js";
import { collectDecls, extractFieldAccesses } from "./field-access.js";
import { blankBracketGroups, findInlineQueries } from "./soql-fields.js";

export interface ApexTriggerInput {
  triggerName: string;
  body: string;
  metaXml?: string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * SOQL/DML body analysis for a trigger body (string-stripped). Triggers are the
 * most governor-risk-prone Salesforce artifact, yet previously got ZERO body
 * analysis. Mirrors the class regex path: EXECUTES_SOQL / EXECUTES_DML edges
 * stamped `inLoop` when inside a for/while/do body, so governor_risk_check
 * surfaces SOQL/DML-in-loop in triggers too.
 */
function extractTriggerBodyEdges(
  ctx: ParseContext,
  triggerQname: string,
  body: string,
): EdgeFact[] {
  const edges: EdgeFact[] = [];
  const loopRanges = computeLoopRanges(body);
  const inLoopAt = (idx: number): boolean => loopRanges.some((r) => idx > r.start && idx < r.end);

  for (const sq of findInlineQueries(body)) {
    const obj = stripNs(parseSoql(blankBracketGroups(sq.inner)).object ?? "", ctx.namespace);
    edges.push(
      makeEdge(ctx, triggerQname, REL_TYPES.EXECUTES_SOQL, `CustomObject:${obj}`, {
        query: sq.text.trim(),
        ...(inLoopAt(sq.index) ? { inLoop: true } : {}),
      }),
    );
  }

  emitDmlEdges(ctx, triggerQname, body, inLoopAt, edges);
  return edges;
}

/** `dynamicQueryInLoop` for a trigger body with dynamic queries in a loop (T15 I-5). */
function dynamicInLoopAttr(body: string): { dynamicQueryInLoop?: string[] } {
  const loopRanges = computeLoopRanges(body);
  const names = dynamicQueriesInLoop(body, (idx) =>
    loopRanges.some((r) => idx > r.start && idx < r.end),
  );
  return names.length > 0 ? { dynamicQueryInLoop: names } : {};
}

export class ApexTriggerParser implements Parser<ApexTriggerInput> {
  readonly category = METADATA_CATEGORY.APEX_TRIGGER;
  readonly type = "ApexTrigger";

  async parse(input: ApexTriggerInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const snippets: SnippetRecord[] = [];
    const name = stripNs(input.triggerName, ctx.namespace);
    const cleaned = stripCommentsAndStrings(input.body);
    const triggerQname = `ApexTrigger:${name}`;

    // Managed-package triggers (and any member whose Body the extractor couldn't
    // fetch) arrive with an empty body. That is NOT a parse failure — emit a
    // bare node so referencing edges resolve to a real target, instead of the
    // misleading "could not parse trigger header" ParseError. The triggering
    // object is unknown without a body, so no TRIGGERS_ON edge is emitted.
    if (cleaned.trim() === "") {
      const av = input.metaXml?.match(/<apiVersion>([^<]+)<\/apiVersion>/)?.[1]?.trim();
      nodes.push(
        makeNode(
          ctx,
          "ApexTrigger",
          triggerQname,
          { name, object: null, events: [], apiVersion: av ?? null },
          sha256(input.body),
        ),
      );
      return { nodes, edges };
    }

    // Parse header: trigger <Name> on <Object>(after insert, before update, ...) {
    const m = cleaned.match(/trigger\s+([A-Za-z_]\w*)\s+on\s+([A-Za-z_][\w.]*)\s*\(([^)]*)\)/i);
    if (!m) {
      nodes.push(
        makeNode(
          ctx,
          "ParseError",
          `ParseError:ApexTrigger:${name}`,
          { message: "could not parse trigger header" },
          sha256(input.body),
        ),
      );
      return { nodes, edges };
    }
    const triggerName = m[1] ?? name;
    const object = stripNs(m[2] ?? "", ctx.namespace);
    const events = (m[3] ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);

    const apiVersionMatch = input.metaXml?.match(/<apiVersion>([^<]+)<\/apiVersion>/);
    const apiVersion = apiVersionMatch?.[1] ? apiVersionMatch[1].trim() : null;

    nodes.push(
      makeNode(
        ctx,
        "ApexTrigger",
        triggerQname,
        {
          name: triggerName,
          object,
          events,
          apiVersion,
          ...dynamicInLoopAttr(cleaned),
        },
        sha256(input.body),
      ),
    );
    edges.push(
      makeEdge(ctx, triggerQname, REL_TYPES.TRIGGERS_ON, `CustomObject:${object}`, { events }),
    );

    // Store the trigger body so explain_code / debug can read it (triggers had
    // NO stored source before), and run SOQL/DML body analysis so governor and
    // traces cover triggers — the most governor-risk-prone Salesforce artifact.
    snippets.push({
      orgId: asOrgId(ctx.orgId),
      qualifiedName: asQualifiedName(triggerQname),
      sourceFormat: "apex",
      sourceText: input.body,
      sourceHash: asSha256(sha256(input.body)),
      startLine: 1,
      endLine: input.body.split("\n").length,
    });
    edges.push(...aggregateGovernorFacts(extractTriggerBodyEdges(ctx, triggerQname, cleaned)));
    // Field reads/writes through SObject-typed vars and Trigger.new/old/newMap/oldMap.
    const bodyStart = cleaned.indexOf("{", m.index ?? 0);
    const triggerBody = bodyStart >= 0 ? cleaned.slice(bodyStart) : cleaned;
    const decls = collectDecls(triggerBody);
    const localTypes = new Set(
      [...triggerBody.matchAll(/\b(?:class|enum|interface)\s+([A-Za-z_]\w*)/gi)].map((x) =>
        (x[1] ?? "").toLowerCase(),
      ),
    );
    emitFieldAccessEdges(
      ctx,
      triggerQname,
      extractFieldAccesses(triggerBody, {
        decls,
        triggerObject: object,
        excludedTypes: localTypes,
      }),
      edges,
      0,
    );
    // Static calls, constructors and static-member refs (handler dispatch,
    // recursion guards, constants) and dynamic SOQL, same rules as classes.
    // Length-preserving mask (quotes kept) so string args count toward arity.
    const masked = maskApex(input.body);
    const hdr = masked.search(/\btrigger\s+[A-Za-z_]\w*\s+on\b/i);
    const open = masked.indexOf("{", Math.max(0, hdr));
    const callCode = open >= 0 ? masked.slice(open) : masked;
    const triggerVars = localVarNames(decls);
    emitStaticCallEdges(ctx, triggerQname, callCode, undefined, edges, triggerVars);
    emitClassRefEdges(ctx, triggerQname, callCode, { localTypes, localVars: triggerVars }, edges);
    emitDescribeRefEdges(ctx, triggerQname, callCode, edges);
    setDynamicSoqlSkips(
      nodes.find((n) => String(n.qualifiedName) === triggerQname),
      emitDynamicSoqlEdges(ctx, triggerQname, foldDynamicSoql(input.body), edges, 0),
    );

    return { nodes, edges, snippets };
  }
}
