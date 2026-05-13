import type { ToolResponse } from "@sfgraph/core";
import { type ZodTypeAny, z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerTool } from "../tool-registry.js";

export interface DefineToolSpec<S extends ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  execute: (input: z.infer<S>) => Promise<ToolResponse<unknown>>;
}

export function defineTool<S extends ZodTypeAny>(spec: DefineToolSpec<S>): void {
  const jsonSchema = zodToJsonSchema(spec.inputSchema, {
    name: spec.name,
    target: "jsonSchema7",
  });
  let schemaObj: Record<string, unknown> = jsonSchema as Record<string, unknown>;
  const defs = (jsonSchema as { definitions?: Record<string, unknown> }).definitions;
  if (defs?.[spec.name]) {
    schemaObj = defs[spec.name] as Record<string, unknown>;
  }
  if (typeof schemaObj.type !== "string") {
    schemaObj = { type: "object", ...schemaObj };
  }
  registerTool({
    name: spec.name,
    description: spec.description,
    inputSchema: schemaObj,
    async execute(raw) {
      const parsed = spec.inputSchema.parse(raw) as z.infer<S>;
      const r = await spec.execute(parsed);
      return r as unknown as Record<string, unknown>;
    },
  });
}

export { z };
