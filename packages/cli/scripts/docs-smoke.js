#!/usr/bin/env node

/**
 * Execute the explicitly documented Pactile command smoke contract.
 *
 * The command list is read from docs/pactile/documentation-map.json.  That
 * file is the allowlist: this runner never scrapes arbitrary shell fences and
 * never passes a shell command through `exec`.  Mutating commands are executed
 * only inside fresh temporary projects and are reduced to their read-only
 * preview form where the contract permits it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(CLI_ROOT, "../..");
const CLI_ENTRY = path.join(CLI_ROOT, "bin", "pactile.js");
const MAP_PATH = path.join(
  REPO_ROOT,
  "docs",
  "pactile",
  "documentation-map.json",
);
const DOGFOOD_FIXTURE = path.join(
  CLI_ROOT,
  "test",
  "fixtures",
  "pactile",
  "dogfood",
);
const MAX_OUTPUT_CHARS = 2400;
const COMMAND_TIMEOUT_MS = 120_000;

const REQUIRED_COMMANDS = new Set([
  "pactile --version",
  "pactile init --codex",
  "pactile update",
  "pactile capability-smoke --json",
  "pactile detach codex",
  "pactile uninstall",
]);

const BASELINE_SKILL_IDS = [
  "approval-personal",
  "close-basic",
  "context-progressive",
  "define-basic",
  "execute-agent",
  "intake-basic",
  "observability-local",
  "verify-basic",
];

function normalizeText(value) {
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .trimEnd();
}

function relativePath(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink())
        throw new Error(`dogfood symlink is not permitted: ${absolute}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

function trimOutput(value) {
  const text = String(value ?? "").trim();
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `…${text.slice(-MAX_OUTPUT_CHARS)}`;
}

function loadCommandContract() {
  if (!fs.existsSync(MAP_PATH))
    throw new Error(`documentation map is missing: ${relativePath(MAP_PATH)}`);
  const map = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
  if (!Array.isArray(map.commandSmoke) || map.commandSmoke.length === 0)
    throw new Error("documentation map has no commandSmoke entries");

  const commands = map.commandSmoke.map((entry) => {
    if (!entry || typeof entry.command !== "string")
      throw new Error("every commandSmoke entry needs a command string");
    const command = entry.command.trim();
    if (!/^pactile(?:\s|$)/u.test(command))
      throw new Error(`non-canonical executable in commandSmoke: ${command}`);
    if (/[;&|<>$`\n\r]/u.test(command))
      throw new Error(`shell syntax is forbidden in commandSmoke: ${command}`);
    return { ...entry, command };
  });
  const actual = new Set(commands.map((entry) => entry.command));
  for (const command of REQUIRED_COMMANDS) {
    if (!actual.has(command))
      throw new Error(
        `documentation map lost required smoke command: ${command}`,
      );
  }
  return commands;
}

function childEnvironment(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: path.parse(home).root.slice(0, 2),
    HOMEPATH:
      path.parse(home).root.slice(2) + home.slice(path.parse(home).root.length),
    NO_COLOR: "1",
    PACTILE_SKIP_SMART_SEARCH_POSTINSTALL: "1",
    PACTILE_SKIP_PYTHON_CHECK: "1",
  };
}

function runCli(caseId, cwd, args, env) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  return {
    caseId,
    command: `pactile ${args.join(" ")}`,
    cwd: relativePath(cwd),
    exitCode: timedOut ? null : result.status,
    timedOut,
    durationMs: Date.now() - started,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr || result.error?.message),
  };
}

function assertExit(result, expected = 0) {
  if (result.timedOut || result.exitCode !== expected) {
    throw new Error(
      `${result.caseId} failed: exit=${result.exitCode} timeout=${result.timedOut}\n` +
        `${result.stderr || result.stdout}`,
    );
  }
}

function assertExists(root, relative) {
  const target = path.join(root, ...relative.split("/"));
  if (!fs.existsSync(target))
    throw new Error(`missing generated surface: ${relative}`);
}

function assertCanonicalSurface(root) {
  assertExists(root, "AGENTS.md");
  const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  if (
    !agents.includes("<!-- PACTILE:START -->") ||
    !agents.includes("<!-- PACTILE:END -->")
  )
    throw new Error("AGENTS.md has no Pactile managed block");
  if (/\bcstl\b|Cursor\+\+/iu.test(agents))
    throw new Error("generated AGENTS.md contains a legacy live identifier");

  for (const id of BASELINE_SKILL_IDS) {
    assertExists(root, `.agents/skills/${id}/SKILL.md`);
    const text = fs.readFileSync(
      path.join(root, ".agents", "skills", id, "SKILL.md"),
      "utf8",
    );
    if (!text.startsWith("# ") || /\bcstl\b|Cursor\+\+/iu.test(text))
      throw new Error(`non-canonical shared skill surface: ${id}`);
  }

  if (fs.existsSync(path.join(root, ".cursor"))) {
    throw new Error("Codex init unexpectedly created a Cursor tree");
  }
  if (fs.existsSync(path.join(root, ".codex"))) {
    throw new Error("Codex baseline unexpectedly created a native .codex tree");
  }
}

function compareFixture(actualRoot, fixtureRoot) {
  const relativeSurfaceFiles = (root) =>
    listFiles(root)
      .map((file) => path.relative(root, file).split(path.sep).join("/"))
      .filter(
        (file) =>
          file === "AGENTS.md" ||
          file.startsWith(".agents/skills/") ||
          file.startsWith(".codex/"),
      )
      .sort();
  const actual = relativeSurfaceFiles(actualRoot);
  const expected = relativeSurfaceFiles(fixtureRoot);
  const diffs = [];
  for (const file of [...new Set([...actual, ...expected])].sort()) {
    const actualPath = path.join(actualRoot, ...file.split("/"));
    const expectedPath = path.join(fixtureRoot, ...file.split("/"));
    if (!fs.existsSync(actualPath)) diffs.push(`${file}: missing generated`);
    else if (!fs.existsSync(expectedPath))
      diffs.push(`${file}: missing fixture`);
    else if (
      normalizeText(fs.readFileSync(actualPath, "utf8")) !==
      normalizeText(fs.readFileSync(expectedPath, "utf8"))
    )
      diffs.push(`${file}: normalized content differs`);
  }
  if (diffs.length)
    throw new Error(`dogfood fixture drift:\n- ${diffs.join("\n- ")}`);
  return { files: actual.length, diffs: [] };
}

async function assertSourceSkillParity(root) {
  const sourceModule = path.join(
    CLI_ROOT,
    "dist",
    "pactile",
    "tiles",
    "content",
    "baseline",
    "index.js",
  );
  if (!fs.existsSync(sourceModule))
    throw new Error(
      "built baseline tile module is missing; run pnpm build first",
    );
  const { loadBaselineTileContent } = await import(
    pathToFileURL(sourceModule).href
  );
  const loaded = loadBaselineTileContent();
  if (!loaded?.success || !Array.isArray(loaded.data))
    throw new Error("baseline tile catalog could not be loaded");
  const expected = new Map(
    loaded.data.map((entry) => [
      entry.manifest.identity.id,
      normalizeText(entry.skillText),
    ]),
  );
  const diffs = [];
  for (const id of BASELINE_SKILL_IDS) {
    const target = path.join(root, ".agents", "skills", id, "SKILL.md");
    const expectedText = expected.get(id);
    if (!expectedText) diffs.push(`${id}: missing source tile`);
    else if (normalizeText(fs.readFileSync(target, "utf8")) !== expectedText)
      diffs.push(`${id}: generated shared skill differs from source tile`);
  }
  if (diffs.length)
    throw new Error(
      `source/generated skill parity failed:\n- ${diffs.join("\n- ")}`,
    );
  return { files: BASELINE_SKILL_IDS.length, diffs: [] };
}

function writeEmptyCapabilityManifest(root) {
  const target = path.join(root, ".pactile", "capabilities.json");
  const capabilities = {
    schema_version: 3,
    note: "Pactile-managed project capability selection. Credentials and global MCP/client config stay outside repository templates.",
    selected: [],
    capabilities: {},
  };
  fs.writeFileSync(
    target,
    `${JSON.stringify(capabilities, null, 2)}\n`,
    "utf8",
  );
}

function assertHelpParity(contract, env) {
  const results = [];
  const rootHelp = runCli("help.root", REPO_ROOT, ["--help"], env);
  assertExit(rootHelp);
  results.push(rootHelp);
  const commandNames = new Set();
  for (const entry of contract) {
    const tokens = entry.command.split(/\s+/u).slice(1);
    const command = tokens[0];
    if (!command || command === "--version") continue;
    commandNames.add(command);
    const help = runCli(`help.${command}`, REPO_ROOT, [command, "--help"], env);
    assertExit(help);
    results.push(help);
    if (!help.stdout.includes(command))
      throw new Error(`CLI help omitted command ${command}`);
  }
  const rootOutput = rootHelp.stdout;
  for (const command of commandNames) {
    if (!rootOutput.includes(command))
      throw new Error(`root CLI help omitted ${command}`);
  }
  const initHelp =
    results.find((item) => item.caseId === "help.init")?.stdout ?? "";
  for (const flag of ["--codex", "--yes"]) {
    if (!initHelp.includes(flag)) throw new Error(`init help omitted ${flag}`);
  }
  if (initHelp.includes("--cursor"))
    throw new Error("retired Cursor init flag remains in CLI help");
  const detachHelp =
    results.find((item) => item.caseId === "help.detach")?.stdout ?? "";
  if (!detachHelp.includes("<adapter>"))
    throw new Error("detach help omitted positional adapter");

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(CLI_ROOT, "package.json"), "utf8"),
  );
  if (packageJson.name !== "@blxzer/pactile")
    throw new Error("CLI package name is not canonical");
  if (packageJson.bin?.pactile !== "./bin/pactile.js")
    throw new Error("canonical pactile bin is not exposed");

  // The compatibility entry is a separate launcher, so invoke it directly.
  const legacyStarted = spawnSync(
    process.execPath,
    [path.join(CLI_ROOT, "bin", "cstl.js"), "--version"],
    {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    },
  );
  const legacyText = `${legacyStarted.stdout ?? ""}\n${legacyStarted.stderr ?? ""}`;
  if (
    legacyStarted.status !== 0 ||
    (legacyText.match(/Deprecated compatibility entry/gu) ?? []).length !== 1
  )
    throw new Error(
      "legacy cstl alias did not emit exactly one compatibility warning",
    );
  results.push({
    caseId: "legacy.alias",
    command: "cstl --version",
    cwd: relativePath(REPO_ROOT),
    exitCode: legacyStarted.status,
    timedOut: legacyStarted.error?.code === "ETIMEDOUT",
    durationMs: null,
    stdout: trimOutput(legacyText),
    stderr: "",
  });
  return { cases: results.length, commands: [...commandNames].sort() };
}

async function main() {
  const contract = loadCommandContract();
  if (!fs.existsSync(CLI_ENTRY))
    throw new Error(`CLI entry is missing: ${relativePath(CLI_ENTRY)}`);
  if (!fs.existsSync(DOGFOOD_FIXTURE))
    throw new Error(
      `dogfood fixture is missing: ${relativePath(DOGFOOD_FIXTURE)}`,
    );

  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-docs-smoke-"));
  const home = path.join(runRoot, "home");
  fs.mkdirSync(home, { recursive: true });
  const env = childEnvironment(home);
  const results = [];
  try {
    const version = runCli("docs.version", REPO_ROOT, ["--version"], env);
    assertExit(version);
    results.push(version);

    const codex = path.join(runRoot, "codex");
    fs.mkdirSync(codex, { recursive: true });

    const initCodex = runCli(
      "docs.init.codex",
      codex,
      ["init", "--codex", "--yes", "--skip-readiness"],
      env,
    );
    assertExit(initCodex);
    assertCanonicalSurface(codex);
    results.push(initCodex);

    const sourceParity = await assertSourceSkillParity(codex);
    const fixtureParity = compareFixture(codex, DOGFOOD_FIXTURE);

    writeEmptyCapabilityManifest(codex);
    for (const entry of contract) {
      const command = entry.command;
      if (
        command === "pactile --version" ||
        command === "pactile init --codex"
      )
        continue;
      const tokens = command.split(/\s+/u).slice(1);
      let args;
      let cwd = codex;
      if (command === "pactile update")
        args = ["update", "--dry-run", "--json", "--skip-readiness"];
      else if (command === "pactile capability-smoke --json")
        args = ["capability-smoke", "--json"];
      else if (command === "pactile detach codex")
        args = ["detach", "codex", "--dry-run"];
      else if (command === "pactile uninstall")
        args = ["uninstall", "--dry-run"];
      else throw new Error(`no safe runner is registered for ${command}`);
      const result = runCli(`docs.${tokens.join("-")}`, cwd, args, env);
      assertExit(result);
      results.push(result);
    }

    const help = assertHelpParity(contract, env);
    const summary = {
      schemaVersion: 1,
      ok: true,
      contractCommands: contract.length,
      executedCases: results.length,
      sourceSkillParity: sourceParity,
      checkedInFixtureParity: fixtureParity,
      helpParity: help,
      skipped: [],
      safety: {
        shellFencesExecuted: false,
        writesOutsideTemporaryProjects: false,
        networkWrites: false,
        credentialsRead: false,
      },
      cases: results,
    };
    if (process.argv.includes("--json"))
      console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(
        `docs smoke passed: ${contract.length} documented commands, ${results.length} executions`,
      );
      console.log(
        `source/generated skills: ${sourceParity.files}; checked-in host fixture: ${fixtureParity.files}`,
      );
      console.log(
        `CLI help parity: ${help.cases} cases; shell fences executed: no`,
      );
    }
  } finally {
    if (process.env.PACTILE_DOGFOOD_KEEP !== "1")
      fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch((error) => {
  console.error(
    `docs smoke failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
