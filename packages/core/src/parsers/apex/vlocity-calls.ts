// Apex -> Vlocity call extraction and VlocityOpenInterface dispatch table
// (linkage spec §4.3-4.4). Regex-based; operates on raw (string-preserving) source.

const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "return",
  "new",
  "catch",
  "system",
  "when",
  "else",
]);

/** Strip `//` and block comments but keep string literals intact. */
export function stripCommentsOnly(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "'") {
      const s = i++;
      while (i < src.length && src[i] !== "'") i += src[i] === "\\" ? 2 : 1;
      i++;
      out += src.slice(s, i);
    } else if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Split the top-level argument list starting just after `(`. */
function topLevelArgs(src: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  let inStr = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i] as string;
    if (inStr) {
      cur += ch;
      if (ch === "\\") {
        cur += src[++i] ?? "";
      } else if (ch === "'") inStr = false;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      cur += ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) {
      if (depth === 0) {
        args.push(cur.trim());
        return args;
      }
      depth--;
    }
    if (ch === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  return args;
}

/**
 * Class-level String constants of a class source: `final` String fields with
 * a literal initializer, keyed by lowercased name (Apex names are
 * case-insensitive). A field needs `static` or an access modifier besides
 * `final`, so a method's `final` local is not taken for one. A name declared
 * with two different values (e.g. in two inner classes) is ambiguous and left
 * out.
 */
export function classStringConstants(rawClass: string): ReadonlyMap<string, string> {
  const src = stripCommentsOnly(rawClass);
  const out = new Map<string, string>();
  const ambiguous = new Set<string>();
  const re =
    /\b((?:(?:public|private|protected|global|static|final|transient)\s+)+)String\s+([A-Za-z_]\w*)\s*=\s*'((?:[^'\\]|\\.)*)'\s*;/gi;
  for (const m of src.matchAll(re)) {
    const mods = (m[1] as string).toLowerCase().split(/\s+/);
    if (!mods.includes("final") || mods.every((x) => x === "final" || x === "")) continue;
    const name = (m[2] as string).toLowerCase();
    const value = m[3] as string;
    const prev = out.get(name);
    if (prev !== undefined && prev !== value) ambiguous.add(name);
    else out.set(name, value);
  }
  for (const n of ambiguous) out.delete(n);
  return out;
}

function resolveArg(
  arg: string | undefined,
  body: string,
  constants: ReadonlyMap<string, string>,
  paramNames: ReadonlySet<string>,
): string | null {
  if (!arg) return null;
  const lit = /^'((?:[^'\\]|\\.)*)'$/.exec(arg);
  if (lit) return lit[1] as string;
  if (!/^[A-Za-z_]\w*$/.test(arg)) return null;
  const re = new RegExp(`(?:\\bString\\s+)?\\b${arg}\\s*=\\s*'((?:[^'\\\\]|\\\\.)*)'\\s*;`, "gi");
  const hits = [...body.matchAll(re)];
  if (hits.length > 0) return hits.length === 1 ? (hits[0]?.[1] as string) : null;
  // No assignment in the method: a class-level constant of that name, unless
  // the method declares its own variable or parameter of that name.
  if (paramNames.has(arg.toLowerCase())) return null;
  if (new RegExp(`\\bString\\s+${arg}\\b`, "i").test(body)) return null;
  return constants.get(arg.toLowerCase()) ?? null;
}

/**
 * IP keys / DataRaptor names a method's raw text calls. An identifier argument
 * resolves from a single literal assignment in the method, else from
 * `constants` (the class's `final` String fields, `classStringConstants`)
 * unless one of `params` (the method's parameter declarations, `Type name`)
 * has that name.
 */
export function extractVlocityCalls(
  raw: string,
  constants: ReadonlyMap<string, string> = new Map(),
  params: readonly string[] = [],
): {
  ipKeys: string[];
  drNames: string[];
  unresolved: number;
} {
  const body = stripCommentsOnly(raw);
  const paramNames = new Set(
    params.map((p) => (p.trim().split(/\s+/).pop() ?? "").toLowerCase()).filter(Boolean),
  );
  const ipKeys: string[] = [];
  const drNames: string[] = [];
  let unresolved = 0;
  const scan = (re: RegExp, pick: (a: string[]) => string | undefined, sink: string[]) => {
    for (const m of body.matchAll(re)) {
      const v = resolveArg(
        pick(topLevelArgs(body, (m.index ?? 0) + m[0].length)),
        body,
        constants,
        paramNames,
      );
      if (v === null) unresolved++;
      else if (!sink.includes(v)) sink.push(v);
    }
  };
  scan(
    /\b(?:vlocity_cmt\.)?IntegrationProcedureService\.runIntegrationService\s*\(/g,
    (a) => a[0],
    ipKeys,
  );
  scan(/\b(?:vlocity_cmt\.)?DRGlobal\.process\w*\s*\(/g, (a) => a[a.length - 1], drNames);
  return { ipKeys, drNames, unresolved };
}

function blockAfter(src: string, from: number): { body: string; end: number } | null {
  const open = src.indexOf("{", from);
  if (open < 0) return null;
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}" && --d === 0) return { body: src.slice(open + 1, i), end: i };
  }
  return null;
}

function firstCallee(block: string): string | null {
  for (const m of block.matchAll(/(\bthis\.|\.)?\b([A-Za-z_]\w*)\s*\(/g)) {
    if (m[1] === ".") continue;
    if (/\bnew\s+$/i.test(block.slice(Math.max(0, (m.index ?? 0) - 5), m.index ?? 0))) continue;
    const id = m[2] as string;
    if (KEYWORDS.has(id.toLowerCase())) continue;
    return id;
  }
  return null;
}

export function extractVlocityDispatch(
  rawClass: string,
  implementsList: string[],
): Record<string, string> | null {
  if (!implementsList.some((i) => /vlocityopeninterface2?$/i.test(i.trim()))) return null;
  const src = stripCommentsOnly(rawClass);
  const head = /\binvokeMethod\s*\(\s*String\s+([A-Za-z_]\w*)/i.exec(src);
  if (!head) return {};
  const p = head[1] as string;
  const inv = blockAfter(src, head.index);
  if (!inv) return {};
  const body = inv.body;
  const out: Record<string, string> = {};
  const set = (k: string, callee: string | null) => {
    const key = k.toLowerCase();
    if (callee && !(key in out)) out[key] = callee;
  };
  const condRe = new RegExp(
    `\\bif\\s*\\(\\s*(?:${p}\\s*==\\s*'([^']+)'|${p}\\.equals(?:IgnoreCase)?\\(\\s*'([^']+)'\\s*\\)|'([^']+)'\\.equals(?:IgnoreCase)?\\(\\s*${p}\\s*\\))\\s*\\)`,
    "gi",
  );
  for (const m of body.matchAll(condRe)) {
    const b = blockAfter(body, (m.index ?? 0) + m[0].length);
    if (b) set((m[1] ?? m[2] ?? m[3]) as string, firstCallee(b.body));
  }
  const sw = new RegExp(`\\bswitch\\s+on\\s+${p}\\s*\\{`, "i").exec(body);
  if (sw) {
    const swb = blockAfter(body, sw.index);
    if (swb) {
      for (const w of swb.body.matchAll(/\bwhen\s+((?:'[^']+'\s*,?\s*)+)/g)) {
        const b = blockAfter(swb.body, (w.index ?? 0) + w[0].length);
        const callee = b ? firstCallee(b.body) : null;
        for (const k of (w[1] as string).matchAll(/'([^']+)'/g)) set(k[1] as string, callee);
      }
    }
  }
  return out;
}
