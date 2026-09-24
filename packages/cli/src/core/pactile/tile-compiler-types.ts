import type { AssuranceLevelV1, PolicyCeilingV1 } from "./provider.js";
import type {
  TileEvidenceKindV1,
  TileManifestV1,
  TileStopConditionV1,
} from "./tile.js";

/** M1 consumption port. It does not alter any M0 manifest or own a planner. */
export interface CompiledTile {
  readonly ref: string;
  readonly manifest: TileManifestV1;
  readonly fingerprint: string;
}

export interface TileEvidenceObligation {
  readonly kind: TileEvidenceKindV1;
  readonly required: boolean;
  readonly description: string;
  readonly tileRefs: readonly string[];
}

export interface TileStopObligation {
  readonly condition: TileStopConditionV1;
  readonly tileRefs: readonly string[];
}

export interface CompiledComposition {
  readonly compilerAbiVersion: 1;
  readonly requestedSelection: readonly string[];
  readonly expandedSelection: readonly string[];
  readonly fallbackSelection: readonly string[];
  readonly tiles: readonly CompiledTile[];
  readonly policyCeiling: PolicyCeilingV1;
  readonly minimumAssurance: AssuranceLevelV1;
  readonly evidenceObligations: readonly TileEvidenceObligation[];
  readonly stopObligations: readonly TileStopObligation[];
  readonly maxAttempts: number;
  readonly fingerprint: string;
}
