// Playwright resolution + launch + page lifecycle. Contract §8.
// Zero npm dependencies: Playwright is resolved through the global npm root,
// never through a bare bundled import that this repo does not own.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EXIT, fail } from './errors.mjs';

const BCP47_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const DEPENDENCY_HINTS = ['npm i -g playwright', 'npx playwright install chromium'];

// Memoized per browser-config so a run probes the launch candidates only once.
const launchCache = new Map();

/** First line of an error message, for compact multi-candidate failure reports. */
function firstLine(err) {
  const message = err && err.message ? String(err.message) : String(err);
  return message.split('\n')[0].trim();
}

/** Read an installed package version through a require function, null when unknown. */
function packageVersion(requireFn) {
  try {
    return requireFn('playwright/package.json').version ?? null;
  } catch {
    return null;
  }
}

/** Guess a browser family name from an executable path. */
function binaryName(execPath) {
  if (/edge/i.test(execPath)) return 'msedge';
  if (/chrome/i.test(execPath)) return 'chrome';
  return 'chromium';
}

/** Resolve the Playwright module: bare import first, then the global npm root. */
export async function resolvePlaywright() {
  const attempts = [];
  try {
    const m = await import('playwright');
    const chromium = m.chromium || m.default?.chromium;
    if (chromium) {
      return { chromium, source: 'bare-import', version: packageVersion(createRequire(import.meta.url)) };
    }
    attempts.push('bare import: module exports no chromium');
  } catch (err) {
    attempts.push(`bare import: ${firstLine(err)}`);
  }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const requireFromGlobal = createRequire(`${globalRoot}/`);
    const m = requireFromGlobal('playwright');
    const chromium = m.chromium || m.default?.chromium;
    if (!chromium) throw new Error('module exports no chromium');
    return { chromium, source: `global:${globalRoot}`, version: packageVersion(requireFromGlobal) };
  } catch (err) {
    attempts.push(`global npm root: ${firstLine(err)}`);
  }
  return fail(
    `playwright could not be resolved. tried:\n  - ${attempts.join('\n  - ')}\nhints: ${DEPENDENCY_HINTS.join(' | ')}`,
    EXIT.DEPENDENCY,
    { tried: attempts, hints: DEPENDENCY_HINTS },
  );
}

/** Launch candidates in contract order: executable_path, channel, bundled, msedge. */
function launchCandidates(config, chromium) {
  const browserCfg = config?.browser || {};
  const candidates = [];
  const explicit = browserCfg.executable_path || process.env.CAVEMAN_CHROME_PATH || null;
  if (explicit) {
    candidates.push({
      label: `executable_path:${explicit}`,
      name: binaryName(explicit),
      options: { executablePath: explicit },
    });
  }
  const channel = browserCfg.channel || null;
  if (channel) {
    candidates.push({ label: `channel:${channel}`, name: channel, options: { channel } });
  }
  let bundled = null;
  try {
    bundled = chromium.executablePath();
  } catch {
    bundled = null;
  }
  if (bundled && existsSync(bundled)) {
    candidates.push({ label: 'bundled', name: 'chromium', options: { executablePath: bundled } });
  }
  if (channel !== 'msedge') {
    candidates.push({ label: 'channel:msedge', name: 'msedge', options: { channel: 'msedge' } });
  }
  return candidates;
}

/** Identity string for run.json, e.g. 'chrome 151.0.7922.138 (channel:chrome)'. */
export function browserVersionString(browser, candidate) {
  let version = 'unknown';
  try {
    version = typeof browser?.version === 'function' ? browser.version() : String(browser?.version ?? 'unknown');
  } catch {
    version = 'unknown';
  }
  return `${candidate?.name ?? 'chromium'} ${version} (${candidate?.label ?? 'unknown'})`;
}

/** Find a launchable Chromium/Chrome, collecting every candidate failure into one error. */
export async function resolveLaunch(config) {
  const cacheKey = JSON.stringify([config?.browser ?? null, process.env.CAVEMAN_CHROME_PATH ?? null]);
  const cached = launchCache.get(cacheKey);
  if (cached) return cached;
  const { chromium, version: playwrightVersion, source } = await resolvePlaywright();
  const headless = config?.browser?.headless !== false;
  const failures = [];
  for (const candidate of launchCandidates(config, chromium)) {
    const launchOptions = { headless, ...candidate.options };
    let browser = null;
    try {
      browser = await chromium.launch(launchOptions);
      const resolved = {
        chromium,
        launchOptions,
        candidate,
        playwrightVersion,
        playwrightSource: source,
        browserDescription: browserVersionString(browser, candidate),
      };
      launchCache.set(cacheKey, resolved);
      return resolved;
    } catch (err) {
      failures.push(`${candidate.label}: ${firstLine(err)}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
  return fail(
    `no usable browser could be launched. tried:\n  - ${failures.join('\n  - ') || '(no candidates)'}\nhints: ${DEPENDENCY_HINTS.join(' | ')}`,
    EXIT.DEPENDENCY,
    { tried: failures, hints: DEPENDENCY_HINTS },
  );
}

/** Normalize a target locale to a real BCP-47 tag, or null for 'auto'/invalid. */
function realLocale(locale) {
  if (typeof locale !== 'string') return null;
  const tag = locale.trim();
  if (!tag || tag.toLowerCase() === 'auto') return null;
  return BCP47_RE.test(tag) ? tag : null;
}

/** Build Playwright context options from config + one screen target. */
function contextOptions(config, screenTarget) {
  const viewport = screenTarget?.viewport || {};
  const browserCfg = config?.browser || {};
  const locale = realLocale(screenTarget?.locale);
  const options = {
    viewport: { width: viewport.width ?? 1280, height: viewport.height ?? 800 },
    deviceScaleFactor: viewport.device_scale_factor ?? 1,
  };
  if (browserCfg.color_scheme) options.colorScheme = browserCfg.color_scheme;
  if (browserCfg.reduced_motion) options.reducedMotion = browserCfg.reduced_motion;
  if (locale) options.locale = locale;
  if (config?.target?.storage_state) options.storageState = config.target.storage_state;
  const headers = { ...(config?.target?.extra_http_headers || {}) };
  if (locale && browserCfg.locale_header) headers['Accept-Language'] = locale;
  if (Object.keys(headers).length > 0) options.extraHTTPHeaders = headers;
  return options;
}

/** Run fn(page, response, info) in a fresh context; always closes context and browser. */
export async function withPage(config, screenTarget, fn) {
  const { chromium, launchOptions, candidate, playwrightVersion } = await resolveLaunch(config);
  const browser = await chromium.launch(launchOptions);
  let context = null;
  try {
    context = await browser.newContext(contextOptions(config, screenTarget));
    const page = await context.newPage();
    const wait = config?.target?.wait || {};
    const response = screenTarget?.url
      ? await page.goto(screenTarget.url, {
        waitUntil: wait.strategy || 'networkidle',
        timeout: wait.timeout_ms ?? 20000,
      })
      : null;
    return await fn(page, response, {
      browser,
      context,
      candidate,
      playwrightVersion,
      browserDescription: browserVersionString(browser, candidate),
    });
  } finally {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
