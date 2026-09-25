/** Public Pactile foundation APIs plus optional host adapter exports. Importing does not install an adapter. */

export * from "./runtime/index.js";
export * from "./lifecycle/index.js";
export * from "./exit/index.js";

export * from "./tiles/loader.js";
export * from "./tiles/catalog.js";
export * from "./tiles/compiler.js";
export * from "./tiles/selection.js";

export * from "./projection/managed-block.js";
export * from "./projection/structured-merge.js";
export * from "./projection/planner.js";
export * from "./projection/store.js";

export * from "./adapters/index.js";
export * from "./providers/index.js";
export * from "./tiles/content/index.js";
export * from "./registry.js";

export type { AdoptionDiagnostic } from "./adoption/safety.js";
export type {
  DiscoveryContext,
  InventoryResult,
} from "./adoption/inventory.js";
export { buildInventory, discoverSnapshot } from "./adoption/inventory.js";
export { discoverSkillEntries } from "./adoption/discovery.js";
export type {
  InstallHintResult,
  BindingProposal,
} from "./adoption/bindings.js";
export { createInstallHint, planBinding } from "./adoption/bindings.js";
export type {
  AdoptionWorkflowDiagnosticCode,
  AdoptionWorkflowPhase,
  AdoptionWorkflowResult,
  AdoptionWorkflowStep,
} from "./adoption/workflow.js";
export { runAdoptionWorkflow } from "./adoption/workflow.js";

export * from "./middleware/index.js";
export * from "./retrieval/index.js";
