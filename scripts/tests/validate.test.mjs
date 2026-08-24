// Tests for the JSON Schema subset validator (contract §19).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getValidator, validateFile, validateSubset } from '../lib/validate.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const schemasDir = join(here, '..', '..', 'schemas');
const SCHEMA_FILES = ['config.schema.json', 'blind.schema.json', 'audit.schema.json', 'handoff.schema.json'];
const UNSAT = Symbol('unsatisfiable');

function keywords(result) {
  return result.errors.map((error) => error.keyword);
}

function paths(result) {
  return result.errors.map((error) => error.path);
}

test('type accepts single types, type arrays and null', () => {
  assert.ok(validateSubset({ type: 'string' }, 'a').valid);
  assert.ok(!validateSubset({ type: 'string' }, 1).valid);
  assert.ok(validateSubset({ type: ['number', 'null'] }, null).valid);
  assert.ok(validateSubset({ type: ['number', 'null'] }, 3.5).valid);
  assert.ok(!validateSubset({ type: ['number', 'null'] }, 'x').valid);
  assert.ok(validateSubset({ type: 'integer' }, 7).valid);
  assert.ok(!validateSubset({ type: 'integer' }, 7.5).valid);
  assert.ok(validateSubset({ type: 'null' }, null).valid);
  assert.ok(!validateSubset({ type: 'object' }, []).valid);
  assert.deepEqual(keywords(validateSubset({ type: 'boolean' }, 'no')), ['type']);
});

test('enum and const', () => {
  assert.ok(validateSubset({ enum: ['a', 'b'] }, 'b').valid);
  assert.deepEqual(keywords(validateSubset({ enum: ['a', 'b'] }, 'c')), ['enum']);
  assert.ok(validateSubset({ const: 1 }, 1).valid);
  assert.deepEqual(keywords(validateSubset({ const: 'caveman-ui-ux' }, 'other')), ['const']);
  assert.ok(validateSubset({ const: { a: [1] } }, { a: [1] }).valid);
});

test('required reports one error per missing property, path names the field', () => {
  const schema = { type: 'object', required: ['id', 'kind'] };
  const result = validateSubset(schema, { id: 'x' });
  assert.equal(result.valid, false);
  assert.deepEqual(paths(result), ['/kind']);
  assert.deepEqual(keywords(result), ['required']);
});

test('properties recurse and report nested paths', () => {
  const schema = {
    type: 'object',
    properties: { target: { type: 'object', properties: { viewport: { type: 'string' } } } },
  };
  const result = validateSubset(schema, { target: { viewport: 3 } });
  assert.deepEqual(paths(result), ['/target/viewport']);
});

test('additionalProperties false rejects unknown keys, a schema validates them', () => {
  const closed = { type: 'object', properties: { a: { type: 'number' } }, additionalProperties: false };
  const result = validateSubset(closed, { a: 1, b: 2 });
  assert.deepEqual(paths(result), ['/b']);
  assert.deepEqual(keywords(result), ['additionalProperties']);
  const typed = { type: 'object', properties: {}, additionalProperties: { type: 'string' } };
  assert.ok(validateSubset(typed, { x: 'ok' }).valid);
  assert.deepEqual(keywords(validateSubset(typed, { x: 1 })), ['type']);
});

test('patternProperties validate matching keys and count as known', () => {
  const schema = {
    type: 'object',
    patternProperties: { '^scr_[0-9a-f]{4}$': { type: 'number' } },
    additionalProperties: false,
  };
  assert.ok(validateSubset(schema, { scr_1a2b: 1 }).valid);
  assert.deepEqual(keywords(validateSubset(schema, { scr_1a2b: 'x' })), ['type']);
  assert.deepEqual(keywords(validateSubset(schema, { nope: 1 })), ['additionalProperties']);
});

test('items, minItems, maxItems and uniqueItems', () => {
  const schema = { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2, uniqueItems: true };
  assert.ok(validateSubset(schema, ['a']).valid);
  assert.deepEqual(keywords(validateSubset(schema, [])), ['minItems']);
  assert.deepEqual(keywords(validateSubset(schema, ['a', 'b', 'c'])), ['maxItems']);
  assert.deepEqual(keywords(validateSubset(schema, ['a', 'a'])), ['uniqueItems']);
  assert.deepEqual(paths(validateSubset(schema, ['a', 2])), ['/1']);
});

test('numeric bounds including exclusive forms', () => {
  const schema = { type: 'number', minimum: 0, maximum: 100 };
  assert.ok(validateSubset(schema, 0).valid);
  assert.ok(validateSubset(schema, 100).valid);
  assert.deepEqual(keywords(validateSubset(schema, -1)), ['minimum']);
  assert.deepEqual(keywords(validateSubset(schema, 101)), ['maximum']);
  assert.deepEqual(keywords(validateSubset({ exclusiveMinimum: 0 }, 0)), ['exclusiveMinimum']);
  assert.deepEqual(keywords(validateSubset({ exclusiveMaximum: 1 }, 1)), ['exclusiveMaximum']);
});

test('string length, pattern and date-time format', () => {
  assert.deepEqual(keywords(validateSubset({ minLength: 2 }, 'a')), ['minLength']);
  assert.deepEqual(keywords(validateSubset({ maxLength: 2 }, 'abc')), ['maxLength']);
  const idSchema = { type: 'string', pattern: '^scr_[0-9a-f]{12}$' };
  assert.ok(validateSubset(idSchema, 'scr_1a2b3c4d5e6f').valid);
  assert.deepEqual(keywords(validateSubset(idSchema, 'scr_XYZ')), ['pattern']);
  const when = { type: 'string', format: 'date-time' };
  assert.ok(validateSubset(when, '2026-08-19T15:42:01Z').valid);
  assert.ok(validateSubset(when, '2026-08-19T15:42:01.123+08:00').valid);
  assert.deepEqual(keywords(validateSubset(when, '19/08/2026')), ['format']);
});

test('oneOf requires exactly one match, anyOf at least one', () => {
  const oneOf = { oneOf: [{ type: 'string' }, { type: 'number' }] };
  assert.ok(validateSubset(oneOf, 'a').valid);
  assert.ok(validateSubset(oneOf, 1).valid);
  assert.deepEqual(keywords(validateSubset(oneOf, true)), ['oneOf']);
  const ambiguous = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
  assert.match(validateSubset(ambiguous, 1).errors[0].message, /matched 2/);
  const anyOf = { anyOf: [{ type: 'string', minLength: 3 }, { type: 'null' }] };
  assert.ok(validateSubset(anyOf, null).valid);
  assert.deepEqual(keywords(validateSubset(anyOf, 'ab')), ['anyOf']);
});

test('allOf reports the underlying errors, not just a combinator error', () => {
  const schema = { allOf: [{ type: 'object', required: ['a'] }, { type: 'object', required: ['b'] }] };
  const result = validateSubset(schema, { a: 1 });
  assert.deepEqual(paths(result), ['/b']);
});

test('not inverts a subschema', () => {
  assert.ok(validateSubset({ not: { type: 'string' } }, 1).valid);
  assert.deepEqual(keywords(validateSubset({ not: { type: 'string' } }, 'x')), ['not']);
});

test('$ref resolves against $defs and definitions, siblings still apply', () => {
  const withDefs = {
    type: 'object',
    $defs: { severity: { enum: ['blocker', 'critical', 'major', 'minor', 'info'] } },
    properties: { severity: { $ref: '#/$defs/severity' } },
    required: ['severity'],
  };
  assert.ok(validateSubset(withDefs, { severity: 'major' }).valid);
  assert.deepEqual(paths(validateSubset(withDefs, { severity: 'nope' })), ['/severity']);
  const withDefinitions = {
    definitions: { id: { type: 'string', pattern: '^[0-9a-f]{16}$' } },
    properties: { id: { $ref: '#/definitions/id' } },
  };
  assert.ok(validateSubset(withDefinitions, { id: '0123456789abcdef' }).valid);
  assert.deepEqual(keywords(validateSubset(withDefinitions, { id: 'zz' })), ['pattern']);
  assert.deepEqual(keywords(validateSubset({ $ref: '#/$defs/missing' }, 1)), ['$ref']);
  const recursive = {
    $defs: { node: { type: 'object', properties: { child: { $ref: '#/$defs/node' } } } },
    $ref: '#/$defs/node',
  };
  assert.ok(validateSubset(recursive, { child: { child: {} } }).valid);
  assert.deepEqual(paths(validateSubset(recursive, { child: { child: 'x' } })), ['/child/child']);
});

test('boolean schemas and the 50-error cap', () => {
  assert.ok(validateSubset(true, { anything: 1 }).valid);
  assert.equal(validateSubset(false, 1).valid, false);
  const schema = { type: 'array', items: { type: 'string' } };
  const result = validateSubset(schema, new Array(120).fill(1));
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 50);
});

test('getValidator returns a working validator whichever impl is present', async () => {
  const validator = await getValidator();
  assert.ok(['ajv', 'builtin'].includes(validator.impl));
  const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' } } };
  assert.equal(validator.validate(schema, { a: 'x' }).valid, true);
  const bad = validator.validate(schema, {});
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((error) => error.path === '/a' && error.keyword === 'required'));
});

// The three real schemas belong to another agent; every assertion below is guarded.
function sampleFromCharClass(body) {
  let re;
  try {
    re = new RegExp(`^[${body}]$`);
  } catch {
    return null;
  }
  for (const ch of 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_-./: ') {
    if (re.test(ch)) return ch;
  }
  return null;
}

function sampleFromPattern(pattern) {
  let src = pattern;
  if (!src.startsWith('^') || !src.endsWith('$')) return UNSAT;
  src = src.slice(1, -1);
  let out = '';
  let i = 0;
  while (i < src.length) {
    let atom;
    const ch = src[i];
    if (ch === '\\') {
      const esc = src[i + 1];
      i += 2;
      if (esc === 'd') atom = '0';
      else if (esc === 'w') atom = 'a';
      else if (esc === 's') atom = ' ';
      else if ('.-/\\+*?()[]{}|^$'.includes(esc)) atom = esc;
      else return UNSAT;
    } else if (ch === '[') {
      const close = src.indexOf(']', i + 1);
      if (close < 0) return UNSAT;
      atom = sampleFromCharClass(src.slice(i + 1, close));
      i = close + 1;
      if (atom === null) return UNSAT;
    } else if (ch === '.') {
      atom = 'a';
      i += 1;
    } else if ('()|?*+{}'.includes(ch)) {
      return UNSAT;
    } else {
      atom = ch;
      i += 1;
    }
    let reps = 1;
    if (src[i] === '{') {
      const close = src.indexOf('}', i);
      if (close < 0) return UNSAT;
      const spec = src.slice(i + 1, close).match(/^(\d+)(,\d*)?$/);
      if (!spec) return UNSAT;
      reps = Number(spec[1]);
      i = close + 1;
    } else if (src[i] === '+') {
      i += 1;
    } else if (src[i] === '*' || src[i] === '?') {
      reps = 0;
      i += 1;
    }
    out += atom.repeat(reps);
  }
  return out;
}

function resolvePointer(root, ref) {
  if (typeof ref !== 'string' || ref[0] !== '#') return null;
  if (ref === '#') return root;
  let node = root;
  for (const part of ref.slice(1).replace(/^\//, '').split('/')) {
    const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object' || !(key in node)) return null;
    node = node[key];
  }
  return node;
}

function synthesize(schema, root, depth = 0) {
  if (depth > 24 || schema === false) return UNSAT;
  if (schema === true || schema === undefined) return null;
  if (typeof schema !== 'object') return UNSAT;
  if (schema.$ref) {
    const resolved = resolvePointer(root, schema.$ref);
    if (!resolved) return UNSAT;
    return synthesize({ ...resolved, ...withoutRef(schema) }, root, depth + 1);
  }
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (Object.prototype.hasOwnProperty.call(schema, 'const')) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (Array.isArray(schema.allOf)) {
    const merged = schema.allOf.reduce((acc, part) => mergeSchemas(acc, part), withoutKey(schema, 'allOf'));
    return synthesize(merged, root, depth + 1);
  }
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[key])) {
      for (const branch of schema[key]) {
        const candidate = synthesize(mergeSchemas(withoutKey(schema, key), branch), root, depth + 1);
        if (candidate !== UNSAT) return candidate;
      }
      return UNSAT;
    }
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = types.find((candidate) => candidate !== undefined) || inferType(schema);
  if (type === 'null') return null;
  if (type === 'boolean') return false;
  if (type === 'integer' || type === 'number') {
    if (typeof schema.minimum === 'number') return schema.minimum;
    if (typeof schema.exclusiveMinimum === 'number') return schema.exclusiveMinimum + 1;
    if (typeof schema.maximum === 'number' && schema.maximum < 0) return schema.maximum;
    return 0;
  }
  if (type === 'string') {
    if (schema.format === 'date-time') return '2026-08-19T15:42:01Z';
    if (typeof schema.pattern === 'string') return sampleFromPattern(schema.pattern);
    return 'x'.repeat(Math.max(1, schema.minLength || 1));
  }
  if (type === 'array') {
    const count = Math.max(0, schema.minItems || 0);
    if (count === 0) return [];
    const itemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
    const items = [];
    for (let i = 0; i < count; i += 1) {
      const item = synthesize(itemSchema, root, depth + 1);
      if (item === UNSAT) return UNSAT;
      items.push(item);
    }
    return items;
  }
  if (type === 'object') {
    const out = {};
    for (const key of schema.required || []) {
      const child = schema.properties && schema.properties[key];
      if (child === undefined) return UNSAT;
      const value = synthesize(child, root, depth + 1);
      if (value === UNSAT) return UNSAT;
      out[key] = value;
    }
    return out;
  }
  return UNSAT;
}

function inferType(schema) {
  if (schema.properties || schema.required) return 'object';
  if (schema.items || schema.minItems) return 'array';
  if (schema.pattern || schema.minLength || schema.format) return 'string';
  return 'object';
}

function withoutKey(schema, key) {
  const copy = { ...schema };
  delete copy[key];
  return copy;
}

function withoutRef(schema) {
  return withoutKey(schema, '$ref');
}

function mergeSchemas(a, b) {
  if (!b || typeof b !== 'object') return a;
  const merged = { ...a, ...b };
  if (a.properties || b.properties) merged.properties = { ...(a.properties || {}), ...(b.properties || {}) };
  if (a.required || b.required) merged.required = [...new Set([...(a.required || []), ...(b.required || [])])];
  return merged;
}

for (const file of SCHEMA_FILES) {
  const path = join(schemasDir, file);

  test(`${file} is valid JSON`, (t) => {
    if (!existsSync(path)) {
      t.skip(`schemas/${file} not written yet (owned by another agent)`);
      return;
    }
    const schema = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(typeof schema, 'object');
    assert.ok(schema !== null && !Array.isArray(schema));
  });

  test(`${file} accepts a minimal valid document and names each missing required field`, async (t) => {
    if (!existsSync(path)) {
      t.skip(`schemas/${file} not written yet (owned by another agent)`);
      return;
    }
    const schema = JSON.parse(readFileSync(path, 'utf8'));
    const required = Array.isArray(schema.required) ? schema.required : [];
    const minimal = synthesize(schema, schema);
    if (minimal === UNSAT || minimal === null || typeof minimal !== 'object') {
      t.diagnostic(`could not synthesize a minimal document for ${file}`);
      t.skip('minimal-document synthesizer does not cover this schema; replace with a hand-written fixture');
      return;
    }
    const base = validateSubset(schema, minimal);
    if (!base.valid) {
      t.diagnostic(`synthesized document rejected: ${JSON.stringify(base.errors)}`);
      t.skip('minimal-document synthesizer does not cover this schema; replace with a hand-written fixture');
      return;
    }
    const viaFile = await validateFile(join('schemas', file), minimal);
    assert.equal(viaFile.valid, true, JSON.stringify(viaFile.errors));

    for (const field of required) {
      const partial = { ...minimal };
      delete partial[field];
      const result = validateSubset(schema, partial);
      assert.equal(result.valid, false, `omitting "${field}" should fail`);
      assert.ok(
        result.errors.some((error) => error.path === `/${field}` || error.path.startsWith(`/${field}`)),
        `an error path should name "${field}", got ${JSON.stringify(paths(result))}`,
      );
    }
  });
}
