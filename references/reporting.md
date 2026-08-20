# reporting — 三個輸出、章節順序、HTML 自足規則

Stage H 的產出規範。formula 定義在 `rubric.md`，stage 流程在 `pipeline.md`，
finding status 語意在 `fix-verify.md`；本檔只講「輸出長什麼樣、怎麼讀、什麼不准出現」。

## 1. 三個輸出與各自角色

| 檔案 | 角色 | 規則 |
|---|---|---|
| `audit.json` | **唯一 machine source of truth** | 必須通過 `schemas/audit.schema.json`；CI、`verify`、diff、外部工具只讀這個檔 |
| `report.md` | human review / PR comment | 由 `audit.json` + locale dict 渲染，可重跑覆寫 |
| `report.html` | 離線 self-contained 報告（含截圖證據與 filter） | 同上，可重跑覆寫 |

三者都在 `.caveman-ui-ux/runs/<run-id>/`。`report` command 只做 re-render：

```bash
node scripts/caveman.mjs report --run <run-id> --locale zh-TW --inline-screenshots
```

**不要把 Markdown 或 HTML 當資料來源**。任何自動化（gate、baseline 比較、ticket 產生）
都必須解析 `audit.json`；Markdown/HTML 的文字會隨 `report_locale` 改變，parse 它一定會壞。
`report.md` / `report.html` 遺失或被手改不影響正確性 — 重跑 `report` 即可重建。

## 2. Markdown 章節順序（強制）

`renderMarkdown(audit, dict)` 必須依此順序輸出，不可增刪、不可重排（SPEC-001 §12）：

1. Executive summary — `report.section.executive_summary`
2. Gate — `report.section.gate`
3. Component scores — `report.section.scores`
4. Critical / major findings — `report.section.findings`
5. Locale matrix — `report.section.locale_matrix`
6. Methodology — `report.section.methodology`
7. Limitations — `report.section.limitations`
8. Notices — `report.section.notices`

固定順序的理由：報告會被 diff、被 CI 貼到 PR、被跨 run 比較。順序一動，所有 diff 都是噪音。
沒有內容的章節仍要出現，內容用 `finding.none` / `score.unavailable` 佔位，不可整段消失。

Locale matrix 只在 ≥2 locales 時有列（`multilingual.md`）。Notices 放 license 與非法律意見
聲明的指標（`licenses.md`）。

## 3. HTML self-containment 規則

`renderHtml(audit, dict, { css, inlineScreenshots })` 的硬規則：

- **零 remote request**：沒有 CDN、沒有 web font、沒有 `<link rel=stylesheet>`、沒有 `fetch`、
  沒有 remote `<img>`。斷網後 double-click 開檔必須完全正常。
- CSS 來自 `assets/report.css`，整份 inline 進單一 `<style>`。
- 截圖只在 `inlineScreenshots` 時嵌入，且必須是 `data:image/png;base64,...` URI；
  不做相對路徑引用（報告會被單獨搬走）。
- severity filter 與 status filter 用一小段 inline `<script>` 實作（純 DOM class toggle），
  不引任何 library。
- **所有來自被稽核頁面的字串**（title、visible text、DOM html、selector、link text、
  evaluator 產出的 detail）都必須經過 `redactSecrets`；HTML 端再套 `escapeHtml`。
  **順序是 `escapeHtml(redactSecrets(v))`——先 redact 再 escape，不可倒過來。**
  倒過來會漏遮：`token="abc12345"` 先 escape 變 `token=&quot;abc12345&quot;`，
  而 secret 的 value pattern 排除 `&`，於是 `&quot;` 擋住比對、密鑰原文留在報告裡。
  實作在 `lib/report.mjs` 的 `safeHtml()`（HTML）與 `mdText()`/`mdBlock()`（Markdown：
  只 redact，另外把換行壓平、escape 表格的 `|` 與行首 `#`，防 heading injection）。
  被稽核頁面裡的 `<script>alert(1)</script>` 必須以純文字呈現。

## 4. 怎麼讀 score block（不要看 composite）

報告的 score 區塊是**一組互相獨立的 component scores**，不是一個總分：

- `score.caveman` — blind 第一印象（9 dimensions 加權），配 `score.evaluator_confidence`
  與 `score.evaluator_dispersion` 一起讀：dispersion 高代表畫面本身有歧義，不是評分不準。
- `score.heuristic_ux` — full-context heuristic 扣分結果。
- `score.accessibility` — axe 證據換算，唯一的 a11y 來源。
- `score.technical` — Lighthouse median（performance / best-practices / seo），
  不含 Lighthouse 自己的 accessibility category。
- `score.multilingual_consistency` — locale matrix 扣分，<2 locales 時為 `null`。

讀法：

1. 先看 **gate table**（`report.gate.column.gate|actual|threshold|status`）。
   pass / fail / skipped 是唯一有約束力的判定；它決定 `gates.exit_code`，而 process 的 exit code
   只有在指令帶了 `--ci` 時才會跟著變（`pipeline.md`）。
2. 再看有 `fail` 的那個 component score，以及對應的 critical/major findings。
3. `null` 的 component 顯示為 `score.unavailable`，且 Limitations 一定有對應說明
   （例如 Lighthouse 不存在 → `technical_minimum` status `skipped`）。不要把 `null` 讀成 0。
4. **composite score 預設關閉**。啟用時必須揭露權重、標記 `disclosed: true`，
   且永遠不取代 component scores、永遠不驅動 gate。任何「這個網站 82 分」的單一數字說法
   都不是本工具的結論 — 拿 gate table 與 component scores 講話。

## 5. Privacy（SPEC-001 §11，不可協商）

- report 內**不得**出現 cookies、`authorization` header、API key、token、secret、bearer。
  `redactSecrets(str)` 對所有渲染字串執行，命中 `/(api[_-]?key|token|secret|bearer)/i` 一律遮蔽。
- **redaction 發生在 capture time，而且只蓋像素**：`privacy.redact_selectors` 命中的元素在截圖前
  被覆蓋成不透明黑塊，並記入 `ScreenRecord.redacted`；報告端不做「事後打碼」— 敏感像素從未進過檔案。
  **但同一段文字仍會出現在 `dom.json`、`visible_text` 與由它們產生的 finding／report 裡**，因為
  redaction 作用在截圖層、不在 DOM 層。要讓文字也不落盤，只能不 render 該元素（例如用測試帳號、
  或在應用端遮蔽）。命中 0 個元素的 selector 會在 stderr 大聲警告並記進 `ScreenRecord.redaction_misses`
  與 `audit.json.limitations`——沉默地交出一張沒遮到的截圖是不可接受的。
- **`target.extra_http_headers` 會送到頁面載入的每一個 origin**，不只 base_url：Playwright 的
  extraHTTPHeaders 掛在整個 browser context 上。把 `Authorization` 放進去，等於把它一併送給頁面
  引用的所有第三方 CDN／分析／字型網域。稽核帶認證的站台請優先用 `target.storage_state`
  （cookie 只會回送給它自己的 domain），或確認該頁不載入任何跨網域資源。
- **config 快照是遮蔽過的，live config 不是。** `run.json.config` 與 `audit.json.config`
  走 `lib/config.mjs` 的 `redactConfig()`：`target.storage_state` 換成 `[redacted-path]`，
  `target.extra_http_headers` 裡 key 命中 `authorization|cookie|proxy-authorization|x-api-key|api-key|token`
  或 value 長得像憑證（`bearer `、`sk-`、`ghp_`、`glpat-`、JWT）的換成 `[redacted]`，
  任意深度的 key 命中 `password|secret|token|api_key|credential` 也換成 `[redacted]`。
  storage state 的**內容**從頭到尾不進 run 目錄。
- `config_hash` 是對**真實 config** 算的（不是對遮蔽後的快照），所以同一份 config 的兩個 run
  仍然 hash 相同、可互相比較；快照與 hash 兩者永遠不可互換。
  跑 capture 的行程本身仍拿到未遮蔽的 config——遮蔽只發生在寫檔那一步。
- **screenshot 上傳是 opt-in**：`privacy.upload_screenshots` 預設 `false`。
  `caveman prepare` 在未開啟時直接 `EXIT.PRIVACY`。判定依據是 `run.json` 裡那份 config 快照，
  不是當下的 config 檔——已擷取的 run 只能用 `--allow-screenshot-upload`；改 config 要重跑
  `capture` 才生效（SKILL.md §4 step 2）。本機 evaluator 讀檔不算上傳。
- 對外分享 HTML 前先確認 `inlineScreenshots` 是你要的：嵌入的 base64 截圖會跟著檔案走。
