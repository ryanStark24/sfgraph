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
  it("toCursorFormat strips tools_used block but keeps body and other frontmatter", () => {
    const out = toCursorFormat(SAMPLE);
    expect(out).not.toMatch(/^tools_used:/m);
    expect(out).not.toMatch(/^\s+- tool_a/m);
    expect(out).toMatch(/name: foo/);
    expect(out).toMatch(/triggers:/);
    expect(out).toMatch(/^# Body/m);
    expect(out).toMatch(/^- bullet/m);
  });

  it("toClaudeFormat is identity", () => {
    expect(toClaudeFormat(SAMPLE)).toBe(SAMPLE);
  });
});
