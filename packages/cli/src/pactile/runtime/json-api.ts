import fs from "node:fs";
import {
  RuntimeError,
  assertCanonicalWriteTarget,
  caseFoldComponent,
  discoverRuntimeRoots,
  normalizeRuntimeRelativePath,
  resolveCanonicalPaths,
  type RuntimeFileSystem,
} from "./paths.js";

export type RuntimePathResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string } };

/** Small host-neutral JSON ABI for task and session consumers.
 * No lifecycle orchestration, private inputs, credentials or absolute diagnostics.
 */
export function handleRuntimePathRequest(
  input: unknown,
  io: RuntimeFileSystem = fs,
): RuntimePathResult {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input))
      throw new RuntimeError("state-malformed");
    const request = input as Record<string, unknown>;
    const keys = (allowed: string[]): void => {
      if (
        Object.keys(request).some((key) => !allowed.includes(key)) ||
        allowed.some((key) => typeof request[key] !== "string")
      )
        throw new RuntimeError("state-malformed");
    };
    const value = (key: string): string => {
      const item = request[key];
      if (typeof item !== "string") throw new RuntimeError("state-malformed");
      return item;
    };
    switch (request.operation) {
      case "normalize":
        keys(["operation", "path"]);
        return {
          ok: true,
          result: normalizeRuntimeRelativePath(value("path")),
        };
      case "fold":
        keys(["operation", "component"]);
        return { ok: true, result: caseFoldComponent(value("component")) };
      case "resolve": {
        keys(["operation", "projectRoot"]);
        const paths = resolveCanonicalPaths(value("projectRoot"));
        return {
          ok: true,
          result: Object.fromEntries(
            Object.entries(paths).map(([key, item]) => [
              key,
              item.replace(/\\/g, "/"),
            ]),
          ),
        };
      }
      case "discover":
        keys(["operation", "projectRoot"]);
        return {
          ok: true,
          result: discoverRuntimeRoots(value("projectRoot"), io),
        };
      case "guard":
        keys(["operation", "projectRoot", "target"]);
        return {
          ok: true,
          result: assertCanonicalWriteTarget(
            value("projectRoot"),
            value("target"),
            io,
          ).replace(/\\/g, "/"),
        };
      default:
        throw new RuntimeError("state-malformed");
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof RuntimeError ? error.code : "state-malformed",
      },
    };
  }
}
