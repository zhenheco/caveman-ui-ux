// Contract §17: the core rule pack must be valid AND must actually define every rule id the
// pipeline emits. The id lists below are transcribed from the CONTRACT, never derived from the
// pack — deriving them from the file under test would make this test prove nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');

// lib/yaml.mjs and rules/core.pack.yaml are written by other agents in this build; until
// the parser exists these tests cannot run at all, so they skip with a reason instead of
// reporting a false failure. The assertions themselves are never relaxed.
const SKIP = existsSync(join(libDir, 'yaml.mjs'))
  ? false
  : 'lib/yaml.mjs is not written yet — rule pack parsing is unavailable';

/** Import lib/rules.mjs lazily so a missing peer module skips instead of crashing the file. */
async function rulesLib() {
  return import('../lib/rules.mjs');
}

// Contract §12 dimensions -> one CAVEMAN.<DIM>.001 blind rule each (9).
const CAVEMAN_IDS = [
  'CAVEMAN.IDENTITY.001',
  'CAVEMAN.AUDIENCE.001',
  'CAVEMAN.VALUE.001',
  'CAVEMAN.PRIMARY_ACTION.001',
  'CAVEMAN.VISUAL_HIERARCHY.001',
  'CAVEMAN.COGNITIVE_SIMPLICITY.001',
  'CAVEMAN.TRUST.001',
  'CAVEMAN.NAVIGATION.001',
  'CAVEMAN.LANGUAGE_CLARITY.001',
];

// Contract §10 deterministic checks (15).
const TECH_IDS = [
  'TECH.TARGET.UNREACHABLE',
  'TECH.OVERFLOW.HORIZONTAL',
  'TECH.TAP_TARGET.SMALL',
  'TECH.HEADING.MISSING_H1',
  'TECH.HEADING.MULTIPLE_H1',
  'TECH.HEADING.SKIPPED_LEVEL',
  'TECH.FORM.MISSING_LABEL',
  'TECH.LINK.BROKEN',
  'TECH.LINK.EMPTY_TEXT',
  'TECH.IMG.MISSING_ALT',
  'TECH.LANG.MISSING',
  'TECH.LANG.MISMATCH',
  'TECH.META.MISSING_VIEWPORT',
  'TECH.NAV.NO_LANDMARK',
  'TECH.NAV.NO_MAIN',
];

// Contract §13 multilingual rules (9).
const I18N_IDS = [
  'I18N.MISSING_ROUTE',
  'I18N.RESIDUAL_LANGUAGE',
  'I18N.CTA_PARITY',
  'I18N.OVERFLOW',
  'I18N.HREFLANG.MISSING',
  'I18N.HREFLANG.NO_SELF',
  'I18N.HREFLANG.NO_XDEFAULT',
  'I18N.LANG_ATTR_MISMATCH',
  'I18N.TEXT_EXPANSION',
];

// Contract §17 heuristic Stage E rules (9).
const UX_IDS = [
  'UX.CTA.AMBIGUOUS_PRIMARY',
  'UX.CTA.MISLEADING_LABEL',
  'UX.COPY.JARGON',
  'UX.COPY.VAGUE_VALUE',
  'UX.HIERARCHY.COMPETING_EMPHASIS',
  'UX.LOAD.COGNITIVE_OVERLOAD',
  'UX.TRUST.NO_SOCIAL_PROOF',
  'UX.NAV.NO_WAY_BACK',
  'UX.FORM.UNEXPLAINED_FIELD',
];

const REQUIRED_RULE_FIELDS = [
  'id', 'version', 'category', 'kind', 'severity_default', 'localizable', 'title', 'applicability',
  'evidence', 'testability',
];

test('loadRulePacks reads the core pack with its license metadata', { skip: SKIP }, async () => {
  const { loadRulePacks } = await rulesLib();
  const { packs, rules } = loadRulePacks({ packs: ['core'] });
  assert.equal(packs.length, 1);
  const [pack] = packs;
  assert.equal(pack.id, 'core');
  assert.equal(pack.license, 'MIT');
  assert.equal(pack.redistribution_reviewed, true);
  assert.equal(typeof pack.source_url, 'string');
  assert.equal(typeof pack.attribution_file, 'string');
  assert.ok(rules.length >= 42, `expected at least 42 rules, got ${rules.length}`);
});

test('rule ids are unique and match RULE_ID_PATTERN', { skip: SKIP }, async () => {
  const { allRules, RULE_ID_PATTERN } = await rulesLib();
  const ids = allRules().map((rule) => rule.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, [], `duplicate rule ids: ${duplicates.join(', ')}`);
  const malformed = ids.filter((id) => !RULE_ID_PATTERN.test(id));
  assert.deepEqual(malformed, [], `rule ids not matching ${RULE_ID_PATTERN}: ${malformed.join(', ')}`);
});

test('every rule carries the required fields', { skip: SKIP }, async () => {
  const { allRules } = await rulesLib();
  for (const rule of allRules()) {
    for (const field of REQUIRED_RULE_FIELDS) {
      assert.ok(
        rule[field] !== undefined && rule[field] !== null && rule[field] !== '',
        `rule ${rule.id} is missing '${field}'`,
      );
    }
    assert.ok(Array.isArray(rule.evidence?.accepted), `rule ${rule.id} has no evidence.accepted list`);
    assert.ok(Array.isArray(rule.applicability?.page_types), `rule ${rule.id} has no applicability.page_types list`);
  }
});

test('checkRules() reports zero errors for the core pack', { skip: SKIP }, async () => {
  const { checkRules } = await rulesLib();
  const result = await checkRules({ packs: ['core'] });
  assert.deepEqual(result.errors, [], `rules check errors: ${result.errors.join(' | ')}`);
  assert.ok(result.count >= 42, `expected at least 42 checked rules, got ${result.count}`);
});

for (const [group, ids] of [
  ['CAVEMAN', CAVEMAN_IDS],
  ['TECH', TECH_IDS],
  ['I18N', I18N_IDS],
  ['UX', UX_IDS],
]) {
  test(`the pack defines every contract ${group}.* rule id`, { skip: SKIP }, async () => {
    const { getRule } = await rulesLib();
    const absent = ids.filter((id) => !getRule(id));
    assert.deepEqual(absent, [], `${group} rule ids missing from rules/core.pack.yaml: ${absent.join(', ')}`);
  });
}

test('the CAVEMAN, TECH, I18N and UX groups have the contract cardinality', { skip: SKIP }, async () => {
  assert.equal(CAVEMAN_IDS.length, 9);
  assert.equal(TECH_IDS.length, 15);
  assert.equal(I18N_IDS.length, 9);
  assert.equal(UX_IDS.length, 9);
});

test('blind and heuristic rules declare a rubric dimension', { skip: SKIP }, async () => {
  const { allRules } = await rulesLib();
  const { DIMENSIONS } = await import('../lib/scoring.mjs');
  const keys = DIMENSIONS.map((dimension) => dimension.key);
  for (const rule of allRules()) {
    if (rule.kind !== 'blind' && rule.kind !== 'heuristic') continue;
    assert.ok(keys.includes(rule.dimension), `rule ${rule.id} has an unknown dimension '${rule.dimension}'`);
  }
});

test('ruleSeverity applies severity_overrides and disabled from the config', { skip: SKIP }, async () => {
  const { ruleSeverity } = await rulesLib();
  assert.equal(ruleSeverity('TECH.FORM.MISSING_LABEL', {}), 'critical');
  assert.equal(
    ruleSeverity('TECH.FORM.MISSING_LABEL', { rules: { severity_overrides: { 'TECH.FORM.MISSING_LABEL': 'minor' } } }),
    'minor',
  );
  assert.equal(ruleSeverity('TECH.FORM.MISSING_LABEL', { rules: { disabled: ['TECH.FORM.MISSING_LABEL'] } }), null);
  assert.equal(ruleSeverity('NOT.A.RULE', {}), null);
});

test('loadRulePacks fails loudly on an unknown pack', { skip: SKIP }, async () => {
  const { loadRulePacks } = await rulesLib();
  assert.throws(() => loadRulePacks({ packs: ['definitely-not-a-pack'] }), /not found/);
});
