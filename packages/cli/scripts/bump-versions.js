#!/usr/bin/env node
/**
 * Bump the single @blxzer/pactile package for a maintainer-authored release PR.
 *
 * Usage:
 *   node scripts/bump-versions.js <type>
 *
 * <type>:
 *   patch | minor | major
 *   beta                       -- prerelease bump
 *   promote                    -- strip prerelease suffix
 *   x.y.z[-pre]                -- explicit target (e.g. 0.5.0-beta.0)
 *
 * Reads and writes only packages/cli/package.json. Lockfile and changelog
 * changes remain explicit reviewable edits in the release PR.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PKG = path.resolve(__dirname, "../package.json");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function writeJSON(p, obj) {
  // Preserve trailing newline that npm/pnpm write.
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

function fail(msg) {
  console.error(`${RED}x ${msg}${RESET}`);
  process.exit(1);
}

function parseVersion(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.+-]+))?$/);
  if (!m) fail(`unparseable version: ${v}`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

function bumpPrerelease(current, preid) {
  const parsed = parseVersion(current);
  if (parsed.prerelease) {
    // Existing prerelease: if same preid, bump its counter; otherwise switch
    // track (rc.N -> beta.0 is unusual but we mirror what pnpm/npm do).
    const m = parsed.prerelease.match(/^([A-Za-z0-9-]+)\.(\d+)$/);
    if (m && m[1] === preid) {
      return `${parsed.major}.${parsed.minor}.${parsed.patch}-${preid}.${Number(m[2]) + 1}`;
    }
    const seed = parsed.prerelease.match(/^(\d+)$/);
    if (seed) {
      // X.Y.Z-N seed format lifts to X.Y.Z-<preid>.0.
      return `${parsed.major}.${parsed.minor}.${parsed.patch}-${preid}.0`;
    }
    // Track switch: drop any other prerelease and start <preid>.0 on same base.
    return `${parsed.major}.${parsed.minor}.${parsed.patch}-${preid}.0`;
  }
  // Stable -> prerelease bumps the patch first (npm semver behavior).
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}-${preid}.0`;
}

const EXPLICIT_VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.+-]+)?$/;

export function computeNext(current, type) {
  if (EXPLICIT_VERSION.test(type)) {
    parseVersion(type);
    if (type === current) {
      fail(`already at ${current}`);
    }
    return type;
  }
  const v = parseVersion(current);
  switch (type) {
    case "patch":
      if (v.prerelease) return `${v.major}.${v.minor}.${v.patch}`;
      return `${v.major}.${v.minor}.${v.patch + 1}`;
    case "minor":
      return `${v.major}.${v.minor + 1}.0`;
    case "major":
      return `${v.major + 1}.0.0`;
    case "beta":
      return bumpPrerelease(current, "beta");
    case "promote":
      if (!v.prerelease) {
        fail(`promote requires a prerelease version (got ${current}).`);
      }
      return `${v.major}.${v.minor}.${v.patch}`;
    default:
      fail(`unknown bump type: ${type}`);
      return null; // unreachable
  }
}

function main() {
  const [type] = process.argv.slice(2);
  if (!type) {
    fail(
      `usage: bump-versions.js <patch|minor|major|beta|promote|x.y.z[-beta.N]>`,
    );
  }

  const cli = readJSON(CLI_PKG);
  const next = computeNext(cli.version, type);
  cli.version = next;
  writeJSON(CLI_PKG, cli);
  // Human message to stderr so stdout stays a clean machine-readable value.
  process.stderr.write(
    `${GREEN}ok${RESET} bumped @blxzer/pactile (${type}) -> ${next}; update pnpm-lock.yaml in the release PR\n`,
  );
  process.stdout.write(next + "\n");
}

const invokedAs = process.argv[1];
if (
  invokedAs &&
  import.meta.url === pathToFileURL(path.resolve(invokedAs)).href
) {
  main();
}
