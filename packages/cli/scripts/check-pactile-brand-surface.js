#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLASSIFICATIONS = ["live", "compat", "history", "attribution"];
const ACTIONS = ["rewrite", "merge", "redirect", "archive"];
const REQUIRED_RENAME_KINDS = [
  "product",
  "package",
  "bin",
  "runtime-directory",
  "environment-prefix",
  "managed-marker",
  "managed-block",
  "command-skill-prefix",
  "release-tag",
  "repository-url",
  "documentation-url",
  "compatibility-alias",
];
const REQUIRED_GITHUB_SURFACES = [
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "SUPPORT.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
];
const REQUIRED_ADOPTION_OPERATIONS = [
  "install",
  "adopt",
  "bind",
  "conflict",
  "degraded",
];
const REQUIRED_COMMAND_SMOKE = [
  "pactile --version",
  "pactile init --codex",
  "pactile capability-smoke --json",
  "pactile update",
  "pactile detach codex",
  "pactile uninstall",
];
const CONTRACT_IDS = {
  inventory: "pactile.brand-inventory/v1",
  renameMap: "pactile.rename-map/v1",
  documentationMap: "pactile.documentation-map/v1",
};
const CANONICAL_POLICY_DIGESTS = {
  inventory: "541ec8c277cc1193a53593b7164c4f6a1d63b2b9f7f38a1484b730842a7ebc84",
  renameMap: "e7e3a0eeb7ba5c97b5ed614b13c8ac628e9e3781d57ec763be06f405bb1b91aa",
  documentationMap:
    "03942755efb2d1bedc1689af353ae972d31bbeeb4804e00c1e0c2ca99b083c29",
};
const REQUIRED_TOKEN_IDS = [
  "legacy-product-name",
  "legacy-cstl-token",
  "legacy-trellis-token",
  "legacy-runtime-path",
  "upstream-runtime-path",
  "legacy-package-name",
  "legacy-environment-name",
  "legacy-managed-marker",
  "cursor-plus-plus",
];
const REQUIRED_DOCUMENTATION_SOURCES = [
  ".github/workflows/ci.yml",
  ".github/workflows/publish.yml",
  "AGENTS.md",
  "PERSONAL_SKILLS_TRELLIS_INTEGRATION_RESEARCH.md",
  "README.md",
  "README.zh-CN.md",
  "docs/agent-tooling-narrative.zh-CN.md",
  "docs/architecture.md",
  "docs/architecture.zh-CN.md",
  "docs/campaign-ui.md",
  "docs/community/linux-do-release.md",
  "docs/cursor-platform-limitations-and-trellis-adaptation.md",
  "docs/cursor-platform-limitations-and-trellis-adaptation.zh-CN.md",
  "docs/cursor-trellis-release-coexistence-guide.md",
  "docs/cursor.md",
  "docs/cursor.zh-CN.md",
  "docs/pactile/contracts-v1.md",
  "docs/pactile/compatibility-inputs.md",
  "docs/pactile/compatibility-inputs.zh-CN.md",
  "docs/retrieval.md",
  "docs/retrieval.zh-CN.md",
  "docs/skills.md",
  "docs/skills.zh-CN.md",
  "docs/spec-system.md",
  "docs/spec-system.zh-CN.md",
  "docs/subagents.md",
  "docs/subagents.zh-CN.md",
  "docs/task-system.md",
  "docs/task-system.zh-CN.md",
  "docs/workflow.md",
  "docs/workflow.zh-CN.md",
  "examples/minimal-agent-app/README.md",
  "packages/cli/CHANGELOG.md",
  "packages/cli/README.md",
  "packages/cli/README.zh-CN.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "docs/capabilities/index.md",
  "docs/capabilities/index.zh-CN.md",
  "docs/capabilities/mcp.md",
  "docs/capabilities/mcp.zh-CN.md",
  "docs/capabilities/native-adoption.md",
  "docs/capabilities/native-adoption.zh-CN.md",
  "docs/capabilities/privacy-and-permissions.md",
  "docs/capabilities/privacy-and-permissions.zh-CN.md",
  "docs/capabilities/providers.md",
  "docs/capabilities/providers.zh-CN.md",
  "docs/capabilities/retrieval.md",
  "docs/capabilities/retrieval.zh-CN.md",
  "docs/capabilities/skills.md",
  "docs/capabilities/skills.zh-CN.md",
  "docs/capabilities/subagents.md",
  "docs/capabilities/subagents.zh-CN.md",
  "docs/concepts/architecture.md",
  "docs/concepts/architecture.zh-CN.md",
  "docs/concepts/index.md",
  "docs/concepts/index.zh-CN.md",
  "docs/concepts/kernel-evidence-trace.md",
  "docs/concepts/kernel-evidence-trace.zh-CN.md",
  "docs/concepts/projection-and-ownership.md",
  "docs/concepts/projection-and-ownership.zh-CN.md",
  "docs/concepts/spec-system.md",
  "docs/concepts/spec-system.zh-CN.md",
  "docs/concepts/task-system.md",
  "docs/concepts/task-system.zh-CN.md",
  "docs/concepts/tiles.md",
  "docs/concepts/tiles.zh-CN.md",
  "docs/governance/compatibility.md",
  "docs/governance/compatibility.zh-CN.md",
  "docs/governance/contributing.md",
  "docs/governance/contributing.zh-CN.md",
  "docs/governance/index.md",
  "docs/governance/index.zh-CN.md",
  "docs/governance/releasing.md",
  "docs/governance/releasing.zh-CN.md",
  "docs/governance/security.md",
  "docs/governance/security.zh-CN.md",
  "docs/history/campaign-ui.md",
  "docs/history/cursor-plus-plus.md",
  "docs/history/cursor-plus-plus.zh-CN.md",
  "docs/history/index.md",
  "docs/history/index.zh-CN.md",
  "docs/history/community/linux-do-release.md",
  "docs/history/research/personal-skills-integration.md",
  "docs/hosts/codex.md",
  "docs/hosts/codex.zh-CN.md",
  "docs/hosts/coexistence.md",
  "docs/hosts/coexistence.zh-CN.md",
  "docs/hosts/cursor-limitations.md",
  "docs/hosts/cursor-limitations.zh-CN.md",
  "docs/hosts/cursor.md",
  "docs/hosts/cursor.zh-CN.md",
  "docs/hosts/index.md",
  "docs/hosts/index.zh-CN.md",
  "docs/lifecycle/detach-and-uninstall.md",
  "docs/lifecycle/detach-and-uninstall.zh-CN.md",
  "docs/lifecycle/index.md",
  "docs/lifecycle/index.zh-CN.md",
  "docs/lifecycle/install.md",
  "docs/lifecycle/install.zh-CN.md",
  "docs/lifecycle/rollback-and-purge.md",
  "docs/lifecycle/rollback-and-purge.zh-CN.md",
  "docs/lifecycle/upgrade-and-migrate.md",
  "docs/lifecycle/upgrade-and-migrate.zh-CN.md",
  "docs/lifecycle/workflow.md",
  "docs/lifecycle/workflow.zh-CN.md",
  "docs/troubleshooting/doctor.md",
  "docs/troubleshooting/doctor.zh-CN.md",
  "docs/troubleshooting/index.md",
  "docs/troubleshooting/index.zh-CN.md",
  "docs/troubleshooting/known-limitations.md",
  "docs/troubleshooting/known-limitations.zh-CN.md",
  "docs/troubleshooting/recovery.md",
  "docs/troubleshooting/recovery.zh-CN.md",
  "examples/minimal-agent-app/README.zh-CN.md",
];
const REQUIRED_HISTORY_DOCUMENTATION_SOURCES = [
  "PERSONAL_SKILLS_TRELLIS_INTEGRATION_RESEARCH.md",
  "docs/campaign-ui.md",
  "docs/community/linux-do-release.md",
  "packages/cli/CHANGELOG.md",
  "docs/history/campaign-ui.md",
  "docs/history/cursor-plus-plus.md",
  "docs/history/cursor-plus-plus.zh-CN.md",
  "docs/history/index.md",
  "docs/history/index.zh-CN.md",
  "docs/history/community/linux-do-release.md",
  "docs/history/research/personal-skills-integration.md",
];
const REQUIRED_COMPAT_DOCUMENTATION_SOURCES = [
  "docs/pactile/compatibility-inputs.md",
  "docs/pactile/compatibility-inputs.zh-CN.md",
  "docs/cursor-platform-limitations-and-trellis-adaptation.md",
  "docs/cursor-platform-limitations-and-trellis-adaptation.zh-CN.md",
  "docs/cursor-trellis-release-coexistence-guide.md",
];
const REQUIRED_TOPICS = [
  "tiles",
  "kernel",
  "evidence",
  "trace",
  "projection",
  "ownership",
  "cursor",
  "codex",
  "coexistence",
  "skills",
  "mcp",
  "native-adoption",
  "retrieval",
  "providers",
  "privacy",
  "install",
  "upgrade",
  "migration",
  "detach",
  "uninstall",
  "rollback",
  "purge",
  "doctor",
  "recovery",
  "governance",
  "release",
];
const REQUIRED_OWNER_LANES = [
  "batch-3-brand-runtime",
  "batch-4-docs-entry-concepts",
  "batch-4-docs-hosts-capabilities",
  "batch-4-docs-lifecycle-support",
  "batch-4-docs-governance-history",
];
const REQUIRED_NAVIGATION_GROUPS = [
  "entry",
  "machine-surface",
  "concepts",
  "hosts",
  "capabilities",
  "lifecycle",
  "troubleshooting",
  "governance",
  "history",
];
const REQUIRED_PAGE_STATUSES = [
  "rewrite",
  "rewrite-and-add-locale-peer",
  "planned",
  "archive-original-language",
  "preserve-in-place",
];
const REQUIRED_TARGET_PAGE_IDS = [
  "entry.repo",
  "entry.cli-package",
  "entry.example-minimal",
  "repo.agents",
  "github.ci",
  "github.publish",
  "concepts.index",
  "concepts.architecture",
  "concepts.tiles",
  "concepts.kernel-evidence-trace",
  "concepts.projection-ownership",
  "concepts.spec-system",
  "concepts.task-system",
  "hosts.index",
  "hosts.cursor",
  "hosts.cursor-limitations",
  "hosts.codex",
  "hosts.coexistence",
  "capabilities.index",
  "capabilities.skills",
  "capabilities.mcp",
  "capabilities.native-adoption",
  "capabilities.retrieval",
  "capabilities.providers",
  "capabilities.privacy",
  "capabilities.subagents",
  "lifecycle.index",
  "lifecycle.install",
  "lifecycle.workflow",
  "lifecycle.upgrade-migrate",
  "lifecycle.detach-uninstall",
  "lifecycle.rollback-purge",
  "troubleshooting.index",
  "troubleshooting.doctor",
  "troubleshooting.recovery",
  "troubleshooting.known-limitations",
  "governance.index",
  "governance.contributing",
  "governance.security",
  "governance.compatibility",
  "governance.releasing",
  "history.index",
  "history.cursor-plus-plus",
  "history.campaign-ui",
  "history.community-linux-do",
  "history.research-personal-skills",
  "history.release-changelog",
];
const P23_HISTORY_PAGE = "history.cursor-plus-plus";
const REQUIRED_P23_SOURCE_PATHS = [
  "README.md",
  "README.zh-CN.md",
  "packages/cli/README.md",
  "packages/cli/README.zh-CN.md",
  "docs/cursor-platform-limitations-and-trellis-adaptation.md",
  "docs/cursor-platform-limitations-and-trellis-adaptation.zh-CN.md",
  "docs/cursor.md",
  "docs/cursor.zh-CN.md",
  "docs/retrieval.md",
  "docs/retrieval.zh-CN.md",
  "docs/skills.md",
  "docs/skills.zh-CN.md",
  "docs/subagents.md",
  "docs/subagents.zh-CN.md",
];

function defaultRepoRoot() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, "../../..");
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort((a, b) => a.localeCompare(b));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => [key, canonicalJson(value[key])]),
  );
}

function jsonDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(value)))
    .digest("hex");
}

function inventoryPolicyDigest(inventory) {
  const {
    baselineSnapshot: _snapshot,
    capturedAtUtc: _capturedAt,
    ...policy
  } = inventory;
  return jsonDigest(policy);
}

function exactSetErrors(label, expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((value) => !actualSet.has(value));
  const unexpected = actual.filter((value) => !expectedSet.has(value));
  const errors = [];
  if (missing.length > 0) {
    errors.push(`${label} missing: ${missing.join(", ")}`);
  }
  if (unexpected.length > 0) {
    errors.push(`${label} unexpected: ${unexpected.join(", ")}`);
  }
  return errors;
}

function gitInventoryFiles(repoRoot) {
  const raw = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return raw
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .sort((a, b) => a.localeCompare(b));
}

function isThinConnectedCheckout(repoRoot) {
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  return (
    fs.existsSync(agentsPath) &&
    /\bthin-connect(?:ed)?\b/iu.test(fs.readFileSync(agentsPath, "utf8"))
  );
}

function walkFiles(rootDir, relativeDir) {
  const absoluteDir = path.join(rootDir, ...relativeDir.split("/"));
  if (!fs.existsSync(absoluteDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = normalizePath(
      path.posix.join(relativeDir, entry.name),
    );
    if (entry.isDirectory()) {
      out.push(...walkFiles(rootDir, relativePath));
    } else if (entry.isFile()) {
      out.push(relativePath);
    }
  }
  return out;
}

/**
 * Include every tracked and non-ignored untracked file. Brand-sensitive files
 * must not escape the guard merely because Batch 3 work is still uncommitted.
 */
function inventoryFiles(repoRoot, trackedFiles) {
  const controlFiles = [
    ...walkFiles(repoRoot, "docs/pactile"),
    "packages/cli/scripts/check-pactile-brand-surface.js",
    "packages/cli/test/docs/pactile-brand-surface.test.ts",
  ].filter((relativePath) =>
    fs.existsSync(path.join(repoRoot, ...relativePath.split("/"))),
  );
  const thinConnected = isThinConnectedCheckout(repoRoot);
  return sortedUnique([...trackedFiles, ...controlFiles]).filter(
    (relativePath) =>
      // Thin-connected CI materializes the harness-owned templates into these
      // paths solely for integration tests. They are not product-owned source
      // and must not become brand debt or snapshot input.
      !(
        thinConnected &&
        (relativePath === ".pactile/scripts" ||
          relativePath.startsWith(".pactile/scripts/") ||
          relativePath === ".cursor" ||
          relativePath.startsWith(".cursor/"))
      ) && fs.existsSync(path.join(repoRoot, ...relativePath.split("/"))),
  );
}

function compileRegex(pattern, flags, label) {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(
      `${label} has invalid regex ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function compileInventoryPolicy(inventory) {
  const tokenRules = (
    Array.isArray(inventory.tokenRules) ? inventory.tokenRules : []
  ).map((rule) => {
    const flags = rule.flags.includes("g") ? rule.flags : `${rule.flags}g`;
    return { ...rule, regex: compileRegex(rule.pattern, flags, rule.id) };
  });
  const pathClassifiers = (
    Array.isArray(inventory.pathClassifiers) ? inventory.pathClassifiers : []
  ).map((rule, index) => ({
    ...rule,
    regex: compileRegex(rule.pathRegex, "u", `pathClassifiers[${index}]`),
  }));
  const livePathAllowlist = (
    Array.isArray(inventory.livePathAllowlist)
      ? inventory.livePathAllowlist
      : []
  ).map((pattern, index) =>
    compileRegex(pattern, "u", `livePathAllowlist[${index}]`),
  );
  return { tokenRules, pathClassifiers, livePathAllowlist };
}

function classifyOccurrence(relativePath, policy) {
  for (const rule of policy.pathClassifiers) {
    if (rule.regex.test(relativePath)) return rule.classification;
  }
  if (policy.livePathAllowlist.some((regex) => regex.test(relativePath))) {
    return "live";
  }
  return "unclassified";
}

function scanLegacyTokens(repoRoot, files, inventory) {
  const policy = compileInventoryPolicy(inventory);
  const exclusions = new Set(
    (Array.isArray(inventory.scanExclusions)
      ? inventory.scanExclusions
      : []
    ).map((entry) => normalizePath(entry.path)),
  );
  const occurrences = [];
  const readErrors = [];

  const recordMatches = ({ relativePath, text, location, line = null }) => {
    for (const rule of policy.tokenRules) {
      rule.regex.lastIndex = 0;
      let match = rule.regex.exec(text);
      while (match !== null) {
        occurrences.push({
          path: relativePath,
          line,
          location,
          token: rule.id,
          match: match[0],
          classification: classifyOccurrence(relativePath, policy),
        });
        if (match[0].length === 0) rule.regex.lastIndex += 1;
        match = rule.regex.exec(text);
      }
    }
  };

  for (const relativePath of files) {
    // Path names are a live user-facing surface even when the payload is binary.
    recordMatches({ relativePath, text: relativePath, location: "path" });
    if (exclusions.has(relativePath)) continue;
    const absolutePath = path.join(repoRoot, ...relativePath.split("/"));
    let buffer;
    try {
      buffer = fs.readFileSync(absolutePath);
    } catch (error) {
      readErrors.push(
        `${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (buffer.includes(0)) continue;
    const lines = buffer.toString("utf8").split(/\r?\n/u);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      recordMatches({
        relativePath,
        text: line,
        location: "content",
        line: lineIndex + 1,
      });
    }
  }

  return { occurrences, readErrors };
}

function buildSnapshot(occurrences) {
  const buckets = new Map();
  const byClassification = {};
  const byToken = {};
  const files = new Set();

  for (const occurrence of occurrences) {
    files.add(occurrence.path);
    byClassification[occurrence.classification] =
      (byClassification[occurrence.classification] ?? 0) + 1;
    byToken[occurrence.token] = (byToken[occurrence.token] ?? 0) + 1;
    const key = [
      occurrence.path,
      occurrence.location,
      occurrence.token,
      occurrence.classification,
      occurrence.match.toLocaleLowerCase("en-US"),
    ].join("\0");
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  const normalizedRows = [...buckets.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const sha256 = createHash("sha256")
    .update(JSON.stringify(normalizedRows))
    .digest("hex");

  return {
    sha256,
    occurrences: occurrences.length,
    files: files.size,
    byClassification: Object.fromEntries(
      Object.entries(byClassification).sort(([a], [b]) => a.localeCompare(b)),
    ),
    byToken: Object.fromEntries(
      Object.entries(byToken).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

function snapshotsEqual(expected, actual) {
  return JSON.stringify(expected) === JSON.stringify(actual);
}

function discoverDocumentationSurface(trackedFiles, documentationMap) {
  const include = documentationMap.discovery.includePathRegexes.map(
    (pattern, index) =>
      compileRegex(pattern, "u", `discovery.includePathRegexes[${index}]`),
  );
  const exclude = documentationMap.discovery.excludePathRegexes.map(
    (pattern, index) =>
      compileRegex(pattern, "u", `discovery.excludePathRegexes[${index}]`),
  );
  return trackedFiles
    .filter((relativePath) => include.some((regex) => regex.test(relativePath)))
    .filter(
      (relativePath) => !exclude.some((regex) => regex.test(relativePath)),
    )
    .sort((a, b) => a.localeCompare(b));
}

function validateBrandInventory(inventory, scan, snapshot, releaseMode) {
  const errors = [];
  if (inventory.schemaVersion !== 1) {
    errors.push("brand-inventory.json schemaVersion must be 1");
  }
  if (inventory.contractId !== CONTRACT_IDS.inventory) {
    errors.push(
      `brand-inventory.json contractId must be ${CONTRACT_IDS.inventory}`,
    );
  }
  if (inventory.status !== "batch-0-baseline") {
    errors.push("brand-inventory.json status must be batch-0-baseline");
  }
  const policyDigest = inventoryPolicyDigest(inventory);
  if (policyDigest !== CANONICAL_POLICY_DIGESTS.inventory) {
    errors.push(
      `brand-inventory.json canonical policy digest mismatch: expected ${CANONICAL_POLICY_DIGESTS.inventory}, actual ${policyDigest}`,
    );
  }

  const tokenIds = inventory.tokenRules.map((rule) => rule.id);
  errors.push(
    ...exactSetErrors(
      "brand inventory token rules",
      sortedUnique(REQUIRED_TOKEN_IDS),
      sortedUnique(tokenIds),
    ),
  );
  for (const duplicate of duplicateValues(tokenIds)) {
    errors.push(`brand-inventory.json duplicate token id: ${duplicate}`);
  }
  for (const rule of inventory.tokenRules) {
    compileRegex(rule.pattern, rule.flags, rule.id);
    if (typeof rule.replacement !== "string" || rule.replacement.length === 0) {
      errors.push(`token ${rule.id} must declare a replacement policy`);
    }
  }

  if (!Array.isArray(inventory.lineClassifiers)) {
    errors.push("brand-inventory.json lineClassifiers must be an array");
  } else if (inventory.lineClassifiers.length > 0) {
    errors.push(
      "brand-inventory.json lineClassifiers must stay empty; classification is path-scoped so broad line wording cannot exempt live legacy tokens",
    );
  }

  const exclusionPaths = inventory.scanExclusions.map((entry) => entry.path);
  for (const duplicate of duplicateValues(exclusionPaths)) {
    errors.push(`brand inventory duplicate scan exclusion: ${duplicate}`);
  }
  for (const entry of inventory.scanExclusions) {
    if (!entry.reason) {
      errors.push(`scan exclusion ${entry.path} needs a reason`);
    }
  }

  for (const [groupName, rules] of [
    ["pathClassifiers", inventory.pathClassifiers],
    ["lineClassifiers", inventory.lineClassifiers],
  ]) {
    for (const [index, rule] of rules.entries()) {
      if (!CLASSIFICATIONS.includes(rule.classification)) {
        errors.push(
          `${groupName}[${index}] has invalid classification ${rule.classification}`,
        );
      }
      if (!rule.reason || !rule.exitCondition) {
        errors.push(`${groupName}[${index}] needs reason and exitCondition`);
      }
    }
  }

  errors.push(...scan.readErrors.map((error) => `scan read error: ${error}`));
  const unclassified = scan.occurrences.filter(
    (occurrence) => occurrence.classification === "unclassified",
  );
  for (const occurrence of unclassified.slice(0, 50)) {
    errors.push(
      `unclassified legacy token ${occurrence.token} at ${occurrence.path}:${occurrence.line} (${JSON.stringify(occurrence.match)})`,
    );
  }
  if (unclassified.length > 50) {
    errors.push(
      `${unclassified.length - 50} more unclassified occurrences omitted`,
    );
  }

  if (!snapshotsEqual(inventory.baselineSnapshot, snapshot)) {
    errors.push(
      `brand inventory snapshot drift: expected ${inventory.baselineSnapshot.sha256}, actual ${snapshot.sha256}; run with --print-snapshot and classify the change`,
    );
  }

  if (releaseMode) {
    const live = scan.occurrences.filter(
      (occurrence) => occurrence.classification === "live",
    );
    if (live.length > 0) {
      const examples = live
        .slice(0, 12)
        .map((occurrence) => {
          const location =
            occurrence.location === "path" ? " (path)" : `:${occurrence.line}`;
          return `${occurrence.path}${location} ${occurrence.token}`;
        })
        .join(", ");
      errors.push(
        `stable-release mode rejects ${live.length} live legacy-token occurrences; examples: ${examples}`,
      );
    }
  }

  return errors;
}

function validateRenameMap(renameMap) {
  const errors = [];
  if (renameMap.schemaVersion !== 1) {
    errors.push("rename-map.json schemaVersion must be 1");
  }
  if (renameMap.contractId !== CONTRACT_IDS.renameMap) {
    errors.push(`rename-map.json contractId must be ${CONTRACT_IDS.renameMap}`);
  }
  if (renameMap.status !== "batch-0-frozen-input") {
    errors.push("rename-map.json status must be batch-0-frozen-input");
  }
  const contractDigest = jsonDigest(renameMap);
  if (contractDigest !== CANONICAL_POLICY_DIGESTS.renameMap) {
    errors.push(
      `rename-map.json canonical contract digest mismatch: expected ${CANONICAL_POLICY_DIGESTS.renameMap}, actual ${contractDigest}`,
    );
  }
  const expectedCanonical = {
    product: "Pactile",
    pronunciation: "PACK-tile",
    cli: "pactile",
    runtimeDirectory: ".pactile/",
    environmentPrefix: "PACTILE_",
    markerPrefix: "PACTILE",
    cliPackage: "@blxzer/pactile",
    corePackage: "@blxzer/pactile-core",
    repositorySlug: "pactile",
    releaseTagPrefix: "pactile-v",
  };
  for (const [key, value] of Object.entries(expectedCanonical)) {
    if (renameMap.canonical?.[key] !== value) {
      errors.push(`rename-map canonical.${key} must be ${value}`);
    }
  }

  const entityIds = renameMap.entities.map((entry) => entry.id);
  for (const duplicate of duplicateValues(entityIds)) {
    errors.push(`rename-map duplicate entity id: ${duplicate}`);
  }
  const kinds = new Set(renameMap.entities.map((entry) => entry.kind));
  for (const kind of REQUIRED_RENAME_KINDS) {
    if (!kinds.has(kind)) errors.push(`rename-map missing kind: ${kind}`);
  }
  for (const entry of renameMap.entities) {
    if (!Array.isArray(entry.sources) || entry.sources.length === 0) {
      errors.push(`rename entity ${entry.id} needs at least one source`);
    }
    if (!entry.target || !entry.strategy || !entry.ownerLane) {
      errors.push(
        `rename entity ${entry.id} needs target, strategy, and ownerLane`,
      );
    }
    if (!CLASSIFICATIONS.includes(entry.classification)) {
      errors.push(
        `rename entity ${entry.id} has invalid classification ${entry.classification}`,
      );
    }
    if (!entry.reason || !entry.exitCondition) {
      errors.push(`rename entity ${entry.id} needs reason and exitCondition`);
    }
  }

  const operations = renameMap.nativeAdoptionModel.states.map(
    (state) => state.operation,
  );
  errors.push(
    ...exactSetErrors(
      "native adoption operations",
      REQUIRED_ADOPTION_OPERATIONS,
      sortedUnique(operations),
    ),
  );
  for (const duplicate of duplicateValues(operations)) {
    errors.push(`native adoption operation must be unique: ${duplicate}`);
  }
  const expectedObservedState = {
    install: "pactile-composed-or-generated-projection-absent",
    adopt: "semantically-compatible-preexisting",
    bind: "installed-or-adopted",
    conflict: "same-id-different-semantics",
    degraded: "malformed-locked-or-untrusted",
  };
  for (const [operation, observed] of Object.entries(expectedObservedState)) {
    const state = renameMap.nativeAdoptionModel.states.find(
      (candidate) => candidate.operation === operation,
    );
    if (state?.observed !== observed || !state?.result) {
      errors.push(
        `native adoption ${operation} must use observed state ${observed} and declare a result`,
      );
    }
  }
  const nativeModel = renameMap.nativeAdoptionModel;
  const requiredNativeFields = {
    resourceIdentity: "resource kind + stable logical id",
    identityScope: "workspace",
    ownershipLedgerRequired: true,
    multipleClaimantsAllowed: true,
    borrowedResourceDeletion: "never",
    generatedResourceDeletion: "final-claimant-and-safe-managed-bytes-only",
    conflictResolution: "explicit",
    degradedScope: "affected-host-adapter-only",
    retryPlanRequired: true,
  };
  for (const [field, expected] of Object.entries(requiredNativeFields)) {
    if (nativeModel[field] !== expected) {
      errors.push(
        `native adoption ${field} must be ${JSON.stringify(expected)}`,
      );
    }
  }
  errors.push(
    ...exactSetErrors(
      "native shared resource kinds",
      ["agent-skill", "agents-managed-block"],
      sortedUnique(nativeModel.sharedResourceKinds ?? []),
    ),
  );
  const requiredAbsencePolicy = {
    externalNative: {
      operation: "install-hint",
      installer: "user-or-host",
      ownershipAfterInstall: "borrowed",
      pactileMayInstall: false,
    },
    pactileProjection: {
      operation: "install",
      installer: "pactile",
      ownershipAfterInstall: "managed",
      pactileMayInstall: true,
    },
  };
  for (const [resourceClass, expectedPolicy] of Object.entries(
    requiredAbsencePolicy,
  )) {
    for (const [field, expected] of Object.entries(expectedPolicy)) {
      if (nativeModel.absencePolicy?.[resourceClass]?.[field] !== expected) {
        errors.push(
          `native adoption absencePolicy.${resourceClass}.${field} must be ${JSON.stringify(expected)}`,
        );
      }
    }
  }
  const adopted = renameMap.nativeAdoptionModel.states.find(
    (state) => state.operation === "adopt",
  );
  if (!adopted?.result.includes("do not rewrite or delete")) {
    errors.push("native adopt state must preserve borrowed resources");
  }
  if (
    !renameMap.nativeAdoptionModel.detachRules.some((rule) =>
      rule.includes("Never delete a borrowed"),
    )
  ) {
    errors.push(
      "native adoption model must forbid deleting borrowed resources",
    );
  }
  const requiredDetachPolicy = {
    removeOnlyDetachingClaimant: true,
    preserveWhileClaimed: true,
    deleteGeneratedOnlyOnFinalClaimant: true,
    requireSafeManagedBytesForGeneratedDeletion: true,
    deleteBorrowed: false,
    preserveOtherHostBindings: true,
  };
  for (const [field, expected] of Object.entries(requiredDetachPolicy)) {
    if (nativeModel.detachPolicy?.[field] !== expected) {
      errors.push(`native adoption detachPolicy.${field} must be ${expected}`);
    }
  }
  return errors;
}

function validateDocumentationMap(
  documentationMap,
  trackedFiles,
  scan,
  inventory,
) {
  const errors = [];
  const inventoryPolicy = compileInventoryPolicy(inventory);
  if (documentationMap.schemaVersion !== 1) {
    errors.push("documentation-map.json schemaVersion must be 1");
  }
  if (documentationMap.contractId !== CONTRACT_IDS.documentationMap) {
    errors.push(
      `documentation-map.json contractId must be ${CONTRACT_IDS.documentationMap}`,
    );
  }
  if (documentationMap.status !== "batch-0-source-map") {
    errors.push("documentation-map.json status must be batch-0-source-map");
  }
  const contractDigest = jsonDigest(documentationMap);
  if (contractDigest !== CANONICAL_POLICY_DIGESTS.documentationMap) {
    errors.push(
      `documentation-map.json canonical contract digest mismatch: expected ${CANONICAL_POLICY_DIGESTS.documentationMap}, actual ${contractDigest}`,
    );
  }
  errors.push(
    ...exactSetErrors(
      "documentation actions",
      sortedUnique(ACTIONS),
      sortedUnique(documentationMap.actions ?? []),
    ),
    ...exactSetErrors(
      "documentation classifications",
      sortedUnique(CLASSIFICATIONS),
      sortedUnique(documentationMap.classifications ?? []),
    ),
    ...exactSetErrors(
      "documentation owner lanes",
      sortedUnique(REQUIRED_OWNER_LANES),
      sortedUnique(documentationMap.ownerLanes ?? []),
    ),
    ...exactSetErrors(
      "documentation required topics",
      sortedUnique(REQUIRED_TOPICS),
      sortedUnique(documentationMap.requiredTopics ?? []),
    ),
    ...exactSetErrors(
      "documentation first-class locales",
      ["en", "zh-CN"],
      sortedUnique(documentationMap.languagePolicy?.firstClassLocales ?? []),
    ),
  );
  if (documentationMap.languagePolicy?.englishSuffix !== ".md") {
    errors.push("documentation English suffix must be .md");
  }
  if (documentationMap.languagePolicy?.chineseSuffix !== ".zh-CN.md") {
    errors.push("documentation Chinese suffix must be .zh-CN.md");
  }
  if (
    !Array.isArray(documentationMap.languagePolicy?.parityRequirements) ||
    documentationMap.languagePolicy.parityRequirements.length === 0 ||
    !documentationMap.languagePolicy.localizationRule ||
    !documentationMap.languagePolicy.historyException
  ) {
    errors.push(
      "documentation languagePolicy needs parity requirements, localizationRule, and historyException",
    );
  }
  const discovered = discoverDocumentationSurface(
    trackedFiles,
    documentationMap,
  );
  const mappingPaths = documentationMap.sourceMappings.map(
    (entry) => entry.path,
  );
  for (const duplicate of duplicateValues(mappingPaths)) {
    errors.push(`documentation source has multiple mappings: ${duplicate}`);
  }
  errors.push(
    ...exactSetErrors(
      "canonical documentation sources",
      sortedUnique(REQUIRED_DOCUMENTATION_SOURCES),
      sortedUnique(mappingPaths),
    ),
  );
  const trackedSet = new Set(trackedFiles);
  for (const sourcePath of REQUIRED_DOCUMENTATION_SOURCES) {
    if (!trackedSet.has(sourcePath)) {
      errors.push(
        `canonical documentation source is not tracked: ${sourcePath}`,
      );
    }
  }
  errors.push(
    ...exactSetErrors(
      "documentation source map",
      discovered,
      sortedUnique(mappingPaths),
    ),
  );

  const pageIds = documentationMap.targetPages.map((page) => page.id);
  for (const duplicate of duplicateValues(pageIds)) {
    errors.push(`documentation target has duplicate id: ${duplicate}`);
  }
  const targetById = new Map(
    documentationMap.targetPages.map((page) => [page.id, page]),
  );
  errors.push(
    ...exactSetErrors(
      "canonical target pages",
      sortedUnique(REQUIRED_TARGET_PAGE_IDS),
      sortedUnique(pageIds),
    ),
    ...exactSetErrors(
      "target navigation groups",
      sortedUnique(REQUIRED_NAVIGATION_GROUPS),
      sortedUnique(
        documentationMap.targetPages.map((page) => page.navigationGroup),
      ),
    ),
    ...exactSetErrors(
      "target page statuses",
      sortedUnique(REQUIRED_PAGE_STATUSES),
      sortedUnique(documentationMap.targetPages.map((page) => page.status)),
    ),
  );
  const ownerLanes = new Set(documentationMap.ownerLanes);
  const targetPaths = [];

  for (const page of documentationMap.targetPages) {
    if (!ownerLanes.has(page.ownerLane)) {
      errors.push(
        `target page ${page.id} has unknown owner lane ${page.ownerLane}`,
      );
    }
    if (!isPlainObject(page.paths) || Object.keys(page.paths).length === 0) {
      errors.push(`target page ${page.id} needs at least one path`);
    }
    if (!REQUIRED_NAVIGATION_GROUPS.includes(page.navigationGroup)) {
      errors.push(
        `target page ${page.id} has invalid navigation group ${page.navigationGroup}`,
      );
    }
    if (!REQUIRED_PAGE_STATUSES.includes(page.status)) {
      errors.push(`target page ${page.id} has invalid status ${page.status}`);
    }
    if (!Array.isArray(page.topics) || page.topics.length === 0) {
      errors.push(`target page ${page.id} needs at least one topic`);
    }
    for (const topic of page.topics ?? []) {
      if (!REQUIRED_TOPICS.includes(topic)) {
        errors.push(`target page ${page.id} has unknown topic ${topic}`);
      }
    }
    for (const [locale, targetPath] of Object.entries(page.paths ?? {})) {
      if (!["en", "zh-CN", "neutral"].includes(locale)) {
        errors.push(`target page ${page.id} has invalid locale ${locale}`);
      }
      if (typeof targetPath !== "string") {
        errors.push(`target page ${page.id} has non-string path`);
        continue;
      }
      if (
        targetPath.length === 0 ||
        normalizePath(targetPath) !== targetPath ||
        path.posix.isAbsolute(targetPath) ||
        targetPath.split("/").includes("..")
      ) {
        errors.push(`target page ${page.id} has unsafe path ${targetPath}`);
      } else {
        targetPaths.push(targetPath);
      }
      if (
        locale === "zh-CN" &&
        page.parityRequired &&
        !targetPath.endsWith(".zh-CN.md")
      ) {
        errors.push(
          `target page ${page.id} Chinese path must end in .zh-CN.md`,
        );
      }
      if (
        locale === "en" &&
        (!targetPath.endsWith(".md") || targetPath.endsWith(".zh-CN.md"))
      ) {
        errors.push(`target page ${page.id} English path must end in .md`);
      }
    }
    if (page.parityRequired) {
      errors.push(
        ...exactSetErrors(
          `target page ${page.id} locale parity`,
          ["en", "zh-CN"],
          sortedUnique(Object.keys(page.paths ?? {})),
        ),
      );
      for (const locale of ["en", "zh-CN"]) {
        if (!page.paths?.[locale]) {
          errors.push(`target page ${page.id} lacks ${locale} parity path`);
        }
      }
    }
  }
  for (const duplicate of duplicateValues(targetPaths)) {
    errors.push(
      `documentation target path must be globally unique: ${duplicate}`,
    );
  }

  for (const mapping of documentationMap.sourceMappings) {
    if (!CLASSIFICATIONS.includes(mapping.classification)) {
      errors.push(
        `source ${mapping.path} has invalid classification ${mapping.classification}`,
      );
    }
    if (!ACTIONS.includes(mapping.action)) {
      errors.push(
        `source ${mapping.path} has invalid action ${mapping.action}`,
      );
    }
    if (!ownerLanes.has(mapping.ownerLane)) {
      errors.push(
        `source ${mapping.path} has unknown owner lane ${mapping.ownerLane}`,
      );
    }
    if (!targetById.has(mapping.targetPage)) {
      errors.push(
        `source ${mapping.path} points to missing target page ${mapping.targetPage}`,
      );
    }
    if (!mapping.reason) errors.push(`source ${mapping.path} needs a reason`);
    if (!["en", "zh-CN", "neutral"].includes(mapping.language)) {
      errors.push(
        `source ${mapping.path} has invalid language ${mapping.language}`,
      );
    }
    const expectedClassification =
      REQUIRED_HISTORY_DOCUMENTATION_SOURCES.includes(mapping.path)
        ? "history"
        : REQUIRED_COMPAT_DOCUMENTATION_SOURCES.includes(mapping.path)
          ? "compat"
          : "live";
    if (mapping.classification !== expectedClassification) {
      errors.push(
        `source ${mapping.path} must be classified ${expectedClassification}`,
      );
    }
    const inventoryClassification = classifyOccurrence(
      mapping.path,
      inventoryPolicy,
    );
    if (mapping.classification !== inventoryClassification) {
      errors.push(
        `documentation source classification mismatch for ${mapping.path}: map=${mapping.classification}, inventory=${inventoryClassification}`,
      );
    }
  }

  const topicSet = new Set(
    documentationMap.targetPages.flatMap((page) => page.topics ?? []),
  );
  for (const topic of documentationMap.requiredTopics) {
    if (!topicSet.has(topic))
      errors.push(`target IA misses required topic: ${topic}`);
  }

  const plannedGithub = sortedUnique(
    documentationMap.plannedGitHubSurfaces.map((entry) => entry.path),
  );
  errors.push(
    ...exactSetErrors(
      "planned GitHub surfaces",
      sortedUnique(REQUIRED_GITHUB_SURFACES),
      plannedGithub,
    ),
  );
  for (const entry of documentationMap.plannedGitHubSurfaces) {
    if (
      entry.status !== "create" ||
      !entry.ownerLane ||
      !entry.languagePolicy
    ) {
      errors.push(
        `planned GitHub surface ${entry.path} needs create status, ownerLane, and languagePolicy`,
      );
    }
  }

  const smoke = documentationMap.commandSmoke.map((entry) => entry.command);
  errors.push(
    ...exactSetErrors(
      "planned command smoke",
      sortedUnique(REQUIRED_COMMAND_SMOKE),
      sortedUnique(smoke),
    ),
  );

  const mappingByPath = new Map(
    documentationMap.sourceMappings.map((entry) => [entry.path, entry]),
  );
  const cursorPlusLiveDocs = sortedUnique(
    scan.occurrences
      .filter((occurrence) => occurrence.token === "cursor-plus-plus")
      .map((occurrence) => occurrence.path)
      .filter(
        (relativePath) =>
          mappingByPath.get(relativePath)?.classification === "live",
      ),
  );
  const p23Routes = documentationMap.p23CursorPlusPlus.routes;
  const p23Paths = sortedUnique(p23Routes.map((route) => route.sourcePath));
  if (
    documentationMap.p23CursorPlusPlus.status !== "mapped-not-reimplemented"
  ) {
    errors.push("P23 status must be mapped-not-reimplemented");
  }
  if (
    documentationMap.p23CursorPlusPlus.canonicalTargetPage !== P23_HISTORY_PAGE
  ) {
    errors.push(`P23 canonical target must be ${P23_HISTORY_PAGE}`);
  }
  errors.push(
    ...exactSetErrors(
      "canonical P23 live documentation routes",
      sortedUnique(REQUIRED_P23_SOURCE_PATHS),
      p23Paths,
    ),
  );
  const uncoveredP23Docs = cursorPlusLiveDocs.filter(
    (sourcePath) => !p23Paths.includes(sourcePath),
  );
  if (uncoveredP23Docs.length > 0) {
    errors.push(
      `P23 live documentation routes missing: ${uncoveredP23Docs.join(", ")}`,
    );
  }
  if (duplicateValues(p23Routes.map((route) => route.sourcePath)).length > 0) {
    errors.push("P23 live documentation source routes must be unique");
  }
  for (const route of p23Routes) {
    if (route.targetPage !== P23_HISTORY_PAGE) {
      errors.push(
        `P23 route ${route.sourcePath} must use canonical target ${P23_HISTORY_PAGE}`,
      );
    }
  }
  const p23Target = targetById.get(P23_HISTORY_PAGE);
  if (!p23Target) {
    errors.push("P23 canonical target page is absent from targetPages");
  } else if (
    p23Target.navigationGroup !== "history" ||
    p23Target.status !== "planned" ||
    p23Target.paths?.en !== "docs/history/cursor-plus-plus.md" ||
    p23Target.paths?.["zh-CN"] !== "docs/history/cursor-plus-plus.zh-CN.md"
  ) {
    errors.push(
      "P23 canonical target must remain the bilingual planned history page",
    );
  }

  return { errors, discovered };
}

function loadContracts(repoRoot) {
  const contractDir = path.join(repoRoot, "docs", "pactile");
  return {
    inventory: readJson(path.join(contractDir, "brand-inventory.json")),
    renameMap: readJson(path.join(contractDir, "rename-map.json")),
    documentationMap: readJson(
      path.join(contractDir, "documentation-map.json"),
    ),
  };
}

function auditBrandSurface(repoRoot, options = {}) {
  const contracts = loadContracts(repoRoot);
  const trackedFiles = gitInventoryFiles(repoRoot);
  const files = inventoryFiles(repoRoot, trackedFiles);
  const scan = scanLegacyTokens(repoRoot, files, contracts.inventory);
  const snapshot = buildSnapshot(scan.occurrences);
  const documentation = validateDocumentationMap(
    contracts.documentationMap,
    trackedFiles,
    scan,
    contracts.inventory,
  );
  const inventoryErrors = options.skipSnapshotCheck
    ? validateBrandInventory(
        { ...contracts.inventory, baselineSnapshot: snapshot },
        scan,
        snapshot,
        options.releaseMode === true,
      )
    : validateBrandInventory(
        contracts.inventory,
        scan,
        snapshot,
        options.releaseMode === true,
      );
  const errors = [
    ...inventoryErrors,
    ...validateRenameMap(contracts.renameMap),
    ...documentation.errors,
  ];
  const filesByClassification = {};
  for (const occurrence of scan.occurrences) {
    const values = filesByClassification[occurrence.classification] ?? [];
    values.push(occurrence.path);
    filesByClassification[occurrence.classification] = values;
  }
  for (const [classification, values] of Object.entries(
    filesByClassification,
  )) {
    filesByClassification[classification] = sortedUnique(values);
  }
  return {
    errors,
    snapshot,
    documentationSources: documentation.discovered,
    occurrences: scan.occurrences,
    filesByClassification,
  };
}

function parseArgs(argv) {
  const options = {
    repoRoot: defaultRepoRoot(),
    releaseMode: false,
    printSnapshot: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--release") options.releaseMode = true;
    else if (value === "--print-snapshot") options.printSnapshot = true;
    else if (value === "--json") options.json = true;
    else if (value === "--root") {
      index += 1;
      if (!argv[index]) throw new Error("--root requires a path");
      options.repoRoot = path.resolve(argv[index]);
    } else {
      throw new Error(`unknown option: ${value}`);
    }
  }
  return options;
}

function runCli() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  let report;
  try {
    report = auditBrandSurface(options.repoRoot, {
      releaseMode: options.releaseMode,
      skipSnapshotCheck: options.printSnapshot,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
    return;
  }

  if (options.printSnapshot) {
    console.log(JSON.stringify(report.snapshot, null, 2));
    if (report.errors.length > 0) {
      console.error("Non-snapshot contract errors:");
      for (const error of report.errors) console.error(`  - ${error}`);
      process.exitCode = 1;
    }
    return;
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: report.errors.length === 0,
          errors: report.errors,
          snapshot: report.snapshot,
          documentationSourceCount: report.documentationSources.length,
          filesByClassification: report.filesByClassification,
        },
        null,
        2,
      ),
    );
  } else if (report.errors.length === 0) {
    const liveCount = report.snapshot.byClassification.live ?? 0;
    console.log(
      `ok Pactile brand surface: ${report.documentationSources.length} mapped GitHub/live docs, ${report.snapshot.occurrences} inventoried legacy occurrences (${liveCount} live debt).`,
    );
  } else {
    console.error("Pactile brand surface check failed:");
    for (const error of report.errors) console.error(`  - ${error}`);
  }

  if (report.errors.length > 0) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) runCli();

export {
  auditBrandSurface,
  buildSnapshot,
  classifyOccurrence,
  discoverDocumentationSurface,
  scanLegacyTokens,
  validateDocumentationMap,
  validateRenameMap,
};
