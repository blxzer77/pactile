// Public task API surface — canonical task record shape, factory,
// schema, I/O helpers, directory validation, and phase inference.
//
// Task API is intentionally independent from the channel API.

export type {
  PactileTaskRecord,
  TaskRecordField,
} from "./schema.js";

export {
  TASK_RECORD_FIELD_ORDER,
  emptyTaskRecord,
  taskRecordSchema,
} from "./schema.js";

export type {
  LoadTaskRecordOptions,
  WriteTaskRecordOptions,
} from "./records.js";

export {
  loadTaskRecord,
  writeTaskRecord,
} from "./records.js";

export type { TaskDirParts } from "./paths.js";
export { validateTaskDirName, isValidTaskDirName } from "./paths.js";

export type { PactileTaskPhase } from "./phase.js";
export { inferTaskPhase } from "./phase.js";
export type { TrellisTaskPhase, TrellisTaskRecord } from "./compat.js";

export type {
  KernelPhase,
  KernelCondition,
  KernelOutcome,
  KernelErrorCode,
  KernelState,
  KernelIdentity,
  KernelAuditEvent,
  KernelSnapshot,
  KernelGates,
  KernelLegacyProjection,
  KernelCommandOp,
  TransitionRequest,
  LegacyTaskProjection,
  KernelExtrasBoundary,
  ProviderResolutionFact,
  EvidenceFact,
  EvidenceFactPort,
  CompositionValidationInput,
  CompositionReasonCode,
  CompositionValidationOutcome,
  CompositionValidationPort,
} from "./kernel-contract.js";

export {
  KERNEL_SCHEMA_VERSION,
  KERNEL_JSON_BASENAME,
  KERNEL_PHASES,
  KERNEL_CONDITIONS,
  KERNEL_OUTCOMES,
  KERNEL_PHASE_EDGES,
  KERNEL_COMMAND_OPS,
  KernelError,
  isKernelPhase,
  isLegalPhaseEdge,
  deriveStateForPhase,
  projectLegacyStatus,
  kernelPhaseToLegacyStatus,
  hopsToExecute,
  hopsToClose,
  neutralKernelExtrasBoundary,
  validateComposition,
  compositionValidationPort,
} from "./kernel-contract.js";

export type {
  KernelSurfaceLocale,
  KernelSurfaceInput,
  KernelSurfaceProjection,
  ProjectionInspection,
  ProjectionRepairReceipt,
  TaskProjectionPort,
} from "./kernel-surface.js";

export {
  KERNEL_PHASE_HUMAN_EN,
  KERNEL_PHASE_HUMAN_ZH,
  kernelPhaseHumanTitle,
  topologyNeedsIntegrate,
  projectKernelSurface,
  legacyKernelExtrasBoundary,
  projectionBytesFingerprint,
  expectedTaskProjection,
  inspectProjection,
} from "./kernel-surface.js";

export type {
  LitePackErrorCode,
  LitePackArtifact,
  LitePackItem,
  LitePackOmission,
  LiteContextPackRequest,
  LiteContextPack,
} from "./lite-context-pack.js";

export {
  LITE_PACK_VERSION,
  LITE_PACK_SOURCE,
  LITE_BASELINE_MODULES,
  LITE_BLOCKED_ON_DEMAND_MODULES,
  LITE_RETRIEVAL_INTENTS,
  LITE_DEFAULT_MAX_ITEMS,
  LITE_DEFAULT_MAX_ESTIMATED_TOKENS,
  LiteContextPackError,
  isBlockedOnDemandModule,
  estimateLiteTokens,
  buildLiteContextPack,
} from "./lite-context-pack.js";

export type {
  FullQualityRigor,
  FullQualityPhase,
  FullQualityControlId,
  IndependentCheckMode,
  IndependentCheckResult,
  ResolveRequiredControlsInput,
  RequiredControlsBundle,
  AcceptanceItem,
  AcEvidenceMapping,
  AcEvidenceLedger,
  IndependentCheckVerdict,
  EvaluateIndependentCheckInput,
} from "./full-quality.js";

export {
  FULL_QUALITY_SOURCE,
  FULL_QUALITY_SCHEMA_VERSION,
  FULL_BASELINE_CONTROLS,
  FULL_OPTIONAL_CONTROLS,
  DEFAULT_CONTROL_SURFACES,
  DESIGN_RISK_SIGNALS,
  qualityFingerprint,
  resolveRequiredControls,
  parseAcceptanceItems,
  buildAcEvidenceLedger,
  evaluateIndependentCheck,
  readRequiredControls,
  normalizeRequiredControls,
  normalizeRequiredControlsInExtras,
  assertFullQualityForPhase,
  assertIndependentCheckGateRecord,
} from "./full-quality.js";

export type {
  TopologyKind,
  DependencyEdgeType,
  Stage5CommandPhase,
  Stage5OndemandModule,
  TopologyState,
  DependencyEdge,
  DependencyGraph,
  OndemandTrigger,
  OndemandModules,
  BaselineModules,
  DecomposeProposal,
  CaptureCandidate,
  TaskMapGraphProjection,
  Stage5RecordHint,
} from "./ondemand-topology.js";

export {
  STAGE5_SOURCE,
  STAGE5_SCHEMA_VERSION,
  TOPOLOGY_KINDS,
  DEPENDENCY_EDGE_TYPES,
  LIFECYCLE_SLOTS,
  STAGE5_ONDEMAND_MODULES,
  PROFILE_BASELINE_MODULES,
  ONDEMAND_OWNERS,
  LITE_DORMANT_ONDEMAND,
  topologyKindFromChildren,
  defaultTopology,
  defaultOndemandModules,
  defaultBaselineModules,
  defaultDependencyGraph,
  captureCandidate,
  proposeDecompose,
  confirmDecompose,
  applyRetention,
  assignParent,
  assertIntegrationAuthority,
  expandDependsOnToRequires,
  unmetRequires,
  projectTaskMapGraph,
  renderTaskMapProjection,
  residentOnDemandModules,
  activateOnDemand,
  normalizeTopology,
  normalizeDependencyGraph,
  normalizeOndemandModules,
  normalizeBaselineModules,
  readTopology,
  readDependencyGraph,
  readOndemandModules,
  normalizeStage5InExtras,
  assertStage5ForPhase,
  normalizeStage5InExtrasAndAssert,
} from "./ondemand-topology.js";

export type {
  Stage6HookEvent,
  RetrievalIntent,
  MiddlewareProbeKind,
  ShippedMiddlewareProvider,
  Stage6CommandPhase,
  ProviderReadinessStatus,
  EventSubscription,
  EventBridgeLastEvent,
  EventBridgeState,
  ProviderReadiness,
  MiddlewareProviders,
  CapabilityRouter,
  DispatchHookEventInput,
} from "./adapter-middleware.js";

export {
  STAGE6_SOURCE,
  STAGE6_SCHEMA_VERSION,
  STAGE6_HOOK_EVENTS,
  RETRIEVAL_INTENTS,
  SHIPPED_MIDDLEWARE_PROVIDERS,
  DEFAULT_MIDDLEWARE_PROVIDERS,
  DEFAULT_REQUIRED_MIDDLEWARE_PROVIDERS,
  OPTIONAL_CODE_INTEL_PROVIDERS,
  SMART_SEARCH_PROVIDER,
  EXTERNAL_KNOWLEDGE_CAPABILITY,
  SHIPPED_PROVIDER_CAPABILITY,
  SHIPPED_PROVIDER_PROBE,
  defaultEventBridge,
  defaultMiddlewareProviders,
  defaultCapabilityRouter,
  subscribeEvent,
  recordHookEvent,
  shippedProviderCapability,
  shippedProviderProbeKind,
  classifyTransportProbe,
  selectRegisteredMcpServers,
  mcpServerIdsFromConfig,
  probeShippedProviderReadiness,
  probeSmartSearchReadiness,
  applyShippedProviderReadiness,
  applySmartSearchReadiness,
  normalizeEventBridge,
  normalizeMiddlewareProviders,
  normalizeCapabilityRouter,
  readEventBridge,
  readMiddlewareProviders,
  readCapabilityRouter,
  requiredCapabilities,
  externalKnowledgeReady,
  normalizeStage6InExtras,
  assertStage6ForPhase,
  normalizeStage6InExtrasAndAssert,
} from "./adapter-middleware.js";

export type {
  KernelReadResult,
  KernelTransitionResult,
  KernelCommandResult,
  KernelCreateRequest,
  KernelStartRequest,
  KernelRecordGateRequest,
  KernelArchiveRequest,
  KernelPatchRequest,
  KernelProjectionRepairRequest,
} from "./kernel-store.js";

export {
  readKernel,
  applyKernelTransition,
  applyKernelCreate,
  applyKernelStart,
  applyKernelRecordGate,
  applyKernelArchive,
  applyKernelPatch,
  resolveTaskDir,
  kernelJsonPath,
  setKernelAfterWriteHook,
  inspectTaskProjection,
  repairTaskProjection,
  createTaskProjectionPort,
} from "./kernel-store.js";

export type {
  KernelCliSuccess,
  KernelCliFailure,
  KernelCliResponse,
  KernelCliIo,
} from "./kernel-cli.js";

export { handleKernelRequest, runKernelJsonCli } from "./kernel-cli.js";

export type {
  ContractMigrateFindingKind,
  ContractMigrateFinding,
  ContractMigrateReport,
  ScanContractMigrationOptions,
} from "./contract-migrate.js";

export {
  RETIRED_TOP_LEVEL_FIELDS,
  RETIRED_META_FIELDS,
  stripRetiredExtras,
  stripRetiredMeta,
  scanContractMigration,
} from "./contract-migrate.js";

export type {
  ArtifactWriteTarget,
  ArtifactTaskScan,
  ArtifactMigratePlan,
  PlanArtifactMigrationOptions,
  ApplyArtifactMigrationOptions,
  ApplyArtifactMigrationResult,
} from "./p36-artifact-migrate.js";

export {
  P36_ARTIFACT_SOURCE,
  planArtifactMigration,
  applyArtifactMigration,
  formatArtifactVernacular,
} from "./p36-artifact-migrate.js";

export type { WaveCState, WaveCPlan } from "./p36-wave-c.js";

export {
  WAVE_C_STATE_REL,
  WAVE_C_SCHEMA_VERSION,
  waveCStatePath,
  emptyWaveCState,
  readWaveCState,
  isWaveCConfirmed,
  writeWaveCConfirmed,
  planWaveC,
  formatWaveCVernacular,
} from "./p36-wave-c.js";
