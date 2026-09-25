#!/usr/bin/env node
/**
 * Pre-release gate: ensure migration-manifest continuity with npm.
 *
 * Contract: once a version is published to npm, its manifest is part of the
 * public update contract. `pactile update` applies manifests where
 * `v > installed && v <= current` — if any published version is missing a
 * local manifest, users upgrading from that version silently skip their
 * bucket of migrations.
 *
 * This guard runs before `pnpm version` bumps on every release track:
 *   1. Query npm for all published versions of @blxzer/pactile
 *   2. Diff against local `src/migrations/manifests/*.json`
 *   3. Fail non-zero if any npm version lacks a local manifest
 *
 * Historical gaps (existed before this check was introduced) are listed in
 * KNOWN_GAPS below so the gate can block *new* drift without being stuck
 * on accumulated debt. Do NOT add to KNOWN_GAPS — fix the root cause instead.
 *
 * Override: `SKIP_MANIFEST_CONTINUITY=1` to bypass (for emergency re-rolls
 * that knowingly accept the tradeoff). Prints a loud banner when bypassed.
 *
 * Background:
 *   The beta.10 incident (manifest deleted from repo AFTER being published
 *   to npm) motivated this gate — see .pactile/spec/cli/backend/migrations.md.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = path.join(__dirname, "../src/migrations/manifests");
const PACKAGE_NAME = "@blxzer/pactile";

/**
 * Historical npm versions whose manifests are permanently missing from the
 * repo. Check was added AFTER these gaps existed; they're frozen as debt.
 *
 * **Do NOT extend this list.** If a new gap appears, it means someone is
 * about to repeat the beta.10 mistake — fix the root cause (restore the
 * manifest from git or change the release plan) instead of appending here.
 */
const KNOWN_GAPS = new Set([
  // New package line (@blxzer/pactile): no historical npm debt yet.
]);

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function readLocalManifestVersions() {
  return new Set(
    fs
      .readdirSync(MANIFESTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, "")),
  );
}

function fetchNpmVersions() {
  try {
    const output = execSync(`npm view ${PACKAGE_NAME} versions --json`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
    });
    const parsed = JSON.parse(output);
    // `npm view` returns a string for single version and array otherwise.
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    // First publish ever? Package doesn't exist on npm yet — nothing to sync.
    const stderr = err.stderr?.toString() ?? "";
    if (stderr.includes("E404") || stderr.includes("not found")) {
      return [];
    }
    throw err;
  }
}

function main() {
  if (process.env.SKIP_MANIFEST_CONTINUITY === "1") {
    console.error(
      `${YELLOW}⚠  SKIP_MANIFEST_CONTINUITY=1 set — bypassing manifest/npm continuity check.${RESET}\n` +
      `${YELLOW}   Only use this for emergency re-rolls with explicit sign-off.${RESET}\n`,
    );
    return;
  }

  const localVersions = readLocalManifestVersions();
  const npmVersions = fetchNpmVersions();

  const newGaps = npmVersions.filter(
    (v) => !localVersions.has(v) && !KNOWN_GAPS.has(v),
  );

  if (newGaps.length > 0) {
    console.error(`${RED}✗ Manifest / npm continuity check failed.${RESET}\n`);
    console.error(
      `${RED}Published-but-missing manifests (new gaps, not in KNOWN_GAPS):${RESET}`,
    );
    newGaps.forEach((v) => console.error(`  - ${v}.json`));
    console.error(
      `\n` +
      `A version on npm without its local manifest breaks \`pactile update\`\n` +
      `for users on adjacent versions. See .pactile/spec/cli/backend/migrations.md.\n` +
      `\n` +
      `Fix options:\n` +
      `  1. Restore the manifest from git history\n` +
      `       git log --all -- src/migrations/manifests/<version>.json\n` +
      `       git checkout <commit-before-delete> -- src/migrations/manifests/<version>.json\n` +
      `     and verify its content matches what was shipped in that npm tarball.\n` +
      `  2. If the version should NEVER have been published (accidental release\n` +
      `     that cannot be unpublished), deprecate it on npm AND accept the gap\n` +
      `     by adding to KNOWN_GAPS — but think carefully: adjacent-version users\n` +
      `     still get broken update chains.\n` +
      `\n` +
      `${DIM}Emergency bypass (NOT recommended): SKIP_MANIFEST_CONTINUITY=1 <command>${RESET}\n`,
    );
    process.exit(1);
  }

  console.log(
    `${GREEN}✓${RESET} Manifest continuity OK — ${localVersions.size} local, ` +
    `${npmVersions.length} published (${KNOWN_GAPS.size} historical gaps whitelisted).`,
  );
}

main();
