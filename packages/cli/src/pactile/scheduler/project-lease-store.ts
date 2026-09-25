import fs from "node:fs";
import path from "node:path";

export interface ProjectWriteLeaseRecordV1 {
  id: string;
  pid?: number;
  child_pid?: number;
  durable?: boolean;
  owner_kind?: "parent-child" | "task-kernel-v2-run";
  parent?: string;
  child?: string;
  task_id?: string;
  run_id?: string;
  schedule_receipt_fingerprint?: string;
  touches: string[];
  authorized_conflicts?: {
    taskIds: readonly [string, string];
    approvedBy: string;
    authorizationRef: string;
    integrationPlan: string;
  }[];
  [key: string]: unknown;
}

export interface LocatedProjectWriteLeaseV1 {
  file: string;
  lease: ProjectWriteLeaseRecordV1;
}

function alive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function waitBriefly(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

/** Serializes all P37 active-writer admission decisions for one project root. */
export function withProjectSchedulerMutex<T>(
  rootValue: string,
  action: () => T,
): T {
  const root = path.resolve(rootValue);
  const mutex = path.join(
    root,
    ".pactile",
    ".runtime",
    "scheduler",
    "project-mutex",
  );
  fs.mkdirSync(path.dirname(mutex), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      fs.mkdirSync(mutex);
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const ownerFile = path.join(mutex, "owner.json");
      let owner: { pid?: number } = {};
      let modifiedAt = Date.now();
      try {
        owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as {
          pid?: number;
        };
        modifiedAt = fs.statSync(mutex).mtimeMs;
      } catch {
        try {
          modifiedAt = fs.statSync(mutex).mtimeMs;
        } catch {
          continue;
        }
      }
      if (!alive(owner.pid) && Date.now() - modifiedAt > 5_000) {
        fs.rmSync(ownerFile, { force: true });
        try {
          fs.rmdirSync(mutex);
        } catch {
          /* Another process took the expired mutex. */
        }
      }
      if (attempt === 199) throw new Error("Project scheduler lock timed out");
      waitBriefly();
    }
  }
  if (!acquired) throw new Error("Project scheduler lock timed out");
  const ownerFile = path.join(mutex, "owner.json");
  try {
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    });
    return action();
  } finally {
    fs.rmSync(ownerFile, { force: true });
    fs.rmdirSync(mutex);
  }
}

function readLease(file: string): ProjectWriteLeaseRecordV1 {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid project write lease: ${file}`);
  const lease = value as ProjectWriteLeaseRecordV1;
  if (
    typeof lease.id !== "string" ||
    !lease.id ||
    !Array.isArray(lease.touches) ||
    lease.touches.some((touch) => typeof touch !== "string")
  ) {
    throw new Error(`Invalid project write lease: ${file}`);
  }
  // Normalize legacy leases in memory so older casing/path forms cannot bypass
  // conflicts with newly admitted writers. An empty legacy scope is unknown,
  // so normalizeProjectWriteSet conservatively treats it as a project-wide
  // write. Do not rewrite the persisted compatibility record.
  return { ...lease, touches: normalizeProjectWriteSet(lease.touches) };
}

/** Reads both legacy Parent lease folders and the V2 project-level lease folder. Call under withProjectSchedulerMutex. */
export function listProjectWriteLeases(
  rootValue: string,
): LocatedProjectWriteLeaseV1[] {
  const root = path.resolve(rootValue);
  const folders: string[] = [];
  const tasksRoot = path.join(root, ".pactile", "tasks");
  if (fs.existsSync(tasksRoot)) {
    for (const entry of fs.readdirSync(tasksRoot, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        ["archive", "locale", "templates"].includes(entry.name)
      )
        continue;
      const folder = path.join(tasksRoot, entry.name, "parallel", "active");
      if (fs.existsSync(folder)) folders.push(folder);
    }
  }
  const projectActive = path.join(
    root,
    ".pactile",
    ".runtime",
    "scheduler",
    "active",
  );
  if (fs.existsSync(projectActive)) folders.push(projectActive);

  const leases: LocatedProjectWriteLeaseV1[] = [];
  for (const folder of folders.sort()) {
    for (const name of fs
      .readdirSync(folder)
      .filter((entry) => entry.endsWith(".json"))
      .sort()) {
      const file = path.join(folder, name);
      const lease = readLease(file);
      if (!lease.durable && !alive(lease.pid) && !alive(lease.child_pid)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      leases.push({ file, lease });
    }
  }
  return leases;
}

/** Canonicalizes concrete project-relative writes. Missing scope is a wildcard. */
export function normalizeProjectWriteSet(
  values: readonly string[] | null | undefined,
): string[] {
  if (!values?.length) return ["*"];
  if (values.length === 1 && values[0] === "*") return ["*"];
  return [
    ...new Set(
      values.map((value) => {
        if (typeof value !== "string")
          throw new Error("write set must contain paths");
        const original = value.trim();
        const normalized = original
          .replaceAll("\\", "/")
          .replace(/^\.\//, "")
          .replace(/\/$/, "")
          .normalize("NFC");
        const segments = normalized.split("/");
        if (
          !normalized ||
          normalized === "." ||
          normalized.startsWith("/") ||
          /^[A-Za-z]:/.test(normalized) ||
          normalized.includes("*") ||
          normalized.includes("?") ||
          normalized.includes("[") ||
          normalized.includes("]") ||
          segments.some(
            (segment) => !segment || segment === "." || segment === "..",
          )
        ) {
          throw new Error(
            `write set must contain concrete project-relative paths: ${value}`,
          );
        }
        return process.platform === "win32"
          ? normalized.toLowerCase()
          : normalized;
      }),
    ),
  ].sort();
}

export function projectWriteSetsConflict(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = normalizeProjectWriteSet(left);
  const normalizedRight = normalizeProjectWriteSet(right);
  return normalizedLeft.some((a) =>
    normalizedRight.some(
      (b) =>
        a === "*" ||
        b === "*" ||
        a === b ||
        a.startsWith(`${b}/`) ||
        b.startsWith(`${a}/`),
    ),
  );
}

export function projectActiveLeasePath(
  rootValue: string,
  leaseId: string,
): string {
  if (
    !leaseId ||
    path.basename(leaseId) !== leaseId ||
    leaseId.includes("/") ||
    leaseId.includes("\\")
  )
    throw new Error("Invalid project write lease ID");
  return path.join(
    path.resolve(rootValue),
    ".pactile",
    ".runtime",
    "scheduler",
    "active",
    `${leaseId}.json`,
  );
}

export function projectLeaseHistoryPath(
  rootValue: string,
  leaseId: string,
): string {
  if (
    !leaseId ||
    path.basename(leaseId) !== leaseId ||
    leaseId.includes("/") ||
    leaseId.includes("\\")
  )
    throw new Error("Invalid project write lease ID");
  return path.join(
    path.resolve(rootValue),
    ".pactile",
    ".runtime",
    "scheduler",
    "lease-history",
    `${leaseId}.json`,
  );
}
