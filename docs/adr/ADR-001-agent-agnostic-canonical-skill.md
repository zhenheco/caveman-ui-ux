# ADR-001 — Agent-agnostic canonical skill architecture

- Status: Accepted for v1
- Date: 2026-08-18

## Context

不同 coding agents 已有不同 instruction / skill 入口。如果各自維護完整 UX prompt，規則、修正流程與輸出格式會逐步分歧。

## Decision

採用 **one canonical skill + generated thin adapters**。

Canonical source：

```text
skills/caveman-ui-ux/
├── SKILL.md
├── references/
├── scripts/
├── assets/
└── agents/openai.yaml
```

Adapter 只負責：

1. 在該 agent 的正式位置註冊或觸發。
2. 指示 agent 讀取 canonical workflow。
3. 提供該 agent 才有的 invocation metadata。
4. 不複製完整 rubric 或 rule pack。

## Installation targets

| Agent | Project-local target | Strategy |
|---|---|---|
| Codex | `.agents/skills/caveman-ui-ux/` | copy canonical skill |
| Claude Code | `.claude/skills/caveman-ui-ux/` | copy canonical skill or safe symlink |
| OpenCode | `.agents/skills/caveman-ui-ux/` | share Codex target when possible |
| Cursor | `.cursor/rules/caveman-ui-ux.mdc` | generated thin rule |
| Gemini CLI | extension directory or local `.gemini/commands/` | generated extension/commands |
| GitHub Copilot | `.github/instructions/caveman-ui-ux.instructions.md` | generated path-aware instructions |
| Generic | `AGENTS.md` patch block | begin/end managed markers |

## Installer behavior

- 預設 project-local；`--global` 才寫入 user-level 位置。
- Windows 預設 copy，不使用 symlink。
- 每次安裝產生 `.caveman-ui-ux/install-manifest.json`。
- 修改既有檔案時，以 managed block patch，不覆蓋整個檔案。
- 若發現使用者修改 managed block，更新前先停止並輸出 conflict。
- `uninstall` 只刪除 manifest 記錄的檔案或 managed blocks。

## Consequences

### Positive

- 規則只有一個 source of truth。
- Agent adapter 可獨立更新。
- 可使用 open Agent Skills progressive disclosure。
- 降低 token duplication。

### Negative

- 非原生 Skill agent 仍依賴 thin adapter 能正確要求讀取 reference。
- 不同 agent 的 tool names 與 sandbox 能力仍需 capability detection。
- 部分 global install 需要額外權限。

## Rejected alternatives

### Fork ux-pilot 並保留 Claude-only plugin

拒絕原因：無法滿足多 agent；核心生命週期會綁定 Claude plugin packaging。

### 每個 agent 各自維護完整 prompt

拒絕原因：規則漂移、難以驗證、維護成本倍增。

### 只使用 AGENTS.md

拒絕原因：缺乏 on-demand progressive disclosure；大型 rubric 會長期佔用 context。
