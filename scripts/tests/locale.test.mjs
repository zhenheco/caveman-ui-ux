// AC-004: the four shipped locales must carry exactly the contract §14 key set, be fully
// translated, and resolve through the documented fallback chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REQUIRED_KEYS, availableLocales, loadLocale, localeCompleteness, localeDir, t,
} from '../lib/locale.mjs';

const LOCALES = ['en', 'zh-TW', 'ja', 'vi'];

// Keys whose English value is a technical token that translators legitimately keep as is:
// 'Run ID' is the artifact's own field name, 'CTA' and 'hreflang' are the industry terms used
// verbatim in zh-TW/ja/vi UX and SEO writing (same class as 'Lighthouse' or 'axe-core').
const UNTRANSLATED_ALLOWLIST = new Set(['report.run_id', 'matrix.cta', 'matrix.hreflang']);

/** Read one locale JSON file directly, bypassing the fallback merge in loadLocale. */
function readRaw(code) {
  return JSON.parse(readFileSync(join(localeDir(), `${code}.json`), 'utf8'));
}

/** Sorted symmetric difference of two key sets, for readable assertion messages. */
function symmetricDifference(actual, expected) {
  const a = new Set(actual);
  const b = new Set(expected);
  return {
    extra: [...a].filter((key) => !b.has(key)).sort(),
    missing: [...b].filter((key) => !a.has(key)).sort(),
  };
}

test('REQUIRED_KEYS is the contract key list with no duplicates', () => {
  assert.equal(new Set(REQUIRED_KEYS).size, REQUIRED_KEYS.length, 'REQUIRED_KEYS contains duplicates');
  assert.ok(REQUIRED_KEYS.length > 0);
});

test('availableLocales() lists exactly the four shipped locales', () => {
  assert.deepEqual(availableLocales(), ['en', 'ja', 'vi', 'zh-TW']);
});

for (const code of LOCALES) {
  test(`${code}.json matches the contract key set and is fully populated`, () => {
    const path = join(localeDir(), `${code}.json`);
    assert.ok(existsSync(path), `missing locale file ${path}`);

    const dict = readRaw(code);
    const diff = symmetricDifference(Object.keys(dict), REQUIRED_KEYS);
    assert.deepEqual(
      diff,
      { extra: [], missing: [] },
      `${code}.json key set differs from contract §14 — missing: ${JSON.stringify(diff.missing)}, extra: ${JSON.stringify(diff.extra)}`,
    );

    for (const key of REQUIRED_KEYS) {
      const value = dict[key];
      assert.equal(typeof value, 'string', `${code}.${key} is not a string`);
      assert.notEqual(value.trim(), '', `${code}.${key} is empty`);
    }
  });
}

test('zh-TW, ja and vi are actually translated, not copies of the English master', () => {
  const master = readRaw('en');
  for (const code of ['zh-TW', 'ja', 'vi']) {
    const dict = readRaw(code);
    const untranslated = REQUIRED_KEYS
      .filter((key) => !UNTRANSLATED_ALLOWLIST.has(key))
      .filter((key) => dict[key] === master[key]);
    assert.deepEqual(untranslated, [], `${code}.json still holds the English value for: ${untranslated.join(', ')}`);
  }
});

test('localeCompleteness() reports 100% completeness against the en master (AC-004)', () => {
  const result = localeCompleteness();
  assert.equal(result.master, 'en');
  assert.deepEqual(result.missing, {});
  assert.deepEqual(result.extra, {});
  assert.equal(result.complete, true);
});

test('loadLocale falls back exact -> base language -> en', () => {
  assert.deepEqual(loadLocale('ja-JP').chain, ['ja', 'en']);
  assert.equal(loadLocale('ja-JP').code, 'ja');
  assert.deepEqual(loadLocale('zh-TW').chain, ['zh-TW', 'en']);
  assert.deepEqual(loadLocale('en').chain, ['en']);
  assert.deepEqual(loadLocale('kl-GL').chain, ['en'], 'an unknown locale resolves to the master only');
});

test('loadLocale merges the chain so every contract key renders', () => {
  for (const code of [...LOCALES, 'ja-JP', 'zh-Hant-TW', 'kl-GL']) {
    const { dict } = loadLocale(code);
    for (const key of REQUIRED_KEYS) {
      assert.equal(typeof dict[key], 'string', `${code} cannot render ${key}`);
    }
  }
});

test('t() substitutes placeholders and never throws on a missing key', () => {
  const { dict } = loadLocale('en');
  assert.equal(t(dict, 'finding.count', { count: 3 }), '3 findings');
  assert.equal(t(dict, 'no.such.key'), 'no.such.key');
  assert.equal(t(null, 'no.such.key'), 'no.such.key');
  assert.equal(t(dict, 'finding.count'), '{{count}} findings', 'an unsupplied var stays literal');
});
