// Tests for the documented YAML subset (contract §19).

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../lib/errors.mjs';
import { loadYamlParser, parseYaml, parseYamlFile, stringifyYaml } from '../lib/yaml.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const skillDir = join(here, '..', '..');

function throwsConfig(text, messageRegex) {
  assert.throws(() => parseYaml(text), (error) => {
    assert.equal(error.name, 'CavemanError');
    assert.equal(error.exitCode, EXIT.CONFIG);
    assert.match(error.message, /^YAML line \d+: /);
    assert.match(error.message, messageRegex);
    assert.equal(typeof error.details.line, 'number');
    return true;
  });
}

test('parses nested maps indented by two spaces', () => {
  const value = parseYaml(['a:', '  b:', '    c: 1', '  d: 2', 'e: 3'].join('\n'));
  assert.deepEqual(value, { a: { b: { c: 1 }, d: 2 }, e: 3 });
});

test('parses block sequences of scalars', () => {
  const value = parseYaml(['routes:', '  - /', '  - /pricing', '  - /docs/intro'].join('\n'));
  assert.deepEqual(value, { routes: ['/', '/pricing', '/docs/intro'] });
});

test('parses block sequences at the same indent as their key', () => {
  const value = parseYaml(['routes:', '- /', '- /pricing', 'other: 1'].join('\n'));
  assert.deepEqual(value, { routes: ['/', '/pricing'], other: 1 });
});

test('parses block sequences of maps with continuation lines', () => {
  const value = parseYaml([
    'viewports:',
    '  - id: mobile',
    '    width: 375',
    '    height: 812',
    '  - id: desktop',
    '    width: 1280',
    '    height: 800',
    'after: ok',
  ].join('\n'));
  assert.deepEqual(value, {
    viewports: [
      { id: 'mobile', width: 375, height: 812 },
      { id: 'desktop', width: 1280, height: 800 },
    ],
    after: 'ok',
  });
});

test('parses nested blocks inside sequence items', () => {
  const value = parseYaml([
    'rules:',
    '  - id: CAVEMAN.IDENTITY.001',
    '    applicability:',
    '      page_types: [landing, product]',
    '    evidence:',
    '      accepted:',
    '        - screenshot_region',
    '        - text',
  ].join('\n'));
  assert.deepEqual(value, {
    rules: [{
      id: 'CAVEMAN.IDENTITY.001',
      applicability: { page_types: ['landing', 'product'] },
      evidence: { accepted: ['screenshot_region', 'text'] },
    }],
  });
});

test('parses nested sequences of sequences', () => {
  const value = parseYaml(['grid:', '  - - 1', '    - 2', '  - - 3'].join('\n'));
  assert.deepEqual(value, { grid: [[1, 2], [3]] });
});

test('parses inline flow sequences including empty and trailing comma', () => {
  const value = parseYaml([
    'a: [1, 2, 3]',
    'b: []',
    'c: [x, y,]',
    'd: [[1, 2], [3]]',
    'e: [/, /pricing]',
  ].join('\n'));
  assert.deepEqual(value, {
    a: [1, 2, 3], b: [], c: ['x', 'y'], d: [[1, 2], [3]], e: ['/', '/pricing'],
  });
});

test('parses inline flow maps including empty and nested', () => {
  const value = parseYaml([
    'wait: { strategy: networkidle, timeout_ms: 20000, settle_ms: 400 }',
    'headers: {}',
    'gates: { caveman: { minimum: 75 }, critical_findings: { maximum: 0 } }',
    'mixed: { list: [a, b], flag: true }',
  ].join('\n'));
  assert.deepEqual(value, {
    wait: { strategy: 'networkidle', timeout_ms: 20000, settle_ms: 400 },
    headers: {},
    gates: { caveman: { minimum: 75 }, critical_findings: { maximum: 0 } },
    mixed: { list: ['a', 'b'], flag: true },
  });
});

test('parses plain scalars without mangling colons inside URLs', () => {
  const value = parseYaml(['base_url: http://localhost:3000/a', 'sel: div > span'].join('\n'));
  assert.deepEqual(value, { base_url: 'http://localhost:3000/a', sel: 'div > span' });
});

test('parses single-quoted strings with doubled-quote escapes', () => {
  const value = parseYaml("s: 'it''s fine: # not a comment'");
  assert.deepEqual(value, { s: "it's fine: # not a comment" });
});

test('parses double-quoted strings with \\n \\t and \\" escapes', () => {
  const value = parseYaml('s: "a\\nb\\tc \\"q\\" \\\\ ok"');
  assert.deepEqual(value, { s: 'a\nb\tc "q" \\ ok' });
});

test('strips whole-line and trailing comments but not comments inside quotes', () => {
  const value = parseYaml([
    '# leading comment',
    'a: 1  # trailing comment',
    '   # indented comment',
    'b: "keep # this"',
    "c: 'and # this'",
  ].join('\n'));
  assert.deepEqual(value, { a: 1, b: 'keep # this', c: 'and # this' });
});

test('parses booleans true/false/yes/no', () => {
  const value = parseYaml(['a: true', 'b: false', 'c: yes', 'd: no', 'e: TRUE', 'f: No'].join('\n'));
  assert.deepEqual(value, { a: true, b: false, c: true, d: false, e: true, f: false });
});

test('parses null as null, ~ and an empty value', () => {
  const value = parseYaml(['a: null', 'b: ~', 'c:', 'd: NULL'].join('\n'));
  assert.deepEqual(value, { a: null, b: null, c: null, d: null });
});

test('parses integers and floats', () => {
  const value = parseYaml(['a: 0', 'b: 75', 'c: -3', 'd: +4', 'e: 0.6', 'f: -1.5', 'g: .5', 'h: 1e3'].join('\n'));
  assert.deepEqual(value, { a: 0, b: 75, c: -3, d: 4, e: 0.6, f: -1.5, g: 0.5, h: 1000 });
});

test('treats a bare key with no value as the start of a nested block', () => {
  const value = parseYaml(['target:', '  routes: [/]', 'privacy:', '  redact_selectors: []'].join('\n'));
  assert.deepEqual(value, { target: { routes: ['/'] }, privacy: { redact_selectors: [] } });
});

test('accepts a single leading document marker', () => {
  assert.deepEqual(parseYaml(['---', 'a: 1'].join('\n')), { a: 1 });
});

test('returns null for an empty or comment-only document', () => {
  assert.equal(parseYaml(''), null);
  assert.equal(parseYaml('# nothing here\n'), null);
});

test('parses a lone flow document', () => {
  assert.deepEqual(parseYaml('{}\n'), {});
  assert.deepEqual(parseYaml('[]\n'), []);
});

test('rejects tab indentation', () => {
  throwsConfig('a:\n\tb: 1\n', /tab indentation/);
});

test('rejects odd indentation', () => {
  throwsConfig('a:\n   b: 1\n', /odd indentation/);
});

test('rejects | and > block scalars', () => {
  throwsConfig('a: |\n  text\n', /block scalars/);
  throwsConfig('a: >\n  text\n', /block scalars/);
  throwsConfig('a: |-\n  text\n', /block scalars/);
});

test('rejects anchors and aliases', () => {
  throwsConfig('a: &anchor 1\n', /anchors and aliases/);
  throwsConfig('a: *anchor\n', /anchors and aliases/);
  throwsConfig('a: [*anchor]\n', /anchors and aliases/);
});

test('rejects multi-document streams', () => {
  throwsConfig('a: 1\n---\nb: 2\n', /multi-document/);
  throwsConfig('a: 1\n...\n', /multi-document/);
});

test('rejects duplicate keys in the same map', () => {
  throwsConfig('a: 1\na: 2\n', /duplicate key "a"/);
  throwsConfig('outer:\n  k: 1\n  k: 2\n', /duplicate key "k"/);
  throwsConfig('m: { k: 1, k: 2 }\n', /duplicate key "k"/);
});

test('reports the failing line number', () => {
  assert.throws(() => parseYaml('a: 1\nb: 2\nc: |\n  x\n'), (error) => {
    assert.equal(error.details.line, 3);
    assert.ok(error.message.startsWith('YAML line 3: '));
    return true;
  });
});

test('rejects a plain scalar where a map key was expected', () => {
  throwsConfig('a:\n  b: 1\nnot-a-key\n', /expected "key: value"/);
});

test('stringifyYaml round-trips through parseYaml', () => {
  const value = {
    version: 1,
    report_locale: 'zh-TW',
    target: {
      base_url: 'http://localhost:3000',
      routes: ['/', '/pricing'],
      locales: ['auto'],
      wait: { strategy: 'networkidle', timeout_ms: 20000, settle_ms: 400 },
      dismiss_selectors: [],
      storage_state: null,
      extra_http_headers: {},
    },
    viewports: [
      { id: 'mobile', width: 375, height: 812, device_scale_factor: 2 },
      { id: 'desktop', width: 1280, height: 800, device_scale_factor: 1 },
    ],
    gates: { caveman_minimum: 75, heuristic_minimum: null, evaluator_confidence_minimum: 0.6 },
    flags: { on: true, off: false, tricky: 'yes', numberish: '75', hash: 'a # b' },
  };
  const text = stringifyYaml(value);
  assert.match(text, /\n$/);
  assert.deepEqual(parseYaml(text), value);
});

test('parseYamlFile reads a file and prefixes errors with its path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caveman-yaml-'));
  const good = join(dir, 'good.yaml');
  const bad = join(dir, 'bad.yaml');
  writeFileSync(good, 'a: 1\nb: [x, y]\n', 'utf8');
  writeFileSync(bad, 'a: |\n  block\n', 'utf8');
  assert.deepEqual(parseYamlFile(good), { a: 1, b: ['x', 'y'] });
  assert.throws(() => parseYamlFile(bad), (error) => {
    assert.equal(error.exitCode, EXIT.CONFIG);
    assert.equal(error.details.path, bad);
    assert.ok(error.message.startsWith(bad));
    return true;
  });
});

test('loadYamlParser always resolves to a working parser', async () => {
  const { parse, impl } = await loadYamlParser();
  assert.ok(['yaml', 'builtin'].includes(impl));
  assert.deepEqual(parse('a: 1\n'), { a: 1 });
});

test('parses the real assets/caveman.config.example.yaml', (t) => {
  const path = join(skillDir, 'assets', 'caveman.config.example.yaml');
  if (!existsSync(path)) {
    t.skip('assets/caveman.config.example.yaml not written yet (owned by another agent)');
    return;
  }
  const config = parseYamlFile(path);
  assert.equal(typeof config, 'object');
  assert.ok(config !== null);
  assert.ok('version' in config, 'example config should declare a version');
  assert.deepEqual(parseYaml(stringifyYaml(config)), config);
});

test('parses the real rules/core.pack.yaml', (t) => {
  const path = join(skillDir, 'rules', 'core.pack.yaml');
  if (!existsSync(path)) {
    t.skip('rules/core.pack.yaml not written yet (owned by another agent)');
    return;
  }
  const pack = parseYamlFile(path);
  assert.equal(typeof pack, 'object');
  assert.ok(pack !== null);
  assert.ok(Array.isArray(pack.rules), 'rule pack should expose a rules array');
  assert.ok(pack.rules.length > 0);
  assert.deepEqual(parseYaml(stringifyYaml(pack)), pack);
});
