import fs from "node:fs";
import path from "node:path";

import {
  parseProviderManifestV1,
  type ProviderManifestV1,
} from "../../core/index.js";

export const PROVIDER_MANIFEST_LOAD_DIAGNOSTIC_CODES_V1 = [
  "provider-root-unavailable",
  "provider-root-case-collision",
  "provider-directory-case-collision",
  "provider-directory-unsupported",
  "provider-manifest-count-exceeded",
  "provider-manifest-case-collision",
  "provider-manifest-entry-unsupported",
  "provider-manifest-read-failed",
  "provider-manifest-size-exceeded",
  "provider-manifest-json-invalid",
  "provider-manifest-contract-invalid",
  "provider-manifest-sensitive-content",
  "provider-manifest-duplicate",
] as const;

export type ProviderManifestLoadDiagnosticCodeV1 =
  (typeof PROVIDER_MANIFEST_LOAD_DIAGNOSTIC_CODES_V1)[number];

export interface ProviderManifestLoadDiagnosticV1 {
  readonly code: ProviderManifestLoadDiagnosticCodeV1;
  /** Stable logical location; never a caller path or filename. */
  readonly location: string;
}

export interface ProviderManifestLoadResultV1 {
  readonly ok: boolean;
  readonly manifests: readonly ProviderManifestV1[];
  readonly diagnostics: readonly ProviderManifestLoadDiagnosticV1[];
}

const MAX_PROVIDER_MANIFESTS = 256;
const MAX_PROVIDER_MANIFEST_BYTES = 1024 * 1024;
const SAFE_MANIFEST_TERM = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const SAFE_DESTINATION = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?$/;
const SENSITIVE_TERMS = new Set([
  "credential",
  "credentials",
  "passwd",
  "password",
  "secret",
  "token",
]);

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function foldedName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function containsSensitiveTerm(value: string): boolean {
  return value
    .replaceAll(":", ".")
    .split(/[._-]/u)
    .some((term) => SENSITIVE_TERMS.has(term));
}

function manifestStringsAreSafe(manifest: ProviderManifestV1): boolean {
  return (
    manifest.evidenceKinds.every(
      (kind) =>
        kind.length <= 128 &&
        SAFE_MANIFEST_TERM.test(kind) &&
        !containsSensitiveTerm(kind),
    ) &&
    manifest.policyCeiling.egressDestinations.every(
      (destination) =>
        destination.length <= 253 &&
        SAFE_DESTINATION.test(destination) &&
        !containsSensitiveTerm(destination),
    )
  );
}

function fail(
  diagnostics: readonly ProviderManifestLoadDiagnosticV1[],
): ProviderManifestLoadResultV1 {
  return { ok: false, manifests: [], diagnostics };
}

function directoryEntries(directory: string): readonly fs.Dirent[] | null {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
}

function exactDirectory(
  parent: string,
  expectedName: string,
  collisionCode:
    | "provider-root-case-collision"
    | "provider-directory-case-collision",
  missingIsEmpty: boolean,
):
  | { readonly kind: "found"; readonly path: string }
  | { readonly kind: "empty" }
  | { readonly kind: "failed"; readonly result: ProviderManifestLoadResultV1 } {
  const entries = directoryEntries(parent);
  if (entries === null) {
    return {
      kind: "failed",
      result: fail([
        { code: "provider-root-unavailable", location: ".pactile" },
      ]),
    };
  }
  const matches = entries.filter(
    (entry) => foldedName(entry.name) === foldedName(expectedName),
  );
  if (matches.length === 0) {
    return missingIsEmpty
      ? { kind: "empty" }
      : {
          kind: "failed",
          result: fail([
            { code: "provider-directory-unsupported", location: expectedName },
          ]),
        };
  }
  const exact = matches.find((entry) => entry.name === expectedName);
  if (
    matches.length !== 1 ||
    exact === undefined ||
    !exact.isDirectory() ||
    exact.isSymbolicLink()
  ) {
    return {
      kind: "failed",
      result: fail([{ code: collisionCode, location: expectedName }]),
    };
  }
  return { kind: "found", path: path.join(parent, expectedName) };
}

/**
 * Read the exact `.pactile/providers/*.json` catalog without mutating it.
 *
 * Any malformed, unknown, duplicate, case-colliding, link-like, unreadable,
 * or oversized entry invalidates the complete catalog. Diagnostics expose
 * only stable ordinal locations and reason codes.
 */
export function loadProviderManifestsV1(
  projectRoot: string,
): ProviderManifestLoadResultV1 {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    return fail([{ code: "provider-root-unavailable", location: ".pactile" }]);
  }

  const canonicalRoot = exactDirectory(
    projectRoot,
    ".pactile",
    "provider-root-case-collision",
    true,
  );
  if (canonicalRoot.kind === "empty") {
    return { ok: true, manifests: [], diagnostics: [] };
  }
  if (canonicalRoot.kind === "failed") return canonicalRoot.result;

  const providers = exactDirectory(
    canonicalRoot.path,
    "providers",
    "provider-directory-case-collision",
    true,
  );
  if (providers.kind === "empty") {
    return { ok: true, manifests: [], diagnostics: [] };
  }
  if (providers.kind === "failed") return providers.result;

  const unsortedEntries = directoryEntries(providers.path);
  if (unsortedEntries === null) {
    return fail([
      {
        code: "provider-directory-unsupported",
        location: ".pactile/providers",
      },
    ]);
  }
  const entries = [...unsortedEntries].sort((left, right) => {
    const folded = ordinalCompare(
      foldedName(left.name),
      foldedName(right.name),
    );
    return folded === 0 ? ordinalCompare(left.name, right.name) : folded;
  });
  if (entries.length > MAX_PROVIDER_MANIFESTS) {
    return fail([
      {
        code: "provider-manifest-count-exceeded",
        location: ".pactile/providers",
      },
    ]);
  }

  const diagnostics: ProviderManifestLoadDiagnosticV1[] = [];
  const seenNames = new Map<string, number>();
  const loaded: {
    readonly manifest: ProviderManifestV1;
    readonly location: string;
  }[] = [];

  entries.forEach((entry, index) => {
    const location = `providers[${index}]`;
    const folded = foldedName(entry.name);
    if (seenNames.has(folded)) {
      diagnostics.push({ code: "provider-manifest-case-collision", location });
      return;
    }
    seenNames.set(folded, index);

    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !entry.name.endsWith(".json")
    ) {
      diagnostics.push({
        code: "provider-manifest-entry-unsupported",
        location,
      });
      return;
    }

    const manifestPath = path.join(providers.path, entry.name);
    let bytes: Buffer;
    try {
      const stat = fs.lstatSync(manifestPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        diagnostics.push({
          code: "provider-manifest-entry-unsupported",
          location,
        });
        return;
      }
      if (stat.size > MAX_PROVIDER_MANIFEST_BYTES) {
        diagnostics.push({ code: "provider-manifest-size-exceeded", location });
        return;
      }
      bytes = fs.readFileSync(manifestPath);
    } catch {
      diagnostics.push({ code: "provider-manifest-read-failed", location });
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      diagnostics.push({ code: "provider-manifest-json-invalid", location });
      return;
    }
    const parsed = parseProviderManifestV1(value);
    if (!parsed.success) {
      diagnostics.push({
        code: "provider-manifest-contract-invalid",
        location,
      });
      return;
    }
    if (!manifestStringsAreSafe(parsed.data)) {
      diagnostics.push({
        code: "provider-manifest-sensitive-content",
        location,
      });
      return;
    }
    loaded.push({ manifest: parsed.data, location });
  });

  const seenIdentities = new Set<string>();
  for (const item of loaded) {
    const identity = `${item.manifest.id}\u0000${item.manifest.version}`;
    if (seenIdentities.has(identity)) {
      diagnostics.push({
        code: "provider-manifest-duplicate",
        location: item.location,
      });
    } else {
      seenIdentities.add(identity);
    }
  }

  if (diagnostics.length > 0) return fail(diagnostics);
  return {
    ok: true,
    manifests: loaded
      .map((item) => item.manifest)
      .sort((left, right) =>
        ordinalCompare(
          `${left.id}\u0000${left.version}`,
          `${right.id}\u0000${right.version}`,
        ),
      ),
    diagnostics: [],
  };
}
