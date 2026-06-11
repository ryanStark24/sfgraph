import { createHash } from "node:crypto";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import type { SnippetRecord } from "../../storage/interfaces.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { DML_RE, SOQL_RE, computeLoopRanges, parseSoql } from "./class.js";
import { stripCommentsAndStrings } from "./common.js";

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

  const soqlRe = new RegExp(SOQL_RE.source, "gi");
  let sq: RegExpExecArray | null = soqlRe.exec(body);
  while (sq !== null) {
    const obj = stripNs(parseSoql(sq[1] ?? "").object ?? "", ctx.namespace);
    edges.push(
      makeEdge(ctx, triggerQname, REL_TYPES.EXECUTES_SOQL, `CustomObject:${obj}`, {
        query: sq[0]?.trim(),
        ...(inLoopAt(sq.index) ? { inLoop: true } : {}),
      }),
    );
    sq = soqlRe.exec(body);
  }

  const dmlRe = new RegExp(DML_RE.source, "gi");
  let dm: RegExpExecArray | null = dmlRe.exec(body);
  while (dm !== null) {
    const op = (dm[1] ?? "").toLowerCase();
    edges.push(
      makeEdge(ctx, triggerQname, REL_TYPES.EXECUTES_DML, `DML:${op}`, {
        target: dm[2],
        ...(inLoopAt(dm.index) ? { inLoop: true } : {}),
      }),
    );
    dm = dmlRe.exec(body);
  }
  return edges;
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
        { name: triggerName, object, events, apiVersion },
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
    edges.push(...extractTriggerBodyEdges(ctx, triggerQname, cleaned));

    return { nodes, edges, snippets };
  }
}
