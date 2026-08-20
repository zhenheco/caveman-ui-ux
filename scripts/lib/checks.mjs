// Deterministic DOM evidence + rule engine (Stage D). runChecks is pure over DomEvidence.
import { deterministicFindingId } from './ids.mjs';

const RULE_VERSION = '1.0.0';
const MAX_FINDINGS_PER_RULE = 10;
const MAX_EVIDENCE_NODES = 5;
const MIN_TEXT_CHARS_FOR_SCRIPT_CHECK = 30;
const TAP_TARGET_MIN_PX = 24;
const LINK_CONCURRENCY = 6;
const VISIBLE_TEXT_CHARS = 4000;

const SCRIPT_KEYS = ['latin', 'han', 'kana', 'hangul', 'cyrillic', 'other'];

// Code-point ranges per script. Digits, punctuation and emoji fall through to 'other'.
const SCRIPT_RANGES = {
  latin: [[0x41, 0x5a], [0x61, 0x7a], [0xc0, 0x24f], [0x1e00, 0x1eff], [0x2c60, 0x2c7f], [0xa720, 0xa7ff], [0xff21, 0xff3a], [0xff41, 0xff5a]],
  han: [[0x2e80, 0x2eff], [0x3005, 0x3007], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0x20000, 0x2a6df], [0x2a700, 0x2ebef], [0x2f800, 0x2fa1f]],
  kana: [[0x3041, 0x309f], [0x30a0, 0x30ff], [0x31f0, 0x31ff], [0xff66, 0xff9d]],
  hangul: [[0x1100, 0x11ff], [0x3130, 0x318f], [0xa960, 0xa97f], [0xac00, 0xd7af]],
  cyrillic: [[0x400, 0x52f], [0x2de0, 0x2dff], [0xa640, 0xa69f]],
};

// Expected dominant scripts per language base, used by TECH.LANG.MISMATCH only.
const EXPECTED_SCRIPTS = {
  zh: ['han'], ja: ['kana', 'han'], ko: ['hangul', 'han'], yue: ['han'],
  ru: ['cyrillic'], uk: ['cyrillic'], be: ['cyrillic'], bg: ['cyrillic'], mk: ['cyrillic'], kk: ['cyrillic'], sr: ['cyrillic', 'latin'],
  en: ['latin'], vi: ['latin'], de: ['latin'], fr: ['latin'], es: ['latin'], pt: ['latin'], it: ['latin'],
  nl: ['latin'], id: ['latin'], ms: ['latin'], tl: ['latin'], tr: ['latin'], pl: ['latin'], cs: ['latin'],
  sk: ['latin'], sv: ['latin'], da: ['latin'], nb: ['latin'], no: ['latin'], fi: ['latin'], ro: ['latin'],
  hu: ['latin'], hr: ['latin'], sl: ['latin'], et: ['latin'], lv: ['latin'], lt: ['latin'],
};

const SKIPPED_CONTROL_TYPES = new Set(['hidden', 'submit', 'reset', 'button', 'image']);
const SKIPPED_LINK_PROTOCOLS = /^(mailto:|tel:|sms:|javascript:|data:|blob:|about:)/i;

/** Classify one code point into a script bucket. */
function classifyCodePoint(cp) {
  for (const key of SCRIPT_KEYS) {
    const ranges = SCRIPT_RANGES[key];
    if (!ranges) continue;
    for (const [lo, hi] of ranges) {
      if (cp >= lo && cp <= hi) return key;
    }
  }
  return 'other';
}

/** Ratios of latin/han/kana/hangul/cyrillic/other over the non-whitespace characters of `text`. */
export function scriptRatios(text) {
  const counts = { latin: 0, han: 0, kana: 0, hangul: 0, cyrillic: 0, other: 0 };
  let total = 0;
  for (const ch of String(text ?? '')) {
    if (/\s/.test(ch)) continue;
    total += 1;
    counts[classifyCodePoint(ch.codePointAt(0))] += 1;
  }
  const out = {};
  for (const key of SCRIPT_KEYS) {
    out[key] = total ? Math.round((counts[key] / total) * 10000) / 10000 : 0;
  }
  return out;
}

/** Highest-ratio real script of `text` ('other' never wins); null when no script chars exist. */
export function dominantScript(text) {
  const ratios = scriptRatios(text);
  let best = null;
  let bestValue = 0;
  for (const key of SCRIPT_KEYS) {
    if (key === 'other') continue;
    if (ratios[key] > bestValue) {
      best = key;
      bestValue = ratios[key];
    }
  }
  return bestValue > 0 ? best : null;
}

/** Normalize a screen target into the canonical Finding.target shape. */
function findingTarget(target) {
  const t = target || {};
  const viewport = t.viewport && typeof t.viewport === 'object' ? t.viewport.id : t.viewport;
  return {
    route: t.route ?? null,
    normalized_route: t.normalized_route ?? t.normalizedRoute ?? t.route ?? null,
    locale: t.locale ?? null,
    viewport: viewport ?? null,
    screen_id: t.screen_id ?? t.screenId ?? null,
    url: t.url ?? null,
  };
}

/** Build a canonical deterministic Finding. */
function makeFinding({ ruleId, severity, selector, title, detail, evidence, fix, target }) {
  return {
    id: deterministicFindingId({
      ruleId,
      normalizedRoute: target.normalized_route,
      locale: target.locale,
      viewport: target.viewport,
      stableSelector: selector,
    }),
    rule_id: ruleId,
    rule_version: RULE_VERSION,
    kind: 'deterministic',
    severity,
    confidence: 1.0,
    title,
    detail,
    target,
    evidence,
    fix_brief: {
      intent: fix.intent,
      acceptance: fix.acceptance,
      suggested_change: fix.suggested_change,
      rule_ids: [ruleId],
      target,
    },
    status: 'open',
  };
}

/** DOM evidence entry. */
function domEv(selector, nodePath = '', html = '') {
  return { type: 'dom', selector: selector || '', node_path: nodePath || selector || '', html };
}

/** Numeric evidence entry. */
function metricEv(name, value, unit) {
  return { type: 'metric', name, value, unit };
}

/** Free-text evidence entry. */
function textEv(value) {
  return { type: 'text', value: String(value ?? '').slice(0, 400) };
}

/** Word count of a whitespace-separated string (CJK is under-counted by design). */
function wordCount(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

/** Derive DomEvidence.text_stats from the full visible text. */
function textStats(text) {
  const normalized = String(text || '').replace(/\r/g, '');
  let longest = 0;
  for (const block of normalized.split(/\n+/)) {
    longest = Math.max(longest, wordCount(block));
  }
  const ratios = scriptRatios(normalized);
  return {
    chars: normalized.length,
    words: wordCount(normalized),
    longest_paragraph_words: longest,
    script_ratios: {
      latin: ratios.latin,
      han: ratios.han,
      kana: ratios.kana,
      hangul: ratios.hangul,
      cyrillic: ratios.cyrillic,
    },
  };
}

/** Walk the live DOM in a single page.evaluate and return the DomEvidence snapshot. */
export async function collectDom(page) {
  const snapshot = await page.evaluate(() => {
    const MAX_ELEMENTS = 4000;
    const MAX_TEXT = 200000;
    const MAX_LINKS = 400;
    const MAX_IMAGES = 300;
    const MAX_CONTROLS = 300;
    const MAX_HEADINGS = 200;
    const MAX_TAP_TARGETS = 50;
    const MAX_OFFENDERS = 10;
    const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [onclick], [tabindex]';
    const PRIMARY_HINT = /(primary|cta|hero|signup|sign-up|submit|action)/i;

    const all = (selector) => Array.prototype.slice.call(document.querySelectorAll(selector));
    const count = (selector) => document.querySelectorAll(selector).length;
    const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    const attr = (el, name) => (el.hasAttribute(name) ? el.getAttribute(name) : null);
    const metaContent = (name) => {
      const el = document.querySelector('meta[name="' + name + '"]');
      return el ? attr(el, 'content') : null;
    };

    // Stable selector: a unique '#id' when available, else an untruncated nth-of-type path from
    // the document root (mirrors ids.stableSelector; it cannot be imported because page.evaluate
    // runs with no module scope). Every returned selector is verified to match exactly one
    // element, so two different elements never share a selector on the same page.
    const simpleIdRe = /^[A-Za-z][\w-]*$/;
    const idSelector = (id) => (simpleIdRe.test(id) ? '#' + id : '[id="' + String(id).replace(/["\\]/g, '\\$&') + '"]');
    const matchCount = (selector) => {
      if (!selector) return 0;
      try {
        return document.querySelectorAll(selector).length;
      } catch {
        return 0;
      }
    };
    // exact=true emits ':root' plus '*:nth-child(n)' at every level: root-anchored, unique by
    // construction, and immune to the case-sensitivity of XML tag names (SVG's clipPath).
    function pathFor(el, exact) {
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1) {
        const parent = node.parentElement;
        if (!exact && node !== el && node.id && matchCount(idSelector(node.id)) === 1) {
          parts.unshift(idSelector(node.id));
          break;
        }
        if (!parent) {
          parts.unshift(exact ? ':root' : node.tagName.toLowerCase());
          break;
        }
        if (exact) {
          parts.unshift('*:nth-child(' + (Array.prototype.indexOf.call(parent.children, node) + 1) + ')');
        } else {
          const tag = node.tagName.toLowerCase();
          const sameTag = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
          parts.unshift(sameTag.length > 1 ? tag + ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')' : tag);
        }
        node = parent;
      }
      return parts.join(' > ');
    }
    function selectorFor(el) {
      if (!el || el.nodeType !== 1) return '';
      if (el.id && matchCount(idSelector(el.id)) === 1) return idSelector(el.id);
      const readable = pathFor(el, false);
      if (matchCount(readable) === 1) return readable;
      return pathFor(el, true);
    }

    function boxOf(el) {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
    }

    const isVisible = (el) => el.getClientRects().length > 0;

    function labelledByText(el) {
      const ids = clean(attr(el, 'aria-labelledby'));
      if (!ids) return '';
      return ids
        .split(' ')
        .map((id) => {
          const ref = document.getElementById(id);
          return ref ? clean(ref.textContent) : '';
        })
        .filter(Boolean)
        .join(' ');
    }

    // Accessible-name approximation: own text -> aria-label -> aria-labelledby -> img alt -> title.
    function accessibleText(el) {
      const own = clean(el.innerText || el.textContent);
      if (own) return own;
      const aria = clean(attr(el, 'aria-label'));
      if (aria) return aria;
      const referenced = labelledByText(el);
      if (referenced) return referenced;
      const img = el.querySelector('img[alt]');
      if (img && clean(img.getAttribute('alt'))) return clean(img.getAttribute('alt'));
      const value = el.tagName === 'INPUT' ? clean(el.value) : '';
      if (value) return value;
      return clean(attr(el, 'title'));
    }

    function controlLabel(el) {
      const labels = el.labels ? Array.prototype.slice.call(el.labels) : [];
      for (const label of labels) {
        const text = clean(label.innerText || label.textContent);
        if (text) return text;
      }
      const wrapping = el.closest('label');
      if (wrapping) {
        const text = clean(wrapping.innerText || wrapping.textContent);
        if (text) return text;
      }
      const aria = clean(attr(el, 'aria-label'));
      if (aria) return aria;
      const referenced = labelledByText(el);
      if (referenced) return referenced;
      return clean(attr(el, 'title'));
    }

    const headings = all('h1, h2, h3, h4, h5, h6').slice(0, MAX_HEADINGS).map((el) => ({
      level: Number(el.tagName.charAt(1)),
      text: clean(el.innerText || el.textContent).slice(0, 200),
      selector: selectorFor(el),
    }));

    const controls = all('input, select, textarea').slice(0, MAX_CONTROLS);
    const formEls = all('form');
    const buckets = new Map();
    for (const el of formEls) buckets.set(el, []);
    const orphans = [];
    for (const control of controls) {
      const record = {
        tag: control.tagName.toLowerCase(),
        type: clean(control.getAttribute('type') || control.type || '').toLowerCase(),
        name: attr(control, 'name'),
        hasLabel: false,
        labelText: '',
        placeholder: attr(control, 'placeholder'),
        required: control.required === true || attr(control, 'aria-required') === 'true',
        selector: selectorFor(control),
      };
      record.labelText = controlLabel(control);
      record.hasLabel = record.labelText.length > 0;
      const owner = control.form;
      if (owner && buckets.has(owner)) buckets.get(owner).push(record);
      else orphans.push(record);
    }
    const forms = formEls.map((el) => ({ selector: selectorFor(el), controls: buckets.get(el) || [] }));
    // Controls outside any <form> still need label checks; expose them under a synthetic entry.
    if (orphans.length) forms.push({ selector: 'body', controls: orphans });

    const links = all('a[href]').slice(0, MAX_LINKS).map((el) => ({
      text: accessibleText(el),
      href: attr(el, 'href'),
      selector: selectorFor(el),
      target: attr(el, 'target'),
    }));

    // A styled <a href> is the dominant landing-page CTA pattern, so anchors that are marked or
    // rendered like buttons join the button family in `buttons`; `tag` tells callers them apart.
    const CTA_CLASS_HINT = /(^|[-_ ])(btn|button|cta)([-_ ]|$)/i;
    const cssPx = (value) => {
      const n = parseFloat(value);
      return Number.isFinite(n) ? n : 0;
    };
    function anchorIsCta(el) {
      if (attr(el, 'role') === 'button') return true;
      if (CTA_CLASS_HINT.test(String(el.getAttribute('class') || ''))) return true;
      const style = window.getComputedStyle(el);
      if (!style || style.display === 'inline' || style.display === 'contents' || style.display === 'none') return false;
      const bg = String(style.backgroundColor || '');
      // Chrome serializes a fully transparent colour as 'rgba(r, g, b, 0)'.
      if (!bg || bg === 'transparent' || /,\s*0(\.0+)?\s*\)$/.test(bg)) return false;
      const padded = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
        .filter((value) => cssPx(value) >= 8).length;
      return padded >= 2;
    }

    const buttonEls = all('button, [role="button"], input[type="submit"], input[type="button"], a')
      .filter((el) => el.tagName.toLowerCase() !== 'a' || anchorIsCta(el));
    const buttonRaw = buttonEls.map((el) => {
      const box = boxOf(el);
      return {
        tag: el.tagName.toLowerCase(),
        text: accessibleText(el),
        selector: selectorFor(el),
        visible: isVisible(el),
        hinted: PRIMARY_HINT.test(String(el.getAttribute('class') || '') + ' ' + String(el.getAttribute('data-variant') || '')),
        area: box.w * box.h,
      };
    });
    const maxArea = buttonRaw.reduce((acc, b) => (b.visible && b.area > acc ? b.area : acc), 0);
    const buttons = buttonRaw.map((b) => ({
      text: b.text,
      selector: b.selector,
      isPrimaryCandidate: b.visible && (b.hinted || (maxArea > 0 && b.area === maxArea)),
      tag: b.tag,
    }));

    const images = all('img').slice(0, MAX_IMAGES).map((el) => ({
      selector: selectorFor(el),
      alt: attr(el, 'alt'),
      hasAlt: el.hasAttribute('alt'),
      naturalWidth: el.naturalWidth || 0,
      naturalHeight: el.naturalHeight || 0,
    }));

    const clientWidth = document.documentElement.clientWidth;
    const documentScrollWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body ? document.body.scrollWidth : 0,
    );
    const elements = all('*').slice(0, MAX_ELEMENTS);
    const offenders = [];
    const tapTargets = [];
    for (const el of elements) {
      if (!isVisible(el)) continue;
      const box = boxOf(el);
      if (box.w > 1 && box.x + box.w > clientWidth + 1) {
        offenders.push({ selector: selectorFor(el), box, right: box.x + box.w });
      }
      if (
        tapTargets.length < MAX_TAP_TARGETS &&
        box.w > 0 && box.h > 0 &&
        (box.w < 24 || box.h < 24) &&
        el.matches(INTERACTIVE)
      ) {
        tapTargets.push({ selector: selectorFor(el), box });
      }
    }
    offenders.sort((a, b) => b.right - a.right);

    const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';

    return {
      title: document.title || '',
      meta: {
        description: metaContent('description'),
        viewport: metaContent('viewport'),
        robots: metaContent('robots'),
      },
      lang: attr(document.documentElement, 'lang'),
      dir: attr(document.documentElement, 'dir'),
      hreflang: all('link[rel~="alternate"][hreflang]').map((el) => ({
        hreflang: attr(el, 'hreflang'),
        href: attr(el, 'href'),
      })),
      headings,
      landmarks: {
        header: count('header, [role="banner"]'),
        nav: count('nav, [role="navigation"]'),
        main: count('main, [role="main"]'),
        footer: count('footer, [role="contentinfo"]'),
        aside: count('aside, [role="complementary"]'),
      },
      forms,
      links,
      buttons,
      images,
      overflow: {
        documentScrollWidth,
        clientWidth,
        offenders: offenders.slice(0, MAX_OFFENDERS).map((o) => ({ selector: o.selector, box: o.box })),
      },
      tap_targets: tapTargets,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      _text: String(bodyText).slice(0, MAX_TEXT),
    };
  });
  const fullText = snapshot._text || '';
  delete snapshot._text;
  // text_stats is derived in Node so scriptRatios stays the single implementation.
  return {
    ...snapshot,
    text_stats: textStats(fullText),
    visible_text: fullText.slice(0, VISIBLE_TEXT_CHARS),
  };
}

/** Run every deterministic TECH.* rule (except TECH.LINK.BROKEN) over a DomEvidence snapshot. */
export function runChecks(dom, target) {
  const t = findingTarget(target);
  const findings = [];
  const unreachable = !dom || target?.status === 'error' || Number(target?.http_status) >= 400;
  if (unreachable) {
    findings.push(makeFinding({
      ruleId: 'TECH.TARGET.UNREACHABLE',
      severity: 'blocker',
      selector: 'document',
      title: 'The screen could not be loaded',
      detail: `Navigation failed or returned an error status (${target?.http_status ?? 'no response'}): ${target?.error ?? 'no DOM evidence collected'}`,
      evidence: [
        metricEv('http_status', Number(target?.http_status) || 0, 'status'),
        textEv(String(target?.error ?? 'no DOM evidence collected')),
      ],
      fix: {
        intent: 'The route must answer with a rendered page before any UX judgement is possible',
        acceptance: ['The route returns a 2xx/3xx status', 'The page renders a DOM the auditor can snapshot'],
        suggested_change: 'Fix the route, the dev server, the auth/storage state or the base_url in caveman.config.yaml, then re-run capture.',
      },
      target: t,
    }));
    return findings;
  }

  const overflow = dom.overflow || { documentScrollWidth: 0, clientWidth: 0, offenders: [] };
  const offenders = Array.isArray(overflow.offenders) ? overflow.offenders : [];
  if (Number(overflow.documentScrollWidth) > Number(overflow.clientWidth) + 1) {
    const overflowPx = Number(overflow.documentScrollWidth) - Number(overflow.clientWidth);
    findings.push(makeFinding({
      ruleId: 'TECH.OVERFLOW.HORIZONTAL',
      severity: 'major',
      selector: 'document',
      title: 'The page scrolls horizontally at this viewport',
      detail: `Document scroll width ${overflow.documentScrollWidth}px exceeds the viewport width ${overflow.clientWidth}px by ${overflowPx}px, so content is cut off or requires sideways scrolling.`,
      evidence: [
        metricEv('overflow_px', overflowPx, 'px'),
        metricEv('document_scroll_width', Number(overflow.documentScrollWidth), 'px'),
        metricEv('client_width', Number(overflow.clientWidth), 'px'),
        ...offenders.slice(0, MAX_EVIDENCE_NODES).map((o) => domEv(o.selector)),
      ],
      fix: {
        intent: 'No content may extend past the viewport width at this breakpoint',
        acceptance: [
          'document.documentElement.scrollWidth <= clientWidth + 1 at this viewport',
          'No element box extends past the right viewport edge',
        ],
        suggested_change: `Constrain the widest offenders (${offenders.slice(0, 3).map((o) => o.selector).join(', ') || 'unknown'}) with max-width: 100%, flexible layout units, word wrapping or overflow handling instead of fixed pixel widths.`,
      },
      target: t,
    }));
  }

  for (const tap of (Array.isArray(dom.tap_targets) ? dom.tap_targets : []).slice(0, MAX_FINDINGS_PER_RULE)) {
    const box = tap.box || { w: 0, h: 0 };
    findings.push(makeFinding({
      ruleId: 'TECH.TAP_TARGET.SMALL',
      severity: 'minor',
      selector: tap.selector,
      title: 'An interactive target is smaller than the minimum touch size',
      detail: `The target measures ${box.w}x${box.h}px, below the ${TAP_TARGET_MIN_PX}px minimum, which makes it easy to mis-tap on touch devices.`,
      evidence: [
        domEv(tap.selector),
        metricEv('width', Number(box.w) || 0, 'px'),
        metricEv('height', Number(box.h) || 0, 'px'),
      ],
      fix: {
        intent: `Every interactive target reaches at least ${TAP_TARGET_MIN_PX}x${TAP_TARGET_MIN_PX}px of hit area`,
        acceptance: [`${tap.selector} has a hit area of at least ${TAP_TARGET_MIN_PX}x${TAP_TARGET_MIN_PX}px`],
        suggested_change: 'Increase padding or min-width/min-height on the control, or enlarge its pseudo-element hit area, without shrinking the visible label.',
      },
      target: t,
    }));
  }

  const headings = Array.isArray(dom.headings) ? dom.headings : [];
  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    findings.push(makeFinding({
      ruleId: 'TECH.HEADING.MISSING_H1',
      severity: 'major',
      selector: 'document',
      title: 'The page has no level-1 heading',
      detail: 'Without an h1 the page never states what it is in machine- and screen-reader-readable form, so the document outline starts mid-hierarchy.',
      evidence: [
        metricEv('h1_count', 0, 'elements'),
        metricEv('heading_count', headings.length, 'elements'),
        textEv(headings.slice(0, 3).map((h) => `h${h.level}: ${h.text}`).join(' | ')),
      ],
      fix: {
        intent: 'The page states its own identity in exactly one h1',
        acceptance: ['The page contains exactly one h1', 'The h1 text names what this screen is'],
        suggested_change: 'Promote the visual page title to an h1 (or add one) instead of styling a div or an h2 to look like a title.',
      },
      target: t,
    }));
  } else if (h1s.length >= 2) {
    findings.push(makeFinding({
      ruleId: 'TECH.HEADING.MULTIPLE_H1',
      severity: 'minor',
      selector: 'document',
      title: 'The page has more than one level-1 heading',
      detail: `${h1s.length} h1 elements compete for the top of the document outline, which weakens the page identity for assistive technology.`,
      evidence: [
        metricEv('h1_count', h1s.length, 'elements'),
        ...h1s.slice(0, MAX_EVIDENCE_NODES).map((h) => domEv(h.selector, '', h.text)),
      ],
      fix: {
        intent: 'Exactly one h1 owns the page identity',
        acceptance: ['The page contains exactly one h1', 'The extra former h1 elements become h2 or lower'],
        suggested_change: `Keep the primary title as h1 and demote the others (${h1s.slice(1, 4).map((h) => h.selector).join(', ')}).`,
      },
      target: t,
    }));
  }

  let previousLevel = 0;
  let skipped = 0;
  for (const heading of headings) {
    if (previousLevel && heading.level - previousLevel > 1 && skipped < MAX_FINDINGS_PER_RULE) {
      skipped += 1;
      findings.push(makeFinding({
        ruleId: 'TECH.HEADING.SKIPPED_LEVEL',
        severity: 'minor',
        selector: heading.selector,
        title: 'The heading outline skips a level',
        detail: `h${heading.level} follows h${previousLevel}, so the outline jumps ${heading.level - previousLevel} levels and readers lose the nesting relationship.`,
        evidence: [
          domEv(heading.selector, '', heading.text),
          metricEv('from_level', previousLevel, 'level'),
          metricEv('to_level', heading.level, 'level'),
        ],
        fix: {
          intent: 'The heading outline descends one level at a time',
          acceptance: [`${heading.selector} uses level h${previousLevel + 1} or the missing intermediate heading is added`],
          suggested_change: 'Choose heading levels by document structure and use CSS for size, instead of picking a level for its visual weight.',
        },
        target: t,
      }));
    }
    if (heading.level) previousLevel = heading.level;
  }

  let missingLabels = 0;
  for (const form of Array.isArray(dom.forms) ? dom.forms : []) {
    for (const control of Array.isArray(form.controls) ? form.controls : []) {
      if (control.hasLabel) continue;
      if (SKIPPED_CONTROL_TYPES.has(String(control.type || ''))) continue;
      if (missingLabels >= MAX_FINDINGS_PER_RULE) break;
      missingLabels += 1;
      findings.push(makeFinding({
        ruleId: 'TECH.FORM.MISSING_LABEL',
        severity: 'critical',
        selector: control.selector,
        title: 'A form control has no programmatic label',
        detail: `The ${control.tag}${control.type ? `[type=${control.type}]` : ''} control ${control.name ? `named "${control.name}"` : 'with no name'} has no <label>, aria-label, aria-labelledby or title, so nobody using assistive technology learns what to type.${control.placeholder ? ' A placeholder is not a label: it disappears on input.' : ''}`,
        evidence: [
          domEv(control.selector, form.selector),
          textEv(`placeholder: ${control.placeholder ?? 'none'}`),
          metricEv('required', control.required ? 1 : 0, 'bool'),
        ],
        fix: {
          intent: 'Every form control exposes a programmatic label',
          acceptance: [
            `${control.selector} is referenced by a <label for> or carries aria-label / aria-labelledby`,
            'The accessible name matches the visible label text',
          ],
          suggested_change: 'Add a visible <label for="…"> tied to the control id; keep the placeholder only as an example value.',
        },
        target: t,
      }));
    }
  }

  let emptyLinks = 0;
  for (const link of Array.isArray(dom.links) ? dom.links : []) {
    if (String(link.text || '').trim()) continue;
    if (emptyLinks >= MAX_FINDINGS_PER_RULE) break;
    emptyLinks += 1;
    findings.push(makeFinding({
      ruleId: 'TECH.LINK.EMPTY_TEXT',
      severity: 'minor',
      selector: link.selector,
      title: 'A link has no accessible text',
      detail: `The anchor pointing at "${link.href ?? ''}" exposes no text, image alt or aria-label, so it is announced only as "link".`,
      evidence: [domEv(link.selector), textEv(`href: ${link.href ?? ''}`)],
      fix: {
        intent: 'Every link announces where it goes',
        acceptance: [`${link.selector} has visible text, an image alt or an aria-label describing the destination`],
        suggested_change: 'Add link text (or aria-label for icon-only links) that names the destination rather than "here" or nothing.',
      },
      target: t,
    }));
  }

  let missingAlt = 0;
  for (const image of Array.isArray(dom.images) ? dom.images : []) {
    if (image.hasAlt) continue;
    if (missingAlt >= MAX_FINDINGS_PER_RULE) break;
    missingAlt += 1;
    findings.push(makeFinding({
      ruleId: 'TECH.IMG.MISSING_ALT',
      severity: 'major',
      selector: image.selector,
      title: 'An image has no alt attribute',
      detail: `The image at ${image.selector} (${image.naturalWidth}x${image.naturalHeight}px) has no alt attribute at all, so assistive technology falls back to the file name.`,
      evidence: [
        domEv(image.selector),
        metricEv('natural_width', Number(image.naturalWidth) || 0, 'px'),
        metricEv('natural_height', Number(image.naturalHeight) || 0, 'px'),
      ],
      fix: {
        intent: 'Every <img> declares its alternative text, including the empty one',
        acceptance: [`${image.selector} has an alt attribute`, 'Decorative images use alt="" rather than omitting the attribute'],
        suggested_change: 'Add alt text describing the information the image carries, or alt="" when it is purely decorative.',
      },
      target: t,
    }));
  }

  const langAttr = String(dom.lang || '').trim();
  if (!langAttr) {
    findings.push(makeFinding({
      ruleId: 'TECH.LANG.MISSING',
      severity: 'major',
      selector: 'html',
      title: 'The document declares no language',
      detail: 'The <html> element has no lang attribute, so screen readers, translation and hyphenation all guess the language of the copy.',
      evidence: [domEv('html'), textEv('lang attribute is absent')],
      fix: {
        intent: 'The document declares the language of its content',
        acceptance: ['<html lang="…"> carries a valid BCP-47 tag matching the rendered copy'],
        suggested_change: 'Set lang on <html> per rendered locale (for example lang="zh-TW"), driven by the routing locale.',
      },
      target: t,
    }));
  } else {
    const base = langAttr.toLowerCase().split(/[-_]/)[0];
    const expected = EXPECTED_SCRIPTS[base];
    const stats = dom.text_stats || {};
    const dominant = dominantScript(dom.visible_text || '');
    if (expected && dominant && Number(stats.chars || 0) >= MIN_TEXT_CHARS_FOR_SCRIPT_CHECK && !expected.includes(dominant)) {
      findings.push(makeFinding({
        ruleId: 'TECH.LANG.MISMATCH',
        severity: 'major',
        selector: 'html',
        title: 'The declared language contradicts the rendered copy',
        detail: `<html lang="${langAttr}"> expects ${expected.join(' or ')} script but the visible text is dominated by ${dominant} script, so either the lang attribute or the copy is wrong for this route.`,
        evidence: [
          domEv('html', '', `lang="${langAttr}"`),
          metricEv('dominant_script_ratio', (stats.script_ratios || {})[dominant] ?? 0, 'ratio'),
          textEv(String(dom.visible_text || '').slice(0, 200)),
        ],
        fix: {
          intent: 'The lang attribute and the rendered copy describe the same language',
          acceptance: [
            `<html lang> matches the language actually rendered on this route`,
            'Untranslated fragments are either translated or wrapped in their own lang attribute',
          ],
          suggested_change: 'Fix the locale wiring so the route renders the declared language, or correct the lang attribute; mark genuinely foreign fragments with an inline lang attribute.',
        },
        target: t,
      }));
    }
  }

  const meta = dom.meta || {};
  if (!String(meta.viewport || '').trim()) {
    findings.push(makeFinding({
      ruleId: 'TECH.META.MISSING_VIEWPORT',
      severity: 'major',
      selector: 'head',
      title: 'The page declares no viewport meta tag',
      detail: 'Without <meta name="viewport"> mobile browsers render at a desktop width and scale the page down, so every touch target and font shrinks.',
      evidence: [domEv('head'), textEv('meta[name="viewport"] is absent')],
      fix: {
        intent: 'The page opts into responsive rendering on mobile browsers',
        acceptance: ['<meta name="viewport" content="width=device-width, initial-scale=1"> exists in <head>'],
        suggested_change: 'Add the viewport meta tag to the document head (or the framework layout) without disabling user scaling.',
      },
      target: t,
    }));
  }

  const landmarks = dom.landmarks || {};
  if (!Number(landmarks.nav)) {
    findings.push(makeFinding({
      ruleId: 'TECH.NAV.NO_LANDMARK',
      severity: 'minor',
      selector: 'document',
      title: 'The page exposes no navigation landmark',
      detail: 'There is no <nav> element and no role="navigation", so keyboard and screen-reader users cannot jump to the navigation region.',
      evidence: [metricEv('nav_landmarks', 0, 'elements'), textEv('no nav / role="navigation"')],
      fix: {
        intent: 'Navigation is reachable as a landmark',
        acceptance: ['The primary navigation is wrapped in <nav> or carries role="navigation"'],
        suggested_change: 'Wrap the existing link group in <nav> instead of a plain div.',
      },
      target: t,
    }));
  }
  if (!Number(landmarks.main)) {
    findings.push(makeFinding({
      ruleId: 'TECH.NAV.NO_MAIN',
      severity: 'minor',
      selector: 'document',
      title: 'The page exposes no main landmark',
      detail: 'There is no <main> element and no role="main", so "skip to content" and screen-reader region jumps have no target.',
      evidence: [metricEv('main_landmarks', 0, 'elements'), textEv('no main / role="main"')],
      fix: {
        intent: 'The primary content is reachable as a main landmark',
        acceptance: ['Exactly one <main> (or role="main") wraps the primary content'],
        suggested_change: 'Wrap the page body content in <main> instead of a generic container div.',
      },
      target: t,
    }));
  }

  return findings;
}

/** Resolve one candidate link with HEAD, falling back to GET when HEAD is not allowed. */
async function probeLink(request, url, timeoutMs) {
  const options = { timeout: timeoutMs, failOnStatusCode: false, maxRedirects: 5 };
  try {
    let response = await request.head(url, options);
    let status = response.status();
    if (status === 405 || status === 501) {
      response = await request.get(url, options);
      status = response.status();
      return { status, method: 'GET', error: null };
    }
    return { status, method: 'HEAD', error: null };
  } catch (error) {
    return { status: 0, method: 'HEAD', error: error.message };
  }
}

/** Probe same-origin http(s) links from DomEvidence and emit TECH.LINK.BROKEN findings. */
export async function checkLinks(page, dom, { timeoutMs = 8000, max = 40, target = null } = {}) {
  const t = findingTarget(target);
  const base = page.url();
  let origin;
  try {
    origin = new URL(base).origin;
  } catch {
    return [];
  }
  const request = page.request || (page.context ? page.context().request : null);
  if (!request) return [];

  const candidates = [];
  const seen = new Set();
  for (const link of Array.isArray(dom?.links) ? dom.links : []) {
    const href = String(link.href ?? '').trim();
    if (!href || href.startsWith('#') || SKIPPED_LINK_PROTOCOLS.test(href)) continue;
    let resolved;
    try {
      resolved = new URL(href, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    // Same-origin only: third-party hosts produce bot-blocking false positives.
    if (resolved.origin !== origin) continue;
    resolved.hash = '';
    const key = resolved.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ url: key, link });
    if (candidates.length >= max) break;
  }

  const broken = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor];
      cursor += 1;
      const result = await probeLink(request, candidate.url, timeoutMs);
      if (result.error || result.status >= 400) broken.push({ ...candidate, ...result });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LINK_CONCURRENCY, candidates.length) }, () => worker()),
  );
  broken.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  return broken.slice(0, MAX_FINDINGS_PER_RULE).map((item) => makeFinding({
    ruleId: 'TECH.LINK.BROKEN',
    severity: 'major',
    selector: item.link.selector,
    title: 'A link on this screen does not resolve',
    detail: item.error
      ? `The link to ${item.url} failed with a network error (${item.error}), so the path it promises is a dead end.`
      : `The link to ${item.url} answered HTTP ${item.status} (${item.method}), so the path it promises is a dead end.`,
    evidence: [
      domEv(item.link.selector, '', String(item.link.text || '').slice(0, 200)),
      metricEv('http_status', item.status, 'status'),
      textEv(item.url),
    ],
    fix: {
      intent: 'Every link on the screen resolves to a real destination',
      acceptance: [`${item.url} answers with a 2xx or an intentional 3xx`, 'Or the link is removed / repointed'],
      suggested_change: 'Repoint or remove the link; if the destination is intentionally gone, redirect it instead of leaving a 404.',
    },
    target: t,
  }));
}
