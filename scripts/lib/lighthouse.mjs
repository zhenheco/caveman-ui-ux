// Lighthouse adapter (optional). External process only, argv arrays, never a shell string.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];
const METRIC_AUDITS = [
  'first-contentful-paint',
  'largest-contentful-paint',
  'total-blocking-time',
  'cumulative-layout-shift',
];
const PROBE_TIMEOUT_MS = 180000;
const KILL_GRACE_MS = 5000;
const NPX_ARGS = ['-y', 'lighthouse@12'];

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

/** Run one argv array and resolve to { code, stdout, stderr } without ever throwing. */
function run(command, args, { timeoutMs, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, env: env || process.env, maxBuffer: 64 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: error ? error.message : null,
        });
      },
    );
  });
}

/** First usable Chrome/Chromium binary for Lighthouse, or null when none is found. */
export function detectChromePath() {
  const fromEnv = process.env.CAVEMAN_CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  for (const binary of ['google-chrome', 'chromium']) {
    try {
      // `command -v` is a shell builtin, so it needs sh; `binary` is a local literal, never user input.
      const found = execFileSync('sh', ['-c', `command -v ${binary}`], { encoding: 'utf8' }).trim();
      if (found && existsSync(found)) return found;
    } catch {
      // not on PATH
    }
  }
  return null;
}

/** Extract the first semver-looking string from CLI output. */
function parseVersion(text) {
  const match = String(text || '').match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/** Detect whether Lighthouse can run here, preferring a local binary over npx. */
export async function lighthouseAvailable() {
  const which = await run('sh', ['-c', 'command -v lighthouse'], { timeoutMs: 10000 });
  const binary = which.code === 0 ? which.stdout.trim().split('\n')[0].trim() : '';
  if (binary) {
    const probe = await run(binary, ['--version'], { timeoutMs: 60000 });
    if (probe.code === 0) {
      return { available: true, version: parseVersion(probe.stdout) || null, how: 'bin' };
    }
  }
  const npx = await run('npx', [...NPX_ARGS, '--version'], { timeoutMs: PROBE_TIMEOUT_MS });
  if (npx.code === 0) {
    return { available: true, version: parseVersion(npx.stdout) || null, how: 'npx' };
  }
  return { available: false, version: null, how: null };
}

/** Slice JSON out of stdout that may start with npx or Lighthouse noise. */
function parseLhr(stdout) {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

/** Pull the 4 category scores and key metrics out of one Lighthouse result. */
function extractRun(lhr) {
  const scores = {};
  for (const key of CATEGORIES) {
    const category = lhr.categories ? lhr.categories[key] : null;
    scores[key] = category && typeof category.score === 'number' ? category.score : null;
  }
  const metrics = {};
  for (const id of METRIC_AUDITS) {
    const audit = lhr.audits ? lhr.audits[id] : null;
    metrics[id] = audit && typeof audit.numericValue === 'number' ? audit.numericValue : null;
  }
  return { ...scores, metrics };
}

/** Median of the numbers in `values`, ignoring null/NaN; null when nothing is usable. */
function medianOf(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/** Spawn one Lighthouse run with a hard timeout; resolves to { ok, lhr|null, reason }. */
function spawnRun({ command, args, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, lhr: null, reason: `spawn failed: ${error.message}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer = null;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString().slice(0, 4000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    child.on('error', (error) => finish({ ok: false, lhr: null, reason: `process error: ${error.message}` }));
    child.on('close', (code, signal) => {
      if (signal) {
        finish({ ok: false, lhr: null, reason: `killed by ${signal} after ${timeoutMs}ms` });
        return;
      }
      const lhr = parseLhr(stdout);
      if (!lhr) {
        finish({
          ok: false,
          lhr: null,
          reason: `exit ${code} without parsable JSON: ${stderr.trim().slice(0, 300) || 'no stderr'}`,
        });
        return;
      }
      finish({ ok: true, lhr, reason: null });
    });
  });
}

/** Run Lighthouse `runs` times over one URL and return per-run plus median category scores. */
export async function runLighthouse({
  url,
  formFactor = 'mobile',
  runs = 3,
  chromePath = null,
  timeoutMs = PROBE_TIMEOUT_MS,
  log = null,
} = {}) {
  if (!url) return { available: false, reason: 'no url given' };
  const availability = await lighthouseAvailable();
  if (!availability.available) {
    return { available: false, reason: 'lighthouse is not installed and npx lighthouse@12 could not start' };
  }
  const chrome = chromePath || detectChromePath();
  const env = { ...process.env };
  if (chrome) env.CHROME_PATH = chrome;

  const mobile = formFactor !== 'desktop';
  const lighthouseArgs = [
    url,
    '--output=json',
    '--output-path=stdout',
    '--quiet',
    '--only-categories=performance,accessibility,best-practices,seo',
    `--form-factor=${mobile ? 'mobile' : 'desktop'}`,
    `--screenEmulation.mobile=${mobile}`,
    '--chrome-flags=--headless=new',
  ];
  const command = availability.how === 'bin' ? 'lighthouse' : 'npx';
  const args = availability.how === 'bin' ? lighthouseArgs : [...NPX_ARGS, ...lighthouseArgs];

  const collected = [];
  const failures = [];
  const total = Math.max(1, Number(runs) || 1);
  for (let i = 0; i < total; i += 1) {
    if (log) log(`lighthouse ${formFactor} run ${i + 1}/${total}`);
    const result = await spawnRun({ command, args, env, timeoutMs });
    if (result.ok) collected.push(extractRun(result.lhr));
    else failures.push(result.reason);
  }
  if (!collected.length) {
    return {
      available: false,
      reason: `all ${total} lighthouse run(s) failed: ${failures.join(' | ').slice(0, 500)}`,
    };
  }

  const median = {};
  for (const key of CATEGORIES) {
    median[key] = medianOf(collected.map((r) => r[key]));
  }
  median.metrics = {};
  for (const id of METRIC_AUDITS) {
    median.metrics[id] = medianOf(collected.map((r) => r.metrics[id]));
  }

  return {
    available: true,
    runs: collected,
    median,
    version: availability.version,
    how: availability.how,
    form_factor: mobile ? 'mobile' : 'desktop',
    chrome_path: chrome,
    failed_runs: failures,
  };
}
