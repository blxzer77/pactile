import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTaskCandidateEntry,
  GitCandidateObservationError,
  observeGitCandidate,
  observeTaskRunCandidate,
} from "../../../src/pactile/verification/index.js";
import type { TaskRunObservationSource } from "../../../src/pactile/verification/index.js";
import {
  createTemporaryGitRepository,
  removeTemporaryGitRepository,
  runGit,
} from "./git-fixture.js";

describe("read-only Git candidate observation", () => {
  it("fingerprints staged, unstaged and allowed untracked bytes deterministically", () => {
    const repository = createTemporaryGitRepository();
    try {
      fs.writeFileSync(
        path.join(repository.root, "src", "task.ts"),
        "export const task = 'staged';\n",
      );
      runGit(repository.root, ["add", "src/task.ts"]);
      fs.mkdirSync(path.join(repository.root, "docs"), { recursive: true });
      fs.writeFileSync(
        path.join(repository.root, "docs", "acceptance.md"),
        "public outcome\n",
      );
      fs.writeFileSync(
        path.join(repository.root, "src", "local.env"),
        "private=not-read\n",
      );

      const allowedWriteSet = {
        exactPaths: ["src/task.ts"],
        directoryPrefixes: ["docs"],
      };
      const beforeStatus = runGit(repository.root, [
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
      ]);
      const first = observeGitCandidate({
        repositoryRoot: repository.root,
        allowedWriteSet,
      });
      const second = observeGitCandidate({
        repositoryRoot: repository.root,
        allowedWriteSet,
      });
      const afterStatus = runGit(repository.root, [
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
      ]);

      expect(first.head).toBe(repository.head);
      expect(first.stagedPaths).toEqual(["src/task.ts"]);
      expect(first.untrackedPaths).toEqual([
        "docs/acceptance.md",
        "src/local.env",
      ]);
      expect(first.inScopePaths).toEqual(["docs/acceptance.md", "src/task.ts"]);
      expect(first.outOfScopePaths).toEqual(["src/local.env"]);
      expect(first.currentFiles.map(({ path: filePath }) => filePath)).toEqual(
        first.inScopePaths,
      );
      expect(first.scopeStatus).toBe("out-of-scope");
      expect(first.fingerprint).toBe(second.fingerprint);
      expect(first.observedAt).not.toBe(second.observedAt);
      expect(afterStatus).toBe(beforeStatus);
      expect(() => createTaskCandidateEntry(first)).toThrow(
        GitCandidateObservationError,
      );
    } finally {
      removeTemporaryGitRepository(repository);
    }
  });

  it("invalidates a candidate when allowed current bytes or HEAD change", () => {
    const repository = createTemporaryGitRepository();
    try {
      fs.writeFileSync(
        path.join(repository.root, "src", "task.ts"),
        "export const task = 'first';\n",
      );
      const allowedWriteSet = {
        exactPaths: ["src/task.ts"],
        directoryPrefixes: [],
      };
      const first = observeGitCandidate({
        repositoryRoot: repository.root,
        allowedWriteSet,
      });
      expect(createTaskCandidateEntry(first).fingerprint).toBe(
        first.fingerprint,
      );

      fs.writeFileSync(
        path.join(repository.root, "src", "task.ts"),
        "export const task = 'changed';\n",
      );
      const changedBytes = observeGitCandidate({
        repositoryRoot: repository.root,
        allowedWriteSet,
      });
      expect(changedBytes.fingerprint).not.toBe(first.fingerprint);
      expect(changedBytes.unstagedPaths).toEqual(["src/task.ts"]);
      expect(changedBytes.currentFiles[0]?.sha256).not.toBe(
        first.currentFiles[0]?.sha256,
      );

      runGit(repository.root, ["add", "src/task.ts"]);
      runGit(repository.root, ["commit", "--quiet", "-m", "new candidate"]);
      const changedHead = observeGitCandidate({
        repositoryRoot: repository.root,
        allowedWriteSet,
      });
      expect(changedHead.head).not.toBe(first.head);
      expect(changedHead.fingerprint).not.toBe(first.fingerprint);
    } finally {
      removeTemporaryGitRepository(repository);
    }
  });

  it("adapts the frozen P35 Run workspace and rejects mismatched write sets", () => {
    const repository = createTemporaryGitRepository();
    try {
      const workspace = {
        ownerRunId: "run-1",
        canonicalPath: repository.root,
        branch: repository.branch,
        baseSha: repository.head,
        writeSet: ["src/task.ts", "docs/"],
        integrationState: "not-integrated" as const,
        reclamationState: "not-requested" as const,
      };
      const run: TaskRunObservationSource = {
        writeSetSnapshot: ["src/task.ts", "docs/"],
        workspace,
      };
      const observation = observeTaskRunCandidate({ run });
      expect(observation.expectedBaseSha).toBe(repository.head);
      expect(observation.expectedBranch).toBe(repository.branch);
      expect(observation.scopeStatus).toBe("within-write-set");
      expect(() =>
        observeTaskRunCandidate({
          run: {
            ...run,
            workspace: { ...workspace, writeSet: ["src/other.ts"] },
          },
        }),
      ).toThrow(/disagree/);
      expect(() =>
        observeTaskRunCandidate({
          run,
          repositoryRoot: `${repository.root}-different`,
        }),
      ).toThrow(/does not match/);
    } finally {
      removeTemporaryGitRepository(repository);
    }
  });

  it("fails closed on unsafe paths and expected-branch mismatch", () => {
    const repository = createTemporaryGitRepository();
    try {
      expect(() =>
        observeGitCandidate({
          repositoryRoot: repository.root,
          allowedWriteSet: {
            exactPaths: ["../outside"],
            directoryPrefixes: [],
          },
        }),
      ).toThrow(/unsafe path segment/);
      const mismatch = observeGitCandidate({
        repositoryRoot: repository.root,
        allowedWriteSet: { exactPaths: ["src/task.ts"], directoryPrefixes: [] },
        expectedBranch: "another-branch",
      });
      expect(mismatch.scopeStatus).toBe("workspace-mismatch");
      expect(() => createTaskCandidateEntry(mismatch)).toThrow(
        /workspace-mismatch/,
      );
    } finally {
      removeTemporaryGitRepository(repository);
    }
  });
});
