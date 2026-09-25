#!/usr/bin/env node
/**
 * Create migration manifest for a new version.
 *
 * Usage:
 *   pnpm --filter @blxzer/pactile exec tsx scripts/create-manifest.ts          # interactive
 *   pnpm --filter @blxzer/pactile exec tsx scripts/create-manifest.ts --breaking
 *   pnpm --filter @blxzer/pactile exec tsx scripts/create-manifest.ts --version 0.3.0-rc.0
 *   pnpm --filter @blxzer/pactile exec tsx scripts/create-manifest.ts -y --description "..." --changelog "..." # non-interactive
 *   echo '{"version":"0.3.9",...}' | pnpm --filter @blxzer/pactile exec tsx scripts/create-manifest.ts # JSON via stdin
 *
 * Stdin JSON mode (auto-detected when stdin is piped, or force with --stdin):
 *   Reads a JSON object from stdin with fields: version, description, changelog
 *   (required), plus optional: breaking, recommendMigrate, migrations, notes,
 *   migrationGuide, aiInstructions.
 *   Breaking + recommendMigrate manifests REQUIRE migrationGuide — without it,
 *   the migration task PRD template falls back to whatever older manifests
 *   happen to have a guide, leaving users to migrate blind.
 *   Best for AI/scripting — avoids shell escaping issues with multi-line text.
 *
 * Non-interactive mode (-y):
 *   When -y is passed, all values are taken from CLI flags (no prompts).
 *   --version defaults to next prerelease from package.json.
 *   --description and --changelog are required in -y mode.
 *   --notes overrides the auto-generated notes field.
 *
 * Interactive prompts will ask for:
 *   - Version (default: next prerelease from package.json)
 *   - Description
 *   - Changelog
 *   - Breaking change (y/n)
 *
 * Version suggestion logic:
 *   beta.N  → beta.(N+1)    (also shows rc.0 hint)
 *   rc.N    → rc.(N+1)      (also shows release hint)
 *   X.Y.Z   → X.Y.(Z+1)-beta.0
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { isRecord } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = path.join(__dirname, "../src/migrations/manifests");
const PACKAGE_NAME = "@blxzer/pactile";

/**
 * Check whether `version` is already published on npm. Returns false on network
 * error so we fail open (don't block dev flow when npm is unreachable); the
 * release-time continuity check is the authoritative gate.
 */
function versionOnNpm(version) {
  try {
    const out = execSync(
      `npm view ${PACKAGE_NAME}@${version} version 2>/dev/null`,
      {
        encoding: "utf-8",
        timeout: 8_000,
      },
    ).trim();
    return out === version;
  } catch {
    return false;
  }
}

/**
 * Abort if attempting to (over)write a manifest file for a version already
 * on npm. Once a version is published, its manifest is contract; mutating
 * it breaks the update chain for users at adjacent versions.
 */
function guardAgainstPublishedManifest(version, manifestPath, allowOverwrite) {
  const exists = fs.existsSync(manifestPath);
  const onNpm = versionOnNpm(version);

  if (onNpm) {
    console.error(
      `\n✗ Version ${version} is already published on npm.\n` +
        `  Its manifest is part of the update contract and must NOT be rewritten.\n` +
        `  If you need to release additional migrations, use the NEXT version number.\n`,
    );
    process.exit(1);
  }

  if (exists && !allowOverwrite) {
    console.error(
      `\n✗ ${manifestPath} already exists.\n` +
        `  Use --force in non-interactive modes, or answer "y" to the overwrite prompt\n` +
        `  in interactive mode, if you really intend to rewrite a NOT-YET-PUBLISHED manifest.\n`,
    );
    process.exit(1);
  }
}

function readPackageVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../package.json"), "utf-8"),
  );
  return pkg.version;
}

function getNextVersion(currentVersion: string) {
  // beta.N → next beta
  const betaMatch = currentVersion.match(/^(\d+\.\d+\.\d+)-beta\.(\d+)$/);
  if (betaMatch) {
    const base = betaMatch[1];
    const next = parseInt(betaMatch[2], 10) + 1;
    return {
      suggested: `${base}-beta.${next}`,
      hint: `or ${base}-rc.0 to promote to RC`,
    };
  }
  // rc.N → next rc
  const rcMatch = currentVersion.match(/^(\d+\.\d+\.\d+)-rc\.(\d+)$/);
  if (rcMatch) {
    const base = rcMatch[1];
    const next = parseInt(rcMatch[2], 10) + 1;
    return { suggested: `${base}-rc.${next}`, hint: `or ${base} to release` };
  }
  // stable X.Y.Z → next patch beta
  const stableMatch = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (stableMatch) {
    const [, major, minor, patch] = stableMatch;
    const nextPatch = `${major}.${minor}.${parseInt(patch, 10) + 1}`;
    return { suggested: `${nextPatch}-beta.0`, hint: null };
  }
  return { suggested: currentVersion, hint: null };
}

function getArgValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

/**
 * Unescape literal \n and \t sequences in a string.
 * When passing multi-line text via CLI flags (e.g. --changelog "line1\nline2"),
 * the shell delivers literal backslash + n characters. This function converts
 * them to real newlines so JSON.stringify produces correct \n escapes.
 */
function unescapeLiterals(str: string): string {
  return str.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

function askQuestion(
  rl: readline.Interface,
  question: string,
  defaultValue = "",
): Promise<string> {
  const prompt = defaultValue
    ? `${question} [${defaultValue}]: `
    : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

/**
 * Read all data from stdin as a string.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const stdinMode = args.includes("--stdin") || !process.stdin.isTTY;
  const nonInteractive = args.includes("-y");
  const isBreaking = args.includes("--breaking");
  const versionArg = getArgValue(args, "--version");
  const descriptionArg = getArgValue(args, "--description");
  const changelogArg = getArgValue(args, "--changelog");
  const notesArg = getArgValue(args, "--notes");

  const currentVersion = readPackageVersion();
  const { suggested, hint } = getNextVersion(currentVersion);

  // --- Stdin JSON mode (best for AI / scripting) ---
  if (stdinMode) {
    const input = await readStdin();
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      console.error("Error: --stdin expects valid JSON on stdin");
      process.exit(1);
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.version !== "string" ||
      typeof parsed.description !== "string" ||
      typeof parsed.changelog !== "string"
    ) {
      console.error(
        "Error: --stdin JSON requires version, description, and changelog fields",
      );
      process.exit(1);
    }
    const data = parsed;
    if (
      (data.breaking != null && typeof data.breaking !== "boolean") ||
      (data.recommendMigrate != null &&
        typeof data.recommendMigrate !== "boolean") ||
      (data.migrations != null && !Array.isArray(data.migrations)) ||
      (data.notes != null && typeof data.notes !== "string") ||
      (data.migrationGuide != null &&
        typeof data.migrationGuide !== "string") ||
      (data.aiInstructions != null && typeof data.aiInstructions !== "string")
    ) {
      console.error(
        "Error: optional --stdin manifest fields have invalid types",
      );
      process.exit(1);
    }
    const version = data.version;
    const description = data.description;
    const changelog = data.changelog;
    const breaking = data.breaking === true;
    const recommendMigrate =
      typeof data.recommendMigrate === "boolean"
        ? data.recommendMigrate
        : breaking;
    // Breaking releases MUST include a migrationGuide — without it, the
    // generated migration task PRD pulls only older guides from between
    // fromVersion and toVersion, leaving users to migrate blind. See
    // `spec/cli/backend/migrations.md` § "Migration guides are mandatory
    // on breaking releases".
    if (
      breaking &&
      recommendMigrate &&
      (typeof data.migrationGuide !== "string" ||
        data.migrationGuide.length === 0)
    ) {
      console.error(
        "Error: breaking + recommendMigrate manifests require a migrationGuide field (narrative migration doc that gets templated into the user's migration task PRD). " +
          "Also recommend aiInstructions (AI hints for helping users migrate).",
      );
      process.exit(1);
    }
    const manifestPath = path.join(MANIFESTS_DIR, `${version}.json`);
    guardAgainstPublishedManifest(version, manifestPath, data.force === true);
    const manifest = {
      version,
      description,
      breaking,
      recommendMigrate,
      changelog,
      ...(typeof data.migrationGuide === "string" && data.migrationGuide
        ? { migrationGuide: data.migrationGuide }
        : {}),
      ...(typeof data.aiInstructions === "string" && data.aiInstructions
        ? { aiInstructions: data.aiInstructions }
        : {}),
      migrations: data.migrations ?? [],
      notes:
        typeof data.notes === "string" ? data.notes : "No migration required.",
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`✅ Created: ${manifestPath}`);
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  // --- Non-interactive mode (-y) ---
  if (nonInteractive) {
    if (!descriptionArg || !changelogArg) {
      console.error("Error: -y mode requires --description and --changelog");
      process.exit(1);
    }
    if (isBreaking) {
      // See rationale in --stdin branch above.
      console.error(
        "Error: -y mode cannot produce a breaking manifest — migrationGuide + aiInstructions are required and -y has no way to supply them. Use --stdin with JSON input instead.",
      );
      process.exit(1);
    }
    const version = versionArg || suggested;
    const manifestPath = path.join(MANIFESTS_DIR, `${version}.json`);
    guardAgainstPublishedManifest(
      version,
      manifestPath,
      args.includes("--force"),
    );

    const manifest = {
      version,
      description: unescapeLiterals(descriptionArg),
      breaking: isBreaking,
      recommendMigrate: isBreaking,
      changelog: unescapeLiterals(changelogArg),
      migrations: [],
      notes: notesArg
        ? unescapeLiterals(notesArg)
        : isBreaking
          ? "Review changelog and run with --migrate if needed."
          : "No migration required.",
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`✅ Created: ${manifestPath}`);
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  // --- Interactive mode ---
  const suggestedVersion = versionArg || suggested;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n📝 Create Migration Manifest\n");
  console.log(`Current package.json version: ${currentVersion}`);
  if (!versionArg && hint) {
    console.log(`Hint: ${hint}`);
  }
  console.log("");

  try {
    // Get version
    const version = await askQuestion(rl, "Version", suggestedVersion);

    // Check if manifest already exists (local) or is already on npm.
    const manifestPath = path.join(MANIFESTS_DIR, `${version}.json`);
    if (versionOnNpm(version)) {
      console.error(
        `\n✗ Version ${version} is already published on npm.\n` +
          `  Rewriting its manifest would break \`pactile update\` for users\n` +
          `  currently at that version. Use the NEXT version number instead.\n`,
      );
      rl.close();
      process.exit(1);
    }
    if (fs.existsSync(manifestPath)) {
      console.log(`\n⚠️  Manifest already exists: ${manifestPath}`);
      const overwrite = await askQuestion(rl, "Overwrite? (y/n)", "n");
      if (overwrite.toLowerCase() !== "y") {
        console.log("Cancelled.");
        rl.close();
        return;
      }
    }

    // Get description
    const description =
      descriptionArg || (await askQuestion(rl, "Description (short)"));

    // Get changelog
    const changelog =
      changelogArg || (await askQuestion(rl, "Changelog (one line summary)"));

    // Get breaking status
    let breaking = isBreaking;
    if (!isBreaking) {
      const breakingAnswer = await askQuestion(
        rl,
        "Breaking change? (y/n)",
        "n",
      );
      breaking = breakingAnswer.toLowerCase() === "y";
    }

    // Get recommend migrate
    let recommendMigrate = false;
    if (breaking) {
      const migrateAnswer = await askQuestion(
        rl,
        "Recommend --migrate? (y/n)",
        "y",
      );
      recommendMigrate = migrateAnswer.toLowerCase() === "y";
    }

    // Breaking releases: nudge for migrationGuide + aiInstructions.
    // The interactive prompt can't capture a multi-paragraph narrative
    // cleanly, so we write TODO placeholders here and error out in the
    // completion summary. User is expected to re-run via --stdin or
    // hand-edit after seeing what was written.
    let migrationGuide;
    let aiInstructions;
    if (breaking && recommendMigrate) {
      console.log(
        "\n⚠ Breaking releases require migrationGuide + aiInstructions fields.\n" +
          "   Interactive mode can't capture multi-paragraph content cleanly;\n" +
          "   the manifest will be written with TODO placeholders, then you\n" +
          "   MUST hand-edit the JSON (or re-run via --stdin with full JSON).\n",
      );
      migrationGuide =
        "TODO: narrative migration guide (gets templated into the user's migration task PRD on pactile update --migrate).";
      aiInstructions =
        "TODO: AI hints for helping users migrate (what to check, common pitfalls).";
    }

    // Build manifest
    const manifest = {
      version,
      description,
      breaking,
      recommendMigrate,
      changelog,
      ...(migrationGuide ? { migrationGuide } : {}),
      ...(aiInstructions ? { aiInstructions } : {}),
      migrations: [],
      notes:
        notesArg ||
        (breaking
          ? "Review changelog and run with --migrate if needed."
          : "No migration required."),
    };

    // Write manifest
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    console.log(`\n✅ Created: ${manifestPath}`);
    console.log("\nManifest content:");
    console.log(JSON.stringify(manifest, null, 2));

    // Detect release type for next steps hint
    const releaseCmd = version.includes("-beta.")
      ? "pnpm release:beta"
      : version.includes("-rc.")
        ? "pnpm release:rc"
        : "pnpm release";

    console.log("\n📋 Next steps:");
    console.log(
      `  1. Edit ${version}.json if needed (add migrations, migrationGuide, etc.)`,
    );
    console.log(`  2. ${releaseCmd}`);
  } finally {
    rl.close();
  }
}

main().catch(console.error);
