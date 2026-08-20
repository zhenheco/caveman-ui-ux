# fix-verify — fix_brief 契約與 verify 迴圈

修完不等於做完。做完的定義是：`verify` 用**原座標**重跑過，且報告顯示 before / after
evidence（AC-007）。score formula 見 `rubric.md`，輸出格式見 `reporting.md`。

## 1. fix_brief 契約

每個 finding 都帶一個 agent-neutral 的 `fix_brief`（FR-013）：

```json
{
  "intent": "讓訪客在首屏就知道這是什麼產品",
  "acceptance": [
    "首屏可見一句話說明產品類別與對象",
    "該句不含未定義的內部術語"
  ],
  "suggested_change": "把 hero h1 從品牌 slogan 改成具體的產品描述",
  "rule_ids": ["CAVEMAN.IDENTITY.001"],
  "target": { "route": "/", "normalized_route": "/", "locale": "zh-TW",
              "viewport": "mobile", "screen_id": "scr_1a2b3c4d5e6f",
              "url": "https://example.com/" }
}
```

欄位語意：

- `intent` — 要達成的**結果**，一句話，不是實作步驟。
- `acceptance[]` — 可被人或 agent 逐條判定的驗收條件；每條都要能回答 yes/no。
  這是 fix_brief 的核心，寫不出 acceptance 就代表 finding 本身還不夠具體。
- `suggested_change` — 最小可行的修改方向。它是**建議**，不是規格；實作者可以換做法，
  只要 `acceptance` 全過。
- `rule_ids[]` — 這個 brief 對應的 rule，供實作端與 diff 對齊用。**它不決定 `verify` 跑哪些
  check**：重測範圍由 `--finding` 的座標決定（見 §3），Stage D 的 check 一律整組重跑。
- `target` — 原始座標（route / normalized_route / locale / viewport / screen_id / url）。
  這組值是 verify 的輸入，**不可以在修完後改寫**。

## 2. 怎麼把 brief 交給實作 agent

一次交一個 brief，附上 `intent` + `acceptance[]` + `suggested_change` + evidence
（selector、metric、截圖區塊）。實作者要回報「改了哪些檔案」與「哪一條 acceptance 對應哪個改動」。

**不要在這裡重述設計建議。** 本 skill 的職責是「發現並驗證問題」，不是產生視覺設計：

- 需要重做視覺、版面、色彩、字級階層、component 樣式 → 派給 `frontend-design`。
- 需要 design system / palette / font pairing / UX guideline 查表 → 派給 `ui-ux-pro-max`。
- 需要文案改寫 → 交給寫文案的流程，本 skill 只給 `acceptance`。

把 `intent` 與 `acceptance[]` 當成 design skill 的 input constraint，讓它出方案；
回來之後由 `verify` 判定，不由 design skill 自己宣告修好。

## 3. verify command

```bash
node scripts/caveman.mjs verify --run <run-id> [--finding <id>] [--finding <id>]
```

`verify` 必須**重用原 run 的座標**（FR-013），而 `--finding` 決定重測的範圍：

- route / locale / viewport 一律從**原 run 的 sealed 座標**讀（finding 的 `target`），
  不從當前 config 猜。config 快照也沿用原 run 的。
- **`--finding` 會縮小重擷取範圍**：只重跑那些 finding 的 `target` 的
  `(route, locale, viewport)` 三元組所對應的 screen，其餘 screen 不重擷取、不重跑 evidence。
  給多個 `--finding` 就是這些三元組的聯集；某個軸是 `null`（例如跨 viewport 的 finding）
  代表「那個軸全取」。`--finding` 給的 id 不在前一輪 `audit.json` 裡 ⇒ `2 CONFIG`。
- **不給 `--finding` 的 `verify` 會重擷取整個 matrix**（原 run 的全部 screen）。想要快就給
  `--finding`；一次全量 verify 的成本大約等於一次 `audit`。
- Stage D 的 check 一律整組重跑（`collectDom` + axe + `runChecks` + link check）——
  `fix_brief.rule_ids` **不會**被用來只挑幾條 rule 跑。它的用途是告訴實作端「這個 brief 對應
  哪幾條 rule」，以及 diff 時的對齊；rule 層級的過濾不存在，因為修 A 常常會弄壞 B，
  只重跑 A 就看不到那個退步。
- 產出 `verify.json`，並在 `report.md` 追加 diff 章節，逐 finding 顯示 before / after
  severity + evidence（AC-007）。`--finding` 同時也是報告 diff 的過濾條件。

換 viewport、換 locale、改 route 之後跑出來的「好了」不算驗證 — 那是另一個座標的另一次量測。

## 4. 五種 status（定義固定）

| status | 定義 |
|---|---|
| `resolved` | 原 finding 消失 |
| `improved` | severity 降低 ≥1 級 |
| `unchanged` | 同一個 finding id 且 severity 相同 |
| `regressed` | severity 上升，或出現共用同一 rule + target 的新 finding |
| `not-comparable` | target 不可達、viewport/locale 不存在，或該 finding kind 需要的 evaluator 這次沒重跑 |

locale key 對應 `status.resolved|improved|unchanged|regressed|not_comparable`。
`regressed` 特別注意第二種情形：修一個問題換出同 rule 的新問題，仍算退步，不是 resolved。

## 5. heuristic / blind finding 的驗證

deterministic finding（`kind: 'deterministic'`）由 script 重跑即可判定。
**heuristic 與 blind finding 不行** — 它們的判斷來自 agent：

- 要驗證 blind finding，必須重新 dispatch 一個 fresh-context evaluator，對**新截圖**重做
  blind 評估（流程見 `blind-protocol.md`），不可以拿舊回應比對，也不可以自己代答。
- 要驗證 heuristic finding，必須重跑 Stage E 的 full-context 判讀。
- 沒有重新 dispatch evaluator 就跑 `verify` → 該 finding 一律回 `not-comparable`，
  **不是** `resolved`。這是刻意的：沉默不代表修好。

## 6. Done 的判定

一個 fix 只有在以下三件事都成立時才算 done：

1. `verify` 在**同一組座標**上重跑過（route + normalized_route + locale + viewport）。
2. 該 finding 的 status 是 `resolved` 或 `improved`。
3. 報告顯示 before / after evidence，且沒有新的 `regressed`。

任何一項缺失，回報用「changed but not verified」，不要說修好了。
