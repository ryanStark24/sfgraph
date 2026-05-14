import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { validateOrgIdentifier } from "./org-identifier.js";
import { getSfgraphPaths } from "./paths.js";

export interface Workspace {
  projectRoot: string;
  projectHash: string;
  orgAlias: string | null;
  orgId: string | null;
  linkedAt: number | null;
  lastAnalyzedAt: number | null;
}

export function workspaceHashFor(projectRoot: string): string {
  const norm = path.resolve(projectRoot);
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

export function workspaceConfigPath(projectRoot: string): string {
  const paths = getSfgraphPaths();
  return path.join(paths.config, "workspaces", `${workspaceHashFor(projectRoot)}.json`);
}

/**
 * Walk up from `start` to find a directory containing `sfdx-project.json`.
 * Returns the project root (the dir containing the manifest) or null.
 */
export function findProjectRoot(start: string): string | null {
  let cur = path.resolve(start);
  // Guard against symlink loops by bounding the walk.
  for (let i = 0; i < 64; i++) {
    const candidate = path.join(cur, "sfdx-project.json");
    try {
      if (fs.existsSync(candidate)) return cur;
    } catch {
      // ignore
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

export async function readWorkspace(projectRoot: string): Promise<Workspace | null> {
  const file = workspaceConfigPath(projectRoot);
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed: Partial<Workspace>;
  try {
    parsed = JSON.parse(raw) as Partial<Workspace>;
  } catch {
    return null;
  }
  // P1 audit: validate orgId / orgAlias read off disk. A malicious / corrupt
  // workspace JSON (e.g. orgId: "../../etc/passwd") must not flow into a
  // path.join'd DB path. Throw — the caller (CLI) surfaces the error rather
  // than silently falling back to a fresh empty workspace.
  if (typeof parsed.orgId === "string" && parsed.orgId.length > 0) {
    validateOrgIdentifier(parsed.orgId);
  }
  if (typeof parsed.orgAlias === "string" && parsed.orgAlias.length > 0) {
    validateOrgIdentifier(parsed.orgAlias);
  }
  return {
    projectRoot: parsed.projectRoot ?? path.resolve(projectRoot),
    projectHash: parsed.projectHash ?? workspaceHashFor(projectRoot),
    orgAlias: parsed.orgAlias ?? null,
    orgId: parsed.orgId ?? null,
    linkedAt: parsed.linkedAt ?? null,
    lastAnalyzedAt: parsed.lastAnalyzedAt ?? null,
  };
}

export async function writeWorkspace(ws: Workspace): Promise<void> {
  const file = workspaceConfigPath(ws.projectRoot);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(ws, null, 2)}\n`, "utf8");
}

export async function linkWorkspace(
  projectRoot: string,
  orgAlias: string,
  orgId: string,
): Promise<Workspace> {
  const resolved = path.resolve(projectRoot);
  const existing = await readWorkspace(resolved);
  const ws: Workspace = {
    projectRoot: resolved,
    projectHash: workspaceHashFor(resolved),
    orgAlias,
    orgId,
    linkedAt: Date.now(),
    lastAnalyzedAt: existing?.lastAnalyzedAt ?? null,
  };
  await writeWorkspace(ws);
  return ws;
}
