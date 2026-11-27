import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Keeps a project walk inside the project folder. Every path the walker is
 * about to list or read is resolved with realpath first; anything whose real
 * location is outside the project root (a `../` or absolute packageDirectories
 * entry, a symlink to a file or folder elsewhere) is skipped and recorded.
 * A symlink whose target is inside the project keeps working.
 */
export class Containment {
  readonly realRoot: string;
  /** Paths refused for resolving outside the project (deduplicated, as given). */
  readonly outside = new Set<string>();

  constructor(rootDir: string) {
    this.realRoot = realOrSelf(path.resolve(rootDir));
  }

  /** True when `p` really lives under the project root (or is the root). */
  inside(p: string): boolean {
    let real: string;
    try {
      real = fs.realpathSync(p);
    } catch {
      // Missing path: nothing to read. Judge the lexical location instead.
      real = path.resolve(p);
    }
    const rel = path.relative(this.realRoot, real);
    return (
      rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
    );
  }

  /** `inside`, recording a refusal. */
  allow(p: string): boolean {
    if (this.inside(p)) return true;
    this.outside.add(p);
    return false;
  }

  /** The warnings to show the developer, one line per refused path. */
  warnings(): string[] {
    return [...this.outside]
      .sort()
      .map((p) => `skipped ${p}: resolves outside the project folder ${this.realRoot}`);
  }
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
