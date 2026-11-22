import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findSkillsRoot, listSkillsBundled } from "../installer.js";

/**
 * Org safety in the playbook text: any playbook that mentions an `sf` command must tell the agent
 * to ask the user first, to name the org, to stay off production unasked and to leave write and
 * deploy commands alone; and no `sf` command that reads from an org may be shown without a
 * named org.
 */

const ORG_READS = /`(sf (?:project retrieve|data query|apex (?:list|get) log)[^`]*)`/g;

async function playbooks(): Promise<Array<{ name: string; text: string }>> {
  const root = findSkillsRoot();
  const names = await listSkillsBundled();
  return names.map((name) => ({ name, text: readFileSync(join(root, name, "SKILL.md"), "utf8") }));
}

describe("playbook org safety", () => {
  it("every playbook that mentions an sf command carries the ask-first rule", async () => {
    const withSf = (await playbooks()).filter((p) => /`sf [a-z]/.test(p.text));
    expect(withSf.length).toBeGreaterThan(0);
    for (const { name, text } of withSf) {
      expect(text, name).toMatch(/ask the user and show the exact command/i);
      expect(text, name).toContain("--target-org");
      expect(text, name).toMatch(/never run against production/i);
      expect(text, name).toMatch(/never run or suggest write or deploy commands/i);
    }
  });

  it("every sf command that reads from an org names the org", async () => {
    for (const { name, text } of await playbooks()) {
      for (const m of text.matchAll(ORG_READS)) {
        // `…` stands for the elided query body in examples; the org flag must still be present.
        expect(m[1], `${name}: ${m[1]}`).toContain("--target-org");
      }
    }
  });

  it("no playbook tells the agent to fetch from the org freely or to tail logs", async () => {
    for (const { name, text } of await playbooks()) {
      expect(text, name).not.toMatch(/fetch freely|\(fetch when needed\)|pull it from the org\b/i);
      expect(text, name).not.toMatch(/go get the evidence or stop/i);
      // Only the safety rule itself may mention tailing, and only to forbid it.
      for (const line of text.split("\n")) {
        if (/sf apex tail log/.test(line))
          expect(line, name).toMatch(/do not run|never run|can create a trace flag/i);
      }
    }
  });
});
