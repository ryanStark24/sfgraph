import path from "node:path";
import { type OrgId, type QualifiedName, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { GraphStore, MemberRow } from "../storage/interfaces.js";
import { componentOf, traversalMembers } from "./containment.js";
import type { DiffFile, DiffHunk } from "./git-diff.js";
import { pathToQualifiedName } from "./path-to-qname.js";

/** One graph node a changed file stands for (T15 query I-4). */
export interface DiffSeed {
  qname: string;
  /** The changed path it came from (a rename's old or new path). */
  path: string;
  status: DiffFile["status"];
  /** `member`: an ApexMethod the hunks fall in; `component`: the whole node. */
  level: "member" | "component";
  /** The node the file stands for as a whole (the class of a member seed). */
  component: string;
}

/** A changed path that yields no seed, and why. Never silently dropped. */
export interface UnmappedPath {
  path: string;
  reason: "binary" | "mode-only" | "no-qname" | "unparseable";
}

export interface DiffSeedResult {
  seeds: DiffSeed[];
  unmapped: UnmappedPath[];
}

const PARSE_ERROR = "ParseError:";
const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
const keyPath = (k: string): string => norm(k.startsWith("file://") ? k.slice(7) : k);

/**
 * The graph's member index (filesystem ingests: one row per source member,
 * keyed by its file or bundle directory, with the qnames it owns), searched
 * by a repo-relative path:
 *  - a file key ending in `/<path>`;
 *  - a directory key (a bundle) that is an ancestor of the path;
 *  - a file in the same directory as a member key that is the only member
 *    of that directory (a DataPack's other files).
 */
class MemberIndex {
  private readonly byBase = new Map<string, MemberRow[]>();
  private readonly byDirBase = new Map<string, MemberRow[]>();
  private readonly dirCount = new Map<string, number>();

  constructor(rows: readonly MemberRow[]) {
    for (const r of rows) {
      const k = keyPath(r.key);
      push(this.byBase, path.posix.basename(k), r);
      const dir = path.posix.dirname(k);
      push(this.byDirBase, path.posix.basename(dir), r);
      this.dirCount.set(dir, (this.dirCount.get(dir) ?? 0) + 1);
    }
  }

  lookup(rel: string): MemberRow[] {
    const p = norm(rel);
    const ends = (k: string, tail: string) => k === tail || k.endsWith(`/${tail}`);
    const hits = new Set<MemberRow>();
    for (let a = p; a && a !== "." && a !== "/"; a = path.posix.dirname(a)) {
      for (const r of this.byBase.get(path.posix.basename(a)) ?? []) {
        if (ends(keyPath(r.key), a)) hits.add(r);
      }
      if (hits.size > 0) return [...hits];
    }
    const dir = path.posix.dirname(p);
    if (dir && dir !== ".") {
      for (const r of this.byDirBase.get(path.posix.basename(dir)) ?? []) {
        const kd = path.posix.dirname(keyPath(r.key));
        if (ends(kd, dir) && this.dirCount.get(kd) === 1) hits.add(r);
      }
    }
    return [...hits];
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

/**
 * The top-level nodes a member owns: real nodes (not parse errors), minus
 * those whose component is itself owned by the member (a class's methods, an
 * object's fields).
 */
function ownedSeeds(store: GraphStore, orgId: OrgId, owned: readonly string[]): string[] {
  const real = owned.filter(
    (q) => !q.startsWith(PARSE_ERROR) && store.getNode(orgId, asQualifiedName(q)) !== null,
  );
  const set = new Set(real);
  return real
    .filter((q) => {
      const c = String(componentOf(store, orgId, asQualifiedName(q)));
      return c === q || !set.has(c);
    })
    .sort();
}

/** A line that can identify where it is (not just braces or punctuation). */
const meaningful = (t: string): boolean => /[A-Za-z0-9_]{2,}/.test(t);
/** Apex method declaration grammar: a modifier or type before `<name>(`. */
const signatureOf = (line: string, name: string): boolean =>
  !line.trimEnd().endsWith(";") &&
  new RegExp(`(?:^|\\s)[\\w<>,.\\[\\]]+\\s+${name.replace(/\W/g, "\\$&")}\\s*\\(`).test(line);

/** Net `{` minus `}` on a line, ignoring string literals and `//` comments (approximate). */
const braceDelta = (line: string): number => {
  const code = line.replace(/'(?:\\.|[^'\\])*'/g, "''").replace(/\/\/.*$/, "");
  return (code.match(/\{/g)?.length ?? 0) - (code.match(/\}/g)?.length ?? 0);
};

/**
 * The ApexMethods of `cls` the hunks change, from the old-side lines of each
 * change block (a run of `-`/`+` lines) matched against the methods' stored
 * source bodies (snippets). A block with meaningful removed lines picks the
 * methods those lines belong to, where a line's nearest old-side neighbours
 * agree (so a class-level line that happens to equal a body line is not taken
 * for it); its added lines must not open a method, or close more blocks than
 * the removed lines did and continue. Any other block (a pure insertion, or only braces removed) is
 * placed by its nearest meaningful old-side lines on both sides. Null when
 * any change is class-level (a line in no method body: fields, the class
 * header, a new method) or the class has no method bodies; the caller then
 * seeds the class.
 */
function methodsForHunks(
  store: GraphStore,
  orgId: OrgId,
  cls: QualifiedName,
  hunks: readonly DiffHunk[],
): string[] | null {
  const { members } = traversalMembers(store, orgId, cls);
  if (members.length === 0 || hunks.length === 0) return null;
  const bodyLines = new Map<string, Set<string>>();
  const names = new Map<string, string>();
  for (const m of members) {
    const name = /\.([^.(]+)\(/.exec(String(m))?.[1];
    if (name) names.set(String(m), name);
    const body = store.getSnippet(orgId, m)?.sourceText;
    if (!body) continue;
    for (const raw of body.split(/\r?\n/)) {
      const t = raw.trim();
      if (!meaningful(t)) continue;
      const s = bodyLines.get(t);
      if (s) s.add(String(m));
      else bodyLines.set(t, new Set([String(m)]));
    }
  }
  if (bodyLines.size === 0) return null;
  const candidates = (line: string): Set<string> => {
    const t = line.trim();
    const out = new Set(bodyLines.get(t) ?? []);
    for (const [m, name] of names) if (signatureOf(t, name)) out.add(m);
    return out;
  };
  const picked = new Set<string>();
  for (const h of hunks) {
    const lines = h.lines.filter((l) => !l.startsWith("\\"));
    const changed = (i: number): boolean => /^[-+]/.test(lines[i] ?? "");
    // Whether method m can own the old-side line at i: its nearest meaningful
    // old-side neighbours are m's lines (or, before it, m's signature). A
    // closing brace on the way makes that side inconclusive.
    const fits = (i: number, m: string): boolean => {
      const name = names.get(m) ?? "";
      for (const step of [-1, 1]) {
        for (let j = i + step; j >= 0 && j < lines.length; j += step) {
          const l = lines[j] as string;
          if (l.startsWith("+")) continue;
          const t = l.slice(1).trim();
          if (!meaningful(t)) {
            if (t.includes("}")) break;
            continue;
          }
          if (bodyLines.get(t)?.has(m)) break;
          if (step < 0 && name && signatureOf(t, name)) break;
          return false;
        }
      }
      return true;
    };
    const near = (from: number, step: number): string | null => {
      for (let i = from; i >= 0 && i < lines.length; i += step) {
        const l = lines[i] as string;
        if (l.startsWith("+")) continue;
        if (meaningful(l.slice(1))) return l.slice(1);
      }
      return null;
    };
    for (let first = 0; first < lines.length; first++) {
      if (!changed(first)) continue;
      let last = first;
      while (changed(last + 1)) last++;
      const block = lines.slice(first, last + 1);
      const added = block.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
      const removed = block.filter((l) => l.startsWith("-")).map((l) => l.slice(1));
      // A new method (or overload) is a class-level change; a rewritten signature is not.
      const sigs = (ls: string[], n: string) => ls.filter((l) => signatureOf(l, n)).length;
      if ([...names.values()].some((n) => sigs(added, n) > sigs(removed, n))) return null;
      const removedAt = block
        .map((l, k) => [l, first + k] as const)
        .filter(([l]) => l.startsWith("-") && meaningful(l.slice(1)));
      if (removedAt.length > 0) {
        for (const [l, i] of removedAt) {
          const c = [...candidates(l.slice(1))].filter((m) => fits(i, m));
          if (c.length === 0) return null;
          for (const m of c) picked.add(m);
        }
        // Added text that closes more blocks than the removed text did (so it
        // leaves the enclosing method) and goes on is outside the method. The
        // floor is the removed text's lowest depth: a `}` that replaces a
        // removed `}` of an inner if/for stays inside.
        let floor = 0;
        let depth = 0;
        for (const r of removed) {
          depth += braceDelta(r);
          floor = Math.min(floor, depth);
        }
        depth = 0;
        for (const a of added) {
          if (depth < floor && meaningful(a)) return null;
          depth += braceDelta(a);
        }
      } else if (added.length > 0) {
        // A pure insertion (or only braces removed): the method both neighbours belong to.
        const before = near(first - 1, -1);
        const after = near(last + 1, 1);
        if (before === null || after === null) return null;
        const a = candidates(before);
        const both = [...candidates(after)].filter((m) => a.has(m));
        if (both.length === 0) return null;
        for (const m of both) picked.add(m);
      }
      first = last;
    }
  }
  return picked.size > 0 ? [...picked].sort() : null;
}

/**
 * Graph seeds for the files of a unified diff (T15 query I-4). A path maps by
 * the source-file grammar (pathToQualifiedName), else through the graph's
 * member index; a rename seeds both its old and its new path. A modified
 * ApexClass seeds the methods its hunks change when they are identifiable,
 * else the class. Binary files, mode-only changes and paths that map to
 * nothing are listed in `unmapped`, never dropped.
 */
export function resolveDiffSeeds(
  store: GraphStore,
  orgId: OrgId,
  files: readonly DiffFile[],
  diffText?: string,
): DiffSeedResult {
  const seeds: DiffSeed[] = [];
  const unmapped: UnmappedPath[] = [];
  const seen = new Set<string>();
  let index: MemberIndex | null = null;
  const memberIndex = (): MemberIndex => {
    if (!index) index = new MemberIndex(store.listMemberRows?.(orgId) ?? []);
    return index;
  };
  const add = (s: DiffSeed): void => {
    if (seen.has(s.qname)) return;
    seen.add(s.qname);
    seeds.push(s);
  };
  if (files.length === 0 && diffText !== undefined && diffText.trim() !== "") {
    unmapped.push({ path: "(diff)", reason: "unparseable" });
  }
  for (const f of files) {
    if (f.modeOnly) {
      unmapped.push({ path: f.path, reason: "mode-only" });
      continue;
    }
    const paths: Array<[string, DiffFile["status"]]> = f.oldPath
      ? [
          [f.oldPath, f.status],
          [f.path, f.status],
        ]
      : [[f.path, f.status]];
    for (const [p, status] of paths) {
      const byGrammar = pathToQualifiedName(p);
      const qnames = byGrammar
        ? [String(byGrammar)]
        : memberIndex()
            .lookup(p)
            .flatMap((r) => ownedSeeds(store, orgId, r.owned));
      if (qnames.length === 0) {
        unmapped.push({ path: p, reason: f.binary ? "binary" : "no-qname" });
        continue;
      }
      for (const q of [...new Set(qnames)]) {
        const qn = asQualifiedName(q);
        const node = store.getNode(orgId, qn);
        const canonical = node ? String(node.qualifiedName) : q;
        const members =
          status === "modified" && !f.binary && node?.label === "ApexClass"
            ? methodsForHunks(store, orgId, node.qualifiedName as QualifiedName, f.hunks)
            : null;
        if (members) {
          for (const m of members) {
            add({ qname: m, path: p, status, level: "member", component: canonical });
          }
        } else {
          add({ qname: canonical, path: p, status, level: "component", component: canonical });
        }
      }
    }
  }
  return { seeds, unmapped };
}
