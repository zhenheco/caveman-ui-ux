# licenses — 第三方整合與授權邊界（ADR-003）

> **本檔是工程授權邊界，不是法律意見。** 正式對外發布（publish / redistribute）前
> 仍應另做 license review。以下每個 upstream 的授權都以「reported license」記錄，
> 意思是取自 upstream 專案自述，未經法律確認。

執行細節（axe 版本鎖定、快取路徑判斷、Lighthouse 呼叫參數）在 `deterministic-checks.md`；
本檔只講授權義務與邊界。

## 1. axe-core

- Reported license: **MPL-2.0 family**，需保留相應 notices。
- Integration mode：**runtime download，不 vendor**。`axe.min.js` 由 `lib/axe.mjs` 以
  `node:https` 下載到 state dir：

  ```
  ${CAVEMAN_STATE_DIR:-$HOME/.claude/state/caveman-ui-ux}/vendor/axe-core-<version>/axe.min.js
  ```

- 同目錄必須寫一份 `NOTICE.txt`，記錄 upstream 名稱、版本、reported license 與取得來源 URL。
- 這個檔案**不進 canonical bundle、不進 git、不進任何 artifact**；它是本機快取。
- 我們只 inject 未修改的 upstream 檔案。**若修改其來源檔案，file-level copyleft
  requirements 即適用**（改過的那個檔案要以同授權釋出）— v1 不修改，也不要開始修改。
  要調整 axe 行為請用它的 options（rules / resultTypes），不要改檔。

## 2. Lighthouse / Lighthouse CI

- Reported license: **Apache-2.0**。
- Integration mode：**external CLI via `npx -y lighthouse@12`，不 vendor、不進 bundle。**
- 保留 NOTICE 與 license obligations：若日後改為隨附散布（vendored / bundled），
  必須附上 Apache-2.0 授權全文與 NOTICE 檔。v1 沒有這個義務，因為我們只呼叫使用者環境裡的它。
- 呼叫一律用 argv array，不用 shell string（同時是 SPEC-001 §11 的安全要求）。

## 3. `Sakaax/ux-pilot`

- Reported license: **MIT**。
- Integration mode：**optional rule-pack importer / attributed snapshot**。
- 規則：
  - **不**把 `ux-pilot` 當 runtime architecture dependency（核心不 import、不執行它的程式）。
  - 若匯入其檔案，必須保留原 **MIT license 全文、copyright notice、upstream commit SHA**。
  - 每一條 imported rule 必須記錄 `source_pack`、`source_rule_id`、`source_commit`。
  - 不明確屬於 MIT 發布內容的外部文字（例如它引用的第三方素材）**不得再次散布**。

## 4. `ems-project/web-auditor-playwright`

- Reported license: **LGPL-3.0**。
- Integration mode：**optional external process adapter**。
- 規則：
  - v1 核心**不複製其程式碼**、不 link、不 vendor（AC-008）。
  - 使用者自行安裝後，adapter 以 child process 呼叫（**argv array**，不做 shell interpolation）
    並解析其 JSON 輸出。
  - 未安裝時核心照常運作 — Playwright + axe + Lighthouse 已足夠，這個 adapter 純加分。
  - 未來若要 **link、fork 或 distribute modified version**，必須另開一份 ADR 並做 legal review，
    不得在既有 ADR 下自行擴大用法。

## 5. Rule pack metadata contract

每個 rule pack（含 `rules/core.pack.yaml` 與任何 imported pack）必須具備：

```yaml
id: pack-name
version: semver
source_url: string
source_commit: string
license: SPDX identifier
attribution_file: path
redistribution_reviewed: boolean
```

`lib/rules.mjs` 的 `checkRules()` 會驗這七個欄位存在。imported rule 另外必須帶
`source_pack` / `source_rule_id` / `source_commit`（AC-008：imported rules 有 source commit
與 license metadata）。缺 metadata 的 pack 一律當錯誤，不當警告。

## 6. `redistribution_reviewed: false` ⇒ local import only

`redistribution_reviewed: false` 的 pack **只能在本機 import**，不得進入任何對外散布物
（published npm tarball、release 壓縮檔、canonical bundle）。

具體約束：

- 不可列在 `assets/caveman.config.example.yaml` 的 `rules.packs` 裡（example config 是散布內容）。
- 可以在使用者自己的 `caveman.config.yaml` 裡啟用，那是本機決定。
- `redistribution_reviewed` 從 `false` 改成 `true` 是一個**人做的決定**，需要先完成
  該 pack 的授權審查；不是 script 可以自動翻的旗標。
