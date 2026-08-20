// Stage A (preflight) + Stage B (blind capture): render every target, seal the
// screenshot manifest, emit blind payloads. Contract §9.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { chmod, readFile, rm } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertNoLeakage, blindPayload } from './blind.mjs';
import { resolveLaunch, withPage } from './browser.mjs';
import { configHash, expandTargets, normalizeRoute, redactConfig, resolveUrl } from './config.mjs';
import { EXIT, fail } from './errors.mjs';
import { ensureDir, exists, readJson, writeJson } from './fsx.mjs';
import { deterministicFindingId, screenId as makeScreenId } from './ids.mjs';
import { ROOT_DIR_NAME, latestRunId, relToCwd, runDir, screenDir } from './paths.mjs';

const RULE_VERSION = '1.0.0';
const UNREACHABLE_RULE = 'TECH.TARGET.UNREACHABLE';

/** First line of an error message. */
function firstLine(err) {
  const message = err && err.message ? String(err.message) : String(err);
  return message.split('\n')[0].trim();
}

/** Accept a function, a {info} logger or nothing, and always return a callable. */
function toLogger(log) {
  if (typeof log === 'function') return log;
  if (log && typeof log.info === 'function') return (message) => log.info(message);
  return () => {};
}

/** Resolve a target viewport (object or configured id) to the canonical shape. */
function resolveViewport(config, viewport) {
  const list = Array.isArray(config?.viewports) ? config.viewports : [];
  const found = typeof viewport === 'string' ? list.find((entry) => entry.id === viewport) : viewport;
  if (!found || typeof found.width !== 'number' || typeof found.height !== 'number') {
    return fail(`unknown viewport ${JSON.stringify(viewport)}; configure it under viewports`, EXIT.CONFIG, { viewport });
  }
  return {
    id: found.id,
    width: found.width,
    height: found.height,
    device_scale_factor: found.device_scale_factor ?? 1,
  };
}

/** Match one planned target against onlyTargets (function, string or object filters). */
function matchesOnly(plan, onlyTargets) {
  if (typeof onlyTargets === 'function') return Boolean(onlyTargets(plan));
  const list = Array.isArray(onlyTargets) ? onlyTargets : [onlyTargets];
  return list.some((entry) => {
    if (typeof entry === 'string') {
      return entry === plan.screen_id || entry === plan.route || entry === plan.locale || entry === plan.viewport.id;
    }
    if (!entry || typeof entry !== 'object') return false;
    const viewportId = typeof entry.viewport === 'string' ? entry.viewport : entry.viewport?.id;
    return (entry.screen_id === undefined || entry.screen_id === plan.screen_id)
      && (entry.route === undefined || entry.route === plan.route)
      && (entry.locale === undefined || entry.locale === plan.locale)
      && (viewportId === undefined || viewportId === plan.viewport.id);
  });
}

/** Click only the explicitly configured overlays; never guess a cookie banner. */
async function dismissConfigured(page, selectors) {
  let dismissed = 0;
  for (const selector of selectors) {
    const handles = await page.locator(selector).all().catch(() => []);
    for (const handle of handles) {
      const clicked = await handle.click({ timeout: 1500 }).then(() => true).catch(() => false);
      if (clicked) dismissed += 1;
    }
  }
  if (dismissed > 0) await sleep(150);
  return dismissed;
}

/** Overlay opaque black boxes over redacted regions; reports selectors that matched nothing. */
async function applyRedactions(page, selectors) {
  const configured = Array.isArray(selectors) ? selectors : [];
  if (configured.length === 0) return { applied: [], misses: [] };
  const applied = await page.evaluate((wanted) => {
    const applied = [];
    if (!document.body) return applied;
    for (const selector of wanted) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch {
        continue;
      }
      let hit = false;
      for (const node of nodes) {
        const box = node.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) continue;
        const overlay = document.createElement('div');
        overlay.setAttribute('data-caveman-redaction', '1');
        overlay.style.cssText = [
          'position:fixed',
          `left:${box.left}px`,
          `top:${box.top}px`,
          `width:${box.width}px`,
          `height:${box.height}px`,
          'background:#000000',
          'opacity:1',
          'z-index:2147483647',
          'pointer-events:none',
        ].join(';');
        document.body.appendChild(overlay);
        hit = true;
      }
      if (hit) applied.push(selector);
    }
    return applied;
  }, configured);
  // An unmatched or syntactically invalid selector never lands in `applied`, so the
  // difference is exactly the set of redactions that produced no black box.
  return { applied, misses: configured.filter((selector) => !applied.includes(selector)) };
}

/** Split a command string into an argv array, honouring single and double quotes. */
export function splitArgv(command) {
  if (Array.isArray(command)) {
    for (let i = 0; i < command.length; i++) {
      if (typeof command[i] !== 'string' || command[i] === '') {
        return fail(`target.start_command array element at index ${i} is not a non-empty string`, EXIT.CONFIG, { index: i, value: command[i] });
      }
    }
    return command;
  }
  const argv = [];
  let current = '';
  let started = false;
  let quote = null;
  for (const char of String(command)) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === '\'') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) argv.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) {
    return fail(`target.start_command has an unterminated ${quote} quote: ${command}`, EXIT.CONFIG, { start_command: command });
  }
  if (started) argv.push(current);
  return argv;
}

/** Mirror a child stream into the progress log one line at a time. */
function teeToLog(stream, say, prefix) {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) say(`${prefix} ${line.trim()}`);
    }
  });
}

/** True as soon as the url answers with any status; false on error or timeout. */
function probeUrl(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      const client = new URL(url).protocol === 'https:' ? httpsGet : httpGet;
      // Liveness probe only: a self-signed dev certificate still means "the app is up".
      request = client(url, { timeout: timeoutMs, rejectUnauthorized: false }, (response) => {
        response.resume();
        finish(true);
      });
    } catch {
      finish(false);
      return;
    }
    request.on('error', () => finish(false));
    request.on('timeout', () => {
      request.destroy();
      finish(false);
    });
  });
}

/** True as soon as a TCP connect to the host:port of url succeeds; false on error or timeout. */
export function isPortInUse(url, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      finish(false);
      return;
    }
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
    const socket = connect({ host: parsed.hostname, port, timeout: timeoutMs }, () => {
      socket.destroy();
      finish(true);
    });
    socket.on('error', () => finish(false));
    socket.on('timeout', () => {
      socket.destroy();
      finish(false);
    });
  });
}

/** SIGTERM a child process, escalating to SIGKILL after 5s; resolves once it is gone. */
function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const escalate = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => {
      clearTimeout(escalate);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

// ponytail: one child process, SIGTERM then SIGKILL, and readiness = base_url answers at all.
// No process-group kill and no separate health-check path config — add those when a target
// spawns detached workers or needs a warm-up endpoint that differs from base_url.
/** Run config.target.start_command and wait for base_url to answer; null when unset. */
export async function startTargetApp(config, cwd, log) {
  const say = toLogger(log);
  const command = config?.target?.start_command;
  if (command === null || command === undefined || command === '') return null;
  const argv = splitArgv(command);
  if (argv.length === 0) {
    return fail('target.start_command is blank; set it to a command or null', EXIT.CONFIG, { start_command: command });
  }
  const url = config?.target?.base_url;
  if (!url) {
    return fail('target.start_command needs target.base_url to poll for readiness', EXIT.CONFIG, { start_command: command });
  }
  const timeoutMs = config?.target?.wait?.timeout_ms ?? 20000;
  const workDir = cwd || process.cwd();
  say(`starting target app: ${argv.join(' ')}`);
  // Never shell:true — an argv array keeps a config value from becoming a shell injection.
  const child = spawn(argv[0], argv.slice(1), { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const handle = { stop: () => killChild(child) };
  let gone = null;
  child.once('error', (err) => { gone = gone || firstLine(err); });
  child.once('exit', (code, signal) => { gone = gone || `exited with ${signal || `code ${code}`}`; });
  teeToLog(child.stdout, say, 'target app:');
  teeToLog(child.stderr, say, 'target app:');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeUrl(url)) {
      say(`target app is answering ${url}`);
      return handle;
    }
    if (gone !== null) break;
    await sleep(250);
  }
  // Snapshot before stopping: our own SIGTERM would otherwise look like a spontaneous death.
  const diedAlone = gone;
  await handle.stop();
  // A dead child is the cause; a live one that never answered is a timeout. Say which.
  const why = diedAlone ? `the child ${diedAlone}` : `it stayed silent for ${timeoutMs}ms (target.wait.timeout_ms)`;
  return fail(
    `target.start_command (${argv.join(' ')}) never made ${url} answer: ${why}`,
    EXIT.TARGET,
    { start_command: command, base_url: url, timeout_ms: timeoutMs, child: diedAlone },
  );
}

/** Start the target app, call fn, and stop the app in finally. */
export async function withTargetApp(config, cwd, log, fn, preflight) {
  const say = toLogger(log);
  const command = config?.target?.start_command;
  const url = config?.target?.base_url;

  // No start_command configured: run fn directly.
  if (command === null || command === undefined || command === '') return fn();

  // Validate start_command legality before any side effect (C1).
  splitArgv(command);

  // Run preflight before spawning (C2).
  if (preflight) await preflight();

  // Already answering: don't spawn, don't kill — it may be a user's own server.
  if (url && await isPortInUse(url)) {
    say(`reusing the server already listening on ${url} (not started by us, will not be stopped)`);
    return fn();
  }

  // Spawn our own child, run fn, stop child in finally.
  const app = await startTargetApp(config, cwd, log);
  try {
    return await fn();
  } finally {
    if (app) await app.stop();
  }
}

/** Screens whose configured redact_selectors matched nothing, for the score limitations block. */
export function redactionSummary(manifest) {
  const screens = Array.isArray(manifest?.screens) ? manifest.screens : [];
  return screens
    .filter((screen) => Array.isArray(screen?.redaction_misses) && screen.redaction_misses.length > 0)
    .map((screen) => ({ screen_id: screen.screen_id, selectors: [...screen.redaction_misses] }));
}

/** Build the blocker finding recorded when a target cannot be rendered. */
function unreachableFinding(record) {
  const target = {
    route: record.route,
    normalized_route: record.normalized_route,
    locale: record.locale,
    viewport: record.viewport.id,
    screen_id: record.screen_id,
    url: record.url,
  };
  return {
    id: deterministicFindingId({
      ruleId: UNREACHABLE_RULE,
      normalizedRoute: record.normalized_route,
      locale: record.locale,
      viewport: record.viewport.id,
      stableSelector: ':root',
    }),
    rule_id: UNREACHABLE_RULE,
    rule_version: RULE_VERSION,
    kind: 'deterministic',
    severity: 'blocker',
    confidence: 1.0,
    title: 'Target screen could not be rendered',
    detail: `Navigation failed (${record.error || 'unknown error'}), so no evidence could be collected for this screen.`,
    target,
    evidence: [
      { type: 'metric', name: 'http_status', value: record.http_status ?? 0, unit: 'status' },
      { type: 'text', value: record.error || 'navigation failed' },
    ],
    fix_brief: {
      intent: 'Make the audited route render successfully so it can be evaluated.',
      acceptance: [
        'The route answers with a 2xx or 3xx status.',
        'The page reaches the configured wait strategy inside target.wait.timeout_ms.',
      ],
      suggested_change: 'Check target.base_url and the route, start the dev server (target.start_command), and confirm auth via target.storage_state when the route is protected.',
      rule_ids: [UNREACHABLE_RULE],
      target,
    },
    status: 'open',
  };
}

/** Stage A + B: capture every configured route x locale x viewport and seal the manifest. */
export async function captureMatrix({ cwd, config, runId, log, onlyTargets } = {}) {
  const say = toLogger(log);
  const workDir = cwd || process.cwd();
  if (!runId) return fail('captureMatrix requires a run id', EXIT.CONFIG, {});
  const startedAt = new Date().toISOString();
  const localePrefixes = config?.target?.locale_prefixes || [];
  const configuredRoutes = Array.isArray(config?.target?.routes) ? config.target.routes : [];

  const planned = expandTargets(config).map((target) => {
    const viewport = resolveViewport(config, target.viewport);
    return {
      route: target.route,
      locale: target.locale,
      viewport,
      screen_id: makeScreenId(runId, target.route, target.locale, viewport.id),
    };
  });
  const targets = onlyTargets === undefined || onlyTargets === null
    ? planned
    : planned.filter((plan) => matchesOnly(plan, onlyTargets));
  if (targets.length === 0) {
    return fail('no capture targets: check target.routes, target.locales, viewports and any --routes/--locales/--viewports filter', EXIT.CONFIG, { planned: planned.length });
  }

  // Fail fast on a missing browser before any artifact directory is created.
  const launch = await resolveLaunch(config);
  say(`browser: ${launch.browserDescription}`);

  return await captureTargets({ workDir, config, runId, say, targets, launch, startedAt, localePrefixes, configuredRoutes });
}

/** Capture every planned target, seal the manifest and return it (contract §9). */
async function captureTargets({ workDir, config, runId, say, targets, launch, startedAt, localePrefixes, configuredRoutes }) {
  const screens = [];
  const sealed = {};
  for (const plan of targets) {
    const screenId = plan.screen_id;
    const url = resolveUrl(config, plan.route, plan.locale);
    const dir = ensureDir(screenDir(workDir, runId, screenId));
    const screenshotAbs = join(dir, 'screenshot.png');
    const record = {
      screen_id: screenId,
      route: plan.route,
      normalized_route: normalizeRoute(plan.route, localePrefixes),
      url,
      locale: plan.locale,
      viewport: plan.viewport,
      http_status: null,
      status: 'ok',
      error: null,
      screenshot: { path: relToCwd(workDir, screenshotAbs), bytes: 0, sha256: null },
      redacted: [],
      redaction_misses: [],
    };
    let title = '';
    try {
      await withPage(config, { url, locale: plan.locale, viewport: plan.viewport }, async (page, response) => {
        record.http_status = response && typeof response.status === 'function' ? response.status() : null;
        if (record.http_status !== null && record.http_status >= 400) {
          throw new Error(`HTTP ${record.http_status}`);
        }
        await sleep(config?.target?.wait?.settle_ms ?? 400);
        await dismissConfigured(page, config?.target?.dismiss_selectors || []);
        const redaction = await applyRedactions(page, config?.privacy?.redact_selectors || []);
        record.redacted = redaction.applied;
        record.redaction_misses = redaction.misses;
        for (const selector of redaction.misses) {
          // Loud on purpose, and past --quiet: a redaction that matched nothing means this
          // screenshot ships unredacted, and a renamed CSS class is the usual cause.
          process.stderr.write(
            `caveman-ui-ux: warning: redact_selector ${JSON.stringify(selector)} matched nothing on `
            + `${screenId} (${plan.route} [${plan.locale}/${plan.viewport.id}]) — that screenshot is NOT redacted for it\n`,
          );
        }
        title = await page.title().catch(() => '');
        // Screenshots are chmod 0444 once sealed; clear a previous file first.
        await rm(screenshotAbs, { force: true });
        await page.screenshot({ path: screenshotAbs, fullPage: false });
      });
      const bytes = await readFile(screenshotAbs);
      record.screenshot.bytes = bytes.length;
      record.screenshot.sha256 = createHash('sha256').update(bytes).digest('hex');
    } catch (err) {
      record.status = 'error';
      record.error = firstLine(err);
      // No usable file, so no screenshot object: {path, bytes, sha256} are all required and a
      // null sha256 would make the whole audit fail schema validation (contract §3).
      record.screenshot = null;
      say(`capture failed: ${plan.route} [${plan.locale}/${plan.viewport.id}] ${record.error}`);
      writeJson(join(dir, 'checks.json'), { findings: [unreachableFinding(record)] });
      screens.push(record);
      sealed[screenId] = {
        route: record.route,
        url: record.url,
        locale: record.locale,
        viewport: record.viewport.id,
        title: '',
      };
      continue;
    }

    sealed[screenId] = {
      route: record.route,
      url: record.url,
      locale: record.locale,
      viewport: record.viewport.id,
      title,
    };
    const payload = blindPayload(record, config);
    writeJson(join(dir, 'blind-payload.json'), payload);
    const leakage = assertNoLeakage(payload, {
      baseUrl: config?.target?.base_url || url,
      routes: [...configuredRoutes, plan.route],
      sealed,
    });
    if (!leakage.ok) {
      return fail(
        `blind payload for ${screenId} leaks context: ${leakage.violations.map((v) => `${v.kind}@${v.key}`).join(', ')}`,
        EXIT.PRIVACY,
        { screen_id: screenId, violations: leakage.violations },
      );
    }
    say(`captured ${plan.route} [${plan.locale}/${plan.viewport.id}] -> ${screenId}`);
    screens.push(record);
  }

  if (screens.every((screen) => screen.status === 'error')) {
    return fail(
      `every capture target failed (${screens.length}); first error: ${screens[0]?.error || 'unknown'}`,
      EXIT.TARGET,
      { screens: screens.map((screen) => ({ screen_id: screen.screen_id, route: screen.route, error: screen.error })) },
    );
  }

  writeJson(join(runDir(workDir, runId), 'sealed.json'), sealed);
  const manifest = {
    run_id: runId,
    started_at: startedAt,
    finished_at: null,
    cwd: workDir,
    // Credentials must never reach an artifact that CI uploads; the hash still covers the
    // real config so two runs of the same config still agree.
    config: redactConfig(config),
    config_hash: configHash(config),
    report_locale: config?.report_locale || 'en',
    tool_versions: {
      node: process.version,
      playwright: launch.playwrightVersion ?? null,
      browser: launch.browserDescription ?? null,
      axe_core: null,
      lighthouse: null,
    },
    screens,
    stages_completed: ['A', 'B'],
    blind_sealed_at: new Date().toISOString(),
  };
  await writeRunManifest(workDir, manifest);

  for (const screen of screens) {
    if (screen.status !== 'ok') continue;
    await chmod(join(workDir, screen.screenshot.path), 0o444).catch(() => {});
  }
  return manifest;
}

/** Write run.json for a run manifest. */
export async function writeRunManifest(cwd, manifest) {
  const workDir = cwd || process.cwd();
  const runId = manifest?.run_id;
  if (!runId) return fail('run manifest has no run_id', EXIT.CONFIG, {});
  writeJson(join(runDir(workDir, runId), 'run.json'), manifest);
  return manifest;
}

/** Read run.json; an omitted run id resolves to the newest run directory. */
export async function readRunManifest(cwd, runId) {
  const workDir = cwd || process.cwd();
  const id = runId || latestRunId(workDir);
  if (!id) return fail(`no runs found under ${ROOT_DIR_NAME}/runs; run capture first`, EXIT.CONFIG, { cwd: workDir });
  const file = join(runDir(workDir, id), 'run.json');
  if (!exists(file)) {
    return fail(`run manifest not found: ${ROOT_DIR_NAME}/runs/${id}/run.json`, EXIT.CONFIG, { run_id: id });
  }
  try {
    return readJson(file);
  } catch (err) {
    return fail(`run manifest is not valid JSON: ${file} (${firstLine(err)})`, EXIT.CONFIG, { run_id: id });
  }
}

/** True for a plain object (used for one-level manifest patching). */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Patch run.json, merging plain objects one level deep (e.g. tool_versions). */
export async function updateRunManifest(cwd, runId, patch) {
  const manifest = await readRunManifest(cwd, runId);
  const next = { ...manifest };
  for (const [key, value] of Object.entries(patch || {})) {
    next[key] = isPlainObject(value) && isPlainObject(manifest[key]) ? { ...manifest[key], ...value } : value;
  }
  await writeRunManifest(cwd, next);
  return next;
}
