import { z } from "zod";

// Recursive `applies_when` predicate.
export const WhenSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ always: z.literal(true) }).strict(),
    z.object({ capability: z.string() }).strict(),
    z.object({ not: WhenSchema }).strict(),
    z.object({ any_of: z.array(WhenSchema) }).strict(),
    z.object({ all_of: z.array(WhenSchema) }).strict(),
  ]),
);

const PropValueSchema = z.union([z.string(), z.boolean(), z.number(), z.null()]);

const NodeRuleSchema = z
  .object({
    label: z.string(),
    qname: z.string(),
    props: z.record(PropValueSchema).optional(),
    /** When set, repeats the node per element of the iterated array. */
    iterate: z.string().optional(),
    /** Conditional emit; evaluated against ctx (item bound when iterating). */
    when: z.string().optional(),
  })
  .strict();

const EdgeRuleSchema = z
  .object({
    relType: z.string(),
    iterate: z.string().optional(),
    when: z.string().optional(),
    src: z.string(),
    dst: z.string(),
    props: z.record(PropValueSchema).optional(),
  })
  .strict();

export const RuleSchema = z
  .object({
    type: z.string(),
    category: z.string(),
    input: z.enum(["object", "json", "xml-string"]),
    /** Optional dot-path to the root element after XML parsing (e.g. "Profile"). */
    root: z.string().optional(),
    applies_when: WhenSchema.default({ always: true }),
    nodes: z.array(NodeRuleSchema).default([]),
    edges: z.array(EdgeRuleSchema).default([]),
  })
  .strict();

export type Rule = z.infer<typeof RuleSchema>;
export type NodeRule = z.infer<typeof NodeRuleSchema>;
export type EdgeRule = z.infer<typeof EdgeRuleSchema>;
