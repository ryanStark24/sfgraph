import { Command } from "commander";
import { ingestCmd } from "./commands/ingest.js";
import { installCmd } from "./commands/install.js";
import {
  disableCmd,
  enableLocalCmd,
  previewCmd,
  purgeCmd,
  resetIdCmd,
  statusCmd,
} from "./commands/telemetry.js";
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
    .description("install MCP config for a target")
    .option("--target <target>", "claude | cursor | all", "all")
    .action(async (opts: { target: string }) => {
      await installCmd(opts.target);
    });

  program
    .command("ingest")
    .description("sync a Salesforce org into the local graph (read-only)")
    .requiredOption("--org <alias>", "Salesforce alias/username from sf CLI")
    .option("--mode <mode>", "full | incremental | auto", "auto")
    .option("--db <path>", "override SQLite database path")
    .action(async (opts: { org: string; mode: "full" | "incremental" | "auto"; db?: string }) => {
      await ingestCmd({ org: opts.org, mode: opts.mode, db: opts.db });
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
