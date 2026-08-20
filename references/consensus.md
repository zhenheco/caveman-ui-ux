# consensus.md — Panel 聚合與 disagreement 判讀（ADR-002）

一個 evaluator 只能告訴你「一個新使用者可能怎麼理解這個畫面」；多個 evaluator 才能告訴你
「這個畫面的理解是否穩定」。Panel 的產出有兩個獨立訊號：**consensus score**（畫面好不好）與
**dispersion / contradictions**（畫面是否曖昧）。兩者不互相抵銷。

公式定義在 `references/rubric.md`（consensus 段），隔離規則在 `references/blind-protocol.md`。
本檔只做一件事：把數字算給你看，並說明怎麼讀。

## Panel setup

config：

```yaml
evaluation:
  panel:
    enabled: true
    evaluators: [e1, e2, e3]
```

流程：`caveman prepare --evaluators 3` 產出同一份 payload 的 N 份 prompt → 各自 fresh context
dispatch → 每份 `caveman ingest --evaluator <id>` 分別 seal → `score` 聚合。也可以直接
`audit --panel`。建議用**奇數**（3 起跳）：median 不必取兩數平均，結果更好解釋。
每個 evaluator 必須是獨立 context，否則 median 只是同一個意見複製三次。

## Worked example — 3 evaluators, 1 screen

Evaluator confidence：`e1 = 0.75`、`e2 = 0.85`、`e3 = 0.70`。

| dimension | w | e1 | e2 | e3 | median | MAD | dispersion | spread |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| identity | 15 | 4 | 6 | 8 | 6 | 2 | 0.80 | **4** |
| audience | 10 | 5 | 6 | 7 | 6 | 1 | 0.40 | 2 |
| value | 20 | 3 | 4 | 6 | 4 | 1 | 0.40 | 3 |
| primary_action | 15 | 5 | 6 | 7 | 6 | 1 | 0.40 | 2 |
| visual_hierarchy | 10 | 6 | 7 | 8 | 7 | 1 | 0.40 | 2 |
| cognitive_simplicity | 10 | 5 | 5 | 6 | 5 | 0 | 0.00 | 1 |
| trust | 10 | 3 | 4 | 4 | 4 | 0 | 0.00 | 1 |
| navigation | 5 | 8 | 8 | 8 | 8 | 0 | 0.00 | 0 |
| language_clarity | 5 | 6 | 7 | 7 | 7 | 0 | 0.00 | 1 |

### 逐格算術

`identity` = `[4, 6, 8]`：median = 6。絕對偏差 = `|4-6|, |6-6|, |8-6|` = `2, 0, 2`，
排序 `0, 2, 2` → MAD = 2 → dispersion = `min(1, 2 / 2.5)` = **0.80**。spread = `8 - 4` = **4**。

`audience` = `[5, 6, 7]`：median = 6，偏差 `1, 0, 1` → 排序 `0, 1, 1` → MAD = 1 →
dispersion = `min(1, 1 / 2.5)` = **0.40**。

`value` = `[3, 4, 6]`：median = 4，偏差 `1, 0, 2` → 排序 `0, 1, 2` → MAD = 1 → dispersion = **0.40**。
注意 median 4 不受 `6` 這個高分拉動——這就是用 median 而非 mean 的理由。

`cognitive_simplicity` = `[5, 5, 6]`：median = 5，偏差 `0, 0, 1` → 排序 `0, 0, 1` → MAD = 0 →
dispersion = **0.00**。三人只差 1 分視為一致。

（三個值的一般解：排序後 `a ≤ b ≤ c`，median = `b`，`MAD = min(b - a, c - b)`。）

### 整體聚合

```text
dispersions        = [0.80, 0.40, 0.40, 0.40, 0.40, 0.00, 0.00, 0.00, 0.00]
sorted             = [0.00, 0.00, 0.00, 0.00, 0.40, 0.40, 0.40, 0.40, 0.80]
medianDispersion   = 第 5 個 = 0.40                       → evaluator_dispersion = 0.40

confidences        = [0.75, 0.85, 0.70]，sorted = [0.70, 0.75, 0.85]
median(confidence) = 0.75
evaluator_confidence = 0.75 × (1 - 0.5 × 0.40) = 0.75 × 0.80 = 0.60   → band: medium
```

### caveman_score（用 consensus medians）

```text
identity              6 × 15/10 = 9.0
audience              6 × 10/10 = 6.0
value                 4 × 20/10 = 8.0
primary_action        6 × 15/10 = 9.0
visual_hierarchy      7 × 10/10 = 7.0
cognitive_simplicity  5 × 10/10 = 5.0
trust                 4 × 10/10 = 4.0
navigation            8 ×  5/10 = 4.0
language_clarity      7 ×  5/10 = 3.5
                      ---------------
caveman_score                55.5
```

### 這一輪的 gate 判讀

- `caveman_minimum: 75` → actual 55.5 → **fail**（`gates.exit_code` 記 `EXIT.GATE_FAIL`；process
  真的回 1 要加 `--ci`，見 `pipeline.md`）。主因是 value（weight 20，median 只有 4）與 trust。
- `evaluator_confidence_minimum: 0.60` → actual 0.60 → **pass**，剛好踩在門檻上。
  0.75 的原始信心被 0.40 的 dispersion 打掉 20%：三個人看同一張圖但不同意，這次判讀就沒那麼可信。

### contradictions

只有 `identity` 的 `spread = 8 - 4 = 4 >= 4`，所以輸出一筆：

```json
{ "contradictions": [ { "dimension": "identity", "spread": 4, "scores": [4, 6, 8] } ] }
```

`value` 的 spread 是 3、`audience` 是 2，都不觸發。門檻設在 4 的原因：跨越兩個 anchor 區間
（例如「猜得出大類」對「能正確說出主體」）才算真的看法衝突，1–3 分屬正常打分差異。

## 為什麼 disagreement 不扣分

`identity` 的 median 是 6，就用 6，**不會**因為三人不同意而再扣分。理由：

1. **歸因對象不同。** 分數回答「畫面好不好」，dispersion 回答「畫面是否讓不同的人得出不同結論」。
   把後者加進前者，兩個訊號都會失去意義，而且同一個缺陷會被罰兩次。
2. **spread 大是關於 SCREEN 的事實，不是 evaluator 的錯。** 三個獨立 fresh context 對「這是什麼」
   給出 4 / 6 / 8，最可能的解釋是這個畫面本身允許多種讀法——這正是 caveman test 要找的東西。
   修正方向是讓 identity 只剩一種讀法，不是找一個「打分比較準」的 evaluator。
3. **不可信不等於不好。** 低 confidence／高 dispersion 的處理是補評審或改善畫面線索，
   不是調門檻，也不是給提示再問一次（見 `references/blind-protocol.md`）。

所以 dispersion 只出現在兩個地方：`evaluator_confidence` 的折扣係數，以及 `contradictions` 清單。
它永遠不會直接改動任何 dimension 的 median。

## 單一 evaluator

`dispersion = 0`、`evaluator_confidence` = 該 evaluator 自己的 confidence、`contradictions` 為空。
這不代表「完全一致」，只代表「沒有第二個意見可比」——報告要照實這樣讀，別把 dispersion 0 當成穩定。
