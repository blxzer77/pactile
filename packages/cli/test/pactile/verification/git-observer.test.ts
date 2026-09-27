import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTaskCandidateEntry,
  fingerprintCurrentRepositoryFile,
  GitCandidateObservationError,
  observeGitCandidate,
  observeGitRepositoryBaseline,
  observeTaskRunCandidate,
} from "../../../src/pactile/verification/index.js";
import type { TaskRunObservationSource } from "../../../src/pactile/verification/index.js";
import {
  createTemporaryGitRepository,
  removeTemporaryGitRepository,
  runGit,
} from "./git-fixture.js";

describe("read-only Git candidate observation", () => {
  it("rejects a nested directory as the repository root", () => {
    const repository = createTemporaryGitRepository();
    try {
      expect(() =>
        observeGitRepositoryBaseline(path.join(repository.root, "src")),
      ).toThrow(/Git top-level directory/);
    } finally {
      removeTemporaryGitRepository(repository);
    }
  });

  it("accepts a Windows short-path spelling of the same Git root", (context) => {
    if (process.platform !== "win32") {
      context.skip("Windows 8.3 paths are unavailable on this platform");
      return;
    }
    const repository = createTemporaryGitRepository();
    try {
      const shortRoot = execFileSync(
        "cmd.exe",
        ["/d", "/c", `for %I in ("${repository.root}") do @echo %~sI`],
        { encoding: "utf8", windowsHide: true },
      ).trim();
      if (!fs.existsSync(shortRoot) || shortRoot === repository.root) {
        context.skip("This volume does not expose a distinct 8.3 alias");
        return;
      }
      const baseline = observeGitRepositoryBaseline(shortRoot);
      expect(baseline.headSha).toBe(repository.head);
      expect(() =>
        observeGitRepositoryBaseline(path.join(shortRoot, "src")),
      ).toThrow(/Git top-level directory/);
    } finally {
      removeTemporaryGitRepository(repository);
    }
  });

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

  it("includes committed base-to-HEAD paths when enforcing the frozen write set", () => {
    const repository = createTemporaryGitRepository();
    try {
      const baseSha = repository.head;
      fs.mkdirSync(path.join(repository.root, "docs"), { recursive: true });
      fs.writeFileSync(
        path.join(repository.root, "docs", "outside.md"),
        "committed outside the Run write set\n",
      );
      runGit(repository.root, ["add", "docs/outside.md"]);
      runGit(repository.root, [
        "commit",
        "--quiet",
        "-m",
        "out-of-scope commit",
      ]);

      const observation = observeGitCandidate({
        repositoryRoot: repository.root,
        expectedBaseSha: baseSha,
        allowedWriteSet: { exactPaths: ["src/task.ts"], directoryPrefixes: [] },
      });

      expect(observation.committedPaths).toEqual(["docs/outside.md"]);
      expect(observation.affectedPaths).toContain("docs/outside.md");
      expect(observation.outOfScopePaths).toContain("docs/outside.md");
      expect(observation.scopeStatus).toBe("out-of-scope");
      expect(() => createTaskCandidateEntry(observation)).toThrow(
        /out-of-scope/,
      );
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
        id: "run-1",
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

  it("preserves a detached-HEAD baseline as an explicit branch expectation", () => {
    const repository = createTemporaryGitRepository();
    try {
      runGit(repository.root, [
        "checkout",
        "--quiet",
        "--detach",
        repository.head,
      ]);
      const baseline = observeGitRepositoryBaseline(repository.root);
      expect(baseline.headSha).toBe(repository.head);
      expect(baseline.branch).toBeNull();

      runGit(repository.root, [
        "checkout",
        "--quiet",
        "-b",
        "attached-at-same-head",
      ]);
      const observation = observeGitCandidate({
        repositoryRoot: repository.root,
        expectedBaseSha: baseline.headSha,
        expectedBranch: baseline.branch,
        allowedWriteSet: { exactPaths: ["src/task.ts"], directoryPrefixes: [] },
      });

      expect(observation.head).toBe(baseline.headSha);
      expect(observation.expectedBranchBound).toBe(true);
      expect(observation.expectedBranch).toBeNull();
      expect(observation.branch).toBe("attached-at-same-head");
      expect(observation.scopeStatus).toBe("workspace-mismatch");
      expect(() => createTaskCandidateEntry(observation)).toThrow(
        /workspace-mismatch/,
      );
    } finally {
      removeTemporaryGitRepository(repository);
    }
  });

  it("rejects symlink delivery paths instead of hashing the link target file", (context) => {
    const repository = createTemporaryGitRepository();
    const outside = path.join(
      path.dirname(repository.root),
      "pactile-verification-outside.txt",
    );
    const link = path.join(repository.root, "src", "outside-link.txt");
    try {
      fs.writeFileSync(outside, "outside bytes\n");
      try {
        fs.symlinkSync(outside, link, "file");
      } catch (error) {
        if (process.platform === "win32") {
          context.skip(
            `Windows does not permit creating the test symlink: ${String(error)}`,
          );
          return;
        }
        throw error;
      }
      expect(() =>
        fingerprintCurrentRepositoryFile(
          repository.root,
          "src/outside-link.txt",
        ),
      ).toThrow(/regular file inside the repository/);
      expect(() =>
        fingerprintCurrentRepositoryFile(
          repository.root,
          "../pactile-verification-outside.txt",
        ),
      ).toThrow(/unsafe path segment/);
    } finally {
      fs.rmSync(outside, { force: true });
      removeTemporaryGitRepository(repository);
    }
  });
});
