// Agent adapter installer. Contract §20 / ADR-001.
// One canonical bundle, many thin adapters: only codex/claude/opencode receive a copy (or a
// same-volume symlink) of the skill; cursor/copilot/gemini/generic get a short generated
// pointer that names the canonical SKILL.md path and the CLI commands, never the rubric, the
// dimension weights or the rule pack.
// Nothing is ever overwritten blindly: our own generated files and managed blocks are guarded
// by the sha256 we recorded in install-manifest.json, and a hand-edited one yields `conflict`
// with no write at all.

import {
  existsSync, lstatSync, readdirSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EXIT, fail } from './errors.mjs';
import {
  copyFileHashed, ensureDir, exists, readJson, readText, rmrf, sha256, sha256File, writeJson, writeText,
} from './fsx.mjs';
import { ROOT_DIR_NAME, installManifestPath, skillRoot } from './paths.mjs';

const MANIFEST_VERSION = '1.0.0';
const START_MARKER = '<!-- caveman-ui-ux:start -->';
const END_MARKER = '<!-- caveman-ui-ux:end -->';

// The canonical bundle: exactly these top-level entries, never run artifacts or dependencies.
const BUNDLE_ENTRIES = ['SKILL.md', 'agents', 'assets', 'locales', 'references', 'rules', 'schemas', 'scripts'];
const EXCLUDED_DIRS = new Set([ROOT_DIR_NAME, 'node_modules', '.git']);
const EXCLUDED_FILES = new Set(['.DS_Store']);

const FRONTEND_GLOB = '**/*.{tsx,jsx,ts,js,mjs,vue,svelte,astro,html,htm,css,scss,sass}';

// Where a thin adapter should say the bundle lives. A project-local copy wins over the
// absolute source path: .cursor/rules/*.mdc, AGENTS.md and the Copilot instructions are files
// the user commits, so an absolute path from the installing machine breaks for every teammate
// and every CI runner. Order matches the copy targets in ADAPTERS.
const LOCAL_BUNDLE_DIRS = [
  '.claude/skills/caveman-ui-ux',
  '.agents/skills/caveman-ui-ux',
  '.opencode/skills/caveman-ui-ux',
];

/** How a generated adapter should name the canonical SKILL.md. */
function skillRef(ref) {
  return ref?.portable ? ref.skill : displayPath(canonicalSkillPath());
}

/** Project-relative bundle dir when one is installed in this project, else null. */
function localBundleDir(cwd) {
  if (!cwd) return null;
  for (const rel of LOCAL_BUNDLE_DIRS) {
    if (existsSync(join(cwd, rel, 'SKILL.md'))) return rel;
  }
  return null;
}

/** Where generated adapters point: {skill, cli, portable}. */
function bundleReference(cwd) {
  const local = localBundleDir(cwd);
  if (local) return { skill: `${local}/SKILL.md`, cli: `${local}/scripts/caveman.mjs`, portable: true };
  return { skill: canonicalSkillPath(), cli: cliPath(), portable: false };
}

/** Absolute path of the canonical SKILL.md, for generated adapters to point at. */
function canonicalSkillPath() {
  return join(skillRoot(), 'SKILL.md');
}

/** Absolute path of the CLI entry point. */
function cliPath() {
  return join(skillRoot(), 'scripts', 'caveman.mjs');
}

/** Prose form of a path: ~/... when it lives under the user's home. */
function displayPath(abs) {
  const home = homedir();
  return abs.startsWith(home + sep) ? `~${abs.slice(home.length)}` : abs;
}

/** Shell form of a path: always quoted (the skill path may contain spaces), $HOME-relative. */
function shellPath(abs) {
  const home = homedir();
  return abs.startsWith(home + sep) ? `"$HOME${abs.slice(home.length)}"` : `"${abs}"`;
}

/** The command lines every thin adapter lists (no rubric, no weights, no rules). */
function cliLines(ref) {
  const cli = ref?.portable ? `node ${ref.cli}` : `node ${shellPath(cliPath())}`;
  return [
    `${cli} doctor`,
    `${cli} audit <url> --no-llm --ci        # deterministic CI path`,
    `${cli} capture <url>                    # Stage A+B`,
    `${cli} caveman prepare --evaluators 1   # blind payload + evaluator prompt`,
    `${cli} caveman ingest --screen <sid> --evaluator <id> --file <path>`,
    `${cli} evidence                         # axe + DOM checks + lighthouse`,
    `${cli} heuristic ingest --file <path>`,
    `${cli} score --ci`,
    `${cli} report --locale <en|zh-TW|ja|vi>`,
    `${cli} verify`,
  ];
}

/** Build a detect(cwd) function from marker files, home markers and binary names. */
function detector({ rels = [], homeRels = [], bins = [] }) {
  return (cwd) => {
    const base = resolve(cwd || process.cwd());
    const found = [];
    for (const rel of rels) if (existsSync(join(base, rel))) found.push(rel);
    for (const rel of homeRels) if (existsSync(join(homedir(), rel))) found.push(`~/${rel}`);
    for (const bin of bins) if (hasBinary(bin)) found.push(`command -v ${bin}`);
    return found;
  };
}

/** True when a binary is on PATH (no shell, no child process). */
function hasBinary(name) {
  const parts = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const part of parts) {
    if (!part) continue;
    for (const ext of exts) {
      try {
        if (statSync(join(part, name + ext)).isFile()) return true;
      } catch {
        // not there; keep looking
      }
    }
  }
  return false;
}

export const ADAPTERS = Object.freeze([
  Object.freeze({
    id: 'codex',
    label: 'Codex',
    projectTarget: '.agents/skills/caveman-ui-ux',
    globalTarget: '~/.codex/skills/caveman-ui-ux',
    strategy: 'bundle',
    symlinkable: true,
    detect: detector({ rels: ['.codex', '.agents'], homeRels: ['.codex'], bins: ['codex'] }),
  }),
  Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    projectTarget: '.claude/skills/caveman-ui-ux',
    globalTarget: '~/.claude/skills/caveman-ui-ux',
    strategy: 'bundle',
    symlinkable: true,
    detect: detector({ rels: ['.claude', 'CLAUDE.md'], homeRels: ['.claude'], bins: ['claude'] }),
  }),
  Object.freeze({
    id: 'opencode',
    label: 'OpenCode',
    projectTarget: '.opencode/skills/caveman-ui-ux',
    // Reused when it already exists, so Codex and OpenCode share one copy.
    reuse: '.agents/skills/caveman-ui-ux',
    globalTarget: '~/.config/opencode/skills/caveman-ui-ux',
    strategy: 'bundle',
    symlinkable: true,
    detect: detector({ rels: ['.opencode'], homeRels: ['.config/opencode'], bins: ['opencode'] }),
  }),
  Object.freeze({
    id: 'cursor',
    label: 'Cursor',
    projectTarget: '.cursor/rules/caveman-ui-ux.mdc',
    globalTarget: '~/.cursor/rules/caveman-ui-ux.mdc',
    strategy: 'generated',
    symlinkable: false,
    detect: detector({ rels: ['.cursor'], homeRels: ['.cursor'], bins: ['cursor'] }),
  }),
  Object.freeze({
    id: 'gemini',
    label: 'Gemini CLI',
    projectTarget: '.gemini/extensions/caveman-ui-ux',
    commandsTarget: '.gemini/commands/caveman',
    globalTarget: '~/.gemini/extensions/caveman-ui-ux',
    globalCommandsTarget: '~/.gemini/commands/caveman',
    strategy: 'generated',
    symlinkable: false,
    detect: detector({ rels: ['.gemini', 'GEMINI.md'], homeRels: ['.gemini'], bins: ['gemini'] }),
  }),
  Object.freeze({
    id: 'copilot',
    label: 'GitHub Copilot',
    projectTarget: '.github/instructions/caveman-ui-ux.instructions.md',
    globalTarget: '~/.config/github-copilot/instructions/caveman-ui-ux.instructions.md',
    strategy: 'generated',
    symlinkable: false,
    detect: detector({ rels: ['.github'], homeRels: ['.config/github-copilot'] }),
  }),
  Object.freeze({
    id: 'generic',
    label: 'Generic AGENTS.md',
    projectTarget: 'AGENTS.md',
    globalTarget: '~/.codex/AGENTS.md',
    strategy: 'managed-block',
    symlinkable: false,
    detect: detector({ rels: ['AGENTS.md'] }),
  }),
]);

/** Detection report per adapter: [{id, label, detected, evidence}] in ADAPTERS order. */
export function detectAgents(cwd = process.cwd()) {
  return ADAPTERS.map((adapter) => {
    const evidence = adapter.detect(cwd);
    return { id: adapter.id, label: adapter.label, detected: evidence.length > 0, evidence };
  });
}

/** Every file of the canonical bundle: [{relative, path}] sorted by relative path. */
export function bundleFiles() {
  const root = skillRoot();
  const files = [];
  for (const entry of BUNDLE_ENTRIES) {
    const abs = join(root, entry);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) collectFiles(abs, entry, files);
    else if (!EXCLUDED_FILES.has(entry)) files.push({ relative: entry, path: abs });
  }
  return files.sort((a, b) => (a.relative < b.relative ? -1 : 1));
}

function collectFiles(dir, prefix, out) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory()) {
      if (EXCLUDED_DIRS.has(item.name)) continue;
      collectFiles(join(dir, item.name), `${prefix}/${item.name}`, out);
      continue;
    }
    if (!item.isFile() || EXCLUDED_FILES.has(item.name)) continue;
    out.push({ relative: `${prefix}/${item.name}`, path: join(dir, item.name) });
  }
}

/** Content hash of the canonical bundle (16 hex), used to detect a stale install. */
export function bundleHash() {
  const lines = bundleFiles().map((file) => `${file.relative}:${sha256File(file.path)}`);
  return sha256(lines.join('\n')).slice(0, 16);
}

/** Wrap content in the caveman-ui-ux managed markers. */
export function managedBlock(content) {
  return `${START_MARKER}\n${String(content).trim()}\n${END_MARKER}`;
}

/** Locate the managed block inside a file's text, or null. */
function findBlock(text) {
  const start = text.indexOf(START_MARKER);
  if (start < 0) return null;
  const endAt = text.indexOf(END_MARKER, start);
  if (endAt < 0) return null;
  const end = endAt + END_MARKER.length;
  return { start, end, text: text.slice(start, end) };
}

/**
 * Create or patch the managed block of a file. Writes nothing and returns status 'conflict'
 * when the block on disk differs from the hash recorded in the manifest (a hand edit).
 */
export function patchManagedFile(path, content, { force = false, recordedHash = null } = {}) {
  const block = managedBlock(content);
  const hash = sha256(block);
  if (!existsSync(path)) {
    writeText(path, `${block}\n`);
    return { path, action: 'created', sha256: hash, managed_block: true, status: 'installed' };
  }
  const text = readText(path);
  const found = findBlock(text);
  if (!found) {
    const gap = text.trim().length ? (text.endsWith('\n') ? '\n' : '\n\n') : '';
    writeText(path, `${text}${gap}${block}\n`);
    return { path, action: 'patched', sha256: hash, managed_block: true, status: 'installed' };
  }
  const existing = sha256(found.text);
  if (existing === hash) {
    return { path, action: 'skipped', sha256: hash, managed_block: true, status: 'skipped' };
  }
  if (!force && existing !== recordedHash) {
    return {
      path,
      action: 'conflict',
      sha256: existing,
      expected: recordedHash,
      managed_block: true,
      status: 'conflict',
      hint: `managed block in ${path} was edited by hand; diff it against the generated block and re-run with --force to overwrite`,
    };
  }
  writeText(path, text.slice(0, found.start) + block + text.slice(found.end));
  return { path, action: 'updated', sha256: hash, managed_block: true, status: 'updated' };
}

/** Write a whole file we own, refusing to clobber a hand-edited or foreign file. */
function writeOwnedFile(path, content, { force = false, recordedHash = null } = {}) {
  const hash = sha256(content);
  if (!existsSync(path)) {
    writeText(path, content);
    return { path, action: 'created', sha256: hash, managed_block: false, status: 'installed' };
  }
  const current = sha256(readText(path));
  if (current === hash) {
    return { path, action: 'skipped', sha256: hash, managed_block: false, status: 'skipped' };
  }
  if (!force && current !== recordedHash) {
    return {
      path,
      action: 'conflict',
      sha256: current,
      expected: recordedHash,
      managed_block: false,
      status: 'conflict',
      hint: `${path} differs from what we installed; diff it and re-run with --force to overwrite`,
    };
  }
  writeText(path, content);
  return { path, action: 'updated', sha256: hash, managed_block: false, status: 'updated' };
}

/** Thin Cursor rule (.mdc) pointing at the canonical skill. */
export function generateCursorRule(ref = bundleReference(null)) {
  return [
    '---',
    'description: caveman-ui-ux — blind first-impression UI/UX audit with deterministic evidence',
    `globs: ${FRONTEND_GLOB}`,
    'alwaysApply: false',
    '---',
    '',
    '# caveman-ui-ux (thin adapter)',
    '',
    '觸發：caveman test、第一印象測試、blind UX review、UI/UX 稽核、UX audit、accessibility 稽核、',
    '多語 UI 檢查、UX regression gate。',
    '',
    `Canonical workflow, rubric, dimension weights and rule pack live in \`${skillRef(ref)}\`.`,
    'Read that file and follow it. Do not restate the rubric here — this adapter is a pointer only.',
    '',
    '```bash',
    ...cliLines(ref),
    '```',
    '',
    'Done means: `audit.json` exists, the gate table is reported, and every blocker/critical/major',
    'finding carries evidence. Fixes are only complete after `verify` re-ran the same coordinates.',
    '',
  ].join('\n');
}

/** Path-scoped GitHub Copilot instructions file. */
export function generateCopilotInstructions(ref = bundleReference(null)) {
  return [
    '---',
    `applyTo: '${FRONTEND_GLOB}'`,
    '---',
    '',
    '# caveman-ui-ux (thin adapter)',
    '',
    '需要做 UI/UX 稽核、第一印象測試、blind UX review、accessibility 稽核或多語 UI 檢查時，',
    `讀 \`${skillRef(ref)}\` 並照該檔的 8-stage workflow 執行。`,
    'Rubric、dimension weights 與 rule pack 只存在該 canonical skill，這裡不複製。',
    '',
    '```bash',
    ...cliLines(ref),
    '```',
    '',
    'Gate 失敗（exit 1）代表這次 UI 變更不可上線；先修 blocker/critical，再跑 `verify`。',
    '',
  ].join('\n');
}

/** Gemini CLI extension files: [{relative, content}] under the extension directory. */
export function generateGeminiExtension(ref = bundleReference(null)) {
  const json = {
    name: 'caveman-ui-ux',
    version: MANIFEST_VERSION,
    description: 'Blind first-impression UI/UX audit with deterministic accessibility and technical evidence.',
    contextFileName: 'GEMINI.md',
  };
  const md = [
    '# caveman-ui-ux (thin adapter)',
    '',
    `Canonical workflow: \`${skillRef(ref)}\`。Rubric、dimension weights、rule pack 都在那裡，`,
    '本檔只負責把你導過去。',
    '',
    '```bash',
    ...cliLines(ref),
    '```',
    '',
    'Blind stage 必須在 fresh-context subagent 執行，evaluator 只能看到一張 screenshot 與 viewport／locale。',
    '',
  ].join('\n');
  return [
    { relative: 'gemini-extension.json', content: `${JSON.stringify(json, null, 2)}\n` },
    { relative: 'GEMINI.md', content: md },
  ];
}

/** Gemini CLI custom commands: [{relative, content}] under .gemini/commands/caveman/. */
export function generateGeminiCommands(ref = bundleReference(null)) {
  const audit = [
    'description = "Run a caveman-ui-ux audit on a URL and report the gate result."',
    'prompt = """',
    `Read ${skillRef(ref)} first, then run the 8-stage workflow for {{args}}.`,
    `Deterministic path: node ${shellPath(cliPath())} audit {{args}} --no-llm --ci`,
    'Report the gate table, every blocker/critical/major finding with its evidence, and the run id.',
    '"""',
    '',
  ].join('\n');
  const verify = [
    'description = "Re-verify caveman-ui-ux findings after a fix."',
    'prompt = """',
    `Read ${skillRef(ref)} first, then run: node ${shellPath(cliPath())} verify {{args}}`,
    'Report each finding as resolved / improved / unchanged / regressed / not-comparable with evidence.',
    'A fix is only done when verify re-ran the same route, locale and viewport.',
    '"""',
    '',
  ].join('\n');
  return [
    { relative: 'audit.toml', content: audit },
    { relative: 'verify.toml', content: verify },
  ];
}

/** Inner content of the AGENTS.md managed block (markers added by managedBlock). */
export function generateAgentsBlock(ref = bundleReference(null)) {
  return [
    '## caveman-ui-ux (UI/UX audit)',
    '',
    'UI/UX 稽核、第一印象測試、blind UX review、accessibility 稽核、多語 UI 檢查、UX regression gate：',
    `讀 \`${skillRef(ref)}\` 並照該檔執行。Rubric、dimension weights 與 rule pack 只存在該檔。`,
    '',
    '```bash',
    ...cliLines(ref),
    '```',
    '',
    '規則：blind evaluator 只能看到一張 screenshot（fresh context，無 URL／DOM／repo）；',
    'blocker/critical/major finding 沒有 evidence 一律丟棄；gate 失敗回 exit 1。',
  ].join('\n');
}

/** Expand a leading ~/ to the user's home directory. */
function expandHome(target) {
  if (!target) return null;
  if (target === '~') return homedir();
  if (target.startsWith('~/')) return join(homedir(), target.slice(2));
  return target;
}

/** Absolute install paths of one adapter: {base, commands}. */
function adapterPaths(adapter, { cwd, global }) {
  if (global) {
    return {
      base: expandHome(adapter.globalTarget),
      commands: adapter.globalCommandsTarget ? expandHome(adapter.globalCommandsTarget) : null,
    };
  }
  let rel = adapter.projectTarget;
  if (adapter.reuse && existsSync(join(cwd, adapter.reuse))) rel = adapter.reuse;
  return {
    base: join(cwd, rel),
    commands: adapter.commandsTarget ? join(cwd, adapter.commandsTarget) : null,
  };
}

/** Manifest-friendly path: cwd-relative when inside the project, absolute otherwise. */
function manifestPathOf(cwd, abs) {
  const rel = relative(cwd, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return abs;
  return rel.split(sep).join('/');
}

/** Recorded absolute-path -> sha256 map from a previous manifest agent entry. */
function recordedHashes(cwd, previous) {
  const map = new Map();
  for (const entry of ((previous && previous.files) || [])) {
    if (!entry || !entry.path) continue;
    map.set(resolve(cwd, entry.path), entry.sha256 || null);
  }
  return map;
}

/** True when the skill root and the target parent live on the same device. */
function sameVolume(target) {
  try {
    let dir = dirname(target);
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
    return statSync(skillRoot()).dev === statSync(dir).dev;
  } catch {
    return false;
  }
}

/** True when the path itself is a symbolic link. */
function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Symlink the canonical bundle; returns null when a real directory is in the way. */
function linkBundle(target) {
  const src = skillRoot();
  ensureDir(dirname(target));
  if (isSymlink(target)) {
    try {
      if (realpathSync(target) === realpathSync(src)) {
        return { path: target, action: 'skipped', sha256: bundleHash(), managed_block: false, symlink: true, status: 'skipped' };
      }
    } catch {
      // dangling link: replace it
    }
    unlinkSync(target);
  } else if (existsSync(target)) {
    return null;
  }
  symlinkSync(src, target, 'dir');
  return { path: target, action: 'created', sha256: bundleHash(), managed_block: false, symlink: true, status: 'installed' };
}

/** Copy the canonical bundle file by file, skipping unchanged files. */
function copyBundle(target) {
  const files = [];
  for (const file of bundleFiles()) {
    const dest = join(target, ...file.relative.split('/'));
    const { action, sha256: hash } = copyFileHashed(file.path, dest);
    files.push({
      path: dest,
      action,
      sha256: hash,
      managed_block: false,
      status: action === 'created' ? 'installed' : action === 'updated' ? 'updated' : 'skipped',
    });
  }
  return files;
}

/** Generated file list for one adapter: [{path, content}]. */
function generatedFiles(adapter, paths, ref) {
  if (adapter.id === 'cursor') return [{ path: paths.base, content: generateCursorRule(ref) }];
  if (adapter.id === 'copilot') return [{ path: paths.base, content: generateCopilotInstructions(ref) }];
  if (adapter.id === 'gemini') {
    const out = generateGeminiExtension(ref).map((file) => ({
      path: join(paths.base, ...file.relative.split('/')),
      content: file.content,
    }));
    for (const file of generateGeminiCommands(ref)) {
      out.push({ path: join(paths.commands, ...file.relative.split('/')), content: file.content });
    }
    return out;
  }
  return [];
}

/** Roll per-file results up to one agent status. */
function rollupStatus(files) {
  if (files.some((file) => file.status === 'conflict')) return 'conflict';
  if (files.some((file) => file.status === 'installed')) return 'installed';
  if (files.some((file) => file.status === 'updated')) return 'updated';
  return 'skipped';
}

/** Install or update one adapter; returns the manifest entry for it. */
function installAdapter(adapter, { cwd, global, force, symlink, previous }) {
  const paths = adapterPaths(adapter, { cwd, global });
  const recorded = recordedHashes(cwd, previous);
  // Recomputed per adapter: bundle adapters run first, so a thin adapter installed in the
  // same pass already sees the project-local copy and can point at it relatively.
  const ref = global ? bundleReference(null) : bundleReference(cwd);
  let files = [];
  if (adapter.strategy === 'bundle') {
    const wantLink = symlink && adapter.symlinkable && process.platform !== 'win32' && sameVolume(paths.base);
    const linked = wantLink ? linkBundle(paths.base) : null;
    files = linked ? [linked] : copyBundle(paths.base);
  } else if (adapter.strategy === 'managed-block') {
    files = [patchManagedFile(paths.base, generateAgentsBlock(ref), {
      force,
      recordedHash: recorded.has(paths.base) ? recorded.get(paths.base) : null,
    })];
  } else {
    files = generatedFiles(adapter, paths, ref).map((file) => writeOwnedFile(file.path, file.content, {
      force,
      recordedHash: recorded.has(file.path) ? recorded.get(file.path) : null,
    }));
  }
  const status = rollupStatus(files);
  const previousEntries = (previous && previous.files) || [];
  const entries = files.map((file) => {
    const path = manifestPathOf(cwd, file.path);
    if (file.status === 'conflict') {
      // Keep the hash we recorded before, so the conflict stays sticky until --force.
      const before = previousEntries.find((entry) => entry.path === path);
      return before || { path, action: 'conflict', sha256: null, managed_block: !!file.managed_block };
    }
    const entry = { path, action: file.action, sha256: file.sha256, managed_block: !!file.managed_block };
    if (file.symlink) entry.symlink = true;
    return entry;
  });
  const out = { status, target: manifestPathOf(cwd, paths.base), files: entries };
  const conflict = files.find((file) => file.status === 'conflict');
  if (conflict) out.hint = conflict.hint;
  return out;
}

/** Resolve the agent id list: explicit csv/array, else detected, else generic. */
function resolveAgentIds(cwd, agents) {
  const known = ADAPTERS.map((adapter) => adapter.id);
  let ids = [];
  if (typeof agents === 'string' && agents.trim()) ids = agents.split(',').map((part) => part.trim()).filter(Boolean);
  else if (Array.isArray(agents) && agents.length) ids = agents.map((part) => String(part).trim()).filter(Boolean);
  if (ids.includes('all')) ids = known.slice();
  if (!ids.length) {
    ids = detectAgents(cwd).filter((item) => item.detected).map((item) => item.id);
    if (!ids.length) ids = ['generic'];
  }
  const unknown = ids.filter((id) => !known.includes(id));
  if (unknown.length) fail(`unknown agent adapter: ${unknown.join(', ')}`, EXIT.CONFIG, { known });
  return known.filter((id) => ids.includes(id));
}

/** Install or update adapters and write .caveman-ui-ux/install-manifest.json. */
export function install({ cwd = process.cwd(), agents, global = false, force = false, symlink = false } = {}) {
  const base = resolve(cwd);
  const manifestPath = installManifestPath(base);
  const previous = exists(manifestPath) ? readJson(manifestPath) : null;
  // Bundle adapters must run before thin ones: a thin adapter points at the project-local
  // bundle when it exists, so the copy has to land first regardless of --agents order.
  const order = new Map(ADAPTERS.map((adapter, index) => [adapter.id, index]));
  const ids = resolveAgentIds(base, agents)
    .slice()
    .sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
  const results = {};
  for (const id of ids) {
    const adapter = ADAPTERS.find((item) => item.id === id);
    const before = (previous && previous.agents && previous.agents[id]) || null;
    results[id] = installAdapter(adapter, { cwd: base, global, force, symlink, previous: before });
  }
  const merged = { ...((previous && previous.agents) || {}), ...results };
  const hash = bundleHash();
  const untouched = Object.keys(results).every((id) => results[id].status === 'skipped');
  const installedAt = (previous && untouched && previous.bundle_hash === hash && previous.installed_at)
    ? previous.installed_at
    : new Date().toISOString();
  const manifest = {
    tool: 'caveman-ui-ux',
    version: MANIFEST_VERSION,
    installed_at: installedAt,
    global: !!global,
    agents: merged,
    bundle_hash: hash,
  };
  writeJson(manifestPath, manifest);
  const conflicts = Object.keys(results).filter((id) => results[id].status === 'conflict');
  return { ok: conflicts.length === 0, path: manifestPath, manifest, conflicts, agents: ids };
}

/** Remove the managed block from a file, leaving everything else untouched. */
function removeManagedBlock(path, wasCreated) {
  if (!existsSync(path)) return { path, status: 'missing' };
  const text = readText(path);
  const found = findBlock(text);
  if (!found) return { path, status: 'kept', reason: 'no managed block' };
  const rest = `${text.slice(0, found.start)}${text.slice(found.end)}`.replace(/\n{3,}/g, '\n\n');
  if (wasCreated && !rest.trim()) {
    unlinkSync(path);
    return { path, status: 'removed' };
  }
  writeText(path, rest.replace(/^\n+/, '').replace(/\n*$/, '\n'));
  return { path, status: 'removed', reason: 'managed block only' };
}

/** Delete empty directories upwards from a path, stopping at stopDir. */
function pruneEmptyDirs(startDir, stopDir) {
  let dir = startDir;
  const stop = resolve(stopDir);
  while (dir.startsWith(stop) && dir !== stop && dir !== dirname(dir)) {
    try {
      if (readdirSync(dir).length) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

/** Remove only manifest-recorded files and managed blocks, then drop the manifest. */
export function uninstall({ cwd = process.cwd() } = {}) {
  const base = resolve(cwd);
  const manifestPath = installManifestPath(base);
  if (!exists(manifestPath)) return { ok: true, removed: [], kept: [], agents: [] };
  const manifest = readJson(manifestPath);
  const removed = [];
  const kept = [];
  for (const [id, agent] of Object.entries((manifest && manifest.agents) || {})) {
    for (const entry of (agent.files || [])) {
      const abs = resolve(base, entry.path);
      if (entry.symlink) {
        if (isSymlink(abs)) {
          unlinkSync(abs);
          removed.push({ agent: id, path: abs });
        } else {
          kept.push({ agent: id, path: abs, reason: 'not a symlink any more' });
        }
        pruneEmptyDirs(dirname(abs), base);
        continue;
      }
      if (entry.managed_block) {
        const result = removeManagedBlock(abs, entry.action === 'created');
        (result.status === 'removed' ? removed : kept).push({ agent: id, path: abs, reason: result.reason });
        continue;
      }
      if (!existsSync(abs)) {
        kept.push({ agent: id, path: abs, reason: 'already gone' });
        continue;
      }
      if (entry.sha256 && sha256File(abs) !== entry.sha256) {
        kept.push({ agent: id, path: abs, reason: 'modified after install' });
        continue;
      }
      unlinkSync(abs);
      removed.push({ agent: id, path: abs });
      pruneEmptyDirs(dirname(abs), base);
    }
  }
  rmrf(manifestPath);
  pruneEmptyDirs(dirname(manifestPath), base);
  return { ok: true, removed, kept, agents: Object.keys((manifest && manifest.agents) || {}) };
}
