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

  clear(): void {
    this.tools.clear();
  }
}

/**
 * Global default registry. `defineTool` registers here on side-effect import.
 */
export const defaultRegistry = new ToolRegistry();

export function registerTool(spec: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: ToolHandler;
}): void {
  defaultRegistry.register(spec.name, spec.execute, {
    description: spec.description,
    inputSchema: spec.inputSchema,
  });
}
