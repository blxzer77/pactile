import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
  parseInstallStateV1,
  type InstallStateV1,
} from "../../core/index.js";
import {
  RuntimeError,
  assertCanonicalWriteTarget,
  caseFoldComponent,
  isMissing,
  maybeStat,
  normalizeRuntimeRelativePath,
  resolveCanonicalPaths,
  runtimeBoundary,
  type RuntimeErrorCode,
  type RuntimeFileSystem,
} from "./paths.js";

export interface GenerationFile {
  path: string;
  fingerprint: string;
}
export interface GenerationSeal {
  schemaVersion: 1;
  generationId: string;
  files: GenerationFile[];
  fingerprint: string;
}
export interface InstallStateSnapshot {
  state: InstallStateV1;
  fingerprint: string;
}

function digest(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** Prefix every M0 ID: percent encoding alone does not escape Windows devices. */
function generationName(id: string): string {
  if (!/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/.test(id))
    throw new RuntimeError("generation-invalid");
  return `g-${encodeURIComponent(id)}`;
}

function prepareDirectory(
  root: string,
  directory: string,
  io: RuntimeFileSystem,
): void {
  const target = assertCanonicalWriteTarget(root, directory, io);
  runtimeBoundary("atomic-replace-failed", () =>
    io.mkdirSync(target, { recursive: true }),
  );
  assertCanonicalWriteTarget(root, target, io);
}

function writeExclusive(
  root: string,
  target: string,
  content: string | Buffer,
  io: RuntimeFileSystem,
  collisionCode: RuntimeErrorCode = "atomic-replace-failed",
): void {
  assertCanonicalWriteTarget(root, target, io);
  let descriptor: number | undefined;
  try {
    descriptor = io.openSync(
      target,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const stat = io.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new RuntimeError("link-escape");
    assertCanonicalWriteTarget(root, target, io);
    io.writeFileSync(descriptor, content);
    io.fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new RuntimeError(collisionCode);
    throw new RuntimeError("atomic-replace-failed");
  } finally {
    if (descriptor !== undefined) {
      const openedDescriptor = descriptor;
      runtimeBoundary("atomic-replace-failed", () =>
        io.closeSync(openedDescriptor),
      );
    }
  }
}

/** Cooperative cross-process lock. A crash leaves an explicit lock, never stolen. */
function withLock<T>(
  root: string,
  target: string,
  io: RuntimeFileSystem,
  action: () => T,
): T {
  const token = randomUUID();
  try {
    writeExclusive(root, target, token, io);
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError(
      "atomic-replace-failed",
      "atomic-replace-failed: writer lock unavailable",
    );
  }
  try {
    return runtimeBoundary("atomic-replace-failed", action);
  } finally {
    // Only unlink a lock that is provably ours. Recovery reports any residue.
    try {
      assertCanonicalWriteTarget(root, target, io);
      if (io.readFileSync(target, "utf8") === token) io.unlinkSync(target);
    } catch {
      /* A failed cleanup must not misreport an already-committed CAS. */
    }
  }
}

function atomicReplace(
  root: string,
  target: string,
  contents: string,
  io: RuntimeFileSystem,
): void {
  const temporary = `${target}.tmp-${randomUUID()}`;
  let created = false;
  try {
    writeExclusive(root, temporary, contents, io);
    created = true;
    assertCanonicalWriteTarget(root, target, io);
    assertCanonicalWriteTarget(root, temporary, io);
    io.renameSync(temporary, target);
  } catch (error) {
    // Keep the old pointer. Do not delete arbitrary temp files or retry by unlinking target.
    if (created) {
      try {
        assertCanonicalWriteTarget(root, temporary, io);
        io.unlinkSync(temporary);
      } catch {
        /* Leftover temp is discoverable by recover(). */
      }
    }
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError("atomic-replace-failed");
  }
}

function fileOrder(a: GenerationFile, b: GenerationFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Immutable generation contents live below files/, separately from store metadata. */
export class GenerationStore {
  private readonly paths;
  constructor(
    readonly projectRoot: string,
    private readonly io: RuntimeFileSystem = fs,
  ) {
    this.paths = resolveCanonicalPaths(projectRoot);
  }

  private directory(id: string): string {
    return assertCanonicalWriteTarget(
      this.projectRoot,
      path.join(this.paths.generationsPath, generationName(id)),
      this.io,
    );
  }

  stage(id: string): void {
    const directory = this.directory(id);
    prepareDirectory(this.projectRoot, this.paths.generationsPath, this.io);
    if (maybeStat(this.io, directory))
      throw new RuntimeError("generation-invalid", "generation-invalid");
    try {
      this.io.mkdirSync(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        throw new RuntimeError("generation-invalid");
      throw new RuntimeError("atomic-replace-failed");
    }
    writeExclusive(
      this.projectRoot,
      path.join(directory, ".stage.json"),
      canonicalizePactileJsonV1({ schemaVersion: 1, generationId: id }),
      this.io,
    );
    prepareDirectory(this.projectRoot, path.join(directory, "files"), this.io);
  }

  private assertStaging(id: string): string {
    const directory = this.directory(id);
    if (maybeStat(this.io, path.join(directory, ".sealed.json")))
      throw new RuntimeError("generation-sealed");
    try {
      const markerPath = assertCanonicalWriteTarget(
        this.projectRoot,
        path.join(directory, ".stage.json"),
        this.io,
      );
      const marker: unknown = JSON.parse(
        this.io.readFileSync(markerPath, "utf8"),
      );
      if (
        canonicalizePactileJsonV1(marker) !==
        canonicalizePactileJsonV1({ schemaVersion: 1, generationId: id })
      )
        throw new RuntimeError("generation-invalid");
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError("generation-invalid");
    }
    return directory;
  }

  writeFile(
    id: string,
    relativePath: string,
    contents: string | Buffer,
  ): GenerationFile {
    const relative = normalizeRuntimeRelativePath(relativePath);
    const directory = this.assertStaging(id);
    return withLock(
      this.projectRoot,
      path.join(directory, ".generation.lock"),
      this.io,
      () => {
        this.assertStaging(id);
        const target = assertCanonicalWriteTarget(
          this.projectRoot,
          path.join(directory, "files", relative),
          this.io,
        );
        prepareDirectory(this.projectRoot, path.dirname(target), this.io);
        writeExclusive(
          this.projectRoot,
          target,
          contents,
          this.io,
          "generation-invalid",
        );
        return { path: relative, fingerprint: digest(contents) };
      },
    );
  }

  private inventory(id: string): GenerationFile[] {
    const base = path.join(this.directory(id), "files");
    const files: GenerationFile[] = [];
    const visit = (directory: string): void => {
      assertCanonicalWriteTarget(this.projectRoot, directory, this.io);
      const names = this.io.readdirSync(directory).sort();
      const folded = names.map(caseFoldComponent);
      if (new Set(folded).size !== folded.length)
        throw new RuntimeError("canonical-collision");
      for (const name of names) {
        const target = assertCanonicalWriteTarget(
          this.projectRoot,
          path.join(directory, name),
          this.io,
        );
        const stat = this.io.lstatSync(target);
        if (stat.isDirectory()) visit(target);
        else
          files.push({
            path: path.relative(base, target).split(path.sep).join("/"),
            fingerprint: digest(this.io.readFileSync(target)),
          });
      }
    };
    visit(base);
    return files.sort(fileOrder);
  }

  /** The caller supplies the expected inventory; unlisted or changed bytes fail seal. */
  seal(id: string, expectedFiles: readonly GenerationFile[]): GenerationSeal {
    const directory = this.assertStaging(id);
    return withLock(
      this.projectRoot,
      path.join(directory, ".generation.lock"),
      this.io,
      () => {
        this.assertStaging(id);
        const actual = this.inventory(id);
        const expected = [...expectedFiles].sort(fileOrder);
        if (
          canonicalizePactileJsonV1(actual) !==
          canonicalizePactileJsonV1(expected)
        )
          throw new RuntimeError(
            "generation-invalid",
            "generation-invalid: manifest mismatch",
          );
        const payload = {
          schemaVersion: 1 as const,
          generationId: id,
          files: actual,
        };
        const seal = {
          ...payload,
          fingerprint: fingerprintPactileContractV1(payload),
        };
        atomicReplace(
          this.projectRoot,
          path.join(directory, ".sealed.json"),
          canonicalizePactileJsonV1(seal),
          this.io,
        );
        return seal;
      },
    );
  }

  verify(id: string): GenerationSeal {
    const directory = this.directory(id);
    try {
      const marker = assertCanonicalWriteTarget(
        this.projectRoot,
        path.join(directory, ".sealed.json"),
        this.io,
      );
      const seal: unknown = JSON.parse(this.io.readFileSync(marker, "utf8"));
      const payload = {
        schemaVersion: 1 as const,
        generationId: id,
        files: this.inventory(id),
      };
      const expected = {
        ...payload,
        fingerprint: fingerprintPactileContractV1(payload),
      };
      if (
        canonicalizePactileJsonV1(seal) !== canonicalizePactileJsonV1(expected)
      )
        throw new RuntimeError("generation-unsealed");
      return expected;
    } catch (error) {
      if (
        error instanceof RuntimeError &&
        ["link-escape", "canonical-collision", "outside-project"].includes(
          error.code,
        )
      )
        throw error;
      throw new RuntimeError("generation-unsealed");
    }
  }

  readFile(id: string, relativePath: string): Buffer {
    return this.readFiles(id, [relativePath]).get(
      normalizeRuntimeRelativePath(relativePath),
    ) as Buffer;
  }

  /** Verify the immutable inventory once, then read an exact requested set. */
  readFiles(id: string, relativePaths: readonly string[]): Map<string, Buffer> {
    const normalized = relativePaths.map(normalizeRuntimeRelativePath);
    if (new Set(normalized).size !== normalized.length)
      throw new RuntimeError("generation-invalid");
    const seal = this.verify(id);
    const allowed = new Set(seal.files.map((file) => file.path));
    if (normalized.some((relative) => !allowed.has(relative)))
      throw new RuntimeError("generation-invalid");
    const result = new Map<string, Buffer>();
    for (const relative of normalized) {
      const target = assertCanonicalWriteTarget(
        this.projectRoot,
        path.join(this.directory(id), "files", relative),
        this.io,
      );
      result.set(
        relative,
        runtimeBoundary("generation-unsealed", () =>
          this.io.readFileSync(target),
        ),
      );
    }
    return result;
  }
}

export interface RuntimeRecovery {
  activeGenerationId: string | null;
  diagnostics: { code: string; path: string }[];
}

/** InstallState.generationId is the sole active pointer, updated under a CAS lock. */
export class InstallStateStore {
  private readonly paths;
  constructor(
    readonly projectRoot: string,
    private readonly io: RuntimeFileSystem = fs,
  ) {
    this.paths = resolveCanonicalPaths(projectRoot);
  }

  read(): InstallStateSnapshot | null {
    const target = assertCanonicalWriteTarget(
      this.projectRoot,
      this.paths.installStatePath,
      this.io,
    );
    let value: unknown;
    try {
      value = JSON.parse(this.io.readFileSync(target, "utf8"));
    } catch (error) {
      if (isMissing(error)) return null;
      throw new RuntimeError("state-malformed");
    }
    const parsed = parseInstallStateV1(value);
    if (!parsed.success) throw new RuntimeError("state-malformed");
    return { state: parsed.data, fingerprint: parsed.fingerprint };
  }

  compareAndSwap(
    expectedFingerprint: string | null,
    next: InstallStateV1,
  ): InstallStateSnapshot {
    const parsed = parseInstallStateV1(next);
    if (!parsed.success) throw new RuntimeError("state-malformed");
    prepareDirectory(
      this.projectRoot,
      path.dirname(this.paths.installStatePath),
      this.io,
    );
    return withLock(
      this.projectRoot,
      `${this.paths.installStatePath}.lock`,
      this.io,
      () => {
        const current = this.read();
        if ((current?.fingerprint ?? null) !== expectedFingerprint)
          throw new RuntimeError("cas-mismatch");
        new GenerationStore(this.projectRoot, this.io).verify(
          parsed.data.generationId,
        );
        atomicReplace(
          this.projectRoot,
          this.paths.installStatePath,
          canonicalizePactileJsonV1(parsed.data),
          this.io,
        );
        return { state: parsed.data, fingerprint: parsed.fingerprint };
      },
    );
  }

  /** Diagnostics only: never delete an unknown generation, lock or temp. */
  recover(): RuntimeRecovery {
    return runtimeBoundary("state-malformed", () => this.recoverSnapshot());
  }

  private recoverSnapshot(): RuntimeRecovery {
    const result: RuntimeRecovery = {
      activeGenerationId: null,
      diagnostics: [],
    };
    let pointerKnown = true;
    const report = (code: string, target: string): void => {
      const relativePath = path
        .relative(path.resolve(this.projectRoot), target)
        .split(path.sep)
        .join("/");
      if (
        !result.diagnostics.some(
          (item) => item.code === code && item.path === relativePath,
        )
      ) {
        result.diagnostics.push({ code, path: relativePath });
      }
    };
    try {
      result.activeGenerationId = this.read()?.state.generationId ?? null;
    } catch (error) {
      if (!(error instanceof RuntimeError)) throw error;
      pointerKnown = false;
      report(error.code, this.paths.installStatePath);
    }
    // Validate the pointer independently of directory enumeration: a missing
    // generation (or the whole store) must never produce empty diagnostics.
    if (result.activeGenerationId !== null) {
      const activeTarget = path.join(
        this.paths.generationsPath,
        generationName(result.activeGenerationId),
      );
      try {
        new GenerationStore(this.projectRoot, this.io).verify(
          result.activeGenerationId,
        );
      } catch (error) {
        report(
          error instanceof RuntimeError ? error.code : "generation-unsealed",
          activeTarget,
        );
      }
    }
    const directory = assertCanonicalWriteTarget(
      this.projectRoot,
      path.dirname(this.paths.installStatePath),
      this.io,
    );
    if (!maybeStat(this.io, directory)) return result;
    for (const name of this.io.readdirSync(directory).sort()) {
      if (name.startsWith("install-state.json.tmp-"))
        report("leftover-temp", path.join(directory, name));
      if (name === "install-state.json.lock")
        report("leftover-lock", path.join(directory, name));
    }
    const generations = assertCanonicalWriteTarget(
      this.projectRoot,
      this.paths.generationsPath,
      this.io,
    );
    if (maybeStat(this.io, generations)) {
      for (const name of this.io.readdirSync(generations).sort()) {
        const target = path.join(generations, name);
        try {
          if (!name.startsWith("g-"))
            throw new RuntimeError("generation-invalid");
          const id = decodeURIComponent(name.slice(2));
          if (generationName(id) !== name)
            throw new RuntimeError("generation-invalid");
          assertCanonicalWriteTarget(this.projectRoot, target, this.io);
          for (const metadata of this.io.readdirSync(target).sort()) {
            if (metadata.startsWith(".sealed.json.tmp-"))
              report("leftover-temp", path.join(target, metadata));
            if (metadata === ".generation.lock")
              report("leftover-lock", path.join(target, metadata));
          }
          if (id !== result.activeGenerationId)
            new GenerationStore(this.projectRoot, this.io).verify(id);
          if (!pointerKnown) report("generation-activation-unknown", target);
          else if (id !== result.activeGenerationId)
            report("orphan-generation", target);
        } catch (error) {
          report(
            error instanceof RuntimeError ? error.code : "generation-invalid",
            target,
          );
        }
      }
    }
    result.diagnostics.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : 1,
    );
    return result;
  }
}
