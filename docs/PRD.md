# PRD — caveman-ui-ux v1

## 1. 文件資訊

- Product: `caveman-ui-ux`
- Status: Draft for implementation
- Version: 0.1
- Primary audience: AI coding agent users、frontend teams、consultants、QA、design engineers

## 2. 問題陳述

現有 AI coding agents 可以快速生成 UI，但缺少跨工具一致、可重複、具 evidence 的 UX 驗證流程。常見問題包括：

- Agent 已讀過 PRD，因此誤以為畫面資訊很清楚。
- UX 評語無固定 rubric，無法跨版本比較。
- Accessibility、performance 與主觀 UX 混成一個不可解釋分數。
- 不同 agent 各維護一份 prompt，長期產生規則漂移。
- 多語網站只檢查翻譯存在，不檢查 CTA、層級、溢出與文化語感。
- 修正後沒有以同條件重新驗證。

## 3. 產品目標

1. 建立 screenshot-first 的 Caveman blind test。
2. 將 UI/UX audit 轉成 machine-readable contract。
3. 讓同一套 Skill 可安裝至多個 AI coding agents。
4. 同時支援多 report locales 與多 target locales。
5. 建立可加入 CI 的 UX quality gate。
6. 將 finding、修正建議與重測結果形成完整 trace。

## 4. 非目標

- 取代真正的使用者研究。
- 以單一 AI score 證明商業成效。
- 宣稱自動工具可完整驗證 WCAG 或法規合規。
- 在 v1 建立雲端帳號、計費、團隊 dashboard。
- 將任何單一模型或 agent 設為必要依賴。

## 5. 目標使用者

### Persona A — AI-assisted developer

需要在 PR 前確認新頁面不是只有「能跑」，而是第一次使用者也看得懂。

### Persona B — UX / product consultant

需要快速、可追溯地比較客戶網站、多語頁面與改版前後差異。

### Persona C — Engineering lead

需要把 critical UX regression 擋在 CI，而不是 production 上線後才發現。

### Persona D — Open-source maintainer

希望一次維護 Skill，讓不同 agent 的貢獻者都能使用。

## 6. Jobs to Be Done

- 當我完成一個 UI 時，我要在沒有內部背景資訊的情況下測試第一次理解程度。
- 當我有多語網站時，我要知道哪個 locale 的 CTA、導覽或版面較差。
- 當不同 evaluator 判斷不一致時，我要看到 disagreement，而不是被平均數掩蓋。
- 當 agent 修正 finding 後，我要確認問題真的消失且沒有新增 regression。
- 當團隊使用不同 coding agents 時，我要共用同一份 UX 規則。

## 7. 功能需求

### FR-001 Target acquisition

系統必須接受：

- 公開 URL
- localhost URL
- 可由 command 啟動的本機 web app
- 預先提供的 screenshot manifest

### FR-002 Blind capture

Caveman 階段必須先於 source、DOM、metadata、README 與產品文件讀取。

### FR-003 Viewport matrix

預設至少：

- mobile: 375 × 812
- tablet: 768 × 1024
- desktop: 1280 × 800

使用者可覆寫尺寸與 device scale factor。

### FR-004 Caveman rubric

系統必須評估：Identity、Audience、Value、Primary Action、Visual Hierarchy、Cognitive Simplicity、Trust、Navigation、Language Clarity。

### FR-005 Evidence

每個 finding 必須具有至少一種 evidence：screenshot region、DOM selector、metric、network/log、manual note。

### FR-006 Technical adapters

v1 必須提供 axe-core 與 Lighthouse adapters；web-auditor-playwright 為 optional external adapter。

### FR-007 Rule packs

規則必須具 stable ID、version、source、license、category、severity defaults、testability metadata。

### FR-008 Multilingual

系統必須分離：

- `report_locale`
- `target_locale`
- `content_language_detected`

並可對每個 locale 產生獨立 score 與 finding。

### FR-009 Multi-evaluator

系統必須提供 provider-neutral evaluator contract。v1 可先支援單 provider；panel mode 的資料結構與 aggregation 必須在 v1 固定。

### FR-010 Reports

必須輸出：

- canonical JSON
- human-readable Markdown
- self-contained HTML

### FR-011 CI gate

必須支援 threshold、critical finding count、baseline regression 與明確 exit code。

### FR-012 Agent installation

安裝器必須：

- 偵測已存在的 agent config
- 支援明確指定 agent
- idempotent
- 不覆寫使用者既有 instructions
- 變更前建立 backup 或 patch manifest
- 支援 uninstall

### FR-013 Fix and verify

每個 finding 必須可產生 agent-neutral fix brief；verify 必須重用原 route、locale、viewport 與相關 rule IDs。

## 8. 非功能需求

- Node.js 22+
- Linux、macOS、Windows 基本支援
- JSON Schema 作為公開 contract
- 不將 API key 寫入 report
- screenshot 上傳必須 opt-in
- 所有外部 provider 呼叫可停用
- audit 可重跑並保留 run manifest
- deterministic checks 必須可在無 LLM 的情況下執行

## 9. 成功指標

- adapter install success ≥ 95% on supported fixtures
- report schema validation = 100%
- locale key completeness = 100%
- repeated deterministic run finding ID stability ≥ 98%
- blind isolation tests = 100% pass
- critical finding verification trace completeness = 100%
- Skill trigger precision/recall 以 eval set 持續追蹤

## 10. 風險

| Risk | Mitigation |
|---|---|
| AI 評分不穩定 | panel、confidence、dispersion、固定 rubric |
| Agent instructions 漂移 | canonical Skill + generated adapters |
| 上游 rule pack 授權不清 | source/commit/license manifest；不明規則不匯入 |
| 多語模型能力不一致 | locale capability metadata；低 confidence 顯示 warning |
| Lighthouse 波動 | 多次執行、median、不要用單次結果做精細比較 |
| 登入頁面涉及敏感資料 | local-only capture、redaction、artifact retention policy |
