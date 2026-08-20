// Multilingual consistency matrix, Stage F (contract §13).
// Pure functions over already-captured DOM evidence: no browser, no network, no npm deps.
// The caller sets matrix.score = multilingualScore(matrix) from lib/scoring.mjs; this module
// deliberately returns score: null so the score formula lives in exactly one place.

import { deterministicFindingId } from './ids.mjs';
import { normalizeRoute } from './config.mjs';
import { scriptRatios } from './checks.mjs';

const RULE_VERSION = '1.0.0';
// Contract §13: residual Latin text above this ratio in a non-Latin locale is untranslated copy.
const RESIDUAL_LATIN_MAX = 0.35;
// Contract §13: this locale's character count above 1.4x the reference locale is text expansion.
const TEXT_EXPANSION_FACTOR = 1.4;
// Target locales whose base language is not written in Latin script.
const NON_LATIN_BASES = new Set(['zh', 'ja', 'ko', 'th', 'ar', 'he', 'ru', 'el', 'hi']);
const SCRIPT_KEYS = ['latin', 'han', 'kana', 'hangul', 'cyrillic'];
// Pseudo viewport for route-level findings that exist without any captured screen.
const ALL_VIEWPORTS = 'all';

/** Round a ratio to 4 decimals so matrix values and reports stay byte-stable. */
function round4(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num * 10000) / 10000 : 0;
}

/** Base language subtag of a locale tag ('zh-Hant-TW' -> 'zh'); 'auto' stays 'auto'. */
function baseLanguage(code) {
  return String(code || '').split('-')[0].toLowerCase();
}

/** True when the target locale is written in a non-Latin script (contract §13). */
function isNonLatinLocale(locale) {
  return NON_LATIN_BASES.has(baseLanguage(locale));
}

/** Script ratios of a text as {latin,han,kana,hangul,cyrillic,other} over non-whitespace. */
export function detectScripts(text) {
  const raw = scriptRatios(text) || {};
  const out = {};
  let sum = 0;
  for (const key of SCRIPT_KEYS) {
    const value = round4(raw[key]);
    out[key] = value;
    sum += value;
  }
  out.other = Number.isFinite(Number(raw.other)) ? round4(raw.other) : round4(Math.max(0, 1 - sum));
  return out;
}

export { scriptRatios };

/** Configured target locales, collapsing an empty/'auto' config to the 'auto' pseudo-locale. */
function configuredLocales(config) {
  const declared = Array.isArray(config?.target?.locales)
    ? config.target.locales.filter((locale) => typeof locale === 'string' && locale.trim() !== '')
    : [];
  return declared.length ? declared : ['auto'];
}

/** Longest whitespace-delimited token in a text, truncated for report safety. */
function longestWord(text) {
  let longest = '';
  for (const token of String(text || '').split(/\s+/)) {
    if (token.length > longest.length) longest = token;
  }
  return longest.slice(0, 40);
}

/** Up to `max` Latin-script fragments from a text, used as untranslated-copy evidence. */
function latinFragments(text, max = 3) {
  const out = [];
  for (const match of String(text || '').matchAll(/[A-Za-z][A-Za-z0-9'’\- ]{3,60}/g)) {
    const value = match[0].trim();
    if (value.length >= 4) out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

/** Per-viewport evidence entry for one captured screen; nulls when dom.json is absent. */
function screenEntry(screen, dom) {
  const overflow = dom?.overflow || null;
  const scrollWidth = Number(overflow?.documentScrollWidth);
  const clientWidth = Number(overflow?.clientWidth);
  const hasOverflowMetrics = Number.isFinite(scrollWidth) && Number.isFinite(clientWidth);
  const buttons = Array.isArray(dom?.buttons) ? dom.buttons : [];
  const labelled = buttons.filter((button) => String(button?.text || '').trim() !== '');
  const primary = labelled.find((button) => button?.isPrimaryCandidate) || null;
  const visibleText = typeof dom?.visible_text === 'string' ? dom.visible_text : '';
  const stats = dom?.text_stats || null;
  const ratios = stats?.script_ratios || null;
  return {
    screen_id: screen?.screen_id ?? null,
    viewport: screen?.viewport?.id ?? screen?.viewport ?? null,
    url: screen?.url ?? null,
    has_dom: Boolean(dom),
    lang: dom?.lang || null,
    hreflang: Array.isArray(dom?.hreflang) ? dom.hreflang : [],
    // CTA proxy: buttons with visible text. A "primary" CTA is the first primary candidate.
    cta_count: labelled.length,
    primary_cta_text: primary ? String(primary.text).trim() : null,
    residual_ratio: ratios ? round4(ratios.latin) : round4(detectScripts(visibleText).latin),
    overflow: hasOverflowMetrics ? scrollWidth > clientWidth + 1 : false,
    document_scroll_width: hasOverflowMetrics ? scrollWidth : null,
    client_width: hasOverflowMetrics ? clientWidth : null,
    overflow_offenders: Array.isArray(overflow?.offenders) ? overflow.offenders : [],
    tap_target_issues: Array.isArray(dom?.tap_targets) ? dom.tap_targets.length : 0,
    chars: Number.isFinite(Number(stats?.chars)) ? Number(stats.chars) : visibleText.length,
    longest_word: longestWord(visibleText),
    visible_text: visibleText,
  };
}

/** Aggregate the per-viewport entries of one route+locale into a matrix cell. */
function buildCell(locale, entries) {
  const rep = entries[0];
  const hreflang = rep.hreflang;
  const hasSelf = locale !== 'auto'
    && hreflang.some((entry) => baseLanguage(entry?.hreflang) === baseLanguage(locale));
  return {
    screen_id: rep.screen_id,
    lang: rep.lang,
    hreflang_ok: hreflang.length > 0 && (locale === 'auto' || hasSelf),
    cta_count: rep.cta_count,
    primary_cta_text: rep.primary_cta_text,
    residual_ratio: rep.residual_ratio,
    // A locale overflows when ANY captured viewport overflows.
    overflow: entries.some((entry) => entry.overflow),
    chars: rep.chars,
    longest_word: rep.longest_word,
    // Additions beyond the contract cell fields: findings need the offending viewport and
    // the raw hreflang list, and rules must stay silent when Stage D produced no dom.json.
    has_dom: entries.some((entry) => entry.has_dom),
    screens: entries,
  };
}

/** Reference locale: first configured locale, or the best-covered one when it is 'auto'. */
function referenceLocale(matrix, config) {
  const configured = configuredLocales(config);
  const first = configured[0];
  if (first && first !== 'auto') return first;
  const counts = new Map();
  for (const row of matrix?.rows || []) {
    for (const [locale, cell] of Object.entries(row.by_locale || {})) {
      if (!cell) continue;
      counts.set(locale, (counts.get(locale) || 0) + (cell.screens?.length || 1));
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  return ranked.length ? ranked[0][0] : first || 'auto';
}

/** Build one canonical multilingual Finding. */
function makeFinding({
  ruleId, severity, title, detail, row, locale, viewport, screenId, url, selector, evidence, fixBrief,
}) {
  const target = {
    route: row.route,
    normalized_route: row.normalized_route,
    locale,
    viewport,
    screen_id: screenId ?? null,
    url: url ?? null,
  };
  return {
    id: deterministicFindingId({
      ruleId,
      normalizedRoute: row.normalized_route,
      locale,
      viewport,
      stableSelector: selector,
    }),
    rule_id: ruleId,
    rule_version: RULE_VERSION,
    kind: 'multilingual',
    severity,
    confidence: 1.0,
    title,
    detail,
    target,
    evidence,
    fix_brief: { ...fixBrief, rule_ids: [ruleId], target },
    status: 'open',
  };
}

/** Representative viewport id of a cell, for route-level findings. */
function cellViewport(cell) {
  return cell?.screens?.[0]?.viewport ?? ALL_VIEWPORTS;
}

/** Emit every I18N.* finding implied by an already-built locale matrix (contract §13). */
export function localeMatrixFindings(matrix, config = {}) {
  const locales = Array.isArray(matrix?.locales) ? matrix.locales : [];
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];
  const reference = matrix?.reference_locale || referenceLocale(matrix, config);
  // Comparative rules need at least two locales to compare; single-locale runs would
  // otherwise duplicate what the TECH.* deterministic checks already report.
  const comparative = locales.length >= 2;
  const findings = [];

  for (const row of rows) {
    const refCell = row.by_locale?.[reference] ?? null;
    for (const locale of locales) {
      const cell = row.by_locale?.[locale] ?? null;

      if (!cell) {
        if (!comparative) continue;
        findings.push(makeFinding({
          ruleId: 'I18N.MISSING_ROUTE',
          severity: 'major',
          title: `Locale ${locale} has no captured screen for ${row.normalized_route}`,
          detail: `The run configured locale '${locale}' but no screen for ${row.normalized_route} was captured successfully, so this route cannot be compared across locales.`,
          row,
          locale,
          viewport: ALL_VIEWPORTS,
          screenId: null,
          url: null,
          selector: 'html',
          evidence: [
            { type: 'metric', name: 'successful_screens', value: 0, unit: 'screens' },
            { type: 'manual_note', value: `locale '${locale}' produced no successful screen for ${row.normalized_route}` },
          ],
          fixBrief: {
            intent: 'Serve this route successfully in every configured locale',
            acceptance: [
              `the ${locale} URL of ${row.normalized_route} responds with a 2xx status`,
              `a ${locale} screen for ${row.normalized_route} appears in the locale matrix`,
            ],
            suggested_change: `Add the missing ${locale} route or fix the locale prefix mapping in target.locale_prefixes.`,
          },
        }));
        continue;
      }

      const viewport = cellViewport(cell);
      const rep = cell.screens?.[0] || {};
      const hreflang = rep.hreflang || [];
      const isReference = locale === reference;

      // Rules below read DOM evidence; without dom.json we make no claim at all.
      if (!cell.has_dom) continue;

      if (isNonLatinLocale(locale) && cell.residual_ratio > RESIDUAL_LATIN_MAX) {
        const fragments = latinFragments(rep.visible_text);
        findings.push(makeFinding({
          ruleId: 'I18N.RESIDUAL_LANGUAGE',
          severity: 'major',
          title: `Untranslated Latin text remains in the ${locale} screen`,
          detail: `${Math.round(cell.residual_ratio * 100)}% of the non-whitespace visible text is Latin script while the target locale is ${locale}, which points at copy that was never translated.`,
          row,
          locale,
          viewport,
          screenId: cell.screen_id,
          url: rep.url,
          selector: 'html',
          evidence: [
            { type: 'metric', name: 'latin_script_ratio', value: cell.residual_ratio, unit: 'ratio' },
            { type: 'metric', name: 'latin_script_ratio_threshold', value: RESIDUAL_LATIN_MAX, unit: 'ratio' },
            ...fragments.map((value) => ({ type: 'text', value })),
          ],
          fixBrief: {
            intent: `Translate the remaining Latin-script copy on the ${locale} screen`,
            acceptance: [
              `the ${locale} screen's Latin script ratio drops below ${RESIDUAL_LATIN_MAX}`,
              'no English placeholder copy is visible in the first viewport',
            ],
            suggested_change: fragments.length
              ? `Translate or remove the untranslated strings, starting with: ${fragments.join(' | ')}`
              : 'Translate the remaining Latin-script strings on this screen.',
          },
        }));
      }

      if (locale !== 'auto' && cell.lang && baseLanguage(cell.lang) !== baseLanguage(locale)) {
        findings.push(makeFinding({
          ruleId: 'I18N.LANG_ATTR_MISMATCH',
          severity: 'major',
          title: `<html lang="${cell.lang}"> does not match target locale ${locale}`,
          detail: `The document declares lang="${cell.lang}" while this screen was requested as ${locale}. Screen readers, hyphenation and translation tooling all follow the lang attribute, so the mismatch mislabels the whole page.`,
          row,
          locale,
          viewport,
          screenId: cell.screen_id,
          url: rep.url,
          selector: 'html',
          evidence: [
            { type: 'dom', selector: 'html', node_path: 'html', html: `<html lang="${cell.lang}">` },
            { type: 'text', value: `target_locale=${locale} html_lang=${cell.lang}` },
          ],
          fixBrief: {
            intent: 'Emit the served locale in the html lang attribute',
            acceptance: [`the ${locale} screen renders <html lang> with base language ${baseLanguage(locale)}`],
            suggested_change: `Set lang="${locale}" (or its base language) when rendering the ${locale} variant.`,
          },
        }));
      }

      if (comparative && !isReference && refCell && refCell.has_dom) {
        const ctaMismatch = cell.cta_count !== refCell.cta_count;
        const primaryMissing = Boolean(refCell.primary_cta_text) && !cell.primary_cta_text;
        if (ctaMismatch || primaryMissing) {
          findings.push(makeFinding({
            ruleId: 'I18N.CTA_PARITY',
            severity: 'major',
            title: `Call-to-action set differs between ${locale} and ${reference}`,
            detail: primaryMissing
              ? `The ${reference} screen exposes a primary call to action but the ${locale} screen does not, so this locale loses the main conversion path.`
              : `The ${locale} screen shows ${cell.cta_count} labelled call(s) to action against ${refCell.cta_count} in the ${reference} reference locale.`,
            row,
            locale,
            viewport,
            screenId: cell.screen_id,
            url: rep.url,
            selector: 'html',
            evidence: [
              { type: 'metric', name: 'cta_count', value: cell.cta_count, unit: 'buttons' },
              { type: 'metric', name: 'reference_cta_count', value: refCell.cta_count, unit: 'buttons' },
              { type: 'text', value: `${locale} primary CTA: ${cell.primary_cta_text ?? '(none)'}` },
              { type: 'text', value: `${reference} primary CTA: ${refCell.primary_cta_text ?? '(none)'}` },
            ],
            fixBrief: {
              intent: `Give the ${locale} screen the same call-to-action set as ${reference}`,
              acceptance: [
                `the ${locale} screen exposes ${refCell.cta_count} labelled call(s) to action`,
                'the primary call to action is present and labelled in every locale',
              ],
              suggested_change: 'Translate the missing CTA labels instead of hiding the buttons in this locale.',
            },
          }));
        }

        if (cell.overflow && !refCell.overflow) {
          const offending = cell.screens.find((entry) => entry.overflow) || rep;
          findings.push(makeFinding({
            ruleId: 'I18N.OVERFLOW',
            severity: 'major',
            title: `The ${locale} screen scrolls horizontally where ${reference} does not`,
            detail: `At the ${offending.viewport} viewport the ${locale} document scrolls to ${offending.document_scroll_width}px inside a ${offending.client_width}px client width, while the ${reference} locale fits. Longer translated strings are breaking the layout.`,
            row,
            locale,
            viewport: offending.viewport ?? viewport,
            screenId: offending.screen_id ?? cell.screen_id,
            url: offending.url ?? rep.url,
            selector: offending.overflow_offenders?.[0]?.selector || 'html',
            evidence: [
              { type: 'metric', name: 'document_scroll_width', value: offending.document_scroll_width, unit: 'px' },
              { type: 'metric', name: 'client_width', value: offending.client_width, unit: 'px' },
              ...(offending.overflow_offenders || []).slice(0, 3).map((entry) => ({
                type: 'dom',
                selector: String(entry?.selector || ''),
                node_path: String(entry?.selector || ''),
                html: '',
              })),
            ],
            fixBrief: {
              intent: `Make the ${locale} layout fit its viewport`,
              acceptance: [`documentScrollWidth <= clientWidth + 1 on the ${locale} ${offending.viewport} screen`],
              suggested_change: 'Allow the offending element to wrap or shrink instead of assuming reference-locale string lengths.',
            },
          }));
        }

        const expansion = refCell.chars > 0 ? cell.chars / refCell.chars : 0;
        const layoutStressed = cell.overflow || (rep.tap_target_issues || 0) > 0;
        if (expansion > TEXT_EXPANSION_FACTOR && layoutStressed) {
          findings.push(makeFinding({
            ruleId: 'I18N.TEXT_EXPANSION',
            severity: 'minor',
            title: `The ${locale} copy is ${expansion.toFixed(2)}x longer than ${reference} and the layout is already stressed`,
            detail: `This screen renders ${cell.chars} characters against ${refCell.chars} in ${reference} (${expansion.toFixed(2)}x) while also reporting overflow or undersized tap targets, so the extra text is what pushes the layout past its limits.`,
            row,
            locale,
            viewport,
            screenId: cell.screen_id,
            url: rep.url,
            selector: 'html',
            evidence: [
              { type: 'metric', name: 'chars', value: cell.chars, unit: 'chars' },
              { type: 'metric', name: 'reference_chars', value: refCell.chars, unit: 'chars' },
              { type: 'metric', name: 'expansion_ratio', value: round4(expansion), unit: 'ratio' },
              { type: 'text', value: `longest word: ${cell.longest_word}` },
            ],
            fixBrief: {
              intent: 'Design the layout for the longest locale, not the shortest',
              acceptance: [
                `the ${locale} screen has no overflow and no tap target under 24px`,
                'copy length changes do not break the layout',
              ],
              suggested_change: `Allow wrapping and flexible widths, or shorten the ${locale} copy; the longest token is "${cell.longest_word}".`,
            },
          }));
        }
      }

      if (comparative && hreflang.length === 0) {
        findings.push(makeFinding({
          ruleId: 'I18N.HREFLANG.MISSING',
          severity: 'major',
          title: `The ${locale} screen declares no hreflang alternates`,
          detail: `${locales.length} locales are configured but this document has no hreflang link, so search engines and browsers cannot discover the other language variants of ${row.normalized_route}.`,
          row,
          locale,
          viewport,
          screenId: cell.screen_id,
          url: rep.url,
          selector: 'head',
          evidence: [
            { type: 'metric', name: 'hreflang_link_count', value: 0, unit: 'links' },
            { type: 'metric', name: 'configured_locales', value: locales.length, unit: 'locales' },
          ],
          fixBrief: {
            intent: 'Declare every locale variant of this route with hreflang',
            acceptance: [`the ${locale} screen emits one hreflang link per configured locale plus x-default`],
            suggested_change: 'Render <link rel="alternate" hreflang="..."> for every locale variant of this route.',
          },
        }));
      }

      if (hreflang.length > 0 && locale !== 'auto'
        && !hreflang.some((entry) => baseLanguage(entry?.hreflang) === baseLanguage(locale))) {
        findings.push(makeFinding({
          ruleId: 'I18N.HREFLANG.NO_SELF',
          severity: 'minor',
          title: `The hreflang set on the ${locale} screen has no self-reference`,
          detail: `The document lists hreflang alternates but none of them points back at ${locale}, which makes the alternate set ambiguous for crawlers.`,
          row,
          locale,
          viewport,
          screenId: cell.screen_id,
          url: rep.url,
          selector: 'head',
          evidence: [
            { type: 'metric', name: 'hreflang_link_count', value: hreflang.length, unit: 'links' },
            { type: 'text', value: hreflang.map((entry) => String(entry?.hreflang || '')).join(', ') },
          ],
          fixBrief: {
            intent: 'Include a self-referencing hreflang entry',
            acceptance: [`the ${locale} screen lists hreflang="${locale}" pointing at its own URL`],
            suggested_change: `Add <link rel="alternate" hreflang="${locale}" href="<this url>">.`,
          },
        }));
      }

      if (hreflang.length > 0
        && !hreflang.some((entry) => String(entry?.hreflang || '').toLowerCase() === 'x-default')) {
        findings.push(makeFinding({
          ruleId: 'I18N.HREFLANG.NO_XDEFAULT',
          severity: 'info',
          title: `The hreflang set on the ${locale} screen has no x-default entry`,
          detail: 'Without x-default there is no declared fallback for visitors whose language matches none of the listed locales.',
          row,
          locale,
          viewport,
          screenId: cell.screen_id,
          url: rep.url,
          selector: 'head',
          evidence: [
            { type: 'metric', name: 'hreflang_link_count', value: hreflang.length, unit: 'links' },
            { type: 'text', value: hreflang.map((entry) => String(entry?.hreflang || '')).join(', ') },
          ],
          fixBrief: {
            intent: 'Declare a fallback locale with x-default',
            acceptance: ['the hreflang set includes one hreflang="x-default" entry'],
            suggested_change: 'Add <link rel="alternate" hreflang="x-default" href="<default url>">.',
          },
        }));
      }
    }
  }

  return findings;
}

/** Build the locale x route matrix and its I18N.* findings; score is left to scoring.mjs. */
export function buildLocaleMatrix({ screens = [], domByScreen = {}, config = {} } = {}) {
  const prefixes = config?.target?.locale_prefixes ?? [];
  const locales = [...configuredLocales(config)];
  const routeOrder = [];
  const cells = new Map();

  for (const screen of Array.isArray(screens) ? screens : []) {
    if (!screen || screen.status !== 'ok') continue;
    const locale = screen.locale ?? 'auto';
    if (!locales.includes(locale)) locales.push(locale);
    const normalized = screen.normalized_route || normalizeRoute(screen.route ?? '/', prefixes);
    if (!cells.has(normalized)) {
      cells.set(normalized, { route: screen.route ?? normalized, byLocale: new Map() });
      routeOrder.push(normalized);
    }
    const row = cells.get(normalized);
    if (!row.byLocale.has(locale)) row.byLocale.set(locale, []);
    row.byLocale.get(locale).push(screenEntry(screen, domByScreen?.[screen.screen_id] || null));
  }

  const rows = routeOrder.map((normalized) => {
    const source = cells.get(normalized);
    const byLocale = {};
    for (const locale of locales) {
      const entries = source.byLocale.get(locale);
      byLocale[locale] = entries && entries.length ? buildCell(locale, entries) : null;
    }
    return { route: source.route, normalized_route: normalized, by_locale: byLocale };
  });

  const matrix = { locales, rows, reference_locale: '', findings: [], score: null };
  matrix.reference_locale = referenceLocale(matrix, config);
  matrix.findings = localeMatrixFindings(matrix, config);
  return matrix;
}
