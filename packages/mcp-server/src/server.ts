import { getToolContext, leasedSyncWarnings, runWithContextLeases } from "./context.js";
import {
  type ToolHandler,
  type ToolProfile,
  ToolRegistry,
  defaultRegistry,
  inProfile,
  toolList,
  toolProfile,
} from "./tool-registry.js";
import { HEADINGS, PRESENTATION_GUIDE, PRESENTATION_OUTLINE } from "./tools/_report.js";
import { pingTool } from "./tools/ping.js";

/**
 * Cycle 2 T5: the most characters of result text one tool call returns. An MCP client sees only
 * this text, and a client may refuse a longer one (Claude Code saves it to a file the agent may
 * not be allowed to read), so the server cuts it instead and says how to narrow the call.
 */
export const TEXT_MAX = 16000;

/**
 * Cut `text` to at most `max` characters at a line boundary and end it with a line saying how many
 * lines were left out. A cut inside a ``` fence drops the whole fenced block when text comes before
 * it; when the fenced block is the first content, its lines that fit are kept and the fence is
 * closed. A first line longer than the room is cut at the room. Only a line that is just a fence
 * (``` and an optional language tag) opens or closes one; a ``` inside source text does not.
 */
const FENCE_OPEN = /^\s*```[\w+#.-]*\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const CLOSE = "\n```";

export function fitText(text: string, max = TEXT_MAX): string {
  if (text.length <= max) return text;
  return fitReport(text, max) ?? cutLines(text, max, max);
}

const cutNote = (max: number, n: number) =>
  `\n\n_Text cut at ${max} characters: ${n} more lines not shown. Narrow the call (a lower limit or depth, or a label, pattern or category filter) to see the rest._`;

/** `s` cut to at most `n` UTF-16 units, never between the halves of a surrogate pair. */
function sliceUnits(s: string, n: number): string {
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/** `text` in at most `budget` characters, cut at a line boundary with the note (which names `max`). */
function cutLines(text: string, budget: number, max: number): string {
  if (text.length <= budget) return text;
  const all = text.split("\n");
  const note = (n: number) => cutNote(max, n);
  const room = budget - note(all.length).length - CLOSE.length;
  if (all[0]!.length > room) return sliceUnits(all[0]!, Math.max(0, room)) + note(all.length - 1);
  let size = 0;
  let keep = 0;
  let fenceStart = -1;
  for (; keep < all.length; keep++) {
    const line = all[keep]!;
    const add = line.length + (keep > 0 ? 1 : 0);
    if (size + add > room) break;
    size += add;
    if (fenceStart < 0 ? FENCE_OPEN.test(line) : FENCE_CLOSE.test(line))
      fenceStart = fenceStart < 0 ? keep : -1;
  }
  let close = "";
  if (fenceStart >= 0) {
    let before = fenceStart;
    while (before > 0 && all[before - 1]!.trim() === "") before--;
    if (before > 0) keep = before;
    else close = CLOSE;
  }
  while (keep > 0 && all[keep - 1]!.trim() === "") keep--;
  return all.slice(0, keep).join("\n") + close + note(all.length - keep);
}

const PIECE_COUNT_LINE = /^- and (\d+) more\b/;

/** How many pieces a piece line names: a merged line ("- `a`, `b` and 2 others: ...") holds several. */
export function piecesInLine(line: string): number {
  const m = /^- ((?:`[^`]*`(?:, | and )?)+)(?:(\d+) others?)?: /.exec(line);
  if (!m) return 1;
  return (m[1]!.match(/`[^`]*`/g)?.length ?? 1) + (m[2] ? Number(m[2]) : 0);
}

/**
 * Cycle 3 T2: a human report (it holds a Technical details heading) keeps every section before
 * Technical details whole and its What to check next; only the technical details are cut. When the
 * sections before Technical details alone are too long, piece lines are dropped from the end first,
 * with a count line. Null when the text is not a report or cannot fit that way.
 */
function fitReport(text: string, max: number): string | null {
  const all = text.split("\n");
  const at = all.indexOf(HEADINGS.details);
  if (at <= 0) return null;
  let nextAt = all.indexOf(HEADINGS.next, at + 1);
  if (nextAt < 0) nextAt = all.length;
  const head = all.slice(0, at);
  const detailLines = all.slice(at + 1, nextAt);
  while (detailLines.length && detailLines.at(-1)!.trim() === "") detailLines.pop();
  const details = detailLines.join("\n");
  const tail = nextAt < all.length ? `\n\n${all.slice(nextAt).join("\n")}` : "";
  const minDetails = cutNote(max, detailLines.length).length + CLOSE.length;

  // Piece lines of What each piece does, which may be dropped from the end.
  const piecesAt = head.indexOf(HEADINGS.pieces);
  let piecesEnd = piecesAt;
  while (piecesAt >= 0 && piecesEnd + 1 < head.length && head[piecesEnd + 1]!.startsWith("- "))
    piecesEnd++;
  // An existing "- and N more" line is kept as is until a piece is dropped, then counts it too.
  let countLine: string | null = null;
  if (piecesEnd > piecesAt && PIECE_COUNT_LINE.test(head[piecesEnd]!)) {
    countLine = head.splice(piecesEnd, 1)[0]!;
    piecesEnd--;
  }
  const listed = countLine ? Number(PIECE_COUNT_LINE.exec(countLine)![1]) : 0;
  let dropped = 0;
  const headText = () => {
    const line = dropped
      ? `- and ${dropped + listed} more pieces not shown here, to keep the text short`
      : countLine;
    const h = line ? [...head.slice(0, piecesEnd + 1), line, ...head.slice(piecesEnd + 1)] : head;
    return `${h.join("\n")}\n${HEADINGS.details}`;
  };
  let budget = max - headText().length - 1 - tail.length;
  while (budget < Math.min(minDetails, details.length) && piecesEnd > piecesAt) {
    dropped += piecesInLine(head.splice(piecesEnd, 1)[0]!);
    piecesEnd--;
    budget = max - headText().length - 1 - tail.length;
  }
  if (budget < Math.min(minDetails, details.length)) return null;
  return `${headText()}\n${cutLines(details, budget, max)}${tail}`;
}

/**
 * W1.5-08: shape of the per-response staleness block. Surfaced inside
 * `_meta.staleness` so concurrent MCP clients can warn users when the
 * graph is being rewritten mid-query without breaking the MCP envelope.
 */
export interface StalenessBlock {
  generation: number;
  in_progress: boolean;
  started_at: string | null;
  last_sync_at: string | null;
}

/**
 * Best-effort resolution of the org identifier from arbitrary tool
 * arguments. The MCP tool surface uses both `org` and `orgId` as the
 * parameter name across different tools (e.g. staleness_check uses
 * `org`, deeper analytical tools use `orgId`). Returns `null` when
 * neither key is present (tools like `ping` / `list_orgs`); the
 * dispatcher then skips the staleness attachment instead of guessing.
 */
function pickOrgIdFromArgs(args: Record<string, unknown>): string | null {
  const candidates = ["orgId", "org", "org_id"];
  for (const key of candidates) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

async function resolveStaleness(args: Record<string, unknown>): Promise<StalenessBlock | null> {
  const orgArg = pickOrgIdFromArgs(args);
  if (!orgArg) return null;
  try {
    const ctx = await getToolContext({ orgId: orgArg });
    const status = ctx.graphStore.getSyncStatus(ctx.orgId);
    return {
      generation: status.generation,
      in_progress: status.in_progress,
      started_at: status.started_at,
      last_sync_at:
        status.last_sync_at != null ? new Date(status.last_sync_at).toISOString() : null,
    };
  } catch {
    // Context resolution can fail for many legitimate reasons (unknown
    // alias, DB not yet created, sqlite ABI mismatch). Surface a degraded
    // staleness block rather than failing the whole tool call — concurrent
    // readers still get a sane "we don't know" signal.
    return null;
  }
}

const PROMPT_NAME = "present_for_people";

export interface SfgraphMcpServerOpts {
  registry?: ToolRegistry;
  /** Which tools to serve; default from SFGRAPH_TOOLS (`core`, else the full list). */
  profile?: ToolProfile;
}

export class SfgraphMcpServer {
  readonly registry: ToolRegistry;
  readonly profile: ToolProfile;

  constructor(opts: SfgraphMcpServerOpts = {}) {
    this.registry = opts.registry ?? new ToolRegistry();
    this.profile = opts.profile ?? toolProfile();
  }

  registerDefaults(): void {
    if (!this.registry.get("ping")) {
      this.registry.register(pingTool.name, pingTool.handler, pingTool.schema);
    }
  }

  /**
   * Side-effect import every tool module so they register on defaultRegistry,
   * then copy missing tools into this.registry.
   */
  async loadAllTools(): Promise<void> {
    await import("./tools/index.js");
    for (const t of defaultRegistry.list()) {
      if (!this.registry.get(t.name)) {
        this.registry.register(t.name, t.handler, t.schema);
      }
    }
  }

  /**
   * Cycle 3 T2: the one prompt, `present_for_people`, carries the house style (the same guide the
   * server sends as its `instructions`) with a fill-in-the-blank outline.
   */
  listPrompts(): {
    prompts: Array<{
      name: string;
      description: string;
      arguments: Array<{ name: string; description: string; required: boolean }>;
    }>;
  } {
    return {
      prompts: [
        {
          name: PROMPT_NAME,
          description:
            "How to present sfgraph results to a mixed team (a business analyst and a developer), with an outline to fill in.",
          arguments: [
            {
              name: "question",
              description: "The question the answer is for (optional).",
              required: false,
            },
          ],
        },
      ],
    };
  }

  getPrompt(
    name: string,
    args: Record<string, string | undefined> = {},
  ): {
    description: string;
    messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
  } {
    if (name !== PROMPT_NAME) throw new Error(`unknown prompt ${name}`);
    const question = typeof args.question === "string" ? args.question.trim() : "";
    const text = [
      PRESENTATION_GUIDE,
      "",
      "Fill in this outline:",
      "",
      PRESENTATION_OUTLINE,
      ...(question ? ["", `Question: ${question}`] : []),
    ].join("\n");
    return {
      description: "House style for presenting sfgraph results to people",
      messages: [{ role: "user", content: { type: "text", text } }],
    };
  }

  /**
   * The SDK server with every handler set (tools, prompts) and the house style as `instructions`,
   * not yet connected. Lazy-imports the SDK so tests/CLI work without forcing the SDK load.
   */
  async createSdkServer() {
    await this.loadAllTools();
    const sdk = await import("@modelcontextprotocol/sdk/server/index.js");
    const typesMod = await import("@modelcontextprotocol/sdk/types.js");

    const server = new sdk.Server(
      { name: "sfgraph", version: "0.0.0" },
      { capabilities: { tools: {}, prompts: {} }, instructions: PRESENTATION_GUIDE },
    );

    server.setRequestHandler(typesMod.ListToolsRequestSchema, async () => ({
      tools: toolList(this.registry, this.profile),
    }));

    server.setRequestHandler(typesMod.CallToolRequestSchema, async (req) => {
      const params = (req as { params: { name: string; arguments?: Record<string, unknown> } })
        .params;
      return this.dispatch(params.name, params.arguments ?? {});
    });

    server.setRequestHandler(typesMod.ListPromptsRequestSchema, async () => this.listPrompts());

    server.setRequestHandler(typesMod.GetPromptRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;
      try {
        return this.getPrompt(name, args ?? {});
      } catch (err) {
        throw new typesMod.McpError(typesMod.ErrorCode.InvalidParams, (err as Error).message);
      }
    });

    return server;
  }

  /** Start the stdio MCP server. */
  async startStdio(): Promise<void> {
    const server = await this.createSdkServer();
    const stdioMod = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const transport = new stdioMod.StdioServerTransport();
    await server.connect(transport);
  }

  /**
   * Public dispatcher used by stdio handler and tests. Returns MCP-shape response.
   */
  async dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
    _meta?: Record<string, unknown>;
  }> {
    const tool = this.registry.get(name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `unknown tool ${name}` }],
        isError: true,
        _meta: { code: "UNKNOWN_TOOL" },
      };
    }
    // Cycle 3 T5: a tool the core profile does not list is refused, not run.
    if (!inProfile(name, this.profile)) {
      return {
        content: [
          {
            type: "text",
            text: `Could not run ${name}, because this server was started with SFGRAPH_TOOLS=core. Try one of the tools it lists, or restart the server without SFGRAPH_TOOLS to use ${name}.`,
          },
        ],
        isError: true,
        _meta: { code: "NOT_IN_PROFILE" },
      };
    }
    // Every context the call obtains is leased until it settles, so cache
    // eviction can't close a store mid-call (audit rel-04).
    return runWithContextLeases(() => this.runTool(tool.handler, args));
  }

  private async runTool(
    handler: ToolHandler,
    args: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
    _meta?: Record<string, unknown>;
  }> {
    try {
      const result = (await handler(args)) as Record<string, unknown>;
      const text = fitText(
        typeof result.markdown === "string" ? result.markdown : JSON.stringify(result),
      );
      // W1.5-08: attach the staleness block to `_meta` (NOT inside `content`
      // — the protocol envelope shape stays intact). Resolved best-effort:
      // null for tools that don't take an org parameter (`ping`,
      // `list_orgs`), and null on any context-resolution failure. Clients
      // should treat `null` as "unknown" rather than "fresh".
      const staleness = await resolveStaleness(args);
      // T15 R2-1: a sync or rebuild of any org this call read is stated in the
      // result itself (a text block after the payload, so content[0] stays the
      // payload), not only in `_meta` — no silent partial answers.
      const warnings = leasedSyncWarnings();
      return {
        content: [
          { type: "text", text },
          ...(warnings.length > 0 ? [{ type: "text" as const, text: warnings.join("\n") }] : []),
        ],
        _meta: {
          summary: result.summary,
          data: result.data,
          follow_up_tools: result.follow_up_tools,
          staleness,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      };
    } catch (err) {
      const e = err as { name?: string; issues?: unknown; message?: string };
      if (e?.name === "ZodError") {
        return {
          content: [{ type: "text", text: `invalid input: ${JSON.stringify(e.issues)}` }],
          isError: true,
          _meta: { code: "INVALID_INPUT", issues: e.issues },
        };
      }
      return {
        content: [{ type: "text", text: `error: ${e?.message ?? String(err)}` }],
        isError: true,
        _meta: { code: "TOOL_ERROR" },
      };
    }
  }
}
