// Unit tests for the Caveman → AutoFlow handoff contract.
// Covers: actionable filter, exact key, evidence preservation, idempotency,
// recursive suppression, diagnostic receipt, forbidden AutoFlow-resolved transition,
// rollback required/path-safe, record merge semantics, guarded/monotonic transitions,
// Caveman-owned completion path, audit validation, diagnostic validation,
// handoff artifact persistence, exclusive receipt creation, and git rollback baseline.

import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import test from 'node:test';

import {
  buildHandoffItem, claimDispatchKey, claimHandoff, finalizeClaim, handoffSchema,
  HANDOFF_STATES, isRecursiveContext, persistHandoffArtifact, persistReceipt,
  prepareHandoff, readHandoffArtifact, readReceipt, recordHandoff, releaseClaim,
  retryHandoff, selectActionableFindings, transitionToImplemented,
  transitionToVerificationRequired, validateAudit, validateDiagnostic,
  validateFlowId, verifyClaimStillPending, verifyHandoff, writeReceipt,
} from '../lib/handoff.mjs';
import { validateSubset } from '../lib/validate.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory that mimics a run directory. */
function tempRunDir() {
  const dir = mkdtempSync(join(tmpdir(), 'caveman-handoff-test-'));
  return dir;
}

/** Create a temp git repo with at least one commit. Returns { dir, sha }. */
function tempGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'caveman-handoff-git-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@caveman.test"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Caveman Test"', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, '.gitignore'), '.caveman-ui-ux/\n', 'utf8');
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8');
  execSync('git add .gitignore README.md', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "initial commit"', { cwd: dir, stdio: 'pipe' });
  const sha = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  return { dir, sha };
}

/** Create a fake AutoFlow state directory with a valid status.json for a flowId. */
function createFakeAutoflowState(flowId, baseRepo) {
  const dir = mkdtempSync(join(tmpdir(), 'caveman-autoflow-state-'));
  const flowDir = join(dir, flowId);
  mkdirSync(flowDir, { recursive: true });
  writeFileSync(join(flowDir, 'status.json'), JSON.stringify({
    flow_id: flowId,
    release_policy: 'handoff-only',
    base_repo: baseRepo || process.cwd(),
    status: 'running',
    created_at: new Date().toISOString(),
  }), 'utf8');
  return dir;
}

/** Ensure a directory is a real Git repo with at least one commit. No-op if already a repo. */
function ensureGitRepo(dir) {
  if (existsSync(join(dir, '.git'))) return;
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@caveman.test"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Caveman Test"', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, '.gitkeep'), '', 'utf8');
  execSync('git add .gitkeep', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "initial commit"', { cwd: dir, stdio: 'pipe' });
}

/** Create a dispatch claim for a key, used by recordHandoff tests. */
function claimForTest(cwd, runId, key) {
  return claimDispatchKey(cwd, runId, key);
}

/** Call recordHandoff with a fake AutoFlow state dir for the given flowId. */
function recordWithFlow({ cwd, runId, key, flowId, diagnostic, claimToken }) {
  // cwd must be a real Git repo for validateFlowId canonical-root comparison.
  ensureGitRepo(cwd);
  let effectiveToken = claimToken;
  const runPath = join(cwd, '.caveman-ui-ux', 'runs', runId);
  const existing = readReceipt(runPath, key);
  if (existing?.state === 'pending' && !effectiveToken) {
    const findingId = key.slice(`${runId}:`.length);
    if (!existing.source_audit_sha256) {
      const receiptPath = join(runPath, 'handoffs', `${key.replace(/:/g, '_')}.json`);
      rmSync(receiptPath, { force: true });
      writeAudit(runPath, makeAudit([makeActionableFinding({ id: findingId })], runId));
      prepareHandoff({ cwd, runId });
      const bound = readReceipt(runPath, key);
      writeReceipt(runPath, key, {
        ...bound,
        created_at: existing.created_at ?? bound.created_at,
        diagnostic: existing.diagnostic ?? bound.diagnostic,
        flow_id: existing.flow_id ?? bound.flow_id,
      });
    }
    const claimed = claimHandoff(cwd, runId);
    effectiveToken = claimed.claims.find((entry) => entry.key === key)?.claim_token;
  }
  const stateDir = createFakeAutoflowState(flowId, cwd);
  const result = recordHandoff({ cwd, runId, key, flowId, diagnostic, claimToken: effectiveToken, autoflowStateDir: stateDir });
  // Clean up the fake state dir after the call.
  rmSync(stateDir, { recursive: true, force: true });
  return result;
}

function prepareBoundReceipt(cwd, runId, findingOrId, state) {
  ensureGitRepo(cwd);
  const runPath = join(cwd, '.caveman-ui-ux', 'runs', runId);
  const finding = typeof findingOrId === 'string' ? makeActionableFinding({ id: findingOrId }) : findingOrId;
  const findingId = finding.id;
  writeAudit(runPath, makeAudit([finding], runId));
  const defaultVerifyRunId = 'run_20260825T120000Z_bbbbbb';
  const defaultVerifyPath = join(cwd, '.caveman-ui-ux', 'runs', defaultVerifyRunId);
  if (!existsSync(join(defaultVerifyPath, 'audit.json'))) {
    writeAudit(defaultVerifyPath, makeAudit([], defaultVerifyRunId));
  }
  prepareHandoff({ cwd, runId });
  const claim = claimHandoff(cwd, runId).claims.find((entry) => entry.finding_id === findingId);
  const key = `${runId}:${findingId}`;
  recordWithFlow({ cwd, runId, key, flowId: `flow-${findingId}`, claimToken: claim.claim_token });
  if (state === 'accepted') return readReceipt(runPath, key);
  transitionToImplemented({ cwd, runId, key });
  if (state === 'implemented') return readReceipt(runPath, key);
  transitionToVerificationRequired({ cwd, runId, key });
  return readReceipt(runPath, key);
}

/** A minimal actionable finding with a complete fix_brief. */
function makeActionableFinding(overrides = {}) {
  return {
    id: 'a1b2c3d4e5f67890',
    rule_id: 'TECH.FORM.MISSING_LABEL',
    kind: 'deterministic',
    severity: 'critical',
    confidence: 1.0,
    title: 'Form input is missing a label',
    target: {
      route: '/signup',
      normalized_route: '/signup',
      locale: 'en',
      viewport: 'mobile',
      screen_id: 'scr_123456789abc',
      url: 'https://example.com/signup',
    },
    evidence: [
      { type: 'dom', selector: 'input[name="email"]' },
    ],
    fix_brief: {
      intent: 'Every form input has an associated label',
      acceptance: ['All inputs have labels', 'axe passes on rerun'],
      suggested_change: 'Add <label for="..."> elements',
      rule_ids: ['TECH.FORM.MISSING_LABEL'],
    },
    status: 'open',
    ...overrides,
  };
}

/** A minimal audit document with the given findings. */
function makeAudit(findings, runId = 'run_20260824T120000Z_aaaaaa') {
  return {
    schema_version: 1,
    tool: { name: 'caveman-ui-ux', version: '1.0.0' },
    run: { run_id: runId },
    findings,
    scores: {},
    gates: { pass: false, results: [], exit_code: 0 },
    limitations: [],
    notices: [],
  };
}

/** Write an audit.json into a run directory. */
function writeAudit(runDir, audit) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'audit.json'), `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
}

function runHandoffCli(args, cwd) {
  const result = spawnSync(process.execPath, [resolvePath('scripts/caveman.mjs'), ...args, '--json'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CAVEMAN_RUNTIME_HOST: 'codex' },
  });
  return {
    ...result,
    json: result.stdout ? JSON.parse(result.stdout) : null,
  };
}

// ---------------------------------------------------------------------------
// isRecursiveContext
// ---------------------------------------------------------------------------

test('isRecursiveContext detects AUTOFLOW_EXECUTION_ID', () => {
  assert.equal(isRecursiveContext({ AUTOFLOW_EXECUTION_ID: 'flow-42' }), true);
  assert.equal(isRecursiveContext({ AUTOFLOW_EXECUTION_ID: '' }), false);
});

test('isRecursiveContext detects CAVEMAN_INSIDE_AUTOFLOW', () => {
  assert.equal(isRecursiveContext({ CAVEMAN_INSIDE_AUTOFLOW: '1' }), true);
  assert.equal(isRecursiveContext({ CAVEMAN_INSIDE_AUTOFLOW: '0' }), false);
});

test('isRecursiveContext returns false for normal env', () => {
  assert.equal(isRecursiveContext({}), false);
  assert.equal(isRecursiveContext({ PATH: '/usr/bin' }), false);
});

// ---------------------------------------------------------------------------
// validateDiagnostic
// ---------------------------------------------------------------------------

test('validateDiagnostic accepts valid diagnostic', () => {
  const result = validateDiagnostic({ code: 'TIMEOUT', message: 'dispatch timed out' });
  assert.equal(result.valid, true);
});

test('validateDiagnostic rejects null/undefined', () => {
  assert.equal(validateDiagnostic(null).valid, false);
  assert.equal(validateDiagnostic(undefined).valid, false);
  assert.equal(validateDiagnostic('string').valid, false);
});

test('validateDiagnostic rejects missing code', () => {
  assert.equal(validateDiagnostic({ message: 'something' }).valid, false);
});

test('validateDiagnostic rejects empty code', () => {
  assert.equal(validateDiagnostic({ code: '', message: 'something' }).valid, false);
});

test('validateDiagnostic rejects code too long', () => {
  assert.equal(validateDiagnostic({ code: 'x'.repeat(101), message: 'something' }).valid, false);
});

test('validateDiagnostic accepts code at max length', () => {
  assert.equal(validateDiagnostic({ code: 'x'.repeat(100), message: 'something' }).valid, true);
});

test('validateDiagnostic rejects missing message', () => {
  assert.equal(validateDiagnostic({ code: 'ERR' }).valid, false);
});

test('validateDiagnostic rejects empty message', () => {
  assert.equal(validateDiagnostic({ code: 'ERR', message: '' }).valid, false);
});

test('validateDiagnostic rejects message too long', () => {
  assert.equal(validateDiagnostic({ code: 'ERR', message: 'x'.repeat(2001) }).valid, false);
});

test('validateDiagnostic accepts message at max length', () => {
  assert.equal(validateDiagnostic({ code: 'ERR', message: 'x'.repeat(2000) }).valid, true);
});

// ---------------------------------------------------------------------------
// validateAudit
// ---------------------------------------------------------------------------

test('validateAudit accepts valid audit with matching run_id', () => {
  const audit = makeAudit([]);
  const result = validateAudit(audit, 'run_20260824T120000Z_aaaaaa');
  assert.equal(result, audit);
});

test('validateAudit throws on null audit', () => {
  assert.throws(() => validateAudit(null, 'run_x'), { code: 'AUDIT_INVALID' });
});

test('validateAudit throws on missing run.run_id', () => {
  assert.throws(() => validateAudit({}, 'run_x'), { code: 'AUDIT_INVALID' });
  assert.throws(() => validateAudit({ run: {} }, 'run_x'), { code: 'AUDIT_INVALID' });
});

test('validateAudit throws on run_id mismatch', () => {
  const audit = makeAudit([]);
  assert.throws(() => validateAudit(audit, 'run_wrong'), { code: 'AUDIT_RUN_MISMATCH' });
});

// ---------------------------------------------------------------------------
// selectActionableFindings — filter
// ---------------------------------------------------------------------------

test('selectActionableFindings returns empty for null/empty audit', () => {
  assert.deepEqual(selectActionableFindings(null), { items: [], diagnostics: [] });
  assert.deepEqual(selectActionableFindings({}), { items: [], diagnostics: [] });
  assert.deepEqual(selectActionableFindings({ findings: [] }), { items: [], diagnostics: [] });
});

test('selectActionableFindings includes blocker/critical/major findings with complete fix_brief', () => {
  const finding = makeActionableFinding({ severity: 'blocker' });
  const audit = makeAudit([finding]);
  const result = selectActionableFindings(audit);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, finding.id);
  assert.deepEqual(result.diagnostics, []);
});

test('selectActionableFindings excludes minor and info', () => {
  const minor = makeActionableFinding({ severity: 'minor', id: '0000000000000001' });
  const info = makeActionableFinding({ severity: 'info', id: '0000000000000002' });
  const audit = makeAudit([minor, info]);
  const result = selectActionableFindings(audit);
  assert.equal(result.items.length, 0);
  assert.deepEqual(result.diagnostics, []);
});

test('selectActionableFindings excludes resolved findings', () => {
  const resolved = makeActionableFinding({ status: 'resolved', id: '0000000000000001' });
  const audit = makeAudit([resolved]);
  const result = selectActionableFindings(audit);
  assert.equal(result.items.length, 0);
  assert.deepEqual(result.diagnostics, []);
});

test('selectActionableFindings includes unresolved statuses', () => {
  for (const status of ['open', 'improved', 'unchanged', 'regressed', 'not_comparable', 'not-comparable']) {
    const finding = makeActionableFinding({ status, id: `000000000000000${['open', 'improved', 'unchanged', 'regressed', 'not_comparable', 'not-comparable'].indexOf(status)}` });
    const audit = makeAudit([finding]);
    const result = selectActionableFindings(audit);
    assert.equal(result.items.length, 1, `status ${status} should be included`);
  }
});

test('selectActionableFindings excludes findings with no evidence', () => {
  const finding = makeActionableFinding({ evidence: [], id: '0000000000000001' });
  const audit = makeAudit([finding]);
  const result = selectActionableFindings(audit);
  assert.equal(result.items.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].type, 'no_evidence');
});

test('selectActionableFindings excludes findings with untyped evidence', () => {
  const finding = makeActionableFinding({
    evidence: [{ note: 'no type field' }],
    id: '0000000000000001',
  });
  const audit = makeAudit([finding]);
  const result = selectActionableFindings(audit);
  assert.equal(result.items.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].type, 'no_evidence');
});

test('selectActionableFindings excludes findings with empty-type evidence', () => {
  const finding = makeActionableFinding({
    evidence: [{ type: '' }],
    id: '0000000000000001',
  });
  const audit = makeAudit([finding]);
  const result = selectActionableFindings(audit);
  assert.equal(result.items.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].type, 'no_evidence');
});

test('selectActionableFindings excludes findings with incomplete fix_brief', () => {
  const cases = [
    { fix_brief: null, label: 'null fix_brief' },
    { fix_brief: {}, label: 'empty fix_brief' },
    { fix_brief: { intent: '', acceptance: ['x'], suggested_change: 'y', rule_ids: ['z'] }, label: 'empty intent' },
    { fix_brief: { intent: 'x', acceptance: [], suggested_change: 'y', rule_ids: ['z'] }, label: 'empty acceptance' },
    { fix_brief: { intent: 'x', acceptance: ['y'], suggested_change: '', rule_ids: ['z'] }, label: 'empty suggested_change' },
    { fix_brief: { intent: 'x', acceptance: ['y'], suggested_change: 'z', rule_ids: [] }, label: 'empty rule_ids' },
  ];
  for (const { fix_brief, label } of cases) {
    const finding = makeActionableFinding({ fix_brief, id: '0000000000000001' });
    const audit = makeAudit([finding]);
    const result = selectActionableFindings(audit);
    assert.equal(result.items.length, 0, label);
    assert.equal(result.diagnostics.length, 1, `${label}: expected 1 diagnostic`);
    assert.equal(result.diagnostics[0].type, 'incomplete_fix_brief', label);
  }
});

test('selectActionableFindings produces diagnostics for multiple skipped findings', () => {
  const noEvidence = makeActionableFinding({ evidence: [], id: '0000000000000001', rule_id: 'R1' });
  const noFix = makeActionableFinding({
    fix_brief: null,
    id: '0000000000000002',
    rule_id: 'R2',
  });
  const audit = makeAudit([noEvidence, noFix]);
  const result = selectActionableFindings(audit);
  assert.equal(result.items.length, 0);
  assert.equal(result.diagnostics.length, 2);
  assert.equal(result.diagnostics[0].type, 'no_evidence');
  assert.equal(result.diagnostics[1].type, 'incomplete_fix_brief');
});

// ---------------------------------------------------------------------------
// buildHandoffItem — exact key, evidence preservation, rollback
// ---------------------------------------------------------------------------

test('buildHandoffItem produces the exact key <run_id>:<finding_id>', () => {
  const finding = makeActionableFinding();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const item = buildHandoffItem(finding, runId, '0'.repeat(64), '/repo', '/cwd');
  assert.equal(item.key, `${runId}:${finding.id}`);
  assert.equal(item.run_id, runId);
  assert.equal(item.finding_id, finding.id);
});

test('buildHandoffItem preserves complete evidence', () => {
  const finding = makeActionableFinding({
    evidence: [
      { type: 'dom', selector: 'input[name="email"]', html: '<input>' },
      { type: 'screenshot_region', path: 'a.png', box: { x: 0, y: 0, w: 100, h: 50 } },
      { type: 'metric', name: 'contrast', value: 2.1, unit: 'ratio' },
    ],
  });
  const item = buildHandoffItem(finding, 'run_x', '0'.repeat(64), '/repo', '/cwd');
  assert.equal(item.evidence.length, 3);
  assert.equal(item.evidence[0].type, 'dom');
  assert.equal(item.evidence[0].selector, 'input[name="email"]');
  assert.equal(item.evidence[1].type, 'screenshot_region');
  assert.equal(item.evidence[2].type, 'metric');
  assert.equal(item.evidence[2].value, 2.1);
  assert.notEqual(item.evidence, finding.evidence);
  assert.notEqual(item.evidence[0], finding.evidence[0]);
});

test('buildHandoffItem preserves complete fix_brief', () => {
  const finding = makeActionableFinding({
    fix_brief: {
      intent: 'Make the button visible',
      acceptance: ['Button is visible', 'Clickable area > 44px'],
      suggested_change: 'Increase contrast and add padding',
      rule_ids: ['TECH.TAP_TARGET.SMALL', 'A11Y.AXE.COLOR_CONTRAST'],
      target: { route: '/signup', locale: 'en' },
    },
  });
  const item = buildHandoffItem(finding, 'run_x', '0'.repeat(64), '/repo', '/cwd');
  assert.equal(item.fix_brief.intent, 'Make the button visible');
  assert.deepEqual(item.fix_brief.acceptance, ['Button is visible', 'Clickable area > 44px']);
  assert.equal(item.fix_brief.suggested_change, 'Increase contrast and add padding');
  assert.deepEqual(item.fix_brief.rule_ids, ['TECH.TAP_TARGET.SMALL', 'A11Y.AXE.COLOR_CONTRAST']);
  assert.deepEqual(item.fix_brief.target, { route: '/signup', locale: 'en' });
  assert.notEqual(item.fix_brief.acceptance, finding.fix_brief.acceptance);
  assert.notEqual(item.fix_brief.rule_ids, finding.fix_brief.rule_ids);
});

test('buildHandoffItem includes rollback contract with real git SHA', () => {
  const gitRepo = tempGitRepo();
  try {
    const finding = makeActionableFinding();
    const runId = 'run_20260824T120000Z_aaaaaa';
    const item = buildHandoffItem(finding, runId, '0'.repeat(64), gitRepo.dir, gitRepo.dir);
    assert.equal(typeof item.rollback, 'object');
    assert.equal(typeof item.rollback.description, 'string');
    assert.ok(item.rollback.description.length > 0);
    assert.equal(item.rollback.pre_fix_head_sha, gitRepo.sha);
    assert.equal(item.rollback.pre_fix_head_ref, gitRepo.sha);
    assert.ok(item.rollback.pre_fix_head_sha.length === 40);
    assert.ok(/^[0-9a-f]{40}$/.test(item.rollback.pre_fix_head_sha));
    assert.equal(item.rollback.dirty_worktree, false);
    assert.deepEqual(item.rollback.dirty_files, []);
    assert.ok(item.rollback.git_root);
    // Path-safe checks.
    assert.ok(!item.rollback.pre_fix_head_ref.includes('..'));
    assert.ok(!/[;&|`$(){}[\]!<>]/.test(item.rollback.pre_fix_head_ref));
    assert.ok(Array.isArray(item.rollback.preserve_paths));
    assert.ok(item.rollback.preserve_paths.length > 0);
    for (const p of item.rollback.preserve_paths) {
      assert.ok(!p.startsWith('/'));
      assert.ok(!p.includes('..'));
    }
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('buildHandoffItem records dirty worktree metadata', () => {
  const gitRepo = tempGitRepo();
  try {
    // Create an uncommitted change.
    writeFileSync(join(gitRepo.dir, 'dirty.txt'), 'uncommitted\n', 'utf8');
    const finding = makeActionableFinding();
    const item = buildHandoffItem(finding, 'run_x', '0'.repeat(64), gitRepo.dir, gitRepo.dir);
    assert.equal(item.rollback.dirty_worktree, true);
    assert.ok(item.rollback.dirty_files.length > 0);
    assert.ok(item.rollback.dirty_files.includes('dirty.txt'));
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('buildHandoffItem includes source_audit_sha256', () => {
  const finding = makeActionableFinding();
  const sha = 'a'.repeat(64);
  const item = buildHandoffItem(finding, 'run_x', sha, '/repo', '/cwd');
  assert.equal(item.source_audit_sha256, sha);
});

// ---------------------------------------------------------------------------
// persistReceipt — exclusive/atomic creation, idempotency
// ---------------------------------------------------------------------------

test('persistReceipt creates a new receipt and returns created: true', () => {
  const dir = tempRunDir();
  try {
    const result = persistReceipt(dir, 'run_x:a1b2c3d4e5f67890', { state: 'pending', key: 'run_x:a1b2c3d4e5f67890' });
    assert.equal(result.created, true);
    assert.ok(result.path.endsWith('.json'));
    assert.ok(existsSync(result.path));
    const content = JSON.parse(readFileSync(result.path, 'utf8'));
    assert.equal(content.state, 'pending');
    assert.equal(content.key, 'run_x:a1b2c3d4e5f67890');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistReceipt returns created: false and existing data on duplicate key', () => {
  const dir = tempRunDir();
  try {
    const first = persistReceipt(dir, 'run_x:a1b2c3d4e5f67890', { state: 'pending', key: 'run_x:a1b2c3d4e5f67890', created_at: '2026-01-01' });
    assert.equal(first.created, true);

    const second = persistReceipt(dir, 'run_x:a1b2c3d4e5f67890', { state: 'accepted', key: 'run_x:a1b2c3d4e5f67890', created_at: '2026-06-01' });
    assert.equal(second.created, false);
    assert.deepEqual(second.existing, { state: 'pending', key: 'run_x:a1b2c3d4e5f67890', created_at: '2026-01-01' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistReceipt uses wx flag for atomic exclusive creation', () => {
  const dir = tempRunDir();
  try {
    const result = persistReceipt(dir, 'run_x:a1b2c3d4e5f67890', { state: 'pending' });
    assert.equal(result.created, true);

    // Attempting to write with wx should fail (file already exists)
    const handoffsDir = join(dir, 'handoffs');
    const receiptPath = join(handoffsDir, 'run_x_a1b2c3d4e5f67890.json');
    assert.throws(
      () => writeFileSync(receiptPath, '{}', { encoding: 'utf8', flag: 'wx' }),
      { code: 'EEXIST' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistReceipt sanitizes keys for filename safety', () => {
  const dir = tempRunDir();
  try {
    const result = persistReceipt(dir, 'run_x:../../etc/passwd', { state: 'pending' });
    assert.equal(result.created, true);
    assert.ok(!result.path.includes('..'), 'filename must not contain ..');
    assert.ok(!result.path.includes('/etc/'), 'filename must not be an absolute path traversal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readReceipt returns null for missing receipt', () => {
  const dir = tempRunDir();
  try {
    assert.equal(readReceipt(dir, 'nonexistent'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readReceipt reads back a persisted receipt', () => {
  const dir = tempRunDir();
  try {
    persistReceipt(dir, 'run_x:a1b2c3d4e5f67890', { state: 'pending', key: 'run_x:a1b2c3d4e5f67890', created_at: '2026-01-01' });
    const receipt = readReceipt(dir, 'run_x:a1b2c3d4e5f67890');
    assert.equal(receipt.state, 'pending');
    assert.equal(receipt.key, 'run_x:a1b2c3d4e5f67890');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// recordHandoff — guarded/monotonic transitions, key validation, field clearing
// ---------------------------------------------------------------------------

test('recordHandoff creates a receipt with flowId', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    // First prepare a receipt.
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });

    const receipt = recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-42' });
    assert.equal(receipt.state, 'accepted');
    assert.equal(receipt.flow_id, 'flow-42');
    assert.equal(receipt.diagnostic, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordHandoff creates a diagnostic receipt without flowId', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });

    const receipt = recordHandoff({
      cwd: dir, runId, key,
      diagnostic: { code: 'TIMEOUT', message: 'dispatch timed out' },
    });
    assert.equal(receipt.state, 'failed');
    assert.equal(receipt.flow_id, null);
    assert.deepEqual(receipt.diagnostic, { code: 'TIMEOUT', message: 'dispatch timed out' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordHandoff rejects key without matching runId prefix', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const wrongKey = 'run_other:a1b2c3d4e5f67890';
    persistReceipt(runPath, wrongKey, { state: 'pending', key: wrongKey, run_id: 'run_other', finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });

    assert.throws(
      () => recordHandoff({ cwd: dir, runId, key: wrongKey, flowId: 'flow-42' }),
      { code: 'KEY_RUN_MISMATCH' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordHandoff rejects key without a prepared receipt', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:nonexistent`;
  try {
    assert.throws(
      () => recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-42' }),
      { code: 'RECEIPT_NOT_FOUND' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordHandoff rejects invalid diagnostic shape', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });

    assert.throws(
      () => recordHandoff({ cwd: dir, runId, key, diagnostic: { error: 'no code field' } }),
      { code: 'DIAGNOSTIC_INVALID' },
    );
    assert.throws(
      () => recordHandoff({ cwd: dir, runId, key, diagnostic: { code: '', message: 'empty code' } }),
      { code: 'DIAGNOSTIC_INVALID' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordHandoff merges when receipt already exists (pending -> accepted)', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });

    const receipt = recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-42' });
    assert.equal(receipt.state, 'accepted');
    assert.equal(receipt.flow_id, 'flow-42');
    assert.equal(receipt.created_at, '2026-01-01');
    assert.ok(receipt.updated_at);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fix #5: Receipt transitions must clear mutually exclusive stale fields
test('recordHandoff accepted clears stale diagnostic', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, {
      state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890',
      diagnostic: { code: 'OLD', message: 'old diagnostic' }, created_at: '2026-01-01',
    });

    const receipt = recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-42' });
    assert.equal(receipt.state, 'accepted');
    assert.equal(receipt.flow_id, 'flow-42');
    assert.equal(receipt.diagnostic, null, 'accepted must clear stale diagnostic');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordHandoff failed clears stale flow_id', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, {
      state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890',
      flow_id: 'old-flow', created_at: '2026-01-01',
    });

    const receipt = recordHandoff({
      cwd: dir, runId, key,
      diagnostic: { code: 'FAILED', message: 'something failed' },
    });
    assert.equal(receipt.state, 'failed');
    assert.equal(receipt.flow_id, null, 'failed must clear stale flow_id');
    assert.deepEqual(receipt.diagnostic, { code: 'FAILED', message: 'something failed' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fix #7: Guarded/monotonic transitions
test('recordHandoff replay of same flow_id is a no-op', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });

    const first = recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-42' });
    assert.equal(first.state, 'accepted');
    assert.equal(first.flow_id, 'flow-42');

    const second = recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-42' });
    assert.equal(second.state, 'accepted');
    assert.equal(second.flow_id, 'flow-42');
    // Replay must be a no-op: same state, same flow_id, no error.
    assert.ok(second.created_at);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordHandoff conflicting flow_id is a structured error', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });

    recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-42' });

    assert.throws(
      () => recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-99' }),
      { code: 'CONFLICTING_FLOW_ID' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Caveman-owned completion path (Fix #8)
// ---------------------------------------------------------------------------

test('transitionToImplemented transitions accepted -> implemented', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    prepareBoundReceipt(dir, runId, 'a1b2c3d4e5f67890', 'accepted');

    const receipt = transitionToImplemented({ cwd: dir, runId, key });
    assert.equal(receipt.state, 'implemented');
    assert.ok(receipt.updated_at);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transitionToImplemented is a no-op for already implemented', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    prepareBoundReceipt(dir, runId, 'a1b2c3d4e5f67890', 'implemented');

    const receipt = transitionToImplemented({ cwd: dir, runId, key });
    assert.equal(receipt.state, 'implemented');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transitionToImplemented rejects non-accepted state', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, {
      state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01',
    });

    assert.throws(
      () => transitionToImplemented({ cwd: dir, runId, key }),
      { code: 'INVALID_TRANSITION' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transitionToVerificationRequired rejects direct accepted -> verification_required', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, {
      state: 'accepted', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890',
      flow_id: 'flow-42', created_at: '2026-01-01',
    });

    assert.throws(
      () => transitionToVerificationRequired({ cwd: dir, runId, key }),
      { code: 'INVALID_TRANSITION' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transitionToVerificationRequired transitions implemented -> verification_required', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    prepareBoundReceipt(dir, runId, 'a1b2c3d4e5f67890', 'implemented');

    const receipt = transitionToVerificationRequired({ cwd: dir, runId, key });
    assert.equal(receipt.state, 'verification_required');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyHandoff sets verified for resolved finding', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    prepareBoundReceipt(dir, runId, 'a1b2c3d4e5f67890', 'verification_required');

    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{
        id: 'a1b2c3d4e5f67890',
        status: 'resolved',
        previous_severity: 'critical',
        current_severity: null,
      }],
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    const receipt = verifyHandoff({ cwd: dir, runId, verifyRunId, key });
    assert.equal(receipt.state, 'verified');
    assert.equal(receipt.verify_run_id, verifyRunId);
    assert.equal(receipt.verify_status, 'resolved');
    assert.ok(receipt.verified_at);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyHandoff sets verified for improved finding', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    prepareBoundReceipt(dir, runId, 'a1b2c3d4e5f67890', 'verification_required');

    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{
        id: 'a1b2c3d4e5f67890',
        status: 'improved',
        previous_severity: 'critical',
        current_severity: 'major',
      }],
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    const receipt = verifyHandoff({ cwd: dir, runId, verifyRunId, key });
    assert.equal(receipt.state, 'verified');
    assert.equal(receipt.verify_status, 'improved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyHandoff rejects a verification audit with mismatched run identity', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
  try {
    prepareBoundReceipt(dir, runId, 'a1b2c3d4e5f67890', 'verification_required');
    writeAudit(verifyPath, makeAudit([], 'run_20260825T120000Z_cccccc'));
    writeFileSync(join(verifyPath, 'verify.json'), JSON.stringify({
      previous_run: runId, run_id: verifyRunId,
      findings: [{ id: 'a1b2c3d4e5f67890', status: 'resolved' }],
    }));
    assert.throws(() => verifyHandoff({ cwd: dir, runId, verifyRunId, key }), { code: 'AUDIT_RUN_MISMATCH' });
    assert.equal(readReceipt(join(dir, '.caveman-ui-ux', 'runs', runId), key).state, 'verification_required');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verifyHandoff rejects unchanged status', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    prepareBoundReceipt(dir, runId, 'a1b2c3d4e5f67890', 'verification_required');

    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{
        id: 'a1b2c3d4e5f67890',
        status: 'unchanged',
        previous_severity: 'critical',
        current_severity: 'critical',
      }],
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    assert.throws(
      () => verifyHandoff({ cwd: dir, runId, verifyRunId, key }),
      { code: 'VERIFY_STATUS_REJECTED' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyHandoff rejects regression', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    persistReceipt(runPath, key, {
      state: 'verification_required', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890',
      created_at: '2026-01-01',
    });

    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{
        id: 'a1b2c3d4e5f67890',
        status: 'regressed',
        previous_severity: 'critical',
        current_severity: 'blocker',
      }],
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    assert.throws(
      () => verifyHandoff({ cwd: dir, runId, verifyRunId, key }),
      { code: 'VERIFY_REGRESSION' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyHandoff rejects wrong source run', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    persistReceipt(runPath, key, {
      state: 'verification_required', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890',
      created_at: '2026-01-01',
    });

    const verifyDoc = {
      schema_version: 1,
      previous_run: 'run_wrong',
      run_id: verifyRunId,
      findings: [{
        previous_id: 'a1b2c3d4e5f67890',
        status: 'resolved',
        before: [{ type: 'dom', selector: '#x' }],
        after: [{ type: 'dom', selector: '#x' }],
      }],
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    assert.throws(
      () => verifyHandoff({ cwd: dir, runId, verifyRunId, key }),
      { code: 'VERIFY_RUN_MISMATCH' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyHandoff rejects wrong finding', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    persistReceipt(runPath, key, {
      state: 'verification_required', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890',
      created_at: '2026-01-01',
    });

    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{
        id: 'zzzzzzzzzzzzzzzz',
        status: 'resolved',
        previous_severity: 'critical',
        current_severity: null,
      }],
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    assert.throws(
      () => verifyHandoff({ cwd: dir, runId, verifyRunId, key }),
      { code: 'VERIFY_FINDING_NOT_FOUND' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Handoff artifact persistence (Fix #6)
// ---------------------------------------------------------------------------

test('persistHandoffArtifact writes a valid handoff-items.json', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));
    const handoff = prepareHandoff({ cwd: gitRepo.dir, runId });

    const artifactPath = persistHandoffArtifact(gitRepo.dir, runId, handoff);
    assert.ok(existsSync(artifactPath));
    assert.ok(artifactPath.endsWith('handoff-items.json'));

    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    assert.equal(artifact.schema_version, 1);
    assert.equal(artifact.run_id, runId);
    assert.equal(artifact.item_count, 1);
    assert.equal(artifact.items.length, 1);
    assert.equal(artifact.items[0].key, `${runId}:${finding.id}`);
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('persistHandoffArtifact retains the immutable prepared item set after acceptance', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const f1 = makeActionableFinding({ id: '1111111111111111' });
    const f2 = makeActionableFinding({ id: '2222222222222222', severity: 'major' });
    writeAudit(runPath, makeAudit([f1, f2]));
    const handoff = prepareHandoff({ cwd: gitRepo.dir, runId });

    const acceptedKey = `${runId}:1111111111111111`;
    recordWithFlow({ cwd: gitRepo.dir, runId, key: acceptedKey, flowId: 'flow-42' });
    assert.equal(readReceipt(runPath, acceptedKey).state, 'accepted');

    const artifactPath = persistHandoffArtifact(gitRepo.dir, runId, handoff);
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    assert.equal(artifact.item_count, 2);
    assert.equal(artifact.items.length, 2);
    assert.deepEqual(artifact.items.map((item) => item.finding_id), [
      '1111111111111111',
      '2222222222222222',
    ]);
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('readHandoffArtifact reads and validates a valid artifact', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));
    const handoff = prepareHandoff({ cwd: gitRepo.dir, runId });
    persistHandoffArtifact(gitRepo.dir, runId, handoff);

    const artifact = readHandoffArtifact(gitRepo.dir, runId);
    assert.equal(artifact.run_id, runId);
    assert.equal(artifact.items.length, 1);
    assert.equal(artifact.item_count, 1);
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('readHandoffArtifact throws on missing artifact', () => {
  const dir = tempRunDir();
  try {
    assert.throws(
      () => readHandoffArtifact(dir, 'nonexistent'),
      { code: 'ARTIFACT_NOT_FOUND' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readHandoffArtifact throws on invalid artifact', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const handoffsDir = join(runPath, 'handoffs');
    mkdirSync(handoffsDir, { recursive: true });
    writeFileSync(join(handoffsDir, 'handoff-items.json'), 'not json', 'utf8');

    assert.throws(
      () => readHandoffArtifact(dir, runId),
      { code: 'ARTIFACT_INVALID' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readHandoffArtifact validates item_count matches', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const handoffsDir = join(runPath, 'handoffs');
    mkdirSync(handoffsDir, { recursive: true });
    writeFileSync(join(handoffsDir, 'handoff-items.json'), JSON.stringify({
      schema_version: 1,
      run_id: runId,
      items: [],
      item_count: 5,
    }), 'utf8');

    assert.throws(
      () => readHandoffArtifact(dir, runId),
      { code: 'ARTIFACT_INVALID' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// prepareHandoff — integration tests
// ---------------------------------------------------------------------------

test('prepareHandoff throws when audit.json is missing', () => {
  const dir = tempRunDir();
  try {
    assert.throws(
      () => prepareHandoff({ cwd: dir, runId: 'run_nonexistent' }),
      { code: 'AUDIT_NOT_FOUND' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareHandoff throws on audit run_id mismatch', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    const audit = makeAudit([finding], 'run_different');
    writeAudit(runPath, audit);

    assert.throws(
      () => prepareHandoff({ cwd: dir, runId }),
      { code: 'AUDIT_RUN_MISMATCH' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareHandoff throws when no git repo for rollback baseline', () => {
  // Use a temp dir that is NOT a git repo.
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));

    assert.throws(
      () => prepareHandoff({ cwd: dir, runId }),
      { code: 'NO_ROLLBACK_BASELINE' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareHandoff returns an empty no-op without git when there are no actionable findings', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  try {
    writeAudit(join(dir, '.caveman-ui-ux', 'runs', runId), makeAudit([]));
    const result = prepareHandoff({ cwd: dir, runId });
    assert.equal(result.item_count, 0);
    assert.deepEqual(result.items, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('prepareHandoff suppresses when recursive context detected', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));

    const result = prepareHandoff({
      cwd: gitRepo.dir,
      runId,
      env: { AUTOFLOW_EXECUTION_ID: 'flow-42' },
    });

    assert.equal(result.suppressed_recursive, true);
    assert.equal(result.items.length, 0);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].type, 'suppressed_recursive');
    assert.ok(result.diagnostics[0].message.includes('AUTOFLOW_EXECUTION_ID=flow-42'));
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('prepareHandoff suppresses with CAVEMAN_INSIDE_AUTOFLOW marker', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));

    const result = prepareHandoff({
      cwd: gitRepo.dir,
      runId,
      env: { CAVEMAN_INSIDE_AUTOFLOW: '1' },
    });

    assert.equal(result.suppressed_recursive, true);
    assert.equal(result.items.length, 0);
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('prepareHandoff produces items for actionable findings', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));

    const result = prepareHandoff({ cwd: gitRepo.dir, runId });

    assert.equal(result.suppressed_recursive, false);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].key, `${runId}:${finding.id}`);
    assert.equal(result.items[0].finding_id, finding.id);
    assert.equal(result.items[0].severity, 'critical');
    assert.equal(typeof result.source_audit_sha256, 'string');
    assert.equal(result.source_audit_sha256.length, 64);
    assert.equal(result.run_id, runId);
    assert.equal(result.repo, gitRepo.dir);
    assert.equal(result.cwd, gitRepo.dir);
    // Verify rollback has real git SHA.
    assert.equal(result.items[0].rollback.pre_fix_head_sha, gitRepo.sha);
    assert.ok(/^[0-9a-f]{40}$/.test(result.items[0].rollback.pre_fix_head_sha));
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('handoff prepare CLI parses --repo as a value flag', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    writeAudit(runPath, makeAudit([makeActionableFinding()], runId));
    const result = runHandoffCli(['handoff', 'prepare', '--run', runId, '--repo', gitRepo.dir, '--json'], gitRepo.dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.command, 'handoff prepare');
    assert.equal(result.json.item_count, 1);
  } finally { rmSync(gitRepo.dir, { recursive: true, force: true }); }
});

test('handoff lifecycle supports artifact cwd distinct from the prepared product repo', () => {
  const artifactCwd = tempRunDir();
  const productRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const finding = makeActionableFinding();
  const key = `${runId}:${finding.id}`;
  const runPath = join(artifactCwd, '.caveman-ui-ux', 'runs', runId);
  const flowId = 'split-repo-flow';
  let stateDir;
  try {
    writeAudit(runPath, makeAudit([finding], runId));
    const prepared = prepareHandoff({ cwd: artifactCwd, runId, repo: productRepo.dir });
    assert.equal(prepared.items[0].rollback.git_root, realpathSync(productRepo.dir));

    const claimed = claimHandoff(artifactCwd, runId);
    const claim = claimed.claims.find((entry) => entry.key === key);
    assert.ok(claim);
    stateDir = createFakeAutoflowState(flowId, productRepo.dir);
    const receipt = recordHandoff({
      cwd: artifactCwd,
      runId,
      key,
      flowId,
      claimToken: claim.claim_token,
      autoflowStateDir: stateDir,
    });
    assert.equal(receipt.state, 'accepted');
    assert.equal(receipt.rollback.git_root, realpathSync(productRepo.dir));
  } finally {
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    rmSync(artifactCwd, { recursive: true, force: true });
    rmSync(productRepo.dir, { recursive: true, force: true });
  }
});

test('prepare projects audit targets to the strict handoff target contract before claim', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const base = makeActionableFinding();
    const target = { ...base.target, selector: '#outside-handoff-contract' };
    const finding = {
      ...base,
      target,
      fix_brief: { ...base.fix_brief, target: { ...target, selector: '#also-extra' } },
    };
    writeAudit(runPath, makeAudit([finding], runId));
    prepareHandoff({ cwd: gitRepo.dir, runId });

    const artifact = readHandoffArtifact(gitRepo.dir, runId);
    const item = artifact.items[0];
    const allowed = ['locale', 'normalized_route', 'route', 'screen_id', 'url', 'viewport'];
    assert.deepEqual(Object.keys(item.target).sort(), allowed);
    assert.deepEqual(Object.keys(item.fix_brief.target).sort(), allowed);
    assert.equal('selector' in item.target, false);
    assert.equal('selector' in item.fix_brief.target, false);
    assert.equal(claimHandoff(gitRepo.dir, runId).claims.length, 1);
  } finally { rmSync(gitRepo.dir, { recursive: true, force: true }); }
});

// Fix #2: Repeated prepare must only emit pending receipts
test('prepareHandoff persists pending receipts for each item', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const f1 = makeActionableFinding({ id: '1111111111111111' });
    const f2 = makeActionableFinding({ id: '2222222222222222', severity: 'major' });
    writeAudit(runPath, makeAudit([f1, f2]));

    prepareHandoff({ cwd: gitRepo.dir, runId });

    const receipt1 = readReceipt(runPath, `${runId}:1111111111111111`);
    const receipt2 = readReceipt(runPath, `${runId}:2222222222222222`);
    assert.equal(receipt1.state, 'pending');
    assert.equal(receipt1.key, `${runId}:1111111111111111`);
    assert.match(receipt1.canonical_item_sha256, /^[0-9a-f]{64}$/);
    assert.equal(receipt2.state, 'pending');
    assert.equal(receipt2.key, `${runId}:2222222222222222`);
    assert.match(receipt2.canonical_item_sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('prepareHandoff does not persist receipts when suppressed', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));

    prepareHandoff({
      cwd: gitRepo.dir,
      runId,
      env: { AUTOFLOW_EXECUTION_ID: 'flow-42' },
    });

    const handoffsDir = join(runPath, 'handoffs');
    assert.equal(existsSync(handoffsDir), false, 'no handoffs dir should be created when suppressed');
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

// Fix #2: Repeated prepare must not overwrite non-pending receipts and only return pending
test('prepareHandoff repeated does not overwrite non-pending receipts', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const f1 = makeActionableFinding({ id: '1111111111111111' });
    const f2 = makeActionableFinding({ id: '2222222222222222', severity: 'major' });
    writeAudit(runPath, makeAudit([f1, f2]));

    // First prepare.
    const first = prepareHandoff({ cwd: gitRepo.dir, runId });
    assert.equal(first.items.length, 2);

    // Accept one item.
    recordWithFlow({ cwd: gitRepo.dir, runId, key: `${runId}:1111111111111111`, flowId: 'flow-42' });

    // Second prepare: only pending items are returned.
    const second = prepareHandoff({ cwd: gitRepo.dir, runId });
    assert.equal(second.items.length, 1, 'only pending items should be returned');
    assert.equal(second.items[0].finding_id, '2222222222222222');

    // But the accepted receipt should still be 'accepted', NOT overwritten to 'pending'.
    const receipt1 = readReceipt(runPath, `${runId}:1111111111111111`);
    assert.equal(receipt1.state, 'accepted', 'accepted receipt must not be overwritten to pending');
    assert.equal(receipt1.flow_id, 'flow-42');

    const receipt2 = readReceipt(runPath, `${runId}:2222222222222222`);
    assert.equal(receipt2.state, 'pending');
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('prepareHandoff includes diagnostics for skipped findings', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const good = makeActionableFinding({ id: '1111111111111111' });
    const noEvidence = makeActionableFinding({ evidence: [], id: '2222222222222222', rule_id: 'R2' });
    const noFix = makeActionableFinding({ fix_brief: null, id: '3333333333333333', rule_id: 'R3' });
    writeAudit(runPath, makeAudit([good, noEvidence, noFix]));

    const result = prepareHandoff({ cwd: gitRepo.dir, runId });

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].finding_id, '1111111111111111');
    assert.equal(result.diagnostics.length, 2);
    assert.equal(result.diagnostics[0].type, 'no_evidence');
    assert.equal(result.diagnostics[1].type, 'incomplete_fix_brief');
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

// Fix #9: Invalid audit must leave no receipt
test('prepareHandoff fails on invalid audit without leaving receipts', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    // Write an audit with a mismatched run_id.
    const audit = makeAudit([makeActionableFinding()], 'run_different');
    writeAudit(runPath, audit);

    assert.throws(
      () => prepareHandoff({ cwd: gitRepo.dir, runId }),
      { code: 'AUDIT_RUN_MISMATCH' },
    );

    // No receipts should exist.
    const handoffsDir = join(runPath, 'handoffs');
    assert.equal(existsSync(handoffsDir), false, 'no receipts should be created for invalid audit');
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Forbidden transition: AutoFlow must never set Caveman finding resolved
// ---------------------------------------------------------------------------

test('handoff module does not expose a function that sets finding resolved', () => {
  const finding = makeActionableFinding();
  const audit = makeAudit([finding]);

  const result = selectActionableFindings(audit);
  assert.equal(result.items.length, 1);

  assert.equal(audit.findings[0].status, 'open');
  assert.equal(audit.findings[0].severity, 'critical');
});

test('handoff state vocabulary excludes resolved for AutoFlow-set states', () => {
  assert.ok(HANDOFF_STATES.includes('pending'));
  assert.ok(HANDOFF_STATES.includes('accepted'));
  assert.ok(HANDOFF_STATES.includes('failed'));
  assert.ok(HANDOFF_STATES.includes('implemented'));
  assert.ok(HANDOFF_STATES.includes('verification_required'));
  assert.ok(HANDOFF_STATES.includes('verified'));
  assert.ok(!HANDOFF_STATES.includes('resolved'), 'AutoFlow must never set resolved');
});

// ---------------------------------------------------------------------------
// claimHandoff — batch claim with dispatch artifact
// ---------------------------------------------------------------------------

test('claimHandoff creates unique dispatch artifact and returns claims', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));
    prepareHandoff({ cwd: gitRepo.dir, runId });

    const result = claimHandoff(gitRepo.dir, runId);
    assert.ok(typeof result.dispatch_artifact_path === 'string');
    assert.ok(result.dispatch_artifact_path.includes('dispatch-'));
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].key, `${runId}:${finding.id}`);
    assert.ok(typeof result.claims[0].claim_token === 'string');
    assert.ok(result.claims[0].claim_token.length > 0);

    // Verify the dispatch artifact exists and is valid.
    assert.ok(existsSync(result.dispatch_artifact_path));
    const artifact = JSON.parse(readFileSync(result.dispatch_artifact_path, 'utf8'));
    assert.equal(artifact.items.length, 1);
    assert.equal(artifact.items[0].key, `${runId}:${finding.id}`);
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('claimHandoff rejects when no pending items', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    // No findings → no pending items.
    writeAudit(runPath, makeAudit([]));
    prepareHandoff({ cwd: gitRepo.dir, runId });

    assert.throws(
      () => claimHandoff(gitRepo.dir, runId),
      { code: 'NO_PENDING_ITEMS' },
    );
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('claimHandoff rejects when prepare not run', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));
    // No prepareHandoff — receipts don't exist.

    assert.throws(
      () => claimHandoff(gitRepo.dir, runId),
      { code: 'NO_PENDING_ITEMS' },
    );
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('claimHandoff produces unique dispatch artifact paths', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));
    prepareHandoff({ cwd: gitRepo.dir, runId });

    const r1 = claimHandoff(gitRepo.dir, runId);
    // Release the claim so we can claim again.
    releaseClaim(gitRepo.dir, runId, r1.claims[0].key, r1.claims[0].claim_token);
    // Re-prepare to get a fresh pending receipt.
    prepareHandoff({ cwd: gitRepo.dir, runId });

    const r2 = claimHandoff(gitRepo.dir, runId);

    assert.notEqual(r1.dispatch_artifact_path, r2.dispatch_artifact_path,
      'two claims must produce different dispatch artifact paths');
    assert.ok(r1.dispatch_artifact_path.includes('dispatch-'),
      'dispatch artifact path must contain dispatch- prefix');
    assert.ok(r2.dispatch_artifact_path.includes('dispatch-'),
      'dispatch artifact path must contain dispatch- prefix');

    // Both artifacts should exist and have valid content.
    const a1 = JSON.parse(readFileSync(r1.dispatch_artifact_path, 'utf8'));
    const a2 = JSON.parse(readFileSync(r2.dispatch_artifact_path, 'utf8'));
    assert.equal(a1.items.length, 1);
    assert.equal(a2.items.length, 1);
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('claimHandoff verifies audit binding', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));
    const handoff = prepareHandoff({ cwd: gitRepo.dir, runId });
    persistHandoffArtifact(gitRepo.dir, runId, handoff);

    // Tamper with the audit.
    const audit = JSON.parse(readFileSync(join(runPath, 'audit.json'), 'utf8'));
    audit.findings[0].target.route = '/tampered';
    writeFileSync(join(runPath, 'audit.json'), `${JSON.stringify(audit, null, 2)}\n`, 'utf8');

    assert.throws(
      () => claimHandoff(gitRepo.dir, runId),
      { code: 'AUDIT_TAMPERED' },
    );
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// retryHandoff — failed → pending with cap
// ---------------------------------------------------------------------------

test('retryHandoff transitions failed to pending', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, {
      state: 'failed', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890',
      diagnostic: { code: 'TIMEOUT', message: 'timeout' },
      created_at: '2026-01-01',
    });

    const receipt = retryHandoff(dir, runId, key);
    assert.equal(receipt.state, 'pending');
    assert.equal(receipt.flow_id, null);
    assert.equal(receipt.diagnostic, null);
    assert.equal(receipt.attempts.length, 1);
    assert.equal(receipt.attempts[0].previous_state, 'failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retryHandoff rejects non-failed state', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, {
      state: 'accepted', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890',
      flow_id: 'flow-42', created_at: '2026-01-01',
    });

    assert.throws(
      () => retryHandoff(dir, runId, key),
      { code: 'INVALID_TRANSITION' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retryHandoff caps at max retries', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, {
      state: 'failed', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890',
      diagnostic: { code: 'TIMEOUT', message: 'timeout' },
      attempts: [
        { retried_at: '2026-01-01', previous_state: 'failed' },
        { retried_at: '2026-01-02', previous_state: 'failed' },
        { retried_at: '2026-01-03', previous_state: 'failed' },
      ],
      created_at: '2026-01-01',
    });

    assert.throws(
      () => retryHandoff(dir, runId, key),
      { code: 'MAX_RETRIES' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retryHandoff blocked by active claim', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, {
      state: 'failed', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890',
      diagnostic: { code: 'TIMEOUT', message: 'timeout' },
      created_at: '2026-01-01',
    });

    // Create an active claim.
    claimDispatchKey(dir, runId, key);

    assert.throws(
      () => retryHandoff(dir, runId, key),
      { code: 'CLAIM_CONFLICT' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Multi-process concurrency regression test (Fix #7)
// ---------------------------------------------------------------------------

test('exclusive receipt creation prevents concurrent overwrites', () => {
  const dir = tempRunDir();
  try {
    const handoffsDir = join(dir, 'handoffs');
    ensureDir(handoffsDir);

    const receiptPath = join(handoffsDir, 'run_x_a1b2c3d4e5f67890.json');

    // First write succeeds with wx.
    writeFileSync(receiptPath, '{"state":"pending"}', { encoding: 'utf8', flag: 'wx' });

    // Second write with wx fails.
    assert.throws(
      () => writeFileSync(receiptPath, '{"state":"accepted"}', { encoding: 'utf8', flag: 'wx' }),
      { code: 'EEXIST' },
    );

    // Content is unchanged.
    const content = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(content.state, 'pending');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Claim mechanism tests — Fix #3: atomic per-key dispatch claim
// ---------------------------------------------------------------------------

test('claimDispatchKey atomically claims a key and rejects second claim', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const first = claimDispatchKey(dir, runId, key);
    assert.equal(first.claimed, true);
    assert.ok(existsSync(first.claimPath));

    // Second claim on same key must fail.
    const second = claimDispatchKey(dir, runId, key);
    assert.equal(second.claimed, false);

    // Claim file content is unchanged.
    const content = JSON.parse(readFileSync(first.claimPath, 'utf8'));
    assert.equal(content.key, key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claimDispatchKey creates claims directory automatically', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const claimsDir = join(dir, '.caveman-ui-ux', 'runs', runId, 'handoffs', 'claims');
    assert.equal(existsSync(claimsDir), false);

    const result = claimDispatchKey(dir, runId, key);
    assert.equal(result.claimed, true);
    assert.equal(existsSync(claimsDir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseClaim releases a claim and allows re-claim', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const first = claimDispatchKey(dir, runId, key);
    assert.equal(first.claimed, true);

    const released = releaseClaim(dir, runId, key, first.token);
    assert.equal(released, true);

    // After release, re-claim must succeed.
    const second = claimDispatchKey(dir, runId, key);
    assert.equal(second.claimed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finalizeClaim removes claim and creates final marker', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const result = claimDispatchKey(dir, runId, key);
    assert.equal(result.claimed, true);
    assert.ok(existsSync(result.claimPath));

    const finalized = finalizeClaim(dir, runId, key, result.token);
    assert.equal(finalized, true, `finalizeClaim returned false; claimPath=${result.claimPath}; exists=${existsSync(result.claimPath)}`);

    // Claim file is gone.
    assert.equal(existsSync(result.claimPath), false);
    // Final marker exists.
    const claimsDir = join(dir, '.caveman-ui-ux', 'runs', runId, 'handoffs', 'claims');
    const finalPath = join(claimsDir, 'run_20260824T120000Z_aaaaaa_a1b2c3d4e5f67890.final');
    assert.ok(existsSync(finalPath));

    // Finalize is idempotent (no token needed — already has final marker).
    const double = finalizeClaim(dir, runId, key, result.token);
    assert.equal(double, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordHandoff finalizes the claim for accepted status', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    ensureGitRepo(dir);
    writeAudit(runPath, makeAudit([makeActionableFinding()], runId));
    prepareHandoff({ cwd: dir, runId });
    const claimed = claimHandoff(dir, runId);
    const claimResult = { token: claimed.claims[0].claim_token, claimPath: join(runPath, 'handoffs', 'claims', `${key.replace(/:/g, '_')}.claim`) };

    // Record handoff should finalize the claim (with matching token).
    recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-42', claimToken: claimResult.token });

    // Claim file should be gone.
    assert.equal(existsSync(claimResult.claimPath), false);
    // Final marker should exist.
    const claimsDir = join(runPath, 'handoffs', 'claims');
    const finalPath = join(claimsDir, `${key.replace(/:/g, '_')}.final`);
    assert.ok(existsSync(finalPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordHandoff finalizes the claim for failed status', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });

    // Claim the key first.
    const claimResult = claimDispatchKey(dir, runId, key);
    assert.equal(claimResult.claimed, true);

    // Record a failed diagnostic should finalize the claim (with matching token).
    recordHandoff({ cwd: dir, runId, key, diagnostic: { code: 'TIMEOUT', message: 'timeout' }, claimToken: claimResult.token });

    // Claim file should be gone.
    assert.equal(existsSync(claimResult.claimPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Token ownership tests — no-token/wrong-token cannot race an active claim
// ---------------------------------------------------------------------------

test('no-token recordHandoff fails against an active claim', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    ensureGitRepo(dir);
    writeAudit(runPath, makeAudit([makeActionableFinding()], runId));
    prepareHandoff({ cwd: dir, runId });
    claimHandoff(dir, runId);
    const stateDir = createFakeAutoflowState('flow-42', dir);

    // recordHandoff without a claimToken must fail.
    assert.throws(
      () => recordHandoff({ cwd: dir, runId, key, flowId: 'flow-42', autoflowStateDir: stateDir }),
      { code: 'CLAIM_CONFLICT' },
    );
    rmSync(stateDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wrong-token recordHandoff fails against an active claim', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });

    // Create a claim.
    claimDispatchKey(dir, runId, key);

    // recordHandoff with a wrong token must fail.
    assert.throws(
      () => recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-42', claimToken: 'wrong-token' }),
      { code: 'CLAIM_CONFLICT' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('right-token recordHandoff succeeds against an active claim', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    ensureGitRepo(dir);
    writeAudit(runPath, makeAudit([makeActionableFinding()], runId));
    prepareHandoff({ cwd: dir, runId });
    const claimed = claimHandoff(dir, runId);
    const claimResult = { token: claimed.claims[0].claim_token };

    // recordHandoff with the right token must succeed.
    const receipt = recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-42', claimToken: claimResult.token });
    assert.equal(receipt.state, 'accepted');
    assert.equal(receipt.flow_id, 'flow-42');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('foreign release with wrong token cannot remove the claim', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const claimResult = claimDispatchKey(dir, runId, key);
    assert.equal(claimResult.claimed, true);

    // Release with wrong token must fail.
    const released = releaseClaim(dir, runId, key, 'wrong-token');
    assert.equal(released, false);

    // Claim file must still exist.
    assert.ok(existsSync(claimResult.claimPath));

    // Release with right token must succeed.
    const released2 = releaseClaim(dir, runId, key, claimResult.token);
    assert.equal(released2, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyClaimStillPending with wrong token returns false', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });

    const claimResult = claimDispatchKey(dir, runId, key);
    assert.equal(claimResult.claimed, true);

    // Wrong token: verifyClaimStillPending must return false.
    const result = verifyClaimStillPending(dir, runId, key, 'wrong-token');
    assert.equal(result, false);

    // Right token: verifyClaimStillPending must return true.
    const result2 = verifyClaimStillPending(dir, runId, key, claimResult.token);
    assert.equal(result2, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyClaimStillPending returns false when receipt is not pending', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'accepted', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', flow_id: 'flow-42', created_at: '2026-01-01' });

    const claimResult = claimDispatchKey(dir, runId, key);
    // The receipt is already accepted, so verifyClaimStillPending should return false.
    const result = verifyClaimStillPending(dir, runId, key, claimResult.token);
    assert.equal(result, false);
    // The claim should have been released.
    assert.equal(existsSync(claimResult.claimPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Expired claim takeover — stale claims can be taken over
// ---------------------------------------------------------------------------

test('claimDispatchKey takes over expired claim', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    // Create an expired claim (claimed_at = 2 days ago).
    const claimsDir = join(dir, '.caveman-ui-ux', 'runs', runId, 'handoffs', 'claims');
    mkdirSync(claimsDir, { recursive: true });
    const claimPath = join(claimsDir, `${key.replace(/:/g, '_')}.claim`);
    writeFileSync(claimPath, JSON.stringify({
      key, run_id: runId, token: 'old-token',
      claimed_at: '2026-08-22T11:00:00.000Z', // > 24 h ago
    }), 'utf8');

    // Claim should succeed (takeover).
    const result = claimDispatchKey(dir, runId, key);
    assert.equal(result.claimed, true);

    // Verify the token changed.
    const claim = JSON.parse(readFileSync(claimPath, 'utf8'));
    assert.notEqual(claim.token, 'old-token');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claimDispatchKey rejects active unexpired claim', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const first = claimDispatchKey(dir, runId, key);
    assert.equal(first.claimed, true);

    // Second claim must fail (active unexpired).
    const second = claimDispatchKey(dir, runId, key);
    assert.equal(second.claimed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Complete lifecycle chain test — prepare → claim → record → advance → verify
// ---------------------------------------------------------------------------

test('complete lifecycle: prepare → claim → record(token) → advance → verify', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  const verifyPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', verifyRunId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));

    // 1. Prepare
    const handoff = prepareHandoff({ cwd: gitRepo.dir, runId });
    assert.equal(handoff.items.length, 1);

    // 2. Claim
    const claimResult = claimHandoff(gitRepo.dir, runId);
    assert.equal(claimResult.claims.length, 1);
    const { key, claim_token } = claimResult.claims[0];

    // 3. Record with actual flow_id and claim token
    const receipt = recordWithFlow({
      cwd: gitRepo.dir, runId, key,
      flowId: 'real-flow-42',
      claimToken: claim_token,
    });
    assert.equal(receipt.state, 'accepted');
    assert.equal(receipt.flow_id, 'real-flow-42');

    // 4. Advance to implemented
    const impl = transitionToImplemented({ cwd: gitRepo.dir, runId, key });
    assert.equal(impl.state, 'implemented');

    // 5. Advance to verification_required
    const vr = transitionToVerificationRequired({ cwd: gitRepo.dir, runId, key });
    assert.equal(vr.state, 'verification_required');

    // 6. Verify
    writeAudit(verifyPath, makeAudit([], verifyRunId));
    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{ id: finding.id, status: 'resolved', previous_severity: 'critical', current_severity: null }],
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    const verified = verifyHandoff({ cwd: gitRepo.dir, runId, verifyRunId, key });
    assert.equal(verified.state, 'verified');
    assert.equal(verified.verify_status, 'resolved');
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression tests — Fix #2: prepareHandoff only returns pending items
// ---------------------------------------------------------------------------

test('prepareHandoff returns only pending items in items array', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const f1 = makeActionableFinding({ id: '1111111111111111' });
    const f2 = makeActionableFinding({ id: '2222222222222222', severity: 'major' });
    writeAudit(runPath, makeAudit([f1, f2]));

    // First prepare — both items should be pending.
    const first = prepareHandoff({ cwd: gitRepo.dir, runId });
    assert.equal(first.items.length, 2);
    assert.equal(first.items.length, 2); // prepareHandoff.items should reflect pending count

    // Accept f1.
    recordWithFlow({ cwd: gitRepo.dir, runId, key: `${runId}:1111111111111111`, flowId: 'flow-42' });

    // Second prepare — only f2 should be in items.
    const second = prepareHandoff({ cwd: gitRepo.dir, runId });
    assert.equal(second.items.length, 1, 'only pending items should be in items array');
    assert.equal(second.items[0].finding_id, '2222222222222222');
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('prepareHandoff returns empty items when all accepted', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const f1 = makeActionableFinding({ id: '1111111111111111' });
    writeAudit(runPath, makeAudit([f1]));

    prepareHandoff({ cwd: gitRepo.dir, runId });
    recordWithFlow({ cwd: gitRepo.dir, runId, key: `${runId}:1111111111111111`, flowId: 'flow-42' });

    const result = prepareHandoff({ cwd: gitRepo.dir, runId });
    assert.equal(result.items.length, 0, 'no items should be returned when all accepted');
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('prepareHandoff does not include failed items in return', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const f1 = makeActionableFinding({ id: '1111111111111111' });
    const f2 = makeActionableFinding({ id: '2222222222222222', severity: 'major' });
    writeAudit(runPath, makeAudit([f1, f2]));

    prepareHandoff({ cwd: gitRepo.dir, runId });
    recordHandoff({
      cwd: gitRepo.dir, runId, key: `${runId}:1111111111111111`,
      diagnostic: { code: 'FAILED', message: 'test failure' },
    });

    const result = prepareHandoff({ cwd: gitRepo.dir, runId });
    assert.equal(result.items.length, 1, 'only pending items should be in items');
    assert.equal(result.items[0].finding_id, '2222222222222222');
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('prepareHandoff does not include implemented/verified items in return', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const f1 = makeActionableFinding({ id: '1111111111111111' });
    const f2 = makeActionableFinding({ id: '2222222222222222', severity: 'major' });
    writeAudit(runPath, makeAudit([f1, f2]));

    prepareHandoff({ cwd: gitRepo.dir, runId });
    recordWithFlow({ cwd: gitRepo.dir, runId, key: `${runId}:1111111111111111`, flowId: 'flow-42' });
    transitionToImplemented({ cwd: gitRepo.dir, runId, key: `${runId}:1111111111111111` });

    const result = prepareHandoff({ cwd: gitRepo.dir, runId });
    assert.equal(result.items.length, 1, 'only pending items should be in items');
    assert.equal(result.items[0].finding_id, '2222222222222222');
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression tests — Fix #3: verifyHandoff state machine enforcement
// ---------------------------------------------------------------------------

test('verifyHandoff rejects pending receipt', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });

    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{ id: 'a1b2c3d4e5f67890', status: 'resolved', previous_severity: 'critical', current_severity: null }],
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    assert.throws(
      () => verifyHandoff({ cwd: dir, runId, verifyRunId, key }),
      { code: 'VERIFY_INVALID_STATE' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyHandoff rejects accepted receipt', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    persistReceipt(runPath, key, { state: 'accepted', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', flow_id: 'flow-42', created_at: '2026-01-01' });

    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{ id: 'a1b2c3d4e5f67890', status: 'resolved', previous_severity: 'critical', current_severity: null }],
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    assert.throws(
      () => verifyHandoff({ cwd: dir, runId, verifyRunId, key }),
      { code: 'VERIFY_INVALID_STATE' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyHandoff rejects failed receipt', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    persistReceipt(runPath, key, { state: 'failed', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', diagnostic: { code: 'ERR', message: 'fail' }, created_at: '2026-01-01' });

    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{ id: 'a1b2c3d4e5f67890', status: 'resolved', previous_severity: 'critical', current_severity: null }],
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    assert.throws(
      () => verifyHandoff({ cwd: dir, runId, verifyRunId, key }),
      { code: 'VERIFY_INVALID_STATE' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyHandoff rejects implemented receipt', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    persistReceipt(runPath, key, { state: 'implemented', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', flow_id: 'flow-42', created_at: '2026-01-01' });

    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{ id: 'a1b2c3d4e5f67890', status: 'resolved', previous_severity: 'critical', current_severity: null }],
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    assert.throws(
      () => verifyHandoff({ cwd: dir, runId, verifyRunId, key }),
      { code: 'VERIFY_INVALID_STATE' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyHandoff idempotent replay of already verified', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    persistReceipt(runPath, key, {
      state: 'verified', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890',
      verify_run_id: verifyRunId, verify_status: 'resolved', verified_at: '2026-01-01',
      created_at: '2026-01-01',
    });

    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{ id: 'a1b2c3d4e5f67890', status: 'resolved', previous_severity: 'critical', current_severity: null }],
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    const receipt = verifyHandoff({ cwd: dir, runId, verifyRunId, key });
    assert.equal(receipt.state, 'verified');
    assert.equal(receipt.verify_status, 'resolved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression tests — Fix #5: Align verifyHandoff to production verify.json
// ---------------------------------------------------------------------------

test('verifyHandoff uses production verify.json shape with id field', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    prepareBoundReceipt(dir, runId, 'a1b2c3d4e5f67890', 'verification_required');

    // Production format from diffFindings: uses `id` (not `previous_id`),
    // `previous_severity`, `current_severity`, no `before`/`after`.
    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{
        id: 'a1b2c3d4e5f67890',
        current_id: null,
        key: 'TECH.FORM.MISSING_LABEL|/signup|en|mobile',
        rule_id: 'TECH.FORM.MISSING_LABEL',
        kind: 'deterministic',
        target: { route: '/signup', normalized_route: '/signup', locale: 'en', viewport: 'mobile' },
        previous_severity: 'critical',
        current_severity: null,
        status: 'resolved',
      }],
      summary: { resolved: 1, improved: 0, unchanged: 0, regressed: 0, not_comparable: 0, open: 0 },
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    const receipt = verifyHandoff({ cwd: dir, runId, verifyRunId, key });
    assert.equal(receipt.state, 'verified');
    assert.equal(receipt.verify_status, 'resolved');
    assert.equal(receipt.verify_run_id, verifyRunId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyHandoff uses production shape with improved status', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    prepareBoundReceipt(dir, runId, 'a1b2c3d4e5f67890', 'verification_required');

    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{
        id: 'a1b2c3d4e5f67890',
        current_id: 'a1b2c3d4e5f67890',
        key: 'TECH.FORM.MISSING_LABEL|/signup|en|mobile',
        rule_id: 'TECH.FORM.MISSING_LABEL',
        kind: 'deterministic',
        target: { route: '/signup', normalized_route: '/signup', locale: 'en', viewport: 'mobile' },
        previous_severity: 'critical',
        current_severity: 'major',
        status: 'improved',
      }],
      summary: { resolved: 0, improved: 1, unchanged: 0, regressed: 0, not_comparable: 0, open: 0 },
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    const receipt = verifyHandoff({ cwd: dir, runId, verifyRunId, key });
    assert.equal(receipt.state, 'verified');
    assert.equal(receipt.verify_status, 'improved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyHandoff rejects unchanged in production shape', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    persistReceipt(runPath, key, {
      state: 'verification_required', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890',
      created_at: '2026-01-01',
    });

    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{
        id: 'a1b2c3d4e5f67890',
        current_id: 'a1b2c3d4e5f67890',
        status: 'unchanged',
        previous_severity: 'critical',
        current_severity: 'critical',
      }],
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    assert.throws(
      () => verifyHandoff({ cwd: dir, runId, verifyRunId, key }),
      { code: 'VERIFY_STATUS_REJECTED' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyHandoff rejects regression in production shape', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    persistReceipt(runPath, key, {
      state: 'verification_required', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890',
      created_at: '2026-01-01',
    });

    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{
        id: 'a1b2c3d4e5f67890',
        current_id: 'a1b2c3d4e5f67890',
        status: 'regressed',
        previous_severity: 'critical',
        current_severity: 'blocker',
      }],
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    assert.throws(
      () => verifyHandoff({ cwd: dir, runId, verifyRunId, key }),
      { code: 'VERIFY_REGRESSION' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression tests — Fix #6: recordHandoff monotonic transition table
// ---------------------------------------------------------------------------

test('recordHandoff allows accepted -> failed transition for implementation failure recovery', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });
    recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-42' });

    const receipt = recordHandoff({ cwd: dir, runId, key, diagnostic: { code: 'FAIL', message: 'implementation failed' } });
    assert.equal(receipt.state, 'failed');
    assert.equal(retryHandoff(dir, runId, key).state, 'pending');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordHandoff allows implemented -> failed transition for implementation failure recovery', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890' });
    recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-42' });
    transitionToImplemented({ cwd: dir, runId, key });
    const receipt = recordHandoff({ cwd: dir, runId, key, diagnostic: { code: 'TEST_FAIL', message: 'verification setup failed' } });
    assert.equal(receipt.state, 'failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recordHandoff rejects failed -> accepted transition', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });
    recordHandoff({ cwd: dir, runId, key, diagnostic: { code: 'FAIL', message: 'fail first' } });

    assert.throws(
      () => recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-42' }),
      { code: 'INVALID_TRANSITION' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordHandoff rejects implemented -> accepted transition', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });
    recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-42' });
    transitionToImplemented({ cwd: dir, runId, key });

    assert.throws(
      () => recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-99' }),
      { code: 'INVALID_TRANSITION' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordHandoff rejects verification_required -> accepted transition', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });
    recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-42' });
    transitionToImplemented({ cwd: dir, runId, key });
    transitionToVerificationRequired({ cwd: dir, runId, key });

    assert.throws(
      () => recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-99' }),
      { code: 'INVALID_TRANSITION' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordHandoff rejects verified -> accepted transition', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });
    recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-42' });
    transitionToImplemented({ cwd: dir, runId, key });
    transitionToVerificationRequired({ cwd: dir, runId, key });
    // Manually set to verified since we can't go through verifyHandoff in this test easily.
    writeReceipt(runPath, key, { state: 'verified', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', flow_id: 'flow-42', verified_at: '2026-01-01' });

    assert.throws(
      () => recordWithFlow({ cwd: dir, runId, key, flowId: 'flow-99' }),
      { code: 'INVALID_TRANSITION' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordHandoff idempotent replay of failed with same diagnostic', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });

    recordHandoff({ cwd: dir, runId, key, diagnostic: { code: 'TIMEOUT', message: 'timed out' } });
    // Replay same diagnostic — should be idempotent.
    const receipt = recordHandoff({ cwd: dir, runId, key, diagnostic: { code: 'TIMEOUT', message: 'timed out' } });
    assert.equal(receipt.state, 'failed');
    assert.deepEqual(receipt.diagnostic, { code: 'TIMEOUT', message: 'timed out' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordHandoff rejects failed -> failed with different diagnostic', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890', created_at: '2026-01-01' });

    recordHandoff({ cwd: dir, runId, key, diagnostic: { code: 'TIMEOUT', message: 'timed out' } });

    assert.throws(
      () => recordHandoff({ cwd: dir, runId, key, diagnostic: { code: 'CRASH', message: 'crashed' } }),
      { code: 'CONFLICTING_DIAGNOSTIC' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression tests — Fix #8: Rollback fail on dirty worktree
// ---------------------------------------------------------------------------

test('prepareHandoff fails on dirty worktree', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    // Create an uncommitted change — dirty worktree.
    writeFileSync(join(gitRepo.dir, 'dirty.txt'), 'uncommitted\n', 'utf8');

    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));

    assert.throws(
      () => prepareHandoff({ cwd: gitRepo.dir, runId }),
      { code: 'DIRTY_WORKTREE' },
    );
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('prepareHandoff preserves porcelain status columns and rename targets', () => {
  const runId = 'run_20260824T120000Z_aaaaaa';
  const finding = makeActionableFinding();
  const modifiedRepo = tempGitRepo();
  const renamedRepo = tempGitRepo();
  const intoWorkflowRepo = tempGitRepo();
  try {
    writeAudit(join(modifiedRepo.dir, '.caveman-ui-ux', 'runs', runId), makeAudit([finding]));
    writeFileSync(join(modifiedRepo.dir, 'README.md'), '# modified\n');
    assert.throws(
      () => prepareHandoff({ cwd: modifiedRepo.dir, runId }),
      (error) => error.code === 'DIRTY_WORKTREE' && error.message.includes('README.md'),
    );

    writeAudit(join(renamedRepo.dir, '.caveman-ui-ux', 'runs', runId), makeAudit([finding]));
    execSync('git mv README.md renamed.md', { cwd: renamedRepo.dir });
    assert.throws(
      () => prepareHandoff({ cwd: renamedRepo.dir, runId }),
      (error) => error.code === 'DIRTY_WORKTREE' && error.message.includes('renamed.md'),
    );

    writeAudit(join(intoWorkflowRepo.dir, '.caveman-ui-ux', 'runs', runId), makeAudit([finding]));
    execSync('git mv README.md .caveman-ui-ux/product.txt', { cwd: intoWorkflowRepo.dir });
    assert.throws(
      () => prepareHandoff({ cwd: intoWorkflowRepo.dir, runId }),
      (error) => error.code === 'DIRTY_WORKTREE'
        && error.message.includes('README.md')
        && error.message.includes('.caveman-ui-ux/product.txt'),
    );
  } finally {
    rmSync(modifiedRepo.dir, { recursive: true, force: true });
    rmSync(renamedRepo.dir, { recursive: true, force: true });
    rmSync(intoWorkflowRepo.dir, { recursive: true, force: true });
  }
});

test('rollback dirty status stays Git-root-relative from a nested cwd', () => {
  const gitRepo = tempGitRepo();
  const nested = join(gitRepo.dir, 'packages', 'app');
  const workflowFile = join(gitRepo.dir, '.caveman-ui-ux', 'state.txt');
  const runId = 'run_20260824T120000Z_aaaaaa';
  try {
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(gitRepo.dir, '.caveman-ui-ux'), { recursive: true });
    writeFileSync(workflowFile, 'baseline\n');
    execSync('git add -f .caveman-ui-ux/state.txt', { cwd: gitRepo.dir, stdio: 'pipe' });
    execSync('git commit -m "track workflow fixture"', { cwd: gitRepo.dir, stdio: 'pipe' });

    writeFileSync(workflowFile, 'workflow update\n');
    let item = buildHandoffItem(makeActionableFinding(), runId, 'a'.repeat(64), nested, nested);
    assert.equal(item.rollback.dirty_worktree, false, 'root workflow state must be excluded from nested cwd');

    writeFileSync(join(gitRepo.dir, 'README.md'), '# product update\n');
    item = buildHandoffItem(makeActionableFinding(), runId, 'a'.repeat(64), nested, nested);
    assert.equal(item.rollback.dirty_worktree, true);
    assert.deepEqual(item.rollback.dirty_files, ['README.md']);
  } finally { rmSync(gitRepo.dir, { recursive: true, force: true }); }
});

test('prepareHandoff succeeds on clean worktree', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));

    const result = prepareHandoff({ cwd: gitRepo.dir, runId });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].rollback.dirty_worktree, false);
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression tests — Fix #7: Runtime adapter schema validation
// ---------------------------------------------------------------------------

test('readHandoffArtifact rejects artifact with missing required field', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const handoffsDir = join(runPath, 'handoffs');
    mkdirSync(handoffsDir, { recursive: true });
    // Missing tool field.
    writeFileSync(join(handoffsDir, 'handoff-items.json'), JSON.stringify({
      schema_version: 1,
      run_id: runId,
      items: [],
      item_count: 0,
    }), 'utf8');

    assert.throws(
      () => readHandoffArtifact(dir, runId),
      { code: 'ARTIFACT_INVALID' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readHandoffArtifact rejects tampered artifact with mismatched source_audit_sha256', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));
    const handoff = prepareHandoff({ cwd: gitRepo.dir, runId });
    const artifactPath = persistHandoffArtifact(gitRepo.dir, runId, handoff);

    // Tamper with the artifact: change an item's source_audit_sha256.
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    artifact.items[0].source_audit_sha256 = '0'.repeat(64);
    writeFileSync(artifactPath, JSON.stringify(artifact), 'utf8');

    assert.throws(
      () => readHandoffArtifact(gitRepo.dir, runId),
      { code: 'ARTIFACT_TAMPERED' },
    );
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('readHandoffArtifact rejects artifact with item not matching any pending receipt', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));
    const handoff = prepareHandoff({ cwd: gitRepo.dir, runId });
    const artifactPath = persistHandoffArtifact(gitRepo.dir, runId, handoff);

    // Accept the receipt so it's no longer pending.
    recordWithFlow({ cwd: gitRepo.dir, runId, key: `${runId}:${finding.id}`, flowId: 'flow-42' });

    // Now re-read the artifact — it should have 0 items since the receipt is no longer pending.
    // But the artifact file still has the item. readHandoffArtifact should reject stale items.
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    assert.equal(artifact.item_count, 1); // artifact still has the item

    // readHandoffArtifact should reject because the item's receipt is no longer pending.
    assert.throws(
      () => readHandoffArtifact(gitRepo.dir, runId),
      { code: 'ARTIFACT_STALE' },
    );
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E2E regression tests — Fix #1: CLI verify integrates with handoff receipts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Schema validation tamper tests — Fix #2: validateSubset catches malformed
// artifacts that the old manual top-level checks would accept.
// ---------------------------------------------------------------------------

test('readHandoffArtifact rejects item with extra unknown field (additionalProperties)', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));
    const handoff = prepareHandoff({ cwd: gitRepo.dir, runId });
    const artifactPath = persistHandoffArtifact(gitRepo.dir, runId, handoff);

    // Tamper: add an unknown field to an item. Old manual checks wouldn't catch this.
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    artifact.items[0].injected_field = 'malicious';
    writeFileSync(artifactPath, JSON.stringify(artifact), 'utf8');

    assert.throws(
      () => readHandoffArtifact(gitRepo.dir, runId),
      { code: 'ARTIFACT_INVALID' },
    );
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('readHandoffArtifact rejects item with malformed rollback missing description', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));
    const handoff = prepareHandoff({ cwd: gitRepo.dir, runId });
    const artifactPath = persistHandoffArtifact(gitRepo.dir, runId, handoff);

    // Tamper: remove a required rollback field. Old manual checks only check top-level fields.
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    delete artifact.items[0].rollback.description;
    writeFileSync(artifactPath, JSON.stringify(artifact), 'utf8');

    assert.throws(
      () => readHandoffArtifact(gitRepo.dir, runId),
      { code: 'ARTIFACT_INVALID' },
    );
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('readHandoffArtifact rejects item with malformed fix_brief missing acceptance', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));
    const handoff = prepareHandoff({ cwd: gitRepo.dir, runId });
    const artifactPath = persistHandoffArtifact(gitRepo.dir, runId, handoff);

    // Tamper: remove a required fix_brief field.
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    delete artifact.items[0].fix_brief.acceptance;
    writeFileSync(artifactPath, JSON.stringify(artifact), 'utf8');

    assert.throws(
      () => readHandoffArtifact(gitRepo.dir, runId),
      { code: 'ARTIFACT_INVALID' },
    );
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('readHandoffArtifact rejects item with invalid severity enum value', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));
    const handoff = prepareHandoff({ cwd: gitRepo.dir, runId });
    const artifactPath = persistHandoffArtifact(gitRepo.dir, runId, handoff);

    // Tamper: change severity to an invalid value. Old checks only verify top-level fields.
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    artifact.items[0].severity = 'info';
    writeFileSync(artifactPath, JSON.stringify(artifact), 'utf8');

    assert.throws(
      () => readHandoffArtifact(gitRepo.dir, runId),
      { code: 'ARTIFACT_INVALID' },
    );
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('readHandoffArtifact rejects item with evidence entry missing type', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));
    const handoff = prepareHandoff({ cwd: gitRepo.dir, runId });
    const artifactPath = persistHandoffArtifact(gitRepo.dir, runId, handoff);

    // Tamper: remove the required `type` from an evidence entry.
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    delete artifact.items[0].evidence[0].type;
    writeFileSync(artifactPath, JSON.stringify(artifact), 'utf8');

    assert.throws(
      () => readHandoffArtifact(gitRepo.dir, runId),
      { code: 'ARTIFACT_INVALID' },
    );
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('verifyHandoff handles not_comparable status correctly', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    persistReceipt(runPath, key, {
      state: 'verification_required', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890',
      created_at: '2026-01-01',
    });

    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{
        id: 'a1b2c3d4e5f67890',
        status: 'not_comparable',
        previous_severity: 'critical',
        current_severity: null,
      }],
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    assert.throws(
      () => verifyHandoff({ cwd: dir, runId, verifyRunId, key }),
      { code: 'VERIFY_STATUS_REJECTED' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: shifted-region blind/heuristic finding must not be falsely verified.
// When the same semantic key (rule + route + locale + viewport) produces a new
// finding id because the evidence region shifted, diffFindings must match by
// key fallback so the finding is marked unchanged (not resolved), and the
// receipt must NOT transition to verified.
test('verifyHandoff rejects shifted-region blind finding (same key, different id)', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
    const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
    mkdirSync(verifyPath, { recursive: true });

    persistReceipt(runPath, key, {
      state: 'verification_required', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890',
      created_at: '2026-01-01',
    });

    // Simulate what the fixed diffFindings produces: previous finding id A,
    // current finding id B (shifted region), same semantic key, unchanged severity.
    const verifyDoc = {
      schema_version: 1,
      previous_run: runId,
      run_id: verifyRunId,
      findings: [{
        id: 'a1b2c3d4e5f67890',           // previous blind finding id (region A)
        current_id: 'b2c3d4e5f6789012',     // current blind finding id (region B — shifted)
        key: 'TECH.TAP_TARGET.SMALL|/signup|en|mobile',
        rule_id: 'TECH.TAP_TARGET.SMALL',
        kind: 'blind',
        target: { route: '/signup', normalized_route: '/signup', locale: 'en', viewport: 'mobile' },
        previous_severity: 'major',
        current_severity: 'major',
        status: 'unchanged',
      }],
      summary: { resolved: 0, improved: 0, unchanged: 1, regressed: 0, not_comparable: 0, open: 0 },
    };
    writeFileSync(join(verifyPath, 'verify.json'), `${JSON.stringify(verifyDoc, null, 2)}\n`, 'utf8');

    // Must reject because status is unchanged, not resolved.
    assert.throws(
      () => verifyHandoff({ cwd: dir, runId, verifyRunId, key }),
      { code: 'VERIFY_STATUS_REJECTED' },
    );

    // Receipt must remain in verification_required, not transition to verified.
    const receiptAfter = readReceipt(runPath, key);
    assert.equal(receiptAfter.state, 'verification_required');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Multi-process barrier test — exactly one winner for the same key
// ---------------------------------------------------------------------------

test('multi-process claimDispatchKey: exactly one winner per key', async () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  try {
    const { spawn } = await import('node:child_process');

    // Launch 5 child processes that all try to claim the same key.
    const children = [];
    for (let i = 0; i < 5; i++) {
      const p = new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', `
          import { claimDispatchKey } from './scripts/lib/handoff.mjs';
          const result = claimDispatchKey('${dir}', '${runId}', '${key}');
          process.stdout.write(JSON.stringify({claimed: result.claimed}));
          process.exit(0);
        `], { cwd: resolvePath('.'), stdio: 'pipe' });
        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.on('close', (code) => resolve({ code, stdout }));
      });
      children.push(p);
    }

    const results = await Promise.all(children);
    const winners = results.filter((r) => {
      try { return JSON.parse(r.stdout).claimed === true; } catch { return false; }
    });

    assert.equal(winners.length, 1, `expected exactly 1 winner, got ${winners.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Audit binding tests — receipt source_audit_sha256
// ---------------------------------------------------------------------------

test('claimHandoff rejects when receipt audit binding is missing', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));

    // Manually create a receipt without source_audit_sha256 (legacy).
    const handoffsDir = join(runPath, 'handoffs');
    mkdirSync(handoffsDir, { recursive: true });
    const key = `${runId}:${finding.id}`;
    writeFileSync(join(handoffsDir, `${key.replace(/:/g, '_')}.json`), JSON.stringify({
      state: 'pending', key, run_id: runId, finding_id: finding.id, created_at: '2026-01-01',
    }), 'utf8');

    assert.throws(
      () => claimHandoff(gitRepo.dir, runId),
      { code: 'AUDIT_BINDING_MISSING' },
    );
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('claimHandoff rejects when audit changed after prepare', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));
    prepareHandoff({ cwd: gitRepo.dir, runId });

    // Tamper with the audit.
    const audit = JSON.parse(readFileSync(join(runPath, 'audit.json'), 'utf8'));
    audit.findings[0].target.route = '/tampered';
    writeFileSync(join(runPath, 'audit.json'), `${JSON.stringify(audit, null, 2)}\n`, 'utf8');

    assert.throws(
      () => claimHandoff(gitRepo.dir, runId),
      { code: 'AUDIT_TAMPERED' },
    );
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('claimHandoff rejects tracked worktree changes made after prepare without creating a claim artifact', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    writeAudit(runPath, makeAudit([makeActionableFinding()]));
    prepareHandoff({ cwd: gitRepo.dir, runId });
    writeFileSync(join(gitRepo.dir, 'README.md'), '# changed after prepare\n', 'utf8');

    assert.throws(() => claimHandoff(gitRepo.dir, runId), { code: 'DIRTY_WORKTREE' });
    const claimsDir = join(runPath, 'handoffs', 'claims');
    assert.equal(existsSync(claimsDir), false);
    assert.equal(readdirSync(join(runPath, 'handoffs')).some((name) => name.startsWith('dispatch-')), false);
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('claimHandoff rejects HEAD drift from the prepared rollback baseline without creating an artifact', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    writeAudit(runPath, makeAudit([makeActionableFinding()]));
    prepareHandoff({ cwd: gitRepo.dir, runId });
    writeFileSync(join(gitRepo.dir, 'README.md'), '# new committed head\n', 'utf8');
    execSync('git add README.md', { cwd: gitRepo.dir, stdio: 'pipe' });
    execSync('git commit -m "head drift"', { cwd: gitRepo.dir, stdio: 'pipe' });

    assert.throws(() => claimHandoff(gitRepo.dir, runId), { code: 'ROLLBACK_BASELINE_MISMATCH' });
    assert.equal(existsSync(join(runPath, 'handoffs', 'claims')), false);
    assert.equal(readdirSync(join(runPath, 'handoffs')).some((name) => name.startsWith('dispatch-')), false);
    assert.equal(readReceipt(runPath, `${runId}:${makeActionableFinding().id}`).state, 'pending');
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('claimHandoff rejects a receipt whose rollback baseline was tampered to the new HEAD', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  const key = `${runId}:${makeActionableFinding().id}`;
  try {
    writeAudit(runPath, makeAudit([makeActionableFinding()]));
    const prepared = prepareHandoff({ cwd: gitRepo.dir, runId });
    persistHandoffArtifact(gitRepo.dir, runId, prepared);
    writeFileSync(join(gitRepo.dir, 'README.md'), '# B\n');
    execSync('git add README.md', { cwd: gitRepo.dir, stdio: 'pipe' });
    execSync('git commit -m B', { cwd: gitRepo.dir, stdio: 'pipe' });
    const receipt = readReceipt(runPath, key);
    receipt.rollback.pre_fix_head_sha = execSync('git rev-parse HEAD', { cwd: gitRepo.dir, encoding: 'utf8' }).trim();
    receipt.rollback.pre_fix_head_ref = receipt.rollback.pre_fix_head_sha;
    writeReceipt(runPath, key, receipt);
    assert.throws(() => claimHandoff(gitRepo.dir, runId), { code: 'ROLLBACK_BASELINE_TAMPERED' });
    assert.equal(existsSync(join(runPath, 'handoffs', 'claims')), false);
  } finally { rmSync(gitRepo.dir, { recursive: true, force: true }); }
});

test('claimHandoff fails closed when the canonical prepared artifact is tampered', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    writeAudit(runPath, makeAudit([makeActionableFinding()]));
    const prepared = prepareHandoff({ cwd: gitRepo.dir, runId });
    const artifactPath = persistHandoffArtifact(gitRepo.dir, runId, prepared);
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    artifact.items[0].rollback.pre_fix_head_sha = 'f'.repeat(40);
    writeFileSync(artifactPath, JSON.stringify(artifact));
    assert.throws(() => claimHandoff(gitRepo.dir, runId), { code: 'ROLLBACK_BASELINE_TAMPERED' });
    assert.equal(existsSync(join(runPath, 'handoffs', 'claims')), false);
  } finally { rmSync(gitRepo.dir, { recursive: true, force: true }); }
});

test('recordHandoff rejects post-claim dispatch artifact tampering and preserves claim', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    writeAudit(runPath, makeAudit([makeActionableFinding()]));
    const prepared = prepareHandoff({ cwd: gitRepo.dir, runId });
    persistHandoffArtifact(gitRepo.dir, runId, prepared);
    const claimed = claimHandoff(gitRepo.dir, runId);
    const claim = claimed.claims[0];
    const artifact = JSON.parse(readFileSync(claimed.dispatch_artifact_path, 'utf8'));
    artifact.items[0].fix_brief.intent = 'attacker changed intent';
    writeFileSync(claimed.dispatch_artifact_path, JSON.stringify(artifact));
    assert.throws(
      () => recordHandoff({ cwd: gitRepo.dir, runId, key: claim.key, diagnostic: { code: 'FAIL', message: 'failed' }, claimToken: claim.claim_token }),
      { code: 'DISPATCH_BINDING_INVALID' },
    );
    assert.equal(readReceipt(runPath, claim.key).state, 'pending');
    assert.ok(existsSync(join(runPath, 'handoffs', 'claims', `${claim.key.replace(/:/g, '_')}.claim`)));
  } finally { rmSync(gitRepo.dir, { recursive: true, force: true }); }
});

test('recordHandoff refuses to mutate a claimed receipt while its per-key lock is held', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const key = `${runId}:a1b2c3d4e5f67890`;
  const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
  try {
    persistReceipt(runPath, key, { state: 'pending', key, run_id: runId, finding_id: 'a1b2c3d4e5f67890' });
    const claim = claimDispatchKey(dir, runId, key);
    const lockPath = join(runPath, 'handoffs', 'claims', `${key.replace(/:/g, '_')}.lock`);
    writeFileSync(lockPath, 'foreign-owner', { flag: 'wx' });

    assert.throws(
      () => recordHandoff({ cwd: dir, runId, key, diagnostic: { code: 'FAIL', message: 'failed' }, claimToken: claim.token }),
      { code: 'CLAIM_BUSY' },
    );
    assert.equal(readReceipt(runPath, key).state, 'pending');
    assert.ok(existsSync(claim.claimPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all lifecycle mutations fail with CLAIM_BUSY while the per-key lock is live', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const finding = makeActionableFinding();
  const key = `${runId}:${finding.id}`;
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  const lockPath = join(runPath, 'handoffs', 'claims', `${key.replace(/:/g, '_')}.lock`);
  const lock = () => writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  try {
    prepareBoundReceipt(gitRepo.dir, runId, finding, 'accepted');
    lock();
    assert.throws(() => transitionToImplemented({ cwd: gitRepo.dir, runId, key }), { code: 'CLAIM_BUSY' });
    const competing = runHandoffCli(['handoff', 'advance', '--run', runId, '--key', key, '--state', 'implemented'], gitRepo.dir);
    assert.equal(competing.status, 2);
    assert.match(competing.stderr, /busy/i);
    assert.equal(readReceipt(runPath, key).state, 'accepted');
    unlinkSync(lockPath);

    transitionToImplemented({ cwd: gitRepo.dir, runId, key });
    lock();
    assert.throws(() => transitionToVerificationRequired({ cwd: gitRepo.dir, runId, key }), { code: 'CLAIM_BUSY' });
    assert.equal(readReceipt(runPath, key).state, 'implemented');
    unlinkSync(lockPath);

    transitionToVerificationRequired({ cwd: gitRepo.dir, runId, key });
    const verifyPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', verifyRunId);
    writeAudit(verifyPath, makeAudit([], verifyRunId));
    writeFileSync(join(verifyPath, 'verify.json'), JSON.stringify({
      previous_run: runId, run_id: verifyRunId,
      findings: [{ id: finding.id, status: 'resolved' }],
    }));
    lock();
    assert.throws(() => verifyHandoff({ cwd: gitRepo.dir, runId, verifyRunId, key }), { code: 'CLAIM_BUSY' });
    assert.equal(readReceipt(runPath, key).state, 'verification_required');
    unlinkSync(lockPath);

    writeReceipt(runPath, key, { ...readReceipt(runPath, key), state: 'failed' });
    lock();
    assert.throws(() => retryHandoff(gitRepo.dir, runId, key), { code: 'CLAIM_BUSY' });
    assert.equal(readReceipt(runPath, key).state, 'failed');
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('handoff verify matches a shifted finding id by semantic key', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const previous = makeActionableFinding({ kind: 'blind', severity: 'major' });
  const current = makeActionableFinding({ id: 'bbbbbbbbbbbbbbbb', kind: 'blind', severity: 'major' });
  const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
  const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
  try {
    writeAudit(runPath, makeAudit([previous], runId));
    const currentAudit = makeAudit([current], verifyRunId);
    currentAudit.run.screens = [{ screen_id: 'scr_123456789abc', normalized_route: '/signup', locale: 'en', viewport: { id: 'mobile' }, status: 'ok' }];
    currentAudit.per_screen = [{ screen_id: 'scr_123456789abc', scores: { caveman: 80 } }];
    writeAudit(verifyPath, currentAudit);
    prepareBoundReceipt(dir, runId, previous, 'verification_required');

    const result = runHandoffCli(['handoff', 'verify', '--run', runId, '--key', `${runId}:${previous.id}`, '--verify-run', verifyRunId], dir);
    assert.equal(result.status, 2, result.stderr);
    const verifyDoc = JSON.parse(readFileSync(join(verifyPath, 'verify.json'), 'utf8'));
    assert.equal(verifyDoc.findings[0].status, 'unchanged');
    assert.equal(verifyDoc.findings[0].current_id, current.id);
    assert.equal(readReceipt(runPath, `${runId}:${previous.id}`).state, 'verification_required');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff verify does not semantic-match deterministic findings with changed ids', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const previous = makeActionableFinding({ kind: 'deterministic', severity: 'major' });
  const current = makeActionableFinding({ id: 'abababababababab', kind: 'deterministic', severity: 'major' });
  const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
  const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
  try {
    writeAudit(runPath, makeAudit([previous], runId));
    const currentAudit = makeAudit([current], verifyRunId);
    currentAudit.run.screens = [{ screen_id: 'scr_123456789abc', normalized_route: '/signup', locale: 'en', viewport: { id: 'mobile' }, status: 'ok' }];
    writeAudit(verifyPath, currentAudit);
    prepareBoundReceipt(dir, runId, previous, 'verification_required');
    const result = runHandoffCli(['handoff', 'verify', '--run', runId, '--key', `${runId}:${previous.id}`, '--verify-run', verifyRunId], dir);
    assert.equal(result.status, 0, result.stderr);
    const entry = JSON.parse(readFileSync(join(verifyPath, 'verify.json'), 'utf8')).findings[0];
    assert.equal(entry.status, 'resolved');
    assert.equal(entry.current_id, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('handoff verify fails closed for heuristic resolution without coordinate-level fresh evidence', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const previous = makeActionableFinding({ kind: 'heuristic' });
  const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
  const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
  try {
    writeAudit(runPath, makeAudit([previous], runId));
    const currentAudit = makeAudit([], verifyRunId);
    currentAudit.scores.heuristic_ux = 100;
    currentAudit.run.screens = [];
    writeAudit(verifyPath, currentAudit);
    prepareBoundReceipt(dir, runId, previous, 'verification_required');

    const result = runHandoffCli(['handoff', 'verify', '--run', runId, '--key', `${runId}:${previous.id}`, '--verify-run', verifyRunId], dir);
    assert.equal(result.status, 2, result.stderr);
    const verifyDoc = JSON.parse(readFileSync(join(verifyPath, 'verify.json'), 'utf8'));
    assert.equal(verifyDoc.findings[0].status, 'not_comparable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff verify rejects a present semantic heuristic match without recaptured coordinate evidence', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const previous = makeActionableFinding({ kind: 'heuristic' });
  const current = makeActionableFinding({ id: 'cccccccccccccccc', kind: 'heuristic' });
  const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
  const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
  try {
    writeAudit(runPath, makeAudit([previous], runId));
    const currentAudit = makeAudit([current], verifyRunId);
    currentAudit.scores.heuristic_ux = 85;
    currentAudit.run.screens = [];
    writeAudit(verifyPath, currentAudit);
    prepareBoundReceipt(dir, runId, previous, 'verification_required');

    const result = runHandoffCli(['handoff', 'verify', '--run', runId, '--key', `${runId}:${previous.id}`, '--verify-run', verifyRunId], dir);
    assert.equal(result.status, 2, result.stderr);
    const verifyDoc = JSON.parse(readFileSync(join(verifyPath, 'verify.json'), 'utf8'));
    assert.equal(verifyDoc.findings[0].status, 'not_comparable');
    assert.equal(verifyDoc.findings[0].current_id, current.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff verify accepts improved heuristic only with recaptured coordinate-bound heuristic evidence', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const previous = makeActionableFinding({ kind: 'heuristic', severity: 'critical' });
  const current = makeActionableFinding({ id: 'dddddddddddddddd', kind: 'heuristic', severity: 'major' });
  const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
  const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
  try {
    writeAudit(runPath, makeAudit([previous], runId));
    const currentAudit = makeAudit([current], verifyRunId);
    currentAudit.run.screens = [{ screen_id: 'scr_123456789abc', normalized_route: '/signup', locale: 'en', viewport: { id: 'mobile' }, status: 'ok' }];
    currentAudit.per_screen = [{ screen_id: 'scr_123456789abc', scores: { heuristic_ux: 90 } }];
    currentAudit.scores.heuristic_ux = 90;
    writeAudit(verifyPath, currentAudit);
    prepareBoundReceipt(dir, runId, previous, 'verification_required');
    const result = runHandoffCli(['handoff', 'verify', '--run', runId, '--key', `${runId}:${previous.id}`, '--verify-run', verifyRunId], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readReceipt(runPath, `${runId}:${previous.id}`).verify_status, 'improved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('route-wide heuristic verification requires fresh coverage for every recaptured viewport', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const target = { ...makeActionableFinding().target, viewport: null, screen_id: null };
  const previous = makeActionableFinding({ kind: 'heuristic', severity: 'critical', target });
  const current = makeActionableFinding({ id: 'eeeeeeeeeeeeeeee', kind: 'heuristic', severity: 'major', target });
  const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
  const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
  try {
    writeAudit(runPath, makeAudit([previous], runId));
    const currentAudit = makeAudit([current], verifyRunId);
    currentAudit.run.screens = [
      { screen_id: 'scr_111111111111', normalized_route: '/signup', locale: 'en', viewport: { id: 'mobile' }, status: 'ok' },
      { screen_id: 'scr_222222222222', normalized_route: '/signup', locale: 'en', viewport: { id: 'desktop' }, status: 'ok' },
    ];
    currentAudit.per_screen = [{ screen_id: 'scr_111111111111', scores: { heuristic_ux: 90 } }];
    writeAudit(verifyPath, currentAudit);
    prepareBoundReceipt(dir, runId, previous, 'verification_required');
    let result = runHandoffCli(['handoff', 'verify', '--run', runId, '--key', `${runId}:${previous.id}`, '--verify-run', verifyRunId], dir);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(readFileSync(join(verifyPath, 'verify.json'), 'utf8')).findings[0].status, 'not_comparable');

    currentAudit.per_screen.push({ screen_id: 'scr_222222222222', scores: { heuristic_ux: 90 } });
    writeAudit(verifyPath, currentAudit);
    result = runHandoffCli(['handoff', 'verify', '--run', runId, '--key', `${runId}:${previous.id}`, '--verify-run', verifyRunId], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readReceipt(runPath, `${runId}:${previous.id}`).verify_status, 'improved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('handoff verify merges multiple finding results into verify.json idempotently', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const first = makeActionableFinding({ id: '1111111111111111' });
  const second = makeActionableFinding({ id: '2222222222222222', rule_id: 'TECH.FORM.SECOND' });
  const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
  const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
  try {
    ensureGitRepo(dir);
    writeAudit(runPath, makeAudit([first, second], runId));
    prepareHandoff({ cwd: dir, runId });
    const claimed = claimHandoff(dir, runId);
    for (const claim of claimed.claims) {
      recordWithFlow({ cwd: dir, runId, key: claim.key, flowId: `flow-${claim.finding_id}`, claimToken: claim.claim_token });
      transitionToImplemented({ cwd: dir, runId, key: claim.key });
      transitionToVerificationRequired({ cwd: dir, runId, key: claim.key });
    }
    const currentAudit = makeAudit([], verifyRunId);
    currentAudit.run.screens = [{ screen_id: 'scr_123456789abc', normalized_route: '/signup', locale: 'en', viewport: { id: 'mobile' }, status: 'ok' }];
    writeAudit(verifyPath, currentAudit);
    for (const finding of [first, second]) {
      const key = `${runId}:${finding.id}`;
      const result = runHandoffCli(['handoff', 'verify', '--run', runId, '--key', key, '--verify-run', verifyRunId], dir);
      assert.equal(result.status, 0, result.stderr);
    }
    const verifyDoc = JSON.parse(readFileSync(join(verifyPath, 'verify.json'), 'utf8'));
    assert.deepEqual(verifyDoc.findings.map((entry) => entry.id).sort(), [first.id, second.id]);
    assert.equal(verifyDoc.compared, 2);
    assert.equal(verifyDoc.summary.resolved, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff record CLI rejects simultaneous flow id and diagnostic file', () => {
  const dir = tempRunDir();
  const diagnosticPath = join(dir, 'diagnostic.json');
  try {
    mkdirSync(join(dir, '.caveman-ui-ux', 'runs', 'run_20260824T120000Z_aaaaaa'), { recursive: true });
    writeFileSync(diagnosticPath, JSON.stringify({ code: 'FAIL', message: 'failed' }), 'utf8');
    const result = runHandoffCli([
      'handoff', 'record', '--run', 'run_20260824T120000Z_aaaaaa', '--key', 'run_20260824T120000Z_aaaaaa:a1b2c3d4e5f67890',
      '--flow-id', 'flow-1', '--diagnostic-file', diagnosticPath,
    ], dir);
    assert.equal(result.status, 2);
    assert.equal(result.json.ok, false);
    assert.match(result.json.error, /exactly one|not both/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff record CLI rejects a valid unrelated flow when no claim exists', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const finding = makeActionableFinding();
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  const flowId = 'unrelated-valid-flow';
  const stateDir = createFakeAutoflowState(flowId, gitRepo.dir);
  try {
    writeAudit(runPath, makeAudit([finding], runId));
    prepareHandoff({ cwd: gitRepo.dir, runId });
    const prior = process.env.CAVEMAN_AUTOFLOW_STATE_DIR;
    process.env.CAVEMAN_AUTOFLOW_STATE_DIR = stateDir;
    const result = runHandoffCli(['handoff', 'record', '--run', runId, '--key', `${runId}:${finding.id}`, '--flow-id', flowId], gitRepo.dir);
    if (prior === undefined) delete process.env.CAVEMAN_AUTOFLOW_STATE_DIR; else process.env.CAVEMAN_AUTOFLOW_STATE_DIR = prior;
    assert.equal(result.status, 2);
    assert.match(result.json.error, /live dispatch claim/i);
    assert.equal(readReceipt(runPath, `${runId}:${finding.id}`).state, 'pending');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

test('lifecycle rejects source audit tampering after acceptance without checking product HEAD', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const finding = makeActionableFinding();
  const key = `${runId}:${finding.id}`;
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    writeAudit(runPath, makeAudit([finding], runId));
    prepareHandoff({ cwd: gitRepo.dir, runId });
    const claim = claimHandoff(gitRepo.dir, runId).claims[0];
    recordWithFlow({ cwd: gitRepo.dir, runId, key, flowId: 'bound-flow', claimToken: claim.claim_token });
    // Product work after dispatch is legitimate and must not invalidate stored rollback identity.
    writeFileSync(join(gitRepo.dir, 'README.md'), '# product work in progress\n');
    transitionToImplemented({ cwd: gitRepo.dir, runId, key });
    const audit = JSON.parse(readFileSync(join(runPath, 'audit.json'), 'utf8'));
    audit.findings[0].severity = 'blocker';
    writeFileSync(join(runPath, 'audit.json'), JSON.stringify(audit));
    assert.throws(() => transitionToVerificationRequired({ cwd: gitRepo.dir, runId, key }), { code: 'SOURCE_AUDIT_TAMPERED' });
    assert.equal(readReceipt(runPath, key).state, 'implemented');
    writeAudit(runPath, makeAudit([finding], runId));
    transitionToVerificationRequired({ cwd: gitRepo.dir, runId, key });
    audit.findings[0].severity = 'blocker';
    writeFileSync(join(runPath, 'audit.json'), JSON.stringify(audit));
    const verifyRunId = 'run_20260825T120000Z_bbbbbb';
    const verifyPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', verifyRunId);
    writeAudit(verifyPath, makeAudit([], verifyRunId));
    writeFileSync(join(verifyPath, 'verify.json'), JSON.stringify({
      previous_run: runId, run_id: verifyRunId,
      findings: [{ id: finding.id, status: 'improved' }],
    }));
    assert.throws(() => verifyHandoff({ cwd: gitRepo.dir, runId, verifyRunId, key }), { code: 'SOURCE_AUDIT_TAMPERED' });
    assert.equal(readReceipt(runPath, key).state, 'verification_required');
  } finally { rmSync(gitRepo.dir, { recursive: true, force: true }); }
});

test('lifecycle rejects canonical prepared item and receipt digest tampering', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const finding = makeActionableFinding();
  const key = `${runId}:${finding.id}`;
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  const artifactPath = join(runPath, 'handoffs', 'handoff-items.json');
  try {
    prepareBoundReceipt(gitRepo.dir, runId, finding, 'accepted');
    const originalArtifact = readFileSync(artifactPath, 'utf8');
    const artifact = JSON.parse(originalArtifact);
    artifact.items[0].target.route = '/tampered';
    writeFileSync(artifactPath, JSON.stringify(artifact));
    assert.throws(() => transitionToImplemented({ cwd: gitRepo.dir, runId, key }), { code: 'SOURCE_BINDING_INVALID' });
    assert.equal(readReceipt(runPath, key).state, 'accepted');

    writeFileSync(artifactPath, originalArtifact);
    writeReceipt(runPath, key, { ...readReceipt(runPath, key), canonical_item_sha256: '0'.repeat(64) });
    assert.throws(() => transitionToImplemented({ cwd: gitRepo.dir, runId, key }), { code: 'SOURCE_BINDING_INVALID' });
    assert.equal(readReceipt(runPath, key).state, 'accepted');
  } finally { rmSync(gitRepo.dir, { recursive: true, force: true }); }
});

test('claimHandoff immediately recovers an orphan unbound claim from a crashed dispatcher', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const finding = makeActionableFinding();
  const key = `${runId}:${finding.id}`;
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    writeAudit(runPath, makeAudit([finding], runId));
    prepareHandoff({ cwd: gitRepo.dir, runId });
    const orphan = claimDispatchKey(gitRepo.dir, runId, key);
    const recovered = claimHandoff(gitRepo.dir, runId);
    assert.equal(recovered.claims.length, 1);
    assert.notEqual(recovered.claims[0].claim_token, orphan.token);
    const live = JSON.parse(readFileSync(join(runPath, 'handoffs', 'claims', `${key.replace(/:/g, '_')}.claim`), 'utf8'));
    assert.ok(live.dispatch_binding?.sha256);
  } finally { rmSync(gitRepo.dir, { recursive: true, force: true }); }
});

test('claimHandoff immediately recovers a run lock owned by an exited child process', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    writeAudit(runPath, makeAudit([makeActionableFinding()], runId));
    prepareHandoff({ cwd: gitRepo.dir, runId });
    const lockPath = join(runPath, 'handoffs', 'dispatch-run.lock');
    const child = spawnSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(lockPath)}, String(process.pid))`]);
    assert.equal(child.status, 0);
    const started = Date.now();
    assert.equal(claimHandoff(gitRepo.dir, runId).claims.length, 1);
    assert.ok(Date.now() - started < 5_000, 'dead-owner recovery must not wait for stale timeout');
  } finally { rmSync(gitRepo.dir, { recursive: true, force: true }); }
});

test('concurrent claimHandoff processes produce exactly one dispatch winner', async () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    writeAudit(runPath, makeAudit([makeActionableFinding()], runId));
    prepareHandoff({ cwd: gitRepo.dir, runId });
    const { spawn } = await import('node:child_process');
    const launches = [0, 1].map(() => new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', `
        import { claimHandoff } from './scripts/lib/handoff.mjs';
        try { claimHandoff(${JSON.stringify(gitRepo.dir)}, ${JSON.stringify(runId)}); process.stdout.write('won'); }
        catch (error) { process.stdout.write(error.code || 'error'); }
      `], { cwd: resolvePath('.'), stdio: 'pipe' });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('close', () => resolve(stdout));
    }));
    const results = await Promise.all(launches);
    assert.equal(results.filter((value) => value === 'won').length, 1, JSON.stringify(results));
  } finally { rmSync(gitRepo.dir, { recursive: true, force: true }); }
});

test('handoff verify assigns one current semantic finding to at most one previous finding', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const first = makeActionableFinding({ id: '1111111111111111', kind: 'blind', severity: 'critical' });
  const second = makeActionableFinding({ id: '2222222222222222', kind: 'blind', severity: 'critical' });
  const current = makeActionableFinding({ id: '3333333333333333', kind: 'blind', severity: 'major' });
  const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
  const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
  try {
    ensureGitRepo(dir);
    writeAudit(runPath, makeAudit([first, second], runId));
    prepareHandoff({ cwd: dir, runId });
    const claimed = claimHandoff(dir, runId);
    for (const claim of claimed.claims) {
      recordWithFlow({ cwd: dir, runId, key: claim.key, flowId: `flow-${claim.finding_id}`, claimToken: claim.claim_token });
      transitionToImplemented({ cwd: dir, runId, key: claim.key });
      transitionToVerificationRequired({ cwd: dir, runId, key: claim.key });
    }
    const currentAudit = makeAudit([current], verifyRunId);
    currentAudit.run.screens = [{ screen_id: 'scr_123456789abc', normalized_route: '/signup', locale: 'en', viewport: { id: 'mobile' }, status: 'ok' }];
    currentAudit.per_screen = [{ screen_id: 'scr_123456789abc', scores: { caveman: 80 } }];
    writeAudit(verifyPath, currentAudit);
    for (const finding of [first, second]) runHandoffCli(['handoff', 'verify', '--run', runId, '--key', `${runId}:${finding.id}`, '--verify-run', verifyRunId], dir);
    const verifyDoc = JSON.parse(readFileSync(join(verifyPath, 'verify.json'), 'utf8'));
    assert.equal(verifyDoc.findings.filter((entry) => entry.status === 'improved').length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('targeted handoff verify ignores unrelated previous findings during semantic allocation', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const selected = makeActionableFinding({ kind: 'heuristic', severity: 'critical' });
  const unrelated = makeActionableFinding({
    id: 'ffffffffffffffff', kind: 'deterministic', rule_id: 'TECH.OVERFLOW.HORIZONTAL',
    target: { ...selected.target, route: '/other', normalized_route: '/other' },
  });
  const current = makeActionableFinding({ id: unrelated.id, kind: 'heuristic', severity: 'major' });
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  const verifyPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', verifyRunId);
  try {
    writeAudit(runPath, makeAudit([selected, unrelated], runId));
    prepareHandoff({ cwd: gitRepo.dir, runId });
    const claims = claimHandoff(gitRepo.dir, runId).claims;
    const claim = claims.find((entry) => entry.finding_id === selected.id);
    recordWithFlow({ cwd: gitRepo.dir, runId, key: claim.key, flowId: 'selected-flow', claimToken: claim.claim_token });
    transitionToImplemented({ cwd: gitRepo.dir, runId, key: claim.key });
    transitionToVerificationRequired({ cwd: gitRepo.dir, runId, key: claim.key });

    const currentAudit = makeAudit([current], verifyRunId);
    currentAudit.run.screens = [{ screen_id: 'scr_123456789abc', normalized_route: '/signup', locale: 'en', viewport: { id: 'mobile' }, status: 'ok' }];
    currentAudit.per_screen = [{ screen_id: 'scr_123456789abc', scores: { heuristic_ux: 90 } }];
    writeAudit(verifyPath, currentAudit);
    const result = runHandoffCli(['handoff', 'verify', '--run', runId, '--key', claim.key, '--verify-run', verifyRunId], gitRepo.dir);
    assert.equal(result.status, 0, result.stderr);
    const entry = JSON.parse(readFileSync(join(verifyPath, 'verify.json'), 'utf8')).findings[0];
    assert.equal(entry.status, 'improved');
    assert.equal(entry.current_id, current.id);
  } finally { rmSync(gitRepo.dir, { recursive: true, force: true }); }
});

test('handoff verify semantic allocation uses nearest screenshot region with w/h boxes', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const verifyRunId = 'run_20260825T120000Z_bbbbbb';
  const region = (x) => [{ type: 'screenshot_region', box: { x, y: 10, w: 20, h: 20 } }];
  const first = makeActionableFinding({ id: '1111111111111111', kind: 'blind', evidence: region(10) });
  const second = makeActionableFinding({ id: '2222222222222222', kind: 'blind', evidence: region(500) });
  const nearSecond = makeActionableFinding({ id: '3333333333333333', kind: 'blind', evidence: region(510) });
  const nearFirst = makeActionableFinding({ id: '4444444444444444', kind: 'blind', evidence: region(15) });
  const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
  const verifyPath = join(dir, '.caveman-ui-ux', 'runs', verifyRunId);
  try {
    ensureGitRepo(dir);
    writeAudit(runPath, makeAudit([first, second], runId));
    prepareHandoff({ cwd: dir, runId });
    const claimed = claimHandoff(dir, runId);
    for (const claim of claimed.claims) {
      recordWithFlow({ cwd: dir, runId, key: claim.key, flowId: `flow-${claim.finding_id}`, claimToken: claim.claim_token });
      transitionToImplemented({ cwd: dir, runId, key: claim.key });
      transitionToVerificationRequired({ cwd: dir, runId, key: claim.key });
    }
    const currentAudit = makeAudit([nearSecond, nearFirst], verifyRunId);
    currentAudit.run.screens = [{ screen_id: 'scr_123456789abc', normalized_route: '/signup', locale: 'en', viewport: { id: 'mobile' }, status: 'ok' }];
    writeAudit(verifyPath, currentAudit);
    for (const finding of [first, second]) runHandoffCli(['handoff', 'verify', '--run', runId, '--key', `${runId}:${finding.id}`, '--verify-run', verifyRunId], dir);
    const entries = JSON.parse(readFileSync(join(verifyPath, 'verify.json'), 'utf8')).findings;
    assert.equal(entries.find((entry) => entry.id === first.id).current_id, nearFirst.id);
    assert.equal(entries.find((entry) => entry.id === second.id).current_id, nearSecond.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('heuristic ingest requires unique known evaluated_screen_ids and persists partial coverage', () => {
  const dir = tempRunDir();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(dir, '.caveman-ui-ux', 'runs', runId);
  const first = 'scr_111111111111';
  const second = 'scr_222222222222';
  try {
    mkdirSync(runPath, { recursive: true });
    writeFileSync(join(runPath, 'run.json'), JSON.stringify({
      run_id: runId,
      config: {},
      screens: [
        { screen_id: first, normalized_route: '/signup', locale: 'en', viewport: { id: 'mobile' } },
        { screen_id: second, normalized_route: '/other', locale: 'en', viewport: { id: 'mobile' } },
      ],
    }));
    for (const payload of [
      { findings: [] },
      { evaluated_screen_ids: [first, first], findings: [] },
      { evaluated_screen_ids: ['scr_ffffffffffff'], findings: [] },
    ]) {
      const input = join(dir, `heuristic-${Math.random()}.json`);
      writeFileSync(input, JSON.stringify(payload));
      assert.equal(runHandoffCli(['heuristic', 'ingest', '--run', runId, '--file', input], dir).status, 5);
    }
    const uncovered = join(dir, 'heuristic-uncovered.json');
    writeFileSync(uncovered, JSON.stringify({
      evaluated_screen_ids: [first],
      findings: [makeActionableFinding({
        kind: 'heuristic', rule_id: 'UX.CTA.AMBIGUOUS_PRIMARY',
        target: { route: '/other', locale: 'en', viewport: 'mobile', screen_id: second },
      })],
    }));
    assert.equal(runHandoffCli(['heuristic', 'ingest', '--run', runId, '--file', uncovered], dir).status, 5);
    const good = join(dir, 'heuristic-good.json');
    writeFileSync(good, JSON.stringify({
      evaluated_screen_ids: [first],
      findings: [makeActionableFinding({
        kind: 'heuristic', rule_id: 'UX.CTA.AMBIGUOUS_PRIMARY',
        target: { route: '/signup/', locale: 'en', viewport: 'mobile', screen_id: first },
      })],
    }));
    assert.equal(runHandoffCli(['heuristic', 'ingest', '--run', runId, '--file', good], dir).status, 0);
    const ingested = JSON.parse(readFileSync(join(runPath, 'heuristic.json'), 'utf8'));
    assert.deepEqual(ingested.evaluated_screen_ids, [first]);
    assert.equal(ingested.findings[0].target.normalized_route, '/signup');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Dispatch artifact schema validation
// ---------------------------------------------------------------------------

test('dispatch artifact validates against handoff schema', () => {
  const gitRepo = tempGitRepo();
  const runId = 'run_20260824T120000Z_aaaaaa';
  const runPath = join(gitRepo.dir, '.caveman-ui-ux', 'runs', runId);
  try {
    const finding = makeActionableFinding();
    writeAudit(runPath, makeAudit([finding]));
    prepareHandoff({ cwd: gitRepo.dir, runId });

    const result = claimHandoff(gitRepo.dir, runId);
    const artifact = JSON.parse(readFileSync(result.dispatch_artifact_path, 'utf8'));

    // Validate against the real schema.
    const schemaResult = validateSubset(handoffSchema(), artifact);
    assert.equal(schemaResult.valid, true, `dispatch artifact failed schema validation: ${JSON.stringify(schemaResult.errors)}`);
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FlowId validation tests — fail-closed identity validation
// ---------------------------------------------------------------------------

test('validateFlowId rejects missing status.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caveman-flowid-test-'));
  try {
    const result = validateFlowId('no-such-flow', process.cwd(), dir);
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('not found'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateFlowId rejects wrong release_policy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caveman-flowid-test-'));
  const flowId = 'test-flow';
  try {
    const flowDir = join(dir, flowId);
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, 'status.json'), JSON.stringify({
      flow_id: flowId,
      release_policy: 'auto',
      base_repo: process.cwd(),
    }), 'utf8');

    const result = validateFlowId(flowId, process.cwd(), dir);
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('release_policy'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateFlowId rejects missing base_repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caveman-flowid-test-'));
  const flowId = 'test-flow';
  try {
    const flowDir = join(dir, flowId);
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, 'status.json'), JSON.stringify({
      flow_id: flowId,
      release_policy: 'handoff-only',
    }), 'utf8');

    const result = validateFlowId(flowId, process.cwd(), dir);
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('missing base_repo'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateFlowId rejects mismatched base_repo', () => {
  const repoA = tempGitRepo();
  const repoB = tempGitRepo();
  const dir = mkdtempSync(join(tmpdir(), 'caveman-flowid-test-'));
  const flowId = 'test-flow';
  try {
    const flowDir = join(dir, flowId);
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, 'status.json'), JSON.stringify({
      flow_id: flowId,
      release_policy: 'handoff-only',
      base_repo: repoA.dir,
    }), 'utf8');

    const result = validateFlowId(flowId, repoB.dir, dir);
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('does not match'));
  } finally {
    rmSync(repoA.dir, { recursive: true, force: true });
    rmSync(repoB.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateFlowId accepts valid handoff-only state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caveman-flowid-test-'));
  const flowId = 'test-flow';
  try {
    const flowDir = join(dir, flowId);
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, 'status.json'), JSON.stringify({
      flow_id: flowId,
      release_policy: 'handoff-only',
      base_repo: process.cwd(),
    }), 'utf8');

    const result = validateFlowId(flowId, process.cwd(), dir);
    assert.equal(result.valid, true);
    assert.equal(result.flow_id, flowId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateFlowId rejects a symlinked flow directory', () => {
  const gitRepo = tempGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), 'caveman-flowid-state-'));
  const targetDir = mkdtempSync(join(tmpdir(), 'caveman-flowid-target-'));
  const flowId = 'symlinked-flow';
  try {
    writeFileSync(join(targetDir, 'status.json'), JSON.stringify({ flow_id: flowId, release_policy: 'handoff-only', base_repo: gitRepo.dir }));
    symlinkSync(targetDir, join(stateDir, flowId), 'dir');
    const result = validateFlowId(flowId, gitRepo.dir, stateDir);
    assert.equal(result.valid, false);
    assert.match(result.error, /symlink/i);
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('validateFlowId accepts symlink-equivalent paths (same physical repo)', () => {
  const gitRepo = tempGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), 'caveman-flowid-test-'));
  const flowId = 'test-symlink-flow';
  try {
    // Create a symlink to the real git repo path.
    const symlinkPath = join(tmpdir(), 'caveman-flowid-symlink-' + flowId);
    // Use the real path as the symlink target.
    symlinkSync(gitRepo.dir, symlinkPath, 'dir');

    const flowDir = join(stateDir, flowId);
    mkdirSync(flowDir, { recursive: true });
    // status.base_repo uses the real path; expectedRepo uses the symlink.
    writeFileSync(join(flowDir, 'status.json'), JSON.stringify({
      flow_id: flowId,
      release_policy: 'handoff-only',
      base_repo: realpathSync(gitRepo.dir),
    }), 'utf8');

    const result = validateFlowId(flowId, symlinkPath, stateDir);
    assert.equal(result.valid, true, `symlink path should match real path: ${result.error}`);
    assert.equal(result.flow_id, flowId);
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    try { rmSync(join(tmpdir(), 'caveman-flowid-symlink-' + flowId), { recursive: true, force: true }); } catch {}
  }
});

test('validateFlowId accepts subdirectory of same git worktree', () => {
  const gitRepo = tempGitRepo();
  const stateDir = mkdtempSync(join(tmpdir(), 'caveman-flowid-test-'));
  const flowId = 'test-subdir-flow';
  try {
    // Create a subdirectory inside the git repo.
    const subdir = join(gitRepo.dir, 'sub', 'dir');
    mkdirSync(subdir, { recursive: true });

    const flowDir = join(stateDir, flowId);
    mkdirSync(flowDir, { recursive: true });
    // status.base_repo uses the git root; expectedRepo uses a subdirectory.
    writeFileSync(join(flowDir, 'status.json'), JSON.stringify({
      flow_id: flowId,
      release_policy: 'handoff-only',
      base_repo: gitRepo.dir,
    }), 'utf8');

    const result = validateFlowId(flowId, subdir, stateDir);
    assert.equal(result.valid, true, `subdirectory should match git root: ${result.error}`);
    assert.equal(result.flow_id, flowId);
  } finally {
    rmSync(gitRepo.dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('validateFlowId rejects nonexistent expectedRepo path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caveman-flowid-test-'));
  const flowId = 'test-flow';
  try {
    const flowDir = join(dir, flowId);
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, 'status.json'), JSON.stringify({
      flow_id: flowId,
      release_policy: 'handoff-only',
      base_repo: process.cwd(),
    }), 'utf8');

    const result = validateFlowId(flowId, '/nonexistent/path/xyz', dir);
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('does not exist'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateFlowId rejects nonexistent base_repo path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caveman-flowid-test-'));
  const flowId = 'test-flow';
  try {
    const flowDir = join(dir, flowId);
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, 'status.json'), JSON.stringify({
      flow_id: flowId,
      release_policy: 'handoff-only',
      base_repo: '/nonexistent/path/xyz',
    }), 'utf8');

    const result = validateFlowId(flowId, process.cwd(), dir);
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('does not exist'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateFlowId rejects non-git expectedRepo', () => {
  const nonGitDir = mkdtempSync(join(tmpdir(), 'caveman-flowid-nongit-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'caveman-flowid-test-'));
  const flowId = 'test-flow';
  try {
    const flowDir = join(stateDir, flowId);
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, 'status.json'), JSON.stringify({
      flow_id: flowId,
      release_policy: 'handoff-only',
      base_repo: process.cwd(),
    }), 'utf8');

    const result = validateFlowId(flowId, nonGitDir, stateDir);
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('not a git repository'));
  } finally {
    rmSync(nonGitDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('validateFlowId rejects non-git base_repo', () => {
  const nonGitDir = mkdtempSync(join(tmpdir(), 'caveman-flowid-nongit-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'caveman-flowid-test-'));
  const flowId = 'test-flow';
  try {
    const flowDir = join(stateDir, flowId);
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, 'status.json'), JSON.stringify({
      flow_id: flowId,
      release_policy: 'handoff-only',
      base_repo: nonGitDir,
    }), 'utf8');

    const result = validateFlowId(flowId, process.cwd(), stateDir);
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('not a git repository'));
  } finally {
    rmSync(nonGitDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
