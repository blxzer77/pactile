import { describe, expect, it } from "vitest";
import { checkPullRequest } from "../scripts/release-pr-check.js";

const stablePackage = { name: "@blxzer/pactile", version: "0.6.0", dependencies: { chalk: "^5.3.0" } };
const betaPackage = { ...stablePackage, version: "0.6.0-beta.1" };
const repository = "blxzer77/pactile";
const betaTag = "pactile-v0.6.0-beta.1";
const body = [
  `Beta tag: ${betaTag}`,
  `Beta validation: https://github.com/${repository}/actions/runs/123`,
  "Beta acceptance: CLI and task smoke passed on the beta install",
  "Post-beta changes: packages/cli/package.json, packages/cli/CHANGELOG.md",
].join("\n");

function event(base: string, head: string, prBody = body) {
  return {
    repository: { full_name: repository },
    pull_request: {
      base: { ref: base },
      head: { ref: head, sha: "head-sha", repo: { full_name: repository } },
      body: prBody,
    },
  };
}

function gitCommand(args: string[]) {
  const key = args.join(" ");
  if (key === "rev-parse HEAD" || key === "rev-parse origin/develop") return "head-sha";
  if (key === `rev-parse ${betaTag}^{commit}`) return "beta-sha";
  if (key === "merge-base --is-ancestor beta-sha head-sha") return "";
  if (key === `show ${betaTag}:packages/cli/package.json`) return JSON.stringify(betaPackage);
  if (key === "diff --name-only beta-sha head-sha") {
    return "packages/cli/package.json\npackages/cli/CHANGELOG.md";
  }
  throw new Error(`unexpected Git call: ${key}`);
}

const run = {
  event: "push",
  head_sha: "beta-sha",
  status: "completed",
  conclusion: "success",
  path: `.github/workflows/publish.yml@refs/tags/${betaTag}`,
};

describe("PR source and release evidence", () => {
  it("routes feature PRs only into develop", async () => {
    await expect(checkPullRequest({ event: event("develop", "feat/one"), stablePackage }))
      .resolves.toMatchObject({ kind: "development" });
    await expect(checkPullRequest({ event: event("main", "feat/one"), stablePackage }))
      .rejects.toThrow(/Only develop may target main/);
    await expect(checkPullRequest({ event: event("develop", "cursor-hook"), stablePackage }))
      .rejects.toThrow(/Only feat/);
  });

  it("accepts a verified beta tag and documented version/changelog changes", async () => {
    const result = await checkPullRequest({
      event: event("main", "develop"), stablePackage, gitCommand,
      getWorkflowRun: async () => run,
    });
    expect(result).toMatchObject({ kind: "release", betaTag, runId: "123" });
    await expect(checkPullRequest({
      event: event("main", "develop"), stablePackage, gitCommand,
      getWorkflowRun: async () => ({ ...run, path: `.github/workflows/publish.yml@${betaTag}` }),
    })).resolves.toMatchObject({ kind: "release", betaTag });
  });

  it("rejects product changes after beta and requires a new beta", async () => {
    await expect(checkPullRequest({
      event: event("main", "develop"), stablePackage,
      gitCommand: (args: string[]) => args[0] === "diff"
        ? "packages/cli/src/cli/index.ts"
        : gitCommand(args),
      getWorkflowRun: async () => run,
    })).rejects.toThrow(/Product changes after beta/);
    await expect(checkPullRequest({
      event: event("main", "develop"),
      stablePackage: { ...stablePackage, dependencies: { chalk: "^6.0.0" } },
      gitCommand, getWorkflowRun: async () => run,
    })).rejects.toThrow(/Package changed after beta/);
  });

  it("rejects an unrelated or failed beta workflow run", async () => {
    await expect(checkPullRequest({
      event: event("main", "develop"), stablePackage, gitCommand,
      getWorkflowRun: async () => ({ ...run, conclusion: "failure" }),
    })).rejects.toThrow(/did not succeed/);
    await expect(checkPullRequest({
      event: event("main", "develop"), stablePackage, gitCommand,
      getWorkflowRun: async () => ({ ...run, path: ".github/workflows/publish.yml@refs/heads/develop" }),
    })).rejects.toThrow(/did not succeed/);
    await expect(checkPullRequest({
      event: event("main", "develop", body.replace("actions/runs/123", "other/actions/runs/123")),
      stablePackage, gitCommand, getWorkflowRun: async () => run,
    })).rejects.toThrow(/must link/);
  });
});
