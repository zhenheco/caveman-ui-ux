// Config loading, target expansion, URL resolution and artifact redaction. Contract §5.
// Search order in cwd: caveman.config.yaml -> .yml -> .json; a missing file is not an error.
// Both gate spellings (flat SPEC-001 §4 and nested Master Plan §6) normalize to the flat form.

import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { EXIT, fail } from './errors.mjs';
import { canonicalJson } from './fsx.mjs';
import { parseYamlFile } from './yaml.mjs';
import { validateFile } from './validate.mjs';
import { sha16 } from './ids.mjs';

const CONFIG_FILENAMES = ['caveman.config.yaml', 'caveman.config.yml', 'caveman.config.json'];

// Nested gate key -> [nested leaf key, flat key].
const NESTED_GATES = {
  caveman: ['minimum', 'caveman_minimum'],
  heuristic: ['minimum', 'heuristic_minimum'],
  accessibility: ['minimum', 'accessibility_minimum'],
  technical: ['minimum', 'technical_minimum'],
  multilingual: ['minimum', 'multilingual_minimum'],
  critical_findings: ['maximum', 'critical_maximum'],
  evaluator_confidence: ['minimum', 'evaluator_confidence_minimum'],
};

const FLAT_GATES = new Set([
  'caveman_minimum',
  'heuristic_minimum',
  'accessibility_minimum',
  'technical_minimum',
  'multilingual_minimum',
  'critical_maximum',
  'evaluator_confidence_minimum',
]);

const REDACTED = '[redacted]';
const REDACTED_PATH = '[redacted-path]';

// Header names that carry credentials outright.
const SECRET_HEADER_KEYS = /^(authorization|cookie|proxy-authorization|x-api-key|api-key|token)$/i;
// Header values that look like a credential whatever the header is called.
const SECRET_HEADER_VALUES = /(bearer\s|sk-|ghp_|glpat-|eyJ[A-Za-z0-9_-]{10,})/i;
// Any key anywhere in the config whose value must never reach an artifact.
const SECRET_KEYS = /(password|secret|token|api[_-]?key|credential)/i;

/** Recursively freeze an object tree so DEFAULT_CONFIG can never be mutated in place. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const DEFAULT_CONFIG = deepFreeze({
  version: 1,
  report_locale: 'en',
  target: {
    base_url: null,
    routes: ['/'],
    locales: ['auto'],
    locale_prefixes: [],
    start_command: null,
    wait: { strategy: 'networkidle', timeout_ms: 20000, settle_ms: 400 },
    dismiss_selectors: [],
    storage_state: null,
    extra_http_headers: {},
  },
  viewports: [
    { id: 'mobile', width: 375, height: 812, device_scale_factor: 2 },
    { id: 'tablet', width: 768, height: 1024, device_scale_factor: 2 },
    { id: 'desktop', width: 1280, height: 800, device_scale_factor: 1 },
  ],
  browser: {
    channel: 'chrome',
    executable_path: null,
    headless: true,
    locale_header: true,
    color_scheme: 'light',
    reduced_motion: 'reduce',
  },
  evaluation: {
    caveman: true,
    heuristic: true,
    accessibility: true,
    technical: true,
    lighthouse_runs: 3,
    panel: { enabled: false, evaluators: [] },
  },
  privacy: { upload_screenshots: false, redact_selectors: [], retention_days: 30 },
  gates: {
    caveman_minimum: 75,
    heuristic_minimum: null,
    accessibility_minimum: 90,
    technical_minimum: 85,
    multilingual_minimum: null,
    critical_maximum: 0,
    evaluator_confidence_minimum: 0.60,
  },
  composite: {
    enabled: false,
    weights: { caveman: 0.35, heuristic_ux: 0.2, accessibility: 0.25, technical: 0.1, multilingual_consistency: 0.1 },
  },
  rules: { packs: ['core'], disabled: [], severity_overrides: {} },
});

/** True for a non-array object literal. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep-merge patch over base; arrays replace instead of concatenating. */
function deepMerge(base, patch) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(isPlainObject(patch) ? patch : {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) out[key] = value.slice();
    else if (isPlainObject(value)) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  }
  return out;
}

/** Rewrite nested gate spellings into the flat canonical keys. */
function normalizeGates(gates, warnings) {
  if (!isPlainObject(gates)) return gates;
  const flat = {};
  for (const [key, value] of Object.entries(gates)) {
    if (FLAT_GATES.has(key)) {
      flat[key] = value;
      continue;
    }
    const mapping = NESTED_GATES[key];
    if (!mapping) {
      warnings.push(`unknown gate key ignored: gates.${key}`);
      continue;
    }
    const [leaf, flatKey] = mapping;
    if (isPlainObject(value)) {
      if (value[leaf] !== undefined) flat[flatKey] = value[leaf];
      else warnings.push(`gates.${key} has no '${leaf}' field, ignored`);
    } else {
      flat[flatKey] = value;
    }
  }
  return flat;
}

/** Normalize one config-shaped document (file or overrides) before merging. */
function normalizeDocument(doc, warnings) {
  if (!isPlainObject(doc)) return {};
  const out = { ...doc };
  if (out.gates !== undefined) out.gates = normalizeGates(out.gates, warnings);
  return out;
}

/** Read a config document from disk by extension (.json parsed directly, otherwise YAML). */
async function readConfigFile(path) {
  if (path.endsWith('.json')) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      fail(`cannot parse config JSON ${path}: ${error.message}`, EXIT.CONFIG, { path });
    }
  }
  try {
    return await parseYamlFile(path);
  } catch (error) {
    if (error && error.exitCode) throw error;
    fail(`cannot parse config YAML ${path}: ${error.message}`, EXIT.CONFIG, { path });
  }
  return {};
}

/** Render one validator error as 'path: message'. */
function formatError(error) {
  if (typeof error === 'string') return error;
  const path = error?.path === '' || error?.path === undefined ? '(root)' : error.path;
  return `${path}: ${error?.message ?? JSON.stringify(error)}`;
}

/** Validate a config object against schemas/config.schema.json; returns formatted error strings. */
async function validateConfig(config) {
  // validateFile resolves a relative schema path against the skill root itself.
  const result = await validateFile('schemas/config.schema.json', config);
  return result.valid ? [] : (result.errors ?? []).map(formatError);
}

/** Load config from cwd (or configPath), merge over defaults, validate, and return it. */
export async function loadConfig({ cwd = process.cwd(), configPath = null, overrides = {} } = {}) {
  const warnings = [];
  const baseDir = isAbsolute(cwd) ? cwd : resolve(cwd);
  let source = 'defaults';
  let doc = {};

  if (configPath) {
    const path = isAbsolute(configPath) ? configPath : resolve(baseDir, configPath);
    if (!existsSync(path)) fail(`config file not found: ${configPath}`, EXIT.CONFIG, { path });
    doc = await readConfigFile(path);
    source = path;
  } else {
    for (const name of CONFIG_FILENAMES) {
      const path = join(baseDir, name);
      if (existsSync(path)) {
        doc = await readConfigFile(path);
        source = path;
        break;
      }
    }
  }

  if (doc !== null && !isPlainObject(doc)) {
    fail(`config root must be a mapping, got ${Array.isArray(doc) ? 'array' : typeof doc}`, EXIT.CONFIG, { source });
  }

  let config = structuredClone(DEFAULT_CONFIG);
  config = deepMerge(config, normalizeDocument(doc, warnings));
  config = deepMerge(config, normalizeDocument(overrides, warnings));

  if (config.version !== 1) warnings.push(`unsupported config version ${config.version}, treating it as version 1`);

  const errors = await validateConfig(config);
  if (errors.length > 0) {
    fail(`invalid config (${source}):\n  - ${errors.join('\n  - ')}`, EXIT.CONFIG, { source, errors });
  }

  return { config, source, warnings };
}

/** Locale prefixes as a plain list of prefix strings, from either an array or a {locale: prefix} map. */
function prefixList(localePrefixes) {
  if (Array.isArray(localePrefixes)) return localePrefixes.filter((p) => typeof p === 'string');
  if (isPlainObject(localePrefixes)) return Object.values(localePrefixes).filter((p) => typeof p === 'string');
  return [];
}

/** The configured prefix for one locale, or null when the locale has none. */
function localePrefixFor(localePrefixes, locale) {
  if (!locale || locale === 'auto') return null;
  const wanted = String(locale).toLowerCase();
  if (isPlainObject(localePrefixes)) {
    for (const [key, value] of Object.entries(localePrefixes)) {
      if (String(key).toLowerCase() === wanted && typeof value === 'string') return value;
    }
    return null;
  }
  for (const prefix of prefixList(localePrefixes)) {
    if (prefix.replace(/^\/+|\/+$/g, '').toLowerCase() === wanted) return prefix;
  }
  return null;
}

/** Normalize a route: lowercase, drop query/hash, strip locale prefix, strip trailing slash. */
export function normalizeRoute(route, localePrefixes = []) {
  let path = String(route ?? '/');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      // keep the raw string when it is not a parsable URL
    }
  }
  path = path.split('#')[0].split('?')[0];
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.toLowerCase();
  for (const prefix of prefixList(localePrefixes)) {
    const p = `/${prefix.replace(/^\/+|\/+$/g, '').toLowerCase()}`;
    if (p === '/') continue;
    if (path === p) {
      path = '/';
      break;
    }
    if (path.startsWith(`${p}/`)) {
      path = path.slice(p.length);
      break;
    }
  }
  path = path.replace(/\/+$/, '');
  return path === '' ? '/' : path;
}

/** Cartesian product route x locale x viewport; 'auto' collapses to one pseudo-locale. */
export function expandTargets(config) {
  const target = isPlainObject(config?.target) ? config.target : {};
  const routes = Array.isArray(target.routes) && target.routes.length > 0 ? target.routes : ['/'];
  const declared = Array.isArray(target.locales) ? target.locales.filter(Boolean) : [];
  const locales = declared.length === 0 || declared.includes('auto') ? ['auto'] : declared;
  const viewportSource =
    Array.isArray(config?.viewports) && config.viewports.length > 0 ? config.viewports : DEFAULT_CONFIG.viewports;
  const targets = [];
  for (const route of routes) {
    for (const locale of locales) {
      for (const viewport of viewportSource) targets.push({ route, locale, viewport: { ...viewport } });
    }
  }
  return targets;
}

/** Throw EXIT.CONFIG when the command needs target.base_url but the config has none. */
export function requireBaseUrl(config) {
  const baseUrl = config?.target?.base_url;
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    fail('target.base_url is not set — pass a URL argument or set target.base_url in caveman.config.yaml', EXIT.CONFIG);
  }
  return baseUrl.trim();
}

/** Absolute URL for one route + locale, inserting the configured locale prefix. */
export function resolveUrl(config, route, locale) {
  const base = requireBaseUrl(config).replace(/\/+$/, '');
  const prefix = localePrefixFor(config?.target?.locale_prefixes, locale);
  const pfx = prefix ? `/${prefix.replace(/^\/+|\/+$/g, '')}` : '';
  let path = String(route ?? '/');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  if (!path.startsWith('/')) path = `/${path}`;
  if (path === '/') return `${base}${pfx || '/'}`;
  return `${base}${pfx}${path}`;
}

/** First 16 hex of sha256 over the canonical JSON of the config. */
export function configHash(config) {
  return sha16(canonicalJson(config));
}

/** Replace every value under a secret-looking key, in place, at any depth. */
function redactSecretKeys(node) {
  if (Array.isArray(node)) {
    for (const child of node) redactSecretKeys(child);
    return;
  }
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (SECRET_KEYS.test(key)) node[key] = REDACTED;
    else redactSecretKeys(value);
  }
}

/**
 * Restore the credentials a run.json snapshot deliberately dropped, from the live config file.
 * Stages after `capture` (evidence, verify) reuse the run's pinned parameters but still need
 * real headers and a real storage_state to talk to an authenticated target. Secrets therefore
 * live in exactly one place — the config file — and are re-read per stage, never persisted.
 */
export function restoreCredentials(snapshot, live) {
  if (!isPlainObject(snapshot)) return snapshot;
  const clone = structuredClone(snapshot);
  const target = clone.target;
  const liveTarget = isPlainObject(live) && isPlainObject(live.target) ? live.target : {};
  if (!isPlainObject(target)) return clone;
  if (isPlainObject(target.extra_http_headers)) {
    for (const [key, value] of Object.entries(target.extra_http_headers)) {
      if (value !== REDACTED) continue;
      const liveValue = isPlainObject(liveTarget.extra_http_headers) ? liveTarget.extra_http_headers[key] : undefined;
      if (typeof liveValue === 'string') target.extra_http_headers[key] = liveValue;
      else delete target.extra_http_headers[key];
    }
  }
  if (target.storage_state === REDACTED_PATH) {
    target.storage_state = typeof liveTarget.storage_state === 'string' ? liveTarget.storage_state : null;
  }
  return clone;
}

/**
 * Credential fields that are still redaction markers after restoreCredentials, i.e. the config
 * file no longer supplies what the run was captured with. The caller must fail loud rather than
 * send the literal string `[redacted]` to the target.
 */
export function unresolvedCredentials(config) {
  const target = isPlainObject(config) && isPlainObject(config.target) ? config.target : {};
  const missing = [];
  if (isPlainObject(target.extra_http_headers)) {
    for (const [key, value] of Object.entries(target.extra_http_headers)) {
      if (value === REDACTED) missing.push(`target.extra_http_headers.${key}`);
    }
  }
  if (target.storage_state === REDACTED_PATH) missing.push('target.storage_state');
  return missing;
}

/** Deep-clone a config with credentials replaced, for the run.json / audit.json snapshot only. */
export function redactConfig(config) {
  // configHash() is deliberately computed over the REAL config; this clone is the snapshot
  // written into artifacts, so the two must never be swapped. Everything that is not a
  // credential stays byte-identical, which keeps the snapshot diffable against the hash input.
  if (!isPlainObject(config)) return config;
  const clone = structuredClone(config);
  redactSecretKeys(clone);
  const target = clone.target;
  if (isPlainObject(target)) {
    if (isPlainObject(target.extra_http_headers)) {
      for (const [key, value] of Object.entries(target.extra_http_headers)) {
        if (SECRET_HEADER_KEYS.test(key) || (typeof value === 'string' && SECRET_HEADER_VALUES.test(value))) {
          target.extra_http_headers[key] = REDACTED;
        }
      }
    }
    // storage_state is a path to a cookie/token jar: the path itself names the file to steal.
    if (target.storage_state !== null && target.storage_state !== undefined) target.storage_state = REDACTED_PATH;
  }
  return clone;
}
