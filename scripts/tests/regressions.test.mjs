// Regression tests for the defects confirmed by the 2026-08-19 adversarial review.
// One test per confirmed finding, each written so it FAILS against the defect and passes
// once the fix lands. Nothing here needs a browser: the pipeline-level case fabricates a
// run directory on disk and drives `score` as a child process.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONFIG, redactConfig, restoreCredentials, unresolvedCredentials,
} from '../lib/config.mjs';
import { redactSecrets, renderHtml, renderMarkdown } from '../lib/report.mjs';
import { blindPayload, checkEvidenceBoxes, evaluatorPrompt } from '../lib/blind.mjs';
import { ruleSeverity, severityOverride } from '../lib/rules.mjs';
import { dimensionSeverity } from '../lib/scoring.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, '..', '..');
const CLI = join(SKILL_ROOT, 'scripts', 'caveman.mjs');

// Distinctive literals so an assertion failure names the exact string that escaped.
const HEADER_TOKEN = 'LEAKTOKEN-AAA111';
const HEADER_COOKIE = 'LEAKCOOKIE-BBB222';
const HEADER_APIKEY = 'LEAKAPIKEY-CCC333';
const STORAGE_STATE = './.auth/storage-state.json';
const URL_PASSWORD = 'HUNTER2SECRET';
const QUERY_TOKEN = 'SECRETTOK123';
const QUERY_APIKEY = 'AKEY456';

// --- finding 24: redactConfig masks credentials before the config is persisted ----------

/** A DEFAULT_CONFIG clone carrying every credential shape the review found leaking. */
function configWithSecrets() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.target.base_url = 'https://shop.example.com';
  config.target.extra_http_headers = {
    Authorization: `Bearer ${HEADER_TOKEN}`,
    Cookie: `session=${HEADER_COOKIE}`,
    'X-Api-Key': HEADER_APIKEY,
    'X-Preview-Mode': 'draft',
  };
  config.target.storage_state = STORAGE_STATE;
  config.integrations = {
    slack_token: 'xoxb-LEAK-DDD444',
    db_password: 'LEAKPASS-EEE555',
    client_secret: 'LEAKSECRET-FFF666',
    api_key: 'LEAKKEY-GGG777',
    harmless_note: 'keep me byte-identical',
  };
  return config;
}

test('redactConfig masks credential headers, storage_state and secret-looking keys', () => {
  const original = configWithSecrets();
  const snapshot = JSON.stringify(original);
  const safe = redactConfig(original);

  assert.equal(JSON.stringify(original), snapshot, 'redactConfig must not mutate the live config');

  const headers = safe.target.extra_http_headers;
  assert.notEqual(headers.Authorization, `Bearer ${HEADER_TOKEN}`, 'Authorization header must be masked');
  assert.notEqual(headers.Cookie, `session=${HEADER_COOKIE}`, 'Cookie header must be masked');
  assert.notEqual(headers['X-Api-Key'], HEADER_APIKEY, 'X-Api-Key header must be masked');
  assert.equal(headers['X-Preview-Mode'], 'draft', 'a non-credential header must survive untouched');

  assert.notEqual(safe.target.storage_state, STORAGE_STATE, 'storage_state path must be masked');

  assert.notEqual(safe.integrations.slack_token, original.integrations.slack_token, '*token* key must be masked');
  assert.notEqual(safe.integrations.db_password, original.integrations.db_password, '*password* key must be masked');
  assert.notEqual(safe.integrations.client_secret, original.integrations.client_secret, '*secret* key must be masked');
  assert.notEqual(safe.integrations.api_key, original.integrations.api_key, '*api_key* key must be masked');
  assert.equal(safe.integrations.harmless_note, 'keep me byte-identical');

  // No secret value survives anywhere in the persisted snapshot, at any depth.
  const serialized = JSON.stringify(safe);
  for (const secret of [
    HEADER_TOKEN, HEADER_COOKIE, HEADER_APIKEY, 'storage-state.json',
    'xoxb-LEAK-DDD444', 'LEAKPASS-EEE555', 'LEAKSECRET-FFF666', 'LEAKKEY-GGG777',
  ]) {
    assert.equal(serialized.includes(secret), false, `redacted config still contains ${secret}`);
  }

  // Everything else is byte-identical: put the six masked values back and deep-equal the rest.
  const restored = structuredClone(safe);
  restored.target.extra_http_headers.Authorization = original.target.extra_http_headers.Authorization;
  restored.target.extra_http_headers.Cookie = original.target.extra_http_headers.Cookie;
  restored.target.extra_http_headers['X-Api-Key'] = original.target.extra_http_headers['X-Api-Key'];
  restored.target.storage_state = original.target.storage_state;
  restored.integrations = { ...original.integrations };
  assert.deepEqual(restored, original, 'redactConfig changed a value that is not a credential');
});

// --- finding 25: redactSecrets covers URL userinfo and credential query parameters -------

const DIRTY_URL = `https://staginguser:${URL_PASSWORD}@127.0.0.1:8080/checkout`
  + `?token=${QUERY_TOKEN}&api_key=${QUERY_APIKEY}&plan=pro`;

test('redactSecrets masks URL userinfo and token/api_key query parameters', () => {
  const clean = redactSecrets(DIRTY_URL);
  assert.equal(clean.includes(URL_PASSWORD), false, `URL userinfo password survived: ${clean}`);
  assert.equal(clean.includes(QUERY_TOKEN), false, `?token= value survived: ${clean}`);
  assert.equal(clean.includes(QUERY_APIKEY), false, `&api_key= value survived: ${clean}`);
  // The non-secret parts of the URL must stay readable, otherwise the report loses its meaning.
  assert.equal(clean.includes('127.0.0.1:8080/checkout'), true, `host and path must survive: ${clean}`);
  assert.equal(clean.includes('plan=pro'), true, `a non-secret query parameter must survive: ${clean}`);
});

/** A minimal audit document whose target and finding both carry the dirty URL. */
function auditWithDirtyUrl() {
  return {
    schema_version: 1,
    tool: { name: 'caveman-ui-ux', version: '1.0.0' },
    run: {
      run_id: 'run_20260819T154201Z_a1b2c3',
      started_at: '2026-08-19T15:42:01.000Z',
      finished_at: '2026-08-19T15:44:10.000Z',
      cwd: '/workspace/demo',
      config_hash: '0123456789abcdef',
      report_locale: 'en',
      tool_versions: { node: 'v26.5.1', playwright: '1.59.1', browser: 'chrome', axe_core: '4.10.2', lighthouse: null },
      stages_completed: ['A', 'B', 'D', 'F', 'G', 'H'],
      blind_sealed_at: null,
    },
    config: { target: { base_url: DIRTY_URL, locales: ['en'] } },
    targets: [{ route: '/checkout', normalized_route: '/checkout', locale: 'en', viewport: 'mobile', url: DIRTY_URL }],
    scores: {
      caveman: null, heuristic_ux: null, accessibility: 91, technical: null,
      multilingual_consistency: null, evaluator_confidence: null, evaluator_dispersion: null, composite: null,
    },
    caveman: null,
    locale_matrix: null,
    findings: [{
      id: 'aaaaaaaaaaaaaaa1',
      rule_id: 'TECH.LINK.BROKEN',
      rule_version: '1.0.0',
      kind: 'deterministic',
      severity: 'major',
      confidence: 1,
      title: `The link to ${DIRTY_URL} answered HTTP 404`,
      detail: `Fetching ${DIRTY_URL} returned 404.`,
      target: { route: '/checkout', normalized_route: '/checkout', locale: 'en', viewport: 'mobile', screen_id: 'scr_1a2b3c4d5e6f', url: DIRTY_URL },
      evidence: [{ type: 'text', value: `href=${DIRTY_URL}` }],
      status: 'open',
    }],
    gates: { pass: true, results: [], exit_code: 0 },
    limitations: [],
    notices: [],
  };
}

test('neither report.md nor report.html prints URL userinfo or credential query parameters', () => {
  const audit = auditWithDirtyUrl();
  const dict = { 'report.subtitle': 'Blind first-impression review of {{target}}' };
  const outputs = {
    markdown: renderMarkdown(audit, dict),
    html: renderHtml(audit, dict, { css: 'body{}', inlineScreenshots: false }),
  };
  for (const [name, text] of Object.entries(outputs)) {
    assert.equal(text.includes(URL_PASSWORD), false, `${name} leaked the base_url password`);
    assert.equal(text.includes(QUERY_TOKEN), false, `${name} leaked the ?token= value`);
    assert.equal(text.includes(QUERY_APIKEY), false, `${name} leaked the &api_key= value`);
    // Proves the renderer really produced the target line rather than dropping it.
    assert.equal(text.includes('127.0.0.1:8080'), true, `${name} did not render the target host at all`);
  }
});

// --- finding 26: the maintainer note never reaches an evaluator --------------------------

test('evaluatorPrompt contains no HTML comment', () => {
  const payload = blindPayload(
    {
      screen_id: 'scr_0123456789ab',
      viewport: { id: 'mobile', width: 375, height: 812, device_scale_factor: 2 },
      locale: 'auto',
      screenshot: { path: '.caveman-ui-ux/runs/run_20260819T154201Z_a1b2c3/screens/scr_0123456789ab/screenshot.png' },
    },
    DEFAULT_CONFIG,
  );
  const prompt = evaluatorPrompt(payload, { screenshotAbsPath: join(tmpdir(), 'scr_0123456789ab.png') });
  assert.equal(prompt.includes('<!--'), false, 'the maintainer HTML comment reached the evaluator prompt');
  assert.equal(prompt.includes('-->'), false, 'an HTML comment terminator reached the evaluator prompt');
  assert.equal(prompt.includes('references/'), false, 'the prompt names internal reference files');
  assert.equal(prompt.includes('{{'), false, 'an unsubstituted placeholder reached the evaluator prompt');
  assert.equal(prompt.includes('scr_0123456789ab'), true, 'the prompt lost the screen id it is supposed to carry');
});

// --- findings 0 / 13: ruleSeverity semantics ---------------------------------------------

test('ruleSeverity honours disabled, severity_overrides and the pack default', () => {
  assert.equal(ruleSeverity('TECH.FORM.MISSING_LABEL', {}), 'critical', 'pack default');
  assert.equal(
    ruleSeverity('TECH.FORM.MISSING_LABEL', { rules: { disabled: ['TECH.FORM.MISSING_LABEL'] } }),
    null,
    'a disabled rule id must resolve to null',
  );
  assert.equal(
    ruleSeverity('TECH.FORM.MISSING_LABEL', { rules: { severity_overrides: { 'TECH.FORM.MISSING_LABEL': 'info' } } }),
    'info',
    'an overridden rule id must resolve to the override',
  );
  // disabled wins over an override for the same id: a user who did both means "off".
  assert.equal(
    ruleSeverity('TECH.FORM.MISSING_LABEL', {
      rules: { disabled: ['TECH.FORM.MISSING_LABEL'], severity_overrides: { 'TECH.FORM.MISSING_LABEL': 'info' } },
    }),
    null,
    'disabled must win over severity_overrides',
  );
  // lib/rules.mjs contract: an id that is in no pack has no pack default, so it resolves to
  // null. Callers must therefore treat null as "not a pack rule" and only drop findings whose
  // id is explicitly listed in rules.disabled — see the pipeline test below.
  assert.equal(ruleSeverity('NOT.A.RULE', {}), null, 'an unknown rule id has no pack severity');
  assert.equal(
    ruleSeverity('A11Y.AXE.COLOR_CONTRAST', { rules: { severity_overrides: { 'A11Y.AXE.COLOR_CONTRAST': 'minor' } } }),
    'minor',
    'an override applies to a dynamically named rule id too',
  );
  assert.equal(
    ruleSeverity('A11Y.AXE.COLOR_CONTRAST', { rules: { disabled: ['A11Y.AXE.COLOR_CONTRAST'] } }),
    null,
    'a dynamically named rule id can be disabled',
  );
});

// --- findings 0 / 13 at pipeline level: `score` must apply the config ---------------------

const RUN_ID = 'run_20260819T154201Z_a1b2c3';
const SCREEN_ID = 'scr_0123456789ab';

/** Findings the fabricated run pretends Stage D produced. */
function fabricatedFindings() {
  const target = {
    route: '/pricing',
    normalized_route: '/pricing',
    locale: 'auto',
    viewport: 'mobile',
    screen_id: SCREEN_ID,
    url: 'http://127.0.0.1:9/pricing',
  };
  const base = (id, ruleId, severity) => ({
    id,
    rule_id: ruleId,
    rule_version: '1.0.0',
    kind: 'deterministic',
    severity,
    confidence: 1,
    title: `${ruleId} on the pricing page`,
    detail: 'Synthetic finding for the rules-config regression test.',
    target,
    evidence: [{ type: 'text', value: 'synthetic evidence' }],
    status: 'open',
  });
  return [
    base('1111111111111111', 'TECH.FORM.MISSING_LABEL', 'critical'),
    base('2222222222222222', 'TECH.HEADING.MISSING_H1', 'major'),
    base('3333333333333333', 'TECH.NAV.NO_MAIN', 'minor'),
    base('4444444444444444', 'A11Y.AXE.COLOR_CONTRAST', 'major'),
  ];
}

/** Write a complete, schema-valid run directory that `score` can assemble without a browser. */
function fabricateRun(rules) {
  const cwd = mkdtempSync(join(tmpdir(), 'caveman-rules-'));
  const runRoot = join(cwd, '.caveman-ui-ux', 'runs', RUN_ID);
  const screen = join(runRoot, 'screens', SCREEN_ID);
  mkdirSync(screen, { recursive: true });

  const config = structuredClone(DEFAULT_CONFIG);
  config.target.base_url = 'http://127.0.0.1:9';
  config.target.routes = ['/pricing'];
  config.gates = { ...config.gates, technical_minimum: null, evaluator_confidence_minimum: null };
  config.rules = { packs: ['core'], ...rules };

  writeFileSync(join(cwd, 'caveman.config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  writeFileSync(join(runRoot, 'run.json'), `${JSON.stringify({
    run_id: RUN_ID,
    started_at: '2026-08-19T15:42:01.000Z',
    finished_at: null,
    cwd,
    config,
    config_hash: '0123456789abcdef',
    report_locale: 'en',
    tool_versions: { node: process.version, playwright: '1.59.1', browser: 'chrome (fabricated)', axe_core: '4.10.2', lighthouse: null },
    screens: [{
      screen_id: SCREEN_ID,
      route: '/pricing',
      normalized_route: '/pricing',
      url: 'http://127.0.0.1:9/pricing',
      locale: 'auto',
      viewport: { id: 'mobile', width: 375, height: 812, device_scale_factor: 2 },
      http_status: 200,
      status: 'ok',
      error: null,
      screenshot: { path: `.caveman-ui-ux/runs/${RUN_ID}/screens/${SCREEN_ID}/screenshot.png`, bytes: 1, sha256: 'a'.repeat(64) },
      redacted: [],
    }],
    stages_completed: ['A', 'B', 'D'],
    blind_sealed_at: '2026-08-19T15:43:00.000Z',
  }, null, 2)}\n`, 'utf8');
  writeFileSync(join(screen, 'checks.json'), `${JSON.stringify({ findings: fabricatedFindings() }, null, 2)}\n`, 'utf8');
  return cwd;
}

/** Run `score` in a fabricated project and return { status, stderr, audit }. */
function scoreRun(rules) {
  const cwd = fabricateRun(rules);
  const result = spawnSync(process.execPath, [CLI, 'score', '--cwd', cwd, '--no-llm', '--allow-missing-technical', '--quiet'], {
    encoding: 'utf8',
    cwd: SKILL_ROOT,
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const auditPath = join(cwd, '.caveman-ui-ux', 'runs', RUN_ID, 'audit.json');
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    audit: existsSync(auditPath) ? JSON.parse(readFileSync(auditPath, 'utf8')) : null,
  };
}

/** rule_id -> severity map of an assembled audit. */
function severityByRule(audit) {
  const map = {};
  for (const finding of audit.findings || []) map[finding.rule_id] = finding.severity;
  return map;
}

test('score honours rules.disabled and rules.severity_overrides', { timeout: 120000 }, () => {
  const baseline = scoreRun({ disabled: [], severity_overrides: {} });
  assert.equal(baseline.status, 0, `baseline score failed:\n${baseline.stderr}`);
  assert.notEqual(baseline.audit, null, 'baseline produced no audit.json');
  assert.deepEqual(severityByRule(baseline.audit), {
    'TECH.FORM.MISSING_LABEL': 'critical',
    'TECH.HEADING.MISSING_H1': 'major',
    'TECH.NAV.NO_MAIN': 'minor',
    'A11Y.AXE.COLOR_CONTRAST': 'major',
  }, 'the fabricated run did not reach audit.json unchanged');

  const tuned = scoreRun({
    disabled: ['TECH.FORM.MISSING_LABEL'],
    severity_overrides: { 'TECH.HEADING.MISSING_H1': 'info' },
  });
  assert.equal(tuned.status, 0, `tuned score failed:\n${tuned.stderr}`);
  assert.notEqual(tuned.audit, null, 'tuned run produced no audit.json');

  const severities = severityByRule(tuned.audit);
  assert.equal(
    'TECH.FORM.MISSING_LABEL' in severities,
    false,
    'rules.disabled did not remove the finding — it is still in audit.json',
  );
  assert.equal(severities['TECH.HEADING.MISSING_H1'], 'info', 'rules.severity_overrides did not change the severity');
  assert.equal(severities['TECH.NAV.NO_MAIN'], 'minor', 'an untouched rule changed severity');
  assert.equal(
    severities['A11Y.AXE.COLOR_CONTRAST'],
    'major',
    'a rule id that lives in no pack must keep its own severity, not be dropped',
  );

  // The gate must move with the findings: disabling the only critical clears critical_maximum.
  const gate = (audit) => (audit.gates.results || []).find((result) => result.gate === 'critical_maximum');
  assert.equal(gate(baseline.audit).status, 'fail', 'baseline critical_maximum should fail (1 critical)');
  assert.equal(gate(tuned.audit).status, 'pass', 'critical_maximum should pass once the critical rule is disabled');
});

// run.json stores a redacted config, but `evidence` and `verify` still have to reach an
// authenticated target. Redacting the snapshot once broke exactly that: the stage read
// `[redacted-path]` back out of run.json and died with ENOENT. Secrets therefore live only in
// the config file and are re-attached per stage.
test('restoreCredentials re-attaches what the snapshot dropped, and only that', () => {
  const live = structuredClone(DEFAULT_CONFIG);
  live.target = {
    ...live.target,
    base_url: 'http://127.0.0.1:3000',
    storage_state: './.auth/storage-state.json',
    extra_http_headers: { Authorization: `Bearer ${HEADER_TOKEN}`, 'X-Trace-Id': 'keep-me' },
  };
  const snapshot = redactConfig(live);
  assert.equal(snapshot.target.storage_state, '[redacted-path]');
  assert.equal(snapshot.target.extra_http_headers.Authorization, '[redacted]');

  const restored = restoreCredentials(snapshot, live);
  assert.equal(restored.target.storage_state, './.auth/storage-state.json');
  assert.equal(restored.target.extra_http_headers.Authorization, `Bearer ${HEADER_TOKEN}`);
  assert.equal(restored.target.extra_http_headers['X-Trace-Id'], 'keep-me', 'non-secret headers must be untouched');
  assert.deepEqual(unresolvedCredentials(restored), [], 'nothing should remain unresolved');
  assert.equal(snapshot.target.storage_state, '[redacted-path]', 'the snapshot itself must not be mutated');
});

test('a config that no longer supplies the credentials is reported, never sent as "[redacted]"', () => {
  const live = structuredClone(DEFAULT_CONFIG);
  live.target = {
    ...live.target,
    storage_state: './.auth/storage-state.json',
    extra_http_headers: { Authorization: `Bearer ${HEADER_TOKEN}` },
  };
  const snapshot = redactConfig(live);

  // The config file has since lost the credentials entirely.
  const stripped = structuredClone(DEFAULT_CONFIG);
  const restored = restoreCredentials(snapshot, stripped);
  assert.equal(restored.target.storage_state, null, 'an unavailable storage_state becomes null, not the marker');
  assert.equal(
    restored.target.extra_http_headers.Authorization,
    undefined,
    'a header we cannot resolve is dropped rather than sent as the literal "[redacted]"',
  );

  // And when the marker cannot be resolved at all, the caller must be told rather than guess.
  const stuck = structuredClone(snapshot);
  assert.deepEqual(
    unresolvedCredentials(stuck).sort(),
    ['target.extra_http_headers.Authorization', 'target.storage_state'],
    'unresolved credential fields must be enumerated for a loud failure',
  );
});

// A real dogfood run scored 29.5/100 and reported "0 problems": the pack's nine
// CAVEMAN.<DIM>.001 rules (kind: blind) were never emitted by anything, so the rubric's
// verdict never became a finding anyone could act on or gate against.
test('dimensionSeverity maps the rubric anchors onto severity bands', () => {
  assert.equal(dimensionSeverity(0), 'critical');
  assert.equal(dimensionSeverity(2), 'critical');
  assert.equal(dimensionSeverity(3), 'major');
  assert.equal(dimensionSeverity(4), 'major');
  assert.equal(dimensionSeverity(5), 'minor');
  assert.equal(dimensionSeverity(6), 'minor');
  assert.equal(dimensionSeverity(7), null, 'a score of 7 is "clear on a normal read" — not a finding');
  assert.equal(dimensionSeverity(10), null);
  assert.equal(dimensionSeverity(null), null);
  assert.equal(dimensionSeverity(undefined), null);
});

// Two real evaluators answered the same prompt in two different coordinate systems: one in
// image pixels, one mixing CSS pixels on x with image pixels on y. Both produced meaningless
// evidence boxes that nothing rejected.
const IMAGE = { width: 750, height: 1624 };
const VIEWPORT = { id: 'mobile', width: 375, height: 812, device_scale_factor: 2 };
const boxResponse = (boxes) => ({
  dimensions: Object.fromEntries(boxes.map((box, index) => [
    `dimension_${index}`,
    { score: 3, rationale: 'x', evidence: [{ type: 'screenshot_region', box }] },
  ])),
});

test('checkEvidenceBoxes accepts consistent image-pixel boxes', () => {
  const result = checkEvidenceBoxes(boxResponse([
    { x: 0, y: 0, w: 750, h: 112 }, { x: 48, y: 192, w: 654, h: 144 }, { x: 48, y: 1264, w: 654, h: 96 },
  ]), IMAGE, VIEWPORT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  assert.equal(result.warning, null);
});

test('checkEvidenceBoxes rejects a box that leaves the image', () => {
  const result = checkEvidenceBoxes(boxResponse([{ x: 0, y: 0, w: 2000, h: 3000 }]), IMAGE, VIEWPORT);
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 2, 'both axes are out of bounds');
  assert.match(result.violations.join(' '), /exceeds the image width 750/);
  assert.match(result.violations.join(' '), /exceeds the image height 1624/);
});

test('checkEvidenceBoxes warns when the two axes use different coordinate systems', () => {
  // The observed real failure: widths stay inside 375 CSS px while heights run to 1470 image px.
  const result = checkEvidenceBoxes(boxResponse([
    { x: 16, y: 100, w: 343, h: 220 }, { x: 240, y: 55, w: 160, h: 50 }, { x: 16, y: 1240, w: 343, h: 230 },
  ]), IMAGE, VIEWPORT);
  assert.equal(result.ok, true, 'the boxes do fit inside the image, so this is a warning not a rejection');
  assert.match(result.warning ?? '', /different coordinate systems/);
  assert.match(result.warning ?? '', /1470px vertically/);
});

test('severityOverride only reports an explicit config override, never the pack default', () => {
  const pack = { rules: { packs: ['core'] } };
  assert.equal(severityOverride('CAVEMAN.TRUST.001', pack), null, 'the pack default must not re-grade a producer');
  assert.equal(ruleSeverity('CAVEMAN.TRUST.001', pack), 'major', 'ruleSeverity still exposes the pack default');
  const overridden = { rules: { severity_overrides: { 'CAVEMAN.TRUST.001': 'info' } } };
  assert.equal(severityOverride('CAVEMAN.TRUST.001', overridden), 'info');
  assert.equal(severityOverride('A11Y.AXE.COLOR_CONTRAST', pack), null, 'a runtime-minted id has no override');
});
