// Contract §19 / AC-003 install.test.mjs — install, idempotent re-install, managed-block
// conflict detection, --force overwrite, user content survival and clean uninstall.
// Everything happens inside fs.mkdtempSync; every write is guarded by a temp-prefix assert.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import {
  ADAPTERS, bundleFiles, bundleHash, detectAgents, generateAgentsBlock, generateCopilotInstructions,
  generateCursorRule, install, managedBlock, uninstall,
} from '../lib/install.mjs';

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const START = '<!-- caveman-ui-ux:start -->';
const END = '<!-- caveman-ui-ux:end -->';
const AGENTS = 'cursor,copilot,generic';

const CURSOR_REL = join('.cursor', 'rules', 'caveman-ui-ux.mdc');
const COPILOT_REL = join('.github', 'instructions', 'caveman-ui-ux.instructions.md');
const MANIFEST_REL = join('.caveman-ui-ux', 'install-manifest.json');

let TMP = '';

/** Refuse to touch anything outside the temp project. */
function guard(path) {
  const abs = resolve(path);
  const root = resolve(TMP);
  assert.ok(abs === root || abs.startsWith(root + sep), `refusing to touch ${abs} outside ${root}`);
  return abs;
}

/** Read a file inside the temp project. */
function read(rel) {
  return readFileSync(guard(join(TMP, rel)), 'utf8');
}

/** Write a file inside the temp project. */
function write(rel, content) {
  writeFileSync(guard(join(TMP, rel)), content, 'utf8');
}

/** relative path -> sha256 for every file in the temp project. */
function snapshot(dir = TMP, prefix = '') {
  const out = new Map();
  for (const item of readdirSync(guard(dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = join(dir, item.name);
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) {
      for (const [key, value] of snapshot(abs, rel)) out.set(key, value);
      continue;
    }
    if (!item.isFile()) continue;
    out.set(rel, createHash('sha256').update(readFileSync(abs)).digest('hex'));
  }
  return out;
}

/** The managed block currently inside AGENTS.md. */
function currentBlock() {
  const text = read('AGENTS.md');
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  assert.ok(start >= 0 && end > start, 'managed markers missing from AGENTS.md');
  return text.slice(start, end + END.length);
}

test('AC-003 adapter installation', async (t) => {
  TMP = mkdtempSync(join(tmpdir(), 'caveman-install-'));
  t.after(() => {
    if (TMP && resolve(TMP).startsWith(resolve(tmpdir()))) rmSync(TMP, { recursive: true, force: true });
  });

  await t.test('descriptors and bundle list stay inside contract §20', () => {
    assert.deepEqual(
      ADAPTERS.map((adapter) => adapter.id),
      ['codex', 'claude', 'opencode', 'cursor', 'gemini', 'copilot', 'generic'],
    );
    assert.ok(Object.isFrozen(ADAPTERS));
    for (const adapter of ADAPTERS) {
      assert.equal(typeof adapter.label, 'string');
      assert.equal(typeof adapter.projectTarget, 'string');
      assert.equal(typeof adapter.globalTarget, 'string');
      assert.ok(['bundle', 'generated', 'managed-block'].includes(adapter.strategy));
      assert.equal(typeof adapter.detect, 'function');
    }
    const files = bundleFiles().map((file) => file.relative);
    assert.ok(files.includes('SKILL.md') || files.length > 0);
    assert.ok(!files.some((rel) => rel.startsWith('.caveman-ui-ux/')), 'run artifacts must never be bundled');
    assert.ok(!files.some((rel) => rel.includes('node_modules')), 'dependencies must never be bundled');
    assert.match(bundleHash(), /^[0-9a-f]{16}$/);
    const detected = detectAgents(TMP);
    assert.equal(detected.length, ADAPTERS.length);
    assert.ok(detected.every((item) => Array.isArray(item.evidence)));
  });

  await t.test('thin adapters carry no rubric, no weights, no rule pack', () => {
    const rule = generateCursorRule();
    assert.ok(rule.split('\n').length <= 40, 'cursor rule must stay under 40 lines');
    for (const forbidden of ['dimension.', 'CAVEMAN.IDENTITY', 'severity_default', 'weight: 15']) {
      assert.ok(!rule.includes(forbidden), `cursor rule duplicates ${forbidden}`);
    }
    assert.ok(rule.includes('SKILL.md'), 'cursor rule must point at the canonical skill');
    assert.ok(generateCopilotInstructions().startsWith('---\napplyTo:'), 'copilot needs applyTo frontmatter');
  });

  await t.test('install into an empty project creates the expected files', () => {
    const result = install({ cwd: guard(TMP), agents: AGENTS });
    assert.equal(result.ok, true);
    assert.deepEqual(result.conflicts, []);
    for (const rel of [CURSOR_REL, COPILOT_REL, 'AGENTS.md', MANIFEST_REL]) {
      assert.ok(existsSync(join(TMP, rel)), `missing ${rel}`);
    }
    for (const id of ['cursor', 'copilot', 'generic']) {
      assert.equal(result.manifest.agents[id].status, 'installed', `${id} status`);
      assert.ok(result.manifest.agents[id].files.length > 0);
    }
    const manifest = JSON.parse(read(MANIFEST_REL));
    assert.equal(manifest.tool, 'caveman-ui-ux');
    assert.equal(manifest.global, false);
    assert.equal(manifest.bundle_hash, bundleHash());
    assert.equal(manifest.agents.generic.files[0].managed_block, true);
    assert.equal(currentBlock(), managedBlock(generateAgentsBlock()));
    // The generated Copilot file must never be the repo-wide instructions file.
    assert.ok(!existsSync(join(TMP, '.github', 'copilot-instructions.md')));
  });

  await t.test('a second install is idempotent', () => {
    const before = snapshot();
    const beforeManifest = JSON.parse(read(MANIFEST_REL));
    const result = install({ cwd: guard(TMP), agents: AGENTS });
    const after = snapshot();
    assert.equal(result.ok, true);
    for (const id of ['cursor', 'copilot', 'generic']) {
      assert.equal(result.manifest.agents[id].status, 'skipped', `${id} should be skipped`);
      // Same paths, same hashes: only the per-run `action` field flips created -> skipped.
      assert.deepEqual(
        result.manifest.agents[id].files.map((file) => [file.path, file.sha256, file.managed_block]),
        beforeManifest.agents[id].files.map((file) => [file.path, file.sha256, file.managed_block]),
        `${id} manifest entries drifted`,
      );
    }
    // Every installed adapter file must be byte-identical; the manifest itself legitimately
    // records this run's statuses, so it is compared field by field instead of by hash.
    const adapterFiles = (map) => [...map.entries()].filter(([rel]) => rel !== '.caveman-ui-ux/install-manifest.json');
    assert.deepEqual(adapterFiles(after), adapterFiles(before), 're-install rewrote adapter files');
    const afterManifest = JSON.parse(read(MANIFEST_REL));
    assert.equal(afterManifest.bundle_hash, beforeManifest.bundle_hash);
    assert.equal(afterManifest.installed_at, beforeManifest.installed_at, 'a no-op install must not restamp installed_at');
  });

  await t.test('a hand edit inside the managed block is a conflict, and nothing is written', () => {
    const original = read('AGENTS.md');
    write('AGENTS.md', original.replace('## caveman-ui-ux (UI/UX audit)', '## caveman-ui-ux (edited by hand)'));
    const edited = read('AGENTS.md');
    const result = install({ cwd: guard(TMP), agents: 'generic' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.conflicts, ['generic']);
    assert.equal(result.manifest.agents.generic.status, 'conflict');
    assert.ok(result.manifest.agents.generic.hint.includes('--force'));
    assert.equal(read('AGENTS.md'), edited, 'conflict must not touch the file');
    // Sticky: the recorded hash was preserved, so the next plain install still conflicts.
    const again = install({ cwd: guard(TMP), agents: 'generic' });
    assert.equal(again.manifest.agents.generic.status, 'conflict');
    assert.equal(read('AGENTS.md'), edited);
  });

  await t.test('--force overwrites the conflicted block', () => {
    const result = install({ cwd: guard(TMP), agents: 'generic', force: true });
    assert.equal(result.ok, true);
    assert.equal(result.manifest.agents.generic.status, 'updated');
    assert.equal(currentBlock(), managedBlock(generateAgentsBlock()));
  });

  await t.test('user prose outside the managed block survives an update', () => {
    const prose = '# Project agents\n\nOur own house rules live here.\n';
    const tail = '\n## Local notes\n\nDo not delete this line.\n';
    write('AGENTS.md', `${prose}\n${currentBlock().replace('UI/UX audit', 'hand edited again')}\n${tail}`);
    const result = install({ cwd: guard(TMP), agents: 'generic', force: true });
    assert.equal(result.manifest.agents.generic.status, 'updated');
    const text = read('AGENTS.md');
    assert.ok(text.includes('Our own house rules live here.'), 'prose before the block was lost');
    assert.ok(text.includes('Do not delete this line.'), 'prose after the block was lost');
    assert.equal(currentBlock(), managedBlock(generateAgentsBlock()));
  });

  await t.test('a hand-edited generated file is a conflict too', () => {
    const original = read(CURSOR_REL);
    write(CURSOR_REL, `${original}\n# my own tweak\n`);
    const result = install({ cwd: guard(TMP), agents: 'cursor' });
    assert.equal(result.manifest.agents.cursor.status, 'conflict');
    assert.ok(read(CURSOR_REL).includes('# my own tweak'), 'conflict must not overwrite the file');
    const forced = install({ cwd: guard(TMP), agents: 'cursor', force: true });
    assert.equal(forced.manifest.agents.cursor.status, 'updated');
    assert.equal(read(CURSOR_REL), generateCursorRule());
  });

  await t.test('uninstall removes only what the manifest recorded', () => {
    write(join('.cursor', 'rules', 'my-own.mdc'), '# mine\n');
    const result = uninstall({ cwd: guard(TMP) });
    assert.equal(result.ok, true);
    assert.ok(!existsSync(join(TMP, CURSOR_REL)), 'cursor rule should be gone');
    assert.ok(!existsSync(join(TMP, COPILOT_REL)), 'copilot instructions should be gone');
    assert.ok(!existsSync(join(TMP, MANIFEST_REL)), 'manifest should be gone');
    assert.ok(existsSync(join(TMP, '.cursor', 'rules', 'my-own.mdc')), 'user rule must survive');
    const text = read('AGENTS.md');
    assert.ok(!text.includes(START) && !text.includes(END), 'managed markers should be gone');
    assert.ok(text.includes('Our own house rules live here.'), 'user prose must survive uninstall');
    assert.ok(text.includes('Do not delete this line.'), 'user prose must survive uninstall');
    assert.ok(statSync(join(TMP, 'AGENTS.md')).isFile());
  });
});

// .cursor/rules/*.mdc, AGENTS.md and the Copilot instructions are files the user COMMITS.
// Pointing them at the installing machine's absolute clone path breaks every teammate and
// every CI runner, so a project-local bundle must win over the source path.
test('thin adapters point at the project-local bundle, not the installing machine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caveman-ref-'));
  try {
    // Deliberately reversed order: thin adapters listed before the bundle adapter.
    install({ cwd: dir, agents: 'cursor,generic,claude' });
    const localSkill = join(dir, '.claude', 'skills', 'caveman-ui-ux', 'SKILL.md');
    assert.ok(existsSync(localSkill), 'the claude adapter must copy the bundle into the project');

    for (const rel of [CURSOR_REL, 'AGENTS.md']) {
      const text = readFileSync(join(dir, rel), 'utf8');
      assert.match(text, /\.claude\/skills\/caveman-ui-ux/, `${rel} must reference the project-local bundle`);
      assert.ok(!text.includes(SKILL_ROOT), `${rel} must not embed the installing machine's path`);
      assert.ok(!/\$HOME|~\//.test(text), `${rel} must not embed a home-relative path either`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a project-local bundle a thin adapter falls back to the source path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caveman-abs-'));
  try {
    install({ cwd: dir, agents: 'cursor' });
    const text = readFileSync(join(dir, CURSOR_REL), 'utf8');
    assert.ok(!/\.claude\/skills\/caveman-ui-ux/.test(text), 'there is no local bundle to point at');
    assert.match(text, /SKILL\.md/, 'it must still name the canonical file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
