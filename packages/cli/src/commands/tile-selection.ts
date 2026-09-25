import fs from "node:fs";
import path from "node:path";
import type { PactileIntentV1, PolicyCeilingV1 } from "../core/index.js";
import {
  decideSelectedTaskBatch2TileSelection,
  prepareSelectedTaskBatch2TileSelection,
  replayStoredSelectedTaskBatch2TileSelectionDecision,
} from "../pactile/registry.js";
import type {
  TileCapabilityFact,
  TileProviderFact,
} from "../pactile/tiles/compiler.js";
import {
  taskTileSelectionRequest,
  type TileSelectionDecision,
  type TileSelectionRequest,
} from "../pactile/tiles/selection.js";

type JsonRecord = Record<string, unknown>;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function repeatedOptions(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}

function readRequestFile(root: string, input: string): JsonRecord {
  let parsed: unknown;
  try {
    const file = input === "-" ? null : path.resolve(root, input);
    const raw = file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Tile selection request file is unreadable or invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Tile selection request must be a JSON object");
  const record = parsed as JsonRecord;
  const allowed = new Set([
    "intent",
    "requiredOutputs",
    "policyCeiling",
    "capabilities",
    "providerFacts",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key)))
    throw new Error("Tile selection request contains unsupported fields");
  return record;
}

function selectionRequest(args: readonly string[], root: string): Omit<TileSelectionRequest, "taskLifecycle"> {
  const requestFile = option(args, "--request-file");
  const record = requestFile ? readRequestFile(root, requestFile) : {};
  const flaggedIntent = option(args, "--intent");
  const flaggedOutputs = repeatedOptions(args, "--output");
  if (requestFile && (flaggedIntent !== undefined || flaggedOutputs.length > 0))
    throw new Error("Use either --request-file or --intent/--output flags, not both");

  const defaults = taskTileSelectionRequest("define");
  const intent = requestFile ? record.intent : flaggedIntent;
  const requiredOutputs = requestFile ? record.requiredOutputs : flaggedOutputs;
  if (typeof intent !== "string" || !Array.isArray(requiredOutputs) || requiredOutputs.length === 0)
    throw new Error("Tile selection requires --intent and at least one --output, or a complete --request-file");

  return {
    intent: intent as PactileIntentV1,
    requiredOutputs: requiredOutputs as string[],
    policyCeiling: (requestFile ? record.policyCeiling : undefined) as PolicyCeilingV1 | undefined ?? defaults.policyCeiling,
    capabilities: (requestFile ? record.capabilities : undefined) as TileCapabilityFact[] | undefined ?? [],
    providerFacts: (requestFile ? record.providerFacts : undefined) as TileProviderFact[] | undefined ?? [],
    channel: "agent",
  };
}

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Current-Task Agent entry point. Only the compiler-checked offer is shown. */
export function runTileSelectionCli(args: string[], root = process.cwd()): number {
  try {
    const [operation, ...rest] = args;
    if (operation === "prepare") {
      const request = selectionRequest(rest, root);
      const prepared = prepareSelectedTaskBatch2TileSelection(root, request);
      if (!prepared.success) {
        writeJson(prepared);
        return 1;
      }
      writeJson({ success: true, offer: prepared.data.offer });
      return 0;
    }

    if (operation === "decide") {
      const request = selectionRequest(rest, root);
      const offerFingerprint = option(rest, "--offer-fingerprint");
      const kind = option(rest, "--kind");
      if (!offerFingerprint || !kind)
        throw new Error("Usage: pactile tile-selection decide --offer-fingerprint <sha256> --kind <adopt|override|no-match> --intent <intent> --output <output> [--tile <ref>]");
      const selectedRefs = repeatedOptions(rest, "--tile");
      const priorAttemptRefs = repeatedOptions(rest, "--prior-tile");
      const decision: TileSelectionDecision = {
        kind: kind as TileSelectionDecision["kind"],
        offerFingerprint,
        ...(selectedRefs.length ? { selectedRefs } : {}),
        ...(priorAttemptRefs.length ? { priorAttemptRefs } : {}),
      };
      const result = decideSelectedTaskBatch2TileSelection(root, request, decision);
      if (!result.success) {
        writeJson(result);
        return 1;
      }
      writeJson({
        success: true,
        receipt: result.data,
        snapshot: result.snapshot,
        executionAuthorization: "not-granted",
      });
      return 0;
    }

    if (operation === "replay") {
      const fingerprint = option(rest, "--snapshot-fingerprint");
      if (!fingerprint)
        throw new Error("Usage: pactile tile-selection replay --snapshot-fingerprint <sha256>");
      const result = replayStoredSelectedTaskBatch2TileSelectionDecision(root, fingerprint);
      writeJson(result);
      return result.success ? 0 : 1;
    }

    throw new Error("Usage: pactile tile-selection <prepare|decide|replay> ...");
  } catch (error) {
    console.error(`Tile selection error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
