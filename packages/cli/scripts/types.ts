export interface CommandOptions {
  cwd?: string;
  capture?: boolean;
  env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (
  command: string,
  args?: string[],
  options?: CommandOptions,
) => string;

export interface PackageVersions {
  cliName: string;
  cliVersion: string;
}

export interface PackageInfo extends PackageVersions {
  cliDir: string;
}

export interface CliPackageManifest extends Record<string, unknown> {
  name: string;
  version: string;
  private?: boolean;
  engines?: { node?: string };
  exports?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  bin?: Record<string, unknown>;
}

export interface ReleasePackageDefinition {
  key: "cli";
  name: string;
  version: string;
  packageDir?: string;
}

export interface ReleasePackagePlan {
  name: string;
  publish: boolean;
  alreadyOnNpm: boolean | null;
}

export interface PublishPlan {
  version: string;
  tag: string;
  cli: ReleasePackagePlan;
  registryChecked?: boolean;
}

export interface ReleaseArtifactRecord {
  key: "cli";
  name: string;
  version: string;
  filename: string;
  size: number;
  sha256: string;
  tarballPath?: string;
}

export interface PreparedReleaseArtifacts {
  schemaVersion: 2;
  version: string;
  npmTag: string;
  releaseTag: string | null;
  commit: string;
  packages: (ReleaseArtifactRecord & { tarballPath: string })[];
  manifestPath: string;
  manifestSha256: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
