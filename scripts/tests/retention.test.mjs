// privacy.retention_days is the only mitigation the docs offer for "screenshots may contain
// sensitive data", and blind staging puts a second copy of every screenshot outside the project.
// These assertions are the proof surface for both: what gets deleted, what must never be, and
// that a symlink or a crafted run id cannot walk the sweep out of the two roots it owns.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { pruneRuns, stagedBlindDir } from '../lib/retention.mjs';

const OLD_RUN = 'run_20260101T000000Z_aaaaaa';
const NEW_RUN = 'run_20260818T120000Z_bbbbbb';
const ORPHAN_RUN = 'run_20251201T000000Z_cccccc';
const NOW = new Date('2026-08-19T00:00:00Z');

const savedStateDir = process.env.CAVEMAN_STATE_DIR;
let sandbox;
let cwd;
let state;

/** Fresh cwd + CAVEMAN_STATE_DIR pair, so the sweep never touches the real home state dir. */
function makeSandbox() {
  sandbox = mkdtempSync(join(tmpdir(), 'caveman-retention-'));
  cwd = join(sandbox, 'project');
  state = join(sandbox, 'state');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(state, { recursive: true });
  process.env.CAVEMAN_STATE_DIR = state;
}

/** Create a run dir with one read-only screenshot, mirroring what capture() leaves behind. */
function makeRun(runId, bytes = 64) {
  const dir = join(cwd, '.caveman-ui-ux', 'runs', runId, 'screens', 'scr_0123456789ab');
  mkdirSync(dir, { recursive: true });
  const shot = join(dir, 'screenshot.png');
  writeFileSync(shot, Buffer.alloc(bytes));
  chmodSync(shot, 0o444);
  return join(cwd, '.caveman-ui-ux', 'runs', runId);
}

/** Create the staged blind copy for a run id under the state dir. */
function makeStaged(runId, bytes = 32) {
  const dir = stagedBlindDir(runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scr_0123456789ab.png'), Buffer.alloc(bytes));
  return dir;
}

beforeEach(() => {
  makeSandbox();
});

after(() => {
  if (savedStateDir === undefined) delete process.env.CAVEMAN_STATE_DIR;
  else process.env.CAVEMAN_STATE_DIR = savedStateDir;
});

describe('pruneRuns', () => {
  test('retention_days <= 0 disables the sweep entirely', () => {
    const run = makeRun(OLD_RUN);
    const staged = makeStaged(ORPHAN_RUN);
    for (const days of [0, -1, undefined, null, 'never']) {
      const result = pruneRuns({ cwd, retentionDays: days, now: NOW });
      assert.deepEqual(result, { removedRuns: [], removedStaged: [], freedBytes: 0 }, `days=${days}`);
    }
    assert.ok(existsSync(run), 'a disabled sweep must not delete a run');
    assert.ok(existsSync(staged), 'a disabled sweep must not delete staged screenshots');
  });

  test('a run older than retention_days is deleted with its staged screenshots', () => {
    const run = makeRun(OLD_RUN, 100);
    const staged = makeStaged(OLD_RUN, 50);
    const lines = [];
    const result = pruneRuns({ cwd, retentionDays: 30, now: NOW, log: (m) => lines.push(m) });
    assert.deepEqual(result.removedRuns, [OLD_RUN]);
    assert.deepEqual(result.removedStaged, [OLD_RUN]);
    assert.equal(result.freedBytes, 150);
    assert.ok(!existsSync(run), 'expired run dir survived');
    assert.ok(!existsSync(staged), 'staged blind screenshots survived their run');
    assert.equal(lines.length, 2, 'both deletions must be logged');
  });

  test('a run inside the window is untouched, staged copy included', () => {
    const run = makeRun(NEW_RUN);
    const staged = makeStaged(NEW_RUN);
    const result = pruneRuns({ cwd, retentionDays: 30, now: NOW });
    assert.deepEqual(result.removedRuns, []);
    assert.deepEqual(result.removedStaged, []);
    assert.ok(existsSync(run) && existsSync(staged), 'a live run must keep both copies');
  });

  test('age comes from the run id, not mtime: a freshly written expired run still goes', () => {
    // makeRun() writes now, so mtime is seconds old while the id says 2026-01-01.
    makeRun(OLD_RUN);
    const result = pruneRuns({ cwd, retentionDays: 30, now: NOW });
    assert.deepEqual(result.removedRuns, [OLD_RUN]);
  });

  test('a staging dir whose run no longer exists is reclaimed', () => {
    const orphan = makeStaged(ORPHAN_RUN, 21);
    const result = pruneRuns({ cwd, retentionDays: 30, now: NOW });
    assert.deepEqual(result.removedRuns, []);
    assert.deepEqual(result.removedStaged, [ORPHAN_RUN]);
    assert.equal(result.freedBytes, 21);
    assert.ok(!existsSync(orphan), 'orphan staging dir survived');
  });

  test('nothing outside the two roots is ever deleted', () => {
    const outside = join(sandbox, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), 'precious');

    // 1. A symlinked run dir with an expired id: resolving it leaves the runs root.
    const runsRoot = join(cwd, '.caveman-ui-ux', 'runs');
    mkdirSync(runsRoot, { recursive: true });
    symlinkSync(outside, join(runsRoot, OLD_RUN), 'dir');
    // 2. A symlinked orphan staging dir: resolving it leaves the state dir.
    mkdirSync(join(state, 'blind'), { recursive: true });
    symlinkSync(outside, join(state, 'blind', ORPHAN_RUN), 'dir');
    // 3. Crafted names: not a run id, and a run id whose date rolls over (month 13).
    const notARun = join(runsRoot, 'not_a_run_20260101T000000Z_dddddd');
    const rolledOver = join(runsRoot, 'run_20261301T000000Z_eeeeee');
    mkdirSync(notARun, { recursive: true });
    mkdirSync(rolledOver, { recursive: true });

    const result = pruneRuns({ cwd, retentionDays: 30, now: NOW });
    assert.deepEqual(result.removedRuns, [], 'a symlinked or crafted run dir must not count as removed');
    assert.deepEqual(result.removedStaged, [], 'a symlinked staging dir must not count as removed');
    assert.equal(result.freedBytes, 0);
    assert.ok(existsSync(join(outside, 'keep.txt')), 'the sweep followed a symlink out of its root');
    assert.ok(existsSync(notARun), 'a dir that is not a run was deleted');
    assert.ok(existsSync(rolledOver), 'a run id with an impossible date must not be date-guessed');
  });

  test('missing roots are a no-op, and a second sweep is idempotent', () => {
    const empty = pruneRuns({ cwd, retentionDays: 30, now: NOW });
    assert.deepEqual(empty, { removedRuns: [], removedStaged: [], freedBytes: 0 });

    makeRun(OLD_RUN, 10);
    makeStaged(OLD_RUN, 10);
    makeRun(NEW_RUN, 10);
    const first = pruneRuns({ cwd, retentionDays: 30, now: NOW });
    assert.deepEqual(first.removedRuns, [OLD_RUN]);
    const second = pruneRuns({ cwd, retentionDays: 30, now: NOW });
    assert.deepEqual(second, { removedRuns: [], removedStaged: [], freedBytes: 0 }, 'second sweep must find nothing');
    assert.ok(existsSync(join(cwd, '.caveman-ui-ux', 'runs', NEW_RUN)), 'the live run must survive both sweeps');
  });
});

describe('stagedBlindDir', () => {
  test('is the path stageBlindScreenshot writes to, under the state dir', () => {
    assert.equal(stagedBlindDir(NEW_RUN), join(state, 'blind', NEW_RUN));
  });
});
