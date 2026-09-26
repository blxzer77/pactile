import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args.length !== 7 || args.some((value) => !value)) {
  throw new Error(
    "Usage: node worktree-owner-claim.js <cli-root> <repo-root> <run-id> <canonical-path> <branch> <base-sha> <barrier-dir>",
  );
}
const [cliRoot, root, runId, canonicalPath, branch, baseSha, barrierDir] = args;

const { repoIdentity } = await import(
  pathToFileURL(path.join(cliRoot, "dist/pactile/worktree/git-probe.js")).href
);
const { persistManagerProvenance, provenanceFor } = await import(
  pathToFileURL(
    path.join(cliRoot, "dist/pactile/worktree/manager-provenance.js"),
  ).href
);

const identity = repoIdentity(root);
const registry = path.join(identity.commonDir, "pactile-run-workspaces-v1");
const originalOpenSync = fs.openSync.bind(fs);
type OpenSyncArgs = Parameters<typeof fs.openSync>;
fs.openSync = ((...args: OpenSyncArgs) => {
  const [file, flags] = args;
  const requested = typeof file === "string" ? file : String(file);
  if (flags === "wx" && path.dirname(requested) === registry) {
    fs.writeFileSync(path.join(barrierDir, `${runId}.ready`), "after-precheck");
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(path.join(barrierDir, "go"))) {
      if (Date.now() > deadline) throw new Error("claim barrier timed out");
      Atomics.wait(waitCell, 0, 0, 10);
    }
  }
  return Reflect.apply(originalOpenSync, fs, args);
}) as typeof fs.openSync;

const gitDir = execFileSync(
  "git",
  ["rev-parse", "--absolute-git-dir"],
  { cwd: canonicalPath, encoding: "utf8" },
).trim();
const provenance = provenanceFor({
  identity,
  gitDir,
  source: "adopted",
  adoption: { approvedBy: "test", approvedAt: "now", evidenceRef: "test:race" },
  binding: {
    ownerRunId: runId,
    canonicalPath,
    branch,
    baseSha,
    writeSet: ["src"],
    integrationState: "not-integrated",
    reclamationState: "not-requested",
  },
});

try {
  persistManagerProvenance(identity, provenance);
  console.log(`CLAIMED:${runId}`);
} catch (error) {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (code === "owner-conflict" || code === "manager-provenance-invalid") {
    console.log(`REJECTED:${runId}:${code}`);
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}
