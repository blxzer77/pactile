---
name: smart-search-cli
description: CLI-first web research and source retrieval through the local smart-search command. Use when Codex needs current web search, source-backed fact checking, URL fetching, site mapping, official/API/documentation search, or reproducible search evidence via Skill + CLI instead of MCP tools.
---

# Smart Search CLI

This workflow requires the separate Smart Search Middleware CLI to be installed and configured on the user's PATH. Pactile does not bundle or install `smart-search`; its prerequisites are managed independently from Pactile's Node.js runtime.

Use the local `smart-search` command as the default execution layer for web research. The skill decides routing; the CLI performs the work; JSON or saved files provide evidence.

## Default workflow

1. Run `smart-search doctor --format json` when configuration or availability is uncertain.
2. If `doctor` reports missing configuration, use `smart-search setup` or `smart-search config set KEY VALUE` when the user provides keys. Do not ask users to edit global environment variables by default.
3. If OpenAI-compatible `search` hangs or times out after `doctor` succeeds, run `smart-search diagnose openai-compatible --format markdown` and use its summary/recommendation. This one command tests quick chat plus real search-shape `stream=false` and `stream=true`.
4. If `doctor` returns `ok: true`, use only `smart-search` CLI subcommands for web research. Do not call Codex native web search in the same task.
5. For every research question, run a bilingual `smart-search search` pair: one Chinese-source query and one English-source query. Save both JSON outputs.
6. Use `smart-search search` as the first hop for realtime, broad exploration, community signals, multi-source summaries, and routing metadata. The default broad pass is bilingual via Tavily / Firecrawl when configured.
7. Use `smart-search context7-library` / `context7-docs` first for library, SDK, API, framework, or documentation intent.
8. Use `smart-search exa-search` for official domains, papers, product pages, trusted sites, and low-noise discovery. Do not treat Exa as the universal second hop for every high-risk or verification task.
9. Use `smart-search search --extra-sources N` for Tavily/Firecrawl horizontal candidates, and `smart-search fetch` for page text that can support final claims.
10. Use `smart-search exa-similar` when the user gives a representative URL and wants related pages or neighboring sources.
11. Use `smart-search fetch` when the user gives a URL or a claim depends on page content.
12. Use `smart-search map` when a documentation site or domain structure matters.
13. To change the main-search model, use `smart-search config set OPENAI_COMPATIBLE_MODEL ...` (or `XAI_MODEL ...` for the xAI route).
14. For current-news, policy, finance, health, or other high-risk facts, do not answer from broad `search.content` alone. Use the bilingual search pair plus intent-specific sources: Context7 for docs/API, Exa for official/trusted domains or papers, then `fetch` key pages and summarize only what fetched text supports.
15. Use `smart-search research "question" --format json` when the user wants the CLI to run live Deep Research end to end instead of only planning. It executes plan -> discover -> fetch/read -> gap check -> evidence-only synthesis.
16. Preserve command lines and source URLs in your answer. Prefer citing fetched pages or `primary_sources`; treat `extra_sources` as follow-up candidates, not verified evidence for generated claims.

## Deep Research Mode

Use Deep Research Mode when the user asks for `深度搜索`, `深度调研`, `深入搜索`, `deep search`, `deep research`, multi-source verification, cross-checking, serious review, or selection/comparison research. This is a capability-based orchestration workflow. The live executor route calls `smart-search research "question" --format json` and lets the CLI execute plan -> discover -> fetch/read -> gap check -> evidence-only synthesis. `smart-search research` builds the `research_plan` internally before discovery; there is no separate offline planner command. This does not change default `smart-search search`, and it does not depend on an MCP session.

Do not select a fixed topic recipe. Market, product, technical docs, news, policy, claim-checking, and URL-first prompts are examples of user language, not schema modes. Decide from intent dimensions and capability needs.

When `smart-search research` runs, it builds an internal `research_plan` as its planning artifact before discovery. The plan uses this shape:

```json
{
  "mode": "deep_research",
  "query_mode": "research",
  "question": "user question",
  "trigger_source": "explicit_cli",
  "difficulty": "standard|high",
  "intent_signals": {
    "recency_requirement": "none|recent|current",
    "docs_api_intent": false,
    "locale_domain_scope": "global|china|known_domains|mixed",
    "known_url": false,
    "source_authority_need": "normal|high",
    "claim_risk": "low|medium|high",
    "cross_validation_need": "normal|high",
    "breadth_depth_budget": "quick|standard|deep"
  },
  "decomposition": [
    {
      "id": "sq1",
      "question": "subquestion",
      "reason": "why this subquestion is needed",
      "required_capabilities": ["broad_discovery"]
    }
  ],
  "capability_plan": [
    {
      "capability": "broad_discovery",
      "tools": ["search"],
      "reason": "Find the initial answer shape and candidate sources."
    }
  ],
  "preflight": {
    "tool": "doctor",
    "command": "smart-search doctor --format json",
    "when": "configuration or availability is uncertain",
    "executed_during_planning": false
  },
  "evidence_policy": "fetch_before_claim",
  "steps": [
    {
      "id": "s1",
      "subquestion_id": "sq1",
      "tool": "search",
      "purpose": "broad discovery",
      "command": "smart-search search \"query\" --validation balanced --extra-sources 1 --format json --output <resolved_evidence_dir>\\YYYYMMDD-HHMM-topic\\01-search.json",
      "output_path": "<resolved_evidence_dir>\\YYYYMMDD-HHMM-topic\\01-search.json"
    }
  ],
  "gap_check": {
    "required": true,
    "rule": "fetch missing evidence for key claims or downgrade them to unverified candidates"
  },
  "final_answer_policy": "cite fetched evidence, list unverified candidates, and include key commands",
  "usage_boundary": {
    "search": "smart-search search runs live fast/broad search immediately.",
    "execution": "smart-search research executes the listed steps with existing CLI building blocks, then performs gap_check."
  }
}
```

Allowed `steps[].tool` values are `search`, `exa-search`, `exa-similar`, `context7-library`, `context7-docs`, `fetch`, and `map`. Each step must include `id`, `subquestion_id`, `purpose`, `command`, and `output_path`. `doctor` is preflight and must not appear in `steps[]`. Simple plans may have one subquestion; complex plans should use 2-6 subquestions unless the user explicitly asks for exhaustive coverage.

Capability boundaries:

- `search`: broad bilingual discovery and synthesis through `main_search`; inspect `routing_decision`, `provider_attempts`, `fallback_used`, and `source_warning`. Do not treat broad answers as proof for high-risk claims.
- `context7-library` / `context7-docs`: library, SDK, API, framework, and documentation intent. Prefer Context7 before Exa for docs/API questions.
- `exa-search`: low-noise discovery for official domains, papers, product pages, known domains, and trusted pages. Use it when that boundary fits; it is not the default second hop for every verification task.
- `exa-similar`: adjacent-source discovery when a known reliable URL is available.
- `search --extra-sources N`: Tavily/Firecrawl horizontal candidate collection for breadth. Treat those candidates as discovery until fetched.
- `fetch`: page-content evidence. Use it before claim-level conclusions.
- `map`: site structure exploration before many fetches from one site; not claim evidence by itself.

Default Deep Research orchestration:

1. Run `smart-search doctor --format json` as preflight when configuration is uncertain.
2. `smart-search research` builds an internal `research_plan` with `intent_signals`, `decomposition`, and `capability_plan`; do not choose fixed topic recipe ids.
3. Execute planned bilingual `search --validation balanced --extra-sources 1..3` steps for Chinese-source and English-source broad discovery, then read routing metadata.
4. Execute planned `exa-search`, `exa-similar`, `context7-library`, `context7-docs`, or `map` only when their capability boundary matches the intent.
5. Use `fetch` on key URLs before making claim-level statements.
6. Run `gap_check`: if an important claim lacks fetched evidence, fetch another source or mark the claim/source as unverified.

Default evidence policy is `fetch_before_claim`: key claims in the final answer must be supported by fetched page text. Treat `primary_sources` and `extra_sources` as discovery candidates until the relevant URL has been fetched. The final answer should include fetched evidence, unverified candidate sources, and key commands used.

Live Deep Research executor:

- `smart-search research QUERY [--budget quick|standard|deep] [--locale-scope cn|en|both] [--evidence-dir PATH] [--fallback auto|off] [--dry-run] [--progress] [--timeout SECONDS] [--format json|markdown|content] [--output PATH]` runs the staged workflow directly. Use `--dry-run` to preview plan/routing without live providers; `--progress` for stderr stage logs; `--locale-scope cn` or `en` to skip bilingual discovery when cost matters. Docs/API intent is precision-first (weak language/product tokens alone do not trigger). If docs discovery yields no HTTP evidence, the executor fail-opens to `web_discovery` (`stage_results` may include `fail_open_web_after_docs`). Default `--timeout` is 600 seconds for the full research run.
- Default `--fallback auto` permits same-capability fallback inside selected routes. Use `--fallback off` only for debugging or deterministic provider checks.
- Research output includes `final_answer`, `citations`, `evidence_items`, `gap_check`, `provider_attempts`, `fallback_used`, `degraded`, `route_policy_version`, `output_schema_version`, and `evidence_dir`.
- Contract fields for agents: always read `output_schema_version` (currently `1`), `route_policy_version`, `minimum_profile_ok`, and `cache_hit` on attempts/stages. Treat `cache_hit: true` as possibly stale only if the local config model/endpoint changed without process restart — keys include model identity, but process-local TTL still applies. Prefer `doctor --format json` when `minimum_profile_ok` is false (fail-closed).
- The synthesis is evidence-only. It may cite fetched/read evidence, but it must not cite unfetched discovery candidates as proof.
- If providers are exhausted or evidence cannot close, return the degraded gaps rather than inventing missing claims.

Research provider advantage routing:

- Context7: library/API/framework docs resolution and docs retrieval.
- Exa: official domains, papers, product/company pages, date/domain-filtered low-noise discovery, and adjacent-source discovery.
- Tavily: broad bilingual source discovery and site map.
- Jina: known public URL, PDF, and arXiv clean extraction; ReaderLM-v2 requires `JINA_API_KEY`.
- Firecrawl: robust fetch fallback, JS-heavy/dynamic pages, browser-like extraction, OCR/PDF/structured extraction.

Safe research overrides are `SMART_SEARCH_RESEARCH_PREFERRED_PROVIDERS`, `SMART_SEARCH_RESEARCH_DISABLED_PROVIDERS`, and `SMART_SEARCH_CACHE` (`on` by default; `off` disables the in-process provider TTL cache). Preferred/disabled provider CSV values may reorder or disable providers only within capabilities the provider already supports; they must not move a provider across capability boundaries.

Deep Research test coverage for workflow maintenance should verify trigger phrases, normal search requests that should not trigger Deep Research, required `research_plan` fields, allowed tool whitelist, bilingual search steps, `fetch_before_claim`, evidence output paths, capability boundaries, `intent_signals`, `capability_plan`, `gap_check`, simple current prompts such as `深度搜索一下最近的比特币行情`, docs/API prompts, claim-verification prompts, user-provided URL fetch-first flows, missing-provider failure guidance, and the rule that fixed topic recipe ids are not required schema. When real keys are available and the user expects live checks, a small live pass can run `doctor`, two broad `search` commands (Chinese and English), one `exa-search`, and one `fetch`.

Standard user-facing Deep Research tests:

```powershell
smart-search research "深度搜索一下最近的比特币行情" --format json
smart-search research "OpenAI Responses API web_search 和 Chat Completions 联网搜索怎么选" --budget deep --format json
smart-search research "帮我核验这个说法是真是假：某某工具已经完全替代 Tavily 做 AI 搜索了" --format json
smart-search research "https://example.com/source" --format json
```

## Provider Routing

- `search` builds `main_search` from `XAI_API_KEY` (xAI Responses with server-side `web_search`/`x_search` tools) and/or `OPENAI_COMPATIBLE_API_URL` + `OPENAI_COMPATIBLE_API_KEY` (Chat Completions). One is enough; when both are configured, `SMART_SEARCH_MAIN_SEARCH_ROUTE` (ordered CSV of `xai-responses,openai-compatible`) sets priority, and a single entry disables cross-route fallback.
- `search` is the default first hop for broad exploration, current synthesis, and routing metadata.
- OpenAI-compatible relays/gateways use Chat Completions `/chat/completions` through `OPENAI_COMPATIBLE_*`.
- `OPENAI_COMPATIBLE_STREAM=true` or `search --stream` sets `stream=true` only for OpenAI-compatible `search` and provider-side `fetch`; it is a relay compatibility switch and does not affect URL description or source ranking.
- Legacy `SMART_SEARCH_API_URL`, `SMART_SEARCH_API_KEY`, `SMART_SEARCH_API_MODE`, and `SMART_SEARCH_MODEL` are unsupported config keys.
- The standard minimum profile requires one configured provider in each of `main_search`, `docs_search`, and fetch capability. Missing required capabilities should be treated as a hard configuration failure.
- Jina Reader is `web_fetch` only, not a general search provider. `JINA_API_KEY` is required before Jina satisfies the standard minimum profile; anonymous `r.jina.ai` is explicit/experimental fetch behavior.
- `search` exposes `--validation fast|balanced|strict`, `--fallback auto|off`, and `--providers auto|CSV`. Default validation is `balanced`; fallback only happens within the same capability.
- `search --validation strict` uses the same bilingual web_search policy as balanced mode when source discovery providers are configured. Strict queries without primary, docs, fetch, or explicit source evidence can still fail with `evidence_error`; use `--extra-sources N`, source-first commands such as `exa-search`, or `fetch` when citable evidence is required.
- `search` runs bilingual web_search source discovery through Tavily / Firecrawl when configured.
- Docs/API/library routing stays explicit keyword intent-based and should prefer Context7 first. Exa is for official-domain or low-noise supplemental discovery, not the default docs answer route.
- `search` calls Tavily and/or Firecrawl for `extra_sources` only when `--extra-sources N` is greater than 0.
- With both Tavily and Firecrawl configured, `search --extra-sources N` splits extra sources between them, with Tavily receiving about 60% and Firecrawl the rest.
- Search JSON separates `primary_sources`, `extra_sources`, and backward-compatible merged `sources`.
- `primary_sources` are extracted from the primary model answer. `extra_sources` are parallel Tavily / Firecrawl candidates and are not automatically used to verify `content`.
- `fetch` tries Tavily first, then Jina with `JINA_API_KEY`, then Firecrawl.
- `map` currently uses Tavily only.
- `exa-search` and `exa-similar` use Exa only.
- `context7-library` and `context7-docs` use Context7 only.
- `TAVILY_API_URL` only affects Tavily REST calls.
- `doctor` tests configured main-search providers, Exa, Tavily, Jina, and Context7 connectivity. Firecrawl status currently means the key is configured, not that a live Firecrawl request succeeded.

## Evidence Files

For multi-source research, use `smart-search config path --format json` and save evidence under `resolved_evidence_dir` with a descriptive timestamped filename. Stdout should still contain the full JSON result unless markdown or content output was explicitly chosen for human reading.

For claim-level evidence, prefer this order:

1. Discover candidate URLs with a bilingual source-focused `search` pair, Context7 for docs/API/library topics, or `exa-search` for official/trusted domains and papers.
2. Fetch the exact pages that matter.
3. Use broad `search` only as synthesis or discovery, and mark claims as unverified when only `extra_sources` are available.

Prefer shorter, source-directed commands:

```powershell
$Config = smart-search config path --format json | ConvertFrom-Json
$EvidenceDir = Join-Path $Config.resolved_evidence_dir "YYYYMMDD-HHMM-topic"
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
smart-search exa-search "Reuters Iran Hormuz latest" --num-results 5 --include-highlights --format json --output (Join-Path $EvidenceDir "01-iran-hormuz-exa.json")
smart-search exa-search "OpenAI Responses API documentation" --include-domains platform.openai.com developers.openai.com --num-results 5 --include-text --format json
smart-search exa-similar "https://example.com/source" --num-results 5 --format json
smart-search fetch "https://example.com/source" --format json --output (Join-Path $EvidenceDir "02-source-fetch.json")
smart-search search "Iran Hormuz latest military talks" --extra-sources 3 --timeout 90 --format json --output (Join-Path $EvidenceDir "03-iran-hormuz-search.json")
```

## Workflows

Use these recipes when the user asks for evidence, citations, repeated searches, or an archiveable research trail. Keep `--output` paths under one timestamped evidence directory so later answers can cite saved files and rerun commands.

### Lightweight Evidence Gathering

Use this when the user needs a source-backed answer but not full Deep Research.

1. Create an evidence directory under the system-aware Smart Search evidence root reported by `smart-search config path --format json`.
2. Discover candidate sources by intent:
   - Always run the bilingual broad pair:
     - `smart-search search "中文搜索，优先检索中文来源，并回答原问题：query" --validation balanced --extra-sources 1 --format json --output "$EvidenceDir\01-search-zh.json"`
     - `smart-search search "Search English-language sources and answer the original question: query" --validation balanced --extra-sources 1 --format json --output "$EvidenceDir\02-search-en.json"`
   - Docs/API/library/framework intent: `smart-search context7-library "library" "topic" --format json --output "$EvidenceDir\01-context7-library.json"`
   - Official domains, papers, product pages, or trusted sites: `smart-search exa-search "query" --num-results 5 --include-text --include-highlights --format json --output "$EvidenceDir\01-exa.json"`
3. Fetch the one or two URLs that support the answer: `smart-search fetch "https://example.com/source" --format markdown --output "$EvidenceDir\02-fetch-source.md"`.
4. Write the final answer only from fetched page text or clearly label unfetched items as candidates.

See `examples/evidence-gathering.md` for a complete command sequence.

### Deep Research With Citations

Use this when the user asks for deep research, cross-checking, serious comparison, or a multi-source investigation.

1. Run the live executor: `smart-search research "question" --budget standard --format json --output "$EvidenceDir\research.json"`.
2. Read `research_plan`, `evidence_items`, `gap_check`, `citations`, and `final_answer`.
3. If `degraded` is true or `gap_check` lists open gaps, either fetch more sources or report the remaining gaps instead of filling them from memory.

Keep the detailed Deep Research rules in `## Deep Research Mode`; this workflow is only the quick selection recipe.

### Batch Search And Fetch

Use this when the user gives multiple queries, companies, tools, documents, URLs, or comparison targets.

1. Create one evidence directory for the batch.
2. Run one CLI command per query or URL, using numbered outputs such as `01-search-react.json`, `02-search-vue.json`, or `03-fetch-docs.md`.
3. Keep each command narrow:
   - Use the bilingual `search --extra-sources 1` pair for quick broad discovery.
   - Use `context7-library` / `context7-docs` for docs/API/library items.
   - Use `exa-search` for official/trusted-domain discovery.
   - Use `fetch` for each URL that will support a claim.
4. After the loop, summarize across saved files. Cite fetched files or fetched URLs for claims; list unfetched discovery results only as candidates.

See `examples/batch-search.md` for PowerShell loop patterns and output naming.

### Evidence Archiving

Use this when the user wants work that can be inspected, resumed, or audited.

1. Save every non-trivial command with `--output`.
2. Use stable numbered filenames: `01-search.json`, `02-exa-official.json`, `03-fetch-source.md`, `04-summary.json`.
3. Keep command lines in the final answer or notes.
4. Prefer JSON for machine-readable discovery and Markdown for fetched page text intended for reading.
5. Do not treat `primary_sources` or `extra_sources` as claim proof until the relevant URL has been fetched.

## Local wrapper contract

- Expect `smart-search` to resolve from the user's PATH.
- This bundled skill is maintained with the `smartsearch` repository.
- Prefer the CLI's local config file managed by `smart-search setup` / `smart-search config`.
- Environment variables remain supported for CI and advanced users, and override the local config file.
- Do not ask users to set Windows global API-key environment variables by default.
- If keys are changed with `smart-search config set`, rerun the CLI; no Codex restart is needed.
- If PATH is changed, a new terminal or Codex restart may be needed.
- On Windows, the default local config file is `%LOCALAPPDATA%\smart-search\config.json`. Linux/macOS default to `~/.config/smart-search/config.json`.
- In sandboxed runtimes (Codex CLI, containers, CI) where the default config directory is not writable or must be pinned, set `SMART_SEARCH_CONFIG_DIR` to an absolute writable path. The CLI uses it for both config and relative logs and skips default-directory selection.
- The default research evidence root is `evidence` under the active config directory. Set `SMART_SEARCH_EVIDENCE_DIR` only when evidence needs a separate absolute location; `config path` and `doctor` report both the configured and resolved evidence paths.
- Earlier Windows source defaults used `~\.config\smart-search\config.json`, while some installs were already pinned to `%LOCALAPPDATA%\smart-search` through `SMART_SEARCH_CONFIG_DIR`. If the new default file is missing but the old file exists, `doctor` reports `legacy_windows_home` as the active source so upgrades do not silently lose configuration. It also reports the override value and whether it matches the current default.
- Use `smart-search doctor --format json` for agent/script parsing and `smart-search doctor --format markdown` when a human wants a detailed diagnostic report.
- If `smart-search doctor --format json` returns `ok: false`, follow the `error` field's guidance (`smart-search setup` or `smart-search config set KEY VALUE`); do not silently fall back to native web search.
- Use `smart-search diagnose openai-compatible --format markdown` when `doctor` succeeds but OpenAI-compatible `search` appears to hang, returns a timeout, or differs between `--stream` and `--no-stream`. It is the beginner-facing one-command report for upstream/relay compatibility.
- Interactive `smart-search setup` is a language-selecting grouped wizard with arrow-key / Space / Enter provider selection. It guides users through required `main_search`, `docs_search`, and fetch capability.
- The setup wizard prints beginner filling examples for official-service and relay/pooled-endpoint minimum profiles. Keep that guidance on stderr so stdout remains parseable JSON/Markdown/content output.
- Use `smart-search setup --lang en` for an English wizard and `smart-search setup --advanced` only when low-level config keys must be shown one by one.
- Use `smart-search setup --non-interactive --jina-key "key"` to let Jina satisfy `web_fetch`; `JINA_RESPOND_WITH=readerlm-v2` also requires `JINA_API_KEY`.
- Use `smart-search setup --non-interactive --openai-compatible-stream true` only when an OpenAI-compatible relay benefits from SSE streaming for long requests. Default is true.
- Use `TAVILY_API_URL=https://<host>/api/tavily` for Tavily Hikari / pooled endpoints. Root host and `/mcp` inputs are normalized by setup; `/mcp` itself is not the REST base Smart Search should call.
- `TAVILY_TIMEOUT_SECONDS` controls the Tavily `doctor` connectivity timeout and defaults to `30`. Raise it for slower pooled/community Tavily endpoints before judging the provider unhealthy.
- Use `FIRECRAWL_API_URL` only for a Firecrawl-compatible REST base. Official default is `https://api.firecrawl.dev/v2`.

## Command Patterns

```powershell
smart-search search "query" --extra-sources 5 --timeout 90 --format json --output result.json
smart-search search "query" --stream --format json
smart-search diagnose openai-compatible --format markdown
smart-search search "query" --platform "Reuters" --model "model-id" --extra-sources 3 --timeout 90 --format json
smart-search search "nba战报" --format content
smart-search search "query" --validation strict --fallback auto --providers auto --format json
smart-search exa-search "query" --num-results 5 --search-type neural --include-text --include-highlights --include-domains docs.example.com developer.mozilla.org --format json
smart-search exa-similar "https://example.com/article" --num-results 5 --format json
smart-search context7-library "react" "hooks" --format json
smart-search context7-docs "/facebook/react" "useEffect cleanup" --format json
smart-search fetch "https://example.com" --format markdown --output page.md
smart-search map "https://docs.example.com" --instructions "Find API reference pages" --max-depth 1 --max-breadth 20 --limit 50 --format json
smart-search research "OpenAI Responses API web_search vs Chat Completions search" --budget deep --fallback auto --format json
smart-search rs "https://example.com/source" --fallback off --format markdown
smart-search setup
smart-search setup --lang en
smart-search setup --advanced
smart-search setup --non-interactive --openai-compatible-stream true
smart-search setup --non-interactive --tavily-api-url "https://api.tavily.com" --tavily-key "key"
smart-search --version
smart-search config path --format json
smart-search config list --format json
smart-search config list --format markdown
smart-search config set OPENAI_COMPATIBLE_API_URL "https://api.openai.com/v1" --format json
smart-search config set OPENAI_COMPATIBLE_API_KEY "key" --format json
smart-search config set OPENAI_COMPATIBLE_MODEL "model-id" --format json
smart-search config set OPENAI_COMPATIBLE_STREAM "true" --format json
smart-search config set XAI_API_KEY "key" --format json
smart-search config set XAI_MODEL "grok-4.5" --format json
smart-search config set SMART_SEARCH_MAIN_SEARCH_ROUTE "xai-responses,openai-compatible" --format json
smart-search config set EXA_API_KEY "key" --format json
smart-search config set CONTEXT7_API_KEY "key" --format json
smart-search config set TAVILY_API_URL "https://api.tavily.com" --format json
smart-search config set TAVILY_TIMEOUT_SECONDS "45" --format json
smart-search config set FIRECRAWL_API_URL "https://api.firecrawl.dev/v2" --format json
smart-search doctor --format json
smart-search doctor --format markdown
smart-search diagnose openai-compatible --format markdown
```

Short aliases are supported for interactive use:

```powershell
smart-search --v
smart-search s "query" --format json
smart-search s "nba战报" --format content
smart-search rs "query" --format json
smart-search f "https://example.com" --format markdown
smart-search exa "OpenAI Responses API documentation" --format json
smart-search z "today China AI news" --format json
smart-search c7 "react" "hooks" --format json
smart-search c7docs "/facebook/react" "useEffect cleanup" --format json
smart-search cfg ls --format json
smart-search d --format markdown
```

## Timeout Retry Policy

When `smart-search search` returns `ok: false` with `error_type: "network_error"` and an error message containing `timed out`, treat it as a retryable CLI-level timeout, not as a terminal research failure.

### Error contract (U1/U2)

Failed JSON payloads expose a stable triple for Agent/JSON consumers:

| Field | Meaning |
| --- | --- |
| `error_type` | Category enum string: `config_error`, `parameter_error`, `network_error`, `evidence_error`, `auth_error`, `rate_limited`, `timeout`, `parse_error`, `quality_error`, `runtime_error` |
| `error_code` | Stable `SCREAMING_SNAKE` code (defaults from `error_type`, e.g. `CONFIG_ERROR`; specific codes such as `MISSING_API_KEY`, `SEARCH_TIMEOUT` when applicable) |
| `error` | Default **English** human message (no locale framework; Chinese remains only in interactive setup prompts via existing `_t`) |

CLI exit codes stay mapped from `error_type` only: `parameter_error→2`, `config_error→3`, `network_error`/`evidence_error→4`, other→`5`.

1. Retry up to 3 total attempts with `--timeout 180`, waiting about 5 seconds between attempts.
2. Use `--format json` and `--output PATH` for each attempt; after each attempt, inspect the saved JSON and stop on the first `"ok": true`.
3. Use `--extra-sources 1` during retry attempts to keep Tavily/Firecrawl overhead small.
4. Always use the CLI's `--timeout` option. Do not wrap `smart-search` in a shell-level `timeout` command because shell termination can prevent the CLI from writing structured failure JSON.
5. Do not rely on `SMART_SEARCH_RETRY_*` settings for this path; search command timeouts are surfaced by the CLI result contract and should be handled by the agent workflow.
6. If all attempts time out, fall back to source-first evidence:
   - Run `exa-search` with the original query for broad source discovery.
   - Run `exa-search --include-domains` when likely official domains are known.
   - `fetch` the top 1-2 relevant URLs before making claim-level statements.
   - Mark the final answer as `source_mode: "fallback"` or clearly state that the answer was assembled from fetched sources rather than generated by `search`.

Example retry flow:

```powershell
smart-search search "query" --validation balanced --extra-sources 1 --timeout 180 --format json --output result-attempt-1.json
smart-search search "query" --validation balanced --extra-sources 1 --timeout 180 --format json --output result-attempt-2.json
smart-search search "query" --validation balanced --extra-sources 1 --timeout 180 --format json --output result-attempt-3.json
smart-search exa-search "query" --num-results 5 --include-text --format json --output exa.json
smart-search exa-search "query" --include-domains platform.openai.com developers.openai.com --num-results 3 --include-text --format json --output exa-official.json
smart-search fetch "https://example.com/source" --format markdown --output fetch.md
```

## Guardrails

- Prefer JSON for agent parsing and markdown for fetched page text intended for reading.
- Use `--output` for multi-source work, long pages, or anything the answer may need to cite later.
- Keep `--extra-sources` small (`1` to `3`) unless the user asks for broad coverage. Large values are slower and can add noise.
- Do not cite `extra_sources` as proof for a sentence in `content`; fetch the URL first or cite it only as a candidate source.
- Prefer `exa-search --include-domains` for official documentation when likely domains are known.
- Do not expose API keys. Treat `doctor` output as safe only because it is expected to mask secrets.
- In this CLI-first workflow, native `web_search` is disabled unless the user explicitly configures another approved route.
- If `doctor` or a command fails, report the failure and recovery steps; do not silently fall back to another web-search route.
- If the user explicitly asks to bypass smart-search, state that another approved web-search route must be configured first.
- Do not use legacy MCP tool names in prompts, notes, or generated instructions for this workflow.
- Treat key rotation as a hard safety gate when previous key values were pasted into chat or logs.
- For provider architecture maintenance, verify the distributable contract rather than the current developer machine's wrappers or local config. Keep fallback same-capability only.
- `main_search` is a user choice between xAI Responses (`XAI_*`) and OpenAI-compatible Chat Completions (`OPENAI_COMPATIBLE_*`). Never send xAI server tools (`web_search`, `x_search`) or xAI-only parameters into the OpenAI-compatible route, and never point the xAI route at `/chat/completions`. Do not fabricate additional `main_search` providers or reuse another capability's URL/key as a `main_search` fallback.

## Supporting Reference

Read `references/cli-contract.md` when you need command details, output fields, exit codes, or contract expectations.
