import { ToolRegistry, defaultRegistry } from "./tool-registry.js";
import { pingTool } from "./tools/ping.js";

export interface SfgraphMcpServerOpts {
  registry?: ToolRegistry;
}

export class SfgraphMcpServer {
  readonly registry: ToolRegistry;

  constructor(opts: SfgraphMcpServerOpts = {}) {
    this.registry = opts.registry ?? new ToolRegistry();
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
   * Start the stdio MCP server. Lazy-imports the SDK so tests/CLI work without
   * forcing the SDK load when not needed.
   */
  async startStdio(): Promise<void> {
    await this.loadAllTools();
    const sdk = await import("@modelcontextprotocol/sdk/server/index.js");
    const stdioMod = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const typesMod = await import("@modelcontextprotocol/sdk/types.js");

    const server = new sdk.Server(
      { name: "sfgraph", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(typesMod.ListToolsRequestSchema, async () => ({
      tools: this.registry.list().map((t) => ({
        name: t.name,
        description: t.schema.description,
        inputSchema: t.schema.inputSchema ?? { type: "object" },
      })),
    }));

    server.setRequestHandler(typesMod.CallToolRequestSchema, async (req) => {
      const params = (req as { params: { name: string; arguments?: Record<string, unknown> } })
        .params;
      return this.dispatch(params.name, params.arguments ?? {});
    });

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
    try {
      const result = (await tool.handler(args)) as Record<string, unknown>;
      const text = typeof result.markdown === "string" ? result.markdown : JSON.stringify(result);
      return {
        content: [{ type: "text", text }],
        _meta: {
          summary: result.summary,
          data: result.data,
          follow_up_tools: result.follow_up_tools,
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
