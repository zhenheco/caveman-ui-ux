# caveman-ui-ux Master Plan

> **Status note (2026-08-20).** This document is the original design intent. What this
> repository actually ships is the canonical agent skill: `SKILL.md`, `references/`,
> `schemas/`, `rules/`, `locales/`, `assets/` and dependency-free Node scripts under
> `scripts/`, covered by 184 tests. The pnpm monorepo (`packages/core|cli|installer|evaluator|reporter`),
> the published npm binary, the TypeScript build, AJV and Vitest described below are **not
> built**. Where this document and the tree disagree, the tree is the truth.

## 1. 定位

`caveman-ui-ux` 是一個可安裝到不同 AI coding agents 的 UI/UX 品質 Skill，同時提供可重複執行的 CLI 與 CI gate。

它不是單純的「AI 幫我評論畫面」，而是將以下流程標準化：

```text
Capture → Blind Caveman Test → Deterministic Audit → Heuristic Audit
→ Multilingual Matrix → Consensus → Report → Fix → Verify
```

## 2. 差異化

### 2.1 Blind Context Isolation

第一次理解測試不得預先讀取：

- README、PRD、SPEC、設計稿說明
- 原始碼與 package metadata
- SEO title、description、schema.org
- 公司背景或品牌說明
- 其他 evaluator 的答案

第一階段只允許：

- rendered screenshot
- viewport
- target locale
- route 的匿名代號，而非具語意的 URL slug

### 2.2 Deterministic 與 Probabilistic 分離

**Deterministic evidence**：axe、Lighthouse、DOM、overflow、broken link、heading、label、hreflang。

**Probabilistic judgment**：價值主張、信任感、主行動、視覺層級、認知負荷、語言自然度。

兩者不應被混為同一個未揭露公式的總分。

### 2.3 Agent-neutral

核心 Skill 採 open Agent Skills 結構；Codex、Claude Code、OpenCode 可直接載入。Cursor、Gemini CLI、Copilot 只負責轉接與觸發，不維護第二份 UX 規則。

### 2.4 Multilingual Matrix

```yaml
report_locale: zh-TW

targets:
  - route: /
    locales: [en, zh-TW, ja, vi]
```

「報告使用繁中」不代表「只測繁中畫面」。每個 route × locale × viewport 都是獨立測試案例。

## 3. v1 支援範圍

### 必須完成

- URL 與 localhost audit
- mobile / tablet / desktop screenshots
- screenshot-first Caveman Test
- 9 維度評分與 evidence
- axe-core integration
- Lighthouse integration
- UX rule-pack interface
- en、zh-TW、ja、vi 報告本地化
- Codex、Claude Code、Cursor、Gemini CLI、Copilot、OpenCode adapters
- JSON、Markdown、HTML reports
- CI exit codes and thresholds
- single evaluator 與 multi-evaluator provider interface
- fix-and-verify workflow

### 暫不納入 v1

- 真實受試者招募與研究管理
- 眼動追蹤
- Figma 原生 plugin
- 自動改版並直接部署 production
- 以 AI 分數宣稱 WCAG 法律合規
- 對所有語言提供母語級文化審查保證
- 內建雲端 SaaS dashboard

## 4. 推薦技術架構

```text
packages/
├── core        # pipeline、types、scoring、orchestration
├── cli         # commands、flags、exit codes
├── installer   # agent detection、copy/patch、manifest
├── evaluator   # model-provider interface、consensus
└── reporter    # JSON/MD/HTML rendering

skills/caveman-ui-ux/
├── SKILL.md
├── references/
├── scripts/
├── assets/
└── agents/openai.yaml
```

建議：Node.js 22+、TypeScript、pnpm workspace、Playwright、AJV、Vitest、tsup。

## 5. 核心命令

| Command | 目的 |
|---|---|
| `init` | 建立 config 並安裝 agent adapters |
| `install` | 追加或更新指定 adapter |
| `doctor` | 檢查 browser、runtime、provider、權限 |
| `capture` | 只產生 route/locale/viewport artifacts |
| `caveman` | 只做 blind first-impression test |
| `audit` | 執行完整 pipeline |
| `verify` | 對既有 findings 做同條件重測 |
| `report` | 從 JSON 重新渲染 MD/HTML |
| `rules` | 檢查、同步、列出 rule packs |

## 6. 預設 Quality Gate

```yaml
gates:
  caveman:
    minimum: 75
  accessibility:
    minimum: 90
  technical:
    minimum: 85
  critical_findings:
    maximum: 0
  evaluator_confidence:
    minimum: 0.60
```

CI 預設以各 component gate 判斷，不以 composite score 取代問題本身。

## 7. 分期

### Phase 0 — Contracts

完成 PRD、ADR、JSON Schema、SKILL.md、測試 fixtures。

### Phase 1 — Capture + Caveman

完成 Playwright capture、blind context isolation、單 evaluator、JSON/Markdown report。

### Phase 2 — Deterministic Evidence

整合 axe-core、Lighthouse、responsive/overflow、DOM evidence。

### Phase 3 — Adapters + Installer

完成六種 Agent adapter、idempotent install、backup、uninstall、doctor。

### Phase 4 — Multilingual

完成 locale discovery、route mapping、文字溢出、殘留語言、hreflang 與四語報告。

### Phase 5 — Consensus + CI

完成 provider interface、panel aggregation、GitHub Actions、baseline regression。

### Phase 6 — Rule Packs

完成 ux-pilot importer、rule version pinning、license notice、rule coverage tests。

## 8. Definition of Done

v1 只有在以下條件全部成立時才可標記 stable：

1. 新 repository 可透過單一 init command 安裝至少 Codex、Claude Code、Cursor、Gemini CLI、Copilot、OpenCode。
2. 同一份 canonical Skill 更新後，所有 adapter 可重新生成且沒有內容漂移。
3. 對至少 12 個 fixture pages 產生可重複的 audit JSON。
4. blind evaluator 無法讀取 README、DOM 或 metadata。
5. 每個 finding 都有 evidence 與 reproducible target coordinates。
6. 四個 report locales 通過 key completeness test。
7. CI 可因 critical finding 或 threshold failure 回傳非零 exit code。
8. 第三方 rule pack 與 external auditor 均保留清楚授權邊界。
