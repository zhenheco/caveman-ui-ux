// Rule pack loading and validation (contract §17).
// Packs are YAML files in rules/<id>.pack.yaml parsed by the hand-rolled subset parser
// in lib/yaml.mjs — zero npm dependencies, so the pack format stays deliberately small.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT, fail } from './errors.mjs';
import { skillRoot } from './paths.mjs';
import { parseYamlFile } from './yaml.mjs';
import { DIMENSIONS, SEVERITY_ORDER } from './scoring.mjs';

// Two to four dot-separated upper-snake segments: I18N.OVERFLOW, TECH.FORM.MISSING_LABEL,
// CAVEMAN.IDENTITY.001, A11Y.AXE.COLOR_CONTRAST.
export const RULE_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:\.[A-Z0-9_]+){1,3}$/;

export const RULE_KINDS = Object.freeze(['blind', 'heuristic', 'deterministic', 'multilingual']);
export const RULE_TESTABILITY = Object.freeze(['deterministic', 'subjective']);
export const DEFAULT_PACKS = Object.freeze(['core']);

const REQUIRED_PACK_FIELDS = [
  'id', 'version', 'source_url', 'source_commit', 'license', 'attribution_file', 'redistribution_reviewed',
];
const REQUIRED_RULE_FIELDS = [
  'id', 'version', 'category', 'kind', 'severity_default', 'localizable', 'title', 'applicability',
  'evidence', 'testability',
];
// A subjective rule must say which rubric dimension it feeds; deterministic ones need not.
const DIMENSION_REQUIRED_KINDS = ['blind', 'heuristic'];
const DIMENSION_KEYS = DIMENSIONS.map((dimension) => dimension.key);

// Keyed by the joined pack id list so alternating pack sets do not thrash the cache.
const packCache = new Map();

/** Absolute path of one rule pack file inside the skill bundle. */
function rulePackPath(packId) {
  return join(skillRoot(), 'rules', `${packId}.pack.yaml`);
}

/** Normalize a pack list into unique, non-empty, filesystem-safe pack ids. */
function normalizePackIds(packs) {
  const list = Array.isArray(packs) ? packs : [packs];
  const out = [];
  for (const entry of list) {
    const id = String(entry ?? '').trim();
    if (!id || out.includes(id)) continue;
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
      fail(`invalid rule pack id '${id}' — expected a filename-safe identifier`, EXIT.CONFIG, { pack: id });
    }
    out.push(id);
  }
  return out.length ? out : [...DEFAULT_PACKS];
}

/** Load the named rule packs, returning pack metadata, flat rules and an id index. */
export function loadRulePacks({ packs = DEFAULT_PACKS } = {}) {
  const ids = normalizePackIds(packs);
  const cacheKey = ids.join(',');
  const cached = packCache.get(cacheKey);
  if (cached) return cached;

  const loadedPacks = [];
  const rules = [];
  for (const id of ids) {
    const path = rulePackPath(id);
    if (!existsSync(path)) {
      fail(`rule pack '${id}' not found (expected rules/${id}.pack.yaml)`, EXIT.CONFIG, { pack: id, path });
    }
    const doc = parseYamlFile(path);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      fail(`rule pack '${id}' did not parse into a mapping`, EXIT.CONFIG, { pack: id, path });
    }
    const packRules = Array.isArray(doc.rules) ? doc.rules : [];
    const { rules: _ignored, ...meta } = doc;
    loadedPacks.push({ ...meta, id: doc.id ?? id, requested_id: id, path, rule_count: packRules.length });
    for (const rule of packRules) {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
      rules.push({ ...rule, pack: doc.id ?? id });
    }
  }

  const byId = new Map();
  const duplicates = [];
  for (const rule of rules) {
    const id = String(rule.id ?? '');
    if (byId.has(id)) duplicates.push(id);
    else byId.set(id, rule);
  }

  const value = { packs: loadedPacks, rules, byId, duplicates };
  packCache.set(cacheKey, value);
  return value;
}

/** Look up one rule by id within a pack set; null when it is not defined. */
function findRule(ruleId, packs) {
  return loadRulePacks({ packs }).byId.get(String(ruleId ?? '')) ?? null;
}

/** One rule definition from the default packs, or null when the id is unknown. */
export function getRule(id) {
  return findRule(id, DEFAULT_PACKS);
}

/** Every rule definition from the given packs (default: the core pack). */
export function allRules({ packs = DEFAULT_PACKS } = {}) {
  return loadRulePacks({ packs }).rules;
}

/** Pack ids listed in assets/caveman.config.example.yaml, or [] when unreadable. */
function examplePackIds() {
  const path = join(skillRoot(), 'assets', 'caveman.config.example.yaml');
  if (!existsSync(path)) return null;
  try {
    const doc = parseYamlFile(path);
    const list = doc?.rules?.packs;
    return Array.isArray(list) ? list.map((entry) => String(entry)) : [];
  } catch {
    return null;
  }
}

/** Validate the loaded packs: ids, required fields, enums, license metadata. */
export function checkRules({ packs = DEFAULT_PACKS } = {}) {
  const errors = [];
  const warnings = [];
  let loaded;
  try {
    loaded = loadRulePacks({ packs });
  } catch (error) {
    return { errors: [error.message], warnings, count: 0 };
  }

  const examplePacks = examplePackIds();
  if (examplePacks === null) {
    warnings.push('could not read assets/caveman.config.example.yaml — skipped the redistribution cross-check');
  }

  for (const pack of loaded.packs) {
    const label = pack.id ?? pack.requested_id;
    for (const field of REQUIRED_PACK_FIELDS) {
      if (pack[field] === undefined || pack[field] === null || pack[field] === '') {
        errors.push(`pack '${label}': missing required metadata field '${field}'`);
      }
    }
    if (!pack.rule_count) errors.push(`pack '${label}': contains no rules`);
    if (pack.redistribution_reviewed !== true) {
      warnings.push(`pack '${label}': redistribution_reviewed is not true — the pack is local-only and must not be redistributed`);
      if (examplePacks && (examplePacks.includes(String(label)) || examplePacks.includes(String(pack.requested_id)))) {
        errors.push(`pack '${label}': listed in assets/caveman.config.example.yaml rules.packs but redistribution_reviewed is not true`);
      }
    }
  }

  for (const id of loaded.duplicates) errors.push(`duplicate rule id '${id}'`);

  for (const rule of loaded.rules) {
    const id = String(rule.id ?? '');
    const label = id || `<rule without id in pack '${rule.pack}'>`;
    for (const field of REQUIRED_RULE_FIELDS) {
      if (rule[field] === undefined || rule[field] === null || rule[field] === '') {
        errors.push(`rule '${label}': missing required field '${field}'`);
      }
    }
    if (!RULE_ID_PATTERN.test(id)) errors.push(`rule '${label}': id does not match ${RULE_ID_PATTERN}`);
    if (!RULE_KINDS.includes(rule.kind)) {
      errors.push(`rule '${label}': kind '${rule.kind}' is not one of ${RULE_KINDS.join('|')}`);
    }
    if (!SEVERITY_ORDER.includes(rule.severity_default)) {
      errors.push(`rule '${label}': severity_default '${rule.severity_default}' is not one of ${SEVERITY_ORDER.join('|')}`);
    }
    if (rule.testability !== undefined && !RULE_TESTABILITY.includes(rule.testability)) {
      errors.push(`rule '${label}': testability '${rule.testability}' is not one of ${RULE_TESTABILITY.join('|')}`);
    }
    if (typeof rule.localizable !== 'boolean') {
      errors.push(`rule '${label}': localizable must be a boolean`);
    }
    if (DIMENSION_REQUIRED_KINDS.includes(rule.kind) && !DIMENSION_KEYS.includes(rule.dimension)) {
      errors.push(`rule '${label}': dimension '${rule.dimension}' is not one of the 9 rubric dimensions`);
    }
    const accepted = rule.evidence?.accepted;
    if (rule.evidence !== undefined && !Array.isArray(accepted)) {
      errors.push(`rule '${label}': evidence.accepted must be a sequence`);
    }
    const pageTypes = rule.applicability?.page_types;
    if (rule.applicability !== undefined && !Array.isArray(pageTypes)) {
      errors.push(`rule '${label}': applicability.page_types must be a sequence`);
    }
  }

  return { errors, warnings, count: loaded.rules.length };
}

/**
 * ONLY the config's explicit severity override for a rule; null when there is none.
 * Producers compute a severity from what they measured (an axe impact, a consensus score), so
 * the pack default must not overwrite it — the precedence is config override > producer >
 * pack default. Use ruleSeverity() when you need that default, this when you are re-grading.
 */
export function severityOverride(ruleId, config) {
  const section = config?.rules && typeof config.rules === 'object' ? config.rules : {};
  const overrides = section.severity_overrides && typeof section.severity_overrides === 'object'
    ? section.severity_overrides
    : {};
  const override = overrides[String(ruleId ?? '')];
  return typeof override === 'string' && SEVERITY_ORDER.includes(override) ? override : null;
}

/** Effective severity for a rule under a config; null when disabled or unknown. */
export function ruleSeverity(ruleId, config) {
  const section = config?.rules && typeof config.rules === 'object' ? config.rules : {};
  const id = String(ruleId ?? '');
  const disabled = Array.isArray(section.disabled) ? section.disabled.map(String) : [];
  if (disabled.includes(id)) return null;
  const overrides = section.severity_overrides && typeof section.severity_overrides === 'object'
    ? section.severity_overrides
    : {};
  const override = overrides[id];
  if (typeof override === 'string' && SEVERITY_ORDER.includes(override)) return override;
  const packs = Array.isArray(section.packs) && section.packs.length ? section.packs : DEFAULT_PACKS;
  const rule = findRule(id, packs);
  return rule && SEVERITY_ORDER.includes(rule.severity_default) ? rule.severity_default : null;
}
