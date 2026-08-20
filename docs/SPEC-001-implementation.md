# SPEC-001 — caveman-ui-ux v1 Implementation Specification

> **Status note (2026-08-20).** This document is the original design intent. What this
> repository actually ships is the canonical agent skill: `SKILL.md`, `references/`,
> `schemas/`, `rules/`, `locales/`, `assets/` and dependency-free Node scripts under
> `scripts/`, covered by 184 tests. The pnpm monorepo (`packages/core|cli|installer|evaluator|reporter`),
> the published npm binary, the TypeScript build, AJV and Vitest described below are **not
> built**. Where this document and the tree disagree, the tree is the truth.

## 1. Scope

本規格定義 v1 repository、CLI、core pipeline、Skill contract、agent installer、schemas、reports、tests 與 release gates。

## 2. Repository structure

```text
caveman-ui-ux/
├── docs/
├── skills/caveman-ui-ux/
├── schemas/
├── rules/
├── locales/
├── adapters/
├── packages/
│   ├── core/
│   ├── cli/
│   ├── installer/
│   ├── evaluator/
│   └── reporter/
├── examples/
└── tests/
```

## 3. Runtime requirements

- Node.js: `>=22`
- Package manager: pnpm
- Language: TypeScript, strict mode
- Browser: Playwright Chromium as baseline
- Schema validator: AJV
- Test runner: Vitest
- Build: tsup or equivalent ESM/CJS-compatible bundler

## 4. Configuration

Default config file: `caveman.config.yaml`.

Required conceptual fields：

```yaml
version: 1
report_locale: zh-TW

target:
  base_url: http://localhost:3000
  routes: [/]
  locales: [auto]

viewports:
  - id: mobile
    width: 375
    height: 812
  - id: desktop
    width: 1280
    height: 800

evaluation:
  caveman: true
  heuristic: true
  accessibility: true
  technical: true
  panel:
    enabled: false
    evaluators: []

privacy:
  upload_screenshots: false
  redact_selectors: []
  retention_days: 30

gates:
  caveman_minimum: 75
  accessibility_minimum: 90
  technical_minimum: 85
  critical_maximum: 0
```

## 5. CLI contract

### 5.1 `init`

```bash
caveman-ui-ux init [--agents <csv>] [--global] [--force]
```

Behavior：

1. 尋找 git root。
2. 偵測 agent marker files / installed binaries。
3. 建立 config。
4. 安裝 adapters。
5. 寫入 install manifest。
6. 執行 schema validation。
7. 顯示明確的 installed / skipped / conflict 結果。

### 5.2 `audit`

```bash
caveman-ui-ux audit <url?> [--config path] [--ci] [--panel]
```

Exit codes：

| Code | Meaning |
|---:|---|
| 0 | completed and gate passed |
| 1 | completed and gate failed |
| 2 | invalid configuration |
| 3 | target unavailable |
| 4 | runtime dependency missing |
| 5 | evaluator failure without usable fallback |
| 6 | privacy / permission block |

### 5.3 `verify`

```bash
caveman-ui-ux verify --run <run-id> [--finding <id>]
```

必須重用原 target coordinates，並產生 `resolved`、`improved`、`unchanged`、`regressed`、`not-comparable`。

## 6. Pipeline

### Stage A — Preflight

- resolve config
- validate schemas
- check target
- create run ID
- redact environment
- record tool versions

### Stage B — Blind capture

- render target route
- wait using configurable strategy
- dismiss only explicitly configured overlays
- capture viewport screenshot
- assign opaque screen ID
- seal screenshot manifest

### Stage C — Caveman evaluation

- evaluator receives only allowed blind payload
- validate evaluator JSON
- persist immutable raw response
- calculate dimension scores

### Stage D — Deterministic evidence

- DOM snapshot
- axe adapter
- Lighthouse adapter
- responsive overflow checks
- navigation/form/static rules

### Stage E — Full-context heuristic

此階段才允許讀取 DOM、copy、route purpose 與可選 source context。

### Stage F — Multilingual matrix

- compare locale routes
- detect missing/foreign-language strings
- check overflow and CTA parity
- check hreflang / lang attributes
- produce per-locale scores

### Stage G — Consensus

- isolate evaluator responses
- aggregate by median
- calculate MAD / confidence
- detect contradictions

### Stage H — Reporting and gate

- validate canonical audit JSON
- render Markdown / HTML
- calculate gates
- set exit code

## 7. Agent installer specification

### 7.1 Canonical bundle

Source：`skills/caveman-ui-ux/`。

Installer 必須以 content hash 判斷是否需要更新。

### 7.2 Codex

Target：`.agents/skills/caveman-ui-ux/`。

Copy：`SKILL.md`、`references/`、`scripts/`、`assets/`、`agents/`。

### 7.3 Claude Code

Target：`.claude/skills/caveman-ui-ux/`。

可使用 copy；只有在平台與權限明確允許時使用 symlink。

### 7.4 OpenCode

若 Codex target 已存在，重用 `.agents/skills/caveman-ui-ux/`；否則可選 `.opencode/skills/caveman-ui-ux/`。

### 7.5 Cursor

建立 `.cursor/rules/caveman-ui-ux.mdc`。內容必須保持短小，只定義觸發、讀取 canonical Skill、必要命令與完成條件。

### 7.6 Gemini CLI

提供：

- `gemini-extension.json`
- `GEMINI.md`
- `commands/caveman/audit.toml`
- `commands/caveman/verify.toml`

### 7.7 GitHub Copilot

建立 `.github/instructions/caveman-ui-ux.instructions.md`，使用 `applyTo` 限制 frontend/UI files。不可覆寫現有 `.github/copilot-instructions.md`。

### 7.8 Generic

以 managed markers patch `AGENTS.md`：

```text
<!-- caveman-ui-ux:start -->
...
<!-- caveman-ui-ux:end -->
```

## 8. Rule model

每條 rule：

```yaml
id: CAVEMAN.IDENTITY.001
version: 1.0.0
category: identity
kind: heuristic
severity_default: major
localizable: true
source:
  pack: core
  license: MIT
applicability:
  page_types: [landing, product, dashboard, form]
evidence:
  accepted: [screenshot_region, text]
```

Stable rule ID 不得因翻譯或檔案搬移而改變。

## 9. Finding identity

Deterministic finding ID：

```text
sha256(rule_id + normalized_route + locale + viewport + stable_selector)
```

Heuristic finding ID：

```text
sha256(rule_id + normalized_route + locale + viewport + normalized_evidence_region)
```

## 10. Localization

- JSON keys 以英文 stable identifiers 保存。
- Report renderer 才做 UI label localization。
- Finding 的實際分析文字由 evaluator 以 `report_locale` 產生。
- 原始 target copy 不可被翻譯後再評估。
- locale fallback：requested → language base → en。
- CI 必須檢查所有 locale keys 完整。

## 11. Security and privacy

- 不在 report 中輸出 cookies、authorization headers、API keys。
- 預設不把 screenshots 傳給 remote evaluator，除非 provider 明確需要且使用者同意。
- 支援 selector-based redaction。
- 對 authenticated target 支援由使用者提供 storage state path；不得把 storage state 打包進 artifact。
- HTML report 必須 escape untrusted page text。
- external process adapter 必須使用 argv array，不使用 shell interpolation。

## 12. Reports

### Canonical JSON

唯一 machine source of truth，必須通過 `schemas/audit.schema.json`。

### Markdown

順序：Executive summary → gate → component scores → critical/major findings → locale matrix → methodology → limitations。

### HTML

Self-contained、可離線開啟；支援 screenshot evidence、filters、finding status、run metadata。

## 13. Tests

### Unit

- scoring
- severity mapping
- stable IDs
- config merge
- locale fallback
- adapter path resolution

### Integration

- fixture site capture
- axe result normalization
- Lighthouse result normalization
- report schema validation
- install/update/uninstall for every adapter

### Evals

- should-trigger prompts
- should-not-trigger prompts
- incomplete target prompts
- blind leakage attempts
- multilingual reporting prompts
- hallucinated evidence rejection

### Golden fixtures

至少包含：

1. clear landing page
2. vague slogan landing page
3. dashboard with ambiguous primary action
4. form with missing labels
5. mobile overflow
6. misleading CTA
7. multilingual residual English
8. Japanese text expansion
9. Vietnamese CTA overflow
10. low-contrast page
11. broken navigation
12. authenticated app fixture

## 14. Acceptance criteria

### AC-001 Canonical Skill

- `SKILL.md` 通過 Agent Skills frontmatter validation。
- References 可被按需讀取。
- 不要求特定模型。

### AC-002 Blind isolation

- Caveman evaluator payload 不含 URL slug、DOM、metadata、README 或 source。
- automated leakage tests 全部通過。

### AC-003 Agent installation

- 六種 adapters 可 idempotent 安裝。
- 不覆蓋使用者原檔。
- update conflict 可被偵測。
- uninstall 不刪除非本工具內容。

### AC-004 Multilingual

- en、zh-TW、ja、vi locale keys 完整。
- report locale 與 target locale 可不同。
- 每個 locale 獨立產生 findings 和 scores。

### AC-005 Evidence

- critical / major finding 不得沒有 evidence。
- screenshot evidence 具有 artifact path 與 region。
- DOM evidence 具有 selector 或 node path。

### AC-006 CI

- gate pass 回傳 0。
- gate fail 回傳 1。
- config/runtime failure 使用專用 exit code。

### AC-007 Verify

- finding 可按原條件重測。
- report 顯示 before / after status 與 evidence。

### AC-008 License boundary

- imported rules 有 source commit 與 license metadata。
- LGPL external adapter 不被 vendored 進核心 bundle。
