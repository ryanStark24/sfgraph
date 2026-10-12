const LABEL_ALIASES = {
  apex: "apexclass", class: "apexclass", trigger: "apextrigger", ip: "integrationprocedure",
  os: "omniscript", dr: "dataraptor", lightningcomponentbundle: "lwc", card: "vlocitycard",
  field: "customfield", object: "customobject",
};
// Cycle 3 T2: the plain kinds tool diagrams show (`Apex class: Foo`, `OmniScript (guided screen flow): X`),
// lowercased, to the label they stand for. Kept in step with KIND_SHORT in packages/mcp-server/src/tools/_plain.ts
// by a vitest there (plain.test.ts).
const PLAIN_LABELS = {
  "apex class": "apexclass", "apex trigger": "apextrigger", "apex interface": "apexinterface",
  "apex method": "apexmethod", "test method": "testmethod", "visualforce page": "apexpage",
  "visualforce component": "apexcomponent", "lightning web component": "lwc", "aura component": "auracomponent",
  "aura bundle": "auradefinitionbundle", flow: "flow", "flow version": "flowversion", workflow: "workflow",
  "workflow rule": "workflowrule", "workflow email alert": "workflowalert", "approval process": "approvalprocess",
  "validation rule": "validationrule", "duplicate rule": "duplicaterule", "matching rule": "matchingrule",
  "agent planner": "genaiplanner", "agent topic": "genaiplugin", omniscript: "omniscript",
  "integration procedure": "integrationprocedure", dataraptor: "dataraptor", flexcard: "vlocitycard",
  "omni process": "omniprocess", "omni integration procedure": "omniintegrationprocedure",
  "omni data mapper": "omnidatatransform", "omni flexcard": "omniuicard", "remote action": "remote",
  object: "customobject", field: "customfield", "custom setting": "customsetting",
  "custom metadata type": "custommetadatatype", "custom metadata record": "custommetadatarecord",
  "platform event": "platformevent", "event channel": "platformeventchannel", "named credential": "namedcredential",
  "external credential": "externalcredential", "external service": "externalserviceregistration",
  "connected app": "connectedapp", "remote site setting": "remotesitesetting", profile: "profile",
  "permission set": "permissionset", "permission set group": "permissionsetgroup", "sharing rule": "sharingrule",
  role: "role", group: "group", queue: "queue", "page layout": "layout", "lightning page": "flexipage",
  tab: "customtab", "record type": "recordtype", "experience site": "network", "custom label": "customlabel",
  "static resource": "staticresource", "email template": "emailtemplate", report: "report", dashboard: "dashboard",
  "unreadable file": "parseerror", "other setup item": "opaquemetadata",
};
// Labels the scorer knows (every sfgraph label, its aliases and plain kinds). After a known label, a space after the
// colon is the same as none (`Flow: X` = `Flow:X`); an unknown label keeps its text as it was.
const KNOWN_LABEL_TEXT = new Set([...Object.keys(PLAIN_LABELS), ...Object.values(PLAIN_LABELS),
  ...Object.keys(LABEL_ALIASES), ...Object.values(LABEL_ALIASES), "lwcbundle"]);
const NS_RE = /(%vlocity_namespace%__|vlocity_cmt__|vlocity_cmt\.)/g;

export function normalise(item, keySet) {
  let s = String(item).trim().replace(/^[`'"]+|[`'"]+$/g, "").toLowerCase().replace(NS_RE, "");
  if (!s) return null;
  const i = s.indexOf(":");
  if (i < 0) {
    if (keySet) {
      const hits = [...keySet].filter((k) => k.slice(k.indexOf(":") + 1) === s);
      if (hits.length === 1) return hits[0];
    }
    return `?:${s}`;
  }
  let label = s.slice(0, i);
  let name = s.slice(i + 1);
  const plain = PLAIN_LABELS[label.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+/g, " ")];
  if (plain) label = plain;
  if (KNOWN_LABEL_TEXT.has(label)) name = name.replace(/^ /, "");
  label = LABEL_ALIASES[label] ?? label;
  // Member rows fold onto the scored component (tool-tests/score.mjs
  // SCORED_MEMBER_OWNER): a method onto its class, a flow version
  // (`<Flow>.v<N>`) onto its flow, an LWC bundle onto its same-named LWC.
  if (label === "apexmethod" || label === "testmethod") {
    label = "apexclass";
    name = name.replace(/\(.*\)$/, "").split(".")[0];
  } else if (label === "flowversion") {
    label = "flow";
    name = name.replace(/\.v\d+$/, "");
  } else if (label === "lwcbundle") {
    label = "lwc";
  }
  // Card folder keys hyphenate spaces ("c360 Contact" -> c360-Contact); fold separators for cards.
  if (label === "vlocitycard") name = name.replace(/[\s_-]+/g, "-");
  return `${label}:${name}`;
}

function jsonBlocks(text) {
  const lines = String(text ?? "").split("\n");
  const blocks = [];
  let openBlock = null, openInfo = null, openContent = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      if (openBlock === null) {
        // Open a new block
        openInfo = line.slice(3).trim();
        openBlock = true;
        openContent = [];
      } else {
        // Close the open block
        const isJson = openInfo.includes("json") || (!openInfo && tryParseComponents(openContent.join("\n")));
        if (isJson) blocks.push(openContent.join("\n"));
        openBlock = null;
      }
    } else if (openBlock !== null) {
      openContent.push(line);
    }
  }

  return blocks;
}

export function extractComponents(text) {
  const blocks = jsonBlocks(text);
  for (let b = blocks.length - 1; b >= 0; b--) {
    try {
      const j = JSON.parse(blocks[b]);
      if (Array.isArray(j?.components)) return j.components.map(String);
    } catch { /* try earlier block */ }
  }
  return null;
}

// The "facts" object from the last fenced JSON block that carries one, else null.
export function extractFacts(text) {
  const blocks = jsonBlocks(text);
  for (let b = blocks.length - 1; b >= 0; b--) {
    try {
      const j = JSON.parse(blocks[b]);
      if (j?.facts && typeof j.facts === "object" && !Array.isArray(j.facts)) return j.facts;
    } catch { /* try earlier block */ }
  }
  return null;
}

function tryParseComponents(text) {
  try {
    const j = JSON.parse(text);
    return Array.isArray(j?.components);
  } catch {
    return false;
  }
}

export function scoreTask(answer, expected) {
  const key = new Set(expected.map((e) => normalise(e)).filter(Boolean));
  if (answer === null) return { p: 0, r: 0, f1: 0, tp: 0, fp: 0, fn: key.size, misses: [...key].sort(), extras: [] };
  const got = new Set(answer.map((a) => normalise(a, key)).filter(Boolean));
  const tp = [...got].filter((g) => key.has(g)).length;
  const fp = got.size - tp;
  const fn = key.size - tp;
  if (key.size === 0 && got.size === 0) return { p: 1, r: 1, f1: 1, tp, fp, fn, misses: [], extras: [] };
  const p = got.size ? tp / got.size : 0;
  const r = key.size ? tp / key.size : 0;
  const f1 = p + r ? (2 * p * r) / (p + r) : 0;
  return { p, r, f1, tp, fp, fn,
    misses: [...key].filter((k) => !got.has(k)).sort(),
    extras: [...got].filter((g) => !key.has(g)).sort() };
}
