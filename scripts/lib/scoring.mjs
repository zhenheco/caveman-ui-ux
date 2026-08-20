// All score formulas. Contract §12 — every formula here is disclosed in
// references/rubric.md verbatim; changing one here means changing that file too.
// Pure functions only: no I/O, no config reads, so the whole scoring surface is unit-testable.

import { EXIT } from './errors.mjs';

export const DIMENSIONS = [
  { key: 'identity', weight: 15, question: '這是什麼？' },
  { key: 'audience', weight: 10, question: '這是給誰的？' },
  { key: 'value', weight: 20, question: '我能得到什麼？' },
  { key: 'primary_action', weight: 15, question: '下一步要做什麼？' },
  { key: 'visual_hierarchy', weight: 10, question: '第一眼是否看到最重要資訊？' },
  { key: 'cognitive_simplicity', weight: 10, question: '是否需要過多推理？' },
  { key: 'trust', weight: 10, question: '是否有足夠理由相信？' },
  { key: 'navigation', weight: 5, question: '是否知道如何移動或返回？' },
  { key: 'language_clarity', weight: 5, question: '用詞是否直接、自然、無行話？' },
];

export const SEVERITY_ORDER = ['blocker', 'critical', 'major', 'minor', 'info'];

// ADR-002: a finding below this confidence cannot hard-fail a gate on its own
// unless it carries deterministic evidence.
const LOW_CONFIDENCE_CUTOFF = 0.60;

const AXE_SEVERITY_WEIGHT = { critical: 10, major: 6, minor: 3, info: 1 };
const HEURISTIC_SEVERITY_PENALTY = { blocker: 40, critical: 20, major: 8, minor: 3, info: 0 };
const I18N_PENALTY = {
  'I18N.RESIDUAL_LANGUAGE': 15,
  'I18N.CTA_PARITY': 10,
  'I18N.OVERFLOW': 10,
  'I18N.MISSING_ROUTE': 5,
};
const I18N_HREFLANG_PENALTY = 8;

/** True when the value is a usable finite number. */
function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Round to one decimal place (the report's score precision). */
function round1(value) {
  return Math.round(value * 10) / 10;
}

/** Median of a number list; even count averages the two middles, empty list -> null. */
export function median(nums) {
  const xs = (Array.isArray(nums) ? nums : []).filter(isNum).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** Median absolute deviation from the median; empty list -> null. */
export function mad(nums) {
  const m = median(nums);
  if (m === null) return null;
  const xs = (Array.isArray(nums) ? nums : []).filter(isNum);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** Read a dimension score that may be a bare number or a {score} object. */
function dimValue(entry) {
  if (isNum(entry)) return entry;
  if (entry && isNum(entry.score)) return entry.score;
  return null;
}

/** Weighted caveman score 0..100 from 0..10 dimension scores; missing dimension throws. */
export function cavemanScore(dimScores) {
  let total = 0;
  for (const { key, weight } of DIMENSIONS) {
    const score = dimValue(dimScores ? dimScores[key] : null);
    if (score === null) throw new Error(`cavemanScore: missing dimension score '${key}'`);
    total += (weight * score) / 10;
  }
  return round1(total);
}

/**
 * Aggregate a panel of blind responses. ADR-002: per dimension take the median,
 * report dispersion separately, and never let disagreement act as a score penalty.
 */
/**
 * Severity band for one consensus dimension score, so a blind rubric score becomes a real
 * finding instead of a number nobody acts on. Bands follow references/rubric.md's anchors:
 * <=2 "nothing addresses the question", <=4 "two strangers would guess differently",
 * <=6 "answerable only with visible effort", >=7 clear enough to not be a finding.
 */
export function dimensionSeverity(score) {
  if (!Number.isFinite(score)) return null;
  if (score <= 2) return 'critical';
  if (score <= 4) return 'major';
  if (score <= 6) return 'minor';
  return null;
}

export function consensus(responses) {
  const list = Array.isArray(responses) ? responses : [];
  if (list.length === 0) {
    return {
      evaluator_ids: [],
      dimensions: {},
      caveman_score: null,
      evaluator_confidence: null,
      evaluator_dispersion: null,
      contradictions: [],
    };
  }
  const dimensions = {};
  const contradictions = [];
  const dispersions = [];
  for (const { key } of DIMENSIONS) {
    const scores = list.map((r) => dimValue(r?.dimensions ? r.dimensions[key] : null));
    const usable = scores.filter(isNum);
    const m = median(usable);
    const deviation = mad(usable);
    const dispersion = deviation === null ? 0 : Math.min(1, deviation / 2.5);
    dimensions[key] = { consensus_score: m, scores, mad: deviation, dispersion };
    dispersions.push(dispersion);
    if (usable.length >= 2) {
      const spread = Math.max(...usable) - Math.min(...usable);
      if (spread >= 4) contradictions.push({ dimension: key, spread, scores });
    }
  }
  const medianDispersion = median(dispersions) ?? 0;
  const medianConfidence = median(list.map((r) => (isNum(r?.confidence) ? r.confidence : null)));
  const consensusScores = {};
  for (const { key } of DIMENSIONS) consensusScores[key] = dimensions[key].consensus_score;
  return {
    evaluator_ids: list.map((r) => r?.evaluator?.id ?? r?.evaluator_id ?? null),
    dimensions,
    caveman_score: cavemanScore(consensusScores),
    evaluator_confidence: medianConfidence === null ? null : medianConfidence * (1 - 0.5 * medianDispersion),
    evaluator_dispersion: medianDispersion,
    contradictions,
  };
}

/** Number of DOM nodes a deterministic finding covers, capped later at 5. */
function nodeCount(finding) {
  if (isNum(finding?.node_count)) return finding.node_count;
  if (Array.isArray(finding?.nodes)) return Math.max(1, finding.nodes.length);
  if (Array.isArray(finding?.evidence)) {
    return Math.max(1, finding.evidence.filter((e) => e && e.type === 'dom').length);
  }
  return 1;
}

/** Accessibility score from axe findings: 100 minus capped per-finding penalties; no run -> null. */
export function accessibilityScore(axeFindings) {
  if (!Array.isArray(axeFindings)) return null;
  let penalty = 0;
  for (const finding of axeFindings) {
    const weight = AXE_SEVERITY_WEIGHT[finding?.severity] ?? 0;
    penalty += weight * Math.min(nodeCount(finding), 5);
  }
  return Math.max(0, 100 - penalty);
}

/** Technical score from median Lighthouse categories (a11y excluded — axe owns it); missing -> null. */
export function technicalScore(medianCategories) {
  if (!medianCategories || typeof medianCategories !== 'object') return null;
  const performance = medianCategories.performance;
  const bestPractices = medianCategories['best-practices'] ?? medianCategories.bestPractices;
  const seo = medianCategories.seo;
  if (![performance, bestPractices, seo].every(isNum)) return null;
  return Math.round(100 * (0.5 * performance + 0.3 * bestPractices + 0.2 * seo));
}

/** Heuristic UX score: 100 minus severity penalties over kind === 'heuristic' findings. */
export function heuristicScore(findings) {
  if (!Array.isArray(findings)) return null;
  let penalty = 0;
  for (const finding of findings) {
    if (finding?.kind !== 'heuristic') continue;
    penalty += HEURISTIC_SEVERITY_PENALTY[finding?.severity] ?? 0;
  }
  return Math.max(0, 100 - penalty);
}

/** Penalty for one I18N rule id; hreflang rules share a single weight. */
function i18nPenalty(ruleId) {
  if (typeof ruleId !== 'string') return 0;
  if (ruleId.startsWith('I18N.HREFLANG.')) return I18N_HREFLANG_PENALTY;
  return I18N_PENALTY[ruleId] ?? 0;
}

/** Multilingual consistency score from a locale matrix; fewer than 2 locales -> null. */
export function multilingualScore(matrix) {
  const locales = Array.isArray(matrix?.locales) ? matrix.locales : [];
  if (locales.length < 2) return null;
  const findings = Array.isArray(matrix?.findings) ? matrix.findings : [];
  let penalty = 0;
  for (const finding of findings) penalty += i18nPenalty(finding?.rule_id);
  return Math.max(0, 100 - penalty);
}

/** Optional composite score with weights renormalized over the non-null components. */
export function compositeScore(scores, weights) {
  const inputWeights = weights && typeof weights === 'object' ? weights : {};
  const included = Object.keys(inputWeights).filter((key) => isNum(scores?.[key]) && isNum(inputWeights[key]));
  const weightSum = included.reduce((sum, key) => sum + inputWeights[key], 0);
  if (included.length === 0 || weightSum <= 0) {
    return { value: null, weights: {}, disclosed: true, components: {} };
  }
  const effective = {};
  const components = {};
  let value = 0;
  for (const key of included) {
    const weight = inputWeights[key] / weightSum;
    const contribution = weight * scores[key];
    effective[key] = weight;
    components[key] = { score: scores[key], weight, contribution };
    value += contribution;
  }
  return { value: round1(value), weights: effective, disclosed: true, components };
}

/** Confidence band label: >=0.80 high, >=0.60 medium, otherwise low. */
export function confidenceBand(c) {
  if (!isNum(c)) return 'low';
  if (c >= 0.80) return 'high';
  if (c >= 0.60) return 'medium';
  return 'low';
}

/** True when a blocker/critical finding may hard-fail a gate on its own (ADR-002). */
function countsAsCritical(finding) {
  const severity = finding?.severity;
  if (severity !== 'blocker' && severity !== 'critical') return false;
  const confidence = isNum(finding?.confidence) ? finding.confidence : 1;
  if (confidence >= LOW_CONFIDENCE_CUTOFF) return true;
  return finding?.kind === 'deterministic';
}

/** Evaluate every configured gate; null threshold or missing actual becomes 'skipped'. */
export function evaluateGates({ scores = {}, findings = [], gates = {}, technicalAvailable = true } = {}) {
  const limitations = [];
  const results = [];
  const criticalFindings = (Array.isArray(findings) ? findings : []).filter(countsAsCritical);

  /** Push one gate result, deciding pass/fail/skipped. */
  const push = (gate, actual, threshold, comparator, forcedSkipReason) => {
    if (forcedSkipReason) {
      limitations.push(forcedSkipReason);
      results.push({ gate, actual, threshold: isNum(threshold) ? threshold : null, comparator, status: 'skipped' });
      return;
    }
    if (!isNum(threshold) || !isNum(actual)) {
      results.push({
        gate,
        actual: isNum(actual) ? actual : null,
        threshold: isNum(threshold) ? threshold : null,
        comparator,
        status: 'skipped',
      });
      return;
    }
    const ok = comparator === '<=' ? actual <= threshold : actual >= threshold;
    results.push({ gate, actual, threshold, comparator, status: ok ? 'pass' : 'fail' });
  };

  push('caveman_minimum', scores.caveman, gates.caveman_minimum, '>=');
  push('heuristic_minimum', scores.heuristic_ux, gates.heuristic_minimum, '>=');
  push('accessibility_minimum', scores.accessibility, gates.accessibility_minimum, '>=');
  push(
    'technical_minimum',
    scores.technical,
    gates.technical_minimum,
    '>=',
    technicalAvailable === false && isNum(gates.technical_minimum)
      ? 'technical_minimum skipped: technical score unavailable (Lighthouse did not run)'
      : null,
  );
  push('multilingual_minimum', scores.multilingual_consistency, gates.multilingual_minimum, '>=');
  push('critical_maximum', criticalFindings.length, gates.critical_maximum, '<=');
  push('evaluator_confidence_minimum', scores.evaluator_confidence, gates.evaluator_confidence_minimum, '>=');

  const pass = results.every((r) => r.status !== 'fail');
  return { pass, results, exit_code: pass ? EXIT.OK : EXIT.GATE_FAIL, limitations };
}
