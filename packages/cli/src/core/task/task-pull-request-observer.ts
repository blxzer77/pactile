import { spawnSync } from "node:child_process";
import {
  GitCandidateObservationError,
  readGitRemoteUrl,
} from "./task-candidate-observer.js";

const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const COMMIT_SHA_RE = /^[a-f0-9]{40}([a-f0-9]{24})?$/i;

export interface PullRequestProviderFact {
  readonly source: "github-rest-pull-request-v1";
  readonly url: string;
  readonly repository: string;
  readonly number: number;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
}

export class PullRequestObservationError extends Error {
  public readonly code:
    | "unsupported-provider"
    | "repository-mismatch"
    | "provider-unavailable"
    | "provider-response-invalid"
    | "pull-request-state-invalid";

  public constructor(
    code: PullRequestObservationError["code"],
    message: string,
  ) {
    super(message);
    this.name = "PullRequestObservationError";
    this.code = code;
  }
}

export interface ProviderCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly error?: NodeJS.ErrnoException;
}

export type ProviderCommandRunner = (
  args: readonly string[],
) => ProviderCommandResult;

function runGitHubApi(args: readonly string[]): ProviderCommandResult {
  const environment = {
    ...process.env,
    GH_PROMPT_DISABLED: "1",
    GH_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
  const result = spawnSync("gh", [...args], {
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: MAX_PROVIDER_RESPONSE_BYTES,
    timeout: 10_000,
    stdio: "pipe",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    ...(result.error === undefined
      ? {}
      : { error: result.error as NodeJS.ErrnoException }),
  };
}

function repositoryFromRemote(remoteUrl: string): string | null {
  const scp =
    /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(
      remoteUrl,
    );
  if (scp) return scp[1]?.toLowerCase() ?? null;
  try {
    const url = new URL(remoteUrl);
    if (
      url.hostname.toLowerCase() !== "github.com" ||
      (url.protocol !== "https:" && url.protocol !== "ssh:") ||
      (url.protocol === "https:" && url.username.length > 0) ||
      (url.protocol === "ssh:" && url.username !== "git") ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return null;
    }
    const repository = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "");
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
      ? repository.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function parsePullRequestUrl(reference: string): {
  url: string;
  repository: string;
  number: number;
} {
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    throw new PullRequestObservationError(
      "unsupported-provider",
      "Pull-request evidence must be an absolute GitHub pull-request URL.",
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    parts.length !== 4 ||
    parts[2]?.toLowerCase() !== "pull" ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[0] ?? "") ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[1] ?? "") ||
    !/^\d+$/.test(parts[3] ?? "")
  ) {
    throw new PullRequestObservationError(
      "unsupported-provider",
      "Only canonical HTTPS GitHub pull-request URLs are supported by the built-in read-only provider.",
    );
  }
  const number = Number(parts[3]);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new PullRequestObservationError(
      "unsupported-provider",
      "Pull-request number is invalid.",
    );
  }
  const repository = `${parts[0]}/${parts[1]}`.toLowerCase();
  return {
    url: `https://github.com/${parts[0]}/${parts[1]}/pull/${number}`,
    repository,
    number,
  };
}

function nonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value === value.trim()
  );
}

function parseProviderResponse(
  value: unknown,
  expected: ReturnType<typeof parsePullRequestUrl>,
): PullRequestProviderFact {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PullRequestObservationError(
      "provider-response-invalid",
      "GitHub returned an invalid pull-request response.",
    );
  }
  const input = value as Record<string, unknown>;
  const base = input.base as Record<string, unknown> | null;
  const head = input.head as Record<string, unknown> | null;
  const baseRepository = base?.repo as Record<string, unknown> | null;
  const headSha = (head?.sha as string | undefined)?.toLowerCase();
  const mergeCommitSha =
    input.merge_commit_sha === null
      ? null
      : typeof input.merge_commit_sha === "string"
        ? input.merge_commit_sha.toLowerCase()
        : undefined;
  const state = input.state;
  if (
    input.number !== expected.number ||
    typeof input.html_url !== "string" ||
    input.html_url.replace(/\/$/, "").toLowerCase() !==
      expected.url.toLowerCase() ||
    !nonEmptyString(baseRepository?.full_name) ||
    baseRepository.full_name.toLowerCase() !== expected.repository ||
    !nonEmptyString(headSha) ||
    !COMMIT_SHA_RE.test(headSha) ||
    !nonEmptyString(base?.ref) ||
    (state !== "open" && state !== "closed") ||
    typeof input.draft !== "boolean" ||
    typeof input.merged !== "boolean" ||
    (mergeCommitSha !== null &&
      (typeof mergeCommitSha !== "string" ||
        !COMMIT_SHA_RE.test(mergeCommitSha))) ||
    mergeCommitSha === undefined
  ) {
    throw new PullRequestObservationError(
      "provider-response-invalid",
      "GitHub pull-request facts do not match the requested repository and number.",
    );
  }
  if (input.merged && state !== "closed") {
    throw new PullRequestObservationError(
      "provider-response-invalid",
      "GitHub pull-request state and merge facts disagree.",
    );
  }
  return {
    source: "github-rest-pull-request-v1",
    url: expected.url,
    repository: expected.repository,
    number: expected.number,
    state,
    draft: input.draft,
    headSha,
    baseBranch: base.ref,
    merged: input.merged,
    mergeCommitSha,
  };
}

/** Query trusted provider facts through the built-in, read-only GitHub CLI API. */
export function observeGitHubPullRequest(
  repositoryRoot: string,
  reference: string,
  commandRunner: ProviderCommandRunner = runGitHubApi,
): PullRequestProviderFact {
  const expected = parsePullRequestUrl(reference);
  let remoteRepository: string | null;
  try {
    remoteRepository = repositoryFromRemote(readGitRemoteUrl(repositoryRoot));
  } catch (error) {
    if (error instanceof GitCandidateObservationError) {
      throw new PullRequestObservationError(
        "repository-mismatch",
        "A configured GitHub origin is required to validate pull-request ownership.",
      );
    }
    throw error;
  }
  if (remoteRepository === null || remoteRepository !== expected.repository) {
    throw new PullRequestObservationError(
      "repository-mismatch",
      "Pull-request repository does not match the local GitHub origin.",
    );
  }
  const result = commandRunner([
    "api",
    "-X",
    "GET",
    "--hostname",
    "github.com",
    "-H",
    "Accept: application/vnd.github+json",
    `repos/${expected.repository}/pulls/${expected.number}`,
  ]);
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    Buffer.byteLength(result.stdout, "utf8") > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    throw new PullRequestObservationError(
      "provider-unavailable",
      "GitHub pull-request facts are unavailable; Close cannot use a caller-supplied URL as proof.",
    );
  }
  let response: unknown;
  try {
    response = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new PullRequestObservationError(
      "provider-response-invalid",
      "GitHub returned malformed pull-request JSON.",
    );
  }
  return parseProviderResponse(response, expected);
}
