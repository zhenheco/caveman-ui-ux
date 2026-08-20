// axe-core adapter (Stage D). The library is CACHED at runtime, never vendored (ADR-003).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { join } from 'node:path';
import { EXIT, fail } from './errors.mjs';
import { stateDir } from './paths.mjs';
import { deterministicFindingId } from './ids.mjs';

export const AXE_VERSION = '4.10.2';
export const AXE_CDN_URL = `https://cdn.jsdelivr.net/npm/axe-core@${AXE_VERSION}/axe.min.js`;

const MIN_SOURCE_BYTES = 100000;
const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 3;
const MAX_NODES_PER_VIOLATION = 5;
const MAX_ACCEPTANCE_LINES = 6;
const RULE_VERSION = '1.0.0';

const SEVERITY_BY_IMPACT = {
  critical: 'critical',
  serious: 'major',
  moderate: 'minor',
  minor: 'info',
};

/** Absolute path of the cached axe-core bundle for AXE_VERSION. */
export function axeCachePath() {
  return join(stateDir(), 'vendor', `axe-core-${AXE_VERSION}`, 'axe.min.js');
}

/** Local copy of the finding-target normalizer so this module stays independent of checks.mjs. */
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

/** GET a URL over https, following up to `redirectsLeft` redirects, resolving to a Buffer. */
function download(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { headers: { 'user-agent': 'caveman-ui-ux' } }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`too many redirects while fetching ${url}`));
          return;
        }
        download(new URL(location, url).toString(), redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status} while fetching ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error(`timeout after ${DOWNLOAD_TIMEOUT_MS}ms while fetching ${url}`));
    });
    req.on('error', reject);
  });
}

/** Text of the sibling NOTICE.txt that records the axe-core license and provenance. */
function noticeText() {
  return [
    'axe-core',
    `version: ${AXE_VERSION}`,
    'license: MPL-2.0',
    `source: ${AXE_CDN_URL}`,
    `retrieved_at: ${new Date().toISOString()}`,
    '',
    'This file is CACHED at runtime by caveman-ui-ux, not vendored into the skill or any',
    'published artifact. It is used unmodified and injected into the page under audit.',
    'Redistribution obligations stay with the upstream project (see references/licenses.md).',
    '',
  ].join('\n');
}

/** Ensure the pinned axe-core bundle exists in the state cache; downloads it unless offline. */
export async function ensureAxeSource({ offline = false } = {}) {
  const path = axeCachePath();
  if (existsSync(path) && statSync(path).size > MIN_SOURCE_BYTES) {
    return { path, version: AXE_VERSION, source: 'cache' };
  }
  if (offline) {
    fail(
      `axe-core ${AXE_VERSION} is not cached and offline mode forbids downloading it`,
      EXIT.DEPENDENCY,
      { path, url: AXE_CDN_URL, hint: 'run once without --offline to populate the cache' },
    );
  }
  let body;
  try {
    body = await download(AXE_CDN_URL, MAX_REDIRECTS);
  } catch (error) {
    fail(`failed to download axe-core ${AXE_VERSION}: ${error.message}`, EXIT.DEPENDENCY, {
      url: AXE_CDN_URL,
      path,
    });
  }
  if (body.length <= MIN_SOURCE_BYTES || !body.includes('axe.run')) {
    fail(
      `downloaded axe-core payload looks wrong (${body.length} bytes, axe.run ${body.includes('axe.run')})`,
      EXIT.DEPENDENCY,
      { url: AXE_CDN_URL, bytes: body.length },
    );
  }
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
  writeFileSync(join(dir, 'NOTICE.txt'), noticeText(), 'utf8');
  return { path, version: AXE_VERSION, source: 'download' };
}

/** Inject the cached axe-core into `page` and return the trimmed violation results. */
export async function runAxe(page, { rules = null, offline = false } = {}) {
  const { path, version } = await ensureAxeSource({ offline });
  const content = readFileSync(path, 'utf8');
  await page.addScriptTag({ content });
  const raw = await page.evaluate(async (runOnly) => {
    const options = { resultTypes: ['violations'], reporter: 'v2' };
    if (runOnly && runOnly.length) {
      options.runOnly = { type: 'rule', values: runOnly };
    }
    const results = await window.axe.run(document, options);
    const list = (value) => (Array.isArray(value) ? value : []);
    return {
      version: (results.testEngine && results.testEngine.version) || null,
      counts: {
        violations: list(results.violations).length,
        passes: list(results.passes).length,
        incomplete: list(results.incomplete).length,
        inapplicable: list(results.inapplicable).length,
      },
      violations: list(results.violations).map((v) => ({
        id: String(v.id || ''),
        impact: v.impact || null,
        help: v.help || '',
        helpUrl: v.helpUrl || '',
        description: v.description || '',
        // Keep every node (normalizeAxe needs the true count) but bound each html blob.
        nodes: list(v.nodes).map((n) => ({
          target: list(n.target).map(String),
          html: String(n.html || '').slice(0, 1000),
          failureSummary: String(n.failureSummary || ''),
        })),
      })),
    };
  }, rules);
  return { ...raw, axe_version: raw.version || version };
}

/** Split axe failureSummary blobs into de-duplicated acceptance lines. */
function acceptanceLines(nodes) {
  const seen = new Set();
  for (const node of nodes) {
    for (const line of String(node.failureSummary || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) seen.add(trimmed);
      if (seen.size >= MAX_ACCEPTANCE_LINES) break;
    }
    if (seen.size >= MAX_ACCEPTANCE_LINES) break;
  }
  return [...seen];
}

/** Convert raw axe results into canonical deterministic Findings for one screen target. */
export function normalizeAxe(raw, target) {
  if (!raw || !Array.isArray(raw.violations)) return [];
  const t = findingTarget(target);
  const findings = [];
  for (const violation of raw.violations) {
    const axeId = String(violation.id || '');
    if (!axeId) continue;
    const ruleId = `A11Y.AXE.${axeId.toUpperCase().replace(/-/g, '_')}`;
    const severity = SEVERITY_BY_IMPACT[violation.impact] || 'minor';
    const allNodes = Array.isArray(violation.nodes) ? violation.nodes : [];
    const nodes = allNodes.slice(0, MAX_NODES_PER_VIOLATION);
    const firstTarget = nodes.length && nodes[0].target.length ? String(nodes[0].target[0]) : 'document';
    const evidence = [];
    for (const node of nodes) {
      evidence.push({
        type: 'dom',
        selector: node.target.length ? String(node.target[0]) : '',
        node_path: node.target.join(' >>> '),
        html: String(node.html || '').slice(0, 200),
      });
    }
    if (nodes.length) {
      evidence.push({ type: 'text', value: String(nodes[0].html || '').slice(0, 200) });
    }
    evidence.push({
      type: 'metric',
      name: 'axe_node_count',
      value: allNodes.length,
      unit: 'nodes',
    });
    const acceptance = acceptanceLines(nodes);
    findings.push({
      id: deterministicFindingId({
        ruleId,
        normalizedRoute: t.normalized_route,
        locale: t.locale,
        viewport: t.viewport,
        stableSelector: firstTarget,
      }),
      rule_id: ruleId,
      rule_version: RULE_VERSION,
      kind: 'deterministic',
      severity,
      confidence: 1.0,
      title: violation.help || `axe rule ${axeId} failed`,
      detail: `${violation.description || ''} (axe rule: ${axeId}, impact: ${violation.impact || 'unknown'}, ${allNodes.length} node(s))`.trim(),
      target: t,
      evidence,
      fix_brief: {
        intent: violation.help || `Satisfy axe rule ${axeId}`,
        acceptance: acceptance.length ? acceptance : [`axe rule ${axeId} reports zero violations on this screen`],
        suggested_change: `${violation.description || ''} Reference: ${violation.helpUrl || ''}`.trim(),
        rule_ids: [ruleId],
        target: t,
      },
      status: 'open',
    });
  }
  return findings;
}
