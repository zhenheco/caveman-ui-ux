# ADR-003 — Third-party integration and license boundaries

- Status: Accepted for v1
- Date: 2026-08-18

> 本文件是工程授權邊界，不是法律意見。正式發布前仍應進行 license review。

## ux-pilot

- Upstream: `Sakaax/ux-pilot`
- Reported license: MIT
- Integration mode: optional rule-pack importer / attributed snapshot

### Rules

- 不將 `ux-pilot` 當 runtime architecture dependency。
- 若匯入其檔案，保留原 MIT license、copyright notice、upstream commit SHA。
- 每條 imported rule 必須記錄 `source_pack`、`source_rule_id`、`source_commit`。
- 不明確屬於 MIT 發布內容的外部文字不得再次散布。

## web-auditor-playwright

- Upstream: `ems-project/web-auditor-playwright`
- Reported license: LGPL-3.0
- Integration mode: optional external process adapter

### Rules

- v1 核心不複製其程式碼。
- 使用者自行安裝後，adapter 以 child process 呼叫並解析 JSON。
- 若未安裝，核心仍可用 Playwright + axe + Lighthouse 執行。
- 如未來要 link、fork 或 distribute modified version，另開 ADR 與 legal review。

## axe-core

- License: MPL-2.0 family；需保留相應 notices。
- Integration mode: npm dependency / adapter。
- 修改其來源檔案時，必須遵守 file-level copyleft requirements。

## Lighthouse / Lighthouse CI

- License: Apache-2.0
- Integration mode: npm dependency / external CLI。
- 保留 NOTICE 與 license obligations。

## Rule-source policy

每個 rule pack 必須具有：

```yaml
id: pack-name
version: semver
source_url: string
source_commit: string
license: SPDX identifier
attribution_file: path
redistribution_reviewed: boolean
```

`redistribution_reviewed: false` 的 pack 只能在本機 import，不得進入 published npm tarball。
