/**
 * Markdown templates for Pactile workflow
 *
 * These are GENERIC templates for new projects.
 * Structure templates use .md.txt extension as they are generic templates.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Read a template file from src/templates/markdown/
 */
function readLocalTemplate(filename: string): string {
  const filePath = join(__dirname, filename);
  return readFileSync(filePath, "utf-8");
}

// =============================================================================
// Root files for new projects
// =============================================================================

export const agentsMdContent: string = readLocalTemplate("agents.md");

// Workspace index template (developer work records)
export const workspaceIndexContent: string =
  readLocalTemplate("workspace-index.md");

// Backwards compatibility alias
export const agentProgressIndexContent = workspaceIndexContent;

// Gitignore (template file - .gitignore is ignored by npm)
export const workflowGitignoreContent: string =
  readLocalTemplate("gitignore.txt");

// =============================================================================
// Structure templates (generic templates from .txt files)
// These are NOT dogfooded - they are generic templates for new projects
// =============================================================================

// Backend structure (multi-doc format)
export const backendIndexContent: string = readLocalTemplate(
  "spec/backend/index.md.txt",
);
export const backendDirectoryStructureContent: string = readLocalTemplate(
  "spec/backend/directory-structure.md.txt",
);
export const backendDatabaseGuidelinesContent: string = readLocalTemplate(
  "spec/backend/database-guidelines.md.txt",
);
export const backendLoggingGuidelinesContent: string = readLocalTemplate(
  "spec/backend/logging-guidelines.md.txt",
);
export const backendQualityGuidelinesContent: string = readLocalTemplate(
  "spec/backend/quality-guidelines.md.txt",
);
export const backendErrorHandlingContent: string = readLocalTemplate(
  "spec/backend/error-handling.md.txt",
);

// Frontend structure (multi-doc format)
export const frontendIndexContent: string = readLocalTemplate(
  "spec/frontend/index.md.txt",
);
export const frontendDirectoryStructureContent: string = readLocalTemplate(
  "spec/frontend/directory-structure.md.txt",
);
export const frontendTypeSafetyContent: string = readLocalTemplate(
  "spec/frontend/type-safety.md.txt",
);
export const frontendHookGuidelinesContent: string = readLocalTemplate(
  "spec/frontend/hook-guidelines.md.txt",
);
export const frontendComponentGuidelinesContent: string = readLocalTemplate(
  "spec/frontend/component-guidelines.md.txt",
);
export const frontendQualityGuidelinesContent: string = readLocalTemplate(
  "spec/frontend/quality-guidelines.md.txt",
);
export const frontendStateManagementContent: string = readLocalTemplate(
  "spec/frontend/state-management.md.txt",
);

// Guides structure (user-owned project thinking guides — init-only seeds)
export const guidesIndexContent: string = readLocalTemplate(
  "spec/guides/index.md.txt",
);
export const guidesCrossLayerThinkingGuideContent: string = readLocalTemplate(
  "spec/guides/cross-layer-thinking-guide.md.txt",
);
export const guidesCodeReuseThinkingGuideContent: string = readLocalTemplate(
  "spec/guides/code-reuse-thinking-guide.md.txt",
);
export const guidesDurableLearningDecisionGuideContent: string =
  readLocalTemplate("spec/guides/durable-learning-decision-guide.md.txt");
export const guidesDebugLoopGuideContent: string = readLocalTemplate(
  "spec/guides/debug-loop-guide.md.txt",
);
export const guidesPrototypeGuideContent: string = readLocalTemplate(
  "spec/guides/prototype-guide.md.txt",
);
export const guidesTestDisciplineGuideContent: string = readLocalTemplate(
  "spec/guides/test-discipline-guide.md.txt",
);
export const guidesE2eWalkthroughGuideContent: string = readLocalTemplate(
  "spec/guides/e2e-walkthrough-guide.md.txt",
);
export const guidesCrossPlatformThinkingGuideContent: string =
  readLocalTemplate("spec/guides/cross-platform-thinking-guide.md.txt");

// =============================================================================
// Framework docs (.pactile/framework/ — framework-owned, refreshed by update)
// =============================================================================

export const frameworkIndexContent: string = readLocalTemplate(
  "framework/index.md.txt",
);
export const frameworkRetrievalDailyGuideContent: string = readLocalTemplate(
  "framework/retrieval-daily-guide.md.txt",
);
export const frameworkCodexWorkerDispatchContent: string = readLocalTemplate(
  "framework/codex-worker-dispatch.md.txt",
);
export const frameworkExecutionStrategyContent: string = readLocalTemplate(
  "framework/execution-strategy.md.txt",
);
export const frameworkVerificationStrengthGuideContent: string =
  readLocalTemplate("framework/verification-strength-guide.md.txt");
export const frameworkInjectionBudgetGuideContent: string = readLocalTemplate(
  "framework/injection-budget-guide.md.txt",
);
export const frameworkArtifactLocaleGuideContent: string = readLocalTemplate(
  "framework/artifact-locale-guide.md.txt",
);
export const frameworkPrdGrillFrontierGuideContent: string = readLocalTemplate(
  "framework/prd-grill-frontier.md.txt",
);
export const frameworkDogfoodOnlySurfacesGuideContent: string =
  readLocalTemplate("framework/dogfood-only-surfaces.md.txt");
export const frameworkParallelFirstExecutionContent: string = readLocalTemplate(
  "framework/parallel-first-execution.md.txt",
);
export const frameworkMiddlewareProtocolContent: string = readLocalTemplate(
  "framework/middleware-protocol.md.txt",
);
export const frameworkUpgradeContent: string = readLocalTemplate(
  "framework/upgrade.md.txt",
);
export const frameworkReleaseBoundaryContent: string = readLocalTemplate(
  "framework/release-boundary.md.txt",
);

/**
 * Single source of truth for `.pactile/framework/` docs.
 * Consumed by init (configurators/workflow.ts) and update (commands/update.ts)
 * so the two paths can never drift.
 */
export const frameworkDocs: readonly {
  name: string;
  content: string;
}[] = [
  { name: "index.md", content: frameworkIndexContent },
  {
    name: "retrieval-daily-guide.md",
    content: frameworkRetrievalDailyGuideContent,
  },
  {
    name: "codex-worker-dispatch.md",
    content: frameworkCodexWorkerDispatchContent,
  },
  { name: "execution-strategy.md", content: frameworkExecutionStrategyContent },
  {
    name: "verification-strength-guide.md",
    content: frameworkVerificationStrengthGuideContent,
  },
  {
    name: "injection-budget-guide.md",
    content: frameworkInjectionBudgetGuideContent,
  },
  {
    name: "artifact-locale-guide.md",
    content: frameworkArtifactLocaleGuideContent,
  },
  {
    name: "prd-grill-frontier.md",
    content: frameworkPrdGrillFrontierGuideContent,
  },
  {
    name: "dogfood-only-surfaces.md",
    content: frameworkDogfoodOnlySurfacesGuideContent,
  },
  {
    name: "parallel-first-execution.md",
    content: frameworkParallelFirstExecutionContent,
  },
  {
    name: "middleware-protocol.md",
    content: frameworkMiddlewareProtocolContent,
  },
  { name: "upgrade.md", content: frameworkUpgradeContent },
  {
    name: "release-boundary.md",
    content: frameworkReleaseBoundaryContent,
  },
];
