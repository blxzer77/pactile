import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Locale = "en" | "zh-CN";

interface SourceMapping {
  path: string;
  action: string;
  targetPage: string;
}

interface TargetPage {
  id: string;
  parityRequired: boolean;
  paths: Partial<Record<Locale | "neutral", string>>;
}

interface DocumentationMap {
  sourceMappings: SourceMapping[];
  targetPages: TargetPage[];
}

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../../..");
const mapPath = path.join(repoRoot, "docs/pactile/documentation-map.json");

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function readUtf8(relativePath: string): string {
  return fs.readFileSync(
    path.join(repoRoot, ...relativePath.split("/")),
    "utf8",
  );
}

function markdownLinks(content: string): string[] {
  const links: string[] = [];
  const pattern = /\[[^\]]+\]\(([^)]+)\)/gu;
  for (const match of content.matchAll(pattern)) {
    const raw = match[1].trim().replace(/^<|>$/gu, "").split(/\s+/u)[0];
    if (raw === "" || raw.startsWith("#") || /^[a-z][a-z\d+.-]*:/iu.test(raw)) {
      continue;
    }
    links.push(raw.split("#", 1)[0]);
  }
  return links.filter(Boolean);
}

function resolveRelative(sourcePath: string, link: string): string | null {
  const sourceAbsolute = path.join(repoRoot, ...sourcePath.split("/"));
  const candidate = path.resolve(path.dirname(sourceAbsolute), link);
  const relative = path.relative(repoRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.replaceAll("\\", "/");
}

function headingLevels(content: string): number[] {
  return content
    .split(/\r?\n/u)
    .filter((line) => /^\s{0,3}#{1,6}\s+\S/u.test(line))
    .map((line) => line.match(/^\s{0,3}(#+)/u)?.[1].length ?? 0);
}

function commandLines(content: string): string[] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^(?:pactile|pnpm|npm|node|git)(?:\s|$)/u.test(line));
}

function sectionAfterAnchor(content: string, id: string): string {
  const anchor = `<a id="${id}"></a>`;
  const anchorIndex = content.indexOf(anchor);
  if (anchorIndex < 0) throw new Error(`missing documentation anchor: ${id}`);
  const section = content.slice(anchorIndex + anchor.length);
  const headings = [...section.matchAll(/^##\s+.+$/gmu)];
  const nextHeading = headings[1]?.index;
  return nextHeading === undefined ? section : section.slice(0, nextHeading);
}

function fencedCodeBlocks(content: string, language: string): string[] {
  const blocks: string[] = [];
  let fence: string | null = null;
  let capturesBlock = false;
  let lines: string[] = [];
  for (const line of content.split(/\r?\n/u)) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence === null) {
      if (!delimiter) continue;
      fence = delimiter[1] ?? null;
      capturesBlock = delimiter[2]?.trim().split(/\s+/u)[0] === language;
      lines = [];
      continue;
    }
    if (
      delimiter &&
      delimiter[1]?.[0] === fence[0] &&
      (delimiter[1]?.length ?? 0) >= fence.length &&
      delimiter[2]?.trim() === ""
    ) {
      if (capturesBlock) blocks.push(lines.join("\n"));
      fence = null;
      capturesBlock = false;
      lines = [];
      continue;
    }
    if (capturesBlock) lines.push(line);
  }
  return blocks;
}

function normalizedLinkDestinations(sourcePath: string): string[] {
  return markdownLinks(readUtf8(sourcePath))
    .map((link) => resolveRelative(sourcePath, link))
    .filter((value): value is string => value !== null)
    .map((value) => value.replace(/\.zh-CN(?=\.md$)/u, ""))
    .sort();
}

const documentationMap = readJson<DocumentationMap>(mapPath);
const targetById = new Map(
  documentationMap.targetPages.map((page) => [page.id, page]),
);

describe("Batch 4 documentation links and locale parity", () => {
  it("keeps every mapped Markdown link inside the repository and resolvable", () => {
    const failures: string[] = [];
    for (const mapping of documentationMap.sourceMappings) {
      if (!mapping.path.endsWith(".md")) continue;
      for (const link of markdownLinks(readUtf8(mapping.path))) {
        const resolved = resolveRelative(mapping.path, link);
        if (
          resolved === null ||
          !fs.existsSync(path.join(repoRoot, ...resolved.split("/")))
        ) {
          failures.push(`${mapping.path} -> ${link}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps parity-required target pages aligned on outline, commands, and destinations", () => {
    const failures: string[] = [];
    for (const page of documentationMap.targetPages) {
      if (!page.parityRequired) continue;
      const english = page.paths.en;
      const chinese = page.paths["zh-CN"];
      if (!english || !chinese) {
        failures.push(`${page.id}: missing locale path`);
        continue;
      }
      const enContent = readUtf8(english);
      const zhContent = readUtf8(chinese);
      if (
        headingLevels(enContent).join(",") !==
        headingLevels(zhContent).join(",")
      ) {
        failures.push(`${page.id}: heading levels differ`);
      }
      if (
        commandLines(enContent).join("\n") !==
        commandLines(zhContent).join("\n")
      ) {
        failures.push(`${page.id}: command lines differ`);
      }
      if (
        normalizedLinkDestinations(english).join("\n") !==
        normalizedLinkDestinations(chinese).join("\n")
      ) {
        failures.push(`${page.id}: internal link destinations differ`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps all P36 reconciliation command continuations identical", () => {
    const english = fencedCodeBlocks(
      sectionAfterAnchor(
        readUtf8("docs/lifecycle/upgrade-and-migrate.md"),
        "p36-held-task-reconciliation",
      ),
      "bash",
    );
    const chinese = fencedCodeBlocks(
      sectionAfterAnchor(
        readUtf8("docs/lifecycle/upgrade-and-migrate.zh-CN.md"),
        "p36-held-task-reconciliation",
      ),
      "bash",
    );
    // AC-number prefixes here are literal --accept description text, not Kernel criterion IDs.
    expect(english).toHaveLength(3);
    expect(english).toEqual(chinese);
  });

  it("requires redirect stubs to expose both first-class locale targets", () => {
    const failures: string[] = [];
    for (const mapping of documentationMap.sourceMappings) {
      if (mapping.action !== "redirect") continue;
      const target = targetById.get(mapping.targetPage);
      if (
        !target?.parityRequired ||
        !target.paths.en ||
        !target.paths["zh-CN"]
      ) {
        failures.push(`${mapping.path}: redirect target is not bilingual`);
        continue;
      }
      const linked = new Set(
        markdownLinks(readUtf8(mapping.path))
          .map((link) => resolveRelative(mapping.path, link))
          .filter((value): value is string => value !== null),
      );
      for (const locale of ["en", "zh-CN"] as const) {
        if (!linked.has(target.paths[locale])) {
          failures.push(
            `${mapping.path}: missing ${locale} -> ${target.paths[locale]}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("documents V2 Close observations and provider proof in both locales", () => {
    const english = readUtf8("docs/concepts/task-system.md").split(
      /^## 0\.5\.x Kernel v1/mu,
    )[0];
    const chinese = readUtf8("docs/concepts/task-system.zh-CN.md").split(
      /^## 0\.5\.x Kernel v1/mu,
    )[0];
    if (!english || !chinese) throw new Error("V2 task-system section is missing");

    expect(english).toContain("`closeTaskKernel`, the same Core API used by the CLI");
    expect(english).toContain("Core re-observes current candidate state");
    expect(english).toContain("read-only GitHub `gh api` observer");
    expect(english).toContain("`--exclude-standard`");
    expect(english).toContain("Review and acceptance evidence is also reopened and fingerprinted at Close");
    expect(english).toContain("does not authenticate identities");
    expect(english).not.toContain("does not recompute current Git HEAD, staged/unstaged state, or file bytes");
    expect(english).not.toContain("does not query a PR/merge service");
    expect(english).not.toContain("does not authenticate those identities, open referenced files");

    expect(chinese).toContain("同一个 Core API");
    expect(chinese).toContain("Core 会重新观察当前候选");
    expect(chinese).toContain("只读 GitHub `gh api` observer");
    expect(chinese).toContain("`--exclude-standard`");
    expect(chinese).toContain("Close 还会重新打开 Review 与验收证据文件");
    expect(chinese).toContain("不会认证身份");
    expect(chinese).not.toContain("不会重新计算当前 Git HEAD");
    expect(chinese).not.toContain("它不会认证这些身份、打开被引用文件");
    expect(chinese).not.toContain("也不会查询 PR 或合并服务");
  });
});
