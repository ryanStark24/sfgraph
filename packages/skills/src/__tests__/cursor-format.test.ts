import { describe, expect, it } from "vitest";
import { toClaudeFormat, toCursorFormat } from "../installer.js";

const SAMPLE = `---
name: foo
description: bar
triggers:
  - "x"
tools_used:
  - tool_a
  - tool_b
---

# Body

Some content.

- bullet
`;

describe("format transforms", () => {
  it("toCursorFormat rewrites frontmatter into Cursor's contract", () => {
    const out = toCursorFormat(SAMPLE);
    // Cursor-shaped frontmatter (the only three keys it understands)
    expect(out).toMatch(/^description:.*bar/m);
    expect(out).toMatch(/^globs:\s*$/m);
    expect(out).toMatch(/^alwaysApply:\s*false$/m);
    // Trigger phrases folded into the description so the agent matches them
    expect(out).toMatch(/Triggers:.*"?x"?/);
    // The agent-requested hint mentions the skill name + sfgraph routing
    expect(out).toMatch(/sfgraph MCP tools/);
    // Body preserved verbatim
    expect(out).toMatch(/^# Body/m);
    expect(out).toMatch(/^- bullet/m);
    // Old frontmatter is gone (it would confuse Cursor's parser)
    expect(out).not.toMatch(/^name: foo/m);
    expect(out).not.toMatch(/^triggers:/m);
    expect(out).not.toMatch(/^tools_used:/m);
  });

  it("toClaudeFormat is identity", () => {
    expect(toClaudeFormat(SAMPLE)).toBe(SAMPLE);
  });
});
