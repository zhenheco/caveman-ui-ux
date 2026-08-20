# caveman-ui-ux

A UI/UX audit skill for AI coding agents. It takes a screenshot of your interface, has a
**context-isolated evaluator** judge it as a first-time visitor against a fixed 9-dimension
rubric, adds deterministic accessibility and DOM evidence, and emits a gated `audit.json`
plus human-readable reports with real exit codes for CI.

The point is the isolation. An agent that has read your PRD, your route names and your DOM
cannot tell you whether a stranger understands your screen — it already knows the answer.
So the first-impression stage runs in a **fresh subagent that receives one screenshot and
seven metadata fields, and nothing else**: no URL, no page title, no DOM, no source, no
README, no other evaluator's answer. Isolation is enforced structurally (an allowlisted
payload, a leakage self-test, an identity-free staged screenshot path), not by asking the
model to behave.

```bash
# deterministic subset — no LLM involved, this is the CI path
node scripts/caveman.mjs audit https://example.com --no-llm --ci
```

## What you get

| Output | Purpose |
|---|---|
| `audit.json` | The only machine source of truth; validates against `schemas/audit.schema.json` |
| `report.md` | Executive summary → gate → scores → findings → locale matrix → methodology → limitations |
| `report.html` | Self-contained, offline-openable, screenshot evidence inline, severity filters |

Scores are reported **separately and never merged into one undisclosed number**: Caveman
score, Heuristic UX, Accessibility, Technical, Multilingual consistency, plus evaluator
confidence and dispersion. A composite score is available but off by default, must disclose
its weights, and never drives a gate.

## The rubric

Nine dimensions, fixed weights, 0–10 each, weighted into a 0–100 Caveman score.

| Dimension | Weight | The question a stranger is asking |
|---|---:|---|
| `identity` | 15 | What is this? |
| `audience` | 10 | Who is it for? |
| `value` | 20 | What do I get out of it? |
| `primary_action` | 15 | What is the next step? |
| `visual_hierarchy` | 10 | Does the most important thing get seen first? |
| `cognitive_simplicity` | 10 | How much reasoning does this screen demand? |
| `trust` | 10 | Is there enough reason to believe it? |
| `navigation` | 5 | Do I know how to move around or get back? |
| `language_clarity` | 5 | Is the wording direct, natural, jargon-free? |

A dimension scoring 6 or lower becomes a real finding (`CAVEMAN.<DIMENSION>.001`) carrying
the evaluator's reasoning and a screenshot region, so a bad score is something you can act
on and gate against — not just a number. All formulas are written out in
[`references/rubric.md`](references/rubric.md); none of them are hidden.

## Requirements

- **Node.js 22+** (developed and tested on 26.5). No `npm install`, no build step —
  **zero npm dependencies**.
- **Playwright** with a Chromium-family browser. Either install it in your project, or
  globally: `npm i -g playwright && npx playwright install chromium`. The skill also uses an
  installed Google Chrome (`channel: chrome`) when one is available.
- **axe-core** 4.10.2 is downloaded once at runtime into a cache directory (not vendored,
  see [NOTICE.md](NOTICE.md)). `--offline` refuses to run rather than silently skipping it.
- **Lighthouse** is optional and invoked through `npx -y lighthouse@12`. Without it the
  technical score is `null` and its gate is reported as `skipped`, never as a pass.

## Quick start

```bash
git clone https://github.com/zhenheco/caveman-ui-ux.git
cd caveman-ui-ux
node scripts/caveman.mjs doctor          # node / playwright / browser / axe / lighthouse / config / schemas / locales / rules
node scripts/caveman.mjs audit https://example.com --no-llm
```

To use it from an agent, install the bundle into the target repository:

```bash
node /path/to/caveman-ui-ux/scripts/caveman.mjs install --agents claude,codex,cursor,copilot
```

| Agent | Target | Strategy |
|---|---|---|
| Codex | `.agents/skills/caveman-ui-ux/` | copy the canonical bundle |
| Claude Code | `.claude/skills/caveman-ui-ux/` | copy (symlink only with `--symlink`, same volume) |
| OpenCode | reuses the Codex target when present | copy |
| Cursor | `.cursor/rules/caveman-ui-ux.mdc` | generated thin rule |
| Gemini CLI | `.gemini/extensions/…` + `.gemini/commands/caveman/*.toml` | generated |
| GitHub Copilot | `.github/instructions/caveman-ui-ux.instructions.md` | generated, `applyTo`-scoped |
| Generic | `AGENTS.md` managed block | patched between markers |

Installs are idempotent, never overwrite your own instructions, record an
`install-manifest.json`, detect a hand-edited managed block as a `conflict` instead of
clobbering it, and `--uninstall` removes only what the manifest recorded. Thin adapters point
at the canonical `SKILL.md`; they never copy the rubric or the rule pack, so there is one
source of truth per install ([ADR-001](docs/adr/ADR-001-agent-agnostic-canonical-skill.md)).

## The pipeline

```
Preflight → Blind capture → Blind evaluation → Deterministic evidence
→ Full-context heuristic → Multilingual matrix → Consensus → Report + gate
```

Stages A/B/D/F/H are pure scripts and run with no LLM at all — that is what `--no-llm --ci`
executes. Stages C and E need an agent: C is the blind first-impression pass (one fresh
subagent per evaluator; `--evaluators n` runs a panel and reports median, MAD, dispersion
and explicit `contradictions` rather than averaging disagreement away), and E is the
full-context heuristic pass where reading the DOM and the copy is finally allowed.

Exit codes are contractual:

| Code | Meaning |
|---:|---|
| 0 | completed, every gate passed or was skipped |
| 1 | completed, a gate failed (`--ci` only; without it the failing gates are printed and the exit stays 0) |
| 2 | invalid configuration or a managed-block conflict |
| 3 | every target was unreachable |
| 4 | a runtime dependency is missing |
| 5 | an evaluator response was unusable |
| 6 | a privacy or permission block |

## CI

```yaml
- uses: actions/setup-node@v4
  with: { node-version: '22' }
- run: npm i -g playwright && npx --yes playwright install --with-deps chromium
- run: |
    node caveman-ui-ux/scripts/caveman.mjs audit http://127.0.0.1:3000 \
      --routes /,/pricing --no-llm --ci --allow-missing-technical
```

## What is built, and what is not

This repository is the **canonical agent skill**: `SKILL.md`, the reference documents, the
JSON Schemas, the rule pack, four report locales, the adapter installer, and dependency-free
Node scripts that really execute the pipeline. 184 tests cover it, including an end-to-end
run against 12 golden fixtures in a real browser.

[`docs/SPEC-001-implementation.md`](docs/SPEC-001-implementation.md) additionally describes a
pnpm monorepo (`packages/core|cli|installer|evaluator|reporter`), a published npm binary and
a TypeScript build. **Those are not built here.** Read that document as the design intent it
is, not as a description of this tree.

## Limitations, stated plainly

- **Not a WCAG or legal accessibility assessment.** The accessibility score is a documented
  axe-core penalty model. No automated tool can verify every success criterion.
- **Not a substitute for user research.** A model simulating a first impression is a cheap
  proxy for one, not a sample of your audience.
- **No score proves a business outcome.** These numbers do not map to conversion or revenue.
- **Lighthouse fluctuates.** Three runs are taken and the median reported; single-run
  comparisons are invalid. Lighthouse's own accessibility category is recorded but not scored
  (axe-core owns accessibility).
- **Heuristic finding ids are only as stable as their evidence region.** Deterministic
  findings are fully reproducible; heuristic ids fold in a 5%-quantised region, so measured
  retention under ±2px jitter is about 72%, not the ≥98% that applies to deterministic ones.
  `verify` therefore has a `not-comparable` status instead of pretending otherwise.
- **`privacy.redact_selectors` blacks out screenshot pixels only.** The same text still
  appears in the DOM evidence and in the report.
- **`target.extra_http_headers` are sent to every origin the page loads**, third parties
  included. Prefer `target.storage_state` for authenticated targets.

## Documentation

`SKILL.md` is the entry point an agent reads. Deeper material is loaded on demand:

| File | Contents |
|---|---|
| [`references/blind-protocol.md`](references/blind-protocol.md) | Allowed/forbidden inputs, sealing rules, per-runtime dispatch, leakage self-test |
| [`references/rubric.md`](references/rubric.md) | Dimension anchors and every scoring formula |
| [`references/pipeline.md`](references/pipeline.md) | Stages A–H, artifacts, resume semantics, retention |
| [`references/deterministic-checks.md`](references/deterministic-checks.md) | The `TECH.*` rules, axe normalization, link probing |
| [`references/multilingual.md`](references/multilingual.md) | `report_locale` vs `target_locale`, the `I18N.*` matrix |
| [`references/consensus.md`](references/consensus.md) | Panel aggregation with a worked example |
| [`references/reporting.md`](references/reporting.md) | Output contracts, escaping, redaction, privacy |
| [`references/fix-verify.md`](references/fix-verify.md) | Fix briefs and the five verify statuses |
| [`references/adapters.md`](references/adapters.md) | Install targets and managed-block discipline |
| [`references/licenses.md`](references/licenses.md) | Third-party license boundaries |

Design history lives in [`docs/`](docs/): the master plan, the PRD, and ADR-001 through 003.

> `SKILL.md` and everything under `references/` are written in Traditional Chinese with
> English identifiers, keys and commands. The schemas, rule ids, locale keys and code are
> English throughout.

## Development

```bash
node --test scripts/tests/*.test.mjs      # 184 tests; the e2e suite drives a real browser
node scripts/caveman.mjs doctor           # environment check
node scripts/caveman.mjs rules check      # rule pack validity
```

The e2e suite skips itself loudly, never silently, when no browser can launch. If you keep a
copy of the bundle in an agent's global skills directory, treat this repository as the source
and sync one-way; see `references/adapters.md` §6.

## License

MIT — see [LICENSE](LICENSE). Third-party components are used at arm's length and are not
vendored into this tree; their boundaries are recorded in [NOTICE.md](NOTICE.md) and
[`references/licenses.md`](references/licenses.md).
