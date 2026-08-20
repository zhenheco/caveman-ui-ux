# adapters — one canonical skill + generated thin adapters

ADR-001 的實作說明：`install` / `uninstall` 怎麼運作、managed block 怎麼寫、
conflict 對操作者代表什麼。license 邊界見 `licenses.md`。

## 1. 原則：canonical 只有一份

canonical bundle = 這個 skill 目錄本身（`SKILL.md` + `references/` + `scripts/` +
`assets/` + `rules/` + `schemas/` + `locales/` + `agents/openai.yaml`）。

adapter 只做四件事：

1. 在該 agent 的正式位置註冊或觸發。
2. 指示 agent 去讀 canonical workflow。
3. 提供該 agent 才有的 invocation metadata。
4. **不複製 rubric、不複製權重、不複製 rule pack。**

第 4 點是硬規則。thin adapter 一旦抄了 9 個 dimension、score weights 或 `rules/core.pack.yaml`
的內容，規則就開始漂移，而且沒有任何檢查能抓到 — canonical 改了，抄本不會跟著改。
thin adapter 只能寫：這個 skill 在哪個路徑、有哪些 command、什麼時候該用它。
細節一律靠指向 canonical `SKILL.md` 的路徑做 progressive disclosure。

## 2. 安裝目標表

| agent id | project target | strategy |
|---|---|---|
| `codex` | `.agents/skills/caveman-ui-ux/` | copy canonical bundle |
| `claude` | `.claude/skills/caveman-ui-ux/` | copy（只有 `--symlink` 且同 volume 才 symlink） |
| `opencode` | 有 `.agents/skills/...` 就共用，否則 `.opencode/skills/caveman-ui-ux/` | copy |
| `cursor` | `.cursor/rules/caveman-ui-ux.mdc` | generated thin rule（≤40 行） |
| `gemini` | `.gemini/extensions/caveman-ui-ux/{gemini-extension.json,GEMINI.md}` + `.gemini/commands/caveman/{audit,verify}.toml` | generated |
| `copilot` | `.github/instructions/caveman-ui-ux.instructions.md`（frontend glob 的 `applyTo` frontmatter） | generated；**永不觸碰** `.github/copilot-instructions.md` |
| `generic` | `AGENTS.md` managed block | patch between markers |

偵測依據：`.codex/` 或 `~/.codex/`、`.claude/` 或 `CLAUDE.md`、`.cursor/`、
`.gemini/` 或 `GEMINI.md`、`.github/`、`AGENTS.md`，以及 `command -v codex|claude|gemini|cursor`。
偵測只用來**建議**，`--agents csv` 明確指定永遠優先。

## 3. Project-local vs `--global`

預設 project-local：所有路徑相對於 target project cwd，manifest 寫
`.caveman-ui-ux/install-manifest.json`。`--global` 才寫 user-level 位置
（`~/.claude/skills/`、`~/.agents/skills/` 等），適合「我每個 repo 都要」的情境。

symlink 規則：macOS / Linux 上，只有 `claude` 與 `codex` 兩個 copy-strategy target
可以在**加了 `--symlink` 且來源與目標同一個 volume** 時用 symlink。
跨 volume 一律 copy（外接碟/網路碟的 symlink 會在別台機器上斷掉）。
**Windows 永遠 copy**，不嘗試 symlink。

## 4. Managed block 紀律

改動使用者既有檔案（`AGENTS.md`、instructions 檔）時只 patch marker 之間的內容，
不覆寫整個檔案：

```
<!-- caveman-ui-ux:start -->
...generated content...
<!-- caveman-ui-ux:end -->
```

Markdown 內一律用上面的 HTML comment 形式（含 `.mdc`、`.instructions.md`、`GEMINI.md`）。
TOML 檔改用 `#` 註解形式的同名 marker：`# caveman-ui-ux:start` / `# caveman-ui-ux:end`。
marker 外面的一切都是使用者的，installer 不得讀寫。
marker 缺一半、或有兩組 marker → 視為 conflict，不寫。

bundle copy 以 per-file content hash 判斷：hash 相同就跳過，不動 mtime。

## 5. 狀態機

每個 agent 在 `install-manifest.json` 的 `agents.<id>.status` 是四者之一：

| status | 何時出現 | installer 行為 |
|---|---|---|
| `installed` | 目標不存在，第一次寫入 | 建立檔案 / patch block，記入 manifest |
| `updated` | 目標存在、內容 hash 不同、managed block 未被人改過 | 覆寫 managed 內容 |
| `skipped` | 內容 hash 相同 | 不寫檔（idempotent；重跑 `install` 應該產生零 diff） |
| `conflict` | managed block 內容被使用者改過（與 manifest 記錄的 sha256 不符） | **不寫**，`EXIT.CONFIG`(2) + diff 提示 |

`conflict` 對操作者的意思是：**你在 managed block 裡改了東西，而我不知道那是刻意的還是誤觸**。
installer 選擇停下來而不是把你的修改吃掉。處理方式二選一：

1. 把你的修改搬到 marker **外面**（那裡永遠不會被動），然後重跑 `install`。
2. 確認那段修改可丟 → `install --force` 覆寫 managed block。

不要用 `--force` 當日常流程；它的存在是為了「我確定要丟掉」。

`--uninstall` 只刪 manifest 記錄的檔案與 managed block；marker 外的內容、
使用者自建的檔案、run artifacts（`.caveman-ui-ux/runs/`）都不動。
manifest 不存在 → 什麼都不刪並明說，不做「猜測式清理」。

### Thin adapter 指向哪一份 bundle

`.cursor/rules/*.mdc`、`AGENTS.md`、`.github/instructions/*.md` 是**使用者會 commit 的檔案**，
所以裡面不能出現安裝機器的絕對路徑（隊友與 CI runner 拿到就是死路徑）。解析順序：

1. `.claude/skills/caveman-ui-ux/` → 用這個相對路徑
2. `.agents/skills/caveman-ui-ux/`
3. `.opencode/skills/caveman-ui-ux/`
4. 專案內都沒有 bundle → 才退回安裝來源的絕對路徑（此時沒有別的東西可指）

因此 bundle adapter（codex / claude / opencode）一律排在 thin adapter 之前執行，
不受 `--agents` 參數順序影響。`--global` 安裝不套用 project-local 規則。

## 6. 自己開發這個 skill 的時候

Clone 下來的 repo 本身就是一份 canonical bundle，直接 `node scripts/caveman.mjs …` 就能跑，
不需要先 `install`。`install` 是給**別的 repo** 與**別的 agent** 用的：

```bash
node /path/to/caveman-ui-ux/scripts/caveman.mjs install --agents cursor,copilot   # 在目標 repo 的 cwd
```

如果你把 bundle 同步到某個 agent 的全域 skill 目錄（例如 `~/.claude/skills/` 或
`~/.agents/skills/`），那份副本就是 runtime，改動一律回到本 repo 改再同步過去，不要就地手改
—— 兩邊分岔之後沒有任何機制會告訴你。單向同步：

```bash
rsync -a --delete --exclude '.caveman-ui-ux' ./ ~/.claude/skills/caveman-ui-ux/
diff -rq --exclude '.caveman-ui-ux' ./ ~/.claude/skills/caveman-ui-ux/    # 應為 0 差異
```
