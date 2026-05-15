/* sfgraph explorer — galactic visualisation (three.js + 3d-force-graph).
 *
 * Goals:
 *   1. Cluster nodes by label so similar things orbit together → galaxy feel.
 *   2. Bigger spheres for high-degree hubs. Stars vs planets.
 *   3. Per-node text labels that fade in only when the camera is close enough
 *      to read them — no permanent text spam at distance.
 *   4. Double-click = fly in close; single-click = inspector + soft zoom.
 *   5. UnrealBloomPass over emissive materials → real glowing orbs.
 *   6. Background starfield so empty space isn't empty.
 */

import ForceGraph3D from "https://esm.sh/3d-force-graph@1.73.4";
import * as THREE from "https://esm.sh/three@0.160.0";
// NOTE: UnrealBloomPass was tried as a render layer for "real" glow, but it
// silently breaks the postProcessingComposer's output (entire canvas blacks
// out) when the addon's three.js version differs subtly from the one
// 3d-force-graph bundles. Sticking with stronger emissive + halo sprites,
// which is 95% of the look at zero render-pipeline risk.

/* ── per-label color map ── */
const LABEL_COLOR = {
  ApexClass: "#ff8a4c",
  ApexTrigger: "#ff8a4c",
  ApexMethod: "#ffb380",
  TestMethod: "#ffd6b3",
  ApexPage: "#ff8a4c",
  LightningComponentBundle: "#5eecff",
  LWC: "#5eecff",
  LWCBundle: "#5eecff",
  AuraDefinitionBundle: "#5eecff",
  Flow: "#b794f4",
  FlowVersion: "#d4b6ff",
  CustomField: "#4ade80",
  CustomObject: "#f5d76e",
  Profile: "#ff5ec8",
  PermissionSet: "#ff5ec8",
  PermissionSetGroup: "#ff5ec8",
  SharingRule: "#ff96d8",
  NamedCredential: "#b9ff5e",
  ExternalServiceRegistration: "#b9ff5e",
  StaticResource: "#8b95b8",
  CustomLabel: "#8b95b8",
  Workflow: "#b794f4",
};
const colorFor = (lbl) => LABEL_COLOR[lbl] ?? "#8b95b8";
const shortName = (qn) => {
  const i = qn.indexOf(":");
  return i >= 0 ? qn.slice(i + 1) : qn;
};

/* ── galactic cluster centres. Each label gets its own region of 3D space.
 *    Initial node positions are seeded near these centres + jitter; d3-force
 *    then relaxes within the cluster. Coordinates are tuned to feel like a
 *    sparse galaxy at default camera distance (~500 units). ── */
// Cluster centres in a tighter ±180 cube — keeps the whole graph inside the
// camera's natural framing even with 1500 nodes. Wider spread caused the
// layout to balloon outward and zoomToFit had to pull the camera so far
// back everything became unreadable specks.
const CLUSTER_CENTERS = {
  ApexClass: { x: -180, y: 30, z: 0 },
  ApexTrigger: { x: -170, y: 90, z: -40 },
  ApexMethod: { x: -110, y: 0, z: -20 },
  TestMethod: { x: -140, y: -80, z: 30 },
  ApexPage: { x: -200, y: -20, z: 40 },
  LightningComponentBundle: { x: 180, y: 40, z: 30 },
  LWC: { x: 180, y: 40, z: 30 },
  LWCBundle: { x: 180, y: 40, z: 30 },
  AuraDefinitionBundle: { x: 200, y: -20, z: 50 },
  Flow: { x: 0, y: 170, z: -50 },
  FlowVersion: { x: 40, y: 170, z: -20 },
  CustomObject: { x: 0, y: -170, z: 60 },
  CustomField: { x: 45, y: -160, z: 30 },
  Profile: { x: -180, y: -120, z: -100 },
  PermissionSet: { x: -160, y: -140, z: -80 },
  PermissionSetGroup: { x: -150, y: -120, z: -120 },
  SharingRule: { x: -190, y: -90, z: -60 },
  NamedCredential: { x: 180, y: -110, z: -90 },
  ExternalServiceRegistration: { x: 200, y: -90, z: -120 },
  StaticResource: { x: 100, y: 100, z: 120 },
  CustomLabel: { x: 50, y: 50, z: 140 },
  Workflow: { x: -50, y: 150, z: -100 },
};
const ORPHAN_CENTER = { x: 0, y: 0, z: 0 };
const jitter = (n = 50) => (Math.random() - 0.5) * n;

/* ── api ── */
const api = async (p) => {
  const r = await fetch(p);
  if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
  return r.json();
};

/* ── state ── */
let currentOrgId = "";
let relTypes = [];
const labelOptions = [
  "ApexClass",
  "ApexTrigger",
  "ApexMethod",
  "LightningComponentBundle",
  "LWC",
  "LWCBundle",
  "Flow",
  "FlowVersion",
  "CustomObject",
  "CustomField",
  "Profile",
  "PermissionSet",
  "NamedCredential",
];
let hoveredNode = null;
let inspectorNodeId = null;
let alwaysShowLabels = false;
/** Degree threshold above which a node is considered a "hub" and gets its
 *  label permanently visible regardless of camera distance. Recomputed in
 *  setData() from the top ~5% of the degree distribution. */
let hubDegreeThreshold = Infinity;
/** id -> { group, core, halo, label, _id, _isHub } — populated in
 *  nodeThreeObject so the per-frame label updater never has to depend on
 *  3d-force-graph's internal `__threeObj` property (which has renamed
 *  between versions). */
const nodeRegistry = new Map();

/* ── label sprite factory — canvas-textured Sprite so labels billboard to
 *    the camera and stay legible from any angle ── */
function makeLabelSprite(text, color) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  // Render at 2x for crispness on retina.
  const fontPx = 36;
  const padX = 18;
  const padY = 10;
  ctx.font = `500 ${fontPx}px "JetBrains Mono", ui-monospace, monospace`;
  const textW = Math.ceil(ctx.measureText(text).width);
  canvas.width = textW + padX * 2;
  canvas.height = fontPx + padY * 2;
  // Re-set font (canvas resize resets context state).
  ctx.font = `500 ${fontPx}px "JetBrains Mono", ui-monospace, monospace`;
  // Dark capsule background.
  ctx.fillStyle = "rgba(8, 12, 24, 0.85)";
  const r = 10;
  const w = canvas.width;
  const h = canvas.height;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(w - r, 0);
  ctx.quadraticCurveTo(w, 0, w, r);
  ctx.lineTo(w, h - r);
  ctx.quadraticCurveTo(w, h, w - r, h);
  ctx.lineTo(r, h);
  ctx.quadraticCurveTo(0, h, 0, h - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();
  // Subtle inner stroke matching node colour.
  ctx.strokeStyle = `${color}44`;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Text.
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, padX, h / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    opacity: 0,
  });
  const sprite = new THREE.Sprite(material);
  // 1 canvas pixel ≈ 0.18 world units. Tweak if labels feel huge/tiny.
  sprite.scale.set(canvas.width * 0.18, canvas.height * 0.18, 1);
  sprite.position.set(0, 14, 0); // hover above node
  sprite.userData.isLabel = true;
  sprite.userData.color = color;
  return sprite;
}

/* ── 3d-force-graph singleton ── */
const graphEl = document.getElementById("graph");
const Graph = ForceGraph3D({ controlType: "orbit" })(graphEl)
  .backgroundColor("rgba(0,0,0,0)")
  .showNavInfo(false)
  .nodeRelSize(5)
  .nodeOpacity(1)
  .nodeResolution(18)
  .nodeColor((n) => colorFor(n.label))
  .nodeLabel(() => "") // disable HTML tooltip — we have 3D sprite labels
  .linkColor(() => "rgba(168, 197, 255, 0.22)")
  .linkWidth(0.7)
  .linkOpacity(0.55)
  .linkDirectionalParticles(2)
  .linkDirectionalParticleSpeed(0.0042)
  .linkDirectionalParticleWidth(1.6)
  .linkDirectionalParticleColor(() => "#5eecff")
  .linkDirectionalArrowLength(2.4)
  .linkDirectionalArrowRelPos(0.94)
  .linkDirectionalArrowColor(() => "rgba(94, 236, 255, 0.55)")
  .onNodeHover((n) => {
    graphEl.style.cursor = n ? "pointer" : "grab";
    hoveredNode = n;
  })
  .cooldownTicks(120) // simulation stops settling after this many ticks
  .warmupTicks(20); // pre-bake some ticks before the first frame

// Weaken the default charge so 1500 disconnected nodes don't fly off into a
// vast sphere the camera can't frame. Add a stronger centering force so the
// whole graph stays roughly inside the cluster cube.
try {
  Graph.d3Force("charge").strength(-18); // default ~ -30
  Graph.d3Force("center").strength(0.4); // default 0.1
} catch {
  /* d3-force API not available — accept defaults */
}

/* size scaling: every node has a visible minimum size even when zoomed
 * out; hubs get an extra log-scaled bump so the eye can pick them out as
 * stars amongst planets. */
const baseRadius = (n) => 4 + Math.min(9, Math.log2(1 + (n.degree ?? 1)) * 2);

Graph.nodeThreeObject((n) => {
  const colorHex = colorFor(n.label);
  const c = new THREE.Color(colorHex);
  const group = new THREE.Group();

  const radius = baseRadius(n);
  const geo = new THREE.SphereGeometry(radius, 22, 22);
  const mat = new THREE.MeshStandardMaterial({
    color: c,
    emissive: c,
    emissiveIntensity: 1.05,
    roughness: 0.35,
    metalness: 0.15,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.isCore = true;
  group.add(mesh);

  // Soft additive halo — much of the "glow" effect comes from this since
  // we don't run a bloom post-pass.
  const haloMat = new THREE.SpriteMaterial({
    map: haloTexture(colorHex),
    color: c,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.6,
  });
  const halo = new THREE.Sprite(haloMat);
  const haloSize = radius * 7;
  halo.scale.set(haloSize, haloSize, 1);
  halo.userData.isHalo = true;
  group.add(halo);

  // Text label sprite — opacity driven per-frame by camera distance.
  const lbl = makeLabelSprite(shortName(n.id), colorHex);
  lbl.position.y = radius + 11;
  group.add(lbl);

  // Track for the label updater. Cleared in setData() when a new graph
  // loads so stale entries don't linger. `_isHub` lets the per-frame loop
  // force-show the label for high-degree nodes (galactic-core stars in
  // the metaphor) without recomputing the threshold every frame.
  nodeRegistry.set(n.id, {
    _id: n.id,
    _isHub: (n.degree ?? 0) >= hubDegreeThreshold,
    group,
    core: mesh,
    halo,
    label: lbl,
  });

  return group;
});

/* halo texture — a radial gradient on a canvas, cached per colour ── */
const HALO_CACHE = new Map();
function haloTexture(colorHex) {
  if (HALO_CACHE.has(colorHex)) return HALO_CACHE.get(colorHex);
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(0.25, `${colorHex}cc`);
  g.addColorStop(0.6, `${colorHex}33`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  HALO_CACHE.set(colorHex, tex);
  return tex;
}

/* ── scene: lighting, fog, starfield, bloom ── */
const scene = Graph.scene();
// Bump ambient + add accent point lights so the spheres pop.
for (const c of scene.children) if (c.isAmbientLight) c.intensity = 0.55;
scene.add(makeLight(0xffffff, 0.55, [200, 300, 200]));
scene.add(makePointLight(0x5eecff, 1.4, 1200, [0, 0, 0]));
scene.add(makePointLight(0xff5ec8, 0.5, 1500, [-400, -300, -400]));

// Soft depth haze far in the distance. Earlier values (far=2400) were
// killing the entire scene when the user scrolled out — every node ended
// up past the fog plane and the canvas blacked out. With far=9000 the
// fog only affects the starfield shell, never the data.
scene.fog = new THREE.Fog(0x05070d, 2500, 9000);

// Starfield backdrop — 3000 points on a sphere shell beyond the data.
// Pushed to radius 6000 so the user can scroll out a long way without
// flying through the shell.
addStarfield(scene, { count: 3000, radius: 6000 });

function makeLight(color, intensity, pos) {
  const l = new THREE.DirectionalLight(color, intensity);
  l.position.set(...pos);
  return l;
}
function makePointLight(color, intensity, range, pos) {
  const l = new THREE.PointLight(color, intensity, range);
  l.position.set(...pos);
  return l;
}
function addStarfield(scene, { count, radius }) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Point on a sphere via spherical → cartesian.
    const u = Math.random() * 2 - 1;
    const t = Math.random() * Math.PI * 2;
    const r = radius * (0.9 + Math.random() * 0.1);
    const s = Math.sqrt(1 - u * u);
    positions[i * 3] = r * s * Math.cos(t);
    positions[i * 3 + 1] = r * s * Math.sin(t);
    positions[i * 3 + 2] = r * u;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xa8c5ff,
    size: 1.6,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  // Stars don't move with the simulation.
  points.userData.skipLayout = true;
  scene.add(points);
}

// (no post-processing — see import note at top)

/* ── orbit controls: smoother rotate/pan/zoom ── */
const controls = Graph.controls();
if (controls) {
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.55;
  controls.panSpeed = 0.85;
  controls.zoomSpeed = 0.85;
  controls.enablePan = true;
  // Mac trackpad: two-finger drag = pan, pinch = zoom. Mouse: right-drag = pan.
  controls.screenSpacePanning = true;
}

/* ── resize ── */
const resize = () => Graph.width(graphEl.clientWidth).height(graphEl.clientHeight);
new ResizeObserver(resize).observe(graphEl);
resize();

/* ── label visibility: top-N nearest + always-show overrides ──
 *
 * The old purely-distance approach used fixed world-units thresholds. That
 * worked when the camera was close, but on a 1500-node graph the user
 * zooms out to see everything — every node falls outside the threshold
 * and ALL labels disappear at once. The screen goes label-free exactly
 * when the user needs anchor points the most.
 *
 * New rule: at any moment, show labels for
 *   - the `TOP_LABEL_COUNT` nodes nearest the camera (fades by rank)
 *   - any "hub" node (top ~5% by degree — set in setData)
 *   - the hovered node
 *   - the node currently in the inspector
 *   - everything, if the user pressed `L` (alwaysShowLabels)
 *
 * This keeps a stable ~30 readable anchor labels visible at every zoom
 * level. As you scroll in, the set rotates to favour what's actually
 * under your nose.
 */
const TOP_LABEL_COUNT = 35;
function tickLabels() {
  const cam = Graph.camera();
  const visible = [];
  for (const entry of nodeRegistry.values()) {
    const { group, label } = entry;
    if (!group || !group.parent || !label) continue;
    const dx = cam.position.x - group.position.x;
    const dy = cam.position.y - group.position.y;
    const dz = cam.position.z - group.position.z;
    entry._dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    visible.push(entry);
  }
  // Sort by camera distance ascending; closest first.
  visible.sort((a, b) => a._dist - b._dist);

  for (let i = 0; i < visible.length; i++) {
    const e = visible[i];
    const isHovered = hoveredNode && hoveredNode.id === e._id;
    const isInspecting = inspectorNodeId && inspectorNodeId === e._id;
    const isHub = e._isHub;
    const inTopN = i < TOP_LABEL_COUNT;

    let opacity;
    if (alwaysShowLabels || isHovered || isInspecting || isHub) {
      opacity = 1;
    } else if (inTopN) {
      // Fade from 1.0 at the nearest down to 0.55 at the cutoff — soft
      // boundary so the ring of just-out-of-frame labels doesn't visibly
      // snap on/off as the camera moves.
      opacity = 1 - (i / TOP_LABEL_COUNT) * 0.45;
    } else {
      opacity = 0;
    }

    if (e.label) {
      e.label.material.opacity = opacity;
      e.label.visible = opacity > 0.02;
    }

    if (isHovered || isInspecting) {
      if (e.core) e.core.scale.setScalar(1.3);
      if (e.halo) e.halo.material.opacity = 0.9;
    } else {
      if (e.core) e.core.scale.setScalar(1);
      if (e.halo) e.halo.material.opacity = 0.6;
    }
  }
  requestAnimationFrame(tickLabels);
}
tickLabels();

/* ── data ingestion ── */
function setData(payload, centerId = null) {
  // Wipe the registry — old node entries are about to be garbage from the
  // scene as 3d-force-graph replaces the graph data.
  nodeRegistry.clear();
  inspectorNodeId = null;
  hubDegreeThreshold = Infinity; // reset; recomputed below
  // De-dupe edges, compute degree.
  const links = [];
  const seen = new Set();
  const degree = new Map();
  for (const e of payload.edges) {
    const k = `${e.source}→${e.target}|${e.relType}`;
    if (seen.has(k)) continue;
    seen.add(k);
    links.push({ source: e.source, target: e.target, relType: e.relType });
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  // Top ~5% of nodes by degree are "hubs" — their labels stay on even at
  // far zoom so the eye has anchor points across the whole graph.
  const degreesSorted = [...degree.values()].sort((a, b) => b - a);
  hubDegreeThreshold =
    degreesSorted.length > 20
      ? (degreesSorted[Math.floor(degreesSorted.length * 0.05)] ?? Infinity)
      : Infinity;

  const nodes = payload.nodes.map((n) => {
    const c = CLUSTER_CENTERS[n.label] ?? ORPHAN_CENTER;
    return {
      id: n.id,
      label: n.label,
      short: shortName(n.id),
      degree: degree.get(n.id) ?? 0,
      // Pre-seed initial positions inside the cluster — d3-force then relaxes
      // within the local neighbourhood, preserving the cluster shape.
      x: c.x + jitter(110),
      y: c.y + jitter(110),
      z: c.z + jitter(110),
    };
  });
  Graph.graphData({ nodes, links });
  document.getElementById("canvasHint").classList.toggle("hidden", nodes.length > 0);
  document.getElementById("statNodes").textContent = nodes.length.toLocaleString();
  document.getElementById("statEdges").textContent = links.length.toLocaleString();
  document.getElementById("truncBadge").classList.toggle("hidden", !payload.truncated);
  // Two-stage framing: first cheap fit at 1.5s once the simulation has
  // done its initial relaxation, then a second pass at 3s after the
  // cooldown ticks finish — by then positions are stable and the framing
  // is final. Without the second pass on big data sets, the graph
  // sometimes settles outside the initial frame and looks empty.
  setTimeout(() => Graph.zoomToFit(800, 60), 1500);
  setTimeout(() => Graph.zoomToFit(800, 60), 3000);
  if (centerId) {
    setTimeout(() => {
      const n = Graph.graphData().nodes.find((x) => x.id === centerId);
      if (n) flyTo(n, 140);
    }, 2200);
  }
}

/* ── camera fly-to ── */
function flyTo(node, distance = 100, durationMs = 1000) {
  const r = Math.hypot(node.x ?? 0, node.y ?? 0, node.z ?? 0) || 1;
  const scale = (r + distance) / r;
  Graph.cameraPosition(
    {
      x: (node.x ?? 0) * scale,
      y: (node.y ?? 0) * scale,
      z: (node.z ?? 0) * scale,
    },
    { x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 },
    durationMs,
  );
}

/* ── click + double-click handling ──
 *
 * Single-click: open inspector + soft zoom.
 * Double-click: fly in really close, no inspector spawn (you're already
 * focused on it visually).
 */
let lastClickAt = 0;
let lastClickNode = null;
const DOUBLE_CLICK_MS = 320;
Graph.onNodeClick((node) => {
  const now = Date.now();
  if (lastClickNode === node && now - lastClickAt < DOUBLE_CLICK_MS) {
    // Double-click: zoom way in.
    flyTo(node, 35, 1100);
    lastClickAt = 0;
    lastClickNode = null;
  } else {
    flyTo(node, 110, 900);
    showInspector(node);
    lastClickAt = now;
    lastClickNode = node;
  }
});

/* ── bootstrap ── */
async function bootstrap() {
  const orgsResp = await api("/api/orgs");
  const orgs = Array.isArray(orgsResp) ? orgsResp : orgsResp.orgs ?? [];
  const errors = (orgsResp && orgsResp.errors) || [];
  const sel = document.getElementById("orgSel");
  for (const o of orgs) {
    const opt = document.createElement("option");
    opt.value = o.orgId;
    opt.textContent = `${o.alias} — ${o.nodeCount.toLocaleString()} nodes`;
    opt.dataset.meta = `api v${o.apiVersion ?? "?"} · ${o.edgeCount.toLocaleString()} edges`;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => {
    currentOrgId = sel.value;
    const opt = sel.selectedOptions[0];
    document.getElementById("orgMeta").textContent = opt?.dataset?.meta ?? "";
  });
  if (orgs.length === 1) {
    sel.value = orgs[0].orgId;
    sel.dispatchEvent(new Event("change"));
  }
  if (orgs.length === 0 && errors.length > 0) showOrgError(errors);

  relTypes = await api("/api/rel-types");
  const relList = document.getElementById("relList");
  for (const r of relTypes) {
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = r;
    cb.checked = true;
    cb.addEventListener("change", updateRelCount);
    lab.append(cb, document.createTextNode(r));
    relList.appendChild(lab);
  }
  updateRelCount();

  const labList = document.getElementById("labelList");
  const defaults = new Set(["ApexClass", "LightningComponentBundle", "Flow"]);
  for (const l of labelOptions) {
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = l;
    cb.checked = defaults.has(l);
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = colorFor(l);
    dot.style.color = colorFor(l);
    lab.append(cb, dot, document.createTextNode(l));
    labList.appendChild(lab);
  }

  // Legend.
  const legendList = document.getElementById("legendList");
  const legendLabels = [
    ["Apex", "ApexClass"],
    ["LWC", "LightningComponentBundle"],
    ["Flow", "Flow"],
    ["Field", "CustomField"],
    ["Object", "CustomObject"],
    ["Profile/Perm", "Profile"],
    ["Cred", "NamedCredential"],
    ["Other", "Unknown"],
  ];
  for (const [name, key] of legendLabels) {
    const row = document.createElement("div");
    row.className = "li";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = colorFor(key);
    dot.style.color = colorFor(key);
    row.append(dot, document.createTextNode(name));
    legendList.appendChild(row);
  }

  setTabGlow(document.querySelector(".tab.active"));
  window.addEventListener("resize", () => setTabGlow(document.querySelector(".tab.active")));
}

function showOrgError(errors) {
  const existing = document.getElementById("orgErrBanner");
  if (existing) existing.remove();
  const isAbi = errors.some((e) =>
    /NODE_MODULE_VERSION|MODULE_NOT_FOUND|better-sqlite3|was compiled against/i.test(e.error),
  );
  const banner = document.createElement("div");
  banner.id = "orgErrBanner";
  banner.style.cssText = `
    position: fixed; top: 96px; left: 50%; transform: translateX(-50%);
    z-index: 12; max-width: 720px; padding: 18px 22px;
    background: rgba(40, 10, 30, 0.85); backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 94, 200, 0.4);
    border-radius: 12px; color: #ffd8eb;
    box-shadow: 0 12px 40px rgba(0,0,0,0.6);
    font: 13px/1.5 Inter, sans-serif;
  `;
  const isDataDir = errors.length === 1 && errors[0].orgId === "(data-dir)";
  if (isDataDir) {
    banner.innerHTML = `
      <strong style="color:#ff5ec8;display:block;margin-bottom:4px;">No ingested orgs found</strong>
      <span style="color:#aab4d4;">${errors[0].error}</span>
      <div style="margin-top:10px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#aab4d4;">
        Run <span style="color:#5eecff;">sfgraph ingest --org &lt;alias&gt;</span> from a shell first.
      </div>`;
  } else if (isAbi) {
    banner.innerHTML = `
      <strong style="color:#ff5ec8;display:block;margin-bottom:4px;">better-sqlite3 native binding mismatch</strong>
      <span style="color:#aab4d4;">The binding was built for a different Node ABI than the one running <code>sfgraph serve</code>.</span>
      <div style="margin-top:10px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#aab4d4;">
        Fix: <span style="color:#5eecff;">pnpm rebuild better-sqlite3</span> from the project root, then re-run.
      </div>`;
  } else {
    banner.innerHTML = `
      <strong style="color:#ff5ec8;display:block;margin-bottom:4px;">Failed to load ${errors.length} org${errors.length > 1 ? "s" : ""}</strong>
      <pre style="white-space:pre-wrap;color:#ffb86b;font-size:11px;margin:6px 0 0;font-family:'JetBrains Mono',monospace;">${errors.map((e) => `${e.orgId}: ${e.error}`).join("\n")}</pre>`;
  }
  document.body.appendChild(banner);
}

function updateRelCount() {
  const all = document.querySelectorAll("#relList input");
  const on = document.querySelectorAll("#relList input:checked").length;
  document.getElementById("relCount").textContent =
    on === all.length ? "all" : `${on}/${all.length}`;
}

/* ── tabs ── */
function setTabGlow(activeTab) {
  if (!activeTab) return;
  const glow = document.getElementById("tabGlow");
  const r = activeTab.getBoundingClientRect();
  const parentR = activeTab.parentElement.getBoundingClientRect();
  glow.style.left = `${r.left - parentR.left}px`;
  glow.style.width = `${r.width}px`;
}
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    setTabGlow(btn);
    document.querySelectorAll(".ctrl-panel").forEach((p) => p.classList.remove("active"));
    document.querySelector(`.ctrl-panel[data-ctrl="${btn.dataset.tab}"]`).classList.add("active");
  });
});

/* ── drawer toggle — collapses the left controls panel and keeps the toggle
 *    visible at the viewport edge (it's a sibling, not a child, of the
 *    drawer). The .collapsed class is applied to BOTH so each can run its
 *    own transition. ── */
document.getElementById("drawerToggle").addEventListener("click", () => {
  const drawer = document.getElementById("drawer");
  const toggle = document.getElementById("drawerToggle");
  drawer.classList.toggle("collapsed");
  toggle.classList.toggle("collapsed");
  // Canvas occupies full viewport already, but trigger resize anyway so any
  // future layout-bound canvas math stays in sync with the transition end.
  setTimeout(resize, 480);
});

/* ── trace search ── */
const searchBox = document.getElementById("searchBox");
const autoEl = document.getElementById("autocomplete");
let autoIdx = -1;
let acHits = [];
let acTimer;

searchBox.addEventListener("input", () => {
  clearTimeout(acTimer);
  const q = searchBox.value.trim();
  if (!currentOrgId || q.length < 2) {
    autoEl.classList.remove("show");
    return;
  }
  acTimer = setTimeout(async () => {
    try {
      acHits = await api(`/api/search?org=${currentOrgId}&q=${encodeURIComponent(q)}&limit=20`);
      renderAutocomplete();
    } catch (e) {
      console.error(e);
    }
  }, 150);
});

function renderAutocomplete() {
  autoEl.innerHTML = "";
  if (acHits.length === 0) {
    autoEl.classList.remove("show");
    return;
  }
  acHits.forEach((h, i) => {
    const li = document.createElement("li");
    if (i === autoIdx) li.classList.add("active");
    const dot = document.createElement("span");
    dot.className = "node-dot";
    dot.style.background = colorFor(h.label);
    dot.style.color = colorFor(h.label);
    li.append(dot, document.createTextNode(h.qname));
    const lab = document.createElement("span");
    lab.className = "lab";
    lab.textContent = h.label;
    li.appendChild(lab);
    li.addEventListener("click", () => pickHit(h));
    autoEl.appendChild(li);
  });
  autoEl.classList.add("show");
}
searchBox.addEventListener("keydown", (e) => {
  if (!autoEl.classList.contains("show")) {
    if (e.key === "Enter" && searchBox.value.trim()) renderTrace();
    return;
  }
  if (e.key === "ArrowDown") {
    autoIdx = Math.min(autoIdx + 1, acHits.length - 1);
    renderAutocomplete();
    e.preventDefault();
  } else if (e.key === "ArrowUp") {
    autoIdx = Math.max(autoIdx - 1, 0);
    renderAutocomplete();
    e.preventDefault();
  } else if (e.key === "Enter" && autoIdx >= 0) {
    pickHit(acHits[autoIdx]);
    e.preventDefault();
  } else if (e.key === "Enter") {
    autoEl.classList.remove("show");
    renderTrace();
    e.preventDefault();
  } else if (e.key === "Escape") {
    autoEl.classList.remove("show");
  }
});
function pickHit(h) {
  searchBox.value = h.qname;
  autoEl.classList.remove("show");
  autoIdx = -1;
  renderTrace();
}
document.addEventListener("click", (e) => {
  if (!autoEl.contains(e.target) && e.target !== searchBox) autoEl.classList.remove("show");
});

let depth = 2;
document.querySelectorAll("#depthGroup button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#depthGroup button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    depth = Number(b.dataset.depth);
  });
});

/* ── render commands ── */
async function renderTrace() {
  if (!currentOrgId) return alert("pick an org first");
  const qname = searchBox.value.trim();
  if (!qname) return;
  const enabled = [...document.querySelectorAll("#relList input:checked")].map((i) => i.value);
  const allRels = document.querySelectorAll("#relList input");
  const relsParam = enabled.length === allRels.length ? "" : `&rels=${enabled.join(",")}`;
  setHint("traceHint", "querying…");
  try {
    const payload = await api(
      `/api/neighborhood?org=${currentOrgId}&qname=${encodeURIComponent(qname)}&depth=${depth}${relsParam}`,
    );
    setData(payload, qname);
    setHint(
      "traceHint",
      `${payload.nodes.length} nodes · ${payload.edges.length} edges${payload.truncated ? " · truncated" : ""}`,
    );
  } catch (e) {
    setHint("traceHint", `error: ${e.message}`);
  }
}
document.getElementById("traceGo").addEventListener("click", renderTrace);

async function renderOverview() {
  if (!currentOrgId) return alert("pick an org first");
  const labels = [...document.querySelectorAll("#labelList input:checked")].map((i) => i.value);
  if (labels.length === 0) return alert("pick at least one label");
  const limit = document.getElementById("overviewLimit").value;
  setHint("overviewHint", "querying…");
  try {
    const payload = await api(
      `/api/overview?org=${currentOrgId}&labels=${labels.join(",")}&limit=${limit}`,
    );
    setData(payload);
    setHint(
      "overviewHint",
      `${payload.nodes.length} nodes · ${payload.edges.length} edges${payload.truncated ? " · truncated" : ""}`,
    );
  } catch (e) {
    setHint("overviewHint", `error: ${e.message}`);
  }
}
document.getElementById("overviewGo").addEventListener("click", renderOverview);

async function renderSchema() {
  if (!currentOrgId) return alert("pick an org first");
  const limit = document.getElementById("schemaLimit").value;
  setHint("schemaHint", "querying…");
  try {
    const payload = await api(`/api/schema?org=${currentOrgId}&limit=${limit}`);
    setData(payload);
    setHint(
      "schemaHint",
      `${payload.nodes.length} nodes · ${payload.edges.length} edges${payload.truncated ? " · truncated" : ""}`,
    );
  } catch (e) {
    setHint("schemaHint", `error: ${e.message}`);
  }
}
document.getElementById("schemaGo").addEventListener("click", renderSchema);
function setHint(id, text) {
  document.getElementById(id).textContent = text;
}

/* ── inspector ── */
async function showInspector(node) {
  const id = node.id;
  const lbl = node.label;
  inspectorNodeId = id;
  document.getElementById("inspName").textContent = id;
  document.getElementById("inspLabel").textContent = lbl;
  const box = document.getElementById("inspector");
  // A fresh click should always reveal the full detail — auto-expand if the
  // user had collapsed the inspector from a previous interaction.
  box.classList.remove("hidden");
  box.classList.remove("collapsed");
  const body = document.getElementById("inspEdges");
  body.innerHTML = `<p style="color:var(--fg-mute);font-size:11px;font-family:'JetBrains Mono',monospace;">loading edges…</p>`;
  try {
    const payload = await api(
      `/api/neighborhood?org=${currentOrgId}&qname=${encodeURIComponent(id)}&depth=1`,
    );
    body.innerHTML = "";
    const out = payload.edges.filter((e) => e.source === id);
    const inn = payload.edges.filter((e) => e.target === id);
    if (out.length) body.appendChild(edgeGroup("outgoing", out, "target"));
    if (inn.length) body.appendChild(edgeGroup("incoming", inn, "source"));
    if (!out.length && !inn.length) {
      body.innerHTML = `<p style="color:var(--fg-mute);font-size:11px;">no edges</p>`;
    }
  } catch (e) {
    body.innerHTML = `<p style="color:var(--magenta);font-size:11px;">${e.message}</p>`;
  }
  document.getElementById("recenter").onclick = () => {
    document.querySelector('[data-tab="trace"]').click();
    searchBox.value = id;
    renderTrace();
  };
}
function edgeGroup(title, list, dirKey) {
  const g = document.createElement("div");
  g.className = "edge-grp";
  const h = document.createElement("h4");
  h.append(document.createTextNode(title));
  const c = document.createElement("span");
  c.className = "count";
  c.textContent = list.length;
  h.appendChild(c);
  g.appendChild(h);
  const ul = document.createElement("ul");
  for (const e of list.slice(0, 30)) {
    const li = document.createElement("li");
    const rel = document.createElement("span");
    rel.className = "rel";
    rel.textContent = e.relType;
    li.append(rel, document.createTextNode(e[dirKey]));
    ul.appendChild(li);
  }
  g.appendChild(ul);
  return g;
}
/* ── inspector controls — collapse to a thin rail OR fully close. ──
 *
 * Collapsed: width shrinks to ~52px, body content hidden, label pill rotates
 * vertically so context stays visible. Clicking anywhere on the collapsed
 * rail (or the chevron) expands it back. Close (×) only visible when
 * expanded.
 */
const inspector = document.getElementById("inspector");
document.getElementById("inspectorClose").addEventListener("click", (e) => {
  e.stopPropagation();
  inspector.classList.add("hidden");
  inspector.classList.remove("collapsed");
  inspectorNodeId = null;
});
document.getElementById("inspectorCollapse").addEventListener("click", (e) => {
  e.stopPropagation();
  inspector.classList.toggle("collapsed");
});
// Click anywhere on the collapsed rail to expand.
inspector.addEventListener("click", () => {
  if (inspector.classList.contains("collapsed")) inspector.classList.remove("collapsed");
});

/* ── keyboard shortcuts ──
 *   L  toggle "always show labels"
 *   F  zoomToFit (reframe the whole graph)
 *   Escape  close inspector / hide autocomplete
 * (Skip if focus is inside an input so typing isn't hijacked.)
 */
window.addEventListener("keydown", (e) => {
  const tag = e.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === "l" || e.key === "L") {
    alwaysShowLabels = !alwaysShowLabels;
    showShortcutToast(alwaysShowLabels ? "labels: always on" : "labels: distance-based");
  } else if (e.key === "f" || e.key === "F") {
    Graph.zoomToFit(800, 60);
    showShortcutToast("fit to view");
  } else if (e.key === "Escape") {
    document.getElementById("inspector").classList.add("hidden");
    document.getElementById("autocomplete").classList.remove("show");
    inspectorNodeId = null;
  }
});

/** Brief floating toast for keyboard-driven actions. */
let toastTimer;
function showShortcutToast(text) {
  let el = document.getElementById("shortcutToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "shortcutToast";
    el.style.cssText = `
      position: fixed; bottom: 64px; left: 50%; transform: translateX(-50%);
      background: rgba(8, 12, 24, 0.92); backdrop-filter: blur(14px);
      border: 1px solid rgba(94, 236, 255, 0.35);
      color: #5eecff; font: 500 12px/1 "JetBrains Mono", monospace;
      letter-spacing: 0.4px; padding: 9px 14px; border-radius: 999px;
      box-shadow: 0 6px 18px rgba(0,0,0,0.5);
      pointer-events: none; opacity: 0;
      transition: opacity 0.18s ease-out, transform 0.25s cubic-bezier(0.16,1,0.3,1);
      z-index: 30;
    `;
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = "1";
  el.style.transform = "translateX(-50%) translateY(0)";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-50%) translateY(8px)";
  }, 1200);
}

bootstrap().catch((e) => {
  document.body.innerHTML = `<pre style="padding:40px;color:#ff5ec8;font-family:'JetBrains Mono',monospace;">bootstrap failed:\n${e.message}</pre>`;
});
