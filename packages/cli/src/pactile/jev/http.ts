import { performance } from "node:perf_hooks";
import { isPlainOwnDataJsonTreeV3 } from "../retrieval/boundary.js";
import { JEV_ENDPOINT_V1 } from "./contracts.js";
import type { JevFallbackCodeV1 } from "./contracts.js";

const SAFE_HEADER_ID = /^req_[A-Za-z0-9_-]{1,76}$/u;
const MAX_RESPONSE_BYTES = 24 * 1024;

function getRequestId(response: Response, apiKey: string): string | null {
  const value = response.headers.get("x-typesafe-request-id");
  return value !== null && SAFE_HEADER_ID.test(value) && !value.includes(apiKey)
    ? value
    : null;
}

function retryDelay(response: Response): number {
  const ms = response.headers.get("retry-after-ms");
  if (ms !== null && /^\d{1,6}$/u.test(ms.trim()))
    return Math.min(500, Number(ms.trim()));
  const s = response.headers.get("retry-after");
  if (s !== null && /^\d{1,3}(?:\.\d+)?$/u.test(s.trim()))
    return Math.min(500, Math.max(0, Math.round(Number(s.trim()) * 1_000)));
  return 100;
}

function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | null> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (value: T | null): void => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(value),
      () => finish(null),
    );
  });
}

function cancelBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation !== undefined) void cancellation.catch(() => undefined);
  } catch {
    /* Never retain raw transport errors. */
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    /* Never retain raw transport errors. */
  }
}

async function retryWait(ms: number, signal: AbortSignal): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(true), ms);
    const finish = (complete: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(complete);
    };
    const abort = (): void => finish(false);
    if (signal.aborted) finish(false);
    else signal.addEventListener("abort", abort, { once: true });
  });
}

async function readBoundedText(
  response: Response,
  signal: AbortSignal,
): Promise<{ text: string } | "too-large" | "aborted" | "failed"> {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    /^\d{1,10}$/u.test(length) &&
    Number(length) > MAX_RESPONSE_BYTES
  ) {
    cancelBody(response);
    return "too-large";
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return "failed";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await raceAbort(reader.read(), signal);
      if (item === null) {
        cancelReader(reader);
        return signal.aborted ? "aborted" : "failed";
      }
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        cancelReader(reader);
        return "too-large";
      }
      chunks.push(item.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* The reader may already be closed. */
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return "failed";
  }
}

export interface JevHttpMetricsV1 {
  readonly attempts: number;
  readonly latencyMs: number;
  readonly httpStatus: number | null;
  readonly requestId: string | null;
}
export type JevHttpOutcomeV1 =
  | {
      readonly ok: true;
      readonly payload: unknown;
      readonly metrics: JevHttpMetricsV1;
    }
  | {
      readonly ok: false;
      readonly reasonCode: JevFallbackCodeV1;
      readonly metrics: JevHttpMetricsV1;
    };

export async function requestJevHttpV1(input: {
  readonly apiKey: string;
  readonly body: string;
  readonly deadlineMs: number;
  readonly maxRetries: number;
  readonly fetchImpl: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<JevHttpOutcomeV1> {
  const started = performance.now();
  let attempts = 0;
  let status: number | null = null;
  let requestId: string | null = null;
  let callerCancelled = false;
  let expired = false;
  const controller = new AbortController();
  const abortCaller = (): void => {
    callerCancelled = true;
    controller.abort();
  };
  input.signal?.addEventListener("abort", abortCaller, { once: true });
  const deadlineTimer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, input.deadlineMs);
  const latency = (): number =>
    Math.max(0, Math.min(5_000, Math.round(performance.now() - started)));
  const metrics = (): JevHttpMetricsV1 => ({
    attempts,
    latencyMs: latency(),
    httpStatus: status,
    requestId,
  });
  const error = (reasonCode: JevFallbackCodeV1): JevHttpOutcomeV1 => ({
    ok: false,
    reasonCode,
    metrics: metrics(),
  });

  try {
    for (let attempt = 0; attempt <= input.maxRetries; attempt += 1) {
      if (controller.signal.aborted)
        return error(callerCancelled ? "cancelled" : "deadline-exceeded");
      attempts += 1;
      let response: Response | null;
      try {
        response = await raceAbort(
          input.fetchImpl(JEV_ENDPOINT_V1, {
            method: "POST",
            redirect: "error",
            headers: {
              authorization: "Bearer " + input.apiKey,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: input.body,
            signal: controller.signal,
          }),
          controller.signal,
        );
      } catch {
        response = null;
      }
      if (response === null)
        return error(
          callerCancelled
            ? "cancelled"
            : expired
              ? "deadline-exceeded"
              : "transport-error",
        );
      status = response.status;
      requestId = getRequestId(response, input.apiKey);

      if (!response.ok) {
        cancelBody(response);
        if (status === 401 || status === 403) return error("authentication");
        if (status === 422) return error("invalid-request");
        if (status === 408) return error("deadline-exceeded");
        if (status === 429 || (status >= 500 && status <= 599)) {
          const code = status === 429 ? "rate-limited" : "service-unavailable";
          if (attempt < input.maxRetries) {
            const delay = retryDelay(response);
            if (latency() + delay >= input.deadlineMs) return error(code);
            const completed = await retryWait(delay, controller.signal);
            if (completed !== true)
              return error(callerCancelled ? "cancelled" : "deadline-exceeded");
            continue;
          }
          return error(code);
        }
        return error("http-error");
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (
        !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(contentType)
      )
        return error("invalid-response");
      const bodyResult = await readBoundedText(response, controller.signal);
      if (bodyResult === "too-large") return error("response-too-large");
      if (bodyResult === "aborted")
        return error(callerCancelled ? "cancelled" : "deadline-exceeded");
      if (bodyResult === "failed") return error("transport-error");
      let decoded: unknown;
      try {
        decoded = JSON.parse(bodyResult.text);
      } catch {
        return error("invalid-response");
      }
      if (!isPlainOwnDataJsonTreeV3(decoded)) return error("invalid-response");
      return { ok: true, payload: decoded, metrics: metrics() };
    }
    return error("transport-error");
  } finally {
    clearTimeout(deadlineTimer);
    input.signal?.removeEventListener("abort", abortCaller);
  }
}
