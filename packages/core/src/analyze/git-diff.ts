/** One hunk of a text diff; `lines` keep their ` `/`-`/`+` prefix. */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface DiffFile {
  /** The file's path after the change (its old path when deleted). */
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** A rename's old path. */
  oldPath?: string;
  /** A copy's source path (the copy is `added`; its unchanged source is not a change). */
  copyFrom?: string;
  /** `Binary files ... differ` / `GIT binary patch`: no hunks. */
  binary?: boolean;
  /** Only a mode change: no content hunks. */
  modeOnly?: boolean;
  hunks: DiffHunk[];
}

/**
 * Unquote a git path: `"a/x y.cls"` with C-style escapes (`\"`, `\\`, `\t`,
 * `\n`, octal UTF-8 bytes), and drop a non-git diff's `\t<timestamp>` tail.
 */
function diffPath(raw: string): string | null {
  let s = raw.trim();
  if (s.startsWith('"')) {
    const bytes: number[] = [];
    let i = 1;
    for (; i < s.length && s[i] !== '"'; i++) {
      const c = s[i] as string;
      if (c !== "\\") {
        bytes.push(...Buffer.from(c, "utf8"));
        continue;
      }
      const n = s[++i] ?? "";
      if (/[0-7]/.test(n)) {
        const oct = s.slice(i, i + 3);
        bytes.push(Number.parseInt(oct, 8));
        i += oct.length - 1;
      } else {
        const esc: Record<string, string> = { t: "\t", n: "\n", r: "\r", '"': '"', "\\": "\\" };
        bytes.push(...Buffer.from(esc[n] ?? n, "utf8"));
      }
    }
    s = Buffer.from(bytes).toString("utf8");
  } else {
    const tab = s.indexOf("\t");
    if (tab >= 0) s = s.slice(0, tab);
  }
  return s === "/dev/null" ? null : s;
}

const stripSide = (p: string | null, side: "a/" | "b/"): string | null =>
  p?.startsWith(side) ? p.slice(2) : p;

/** `diff --git a/X b/Y` -> [X, Y] (unquoted; ambiguous unquoted spaces split at " b/"). */
function gitHeaderPaths(rest: string): [string | null, string | null] {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ', 1);
    if (end > 0) {
      return [
        stripSide(diffPath(rest.slice(0, end + 1)), "a/"),
        stripSide(diffPath(rest.slice(end + 2)), "b/"),
      ];
    }
  }
  const mid = rest.indexOf(" b/");
  if (mid < 0) return [null, null];
  return [
    stripSide(diffPath(rest.slice(0, mid)), "a/"),
    stripSide(diffPath(rest.slice(mid + 1)), "b/"),
  ];
}

/**
 * Parse a unified diff (git or plain) into its files: added, modified,
 * deleted or renamed (`rename from`/`rename to`, with or without hunks),
 * copies (`copy from`/`copy to`: the new path is added, the source untouched),
 * binary files (`Binary files ... differ`, `GIT binary patch`) and mode-only
 * changes, with each file's hunks. Quoted paths (spaces, escapes) are
 * unquoted. A file listed twice keeps its last entry.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files = new Map<string, DiffFile>();
  const lines = text.split(/\r?\n/);
  type Block = {
    gitOld: string | null;
    gitNew: string | null;
    old?: string | null;
    new?: string | null;
    renameFrom?: string;
    renameTo?: string;
    copyFrom?: string;
    copyTo?: string;
    created?: boolean;
    deletedFile?: boolean;
    binary?: boolean;
    modeChange?: boolean;
    hunks: DiffHunk[];
  };
  let cur: Block | null = null;
  let hunk: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;

  const flush = (): void => {
    if (!cur) return;
    const b = cur;
    cur = null;
    hunk = null;
    const oldP = b.renameFrom ?? (b.old !== undefined ? b.old : b.gitOld);
    const newP = b.renameTo ?? (b.new !== undefined ? b.new : b.gitNew);
    let file: DiffFile;
    if (b.copyTo && !b.renameTo) {
      file = { path: b.copyTo, status: "added", hunks: b.hunks };
      if (b.copyFrom && b.copyFrom !== b.copyTo) file.copyFrom = b.copyFrom;
    } else if (b.renameFrom || b.renameTo) {
      if (!newP) return;
      file = { path: newP, status: "renamed", hunks: b.hunks };
      if (oldP && oldP !== newP) file.oldPath = oldP;
    } else if (b.created || (b.old === null && newP)) {
      if (!newP) return;
      file = { path: newP, status: "added", hunks: b.hunks };
    } else if (b.deletedFile || (b.new === null && oldP)) {
      if (!oldP) return;
      file = { path: oldP, status: "deleted", hunks: b.hunks };
    } else {
      const p = newP ?? oldP;
      if (!p) return;
      file = { path: p, status: "modified", hunks: b.hunks };
    }
    if (b.binary) file.binary = true;
    if (b.modeChange && !b.binary && b.hunks.length === 0 && file.status === "modified") {
      file.modeOnly = true;
    }
    files.delete(file.path);
    files.set(file.path, file);
  };

  for (const line of lines) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (c === " " || c === "-" || c === "+" || line === "") {
        (hunk as DiffHunk).lines.push(line === "" ? " " : line);
        if (c !== "+") oldLeft--;
        if (c !== "-") newLeft--;
        continue;
      }
      if (c === "\\") continue; // "\ No newline at end of file"
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("diff --git ")) {
      flush();
      const [a, b] = gitHeaderPaths(line.slice("diff --git ".length));
      cur = { gitOld: a, gitNew: b, hunks: [] };
      continue;
    }
    if (line.startsWith("--- ")) {
      // A plain (non-git) diff starts a file at its `---` line.
      if (!cur || cur.old !== undefined) {
        flush();
        cur = { gitOld: null, gitNew: null, hunks: [] };
      }
      cur.old = stripSide(diffPath(line.slice(4)), "a/");
      continue;
    }
    if (line.startsWith("+++ ") && cur) {
      cur.new = stripSide(diffPath(line.slice(4)), "b/");
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && cur) {
      hunk = {
        oldStart: Number(h[1]),
        oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] === undefined ? 1 : Number(h[4]),
        lines: [],
      };
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      cur.hunks.push(hunk);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("rename from ")) {
      const p = diffPath(line.slice("rename from ".length));
      if (p) cur.renameFrom = p;
    } else if (line.startsWith("rename to ")) {
      const p = diffPath(line.slice("rename to ".length));
      if (p) cur.renameTo = p;
    } else if (line.startsWith("copy from ")) {
      const p = diffPath(line.slice("copy from ".length));
      if (p) cur.copyFrom = p;
    } else if (line.startsWith("copy to ")) {
      const p = diffPath(line.slice("copy to ".length));
      if (p) cur.copyTo = p;
    } else if (line.startsWith("new file mode")) {
      cur.created = true;
    } else if (line.startsWith("deleted file mode")) {
      cur.deletedFile = true;
    } else if (line.startsWith("old mode") || line.startsWith("new mode")) {
      cur.modeChange = true;
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      cur.binary = true;
      const m = /^Binary files (.+) and (.+) differ$/.exec(line);
      if (m) {
        if (cur.old === undefined) cur.old = stripSide(diffPath(m[1] ?? ""), "a/");
        if (cur.new === undefined) cur.new = stripSide(diffPath(m[2] ?? ""), "b/");
      }
    }
  }
  flush();
  return Array.from(files.values());
}
