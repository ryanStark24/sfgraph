export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted";
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files = new Map<string, DiffFile>();
  const lines = text.split(/\r?\n/);
  let curOld: string | null = null;
  let curNew: string | null = null;
  for (const line of lines) {
    if (line.startsWith("--- ")) {
      const raw = line.slice(4).trim();
      curOld = raw === "/dev/null" ? null : raw.replace(/^a\//, "");
    } else if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      curNew = raw === "/dev/null" ? null : raw.replace(/^b\//, "");
      let status: DiffFile["status"];
      let path: string;
      if (curOld === null && curNew) {
        status = "added";
        path = curNew;
      } else if (curNew === null && curOld) {
        status = "deleted";
        path = curOld;
      } else if (curNew) {
        status = "modified";
        path = curNew;
      } else {
        continue;
      }
      files.set(path, { path, status });
      curOld = null;
      curNew = null;
    }
  }
  return Array.from(files.values());
}
