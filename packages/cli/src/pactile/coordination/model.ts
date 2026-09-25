import { createHash } from "node:crypto";
import { z } from "zod";

export const COORDINATION_MAX_EVENT_BYTES = 16 * 1024;
export const COORDINATION_MAX_LOG_BYTES = 16 * 1024 * 1024;
export const COORDINATION_MAX_LOG_EVENTS = 20_000;

export type CoordinationErrorCode =
  | "invalid-input"
  | "unsafe-path"
  | "store-corrupt"
  | "store-locked"
  | "store-limit"
  | "state-conflict"
  | "store-io";

export class CoordinationError extends Error {
  constructor(readonly code: CoordinationErrorCode) {
    super(code);
    this.name = "CoordinationError";
  }
}

const logicalId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((value) => value !== "." && value !== "..");
const eventId = z.string().uuid();
const timestamp = z.string().datetime();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const evidenceLevel = z.enum([
  "local",
  "simulated",
  "desktop-native",
  "provider",
]);
const actor = z
  .object({
    platform: z.enum(["codex", "pi", "pactile", "user", "host", "other"]),
    id: logicalId.nullable(),
  })
  .strict();
const safeText = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 4_096)
  .refine((value) => !hasForbiddenCoordinationControl(value));
const evidenceRef = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    if (
      value.startsWith("/") ||
      value.startsWith("\\") ||
      /^[A-Za-z]:/u.test(value) ||
      value.includes("\\") ||
      /[<>:"|?*]/u.test(value) ||
      hasForbiddenCoordinationControl(value)
    ) {
      return false;
    }
    const parts = value.split("/");
    return parts.every(
      (part) => part.length > 0 && part !== "." && part !== "..",
    );
  });

const base = {
  schema_version: z.literal(1),
  event_id: eventId,
  recorded_at: timestamp,
};

export const coordinationEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("message.created"),
      message_id: logicalId,
      from_task_id: logicalId,
      to_task_id: logicalId,
      from_run_id: logicalId.nullable(),
      to_run_id: logicalId.nullable(),
      sender: actor,
      evidence_level: evidenceLevel,
      body: safeText,
      request_id: logicalId.nullable(),
      host_ref: logicalId.nullable(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("message.receipt"),
      message_id: logicalId,
      receipt_id: logicalId,
      status: z.enum(["queued", "sent", "delivered", "acknowledged", "failed"]),
      actor,
      evidence_level: evidenceLevel,
      external_ref: logicalId.nullable(),
      note: safeText.nullable(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("task.blocked"),
      task_id: logicalId,
      block_id: logicalId,
      blocked_by_task_id: logicalId.nullable(),
      message_id: logicalId.nullable(),
      reason: safeText,
      actor,
      evidence_level: evidenceLevel,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("task.unblocked"),
      task_id: logicalId,
      block_id: logicalId,
      unblocked_by_task_id: logicalId.nullable(),
      resolution_message_id: logicalId.nullable(),
      reason: safeText,
      actor,
      evidence_level: evidenceLevel,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("run.started"),
      task_id: logicalId,
      run_id: logicalId,
      role: logicalId.nullable(),
      workspace_id: logicalId.nullable(),
      provider_run_id: logicalId.nullable(),
      actor,
      evidence_level: evidenceLevel,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("run.progress"),
      task_id: logicalId,
      run_id: logicalId,
      sequence: z.number().int().min(0).max(1_000_000_000),
      name: logicalId,
      summary: safeText,
      evidence_refs: z.array(evidenceRef).max(16),
      actor,
      evidence_level: evidenceLevel,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("run.result"),
      task_id: logicalId,
      run_id: logicalId,
      outcome: z.enum([
        "settled",
        "needs_review",
        "failed",
        "cancelled",
        "timed_out",
        "interrupted",
      ]),
      summary: safeText,
      evidence_refs: z.array(evidenceRef).max(16),
      actor,
      evidence_level: evidenceLevel,
    })
    .strict(),
]);

export const coordinationEnvelopeSchema = z
  .object({
    schema_version: z.literal(1),
    previous_hash: hash,
    hash,
    event: coordinationEventSchema,
  })
  .strict();

export type CoordinationEvidenceLevel = z.infer<typeof evidenceLevel>;
export type CoordinationActor = z.infer<typeof actor>;
export type CoordinationEvent = z.infer<typeof coordinationEventSchema>;
export type CoordinationMessageCreated = Extract<
  CoordinationEvent,
  { type: "message.created" }
>;
export type CoordinationMessageReceipt = Extract<
  CoordinationEvent,
  { type: "message.receipt" }
>;
export type CoordinationTaskBlocked = Extract<
  CoordinationEvent,
  { type: "task.blocked" }
>;
export type CoordinationTaskUnblocked = Extract<
  CoordinationEvent,
  { type: "task.unblocked" }
>;
export type CoordinationRunStarted = Extract<
  CoordinationEvent,
  { type: "run.started" }
>;
export type CoordinationRunProgress = Extract<
  CoordinationEvent,
  { type: "run.progress" }
>;
export type CoordinationRunResult = Extract<
  CoordinationEvent,
  { type: "run.result" }
>;
export type CoordinationMessageStatus =
  | "pending"
  | CoordinationMessageReceipt["status"];

export interface CoordinationMessageSnapshot {
  message: CoordinationMessageCreated;
  status: CoordinationMessageStatus;
  receipts: CoordinationMessageReceipt[];
}

export interface CoordinationRunSnapshot {
  started: CoordinationRunStarted;
  progress: CoordinationRunProgress[];
  result: CoordinationRunResult | null;
}

export interface CoordinationSnapshot {
  events: CoordinationEvent[];
  messages: CoordinationMessageSnapshot[];
  blocked_tasks: CoordinationTaskBlocked[];
  runs: CoordinationRunSnapshot[];
}

export interface CoordinationEnvelope {
  schema_version: 1;
  previous_hash: string;
  hash: string;
  event: CoordinationEvent;
}

export const COORDINATION_GENESIS_HASH = "0".repeat(64);

export function hasForbiddenCoordinationControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint < 0x20 && ![0x09, 0x0a, 0x0d].includes(codePoint)) ||
        codePoint === 0x7f)
    ) {
      return true;
    }
  }
  return false;
}

function stripForbiddenControls(value: string): string {
  return Array.from(value)
    .filter((character) => !hasForbiddenCoordinationControl(character))
    .join("");
}

/** Stable JSON representation used only for journal hashing and replay checks. */
export function canonicalCoordinationJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("coordination-invalid-json");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCoordinationJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalCoordinationJson(record[key])}`,
    )
    .join(",")}}`;
}

export function coordinationEventHash(
  previousHash: string,
  event: CoordinationEvent,
): string {
  return createHash("sha256")
    .update(previousHash)
    .update("\n")
    .update(canonicalCoordinationJson(event))
    .digest("hex");
}

export function redactCoordinationText(value: string): string {
  const redacted = value
    .replace(
      /\b(?:sk[-_]|ghp_|gho_|glpat-|plane_api_)[A-Za-z0-9_-]{12,}\b/gi,
      "[redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{12,}\b/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    )
    .replace(/\r\n?/g, "\n");
  return stripForbiddenControls(redacted).trim();
}
