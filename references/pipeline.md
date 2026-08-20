# pipeline — Stage A–H、run 目錄、resume、retention

每個 stage 的 input / action / artifact / exit code，加上 run 目錄結構與重跑規則。指令總覽看
`SKILL.md` §4；分數公式看 `rubric.md`；rule 邏輯看 `deterministic-checks.md`、blind 規則看 `blind-protocol.md`。

## Run 目錄

`ROOT_DIR_NAME = '.caveman-ui-ux'`，相對受測專案的 cwd（`--cwd` 可改）：

```
.caveman-ui-ux/
├── install-manifest.json
└── runs/<run-id>/
    ├── run.json                     # run manifest（Stage A 建，各 stage 追加 stages_completed）
    ├── sealed.json                  # screen_id → {route, url, locale, viewport}；FORBIDDEN to blind evaluators
    ├── heuristic.json               # ingested Stage E findings
    ├── audit.json                   # canonical output（schemas/audit.schema.json）
    ├── report.md
    ├── report.html
    └── screens/<screen-id>/
        ├── screenshot.png
        ├── blind-payload.json       # 只有 allowlist 的 7 個欄位
        ├── blind/<evaluator-id>.json# sealed immutable raw evaluator responses
        ├── dom.json                 # Stage D/E only
        ├── axe.json
        ├── checks.json
        └── lighthouse.json
```

`--run <run-id>` 預設取最新一個 run。run id 形如 `run_20260819T154201Z_a1b2c3`（時間戳是 retention
判斷年齡的依據），screen id 形如 `scr_1a2b3c4d5e6f`（12 hex，`sha256(runId|route|locale|viewportId)`）。

### run.json 與 ScreenRecord 欄位

```
{ run_id, started_at, finished_at|null, cwd, config, config_hash, report_locale,
  tool_versions: { node, playwright, browser, axe_core, lighthouse|null },
  screens: [ScreenRecord], stages_completed: [string], blind_sealed_at|null }

ScreenRecord = { screen_id, route, normalized_route, url, locale,
  viewport: { id, width, height, device_scale_factor },
  http_status|null, status: 'ok'|'error', error|null,
  screenshot: { path, bytes, sha256 }, redacted: [selector] }
```

`config` 是那次 run 的 config 快照（憑證已遮蔽，見 `reporting.md`），`config_hash`
（對**真實** config 算的 canonical JSON sha256 前 16 hex）決定兩個 run 能不能互相比較；
`stages_completed` 是 resume 的唯一依據；`blind_sealed_at` 有值代表 `sealed.json` 已封存。
`normalized_route` 已 lowercase、去 query/hash、剝 locale prefix、去尾斜線（root 除外），
所以它才是 finding ID 與 multilingual matrix 的對齊鍵，`route` 只是原始輸入。

## Stage A — Preflight（`capture` / `audit` 前半）

| | |
|---|---|
| Input | config 檔（`caveman.config.yaml\|yml\|json` 或 `--config`）、CLI overrides、`[url]` |
| Action | resolve config → 驗 `schemas/config.schema.json` → 正規化 gate 兩種寫法 → `expandTargets` 展開 route×locale×viewport → 產 run id → 解析 playwright/browser/axe/lighthouse 版本 → retention sweep → browser preflight（`resolveLaunch`）→ 需要時起 `target.start_command` |
| Artifact | `runs/<run-id>/run.json`（`stages_completed: ['A']`） |
| Exit codes | `2 CONFIG`（找不到 `--config` 指定的檔、schema 錯、缺 base_url 又推不出 target、`start_command` 引號沒收尾或沒配 base_url）、`4 DEPENDENCY`（playwright 或 browser 解析失敗）、`3 TARGET`（`start_command` 起了但 base_url 在 timeout 內不回應） |

### `target.start_command`（`capture` / `evidence` / `verify` / `audit` 四個 command 都會執行）

由 `withTargetApp` 統一管理：
- `capture` / `evidence` / `verify` / `audit` **四個 command 都會**在需要時啟動 app（`audit` 只包一次涵蓋全部階段）。
- 所有權在 `withTargetApp`，不在 `captureMatrix`。
- 先驗 `start_command` 合法性（argv array 不能有空白或非字串元素，`2 CONFIG`），
  再跑 browser preflight（`resolveLaunch`），最後才決定要不要 spawn。
- 如果 `base_url` 的 port 上**已經有人在聽**（TCP connect 探測，與 HTTP 回應時間無關）：
  **不 spawn、不 kill**——那可能是使用者自己的 server，工具不會動它。
  會 log 一行 `reusing the server already listening on <url> (not started by us, will not be stopped)`。
- 如果 port 上沒人聽，才 spawn：切成 **argv array** 後
  `spawn(..., { shell: false })`——**不進 shell**，config 值不可能變成 shell injection（支援單/雙引號
  分段，引號沒收尾 ⇒ `2 CONFIG`）。cwd 用 `--cwd`，child 的 stdout/stderr 逐行併進進度 log。
  Readiness = 對 `base_url` 每 250ms 送一次 GET，收到**任何** status 就算起來（自簽憑證也算），
  上限 `target.wait.timeout_ms`；逾時或 child 先死 ⇒ `3 TARGET`。收尾一定在 `finally` 殺 child
  （`SIGTERM` → 5 秒後 `SIGKILL`），fn 拋錯也照殺。只管一個 child：detached worker 或
  warm-up endpoint 另有需求的站台請自己先起好。
- `null`／未設／空字串代表不需要啟動：直接跑 fn，什麼都不 spawn。

## Stage B — Blind capture（`capture`）

| | |
|---|---|
| Input | `run.json` 的 targets + `target.wait` + `target.dismiss_selectors` + `privacy.redact_selectors` |
| Action | 逐一 navigate（`wait.strategy`/`timeout_ms` + `settle_ms`）→ 只 dismiss 明確設定的 selector → 疊黑框做 redaction → 截 viewport（`fullPage:false`）→ 寫 `blind-payload.json` → 跑 `assertNoLeakage` |
| Artifact | `screens/<sid>/screenshot.png`（收尾時 `chmod 0444`）、`screens/<sid>/blind-payload.json`、`sealed.json`、`run.json.blind_sealed_at` |
| Exit codes | `6 PRIVACY`（leakage violation）、`3 TARGET`（**全部** target 都 render 失敗）、`4 DEPENDENCY`（launch candidate 全掛） |

單一 target 失敗不致命：該 ScreenRecord 記 `status:'error'` 並產一筆 `TECH.TARGET.UNREACHABLE`。

## Stage C — Caveman evaluation（`caveman prepare` → dispatch → `caveman ingest`）**需要 agent**

| | |
|---|---|
| Input | `blind-payload.json` + `screenshot.png`（evaluator 只拿到這兩樣） |
| Action | 印出 payload 與可直接貼上的 evaluator prompt → 每個 evaluator 一次獨立 fresh-context dispatch → 收 JSON → 驗 `schemas/blind.schema.json` 與 `screen_id` → verbatim 寫檔並加 `_ingested_at` |
| Artifact | `screens/<sid>/blind/<evaluator-id>.json`（write-once） |
| Exit codes | `5 EVALUATOR`（schema 不符、`screen_id` 不符、檔已存在又沒給 `--force`）、`6 PRIVACY`（`privacy.upload_screenshots !== true` 就想 prepare） |

## Stage D — Deterministic evidence（`evidence`）

| | |
|---|---|
| Input | `sealed.json` 的 url/viewport/locale（重新開頁，不用 Stage B 的截圖） |
| Action | `collectDom` → axe（注入 cache 的 axe-core）→ `runChecks` → `checkLinks` → 可選 Lighthouse（3 次取 median） |
| Artifact | `screens/<sid>/{dom.json,axe.json,checks.json,lighthouse.json}` |
| Exit codes | `4 DEPENDENCY`（axe cache miss 且 `--offline`）、`3 TARGET`（全部頁面重開都失敗） |

Lighthouse 不可用只寫 `lighthouse.json = {available:false, reason}`；擋不擋是 Stage H 的事。

## Stage E — Full-context heuristic（`heuristic ingest`）**需要 agent**

| | |
|---|---|
| Input | `dom.json`、`checks.json`、route 意圖、可選 source（此階段才准看） |
| Action | agent 用 `UX.*` rule id 寫 findings JSON → script validate → 存檔 |
| Artifact | `runs/<run-id>/heuristic.json` |
| Exit codes | `5 EVALUATOR`（findings 不合 schema，或 `rule_id` 不在 `config.rules.packs` 載入的任何 pack 裡） |

Rule id 是**封閉字彙**：ingest 拿每筆 `rule_id` 去 pack 查，查不到整批拒收並列出不認識的 id，不會
讓捏造的 id 蓋上 `rule_version` 混進 `audit.json`。先用 `rules list`（`--json`）查可用 id，Stage E 用 `UX.*` 那 9 條。

## Stage F — Multilingual matrix（`score` 內）

| | |
|---|---|
| Input | 全部 ScreenRecord + `dom.json`（`buildLocaleMatrix`） |
| Action | 按 `normalized_route` 併列各 locale，比 CTA parity / residual language / overflow / hreflang / lang 屬性 |
| Artifact | 併進 `audit.json` 的 locale matrix 與 `I18N.*` findings |
| Exit codes | 自己不丟；locale < 2 ⇒ score `null` ⇒ 該 gate `skipped` |

## Stage G — Consensus（`score` 內）

| | |
|---|---|
| Input | `screens/*/blind/*.json`（互相隔離讀入，不共享 context） |
| Action | per-dimension median + MAD → dispersion → `evaluator_confidence` → `contradictions`（spread ≥ 4） |
| Artifact | 併進 `audit.json` 的 scores 區塊 |
| Exit codes | `5 EVALUATOR`（一份可用回應都沒有且無 fallback） |

## Stage H — Reporting and gate（`score` + `report`）

| | |
|---|---|
| Input | Stage C–G 的全部 artifact + `locales/<report_locale>.json` |
| Action | 丟掉 `blocker\|critical\|major` 但零 evidence 的 finding（記進 `limitations`）→ 組 canonical JSON 並驗 `schemas/audit.schema.json` → render Markdown/HTML → `evaluateGates` → 設 exit code |
| Artifact | `audit.json`、`report.md`、`report.html`、`run.json.finished_at` |
| Exit codes | `0 OK`、`1 GATE_FAIL`（**只在有 `--ci` 時**，見下面 exit code 表）、`4 DEPENDENCY`（`--ci` 缺 Lighthouse 又沒 `--allow-missing-technical`）、`2 CONFIG`（自家 canonical JSON 驗不過＝內部錯誤，走 `CavemanError` 預設碼） |

## 為什麼 CI 只跑 deterministic subset

Stage C（blind）與 Stage E（heuristic）的產出是**agent 寫的 JSON**，沒有 agent 就沒有這兩段輸入。
所以 `audit --no-llm` 明確跳過 C 與 E，只跑 A/B/D/F/H：不需要模型、finding ID 穩定、exit code
可預測。代價照實吃：`caveman_score` 與 `heuristic_ux` 為 `null`、對應 gate `skipped` 並記進
`limitations`——CI 綠燈只等於 deterministic 與 multilingual 沒退步，不等於通過第一印象測試。

## Resume 語意

| Artifact | 可否重寫 | 怎麼重跑 |
|---|---|---|
| `screenshot.png` | **不可**（`chmod 0444`） | 開新 run（新 run id）；不要在舊 run 裡蓋圖，蓋掉就無法解釋既有 finding |
| `sealed.json` / `blind_sealed_at` | 一次性封存 | 同上 |
| `blind/<evaluator-id>.json` | **write-once** | 換一個 evaluator id 再 ingest；真的要覆寫才用 `--force`（會破壞可稽核性） |
| `dom.json` `axe.json` `checks.json` `lighthouse.json` | 可 | `evidence` 重跑即整批覆蓋（idempotent） |
| `heuristic.json` | 可 | `heuristic ingest --file` 重新灌 |
| `audit.json` `report.md` `report.html` | 可 | `score` / `report` 重跑；純換語言只要 `report --locale` |

規則一句話：**Stage A/B 是不可逆的取樣，Stage C/E 是 write-once 的證詞，Stage D/F/G/H 隨時可重算。**
續跑前先看 `run.json.stages_completed`。`verify` 不是 resume——它按原座標開新一輪重測並比 status，
`--finding` 把重擷取縮到那些 finding 的座標、不給就是全量（`references/fix-verify.md`）。

## Retention（`privacy.retention_days`，預設 30）

截圖與 DOM 可能含敏感資料，所以到期的 run 是**真的會被刪掉**的，而且有兩份要刪：專案內的
`.caveman-ui-ux/runs/<run-id>/`（canonical artifact），以及
`${CAVEMAN_STATE_DIR:-~/.claude/state/caveman-ui-ux}/blind/<run-id>/`——ADR-002 要求 blind
evaluator 只拿中性路徑，所以 `prepare` 會另存一份截圖複本在那裡（`blind-protocol.md`）。
**只刪 `.caveman-ui-ux/` 不夠。** sweep 由 `lib/retention.mjs` 的 `pruneRuns()` 一次處理兩個 root：

- 觸發時機：每次 `capture`（含 `audit` 的擷取階段）**開頭**自動跑一次，也可以單獨跑
  `node scripts/caveman.mjs prune`。
- 年齡看 **run id 的時間戳**（`run_YYYYMMDDThhmmssZ_xxxxxx`）不看 mtime：複製、還原或 `touch`
  不會讓過期 run「復活」；名字不合格式的目錄一律不動。到期的 run 整個目錄刪掉，不做部分保留。
- staged 截圖另外掃：`blind/<run-id>/` 對應的 run 不在本專案 `runs/` 裡就回收（含剛刪掉的）。
- `retention_days <= 0`／沒設／非數字＝**關閉 sweep**，不是「全刪」。刪之前確認 realpath 真的在
  那兩個 root 底下，symlink 跳過。

`.caveman-ui-ux/` 要進 `.gitignore`，只當 CI artifact 上傳；`retention_days` 存進
`run.json.config` 快照，稽核看得出當時的保留承諾。

## Exit codes（每碼一個具體成因）

**`1 GATE_FAIL` 只在給了 `--ci` 時才會回傳。** `score` / `audit` / `verify` 不加 `--ci` 即使 gate
fail 也一律 `exit 0`：gate 表照印、`audit.json` 裡 `gates.pass` 照樣 `false`、`gates.exit_code`
照樣 `1`，stderr 另外印 `N gate(s) failing (...); pass --ci to make this exit non-zero`。
所以任何靠 `$?` 判斷的地方（git hook、Makefile、非 GitHub runner）**一定要加 `--ci`**。

| exit | 常數 | 具體成因範例 |
|---:|---|---|
| 0 | `OK` | `score` 跑完，所有 gate `pass` 或 `skipped`；**或**有 gate fail 但沒給 `--ci` |
| 1 | `GATE_FAIL` | 有 `--ci`，且 `caveman_score` 72 < `caveman_minimum` 75；或 `critical_maximum: 0` 卻有一筆 `TECH.FORM.MISSING_LABEL`（critical） |
| 2 | `CONFIG` | `caveman.config.yaml` 的 `viewports[0].width` 寫成字串而驗不過 config schema；`--config ./nope.yaml` 不存在；install 遇到被使用者改過的 managed block |
| 3 | `TARGET` | `base_url: http://localhost:3000` 但 dev server 沒起，展開出的 target 全部 navigate 失敗 |
| 4 | `DEPENDENCY` | global npm root 裡沒有 playwright（`npm i -g playwright`）；四種 launch candidate 全失敗；axe cache 沒有 4.10.2 又給了 `--offline`；`--ci` 沒有 Lighthouse 又沒 `--allow-missing-technical` |
| 5 | `EVALUATOR` | evaluator 回的 JSON 少了 `dimensions.value.score`；回的 `screen_id` 是別張 screen；同一個 evaluator id 已 ingest 過 |
| 6 | `PRIVACY` | `assertNoLeakage` 在 `task_framing` 裡抓到 base_url host；`privacy.upload_screenshots` 還是 `false` 就跑 `caveman prepare` |

CLI 抓到 `CavemanError` 會把 `caveman-ui-ux: <message>` 印到 stderr（`--json` 另外在 stdout 印
`{ok:false, error, exit_code, details}`），然後 `process.exit(exitCode)`。

## 封存的是測量，不是判讀

`run.json` 的 config 快照分兩種角色：

- **測量**（`target`、`viewports`、`browser`、`privacy`）：**釘住不動**。事後改它等於描述一張從未拍過的截圖。
- **判讀**（`rules`、`gates`、`composite`、`report_locale`）：`score` 會改用**當下 config 檔**的版本，
  並在 stderr 印出 `re-grading run with the current config's ...`。所以要抑制一條 false positive
  或調門檻，改 config 後直接 `score --force` 即可，**不需要重跑 capture**。

憑證是第三種：快照永遠遮蔽，`evidence` / `verify` 每次從 config 檔重讀（見 `references/reporting.md` §5）。
