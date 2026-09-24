/** PR routing and beta evidence gate for the develop -> main release PR. */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function field(body, label) {
  const line = body.split(/\r?\n/).find((candidate) =>
    candidate.toLowerCase().startsWith(`${label.toLowerCase()}:`),
  );
  const value = line?.slice(label.length + 1).trim();
  if (!value || /^(todo|tbd|pending|none yet)$/i.test(value)) {
    throw new Error(`Release PR requires ${label}: with real evidence.`);
  }
  return value;
}

function isDocumentationPath(file) {
  return file.startsWith("docs/") ||
    /^README(?:\.[^/]*)?$/.test(file) ||
    /^packages\/cli\/(?:README(?:\.[^/]*)?|CHANGELOG\.md)$/.test(file);
}

function sameExceptVersion(betaPackage, stablePackage) {
  return JSON.stringify({ ...betaPackage, version: stablePackage.version }) ===
    JSON.stringify(stablePackage);
}

export async function checkPullRequest({
  event,
  gitCommand = git,
  getWorkflowRun = async (repository, runId) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is required to verify beta CI.");
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub Actions run read failed: HTTP ${response.status}.`);
    return response.json();
  },
  stablePackage = JSON.parse(fs.readFileSync(path.resolve("packages/cli/package.json"), "utf8")),
} = {}) {
  const pr = event?.pull_request;
  if (!pr) throw new Error("Expected a pull_request event.");
  const repository = event.repository?.full_name;
  if (!repository || pr.head?.repo?.full_name !== repository) {
    throw new Error("Pactile PRs must originate from this repository.");
  }
  if (pr.base?.ref === "develop") {
    if (!/^(feat|fix|chore)\/[a-z0-9][a-z0-9-]*$/.test(pr.head?.ref ?? "")) {
      throw new Error("Only feat/*, fix/*, or chore/* branches may target develop.");
    }
    return { kind: "development", source: pr.head.ref, target: "develop" };
  }
  if (pr.base?.ref !== "main" || pr.head?.ref !== "develop") {
    throw new Error("Only develop may target main for a release PR.");
  }
  if (!/^\d+\.\d+\.\d+$/.test(stablePackage.version)) {
    throw new Error("A main release PR must carry a stable package version.");
  }
  const body = pr.body ?? "";
  const betaTag = field(body, "Beta tag");
  if (!new RegExp(`^pactile-v${stablePackage.version.replaceAll(".", "\\.")}-beta\\.\\d+$`).test(betaTag)) {
    throw new Error("Beta tag must match the stable package's base version.");
  }
  const validation = field(body, "Beta validation");
  const acceptance = field(body, "Beta acceptance");
  const postBeta = field(body, "Post-beta changes");
  const runMatch = new RegExp(`^https://github\\.com/${repository.replaceAll("/", "\\/")}/actions/runs/(\\d+)$`).exec(validation);
  if (!runMatch) throw new Error("Beta validation must link to this repository's Actions run.");
  if (acceptance.length < 8) throw new Error("Beta acceptance needs a concrete result.");

  const head = gitCommand(["rev-parse", "HEAD"]);
  if (head !== pr.head.sha || head !== gitCommand(["rev-parse", "origin/develop"])) {
    throw new Error("Release PR checkout must be the current develop head.");
  }
  const betaCommit = gitCommand(["rev-parse", `${betaTag}^{commit}`]);
  try {
    gitCommand(["merge-base", "--is-ancestor", betaCommit, head]);
  } catch {
    throw new Error("Beta tag is not an ancestor of the release PR head.");
  }
  const betaPackage = JSON.parse(gitCommand(["show", `${betaTag}:packages/cli/package.json`]));
  if (betaPackage.version !== betaTag.slice("pactile-v".length) ||
      !sameExceptVersion(betaPackage, stablePackage)) {
    throw new Error("Package changed after beta beyond the stable version field; publish and validate a new beta.");
  }
  const changedPaths = gitCommand(["diff", "--name-only", betaCommit, head])
    .split(/\r?\n/).filter(Boolean);
  const codeChanges = changedPaths.filter((file) =>
    file !== "packages/cli/package.json" && !isDocumentationPath(file),
  );
  if (codeChanges.length > 0) {
    throw new Error(`Product changes after beta require a new beta: ${codeChanges.join(", ")}`);
  }
  if (changedPaths.length === 0) {
    if (postBeta.toLowerCase() !== "none") throw new Error("Post-beta changes must say none.");
  } else if (changedPaths.some((file) => !postBeta.includes(file))) {
    throw new Error("Post-beta changes must list every changed path since the beta tag.");
  }

  const run = await getWorkflowRun(repository, runMatch[1]);
  const publishPath = `.github/workflows/publish.yml@`;
  if (run.event !== "push" || run.head_sha !== betaCommit ||
      run.status !== "completed" || run.conclusion !== "success" ||
      ![`${publishPath}${betaTag}`, `${publishPath}refs/tags/${betaTag}`].includes(run.path)) {
    throw new Error("Linked beta Publish workflow did not succeed for the beta tag commit.");
  }
  return { kind: "release", betaTag, betaCommit, head, changedPaths, runId: runMatch[1] };
}

const invokedAs = process.argv[1];
if (invokedAs && import.meta.url === pathToFileURL(path.resolve(invokedAs)).href) {
  checkPullRequest({ event: JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) })
    .then((result) => console.log(`ok ${result.kind} PR policy`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
