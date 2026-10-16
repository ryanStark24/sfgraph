import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REL_TYPES, VLOCITY_TARGET_LABEL, analyze, render } from "@ryanstark24/sfgraph-core";
import { describe, expect, it } from "vitest";
import { KIND_SHORT, PLAIN_KINDS, PLAIN_RELS, plainKind, plainRel } from "../_plain.js";

// Cycle 3 T2: one plain-word dictionary for every graph label and relationship type core defines.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../../..");
const jargon = JSON.parse(readFileSync(path.join(REPO, "bench/quality/jargon.json"), "utf8")) as {
  patterns: { id: string; regex: string; flags?: string }[];
  words: string[];
};
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const banned = [
  ...jargon.patterns.map((p) => new RegExp(p.regex, p.flags ?? "")),
  ...jargon.words.map((w) => new RegExp(`\\b${esc(w).replace(/\s+/g, "\\s+")}s?\\b`, "i")),
];

const coreLabels = [
  ...new Set([
    ...Object.keys(analyze.COMPONENT_LABEL_REASONS),
    ...Object.keys(analyze.RECORD_CONFIG_LABEL_REASONS),
    ...Object.keys(render.LABEL_COLORS).filter((l) => l !== "Default"),
    ...Object.values(VLOCITY_TARGET_LABEL),
  ]),
].sort();
const coreRels = Object.values(REL_TYPES).sort();

describe("plain-word dictionary covers core", () => {
  it("enumerates a real label and relationship list", () => {
    expect(coreLabels.length).toBeGreaterThan(50);
    expect(coreLabels).toContain("Remote");
    expect(coreLabels).toContain("LightningComponentBundle");
    expect(coreRels.length).toBeGreaterThan(90);
  });

  it("has an entry for every node label core defines", () => {
    expect(coreLabels.filter((l) => !(l in PLAIN_KINDS))).toEqual([]);
    expect(coreLabels.filter((l) => !(l in KIND_SHORT))).toEqual([]);
  });

  it("has an entry for every relationship type core defines", () => {
    expect(coreRels.filter((r) => !(r in PLAIN_RELS))).toEqual([]);
  });

  it("uses the spec's example words", () => {
    expect(plainKind("ApexClass")).toBe("Apex class (server code)");
    expect(plainKind("OmniScript")).toBe("OmniScript (a guided screen flow)");
    // Cycle 3 T9 fix 1: a gloss with an article takes a plural gloss.
    expect(plainKind("OmniScript", { plural: true })).toBe("OmniScripts (guided screen flows)");
    expect(KIND_SHORT.ApexClass).toBe("Apex class");
    expect(plainRel("CALLS")).toBe("calls");
    expect(plainRel("READS_FIELD")).toBe("reads the field");
    expect(plainRel("CONTAINS_METHOD")).toBe("has the method");
  });

  it("forms plurals on the short kind and keeps the gloss", () => {
    expect(plainKind("ApexClass", { plural: true })).toBe("Apex classes (server code)");
    expect(plainKind("Flow", { plural: true })).toMatch(/^Flows\b/);
    expect(plainKind("CustomField", { plural: true })).toMatch(/^Fields\b/);
  });

  it("falls back to spaced lowercase for an unknown value, never the raw constant", () => {
    expect(plainKind("FooBarBaz")).toBe("foo bar baz");
    expect(plainKind("XMLThingType")).toBe("xml thing type");
    expect(plainKind("FooBar", { plural: true })).toBe("foo bars");
    expect(plainRel("SOME_NEW_REL")).toBe("some new rel");
    expect(plainRel("someCamelRel")).toBe("some camel rel");
    expect(plainKind("")).toBe("component");
  });

  it("every dictionary word passes the jargon list", () => {
    const words = [
      ...coreLabels.flatMap((l) => [plainKind(l), plainKind(l, { plural: true }), KIND_SHORT[l]!]),
      ...coreRels.map((r) => plainRel(r)),
    ];
    const bad = words.filter((w) => banned.some((re) => re.test(w)));
    expect(bad).toEqual([]);
  });

  it("the diagram scorer reads every plain kind as its label", async () => {
    const mod = (await import(pathToFileURL(path.join(REPO, "bench/lib/normalise.mjs")).href)) as {
      normalise: (s: string) => string;
    };
    const wrong = coreLabels.filter((l) => {
      const want = mod.normalise(`${l}:Foo.bar(1)`);
      return (
        mod.normalise(`${KIND_SHORT[l]}: Foo.bar(1)`) !== want ||
        mod.normalise(`${plainKind(l)}: Foo.bar(1)`) !== want
      );
    });
    expect(wrong).toEqual([]);
  });
});
