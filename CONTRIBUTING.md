# Contributing

## Ground rules that are not negotiable

1. **Zero npm dependencies.** Only `node:*` builtins, Playwright resolved from the host, an
   optional `npx lighthouse`, and the runtime-cached axe-core file. If you need a library,
   argue for it in an issue first — the install story ("clone and run") is the product.
2. **The blind stage stays blind.** Anything that could let a Stage C evaluator learn the
   route, host, page title, DOM, source or another evaluator's answer is a bug, no matter how
   convenient. `scripts/tests/blind-leakage.test.mjs` and
   `scripts/tests/blind-prompt.test.mjs` are the proof surface; run both after touching
   `scripts/lib/blind.mjs`, `assets/blind-prompt.md` or `schemas/blind.schema.json`.
3. **`assets/blind-prompt.md` and `schemas/blind.schema.json` are two halves of one
   contract.** They drifted apart once and every test stayed green while Stage C was
   completely broken, because the pipeline was only ever exercised with `--no-llm`. Change one,
   change the other, run `blind-prompt.test.mjs`.
4. **Every score formula is public.** If you add or change one, write it out in
   `references/rubric.md`. An undisclosed number is worse than no number.
5. **A finding needs evidence.** `blocker`/`critical`/`major` findings without evidence are
   dropped at scoring time and reported as a limitation. Do not work around that.
6. **Report what you did not verify.** "Changed but not run" is an acceptable statement;
   "fixed" without having executed anything is not.

## Running the suite

```bash
node --test scripts/tests/*.test.mjs        # everything, ~2 min (the e2e suite drives a browser)
node --test scripts/tests/scoring.test.mjs  # the formulas
node scripts/caveman.mjs doctor             # environment
node scripts/caveman.mjs rules check        # rule pack validity
```

The e2e suite starts a local static server over `scripts/tests/fixtures/` and drives the CLI
as a child process so exit codes are genuinely exercised. It skips itself with a loud message
— never silently — when no browser can launch.

## Adding a rule

1. Add it to `rules/core.pack.yaml` with a stable id, `version`, `kind`, `severity_default`,
   `applicability` and accepted `evidence` types. Ids never change; translations and file
   moves must not affect them.
2. Emit it from exactly one producer (`checks.mjs`, `axe.mjs`, `multilingual.mjs`, the blind
   score mapping, or an ingested heuristic finding).
3. Add the id to the assertions in `scripts/tests/rules.test.mjs` — that test hardcodes the
   expected id sets on purpose, so deriving them from the pack would prove nothing.
4. Give it a fixture in `scripts/tests/fixtures/` if it is deterministic, and assert it fires
   in `scripts/tests/e2e.test.mjs`.

Fixtures must contain **nothing about the test harness itself**. Two real blind evaluators
once named a leftover "Fixture list" nav link as their single biggest source of confusion,
which contaminated the very defect each fixture exists to isolate.

## Adding a report locale

`locales/en.json` is the key master. A new locale must have the identical key set —
`scripts/tests/locale.test.mjs` asserts it against the contract, not just against the other
files. Only UI labels are localised; finding prose comes from the evaluator in the configured
`report_locale`, and the audited page's own copy is never translated before evaluation.

## Commit and review expectations

- One concern per commit, with a message that says what broke and why the change fixes it.
- Run the full suite before opening a PR, and say in the PR what you ran and what you did not.
- If a change touches scoring, gates or the blind protocol, include the before/after numbers
  from an actual run.
