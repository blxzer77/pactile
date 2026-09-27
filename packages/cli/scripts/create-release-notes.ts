import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function extractReleaseNotes(
  changelog: string,
  version: string,
): string {
  if (!version.trim()) {
    throw new Error("A release version is required to create release notes.");
  }

  const start = changelog.indexOf(`## [${version}]`);
  if (start < 0) {
    throw new Error(`CHANGELOG.md has no ## [${version}] section`);
  }

  const rest = changelog.slice(start);
  const next = rest.indexOf("\n## [", 1);
  return `${(next < 0 ? rest : rest.slice(0, next)).trim()}\n`;
}

function readPackageVersion(packagePath: string): string {
  const manifest: unknown = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    typeof (manifest as Record<string, unknown>).version !== "string"
  ) {
    throw new Error(`Package manifest has no string version: ${packagePath}`);
  }
  return (manifest as { version: string }).version;
}

export function writeReleaseNotes({
  outputPath,
  packagePath = path.resolve("packages/cli/package.json"),
  changelogPath = path.resolve("packages/cli/CHANGELOG.md"),
  expectedVersion,
}: {
  outputPath: string;
  packagePath?: string;
  changelogPath?: string;
  expectedVersion?: string;
}): void {
  if (!outputPath) {
    throw new Error("An output path is required to create release notes.");
  }
  const version = readPackageVersion(packagePath);
  if (expectedVersion !== undefined && expectedVersion !== version) {
    throw new Error(
      `VERSION ${expectedVersion} does not match package version ${version}.`,
    );
  }
  const changelog = fs.readFileSync(changelogPath, "utf8");
  const notes = extractReleaseNotes(changelog, version);
  fs.writeFileSync(outputPath, notes, "utf8");
}

function runCli(): void {
  const outputPath = process.argv[2];
  if (!outputPath) {
    throw new Error("Usage: create-release-notes <output-path>");
  }
  writeReleaseNotes({
    outputPath,
    expectedVersion: process.env.VERSION,
  });
}

const invokedAs = process.argv[1];
if (
  invokedAs &&
  import.meta.url === pathToFileURL(path.resolve(invokedAs)).href
) {
  try {
    runCli();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
