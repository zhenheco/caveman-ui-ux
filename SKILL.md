---
name: caveman-ui-ux
description: >
  Use when running a caveman test / 第一印象測試 / first-impression test on a UI — blind UX
  review、UI/UX 稽核、UX audit、screenshot UX review、「使用者看不看得懂」、「這頁到底在賣什麼」、
  「下一步該點哪裡」—— or when auditing a screen's accessibility (axe、a11y 稽核、contrast、
  form labels), technical quality (Lighthouse UX gate), multilingual UI consistency
  (多語 UI 檢查、locale UI 稽核、residual English、CTA parity、hreflang、text expansion),
  or when adding a UX regression gate to CI. Triggers: `/caveman-ui-ux`, caveman test、
  caveman audit、caveman verify、blind evaluator、first-impression test、UX regression gate.
  It captures real Playwright screenshots, has a fresh-context subagent judge them blind
  against a 9-dimension weighted rubric, adds axe + DOM deterministic evidence, and emits a
  gated `audit.json` + `report.md`/`report.html` with explicit exit codes. Do NOT use for
  generating visual design (`frontend-design`, `ui-ux-pro-max`), SEO metadata (`seo-check`),
  destructive/security QA (`destructive-qa`), or pure copywriting. Not the `caveman` prose-style
  plugin: that one compresses how you write, this one audits a rendered screen.
user-invocable: true
---

# caveman-ui-ux

把「第一次看到這個畫面的人看不看得懂」變成可重跑、可進 CI、有 evidence 與 exit code 的
contract。輸出 `audit.json`（canonical）+ `report.md` + 離線可開的 `report.html`。
每個 shell call 先定義一次路徑前綴 —— **指向這個 `SKILL.md` 所在的目錄**。它是 clone 下來的
repo、或 `install` 出來的專案副本，指令完全相同：

```bash
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"          # 或直接寫死你的安裝路徑，例如：
SKILL_DIR=".claude/skills/caveman-ui-ux"             # Claude Code 專案副本
SKILL_DIR=".agents/skills/caveman-ui-ux"             # Codex / OpenCode 專案副本
SKILL_DIR="$HOME/src/caveman-ui-ux"                  # 直接跑 clone 下來的 repo
```

## 1. Runtime adapter

本節自成一體，不依賴 repo 外的檔案。

- Claude Code → `export CAVEMAN_RUNTIME_HOST=claude`；Codex → `export CAVEMAN_RUNTIME_HOST=codex`。
- 必須在**第一次 state write 之前**綁定（`capture` 建 `.caveman-ui-ux/runs/<run-id>/` 之前）；未設定的 host 一律 fail loud，禁止預設成 `claude`。
- Nested skill（例如把 fix-brief 交給 `frontend-design`）：Claude Code 用原生 `Skill` tool；Codex 從 catalog 解析、完整讀完該 `SKILL.md`、在當前 task inline 執行。
- Reviewer / blind evaluator dispatch：Claude Code 用原生 `Agent` tool；Codex 用 `spawn_agent agent_type="default" fork_turns="none"`。沒有輸出 = evaluation 失敗，不是 pass。
- Pause for decision（例如 `privacy.upload_screenshots` opt-in）：先把 decision name、choices、resume location 寫進 `.pending_decision`，再 `AskUserQuestion`（Claude）或 final-turn pause（Codex）。
- 非互動執行（cron / CI / `--ci`）：不得把需要停下來的 gate 轉成 pass；沒有輸出 = 失敗。
- 若你的環境另有 runtime contract 檔（例如 zhenheco vault 的 `_lib/runtime-contract.md`），以它為準；沒有也不影響本 skill 運作。

## 2. Core principle

**Deterministic script 只生產 evidence；judgment 由 agent 做；blind 那一段必須在 fresh-context
subagent 裡跑，isolation 才是真的。** 這個分工擋掉三個失效模式：

1. **洩題式第一印象** — 讀過 PRD、route name、DOM、source 的 agent 已知道答案，它回答「看不看得懂」
   是自我確認。所以 blind 階段只餵 allowlist 的 7 個欄位 + 截圖，並強制換到沒有本 session 上下文的 subagent。
2. **無法否證的 UX 意見** — 「層級感覺很弱」不能進 report。severity 為 `blocker|critical|major` 的
   finding 必須帶 ≥1 筆 evidence，否則 `score` 直接丟掉並記進 `limitations`。
3. **被平均掉的分歧** — panel 內不一致時不扣分，而是輸出 `contradictions`（同 dimension spread ≥ 4）
   與 `evaluator_dispersion`。分歧是 ambiguity signal，不是雜訊。

兩個機制保證：deterministic checks（axe + DOM rules）沒有 LLM 也能跑（`--no-llm`＝CI path）；confidence < 0.60 的 heuristic/blind finding 不能單獨 hard-fail，除非另有 deterministic evidence。

## 3. When to use / When NOT to use

用它：新頁面進 PR 前的第一印象檢查、多語頁面比較（哪個 locale 的 CTA/導覽/版面較差）、改版前後 UX regression、把 critical UX finding 擋在 CI、要一條 finding → fix-brief → `verify` 的完整 trace。不要用它：

- 產生設計本身（配色、排版、component、動效）→ `frontend-design` 或 `ui-ux-pro-max`。
- title/meta/canonical/OG/sitemap/JSON-LD 等 metadata 與 SEO → `seo-check`。
- 破壞性測試、權限繞過、injection、資安 → `destructive-qa`。
- 一次性瀏覽、抓頁面、手動點兩下 → `browser-use`（程式化/批次）或 `claude-in-chrome`（逐步互動）。

修正階段也不要在這裡長出設計指南：`score` 產出的 `fix_brief` 是 agent-neutral 的，直接交給上面那些 design/implementation skill 實作，本 skill 只負責重測（§7）。

## 4. The 8-stage workflow

Human mode 進度走 stderr、summary 走 stdout；`--json` 模式 stdout 只有一個 JSON object。全域
options：`--config <path>` `--cwd <path>` `--json` `--quiet` `--run <run-id>`（預設最新）`--force`。

**0. 一次性環境檢查**（node、playwright、browser、axe cache、lighthouse、config、schema、locale、rules）：

```bash
node "$SKILL_DIR/scripts/caveman.mjs" doctor --json
node "$SKILL_DIR/scripts/caveman.mjs" init --base-url https://example.com --agents claude,codex
```

**1. Stage A+B — Preflight + Blind capture.** 建 run id、驗 config、render、只 dismiss 設定過的 overlay、套 redaction、截 viewport 圖、封 `sealed.json`、截圖轉唯讀。

```bash
node "$SKILL_DIR/scripts/caveman.mjs" capture https://example.com \
  --routes /,/pricing --locales zh-TW,en --viewports mobile,desktop --json
```

**2. Stage C — 準備 blind payload。** 印出 allowlist payload 與可直接貼上的 prompt；`--evaluators n` = panel。

```bash
node "$SKILL_DIR/scripts/caveman.mjs" caveman prepare --run <run-id> --screen scr_xxxxxxxxxxxx --evaluators 3
```

`privacy.upload_screenshots` 不是 `true` 時此指令以 `EXIT.PRIVACY (6)` 拒絕（先按 §1 的 pause 流程問過再解）。判定看的是 **`run.json` 那份 config 快照**，不是當下的 config 檔：**已 capture 的 run 只能加 `--allow-screenshot-upload`**；改 config 設 `privacy.upload_screenshots: true` 要重跑 `capture` 才生效。

**3. Stage C — dispatch blind evaluator（一個 evaluator 一次獨立 dispatch）。**

- Claude Code：`Agent` tool、`subagent_type: general-purpose`、fresh context，
  **prompt = `caveman prepare` 印出來的那段字串，一個字都不加不減**。
- Codex：`spawn_agent agent_type="default" fork_turns="none"`，同一段 prompt。

ORCHESTRATOR 硬性禁令：**不可以自己回答 rubric，也不可以把截圖內容轉述、摘要、翻譯或「補充說明」
給 evaluator。** 你已看過 URL、route、DOM 或需求，任何轉述都會毀掉 blind 性質、該份回答作廢；你只負責搬 prompt 與收 JSON。

**4. Stage C — ingest（immutable seal）。** 存成 `screens/<sid>/blind/<evaluator-id>.json`，過
`schemas/blind.schema.json`；已存在不覆寫（需 `--force`）。schema 或 `screen_id` 不符 → `EXIT.EVALUATOR (5)`。

```bash
node "$SKILL_DIR/scripts/caveman.mjs" caveman ingest --run <run-id> \
  --screen scr_xxxxxxxxxxxx --evaluator ev-1 --file /tmp/ev-1.json
```

Panel loop：對 `ev-1..ev-N` 重複 step 3+4。N 份 payload 完全相同、dispatch 彼此不共享 context、每份獨立 ingest；consensus（median / MAD / dispersion / contradictions）由 `score` 算，不要自己先平均。

**5. Stage D — Deterministic evidence.** axe-core 4.10.2（cache 於 `~/.claude/state/caveman-ui-ux/vendor/`）+ DOM checks + link check + 可選 Lighthouse（多次取 median）。

```bash
node "$SKILL_DIR/scripts/caveman.mjs" evidence --run <run-id>   # 可加 --no-lighthouse / --offline
```

**6. Stage E — Full-context heuristic（現在才可以看 DOM、copy、route 意圖、source）。** 讀 `screens/*/dom.json` 與 `checks.json`，用 `UX.*` rule ids 寫出 findings JSON 再 ingest。
**rule id 是封閉字彙**：先 `rules list` 查，pack 裡沒有的 id 會被整批退回（`EXIT.EVALUATOR (5)`）。

```bash
node "$SKILL_DIR/scripts/caveman.mjs" heuristic ingest --run <run-id> --file /tmp/heuristic.json
```

**7. Stage F+G+H — Multilingual matrix + Consensus + Report + Gate.**

```bash
node "$SKILL_DIR/scripts/caveman.mjs" score --run <run-id>
node "$SKILL_DIR/scripts/caveman.mjs" report --run <run-id> --locale zh-TW --inline-screenshots
```

**8. 一次跑完**（互動式仍建議分段，因為 step 3 要 dispatch）；`rules` 供 pack 自檢、
`prune` 手動執行 retention sweep（`capture` 開頭也會自動跑一次）：

```bash
node "$SKILL_DIR/scripts/caveman.mjs" audit https://example.com --panel    # 完整
node "$SKILL_DIR/scripts/caveman.mjs" audit https://example.com --no-llm   # 只跑 deterministic
node "$SKILL_DIR/scripts/caveman.mjs" rules list        # 可用 rule id（Stage E 寫 findings 前先查）
node "$SKILL_DIR/scripts/caveman.mjs" rules check
node "$SKILL_DIR/scripts/caveman.mjs" prune             # 刪過期 run + 其 staged 截圖
```

指令全集：`init` `install` `doctor` `capture` `caveman prepare` `caveman ingest` `evidence` `heuristic ingest` `score` `report` `audit` `verify` `prune` `rules`。

## 5. Blind isolation rules

- 允許進 blind evaluator 的欄位只有 7 個：`screen_id`、`viewport`、`target_locale`、
  `report_locale`、`screenshot_path`、`profile`、`task_framing`。多一個 key 就是 violation。
- 禁止：URL、route slug、page title、DOM、a11y tree、metadata、source、README/PRD/SPEC、之前的 audit、其他 evaluator 的答案。
- `capture` 會自動跑 leakage self-test，違規直接 `EXIT.PRIVACY (6)`。
- Evaluator 拿到的是 `prepare` 複製出來的中性截圖路徑
  （`~/.claude/state/caveman-ui-ux/blind/<run-id>/<screen-id>.png`）而非專案內路徑（repo 目錄名會洩漏
  產品身分）；prompt 開頭的維護者註解也會被剝掉。rendered prompt 若含 `--cwd` 一律 `EXIT.PRIVACY (6)`。
- evaluator 回答洩漏上述資訊（講出品牌名或 route）→ **丟掉整份、重新 dispatch，不要手改**。
- 完整規則、per-runtime dispatch recipe、洩漏處理 → `references/blind-protocol.md`。

## 6. Gates + exit codes

| gate | default | comparator | 說明 |
|---|---|---|---|
| `caveman_minimum` | 75 | `actual >= threshold` | 9 dimension 加權後的 Caveman Score |
| `heuristic_minimum` | null | `>=` | null = skip |
| `accessibility_minimum` | 90 | `>=` | axe penalty 模型，非 WCAG 合規判定 |
| `technical_minimum` | 85 | `>=` | Lighthouse median；不可用時 `skipped` |
| `multilingual_minimum` | null | `>=` | < 2 locales ⇒ null ⇒ skip |
| `critical_maximum` | 0 | `actual <= threshold` | 只算 `blocker`/`critical`，排除 confidence < 0.60 且非 deterministic 的 |
| `evaluator_confidence_minimum` | 0.60 | `>=` | median confidence × (1 − 0.5 × dispersion) |

threshold 或 actual 為 null ⇒ `status: 'skipped'`（不判 fail）。Composite score 永遠不驅動 gate。

**`--ci` 才會讓 gate fail 變成非零 exit code。** `score` / `audit` / `verify` 不加 `--ci` 一律
`exit 0`：gate 表照印、stderr 提示 `pass --ci to make this exit non-zero`、`audit.json` 的
`gates.pass: false` 與 `gates.exit_code: 1` 照常寫入。要用 `$?` 擋就一定要加 `--ci`。

| exit | 常數 | 意義 |
|---|---|---|
| 0 | `OK` | 全部 gate pass 或 skip；**或**有 gate fail 但沒加 `--ci` |
| 1 | `GATE_FAIL` | 至少一個 gate fail，**且**指令帶了 `--ci` |
| 2 | `CONFIG` | config 缺失/schema 錯誤/managed-block conflict |
| 3 | `TARGET` | 全部 target 都無法 render |
| 4 | `DEPENDENCY` | 找不到 playwright / browser / axe cache；`--ci` 缺 Lighthouse 又沒給 `--allow-missing-technical` |
| 5 | `EVALUATOR` | blind/heuristic 回答不符 schema 或 `screen_id` 不符 |
| 6 | `PRIVACY` | leakage violation 或未 opt-in 就要上傳截圖 |

## 7. Fix-and-verify loop

1. 從 `audit.json` 取該 finding 的 `fix_brief`（`intent` / `acceptance[]` / `suggested_change` /
   `rule_ids[]` / `target`），交給實作端（`frontend-design`、`ui-ux-pro-max` 或實作 agent）。本 skill 不寫設計建議。
2. 重測**同一組座標**（原 route + locale + viewport）：`--finding` 會把重擷取縮到那些 finding 的
   座標，不給就重擷取整個 matrix（成本≈一次 `audit`）：

   ```bash
   node "$SKILL_DIR/scripts/caveman.mjs" verify --run <run-id> --finding <finding-id>
   ```

3. 得到 `resolved` / `improved` / `unchanged` / `regressed` / `not-comparable`。**沒跑過 `verify` 就不算修好**；
   只重跑 deterministic 時 blind kind 會是 `not-comparable`，要 `resolved` 得重 dispatch evaluator
   → `references/fix-verify.md`。

## 8. CI usage

CI path 不需要 LLM：`audit --no-llm --ci` 只跑 Stage A/B/D/F/H — deterministic + multilingual + gate + exit code。

```yaml
# .github/workflows/caveman-ui-ux.yml
name: caveman-ui-ux
on: pull_request
jobs:
  ux-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - name: Install Playwright (global — the skill itself has zero npm deps)
        run: npm i -g playwright && npx --yes playwright install --with-deps chromium
      - name: Build the app        # 或改設 target.start_command，讓 capture 自己起 server
        run: npm ci && npm run build && (npm run start &)
      - name: UX gate
        env:
          CAVEMAN_RUNTIME_HOST: codex
          SKILL_DIR: .agents/skills/caveman-ui-ux
        run: |
          node "$SKILL_DIR/scripts/caveman.mjs" \
            audit http://127.0.0.1:3000 --routes /,/pricing --no-llm --ci \
            --allow-missing-technical --json > caveman-audit.json
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: caveman-ui-ux-run
          path: |
            caveman-audit.json
            .caveman-ui-ux/runs/
```

runner 上 `SKILL_DIR` 指向 `install` 出來的專案副本（或 checkout 下來的 repo）。`browser.channel: chrome` 在 ubuntu runner 通常不存在，`npx playwright install chromium` 後會落到 bundled chromium，要指定就設 `CAVEMAN_CHROME_PATH`；拿掉 `--allow-missing-technical` 則 Lighthouse（`npx -y lighthouse@12`，需 network）不可用時以 exit 4 擋住。

## 9. Reference index（progressive disclosure — read on demand）

- `references/blind-protocol.md` — dispatch evaluator、洩漏處理、isolation 自檢。
- `references/rubric.md` — 9 dimension 的 0/3/5/8/10 anchors 與**所有**分數公式（disclosure）。
- `references/pipeline.md` — Stage A–H 的 input/output/artifact、resume 語意、retention 清理。
- `references/deterministic-checks.md` — `TECH.*` 偵測邏輯、axe normalization、link check 上限。
- `references/multilingual.md` — `report_locale` vs `target_locale`、`I18N.*` matrix、script ratio。
- `references/consensus.md` — panel 設定、ADR-002 聚合數學、3-evaluator 範例、contradiction。
- `references/reporting.md` — 三種輸出、Markdown section 順序、HTML escaping/redaction。
- `references/fix-verify.md` — fix-brief contract、5 種 verify status、交棒給實作 agent。
- `references/adapters.md` — 7 個 agent target、managed block、conflict、uninstall。
- `references/licenses.md` — axe-core MPL-2.0 / Lighthouse Apache-2.0 / rule-pack metadata 邊界。

## 10. Limitations & non-goals

- **不宣稱 WCAG 或法規合規。** `accessibility_minimum` 是自訂 axe penalty 分數；自動化工具驗不了
  全部 success criteria，不要當成法律或無障礙認證依據。
- **不取代真正的使用者研究。** blind evaluator 是模型模擬的第一印象，不是受眾樣本。
- **不能用單一分數證明商業成效。** 分數不對應轉換率、營收或滿意度；composite score 必須揭露權重、不得取代 component scores，也不驅動 gate。
- **Lighthouse 數字會抖。** 預設 3 次取 median，仍禁止用單次結果做細比較；Lighthouse 自己的
  accessibility 分數只記錄不計分（a11y 由 axe 負責）。
- **不建雲端帳號/計費/team dashboard，也不把任何單一模型或 agent 設成必要依賴。**
- 截圖與 DOM 可能含敏感資料：capture 全程 local-only、上傳一律 opt-in、`privacy.redact_selectors` 要自己設。`retention_days`（預設 30）由每次 `capture` 開頭與 `prune` 指令真的執行，並同時清掉 `~/.claude/state/caveman-ui-ux/blind/` 底下的 staged 截圖複本 → `references/pipeline.md`。
