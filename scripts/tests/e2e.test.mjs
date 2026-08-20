// End-to-end pipeline test (contract §19): serve the golden fixtures over node:http
// and drive scripts/caveman.mjs as a CHILD PROCESS so real exit codes are exercised.
// Skips loudly — never silently, never as a failure — when no browser can launch.
//
// The fixture server runs in its own process on purpose: spawnSync blocks this
// process's event loop, so an in-process node:http server could never answer the CLI.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateSubset } from '../lib/validate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, '..', '..');
const CLI = join(SKILL_ROOT, 'scripts', 'caveman.mjs');
const FIXTURES = join(HERE, 'fixtures');
const AUDIT_SCHEMA = JSON.parse(readFileSync(join(SKILL_ROOT, 'schemas', 'audit.schema.json'), 'utf8'));
const EN = JSON.parse(readFileSync(join(SKILL_ROOT, 'locales', 'en.json'), 'utf8'));

// The mandated Markdown section order (contract §16), read from the locale master so
// the assertion survives a wording change but not a reordering.
const MANDATED_SECTIONS = [
  'executive_summary', 'gate', 'scores', 'findings',
  'locale_matrix', 'methodology', 'limitations', 'notices',
].map((key) => EN[`report.section.${key}`]);

// node:http static server, run as its own process. It writes the chosen port to
// argv[3] and exits when its stdin closes, i.e. when this test process goes away.
const SERVER_SOURCE = `import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const root = resolve(process.argv[2]);
const portFile = process.argv[3];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  } catch {
    response.statusCode = 400;
    response.end('bad request');
    return;
  }
  const file = resolve(join(root, pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + sep) || !existsSync(file)) {
    response.statusCode = 404;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html lang="en"><head><title>404</title></head><body><main>not found</main></body></html>');
    return;
  }
  response.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
  response.end(readFileSync(file));
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(portFile, String(server.address().port), 'utf8');
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.stdin.resume();
`;

/** Block this process for `ms` without touching the event loop. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A fresh, isolated project directory for one CLI invocation chain. */
function tempCwd(label) {
  return mkdtempSync(join(tmpdir(), `caveman-e2e-${label}-`));
}

/** Start the fixture server in its own process and return { child, port, origin }. */
function startFixtureServer() {
  const dir = tempCwd('server');
  const scriptPath = join(dir, 'fixture-server.mjs');
  const portFile = join(dir, 'port');
  writeFileSync(scriptPath, SERVER_SOURCE, 'utf8');
  const child = spawn(process.execPath, [scriptPath, FIXTURES, portFile], {
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  const deadline = Date.now() + 20000;
  let port = 0;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const value = Number(readFileSync(portFile, 'utf8').trim());
      if (Number.isInteger(value) && value > 0) {
        port = value;
        break;
      }
    }
    sleepSync(50);
  }
  if (port === 0) {
    child.kill('SIGKILL');
    throw new Error(`fixture server did not report a port within 20s (script: ${scriptPath})`);
  }
  return { child, port, origin: `http://127.0.0.1:${port}` };
}

/** Run the CLI as a child process and return { status, stdout, stderr, json }. */
function runCli(args, { cwd, timeout = 600000, env = {} } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: cwd || SKILL_ROOT,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CAVEMAN_RUNTIME_HOST: 'claude', ...env },
  });
  let json = null;
  if (args.includes('--json') && result.stdout) {
    try {
      json = JSON.parse(result.stdout);
    } catch {
      json = null;
    }
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    json,
    error: result.error ?? null,
  };
}

/** Path inside the newest run directory of a temp project cwd. */
function runPath(cwd, ...parts) {
  const runsDir = join(cwd, '.caveman-ui-ux', 'runs');
  const ids = existsSync(runsDir) ? readdirSync(runsDir).filter((name) => name.startsWith('run_')).sort() : [];
  assert.equal(ids.length >= 1, true, `expected at least one run directory in ${runsDir}`);
  return join(runsDir, ids[ids.length - 1], ...parts);
}

/** Deterministic finding ids of one audit document. */
function deterministicIds(audit) {
  return new Set(
    (audit.findings || [])
      .filter((finding) => finding.kind === 'deterministic')
      .map((finding) => finding.id),
  );
}

// --- preflight: fixture server + doctor --------------------------------------

const fixture = startFixtureServer();

const doctor = runCli(['doctor', '--json'], { cwd: tempCwd('doctor'), timeout: 300000 });
const doctorJson = (() => {
  try {
    return JSON.parse(doctor.stdout);
  } catch {
    return null;
  }
})();
const checkStatus = (name) => (doctorJson?.checks || []).find((check) => check.name === name)?.status ?? 'missing';
const browserReady = checkStatus('playwright') === 'ok' && checkStatus('browser') === 'ok';
const skipReason = browserReady
  ? false
  : `no browser could be launched (doctor: playwright=${checkStatus('playwright')}, browser=${checkStatus('browser')})`;

if (!browserReady) {
  process.stderr.write([
    '',
    '='.repeat(78),
    'e2e.test.mjs SKIPPED — the browser-driven pipeline could not run on this machine.',
    `reason: ${skipReason}`,
    'fix: npm i -g playwright, install Google Chrome or set CAVEMAN_CHROME_PATH, then run',
    '     `node scripts/caveman.mjs doctor` until playwright and browser both report ok.',
    'The pipeline assertions below are SKIPPED, not passing.',
    '='.repeat(78),
    '',
  ].join('\n'));
}

after(() => {
  fixture.child.kill('SIGKILL');
});

// --- always-on: doctor is machine-independent -------------------------------

test('doctor --json prints exactly one parseable JSON object', () => {
  assert.notEqual(doctorJson, null, `doctor stdout was not parseable JSON:\n${doctor.stdout}\n${doctor.stderr}`);
  assert.equal(typeof doctorJson.ok, 'boolean');
  assert.equal(doctorJson.command, 'doctor');
  assert.equal(Array.isArray(doctorJson.checks), true);
  for (const name of ['node', 'playwright', 'browser', 'axe-core', 'lighthouse', 'config', 'schemas', 'locales', 'rules', 'writable']) {
    assert.notEqual(checkStatus(name), 'missing', `doctor is missing the ${name} check`);
  }
  // Exactly one JSON object on stdout: no progress line leaked out of stderr.
  assert.equal(doctor.stdout.trim().split('\n').length, 1);
});

// privacy.retention_days used to be a declaration nobody executed. `prune` needs no browser,
// so it is asserted unconditionally rather than behind the skip gate.
test('prune deletes an aged run directory and leaves a fresh one', () => {
  const cwd = tempCwd('prune');
  // The state dir is shared across projects and holds the staged blind screenshots the sweep
  // also reclaims; point it at a scratch dir so this test cannot touch the real one.
  const stateHome = tempCwd('prune-state');

  const stamp = (date) => `${date.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
  const agedId = `run_${stamp(new Date(Date.now() - 90 * 86400000))}_aaaaaa`;
  const freshId = `run_${stamp(new Date())}_bbbbbb`;
  const runsRoot = join(cwd, '.caveman-ui-ux', 'runs');
  for (const id of [agedId, freshId]) {
    mkdirSync(join(runsRoot, id, 'screens'), { recursive: true });
    writeFileSync(join(runsRoot, id, 'run.json'), `{"run_id":"${id}"}\n`, 'utf8');
  }
  writeFileSync(
    join(cwd, 'caveman.config.json'),
    `${JSON.stringify({ version: 1, privacy: { retention_days: 30 } }, null, 2)}\n`,
    'utf8',
  );

  const result = runCli(['prune', '--cwd', cwd, '--json'], { cwd, env: { CAVEMAN_STATE_DIR: stateHome } });
  assert.equal(result.status, 0, `prune failed (${result.status}):\n${result.stderr}`);
  assert.notEqual(result.json, null, `prune --json was not one JSON object:\n${result.stdout}`);
  assert.deepEqual(result.json.removedRuns, [agedId], 'prune must remove exactly the aged run');
  assert.equal(existsSync(join(runsRoot, agedId)), false, `${agedId} survived the sweep`);
  assert.equal(existsSync(join(runsRoot, freshId)), true, `${freshId} must not be pruned`);
});

// --- the pipeline ------------------------------------------------------------

describe('caveman-ui-ux end-to-end pipeline', { skip: skipReason, concurrency: 1 }, () => {
  const ROUTES = ['/form-missing-labels.html', '/mobile-overflow.html', '/low-contrast.html'];
  const auditArgs = [
    'audit', `${fixture.origin}/`,
    '--routes', ROUTES.join(','),
    '--viewports', 'mobile,desktop',
    '--no-llm', '--no-lighthouse', '--json',
  ];

  const main = { cwd: tempCwd('main'), audit: null, result: null };

  test('audit --no-llm over 3 fixtures x 2 viewports writes a schema-valid audit.json', { timeout: 900000 }, () => {
    main.result = runCli(auditArgs, { cwd: main.cwd });
    assert.equal(main.result.status, 0, `audit failed (${main.result.status}):\n${main.result.stderr}`);
    assert.notEqual(main.result.json, null, `--json stdout was not one JSON object:\n${main.result.stdout}`);
    assert.equal(main.result.json.ok, true);
    assert.equal(main.result.stdout.trim().split('\n').length, 1, 'progress must go to stderr, not stdout');

    const auditPath = runPath(main.cwd, 'audit.json');
    assert.equal(existsSync(auditPath), true, `audit.json missing at ${auditPath}`);
    main.audit = JSON.parse(readFileSync(auditPath, 'utf8'));

    const validation = validateSubset(AUDIT_SCHEMA, main.audit);
    assert.equal(
      validation.valid,
      true,
      `audit.json does not validate:\n${validation.errors.map((error) => `${error.path}: ${error.message}`).join('\n')}`,
    );
    assert.equal(main.audit.run.screens.length, ROUTES.length * 2, 'expected 3 routes x 2 viewports');
    assert.equal(main.audit.scores.caveman, null, '--no-llm must leave the caveman score null');
    assert.equal(main.audit.scores.heuristic_ux, null, '--no-llm must leave the heuristic score null');
    assert.equal(
      main.audit.limitations.some((line) => line.includes('--no-llm')),
      true,
      '--no-llm must be recorded in limitations',
    );
  });

  /** Findings of one rule on one fixture route, optionally filtered by viewport. */
  const findingsFor = (routeFragment, rulePredicate, viewport = null) => (main.audit?.findings || []).filter(
    (finding) => String(finding.target?.normalized_route || '').includes(routeFragment)
      && rulePredicate(finding.rule_id)
      && (viewport === null || finding.target?.viewport === viewport),
  );

  test('form-missing-labels.html yields TECH.FORM.MISSING_LABEL', () => {
    const hits = findingsFor('form-missing-labels', (id) => id === 'TECH.FORM.MISSING_LABEL');
    assert.equal(hits.length > 0, true, 'expected at least one TECH.FORM.MISSING_LABEL finding');
    assert.equal(hits[0].kind, 'deterministic');
    assert.equal(hits[0].evidence.length > 0, true, 'a critical finding must carry evidence');
  });

  test('mobile-overflow.html yields TECH.OVERFLOW.HORIZONTAL at the mobile viewport', () => {
    const mobile = findingsFor('mobile-overflow', (id) => id === 'TECH.OVERFLOW.HORIZONTAL', 'mobile');
    assert.equal(mobile.length > 0, true, 'expected TECH.OVERFLOW.HORIZONTAL on the mobile viewport');
    assert.equal(mobile[0].severity, 'major');
  });

  test('low-contrast.html yields an A11Y.AXE.COLOR_CONTRAST* finding', () => {
    const hits = findingsFor('low-contrast', (id) => id.startsWith('A11Y.AXE.COLOR_CONTRAST'));
    assert.equal(hits.length > 0, true, 'expected an axe colour-contrast finding');
    assert.equal(hits[0].confidence, 1);
  });

  test('report.md and report.html exist and the Markdown sections are in the mandated order', () => {
    const markdownPath = runPath(main.cwd, 'report.md');
    const htmlPath = runPath(main.cwd, 'report.html');
    assert.equal(existsSync(markdownPath), true, `report.md missing at ${markdownPath}`);
    assert.equal(existsSync(htmlPath), true, `report.html missing at ${htmlPath}`);

    const markdown = readFileSync(markdownPath, 'utf8');
    const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());
    assert.deepEqual(headings, MANDATED_SECTIONS, 'report.md section order is not the mandated order');

    const html = readFileSync(htmlPath, 'utf8');
    assert.equal(/<html/i.test(html), true, 'report.html must be a full document');
    assert.equal(/<link[^>]+href=["']https?:/i.test(html), false, 'report.html must not link an external stylesheet');
    assert.equal(/<script[^>]+src=["']https?:/i.test(html), false, 'report.html must not load an external script');
  });

  test('deterministic finding ids stay >=98% identical across two identical audits', { timeout: 900000 }, () => {
    const rerunCwd = tempCwd('rerun');
    const second = runCli(auditArgs, { cwd: rerunCwd });
    assert.equal(second.status, 0, `second audit failed:\n${second.stderr}`);
    const secondAudit = JSON.parse(readFileSync(runPath(rerunCwd, 'audit.json'), 'utf8'));

    const first = deterministicIds(main.audit);
    const repeat = deterministicIds(secondAudit);
    assert.equal(first.size > 0, true, 'the first audit produced no deterministic findings to compare');
    const shared = [...first].filter((id) => repeat.has(id)).length;
    const stability = shared / Math.max(first.size, repeat.size);
    assert.equal(
      stability >= 0.98,
      true,
      `finding id stability ${(stability * 100).toFixed(1)}% < 98% (${shared} shared of ${first.size}/${repeat.size})`,
    );
  });

  test('a --ci audit fails an impossible gate and passes a satisfiable one', { timeout: 900000 }, () => {
    const failCwd = tempCwd('gate-fail');
    const impossible = join(failCwd, 'impossible.config.json');
    writeFileSync(impossible, `${JSON.stringify({
      version: 1,
      target: { base_url: fixture.origin, routes: ['/form-missing-labels.html'] },
      gates: {
        accessibility_minimum: 100,
        critical_maximum: null,
        technical_minimum: null,
        caveman_minimum: null,
        evaluator_confidence_minimum: null,
      },
    }, null, 2)}\n`, 'utf8');
    const failing = runCli(
      ['audit', '--config', impossible, '--viewports', 'mobile', '--no-llm', '--no-lighthouse', '--ci', '--json'],
      { cwd: failCwd },
    );
    assert.equal(failing.status, 1, `impossible gate should exit 1 (GATE_FAIL), got ${failing.status}:\n${failing.stderr}`);
    assert.notEqual(failing.json, null, `--json output was not parseable:\n${failing.stdout}`);
    assert.equal(failing.json.gates.pass, false);
    assert.equal(
      failing.json.gates.results.some((result) => result.gate === 'accessibility_minimum' && result.status === 'fail'),
      true,
      'accessibility_minimum: 100 must be the failing gate',
    );

    const passCwd = tempCwd('gate-pass');
    const satisfiable = join(passCwd, 'satisfiable.config.json');
    writeFileSync(satisfiable, `${JSON.stringify({
      version: 1,
      target: { base_url: fixture.origin, routes: ['/mobile-overflow.html'] },
      gates: {
        accessibility_minimum: 1,
        critical_maximum: 50,
        technical_minimum: null,
        caveman_minimum: null,
        evaluator_confidence_minimum: null,
      },
    }, null, 2)}\n`, 'utf8');
    const passing = runCli(
      ['audit', '--config', satisfiable, '--viewports', 'mobile', '--no-llm', '--no-lighthouse', '--ci', '--json'],
      { cwd: passCwd },
    );
    assert.equal(passing.status, 0, `satisfiable gate should exit 0, got ${passing.status}:\n${passing.stderr}`);
    assert.equal(passing.json.gates.pass, true);
  });

  test('one unreachable route does not destroy the run', { timeout: 900000 }, () => {
    const cwd = tempCwd('partial');
    const deadRoute = '/definitely-not-here.html';
    const result = runCli([
      'audit', `${fixture.origin}/`,
      '--routes', `/clear-landing.html,${deadRoute}`,
      '--viewports', 'mobile',
      '--no-llm', '--no-lighthouse', '--json',
    ], { cwd });
    assert.equal(result.status, 0, `a partially failing matrix must still finish (got ${result.status}):\n${result.stderr}`);

    const auditPath = runPath(cwd, 'audit.json');
    assert.equal(existsSync(auditPath), true, `audit.json missing at ${auditPath}`);
    const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
    const validation = validateSubset(AUDIT_SCHEMA, audit);
    assert.equal(
      validation.valid,
      true,
      `audit.json does not validate:\n${validation.errors.map((error) => `${error.path}: ${error.message}`).join('\n')}`,
    );

    const screens = audit.run.screens;
    assert.equal(screens.length, 2, 'both targets must appear in run.screens');
    const errored = screens.find((screen) => screen.route === deadRoute);
    const healthy = screens.find((screen) => screen.route === '/clear-landing.html');
    assert.equal(errored?.status, 'error', 'the 404 route must be recorded as status:error');
    assert.equal(healthy?.status, 'ok', 'the healthy route must still be captured');

    const unreachable = (audit.findings || []).filter((finding) => finding.rule_id === 'TECH.TARGET.UNREACHABLE');
    assert.equal(unreachable.length > 0, true, 'the unreachable route must produce TECH.TARGET.UNREACHABLE');
    assert.equal(unreachable[0].target.route, deadRoute);

    // The healthy screen is still evaluated: a dead sibling must not cost its evidence.
    const healthyScreen = (audit.per_screen || []).find((entry) => entry.screen_id === healthy.screen_id);
    assert.equal(typeof healthyScreen?.scores?.accessibility, 'number', 'the healthy screen lost its accessibility score');
    assert.equal(existsSync(runPath(cwd, 'report.md')), true, 'report.md must still be written');
  });

  test('heuristic ingest rejects a rule id that is in no pack with EXIT.EVALUATOR (5)', () => {
    const screen = main.audit.run.screens.find((entry) => entry.status === 'ok');
    const target = {
      route: screen.route,
      normalized_route: screen.normalized_route,
      locale: screen.locale,
      viewport: screen.viewport.id,
      screen_id: screen.screen_id,
      url: screen.url,
    };
    /** One Stage E finding under the given rule id. */
    const heuristic = (ruleId) => ({
      findings: [{
        rule_id: ruleId,
        kind: 'heuristic',
        severity: 'major',
        confidence: 0.8,
        title: 'The primary action is ambiguous',
        target,
        evidence: [{ type: 'manual_note', value: 'two buttons compete for the same emphasis' }],
      }],
    });

    const badPath = join(main.cwd, 'heuristic-unknown.json');
    writeFileSync(badPath, `${JSON.stringify(heuristic('UX.TOTALLY.MADE_UP'), null, 2)}\n`, 'utf8');
    const rejected = runCli(['heuristic', 'ingest', '--file', badPath, '--json'], { cwd: main.cwd });
    assert.equal(rejected.status, 5, `an unknown rule id must exit 5 (EXIT.EVALUATOR), got ${rejected.status}:\n${rejected.stderr}`);
    assert.equal(
      existsSync(runPath(main.cwd, 'heuristic.json')),
      false,
      'a rejected ingest must not write heuristic.json',
    );

    // Positive control: the same payload under a real pack rule id is accepted, which proves
    // the 5 above came from the pack lookup and not from a schema error.
    const goodPath = join(main.cwd, 'heuristic-known.json');
    writeFileSync(goodPath, `${JSON.stringify(heuristic('UX.CTA.AMBIGUOUS_PRIMARY'), null, 2)}\n`, 'utf8');
    const accepted = runCli(['heuristic', 'ingest', '--file', goodPath, '--json'], { cwd: main.cwd });
    assert.equal(accepted.status, 0, `a pack rule id must be accepted:\n${accepted.stderr}`);
    assert.equal(existsSync(runPath(main.cwd, 'heuristic.json')), true, 'an accepted ingest must write heuristic.json');
  });

  test('rules.disabled clears a critical_maximum failure that the same config without it fails', { timeout: 900000 }, () => {
    /** Write one config and run `audit --ci` against the form fixture. */
    const auditWith = (label, rules) => {
      const cwd = tempCwd(label);
      const configPath = join(cwd, 'gate.config.json');
      writeFileSync(configPath, `${JSON.stringify({
        version: 1,
        target: { base_url: fixture.origin, routes: ['/form-missing-labels.html'] },
        gates: {
          critical_maximum: 0,
          accessibility_minimum: null,
          technical_minimum: null,
          caveman_minimum: null,
          evaluator_confidence_minimum: null,
        },
        ...(rules ? { rules } : {}),
      }, null, 2)}\n`, 'utf8');
      const result = runCli(
        ['audit', '--config', configPath, '--viewports', 'mobile', '--no-llm', '--no-lighthouse', '--ci', '--json'],
        { cwd },
      );
      return { cwd, result };
    };

    const failing = auditWith('gate-nodisable', null);
    assert.equal(
      failing.result.status,
      1,
      `critical_maximum: 0 must fail on form-missing-labels.html, got ${failing.result.status}:\n${failing.result.stderr}`,
    );
    const failingAudit = JSON.parse(readFileSync(runPath(failing.cwd, 'audit.json'), 'utf8'));
    const offenders = [...new Set(
      failingAudit.findings
        .filter((finding) => finding.severity === 'blocker' || finding.severity === 'critical')
        .map((finding) => finding.rule_id),
    )];
    assert.equal(offenders.length > 0, true, 'no blocker/critical finding drove the gate failure');
    assert.equal(offenders.includes('TECH.FORM.MISSING_LABEL'), true, 'expected TECH.FORM.MISSING_LABEL among the offenders');

    // Same config, same fixture, same gate — only rules.disabled differs.
    const passing = auditWith('gate-disable', { packs: ['core'], disabled: offenders, severity_overrides: {} });
    assert.equal(
      passing.result.status,
      0,
      `rules.disabled ${offenders.join(',')} must clear the gate, got ${passing.result.status}:\n${passing.result.stderr}`,
    );
    const passingAudit = JSON.parse(readFileSync(runPath(passing.cwd, 'audit.json'), 'utf8'));
    assert.equal(
      passingAudit.findings.some((finding) => offenders.includes(finding.rule_id)),
      false,
      'a disabled rule id still produced findings',
    );
    assert.equal(
      passingAudit.limitations.some((line) => line.includes('rules.disabled')),
      true,
      'suppression must be disclosed in limitations, never silent',
    );
  });

  test('the Lighthouse stage records an explicit availability verdict', { timeout: 1200000 }, () => {
    const cwd = tempCwd('lighthouse');
    const configPath = join(cwd, 'lh.config.json');
    writeFileSync(configPath, `${JSON.stringify({
      version: 1,
      target: { base_url: fixture.origin, routes: ['/clear-landing.html'] },
      evaluation: { lighthouse_runs: 1 },
      gates: { technical_minimum: null },
    }, null, 2)}\n`, 'utf8');
    // Lighthouse runs for real here (no --no-lighthouse); available:false is a valid outcome.
    const result = runCli(
      ['audit', '--config', configPath, '--viewports', 'mobile', '--no-llm', '--allow-missing-technical', '--json'],
      { cwd },
    );
    assert.equal(result.status, 0, `audit with Lighthouse failed:\n${result.stderr}`);

    const { screens } = JSON.parse(readFileSync(runPath(cwd, 'run.json'), 'utf8'));
    const lighthousePath = runPath(cwd, 'screens', screens[0].screen_id, 'lighthouse.json');
    assert.equal(existsSync(lighthousePath), true, `lighthouse.json missing at ${lighthousePath}`);
    const lighthouse = JSON.parse(readFileSync(lighthousePath, 'utf8'));
    assert.equal(typeof lighthouse.available, 'boolean');
    assert.equal(lighthouse.form_factor, 'mobile');

    const audit = JSON.parse(readFileSync(runPath(cwd, 'audit.json'), 'utf8'));
    if (lighthouse.available) {
      assert.equal(typeof audit.scores.technical, 'number');
      assert.equal(audit.run.tool_versions.lighthouse !== null, true, 'run.json must record the Lighthouse version');
    } else {
      assert.equal(audit.scores.technical, null);
      assert.equal(audit.limitations.some((line) => line.includes('Lighthouse')), true);
    }
  });
  // A real dogfood run exposed both of these: the blind rubric's verdict never became a
  // finding, and re-grading an existing run required re-capturing it.
  test('blind dimension scores become CAVEMAN.* findings with score-derived severities', { timeout: 900000 }, () => {
    const cwd = tempCwd('blind-findings');
    const configPath = join(cwd, 'caveman.config.yaml');
    writeFileSync(configPath, [
      'version: 1',
      `target: { base_url: "${fixture.origin}", routes: [/vague-slogan.html], locales: [en] }`,
      'viewports:',
      '  - { id: mobile, width: 375, height: 812, device_scale_factor: 2 }',
      'evaluation: { technical: false }',
      'privacy: { upload_screenshots: true }',
      '',
    ].join('\n'), 'utf8');

    assert.equal(runCli(['capture', '--config', configPath, '--json'], { cwd }).status, 0);
    const { screens } = JSON.parse(readFileSync(runPath(cwd, 'run.json'), 'utf8'));
    const screenId = screens[0].screen_id;

    // A synthetic but schema-valid evaluator response: image-space boxes for a 750x1624 image.
    const box = { x: 0, y: 0, w: 750, h: 200 };
    const scores = {
      identity: 1, audience: 3, value: 2, primary_action: 5, visual_hierarchy: 9,
      cognitive_simplicity: 4, trust: 1, navigation: 6, language_clarity: 8,
    };
    const response = {
      screen_id: screenId,
      answers: {
        what_is_this: 'unclear', who_is_it_for: 'unclear', what_can_i_get_or_do: 'unclear',
        what_should_i_do_next: 'unclear', why_should_i_trust_it: 'unclear', uncertainties: ['everything'],
      },
      dimensions: Object.fromEntries(Object.entries(scores).map(([key, score]) => [
        key,
        { score, rationale: `${key} scored ${score}`, evidence: [{ type: 'screenshot_region', screen_id: screenId, box }] },
      ])),
      confidence: 0.9,
    };
    const responsePath = join(cwd, 'blind.json');
    writeFileSync(responsePath, `${JSON.stringify(response, null, 2)}\n`, 'utf8');
    const ingest = runCli(
      ['caveman', 'ingest', '--config', configPath, '--screen', screenId, '--evaluator', 'e1', '--file', responsePath],
      { cwd },
    );
    assert.equal(ingest.status, 0, `ingest failed:\n${ingest.stderr}`);
    assert.equal(runCli(['evidence', '--config', configPath, '--no-lighthouse'], { cwd }).status, 0);
    assert.equal(runCli(['score', '--config', configPath], { cwd }).status, 0);

    const audit = JSON.parse(readFileSync(runPath(cwd, 'audit.json'), 'utf8'));
    const blind = audit.findings.filter((finding) => finding.kind === 'blind');
    const byRule = new Map(blind.map((finding) => [finding.rule_id, finding]));
    assert.equal(byRule.get('CAVEMAN.IDENTITY.001')?.severity, 'critical', 'score 1 must be critical');
    assert.equal(byRule.get('CAVEMAN.AUDIENCE.001')?.severity, 'major', 'score 3 must be major');
    assert.equal(byRule.get('CAVEMAN.NAVIGATION.001')?.severity, 'minor', 'score 6 must be minor');
    assert.equal(byRule.has('CAVEMAN.VISUAL_HIERARCHY.001'), false, 'score 9 must not produce a finding');
    assert.equal(byRule.has('CAVEMAN.LANGUAGE_CLARITY.001'), false, 'score 8 must not produce a finding');
    assert.equal(blind.length, 7, `expected 7 blind findings, got ${blind.map((f) => f.rule_id).join(', ')}`);
    for (const finding of blind) {
      assert.ok(finding.evidence.length > 0, `${finding.rule_id} must carry evidence`);
      assert.ok(finding.fix_brief?.acceptance?.length > 0, `${finding.rule_id} must carry a fix brief`);
    }
    const critical = audit.gates.results.find((gate) => gate.gate === 'critical_maximum');
    assert.equal(critical.status, 'fail', 'two critical blind findings must fail critical_maximum');
  });

  test('score re-grades an existing run from the current config without re-capturing', { timeout: 900000 }, () => {
    const cwd = tempCwd('re-grade');
    const strict = join(cwd, 'strict.json');
    const loose = join(cwd, 'loose.json');
    // Only critical_maximum is live, so a status change can mean nothing else.
    const base = {
      version: 1,
      target: { base_url: fixture.origin, routes: ['/form-missing-labels.html'] },
      viewports: [{ id: 'mobile', width: 375, height: 812, device_scale_factor: 2 }],
      evaluation: { technical: false },
      gates: {
        critical_maximum: 0,
        accessibility_minimum: null,
        technical_minimum: null,
        caveman_minimum: null,
        evaluator_confidence_minimum: null,
      },
    };
    writeFileSync(strict, `${JSON.stringify(base, null, 2)}\n`, 'utf8');

    const captured = runCli(
      ['audit', '--config', strict, '--no-llm', '--no-lighthouse', '--allow-missing-technical', '--ci'],
      { cwd },
    );
    assert.equal(captured.status, 1, `the unlabelled form must fail critical_maximum:\n${captured.stderr}`);
    const before = JSON.parse(readFileSync(runPath(cwd, 'audit.json'), 'utf8'));
    const beforeGate = before.gates.results.find((gate) => gate.gate === 'critical_maximum');
    assert.equal(beforeGate.status, 'fail');
    assert.ok(beforeGate.actual > 0, 'there must be critical findings to suppress');
    const capturedAt = before.run.screens[0].screenshot.sha256;

    // Suppress exactly the rules that made the gate fail, whichever producer emitted them.
    const offenders = [...new Set(before.findings
      .filter((finding) => finding.severity === 'blocker' || finding.severity === 'critical')
      .map((finding) => finding.rule_id))];
    assert.ok(offenders.length > 0, 'the failing run must name its offenders');
    writeFileSync(loose, `${JSON.stringify({ ...base, rules: { disabled: offenders } }, null, 2)}\n`, 'utf8');

    // Same run, same screenshots, only the interpretation changed — no re-capture.
    const regraded = runCli(
      ['score', '--config', loose, '--force', '--ci', '--allow-missing-technical'],
      { cwd },
    );
    assert.equal(regraded.status, 0, `re-grading with rules.disabled should pass:\n${regraded.stderr}`);
    const after = JSON.parse(readFileSync(runPath(cwd, 'audit.json'), 'utf8'));
    assert.equal(after.run.screens[0].screenshot.sha256, capturedAt, 'the screenshot must not have been retaken');
    assert.equal(after.findings.some((finding) => offenders.includes(finding.rule_id)), false);
    assert.equal(after.limitations.some((line) => line.includes('suppressed by config.rules.disabled')), true);
  });
});
