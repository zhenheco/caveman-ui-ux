// AC-002: a blind payload must carry exactly the 7 allowed keys and leak nothing
// about host, route, page title, filesystem paths or source. Pure unit test, no browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALLOWED_PAYLOAD_KEYS,
  FORBIDDEN_SUBSTRINGS,
  assertNoLeakage,
  blindPayload,
} from '../lib/blind.mjs';
import { screenId } from '../lib/ids.mjs';

const RUN_ID = 'run_20260819T154201Z_a1b2c3';
const ROUTE = '/pricing/enterprise';
const LOCALE = 'zh-TW';
const HOST = 'acme-invoicing.example.com';
const BASE_URL = `https://${HOST}`;
const URL_STRING = `${BASE_URL}/zh-TW/pricing/enterprise`;
const TITLE = 'Acme Invoicing — Enterprise Pricing';
const VIEWPORT = { id: 'mobile', width: 375, height: 812, device_scale_factor: 2 };
const SCREEN_ID = screenId(RUN_ID, ROUTE, LOCALE, VIEWPORT.id);
const SCREEN_DIR_RE = /^scr_[0-9a-f]{12}$/;

const screenRecord = {
  screen_id: SCREEN_ID,
  route: ROUTE,
  normalized_route: ROUTE,
  url: URL_STRING,
  locale: LOCALE,
  viewport: VIEWPORT,
  http_status: 200,
  status: 'ok',
  error: null,
  screenshot: {
    path: `.caveman-ui-ux/runs/${RUN_ID}/screens/${SCREEN_ID}/screenshot.png`,
    bytes: 40213,
    sha256: 'a'.repeat(64),
  },
  redacted: [],
};

const config = {
  report_locale: 'zh-TW',
  target: { base_url: BASE_URL, routes: ['/', ROUTE] },
  evaluation: {},
};

const context = {
  baseUrl: BASE_URL,
  routes: ['/', ROUTE],
  sealed: {
    [SCREEN_ID]: { route: ROUTE, url: URL_STRING, locale: LOCALE, viewport: VIEWPORT.id, title: TITLE },
  },
};

/** Violation kinds returned for a payload, deduplicated and sorted. */
function kindsFor(payload) {
  const result = assertNoLeakage(payload, context);
  return [...new Set(result.violations.map((violation) => violation.kind))].sort();
}

test('blind payload exposes exactly the 7 allowed keys', () => {
  const payload = blindPayload(screenRecord, config);
  assert.equal(ALLOWED_PAYLOAD_KEYS.length, 7);
  assert.deepEqual(Object.keys(payload).sort(), [...ALLOWED_PAYLOAD_KEYS].sort());
  assert.equal(payload.screen_id, SCREEN_ID);
  assert.equal(payload.target_locale, LOCALE);
  assert.equal(payload.report_locale, 'zh-TW');
  assert.equal(payload.profile, 'generic');
  assert.equal(payload.task_framing, null);
  assert.deepEqual(payload.viewport, VIEWPORT);
});

test('screenshot path is scoped to the opaque screen directory', () => {
  const payload = blindPayload(screenRecord, config);
  const parts = payload.screenshot_path.split('/');
  assert.match(parts[parts.length - 2], SCREEN_DIR_RE);
  assert.equal(parts[parts.length - 1], 'screenshot.png');
});

test('a payload built from a real ScreenRecord is clean', () => {
  const result = assertNoLeakage(blindPayload(screenRecord, config), context);
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
});

test('an injected route key is a forbidden_key violation', () => {
  const payload = { ...blindPayload(screenRecord, config), route: ROUTE };
  assert.ok(kindsFor(payload).includes('forbidden_key'));
});

test('a route slug inside screenshot_path is a route_leak', () => {
  const payload = {
    ...blindPayload(screenRecord, config),
    screenshot_path: `.caveman-ui-ux/runs/${RUN_ID}/screens/${SCREEN_ID}/pricing-enterprise.png`,
  };
  assert.ok(kindsFor(payload).includes('route_leak'));
});

test('the target host inside task_framing is a host_leak', () => {
  const payload = {
    ...blindPayload(screenRecord, config),
    profile: 'task',
    task_framing: `The visitor arrived from ${HOST} and wants to compare plans.`,
  };
  assert.deepEqual(kindsFor(payload), ['host_leak']);
});

test('the sealed page title inside task_framing is a title_leak', () => {
  const payload = {
    ...blindPayload(screenRecord, config),
    profile: 'task',
    task_framing: `Decide whether ${TITLE} is understandable.`,
  };
  assert.ok(kindsFor(payload).includes('title_leak'));
});

test('an extra unknown key is an unknown_key violation', () => {
  const payload = { ...blindPayload(screenRecord, config), extra_notes: 'nothing sensitive' };
  assert.deepEqual(kindsFor(payload), ['unknown_key']);
});

test('a repository file reference is a path_leak', () => {
  const payload = {
    ...blindPayload(screenRecord, config),
    profile: 'task',
    task_framing: 'See README.md before judging the screen.',
  };
  assert.deepEqual(kindsFor(payload), ['path_leak']);
  assert.ok(FORBIDDEN_SUBSTRINGS.includes('readme'));
  assert.ok(Object.isFrozen(FORBIDDEN_SUBSTRINGS));
  assert.ok(Object.isFrozen(ALLOWED_PAYLOAD_KEYS));
});
