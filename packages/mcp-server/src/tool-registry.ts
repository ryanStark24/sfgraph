export interface ToolHandlerResult {
  [key: string]: unknown;
}

export type ToolHandler = (input: Record<string, unknown>) => Promise<ToolHandlerResult>;

export interface ToolSchema {
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface RegisteredTool {
  name: string;
  handler: ToolHandler;
  schema: ToolSchema;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(name: string, handler: ToolHandler, schema: ToolSchema): void {
    if (this.tools.has(name)) {
      throw new Error(`tool '${name}' already registered`);
    }
    this.tools.set(name, { name, handler, schema });
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }
}
