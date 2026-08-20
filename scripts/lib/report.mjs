// Report rendering — Markdown + self-contained HTML. Contract §16.
// The Markdown section order is mandatory: Executive summary -> Gate -> Component scores ->
// Findings -> Locale matrix -> Methodology -> Limitations -> Notices.
// The HTML must open offline: CSS inlined, screenshots as data: URIs, one tiny inline filter
// script, and never a src/href pointing at a remote host.
// Every string that came from the audited page goes through redactSecrets() in Markdown and
// escapeHtml(redactSecrets()) in HTML — page text is untrusted input.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { writeText } from './fsx.mjs';
import { loadLocale, t } from './locale.mjs';
import { runDir, skillRoot } from './paths.mjs';
import { DIMENSIONS, SEVERITY_ORDER, confidenceBand } from './scoring.mjs';

// Mandatory section order. Index 0..7 is also the render order of both outputs.
const SECTION_KEYS = [
  'report.section.executive_summary',
  'report.section.gate',
  'report.section.scores',
  'report.section.findings',
  'report.section.locale_matrix',
  'report.section.methodology',
  'report.section.limitations',
  'report.section.notices',
];

const SCORE_ROWS = [
  { key: 'caveman', label: 'score.caveman', kind: 'score' },
  { key: 'heuristic_ux', label: 'score.heuristic_ux', kind: 'score' },
  { key: 'accessibility', label: 'score.accessibility', kind: 'score' },
  { key: 'technical', label: 'score.technical', kind: 'score' },
  { key: 'multilingual_consistency', label: 'score.multilingual_consistency', kind: 'score' },
  { key: 'evaluator_confidence', label: 'score.evaluator_confidence', kind: 'unit' },
  { key: 'evaluator_dispersion', label: 'score.evaluator_dispersion', kind: 'unit' },
];

const BLIND_ANSWER_KEYS = [
  'what_is_this',
  'who_is_it_for',
  'what_can_i_get_or_do',
  'what_should_i_do_next',
  'why_should_i_trust_it',
];

const REPORTED_SEVERITIES = ['blocker', 'critical', 'major'];

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Secret shapes we never print. Each entry keeps its label and masks the value only, so the
// reader still sees that a credential was there. URL userinfo is the exception: 'user:pass@'
// carries no label worth keeping, so the whole userinfo is dropped.
const SECRET_RULES = [
  // scheme://user:pass@host -> scheme://[REDACTED]@host. base_url is the only place a
  // staging password can enter the run, and report.md/report.html are made to be shared.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi, '$1[REDACTED]@'],
  [/\b(set-cookie|cookie)\b(\s*[:=]\s*)[^\r\n]+/gi, '$1$2[REDACTED]'],
  [/\b(proxy-authorization|authorization)\b(\s*[:=]\s*)[^\r\n]+/gi, '$1$2[REDACTED]'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '$1 [REDACTED]'],
  [
    /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret[_-]?key|token|secret|password|passwd|pwd)\b(["']?\s*[:=]\s*["']?)[^\s"'`&;,)}\]]+/gi,
    '$1$2[REDACTED]',
  ],
  [/\b(?:sk|pk|rk|whsec)[_-](?:live|test)[_-][A-Za-z0-9]{4,}/gi, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '[REDACTED]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}\b/gi, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{12,}\b/g, '[REDACTED]'],
];

/** Escape the five HTML-significant characters; accepts any value. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Mask URL userinfo, cookies, authorization headers, bearer tokens, API keys and secrets. */
export function redactSecrets(str) {
  let out = String(str ?? '');
  for (const [pattern, replacement] of SECRET_RULES) out = out.replace(pattern, replacement);
  return out;
}

/** Untrusted page text, ready for HTML: redact first, then escape. */
function safeHtml(value) {
  return escapeHtml(redactSecrets(String(value ?? '')));
}

/** Untrusted page text, ready for a Markdown table cell or heading (single line). */
function mdText(value) {
  return redactSecrets(String(value ?? ''))
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/** Untrusted page text, ready for a Markdown paragraph (keeps lines, kills heading injection). */
function mdBlock(value) {
  return redactSecrets(String(value ?? '')).replace(/^([ \t]*)(#{1,6}\s)/gm, '$1\\$2').trim();
}

/** Severity chip markup for the HTML report. */
export function severityChip(severity, dict) {
  const key = SEVERITY_ORDER.includes(severity) ? severity : 'info';
  return `<span class="chip chip-${key}">${escapeHtml(t(dict, `severity.${key}`))}</span>`;
}

/** True when the value is a usable finite number. */
function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Render one score value, degrading to the score.unavailable label. */
function formatScoreValue(value, kind, dict) {
  if (!isNum(value)) return { text: t(dict, 'score.unavailable'), available: false };
  const text = kind === 'unit' ? value.toFixed(2) : String(Math.round(value * 10) / 10);
  return { text, available: true };
}

/** Score rows shared by both renderers: {key, label, value, kind, text, available}. */
function scoreRows(audit, dict) {
  const scores = (audit && audit.scores) || {};
  const rows = SCORE_ROWS.map((row) => {
    const value = scores[row.key];
    const shown = formatScoreValue(value, row.kind, dict);
    return { ...row, value, label: t(dict, row.label), text: shown.text, available: shown.available };
  });
  const composite = scores.composite;
  if (composite !== undefined && composite !== null) {
    const value = typeof composite === 'object' ? composite.value : composite;
    const shown = formatScoreValue(value, 'score', dict);
    rows.push({
      key: 'composite',
      label: t(dict, 'score.composite'),
      value,
      kind: 'score',
      text: shown.text,
      available: shown.available,
      weights: typeof composite === 'object' ? composite.weights : null,
    });
  }
  return rows;
}

/** Component score block as Markdown bullets, including the caveman dimension breakdown. */
export function scoreBlock(audit, dict) {
  const lines = scoreRows(audit, dict).map((row) => `- **${row.label}**: ${row.text}`);
  const dims = (audit && audit.caveman && audit.caveman.consensus && audit.caveman.consensus.dimensions) || null;
  if (dims) {
    for (const dim of DIMENSIONS) {
      const cell = dims[dim.key] || {};
      const score = isNum(cell.score) ? String(cell.score) : t(dict, 'score.unavailable');
      lines.push(`  - ${t(dict, `dimension.${dim.key}`)} (${dim.weight}): ${score}`);
    }
  }
  return lines.join('\n');
}

/** Locale matrix rows flattened to one entry per route x locale. */
function matrixEntries(audit) {
  const matrix = (audit && audit.locale_matrix) || null;
  if (!matrix || !Array.isArray(matrix.rows)) return { locales: [], entries: [] };
  const locales = Array.isArray(matrix.locales) ? matrix.locales : [];
  const entries = [];
  for (const row of matrix.rows) {
    const byLocale = row.by_locale || {};
    const codes = locales.length ? locales : Object.keys(byLocale);
    for (const code of codes) {
      const cell = byLocale[code] || {};
      entries.push({
        route: row.normalized_route || row.route || '/',
        locale: code,
        cta: isNum(cell.cta_count) ? String(cell.cta_count) : '-',
        primaryCta: cell.primary_cta_text || '',
        residual: isNum(cell.residual_ratio) ? cell.residual_ratio.toFixed(2) : '-',
        overflow: cell.overflow === true ? 'yes' : cell.overflow === false ? 'no' : '-',
        hreflang: cell.hreflang_ok === true ? 'ok' : cell.hreflang_ok === false ? 'no' : '-',
        missing: !cell.screen_id,
      });
    }
  }
  return { locales, entries };
}

/** Locale matrix as a Markdown table (one row per route x locale). */
export function localeMatrixTable(audit, dict) {
  const { entries } = matrixEntries(audit);
  if (!entries.length) return t(dict, 'finding.none');
  const head = [
    t(dict, 'matrix.route'),
    t(dict, 'matrix.locale'),
    t(dict, 'matrix.cta'),
    t(dict, 'matrix.residual'),
    t(dict, 'matrix.overflow'),
    t(dict, 'matrix.hreflang'),
  ];
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const entry of entries) {
    const cta = entry.primaryCta ? `${entry.cta} (${mdText(entry.primaryCta)})` : entry.cta;
    lines.push(`| ${mdText(entry.route)} | ${mdText(entry.locale)} | ${cta} | ${entry.residual} | ${entry.overflow} | ${entry.hreflang} |`);
  }
  return lines.join('\n');
}

/** Findings sorted by severity, then rule id, then finding id. */
function sortedFindings(audit) {
  const findings = (audit && Array.isArray(audit.findings) ? audit.findings : []).slice();
  return findings.sort((a, b) => {
    const sa = SEVERITY_ORDER.indexOf(a.severity);
    const sb = SEVERITY_ORDER.indexOf(b.severity);
    if (sa !== sb) return (sa < 0 ? SEVERITY_ORDER.length : sa) - (sb < 0 ? SEVERITY_ORDER.length : sb);
    if ((a.rule_id || '') !== (b.rule_id || '')) return (a.rule_id || '') < (b.rule_id || '') ? -1 : 1;
    return (a.id || '') < (b.id || '') ? -1 : 1;
  });
}

/** Count findings per severity key. */
function severityCounts(findings) {
  const counts = {};
  for (const key of SEVERITY_ORDER) counts[key] = 0;
  for (const finding of findings) {
    if (counts[finding.severity] === undefined) counts[finding.severity] = 0;
    counts[finding.severity] += 1;
  }
  return counts;
}

/** Status key of a finding, normalized to the locale key spelling. */
function statusKey(finding) {
  const raw = String((finding && finding.status) || 'open').replace(/-/g, '_');
  return raw;
}

/** Human target coordinate line for a finding. */
function targetLabel(finding) {
  const target = (finding && finding.target) || {};
  const parts = [target.normalized_route || target.route || '/'];
  if (target.locale) parts.push(target.locale);
  if (target.viewport) parts.push(target.viewport);
  return parts.join(' · ');
}

/** Short one-line description of one evidence entry (page-derived, still unsafe). */
function evidenceLine(evidence) {
  if (!evidence || typeof evidence !== 'object') return '';
  switch (evidence.type) {
    case 'dom':
      return `dom ${evidence.selector || ''}${evidence.html ? ` — ${evidence.html}` : ''}`;
    case 'metric':
      return `metric ${evidence.name || ''} = ${evidence.value}${evidence.unit ? ` ${evidence.unit}` : ''}`;
    case 'text':
      return `text — ${evidence.value || ''}`;
    case 'log':
      return `log ${evidence.source || ''} — ${evidence.message || ''}`;
    case 'manual_note':
      return `note — ${evidence.value || ''}`;
    case 'screenshot_region': {
      const box = evidence.box || {};
      return `screenshot ${evidence.path || ''} @ x:${box.x} y:${box.y} w:${box.w} h:${box.h}${evidence.note ? ` — ${evidence.note}` : ''}`;
    }
    default:
      return String(evidence.type || '');
  }
}

/** Gate status label for a gate result row. */
function gateStatusLabel(status, dict) {
  if (status === 'pass') return t(dict, 'report.gate.pass');
  if (status === 'fail') return t(dict, 'report.gate.fail');
  return t(dict, 'report.gate.skipped');
}

/** Tool version summary string. */
function toolVersionsText(audit) {
  const versions = (audit && audit.run && audit.run.tool_versions) || {};
  return Object.keys(versions)
    .map((key) => `${key} ${versions[key] === null || versions[key] === undefined ? '-' : versions[key]}`)
    .join(', ');
}

/** Base url / target description of the run. */
function targetText(audit) {
  const config = (audit && audit.config) || {};
  const target = config.target || {};
  if (target.base_url) return String(target.base_url);
  const first = (audit && Array.isArray(audit.targets) && audit.targets[0]) || null;
  return (first && (first.url || first.route)) || '';
}

/** Render the canonical Markdown report; section order is mandatory. */
export function renderMarkdown(audit, dict) {
  const run = (audit && audit.run) || {};
  const gates = (audit && audit.gates) || { pass: true, results: [] };
  const findings = sortedFindings(audit);
  const counts = severityCounts(findings);
  const target = targetText(audit);
  const out = [];

  out.push(`# ${t(dict, 'report.title')}`);
  out.push('');
  out.push(mdText(t(dict, 'report.subtitle', { target })));
  out.push('');
  out.push(`- **${t(dict, 'report.run_id')}**: \`${mdText(run.run_id || '')}\``);
  out.push(`- **${t(dict, 'report.generated_at')}**: ${mdText(run.finished_at || run.started_at || '')}`);
  out.push(`- **${t(dict, 'report.target')}**: \`${mdText(target)}\``);
  out.push(`- **${t(dict, 'report.tool_versions')}**: ${mdText(toolVersionsText(audit))}`);
  out.push('');

  // 1. Executive summary
  out.push(`## ${t(dict, SECTION_KEYS[0])}`);
  out.push('');
  const verdict = gates.pass ? t(dict, 'report.gate.pass') : t(dict, 'report.gate.fail');
  const caveman = formatScoreValue((audit && audit.scores && audit.scores.caveman), 'score', dict);
  out.push(`**${verdict}** — ${t(dict, 'score.caveman')}: ${caveman.text}. ${t(dict, 'finding.count', { count: findings.length })}`);
  out.push('');
  out.push(SEVERITY_ORDER.map((key) => `${t(dict, `severity.${key}`)} ${counts[key] || 0}`).join(' · '));
  out.push('');
  const answers = (audit && audit.caveman && Array.isArray(audit.caveman.answers)) ? audit.caveman.answers : [];
  if (answers.length) {
    out.push(`### ${t(dict, 'blind.answers')}`);
    out.push('');
    for (const entry of answers) {
      const body = entry.answers || {};
      out.push(`- \`${mdText(entry.screen_id || '')}\` / \`${mdText(entry.evaluator_id || '')}\``);
      for (const key of BLIND_ANSWER_KEYS) {
        if (body[key] === undefined || body[key] === null) continue;
        out.push(`  - **${t(dict, `blind.${key}`)}** ${mdText(body[key])}`);
      }
      if (Array.isArray(body.uncertainties) && body.uncertainties.length) {
        out.push(`  - **${t(dict, 'blind.uncertainties')}** ${body.uncertainties.map((item) => mdText(item)).join('; ')}`);
      }
    }
    out.push('');
  }
  const contradictions = (audit && audit.caveman && Array.isArray(audit.caveman.contradictions))
    ? audit.caveman.contradictions : [];
  if (contradictions.length) {
    for (const item of contradictions) {
      out.push(`- ${t(dict, `dimension.${item.dimension}`)}: spread ${item.spread} (${(item.scores || []).join(', ')})`);
    }
    out.push('');
  }

  // 2. Gate
  out.push(`## ${t(dict, SECTION_KEYS[1])}`);
  out.push('');
  const gateHead = [
    t(dict, 'report.gate.column.gate'),
    t(dict, 'report.gate.column.actual'),
    t(dict, 'report.gate.column.threshold'),
    t(dict, 'report.gate.column.status'),
  ];
  out.push(`| ${gateHead.join(' | ')} |`);
  out.push(`| ${gateHead.map(() => '---').join(' | ')} |`);
  for (const result of (gates.results || [])) {
    const actual = isNum(result.actual) ? String(result.actual) : t(dict, 'score.unavailable');
    const threshold = isNum(result.threshold)
      ? `${result.comparator || '>='} ${result.threshold}`
      : t(dict, 'score.unavailable');
    out.push(`| \`${result.gate}\` | ${actual} | ${threshold} | ${gateStatusLabel(result.status, dict)} |`);
  }
  out.push('');

  // 3. Component scores
  out.push(`## ${t(dict, SECTION_KEYS[2])}`);
  out.push('');
  out.push(scoreBlock(audit, dict));
  out.push('');

  // 4. Critical / major findings
  out.push(`## ${t(dict, SECTION_KEYS[3])}`);
  out.push('');
  const reported = findings.filter((finding) => REPORTED_SEVERITIES.includes(finding.severity));
  if (!reported.length) {
    out.push(t(dict, 'finding.none'));
    out.push('');
  }
  for (const finding of reported) {
    out.push(`### [${t(dict, `severity.${finding.severity}`)}] ${mdText(finding.title)}`);
    out.push('');
    const band = t(dict, `confidence.${confidenceBand(finding.confidence)}`);
    out.push(`- **${t(dict, 'finding.rule')}**: \`${mdText(finding.rule_id)}\` (${finding.kind})`);
    out.push(`- **${t(dict, 'finding.target')}**: ${mdText(targetLabel(finding))}`);
    out.push(`- **${t(dict, 'finding.confidence')}**: ${band} (${isNum(finding.confidence) ? finding.confidence : '-'})`);
    out.push(`- **${t(dict, 'finding.status')}**: ${t(dict, `status.${statusKey(finding)}`)}`);
    out.push('');
    if (finding.detail) {
      out.push(mdBlock(finding.detail));
      out.push('');
    }
    const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
    if (evidence.length) {
      out.push(`**${t(dict, 'finding.evidence')}**`);
      out.push('');
      for (const item of evidence) out.push(`- ${mdText(evidenceLine(item))}`);
      out.push('');
    }
    const fix = finding.fix_brief;
    if (fix && (fix.intent || (fix.acceptance && fix.acceptance.length) || fix.suggested_change)) {
      out.push(`**${t(dict, 'finding.fix_brief')}**`);
      out.push('');
      if (fix.intent) out.push(`- ${mdText(fix.intent)}`);
      for (const item of (fix.acceptance || [])) out.push(`  - ${mdText(item)}`);
      if (fix.suggested_change) out.push(`- ${mdText(fix.suggested_change)}`);
      out.push('');
    }
  }
  const lowSeverity = findings.length - reported.length;
  if (lowSeverity > 0) {
    out.push(`${t(dict, 'severity.minor')} ${counts.minor || 0} · ${t(dict, 'severity.info')} ${counts.info || 0}`);
    out.push('');
  }

  // 5. Locale matrix
  out.push(`## ${t(dict, SECTION_KEYS[4])}`);
  out.push('');
  out.push(localeMatrixTable(audit, dict));
  out.push('');

  // 6. Methodology
  out.push(`## ${t(dict, SECTION_KEYS[5])}`);
  out.push('');
  out.push(t(dict, 'methodology.body'));
  out.push('');

  // 7. Limitations
  out.push(`## ${t(dict, SECTION_KEYS[6])}`);
  out.push('');
  out.push(t(dict, 'limitations.body'));
  out.push('');
  const limitationList = (audit && audit.limitations) || [];
  for (const item of limitationList) out.push(`- ${mdText(item)}`);
  if (limitationList.length) out.push('');

  // 8. Notices
  out.push(`## ${t(dict, SECTION_KEYS[7])}`);
  out.push('');
  const notices = (audit && audit.notices) || [];
  if (!notices.length) out.push(t(dict, 'finding.none'));
  for (const item of notices) out.push(`- ${mdText(item)}`);
  out.push('');

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** Data URI for a screenshot on disk, or null when it cannot be embedded. */
function screenshotDataUri(relPath, baseDir) {
  if (!relPath || !baseDir) return null;
  const abs = isAbsolute(relPath) ? relPath : resolve(baseDir, relPath);
  // Never read outside the run directory the caller handed us.
  if (!abs.startsWith(resolve(baseDir))) return null;
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  const mime = MIME_BY_EXT[extname(abs).toLowerCase()];
  if (!mime) return null;
  return `data:${mime};base64,${readFileSync(abs).toString('base64')}`;
}

/** One evidence entry as HTML (figure for screenshots, pre for everything else). */
function evidenceHtml(evidence, { inlineScreenshots, baseDir }) {
  if (evidence && evidence.type === 'screenshot_region') {
    const uri = inlineScreenshots ? screenshotDataUri(evidence.path, baseDir) : null;
    const caption = safeHtml(evidenceLine(evidence));
    const img = uri ? `<img alt="" src="${uri}">` : '';
    return `<figure>${img}<figcaption>${caption}</figcaption></figure>`;
  }
  return `<figure><pre>${safeHtml(evidenceLine(evidence))}</pre></figure>`;
}

/** Render one finding as an <article class="finding">. */
function findingHtml(finding, dict, options) {
  const severity = SEVERITY_ORDER.includes(finding.severity) ? finding.severity : 'info';
  const status = statusKey(finding);
  const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
  const fix = finding.fix_brief || null;
  const parts = [];
  parts.push(`<article class="finding" data-severity="${severity}" data-status="${escapeHtml(status)}">`);
  parts.push(`<h3>${safeHtml(finding.title)}</h3>`);
  parts.push('<div class="finding-meta">');
  parts.push(severityChip(severity, dict));
  parts.push(`<span class="chip chip-outline">${escapeHtml(t(dict, 'finding.rule'))}: ${safeHtml(finding.rule_id)}</span>`);
  parts.push(`<span class="chip chip-outline">${escapeHtml(t(dict, 'finding.target'))}: ${safeHtml(targetLabel(finding))}</span>`);
  parts.push(`<span class="chip chip-outline">${escapeHtml(t(dict, 'finding.confidence'))}: ${escapeHtml(t(dict, `confidence.${confidenceBand(finding.confidence)}`))}</span>`);
  parts.push(`<span class="chip chip-outline">${escapeHtml(t(dict, 'finding.status'))}: ${escapeHtml(t(dict, `status.${status}`))}</span>`);
  parts.push('</div>');
  if (finding.detail) parts.push(`<p>${safeHtml(finding.detail)}</p>`);
  if (evidence.length) {
    parts.push(`<p><strong>${escapeHtml(t(dict, 'finding.evidence'))}</strong></p>`);
    parts.push('<div class="evidence">');
    for (const item of evidence) parts.push(evidenceHtml(item, options));
    parts.push('</div>');
  }
  if (fix && (fix.intent || (fix.acceptance && fix.acceptance.length) || fix.suggested_change)) {
    parts.push('<div class="fix-brief">');
    parts.push(`<strong>${escapeHtml(t(dict, 'finding.fix_brief'))}</strong>`);
    if (fix.intent) parts.push(`<p>${safeHtml(fix.intent)}</p>`);
    if (Array.isArray(fix.acceptance) && fix.acceptance.length) {
      parts.push(`<ul>${fix.acceptance.map((item) => `<li>${safeHtml(item)}</li>`).join('')}</ul>`);
    }
    if (fix.suggested_change) parts.push(`<p>${safeHtml(fix.suggested_change)}</p>`);
    parts.push('</div>');
  }
  parts.push('</article>');
  return parts.join('\n');
}

/** The severity + status filter controls; returns '' when there is nothing to filter. */
function filtersHtml(findings, dict) {
  if (!findings.length) return '';
  const statuses = [];
  for (const finding of findings) {
    const key = statusKey(finding);
    if (!statuses.includes(key)) statuses.push(key);
  }
  const options = ['<option value="all">&#8212;</option>']
    .concat(SEVERITY_ORDER.map((key) => `<option value="${key}">${escapeHtml(t(dict, `severity.${key}`))}</option>`));
  const boxes = statuses.map((key) => (
    `<label><input type="checkbox" class="cv-status" value="${escapeHtml(key)}" checked>${escapeHtml(t(dict, `status.${key}`))}</label>`
  ));
  return [
    '<div class="filters" role="group">',
    '<label for="cv-sev">&#8805;</label>',
    `<select id="cv-sev">${options.join('')}</select>`,
    `<span>${escapeHtml(t(dict, 'finding.status'))}</span>`,
    boxes.join('\n'),
    '</div>',
  ].join('\n');
}

// Inline filter script: no CDN, no fetch, no external anything. Toggles the [hidden]
// attribute on .finding articles from the severity floor and the status checkboxes.
const FILTER_SCRIPT = `(function () {
  var sel = document.getElementById('cv-sev');
  var items = [].slice.call(document.querySelectorAll('.finding'));
  if (!sel || !items.length) return;
  var boxes = [].slice.call(document.querySelectorAll('.cv-status'));
  var order = ['blocker', 'critical', 'major', 'minor', 'info'];
  function apply() {
    var limit = sel.value === 'all' ? order.length : order.indexOf(sel.value);
    var on = {};
    boxes.forEach(function (box) { on[box.value] = box.checked; });
    items.forEach(function (el) {
      var rank = order.indexOf(el.getAttribute('data-severity'));
      var status = el.getAttribute('data-status');
      var visible = rank > -1 && rank <= limit && on[status] !== false;
      if (visible) { el.removeAttribute('hidden'); } else { el.setAttribute('hidden', ''); }
    });
  }
  sel.addEventListener('change', apply);
  boxes.forEach(function (box) { box.addEventListener('change', apply); });
  apply();
})();`;

/** Render the self-contained offline HTML report (CSS inlined, no remote requests). */
export function renderHtml(audit, dict, { css = '', inlineScreenshots = false, baseDir = null } = {}) {
  const run = (audit && audit.run) || {};
  const gates = (audit && audit.gates) || { pass: true, results: [] };
  const findings = sortedFindings(audit);
  const counts = severityCounts(findings);
  const target = targetText(audit);
  const options = { inlineScreenshots, baseDir };
  const html = [];

  html.push('<!doctype html>');
  html.push(`<html lang="${escapeHtml(run.report_locale || 'en')}">`);
  html.push('<head>');
  html.push('<meta charset="utf-8">');
  html.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  html.push('<meta name="referrer" content="no-referrer">');
  html.push(`<title>${safeHtml(t(dict, 'report.title'))} — ${safeHtml(run.run_id || '')}</title>`);
  html.push(`<style>\n${css}\n</style>`);
  html.push('</head>');
  html.push('<body>');
  html.push('<main>');
  html.push(`<h1>${escapeHtml(t(dict, 'report.title'))}</h1>`);
  html.push(`<p class="subtitle">${safeHtml(t(dict, 'report.subtitle', { target }))}</p>`);
  html.push('<dl class="meta">');
  html.push(`<dt>${escapeHtml(t(dict, 'report.run_id'))}</dt><dd><code>${safeHtml(run.run_id || '')}</code></dd>`);
  html.push(`<dt>${escapeHtml(t(dict, 'report.generated_at'))}</dt><dd>${safeHtml(run.finished_at || run.started_at || '')}</dd>`);
  // The audited URL is rendered as text only — never as a link, so the page stays request-free.
  html.push(`<dt>${escapeHtml(t(dict, 'report.target'))}</dt><dd><code>${safeHtml(target)}</code></dd>`);
  html.push(`<dt>${escapeHtml(t(dict, 'report.tool_versions'))}</dt><dd>${safeHtml(toolVersionsText(audit))}</dd>`);
  html.push('</dl>');

  // 1. Executive summary
  html.push(`<h2>${escapeHtml(t(dict, SECTION_KEYS[0]))}</h2>`);
  const gateClass = gates.pass ? 'gate-pass' : 'gate-fail';
  const verdict = gates.pass ? t(dict, 'report.gate.pass') : t(dict, 'report.gate.fail');
  html.push(`<p><span class="${gateClass}">${escapeHtml(verdict)}</span> — ${escapeHtml(t(dict, 'finding.count', { count: findings.length }))}</p>`);
  html.push(`<p>${SEVERITY_ORDER.map((key) => `${severityChip(key, dict)} ${counts[key] || 0}`).join(' ')}</p>`);
  const answers = (audit && audit.caveman && Array.isArray(audit.caveman.answers)) ? audit.caveman.answers : [];
  if (answers.length) {
    html.push(`<h3>${escapeHtml(t(dict, 'blind.answers'))}</h3>`);
    for (const entry of answers) {
      const body = entry.answers || {};
      html.push(`<p><code>${safeHtml(entry.screen_id || '')}</code> / <code>${safeHtml(entry.evaluator_id || '')}</code></p>`);
      html.push('<dl class="meta">');
      for (const key of BLIND_ANSWER_KEYS) {
        if (body[key] === undefined || body[key] === null) continue;
        html.push(`<dt>${escapeHtml(t(dict, `blind.${key}`))}</dt><dd>${safeHtml(body[key])}</dd>`);
      }
      if (Array.isArray(body.uncertainties) && body.uncertainties.length) {
        html.push(`<dt>${escapeHtml(t(dict, 'blind.uncertainties'))}</dt><dd>${safeHtml(body.uncertainties.join('; '))}</dd>`);
      }
      html.push('</dl>');
    }
  }
  const contradictions = (audit && audit.caveman && Array.isArray(audit.caveman.contradictions))
    ? audit.caveman.contradictions : [];
  if (contradictions.length) {
    html.push('<ul>');
    for (const item of contradictions) {
      html.push(`<li>${escapeHtml(t(dict, `dimension.${item.dimension}`))}: ${escapeHtml(String(item.spread))} (${escapeHtml((item.scores || []).join(', '))})</li>`);
    }
    html.push('</ul>');
  }

  // 2. Gate
  html.push(`<h2>${escapeHtml(t(dict, SECTION_KEYS[1]))}</h2>`);
  html.push('<div class="table-wrap"><table><thead><tr>');
  for (const key of ['gate', 'actual', 'threshold', 'status']) {
    html.push(`<th>${escapeHtml(t(dict, `report.gate.column.${key}`))}</th>`);
  }
  html.push('</tr></thead><tbody>');
  for (const result of (gates.results || [])) {
    const actual = isNum(result.actual) ? String(result.actual) : t(dict, 'score.unavailable');
    const threshold = isNum(result.threshold)
      ? `${result.comparator || '>='} ${result.threshold}`
      : t(dict, 'score.unavailable');
    const cls = result.status === 'pass' ? 'gate-pass' : result.status === 'fail' ? 'gate-fail' : 'gate-skipped';
    html.push(`<tr><td><code>${escapeHtml(result.gate)}</code></td><td class="num">${escapeHtml(actual)}</td><td class="num">${escapeHtml(threshold)}</td><td><span class="${cls}">${escapeHtml(gateStatusLabel(result.status, dict))}</span></td></tr>`);
  }
  html.push('</tbody></table></div>');

  // 3. Component scores
  html.push(`<h2>${escapeHtml(t(dict, SECTION_KEYS[2]))}</h2>`);
  html.push('<ul class="scores">');
  for (const row of scoreRows(audit, dict)) {
    const valueClass = row.available ? 'value' : 'value is-unavailable';
    html.push(`<li class="score-card"><span class="label">${escapeHtml(row.label)}</span><span class="${valueClass}">${escapeHtml(row.text)}</span></li>`);
  }
  html.push('</ul>');
  const dims = (audit && audit.caveman && audit.caveman.consensus && audit.caveman.consensus.dimensions) || null;
  if (dims) {
    html.push('<div class="table-wrap"><table><tbody>');
    for (const dim of DIMENSIONS) {
      const cell = dims[dim.key] || {};
      const score = isNum(cell.score) ? String(cell.score) : t(dict, 'score.unavailable');
      html.push(`<tr><td>${escapeHtml(t(dict, `dimension.${dim.key}`))}</td><td class="num">${escapeHtml(String(dim.weight))}</td><td class="num">${escapeHtml(score)}</td></tr>`);
    }
    html.push('</tbody></table></div>');
  }

  // 4. Findings (all of them here; the filter narrows the view)
  html.push(`<h2>${escapeHtml(t(dict, SECTION_KEYS[3]))}</h2>`);
  html.push(filtersHtml(findings, dict));
  if (!findings.length) html.push(`<p>${escapeHtml(t(dict, 'finding.none'))}</p>`);
  for (const finding of findings) html.push(findingHtml(finding, dict, options));

  // 5. Locale matrix
  html.push(`<h2>${escapeHtml(t(dict, SECTION_KEYS[4]))}</h2>`);
  const { entries } = matrixEntries(audit);
  if (!entries.length) {
    html.push(`<p>${escapeHtml(t(dict, 'finding.none'))}</p>`);
  } else {
    html.push('<div class="table-wrap"><table><thead><tr>');
    for (const key of ['route', 'locale', 'cta', 'residual', 'overflow', 'hreflang']) {
      html.push(`<th>${escapeHtml(t(dict, `matrix.${key}`))}</th>`);
    }
    html.push('</tr></thead><tbody>');
    for (const entry of entries) {
      const cta = entry.primaryCta ? `${entry.cta} (${entry.primaryCta})` : entry.cta;
      html.push(`<tr><td>${safeHtml(entry.route)}</td><td>${safeHtml(entry.locale)}</td><td>${safeHtml(cta)}</td><td class="num">${escapeHtml(entry.residual)}</td><td>${escapeHtml(entry.overflow)}</td><td>${escapeHtml(entry.hreflang)}</td></tr>`);
    }
    html.push('</tbody></table></div>');
  }

  // 6. Methodology
  html.push(`<h2>${escapeHtml(t(dict, SECTION_KEYS[5]))}</h2>`);
  html.push(`<p>${escapeHtml(t(dict, 'methodology.body'))}</p>`);

  // 7. Limitations
  html.push(`<h2>${escapeHtml(t(dict, SECTION_KEYS[6]))}</h2>`);
  html.push(`<p>${escapeHtml(t(dict, 'limitations.body'))}</p>`);
  const limitations = (audit && audit.limitations) || [];
  if (limitations.length) {
    html.push(`<ul>${limitations.map((item) => `<li>${safeHtml(item)}</li>`).join('')}</ul>`);
  }

  // 8. Notices
  html.push(`<h2>${escapeHtml(t(dict, SECTION_KEYS[7]))}</h2>`);
  const notices = (audit && audit.notices) || [];
  if (!notices.length) {
    html.push(`<p>${escapeHtml(t(dict, 'finding.none'))}</p>`);
  } else {
    html.push(`<ul>${notices.map((item) => `<li>${safeHtml(item)}</li>`).join('')}</ul>`);
  }

  html.push('</main>');
  html.push(`<footer><code>${safeHtml(run.run_id || '')}</code></footer>`);
  html.push(`<script>\n${FILTER_SCRIPT}\n</script>`);
  html.push('</body>');
  html.push('</html>');
  return `${html.filter((line) => line !== '').join('\n')}\n`;
}

/** Render and write report.md + report.html into the run directory; returns both paths. */
export function writeReports({ cwd, runId, audit, locale, inlineScreenshots = false }) {
  const id = runId || (audit && audit.run && audit.run.run_id);
  const dir = runDir(cwd, id);
  const code = locale || (audit && audit.run && audit.run.report_locale) || 'en';
  const { dict } = loadLocale(code);
  const cssPath = join(skillRoot(), 'assets', 'report.css');
  const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';
  const markdown = writeText(join(dir, 'report.md'), renderMarkdown(audit, dict));
  const htmlPath = writeText(
    join(dir, 'report.html'),
    renderHtml(audit, dict, { css, inlineScreenshots, baseDir: dir }),
  );
  // Both spellings are returned so the CLI can use either without a rename.
  return { markdown, html: htmlPath, markdownPath: markdown, htmlPath };
}
