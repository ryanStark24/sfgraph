/**
 * Strip line and block comments + string literals from Apex source so regex
 * extractors don't trip on commented-out or string-embedded SOQL/DML.
 */
export function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      // line comment
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else if (c === "'") {
      out += " ";
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "'") {
          i++;
          break;
        }
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export interface ApexAnnotation {
  name: string;
  args: string | null;
}

export function parseAnnotations(text: string): ApexAnnotation[] {
  const out: ApexAnnotation[] = [];
  const re = /@(\w+)(?:\(([^)]*)\))?/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    out.push({ name: (m[1] ?? "").trim(), args: m[2] ?? null });
    m = re.exec(text);
  }
  return out;
}
