# Third-party notices

This is an engineering boundary document, not legal advice. Review it before you
redistribute anything from this repository. The full reasoning is in
[`docs/adr/ADR-003-third-party-license-boundaries.md`](docs/adr/ADR-003-third-party-license-boundaries.md)
and [`references/licenses.md`](references/licenses.md).

Nothing below is vendored into this tree. Every component is either downloaded at runtime
into a user cache directory or invoked as a separate process.

## axe-core — MPL-2.0

- Upstream: <https://github.com/dequelabs/axe-core>, version pinned to `4.10.2`.
- How it is used: `scripts/lib/axe.mjs` downloads `axe.min.js` from jsDelivr on first run into
  `$CAVEMAN_STATE_DIR/vendor/axe-core-4.10.2/` (default
  `~/.claude/state/caveman-ui-ux/vendor/…`) and writes a `NOTICE.txt` next to it. The file is
  injected into the page under test at audit time.
- Not redistributed here. MPL-2.0's file-level copyleft applies to anyone who modifies its
  sources; this project does not modify them.

## Lighthouse — Apache-2.0

- Upstream: <https://github.com/GoogleChrome/lighthouse>, invoked as `npx -y lighthouse@12`.
- How it is used: `scripts/lib/lighthouse.mjs` spawns it as a child process with an argv
  array (never a shell string) and parses its JSON output. Nothing is linked or vendored.
- Optional: when it is unavailable the technical score is `null` and its gate reports
  `skipped`.

## Playwright — Apache-2.0

- Upstream: <https://github.com/microsoft/playwright>, resolved from the host's own
  installation (project-local, then the global npm root). Not a dependency of this tree and
  not redistributed here.

## ux-pilot — reported MIT, not imported

- Upstream: `Sakaax/ux-pilot`.
- Status: **no code or rule content from this project is present in this repository.** The
  rule-pack format reserves `source_pack`, `source_rule_id` and `source_commit` fields so an
  importer can record provenance if rules are ever imported. Any such import must retain the
  upstream MIT text, its copyright notice and the exact commit SHA, and must set
  `redistribution_reviewed: true` before it may ship.

## web-auditor-playwright — reported LGPL-3.0, not bundled

- Upstream: `ems-project/web-auditor-playwright`.
- Status: **not present in this repository and not a dependency.** It is only ever supported
  as an optional external process the user installs themselves. Linking, forking or shipping a
  modified version would require a new ADR and a legal review.

## Rule-pack policy

Every rule pack must declare `id`, `version`, `source_url`, `source_commit`, `license`,
`attribution_file` and `redistribution_reviewed`. A pack with
`redistribution_reviewed: false` may be imported locally but must never be published.
The bundled `core` pack is MIT and originates in this repository.
