/**
 * Canonical Pactile environment access with a bounded 0.5.x legacy-read
 * bridge.  Callers write only the canonical key; legacy values are never
 * copied back into the process environment.
 */

export const PACTILE_ENVIRONMENT_KEYS = {
  debug: "PACTILE_DEBUG",
  allowHomeDirectory: "PACTILE_ALLOW_HOMEDIR",
  skipPythonCheck: "PACTILE_SKIP_PYTHON_CHECK",
  pythonCommand: "PACTILE_PYTHON_CMD",
  channelRoot: "PACTILE_CHANNEL_ROOT",
  channelProject: "PACTILE_CHANNEL_PROJECT",
  hooks: "PACTILE_HOOKS",
  channel: "PACTILE_CHANNEL",
  channelActor: "PACTILE_CHANNEL_AS",
  channelWorkerIdleTimeout: "PACTILE_CHANNEL_WORKER_IDLE_TIMEOUT",
  channelMaxLiveWorkers: "PACTILE_CHANNEL_MAX_LIVE_WORKERS",
  kernelCli: "PACTILE_KERNEL_CLI",
  skipSmartSearchPostinstall: "PACTILE_SKIP_SMART_SEARCH_POSTINSTALL",
} as const;

export type PactileEnvironmentKey =
  (typeof PACTILE_ENVIRONMENT_KEYS)[keyof typeof PACTILE_ENVIRONMENT_KEYS];

const LEGACY_ENVIRONMENT_KEYS = {
  PACTILE_DEBUG: ["CSTL_DEBUG", "TRELLIS_DEBUG"],
  PACTILE_ALLOW_HOMEDIR: ["CSTL_ALLOW_HOMEDIR", "TRELLIS_ALLOW_HOMEDIR"],
  PACTILE_SKIP_PYTHON_CHECK: [
    "CSTL_SKIP_PYTHON_CHECK",
    "TRELLIS_SKIP_PYTHON_CHECK",
  ],
  PACTILE_PYTHON_CMD: ["CSTL_PYTHON_CMD", "TRELLIS_PYTHON_CMD"],
  PACTILE_CHANNEL_ROOT: ["CSTL_CHANNEL_ROOT", "TRELLIS_CHANNEL_ROOT"],
  PACTILE_CHANNEL_PROJECT: [
    "CSTL_CHANNEL_PROJECT",
    "TRELLIS_CHANNEL_PROJECT",
  ],
  PACTILE_HOOKS: ["CSTL_HOOKS", "TRELLIS_HOOKS"],
  PACTILE_CHANNEL: ["CSTL_CHANNEL", "TRELLIS_CHANNEL"],
  PACTILE_CHANNEL_AS: ["CSTL_CHANNEL_AS", "TRELLIS_CHANNEL_AS"],
  PACTILE_CHANNEL_WORKER_IDLE_TIMEOUT: [
    "CSTL_CHANNEL_WORKER_IDLE_TIMEOUT",
    "TRELLIS_CHANNEL_WORKER_IDLE_TIMEOUT",
  ],
  PACTILE_CHANNEL_MAX_LIVE_WORKERS: [
    "CSTL_CHANNEL_MAX_LIVE_WORKERS",
    "TRELLIS_CHANNEL_MAX_LIVE_WORKERS",
  ],
  PACTILE_KERNEL_CLI: ["CSTL_KERNEL_CLI", "TRELLIS_KERNEL_CLI"],
  PACTILE_SKIP_SMART_SEARCH_POSTINSTALL: [
    "CSTL_SKIP_SMART_SEARCH_POSTINSTALL",
    "TRELLIS_SKIP_SMART_SEARCH_POSTINSTALL",
  ],
} as const satisfies Record<PactileEnvironmentKey, readonly string[]>;

export interface PactileEnvironmentDiagnostic {
  readonly code: "legacy-environment-read";
  readonly canonicalKey: PactileEnvironmentKey;
  readonly legacyKey: string;
  readonly compatibilityWindow: "0.5.x";
}

export interface ReadPactileEnvironmentOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly report?: (diagnostic: PactileEnvironmentDiagnostic) => void;
  readonly warnOnce?: boolean;
}

const warnedLegacyKeys = new Set<string>();

function defaultReporter(diagnostic: PactileEnvironmentDiagnostic): void {
  process.stderr.write(
    `[pactile compatibility] ${diagnostic.legacyKey} is deprecated; use ${diagnostic.canonicalKey}. Legacy reads end no earlier than 0.6.0.\n`,
  );
}

/**
 * Read one public Pactile environment value. Canonical always wins. A legacy
 * fallback reports key names only, never the value, and warns once per process
 * by default.
 */
export function readPactileEnvironment(
  key: PactileEnvironmentKey,
  options: ReadPactileEnvironmentOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const canonical = env[key];
  if (canonical !== undefined) return canonical;

  for (const legacyKey of LEGACY_ENVIRONMENT_KEYS[key]) {
    const legacy = env[legacyKey];
    if (legacy === undefined) continue;
    if (options.warnOnce === false || !warnedLegacyKeys.has(legacyKey)) {
      (options.report ?? defaultReporter)({
        code: "legacy-environment-read",
        canonicalKey: key,
        legacyKey,
        compatibilityWindow: "0.5.x",
      });
      if (options.warnOnce !== false) warnedLegacyKeys.add(legacyKey);
    }
    return legacy;
  }
  return undefined;
}

/** Write only the canonical key. This intentionally never mirrors aliases. */
export function writePactileEnvironment(
  key: PactileEnvironmentKey,
  value: string,
  env: Record<string, string | undefined> = process.env,
): void {
  env[key] = value;
}

/** Test-only hook for deterministic once-per-process diagnostic assertions. */
export function resetPactileEnvironmentWarningsForTest(): void {
  warnedLegacyKeys.clear();
}
