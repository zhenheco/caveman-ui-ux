# ADR-002 — Evidence-separated evaluation and blind Caveman protocol

- Status: Accepted for v1
- Date: 2026-08-18

## Decision summary

1. Caveman evaluation 必須 screenshot-first 且 context-isolated。
2. Deterministic、heuristic、accessibility、technical scores 分開呈現。
3. Multi-evaluator 使用 median aggregation，disagreement 另外呈現。
4. CI gate 預設針對 component thresholds，不依賴 composite score。

## Caveman dimensions

| Dimension | Weight | Core question |
|---|---:|---|
| Identity | 15 | 這是什麼？ |
| Audience | 10 | 這是給誰的？ |
| Value | 20 | 我能得到什麼？ |
| Primary Action | 15 | 下一步要做什麼？ |
| Visual Hierarchy | 10 | 第一眼是否看到最重要資訊？ |
| Cognitive Simplicity | 10 | 是否需要過多推理？ |
| Trust | 10 | 是否有足夠理由相信？ |
| Navigation | 5 | 是否知道如何移動或返回？ |
| Language Clarity | 5 | 用詞是否直接、自然、無行話？ |

每項 evaluator score 為 0–10。Caveman score：

```text
sum(weight × dimension_score / 10)
```

## Blind protocol

### Allowed input

- viewport screenshot
- target locale
- generic screen identifier
- optional task framing only when running task-specific profile

### Forbidden input before blind response is sealed

- URL slug with semantic hints
- DOM / accessibility tree
- metadata
- source code
- README / PRD / SPEC
- prior audit
- other evaluators' answers

### Blind output

Evaluator 必須先回答：

- what_is_this
- who_is_it_for
- what_can_i_get_or_do
- what_should_i_do_next
- why_should_i_trust_it
- uncertainties
- dimension scores
- evidence regions
- confidence

輸出通過 JSON Schema 後才可進入下一階段。

## Multi-evaluator aggregation

對每個 dimension：

```text
consensus_score = median(agent_scores)
MAD = median(abs(score - median))
dispersion = min(1, MAD / 2.5)
consensus_confidence = median(agent_confidence) × (1 - 0.5 × dispersion)
```

不直接以 disagreement 扣分；disagreement 是獨立的 ambiguity signal。

## Scores shown in reports

- Caveman Score
- Heuristic UX Score
- Accessibility Score
- Technical Score
- Multilingual Consistency Score
- Evaluator Confidence
- Evaluator Dispersion

可選 composite score 必須揭露權重，且不得取代 component scores。

## Severity

| Severity | Meaning |
|---|---|
| blocker | 頁面無法載入或主要流程完全不可執行 |
| critical | 大量使用者很可能無法理解或完成核心任務 |
| major | 顯著增加錯誤、放棄或理解成本 |
| minor | 局部可用性、清晰度或一致性問題 |
| info | 建議、觀察或需人工研究驗證 |

## Confidence

- 0.80–1.00: high
- 0.60–0.79: medium
- 0.00–0.59: low

低 confidence finding 不得單獨造成 hard fail，除非另有 deterministic evidence。
