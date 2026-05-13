import { describe, expect, it } from "vitest";
import { buildProgram } from "../index.js";

/**
 * These tests parse the CLI argv into the `ingest` command and assert that the
 * commander option model exposes the new flags. We don't actually invoke
 * `ingestCmd` (that would hit @salesforce/core); we just verify the parser.
 */
describe("sfgraph ingest CLI flags", () => {
  function getIngest(): {
    program: ReturnType<typeof buildProgram>;
    ingest: ReturnType<ReturnType<typeof buildProgram>["commands"][number]["name"]> extends string
      ? ReturnType<typeof buildProgram>["commands"][number]
      : never;
  } {
    const program = buildProgram();
    const ingest = program.commands.find((c) => c.name() === "ingest");
    if (!ingest) throw new Error("ingest command not registered");
    return { program, ingest: ingest as never };
  }

  it("registers --orgs, --all, and --parallel options", () => {
    const { ingest } = getIngest();
    const opts = (ingest as unknown as { options: Array<{ long?: string }> }).options.map(
      (o) => o.long,
    );
    expect(opts).toContain("--orgs");
    expect(opts).toContain("--all");
    expect(opts).toContain("--parallel");
    expect(opts).toContain("--org");
  });

  it("parses --orgs a,b correctly", () => {
    const { ingest } = getIngest();
    // Parse without running the action by using parseOptions on a clone.
    const parsed = (
      ingest as never as {
        parseOptions: (argv: string[]) => { operands: string[]; unknown: string[] };
      }
    ).parseOptions(["--orgs", "a,b"]);
    expect(parsed).toBeDefined();
    // After parse, commander stores parsed values on the command.
    const opts = (ingest as unknown as { opts: () => Record<string, unknown> }).opts();
    expect(opts.orgs).toBe("a,b");
  });

  it("honors --all flag", () => {
    const { ingest } = getIngest();
    (ingest as never as { parseOptions: (argv: string[]) => unknown }).parseOptions(["--all"]);
    const opts = (ingest as unknown as { opts: () => Record<string, unknown> }).opts();
    expect(opts.all).toBe(true);
  });

  it("honors --parallel flag", () => {
    const { ingest } = getIngest();
    (ingest as never as { parseOptions: (argv: string[]) => unknown }).parseOptions([
      "--orgs",
      "a,b",
      "--parallel",
    ]);
    const opts = (ingest as unknown as { opts: () => Record<string, unknown> }).opts();
    expect(opts.parallel).toBe(true);
    expect(opts.orgs).toBe("a,b");
  });
});
