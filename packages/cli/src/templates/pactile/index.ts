/**
 * Pactile workflow templates
 *
 * These are GENERIC templates for user projects.
 * Do NOT use Pactile project's own .pactile/ directory (which may be customized).
 *
 * Directory structure:
 *   pactile/
 *   ├── scripts/
 *   │   ├── __init__.py
 *   │   ├── common/           # Shared utilities (Python)
 *   │   └── *.py              # Main scripts (Python)
 *   ├── scripts-shell-archive/ # Archived shell scripts (for reference)
 *   ├── workflow.md           # Workflow guide
 *   ├── config.yaml            # Pactile configuration
 *   └── gitignore.txt         # .gitignore content
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readTemplate(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), "utf-8");
}

// Python scripts - package init
export const scriptsInit = readTemplate("scripts/__init__.py");

// Python scripts - common
export const commonInit = readTemplate("scripts/common/__init__.py");
export const commonPaths = readTemplate("scripts/common/paths.py");
export const commonDeveloper = readTemplate("scripts/common/developer.py");
export const commonGitContext = readTemplate("scripts/common/git_context.py");
export const commonTaskQueue = readTemplate("scripts/common/task_queue.py");
export const commonTaskUtils = readTemplate("scripts/common/task_utils.py");
export const commonActiveTask = readTemplate("scripts/common/active_task.py");
export const commonCliEnvironment = readTemplate(
  "scripts/common/cli_environment.py",
);
export const commonConfig = readTemplate("scripts/common/config.py");
export const commonArtifactLocale = readTemplate("scripts/common/artifact_locale.py");
export const commonIo = readTemplate("scripts/common/io.py");
export const commonLog = readTemplate("scripts/common/log.py");
export const commonGit = readTemplate("scripts/common/git.py");
export const commonTypes = readTemplate("scripts/common/types.py");
export const commonTasks = readTemplate("scripts/common/tasks.py");
export const commonTaskContext = readTemplate("scripts/common/task_context.py");
export const commonTaskStore = readTemplate("scripts/common/task_store.py");
export const commonTaskDashboard = readTemplate(
  "scripts/common/task_dashboard.py",
);
export const commonTaskGates = readTemplate("scripts/common/task_gates.py");
export const commonTaskDependencies = readTemplate(
  "scripts/common/task_dependencies.py",
);
export const commonExecutionStrategy = readTemplate(
  "scripts/common/execution_strategy.py",
);
export const executionStrategyRulesJson = readTemplate(
  "config/execution-strategy-rules.json",
);
export const commonTaskMap = readTemplate("scripts/common/task_map.py");
export const commonParentOrchestration = readTemplate(
  "scripts/common/parent_orchestration.py",
);
export const commonSubagentDispatch = readTemplate(
  "scripts/common/subagent_dispatch.py",
);
export const commonInjectionBudget = readTemplate(
  "scripts/common/injection_budget.py",
);
export const commonKernelCommand = readTemplate(
  "scripts/common/kernel_command.py",
);
export const commonLiteContext = readTemplate("scripts/common/lite_context.py");
export const commonSessionPack = readTemplate("scripts/common/session_pack.py");
export const commonFullQuality = readTemplate("scripts/common/full_quality.py");
export const commonOndemandTopology = readTemplate(
  "scripts/common/ondemand_topology.py",
);
export const commonParallelDeclaration = readTemplate(
  "scripts/common/parallel_declaration.py",
);
export const commonAdapterMiddleware = readTemplate(
  "scripts/common/adapter_middleware.py",
);
export const commonArtifactSearch = readTemplate(
  "scripts/common/artifact_search.py",
);
export const commonSessionMemory = readTemplate(
  "scripts/common/session_memory.py",
);
export const commonSmartSearchEvidence = readTemplate(
  "scripts/common/smart_search_evidence.py",
);
export const commonSmartSearchResolve = readTemplate(
  "scripts/common/smart_search_resolve.py",
);
export const commonRetrievalEvidence = readTemplate(
  "scripts/common/retrieval_evidence.py",
);
export const commonCodebaseRetrievalRouter = readTemplate(
  "scripts/common/codebase_retrieval_router.py",
);
export const commonProjectFileStats = readTemplate(
  "scripts/common/project_file_stats.py",
);
export const commonRetrievalToolClassification = readTemplate(
  "scripts/common/retrieval_tool_classification.py",
);
export const commonRetrievalAgentInstructions = readTemplate(
  "scripts/common/retrieval_agent_instructions.py",
);
export const commonRetrievalPlanGate = readTemplate(
  "scripts/common/retrieval_plan_gate.py",
);
export const commonSemanticPlanGate = readTemplate(
  "scripts/common/semantic_plan_gate.py",
);
export const commonRetrievalResultRanking = readTemplate(
  "scripts/common/retrieval_result_ranking.py",
);
export const rankRetrievalCandidatesScript = readTemplate(
  "scripts/rank_retrieval_candidates.py",
);
export const scoreEvidenceScript = readTemplate("scripts/score_evidence.py");
export const injectionBudgetProbeScript = readTemplate(
  "scripts/injection_budget_probe.py",
);
export const specHealthOutcomesScript = readTemplate(
  "scripts/spec_health_outcomes.py",
);
export const commonRetrievalAdapterMetadata = readTemplate(
  "scripts/common/retrieval_adapter_metadata.py",
);
export const commonContextPack = readTemplate("scripts/common/context_pack.py");
export const commonRetrievalPack = readTemplate("scripts/common/retrieval_pack.py");
export const commonRetrievalPackContext = readTemplate(
  "scripts/common/retrieval_pack_context.py",
);
export const commonSessionContext = readTemplate(
  "scripts/common/session_context.py",
);
export const commonPackagesContext = readTemplate(
  "scripts/common/packages_context.py",
);
export const commonWorkflowPhase = readTemplate(
  "scripts/common/workflow_phase.py",
);
export const commonPactileConfig = readTemplate(
  "scripts/common/pactile_config.py",
);
export const commonSafeCommit = readTemplate("scripts/common/safe_commit.py");

// Python scripts - main
export const getDeveloperScript = readTemplate("scripts/get_developer.py");
export const initDeveloperScript = readTemplate("scripts/init_developer.py");
export const taskScript = readTemplate("scripts/task.py");
export const verifyEvidenceProbeScript = readTemplate(
  "scripts/verify_evidence_probe.py",
);
export const getContextScript = readTemplate("scripts/get_context.py");
export const compileSessionPackScript = readTemplate(
  "scripts/compile_session_pack.py",
);
export const addSessionScript = readTemplate("scripts/add_session.py");
export const searchArtifactsScript = readTemplate("scripts/search_artifacts.py");
export const searchMemoryScript = readTemplate("scripts/search_memory.py");
export const runSmartSearchScript = readTemplate("scripts/run_smart_search.py");
export const buildContextPackScript = readTemplate("scripts/build_context_pack.py");
export const buildRetrievalPackScript = readTemplate("scripts/build_retrieval_pack.py");
export const routeCodebaseRetrievalScript = readTemplate(
  "scripts/route_codebase_retrieval.py",
);
export const codegraphSessionSmokeScript = readTemplate(
  "scripts/codegraph_session_smoke.py",
);
// Configuration files
export const workflowMdTemplate = readTemplate("workflow.md");
export const configYamlTemplate = readTemplate("config.yaml");
export const gitignoreTemplate = readTemplate("gitignore.txt");

// Project domain glossary stub + ADR rules (lazy-created docs/adr/)
export const contextMdTemplate = readTemplate("CONTEXT.md");
export const adrReadmeTemplate = readTemplate("docs/adr/README.md");

const RELEASE_READINESS_TASK_TEMPLATE_FILES = [
  "prd.md",
  "design.md",
  "implement.md",
  "handoff-template.md",
] as const;

const RELEASE_EXECUTION_TASK_TEMPLATE_FILES = [
  "prd.md",
  "design.md",
  "implement.md",
  "handoff-template.md",
] as const;

function readTaskTemplate(relativePath: string): string {
  return readTemplate(join("tasks", "templates", relativePath));
}

/**
 * Optional task artifact templates (under `.pactile/tasks/templates/`).
 * Not applied by `task.py create`; copy into a new task directory when starting
 * release-readiness or release-execution work.
 */
export function getAllTaskTemplates(): Map<string, string> {
  const templates = new Map<string, string>();
  for (const file of RELEASE_READINESS_TASK_TEMPLATE_FILES) {
    templates.set(
      `tasks/templates/release-readiness/${file}`,
      readTaskTemplate(`release-readiness/${file}`),
    );
  }
  for (const file of RELEASE_EXECUTION_TASK_TEMPLATE_FILES) {
    templates.set(
      `tasks/templates/release-execution/${file}`,
      readTaskTemplate(`release-execution/${file}`),
    );
  }
  for (const locale of ["zh", "en"] as const) {
    templates.set(
      `tasks/locale/${locale}/default-prd.md`,
      readTemplate(`tasks/locale/${locale}/default-prd.md`),
    );
  }
  return templates;
}

/**
 * Python scripts kept in the template tree for Pactile maintainers only.
 * Present under `templates/pactile/scripts/` but not shipped via init/update.
 */
export const MAINTAINER_ONLY_SCRIPT_PATHS = new Set([
  "common/test_retrieval_arbitration.py",
  "common/test_observable_defaults.py",
  "common/test_task_dependencies.py",
  "common/test_depends_mode_block.py",
  "common/test_kernel_command.py",
  "common/test_task_store_kernel_patch.py",
  "common/test_lite_path.py",
  "common/test_full_quality.py",
  "common/test_ondemand_topology.py",
  "common/test_parallel_declaration.py",
  "common/test_adapter_middleware.py",
  "common/test_task_dashboard.py",
  "hooks/linear_sync.py",
  "common/session_memory.py",
  "common/smart_search_evidence.py",
  "common/smart_search_resolve.py",
  "common/retrieval_evidence.py",
  "common/codebase_retrieval_router.py",
  "common/project_file_stats.py",
  "common/retrieval_tool_classification.py",
  "common/retrieval_agent_instructions.py",
  "common/retrieval_plan_gate.py",
  "common/semantic_plan_gate.py",
  "common/retrieval_result_ranking.py",
  "common/retrieval_adapter_metadata.py",
  "common/context_pack.py",
  "common/retrieval_pack.py",
  "common/retrieval_pack_context.py",
  "search_artifacts.py",
  "search_memory.py",
  "run_smart_search.py",
  "build_context_pack.py",
  "build_retrieval_pack.py",
  "route_codebase_retrieval.py",
  "codegraph_session_smoke.py",
  "rank_retrieval_candidates.py",
  "score_evidence.py",
  "injection_budget_probe.py",
  "spec_health_outcomes.py",
  "verify_evidence_probe.py",
]);

/**
 * Get all user-shipped script templates as a map of relative path to content.
 * Init and update both use this as the single source of truth (no full-dir copy).
 */
export function getAllScripts(): Map<string, string> {
  const scripts = new Map<string, string>();

  // Package init
  scripts.set("__init__.py", scriptsInit);

  // Common
  scripts.set("common/__init__.py", commonInit);
  scripts.set("common/paths.py", commonPaths);
  scripts.set("common/developer.py", commonDeveloper);
  scripts.set("common/git_context.py", commonGitContext);
  scripts.set("common/task_queue.py", commonTaskQueue);
  scripts.set("common/task_utils.py", commonTaskUtils);
  scripts.set("common/active_task.py", commonActiveTask);
  scripts.set("common/cli_environment.py", commonCliEnvironment);
  scripts.set("common/config.py", commonConfig);
  scripts.set("common/artifact_locale.py", commonArtifactLocale);
  scripts.set("common/io.py", commonIo);
  scripts.set("common/log.py", commonLog);
  scripts.set("common/git.py", commonGit);
  scripts.set("common/types.py", commonTypes);
  scripts.set("common/tasks.py", commonTasks);
  scripts.set("common/task_context.py", commonTaskContext);
  scripts.set("common/task_store.py", commonTaskStore);
  scripts.set("common/task_dashboard.py", commonTaskDashboard);
  scripts.set("common/task_gates.py", commonTaskGates);
  scripts.set("common/task_dependencies.py", commonTaskDependencies);
  scripts.set("common/execution_strategy.py", commonExecutionStrategy);
  scripts.set("common/task_map.py", commonTaskMap);
  scripts.set("common/parent_orchestration.py", commonParentOrchestration);
  scripts.set("common/subagent_dispatch.py", commonSubagentDispatch);
  scripts.set("common/kernel_command.py", commonKernelCommand);
  scripts.set("common/lite_context.py", commonLiteContext);
  scripts.set("common/session_pack.py", commonSessionPack);
  scripts.set("common/full_quality.py", commonFullQuality);
  scripts.set("common/ondemand_topology.py", commonOndemandTopology);
  scripts.set("common/parallel_declaration.py", commonParallelDeclaration);
  scripts.set("common/adapter_middleware.py", commonAdapterMiddleware);
  scripts.set("common/artifact_search.py", commonArtifactSearch);
  scripts.set("common/injection_budget.py", commonInjectionBudget);
  scripts.set("common/session_context.py", commonSessionContext);
  scripts.set("common/packages_context.py", commonPackagesContext);
  scripts.set("common/workflow_phase.py", commonWorkflowPhase);
  scripts.set("common/pactile_config.py", commonPactileConfig);
  scripts.set("common/safe_commit.py", commonSafeCommit);

  // Main user-facing Kernel shims
  scripts.set("get_developer.py", getDeveloperScript);
  scripts.set("init_developer.py", initDeveloperScript);
  scripts.set("task.py", taskScript);
  scripts.set("get_context.py", getContextScript);
  scripts.set("compile_session_pack.py", compileSessionPackScript);
  scripts.set("add_session.py", addSessionScript);

  return scripts;
}

/**
 * Retrieval / evidence / probe scripts kept in the template tree for
 * maintainers and integration tests. Not shipped by default init/update.
 */
export function getMaintainerScripts(): Map<string, string> {
  const scripts = new Map<string, string>();
  scripts.set("common/session_memory.py", commonSessionMemory);
  scripts.set("common/smart_search_evidence.py", commonSmartSearchEvidence);
  scripts.set("common/smart_search_resolve.py", commonSmartSearchResolve);
  scripts.set("common/retrieval_evidence.py", commonRetrievalEvidence);
  scripts.set("common/codebase_retrieval_router.py", commonCodebaseRetrievalRouter);
  scripts.set("common/project_file_stats.py", commonProjectFileStats);
  scripts.set(
    "common/retrieval_tool_classification.py",
    commonRetrievalToolClassification,
  );
  scripts.set(
    "common/retrieval_agent_instructions.py",
    commonRetrievalAgentInstructions,
  );
  scripts.set("common/retrieval_plan_gate.py", commonRetrievalPlanGate);
  scripts.set("common/semantic_plan_gate.py", commonSemanticPlanGate);
  scripts.set("common/retrieval_result_ranking.py", commonRetrievalResultRanking);
  scripts.set("common/retrieval_adapter_metadata.py", commonRetrievalAdapterMetadata);
  scripts.set("common/context_pack.py", commonContextPack);
  scripts.set("common/retrieval_pack.py", commonRetrievalPack);
  scripts.set("common/retrieval_pack_context.py", commonRetrievalPackContext);
  scripts.set("search_artifacts.py", searchArtifactsScript);
  scripts.set("search_memory.py", searchMemoryScript);
  scripts.set("run_smart_search.py", runSmartSearchScript);
  scripts.set("build_context_pack.py", buildContextPackScript);
  scripts.set("build_retrieval_pack.py", buildRetrievalPackScript);
  scripts.set("route_codebase_retrieval.py", routeCodebaseRetrievalScript);
  scripts.set("codegraph_session_smoke.py", codegraphSessionSmokeScript);
  scripts.set("rank_retrieval_candidates.py", rankRetrievalCandidatesScript);
  scripts.set("score_evidence.py", scoreEvidenceScript);
  scripts.set("injection_budget_probe.py", injectionBudgetProbeScript);
  scripts.set("spec_health_outcomes.py", specHealthOutcomesScript);
  scripts.set("verify_evidence_probe.py", verifyEvidenceProbeScript);
  return scripts;
}

/** Test helper: Baseline thin set plus maintainer retrieval/evidence scripts. */
export function getAllScriptsForTests(): Map<string, string> {
  return new Map([...getAllScripts(), ...getMaintainerScripts()]);
}
