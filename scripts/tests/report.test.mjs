// Contract §19 report.test.mjs — Markdown section order, HTML escaping, secret redaction,
// offline self-containment, and locale-key degradation.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  escapeHtml, localeMatrixTable, redactSecrets, renderHtml, renderMarkdown, scoreBlock, severityChip,
} from '../lib/report.mjs';

// The exact section order from contract §16, spelled out here so the test is independent of
// any constant the renderer exports.
const SECTION_KEYS = [
  'report.section.executive_summary',
  'report.section.gate',
  'report.section.scores',
  'report.section.findings',
  'report.section.locale_matrix',
  'report.section.methodology',
  'report.section.limitations',
  'report.section.notices',
];

const XSS = '<script>alert(1)</script>';
const SECRET_LINE = 'Authorization: Bearer sk-live-abc123';
const TOKEN = 'sk-live-abc123';
const TARGET_URL = 'https://shop.example.com/pricing';

const FULL_DICT = {
  'report.title': 'Caveman UI/UX Audit',
  'report.subtitle': 'Blind first-impression review of {{target}}',
  'report.run_id': 'Run ID',
  'report.generated_at': 'Generated at',
  'report.target': 'Target',
  'report.tool_versions': 'Tool versions',
  'report.section.executive_summary': 'Executive summary',
  'report.section.gate': 'Quality gate',
  'report.section.scores': 'Component scores',
  'report.section.findings': 'Findings',
  'report.section.locale_matrix': 'Locale matrix',
  'report.section.methodology': 'Methodology',
  'report.section.limitations': 'Limitations',
  'report.section.notices': 'Notices',
  'report.gate.pass': 'PASS',
  'report.gate.fail': 'FAIL',
  'report.gate.skipped': 'SKIPPED',
  'report.gate.column.gate': 'Gate',
  'report.gate.column.actual': 'Actual',
  'report.gate.column.threshold': 'Threshold',
  'report.gate.column.status': 'Status',
  'score.caveman': 'Caveman score',
  'score.heuristic_ux': 'Heuristic UX score',
  'score.accessibility': 'Accessibility score',
  'score.technical': 'Technical score',
  'score.multilingual_consistency': 'Multilingual consistency',
  'score.evaluator_confidence': 'Evaluator confidence',
  'score.evaluator_dispersion': 'Evaluator dispersion',
  'score.composite': 'Composite score',
  'score.unavailable': 'Not available',
  'dimension.identity': 'Identity',
  'dimension.audience': 'Audience',
  'dimension.value': 'Value',
  'dimension.primary_action': 'Primary action',
  'dimension.visual_hierarchy': 'Visual hierarchy',
  'dimension.cognitive_simplicity': 'Cognitive simplicity',
  'dimension.trust': 'Trust',
  'dimension.navigation': 'Navigation',
  'dimension.language_clarity': 'Language clarity',
  'severity.blocker': 'Blocker',
  'severity.critical': 'Critical',
  'severity.major': 'Major',
  'severity.minor': 'Minor',
  'severity.info': 'Info',
  'confidence.high': 'High',
  'confidence.medium': 'Medium',
  'confidence.low': 'Low',
  'finding.evidence': 'Evidence',
  'finding.fix_brief': 'Fix brief',
  'finding.rule': 'Rule',
  'finding.target': 'Target',
  'finding.confidence': 'Confidence',
  'finding.status': 'Status',
  'finding.none': 'No findings',
  'finding.count': '{{count}} findings',
  'status.open': 'Open',
  'status.resolved': 'Resolved',
  'status.improved': 'Improved',
  'status.unchanged': 'Unchanged',
  'status.regressed': 'Regressed',
  'status.not_comparable': 'Not comparable',
  'blind.answers': 'First-impression answers',
  'blind.what_is_this': 'What is this?',
  'blind.who_is_it_for': 'Who is it for?',
  'blind.what_can_i_get_or_do': 'What can I get or do?',
  'blind.what_should_i_do_next': 'What should I do next?',
  'blind.why_should_i_trust_it': 'Why should I trust it?',
  'blind.uncertainties': 'Uncertainties',
  'matrix.route': 'Route',
  'matrix.locale': 'Locale',
  'matrix.cta': 'CTA',
  'matrix.residual': 'Residual language',
  'matrix.overflow': 'Overflow',
  'matrix.hreflang': 'hreflang',
  'methodology.body': 'Deterministic evidence and probabilistic judgement stay separate.',
  'limitations.body': 'Not a WCAG compliance certification and not a substitute for user research.',
};

/** A copy of FULL_DICT with some keys deleted, to exercise missing-key degradation. */
function dictWithout(...keys) {
  const dict = { ...FULL_DICT };
  for (const key of keys) delete dict[key];
  return dict;
}

/** One synthetic finding. */
function finding(id, ruleId, severity, extra = {}) {
  return {
    id,
    rule_id: ruleId,
    rule_version: '1.0.0',
    kind: 'deterministic',
    severity,
    confidence: 1,
    title: `${severity} finding on the pricing page`,
    detail: `Why ${severity} matters here.`,
    target: {
      route: '/pricing',
      normalized_route: '/pricing',
      locale: 'zh-TW',
      viewport: 'mobile',
      screen_id: 'scr_1a2b3c4d5e6f',
      url: TARGET_URL,
    },
    evidence: [{ type: 'text', value: 'Visible copy from the audited page' }],
    status: 'open',
    ...extra,
  };
}

/** The synthetic audit document under test. */
function buildAudit() {
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
      tool_versions: {
        node: 'v26.5.1',
        playwright: '1.59.1',
        browser: 'chrome 151.0.7922.138 (channel:chrome)',
        axe_core: '4.10.2',
        lighthouse: null,
      },
      stages_completed: ['A', 'B', 'D', 'F', 'G', 'H'],
      blind_sealed_at: '2026-08-19T15:43:00.000Z',
    },
    config: { target: { base_url: TARGET_URL, locales: ['zh-TW', 'ja', 'vi'] } },
    targets: [{ route: '/pricing', normalized_route: '/pricing', locale: 'zh-TW', viewport: 'mobile', url: TARGET_URL }],
    scores: {
      caveman: 72.5,
      heuristic_ux: 84,
      accessibility: 91,
      technical: null,
      multilingual_consistency: null,
      evaluator_confidence: 0.72,
      evaluator_dispersion: 0.16,
      composite: null,
    },
    caveman: {
      evaluators: [],
      consensus: {
        dimensions: {
          identity: { score: 7, mad: 0, dispersion: 0, scores: [7] },
          audience: { score: 6, mad: 0, dispersion: 0, scores: [6] },
          value: { score: 8, mad: 0, dispersion: 0, scores: [8] },
          primary_action: { score: 5, mad: 0, dispersion: 0, scores: [5] },
          visual_hierarchy: { score: 7, mad: 0, dispersion: 0, scores: [7] },
          cognitive_simplicity: { score: 8, mad: 0, dispersion: 0, scores: [8] },
          trust: { score: 6, mad: 0, dispersion: 0, scores: [6] },
          navigation: { score: 9, mad: 0, dispersion: 0, scores: [9] },
          language_clarity: { score: 8, mad: 0, dispersion: 0, scores: [8] },
        },
        score: 72.5,
      },
      answers: [{
        screen_id: 'scr_1a2b3c4d5e6f',
        evaluator_id: 'ev_1',
        answers: {
          what_is_this: 'Some kind of pricing page',
          who_is_it_for: 'Unclear',
          what_can_i_get_or_do: 'Maybe start a trial',
          what_should_i_do_next: 'Not obvious',
          why_should_i_trust_it: 'No proof shown',
          uncertainties: ['Which plan is recommended'],
        },
      }],
      contradictions: [{ dimension: 'primary_action', spread: 4, scores: [3, 7] }],
    },
    locale_matrix: {
      locales: ['zh-TW', 'ja', 'vi'],
      rows: [{
        normalized_route: '/pricing',
        route: '/pricing',
        by_locale: {
          'zh-TW': { screen_id: 'scr_1a2b3c4d5e6f', lang: 'zh-TW', hreflang_ok: true, cta_count: 2, primary_cta_text: '立即開始', residual_ratio: 0.02, overflow: false, chars: 820, longest_word: 6 },
          ja: { screen_id: 'scr_2b3c4d5e6f70', lang: 'ja', hreflang_ok: true, cta_count: 2, primary_cta_text: '今すぐ開始', residual_ratio: 0.05, overflow: true, chars: 1180, longest_word: 9 },
          vi: { screen_id: null, lang: null, hreflang_ok: false, cta_count: null, primary_cta_text: null, residual_ratio: null, overflow: null, chars: null, longest_word: null },
        },
      }],
      score: null,
    },
    findings: [
      finding('aaaaaaaaaaaaaaa1', 'TECH.TARGET.UNREACHABLE', 'blocker'),
      // The nasty one: page-derived script tag in detail, credential in the DOM evidence.
      finding('aaaaaaaaaaaaaaa2', 'TECH.FORM.MISSING_LABEL', 'critical', {
        detail: `The form injects ${XSS} into the label slot.`,
        title: `Unlabelled field renders ${XSS}`,
        evidence: [
          { type: 'dom', selector: '#email', node_path: 'form > input', html: `<input id="email" data-debug="${SECRET_LINE}">` },
          { type: 'screenshot_region', screen_id: 'scr_1a2b3c4d5e6f', path: 'screens/scr_1a2b3c4d5e6f/screenshot.png', box: { x: 10, y: 20, w: 300, h: 80 }, note: 'field without a label' },
        ],
        fix_brief: {
          intent: 'Every control has a programmatic label',
          acceptance: ['axe reports no label violations', 'Screen reader announces the field name'],
          suggested_change: 'Add <label for="email">',
          rule_ids: ['TECH.FORM.MISSING_LABEL'],
          target: { route: '/pricing', locale: 'zh-TW' },
        },
      }),
      finding('aaaaaaaaaaaaaaa3', 'TECH.IMG.MISSING_ALT', 'major'),
      finding('aaaaaaaaaaaaaaa4', 'TECH.TAP_TARGET.SMALL', 'minor', { status: 'improved' }),
      finding('aaaaaaaaaaaaaaa5', 'TECH.NAV.NO_MAIN', 'info', { status: 'resolved' }),
    ],
    gates: {
      pass: false,
      results: [
        { gate: 'accessibility_minimum', actual: 91, threshold: 90, comparator: '>=', status: 'pass' },
        { gate: 'caveman_minimum', actual: 72.5, threshold: 75, comparator: '>=', status: 'fail' },
        { gate: 'technical_minimum', actual: null, threshold: 85, comparator: '>=', status: 'skipped', note: 'lighthouse unavailable' },
      ],
      exit_code: 1,
    },
    limitations: ['lighthouse unavailable: technical score not computed'],
    notices: ['Not a WCAG legal-compliance certification.'],
  };
}

/** Ordered list of level-2 Markdown headings. */
function headings(markdown) {
  return markdown.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3).trim());
}

test('renderMarkdown emits the mandatory section order', () => {
  const markdown = renderMarkdown(buildAudit(), FULL_DICT);
  assert.deepEqual(headings(markdown), SECTION_KEYS.map((key) => FULL_DICT[key]));
});

test('renderMarkdown redacts credentials that came from the page', () => {
  const markdown = renderMarkdown(buildAudit(), FULL_DICT);
  assert.ok(!markdown.includes(TOKEN), 'bearer token leaked into report.md');
  assert.ok(markdown.includes('[REDACTED]'), 'redaction marker missing');
});

test('renderMarkdown shows score.unavailable for null scores', () => {
  const audit = buildAudit();
  const markdown = renderMarkdown(audit, FULL_DICT);
  assert.ok(markdown.includes(`**${FULL_DICT['score.multilingual_consistency']}**: ${FULL_DICT['score.unavailable']}`));
  assert.ok(markdown.includes(`**${FULL_DICT['score.technical']}**: ${FULL_DICT['score.unavailable']}`));
  const block = scoreBlock(audit, FULL_DICT);
  assert.ok(block.includes(FULL_DICT['score.unavailable']));
});

test('renderMarkdown renders every gate status', () => {
  const markdown = renderMarkdown(buildAudit(), FULL_DICT);
  for (const label of ['PASS', 'FAIL', 'SKIPPED']) assert.ok(markdown.includes(label), `missing ${label}`);
});

test('localeMatrixTable covers all three locales', () => {
  const table = localeMatrixTable(buildAudit(), FULL_DICT);
  const rows = table.split('\n').filter((line) => line.startsWith('| /pricing'));
  assert.equal(rows.length, 3);
  for (const locale of ['zh-TW', 'ja', 'vi']) assert.ok(table.includes(locale), `missing ${locale}`);
});

test('missing locale keys degrade to the key itself without throwing', () => {
  const dict = dictWithout('report.section.notices', 'score.unavailable', 'severity.major');
  let markdown = '';
  assert.doesNotThrow(() => { markdown = renderMarkdown(buildAudit(), dict); });
  assert.ok(headings(markdown).includes('report.section.notices'));
  assert.ok(markdown.includes('score.unavailable'));
  assert.doesNotThrow(() => renderHtml(buildAudit(), dict, { css: '' }));
  assert.doesNotThrow(() => renderHtml(buildAudit(), {}, { css: '' }));
});

test('renderHtml escapes page-derived markup', () => {
  const html = renderHtml(buildAudit(), FULL_DICT, { css: 'body{color:red}' });
  assert.ok(!html.includes(XSS), 'raw <script>alert(1)</script> survived into the HTML');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'escaped form missing');
  // Only our own inline filter script may appear.
  assert.equal((html.match(/<script/g) || []).length, 1);
});

test('renderHtml redacts credentials that came from the page', () => {
  const html = renderHtml(buildAudit(), FULL_DICT, { css: '' });
  assert.ok(!html.includes(TOKEN), 'bearer token leaked into report.html');
  assert.ok(html.includes('[REDACTED]'));
});

test('renderHtml makes no external request', () => {
  const html = renderHtml(buildAudit(), FULL_DICT, { css: 'body{color:red}', inlineScreenshots: true });
  assert.ok(!/<link\b/i.test(html), 'a <link> element would fetch a remote stylesheet');
  assert.ok(!/<script[^>]+\bsrc\s*=/i.test(html), 'a script src would fetch remote code');
  assert.ok(!/(?:\bsrc|\bhref)\s*=\s*["']?https?:/i.test(html), 'remote src/href found');
  assert.ok(!/@import/i.test(html));
  // The audited URL is allowed, but only as escaped text.
  assert.ok(html.includes(TARGET_URL));
  assert.ok(html.includes('<style>'), 'CSS must be inlined');
});

test('renderHtml carries filter hooks for severity and status', () => {
  const html = renderHtml(buildAudit(), FULL_DICT, { css: '' });
  for (const severity of ['blocker', 'critical', 'major', 'minor', 'info']) {
    assert.ok(html.includes(`data-severity="${severity}"`), `missing ${severity} finding`);
  }
  assert.ok(html.includes('id="cv-sev"'));
  assert.ok(html.includes('class="cv-status"'));
  assert.ok(html.includes('setAttribute(\'hidden\', \'\')'));
});

test('escapeHtml and redactSecrets are total functions', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(redactSecrets(undefined), '');
  assert.ok(!redactSecrets('Cookie: session=deadbeef').includes('deadbeef'));
  assert.ok(!redactSecrets('x-api-key: 9f8e7d6c5b4a').includes('9f8e7d6c5b4a'));
  assert.ok(!redactSecrets('{"token":"ghp_0123456789abcdefghij"}').includes('ghp_0123456789abcdefghij'));
  assert.equal(redactSecrets('plain visible copy'), 'plain visible copy');
});

test('redactSecrets masks URL credentials and query-parameter tokens', () => {
  // base_url is where a staging basic-auth password enters the run, and report.md/report.html
  // are the artifacts meant to be pasted into a PR.
  assert.equal(
    redactSecrets('http://staginguser:HUNTER2SECRET@127.0.0.1:5173/'),
    'http://[REDACTED]@127.0.0.1:5173/',
  );
  assert.equal(
    redactSecrets('postgres://user:secretpw@db.internal:5432/app'),
    'postgres://[REDACTED]@db.internal:5432/app',
  );
  assert.ok(!redactSecrets('https://x.example.com/a?token=abc123def456&page=2').includes('abc123def456'));
  assert.ok(!redactSecrets('https://x.example.com/a?page=2&api_key=k9f8e7d6c5b4a').includes('k9f8e7d6c5b4a'));
  // Not credentials: an email in body copy and an @ inside a path must survive untouched.
  assert.equal(redactSecrets('write to sales@example.com'), 'write to sales@example.com');
  assert.equal(redactSecrets('https://example.com/users/@handle'), 'https://example.com/users/@handle');
});

test('severityChip falls back to info for an unknown severity', () => {
  assert.ok(severityChip('critical', FULL_DICT).includes('chip-critical'));
  assert.ok(severityChip('nonsense', FULL_DICT).includes('chip-info'));
});
