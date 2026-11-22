import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemMetadataSource } from "../index.js";

/** A project read stays inside the project folder (realpath), however it is pointed out. */

let base: string;
let project: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "sfg-contain-"));
  project = path.join(base, "project");
  outside = path.join(base, "other-project");
  mkdirSync(project, { recursive: true });
  mkdirSync(outside, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

async function names(src: FilesystemMetadataSource): Promise<string[]> {
  const out: string[] = [];
  for await (const m of src.iter()) out.push(`${m.ref.memberType}:${m.ref.memberName}`);
  return out.sort();
}

describe("project reader containment", () => {
  it("skips a ../ and an absolute packageDirectories entry, with a warning", async () => {
    w(project, "force-app/main/default/classes/Mine.cls", "public class Mine {}");
    w(outside, "force-app/main/default/classes/Theirs.cls", "public class Theirs {}");
    w(
      project,
      "sfdx-project.json",
      JSON.stringify({
        packageDirectories: [
          { path: "force-app" },
          { path: "../other-project/force-app" },
          { path: path.join(outside, "force-app", "main") },
        ],
      }),
    );
    const src = FilesystemMetadataSource.fromProjectRoot(project);
    expect(await names(src)).toEqual(["ApexClass:Mine"]);
    const warnings = src.warnings();
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain("outside the project folder");
  });

  it("skips symlinks to a file and to a folder outside, and a DataPack sibling", async () => {
    const md = "force-app/main/default";
    w(project, `${md}/classes/Mine.cls`, "public class Mine {}");
    w(outside, "Stolen.cls", "public class Stolen {}");
    w(outside, "triggers-elsewhere/Evil.trigger", "trigger Evil on Account (before insert) {}");
    symlinkSync(path.join(outside, "Stolen.cls"), path.join(project, md, "classes/Stolen.cls"));
    symlinkSync(path.join(outside, "triggers-elsewhere"), path.join(project, md, "triggers"));
    const src = FilesystemMetadataSource.fromProjectRoot(project);
    expect(await names(src)).toEqual(["ApexClass:Mine"]);
    const joined = src.warnings().join("\n");
    expect(joined).toContain("Stolen.cls");
    expect(joined).toContain("triggers");
  });

  it("still follows a symlink whose target is inside the project", async () => {
    const md = "force-app/main/default";
    w(project, "shared/Linked.cls", "public class Linked {}");
    mkdirSync(path.join(project, md, "classes"), { recursive: true });
    symlinkSync(
      path.join(project, "shared/Linked.cls"),
      path.join(project, md, "classes/Linked.cls"),
    );
    const src = FilesystemMetadataSource.fromProjectRoot(project);
    expect(await names(src)).toEqual(["ApexClass:Linked"]);
    expect(src.warnings()).toEqual([]);
  });

  it("does not read a file text from outside the project", async () => {
    const md = "force-app/main/default";
    w(outside, "secret.txt", "TOP-SECRET-VALUE");
    mkdirSync(path.join(project, md, "flows"), { recursive: true });
    symlinkSync(path.join(outside, "secret.txt"), path.join(project, md, "flows/X.flow-meta.xml"));
    const src = FilesystemMetadataSource.fromProjectRoot(project);
    const seen: string[] = [];
    for await (const m of src.iter()) seen.push(m.content);
    expect(seen.join("\n")).not.toContain("TOP-SECRET-VALUE");
  });
});
