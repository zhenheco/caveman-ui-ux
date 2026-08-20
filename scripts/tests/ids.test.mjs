// Contract §7 / §19 — id determinism, id shapes and finding-id stability under jitter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sha12,
  sha16,
  newRunId,
  screenId,
  deterministicFindingId,
  heuristicFindingId,
  quantizeRegion,
  stableSelector,
} from '../lib/ids.mjs';

const MOBILE = { width: 375, height: 812 };

test('sha16 / sha12 are deterministic and correctly sized', () => {
  assert.match(sha16('abc'), /^[0-9a-f]{16}$/);
  assert.match(sha12('abc'), /^[0-9a-f]{12}$/);
  assert.equal(sha16('abc'), sha16('abc'));
  assert.notEqual(sha16('abc'), sha16('abd'));
  assert.equal(sha16('abc').slice(0, 12), sha12('abc'));
});

test('newRunId stamps UTC, never local time', () => {
  const runId = newRunId(new Date(Date.UTC(2026, 7, 19, 15, 42, 1, 987)));
  assert.match(runId, /^run_\d{8}T\d{6}Z_[0-9a-f]{6}$/);
  assert.equal(runId.slice(0, 21), 'run_20260819T154201Z_');
  assert.notEqual(newRunId(), newRunId());
});

test('screenId is opaque, 12 hex, and reproducible', () => {
  const a = screenId('run_20260819T154201Z_a1b2c3', '/pricing', 'zh-TW', 'mobile');
  const b = screenId('run_20260819T154201Z_a1b2c3', '/pricing', 'zh-TW', 'mobile');
  assert.match(a, /^scr_[0-9a-f]{12}$/);
  assert.equal(a, b);
  for (const [runId, route, locale, viewport] of [
    ['run_other', '/pricing', 'zh-TW', 'mobile'],
    ['run_20260819T154201Z_a1b2c3', '/other', 'zh-TW', 'mobile'],
    ['run_20260819T154201Z_a1b2c3', '/pricing', 'ja', 'mobile'],
    ['run_20260819T154201Z_a1b2c3', '/pricing', 'zh-TW', 'desktop'],
  ]) {
    assert.notEqual(screenId(runId, route, locale, viewport), a, `${runId}|${route}|${locale}|${viewport}`);
  }
});

test('deterministicFindingId is 16 hex and keyed on every input', () => {
  const base = {
    ruleId: 'TECH.FORM.MISSING_LABEL',
    normalizedRoute: '/signup',
    locale: 'zh-TW',
    viewport: 'mobile',
    stableSelector: '#email',
  };
  const id = deterministicFindingId(base);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(id, deterministicFindingId({ ...base }));
  assert.notEqual(id, deterministicFindingId({ ...base, stableSelector: '#password' }));
  assert.notEqual(id, deterministicFindingId({ ...base, locale: 'ja' }));
  assert.notEqual(id, deterministicFindingId({ ...base, ruleId: 'TECH.LINK.BROKEN' }));
});

test('quantizeRegion snaps to the 5% grid', () => {
  // 18.75/375 = 0.05, 81.2/812 = 0.10, 337.5/375 = 0.90, 121.8/812 = 0.15
  assert.equal(
    quantizeRegion({ x: 18.75, y: 81.2, w: 337.5, h: 121.8 }, MOBILE),
    'x:0.05,y:0.10,w:0.90,h:0.15',
  );
  // 8px on a 375px axis is 0.0213 -> nearest 5% cell is 0.00
  assert.equal(quantizeRegion({ x: 8, y: 0, w: 375, h: 812 }, MOBILE), 'x:0.00,y:0.00,w:1.00,h:1.00');
  assert.equal(quantizeRegion({ x: 187.5, y: 406, w: 0, h: 0 }, MOBILE), 'x:0.50,y:0.50,w:0.00,h:0.00');
});

test('quantizeRegion clamps to 0..1 and falls back for a null box', () => {
  assert.equal(quantizeRegion({ x: -400, y: -50, w: 4000, h: 9000 }, MOBILE), 'x:0.00,y:0.00,w:1.00,h:1.00');
  assert.equal(quantizeRegion(null, MOBILE), 'x:0,y:0,w:1,h:1');
  assert.equal(quantizeRegion({ x: 1, y: 1, w: 1, h: 1 }, null), 'x:0,y:0,w:1,h:1');
  assert.equal(quantizeRegion({ x: 'nope', y: 1, w: 1, h: 1 }, MOBILE), 'x:0,y:0,w:1,h:1');
  assert.equal(quantizeRegion({ x: 18.75, y: 81.2, width: 337.5, height: 121.8 }, MOBILE), 'x:0.05,y:0.10,w:0.90,h:0.15');
});

test('heuristicFindingId survives 2px jitter but not a 25% move', () => {
  const base = { ruleId: 'UX.CTA.AMBIGUOUS_PRIMARY', normalizedRoute: '/', locale: 'auto', viewport: 'mobile', viewportSize: MOBILE };
  // Box chosen away from the 5% cell boundaries; +-2px stays inside the same cell.
  const jittered = heuristicFindingId({ ...base, region: { x: 42, y: 92, w: 302, h: 122 } });
  const original = heuristicFindingId({ ...base, region: { x: 40, y: 90, w: 300, h: 120 } });
  const negative = heuristicFindingId({ ...base, region: { x: 38, y: 88, w: 298, h: 118 } });
  assert.match(original, /^[0-9a-f]{16}$/);
  assert.equal(jittered, original);
  assert.equal(negative, original);
  // 25% of the viewport width is ~94px: a different cell, therefore a different finding.
  const moved = heuristicFindingId({ ...base, region: { x: 134, y: 90, w: 300, h: 120 } });
  assert.notEqual(moved, original);
});

test('heuristicFindingId with a null region is still stable', () => {
  const base = { ruleId: 'UX.COPY.JARGON', normalizedRoute: '/', locale: 'auto', viewport: 'desktop', viewportSize: { width: 1280, height: 800 } };
  assert.equal(heuristicFindingId({ ...base, region: null }), heuristicFindingId({ ...base, region: null }));
  assert.notEqual(
    heuristicFindingId({ ...base, region: null }),
    heuristicFindingId({ ...base, region: { x: 0, y: 0, w: 100, h: 100 } }),
  );
});

test('stableSelector prefers #id, then an nth-of-type path', () => {
  assert.equal(stableSelector({ id: 'email', tagName: 'INPUT' }), '#email');
  assert.equal(stableSelector({ id: '2col', tagName: 'DIV' }), '[id="2col"]');
  assert.equal(stableSelector('main > form:nth-of-type(1)'), 'main > form:nth-of-type(1)');
  assert.equal(stableSelector({ selector: 'main .cta' }), 'main .cta');
  assert.equal(
    stableSelector({ tagName: 'INPUT', nthOfType: 2, parent: { tagName: 'FORM', nthOfType: 1 } }),
    'form:nth-of-type(1) > input:nth-of-type(2)',
  );
  assert.equal(stableSelector(null), '');
});
