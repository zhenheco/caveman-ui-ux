// Contract §12 / §19 — every disclosed formula, the ADR-002 consensus math and every gate branch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT } from '../lib/errors.mjs';
import {
  DIMENSIONS,
  SEVERITY_ORDER,
  median,
  mad,
  cavemanScore,
  consensus,
  accessibilityScore,
  technicalScore,
  heuristicScore,
  multilingualScore,
  compositeScore,
  confidenceBand,
  evaluateGates,
} from '../lib/scoring.mjs';

/** Assert two floats are equal within 1e-9 (median * dispersion products are not exact). */
function approx(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ~${expected}, got ${actual}`);
}

/** Build a dimension map where every dimension has the same score. */
function flatDims(score) {
  return Object.fromEntries(DIMENSIONS.map(({ key }) => [key, score]));
}

test('DIMENSIONS weights sum to 100 and questions are the 繁中 rubric wording', () => {
  assert.equal(DIMENSIONS.reduce((sum, d) => sum + d.weight, 0), 100);
  assert.equal(DIMENSIONS.length, 9);
  assert.equal(DIMENSIONS[0].key, 'identity');
  assert.equal(DIMENSIONS[0].question, '這是什麼？');
  assert.equal(DIMENSIONS[2].key, 'value');
  assert.equal(DIMENSIONS[2].weight, 20);
  assert.deepEqual(SEVERITY_ORDER, ['blocker', 'critical', 'major', 'minor', 'info']);
});

test('cavemanScore: all 10 -> 100, all 5 -> 50, missing dimension throws', () => {
  assert.equal(cavemanScore(flatDims(10)), 100);
  assert.equal(cavemanScore(flatDims(5)), 50);
  assert.equal(cavemanScore(flatDims(0)), 0);
  // {score} wrappers (raw evaluator shape) are accepted too.
  assert.equal(cavemanScore(Object.fromEntries(DIMENSIONS.map(({ key }) => [key, { score: 10 }]))), 100);
  const missing = flatDims(8);
  delete missing.trust;
  assert.throws(() => cavemanScore(missing), /missing dimension score 'trust'/);
  assert.throws(() => cavemanScore(undefined), /missing dimension score/);
});

test('cavemanScore rounds to one decimal', () => {
  const dims = flatDims(8);
  dims.language_clarity = 9;
  // 8/10 * 95 weight = 76, plus 5 * 0.9 = 4.5 -> 80.5
  assert.equal(cavemanScore(dims), 80.5);
});

test('median and mad on odd and even counts', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
  assert.equal(median([]), null);
  assert.equal(median(undefined), null);
  assert.equal(mad([1, 2, 3]), 1);
  assert.equal(mad([1, 2, 3, 4]), 1);
  assert.equal(mad([5, 5, 5]), 0);
  assert.equal(mad([]), null);
  // the input array is never mutated
  const input = [3, 1, 2];
  median(input);
  assert.deepEqual(input, [3, 1, 2]);
});

test('consensus: worked 3-evaluator ADR-002 example', () => {
  // Hand-computed expectation.
  //   confidences        0.9, 0.8, 0.7                     -> median 0.8
  //   identity            7,  8,  9  -> median 8, MAD 1 -> dispersion 1/2.5 = 0.4
  //   audience            6,  7,  8  -> median 7, MAD 1 -> 0.4
  //   value               8,  9, 10  -> median 9, MAD 1 -> 0.4
  //   primary_action      2,  6, 10  -> median 6, MAD 4 -> min(1, 4/2.5) = 1.0, spread 8 -> contradiction
  //   visual_hierarchy    6,  7,  8  -> median 7, MAD 1 -> 0.4
  //   cognitive_simplicity 4, 5,  6  -> median 5, MAD 1 -> 0.4
  //   trust               5,  6,  7  -> median 6, MAD 1 -> 0.4
  //   navigation          7,  8,  9  -> median 8, MAD 1 -> 0.4
  //   language_clarity    8,  9, 10  -> median 9, MAD 1 -> 0.4
  //   dispersions [0.4 x8, 1.0] -> median 0.4  => evaluator_dispersion 0.4
  //   evaluator_confidence = 0.8 * (1 - 0.5*0.4) = 0.64
  //   caveman = 12 + 7 + 18 + 9 + 7 + 5 + 6 + 4 + 4.5 = 72.5
  const spreads = {
    identity: [7, 8, 9],
    audience: [6, 7, 8],
    value: [8, 9, 10],
    primary_action: [2, 6, 10],
    visual_hierarchy: [6, 7, 8],
    cognitive_simplicity: [4, 5, 6],
    trust: [5, 6, 7],
    navigation: [7, 8, 9],
    language_clarity: [8, 9, 10],
  };
  const confidences = [0.9, 0.8, 0.7];
  const responses = confidences.map((confidence, index) => ({
    evaluator_id: `eval-${index + 1}`,
    confidence,
    dimensions: Object.fromEntries(Object.entries(spreads).map(([key, values]) => [key, { score: values[index] }])),
  }));

  const result = consensus(responses);
  assert.equal(result.caveman_score, 72.5);
  approx(result.evaluator_dispersion, 0.4, 'evaluator_dispersion');
  approx(result.evaluator_confidence, 0.64, 'evaluator_confidence');
  assert.equal(confidenceBand(result.evaluator_confidence), 'medium');

  assert.deepEqual(result.dimensions.audience.scores, [6, 7, 8]);
  assert.equal(result.dimensions.audience.consensus_score, 7);
  assert.equal(result.dimensions.audience.mad, 1);
  approx(result.dimensions.audience.dispersion, 0.4, 'audience dispersion');

  assert.equal(result.dimensions.primary_action.consensus_score, 6);
  assert.equal(result.dimensions.primary_action.mad, 4);
  assert.equal(result.dimensions.primary_action.dispersion, 1);

  // Disagreement is an ambiguity signal, never a score penalty.
  assert.deepEqual(result.contradictions, [{ dimension: 'primary_action', spread: 8, scores: [2, 6, 10] }]);
  assert.deepEqual(result.evaluator_ids, ['eval-1', 'eval-2', 'eval-3']);
});

test('consensus: single evaluator has zero dispersion and keeps its own confidence', () => {
  const result = consensus([{ evaluator_id: 'solo', confidence: 0.72, dimensions: flatDims(7) }]);
  assert.equal(result.evaluator_dispersion, 0);
  approx(result.evaluator_confidence, 0.72, 'solo confidence');
  assert.equal(result.caveman_score, 70);
  assert.deepEqual(result.contradictions, []);
});

test('consensus: no responses yields nulls, not zeros', () => {
  const result = consensus([]);
  assert.equal(result.caveman_score, null);
  assert.equal(result.evaluator_confidence, null);
  assert.equal(result.evaluator_dispersion, null);
  assert.deepEqual(result.contradictions, []);
});

test('accessibilityScore caps node penalties at 5 nodes and floors at 0', () => {
  assert.equal(accessibilityScore(null), null);
  assert.equal(accessibilityScore(undefined), null);
  assert.equal(accessibilityScore([]), 100);
  // critical weight 10 x min(9, 5) = 50
  assert.equal(accessibilityScore([{ severity: 'critical', node_count: 9 }]), 50);
  assert.equal(accessibilityScore([{ severity: 'critical', node_count: 5 }]), 50);
  // 10*1 + 6*2 + 3*3 + 1*1 = 32
  assert.equal(
    accessibilityScore([
      { severity: 'critical', node_count: 1 },
      { severity: 'major', node_count: 2 },
      { severity: 'minor', node_count: 3 },
      { severity: 'info', node_count: 1 },
    ]),
    68,
  );
  // node count derived from dom evidence entries
  assert.equal(
    accessibilityScore([
      { severity: 'major', evidence: [{ type: 'dom' }, { type: 'dom' }, { type: 'text' }] },
    ]),
    88,
  );
  // floor
  assert.equal(accessibilityScore(Array.from({ length: 4 }, () => ({ severity: 'critical', node_count: 5 }))), 0);
});

test('technicalScore weights performance 0.5 / best-practices 0.3 / seo 0.2', () => {
  // 100 * (0.5*0.9 + 0.3*0.8 + 0.2*1.0) = 89
  assert.equal(technicalScore({ performance: 0.9, 'best-practices': 0.8, seo: 1.0 }), 89);
  // Lighthouse's own accessibility category is recorded elsewhere but excluded here.
  assert.equal(technicalScore({ performance: 0.9, 'best-practices': 0.8, seo: 1.0, accessibility: 0.1 }), 89);
  assert.equal(technicalScore({ performance: 0.9, bestPractices: 0.8, seo: 1.0 }), 89);
  assert.equal(technicalScore({ performance: 1, 'best-practices': 1, seo: 1 }), 100);
  assert.equal(technicalScore({ performance: 0, 'best-practices': 0, seo: 0 }), 0);
  // null passthrough
  assert.equal(technicalScore(null), null);
  assert.equal(technicalScore(undefined), null);
  assert.equal(technicalScore({ performance: 0.9, 'best-practices': 0.8 }), null);
  assert.equal(technicalScore({ performance: null, 'best-practices': 0.8, seo: 1 }), null);
});

test('heuristicScore uses severity weights, ignores other kinds, floors at 0', () => {
  assert.equal(heuristicScore(null), null);
  assert.equal(heuristicScore([]), 100);
  assert.equal(
    heuristicScore([
      { kind: 'heuristic', severity: 'major' },
      { kind: 'heuristic', severity: 'minor' },
      { kind: 'heuristic', severity: 'info' },
      { kind: 'deterministic', severity: 'blocker' },
      { kind: 'blind', severity: 'critical' },
    ]),
    89,
  );
  assert.equal(heuristicScore([{ kind: 'heuristic', severity: 'critical' }]), 80);
  assert.equal(heuristicScore(Array.from({ length: 3 }, () => ({ kind: 'heuristic', severity: 'blocker' }))), 0);
});

test('multilingualScore penalties, floor and the fewer-than-2-locales rule', () => {
  assert.equal(multilingualScore({ locales: ['en'], findings: [{ rule_id: 'I18N.CTA_PARITY' }] }), null);
  assert.equal(multilingualScore({ locales: [], findings: [] }), null);
  assert.equal(multilingualScore(null), null);
  assert.equal(multilingualScore({ locales: ['en', 'ja'], findings: [] }), 100);
  // 15 + 10 + 10 + 8 + 8 + 5 = 56
  assert.equal(
    multilingualScore({
      locales: ['en', 'ja', 'vi'],
      findings: [
        { rule_id: 'I18N.RESIDUAL_LANGUAGE' },
        { rule_id: 'I18N.CTA_PARITY' },
        { rule_id: 'I18N.OVERFLOW' },
        { rule_id: 'I18N.HREFLANG.MISSING' },
        { rule_id: 'I18N.HREFLANG.NO_SELF' },
        { rule_id: 'I18N.MISSING_ROUTE' },
      ],
    }),
    44,
  );
  assert.equal(
    multilingualScore({
      locales: ['en', 'ja'],
      findings: Array.from({ length: 7 }, () => ({ rule_id: 'I18N.RESIDUAL_LANGUAGE' })),
    }),
    0,
  );
});

test('compositeScore renormalizes weights over the non-null components', () => {
  const weights = { caveman: 0.35, heuristic_ux: 0.2, accessibility: 0.25, technical: 0.1, multilingual_consistency: 0.1 };
  const result = compositeScore(
    { caveman: 80, heuristic_ux: null, accessibility: 90, technical: null, multilingual_consistency: null },
    weights,
  );
  // included weights 0.35 + 0.25 = 0.6 -> 0.583333 / 0.416667 ; 80*0.583333 + 90*0.416667 = 84.1667
  assert.equal(result.disclosed, true);
  assert.equal(result.value, 84.2);
  assert.deepEqual(Object.keys(result.weights), ['caveman', 'accessibility']);
  approx(result.weights.caveman, 0.35 / 0.6, 'renormalized caveman weight');
  approx(Object.values(result.weights).reduce((a, b) => a + b, 0), 1, 'weights sum');
  approx(result.components.accessibility.contribution, 90 * (0.25 / 0.6), 'accessibility contribution');

  const full = compositeScore({ caveman: 100, heuristic_ux: 100, accessibility: 100, technical: 100, multilingual_consistency: 100 }, weights);
  assert.equal(full.value, 100);

  const empty = compositeScore({ caveman: null }, weights);
  assert.equal(empty.value, null);
  assert.deepEqual(empty.weights, {});
});

test('confidenceBand boundaries at exactly 0.80 and 0.60', () => {
  assert.equal(confidenceBand(1), 'high');
  assert.equal(confidenceBand(0.80), 'high');
  assert.equal(confidenceBand(0.7999), 'medium');
  assert.equal(confidenceBand(0.60), 'medium');
  assert.equal(confidenceBand(0.5999), 'low');
  assert.equal(confidenceBand(0), 'low');
  assert.equal(confidenceBand(null), 'low');
  assert.equal(confidenceBand(undefined), 'low');
});

const PASSING_SCORES = {
  caveman: 80,
  heuristic_ux: 90,
  accessibility: 95,
  technical: 90,
  multilingual_consistency: null,
  evaluator_confidence: 0.9,
};

const GATES = {
  caveman_minimum: 75,
  heuristic_minimum: null,
  accessibility_minimum: 90,
  technical_minimum: 85,
  multilingual_minimum: null,
  critical_maximum: 0,
  evaluator_confidence_minimum: 0.60,
};

/** Look up one gate result by gate name. */
function gate(result, name) {
  return result.results.find((r) => r.gate === name);
}

test('evaluateGates: every gate passing exits 0, null thresholds are skipped', () => {
  const result = evaluateGates({ scores: PASSING_SCORES, findings: [], gates: GATES, technicalAvailable: true });
  assert.equal(result.pass, true);
  assert.equal(result.exit_code, EXIT.OK);
  assert.equal(result.exit_code, 0);
  assert.equal(gate(result, 'caveman_minimum').status, 'pass');
  assert.equal(gate(result, 'caveman_minimum').comparator, '>=');
  assert.equal(gate(result, 'accessibility_minimum').status, 'pass');
  // null threshold -> skipped, not a silent pass
  assert.equal(gate(result, 'heuristic_minimum').status, 'skipped');
  assert.equal(gate(result, 'heuristic_minimum').threshold, null);
  // null actual -> skipped
  assert.equal(gate(result, 'multilingual_minimum').status, 'skipped');
  assert.equal(gate(result, 'critical_maximum').actual, 0);
  assert.equal(gate(result, 'critical_maximum').comparator, '<=');
  assert.equal(result.results.length, 7);
});

test('evaluateGates: one failing gate exits 1', () => {
  const result = evaluateGates({
    scores: { ...PASSING_SCORES, accessibility: 80 },
    findings: [],
    gates: GATES,
    technicalAvailable: true,
  });
  assert.equal(result.pass, false);
  assert.equal(result.exit_code, EXIT.GATE_FAIL);
  assert.equal(result.exit_code, 1);
  assert.equal(gate(result, 'accessibility_minimum').status, 'fail');
  assert.equal(gate(result, 'accessibility_minimum').actual, 80);
  assert.equal(gate(result, 'caveman_minimum').status, 'pass');
});

test('evaluateGates: low evaluator confidence fails its own gate', () => {
  const result = evaluateGates({
    scores: { ...PASSING_SCORES, evaluator_confidence: 0.42 },
    findings: [],
    gates: GATES,
    technicalAvailable: true,
  });
  assert.equal(gate(result, 'evaluator_confidence_minimum').status, 'fail');
  assert.equal(result.exit_code, EXIT.GATE_FAIL);
});

test('evaluateGates: technicalAvailable false skips the technical gate instead of failing it', () => {
  const result = evaluateGates({
    scores: { ...PASSING_SCORES, technical: null },
    findings: [],
    gates: GATES,
    technicalAvailable: false,
  });
  assert.equal(gate(result, 'technical_minimum').status, 'skipped');
  assert.equal(gate(result, 'technical_minimum').threshold, 85);
  assert.equal(result.pass, true);
  assert.equal(result.exit_code, EXIT.OK);
  assert.ok(result.limitations.some((note) => note.includes('technical')), 'a limitations note is emitted');
});

test('evaluateGates: a low-confidence heuristic critical cannot hard-fail alone (ADR-002)', () => {
  const result = evaluateGates({
    scores: PASSING_SCORES,
    findings: [
      { rule_id: 'UX.CTA.AMBIGUOUS_PRIMARY', kind: 'heuristic', severity: 'critical', confidence: 0.4 },
      { rule_id: 'CAVEMAN.IDENTITY.001', kind: 'blind', severity: 'blocker', confidence: 0.5 },
    ],
    gates: GATES,
    technicalAvailable: true,
  });
  assert.equal(gate(result, 'critical_maximum').actual, 0);
  assert.equal(gate(result, 'critical_maximum').status, 'pass');
  assert.equal(result.exit_code, EXIT.OK);
});

test('evaluateGates: a low-confidence deterministic critical does count', () => {
  const result = evaluateGates({
    scores: PASSING_SCORES,
    findings: [{ rule_id: 'TECH.FORM.MISSING_LABEL', kind: 'deterministic', severity: 'critical', confidence: 0.4 }],
    gates: GATES,
    technicalAvailable: true,
  });
  assert.equal(gate(result, 'critical_maximum').actual, 1);
  assert.equal(gate(result, 'critical_maximum').status, 'fail');
  assert.equal(result.exit_code, EXIT.GATE_FAIL);
});

test('evaluateGates: high-confidence heuristic criticals count, minors never do', () => {
  const result = evaluateGates({
    scores: PASSING_SCORES,
    findings: [
      { kind: 'heuristic', severity: 'critical', confidence: 0.9 },
      { kind: 'heuristic', severity: 'blocker', confidence: 0.6 },
      { kind: 'heuristic', severity: 'major', confidence: 1 },
      { kind: 'deterministic', severity: 'minor' },
      { kind: 'deterministic', severity: 'critical' },
    ],
    gates: GATES,
    technicalAvailable: true,
  });
  assert.equal(gate(result, 'critical_maximum').actual, 3);
  assert.equal(result.exit_code, EXIT.GATE_FAIL);
});

test('evaluateGates: called with nothing skips every gate and exits 0', () => {
  const result = evaluateGates();
  assert.equal(result.pass, true);
  assert.equal(result.exit_code, EXIT.OK);
  assert.ok(result.results.every((r) => r.status === 'skipped'), 'all gates skipped');
});
