import process from "node:process";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const [moduleHref, root, eventJson] = process.argv.slice(2);
if (!moduleHref || !root || !eventJson) {
  throw new Error(
    "Usage: node trace-runtime-store-writer.js <module-url> <project-root> <event-json>",
  );
}

const event: unknown = JSON.parse(eventJson);
if (!isRecord(event)) throw new Error("Trace fixture event must be an object.");

const runtime: unknown = await import(moduleHref);
if (!isRecord(runtime) || typeof runtime.appendTrace !== "function") {
  throw new Error("Trace runtime fixture could not load appendTrace.");
}

type AppendTrace = (
  projectRoot: string,
  traceEvent: Record<string, unknown>,
  expectedHead: { sequence: number; fingerprint: null },
) => unknown;

try {
  (runtime.appendTrace as AppendTrace)(root, event, {
    sequence: 0,
    fingerprint: null,
  });
  process.stdout.write("appended");
} catch (error) {
  const code =
    isRecord(error) && typeof error.code === "string"
      ? error.code
      : "unexpected";
  process.stdout.write(code);
}
