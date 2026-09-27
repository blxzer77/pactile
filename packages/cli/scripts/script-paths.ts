import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function isCliPackageRoot(candidate: string): boolean {
  try {
    const manifest: unknown = JSON.parse(
      fs.readFileSync(path.join(candidate, "package.json"), "utf8"),
    );
    return (
      manifest !== null &&
      typeof manifest === "object" &&
      (manifest as Record<string, unknown>).name === "@blxzer/pactile"
    );
  } catch {
    return false;
  }
}

export function resolveCliPackageRoot(moduleUrl: string): string {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  for (const candidate of [
    path.resolve(moduleDirectory, ".."),
    path.resolve(moduleDirectory, "../.."),
  ]) {
    if (isCliPackageRoot(candidate)) return candidate;
  }
  throw new Error(
    `Unable to locate the @blxzer/pactile package root from ${moduleUrl}.`,
  );
}

export function resolveRepositoryRoot(moduleUrl: string): string {
  return path.resolve(resolveCliPackageRoot(moduleUrl), "../..");
}
