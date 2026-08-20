// Stable identifiers for runs, screens and findings.
// Contract §7 — every id must be reproducible from its inputs alone, so a rerun
// of the same target produces the same finding ids. SPEC-001 §9's ">= 98% id stability"
// applies to DETERMINISTIC findings, whose inputs (rule + route + locale + viewport +
// stable selector) do not move between runs at all. Heuristic ids also fold in a
// 5%-quantised evidence region, so they are only stable while the region stays inside the
// same grid cell: measured retention under +/-2px jitter on a 375px axis is ~72%, not 98%.
// That is by design — a model-authored evidence box moves far more than 2px between runs,
// which is why verify() has a `not-comparable` status instead of pretending otherwise.
// Uses node:crypto directly: no dependency on fsx.mjs, so ids stay unit-testable.

import { createHash, randomBytes } from 'node:crypto';

/** Full sha256 hex digest of a string (internal helper for the id builders). */
function sha256Hex(str) {
  return createHash('sha256').update(String(str), 'utf8').digest('hex');
}

/** First 16 hex chars of sha256(str) — finding id length. */
export function sha16(str) {
  return sha256Hex(str).slice(0, 16);
}

/** First 12 hex chars of sha256(str) — screen id length. */
export function sha12(str) {
  return sha256Hex(str).slice(0, 12);
}

/** New run id 'run_YYYYMMDDTHHMMSSZ_<6hex>' built from UTC, never local time. */
export function newRunId(now = new Date()) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `run_${stamp}_${randomBytes(3).toString('hex')}`;
}

/** Opaque screen id — the only screen handle a blind evaluator ever sees. */
export function screenId(runId, route, locale, viewportId) {
  return `scr_${sha12(`${runId}|${route}|${locale}|${viewportId}`)}`;
}

/** Finding id for deterministic checks, keyed on the stable DOM selector. */
export function deterministicFindingId({ ruleId, normalizedRoute, locale, viewport, stableSelector: selector }) {
  return sha16(`${ruleId}|${normalizedRoute}|${locale}|${viewport}|${selector}`);
}

/** Finding id for agent-produced findings, keyed on a quantized screen region. */
export function heuristicFindingId({ ruleId, normalizedRoute, locale, viewport, region, viewportSize }) {
  return sha16(`${ruleId}|${normalizedRoute}|${locale}|${viewport}|${quantizeRegion(region, viewportSize)}`);
}

/** Snap one coordinate to the 5% grid, clamped to 0..1, formatted to 2 decimals. */
function snap(value, size) {
  const ratio = Number(value) / Number(size);
  const clamped = Math.min(1, Math.max(0, ratio));
  return (Math.round(clamped * 20) / 20).toFixed(2);
}

/** Quantize a pixel box to a 5% grid string so ±2px jitter keeps the finding id. */
export function quantizeRegion(box, viewportSize) {
  const width = Number(viewportSize?.width);
  const height = Number(viewportSize?.height);
  const usable = box && Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
  if (!usable) return 'x:0,y:0,w:1,h:1';
  const x = Number(box.x);
  const y = Number(box.y);
  const w = Number(box.w ?? box.width);
  const h = Number(box.h ?? box.height);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return 'x:0,y:0,w:1,h:1';
  return `x:${snap(x, width)},y:${snap(y, height)},w:${snap(w, width)},h:${snap(h, height)}`;
}

/** CSS-escape-free id selector when the id is simple, attribute selector otherwise. */
function idSelector(id) {
  return /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : `[id="${String(id).replace(/"/g, '\\"')}"]`;
}

/** Stable selector for a DOM node descriptor: '#id' first, then an nth-of-type path. */
export function stableSelector(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.id) return idSelector(node.id);
  if (node.selector) return node.selector;
  if (node.path) return node.path;
  const tag = String(node.tagName || node.tag || '').toLowerCase();
  if (!tag) return '';
  const nth = node.nthOfType ?? node.nth_of_type;
  const step = Number.isFinite(Number(nth)) ? `${tag}:nth-of-type(${Number(nth)})` : tag;
  const parent = node.parent ? stableSelector(node.parent) : '';
  return parent ? `${parent} > ${step}` : step;
}
