// Blind Caveman protocol: payload allowlist, leakage assertions, evaluator prompt,
// sealed response ingestion. Contract §6 / ADR-002 / AC-002.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT, fail } from './errors.mjs';
import { ROOT_DIR_NAME, runDir, screenDir, skillRoot } from './paths.mjs';
import { stagedBlindDir } from './retention.mjs';
import { validateFile } from './validate.mjs';

/** The only keys a blind evaluator may ever see. */
export const ALLOWED_PAYLOAD_KEYS = Object.freeze([
  'screen_id',
  'viewport',
  'target_locale',
  'report_locale',
  'screenshot_path',
  'profile',
  'task_framing',
]);

/** Keys that are never allowed in a blind payload, reported as `forbidden_key`. */
export const FORBIDDEN_PAYLOAD_KEYS = Object.freeze([
  'route',
  'routes',
  'normalized_route',
  'url',
  'base_url',
  'host',
  'hostname',
  'origin',
  'title',
  'meta',
  'metadata',
  'description',
  'path',
  'file',
  'files',
  'cwd',
  'dom',
  'html',
  'source',
  'source_code',
  'readme',
  'prd',
  'spec',
  'prior_audit',
  'findings',
  'sealed',
  'config',
  'http_status',
  'screenshot',
]);

// Contract §6 forbidden substrings: readme|package.json|src/|\.tsx?|schema.org|<html
// '.ts' is stored as a plain substring because it also covers '.tsx'.
/** Substrings that must never appear anywhere in a blind payload. */
export const FORBIDDEN_SUBSTRINGS = Object.freeze([
  'readme',
  'package.json',
  'src/',
  '.ts',
  'schema.org',
  '<html',
]);

const SCREEN_DIR_RE = /^scr_[0-9a-f]{12}$/;
const EVALUATOR_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const BLIND_SCHEMA = 'schemas/blind.schema.json';

/** First line of an error message. */
function firstLine(err) {
  const message = err && err.message ? String(err.message) : String(err);
  return message.split('\n')[0].trim();
}

/** Build the blind payload for one screen: exactly ALLOWED_PAYLOAD_KEYS, nothing else. */
export function blindPayload(screenRecord, config) {
  const screenshotPath = screenRecord?.screenshot?.path;
  if (!screenshotPath) {
    return fail(
      `screen ${screenRecord?.screen_id ?? '(unknown)'} has no screenshot path; cannot build a blind payload`,
      EXIT.PRIVACY,
      { screen_id: screenRecord?.screen_id ?? null },
    );
  }
  const evaluation = config?.evaluation || {};
  const profile = evaluation.profile === 'task' ? 'task' : 'generic';
  const viewport = screenRecord.viewport || {};
  return {
    screen_id: screenRecord.screen_id,
    viewport: {
      id: viewport.id ?? null,
      width: viewport.width ?? null,
      height: viewport.height ?? null,
      device_scale_factor: viewport.device_scale_factor ?? 1,
    },
    target_locale: screenRecord.locale ?? 'auto',
    report_locale: config?.report_locale || 'en',
    screenshot_path: String(screenshotPath).split('\\').join('/'),
    profile,
    task_framing: profile === 'task' ? (evaluation.task_framing ?? null) : null,
  };
}

/** Truncated printable preview of any value, for violation reports. */
function preview(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** Collapse whitespace so needle and haystack compare the same way. */
function flatten(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Deep-collect every string value in the payload as {key, value} pairs. */
function collectStrings(value, keyPath = '', out = []) {
  if (typeof value === 'string') {
    out.push({ key: keyPath || '(root)', value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, `${keyPath}[${index}]`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectStrings(child, keyPath ? `${keyPath}.${key}` : key, out);
    }
  }
  return out;
}

/** Unique non-empty needles, minus tokens the payload legitimately contains. */
function usableNeedles(needles, safeTokens) {
  const seen = new Set();
  const out = [];
  for (const raw of needles) {
    if (typeof raw !== 'string') continue;
    const needle = raw.trim();
    if (needle.length < 3) continue;
    const flat = flatten(needle);
    if (!flat || seen.has(flat) || safeTokens.has(flat)) continue;
    seen.add(flat);
    out.push(needle);
  }
  return out;
}

/** Enumerated payload values that must not be mistaken for page content. */
function safeTokenSet(payload) {
  const viewport = payload?.viewport || {};
  const tokens = [
    viewport.id,
    payload?.target_locale,
    payload?.report_locale,
    payload?.profile,
    payload?.screen_id,
    ROOT_DIR_NAME,
    'runs',
    'screens',
    'screenshot.png',
  ];
  return new Set(tokens.filter((t) => typeof t === 'string' && t).map(flatten));
}

/** Host needles derived from the configured base_url. */
function hostNeedles(baseUrl) {
  if (!baseUrl) return [];
  try {
    const url = new URL(baseUrl);
    return [url.host, url.hostname];
  } catch {
    return [String(baseUrl)];
  }
}

/** Route needles: raw route plus its bare and slugified forms and long segments. */
function routeNeedles(routes) {
  const out = [];
  for (const raw of routes || []) {
    if (typeof raw !== 'string') continue;
    const route = raw.split('?')[0].split('#')[0];
    if (!route || route === '/') continue;
    const bare = route.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!bare) continue;
    out.push(route, bare, bare.split('/').join('-'), bare.split('/').join('_'));
    for (const segment of bare.split('/')) {
      if (segment.length >= 4) out.push(segment);
    }
  }
  return out;
}

/** Sealed page titles (never shown to a blind evaluator). */
function titleNeedles(sealed) {
  const entries = Array.isArray(sealed) ? sealed : Object.values(sealed || {});
  const out = [];
  for (const entry of entries) {
    if (typeof entry?.title === 'string' && entry.title.trim().length >= 4) out.push(entry.title);
  }
  return out;
}

/** Assert a blind payload leaks nothing about route, host, title, path or source. */
export function assertNoLeakage(payload, { baseUrl, routes, sealed, extraSecrets } = {}) {
  const violations = [];
  const keys = payload && typeof payload === 'object' ? Object.keys(payload) : [];
  for (const key of keys) {
    if (FORBIDDEN_PAYLOAD_KEYS.includes(key)) {
      violations.push({ kind: 'forbidden_key', key, value: preview(payload[key]) });
    } else if (!ALLOWED_PAYLOAD_KEYS.includes(key)) {
      violations.push({ kind: 'unknown_key', key, value: preview(payload[key]) });
    }
  }
  const strings = collectStrings(payload).map((entry) => ({ ...entry, flat: flatten(entry.value) }));
  const safeTokens = safeTokenSet(payload);
  const groups = [
    ['host_leak', hostNeedles(baseUrl)],
    ['route_leak', routeNeedles(routes)],
    ['title_leak', titleNeedles(sealed)],
    ['path_leak', [...FORBIDDEN_SUBSTRINGS, ...(extraSecrets || [])]],
  ];
  for (const [kind, rawNeedles] of groups) {
    for (const needle of usableNeedles(rawNeedles, safeTokens)) {
      const flatNeedle = flatten(needle);
      for (const entry of strings) {
        if (entry.flat.includes(flatNeedle)) {
          violations.push({ kind, key: entry.key, value: preview(entry.value) });
        }
      }
    }
  }
  const screenshotPath = typeof payload?.screenshot_path === 'string' ? payload.screenshot_path : null;
  if (screenshotPath) {
    const parts = screenshotPath.split('/').filter(Boolean);
    const dir = parts.length >= 2 ? parts[parts.length - 2] : null;
    if (!dir || !SCREEN_DIR_RE.test(dir)) {
      violations.push({ kind: 'path_leak', key: 'screenshot_path', value: preview(screenshotPath) });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Profile-specific block substituted into the blind prompt. */
function profileBlock(payload) {
  if (payload?.profile === 'task' && payload?.task_framing) {
    return `Profile: task. The visitor arrived with this task in mind: ${payload.task_framing}`;
  }
  return 'Profile: generic. Judge the screen as a first-time visitor with no prior context.';
}

/** Render the exact prompt handed to a fresh-context blind evaluator. */
/**
 * Copy one screenshot to an identity-free absolute path before it is handed to an
 * evaluator. The in-project path contains the repository directory name, which is a
 * semantic hint about the product (ADR-002 forbids inferring identity from the path), so
 * blind evaluators always read the staged copy under the state dir instead.
 */
export function stageBlindScreenshot({ cwd, runId, screenId, screenshotRelPath }) {
  const source = join(cwd, screenshotRelPath);
  if (!existsSync(source)) {
    return fail(`screenshot missing for ${screenId}: ${source}`, EXIT.TARGET, { screen_id: screenId });
  }
  // One owner for this path: retention.mjs prunes exactly what stagedBlindDir() creates.
  const dir = stagedBlindDir(runId);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${screenId}.png`);
  // Re-copy only when the bytes changed; a staged screenshot is disposable, not sealed.
  if (!existsSync(target) || statSync(target).size !== statSync(source).size) {
    copyFileSync(source, target);
  }
  return target;
}

/**
 * True pixel size of a PNG, read from its IHDR header. A viewport of 375x812 at
 * device_scale_factor 2 is a 750x1624 image, and a model measuring an image reports what it
 * sees — so the prompt must state the image size, not the CSS viewport. Falls back to
 * viewport x scale when the file is unavailable (e.g. a unit test with a synthetic payload).
 */
export function screenshotPixels(absPath, viewport) {
  const scale = Number(viewport?.device_scale_factor) || 1;
  const fallback = {
    width: Math.round((Number(viewport?.width) || 0) * scale),
    height: Math.round((Number(viewport?.height) || 0) * scale),
    source: 'viewport',
  };
  if (!absPath || !existsSync(absPath)) return fallback;
  try {
    const head = readFileSync(absPath).subarray(0, 24);
    if (head.length < 24 || head.readUInt32BE(12) !== 0x49484452) return fallback;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20), source: 'png' };
  } catch {
    return fallback;
  }
}

export function evaluatorPrompt(payload, { screenshotAbsPath } = {}) {
  const file = join(skillRoot(), 'assets', 'blind-prompt.md');
  if (!existsSync(file)) {
    return fail(
      `blind prompt template missing: ${file} (the skill bundle is incomplete; expected assets/blind-prompt.md)`,
      EXIT.DEPENDENCY,
      { path: file },
    );
  }
  const viewport = payload?.viewport || {};
  const pixels = screenshotPixels(screenshotAbsPath, viewport);
  const vars = {
    screen_id: payload?.screen_id ?? '',
    image_pixels: `${pixels.width} x ${pixels.height}`,
    viewport: `${viewport.id ?? 'unknown'} ${viewport.width ?? '?'}x${viewport.height ?? '?'} @${viewport.device_scale_factor ?? 1}x`,
    target_locale: payload?.target_locale ?? 'auto',
    report_locale: payload?.report_locale ?? 'en',
    screenshot_path: screenshotAbsPath || payload?.screenshot_path || '',
    profile_block: profileBlock(payload),
  };
  // Strip leading HTML comment blocks before substitution: the maintainer note at the top of
  // blind-prompt.md names the skill, lib/blind.mjs and references/{blind-protocol,rubric}.md,
  // which is exactly the file-layout context ADR-002 forbids the evaluator from having — and
  // substituting placeholders inside it would ship a garbled copy of it too.
  const template = readFileSync(file, 'utf8').replace(/^\s*(?:<!--[\s\S]*?-->\s*)+/, '');
  return template.replace(
    /\{\{(screen_id|image_pixels|viewport|target_locale|report_locale|screenshot_path|profile_block)\}\}/g,
    (_match, key) => vars[key],
  );
}

/** The captured viewport of one screen, read from the run manifest. */
function readScreenViewport(cwd, runId, screenId) {
  try {
    const manifest = JSON.parse(readFileSync(join(runDir(cwd, runId), 'run.json'), 'utf8'));
    const record = (manifest.screens || []).find((screen) => screen.screen_id === screenId);
    return record?.viewport ?? null;
  } catch {
    return null;
  }
}

/** Validate one evaluator response against schemas/blind.schema.json. */
async function validateBlindResponse(data, screenId) {
  let result;
  try {
    result = await validateFile(BLIND_SCHEMA, data);
  } catch (err) {
    // A CavemanError here means the schema file itself is broken; keep its exit code.
    if (err && err.exitCode !== undefined) throw err;
    return fail(
      `blind response for ${screenId} failed schema validation: ${firstLine(err)}`,
      EXIT.EVALUATOR,
      { screen_id: screenId },
    );
  }
  if (result && result.valid === false) {
    const errors = Array.isArray(result.errors) ? result.errors : [];
    const detail = errors
      .map((e) => (typeof e === 'string' ? e : `${e.path ?? ''} ${e.message ?? ''}`.trim()))
      .join('; ');
    return fail(
      `blind response for ${screenId} failed schema validation: ${detail || 'schema mismatch'}`,
      EXIT.EVALUATOR,
      { screen_id: screenId, errors },
    );
  }
  return true;
}

/** Validate and seal one blind evaluator response; responses are immutable. */
/** Fill the evaluator identity block the evaluator itself is not allowed to know about. */
/**
 * Every screenshot_region box in a response, flattened for validation.
 */
function responseBoxes(response) {
  const out = [];
  for (const [key, dimension] of Object.entries(response?.dimensions || {})) {
    for (const item of Array.isArray(dimension?.evidence) ? dimension.evidence : []) {
      if (item?.type === 'screenshot_region' && item.box) out.push({ dimension: key, box: item.box });
    }
  }
  return out;
}

/**
 * Reject evidence boxes that cannot be read against the screenshot they claim to describe.
 * Two real evaluators once answered the same prompt in two different coordinate systems (one
 * in image pixels, one mixing CSS and image pixels), which silently produced meaningless
 * evidence and unstable heuristic ids. Bounds are the structural guard; the CSS-space warning
 * catches the case that still fits inside the image.
 */
export function checkEvidenceBoxes(response, pixels, viewport) {
  const boxes = responseBoxes(response);
  const violations = [];
  for (const { dimension, box } of boxes) {
    const x = Number(box.x); const y = Number(box.y);
    const w = Number(box.w); const h = Number(box.h);
    if (![x, y, w, h].every(Number.isFinite)) {
      violations.push(`${dimension}: box has a non-numeric side (${JSON.stringify(box)})`);
      continue;
    }
    if (pixels.width > 0 && x + w > pixels.width + 1) {
      violations.push(`${dimension}: x+w = ${x + w} exceeds the image width ${pixels.width}`);
    }
    if (pixels.height > 0 && y + h > pixels.height + 1) {
      violations.push(`${dimension}: y+h = ${y + h} exceeds the image height ${pixels.height}`);
    }
  }
  const scale = Number(viewport?.device_scale_factor) || 1;
  let warning = null;
  if (violations.length === 0 && boxes.length >= 3 && scale > 1) {
    // The detectable failure is axis inconsistency: the vertical extent proves the response
    // used image pixels, while the horizontal extent never leaves the CSS width. A response
    // that is CSS-space on both axes is indistinguishable from a genuinely top-left-heavy
    // screen, so it is not guessed at here — the prompt now states the image size instead.
    const cssWidth = pixels.width / scale;
    const cssHeight = pixels.height / scale;
    const maxRight = Math.max(...boxes.map(({ box }) => Number(box.x) + Number(box.w)));
    const maxBottom = Math.max(...boxes.map(({ box }) => Number(box.y) + Number(box.h)));
    if (maxBottom > cssHeight + 1 && maxRight <= cssWidth * 1.1) {
      warning = `boxes reach ${maxBottom}px vertically (past the ${cssHeight}px CSS height, so they are image pixels)`
        + ` but never past ${maxRight}px horizontally (inside the ${cssWidth}px CSS width): the two axes use`
        + ` different coordinate systems. The image is ${pixels.width}x${pixels.height}; re-dispatch this evaluator.`;
    }
  }
  return { ok: violations.length === 0, violations, warning };
}

export function withEvaluatorIdentity(data, { evaluatorId, runtimeHost, model } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (data.evaluator && typeof data.evaluator === 'object') return data;
  const runtime = ['claude', 'codex'].includes(runtimeHost) ? runtimeHost : 'other';
  return { ...data, evaluator: { id: evaluatorId, runtime, model: model || 'unknown' } };
}

export async function ingestBlind({
  cwd, runId, screenId, evaluatorId, data, force = false, runtimeHost, model,
} = {}) {
  if (!runId) return fail('ingestBlind requires a run id', EXIT.EVALUATOR, {});
  if (!screenId || !SCREEN_DIR_RE.test(screenId)) {
    return fail(`ingestBlind requires an opaque screen id (scr_<12 hex>), got ${String(screenId)}`, EXIT.EVALUATOR, {});
  }
  if (!evaluatorId || !EVALUATOR_ID_RE.test(evaluatorId)) {
    return fail(`invalid evaluator id ${String(evaluatorId)} (allowed: letters, digits, dot, dash, underscore)`, EXIT.EVALUATOR, {});
  }
  // The blind evaluator never learns its own id/runtime/model, so the CLI stamps them here.
  const response = withEvaluatorIdentity(data, {
    evaluatorId,
    runtimeHost: runtimeHost ?? process.env.CAVEMAN_RUNTIME_HOST,
    model,
  });
  await validateBlindResponse(response, screenId);
  const shot = join(screenDir(cwd, runId, screenId), 'screenshot.png');
  const record = readScreenViewport(cwd, runId, screenId);
  const pixels = screenshotPixels(shot, record);
  const boxCheck = checkEvidenceBoxes(response, pixels, record);
  if (!boxCheck.ok) {
    return fail(
      `blind response ${evaluatorId} has evidence boxes outside the ${pixels.width}x${pixels.height} screenshot:\n  - ${boxCheck.violations.join('\n  - ')}\ncoordinates must be measured in the screenshot image's own pixels; discard the response and re-dispatch`,
      EXIT.EVALUATOR,
      { violations: boxCheck.violations, image: pixels },
    );
  }
  if (boxCheck.warning) {
    process.stderr.write(`caveman-ui-ux: warning: ${evaluatorId} for ${screenId}: ${boxCheck.warning}\n`);
  }
  if (response?.screen_id !== screenId) {
    return fail(
      `blind response screen_id ${String(data?.screen_id)} does not match ${screenId}; the response was written for another screen`,
      EXIT.EVALUATOR,
      { screen_id: screenId, response_screen_id: data?.screen_id ?? null },
    );
  }
  const dir = join(screenDir(cwd, runId, screenId), 'blind');
  const file = join(dir, `${evaluatorId}.json`);
  if (existsSync(file) && !force) {
    return fail(
      `blind response ${evaluatorId} for ${screenId} already exists; sealed responses are immutable (pass --force to overwrite)`,
      EXIT.EVALUATOR,
      { path: file },
    );
  }
  await mkdir(dir, { recursive: true });
  const sealedResponse = { ...response, _ingested_at: new Date().toISOString() };
  await writeFile(file, `${JSON.stringify(sealedResponse, null, 2)}\n`, 'utf8');
  return { path: file, run_id: runId, screen_id: screenId, evaluator_id: evaluatorId };
}

/** Read every sealed blind response for one screen, sorted by evaluator id. */
export async function readBlindResponses(cwd, runId, screenId) {
  const dir = join(screenDir(cwd, runId, screenId), 'blind');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  const out = [];
  for (const name of files) {
    const file = join(dir, name);
    const raw = await readFile(file, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return fail(`sealed blind response is not valid JSON: ${file} (${firstLine(err)})`, EXIT.EVALUATOR, { path: file });
    }
    out.push({ evaluator_id: name.replace(/\.json$/, ''), ...parsed });
  }
  return out;
}

/** Read a JSON file, or null when it is absent or unreadable. */
function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** How many blind evaluators one screen expects, from the panel config. */
function expectedEvaluatorCount(config) {
  const evaluation = config?.evaluation || {};
  if (evaluation.caveman === false) return 0;
  const panel = evaluation.panel || {};
  if (panel.enabled && Array.isArray(panel.evaluators)) return Math.max(1, panel.evaluators.length);
  return 1;
}

/** Per-screen blind ingestion progress, so the orchestrator knows what is still pending. */
export async function blindStatus(cwd, runId) {
  const workDir = cwd || process.cwd();
  const runRoot = runDir(workDir, runId);
  const manifest = readJsonIfExists(join(runRoot, 'run.json'));
  const screensDir = join(runRoot, 'screens');
  const screenIds = Array.isArray(manifest?.screens) && manifest.screens.length > 0
    ? manifest.screens.map((screen) => screen.screen_id)
    : (existsSync(screensDir) ? readdirSync(screensDir).filter((name) => SCREEN_DIR_RE.test(name)).sort() : []);
  const expected = expectedEvaluatorCount(manifest?.config);
  const screens = [];
  for (const screenId of screenIds) {
    const responses = await readBlindResponses(workDir, runId, screenId);
    const record = Array.isArray(manifest?.screens)
      ? manifest.screens.find((screen) => screen.screen_id === screenId) || null
      : null;
    screens.push({
      screen_id: screenId,
      status: record?.status ?? 'ok',
      expected,
      ingested: responses.length,
      pending: Math.max(0, expected - responses.length),
      evaluators: responses.map((response) => response.evaluator_id),
    });
  }
  return {
    run_id: runId,
    expected_per_screen: expected,
    total_ingested: screens.reduce((sum, screen) => sum + screen.ingested, 0),
    screens,
    complete: screens.filter((screen) => screen.status !== 'error').every((screen) => screen.pending === 0),
  };
}
