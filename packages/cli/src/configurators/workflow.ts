import path from "node:path";

import { DIR_NAMES, PATHS } from "../constants/paths.js";
import {
  getAllScripts,
  workflowMdTemplate,
  configYamlTemplate,
  gitignoreTemplate,
  executionStrategyRulesJson,
  contextMdTemplate,
  adrReadmeTemplate,
} from "../templates/pactile/index.js";

// Import markdown templates
import {
  agentProgressIndexContent,
  // Backend structure (multi-doc)
  backendIndexContent,
  backendDirectoryStructureContent,
  backendDatabaseGuidelinesContent,
  backendLoggingGuidelinesContent,
  backendQualityGuidelinesContent,
  backendErrorHandlingContent,
  // Frontend structure (multi-doc)
  frontendIndexContent,
  frontendDirectoryStructureContent,
  frontendTypeSafetyContent,
  frontendHookGuidelinesContent,
  frontendComponentGuidelinesContent,
  frontendQualityGuidelinesContent,
  frontendStateManagementContent,
  // Guides structure
  guidesIndexContent,
  guidesCrossLayerThinkingGuideContent,
  guidesCodeReuseThinkingGuideContent,
  guidesDurableLearningDecisionGuideContent,
  guidesDebugLoopGuideContent,
  guidesPrototypeGuideContent,
  guidesTestDisciplineGuideContent,
  guidesE2eWalkthroughGuideContent,
  guidesCrossPlatformThinkingGuideContent,
  frameworkDocs,
} from "../templates/markdown/index.js";

import { collectUserModuleTemplates } from "../templates/extract.js";
import { writeFile, ensureDir } from "../utils/file-writer.js";
import { replacePythonCommandLiterals } from "./shared.js";
import {
  sanitizePkgName,
  type ProjectType,
  type DetectedPackage,
} from "../utils/project-detector.js";

interface DocDefinition {
  name: string;
  content: string;
}

/**
 * Root-level files written by the workflow configurator (outside `.pactile/`).
 * Shared by createWorkflowStructure (init), update.ts collectTemplateFiles
 * (update hash tracking), and manifest-prune buildKnownKeys (so uninstall
 * recognizes them as Pactile-written and removes them).
 */
export function getWorkflowRootTemplateFiles(): Map<string, string> {
  const files = new Map<string, string>();
  files.set("CONTEXT.md", contextMdTemplate);
  files.set("docs/adr/README.md", adrReadmeTemplate);
  return files;
}

/**
 * Options for creating workflow structure
 */
export interface WorkflowOptions {
  /** Detected or specified project type */
  projectType: ProjectType;
  /** Skip creating local spec templates (when using remote template) — single-repo mode */
  skipSpecTemplates?: boolean;
  /** Detected monorepo packages (enables monorepo spec creation) */
  packages?: DetectedPackage[];
  /** Package names that use remote templates (skip blank spec for these) */
  remoteSpecPackages?: Set<string>;
  /**
   * Optional override for `.pactile/workflow.md` content. When omitted the
   * bundled native template is written. Set by `init --workflow` (or
   * `--workflow-source`) after the resolver has fetched marketplace content.
   * Caller is still responsible for removing the `.pactile/workflow.md` hash
   * entry for non-native workflows so update.ts treats them as user-managed.
   */
  workflowMdOverride?: string;
}

/**
 * Create workflow structure based on project type
 *
 * This function creates the .pactile/ directory structure by:
 * 1. Writing scripts/ from getAllScripts() (user-shipped subset only)
 * 2. Copying workflow.md and .gitignore (dogfooding)
 * 3. Writing modules/ (index.json + <id>/contract.md; never catalog.ts)
 * 4. Creating workspace/ with index.md
 * 5. Creating tasks/ directory
 * 6. Creating spec/ with templates (not dogfooded - generic templates)
 *
 * @param cwd - Current working directory
 * @param options - Workflow options including project type
 */
export async function createWorkflowStructure(
  cwd: string,
  options?: WorkflowOptions,
): Promise<void> {
  const projectType = options?.projectType ?? "fullstack";
  const skipSpecTemplates = options?.skipSpecTemplates ?? false;
  const packages = options?.packages;
  const remoteSpecPackages = options?.remoteSpecPackages;
  const workflowMd = options?.workflowMdOverride ?? workflowMdTemplate;

  // Create the canonical Pactile directory.
  ensureDir(path.join(cwd, DIR_NAMES.WORKFLOW));

  // Write user-shipped Python scripts (same source of truth as pactile update).
  await writeScriptTemplates(path.join(cwd, PATHS.SCRIPTS));

  // P29 short contracts — Session compiler reads these from the user tree.
  // Walk skips catalog.ts / any .ts; not registered in getAllScripts().
  await writeUserModuleContracts(path.join(cwd, PATHS.MODULES));

  // Do not create or write `.pactile/middleware/`. Users drop Manifests there;
  // init/update never write, delete, or hash that overlay.

  // Copy workflow.md (native bundled template or selected marketplace variant)
  await writeFile(
    path.join(cwd, PATHS.WORKFLOW_GUIDE_FILE),
    replacePythonCommandLiterals(workflowMd),
  );

  // Copy .gitignore from templates
  await writeFile(
    path.join(cwd, DIR_NAMES.WORKFLOW, ".gitignore"),
    gitignoreTemplate,
  );

  // Copy config.yaml from templates
  await writeFile(
    path.join(cwd, DIR_NAMES.WORKFLOW, "config.yaml"),
    configYamlTemplate,
  );
  ensureDir(path.join(cwd, DIR_NAMES.WORKFLOW, "config"));
  await writeFile(
    path.join(cwd, DIR_NAMES.WORKFLOW, "config", "execution-strategy-rules.json"),
    executionStrategyRulesJson,
  );

  // Project domain glossary stub (on-demand read, never always-inject)
  // and ADR rules — shared with update.ts collectTemplateFiles and
  // manifest-prune buildKnownKeys via getWorkflowRootTemplateFiles().
  for (const [relativePath, content] of getWorkflowRootTemplateFiles()) {
    const destPath = path.join(cwd, relativePath);
    if (relativePath.endsWith("README.md")) {
      ensureDir(path.dirname(destPath));
    }
    await writeFile(destPath, content);
  }

  // Create workspace/ with index.md
  ensureDir(path.join(cwd, PATHS.WORKSPACE));
  await writeFile(
    path.join(cwd, PATHS.WORKSPACE, "index.md"),
    replacePythonCommandLiterals(agentProgressIndexContent),
  );

  // Create tasks/ directory
  ensureDir(path.join(cwd, PATHS.TASKS));

  // Create spec templates based on project type
  // These are NOT dogfooded - they are generic templates for new projects
  if (packages && packages.length > 0) {
    // Monorepo mode: create per-package spec directories
    await createSpecTemplates(cwd, projectType, packages, remoteSpecPackages);
  } else if (!skipSpecTemplates) {
    // Single-repo mode: create global spec (skip if using remote template)
    await createSpecTemplates(cwd, projectType);
  }
}

async function writeScriptTemplates(scriptsRoot: string): Promise<void> {
  ensureDir(scriptsRoot);
  for (const [scriptPath, content] of getAllScripts()) {
    const destPath = path.join(scriptsRoot, scriptPath);
    ensureDir(path.dirname(destPath));
    const isExecutable = scriptPath.endsWith(".py");
    await writeFile(destPath, replacePythonCommandLiterals(content), {
      executable: isExecutable,
    });
  }
}

async function writeUserModuleContracts(modulesRoot: string): Promise<void> {
  ensureDir(modulesRoot);
  for (const [relativePath, content] of collectUserModuleTemplates()) {
    const destPath = path.join(modulesRoot, relativePath);
    ensureDir(path.dirname(destPath));
    await writeFile(destPath, replacePythonCommandLiterals(content));
  }
}

/**
 * Write backend spec docs into a target spec directory.
 */
async function writeBackendDocs(specBase: string): Promise<void> {
  const backendDir = path.join(specBase, "backend");
  ensureDir(backendDir);
  const docs: DocDefinition[] = [
    { name: "index.md", content: backendIndexContent },
    {
      name: "directory-structure.md",
      content: backendDirectoryStructureContent,
    },
    {
      name: "database-guidelines.md",
      content: backendDatabaseGuidelinesContent,
    },
    { name: "logging-guidelines.md", content: backendLoggingGuidelinesContent },
    { name: "quality-guidelines.md", content: backendQualityGuidelinesContent },
    { name: "error-handling.md", content: backendErrorHandlingContent },
  ];
  for (const doc of docs) {
    await writeFile(path.join(backendDir, doc.name), doc.content);
  }
}

/**
 * Write frontend spec docs into a target spec directory.
 */
async function writeFrontendDocs(specBase: string): Promise<void> {
  const frontendDir = path.join(specBase, "frontend");
  ensureDir(frontendDir);
  const docs: DocDefinition[] = [
    { name: "index.md", content: frontendIndexContent },
    {
      name: "directory-structure.md",
      content: frontendDirectoryStructureContent,
    },
    { name: "type-safety.md", content: frontendTypeSafetyContent },
    { name: "hook-guidelines.md", content: frontendHookGuidelinesContent },
    {
      name: "component-guidelines.md",
      content: frontendComponentGuidelinesContent,
    },
    {
      name: "quality-guidelines.md",
      content: frontendQualityGuidelinesContent,
    },
    { name: "state-management.md", content: frontendStateManagementContent },
  ];
  for (const doc of docs) {
    await writeFile(path.join(frontendDir, doc.name), doc.content);
  }
}

/**
 * Write spec docs for a given project type into a target spec directory.
 */
async function writeSpecForType(
  specBase: string,
  projectType: ProjectType,
): Promise<void> {
  if (projectType !== "frontend") {
    await writeBackendDocs(specBase);
  }
  if (projectType !== "backend") {
    await writeFrontendDocs(specBase);
  }
}

async function createSpecTemplates(
  cwd: string,
  projectType: ProjectType,
  packages?: DetectedPackage[],
  remoteSpecPackages?: Set<string>,
): Promise<void> {
  // Ensure spec directory exists
  ensureDir(path.join(cwd, PATHS.SPEC));

  // Guides - always created regardless of mode
  const guidesDir = path.join(cwd, `${PATHS.SPEC}/guides`);
  ensureDir(guidesDir);
  const guidesDocs: DocDefinition[] = [
    { name: "index.md", content: guidesIndexContent },
    {
      name: "durable-learning-decision-guide.md",
      content: guidesDurableLearningDecisionGuideContent,
    },
    {
      name: "cross-layer-thinking-guide.md",
      content: guidesCrossLayerThinkingGuideContent,
    },
    {
      name: "code-reuse-thinking-guide.md",
      content: guidesCodeReuseThinkingGuideContent,
    },
    {
      name: "debug-loop-guide.md",
      content: guidesDebugLoopGuideContent,
    },
    {
      name: "prototype-guide.md",
      content: guidesPrototypeGuideContent,
    },
    {
      name: "test-discipline-guide.md",
      content: guidesTestDisciplineGuideContent,
    },
    {
      name: "e2e-walkthrough-guide.md",
      content: guidesE2eWalkthroughGuideContent,
    },
    {
      name: "cross-platform-thinking-guide.md",
      content: guidesCrossPlatformThinkingGuideContent,
    },
  ];
  for (const doc of guidesDocs) {
    await writeFile(path.join(guidesDir, doc.name), doc.content);
  }

  // Framework docs (.pactile/framework/) — framework-owned, refreshed by update.
  // Apply the same platform command rewrite as update.ts collectTemplateFiles
  // so init-written content matches the hash update expects (no-op on
  // same-version update instead of a spurious rewrite).
  const frameworkDir = path.join(cwd, PATHS.FRAMEWORK);
  ensureDir(frameworkDir);
  for (const doc of frameworkDocs) {
    await writeFile(
      path.join(frameworkDir, doc.name),
      replacePythonCommandLiterals(doc.content),
    );
  }

  if (packages && packages.length > 0) {
    // Monorepo mode: create spec/<name>/ for each package
    for (const pkg of packages) {
      const dirName = sanitizePkgName(pkg.name);
      if (remoteSpecPackages?.has(dirName)) continue;
      const pkgSpecBase = path.join(cwd, `${PATHS.SPEC}/${dirName}`);
      ensureDir(pkgSpecBase);
      const pkgType = pkg.type === "unknown" ? "fullstack" : pkg.type;
      await writeSpecForType(pkgSpecBase, pkgType);
    }
  } else {
    // Single-repo mode
    await writeSpecForType(path.join(cwd, PATHS.SPEC), projectType);
  }
}
