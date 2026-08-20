// Dependency-free JSON Schema validator covering exactly the subset our own schemas use.
//
// ponytail: subset validator, not a spec-complete implementation. Supported keywords:
// type (incl. arrays and 'null'), enum, const, required, properties, additionalProperties,
// patternProperties, items, minItems, maxItems, uniqueItems, minimum, maximum,
// exclusiveMinimum/Maximum, minLength, maxLength, pattern, oneOf, anyOf, allOf, not,
// local $ref (#/$defs/... and #/definitions/...) and format 'date-time' (permissive).
// Everything else (if/then/else, dependentRequired, unevaluated*, remote $ref, other formats)
// is ignored, not rejected. Upgrade path: install ajv and getValidator() uses it automatically.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { EXIT, fail } from './errors.mjs';
import { skillRoot } from './paths.mjs';

const MAX_ERRORS = 50;
const MAX_REF_DEPTH = 64;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})?$/;

/** Validate data against a JSON Schema subset; returns {valid, errors[<=50]}. */
export function validateSubset(schema, data) {
  const ctx = { root: schema, errors: [], limit: MAX_ERRORS };
  check(schema, data, '', ctx, 0);
  return { valid: ctx.errors.length === 0, errors: ctx.errors };
}

/** Resolve a validator, preferring ajv when it is installed, else the builtin subset. */
export async function getValidator() {
  try {
    const mod = await import('ajv');
    const Ajv = mod.default || mod.Ajv || mod;
    const ajv = new Ajv({ allErrors: true, strict: false });
    const cache = new WeakMap();
    return {
      validate(schema, data) {
        let fn = cache.get(schema);
        if (!fn) {
          try {
            fn = ajv.compile(schema);
            cache.set(schema, fn);
          } catch {
            return validateSubset(schema, data);
          }
        }
        const valid = fn(data);
        return { valid, errors: valid ? [] : mapAjvErrors(fn.errors).slice(0, MAX_ERRORS) };
      },
      impl: 'ajv',
    };
  } catch {
    // No ajv on this machine; the builtin subset validator is the baseline.
  }
  return { validate: (schema, data) => validateSubset(schema, data), impl: 'builtin' };
}

/** Validate data against a schema file resolved relative to the skill root. */
export async function validateFile(schemaPath, data) {
  const abs = isAbsolute(schemaPath) ? schemaPath : resolve(skillRoot(), schemaPath);
  if (!existsSync(abs)) fail(`schema not found: ${schemaPath}`, EXIT.CONFIG, { path: abs });
  let schema;
  try {
    schema = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (error) {
    fail(`schema is not valid JSON: ${schemaPath} (${error.message})`, EXIT.CONFIG, { path: abs });
  }
  const validator = await getValidator();
  const result = validator.validate(schema, data);
  return { valid: result.valid, errors: result.errors, impl: validator.impl, schema_path: abs };
}

function mapAjvErrors(errors) {
  return (errors || []).map((error) => ({
    path: error.keyword === 'required'
      ? `${error.instancePath}/${error.params.missingProperty}`
      : error.instancePath,
    message: error.message,
    keyword: error.keyword,
  }));
}

function pushError(ctx, path, message, keyword) {
  if (ctx.errors.length >= ctx.limit) return;
  ctx.errors.push({ path, message, keyword });
}

function segment(path, key) {
  return `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value, type) {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

function isValid(schema, data, root, depth) {
  const ctx = { root, errors: [], limit: 1 };
  check(schema, data, '', ctx, depth);
  return ctx.errors.length === 0;
}

function resolveRef(ref, ctx, path) {
  if (typeof ref !== 'string' || ref[0] !== '#') {
    pushError(ctx, path, `unsupported $ref "${ref}" (only local # refs are supported)`, '$ref');
    return null;
  }
  if (ref === '#') return ctx.root;
  const parts = ref.slice(1).replace(/^\//, '').split('/');
  let node = ctx.root;
  for (const part of parts) {
    const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object' || !(key in node)) {
      pushError(ctx, path, `cannot resolve $ref "${ref}"`, '$ref');
      return null;
    }
    node = node[key];
  }
  return node;
}

function safeRegExp(pattern, ctx, path, keyword) {
  try {
    return new RegExp(pattern, 'u');
  } catch {
    try {
      return new RegExp(pattern);
    } catch {
      pushError(ctx, path, `schema contains an invalid regular expression "${pattern}"`, keyword);
      return null;
    }
  }
}

function check(schema, data, path, ctx, depth) {
  if (ctx.errors.length >= ctx.limit) return;
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    pushError(ctx, path, 'value is not allowed here', 'false');
    return;
  }
  if (typeof schema !== 'object' || Array.isArray(schema)) return;

  if (schema.$ref !== undefined) {
    if (depth > MAX_REF_DEPTH) {
      pushError(ctx, path, '$ref recursion limit exceeded', '$ref');
      return;
    }
    const resolved = resolveRef(schema.$ref, ctx, path);
    if (resolved === null) return;
    check(resolved, data, path, ctx, depth + 1);
  }

  checkCombinators(schema, data, path, ctx, depth);
  checkType(schema, data, path, ctx);
  checkEnum(schema, data, path, ctx);
  checkObject(schema, data, path, ctx, depth);
  checkArray(schema, data, path, ctx, depth);
  checkNumber(schema, data, path, ctx);
  checkString(schema, data, path, ctx);
}

function checkCombinators(schema, data, path, ctx, depth) {
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) check(sub, data, path, ctx, depth);
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((sub) => isValid(sub, data, ctx.root, depth));
    if (!matched) {
      pushError(ctx, path, `must match at least one of ${schema.anyOf.length} schemas${closestReason(schema.anyOf, data, ctx, depth)}`, 'anyOf');
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const count = schema.oneOf.filter((sub) => isValid(sub, data, ctx.root, depth)).length;
    if (count !== 1) {
      const why = count === 0 ? closestReason(schema.oneOf, data, ctx, depth) : '';
      pushError(ctx, path, `must match exactly one of ${schema.oneOf.length} schemas (matched ${count})${why}`, 'oneOf');
    }
  }
  if (schema.not !== undefined && isValid(schema.not, data, ctx.root, depth)) {
    pushError(ctx, path, 'must not match the "not" schema', 'not');
  }
}

/**
 * Explain a failed oneOf/anyOf by quoting the branch that came closest. Without this a
 * combinator failure says only "matched 0", which does not tell the caller what to fix.
 */
function closestReason(branches, data, ctx, depth) {
  let best = null;
  for (const branch of branches) {
    const probe = { root: ctx.root, errors: [], limit: 6 };
    check(branch, data, '', probe, depth);
    if (probe.errors.length === 0) continue;
    if (!best || probe.errors.length < best.length) best = probe.errors;
  }
  if (!best) return '';
  const reasons = best.map((error) => `${error.path || '(root)'} ${error.message}`).join('; ');
  return ` — closest branch failed: ${reasons}`;
}

function checkType(schema, data, path, ctx) {
  if (schema.type === undefined) return;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((type) => matchesType(data, type))) {
    pushError(ctx, path, `must be ${types.join(' or ')} but was ${typeName(data)}`, 'type');
  }
}

function checkEnum(schema, data, path, ctx) {
  if (Array.isArray(schema.enum) && !schema.enum.some((value) => deepEqual(value, data))) {
    pushError(ctx, path, `must be one of ${JSON.stringify(schema.enum)}`, 'enum');
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !deepEqual(schema.const, data)) {
    pushError(ctx, path, `must equal ${JSON.stringify(schema.const)}`, 'const');
  }
}

function checkObject(schema, data, path, ctx, depth) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return;
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) {
        pushError(ctx, segment(path, key), `missing required property "${key}"`, 'required');
      }
    }
  }
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
  const patterns = schema.patternProperties && typeof schema.patternProperties === 'object'
    ? Object.keys(schema.patternProperties)
    : [];
  for (const key of Object.keys(data)) {
    const childPath = segment(path, key);
    let known = false;
    if (properties && Object.prototype.hasOwnProperty.call(properties, key)) {
      known = true;
      check(properties[key], data[key], childPath, ctx, depth);
    }
    for (const pattern of patterns) {
      const re = safeRegExp(pattern, ctx, path, 'patternProperties');
      if (re && re.test(key)) {
        known = true;
        check(schema.patternProperties[pattern], data[key], childPath, ctx, depth);
      }
    }
    if (known || schema.additionalProperties === undefined) continue;
    if (schema.additionalProperties === false) {
      pushError(ctx, childPath, `property "${key}" is not allowed`, 'additionalProperties');
      continue;
    }
    check(schema.additionalProperties, data[key], childPath, ctx, depth);
  }
}

function checkArray(schema, data, path, ctx, depth) {
  if (!Array.isArray(data)) return;
  if (typeof schema.minItems === 'number' && data.length < schema.minItems) {
    pushError(ctx, path, `must have at least ${schema.minItems} items but had ${data.length}`, 'minItems');
  }
  if (typeof schema.maxItems === 'number' && data.length > schema.maxItems) {
    pushError(ctx, path, `must have at most ${schema.maxItems} items but had ${data.length}`, 'maxItems');
  }
  if (schema.uniqueItems === true) {
    const seen = new Set();
    for (const item of data) {
      const key = JSON.stringify(item);
      if (seen.has(key)) {
        pushError(ctx, path, 'must not contain duplicate items', 'uniqueItems');
        break;
      }
      seen.add(key);
    }
  }
  if (schema.items === undefined) return;
  if (Array.isArray(schema.items)) {
    for (let i = 0; i < data.length && i < schema.items.length; i += 1) {
      check(schema.items[i], data[i], segment(path, i), ctx, depth);
    }
    return;
  }
  for (let i = 0; i < data.length; i += 1) {
    check(schema.items, data[i], segment(path, i), ctx, depth);
  }
}

function checkNumber(schema, data, path, ctx) {
  if (typeof data !== 'number') return;
  if (typeof schema.minimum === 'number' && data < schema.minimum) {
    pushError(ctx, path, `must be >= ${schema.minimum}`, 'minimum');
  }
  if (typeof schema.maximum === 'number' && data > schema.maximum) {
    pushError(ctx, path, `must be <= ${schema.maximum}`, 'maximum');
  }
  if (typeof schema.exclusiveMinimum === 'number' && data <= schema.exclusiveMinimum) {
    pushError(ctx, path, `must be > ${schema.exclusiveMinimum}`, 'exclusiveMinimum');
  }
  if (typeof schema.exclusiveMaximum === 'number' && data >= schema.exclusiveMaximum) {
    pushError(ctx, path, `must be < ${schema.exclusiveMaximum}`, 'exclusiveMaximum');
  }
}

function checkString(schema, data, path, ctx) {
  if (typeof data !== 'string') return;
  const length = Array.from(data).length;
  if (typeof schema.minLength === 'number' && length < schema.minLength) {
    pushError(ctx, path, `must be at least ${schema.minLength} characters`, 'minLength');
  }
  if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
    pushError(ctx, path, `must be at most ${schema.maxLength} characters`, 'maxLength');
  }
  if (typeof schema.pattern === 'string') {
    const re = safeRegExp(schema.pattern, ctx, path, 'pattern');
    if (re && !re.test(data)) {
      pushError(ctx, path, `must match pattern ${schema.pattern}`, 'pattern');
    }
  }
  if (schema.format === 'date-time' && !DATE_TIME.test(data)) {
    pushError(ctx, path, 'must be an ISO 8601 date-time string', 'format');
  }
}
