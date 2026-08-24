#!/usr/bin/env node
// caveman-ui-ux CLI — the single entry point for every stage. Contract §18.
// Zero npm dependencies: node: builtins plus the lib/ modules of this bundle.
// --json prints exactly one JSON object to stdout; progress always goes to stderr.

import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import { AXE_VERSION, ensureAxeSource, normalizeAxe, runAxe } from './lib/axe.mjs';
import {
  blindPayload, blindStatus, evaluatorPrompt, ingestBlind, readBlindResponses, stageBlindScreenshot,
} from './lib/blind.mjs';
import { resolveLaunch, resolvePlaywright, withPage } from './lib/browser.mjs';
import {
  captureMatrix, readRunManifest, redactionSummary, updateRunManifest, withTargetApp,
} from './lib/capture.mjs';
import { checkLinks, collectDom, runChecks } from './lib/checks.mjs';
import {
  configHash, loadConfig, normalizeRoute, redactConfig, restoreCredentials, unresolvedCredentials,
} from './lib/config.mjs';
import { CavemanError, EXIT, fail } from './lib/errors.mjs';
import { ensureDir, readJson, writeJson } from './lib/fsx.mjs';
import { deterministicFindingId, heuristicFindingId, newRunId } from './lib/ids.mjs';
import { lighthouseAvailable, runLighthouse } from './lib/lighthouse.mjs';
import { loadLocale, localeCompleteness } from './lib/locale.mjs';
import { buildLocaleMatrix } from './lib/multilingual.mjs';
import { ROOT_DIR_NAME, latestRunId, runDir, runsDir, screenDir, skillRoot } from './lib/paths.mjs';
import * as reportLib from './lib/report.mjs';
import { pruneRuns } from './lib/retention.mjs';
import { checkRules, getRule, loadRulePacks, severityOverride } from './lib/rules.mjs';
import {
  accessibilityScore, compositeScore, consensus, DIMENSIONS, dimensionSeverity, heuristicScore,
  median, multilingualScore, SEVERITY_ORDER, evaluateGates, technicalScore,
} from './lib/scoring.mjs';
import { validateFile, validateSubset } from './lib/validate.mjs';
import { claimHandoff, persistHandoffArtifact, prepareHandoff, recordHandoff, retryHandoff, transitionToImplemented, transitionToVerificationRequired, validateAudit, validateDiagnostic, validateLifecycleSourceBinding, verifyHandoff } from './lib/handoff.mjs';

const SKILL_VERSION = '1.0.0';
const AUDIT_SCHEMA_VERSION = 1;
const HEURISTIC_RULE_VERSION = '1.0.0';
const UNREACHABLE_RULE = 'TECH.TARGET.UNREACHABLE';
const EVIDENCE_REQUIRED_SEVERITIES = new Set(['blocker', 'critical', 'major']);
const NOTICES = [
  'This audit is evidence for design review, not a WCAG or accessibility legal compliance assessment.',
  'Agent evaluation is a cheap proxy for a first impression; it does not replace research with real users.',
  'No single number represents business outcomes — read the component scores and the findings.',
];

// Options that consume the next argv token; everything else is a boolean switch.
const VALUE_FLAGS = new Set([
  'config', 'cwd', 'run', 'agents', 'base-url', 'routes', 'locales', 'viewports',
  'screen', 'evaluators', 'evaluator', 'model', 'file', 'locale', 'finding',
  'retention-days', 'key', 'flow-id', 'diagnostic-file', 'state', 'claim-token', 'verify-run', 'repo',
]);
// Options that may repeat and always land in an array.
const REPEATABLE_FLAGS = new Set(['finding']);
const BOOLEAN_FLAGS = new Set([
  'json', 'quiet', 'force', 'help', 'version', 'global', 'uninstall', 'symlink', 'offline',
  'no-lighthouse', 'no-llm', 'ci', 'panel', 'allow-missing-technical', 'inline-screenshots',
  'allow-screenshot-upload',
]);

/** Split a comma separated CLI value into trimmed non-empty parts. */
function csv(value) {
  return String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Parse argv into { command, positional, flags } with no dependency and no guessing. */
function parseArgs(argv) {
  const tokens = [...argv];
  const flags = {};
  const words = [];
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === '--') {
      words.push(...tokens);
      break;
    }
    if (!token.startsWith('--')) {
      words.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq >= 0 ? body.slice(0, eq) : body;
    if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) {
      fail(`unknown option --${name} (run \`caveman --help\` for the option list)`, EXIT.CONFIG, { option: name });
    }
    if (VALUE_FLAGS.has(name)) {
      const value = eq >= 0 ? body.slice(eq + 1) : tokens.shift();
      if (value === undefined) fail(`option --${name} needs a value`, EXIT.CONFIG, { option: name });
      if (REPEATABLE_FLAGS.has(name)) (flags[name] ||= []).push(value);
      else flags[name] = value;
      continue;
    }
    flags[name] = eq >= 0 ? body.slice(eq + 1) !== 'false' : true;
  }
  // Two-word commands (`caveman prepare`, `rules check`) resolve in the dispatcher.
  const first = words.shift() ?? '';
  const second = words[0] ?? '';
  const pair = `${first} ${second}`;
  const command = Object.prototype.hasOwnProperty.call(COMMANDS, pair) ? pair : first;
  if (command === pair) words.shift();
  return { command, positional: words, flags };
}

/** One-line-per-command usage text (stderr only). */
function usage() {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = [
    'caveman-ui-ux — blind first-impression + deterministic UI/UX audit',
    '',
    'usage: node scripts/caveman.mjs <command> [options]',
    '',
    'commands:',
    ...Object.entries(COMMANDS).map(([name, spec]) => `  ${name.padEnd(width)}  ${spec.describe}`),
    '',
    'global options:',
    '  --config <path>   config file (default: caveman.config.yaml|yml|json in --cwd)',
    '  --cwd <path>      project directory to audit (default: process cwd)',
    '  --run <run-id>    operate on this run (default: newest run)',
    '  --json            print exactly one JSON object to stdout',
    '  --quiet           suppress stderr progress',
    '  --force           overwrite sealed / existing artifacts where allowed',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/** Build the per-invocation context: cwd, output mode, logger and emitter. */
function makeContext(parsed) {
  const cwd = resolvePath(parsed.flags.cwd || process.cwd());
  const json = Boolean(parsed.flags.json);
  const quiet = Boolean(parsed.flags.quiet);
  return {
    flags: parsed.flags,
    positional: parsed.positional,
    command: parsed.command,
    cwd,
    json,
    quiet,
    /** Compact progress line; always stderr so --json stdout stays a single object. */
    log(message) {
      if (!quiet) process.stderr.write(`caveman-ui-ux: ${message}\n`);
    },
    /** Terminal output: one JSON object in --json mode, otherwise the human lines. */
    emit(payload, lines = []) {
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: true, ...payload })}\n`);
        return;
      }
      const text = (Array.isArray(lines) ? lines : [lines]).filter((line) => line !== null && line !== undefined);
      if (text.length > 0) process.stdout.write(`${text.join('\n')}\n`);
    },
  };
}

/** Read JSON when the file exists, otherwise null (missing artifacts are normal). */
function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

/** Load the config for this invocation and surface loader warnings on stderr. */
async function contextConfig(ctx, overrides = {}) {
  const loaded = await loadConfig({ cwd: ctx.cwd, configPath: ctx.flags.config || null, overrides });
  for (const warning of loaded.warnings || []) ctx.log(`config warning: ${warning}`);
  return loaded;
}

/** Resolve --run or the newest run, failing with a clear message when there is none. */
function resolveRunId(ctx) {
  const requested = ctx.flags.run || null;
  if (requested) {
    if (!existsSync(runDir(ctx.cwd, requested))) {
      fail(
        `run ${requested} not found under ${ROOT_DIR_NAME}/runs — list ${runsDir(ctx.cwd)} or drop --run to use the newest run`,
        EXIT.CONFIG,
        { run_id: requested, runs_dir: runsDir(ctx.cwd) },
      );
    }
    return requested;
  }
  const latest = latestRunId(ctx.cwd);
  if (!latest) {
    fail(
      `no run found under ${ROOT_DIR_NAME}/runs — run \`caveman capture <url>\` or \`caveman audit <url>\` first`,
      EXIT.CONFIG,
      { cwd: ctx.cwd, runs_dir: runsDir(ctx.cwd) },
    );
  }
  return latest;
}

/** Split a positional URL argument into a base_url origin plus its route. */
function splitUrlArg(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return fail(`expected an absolute URL, got ${JSON.stringify(raw)}`, EXIT.CONFIG, { url: raw });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail(`only http(s) URLs can be audited, got ${parsed.protocol}`, EXIT.CONFIG, { url: raw });
  }
  const route = `${parsed.pathname || '/'}${parsed.search || ''}`;
  return { base_url: parsed.origin, route: route === '' ? '/' : route };
}

/** Build config overrides from the positional URL plus --routes/--locales. */
function targetOverrides(ctx) {
  const target = {};
  const raw = ctx.positional[0];
  if (raw) {
    const split = splitUrlArg(raw);
    target.base_url = split.base_url;
    if (!ctx.flags.routes && split.route !== '/') target.routes = [split.route];
  }
  if (ctx.flags.routes) target.routes = csv(ctx.flags.routes);
  if (ctx.flags.locales) target.locales = csv(ctx.flags.locales);
  return Object.keys(target).length > 0 ? { target } : {};
}

/** Every config override the CLI flags imply (target coordinates plus --panel). */
function cliOverrides(ctx) {
  const overrides = targetOverrides(ctx);
  // --panel is recorded in the run config so `caveman prepare` expects a panel later.
  if (ctx.flags.panel) overrides.evaluation = { panel: { enabled: true } };
  return overrides;
}

/** Apply --viewports by filtering the loaded viewport list (ids must exist in config). */
function applyViewportFilter(ctx, config) {
  if (!ctx.flags.viewports) return config;
  const wanted = csv(ctx.flags.viewports);
  const known = new Map((config.viewports || []).map((viewport) => [viewport.id, viewport]));
  const missing = wanted.filter((id) => !known.has(id));
  if (missing.length > 0) {
    fail(
      `unknown viewport id(s) ${missing.join(', ')}; configured ids: ${[...known.keys()].join(', ')}`,
      EXIT.CONFIG,
      { missing, known: [...known.keys()] },
    );
  }
  return { ...config, viewports: wanted.map((id) => known.get(id)) };
}

/** Lighthouse form factor for one viewport: below 768 CSS px counts as mobile. */
function formFactorOf(viewport) {
  return Number(viewport?.width) < 768 ? 'mobile' : 'desktop';
}

/** Integer or null, coercing a string cell (its length) to the schema's integer type. */
function intOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string') return Array.from(value).length;
  return null;
}

/**
 * Project a locale matrix onto exactly the audit.schema.json shape: the contract §13
 * nine cell fields only, so multilingual.mjs internals (visible_text, per-screen
 * detail) never bloat audit.json.
 */
function localeMatrixForAudit(matrix) {
  if (!matrix) return null;
  const rows = (Array.isArray(matrix.rows) ? matrix.rows : []).map((row) => ({
    normalized_route: row.normalized_route,
    route: row.route ?? row.normalized_route,
    by_locale: Object.fromEntries(Object.entries(row.by_locale || {}).map(([locale, cell]) => [locale, {
      screen_id: cell?.screen_id ?? null,
      lang: cell?.lang ?? null,
      hreflang_ok: typeof cell?.hreflang_ok === 'boolean' ? cell.hreflang_ok : null,
      cta_count: intOrNull(cell?.cta_count),
      primary_cta_text: typeof cell?.primary_cta_text === 'string' ? cell.primary_cta_text : null,
      residual_ratio: typeof cell?.residual_ratio === 'number' ? cell.residual_ratio : null,
      overflow: typeof cell?.overflow === 'boolean' ? cell.overflow : null,
      chars: intOrNull(cell?.chars),
      // audit.schema.json types longest_word as a length; multilingual.mjs reports the word itself.
      longest_word: intOrNull(cell?.longest_word),
    }])),
  }));
  return {
    locales: Array.isArray(matrix.locales) ? matrix.locales.map(String) : [],
    rows,
    score: typeof matrix.score === 'number' ? matrix.score : null,
  };
}

/** Severity rank used by verify; lower index means more severe. */
function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index < 0 ? SEVERITY_ORDER.length : index;
}

/** Coordinate + rule key used to pair findings across runs. */
function findingKey(finding) {
  const target = finding?.target || {};
  return [finding?.rule_id, target.normalized_route, target.locale, target.viewport].join('|');
}

// ---------------------------------------------------------------------------
// Stage D: deterministic evidence
// ---------------------------------------------------------------------------

/** TECH.TARGET.UNREACHABLE finding for a screen the evidence stage could not re-open. */
function unreachableFinding(screen, message) {
  const target = {
    route: screen.route,
    normalized_route: screen.normalized_route,
    locale: screen.locale,
    viewport: screen.viewport.id,
    screen_id: screen.screen_id,
    url: screen.url,
  };
  return {
    id: deterministicFindingId({
      ruleId: UNREACHABLE_RULE,
      normalizedRoute: screen.normalized_route,
      locale: screen.locale,
      viewport: screen.viewport.id,
      stableSelector: ':root',
    }),
    rule_id: UNREACHABLE_RULE,
    rule_version: String(getRule(UNREACHABLE_RULE)?.version ?? '1.0.0'),
    kind: 'deterministic',
    severity: 'blocker',
    confidence: 1.0,
    title: 'Target screen could not be rendered',
    detail: `Evidence collection could not re-open this screen (${message}), so it carries no axe or DOM evidence.`,
    target,
    evidence: [{ type: 'text', value: message }],
    fix_brief: {
      intent: 'Make the audited route render successfully so it can be evaluated.',
      acceptance: [
        'The route answers with a 2xx or 3xx status.',
        'The page reaches the configured wait strategy inside target.wait.timeout_ms.',
      ],
      suggested_change: 'Check target.base_url and the route, keep the dev server up for the whole run, and confirm auth via target.storage_state when the route is protected.',
      rule_ids: [UNREACHABLE_RULE],
      target,
    },
    status: 'open',
  };
}

/**
 * Re-attach credentials to a run's pinned config before any stage talks to the target again.
 * run.json stores a redacted snapshot, so the live config file is the only source of secrets.
 */
async function withLiveCredentials(ctx, snapshot, stage) {
  let live = null;
  try {
    live = (await loadConfig({ cwd: ctx.cwd, configPath: ctx.flags.config || null })).config;
  } catch {
    // A missing or now-invalid config file is only fatal when the run actually used credentials.
  }
  const config = restoreCredentials(snapshot, live);
  const missing = unresolvedCredentials(config);
  if (missing.length > 0) {
    fail(
      `${stage} needs the credentials this run was captured with, but the config file no longer supplies ${missing.join(', ')}; run.json only stores a redacted snapshot (secrets are never written to artifacts)`,
      EXIT.CONFIG,
      { missing },
    );
  }
  return config;
}

/**
 * Turn low blind dimension scores into real findings. Without this the pack's nine
 * CAVEMAN.<DIM>.001 rules never fire and a 29.5/100 screen reports "0 problems" — the score
 * says the visitor is lost while the findings list says nothing is wrong.
 */
function blindFindings({ screen, responses, consensusResult }) {
  const out = [];
  const viewportId = screen?.viewport?.id ?? null;
  const normalizedRoute = screen?.normalized_route ?? normalizeRoute(screen?.route ?? '/');
  for (const { key, question } of DIMENSIONS) {
    const score = consensusResult?.dimensions?.[key]?.consensus_score;
    const severity = dimensionSeverity(score);
    if (!severity) continue;
    const ruleId = `CAVEMAN.${key.toUpperCase()}.001`;
    const rule = getRule(ruleId);
    const evidence = [];
    const rationales = [];
    for (const response of responses) {
      const dimension = response?.dimensions?.[key];
      if (!dimension) continue;
      const who = response?.evaluator?.id ?? 'evaluator';
      if (typeof dimension.rationale === 'string' && dimension.rationale.trim()) {
        rationales.push(`${who}: ${dimension.rationale.trim()}`);
      }
      for (const item of Array.isArray(dimension.evidence) ? dimension.evidence : []) evidence.push(item);
    }
    // The score itself is evidence, so a dimension whose evaluators attached no region still
    // survives the AC-005 evidence gate with something an auditor can check.
    evidence.push({
      type: 'metric', name: `caveman.${key}.consensus_score`, value: score, unit: 'score/10',
    });
    const region = evidence.find((item) => item?.type === 'screenshot_region')?.box ?? null;
    out.push({
      id: heuristicFindingId({
        ruleId, normalizedRoute, locale: screen?.locale ?? 'auto', viewport: viewportId,
        region, viewportSize: screen?.viewport ?? null,
      }),
      rule_id: ruleId,
      rule_version: rule?.version ?? HEURISTIC_RULE_VERSION,
      kind: 'blind',
      severity,
      confidence: consensusResult?.evaluator_confidence ?? null,
      title: rule?.title ?? `Blind evaluators scored ${key} ${score}/10`,
      detail: `${question} — consensus ${score}/10. ${rationales.join(' | ')}`.trim(),
      target: {
        route: screen?.route ?? null,
        normalized_route: normalizedRoute,
        locale: screen?.locale ?? 'auto',
        viewport: viewportId,
        screen_id: screen?.screen_id ?? null,
        url: screen?.url ?? null,
      },
      evidence,
      fix_brief: {
        intent: `讓第一次看到這個畫面的人能回答：${question}`,
        acceptance: [`blind evaluator 對 ${key} 的 consensus score >= 7`],
        suggested_change: rationales[0] ? `對應 evaluator 的觀察：${rationales[0]}` : '',
        rule_ids: [ruleId],
      },
      status: 'open',
    });
  }
  return out;
}

/**
 * Split a run's config into what was MEASURED and how it is INTERPRETED.
 * target/viewports/browser/privacy are pinned to the capture — changing them later would
 * describe a screenshot that was never taken. rules/gates/composite/report_locale are
 * interpretation of those measurements, so a live config file may re-grade an existing run
 * without re-capturing it; that is what makes `rules.disabled` usable against a false positive.
 */
async function withLiveInterpretation(ctx, snapshot, log) {
  let live = null;
  try {
    live = (await loadConfig({ cwd: ctx.cwd, configPath: ctx.flags.config || null })).config;
  } catch {
    // No usable config file: the pinned snapshot is the only interpretation available.
  }
  if (!live) return snapshot;
  const merged = { ...snapshot };
  const changed = [];
  for (const section of ['rules', 'gates', 'composite', 'report_locale']) {
    if (live[section] === undefined) continue;
    if (JSON.stringify(live[section]) === JSON.stringify(snapshot?.[section])) continue;
    merged[section] = live[section];
    changed.push(section);
  }
  if (changed.length > 0 && typeof log === 'function') {
    log(`re-grading run with the current config's ${changed.join(', ')} (measurements stay as captured)`);
  }
  return merged;
}

/** Run axe + deterministic checks + link probes + Lighthouse over one existing run. */
async function runEvidenceStage(ctx, runId, { noLighthouse = false, offline = false } = {}) {
  const manifest = await readRunManifest(ctx.cwd, runId);
  const config = await withLiveCredentials(ctx, manifest.config, 'evidence');
  const screens = (manifest.screens || []).filter((screen) => screen.status === 'ok');
  if (screens.length === 0) {
    fail(`run ${runId} has no successfully captured screen; nothing to collect evidence for`, EXIT.TARGET, { run_id: runId });
  }

  const axeSource = await ensureAxeSource({ offline });
  ctx.log(`axe-core ${axeSource.version} (${axeSource.source})`);
  let axeVersion = axeSource.version;
  const summary = [];

  const failed = [];
  for (const screen of screens) {
    const dir = screenDir(ctx.cwd, runId, screen.screen_id);
    let counts = { axe: 0, checks: 0, links: 0 };
    try {
      await withPage(config, { url: screen.url, locale: screen.locale, viewport: screen.viewport }, async (page) => {
        const dom = await collectDom(page);
        writeJson(join(dir, 'dom.json'), dom);

        const raw = await runAxe(page, { offline });
        if (raw.axe_version) axeVersion = raw.axe_version;
        const axeFindings = normalizeAxe(raw, screen);
        writeJson(join(dir, 'axe.json'), { ...raw, findings: axeFindings });

        const checkFindings = runChecks(dom, screen);
        const linkFindings = await checkLinks(page, dom, { target: screen });
        writeJson(join(dir, 'checks.json'), { findings: [...checkFindings, ...linkFindings] });
        counts = { axe: axeFindings.length, checks: checkFindings.length, links: linkFindings.length };
      });
    } catch (error) {
      // One screen that stopped answering is a target problem for that screen, not a config
      // error for the whole stage: record it as evidence and keep collecting the rest.
      const message = String(error?.message || error).split('\n')[0];
      writeJson(join(dir, 'checks.json'), { error: message, findings: [unreachableFinding(screen, message)] });
      ctx.log(`evidence ${screen.route} [${screen.locale}/${screen.viewport.id}] failed: ${message}`);
      failed.push({ screen_id: screen.screen_id, route: screen.route, error: message });
      summary.push({ screen_id: screen.screen_id, ...counts, error: message });
      continue;
    }
    ctx.log(
      `evidence ${screen.route} [${screen.locale}/${screen.viewport.id}]: `
      + `axe ${counts.axe}, checks ${counts.checks}, links ${counts.links}`,
    );
    summary.push({ screen_id: screen.screen_id, ...counts });
  }
  if (failed.length === screens.length) {
    fail(
      `every screen failed during evidence collection: ${failed.map((entry) => `${entry.route} (${entry.error})`).join('; ')}`,
      EXIT.TARGET,
      { run_id: runId, failed },
    );
  }

  // Lighthouse runs once per (route, locale, form factor) actually present in the viewport list.
  let lighthouseVersion = null;
  const byUrl = new Map();
  const failedIds = new Set(failed.map((entry) => entry.screen_id));
  for (const screen of screens) {
    if (failedIds.has(screen.screen_id)) continue;
    const key = `${screen.route}\u0000${screen.locale}`;
    const entry = byUrl.get(key) || { url: screen.url, formFactors: new Map() };
    const formFactor = formFactorOf(screen.viewport);
    const bucket = entry.formFactors.get(formFactor) || [];
    bucket.push(screen);
    entry.formFactors.set(formFactor, bucket);
    byUrl.set(key, entry);
  }
  for (const [, entry] of byUrl) {
    for (const [formFactor, bucket] of entry.formFactors) {
      let result;
      if (noLighthouse) {
        result = { available: false, reason: 'skipped by --no-lighthouse' };
      } else {
        result = await runLighthouse({
          url: entry.url,
          formFactor,
          runs: config?.evaluation?.lighthouse_runs ?? 3,
          chromePath: config?.browser?.executable_path || process.env.CAVEMAN_CHROME_PATH || null,
          log: (message) => ctx.log(message),
        });
        if (result.available) lighthouseVersion = result.version ?? lighthouseVersion;
        else ctx.log(`lighthouse ${formFactor} unavailable: ${result.reason}`);
      }
      for (const screen of bucket) {
        writeJson(join(screenDir(ctx.cwd, runId, screen.screen_id), 'lighthouse.json'), { form_factor: formFactor, ...result });
      }
    }
  }

  const stages = [...new Set([...(manifest.stages_completed || []), 'D'])];
  await updateRunManifest(ctx.cwd, runId, {
    tool_versions: { axe_core: axeVersion ?? AXE_VERSION, lighthouse: lighthouseVersion },
    stages_completed: stages,
  });
  return { run_id: runId, screens: summary, failed, axe_core: axeVersion, lighthouse: lighthouseVersion };
}

// ---------------------------------------------------------------------------
// Stages F + G: audit assembly
// ---------------------------------------------------------------------------

/** Read every artifact of one run and assemble a schema-valid audit document. */
async function buildAudit(ctx, runId, { noLlm = false, allowMissingTechnical = false } = {}) {
  const manifest = await readRunManifest(ctx.cwd, runId);
  const config = await withLiveInterpretation(ctx, manifest.config, (message) => ctx.log(message));
  const screens = manifest.screens || [];
  const limitations = [];
  const findings = [];
  const axeFindings = [];
  const domByScreen = {};
  const perScreen = [];
  const lighthouseMedians = [];
  const blindResponses = [];
  const evaluatorRecords = [];
  const blindAnswers = [];
  let axeRan = false;
  let technicalAvailable = false;

  for (const screen of screens) {
    const dir = screenDir(ctx.cwd, runId, screen.screen_id);
    const axe = readJsonIfExists(join(dir, 'axe.json'));
    const checks = readJsonIfExists(join(dir, 'checks.json'));
    const dom = readJsonIfExists(join(dir, 'dom.json'));
    const lighthouse = readJsonIfExists(join(dir, 'lighthouse.json'));
    if (dom) domByScreen[screen.screen_id] = dom;
    if (axe) axeRan = true;

    const screenAxeFindings = Array.isArray(axe?.findings) ? axe.findings : [];
    const screenCheckFindings = Array.isArray(checks?.findings) ? checks.findings : [];
    axeFindings.push(...screenAxeFindings);
    findings.push(...screenAxeFindings, ...screenCheckFindings);

    if (lighthouse?.available && lighthouse.median) {
      lighthouseMedians.push(lighthouse.median);
      technicalAvailable = true;
    }

    const responses = noLlm ? [] : await readBlindResponses(ctx.cwd, runId, screen.screen_id);
    for (const response of responses) {
      blindResponses.push(response);
      const evaluatorId = response.evaluator?.id ?? response.evaluator_id ?? null;
      blindAnswers.push({
        screen_id: screen.screen_id,
        evaluator_id: evaluatorId,
        answers: response.answers ?? {},
      });
      // Provenance only: who answered, on which screen, how sure. The prose lives in
      // caveman.answers and the raw sealed file, so it is not duplicated here.
      evaluatorRecords.push({
        id: evaluatorId,
        runtime: response.evaluator?.runtime ?? null,
        model: response.evaluator?.model ?? null,
        screen_id: screen.screen_id,
        confidence: typeof response.confidence === 'number' ? response.confidence : null,
        ingested_at: response._ingested_at ?? null,
      });
    }
    const screenConsensus = responses.length > 0 ? consensus(responses) : null;
    if (screenConsensus) findings.push(...blindFindings({ screen, responses, consensusResult: screenConsensus }));

    perScreen.push({
      screen_id: screen.screen_id,
      route: screen.route,
      normalized_route: screen.normalized_route,
      locale: screen.locale,
      viewport: screen.viewport,
      url: screen.url,
      status: screen.status,
      screenshot: screen.screenshot ?? null,
      scores: {
        caveman: screenConsensus ? screenConsensus.caveman_score : null,
        accessibility: axe ? accessibilityScore(screenAxeFindings) : null,
        technical: lighthouse?.available ? technicalScore(lighthouse.median) : null,
      },
      finding_ids: [...screenAxeFindings, ...screenCheckFindings].map((finding) => finding.id),
      axe: axe ? { counts: axe.counts ?? null, axe_version: axe.axe_version ?? null } : null,
      checks: checks ? { count: screenCheckFindings.length } : null,
      lighthouse: lighthouse ?? null,
      blind: screenConsensus,
    });
  }

  // Stage E findings arrive as an ingested artifact, never computed here.
  const heuristicDoc = noLlm ? null : readJsonIfExists(join(runDir(ctx.cwd, runId), 'heuristic.json'));
  const heuristicFindings = Array.isArray(heuristicDoc?.findings) ? heuristicDoc.findings : [];
  const disabledRules = new Set((Array.isArray(config?.rules?.disabled) ? config.rules.disabled : []).map(String));
  findings.push(...heuristicFindings);

  // Stage F multilingual matrix.
  const matrix = buildLocaleMatrix({ screens, domByScreen, config });
  if (Array.isArray(matrix?.findings)) findings.push(...matrix.findings);

  // Contract §4: config.rules is applied once, here, where the findings of all four
  // producers (axe, checks, heuristic, multilingual) meet — so disabling or re-grading a
  // rule works no matter which stage emitted it.
  const enabled = [];
  let suppressed = 0;
  for (const finding of findings) {
    if (disabledRules.has(String(finding?.rule_id))) {
      suppressed += 1;
      continue;
    }
    // Only an explicit config override may re-grade a finding: the producer already derived
    // its severity from what it measured (axe impact, consensus score, check outcome), and the
    // pack default must not flatten that. Precedence: config override > producer > pack default.
    const override = severityOverride(finding?.rule_id, config);
    if (override) finding.severity = override;
    enabled.push(finding);
  }
  if (suppressed > 0) {
    // Suppression is a limitation of the audit, never a silent deletion.
    limitations.push(`${suppressed} finding(s) suppressed by config.rules.disabled`);
  }

  // AC-005: a blocker/critical/major finding without evidence is not a finding.
  const kept = [];
  let dropped = 0;
  for (const finding of enabled) {
    const hasEvidence = Array.isArray(finding?.evidence) && finding.evidence.length > 0;
    if (EVIDENCE_REQUIRED_SEVERITIES.has(finding?.severity) && !hasEvidence) {
      dropped += 1;
      continue;
    }
    kept.push(finding);
  }
  // Per-screen heuristic scores use the same final cohort as audit.findings:
  // disabled rules, severity overrides, and AC-005 evidence dropping have all applied.
  const keptHeuristicFindings = kept.filter((finding) => finding.kind === 'heuristic');
  const evaluatedScreenIds = new Set(Array.isArray(heuristicDoc?.evaluated_screen_ids) ? heuristicDoc.evaluated_screen_ids : []);
  for (const screen of perScreen) {
    const viewportId = typeof screen.viewport === 'string' ? screen.viewport : screen.viewport?.id;
    const scoped = keptHeuristicFindings.filter((finding) => {
      const target = finding.target || {};
      return normalizeRoute(target.normalized_route ?? target.route ?? '/') === normalizeRoute(screen.normalized_route ?? screen.route ?? '/')
        && target.locale === screen.locale
        && (target.viewport == null || target.viewport === viewportId);
    });
    screen.scores.heuristic_ux = heuristicDoc !== null && screen.status === 'ok' && evaluatedScreenIds.has(screen.screen_id)
      ? heuristicScore(scoped)
      : null;
  }
  // per_screen.finding_ids must resolve inside audit.findings, so it loses the same ids.
  const keptIds = new Set(kept.map((finding) => finding.id));
  for (const screen of perScreen) {
    screen.finding_ids = screen.finding_ids.filter((id) => keptIds.has(id));
  }
  if (dropped > 0) {
    limitations.push(`dropped ${dropped} unevidenced findings`);
    process.stderr.write(`caveman-ui-ux: warning: dropped ${dropped} blocker/critical/major findings with no evidence\n`);
  }

  const overall = blindResponses.length > 0 ? consensus(blindResponses) : null;
  const medianCategories = lighthouseMedians.length > 0
    ? {
      performance: median(lighthouseMedians.map((entry) => entry.performance).filter((value) => typeof value === 'number')),
      'best-practices': median(lighthouseMedians.map((entry) => entry['best-practices']).filter((value) => typeof value === 'number')),
      seo: median(lighthouseMedians.map((entry) => entry.seo).filter((value) => typeof value === 'number')),
      accessibility: median(lighthouseMedians.map((entry) => entry.accessibility).filter((value) => typeof value === 'number')),
    }
    : null;

  const scores = {
    caveman: overall ? overall.caveman_score : null,
    heuristic_ux: noLlm || heuristicDoc === null ? null : heuristicScore(kept),
    accessibility: axeRan ? accessibilityScore(axeFindings.filter((finding) => !disabledRules.has(String(finding.rule_id)))) : null,
    technical: medianCategories ? technicalScore(medianCategories) : null,
    multilingual_consistency: matrix ? (matrix.score ?? multilingualScore(matrix)) : null,
    evaluator_confidence: overall ? overall.evaluator_confidence : null,
    evaluator_dispersion: overall ? overall.evaluator_dispersion : null,
    composite: null,
  };
  if (config?.composite?.enabled) {
    scores.composite = compositeScore(scores, config.composite.weights);
  }

  if (noLlm) {
    limitations.push('blind (Stage C) and heuristic (Stage E) evaluation were skipped (--no-llm): caveman and heuristic_ux scores are null');
  }
  if (!axeRan) limitations.push('axe-core did not run: accessibility score is null');
  for (const miss of redactionSummary(manifest)) {
    limitations.push(`privacy.redact_selectors matched nothing on screen ${miss.screen_id}: ${miss.selectors.join(', ')} (that area was NOT blacked out)`);
  }
  if (!technicalAvailable) {
    limitations.push('Lighthouse did not run: technical score is null');
    if (!allowMissingTechnical && Number.isFinite(config?.gates?.technical_minimum) && ctx.flags.ci) {
      fail(
        'technical_minimum is configured but Lighthouse did not run; pass --allow-missing-technical to accept a skipped technical gate',
        EXIT.DEPENDENCY,
        { gate: 'technical_minimum' },
      );
    }
  }

  const gates = evaluateGates({ scores, findings: kept, gates: config?.gates || {}, technicalAvailable });
  limitations.push(...(gates.limitations || []));

  const audit = {
    schema_version: AUDIT_SCHEMA_VERSION,
    tool: { name: 'caveman-ui-ux', version: SKILL_VERSION },
    // The snapshot in the artifact never carries credentials; gates and configHash still see
    // the live config. redactConfig is idempotent, so an already-redacted manifest is unchanged.
    run: {
      ...manifest,
      config: redactConfig(manifest.config),
      finished_at: new Date().toISOString(),
      stages_completed: [...new Set([...(manifest.stages_completed || []), 'F', 'G'])],
    },
    config: redactConfig(config),
    targets: screens.map((screen) => ({
      route: screen.route,
      normalized_route: screen.normalized_route,
      locale: screen.locale,
      viewport: screen.viewport,
      url: screen.url,
    })),
    scores,
    per_screen: perScreen,
    caveman: overall
      ? {
        evaluators: evaluatorRecords,
        consensus: {
          dimensions: Object.fromEntries(DIMENSIONS.map(({ key }) => {
            const entry = overall.dimensions[key] || {};
            return [key, {
              score: entry.consensus_score ?? null,
              mad: entry.mad ?? null,
              dispersion: entry.dispersion ?? null,
              scores: (entry.scores || []).filter((value) => typeof value === 'number'),
            }];
          })),
          score: overall.caveman_score,
        },
        answers: blindAnswers,
        contradictions: overall.contradictions || [],
      }
      : null,
    locale_matrix: localeMatrixForAudit(matrix),
    findings: kept,
    gates: { pass: gates.pass, results: gates.results, exit_code: gates.exit_code },
    limitations,
    notices: NOTICES,
  };

  const validation = await validateFile('schemas/audit.schema.json', audit);
  if (!validation.valid) {
    const detail = validation.errors
      .map((error) => `${error.path || '(root)'}: ${error.message}`)
      .join('\n  - ');
    fail(`assembled audit.json is invalid:\n  - ${detail}`, EXIT.CONFIG, { errors: validation.errors });
  }
  writeJson(join(runDir(ctx.cwd, runId), 'audit.json'), audit);
  return { audit, gates };
}

/** Human-readable gate table plus the component score block. */
function gateTable(audit) {
  const rows = audit.gates.results.map((result) => [
    result.gate,
    result.actual === null ? 'n/a' : String(result.actual),
    result.threshold === null ? 'n/a' : `${result.comparator} ${result.threshold}`,
    result.status,
  ]);
  const header = ['gate', 'actual', 'threshold', 'status'];
  const widths = header.map((_, index) => Math.max(header[index].length, ...rows.map((row) => row[index].length)));
  const line = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd();
  const scoreLine = Object.entries(audit.scores)
    .filter(([key]) => key !== 'composite')
    .map(([key, value]) => `${key}=${value === null ? 'n/a' : value}`)
    .join(' ');
  return [
    `run ${audit.run.run_id}  findings ${audit.findings.length}  gates ${audit.gates.pass ? 'PASS' : 'FAIL'}`,
    scoreLine,
    '',
    line(header),
    ...rows.map(line),
  ];
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Render report.md + report.html for one run, via writeReports or the render pair. */
async function writeRunReports(ctx, runId, audit, { locale, inlineScreenshots }) {
  const code = locale || audit.run?.report_locale || audit.config?.report_locale || 'en';
  const target = runDir(ctx.cwd, runId);
  if (typeof reportLib.writeReports === 'function') {
    const result = await reportLib.writeReports({
      cwd: ctx.cwd,
      runId,
      runDir: target,
      audit,
      locale: code,
      inlineScreenshots: Boolean(inlineScreenshots),
    });
    return result && typeof result === 'object'
      ? result
      : { markdown: join(target, 'report.md'), html: join(target, 'report.html') };
  }
  // Fallback: the contract §16 render pair is always available even when the
  // writer helper is not; keep the CLI usable either way.
  const { dict } = loadLocale(code);
  const cssPath = join(skillRoot(), 'assets', 'report.css');
  const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';
  const markdown = reportLib.renderMarkdown(audit, dict);
  const html = reportLib.renderHtml(audit, dict, { css, inlineScreenshots: Boolean(inlineScreenshots) });
  ensureDir(target);
  writeFileSync(join(target, 'report.md'), markdown, 'utf8');
  writeFileSync(join(target, 'report.html'), html, 'utf8');
  return { markdown: join(target, 'report.md'), html: join(target, 'report.html') };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Import lib/install.mjs and pick the first export matching a candidate name. */
async function installerFunction(names, label) {
  const mod = await import('./lib/install.mjs');
  for (const name of names) {
    if (typeof mod[name] === 'function') return mod[name];
  }
  return fail(
    `lib/install.mjs exports none of ${names.join(', ')} — cannot ${label}`,
    EXIT.DEPENDENCY,
    { tried: names, exports: Object.keys(mod) },
  );
}

/** Agent ids whose managed block was modified by the user (install refuses to write). */
function installConflicts(result) {
  if (Array.isArray(result?.conflicts)) {
    return result.conflicts.map((entry) => (typeof entry === 'string' ? entry : entry?.agent ?? entry?.id ?? String(entry)));
  }
  return Object.entries(result?.manifest?.agents || result?.agents || {})
    .filter(([, agent]) => agent && agent.status === 'conflict')
    .map(([id]) => id);
}

/** Retention sweep (privacy.retention_days) before a new run allocates more disk. */
function pruneExpired(ctx, config) {
  const retentionDays = Number(config?.privacy?.retention_days ?? 0);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;
  try {
    const result = pruneRuns({ cwd: ctx.cwd, retentionDays, now: new Date(), log: (message) => ctx.log(message) });
    if (result.removedRuns.length > 0 || result.removedStaged.length > 0) {
      ctx.log(
        `retention ${retentionDays}d: removed ${result.removedRuns.length} run(s) and `
        + `${result.removedStaged.length} staged screenshot dir(s), freed ${result.freedBytes} bytes`,
      );
    }
    return result;
  } catch (error) {
    // Housekeeping must never take an audit down with it.
    ctx.log(`retention sweep failed (${String(error?.message || error).split('\n')[0]}); nothing was pruned`);
    return null;
  }
}

/** Shared implementation of `init` and `install`. */
async function runInstaller(ctx, { writeConfig }) {
  const created = [];
  if (writeConfig) {
    const examplePath = join(skillRoot(), 'assets', 'caveman.config.example.yaml');
    if (!existsSync(examplePath)) {
      fail(`assets/caveman.config.example.yaml is missing from the skill bundle`, EXIT.CONFIG, { path: examplePath });
    }
    const destination = join(ctx.cwd, 'caveman.config.yaml');
    if (existsSync(destination) && !ctx.flags.force) {
      fail(`caveman.config.yaml already exists in ${ctx.cwd}; pass --force to overwrite`, EXIT.CONFIG, { path: destination });
    }
    let text = readFileSync(examplePath, 'utf8');
    if (ctx.flags['base-url']) {
      text = text.replace(/^(\s*base_url:).*$/m, `$1 ${JSON.stringify(String(ctx.flags['base-url']))}`);
    }
    writeFileSync(destination, text, 'utf8');
    created.push(destination);
    ctx.log(`wrote ${destination}`);
  }

  const options = {
    cwd: ctx.cwd,
    global: Boolean(ctx.flags.global),
    force: Boolean(ctx.flags.force),
    symlink: Boolean(ctx.flags.symlink),
    uninstall: Boolean(ctx.flags.uninstall),
    log: (message) => ctx.log(message),
  };
  if (ctx.flags.agents) options.agents = csv(ctx.flags.agents);

  const fn = ctx.flags.uninstall
    ? await installerFunction(['uninstallAdapters', 'uninstall', 'removeAdapters', 'installAdapters'], 'uninstall adapters')
    : await installerFunction(['installAdapters', 'install', 'runInstall', 'installSkill'], 'install adapters');
  const manifest = await fn(options);
  return { created, manifest };
}

const COMMANDS = {
  init: {
    describe: 'write caveman.config.yaml then install the agent adapters',
    async run(ctx) {
      const { created, manifest } = await runInstaller(ctx, { writeConfig: true });
      const conflicts = installConflicts(manifest);
      ctx.emit(
        { command: 'init', cwd: ctx.cwd, created, conflicts, install: manifest },
        [
          `initialised caveman-ui-ux in ${ctx.cwd}`,
          ...created.map((path) => `  created ${path}`),
          conflicts.length > 0 ? `conflict: ${conflicts.join(', ')} carry a user-modified managed block` : null,
        ].filter(Boolean),
      );
      return conflicts.length > 0 ? EXIT.CONFIG : EXIT.OK;
    },
  },

  install: {
    describe: 'install / update / uninstall the agent adapters and the install manifest',
    async run(ctx) {
      const { manifest } = await runInstaller(ctx, { writeConfig: false });
      const conflicts = installConflicts(manifest);
      const ids = Array.isArray(manifest?.agents) ? manifest.agents : Object.keys(manifest?.manifest?.agents || {});
      ctx.emit(
        {
          command: 'install',
          cwd: ctx.cwd,
          uninstall: Boolean(ctx.flags.uninstall),
          conflicts,
          install: manifest,
        },
        [
          `${ctx.flags.uninstall ? 'uninstalled' : 'installed'} adapters: ${ids.join(', ') || '(none)'}`,
          conflicts.length > 0
            ? `conflict: ${conflicts.join(', ')} carry a user-modified managed block; diff the file then re-run with --force`
            : null,
        ].filter(Boolean),
      );
      // ADR-001: a user-modified managed block is never overwritten silently.
      return conflicts.length > 0 ? EXIT.CONFIG : EXIT.OK;
    },
  },

  doctor: {
    describe: 'check node, playwright, browser, axe cache, lighthouse, config, schemas, locales, rules',
    async run(ctx) {
      const checks = [];
      /** Record one probe; `required` marks it as needed for a deterministic audit. */
      const probe = async (name, required, fn) => {
        try {
          const result = await fn();
          checks.push({ name, required, status: result.status || 'ok', detail: result.detail, data: result.data ?? null });
        } catch (error) {
          checks.push({ name, required, status: 'fail', detail: String(error?.message || error).split('\n')[0], data: null });
        }
      };
      const offline = Boolean(ctx.flags.offline);
      // Load the config once up front so the browser probe honours browser.channel /
      // browser.executable_path; a broken config is still reported by its own probe.
      let doctorConfig = null;
      let configError = null;
      let configSource = null;
      try {
        const loaded = await contextConfig(ctx);
        doctorConfig = loaded.config;
        configSource = loaded.source;
      } catch (error) {
        configError = error;
      }

      await probe('node', true, () => {
        const major = Number(process.versions.node.split('.')[0]);
        return { status: major >= 20 ? 'ok' : 'fail', detail: process.version, data: { major } };
      });
      await probe('playwright', true, async () => {
        const resolved = await resolvePlaywright();
        return { status: 'ok', detail: `${resolved.version || 'unknown'} (${resolved.source})`, data: { version: resolved.version, source: resolved.source } };
      });
      let browserOk = false;
      await probe('browser', true, async () => {
        const launched = await resolveLaunch(doctorConfig || { browser: { channel: 'chrome', headless: true } });
        browserOk = true;
        return { status: 'ok', detail: launched.browserDescription, data: { candidate: launched.candidate?.label ?? null } };
      });
      await probe('axe-core', true, async () => {
        const source = await ensureAxeSource({ offline });
        return { status: 'ok', detail: `${source.version} (${source.source})`, data: { path: source.path, version: source.version } };
      });
      await probe('lighthouse', false, async () => {
        const available = await lighthouseAvailable();
        return {
          status: available.available ? 'ok' : 'warn',
          detail: available.available ? `${available.version} via ${available.how}` : 'not available (technical score will be null)',
          data: available,
        };
      });
      await probe('config', true, () => {
        if (configError) throw configError;
        return { status: 'ok', detail: String(configSource), data: { source: configSource } };
      });
      await probe('schemas', true, () => {
        const names = ['config.schema.json', 'blind.schema.json', 'audit.schema.json'];
        for (const name of names) JSON.parse(readFileSync(join(skillRoot(), 'schemas', name), 'utf8'));
        return { status: 'ok', detail: `${names.length} schemas parse`, data: { schemas: names } };
      });
      await probe('locales', false, () => {
        const completeness = localeCompleteness();
        return {
          status: completeness.complete ? 'ok' : 'warn',
          detail: completeness.complete
            ? 'all shipped locales match the en master key set'
            : `incomplete: ${Object.keys(completeness.missing).concat(Object.keys(completeness.extra)).join(', ')}`,
          data: completeness,
        };
      });
      await probe('rules', true, () => {
        const result = checkRules();
        return {
          status: result.errors.length === 0 ? (result.warnings.length > 0 ? 'warn' : 'ok') : 'fail',
          detail: `${result.count} rules, ${result.errors.length} errors, ${result.warnings.length} warnings`,
          data: result,
        };
      });
      await probe('writable', true, () => {
        const dir = ensureDir(join(ctx.cwd, ROOT_DIR_NAME));
        const probeFile = join(dir, '.doctor-probe');
        writeFileSync(probeFile, 'ok', 'utf8');
        unlinkSync(probeFile);
        return { status: 'ok', detail: dir, data: { path: dir } };
      });

      const broken = checks.filter((check) => check.required && check.status === 'fail');
      const width = Math.max(...checks.map((check) => check.name.length));
      const lines = checks.map((check) => `${check.status.toUpperCase().padEnd(4)} ${check.name.padEnd(width)}  ${check.detail}`);
      if (broken.length > 0) {
        lines.push('', `${broken.length} required check(s) failed: ${broken.map((check) => check.name).join(', ')}`);
      }
      ctx.emit(
        {
          command: 'doctor',
          ok: broken.length === 0,
          cwd: ctx.cwd,
          browser_launchable: browserOk,
          checks,
        },
        lines,
      );
      return broken.length === 0 ? EXIT.OK : EXIT.DEPENDENCY;
    },
  },

  capture: {
    describe: 'Stage A+B: render every route x locale x viewport and seal the blind payloads',
    async run(ctx) {
      const loaded = await contextConfig(ctx, cliOverrides(ctx));
      const config = applyViewportFilter(ctx, loaded.config);
      pruneExpired(ctx, config);
      const runId = newRunId();
      ctx.log(`run ${runId} (config: ${loaded.source}, hash ${configHash(config)})`);
      const manifest = await withTargetApp(config, ctx.cwd, (message) => ctx.log(message), () =>
        captureMatrix({ cwd: ctx.cwd, config, runId, log: (message) => ctx.log(message) }),
        () => resolveLaunch(config));
      const ok = manifest.screens.filter((screen) => screen.status === 'ok');
      ctx.emit(
        {
          command: 'capture',
          run_id: runId,
          screens: manifest.screens.map((screen) => ({
            screen_id: screen.screen_id,
            route: screen.route,
            locale: screen.locale,
            viewport: screen.viewport.id,
            status: screen.status,
            blind_payload: join(ROOT_DIR_NAME, 'runs', runId, 'screens', screen.screen_id, 'blind-payload.json'),
          })),
        },
        [
          `run ${runId}: captured ${ok.length}/${manifest.screens.length} screens`,
          `blind payloads: ${ROOT_DIR_NAME}/runs/${runId}/screens/<screen-id>/blind-payload.json`,
        ],
      );
      return EXIT.OK;
    },
  },

  'caveman prepare': {
    describe: 'Stage C: print blind payloads and ready-to-paste evaluator prompts',
    async run(ctx) {
      const runId = resolveRunId(ctx);
      const manifest = await readRunManifest(ctx.cwd, runId);
      const config = manifest.config || {};
      const allowed = config?.privacy?.upload_screenshots === true || Boolean(ctx.flags['allow-screenshot-upload']);
      if (!allowed) {
        fail(
          'blind evaluation needs to hand a screenshot to a fresh-context evaluator, and this run was captured without that consent: pass --allow-screenshot-upload, or set privacy.upload_screenshots: true and capture a new run (the run keeps the config it was captured with)',
          EXIT.PRIVACY,
          { run_id: runId },
        );
      }

      const panel = config?.evaluation?.panel || {};
      const configured = panel.enabled && Array.isArray(panel.evaluators) && panel.evaluators.length > 0
        ? panel.evaluators.map((entry, index) => String(entry?.id ?? `e${index + 1}`))
        : null;
      const requested = ctx.flags.evaluators ? Number(ctx.flags.evaluators) : null;
      if (requested !== null && (!Number.isInteger(requested) || requested < 1)) {
        fail(`--evaluators expects a positive integer, got ${JSON.stringify(ctx.flags.evaluators)}`, EXIT.CONFIG, {});
      }
      const evaluatorIds = requested !== null
        ? Array.from({ length: requested }, (_, index) => `e${index + 1}`)
        : (configured || ['e1']);

      const status = await blindStatus(ctx.cwd, runId);
      const wanted = ctx.flags.screen ? new Set(csv(ctx.flags.screen)) : null;
      const host = process.env.CAVEMAN_RUNTIME_HOST || null;
      const pending = [];
      const humanBlocks = [];

      for (const screen of status.screens) {
        if (screen.status === 'error') continue;
        if (wanted && !wanted.has(screen.screen_id)) continue;
        const missing = evaluatorIds.filter((id) => !screen.evaluators.includes(id));
        if (missing.length === 0 && !ctx.flags.force) continue;
        const record = (manifest.screens || []).find((entry) => entry.screen_id === screen.screen_id);
        if (!record) continue;
        const payload = blindPayload(record, config);
        // Never hand out the in-project path: the repository directory name is itself a
        // semantic hint about the product (ADR-002). Stage an identity-free copy instead.
        const screenshotAbsPath = stageBlindScreenshot({
          cwd: ctx.cwd,
          runId,
          screenId: screen.screen_id,
          screenshotRelPath: record.screenshot.path,
        });
        const prompt = evaluatorPrompt(payload, { screenshotAbsPath });
        if (prompt.includes(ctx.cwd)) {
          fail(
            `the rendered evaluator prompt contains the project path ${ctx.cwd}; refusing to dispatch a blind evaluation that can infer the product from its filesystem path`,
            EXIT.PRIVACY,
            { screen_id: screen.screen_id },
          );
        }
        pending.push({
          screen_id: screen.screen_id,
          evaluators: ctx.flags.force ? evaluatorIds : missing,
          blind_payload: payload,
          screenshot_abs_path: screenshotAbsPath,
          prompt,
          dispatch: dispatchInstructions(host, screen.screen_id, ctx.flags.force ? evaluatorIds : missing, runId),
        });
      }

      for (const item of pending) {
        humanBlocks.push(
          '',
          `--- screen ${item.screen_id} (evaluators: ${item.evaluators.join(', ')}) ---`,
          'blind payload (the ONLY context an evaluator may receive):',
          JSON.stringify(item.blind_payload, null, 2),
          '',
          'evaluator prompt:',
          item.prompt,
          '',
          'dispatch:',
          ...item.dispatch,
        );
      }
      if (pending.length === 0) humanBlocks.push('every screen already has its sealed blind responses; nothing to dispatch');

      ctx.log(`run ${runId}: ${pending.length} screen(s) pending blind evaluation`);
      ctx.emit(
        {
          command: 'caveman prepare',
          run_id: runId,
          runtime_host: host,
          evaluator_ids: evaluatorIds,
          pending,
        },
        humanBlocks,
      );
      return EXIT.OK;
    },
  },

  'caveman ingest': {
    describe: 'Stage C: validate and seal one blind evaluator response',
    async run(ctx) {
      const runId = resolveRunId(ctx);
      const screenId = ctx.flags.screen;
      const evaluatorId = ctx.flags.evaluator;
      if (!screenId) fail('caveman ingest needs --screen <screen-id>', EXIT.EVALUATOR, {});
      if (!evaluatorId) fail('caveman ingest needs --evaluator <evaluator-id>', EXIT.EVALUATOR, {});
      const data = await readJsonInput(ctx.flags.file, 'caveman ingest');
      const result = await ingestBlind({
        cwd: ctx.cwd,
        runId,
        screenId,
        evaluatorId,
        data,
        force: Boolean(ctx.flags.force),
        runtimeHost: process.env.CAVEMAN_RUNTIME_HOST || undefined,
        model: ctx.flags.model,
      });
      ctx.log(`sealed ${evaluatorId} for ${screenId}`);
      ctx.emit(
        { command: 'caveman ingest', ...result },
        [`sealed blind response ${evaluatorId} for ${screenId} -> ${result.path}`],
      );
      return EXIT.OK;
    },
  },

  evidence: {
    describe: 'Stage D: axe-core, deterministic checks, link probes and Lighthouse',
    async run(ctx) {
      const runId = resolveRunId(ctx);
      const manifest = await readRunManifest(ctx.cwd, runId);
      const config = await withLiveCredentials(ctx, manifest.config, 'evidence');
      const result = await withTargetApp(config, ctx.cwd, (message) => ctx.log(message), () =>
        runEvidenceStage(ctx, runId, {
          noLighthouse: Boolean(ctx.flags['no-lighthouse']),
          offline: Boolean(ctx.flags.offline),
        }),
        () => resolveLaunch(config));
      ctx.emit(
        { command: 'evidence', ...result },
        [
          `run ${runId}: evidence collected for ${result.screens.length - result.failed.length}/${result.screens.length} screens`,
          result.failed.length > 0
            ? `${result.failed.length} screen(s) could not be re-opened: ${result.failed.map((entry) => entry.route).join(', ')}`
            : null,
          `axe-core ${result.axe_core}, lighthouse ${result.lighthouse ?? 'unavailable'}`,
        ],
      );
      return EXIT.OK;
    },
  },

  'heuristic ingest': {
    describe: 'Stage E: validate and store the agent-produced heuristic findings',
    async run(ctx) {
      const runId = resolveRunId(ctx);
      const manifest = await readRunManifest(ctx.cwd, runId);
      const data = await readJsonInput(ctx.flags.file, 'heuristic ingest');
      const incoming = Array.isArray(data?.findings) ? data.findings : null;
      const evaluatedScreenIds = Array.isArray(data?.evaluated_screen_ids) ? data.evaluated_screen_ids : null;
      if (!incoming || !evaluatedScreenIds) fail('heuristic ingest expects { "evaluated_screen_ids": [ ... ], "findings": [ ... ] }', EXIT.EVALUATOR, {});
      if (new Set(evaluatedScreenIds).size !== evaluatedScreenIds.length) {
        fail('heuristic ingest evaluated_screen_ids must be unique', EXIT.EVALUATOR, {});
      }
      const manifestScreenIds = new Set((manifest.screens || []).map((screen) => screen.screen_id));
      const unknownCoverage = evaluatedScreenIds.filter((id) => !manifestScreenIds.has(id));
      if (unknownCoverage.length > 0) {
        fail(`heuristic ingest references unknown evaluated_screen_ids: ${unknownCoverage.join(', ')}`, EXIT.EVALUATOR, { unknown_screen_ids: unknownCoverage });
      }

      // The Finding shape comes straight out of audit.schema.json; `id` is relaxed
      // because heuristicFindingId assigns it here when the agent omitted it.
      const auditSchema = JSON.parse(readFileSync(join(skillRoot(), 'schemas', 'audit.schema.json'), 'utf8'));
      const findingDef = auditSchema.$defs.finding;
      const incomingSchema = {
        type: 'object',
        required: ['evaluated_screen_ids', 'findings'],
        properties: {
          evaluated_screen_ids: { type: 'array', uniqueItems: true, items: { type: 'string' } },
          findings: {
            type: 'array',
            items: { ...findingDef, required: (findingDef.required || []).filter((key) => key !== 'id') },
          },
        },
        $defs: auditSchema.$defs,
      };
      const validation = validateSubset(incomingSchema, { evaluated_screen_ids: evaluatedScreenIds, findings: incoming });
      if (!validation.valid) {
        const detail = validation.errors.map((error) => `${error.path || '(root)'}: ${error.message}`).join('\n  - ');
        fail(`heuristic findings failed validation:\n  - ${detail}`, EXIT.EVALUATOR, { errors: validation.errors });
      }

      const evaluatedSet = new Set(evaluatedScreenIds);
      for (const finding of incoming) {
        const target = finding.target || {};
        const normalizedRoute = normalizeRoute(target.normalized_route ?? target.route ?? '/');
        const covered = (manifest.screens || []).some((screen) => {
          const viewportId = typeof screen.viewport === 'string' ? screen.viewport : screen.viewport?.id;
          return evaluatedSet.has(screen.screen_id)
            && (!target.screen_id || target.screen_id === screen.screen_id)
            && screen.normalized_route === normalizedRoute
            && screen.locale === target.locale
            && (target.viewport == null || target.viewport === viewportId);
        });
        if (!covered) {
          fail(`heuristic finding ${finding.rule_id} targets a screen coordinate not covered by evaluated_screen_ids`, EXIT.EVALUATOR, {
            rule_id: finding.rule_id,
            target: { ...target, normalized_route: normalizedRoute },
          });
        }
      }

      // pipeline.md Stage E: a rule id that is in no pack has no severity, no dimension and no
      // provenance, so it cannot be scored. loadRulePacks honours the run's configured packs,
      // which getRule (default packs only) would not.
      const configuredPacks = manifest.config?.rules?.packs;
      const ruleById = loadRulePacks(configuredPacks ? { packs: configuredPacks } : {}).byId;
      const unknown = [...new Set(incoming.map((finding) => String(finding?.rule_id ?? '')))]
        .filter((ruleId) => !ruleById.has(ruleId));
      if (unknown.length > 0) {
        fail(
          `heuristic findings reference rule id(s) that are in no rule pack: ${unknown.join(', ')}`
          + ' — run `node scripts/caveman.mjs rules list` for the ids you may use',
          EXIT.EVALUATOR,
          { unknown_rule_ids: unknown },
        );
      }

      const byScreen = new Map((manifest.screens || []).map((screen) => [screen.screen_id, screen]));
      const findings = incoming.map((finding) => {
        // rule_version is provenance, so it comes from the pack rather than from the agent.
        const ruleVersion = String(ruleById.get(String(finding.rule_id))?.version ?? HEURISTIC_RULE_VERSION);
        const target = {
          ...(finding.target || {}),
          normalized_route: normalizeRoute(finding.target?.normalized_route ?? finding.target?.route ?? '/'),
        };
        if (typeof finding.id === 'string' && /^[0-9a-f]{16}$/.test(finding.id)) {
          return { status: 'open', ...finding, target, rule_version: ruleVersion };
        }
        const screen = target.screen_id ? byScreen.get(target.screen_id) : null;
        const region = (Array.isArray(finding.evidence) ? finding.evidence : [])
          .find((evidence) => evidence?.type === 'screenshot_region')?.box ?? null;
        return {
          status: 'open',
          ...finding,
          target,
          rule_version: ruleVersion,
          id: heuristicFindingId({
            ruleId: finding.rule_id,
            normalizedRoute: target.normalized_route ?? normalizeRoute(target.route ?? '/'),
            locale: target.locale ?? 'auto',
            viewport: target.viewport ?? null,
            region,
            viewportSize: screen ? screen.viewport : null,
          }),
        };
      });

      const path = join(runDir(ctx.cwd, runId), 'heuristic.json');
      if (existsSync(path) && !ctx.flags.force) {
        fail(`${path} already exists; pass --force to replace the ingested heuristic findings`, EXIT.EVALUATOR, { path });
      }
      writeJson(path, { run_id: runId, ingested_at: new Date().toISOString(), evaluated_screen_ids: evaluatedScreenIds, findings });
      ctx.log(`stored ${findings.length} heuristic findings`);
      ctx.emit(
        { command: 'heuristic ingest', run_id: runId, path, count: findings.length, finding_ids: findings.map((finding) => finding.id) },
        [`stored ${findings.length} heuristic findings -> ${path}`],
      );
      return EXIT.OK;
    },
  },

  score: {
    describe: 'Stages F+G+H: assemble audit.json, evaluate the gates, set the exit code',
    async run(ctx) {
      const runId = resolveRunId(ctx);
      const { audit } = await buildAudit(ctx, runId, {
        noLlm: Boolean(ctx.flags['no-llm']),
        allowMissingTechnical: Boolean(ctx.flags['allow-missing-technical']),
      });
      const failing = audit.gates.results.filter((result) => result.status === 'fail');
      ctx.log(`audit.json written (${audit.findings.length} findings, gates ${audit.gates.pass ? 'pass' : 'fail'})`);
      ctx.emit(
        {
          command: 'score',
          run_id: runId,
          audit_path: join(ROOT_DIR_NAME, 'runs', runId, 'audit.json'),
          scores: audit.scores,
          gates: audit.gates,
          limitations: audit.limitations,
          findings: audit.findings.length,
        },
        gateTable(audit),
      );
      if (!ctx.flags.ci) {
        if (failing.length > 0) {
          process.stderr.write(`caveman-ui-ux: ${failing.length} gate(s) failing (${failing.map((result) => result.gate).join(', ')}); pass --ci to make this exit non-zero\n`);
        }
        return EXIT.OK;
      }
      return audit.gates.exit_code;
    },
  },

  report: {
    describe: 'Stage H: re-render report.md and report.html from audit.json',
    async run(ctx) {
      const runId = resolveRunId(ctx);
      const auditPath = join(runDir(ctx.cwd, runId), 'audit.json');
      if (!existsSync(auditPath)) {
        fail(`${auditPath} not found — run \`caveman score\` for run ${runId} first`, EXIT.CONFIG, { path: auditPath });
      }
      const audit = readJson(auditPath);
      const written = await writeRunReports(ctx, runId, audit, {
        locale: ctx.flags.locale || null,
        inlineScreenshots: Boolean(ctx.flags['inline-screenshots']),
      });
      ctx.emit(
        { command: 'report', run_id: runId, ...written },
        [`report.md and report.html written to ${runDir(ctx.cwd, runId)}`],
      );
      return EXIT.OK;
    },
  },

  audit: {
    describe: 'capture + evidence + score + report in one pass (--no-llm for the CI path)',
    async run(ctx) {
      const noLlm = Boolean(ctx.flags['no-llm']);
      const loaded = await contextConfig(ctx, cliOverrides(ctx));
      const config = applyViewportFilter(ctx, loaded.config);
      // `audit` is Stage A too: it must sweep before it fills the disk with another run.
      pruneExpired(ctx, config);
      const runId = newRunId();
      ctx.log(`run ${runId} (config: ${loaded.source}, hash ${configHash(config)})`);

      const manifest = await withTargetApp(config, ctx.cwd, (message) => ctx.log(message), async () => {
        const m = await captureMatrix({ cwd: ctx.cwd, config, runId, log: (message) => ctx.log(message) });
        await runEvidenceStage(ctx, runId, {
          noLighthouse: Boolean(ctx.flags['no-lighthouse']),
          offline: Boolean(ctx.flags.offline),
        });
        return m;
      },
      () => resolveLaunch(config));
      if (!noLlm) {
        ctx.log('blind and heuristic stages are agent-driven: run `caveman prepare` / `caveman ingest` / `heuristic ingest` before score for a full audit');
      }
      const { audit } = await buildAudit(ctx, runId, {
        noLlm,
        allowMissingTechnical: Boolean(ctx.flags['allow-missing-technical']),
      });
      const written = await writeRunReports(ctx, runId, audit, {
        locale: ctx.flags.locale || null,
        inlineScreenshots: Boolean(ctx.flags['inline-screenshots']),
      });

      const failing = audit.gates.results.filter((result) => result.status === 'fail');
      ctx.emit(
        {
          command: 'audit',
          run_id: runId,
          screens: manifest.screens.length,
          audit_path: join(ROOT_DIR_NAME, 'runs', runId, 'audit.json'),
          report: written,
          scores: audit.scores,
          gates: audit.gates,
          limitations: audit.limitations,
          findings: audit.findings.length,
        },
        [...gateTable(audit), '', `report: ${written.markdown}`],
      );
      if (!ctx.flags.ci) {
        if (failing.length > 0) {
          process.stderr.write(`caveman-ui-ux: ${failing.length} gate(s) failing (${failing.map((result) => result.gate).join(', ')}); pass --ci to make this exit non-zero\n`);
        }
        return EXIT.OK;
      }
      return audit.gates.exit_code;
    },
  },

  verify: {
    describe: 'recapture the previous run coordinates and diff the findings into 5 statuses',
    async run(ctx) {
      const previousRunId = resolveRunId(ctx);
      const previousDir = runDir(ctx.cwd, previousRunId);
      const previousAuditPath = join(previousDir, 'audit.json');
      const sealedPath = join(previousDir, 'sealed.json');
      if (!existsSync(previousAuditPath)) {
        fail(`${previousAuditPath} not found — verify needs a scored previous run`, EXIT.CONFIG, { path: previousAuditPath });
      }
      if (!existsSync(sealedPath)) {
        fail(`${sealedPath} not found — verify re-captures the sealed coordinates of the previous run`, EXIT.CONFIG, { path: sealedPath });
      }
      const previousAudit = readJson(previousAuditPath);
      const sealed = readJson(sealedPath);
      const previousManifest = await readRunManifest(ctx.cwd, previousRunId);
      if (!previousManifest.config) fail(`run ${previousRunId} has no config snapshot; cannot reproduce its coordinates`, EXIT.CONFIG, {});
      const config = await withLiveCredentials(ctx, previousManifest.config, 'verify');

      const only = Array.isArray(ctx.flags.finding) ? new Set(ctx.flags.finding) : null;
      // fix-verify.md: with --finding, only the route/locale/viewport those findings target are
      // re-measured; without it the whole sealed matrix is re-captured.
      const onlyTargets = only ? findingTargets(previousAudit, only, previousAuditPath) : null;
      const totalTargets = Object.keys(sealed).length;

      const runId = newRunId();
      ctx.log(
        `verify: re-capturing ${onlyTargets ? `the coordinates of ${only.size} finding(s)` : `${totalTargets} sealed coordinates`}`
        + ` from ${previousRunId} as ${runId}`,
      );
      const manifest = await withTargetApp(config, ctx.cwd, (message) => ctx.log(message), async () => {
        const m = await captureMatrix({
          cwd: ctx.cwd, config, runId, log: (message) => ctx.log(message), onlyTargets: onlyTargets ?? undefined,
        });
        const recaptured = m.screens.length;
        ctx.log(`verify: re-captured ${recaptured} of ${totalTargets} sealed coordinates`);
        await runEvidenceStage(ctx, runId, {
          noLighthouse: Boolean(ctx.flags['no-lighthouse']),
          offline: Boolean(ctx.flags.offline),
        });
        return m;
      },
      () => resolveLaunch(config));
      const recaptured = manifest.screens.length;
      const { audit } = await buildAudit(ctx, runId, { noLlm: true, allowMissingTechnical: true });

      const diff = diffFindings({
        previous: previousAudit.findings || [],
        current: audit.findings || [],
        currentScreens: audit.run.screens || [],
        currentAudit: audit,
        only,
      });

      // Statuses live on the current findings so the reporter renders them directly.
      const statusById = new Map(diff.entries.filter((entry) => entry.current_id).map((entry) => [entry.current_id, entry.status]));
      const statusByKey = new Map(diff.entries.filter((entry) => entry.current_id).map((entry) => [entry.key, entry.status]));
      for (const finding of audit.findings) {
        finding.status = statusById.get(finding.id) || statusByKey.get(findingKey(finding)) || 'open';
      }
      audit.verify = {
        previous_run: previousRunId,
        summary: diff.summary,
        findings: diff.entries,
      };
      writeJson(join(runDir(ctx.cwd, runId), 'audit.json'), audit);

      const verifyDoc = {
        schema_version: AUDIT_SCHEMA_VERSION,
        tool: { name: 'caveman-ui-ux', version: SKILL_VERSION },
        previous_run: previousRunId,
        run_id: runId,
        compared: diff.entries.length,
        summary: diff.summary,
        findings: diff.entries,
      };
      writeJson(join(runDir(ctx.cwd, runId), 'verify.json'), verifyDoc);

      // Advance matching verification_required receipts for the previous run.
      const handoffResults = { verified: [], skipped: [], errors: [] };
      const handoffsDir = join(previousDir, 'handoffs');
      if (existsSync(handoffsDir)) {
        for (const entry of diff.entries) {
          if (!entry.id) continue; // Only process findings that existed in the previous run.
          const key = `${previousRunId}:${entry.id}`;
          try {
            const receipt = verifyHandoff({ cwd: ctx.cwd, runId: previousRunId, verifyRunId: runId, key });
            handoffResults.verified.push({ key, verify_status: receipt.verify_status });
            ctx.log(`handoff verify: ${key} → ${receipt.state} (${receipt.verify_status})`);
          } catch (err) {
            if (err.code === 'RECEIPT_NOT_FOUND' || err.code === 'VERIFY_INVALID_STATE') {
              // No receipt or not in verification_required — skip silently.
              handoffResults.skipped.push({ key, reason: err.code });
            } else if (err.code === 'VERIFY_STATUS_REJECTED' || err.code === 'VERIFY_REGRESSION'
              || err.code === 'VERIFY_FINDING_NOT_FOUND' || err.code === 'VERIFY_STATUS_INVALID') {
              // Expected rejection — not an internal error.
              handoffResults.skipped.push({ key, reason: err.code });
            } else {
              // Internal error — must make the command nonzero.
              handoffResults.errors.push({ key, error: err.message, code: err.code });
              ctx.log(`handoff verify error: ${key} — ${err.message}`);
            }
          }
        }
      }

      const written = await writeRunReports(ctx, runId, audit, {
        locale: ctx.flags.locale || null,
        inlineScreenshots: Boolean(ctx.flags['inline-screenshots']),
      });
      appendVerifySection(written.markdown, verifyDoc);

      ctx.emit(
        {
          command: 'verify',
          run_id: runId,
          previous_run: previousRunId,
          verify_path: join(ROOT_DIR_NAME, 'runs', runId, 'verify.json'),
          report: written,
          summary: diff.summary,
          recaptured,
          targets: totalTargets,
          gates: audit.gates,
          handoff: handoffResults,
        },
        [
          `verify ${previousRunId} -> ${runId} (re-captured ${recaptured} of ${totalTargets} coordinates)`,
          Object.entries(diff.summary).map(([status, count]) => `${status}=${count}`).join(' '),
          `report: ${written.markdown}`,
          handoffResults.verified.length > 0
            ? `handoff: ${handoffResults.verified.length} verified, ${handoffResults.skipped.length} skipped, ${handoffResults.errors.length} errors`
            : null,
        ].filter(Boolean),
      );
      // Internal receipt errors make the command nonzero.
      if (handoffResults.errors.length > 0) return EXIT.CONFIG;
      if (!ctx.flags.ci) return EXIT.OK;
      return audit.gates.exit_code;
    },
  },

  rules: {
    describe: 'list or validate the rule packs (`rules list`, `rules check`)',
    async run(ctx) {
      const action = ctx.positional[0] || 'list';
      if (action !== 'list' && action !== 'check') {
        fail(`unknown rules action ${JSON.stringify(action)} (expected list or check)`, EXIT.CONFIG, { action });
      }
      const loaded = await contextConfig(ctx).catch(() => ({ config: null }));
      const packs = loaded.config?.rules?.packs;
      if (action === 'list') {
        const pack = loadRulePacks(packs ? { packs } : {});
        const rows = pack.rules.map((rule) => ({
          id: rule.id,
          kind: rule.kind ?? null,
          severity_default: rule.severity_default ?? null,
          category: rule.category ?? null,
          title: rule.title ?? null,
        }));
        const width = rows.length > 0 ? Math.max(...rows.map((row) => String(row.id).length)) : 0;
        ctx.emit(
          { command: 'rules list', packs: pack.packs.map((entry) => entry.id), count: rows.length, rules: rows },
          rows.map((row) => `${String(row.id).padEnd(width)}  ${row.kind ?? '?'}  ${row.severity_default ?? '?'}  ${row.title ?? ''}`),
        );
        return EXIT.OK;
      }
      const result = checkRules(packs ? { packs } : {});
      const lines = [
        `${result.count} rules checked: ${result.errors.length} errors, ${result.warnings.length} warnings`,
        ...result.errors.map((message) => `ERROR ${message}`),
        ...result.warnings.map((message) => `WARN  ${message}`),
      ];
      ctx.emit({ command: 'rules check', ...result }, lines);
      return result.errors.length === 0 ? EXIT.OK : EXIT.CONFIG;
    },
  },

  prune: {
    describe: 'delete runs and staged blind screenshots older than privacy.retention_days',
    async run(ctx) {
      const loaded = await contextConfig(ctx);
      const override = ctx.flags['retention-days'];
      const retentionDays = override === undefined
        ? Number(loaded.config?.privacy?.retention_days ?? 0)
        : Number(override);
      if (!Number.isInteger(retentionDays) || retentionDays < 0) {
        fail(
          `--retention-days expects a non-negative integer, got ${JSON.stringify(override)}`,
          EXIT.CONFIG,
          { retention_days: override ?? null },
        );
      }
      // 0 means the sweep is off, never "delete every run".
      const result = retentionDays > 0
        ? pruneRuns({ cwd: ctx.cwd, retentionDays, now: new Date(), log: (message) => ctx.log(message) })
        : { removedRuns: [], removedStaged: [], freedBytes: 0 };
      ctx.emit(
        { command: 'prune', cwd: ctx.cwd, retention_days: retentionDays, ...result },
        [
          retentionDays > 0
            ? `retention ${retentionDays}d: removed ${result.removedRuns.length} run(s) and `
              + `${result.removedStaged.length} staged screenshot dir(s), freed ${result.freedBytes} bytes`
            : 'privacy.retention_days is 0: retention is disabled and nothing was pruned',
          ...result.removedRuns.map((id) => `  removed run ${id}`),
          ...result.removedStaged.map((id) => `  removed staged blind screenshots for ${id}`),
        ],
      );
      return EXIT.OK;
    },
  },


  'handoff prepare': {
    describe: 'prepare handoff items from the canonical audit.json',
    async run(ctx) {
      const runId = resolveRunId(ctx);
      const handoff = prepareHandoff({ cwd: ctx.cwd, runId, repo: ctx.flags.repo || null, env: process.env });
      const pending = handoff.items.length;
      if (pending > 0) {
        const artifactPath = persistHandoffArtifact(ctx.cwd, runId, handoff);
        ctx.log(`handoff artifact written: ${artifactPath}`);
      }
      ctx.emit(
        {
          command: 'handoff prepare',
          run_id: runId,
          suppressed_recursive: handoff.suppressed_recursive,
          suppressed_reason: handoff.suppressed_reason || null,
          items: handoff.items,
          item_count: handoff.items.length,
          diagnostics: handoff.diagnostics,
        },
        [
          handoff.suppressed_recursive
            ? `handoff suppressed (${handoff.suppressed_reason})`
            : `${pending} handoff item(s) prepared`,
          handoff.diagnostics.length > 0
            ? `${handoff.diagnostics.length} diagnostic(s): ${handoff.diagnostics.map((d) => d.type).join(', ')}`
            : null,
        ].filter(Boolean),
      );
      return EXIT.OK;
    },
  },

  'handoff record': {
    describe: 'record a flow id or diagnostic against a handoff key',
    async run(ctx) {
      const runId = resolveRunId(ctx);
      const key = ctx.flags.key || ctx.positional[0];
      const flowId = ctx.flags['flow-id'] || null;
      const diagnosticFile = ctx.flags['diagnostic-file'] || null;

      if (!key) {
        fail(
          'handoff record requires --key <run_id>:<finding_id>',
          EXIT.CONFIG,
          {},
        );
      }

      if (!flowId && !diagnosticFile) {
        fail(
          'handoff record requires --flow-id <id> or --diagnostic-file <path>',
          EXIT.CONFIG,
          {},
        );
      }
      if (flowId && diagnosticFile) {
        fail(
          'handoff record requires exactly one of --flow-id or --diagnostic-file, not both',
          EXIT.CONFIG,
          {},
        );
      }

      let diagnostic = null;
      if (diagnosticFile) {
        if (!existsSync(diagnosticFile)) {
          fail(
            `diagnostic file not found: ${diagnosticFile}`,
            EXIT.CONFIG,
            { path: diagnosticFile },
          );
        }
        try {
          diagnostic = readJson(diagnosticFile);
        } catch {
          fail(
            `diagnostic file is not valid JSON: ${diagnosticFile}`,
            EXIT.CONFIG,
            { path: diagnosticFile },
          );
        }
        const validation = validateDiagnostic(diagnostic);
        if (!validation.valid) {
          fail(
            `invalid diagnostic: ${validation.error}`,
            EXIT.CONFIG,
            { diagnostic },
          );
        }
      }

      const receipt = recordHandoff({
        cwd: ctx.cwd, runId, key, flowId, diagnostic,
        claimToken: ctx.flags['claim-token'] || null,
        autoflowStateDir: process.env.CAVEMAN_AUTOFLOW_STATE_DIR || undefined,
      });
      ctx.log(`handoff recorded: ${key} → ${receipt.state}`);
      ctx.emit(
        {
          command: 'handoff record',
          run_id: runId,
          key,
          state: receipt.state,
          flow_id: receipt.flow_id || null,
          diagnostic: receipt.diagnostic || null,
        },
        [`handoff ${key} recorded as ${receipt.state}${receipt.flow_id ? ` (flow: ${receipt.flow_id})` : ''}`],
      );
      if (diagnostic && receipt.state === 'failed') {
        return EXIT.CONFIG;
      }
      return EXIT.OK;
    },
  },

  'handoff advance': {
    describe: 'advance a handoff receipt to implemented or verification_required',
    async run(ctx) {
      const runId = resolveRunId(ctx);
      const key = ctx.flags.key || ctx.positional[0];
      const state = ctx.flags.state || null;

      if (!key) {
        fail('handoff advance requires --key <run_id>:<finding_id>', EXIT.CONFIG, {});
      }

      const VALID_STATES = ['implemented', 'verification_required'];
      if (!state || !VALID_STATES.includes(state)) {
        fail(
          `handoff advance requires --state ${VALID_STATES.join('|')}`,
          EXIT.CONFIG,
          { state },
        );
      }

      let receipt;
      if (state === 'implemented') {
        receipt = transitionToImplemented({ cwd: ctx.cwd, runId, key });
      } else {
        receipt = transitionToVerificationRequired({ cwd: ctx.cwd, runId, key });
      }

      ctx.log(`handoff advance: ${key} → ${receipt.state}`);
      ctx.emit(
        {
          command: 'handoff advance',
          run_id: runId,
          key,
          state: receipt.state,
        },
        [`handoff ${key} advanced to ${receipt.state}`],
      );
      return EXIT.OK;
    },
  },

  'handoff claim': {
    describe: 'atomically claim pending items and write a token-bound dispatch artifact',
    async run(ctx) {
      const runId = resolveRunId(ctx);
      const result = claimHandoff(ctx.cwd, runId);
      ctx.log(`handoff claim: ${result.claims.length} item(s) claimed, written to ${result.dispatch_artifact_path}`);
      ctx.emit(
        {
          command: 'handoff claim',
          run_id: runId,
          dispatch_artifact_path: result.dispatch_artifact_path,
          claims: result.claims,
          unclaimed: result.unclaimed,
        },
        [
          `dispatch artifact: ${result.dispatch_artifact_path}`,
          ...result.claims.map((c) => `  ${c.key} → token ${c.claim_token}`),
          ...result.unclaimed.map((k) => `  ${k} — already claimed`),
        ],
      );
      return EXIT.OK;
    },
  },

  'handoff retry': {
    describe: 'retry a failed handoff key (failed → pending) with attempt cap',
    async run(ctx) {
      const runId = resolveRunId(ctx);
      const key = ctx.flags.key || ctx.positional[0];

      if (!key) {
        fail('handoff retry requires --key <run_id>:<finding_id>', EXIT.CONFIG, {});
      }

      const receipt = retryHandoff(ctx.cwd, runId, key);
      ctx.log(`handoff retry: ${key} → ${receipt.state}`);
      ctx.emit(
        {
          command: 'handoff retry',
          run_id: runId,
          key,
          state: receipt.state,
          attempts: receipt.attempts?.length || 0,
        },
        [`handoff ${key} retried to ${receipt.state} (attempt ${receipt.attempts?.length || 0}/3)`],
      );
      return EXIT.OK;
    },
  },

  'handoff verify': {
    describe: 'verify a handoff key against a re-evaluated verify run',
    async run(ctx) {
      const runId = resolveRunId(ctx);
      const key = ctx.flags.key || ctx.positional[0];
      const verifyRunId = ctx.flags['verify-run'] || null;

      if (!key) {
        fail('handoff verify requires --key <run_id>:<finding_id>', EXIT.CONFIG, {});
      }
      if (!verifyRunId) {
        fail('handoff verify requires --verify-run <run-id>', EXIT.CONFIG, {});
      }

      // Load source and current audits, recompute the finding diff.
      const sourceDir = runDir(ctx.cwd, runId);
      const verifyDir = runDir(ctx.cwd, verifyRunId);
      const sourceAuditPath = join(sourceDir, 'audit.json');
      const currentAuditPath = join(verifyDir, 'audit.json');

      if (!existsSync(sourceAuditPath)) {
        fail(`source audit not found at ${sourceAuditPath}`, EXIT.CONFIG, { path: sourceAuditPath });
      }
      if (!existsSync(currentAuditPath)) {
        fail(`current audit not found at ${currentAuditPath}`, EXIT.CONFIG, { path: currentAuditPath });
      }

      const sourceAudit = readJson(sourceAuditPath);
      const currentAudit = readJson(currentAuditPath);
      validateAudit(currentAudit, verifyRunId);

      validateLifecycleSourceBinding({ cwd: ctx.cwd, runId, key });

      // Extract the finding ID from the key.
      const findingId = key.split(':').pop();
      const diff = diffFindings({
        previous: sourceAudit.findings || [],
        current: currentAudit.findings || [],
        currentScreens: currentAudit.run?.screens || [],
        currentAudit: currentAudit,
        only: new Set([findingId]),
      });

      // Merge into the canonical verify.json for this exact source/current pair.
      // Per-key handoff verification must not erase results recorded for sibling findings.
      const verifyPath = join(verifyDir, 'verify.json');
      const priorVerify = existsSync(verifyPath) ? readJson(verifyPath) : null;
      const priorEntries = priorVerify?.previous_run === runId && priorVerify?.run_id === verifyRunId
        && Array.isArray(priorVerify.findings) ? priorVerify.findings : [];
      const mergedById = new Map(priorEntries.map((entry) => [entry.id, entry]));
      for (const entry of diff.entries) mergedById.set(entry.id, entry);
      const mergedEntries = [...mergedById.values()];
      const mergedSummary = { resolved: 0, improved: 0, unchanged: 0, regressed: 0, not_comparable: 0, open: 0 };
      for (const entry of mergedEntries) mergedSummary[entry.status] = (mergedSummary[entry.status] ?? 0) + 1;
      const verifyDoc = {
        schema_version: AUDIT_SCHEMA_VERSION,
        tool: { name: 'caveman-ui-ux', version: SKILL_VERSION },
        previous_run: runId,
        run_id: verifyRunId,
        compared: mergedEntries.length,
        summary: mergedSummary,
        findings: mergedEntries,
      };
      writeJson(verifyPath, verifyDoc);

      // Now call verifyHandoff with the recomputed verify.json.
      const receipt = verifyHandoff({ cwd: ctx.cwd, runId, verifyRunId, key });
      ctx.log(`handoff verify: ${key} → ${receipt.state}`);
      ctx.emit(
        {
          command: 'handoff verify',
          run_id: runId,
          verify_run_id: verifyRunId,
          key,
          state: receipt.state,
          verify_status: receipt.verify_status,
          diff: diff.entries[0]?.status || null,
        },
        [`handoff ${key} verified as ${receipt.verify_status} (${receipt.state})`],
      );
      return EXIT.OK;
    },
  },

};

// ---------------------------------------------------------------------------
// Helpers used by the commands above
// ---------------------------------------------------------------------------

/** Read JSON from --file, or from stdin when the flag is absent or '-'. */
async function readJsonInput(file, label) {
  let text;
  if (file && file !== '-') {
    const path = resolvePath(file);
    if (!existsSync(path)) fail(`${label}: file not found: ${file}`, EXIT.EVALUATOR, { path });
    text = readFileSync(path, 'utf8');
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '') fail(`${label}: no JSON on stdin and no --file given`, EXIT.EVALUATOR, {});
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return fail(`${label}: input is not valid JSON (${error.message})`, EXIT.EVALUATOR, {});
  }
}

/** Per-runtime dispatch instruction for a fresh-context blind evaluator. */
function dispatchInstructions(host, screenId, evaluatorIds, runId) {
  const claude = [
    'Claude Code: dispatch one Agent tool call per evaluator, subagent_type "general-purpose",',
    '  fresh context, and paste ONLY the evaluator prompt above (no route, no URL, no repo context).',
  ];
  const codex = [
    'Codex: spawn_agent agent_type="default" fork_turns="none" per evaluator, and pass ONLY the',
    '  evaluator prompt above (fork_turns="none" is what makes the isolation real).',
  ];
  const ingest = evaluatorIds.map((id) => `  then: node scripts/caveman.mjs caveman ingest --run ${runId} --screen ${screenId} --evaluator ${id} --file <response.json>`);
  if (host === 'claude') return [...claude, ...ingest];
  if (host === 'codex') return [...codex, ...ingest];
  return [...claude, ...codex, ...ingest];
}

/** Route/locale/viewport filters of the findings named by --finding, for verify. */
function findingTargets(previousAudit, only, auditPath) {
  const wanted = (previousAudit.findings || []).filter((finding) => only.has(finding.id));
  const missing = [...only].filter((id) => !wanted.some((finding) => finding.id === id));
  if (missing.length > 0) {
    fail(
      `--finding ${missing.join(', ')} is not in ${auditPath}; verify can only re-measure a finding of the previous run`,
      EXIT.CONFIG,
      { missing },
    );
  }
  const byCoordinate = new Map();
  for (const finding of wanted) {
    const target = finding.target || {};
    const key = [target.route, target.locale, target.viewport].join('|');
    // undefined means "every value of this axis" in captureMatrix's onlyTargets filter, which
    // is what a cross-viewport (viewport: null) finding needs.
    if (!byCoordinate.has(key)) {
      byCoordinate.set(key, {
        route: target.route ?? undefined,
        locale: target.locale ?? undefined,
        viewport: target.viewport ?? undefined,
      });
    }
  }
  return [...byCoordinate.values()];
}

/** Diff two finding sets into the 5 verify statuses (contract §18). */
function diffFindings({ previous, current, currentScreens, currentAudit, only }) {
  const requestedKeys = only
    ? new Set(previous.filter((finding) => only.has(finding.id)).map(findingKey))
    : null;
  const eligiblePrevious = only
    ? previous.filter((finding) => only.has(finding.id) || requestedKeys.has(findingKey(finding)))
    : previous;
  const assignments = new Map();
  const usedCurrent = new Set();
  const currentById = new Map(current.map((finding) => [finding.id, finding]));
  // Allocate exact IDs first so semantic fallback can never steal them.
  for (const finding of eligiblePrevious) {
    const exact = currentById.get(finding.id);
    if (exact && !usedCurrent.has(exact)) {
      assignments.set(finding, exact);
      usedCurrent.add(exact);
    }
  }
  const regionCenter = (finding) => {
    const box = (finding.evidence || []).find((entry) => entry?.type === 'screenshot_region')?.box;
    if (!box) return null;
    const width = Number(box.w ?? box.width);
    const height = Number(box.h ?? box.height);
    if (![Number(box.x), Number(box.y), width, height].every(Number.isFinite)) return null;
    return { x: Number(box.x) + width / 2, y: Number(box.y) + height / 2 };
  };
  for (const finding of eligiblePrevious) {
    if (assignments.has(finding)) continue;
    if (finding.kind !== 'blind' && finding.kind !== 'heuristic') continue;
    const candidates = current.filter((candidate) => !usedCurrent.has(candidate) && findingKey(candidate) === findingKey(finding));
    if (candidates.length === 0) continue;
    const origin = regionCenter(finding);
    const ranked = candidates.map((candidate, index) => {
      const center = regionCenter(candidate);
      const distance = origin && center ? Math.hypot(origin.x - center.x, origin.y - center.y) : Number.POSITIVE_INFINITY;
      return { candidate, distance, index };
    }).sort((a, b) => a.distance - b.distance || a.index - b.index);
    assignments.set(finding, ranked[0].candidate);
    usedCurrent.add(ranked[0].candidate);
  }
  const screenByCoord = new Map();
  for (const screen of currentScreens) {
    screenByCoord.set([screen.normalized_route, screen.locale, screen.viewport?.id].join('|'), screen);
  }

  /** Check if the current audit has fresh blind consensus for the matching coordinates. */
  const hasFreshBlind = (finding) => {
    const target = finding.target || {};
    const coord = [target.normalized_route, target.locale, target.viewport].join('|');
    const screen = screenByCoord.get(coord);
    if (!screen || screen.status !== 'ok') return false;
    // Check currentAudit.per_screen for non-null blind consensus.
    const perScreen = Array.isArray(currentAudit?.per_screen) ? currentAudit.per_screen : [];
    const entry = perScreen.find((e) => e.screen_id === screen.screen_id);
    return entry && typeof entry.scores?.caveman === 'number' && entry.scores.caveman !== null;
  };

  /** Check if the current audit has heuristic evaluation evidence. */
  const hasFreshHeuristic = (finding, semanticMatch) => {
    const target = finding.target || {};
    const route = normalizeRoute(target.normalized_route ?? target.route ?? '/');
    const screens = currentScreens.filter((entry) => {
      const sameViewport = target.viewport == null || entry.viewport?.id === target.viewport;
      return entry.status === 'ok'
        && normalizeRoute(entry.normalized_route ?? entry.route ?? '/') === route
        && entry.locale === target.locale
        && sameViewport;
    });
    if (screens.length === 0) return false;
    const perScreen = Array.isArray(currentAudit?.per_screen) ? currentAudit.per_screen : [];
    return screens.every((screen) => {
      const evidence = perScreen.find((entry) => entry.screen_id === screen.screen_id);
      return typeof evidence?.scores?.heuristic_ux === 'number';
    });
  };

  /** True when the previous finding cannot be compared to the current audit. */
  const notComparable = (finding, semanticMatch) => {
    if (finding.kind === 'blind') return !hasFreshBlind(finding);
    if (finding.kind === 'heuristic') return !hasFreshHeuristic(finding, semanticMatch);
    const target = finding.target || {};
    const screen = screenByCoord.get([target.normalized_route, target.locale, target.viewport].join('|'));
    if (!screen) return true;
    return screen.status !== 'ok';
  };

  const entries = [];
  const seenCurrent = new Set();
  for (const finding of eligiblePrevious) {
    const key = findingKey(finding);
    const match = assignments.get(finding) || null;
    if (only && !only.has(finding.id)) continue;
    if (match) seenCurrent.add(match.id);
    let status;
    if (notComparable(finding, match)) status = 'not_comparable';
    else if (!match) status = 'resolved';
    else if (severityRank(match.severity) > severityRank(finding.severity)) status = 'improved';
    else if (severityRank(match.severity) < severityRank(finding.severity)) status = 'regressed';
    else status = 'unchanged';
    entries.push({
      id: finding.id,
      current_id: match ? match.id : null,
      key,
      rule_id: finding.rule_id,
      kind: finding.kind,
      target: finding.target,
      previous_severity: finding.severity,
      current_severity: match ? match.severity : null,
      status,
    });
  }
  if (!only) {
    for (const finding of current) {
      if (seenCurrent.has(finding.id)) continue;
      const key = findingKey(finding);
      const sibling = previous.find((entry) => findingKey(entry) === key);
      entries.push({
        id: null,
        current_id: finding.id,
        key,
        rule_id: finding.rule_id,
        kind: finding.kind,
        target: finding.target,
        previous_severity: sibling ? sibling.severity : null,
        current_severity: finding.severity,
        status: sibling ? 'regressed' : 'open',
      });
    }
  }
  const summary = { resolved: 0, improved: 0, unchanged: 0, regressed: 0, not_comparable: 0, open: 0 };
  for (const entry of entries) summary[entry.status] = (summary[entry.status] ?? 0) + 1;
  return { entries, summary };
}

/** Append the verify diff section to a rendered report.md. */
function appendVerifySection(markdownPath, verifyDoc) {
  if (!markdownPath || !existsSync(markdownPath)) return;
  const lines = [
    '',
    '## Verify diff',
    '',
    `previous run: \`${verifyDoc.previous_run}\` → this run: \`${verifyDoc.run_id}\``,
    '',
    Object.entries(verifyDoc.summary).map(([status, count]) => `- ${status}: ${count}`).join('\n'),
    '',
    '| rule | route | locale | viewport | before | after | status |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...verifyDoc.findings.map((entry) => {
      const target = entry.target || {};
      return `| ${entry.rule_id} | ${target.normalized_route ?? ''} | ${target.locale ?? ''} | ${target.viewport ?? ''} `
        + `| ${entry.previous_severity ?? '—'} | ${entry.current_severity ?? '—'} | ${entry.status} |`;
    }),
    '',
  ];
  appendFileSync(markdownPath, `${lines.join('\n')}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Print an error in the active output mode and map it to an exit code. */
function reportError(error, jsonMode) {
  const isCaveman = error instanceof CavemanError || (error && typeof error.exitCode === 'number');
  const exitCode = isCaveman ? error.exitCode : EXIT.CONFIG;
  const message = String(error?.message || error);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: message,
      exit_code: exitCode,
      details: isCaveman ? (error.details ?? {}) : {},
    })}\n`);
  }
  process.stderr.write(`caveman-ui-ux: ${message}\n`);
  if (process.env.CAVEMAN_DEBUG && error?.stack) process.stderr.write(`${error.stack}\n`);
  return exitCode;
}

/** Read one boolean flag straight off argv, before the strict parse can throw. */
function rawBooleanFlag(argv, name) {
  let value = false;
  for (const token of argv) {
    if (token === `--${name}`) value = true;
    else if (token.startsWith(`--${name}=`)) value = token.slice(name.length + 3) !== 'false';
  }
  return value;
}

/** Parse argv, dispatch one command and return its process exit code. */
async function main(argv) {
  // Contract §18: a command in --json mode prints exactly one JSON object — including when the
  // failure is the argument parse itself, which throws before `parsed` exists.
  const quiet = rawBooleanFlag(argv, 'quiet');
  let jsonMode = rawBooleanFlag(argv, 'json');
  try {
    const parsed = parseArgs(argv);
    jsonMode = Boolean(parsed.flags.json);
    if (parsed.flags.version) {
      process.stdout.write(`${SKILL_VERSION}\n`);
      return EXIT.OK;
    }
    if (parsed.flags.help) {
      process.stderr.write(usage());
      return EXIT.OK;
    }
    if (!parsed.command) {
      if (!quiet) process.stderr.write(usage());
      fail('no command given; run `caveman --help` for the command list', EXIT.CONFIG, {});
    }
    const spec = COMMANDS[parsed.command];
    if (!spec) {
      fail(`unknown command ${JSON.stringify(parsed.command)}; known: ${Object.keys(COMMANDS).join(', ')}`, EXIT.CONFIG, { command: parsed.command });
    }
    const ctx = makeContext(parsed);
    return (await spec.run(ctx)) ?? EXIT.OK;
  } catch (error) {
    return reportError(error, jsonMode);
  }
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
// Safety net: a stray browser or child-process handle must not turn a finished
// command into a hang; stdout/stderr are already flushed synchronously on POSIX.
setTimeout(() => process.exit(exitCode), 250).unref();
