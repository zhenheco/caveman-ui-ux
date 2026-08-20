# rubric.md — Caveman 評分準則與完整公式揭露

本檔是 caveman-ui-ux 的 **disclosure document**：所有分數的權重、anchors 與公式全部寫在這裡，
不存在隱藏加權。任何報告裡的數字都必須能用本檔手算重現。實作在 `scripts/lib/scoring.mjs`，
測試在 `scripts/tests/scoring.test.mjs`。

Evaluator 只看 viewport screenshot（見 `references/blind-protocol.md`），每個 dimension 打 0–10。
`0 / 3 / 5 / 8 / 10` 是 judgement anchors，不是唯一可用值；1、2、4、6、7、9 用相鄰 anchor 內插。

## 9 dimensions（權重來源，verbatim）

```js
export const DIMENSIONS = [
  { key:'identity',            weight:15, question:'這是什麼？' },
  { key:'audience',            weight:10, question:'這是給誰的？' },
  { key:'value',               weight:20, question:'我能得到什麼？' },
  { key:'primary_action',      weight:15, question:'下一步要做什麼？' },
  { key:'visual_hierarchy',    weight:10, question:'第一眼是否看到最重要資訊？' },
  { key:'cognitive_simplicity',weight:10, question:'是否需要過多推理？' },
  { key:'trust',               weight:10, question:'是否有足夠理由相信？' },
  { key:'navigation',          weight: 5, question:'是否知道如何移動或返回？' },
  { key:'language_clarity',    weight: 5, question:'用詞是否直接、自然、無行話？' },
];
```

### identity — weight 15 — 「這是什麼？」
- **0**：完全看不出主體，這張截圖可以是任何東西。
- **3**：只猜得出大類（「某種 SaaS 吧」），說不出它做什麼。
- **5**：能講出一句籠統描述，但要靠推理補完缺口。
- **8**：能正確說出主體與類別，只在細節上不確定。
- **10**：第一眼就能用一句話正確說出這是什麼，零推理。

### audience — weight 10 — 「這是給誰的？」
- **0**：畫面沒有任何指向使用對象的線索。
- **3**：只能靠風格猜（「看起來偏開發者」）。
- **5**：說得出一個很寬的族群，但不確定自己算不算在內。
- **8**：能指出明確族群與使用情境，邊界略模糊。
- **10**：一眼看出目標對象，並且能說出「這不是給誰的」。

### value — weight 20 — 「我能得到什麼？」
- **0**：看不出任何好處，也看不出可以做什麼。
- **3**：只有抽象承諾（「更好的體驗」），無法轉成具體結果。
- **5**：知道好處的大方向，但說不出量級或具體產出。
- **8**：能說出具體結果，缺證據或缺量化。
- **10**：能說出具體、可驗證的結果，並知道自己要付出什麼。

### primary_action — weight 15 — 「下一步要做什麼？」
- **0**：畫面上沒有可辨識的下一步。
- **3**：有按鈕，但看不出哪一個才是主要動作。
- **5**：猜得到主要動作，但至少有兩個視覺強度相同的候選。
- **8**：主要動作明確，label 的用詞還要一點推理。
- **10**：主要動作唯一、視覺最強，label 直接說出動作結果。

### visual_hierarchy — weight 10 — 「第一眼是否看到最重要資訊？」
- **0**：視線沒有落點，或第一眼落在裝飾與廣告上。
- **3**：第一眼落在與核心價值無關的元素。
- **5**：要掃視兩三次才找到主要訊息。
- **8**：主要訊息第一眼可得，次要層級稍吵。
- **10**：第一眼就是最重要訊息，強到弱的層級一致。

### cognitive_simplicity — weight 10 — 「是否需要過多推理？」
- **0**：需要外部知識或多步推理才能理解畫面在幹什麼。
- **3**：資訊過載，必須逐字讀完才有概念。
- **5**：理解成本中等，有明顯可刪的雜訊。
- **8**：一次掃視可理解，少數區塊需要停頓。
- **10**：無需推理；資訊量剛好足夠支撐一個決定。

### trust — weight 10 — 「是否有足夠理由相信？」
- **0**：沒有任何來源、身份或可信線索，甚至讓人起疑。
- **3**：只有自我宣稱（「業界領先」），沒有任何憑據。
- **5**：有部分線索（logo、公司名），但無法驗證。
- **8**：有具體社會證明或條件揭露，深度不足。
- **10**：可驗證的證據（具名案例、數字、條款、風險揭露）就在第一屏。

### navigation — weight 5 — 「是否知道如何移動或返回？」
- **0**：沒有導覽、沒有返回，也看不出自己在哪。
- **3**：有導覽但看不出當前位置，也找不到回頭路。
- **5**：找得到主要入口，返回路徑要猜。
- **8**：位置與返回都清楚，次層級略隱藏。
- **10**：當前位置、可去之處、返回方式三者都在畫面上。

### language_clarity — weight 5 — 「用詞是否直接、自然、無行話？」
- **0**：語意不通、機器翻譯感，或殘留其他語言。
- **3**：大量行話與內部術語，需要圈內知識才讀得懂。
- **5**：讀得懂但空泛，形容詞多於名詞與動詞。
- **8**：直接自然，少數術語未解釋。
- **10**：全部用讀者自己的語言，具體、無行話、無填充詞。

## cavemanScore(dimScores)

```text
sum(weight × dimension_score / 10)   → 四捨五入到小數 1 位
```
9 個 dimension 全滿（10）＝ 100.0；全 5 ＝ 50.0。缺任何一個 dimension ⇒ throw，不補 0、不補平均。

## consensus(responses) — ADR-002

`responses` = `[{ evaluator_id, dimensions: {key:{score}}, confidence }]`。

```text
每個 dimension：
  scores            = responses.map(r => r.dimensions[key].score)
  consensus_score   = median(scores)
  MAD               = median(abs(score - median))
  dispersion        = min(1, MAD / 2.5)

整體：
  medianDispersion     = median(每個 dimension 的 dispersion)
  evaluator_confidence = median(confidences) × (1 - 0.5 × medianDispersion)
  evaluator_dispersion = medianDispersion
  caveman_score        = cavemanScore(consensus scores)
```
`median(nums)`：偶數個取中間兩數平均，空陣列 ⇒ `null`。`mad(nums)` = `median(|x - median|)`。
Disagreement **絕不**扣分；`max - min >= 4` 的 dimension 另外輸出
`contradictions: [{dimension, spread, scores}]`。單一 evaluator ⇒ dispersion 0、confidence 用它自己的。
手算範例與解讀 → `references/consensus.md`。

## accessibilityScore(axeFindings)

```text
weight  = { critical: 10, major: 6, minor: 3, info: 1 }
penalty(f) = weight[f.severity] × min(nodeCount(f), 5)
score      = max(0, 100 - Σ penalty)
```
沒有跑 axe ⇒ `null`（不是 100）。

## technicalScore(medianCategories)

```text
round(100 × (0.5 × performance + 0.3 × bestPractices + 0.2 × seo))     // 每項 0..1
```
Lighthouse 自己的 accessibility category 會記錄但**排除**在公式外（a11y 由 axe 負責）。缺 ⇒ `null`。

## heuristicScore(findings)

只算 `kind === 'heuristic'` 的 findings。

```text
100 - Σ { blocker: 40, critical: 20, major: 8, minor: 3, info: 0 }     // floor 0
```

## multilingualScore(matrix)

從 100 起算，每個 locale row 逐項扣：

```text
-15  每個 I18N.RESIDUAL_LANGUAGE
-10  每個 I18N.CTA_PARITY
-10  每個 I18N.OVERFLOW
-8   每個 I18N.HREFLANG.*
-5   每個 I18N.MISSING_ROUTE
floor 0
```
locale 少於 2 個 ⇒ `null`。矩陣定義 → `references/multilingual.md`。

## compositeScore(scores, weights)

**預設關閉**（`composite.enabled: false`）。只在使用者明確開啟時計算，並且：權重必須揭露、
只在 non-null components 上 renormalize、回傳 `{ value, weights, disclosed: true, components }`。

```text
預設 weights = { caveman: 0.35, heuristic_ux: 0.2, accessibility: 0.25, technical: 0.1, multilingual_consistency: 0.1 }
renormalize：只保留 actual !== null 的 component，各權重除以這些權重之和
```
Composite **永遠不得取代 component scores**，也**不得驅動任何 gate**；報告必須同時列出各 component。

## Confidence bands

```text
>= 0.80  high
>= 0.60  medium
else     low
```

## Blind dimension score → finding severity

Consensus dimension 分數不是只給人看的數字：低分會直接變成 `CAVEMAN.<DIMENSION>.001` finding，
帶上 evaluator 的 rationale 與 evidence region，並計入 `critical_maximum` gate。分級與 anchors 同源：

| consensus score | severity | 對應 anchor 語意 |
|---:|---|---|
| 0–2 | `critical` | 畫面上沒有東西回答這個問題，或答案誤導人 |
| 3–4 | `major` | 只能猜，兩個陌生人會猜出不同答案 |
| 5–6 | `minor` | 資訊在，但要花力氣才找得到／看得懂 |
| 7–10 | 不產生 finding | 正常閱讀就清楚 |

實作在 `lib/scoring.mjs` 的 `dimensionSeverity()`；`scripts/tests/regressions.test.mjs` 綁住邊界。
severity 只能被 `config.rules.severity_overrides` 覆寫——pack 的 `severity_default` **不會**蓋掉
producer 依實測算出的 severity（precedence：config override > producer > pack default）。
`config.rules.disabled` 列到的 rule 會整條移除，並在 `audit.json.limitations` 記一筆，不是靜默刪除。

## Severity（ADR-002）

| Severity | Meaning |
|---|---|
| `blocker` | 頁面無法載入或主要流程完全不可執行 |
| `critical` | 大量使用者很可能無法理解或完成核心任務 |
| `major` | 顯著增加錯誤、放棄或理解成本 |
| `minor` | 局部可用性、清晰度或一致性問題 |
| `info` | 建議、觀察或需人工研究驗證 |

排序常數：`SEVERITY_ORDER = ['blocker','critical','major','minor','info']`。

## 低 confidence 不得單獨 hard-fail

`critical_maximum` gate 只計 severity ∈ {`blocker`, `critical`} 的 findings，並**排除**
`confidence < 0.60` 的 heuristic / blind findings。唯一例外：該 finding 帶 deterministic evidence
（`kind === 'deterministic'`），此時仍計入。也就是說，「模型覺得可能有問題」不能單獨讓 CI 紅燈；
要紅燈就要有可重跑的證據。`evaluateGates` 其餘 gate 在 threshold 或 actual 為 `null` 時
`status: 'skipped'`（例如 Lighthouse 不可用時的 `technical_minimum`）。
