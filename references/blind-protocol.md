# blind-protocol.md — Blind Caveman 隔離協議（ADR-002 / AC-002）

Blind 階段（Stage C）的唯一目的：讓 evaluator 在**沒有任何背景知識**的狀態下回答「這是什麼、
給誰、我能得到什麼、下一步做什麼、為什麼要相信」。只要 evaluator 知道產品名、URL、原始碼或
別人的答案，這個測試就已經失效，重跑也救不回來——所以隔離是硬約束，不是最佳實務建議。

評分準則與公式在 `references/rubric.md`；多評審聚合在 `references/consensus.md`。

## Allowed input — 只有這 7 個 key

`blindPayload(screenRecord, config)` 產出的 `blind-payload.json`，key set 是 frozen allowlist：

```json
{
  "screen_id": "scr_1a2b3c4d5e6f",
  "viewport": { "id": "mobile", "width": 375, "height": 812, "device_scale_factor": 2 },
  "target_locale": "zh-TW",
  "report_locale": "zh-TW",
  "screenshot_path": ".caveman-ui-ux/runs/<run-id>/screens/scr_1a2b3c4d5e6f/screenshot.png",
  "profile": "generic",
  "task_framing": null
}
```

`profile` ∈ `'generic' | 'task'`；`task_framing` 只有在 `profile === 'task'` 時才非 null，
而且只能是一句使用者任務（例如「找到定價」），不得包含產品名稱或功能描述。
出現任何第 8 個 key ⇒ `unknown_key` violation，run 直接以 `EXIT.PRIVACY` 中止。

## Forbidden input — sealed 之前一律不得進入 evaluator context

- 帶語意的 URL slug、host、domain、任何完整或部分路由字串
- DOM、accessibility tree、HTML source
- metadata（title、meta description、og tags）
- source code、component 名稱、檔名（`src/`、`.ts`、`.tsx`、`package.json`）
- README / PRD / SPEC / design doc / ticket
- 先前的 audit、report、finding 清單
- 其他 evaluator 的答案或分數
- 產品名、公司名、品牌、競品比較

`assertNoLeakage(payload, { baseUrl, routes, sealed, extraSecrets })` 會 deep-scan 每個 string value，
回傳 `{ ok, violations: [{kind, key, value}] }`，violation kinds：
`forbidden_key`、`host_leak`、`route_leak`、`title_leak`、`path_leak`、`unknown_key`。
`screenshot_path` 只允許含 run id 與 opaque screen id；其 basename dir 必須符合 `/^scr_[0-9a-f]{12}$/`。
route / locale / viewport 的對照表存在 `sealed.json`，**對 blind evaluator 永久禁止**。

### Screenshot 路徑也會洩漏身分

Evaluator 必須真的讀得到那張圖，所以 prompt 裡是**絕對路徑**。專案內路徑
（`/…/acme-invoicing/.caveman-ui-ux/…`）本身就含產品名——那正是 ADR-002 禁止的「從檔案路徑推斷產品」。
因此 `caveman prepare` 先用 `stageBlindScreenshot()` 把圖複製到與產品無關的
`~/.claude/state/caveman-ui-ux/blind/<run-id>/<screen-id>.png`（可用 `CAVEMAN_STATE_DIR` 覆寫），
只交這個路徑；並在 dispatch 前斷言 rendered prompt 不含 `--cwd`，違反即 `EXIT.PRIVACY`。
隔離是結構保證，不是靠 evaluator 自律。這些 staged 複本是**可丟的**（`prepare` 隨時能重做），
由 retention sweep 回收，見 `references/pipeline.md` 的 Retention 一節。

同一個理由，`evaluatorPrompt()` 會在替換 placeholder **之前**把 `assets/blind-prompt.md`
開頭的 `<!-- ... -->` 註解整塊剝掉：那段維護者說明點名了 `lib/blind.mjs`、
`references/blind-protocol.md`、`references/rubric.md`，正是 ADR-002 不准 evaluator 知道的
檔案佈局。所以 evaluator 收到的第一行永遠是 `# Blind first-impression evaluation`。

### 自我檢測

```bash
node --test scripts/tests/blind-leakage.test.mjs scripts/tests/blind-prompt.test.mjs
```
改過 `lib/blind.mjs`、payload 欄位、`schemas/blind.schema.json` 或 `assets/blind-prompt.md`
之後必跑。前者是 AC-002 的證據；後者把 prompt 與 schema 綁在一起（兩邊曾經各自漂移，
`--no-llm` 測試全綠但 Stage C 整條壞掉）。

## Sealing rule — raw response 不可變

1. `caveman ingest` 先用 `schemas/blind.schema.json` 驗證，不合格 ⇒ `EXIT.EVALUATOR`。
2. `data.screen_id !== screenId` ⇒ `EXIT.EVALUATOR`（答錯螢幕的回應不能收）。
3. 檔案已存在且沒給 `--force` ⇒ 拒寫。**已 sealed 的回應是不可變的**。
4. 通過後原封不動寫入 `runs/<run-id>/screens/<sid>/blind/<evaluator-id>.json`，只加 `_ingested_at`。

**不要編輯 evaluator 的回應。** 覺得寫得不好、覺得分數不合理、覺得有錯字，都不能改——
那會把「盲測資料」變成「你自己的意見」。要改只有一條路：丟掉整份回應，換一個 fresh context 重派。

### Evaluator 洩漏了怎麼辦

如果 evaluator 在回應裡提到 URL、產品名、程式碼或任何它不該知道的東西，代表這個 context 已污染：
**discard 整份回應（不 ingest，或以 `--force` 覆蓋為新回應）→ 換新的 evaluator id → 重新 dispatch。**
不要只刪掉那一句話留下分數：分數是在污染狀態下產生的。同時檢查 payload 是否真的乾淨（跑上面的測試）。

## Blind output contract

Evaluator 必須依 ADR-002 順序先回答問題、再打分：`what_is_this`、`who_is_it_for`、
`what_can_i_get_or_do`、`what_should_i_do_next`、`why_should_i_trust_it`、`uncertainties`，
接著 9 個 dimension 的分數、evidence regions、confidence。

Evaluator 只輸出四個 top-level key。`evaluator`（id/runtime/model）與 `_ingested_at` 由
`caveman ingest` 補上——evaluator 不知道自己是誰，也不該知道。

```json
{
  "screen_id": "scr_1a2b3c4d5e6f",
  "answers": {
    "what_is_this": "", "who_is_it_for": "", "what_can_i_get_or_do": "",
    "what_should_i_do_next": "", "why_should_i_trust_it": "", "uncertainties": [""]
  },
  "dimensions": {
    "identity": {
      "score": 6,
      "rationale": "",
      "evidence": [ { "type": "screenshot_region", "screen_id": "scr_1a2b3c4d5e6f", "box": { "x": 24, "y": 96, "w": 327, "h": 72 }, "note": "" } ]
    }
  },
  "confidence": 0.75
}
```
9 個 dimension 全部必填；evidence 掛在**各 dimension 之下**，沒有 top-level `evidence` 陣列。

**Evidence box 用截圖自己的像素座標**，不是 CSS 像素：viewport 375x812 @2x 的截圖是 750x1624，
prompt 會把實際尺寸寫給 evaluator（`{{image_pixels}}`，由 `screenshotPixels()` 直接讀 PNG header）。
`caveman ingest` 會驗界：`x+w` 或 `y+h` 超出圖就以 `EXIT.EVALUATOR` 退回；若偵測到兩軸用不同座標系
（縱向已是 image px、橫向卻沒超過 CSS 寬）會大聲警告並要求重派。
（實測教訓：同一份 prompt 派給兩個真實 evaluator，一個用 image px、一個 x 軸用 CSS、y 軸用 image px，
兩者都產出無意義的 evidence 而當時沒有任何機制擋下來。）
dimension 用 `rationale`，evidence 才用 `note`；box 是 viewport 像素座標，不是比例。
權威定義是 `schemas/blind.schema.json`——`caveman ingest` 以它驗證，欄位有異動一律以 schema 為準；
`assets/blind-prompt.md` 是同一份契約的另一半，兩者由 `scripts/tests/blind-prompt.test.mjs` 綁在一起，
改任一邊都要跑它。`screen_id` 必須與 payload 完全相同。`confidence` 是 evaluator 對**自己這次判讀**
的信心，不是對產品品質的評價。看不懂就寫進 `uncertainties` 並壓低 confidence，不要猜。

## Per-runtime dispatch recipes

先產出 payload 與可直接貼上的 prompt（`evaluatorPrompt` 由 `assets/blind-prompt.md` 套版）：

```bash
node scripts/caveman.mjs caveman prepare --screen scr_1a2b3c4d5e6f --evaluators 3
```
`privacy.upload_screenshots !== true` 時這個指令會以 `EXIT.PRIVACY` 拒絕——截圖要離開本機前
一定要有人明示同意。判定看的是 `run.json` 那份 config **快照**，不是當下的 config 檔：
- 已經 capture 過的 run → 只有 `--allow-screenshot-upload` 有效。
- 想讓 config 生效 → 設 `privacy.upload_screenshots: true` 後**重跑 `capture`**（run 永遠沿用
  當初擷取時的 config）。

- **Claude Code**：用 `Agent` tool、`subagent_type: general-purpose`，prompt 就是 `evaluatorPrompt`
  的輸出全文，附上截圖絕對路徑。每個 evaluator 一次新 dispatch，不要在同一個 subagent 裡連問兩張圖。
- **Codex**：`spawn_agent agent_type="default" fork_turns="none"`。`fork_turns="none"` 是隔離的關鍵——
  fork 會把主線對話（含 URL 與產品討論）帶進去。

每份回應存檔後 ingest：

```bash
node scripts/caveman.mjs caveman ingest --screen scr_1a2b3c4d5e6f --evaluator e1 --file /path/to/e1.json
```

## Orchestrator 自己的義務

派工的那個 agent（你）比 evaluator 更容易毀掉這個測試。禁止事項：

- **不要幫 evaluator 描述畫面**——不摘要、不解釋版面、不說「上面那個藍色按鈕是註冊」。
- **不要自己回答 rubric**。你已經知道這是什麼產品，你的分數沒有 blind 價值；你的判斷屬於
  Stage E heuristic findings，走 `heuristic ingest`，`kind` 標 `heuristic`。
- **不要透露 URL、host、route、repo、branch、ticket 編號**。
- **evaluator 反問「這是什麼產品／這是哪個網站／給我背景」時，不回答**。正確回覆是：只依截圖作答，
  不確定的寫進 `uncertainties`。給了背景就等於重跑一次無效測試。
- 不要把多個 evaluator 的回應互相轉述，也不要在第二位 evaluator 的 prompt 裡提到第一位說了什麼。

## Confidence 低的時候

- **照實報告**。低 confidence 本身就是結果：screenshot 沒有提供足夠線索讓一個新使用者理解畫面。
- **不要補提示再問一次**。加了提示得到的高分是你餵出來的，不是畫面掙來的。
- 需要更穩的訊號時，正確做法是**增加 evaluator 數量**（panel），讓 median 與 dispersion 說話 —— 見
  `references/consensus.md`。
- `evaluator_confidence` 低於 `gates.evaluator_confidence_minimum`（預設 0.60）時 gate 會 fail；
  這代表「這次評估不可信」，不代表「畫面很爛」，處理方式是改善畫面線索或補評審，不是調低門檻。
- 低 confidence 的 heuristic / blind finding 不能單獨造成 hard fail（規則見 `references/rubric.md`）。
