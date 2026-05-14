import { Command } from "commander";
import { ingestCmd } from "./commands/ingest.js";
import { installCmd } from "./commands/install.js";
import { linkCmd } from "./commands/link.js";
import {
  snapshotCreateCmd,
  snapshotDeleteCmd,
  snapshotDiffCmd,
  snapshotListCmd,
  snapshotPruneCmd,
} from "./commands/snapshot.js";
import {
  disableCmd,
  enableLocalCmd,
  previewCmd,
  purgeCmd,
  resetIdCmd,
  statusCmd,
} from "./commands/telemetry.js";
import { wipCmd } from "./commands/wip.js";
import { getCliVersion } from "./version.js";

export function buildProgram(): Command {
  const program = new Command();
  program.name("sfgraph").description("sfgraph CLI").version(getCliVersion());

  program
    .command("version")
    .description("print sfgraph version")
    .action(() => {
      console.log(getCliVersion());
    });

  program
    .command("install")
    .description("install skills + MCP config for the target editor(s)")
    .option("--target <target>", "claude | cursor | vscode | all", "all")
    .option("--dry-run", "show what would be written without writing", false)
    .option("--skills-only", "only install skills; skip MCP config", false)
    .option("--mcp-only", "only write MCP config; skip skills", false)
    .option(
      "--local",
      "point the MCP entry at this local binary instead of `npx @ryanstark24/sfgraph-mcp` (use when the npm package isn't published yet)",
      false,
    )
    .action(
      async (opts: {
        target: "claude" | "cursor" | "vscode" | "all";
        dryRun: boolean;
        skillsOnly: boolean;
        mcpOnly: boolean;
        local: boolean;
      }) => {
        await installCmd({
          target: opts.target,
          dryRun: opts.dryRun,
          skillsOnly: opts.skillsOnly,
          mcpOnly: opts.mcpOnly,
          local: opts.local,
        });
      },
    );

  program
    .command("mcp")
    .description("start the MCP server over stdio (this is what IDEs invoke)")
    .action(async () => {
      const { runMcpServer } = await import("@ryanstark24/sfgraph-server");
      await runMcpServer();
    });

  program
    .command("ingest")
    .description("sync a Salesforce org into the local graph (read-only)")
    .option("--org <alias>", "Salesforce alias/username (defaults to `sf config` target-org)")
    .option("--orgs <list>", "comma-separated list of aliases to ingest in one run (ignores --org)")
    .option("--all", "ingest every authenticated org from `sf` (ignores --org)", false)
    .option(
      "--parallel",
      "with --orgs/--all, run all orgs concurrently (shares default rate-limit pools)",
      false,
    )
    .option("--mode <mode>", "full | incremental | auto", "auto")
    .option(
      "--rebuild",
      "discard existing graph (move to backups/), open fresh DB, force full sync",
      false,
    )
    .option("--no-backup", "with --rebuild, delete existing graph instead of backing it up")
    .option(
      "--detect-deletions",
      "with full sync, delete qnames present in the graph but not touched this run (skipped on parse errors)",
      false,
    )
    .option("--db <path>", "override SQLite database path")
    .option(
      "--only <labels>",
      "comma-separated source labels to fetch (e.g. 'apex,generic:Profile'); merges into existing graph without rebuild",
    )
    .option(
      "--retry-skipped",
      "re-fetch only sources that were skipped in the previous run (read from <dataDir>/<orgId>.skips.json)",
      false,
    )
    .option(
      "--embed-model <path>",
      "absolute path to a custom embedding model dir (overrides the vendored MiniLM); also reads SFGRAPH_EMBED_MODEL_PATH",
    )
    .option(
      "--embed-model-id <id>",
      "model id (e.g. 'MyOrg/MyModel'); also reads SFGRAPH_EMBED_MODEL_ID",
    )
    .option(
      "--embed-model-dim <n>",
      "embedding dimension (default 384); also reads SFGRAPH_EMBED_MODEL_DIM",
      (v) => Number.parseInt(v, 10),
    )
    .action(
      async (opts: {
        org?: string;
        orgs?: string;
        all?: boolean;
        parallel?: boolean;
        mode: "full" | "incremental" | "auto";
        db?: string;
        embedModel?: string;
        embedModelId?: string;
        embedModelDim?: number;
        rebuild?: boolean;
        backup?: boolean; // commander inverts --no-backup → backup:false
        detectDeletions?: boolean;
        only?: string;
        retrySkipped?: boolean;
      }) => {
        await ingestCmd({
          org: opts.org,
          orgs: opts.orgs,
          all: opts.all,
          parallel: opts.parallel,
          mode: opts.mode,
          db: opts.db,
          embedModel: opts.embedModel,
          embedModelId: opts.embedModelId,
          embedModelDim: opts.embedModelDim,
          rebuild: opts.rebuild,
          noBackup: opts.backup === false,
          detectDeletions: opts.detectDeletions,
          only: opts.only,
          retrySkipped: opts.retrySkipped,
        });
      },
    );

  program
    .command("link")
    .description("link the current sfdx project to a Salesforce org alias")
    .requiredOption("--org <alias>", "Salesforce alias/username to bind to this project")
    .option("--project <path>", "override project root (defaults to CWD)")
    .action(async (opts: { org: string; project?: string }) => {
      await linkCmd({ org: opts.org, project: opts.project });
    });

  program
    .command("wip")
    .description("analyze local sfdx-source changes against the linked org's graph")
    .option("--depth <n>", "traversal depth (1..5)", (v) => Number.parseInt(v, 10), 3)
    .option(
      "--mode <mode>",
      "changed-only | full-folder",
      (v) => v as "changed-only" | "full-folder",
      "changed-only",
    )
    .option("--project <path>", "override project root (defaults to CWD)")
    .option("--org <alias>", "override org alias (defaults to workspace binding)")
    .action(
      async (opts: {
        depth: number;
        mode: "changed-only" | "full-folder";
        project?: string;
        org?: string;
      }) => {
        await wipCmd({
          depth: opts.depth,
          mode: opts.mode,
          project: opts.project,
          org: opts.org,
        });
      },
    );

  const snapshot = program
    .command("snapshot")
    .description("manage graph snapshots (list, create, diff, prune, delete)");
  snapshot
    .command("list")
    .description("list snapshots for an org")
    .option("--org <alias>", "Salesforce alias (defaults to workspace binding or `sf` default)")
    .option("--project <path>", "override project root (defaults to CWD)")
    .action(async (opts: { org?: string; project?: string }) => {
      await snapshotListCmd({ org: opts.org, project: opts.project });
    });
  snapshot
    .command("create")
    .description("create a labeled snapshot of the current graph")
    .requiredOption("--label <name>", "human-readable label")
    .option("--kind <kind>", "manual | scheduled", "manual")
    .option("--org <alias>", "Salesforce alias")
    .option("--project <path>", "override project root")
    .action(
      async (opts: {
        label: string;
        kind?: "manual" | "scheduled";
        org?: string;
        project?: string;
      }) => {
        await snapshotCreateCmd({
          label: opts.label,
          kind: opts.kind,
          org: opts.org,
          project: opts.project,
        });
      },
    );
  snapshot
    .command("diff <fromId> <toId>")
    .description("diff two snapshots (or a snapshot vs. 'current')")
    .option("--org <alias>", "Salesforce alias")
    .option("--project <path>", "override project root")
    .action(async (fromId: string, toId: string, opts: { org?: string; project?: string }) => {
      await snapshotDiffCmd({ fromId, toId, org: opts.org, project: opts.project });
    });
  snapshot
    .command("prune")
    .description("delete auto-snapshots older than --retain-days")
    .requiredOption("--retain-days <n>", "retention window in days", (v) => Number.parseInt(v, 10))
    .option("--org <alias>", "Salesforce alias")
    .option("--project <path>", "override project root")
    .action(async (opts: { retainDays: number; org?: string; project?: string }) => {
      await snapshotPruneCmd({
        retainDays: opts.retainDays,
        org: opts.org,
        project: opts.project,
      });
    });
  snapshot
    .command("delete <snapshotId>")
    .description("delete a single snapshot by id")
    .option("--org <alias>", "Salesforce alias")
    .option("--project <path>", "override project root")
    .action(async (snapshotId: string, opts: { org?: string; project?: string }) => {
      await snapshotDeleteCmd({ snapshotId, org: opts.org, project: opts.project });
    });

  const telemetry = program.command("telemetry").description("manage local telemetry");
  telemetry.command("status").action(async () => {
    await statusCmd();
  });
  telemetry
    .command("enable")
    .option("--local", "use local file sink", false)
    .action(async () => {
      await enableLocalCmd();
    });
  telemetry.command("disable").action(async () => {
    await disableCmd();
  });
  telemetry.command("preview").action(async () => {
    await previewCmd();
  });
  telemetry.command("purge").action(async () => {
    await purgeCmd();
  });
  telemetry.command("reset-id").action(async () => {
    await resetIdCmd();
  });

  return program;
}

export async function run(argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}

export { getCliVersion };
