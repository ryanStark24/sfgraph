#!/usr/bin/env node
/**
 * Real-browser check for "Render entire org" (S-1.8.2-009, claim C-1.8.2-061).
 *
 *   pnpm --filter @ryanstark24/sfgraph-web build
 *   node packages/web/scripts/explorer-fullgo.mjs
 *
 * Seeds a temp SQLite store (placeholder names only), starts the real web
 * server, opens the explorer in Chromium, clicks the button and checks that
 * the OmniScript node reaches the graph and the limit text is shown.
 *
 * Needs Playwright with Chromium (not a dependency of this repo, so this is a
 * script and not part of `pnpm test`). The explorer loads three.js and
 * 3d-force-graph from esm.sh; this script answers those two requests with
 * small stand-ins (and records what the page hands to `graphData`), so it
 * checks the explorer's own code and its calls to the server, not the 3D
 * rendering, and needs no network.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "../dist/index.js");

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  try {
    return req("playwright");
  } catch {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    return createRequire(path.join(root, "x.js"))("playwright");
  }
}

const ORG = "00DAAAAAAAAAAAA";
const tmpHome = mkdtempSync(path.join(tmpdir(), "sfg-explorer-"));
process.env.SFGRAPH_DATA_DIR = tmpHome;

const core = createRequire(webDist)("@ryanstark24/sfgraph-core");
const { asOrgId } = createRequire(webDist)("@ryanstark24/sfgraph-shared");
const oid = asOrgId(ORG);
const fact = (label, name) => ({
  orgId: oid,
  label,
  qualifiedName: `${label}:${name}`,
  attributes: {},
  sourceHash: `h-${label}-${name}`,
  firstSeenAt: 1,
  lastSeenAt: 1,
  lastModifiedAt: 1,
});
const store = new core.SqliteGraphStore({ dbPath: path.join(tmpHome, `${ORG}.sqlite`) });
await store.init();
store.upsertOrg({ id: oid, alias: "acme", apiVersion: "65.0", instanceUrl: "", createdAt: 1 });
store.mergeNodes([
  fact("ApexClass", "AcmeGreeter"),
  fact("CustomObject", "Acme_Order__c"),
  fact("OmniScript", "Acme_Intake_English"),
  fact("DataRaptor", "Acme_Load"),
]);
await store.close();

// Stand-ins for the two esm.sh modules. Any property or call on them is a no-op
// chain; `graphData(x)` remembers x so the check can read what was rendered.
const PROXY = `
const mk = () => new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : mk()),
  apply: () => mk(),
  construct: () => mk(),
  set: () => true,
});`;
const forceGraphStub = `${PROXY}
export default function ForceGraph3D() {
  return () => {
    const g = new Proxy({}, { get: (_t, k) => {
      if (k === "graphData") return (d) => { if (d === undefined) return window.__graph ?? { nodes: [], links: [] }; window.__graph = d; return g; };
      if (["scene", "camera", "controls", "d3Force", "renderer"].includes(k)) return () => mk();
      return () => g;
    } });
    return g;
  };
}`;
const names = [
  "AdditiveBlending",
  "BufferAttribute",
  "BufferGeometry",
  "CanvasTexture",
  "Color",
  "DirectionalLight",
  "Fog",
  "Group",
  "LinearFilter",
  "Mesh",
  "MeshStandardMaterial",
  "PointLight",
  "Points",
  "PointsMaterial",
  "SphereGeometry",
  "Sprite",
  "SpriteMaterial",
];
const threeStub = `${PROXY}\n${names.map((n) => `export const ${n} = mk();`).join("\n")}`;

const { chromium } = loadPlaywright();
const { startWebServer } = await import(webDist);
const handle = await startWebServer({ port: 0, log: () => {} });
const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/esm\.sh/, (r) => {
    const u = r.request().url();
    r.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: u.includes("three@") ? threeStub : forceGraphStub,
    });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(handle.url);
  await page.waitForFunction(() => document.querySelector("#labelList input") !== null);
  await page.click('[data-tab="overview"]');
  // Limit of 3 of 4 stored nodes: the hint must say so in words.
  await page.fill("#overviewLimit", "3");
  await page.click("#fullGo");
  await page.waitForFunction(() => /Showing/.test(document.getElementById("fullHint").textContent));
  const hint3 = await page.textContent("#fullHint");
  const badge3 = await page.evaluate(
    () => !document.getElementById("truncBadge").classList.contains("hidden"),
  );
  console.log("limit 3 hint:", hint3, "| truncated badge:", badge3);
  // Large enough limit: all four nodes, OmniScript included.
  await page.fill("#overviewLimit", "100");
  await page.click("#fullGo");
  await page.waitForFunction(() =>
    /Showing 4 of 4/.test(document.getElementById("fullHint").textContent),
  );
  const ids = await page.evaluate(() => window.__graph.nodes.map((n) => n.id).sort());
  const hint100 = await page.textContent("#fullHint");
  console.log("limit 100 hint:", hint100);
  console.log("rendered nodes:", JSON.stringify(ids));
  const ok =
    /Showing 3 of 4 nodes/.test(hint3) &&
    /1 left out by the node limit/.test(hint3) &&
    badge3 &&
    ids.includes("OmniScript:Acme_Intake_English") &&
    ids.length === 4 &&
    errors.length === 0;
  if (errors.length) console.log("page errors:", errors);
  console.log(ok ? "EXPLORER_FULLGO_OK" : "EXPLORER_FULLGO_FAILED");
  failed = !ok;
} finally {
  await browser.close();
  await handle.stop();
  rmSync(tmpHome, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
