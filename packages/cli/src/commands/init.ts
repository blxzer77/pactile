import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import chalk from "chalk";
import figlet from "figlet";
import inquirer from "inquirer";
import { createWorkflowStructure } from "../configurators/workflow.js";
import { getInitToolChoices } from "../configurators/index.js";
import { DIR_NAMES, FILE_NAMES, PATHS } from "../constants/paths.js";
import { VERSION } from "../constants/version.js";
import {
  setWriteMode,
  startRecordingWrites,
  stopRecordingWrites,
  type WriteMode,
} from "../utils/file-writer.js";
import {
  applyKernelCreate,
  applyKernelStart,
  writeWaveCConfirmed,
} from "../core/task/index.js";
import { emptyTaskJson, type TaskJson } from "../utils/task-json.js";
import { initializeDeveloper, readDeveloper } from "../utils/developer.js";
import {
  detectProjectType,
  detectMonorepo,
  sanitizePkgName,
  type ProjectType,
  type DetectedPackage,
} from "../utils/project-detector.js";
import { initializeHashes, removeHash } from "../utils/template-hash.js";
import {
  NATIVE_WORKFLOW_ID,
  resolveWorkflowTemplate,
} from "../utils/workflow-resolver.js";
import {
  isCwdHomedir,
  homedirGuardMessage,
  homedirBypassEnabled,
} from "../utils/cwd-guard.js";
import {
  fetchTemplateIndex,
  probeRegistryIndex,
  downloadTemplateById,
  downloadRegistryDirect,
  parseRegistrySource,
  TIMEOUTS,
  TEMPLATE_INDEX_URL,
  type SpecTemplate,
  type TemplateStrategy,
  type RegistrySource,
  type RegistryBackend,
} from "../utils/template-fetcher.js";
import { setupProxy, maskProxyUrl } from "../utils/proxy.js";
import {
  reportInitReadiness,
  snapshotReadinessForRollout,
} from "../utils/readiness.js";
import {
  getProjectCapability,
  getProjectCapabilityChoices,
  loadProjectCapabilities,
  parseProjectCapabilities,
  writeProjectCapabilityFiles,
  type ProjectCapabilityId,
} from "../utils/project-capabilities.js";
import {
  collectCanonicalGenerationFiles,
  collectLegacyCstlLifecycleFiles,
  discoverCanonicalGenerationPaths,
  installedPactilePlatforms,
  materializeCanonicalGeneration,
  materializePreparedLegacyUserState,
  prepareLegacyCstlImport,
  readLegacyCstlVersion,
  runLifecycleCommand,
  seedCanonicalBuildRoot,
  type LifecycleResult,
} from "../pactile/lifecycle/index.js";
import type { PactilePlatform } from "../pactile/registry.js";
import { InstallStateStore } from "../pactile/runtime/stores.js";
import {
  inspectLegacyInitContext,
  legacyImportPreparedMessage,
} from "../pactile/compat/init-context.js";

// =============================================================================
// Bootstrap Task Creation
// =============================================================================

const BOOTSTRAP_TASK_NAME = "00-bootstrap-guidelines";

/**
 * Slugify a developer name for safe use in task directory names.
 *
 * Unlike `sanitizePkgName` (which only strips npm @scope/ prefixes), this
 * handles arbitrary developer input: spaces, Unicode letters, punctuation,
 * path separators. Returns "user" fallback when input slugifies to empty.
 *
 * Exported for unit testing; not part of the public API.
 */
export function slugifyDeveloperName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "user";
}

/**
 * Write a task skeleton (task.json + prd.md).
 *
 * Idempotent: if the task dir already exists, returns true without touching
 * anything. Shared by both creator bootstrap and joiner onboarding flows.
 */
function writeTaskSkeleton(
  cwd: string,
  taskName: string,
  taskJson: TaskJson,
  prdContent: string,
): boolean {
  const taskDir = path.join(cwd, PATHS.TASKS, taskName);
  if (fs.existsSync(taskDir)) return true; // idempotent

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    const created = applyKernelCreate({
      taskDir,
      actor: "pactile init",
      idempotencyKey: `init:${taskName}`,
      record: { ...taskJson, status: "planning" },
      evidence: "pactile init skeleton",
    });
    if (taskJson.status === "in_progress") {
      applyKernelStart({
        taskDir,
        expectedRevision: created.kernel.revision,
        actor: "pactile init",
        idempotencyKey: `init-start:${taskName}`,
        record: { ...taskJson, status: "in_progress" },
        evidence: "pactile init skeleton start",
      });
    }
    fs.writeFileSync(path.join(taskDir, FILE_NAMES.PRD), prdContent, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the bootstrap checklist items (previously stored as structured
 * `subtasks: [{name, status}]` in task.json). Per task 04-21-task-schema-unify
 * (D1), these live as markdown `- [ ]` items in prd.md instead, so task.json
 * stays canonical with `subtasks: string[]` (child task dir names).
 */
function getBootstrapChecklistItems(
  projectType: ProjectType,
  packages?: DetectedPackage[],
): string[] {
  if (packages && packages.length > 0) {
    const items = packages.map((pkg) => `Fill guidelines for ${pkg.name}`);
    items.push("Add code examples");
    return items;
  }
  if (projectType === "frontend") {
    return ["Fill frontend guidelines", "Add code examples"];
  }
  if (projectType === "backend") {
    return ["Fill backend guidelines", "Add code examples"];
  }
  return [
    "Fill backend guidelines",
    "Fill frontend guidelines",
    "Add code examples",
  ];
}

function renderCapabilityReadinessSection(
  selectedCapabilities: readonly ProjectCapabilityId[],
): string {
  if (selectedCapabilities.length === 0) {
    return "";
  }

  const checklist = selectedCapabilities
    .map((id) => {
      const capability = getProjectCapability(id);
      return `- [ ] \`${capability.id}\` — ${capability.title}. Verify the generated MCP/config path is usable before claiming it in task evidence.`;
    })
    .join("\n");

  return `
## Capability readiness (required before archive)

Init selected optional project capabilities for this repo. Treat them as
\`pending\` until you verify they work in this checkout.

${checklist}

- Read \`.pactile/capabilities.json\` / \`.pactile/capabilities.md\` and keep the
  readiness state honest: \`pending\`, \`ready\`, or \`failed\`.
- For \`codebase-retrieval\`, verify \`.codegraph/\` exists (or initialize it)
  and confirm the MCP path is usable. After the first index, CodeGraph's file
  watcher auto-syncs later edits; you do not need to re-run full indexing for
  every code change.
- If a capability cannot be made ready, record the failure and fallback path in
  \`verify.md\` before archiving bootstrap.
- Validation entrypoint: \`pactile capability-smoke --write-status\`

---
`;
}

function getBootstrapRelatedFiles(
  projectType: ProjectType,
  packages?: DetectedPackage[],
): string[] {
  if (packages && packages.length > 0) {
    return packages.map((pkg) => `.pactile/spec/${sanitizePkgName(pkg.name)}/`);
  }
  if (projectType === "frontend") {
    return [".pactile/spec/frontend/"];
  }
  if (projectType === "backend") {
    return [".pactile/spec/backend/"];
  }
  return [".pactile/spec/backend/", ".pactile/spec/frontend/"];
}

function getBootstrapPrdContent(
  projectType: ProjectType,
  selectedCapabilities: readonly ProjectCapabilityId[],
  packages?: DetectedPackage[],
): string {
  const checklistItems = getBootstrapChecklistItems(projectType, packages);
  const checklistMarkdown = checklistItems
    .map((item) => `- [ ] ${item}`)
    .join("\n");

  const header = `# Bootstrap Task: Fill Project Development Guidelines

**You (the AI) are running this task. The developer does not read this file.**

The developer just ran \`pactile init\` on this project for the first time.
\`.pactile/\` now exists with empty spec scaffolding, and this bootstrap task
exists under \`.pactile/tasks/\`. When they want to work on it, they should start
this task from a session that provides Pactile session identity.

**Your job**: help them populate \`.pactile/spec/\` with the team's real
coding conventions. Every future AI session — this project's
\`pactile-implement\` and \`pactile-check\` sub-agents — auto-loads spec files
listed in per-task jsonl manifests. Empty spec = sub-agents write generic
code. Real spec = sub-agents match the team's actual patterns.

Don't dump instructions. Open with a short greeting, figure out if the repo
has any existing convention docs (AGENTS.md, .cursorrules, CONTRIBUTING.md, etc.), and drive
the rest conversationally.

---

## Status (update the checkboxes as you complete each item)

${checklistMarkdown}

---

${renderCapabilityReadinessSection(selectedCapabilities)}

## Spec files to populate
`;

  const backendSection = `

### Backend guidelines

| File | What to document |
|------|------------------|
| \`.pactile/spec/backend/directory-structure.md\` | Where different file types go (routes, services, utils) |
| \`.pactile/spec/backend/database-guidelines.md\` | ORM, migrations, query patterns, naming conventions |
| \`.pactile/spec/backend/error-handling.md\` | How errors are caught, logged, and returned |
| \`.pactile/spec/backend/logging-guidelines.md\` | Log levels, format, what to log |
| \`.pactile/spec/backend/quality-guidelines.md\` | Code review standards, testing requirements |
`;

  const frontendSection = `

### Frontend guidelines

| File | What to document |
|------|------------------|
| \`.pactile/spec/frontend/directory-structure.md\` | Component/page/hook organization |
| \`.pactile/spec/frontend/component-guidelines.md\` | Component patterns, props conventions |
| \`.pactile/spec/frontend/hook-guidelines.md\` | Custom hook naming, patterns |
| \`.pactile/spec/frontend/state-management.md\` | State library, patterns, what goes where |
| \`.pactile/spec/frontend/type-safety.md\` | TypeScript conventions, type organization |
| \`.pactile/spec/frontend/quality-guidelines.md\` | Linting, testing, accessibility |
`;

  const footer = `

### Thinking guides (already populated)

\`.pactile/spec/guides/\` contains general thinking guides pre-filled with
best practices. Customize only if something clearly doesn't fit this project.

---

## How to fill the spec

### Step 1: Import from existing convention files first (preferred)

Search the repo for existing convention docs. If any exist, read them and
extract the relevant rules into the matching \`.pactile/spec/\` files —
usually much faster than documenting from scratch.

| File / Directory | Notes |
|------|------|
| \`AGENTS.md\` | Agent entry / managed instructions |
| \`.cursorrules\` | Legacy Cursor rules file |
| \`.cursor/rules/*.mdc\` | Cursor rules directory |
| \`CONTRIBUTING.md\` | General project conventions |
| \`.editorconfig\` | Editor formatting rules |

### Step 2: Analyze the codebase for anything not covered by existing docs

Scan real code to discover patterns. Before writing each spec file:
- Find 2-3 real examples of each pattern in the codebase.
- Reference real file paths (not hypothetical ones).
- Document anti-patterns the team clearly avoids.

### Step 3: Document reality, not ideals

**Critical**: write what the code *actually does*, not what it should do.
Sub-agents match the spec, so aspirational patterns that don't exist in the
codebase will cause sub-agents to write code that looks out of place.

If the team has known tech debt, document the current state — improvement
is a separate conversation, not a bootstrap concern.

---

## Quick explainer of the runtime (share when they ask "why do we need spec at all")

- Every AI coding task spawns two sub-agents: \`pactile-implement\` (writes
  code) and \`pactile-check\` (verifies quality).
- Each task has \`implement.jsonl\` / \`check.jsonl\` manifests listing which
  spec files to load.
- The platform hook auto-injects those spec files + the task's \`prd.md\`
  into every sub-agent prompt, so the sub-agent codes/reviews per team
  conventions without anyone pasting them manually.
- Source of truth: \`.pactile/spec/\`. That's why filling it well now pays
  off forever.

---

## Completion

When the developer confirms the checklist items above are done with real
examples (not placeholders), guide them to run:

\`\`\`bash
pactile task archive 00-bootstrap-guidelines --check
pactile task archive 00-bootstrap-guidelines
\`\`\`

After archive, every new developer who joins this project will get a
\`00-join-<slug>\` onboarding task instead of this bootstrap task.

---

## Suggested opening line

"Welcome to Pactile! Your init just set me up to help you fill the project
spec — a one-time setup so every future AI session follows the team's
conventions instead of writing generic code. Before we start, do you have
any existing convention docs (AGENTS.md, .cursorrules, CONTRIBUTING.md,
etc.) I can pull from, or should I scan the codebase from scratch?"
`;

  let content = header;

  if (packages && packages.length > 0) {
    // Monorepo: generate per-package sections
    for (const pkg of packages) {
      const pkgType = pkg.type === "unknown" ? "fullstack" : pkg.type;
      const specName = sanitizePkgName(pkg.name);
      content += `\n### Package: ${pkg.name} (\`spec/${specName}/\`)\n`;
      if (pkgType !== "frontend") {
        content += `\n- Backend guidelines: \`.pactile/spec/${specName}/backend/\`\n`;
      }
      if (pkgType !== "backend") {
        content += `\n- Frontend guidelines: \`.pactile/spec/${specName}/frontend/\`\n`;
      }
    }
  } else if (projectType === "frontend") {
    content += frontendSection;
  } else if (projectType === "backend") {
    content += backendSection;
  } else {
    // fullstack
    content += backendSection;
    content += frontendSection;
  }
  content += footer;

  return content;
}

function getBootstrapTaskJson(
  developer: string,
  projectType: ProjectType,
  packages?: DetectedPackage[],
): TaskJson {
  const today = new Date().toISOString().split("T")[0];
  const relatedFiles = getBootstrapRelatedFiles(projectType, packages);

  // Canonical 24-field shape via emptyTaskJson factory.
  // Checklist items (previously stored as structured `subtasks`) are now
  // rendered as `- [ ]` items in prd.md; task.json.subtasks is always
  // string[] (child task dir names) per the canonical schema.
  return emptyTaskJson({
    id: BOOTSTRAP_TASK_NAME,
    name: BOOTSTRAP_TASK_NAME,
    title: "Bootstrap Guidelines",
    description: "Fill in project development guidelines for AI agents",
    status: "in_progress",
    dev_type: "docs",
    priority: "P1",
    creator: developer,
    assignee: developer,
    createdAt: today,
    relatedFiles,
    notes: `First-time setup task created by pactile init (${projectType} project)`,
  });
}

/**
 * Create bootstrap task for first-time setup
 */
function createBootstrapTask(
  cwd: string,
  developer: string,
  projectType: ProjectType,
  selectedCapabilities: readonly ProjectCapabilityId[],
  packages?: DetectedPackage[],
): boolean {
  const taskJson = getBootstrapTaskJson(developer, projectType, packages);
  const prdContent = getBootstrapPrdContent(
    projectType,
    selectedCapabilities,
    packages,
  );
  return writeTaskSkeleton(cwd, BOOTSTRAP_TASK_NAME, taskJson, prdContent);
}

// =============================================================================
// Joiner Onboarding Task Creation
// =============================================================================

/**
 * task.json factory for joiner onboarding. Mirrors the bootstrap factory but
 * uses dev_type "docs", higher priority "P1", and the developer-specific task
 * name (so multiple joiners in the same checkout don't collide).
 */
function getJoinerTaskJson(developer: string, taskName: string): TaskJson {
  const today = new Date().toISOString().split("T")[0];
  return emptyTaskJson({
    id: taskName,
    name: taskName,
    title: `Joining: Onboard to this Pactile project (${developer})`,
    description:
      "Onboard a new developer to an existing Pactile project: learn the workflow, conventions, and find assigned work",
    status: "in_progress",
    dev_type: "docs",
    priority: "P1",
    creator: developer,
    assignee: developer,
    createdAt: today,
    notes:
      "Generated by pactile init for a new developer joining an existing Pactile project",
  });
}

/**
 * PRD content for joiner onboarding. Kept concise (~80 lines) — deeper
 * guidance lives in skills and docs.
 */
function getJoinerPrdContent(
  developer: string,
  selectedCapabilities: readonly ProjectCapabilityId[],
): string {
  const slug = slugifyDeveloperName(developer);
  const selectedCapabilityChecklist = selectedCapabilities
    .map((id) => {
      const capability = getProjectCapability(id);
      return `- \`${capability.id}\` — re-check readiness in this clone before claiming it is available.`;
    })
    .join("\n");
  let capabilitySection = "";
  if (selectedCapabilities.length > 0) {
    capabilitySection = `
### 5. Re-verify selected project capabilities

This repo has capability selections recorded in \`.pactile/capabilities.json\`.
Before they rely on MCP-backed behavior, remind them to check the selected set:

${selectedCapabilityChecklist}

- If a capability is not \`ready\`, have them re-run the local verification path
  instead of assuming the previous machine's setup carries over.

---
`;
  }
  return `# Joiner Onboarding Task

**You (the AI) are running this task. The developer does not read this file.**

\`${developer}\` just ran \`pactile init\` on a fresh clone, saw "Developer
initialized", and will now start asking you questions in chat. This joiner task
exists under \`.pactile/tasks/\`; when they want to work on it, they should
select it from a session that provides Pactile session identity.

Your job is to orient them to Pactile. Don't dump all of this at them — open
with a short greeting, ask where they want to start, and fill in the rest as
they engage.

---

## Topics to cover (adapt order to their questions)

### 1. What Pactile is + the workflow

Pactile is a governed capability workspace for Codex that keeps AI
agents consistent with project-specific conventions instead of writing generic
code every session.

- **Human lifecycle**: Open → Define → Approve → Execute → Verify →
  (Integrate? when parent-child) → Close. Kernel writes that state.
  \`.pactile/workflow.md\` is a human overview, **not runtime SSOT**.
- **Task files** live under \`.pactile/tasks/\`. \`status\` is a projection, not
  the only truth.
- **Codex session**: read the Task record, project instructions, and current
  Evidence before resuming. The Task record remains durable authority.

### 2. Runtime mechanics (explain when they ask "how does it know what to do")

- **Context**: load Kernel / Dashboard and the selected Task's \`prd.md\`
  plus recent activity. Do not treat a generated phase index as runtime
  authority.
- **Coordination**: \`pactile codex\` records native desktop task requests and
  receipts; the App task invokes its native tools. \`pactile pi\` dispatches
  approved Execute work through Pi RPC.

File layout (mention when they ask "where does what live"):
- \`.pactile/.runtime/sessions/<session>.json\` — live-session selected-task state, gitignored
- \`.pactile/tasks/<task>/{implement,check}.jsonl\` — per-task context manifests
- \`.pactile/spec/\` — project-wide conventions (source of truth)
- \`.pactile/workspace/${developer}/journal-*.md\` — their session log,
  rotated at ~2000 lines

### 3. This project's actual conventions

- Summarize \`.pactile/spec/\` for them — what coding conventions this
  specific team enforces.
- Point at the last 5 entries in \`.pactile/tasks/archive/\` as a rhythm
  example of how people actually work here. **If archive is empty** (the
  project just started), skip this — don't invent examples.
- Not your job in this onboarding to teach them the business code itself —
  the README and their teammates handle that.

### 4. Their assigned work

- Check if \`.pactile/workspace/${developer}/\` already exists — if yes, it's
  their journal from another machine and worth mentioning.
- Run \`pactile task list --assignee "${developer}"\` to
  show tasks assigned to them. (Quote the name if it contains spaces.)
- Remind them to inspect assigned Tasks at the start of each session.

---

${capabilitySection}

## Optional: walk through a small task end-to-end

If they want to practice before touching real work, offer to pick a tiny
P3 task or a typo fix and run the full cycle together: define → approve →
execute → verify → close.

---

## Completion

When they feel oriented (or after you've covered the four topics with
reasonable back-and-forth), guide them to run:

\`\`\`bash
pactile task archive 00-join-${slug} --check
pactile task archive 00-join-${slug}
\`\`\`

---

## Suggested opening line

"Welcome! Your \`pactile init\` set me up to onboard you to this project. I
can walk you through the workflow, show you the runtime mechanics under the
hood, summarize the team's spec, or jump to what you're already curious about
— which would you prefer?"
`;
}

/**
 * Create joiner onboarding task for a new developer on an existing Pactile
 * project. Task name is slugified to be filesystem-safe for arbitrary
 * developer names (spaces, Unicode, punctuation).
 */
function createJoinerOnboardingTask(
  cwd: string,
  developer: string,
): boolean {
  const slug = slugifyDeveloperName(developer);
  const taskName = `00-join-${slug}`;
  const taskJson = getJoinerTaskJson(developer, taskName);
  const prdContent = getJoinerPrdContent(
    developer,
    loadProjectCapabilities(cwd),
  );
  return writeTaskSkeleton(cwd, taskName, taskJson, prdContent);
}

/**
 * Handle re-init when .pactile/ already exists.
 * Returns true if handled (caller should return), false if user chose full re-init.
 */
async function handleReinit(
  cwd: string,
  options: InitOptions,
  developerName: string | undefined,
): Promise<boolean> {
  const TOOLS = getPactileInitToolChoices();
  const installState = new InstallStateStore(cwd).read();
  const configuredPlatforms = new Set<PactilePlatform>(
    (installState?.state.installedAdapters ?? [])
      .filter((adapter) => adapter.status === "active")
      .map((adapter) => adapter.id.replace(/^adapter\./, ""))
      .filter(
        (platform): platform is PactilePlatform =>
          platform === "codex",
      ),
  );
  const configuredNames = [...configuredPlatforms]
    .map((id) => TOOLS.find((choice) => choice.platformId === id)?.name ?? id)
    .join(", ");

  // Determine explicit platform flags
  const explicitTools = TOOLS.filter(
    (t) => options[t.key as keyof InitOptions],
  ).map((t) => t.key);

  let doAddPlatforms = explicitTools.length > 0;
  let doAddDeveloper = !!options.user;
  let platformsToAdd: string[] = explicitTools;

  // No explicit flags → show menu
  if (!doAddPlatforms && !doAddDeveloper) {
    if (options.yes) {
      console.log(chalk.gray(`Already initialized with: ${configuredNames}`));
      console.log(
        chalk.gray(
          "Use --codex or -u <name> to add a platform/developer.",
        ),
      );
      return true;
    }

    console.log(
      chalk.gray(`\n   Already initialized with: ${configuredNames}\n`),
    );

    const { action } = await inquirer.prompt<{ action: string }>([
      {
        type: "list",
        name: "action",
        message: "Pactile is already initialized. What would you like to do?",
        choices: [
          { name: "Add AI platform(s)", value: "add-platform" },
          {
            name: "Set up developer identity on this device",
            value: "add-developer",
          },
          { name: "Full re-initialize", value: "full" },
        ],
      },
    ]);

    if (action === "full") {
      return false; // Fall through to full init
    }
    if (action === "add-platform") doAddPlatforms = true;
    if (action === "add-developer") doAddDeveloper = true;
  }

  // --- Add platforms ---
  if (doAddPlatforms) {
    if (platformsToAdd.length === 0) {
      // Interactive: show only unconfigured platforms
      const unconfigured = TOOLS.filter((t) => {
        return !configuredPlatforms.has(t.platformId);
      });

      if (unconfigured.length === 0) {
        console.log(
          chalk.green("✓ All available platforms are already configured."),
        );
      } else {
        const answers = await inquirer.prompt<{ tools: string[] }>([
          {
            type: "checkbox",
            name: "tools",
            message: "Select platforms to add:",
            choices: unconfigured.map((t) => ({
              name: t.name,
              value: t.key,
            })),
          },
        ]);
        platformsToAdd = answers.tools;
      }
    }

    const requested = platformsToAdd
      .map((tool) => TOOLS.find((choice) => choice.key === tool)?.platformId)
      .filter(
        (platform): platform is PactilePlatform => platform !== undefined,
      );
    const toReconcile = requested.filter(
      (platform) => !configuredPlatforms.has(platform),
    );
    for (const platform of requested.filter((item) =>
      configuredPlatforms.has(item),
    )) {
      console.log(
        chalk.gray(
          `  ○ ${TOOLS.find((choice) => choice.platformId === platform)?.name ?? platform} already configured, skipping`,
        ),
      );
    }
    if (toReconcile.length > 0) {
      const composedPlatforms = [
        ...installedPactilePlatforms(installState?.state ?? null),
        ...toReconcile,
      ];
      const files = collectCanonicalGenerationFiles(
        cwd,
        discoverCanonicalGenerationPaths(cwd),
        composedPlatforms,
        VERSION,
      );
      const result = await runLifecycleCommand({
        projectRoot: cwd,
        operation: "reconcile",
        runtimeVersion: VERSION,
        files,
        platforms: composedPlatforms,
      });
      reportLifecycleResult(result, "Adapter reconcile");
    }
  }

  // --- Add developer ---
  if (doAddDeveloper) {
    let devName = developerName;
    if (!devName) {
      devName = await askInput("Your name: ");
      while (!devName) {
        console.log(chalk.yellow("Name is required"));
        devName = await askInput("Your name: ");
      }
    }

    // Capture pre-init state: if .developer did not exist before we ran
    // the Node identity writer, this checkout had no identity → treat as a new
    // joiner onboarding onto an existing Pactile project.
    const hadDeveloperFileBefore = fs.existsSync(
      path.join(cwd, DIR_NAMES.WORKFLOW, FILE_NAMES.DEVELOPER),
    );

    try {
      initializeDeveloper(cwd, devName);
      console.log(chalk.green(`✓ Developer "${devName}" initialized`));
    } catch (err) {
      console.log(chalk.yellow(`⚠ Could not initialize developer: ${err instanceof Error ? err.message : String(err)}`));
    }

    // Create joiner onboarding task for fresh checkouts (no prior .developer).
    // Runs outside the init_developer try/catch so failures surface as warnings.
    if (!hadDeveloperFileBefore) {
      try {
        if (!createJoinerOnboardingTask(cwd, devName)) {
          console.warn(
            chalk.yellow("⚠ Failed to create joiner onboarding task"),
          );
        }
      } catch (err) {
        console.warn(
          chalk.yellow(
            `⚠ Joiner onboarding setup failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }
  }

  return true;
}

interface InitOptions {
  codex?: boolean;
  importCstl?: boolean;
  yes?: boolean;
  user?: string;
  force?: boolean;
  skipExisting?: boolean;
  skipReadiness?: boolean;
  capability?: string[];
  withOptional?: string[];
  template?: string;
  overwrite?: boolean;
  append?: boolean;
  registry?: string;
  monorepo?: boolean;
  workflow?: string;
  workflowSource?: string;
}

function getPactileInitToolChoices(): {
  key: "codex";
  name: string;
  defaultChecked: boolean;
  platformId: PactilePlatform;
}[] {
  return getInitToolChoices();
}

/**
 * Write monorepo package configuration to config.yaml (non-destructive patch).
 * Appends packages: and default_package: without disturbing existing config.
 */
function writeMonorepoConfig(cwd: string, packages: DetectedPackage[]): void {
  const configPath = path.join(cwd, DIR_NAMES.WORKFLOW, "config.yaml");
  let content = "";

  try {
    content = fs.readFileSync(configPath, "utf-8");
  } catch {
    // Config not created yet; will be created by createWorkflowStructure
    return;
  }

  // Don't overwrite if packages: already exists (re-init case)
  if (/^packages\s*:/m.test(content)) {
    return;
  }

  const lines = ["\n# Auto-detected monorepo packages", "packages:"];
  for (const pkg of packages) {
    lines.push(`  ${sanitizePkgName(pkg.name)}:`);
    lines.push(`    path: ${pkg.path}`);
    if (pkg.isSubmodule) {
      lines.push("    type: submodule");
    } else if (pkg.isGitRepo) {
      lines.push("    git: true");
    }
  }

  // Use first non-submodule package as default, fallback to first package
  const defaultPkg =
    packages.find((p) => !p.isSubmodule)?.name ?? packages[0]?.name;
  if (defaultPkg) {
    lines.push(`default_package: ${defaultPkg}`);
  }

  fs.writeFileSync(
    configPath,
    content.trimEnd() + "\n" + lines.join("\n") + "\n",
    "utf-8",
  );
}

interface InitAnswers {
  tools: string[];
  template?: string;
  existingDirAction?: TemplateStrategy;
  capabilities?: ProjectCapabilityId[];
}

function reportLifecycleResult(result: LifecycleResult, action: string): void {
  if (result.status === "review" || result.status === "interrupted") {
    throw new Error(`${action} stopped: ${result.reason}`);
  }
  if (result.status === "degraded") {
    const failures = result.adapters
      .filter((adapter) => adapter.status !== "succeeded")
      .map(
        (adapter) =>
          `${adapter.adapterId}: ${adapter.reason ?? "pending"}${
            adapter.retryable ? " (retryable)" : ""
          }`,
      );
    console.warn(
      chalk.yellow(
        `${action} committed canonical state but is degraded: ${failures.join(", ")}`,
      ),
    );
    return;
  }
  console.log(chalk.green(`✓ ${action} completed`));
}

export async function init(options: InitOptions): Promise<void> {
  // Refuse to run in $HOME — running here would scoop platform runtime data
  // (Claude/Codex/OpenCode session histories etc.) into the Pactile hash
  // manifest, and a subsequent cleanup could damage it.
  if (isCwdHomedir() && !homedirBypassEnabled()) {
    console.error(chalk.red(homedirGuardMessage("init")));
    process.exit(1);
  }

  const cwd = process.cwd();
  const isFirstInit = !fs.existsSync(path.join(cwd, DIR_NAMES.WORKFLOW));
  const importingCstl = options.importCstl === true;
  const legacyContext = inspectLegacyInitContext({
    cwd,
    canonicalRootAbsent: isFirstInit,
    importRequested: importingCstl,
    developerFileName: FILE_NAMES.DEVELOPER,
  });
  if ((options.withOptional?.length ?? 0) > 0) {
    throw new Error(
      "--with-optional no longer writes host skill directories during init; select a declared Pactile capability instead",
    );
  }
  // Captured here (before createWorkflowStructure + init_developer run) so
  // the three-branch dispatch at the bottom can tell "fresh clone joiner"
  // (canonical root exists, .developer missing) apart from creator first init.
  const hadDeveloperFileAtStart =
    fs.existsSync(path.join(cwd, DIR_NAMES.WORKFLOW, FILE_NAMES.DEVELOPER)) ||
    legacyContext.importedDeveloperFilePresent;

  if (legacyContext.coexistenceNotice.length > 0) {
    console.log(chalk.cyan(legacyContext.coexistenceNotice[0]));
    for (const line of legacyContext.coexistenceNotice.slice(1)) {
      console.log(chalk.gray(line));
    }
  }

  // Generate ASCII art banner dynamically using FIGlet "Rebel" font
  const banner = figlet.textSync("Pactile", { font: "Rebel" });
  console.log(chalk.cyan(`\n${banner.trimEnd()}`));
  console.log(
    chalk.gray(
      "\n   Governed AI workflow for Codex\n",
    ),
  );

  // Set up proxy before any network calls
  const proxyUrl = setupProxy();
  if (proxyUrl) {
    console.log(chalk.gray(`   Using proxy: ${maskProxyUrl(proxyUrl)}\n`));
  }

  // Set write mode based on options
  let writeMode: WriteMode = "ask";
  if (options.force) {
    writeMode = "force";
    console.log(chalk.gray("Mode: Force overwrite existing files\n"));
  } else if (options.skipExisting) {
    writeMode = "skip";
    console.log(chalk.gray("Mode: Skip existing files\n"));
  } else if (options.yes) {
    // -y implies non-interactive: never prompt on conflicts. Default to skip
    // (preserve user files) — explicit --force is required to overwrite.
    writeMode = "skip";
    console.log(chalk.gray("Mode: Non-interactive (skip existing files)\n"));
  }
  setWriteMode(writeMode);

  // Detect developer name from git config or options
  let developerName = options.user;
  if (!developerName) {
    // Only detect from git if current directory is a git repo
    const isGitRepo = fs.existsSync(path.join(cwd, ".git"));
    if (isGitRepo) {
      try {
        developerName = execSync("git config user.name", {
          cwd,
          encoding: "utf-8",
        }).trim();
      } catch {
        // Git not available or no user.name configured
      }
    }
  }

  if (developerName) {
    console.log(chalk.blue("👤 Developer:"), chalk.gray(developerName));
  }

  // ==========================================================================
  // Re-init fast path: skip full flow when .pactile/ already exists.
  // ==========================================================================

  // Aborted-init recovery (issue #204): if .pactile/ exists but tasks/ is
  // empty, the previous init never reached bootstrap creation. Fall through
  // to the full flow so the main-dispatch tasksEmpty fallback fires —
  // handleReinit's joiner branch would otherwise mis-route the recovery.
  const tasksDirEarly = path.join(cwd, PATHS.TASKS);
  const tasksEmptyEarly =
    !fs.existsSync(tasksDirEarly) || fs.readdirSync(tasksDirEarly).length === 0;

  if (
    !isFirstInit &&
    !importingCstl &&
    !options.force &&
    !options.skipExisting &&
    !tasksEmptyEarly
  ) {
    const reinitDone = await handleReinit(
      cwd,
      options,
      developerName,
    );
    if (reinitDone) return;
    // reinitDone === false means user chose "full re-initialize" → fall through
  }

  if (!developerName && !options.yes) {
    // Ask for developer name if not detected and not in yes mode
    console.log(
      chalk.gray(
        "\nPactile supports team collaboration - each developer has their own\n" +
          `workspace directory (${PATHS.WORKSPACE}/{name}/) to track AI sessions.\n` +
          "Tip: Usually this is your git username (git config user.name).\n",
      ),
    );
    developerName = await askInput("Your name: ");
    while (!developerName) {
      console.log(chalk.yellow("Name is required"));
      developerName = await askInput("Your name: ");
    }
    console.log(chalk.blue("👤 Developer:"), chalk.gray(developerName));
  }

  // Detect project type (silent - no output)
  const detectedType = detectProjectType(cwd);

  // Parse custom registry source early (needed by both monorepo + single-repo flows)
  let registry: RegistrySource | undefined;
  if (options.registry) {
    try {
      registry = parseRegistrySource(options.registry);
    } catch (error) {
      console.log(
        chalk.red(
          error instanceof Error ? error.message : "Invalid registry source",
        ),
      );
      return;
    }
  }

  // Determine template strategy from flags (needed before monorepo template downloads)
  let templateStrategy: TemplateStrategy = "skip";
  if (options.overwrite) {
    templateStrategy = "overwrite";
  } else if (options.append) {
    templateStrategy = "append";
  }

  // ==========================================================================
  // Monorepo Detection
  // ==========================================================================

  let monorepoPackages: DetectedPackage[] | undefined;
  let remoteSpecPackages: Set<string> | undefined;

  if (options.monorepo !== false) {
    // options.monorepo: true = --monorepo, false = --no-monorepo, undefined = auto
    const detected = detectMonorepo(cwd);

    if (options.monorepo === true && !detected) {
      console.log(
        chalk.red(
          "Error: --monorepo specified but no multi-package layout detected.",
        ),
      );
      console.log("");
      console.log(chalk.gray("Checked:"));
      console.log(chalk.gray("  ✗ pnpm-workspace.yaml"));
      console.log(chalk.gray("  ✗ package.json workspaces"));
      console.log(chalk.gray("  ✗ Cargo.toml [workspace]"));
      console.log(chalk.gray("  ✗ go.work"));
      console.log(chalk.gray("  ✗ pyproject.toml [tool.uv.workspace]"));
      console.log(chalk.gray("  ✗ .gitmodules"));
      console.log(chalk.gray("  ✗ sibling .git directories (need ≥ 2)"));
      console.log("");
      console.log("To configure manually, add to .pactile/config.yaml:");
      console.log("");
      console.log(chalk.cyan("  packages:"));
      console.log(chalk.cyan("    frontend:"));
      console.log(chalk.cyan("      path: ./frontend"));
      console.log(chalk.cyan("      git: true       # if it has its own .git"));
      console.log(chalk.cyan("    backend:"));
      console.log(chalk.cyan("      path: ./backend"));
      console.log(chalk.cyan("      git: true"));
      return;
    }

    if (detected && detected.length > 0) {
      let enableMonorepo = false;

      if (options.monorepo === true || options.yes) {
        enableMonorepo = true;
      } else {
        // Show detected packages and ask
        console.log(chalk.blue("\n🔍 Detected monorepo packages:"));
        for (const pkg of detected) {
          const tag = pkg.isSubmodule
            ? chalk.gray(" (submodule)")
            : pkg.isGitRepo
              ? chalk.gray(" (git repo)")
              : "";
          console.log(
            chalk.gray(`   - ${pkg.name}`) +
              chalk.gray(` (${pkg.path})`) +
              chalk.gray(` [${pkg.type}]`) +
              tag,
          );
        }
        console.log("");

        const { useMonorepo } = await inquirer.prompt<{
          useMonorepo: boolean;
        }>([
          {
            type: "confirm",
            name: "useMonorepo",
            message: "Enable monorepo mode?",
            default: true,
          },
        ]);
        enableMonorepo = useMonorepo;
      }

      if (enableMonorepo) {
        monorepoPackages = detected;
        remoteSpecPackages = new Set<string>();

        // Per-package template selection (unless -y mode: all use blank spec)
        if (!options.yes && !options.template) {
          for (const pkg of detected) {
            const { specSource } = await inquirer.prompt<{
              specSource: string;
            }>([
              {
                type: "list",
                name: "specSource",
                message: `Spec source for ${pkg.name} (${pkg.path}):`,
                choices: [
                  { name: "From scratch (Pactile default)", value: "blank" },
                  { name: "Download remote template", value: "remote" },
                ],
                default: "blank",
              },
            ]);

            if (specSource === "remote") {
              // Use existing template download flow, targeting spec/<name>/
              const destDir = path.join(
                cwd,
                PATHS.SPEC,
                sanitizePkgName(pkg.name),
              );
              console.log(chalk.blue(`📦 Select template for ${pkg.name}...`));
              // Fetch templates if not already done
              const templates = await fetchTemplateIndex();
              const specTemplates = templates
                .filter((t) => t.type === "spec")
                .map((t) => ({
                  name: `${t.id} (${t.name})`,
                  value: t.id,
                }));

              if (specTemplates.length > 0) {
                const { templateId } = await inquirer.prompt<{
                  templateId: string;
                }>([
                  {
                    type: "list",
                    name: "templateId",
                    message: `Select template for ${pkg.name}:`,
                    choices: specTemplates,
                  },
                ]);

                const result = await downloadTemplateById(
                  cwd,
                  templateId,
                  templateStrategy,
                  templates.find((t) => t.id === templateId),
                  undefined,
                  destDir,
                );

                if (result.success) {
                  console.log(chalk.green(`   ${result.message}`));
                  remoteSpecPackages.add(sanitizePkgName(pkg.name));
                } else {
                  console.log(chalk.yellow(`   ${result.message}`));
                  console.log(chalk.gray("   Falling back to blank spec..."));
                }
              } else {
                console.log(
                  chalk.gray("   No templates available. Using blank spec."),
                );
              }
            }
          }
        } else if (options.template) {
          // --template as default for all packages
          for (const pkg of detected) {
            const destDir = path.join(
              cwd,
              PATHS.SPEC,
              sanitizePkgName(pkg.name),
            );
            const result = await downloadTemplateById(
              cwd,
              options.template,
              templateStrategy,
              undefined,
              registry,
              destDir,
            );
            if (result.success && !result.skipped) {
              remoteSpecPackages.add(sanitizePkgName(pkg.name));
            }
          }
        }
      }
    }
  }

  // Tool definitions derived from the canonical host registry.
  const TOOLS = getPactileInitToolChoices();

  // Build tools from explicit flags
  const explicitTools = TOOLS.filter(
    (t) => options[t.key as keyof InitOptions],
  ).map((t) => t.key);

  let tools: string[];

  if (explicitTools.length > 0) {
    // Explicit flags take precedence (works with or without -y)
    tools = explicitTools;
  } else if (options.yes) {
    // No explicit tools + -y: use the active host default.
    tools = TOOLS.filter((t) => t.defaultChecked).map((t) => t.key);
  } else {
    // Interactive mode
    const answers = await inquirer.prompt<InitAnswers>([
      {
        type: "checkbox",
        name: "tools",
        message: "Select AI tools to configure:",
        choices: TOOLS.map((t) => ({
          name: t.name,
          value: t.key,
          checked: t.defaultChecked,
        })),
      },
    ]);
    tools = answers.tools;
  }

  // Treat unknown project type as fullstack
  const projectType: ProjectType =
    detectedType === "unknown" ? "fullstack" : detectedType;

  if (tools.length === 0) {
    console.log(
      chalk.yellow("No tools selected. At least one tool is required."),
    );
    return;
  }

  const explicitCapabilities = parseProjectCapabilities(options.capability);
  let selectedCapabilities: ProjectCapabilityId[] = explicitCapabilities;

  if (!options.yes && !options.capability?.length) {
    const capabilityAnswers = await inquirer.prompt<InitAnswers>([
      {
        type: "checkbox",
        name: "capabilities",
        message: "Select optional project capabilities:",
        choices: getProjectCapabilityChoices().map((choice) => ({
          name: choice.name,
          value: choice.id,
          checked: false,
        })),
      },
    ]);
    selectedCapabilities = capabilityAnswers.capabilities ?? [];
  }

  reportInitReadiness(
    snapshotReadinessForRollout({
      cwd,
      selected: selectedCapabilities,
      skipReadiness: options.skipReadiness,
    }),
  );

  // ==========================================================================
  // Template Selection (single-repo only; monorepo handles templates above)
  // ==========================================================================

  let selectedTemplate: string | null = null;

  // Pre-fetched templates list (used to pass selected SpecTemplate to downloadTemplateById)
  let fetchedTemplates: SpecTemplate[] = [];
  let registryBackend: RegistryBackend | undefined;

  // Determine the index URL based on registry
  const indexUrl = registry
    ? `${registry.rawBaseUrl}/index.json`
    : TEMPLATE_INDEX_URL;

  if (monorepoPackages) {
    // Monorepo: template selection already handled above
  } else if (options.template) {
    // Template specified via --template flag
    selectedTemplate = options.template;
  } else if (!options.yes) {
    // Interactive mode: show template selection
    const timeoutSec = TIMEOUTS.INDEX_FETCH_MS / 1000;
    const sourceLabel = registry ? registry.gigetSource : TEMPLATE_INDEX_URL;
    console.log(
      chalk.gray(`   Fetching available templates from ${sourceLabel}`),
    );
    let elapsed = 0;
    const ticker = setInterval(() => {
      elapsed++;
      process.stdout.write(
        `\r${chalk.gray(`   Loading... ${elapsed}s/${timeoutSec}s`)}`,
      );
    }, 1000);
    process.stdout.write(chalk.gray(`   Loading... 0s/${timeoutSec}s`));
    let templates: SpecTemplate[];
    let registryProbeNotFound = false;
    let registryProbeError: Error | undefined;
    if (registry) {
      const probeResult = await probeRegistryIndex(indexUrl, registry);
      templates = probeResult.templates;
      registryProbeNotFound = probeResult.isNotFound;
      registryProbeError = probeResult.error;
      registryBackend = probeResult.backend;
    } else {
      templates = await fetchTemplateIndex(indexUrl);
    }
    clearInterval(ticker);
    // Clear the loading line
    process.stdout.write("\r\x1b[2K");
    fetchedTemplates = templates;

    if (templates.length === 0 && registry && registryProbeNotFound) {
      // Custom registry: confirmed no index.json — will try direct download later
      console.log(
        chalk.gray(
          "   No index.json found at registry. Will download as direct spec template.",
        ),
      );
    } else if (templates.length === 0 && registry) {
      // Custom registry: transient error (not a 404) — abort, don't misclassify
      console.log(
        chalk.red(
          `   ${registryProbeError?.message ?? "Could not reach registry. Check your connection and try again."}`,
        ),
      );
      return;
    } else if (templates.length === 0) {
      console.log(
        chalk.gray(
          "   Could not fetch templates (offline or server unavailable).",
        ),
      );
      console.log(chalk.gray("   Using blank templates.\n"));
    }

    if (templates.length > 0) {
      // Build template choices
      const specTemplates = templates
        .filter((t) => t.type === "spec")
        .map((t) => ({
          name: `${t.id} (${t.name})`,
          value: t.id,
        }));

      const templateChoices = registry
        ? specTemplates
        : [
            {
              name: "from scratch (default)",
              value: "blank",
            },
            ...specTemplates,
            {
              name: "custom (enter a registry source)",
              value: "__custom__",
            },
          ];

      // Loop to allow returning from custom source input back to the picker
      let templatePicked = false;
      while (templateChoices.length > 0 && !templatePicked) {
        const templateAnswer = await inquirer.prompt<{ template: string }>([
          {
            type: "list",
            name: "template",
            message: "Select a spec template:",
            choices: templateChoices,
            default: registry ? undefined : "blank",
          },
        ]);

        if (templateAnswer.template === "__custom__") {
          // Prompt for custom registry source (empty → back to picker)
          const customSource = await askInput(
            "Enter registry source (e.g., gh:myorg/myrepo/specs), or press Enter to go back: ",
          );
          if (!customSource) {
            continue; // Back to picker
          }
          try {
            registry = parseRegistrySource(customSource);
            fetchedTemplates = []; // Reset so direct-download guard works correctly
            // Probe index.json to detect marketplace vs direct download
            const customIndexUrl = `${registry.rawBaseUrl}/index.json`;
            console.log(
              chalk.gray(
                `   Checking for templates at ${registry.gigetSource}...`,
              ),
            );
            const customProbe = await probeRegistryIndex(
              customIndexUrl,
              registry,
            );
            const customTemplates = customProbe.templates;
            registryBackend = customProbe.backend;
            if (customTemplates.length > 0) {
              // Marketplace mode: show picker with custom templates
              fetchedTemplates = customTemplates;
              const customChoices = customTemplates
                .filter((t) => t.type === "spec")
                .map((t) => ({
                  name: `${t.id} (${t.name})`,
                  value: t.id,
                }));
              if (customChoices.length > 0) {
                const customAnswer = await inquirer.prompt<{
                  template: string;
                }>([
                  {
                    type: "list",
                    name: "template",
                    message: "Select a spec template:",
                    choices: customChoices,
                  },
                ]);
                selectedTemplate = customAnswer.template;

                // Check if spec directory already exists and ask what to do
                const specDir = path.join(cwd, PATHS.SPEC);
                if (
                  fs.existsSync(specDir) &&
                  !options.overwrite &&
                  !options.append
                ) {
                  const actionAnswer = await inquirer.prompt<{
                    action: TemplateStrategy;
                  }>([
                    {
                      type: "list",
                      name: "action",
                      message: `Directory ${PATHS.SPEC} already exists. What do you want to do?`,
                      choices: [
                        { name: "Skip (keep existing)", value: "skip" },
                        {
                          name: "Overwrite (replace all)",
                          value: "overwrite",
                        },
                        {
                          name: "Append (add missing files only)",
                          value: "append",
                        },
                      ],
                      default: "skip",
                    },
                  ]);
                  templateStrategy = actionAnswer.action;
                }
              }
              templatePicked = true;
            } else if (customProbe.isNotFound) {
              // No index.json → direct download mode
              templatePicked = true;
            } else {
              // Transient error (not 404) — loop back, don't misclassify
              console.log(
                chalk.yellow(
                  `   ${customProbe.error?.message ?? "Could not reach registry. Try again or enter a different source."}`,
                ),
              );
              registry = undefined; // Reset so we don't fall through to direct download
            }
          } catch (error) {
            console.log(
              chalk.red(
                error instanceof Error
                  ? error.message
                  : "Invalid registry source",
              ),
            );
            // Loop back to picker
          }
        } else {
          templatePicked = true;
          if (templateAnswer.template !== "blank") {
            selectedTemplate = templateAnswer.template;

            // Check if spec directory already exists and ask what to do
            const specDir = path.join(cwd, PATHS.SPEC);
            if (
              fs.existsSync(specDir) &&
              !options.overwrite &&
              !options.append
            ) {
              const actionAnswer = await inquirer.prompt<{
                action: TemplateStrategy;
              }>([
                {
                  type: "list",
                  name: "action",
                  message: `Directory ${PATHS.SPEC} already exists. What do you want to do?`,
                  choices: [
                    { name: "Skip (keep existing)", value: "skip" },
                    { name: "Overwrite (replace all)", value: "overwrite" },
                    {
                      name: "Append (add missing files only)",
                      value: "append",
                    },
                  ],
                  default: "skip",
                },
              ]);
              templateStrategy = actionAnswer.action;
            }
          }
        }
      }
    }
  }
  // -y mode with --registry (no --template): probe index.json to detect mode
  // Skip when monorepo mode already handled templates above
  if (options.yes && registry && !selectedTemplate && !monorepoPackages) {
    const probeResult = await probeRegistryIndex(
      `${registry.rawBaseUrl}/index.json`,
      registry,
    );
    registryBackend = probeResult.backend;
    if (probeResult.templates.length > 0) {
      // Marketplace mode requires interactive selection — can't auto-select
      console.log(
        chalk.red(
          "Error: Registry is a marketplace with multiple templates. " +
            "Use --template <id> to specify which one, or remove -y for interactive selection.",
        ),
      );
      return;
    }
    if (!probeResult.isNotFound) {
      // Transient error (not 404) — abort, don't misclassify as direct-download
      console.log(
        chalk.red(
          `Error: ${probeResult.error?.message ?? "Could not reach registry. Check your connection and try again."}`,
        ),
      );
      return;
    }
    // isNotFound=true → no index.json, proceed with direct download (fetchedTemplates stays empty)
  }

  // ==========================================================================
  // Download Remote Template (if selected or direct registry download)
  // ==========================================================================

  let useRemoteTemplate = false;

  if (selectedTemplate) {
    // Marketplace mode: download specific template by ID
    console.log(chalk.blue(`📦 Downloading template "${selectedTemplate}"...`));
    console.log(chalk.gray("   This may take a moment on slow connections."));

    // Find pre-fetched SpecTemplate to avoid double-fetch
    const prefetched = fetchedTemplates.find((t) => t.id === selectedTemplate);

    const result = await downloadTemplateById(
      cwd,
      selectedTemplate,
      templateStrategy,
      prefetched,
      registry,
      undefined,
      registryBackend,
    );

    if (result.success) {
      if (result.skipped) {
        console.log(chalk.gray(`   ${result.message}`));
      } else {
        console.log(chalk.green(`   ${result.message}`));
        useRemoteTemplate = true;
      }
    } else {
      console.log(chalk.yellow(`   ${result.message}`));
      console.log(chalk.gray("   Falling back to blank templates..."));
      const retryCmd = registry
        ? `pactile init --registry ${registry.gigetSource} --template ${selectedTemplate}`
        : `pactile init --template ${selectedTemplate}`;
      console.log(chalk.gray(`   You can retry later: ${retryCmd}`));
    }
  } else if (registry && fetchedTemplates.length === 0) {
    // Direct download mode: registry has no index.json, download directory directly
    console.log(
      chalk.blue(`📦 Downloading spec from ${registry.gigetSource}...`),
    );
    console.log(chalk.gray("   This may take a moment on slow connections."));

    // Ask about existing spec dir in interactive mode
    if (!options.yes && !options.overwrite && !options.append) {
      const specDir = path.join(cwd, PATHS.SPEC);
      if (fs.existsSync(specDir)) {
        const actionAnswer = await inquirer.prompt<{
          action: TemplateStrategy;
        }>([
          {
            type: "list",
            name: "action",
            message: `Directory ${PATHS.SPEC} already exists. What do you want to do?`,
            choices: [
              { name: "Skip (keep existing)", value: "skip" },
              { name: "Overwrite (replace all)", value: "overwrite" },
              { name: "Append (add missing files only)", value: "append" },
            ],
            default: "skip",
          },
        ]);
        templateStrategy = actionAnswer.action;
      }
    }

    const result = await downloadRegistryDirect(
      cwd,
      registry,
      templateStrategy,
      undefined,
      registryBackend,
    );

    if (result.success) {
      if (result.skipped) {
        console.log(chalk.gray(`   ${result.message}`));
      } else {
        console.log(chalk.green(`   ${result.message}`));
        useRemoteTemplate = true;
      }
    } else {
      console.log(chalk.yellow(`   ${result.message}`));
      console.log(chalk.gray("   Falling back to blank templates..."));
      console.log(
        chalk.gray(
          `   You can retry later: pactile init --registry ${registry.gigetSource}`,
        ),
      );
    }
  }

  // ==========================================================================
  // Resolve workflow template (default: native bundled)
  // ==========================================================================

  const workflowIdInput = options.workflow?.trim();
  const workflowId =
    workflowIdInput && workflowIdInput.length > 0
      ? workflowIdInput
      : NATIVE_WORKFLOW_ID;
  let workflowMdOverride: string | undefined;
  if (workflowId !== NATIVE_WORKFLOW_ID || options.workflowSource) {
    const resolved = await resolveWorkflowTemplate(workflowId, {
      source: options.workflowSource,
    });
    if (resolved.id !== NATIVE_WORKFLOW_ID) {
      workflowMdOverride = resolved.content;
      console.log(
        chalk.blue(`🧭 Using workflow template: ${chalk.cyan(resolved.id)}`),
      );
    }
  }

  // ==========================================================================
  // Create Workflow Structure
  // ==========================================================================

  // Build the complete canonical candidate away from the live project. The
  // lifecycle seals and commits these bytes before the callback publishes the
  // live `.pactile` view; failed planning/staging/validation leaves live
  // canonical files untouched and the legacy source remains read-only.
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-init-"));
  try {
    let importedFileCount = 0;
    if (importingCstl) {
      importedFileCount = prepareLegacyCstlImport(cwd, buildRoot).length;
    } else if (!isFirstInit) {
      seedCanonicalBuildRoot(cwd, buildRoot);
    }

    // Record every successful canonical/root write from this section. The
    // captured set is the source of truth for `.template-hashes.json`'s
    // platform/root entries — replacing the previous "walk every managed dir"
    // approach that swept user-owned runtime files into the manifest.
    const writtenPaths = startRecordingWrites(buildRoot);
    try {
      console.log(chalk.blue("📁 Creating workflow structure..."));
      await createWorkflowStructure(buildRoot, {
        projectType,
        skipSpecTemplates: useRemoteTemplate,
        packages: monorepoPackages,
        remoteSpecPackages,
        workflowMdOverride,
      });

      if (monorepoPackages) {
        writeMonorepoConfig(buildRoot, monorepoPackages);
        console.log(chalk.blue("📦 Monorepo packages written to config.yaml"));
      }

      fs.writeFileSync(
        path.join(buildRoot, DIR_NAMES.WORKFLOW, ".version"),
        VERSION,
      );
      await writeProjectCapabilityFiles(buildRoot, selectedCapabilities, []);
    } finally {
      stopRecordingWrites();
    }

    const hashedCount = initializeHashes(buildRoot, {
      trackedPaths: writtenPaths,
      merge: !isFirstInit,
    });
    if (hashedCount > 0) {
      console.log(
        chalk.gray(`📋 Tracking ${hashedCount} template files for updates`),
      );
    }

    if (workflowMdOverride !== undefined && workflowId !== NATIVE_WORKFLOW_ID) {
      removeHash(buildRoot, PATHS.WORKFLOW_GUIDE_FILE);
    }

    const selectedPlatformIds = tools
      .map((tool) => TOOLS.find((choice) => choice.key === tool)?.platformId)
      .filter(
        (platform): platform is PactilePlatform => platform !== undefined,
      );
    const candidateFiles = collectCanonicalGenerationFiles(
      buildRoot,
      discoverCanonicalGenerationPaths(buildRoot),
      selectedPlatformIds,
      VERSION,
    );
    const legacyLifecycleFiles = importingCstl
      ? collectLegacyCstlLifecycleFiles(cwd, buildRoot, candidateFiles)
      : null;
    const canonicalLifecycleOperation = new InstallStateStore(cwd).read()
      ? "update"
      : "init";
    const lifecycleResult = await runLifecycleCommand({
      projectRoot: cwd,
      operation: importingCstl ? "import" : canonicalLifecycleOperation,
      runtimeVersion: VERSION,
      files: importingCstl ? (legacyLifecycleFiles ?? []) : candidateFiles,
      platforms: selectedPlatformIds,
      materializeCanonical: (context) =>
        materializeCanonicalGeneration(cwd, context),
      ...(importingCstl
        ? {
            legacy: {
              runtimeVersion: readLegacyCstlVersion(cwd),
              schemaVersion: null,
              files: legacyLifecycleFiles ?? [],
            },
          }
        : {}),
    });
    reportLifecycleResult(
      lifecycleResult,
      importingCstl
        ? "Legacy import and Adapter reconcile"
        : canonicalLifecycleOperation === "update"
          ? "Pactile re-initialize"
          : "Pactile init",
    );
    if (importingCstl || isFirstInit) {
      // User-owned namespaces are intentionally excluded from the immutable
      // generation. Publish the freshly prepared workspace/spec skeleton (and
      // any imported state) only after canonical activation succeeds.
      materializePreparedLegacyUserState(buildRoot, cwd);
      if (isFirstInit && !importingCstl) {
        // A fresh init may have no developer name yet, so its empty tasks/
        // directory has no file for the state publisher to copy.
        for (const relativePath of [PATHS.WORKSPACE, PATHS.TASKS, PATHS.SPEC]) {
          fs.mkdirSync(path.join(cwd, relativePath), { recursive: true });
        }
      }
    }
    if (importingCstl) {
      console.log(chalk.cyan(legacyImportPreparedMessage(importedFileCount)));
    }
  } finally {
    fs.rmSync(buildRoot, { recursive: true, force: true });
  }
  if (isFirstInit && !importingCstl) {
    // A fresh canonical install cannot contain the retired task shape. Mark
    // that fact once so the first `pactile update` does not manufacture a
    // migration backup or prompt for a legacy transition that never existed.
    writeWaveCConfirmed(cwd);
  }

  // Initialize developer identity with Node (silent - no output).
  if (developerName) {
    try {
      if (!readDeveloper(cwd)) initializeDeveloper(cwd, developerName);
    } catch {
      // Preserve init's best-effort identity creation boundary.
    }

    // Three-branch dispatch using flags captured at init() start (before
    // createWorkflowStructure/init_developer ran, so they reflect the disk
    // state of the user's checkout, not the state this init just produced):
    //   isFirstInit=true                       → creator bootstrap (new project)
    //   isFirstInit=false + no .developer file → joiner onboarding (fresh clone)
    //   isFirstInit=false + .developer exists  → same-dev re-init, no task
    //
    // Tasks-empty fallback (issue #204): if .pactile/ exists but tasks dir is
    // empty, the previous init aborted before creating the bootstrap task. Run
    // bootstrap creation regardless of isFirstInit. writeTaskSkeleton is
    // idempotent so repeated triggers are safe.
    //
    // Runs OUTSIDE the init_developer try/catch (which uses stdio: "pipe")
    // so joiner failures surface as warnings instead of being silently
    // swallowed.
    const tasksDir = path.join(cwd, PATHS.TASKS);
    const tasksEmpty =
      !fs.existsSync(tasksDir) || fs.readdirSync(tasksDir).length === 0;

    if ((isFirstInit && !importingCstl) || tasksEmpty) {
      const bootstrapCreated = createBootstrapTask(
        cwd,
        developerName,
        projectType,
        selectedCapabilities,
        monorepoPackages,
      );
      if (bootstrapCreated) {
        console.log(
          chalk.gray(
            `Next: complete ${BOOTSTRAP_TASK_NAME} to verify selected capabilities and fill the project spec.`,
          ),
        );
      }
    } else if (!hadDeveloperFileAtStart) {
      try {
        if (!createJoinerOnboardingTask(cwd, developerName)) {
          console.warn(
            chalk.yellow("⚠ Failed to create joiner onboarding task"),
          );
        }
      } catch (err) {
        console.warn(
          chalk.yellow(
            `⚠ Joiner onboarding setup failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }
  }
}

/**
 * Simple readline-based input (no flickering like inquirer)
 */
function askInput(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
