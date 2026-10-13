import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { SfgraphMcpServer } from "../server.js";
import { PRESENTATION_GUIDE, PRESENTATION_OUTLINE } from "../tools/_report.js";

// Cycle 3 T2: the house style. The guide goes out as the MCP `instructions` and in one prompt.
describe("presentation guide", () => {
  it("is at most 1,200 characters", () => {
    expect(PRESENTATION_GUIDE.length).toBeLessThanOrEqual(1200);
    expect(PRESENTATION_GUIDE.length).toBeGreaterThan(200);
  });

  it("holds no internal constants and no tool names", async () => {
    expect(PRESENTATION_GUIDE).not.toMatch(/[A-Z]+_[A-Z]+/);
    expect(PRESENTATION_OUTLINE).not.toMatch(/[A-Z]+_[A-Z]+/);
    const s = new SfgraphMcpServer();
    await s.loadAllTools();
    const names = s.registry.list().map((t) => t.name);
    expect(names.length).toBeGreaterThan(15);
    for (const n of names) {
      expect(PRESENTATION_GUIDE).not.toContain(n);
      expect(PRESENTATION_OUTLINE).not.toContain(n);
    }
  });

  it("covers the spec's points", () => {
    for (const w of [
      /plain words/i,
      /diagram/i,
      /each main piece/i,
      /define/i,
      /technical/i,
      /not checked/i,
    ])
      expect(PRESENTATION_GUIDE).toMatch(w);
  });

  // Cycle 3 T9 fix 1: what the judges marked down in the dev round's answers.
  it("asks for matching counts, a mermaid diagram, spelled-out short forms and no process notes", () => {
    for (const w of [
      /count must match the list/i,
      /mermaid diagram/i,
      /SOQL or DML/,
      /not your own steps or tools/i,
      /no drafting notes/i,
      /business purpose/i,
      /steps away/i,
      /what its code decides or writes/i,
      /read it first/i,
    ])
      expect(PRESENTATION_GUIDE).toMatch(w);
  });
});

describe("present_for_people prompt", () => {
  it("is listed with an optional question argument", () => {
    const s = new SfgraphMcpServer();
    expect(s.listPrompts()).toEqual({
      prompts: [
        {
          name: "present_for_people",
          description: expect.any(String),
          arguments: [{ name: "question", description: expect.any(String), required: false }],
        },
      ],
    });
  });

  it("returns the guide plus the outline, and the question when given", () => {
    const s = new SfgraphMcpServer();
    const r = s.getPrompt("present_for_people", { question: "What does CaseTrigger touch?" });
    expect(r.messages).toHaveLength(1);
    const text = r.messages[0]!.content.text;
    expect(r.messages[0]!.role).toBe("user");
    expect(text).toContain(PRESENTATION_GUIDE);
    expect(text).toContain(PRESENTATION_OUTLINE);
    expect(text).toContain("What does CaseTrigger touch?");
    expect(s.getPrompt("present_for_people").messages[0]!.content.text).not.toContain("Question:");
  });

  it("rejects an unknown prompt", () => {
    expect(() => new SfgraphMcpServer().getPrompt("nope")).toThrow(/unknown prompt/);
  });
});

describe("MCP server wiring", () => {
  it("sends the guide as instructions and answers prompts/list and prompts/get", async () => {
    const s = new SfgraphMcpServer();
    const server = await s.createSdkServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      expect(client.getInstructions()).toBe(PRESENTATION_GUIDE);
      expect(client.getServerCapabilities()?.prompts).toBeDefined();
      const list = await client.listPrompts();
      expect(list.prompts.map((p) => p.name)).toEqual(["present_for_people"]);
      const got = await client.getPrompt({
        name: "present_for_people",
        arguments: { question: "Q?" },
      });
      const c = got.messages[0]!.content;
      expect(
        c.type === "text" && c.text.includes(PRESENTATION_OUTLINE) && c.text.includes("Q?"),
      ).toBe(true);
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(15);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
