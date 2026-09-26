import { describe, expect, it } from "vitest";
import { observeGitHubPullRequest } from "../../../src/core/task/task-pull-request-observer.js";
import {
  createTemporaryGitRepository,
  removeTemporaryGitRepository,
  runGit,
} from "./git-fixture.js";

function pullRequestResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 17,
    html_url: "https://github.com/Example/Project/pull/17",
    state: "open",
    draft: false,
    merged: false,
    // GitHub can expose a test merge commit while the PR is still open.
    merge_commit_sha: "a".repeat(40),
    base: {
      ref: "main",
      repo: { full_name: "Example/Project" },
    },
    head: {
      sha: "b".repeat(40),
      repo: { full_name: "Example/Project" },
    },
    ...overrides,
  });
}

describe("read-only GitHub Pull Request observer", () => {
  it("uses only the read-only GET endpoint and returns provider facts for the local origin", () => {
    const repository = createTemporaryGitRepository();
    try {
      runGit(repository.root, [
        "remote",
        "add",
        "origin",
        "git@github.com:Example/Project.git",
      ]);
      let observedArgs: readonly string[] = [];
      const result = observeGitHubPullRequest(
        repository.root,
        "https://github.com/Example/Project/pull/17",
        (args) => {
          observedArgs = args;
          return { status: 0, stdout: pullRequestResponse() };
        },
      );

      expect(result).toMatchObject({
        source: "github-rest-pull-request-v1",
        url: "https://github.com/Example/Project/pull/17",
        repository: "example/project",
        number: 17,
        state: "open",
        draft: false,
        headSha: "b".repeat(40),
        baseBranch: "main",
        merged: false,
      });
      expect(observedArgs.slice(0, 3)).toEqual(["api", "-X", "GET"]);
      expect(observedArgs).not.toContain("POST");
      expect(observedArgs).toContain("repos/example/project/pulls/17");
    } finally {
      removeTemporaryGitRepository(repository);
    }
  });

  it("fails closed when the PR URL does not match origin or provider facts are unavailable", () => {
    const repository = createTemporaryGitRepository();
    try {
      runGit(repository.root, [
        "remote",
        "add",
        "origin",
        "https://github.com/example/project.git",
      ]);
      let calls = 0;
      const runner = () => {
        calls += 1;
        return { status: 0, stdout: pullRequestResponse() };
      };
      expect(() =>
        observeGitHubPullRequest(
          repository.root,
          "https://github.com/other/project/pull/17",
          runner,
        ),
      ).toThrow(/does not match the local GitHub origin/);
      expect(calls).toBe(0);
      expect(() =>
        observeGitHubPullRequest(
          repository.root,
          "https://github.com/example/project/pull/404",
          () => ({ status: 1, stdout: "" }),
        ),
      ).toThrow(/facts are unavailable/);
    } finally {
      removeTemporaryGitRepository(repository);
    }
  });
});
