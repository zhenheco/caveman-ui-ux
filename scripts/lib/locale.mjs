// Report locale dictionaries (contract §14). Flat dotted keys, '{{var}}' placeholders.
// 'en' is the key master; every shipped locale must carry the identical key set (AC-004).
// Nothing here throws on bad input: a broken or partial dictionary must never take the
// reporter down, it degrades to the English master and finally to the raw key.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillRoot } from './paths.mjs';

const MASTER_LOCALE = 'en';

// The exact key list from contract §14. The reporter uses only these keys, and
// locale.test.mjs asserts the shipped locale files against THIS array, not against
// each other, so a key drifting out of the contract fails the build.
export const REQUIRED_KEYS = Object.freeze([
  'report.title',
  'report.subtitle',
  'report.run_id',
  'report.generated_at',
  'report.target',
  'report.tool_versions',
  'report.section.executive_summary',
  'report.section.gate',
  'report.section.scores',
  'report.section.findings',
  'report.section.locale_matrix',
  'report.section.methodology',
  'report.section.limitations',
  'report.section.notices',
  'report.gate.pass',
  'report.gate.fail',
  'report.gate.skipped',
  'report.gate.column.gate',
  'report.gate.column.actual',
  'report.gate.column.threshold',
  'report.gate.column.status',
  'score.caveman',
  'score.heuristic_ux',
  'score.accessibility',
  'score.technical',
  'score.multilingual_consistency',
  'score.evaluator_confidence',
  'score.evaluator_dispersion',
  'score.composite',
  'score.unavailable',
  'dimension.identity',
  'dimension.audience',
  'dimension.value',
  'dimension.primary_action',
  'dimension.visual_hierarchy',
  'dimension.cognitive_simplicity',
  'dimension.trust',
  'dimension.navigation',
  'dimension.language_clarity',
  'severity.blocker',
  'severity.critical',
  'severity.major',
  'severity.minor',
  'severity.info',
  'confidence.high',
  'confidence.medium',
  'confidence.low',
  'finding.evidence',
  'finding.fix_brief',
  'finding.rule',
  'finding.target',
  'finding.confidence',
  'finding.status',
  'finding.none',
  'finding.count',
  'status.open',
  'status.resolved',
  'status.improved',
  'status.unchanged',
  'status.regressed',
  'status.not_comparable',
  'blind.answers',
  'blind.what_is_this',
  'blind.who_is_it_for',
  'blind.what_can_i_get_or_do',
  'blind.what_should_i_do_next',
  'blind.why_should_i_trust_it',
  'blind.uncertainties',
  'matrix.route',
  'matrix.locale',
  'matrix.cta',
  'matrix.residual',
  'matrix.overflow',
  'matrix.hreflang',
  'methodology.body',
  'limitations.body',
]);

/** Absolute path of the bundled locales directory. */
export function localeDir() {
  return join(skillRoot(), 'locales');
}

/** Base language subtag of a BCP-47 code ('zh-Hant-TW' -> 'zh'). */
function baseLanguage(code) {
  return String(code || '').split('-')[0].toLowerCase();
}

/** Read one locale file, or null when it is absent, unparsable or not an object. */
function readLocaleFile(code) {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(String(code || ''))) return null;
  const path = join(localeDir(), `${code}.json`);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // A malformed locale file degrades to the fallback chain instead of crashing.
    return null;
  }
}

/** Sorted locale codes shipped with the skill, e.g. ['en','ja','vi','zh-TW']. */
export function availableLocales() {
  const dir = localeDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

/** Load a dictionary with the fallback chain exact -> base language -> 'en', merged. */
export function loadLocale(code) {
  const requested = String(code || MASTER_LOCALE);
  const chain = [];
  const seen = new Set();
  for (const candidate of [requested, baseLanguage(requested), MASTER_LOCALE]) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (readLocaleFile(candidate)) chain.push(candidate);
  }
  // Merge least-specific first so a partial locale still renders every key.
  const dict = {};
  for (const candidate of [...chain].reverse()) Object.assign(dict, readLocaleFile(candidate));
  return { code: chain[0] || MASTER_LOCALE, dict, chain };
}

/** Translate one key, substituting '{{var}}'; a missing key returns the key itself. */
export function t(dict, key, vars = {}) {
  const raw = dict && typeof dict === 'object' ? dict[key] : undefined;
  const template = typeof raw === 'string' && raw !== '' ? raw : String(key);
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name) => {
    const value = vars && typeof vars === 'object' ? vars[name] : undefined;
    return value === undefined || value === null ? match : String(value);
  });
}

/** Compare every shipped locale's key set against the 'en' master, both directions. */
export function localeCompleteness() {
  const masterKeys = new Set(Object.keys(readLocaleFile(MASTER_LOCALE) || {}));
  const missing = {};
  const extra = {};
  for (const code of availableLocales()) {
    if (code === MASTER_LOCALE) continue;
    const keys = new Set(Object.keys(readLocaleFile(code) || {}));
    const missingKeys = [...masterKeys].filter((key) => !keys.has(key)).sort();
    const extraKeys = [...keys].filter((key) => !masterKeys.has(key)).sort();
    if (missingKeys.length) missing[code] = missingKeys;
    if (extraKeys.length) extra[code] = extraKeys;
  }
  return {
    master: MASTER_LOCALE,
    missing,
    extra,
    complete: Object.keys(missing).length === 0 && Object.keys(extra).length === 0,
  };
}
