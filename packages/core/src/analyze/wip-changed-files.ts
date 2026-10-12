import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "@ryanstark24/sfgraph-shared";
import type { MemberRef } from "../extractors/interfaces/metadata-source.js";

/**
 * Local-change detection for wip "changed-only" mode, so only changed members
 * are parsed. Two signals, either one marks a file changed:
 *  - git: the file differs from HEAD (staged, unstaged or untracked);
 *  - mtime: the file was modified after the org's last sync.
 * A signal that is unavailable (not a git work tree, no `lastSyncedAt`) is
 * skipped. With neither signal there is nothing to narrow by and the caller
 * parses every member.
 */

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "coverage", ".sfdx", ".sf"]);

/**
 * Config overrides so git never runs a command the repo configures: the
 * project may be an untrusted clone, and its `.git/config` (or one it
 * includes) can name a fsmonitor, hooks, an external diff or textconv, and
 * clean/smudge/process filters that `diff HEAD` runs to re-hash a
 * stat-dirty file. Filters cannot be disabled by pattern, so every driver
 * defined in any config scope is blanked by name (git skips an empty
 * command). Null when a driver name cannot be passed safely via `-c`.
 */
function safeGitConfig(root: string): string[] | null {
  const base = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "diff.external=",
    "-c",
    "core.attributesFile=/dev/null",
  ];
  let names: string;
  try {
    names = execFileSync(
      "git",
      [
        "-C",
        root,
        ...base,
        "config",
        "--includes",
        "--name-only",
        "-z",
        "--get-regexp",
        "^filter\\..*\\.(clean|smudge|process)$",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (e) {
    // Exit status 1: no filter driver configured.
    if ((e as { status?: number }).status === 1) return base;
    return null;
  }
  const out = [...base];
  const drivers = new Set<string>();
  for (const key of splitZ(names)) {
    const m = /^filter\.(.+)\.(clean|smudge|process)$/s.exec(key.trim());
    if (!m) return null;
    drivers.add(m[1] as string);
  }
  for (const d of drivers) {
    if (/[=\n\0]/.test(d)) return null;
    for (const k of ["clean", "smudge", "process"]) out.push("-c", `filter.${d}.${k}=`);
    out.push("-c", `filter.${d}.required=false`);
  }
  return out;
}

function git(root: string, config: string[], args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...config, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

const splitZ = (s: string): string[] => s.split("\0").filter((p) => p.length > 0);

/** Absolute paths under `root` that differ from HEAD; null when `root` is not
 *  inside a git work tree, or when git cannot be run safely there. */
export function gitChangedFiles(root: string, logger?: Logger): Set<string> | null {
  const abs = path.resolve(root);
  const cfg = safeGitConfig(abs);
  if (!cfg) {
    logger?.debug("wip: git signal skipped (repo config cannot be neutralised safely)", {
      root: abs,
    });
    return null;
  }
  if (git(abs, cfg, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") return null;
  // `--relative` and `ls-files` report paths relative to `root`.
  // `--ignore-submodules`: never inspect (or run git inside) a submodule.
  const tracked =
    git(abs, cfg, [
      "diff",
      "HEAD",
      "--ignore-submodules",
      "--name-only",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--relative",
      "-z",
    ]) ??
    // No HEAD yet (fresh repo): every tracked file is new.
    git(abs, cfg, ["ls-files", "-z"]);
  const untracked = git(abs, cfg, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (tracked === null || untracked === null) return null;
  const out = new Set<string>();
  for (const rel of [...splitZ(tracked), ...splitZ(untracked)]) out.add(path.join(abs, rel));
  return out;
}

/** Files under `dirs` modified after `sinceMs`. */
export function filesModifiedSince(dirs: string[], sinceMs: number): Set<string> {
  const out = new Set<string>();
  const queue = dirs.map((d) => path.resolve(d));
  while (queue.length > 0) {
    const dir = queue.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(e.name)) queue.push(full);
      } else if (e.isFile()) {
        try {
          if (fs.statSync(full).mtimeMs > sinceMs) out.add(full);
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  return out;
}

/** Changed files by every available signal; null when no signal is available. */
export function localChangedFiles(opts: {
  projectRoot: string;
  /** Directories the metadata source walks (package dirs, DataPacks). */
  sourceDirs: string[];
  lastSyncedAt: number | null | undefined;
  logger?: Logger;
}): Set<string> | null {
  const fromGit = gitChangedFiles(opts.projectRoot, opts.logger);
  const fromMtime =
    typeof opts.lastSyncedAt === "number" && opts.lastSyncedAt > 0
      ? filesModifiedSince(opts.sourceDirs, opts.lastSyncedAt)
      : null;
  if (!fromGit && !fromMtime) return null;
  return new Set([...(fromGit ?? []), ...(fromMtime ?? [])]);
}

/** Filesystem path of a member's `file://` sourceUri. */
export function memberPath(ref: Pick<MemberRef, "sourceUri">): string {
  const uri = ref.sourceUri;
  return path.resolve(uri.startsWith("file://") ? uri.slice("file://".length) : uri);
}

const statIsDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Folders a member anchors at: a directory member at itself, a file member
 *  at its folder, and both at the nearest ancestor (up to two levels) named
 *  after the member (`objects/Foo/` for a stub `fields/` dir). */
function memberAnchors(p: string, isDir: boolean, memberName: string | undefined): string[] {
  const own = isDir ? p : path.dirname(p);
  const out = [own];
  let up = own;
  for (let k = 0; k < 2; k++) {
    if (path.basename(up) === memberName) {
      if (up !== own) out.push(up);
      break;
    }
    up = path.dirname(up);
  }
  return out;
}

/** Changed files plus every folder that contains one. */
export interface ChangeIndex {
  files: ReadonlySet<string>;
  dirs: ReadonlySet<string>;
}

export function indexChanges(changed: ReadonlySet<string>): ChangeIndex {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const raw of changed) {
    const f = path.resolve(raw);
    files.add(f);
    for (let d = path.dirname(f); !dirs.has(d); d = path.dirname(d)) {
      dirs.add(d);
      if (path.dirname(d) === d) break;
    }
  }
  return { files, dirs };
}

/**
 * Streaming pre-check of one member against the changes, without the other
 * members: `direct` = it owns a changed file by itself (own file, sidecar,
 * a file under a directory member); `maybe` = a changed file sits in a folder
 * it anchors, so ownership depends on whether it is the sole member there
 * (`membersOwningFiles` decides with every ref); `no` = it cannot own one.
 */
export function classifyMember(
  ref: Pick<MemberRef, "sourceUri" | "memberName">,
  idx: ChangeIndex,
): "direct" | "maybe" | "no" {
  const p = memberPath(ref);
  const isDir = statIsDir(p);
  if (isDir ? idx.dirs.has(p) : idx.files.has(p) || idx.files.has(`${p}-meta.xml`)) {
    return "direct";
  }
  return memberAnchors(p, isDir, ref.memberName).some((a) => idx.dirs.has(a)) ? "maybe" : "no";
}

/**
 * Which members own the changed files. A member owns:
 *  - its source path (a file, or every file under it when it is a directory);
 *  - the sidecar of a file member (`Foo.cls` -> `Foo.cls-meta.xml`);
 *  - every other file in its folder when it is the only member there (a
 *    DataPack folder, an object folder with `fields/`, ...). A folder shared
 *    by several members (`classes/`) gives an unowned file to nobody.
 * Returns the indexes of owning members in `refs`. Cost is O(refs + changed
 * x path depth).
 */
export function membersOwningFiles(
  refs: ReadonlyArray<Pick<MemberRef, "sourceUri" | "memberName">>,
  changed: ReadonlySet<string>,
  /** Anchors of members not in `refs`, counted per folder (`selectOwningMembers`). */
  extraAnchors?: ReadonlyMap<string, number>,
): Set<number> {
  const out = new Set<number>();
  if (changed.size === 0) return out;
  const paths = refs.map(memberPath);
  const isDir = paths.map(statIsDir);
  const anchored = new Map<string, number[]>();
  const dirMembers = new Map<string, number[]>();
  const byPath = new Map<string, number>();
  const push = (m: Map<string, number[]>, k: string, i: number) => {
    const list = m.get(k) ?? [];
    if (!list.includes(i)) list.push(i);
    m.set(k, list);
  };
  paths.forEach((p, i) => {
    for (const a of memberAnchors(p, isDir[i] === true, refs[i]?.memberName)) push(anchored, a, i);
    if (isDir[i]) push(dirMembers, p, i);
    else byPath.set(p, i);
  });
  for (const raw of changed) {
    const f = path.resolve(raw);
    // Own file or its sidecar (`<file>-meta.xml`).
    const direct = byPath.get(f) ?? byPath.get(f.replace(/-meta\.xml$/, ""));
    if (direct !== undefined) {
      out.add(direct);
      continue;
    }
    // Directory members containing the file (every ancestor folder).
    let hit = false;
    for (let dir = path.dirname(f); ; dir = path.dirname(dir)) {
      for (const i of dirMembers.get(dir) ?? []) {
        out.add(i);
        hit = true;
      }
      if (path.dirname(dir) === dir) break;
    }
    if (hit) continue;
    // Nearest anchoring folder; only a sole member there owns the file.
    for (let dir = path.dirname(f); ; dir = path.dirname(dir)) {
      const list = anchored.get(dir);
      const extra = extraAnchors?.get(dir) ?? 0;
      if (list || extra > 0) {
        if (list?.length === 1 && extra === 0) out.add(list[0] as number);
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
  }
  return out;
}

/** What {@link selectOwningMembers} needs of an index entry and of its loaded member. */
export interface SelectableEntry {
  /** The member's sourceUri. */
  key: string;
}
export interface SelectableMember {
  ref: Pick<MemberRef, "sourceUri" | "memberName">;
}

export interface OwnerSelection<M> {
  /** Members that own a changed file by themselves, in index order. */
  direct: M[];
  /** Members that own a changed file via a sole-member folder, in `membersOwningFiles` order. */
  owners: M[];
  indexed: number;
  loaded: number;
  /** Paths of loaded members whose load() returned null (unreadable). */
  dropped: ReadonlySet<string>;
}

/**
 * The members owning `changed` files, as `membersOwningFiles` over every
 * indexed member would find them, while `load()`ing only the members that can
 * matter, decided from each key (path) with set lookups and a stat at most:
 *  - direct: its path or sidecar is a changed file, or it is a folder holding
 *    one. Loaded; owns it.
 *  - sole: the only member whose own folder (its path for a folder member, its
 *    parent for a file) holds a changed file. Loaded; may own via that folder.
 *  - shared: its own folder holds a changed file but other members' do too.
 *    Not loaded: nobody owns via that folder, and its anchor there is passed
 *    to `membersOwningFiles` as a count (`extraAnchors`).
 *  - The one remaining role is anchoring the folder above its own when named
 *    after it (`memberAnchors`). A member is loaded for that only when a
 *    changed file's walk up reaches that folder before any known anchor.
 * Other members can neither own a changed file nor change who owns one.
 * `load` returning null (unreadable) drops the member like `iter()` does; a
 * member never loaded still counts as an anchor of its own folder.
 */
export async function selectOwningMembers<E extends SelectableEntry, M extends SelectableMember>(
  entries: AsyncIterable<E> | Iterable<E>,
  changed: ReadonlySet<string>,
  load: (e: E) => Promise<M | null>,
): Promise<OwnerSelection<M>> {
  const idx = indexChanges(changed);
  interface Info {
    e: E;
    p: string;
    direct: boolean;
    /** Own folder, when it holds a changed file. */
    own: string | null;
    /** The folder above the own folder: a possible named anchor. */
    up: string;
    loaded: boolean;
  }
  const infos: Info[] = [];
  const dropped = new Set<string>();
  const ownCount = new Map<string, number>();
  for await (const e of entries) {
    const p = memberPath({ sourceUri: e.key });
    const parent = path.dirname(p);
    let direct = false;
    let own: string | null = null;
    let up = path.dirname(parent);
    if (idx.dirs.has(p)) {
      direct = true;
      own = p;
      up = parent;
    } else if (idx.files.has(p) || idx.files.has(`${p}-meta.xml`)) {
      direct = true;
      if (statIsDir(p)) up = parent;
      else own = idx.dirs.has(parent) ? parent : null;
    } else if (idx.dirs.has(parent)) {
      // A folder member here holds no change (own folder = itself).
      if (statIsDir(p)) up = parent;
      else own = parent;
    }
    // Else: own folder (parent, or p for a folder) holds no change, and a
    // folder member's upper anchor (parent) holds none either; treating it
    // as a file only widens `up`, a superset.
    if (own) ownCount.set(own, (ownCount.get(own) ?? 0) + 1);
    infos.push({ e, p, direct, own, up, loaded: false });
  }

  const refs: M[] = [];
  const direct: M[] = [];
  const pending = new Map<number, M>();
  const take = async (info: Info): Promise<void> => {
    info.loaded = true;
    const m = await load(info.e);
    if (!m) {
      dropped.add(info.p);
      return;
    }
    const i = refs.push(m) - 1;
    const kind = classifyMember(m.ref, idx);
    if (kind === "direct") direct.push(m);
    else if (kind === "maybe") pending.set(i, m);
  };
  for (const info of infos) {
    if (info.direct || (info.own !== null && ownCount.get(info.own) === 1)) await take(info);
  }
  // Folders a changed file's walk up passes before (and including) the
  // first folder known to be anchored.
  const anchoredDirs = new Set<string>(ownCount.keys());
  for (const m of refs) {
    const p = memberPath(m.ref);
    for (const a of memberAnchors(p, statIsDir(p), m.ref.memberName)) anchoredDirs.add(a);
  }
  const open = new Set<string>();
  for (const raw of changed) {
    for (let dir = path.dirname(path.resolve(raw)); ; dir = path.dirname(dir)) {
      open.add(dir);
      if (anchoredDirs.has(dir) || path.dirname(dir) === dir) break;
    }
  }
  for (const info of infos) {
    if (!info.loaded && idx.dirs.has(info.up) && open.has(info.up)) await take(info);
  }
  const extra = new Map<string, number>();
  for (const info of infos) {
    if (!info.loaded && info.own) extra.set(info.own, (extra.get(info.own) ?? 0) + 1);
  }
  const owners: M[] = [];
  for (const i of membersOwningFiles(
    refs.map((m) => m.ref),
    changed,
    extra,
  )) {
    const m = pending.get(i);
    if (m) owners.push(m);
  }
  return {
    direct,
    owners,
    indexed: infos.length,
    loaded: infos.filter((i) => i.loaded).length,
    dropped,
  };
}

/**
 * Whether a deleted `file` belongs by itself to a member at `memberPaths`: its
 * sidecar's member (`Foo.cls` for `Foo.cls-meta.xml`) or a folder member
 * holding it (a bundle that lost one file).
 */
export function heldByMember(file: string, memberPaths: ReadonlySet<string>): boolean {
  const f = path.resolve(file);
  if (memberPaths.has(f) || memberPaths.has(f.replace(/-meta\.xml$/, ""))) return true;
  for (let dir = path.dirname(f); ; dir = path.dirname(dir)) {
    if (memberPaths.has(dir)) return true;
    if (path.dirname(dir) === dir) return false;
  }
}
