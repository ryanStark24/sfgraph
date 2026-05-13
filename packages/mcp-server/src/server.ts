import { ToolRegistry } from "./tool-registry.js";
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
   * Start the stdio MCP server. Lazy-imports the SDK so tests/CLI work without
   * forcing the SDK load when not needed.
   */
  async startStdio(): Promise<void> {
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

    server.setRequestHandler(typesMod.CallToolRequestSchema, async (req: any) => {
      const tool = this.registry.get(req.params.name);
      if (!tool) {
        return {
          content: [{ type: "text", text: `unknown tool ${req.params.name}` }],
          isError: true,
        };
      }
      const result = await tool.handler(req.params.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    });

    const transport = new stdioMod.StdioServerTransport();
    await server.connect(transport);
  }
}
