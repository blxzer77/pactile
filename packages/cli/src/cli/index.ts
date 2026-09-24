import fs from "node:fs";
import chalk from "chalk";
import { Command } from "commander";
import {
  ensureCapabilitiesFileExists,
  runCapabilitySmokeCommand,
} from "../commands/capability-smoke.js";
import { init } from "../commands/init.js";
import { update } from "../commands/update.js";
import { migratePreview } from "../commands/migrate.js";
import { rollout } from "../commands/rollout.js";
import { upgrade } from "../commands/upgrade.js";
import { uninstall } from "../commands/uninstall.js";
import { detach } from "../commands/detach.js";
import { rollback } from "../commands/rollback.js";
import { purge } from "../commands/purge.js";
import {
  runWorkflowCommand,
  WorkflowCommandError,
} from "../commands/workflow.js";
import { isWorkflowInitialized, workflowPath } from "../utils/workflow-dir.js";
import { PACKAGE_NAME, VERSION } from "../constants/version.js";
import { runKernelJsonCli } from "@blxzer/pactile-core/task";
import { runTaskCli } from "../commands/task.js";
import { runContextCli } from "../commands/context.js";
import { runSessionCli } from "../commands/session.js";
import {
  PACTILE_ENVIRONMENT_KEYS,
  readPactileEnvironment,
} from "@blxzer/pactile-core";
import { compareVersions } from "../utils/compare-versions.js";
import {
  LEGACY_IMPORT_DESCRIPTION,
  LEGACY_IMPORT_OPTION,
} from "../pactile/compat/cli-options.js";

// Re-export for backwards compatibility (consumers should prefer constants/version.js)
export { VERSION, PACKAGE_NAME };

/**
 * Check if a Pactile update is available (compare project and CLI versions).
 */
function checkForUpdates(cwd: string): void {
  const versionFile = workflowPath(cwd, ".version");
  if (!versionFile || !fs.existsSync(versionFile)) return;

  const projectVersion = fs.readFileSync(versionFile, "utf-8").trim();
  const cliVersion = VERSION;
  const comparison = compareVersions(cliVersion, projectVersion);

  if (comparison > 0) {
    // CLI is newer than project - update available
    console.log(
      chalk.yellow(
        `\n⚠️  Pactile update available: ${projectVersion} → ${cliVersion}`,
      ),
    );
    console.log(chalk.gray(`   Run: pactile update\n`));
  } else if (comparison < 0) {
    // CLI is older than project - CLI needs updating
    console.log(
      chalk.yellow(
        `\n⚠️  Your CLI (${cliVersion}) is older than project (${projectVersion})`,
      ),
    );
    console.log(chalk.gray(`   Run: pactile upgrade\n`));
  }
}

// Check for updates at CLI startup when a workflow dir exists.
// Never print to stdout when running an MCP stdio server — hosts
// treat any non-framed stdout as a handshake failure.
const cwd = process.cwd();
const argvRest = process.argv.slice(2);
const isStdioMcp = argvRest.includes("mcp");
const isKernelJson = argvRest[0] === "kernel";
if (isWorkflowInitialized(cwd) && !isStdioMcp && !isKernelJson) {
  checkForUpdates(cwd);
}

const program = new Command();

function debugEnabled(): boolean {
  return Boolean(
    process.env.DEBUG ??
      readPactileEnvironment(PACTILE_ENVIRONMENT_KEYS.debug),
  );
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program
  .name("pactile")
  .description(
    "Evidence-backed governed capability workspace for Codex",
  )
  .version(VERSION, "-v, --version", "output the version number");

program
  .command("init")
  .description("Initialize Pactile in the current project")
  .option("--codex", "Include Codex project integration")
  .option(LEGACY_IMPORT_OPTION, LEGACY_IMPORT_DESCRIPTION)
  .option("-y, --yes", "Skip prompts and use defaults")
  .option(
    "-u, --user <name>",
    "Initialize developer identity with specified name",
  )
  .option("-f, --force", "Overwrite existing files without asking")
  .option("-s, --skip-existing", "Skip existing files without asking")
  .option(
    "--skip-readiness",
    "Skip Smart Search and selected capability readiness checks and report framework readiness as unverified",
  )
  .option(
    "--capability <id>",
    "Enable an optional project capability (repeatable; use 'all' for every selectable capability)",
    collectOption,
    [],
  )
  .option(
    "--with-optional <name>",
    "Install an optional/experimental skill into the project skills directory (repeatable; no optional skill ships today)",
    collectOption,
    [],
  )
  .option("--monorepo", "Force monorepo mode")
  .option("--no-monorepo", "Skip monorepo detection")
  .option(
    "-t, --template <name>",
    "Use a remote spec template (e.g., electron-fullstack)",
  )
  .option(
    "--overwrite",
    "Overwrite existing spec directory when using template",
  )
  .option("--append", "Only add missing files when using template")
  .option(
    "-r, --registry <source>",
    "Use a custom template registry (e.g., gh:myorg/myrepo/specs)",
  )
  .option(
    "--workflow <id>",
    "Workflow template id for .pactile/workflow.md (default: native; e.g., tdd)",
  )
  .option(
    "--workflow-source <source>",
    "Custom marketplace source for the --workflow lookup (e.g., gh:myorg/myrepo/marketplace)",
  )
  .action(async (options: Record<string, unknown>) => {
    try {
      await init(options);
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (debugEnabled()) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });

program
  .command("capability-smoke")
  .description(
    "Verify selected project capabilities and optionally write readiness statuses",
  )
  .option("--json", "Emit machine-readable capability smoke output")
  .option(
    "--write-status",
    "Write ready/failed status back to .pactile/capabilities.json and capabilities.md",
  )
  .action(async (options: Record<string, unknown>) => {
    try {
      ensureCapabilitiesFileExists(process.cwd());
      const report = await runCapabilitySmokeCommand({
        cwd: process.cwd(),
        json: options.json as boolean,
        writeStatus: options.writeStatus as boolean,
      });
      if (!report.ok) {
        process.exit(1);
      }
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (debugEnabled()) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });

program
  .command("update")
  .description("Update Pactile configuration and projections")
  .option("--dry-run", "Preview changes without applying them")
  .option("-f, --force", "Overwrite all changed files without asking")
  .option("-s, --skip-all", "Skip all changed files without asking")
  .option("-n, --create-new", "Create .new copies for all changed files")
  .option("--allow-downgrade", "Allow downgrading to an older version")
  .option("--migrate", "Apply pending file migrations (renames/deletions)")
  .option(
    "--skip-readiness",
    "Skip Smart Search and selected capability readiness checks and report framework readiness as unverified",
  )
  .option(
    "--json",
    "Emit one-line JSON rollout evidence (dry-run or apply)",
  )
  .option(
    "--skip-post-update-smoke",
    "Skip post-apply Node runtime smoke checks",
  )
  .option(
    "--write-artifacts",
    "Maintainer: after one confirm, write artifact B projections (required_controls / Topology)",
  )
  .option("--maintainer", "Alias for --write-artifacts")
  .action(async (options: Record<string, unknown>) => {
    try {
      await update({
        dryRun: options.dryRun as boolean,
        force: options.force as boolean,
        skipAll: options.skipAll as boolean,
        createNew: options.createNew as boolean,
        allowDowngrade: options.allowDowngrade as boolean,
        migrate: options.migrate as boolean,
        skipReadiness: options.skipReadiness as boolean,
        json: options.json as boolean,
        skipPostUpdateSmoke: options.skipPostUpdateSmoke as boolean,
        writeArtifacts:
          options.writeArtifacts === true || options.maintainer === true,
      });
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (debugEnabled()) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });

program
  .command("migrate")
  .description(
    "Optional P36 preview (dry-run only). Apply official and artifact writes with pactile update",
  )
  .option("--dry-run", "Preview only (default; this command never writes)")
  .option(
    "--write-artifacts",
    "Show the maintainer artifact-write plan (still dry-run)",
  )
  .option("--maintainer", "Alias for --write-artifacts")
  .action((options: Record<string, unknown>) => {
    migratePreview({
      dryRun: true,
      writeArtifacts:
        options.writeArtifacts === true || options.maintainer === true,
    });
  });

program
  .command("rollout")
  .description(
    "Run pactile update across multiple project paths and aggregate rollout evidence",
  )
  .requiredOption(
    "-p, --project <path>",
    "Project root with .pactile/ (repeatable)",
    (val: string, prev: string[] | undefined) => [...(prev ?? []), val],
    [] as string[],
  )
  .option("--dry-run", "Preview updates without applying")
  .option("-f, --force", "Overwrite all changed files without asking")
  .option("-s, --skip-all", "Skip all changed files without asking")
  .option("-n, --create-new", "Create .new copies for all changed files")
  .option("--migrate", "Apply pending file migrations")
  .option("--allow-downgrade", "Allow downgrading project version")
  .option("--skip-readiness", "Skip readiness checks")
  .option("--skip-post-update-smoke", "Skip post-apply script smoke")
  .option("--json", "Emit aggregated JSON rollout evidence")
  .option("-o, --output <file>", "Write --json output to file")
  .action(async (options: Record<string, unknown>) => {
    try {
      await rollout({
        projects: options.project as string[],
        dryRun: options.dryRun as boolean,
        force: options.force as boolean,
        skipAll: options.skipAll as boolean,
        createNew: options.createNew as boolean,
        migrate: options.migrate as boolean,
        allowDowngrade: options.allowDowngrade as boolean,
        skipReadiness: options.skipReadiness as boolean,
        skipPostUpdateSmoke: options.skipPostUpdateSmoke as boolean,
        json: options.json as boolean,
        output: options.output as string | undefined,
      });
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (debugEnabled()) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });

program
  .command("upgrade")
  .description("Upgrade the global Pactile CLI package")
  .option(
    "--tag <tag>",
    "npm dist-tag or version to install (default follows current channel: latest, beta, or rc)",
  )
  .option("--dry-run", "Print the install command without running it")
  .action(async (options: Record<string, unknown>) => {
    try {
      await upgrade({
        tag: options.tag as string | undefined,
        dryRun: options.dryRun as boolean,
      });
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (debugEnabled()) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });

program
  .command("uninstall")
  .description("Safely detach every Pactile Adapter and preserve .pactile/")
  .option("-y, --yes", "Confirm non-interactive Adapter detach")
  .option("--dry-run", "Preview detach decisions without changing state")
  .action(async (options: Record<string, unknown>) => {
    try {
      await uninstall({
        yes: options.yes as boolean,
        dryRun: options.dryRun as boolean,
      });
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (debugEnabled()) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });

program
  .command("detach <adapter>")
  .description("Safely detach a Codex or legacy Cursor Adapter")
  .option("--dry-run", "Preview ownership decisions without changing state")
  .action((adapter: string, options: Record<string, unknown>) => {
    try {
      detach({ adapter, dryRun: options.dryRun as boolean });
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("rollback <generation>")
  .description("Switch to a sealed Pactile generation and reconcile Adapters")
  .option("--dry-run", "Verify and preview the generation switch")
  .action(async (generation: string, options: Record<string, unknown>) => {
    try {
      await rollback({ generation, dryRun: options.dryRun as boolean });
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("purge")
  .description("Explicitly remove an inactive Pactile canonical root")
  .option("--dry-run", "Emit the exact target-set fingerprint without writing")
  .option("--yes", "Explicitly confirm destructive canonical cleanup")
  .option(
    "--preview-fingerprint <sha256>",
    "Exact fingerprint emitted by a prior purge --dry-run",
  )
  .action((options: Record<string, unknown>) => {
    try {
      purge({
        dryRun: options.dryRun as boolean,
        yes: options.yes as boolean,
        previewFingerprint: options.previewFingerprint as string | undefined,
      });
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program
  .command("workflow")
  .description(
    "List or switch the project's .pactile/workflow.md template (native, tdd, or marketplace)",
  )
  .option(
    "-t, --template <id>",
    "Workflow template id (e.g., native, tdd)",
  )
  .option(
    "-m, --marketplace <source>",
    "Custom marketplace source (e.g., gh:myorg/myrepo/marketplace)",
  )
  .option("--list", "List available workflow templates and exit")
  .option("-f, --force", "Overwrite a modified workflow.md without asking")
  .option(
    "-n, --create-new",
    "Write .pactile/workflow.md.new instead of replacing the active workflow",
  )
  .action(async (options: Record<string, unknown>) => {
    try {
      await runWorkflowCommand({
        template: options.template as string | undefined,
        marketplace: options.marketplace as string | undefined,
        list: options.list as boolean | undefined,
        force: options.force as boolean | undefined,
        createNew: options.createNew as boolean | undefined,
      });
    } catch (error) {
      if (error instanceof WorkflowCommandError) {
        console.error(chalk.red("Error:"), error.message);
        process.exit(1);
      }
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      if (debugEnabled()) {
        console.error(error instanceof Error ? error.stack : error);
      }
      process.exit(1);
    }
  });

program
  .command("context")
  .description("Read Pactile task, package, and session context with the Node runtime")
  .addHelpText("after", "\nModes: default, record, packages, phase, lite, session, retrieval-pack\nExamples:\n  pactile context --mode packages --json\n  pactile context --mode session --json\n  pactile context --mode phase --step 1\n  pactile context --mode retrieval-pack --input collected-evidence.json --max-items 8 --json\n")
  .allowUnknownOption()
  .allowExcessArguments()
  .argument("[arguments...]")
  .action(() => {
    process.exitCode = runContextCli(process.argv.slice(3));
  });

program
  .command("session")
  .description("Record a Pactile journal session with the Node runtime")
  .addHelpText("after", "\nOperations:\n  add --title <title> [--summary <text>] [--content-file <path>]\n  search --query <query> [--json]\n")
  .allowUnknownOption()
  .allowExcessArguments()
  .argument("[operation]")
  .argument("[arguments...]")
  .action(() => {
    process.exitCode = runSessionCli(process.argv.slice(3));
  });

program
  .command("task")
  .description("Manage Pactile tasks with the Node runtime")
  .addHelpText("after", "\nCore operations:\n  create <title> --slug <slug> [--rigor lite|full] [--parent <task>]\n  dashboard | list | list-archive [YYYY-MM] | select <task> | selected | exit\n  start-execution <task> --check|--approved [--ignore-deps]\n  archive <task> [--check] [--archive-integrated-children]\n  prepare-archive-evidence <task> [--dry-run] | prepare-learning-scaffold <task> [--trigger <text>]\n  set-deps <task> [required-task-id...]\n  add-subtask <parent> <child> | remove-subtask <parent> <child>\n  prepare-child-worktree <parent> <child> --branch <branch> [--check]\n  set-child-state <parent> <child> <state> --evidence <ref>\n  integrate-child <parent> <child> <state> --evidence <ref> --ref <git-ref> [--execute-merge]\n  record-ac-evidence | record-independent-check | record-gate\n  add-context | list-context | validate | artifact-locale\n")
  .allowUnknownOption()
  .allowExcessArguments()
  .argument("[operation]")
  .argument("[arguments...]")
  .action(() => {
    process.exitCode = runTaskCli(process.argv.slice(3));
  });

program
  .command("kernel")
  .description(
    "Kernel JSON stdin/stdout (Stage 2 create/start/record-gate/archive/patch + Stage 1 transition)",
  )
  .requiredOption(
    "--json",
    "Read a Kernel request from stdin and write one JSON object to stdout",
  )
  .action(async () => {
    try {
      const code = await runKernelJsonCli({ cwd: process.cwd() });
      process.exit(code);
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program.parse();
