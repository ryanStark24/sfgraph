import { Command } from "commander";
import { auditCmd } from "./commands/audit.js";
import { doctorCmd } from "./commands/doctor.js";
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
      "point the MCP entry at this local binary instead of `npx @ryanstark24/sfgraph` (use when the npm package isn't published yet)",
      false,
    )
    .option(
      "--pin-node <path>",
      "absolute path to a node binary to use as the MCP entry's `command` (defaults to process.execPath when --local is set). Pins the IDE child to a Node ABI matching the rebuilt better-sqlite3 binding.",
    )
    .action(
      async (opts: {
        target: "claude" | "cursor" | "vscode" | "all";
        dryRun: boolean;
        skillsOnly: boolean;
        mcpOnly: boolean;
        local: boolean;
        pinNode?: string;
      }) => {
        const args: Parameters<typeof installCmd>[0] = {
          target: opts.target,
          dryRun: opts.dryRun,
          skillsOnly: opts.skillsOnly,
          mcpOnly: opts.mcpOnly,
          local: opts.local,
        };
        if (opts.pinNode !== undefined) args.pinNode = opts.pinNode;
        await installCmd(args);
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
    .option(
      "--tooling-pool <n>",
      "max concurrent Tooling-API calls (default 5; also reads SFGRAPH_TOOLING_POOL)",
      (v) => Number.parseInt(v, 10),
    )
    .option(
      "--metadata-pool <n>",
      "max concurrent Metadata-API calls (default 5; also reads SFGRAPH_METADATA_POOL). Bump this (e.g. 8-10) to speed up slow ingests dominated by Profile/PermissionSet/Layout fans.",
      (v) => Number.parseInt(v, 10),
    )
    .option(
      "--data-pool <n>",
      "max concurrent SObject/Bulk queries (default 10; also reads SFGRAPH_DATA_POOL)",
      (v) => Number.parseInt(v, 10),
    )
    .option(
      "--debug",
      "verbose ingest tracing: heartbeat every 10s with heap/rss, last-source tag, signal stack traces. Also sets SFGRAPH_DEBUG_INGEST=1. Use when an ingest dies silently to identify which extractor was active when it stopped.",
      false,
    )
    .option(
      "--no-auto-retry-skipped",
      "disable the post-ingest auto-retry. By default, if more than SFGRAPH_AUTO_RETRY_THRESHOLD (10) sources were skipped with transient errors (rate_limit/network/unknown), sfgraph waits briefly and re-ingests just those sources. Pass this flag (or set SFGRAPH_NO_AUTO_RETRY=1) to skip it.",
    )
    .option(
      "--no-cross-flavor",
      "skip the post-merge Vlocity↔OmniStudio canonical-of resolver.",
    )
    .option(
      "--no-arity-resolve",
      "skip the post-merge Apex method-arity resolver (leaves CALLS→ApexMethod:X.y(?) edges dangling).",
    )
    .option(
      "--no-flow-resolve",
      "skip the post-merge Flow→Apex invocable-method resolver.",
    )
    .option(
      "--no-audit",
      "skip the post-merge dangling-edge audit summary printed at end of run.",
    )
    .option(
      "--skip-threshold <n>",
      "exit non-zero when ≥N transient sources skipped in a single-org ingest. Env: SFGRAPH_SKIP_THRESHOLD. Default 5. Use a large value (e.g. 9999) to preserve the prior exit-0 behavior.",
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
        toolingPool?: number;
        metadataPool?: number;
        dataPool?: number;
        debug?: boolean;
        autoRetrySkipped?: boolean; // commander inverts --no-auto-retry-skipped → autoRetrySkipped:false
        crossFlavor?: boolean; // commander inverts --no-cross-flavor
        arityResolve?: boolean; // commander inverts --no-arity-resolve
        flowResolve?: boolean; // commander inverts --no-flow-resolve
        audit?: boolean; // commander inverts --no-audit
        skipThreshold?: number;
      }) => {
        if (opts.debug) process.env.SFGRAPH_DEBUG_INGEST = "1";
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
          toolingPool: opts.toolingPool,
          metadataPool: opts.metadataPool,
          dataPool: opts.dataPool,
          noAutoRetry: opts.autoRetrySkipped === false,
          noCrossFlavor: opts.crossFlavor === false,
          noArityResolve: opts.arityResolve === false,
          noFlowResolve: opts.flowResolve === false,
          noAudit: opts.audit === false,
          skipThreshold: opts.skipThreshold,
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

  program
    .command("audit")
    .description(
      "audit the graph for dangling edges — references emitted by parsers whose target node was never materialized (managed-package methods, third-party imports, unparsed metadata).",
    )
    .option("--org <alias>", "Salesforce alias (defaults to workspace binding or `sf` default)")
    .option("--project <path>", "override project root (defaults to CWD)")
    .option("--format <fmt>", "table | json", "table")
    .option(
      "--sample <n>",
      "how many dangling edges to include in the sample list (default 25)",
      (v) => Number.parseInt(v, 10),
    )
    .option(
      "--delete-dangling",
      "DESTRUCTIVE: delete every dangling edge. Requires --yes. Use only after reviewing the audit; deleted edges are gone until next ingest.",
      false,
    )
    .option("--yes", "confirmation flag required by --delete-dangling", false)
    .action(
      async (opts: {
        org?: string;
        project?: string;
        format?: "table" | "json";
        sample?: number;
        deleteDangling?: boolean;
        yes?: boolean;
      }) => {
        await auditCmd({
          org: opts.org,
          project: opts.project,
          format: opts.format,
          sample: opts.sample,
          deleteDangling: opts.deleteDangling,
          yes: opts.yes,
        });
      },
    );

  program
    .command("rebuild-bindings")
    .description(
      "rebuild better-sqlite3's native binding for the current Node runtime (fixes 'bindings file not found' / ABI mismatch after Node upgrade or on a Node version without prebuilts)",
    )
    .option("--dry-run", "show what would be run without executing", false)
    .option("--package-manager <pm>", "force npm | pnpm (auto-detected by default)")
    .action(async (opts: { dryRun: boolean; packageManager?: "npm" | "pnpm" }) => {
      const { rebuildBindingsCmd } = await import("./commands/rebuild-bindings.js");
      await rebuildBindingsCmd({
        dryRun: opts.dryRun,
        ...(opts.packageManager ? { packageManager: opts.packageManager } : {}),
      });
    });

  program
    .command("doctor")
    .description(
      "diagnose sfgraph install (Node ABI, better-sqlite3 binding, data dir, org DBs, sf CLI, IDE MCP config)",
    )
    .action(async () => {
      await doctorCmd();
    });

  program
    .command("refresh-orgs")
    .description(
      "re-snapshot sf-CLI org state (aliases + default-org) so the MCP child sees the latest after a `sf org login` / alias change / `sf config set target-org`",
    )
    .action(async () => {
      const { refreshOrgsCmd } = await import("./commands/refresh-orgs.js");
      await refreshOrgsCmd();
    });

  program
    .command("serve")
    .description("start the local web visualiser for the ingested graph")
    .option("--port <port>", "port to bind", "7777")
    .option(
      "--host <host>",
      "host to bind (default 127.0.0.1 — do not expose publicly)",
      "127.0.0.1",
    )
    .option("--no-open", "do not auto-open the browser")
    .option(
      "--i-understand-public-bind",
      "required acknowledgement when binding to a non-loopback host (the web API has no auth)",
      false,
    )
    .action(
      async (opts: {
        port: string;
        host: string;
        open: boolean;
        iUnderstandPublicBind: boolean;
      }) => {
        const { serveCmd } = await import("./commands/serve.js");
        await serveCmd({
          port: Number.parseInt(opts.port, 10) || 7777,
          host: opts.host,
          open: opts.open !== false,
          iUnderstandPublicBind: Boolean(opts.iUnderstandPublicBind),
        });
      },
    );

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
