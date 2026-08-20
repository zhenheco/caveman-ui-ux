// Documented YAML subset parser and emitter (contract §5, §19). Zero dependencies.
//
// ponytail: hand-rolled YAML subset — swap in the `yaml` package if a project provides it
// (see loadYamlParser). Ceiling: no block scalars (| >), no anchors/aliases (& *), no tags,
// no multi-document streams, no multi-line plain scalars, indentation must be a multiple of 2.
// YAML 1.1 yes/no parse as booleans, so a bare locale code like `no` needs quotes.
// Upgrade path: loadYamlParser() returns the real `yaml` package whenever it resolves.

import { readFileSync } from 'node:fs';
import { EXIT, fail } from './errors.mjs';

/** Parse the supported YAML subset into plain JS values. */
export function parseYaml(text) {
  const lines = tokenize(text);
  if (lines.length === 0) return null;
  const first = lines[0];
  if (first.indent !== 0) yamlFail(first.lineNo, 'unexpected indentation at document start');
  if (lines.length === 1 && !isSeqLine(first.content) && findKeySeparator(first.content) < 0) {
    return parseValue(first.content, first.lineNo);
  }
  const state = makeState(lines);
  const value = parseNode(state, 0);
  const leftover = state.peek();
  if (leftover) yamlFail(leftover.lineNo, `unexpected content "${leftover.content}"`);
  return value;
}

/** Read and parse a YAML file, decorating parse errors with the file path. */
export function parseYamlFile(path) {
  const text = readFileSync(path, 'utf8');
  try {
    return parseYaml(text);
  } catch (error) {
    if (error && error.name === 'CavemanError') {
      error.message = `${path}: ${error.message}`;
      error.details = { ...error.details, path };
    }
    throw error;
  }
}

/** Emit a value as YAML restricted to the same subset parseYaml understands. */
export function stringifyYaml(value) {
  let lines;
  if (isMap(value)) lines = Object.keys(value).length ? emitMap(value, 0) : ['{}'];
  else if (Array.isArray(value)) lines = value.length ? emitSeq(value, 0) : ['[]'];
  else lines = [emitScalar(value)];
  return `${lines.join('\n')}\n`;
}

/** Resolve a YAML parser, preferring the real `yaml` package when it is installed. */
export async function loadYamlParser() {
  try {
    const mod = await import('yaml');
    const parse = typeof mod.parse === 'function' ? mod.parse : mod.default && mod.default.parse;
    if (typeof parse === 'function') return { parse: (text) => parse(text), impl: 'yaml' };
  } catch {
    // No `yaml` package on this machine; the hand-rolled subset is the baseline.
  }
  return { parse: parseYaml, impl: 'builtin' };
}

function yamlFail(lineNo, message, details = {}) {
  fail(`YAML line ${lineNo}: ${message}`, EXIT.CONFIG, { line: lineNo, ...details });
}

function tokenize(text) {
  const out = [];
  const raw = String(text).split(/\r\n|\r|\n/);
  let sawDocStart = false;
  for (let index = 0; index < raw.length; index += 1) {
    const lineNo = index + 1;
    const line = raw[index];
    const lead = line.match(/^[ \t]*/)[0];
    if (lead.includes('\t')) yamlFail(lineNo, 'tab indentation is not supported (use 2 spaces)');
    const stripped = stripComment(line).replace(/\s+$/, '');
    const content = stripped.slice(lead.length);
    if (content === '') continue;
    if (content === '---' && out.length === 0 && !sawDocStart) {
      sawDocStart = true;
      continue;
    }
    if (content === '---' || content.startsWith('--- ') || content === '...') {
      yamlFail(lineNo, 'multi-document YAML (--- / ...) is not supported');
    }
    if (lead.length % 2 !== 0) {
      yamlFail(lineNo, `odd indentation (${lead.length} spaces); use multiples of 2`);
    }
    out.push({ indent: lead.length, content, lineNo });
  }
  return out;
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) return line.slice(0, i);
  }
  return line;
}

function makeState(lines) {
  return {
    lines,
    i: 0,
    peek() {
      return this.i < this.lines.length ? this.lines[this.i] : null;
    },
    next() {
      const line = this.lines[this.i];
      this.i += 1;
      return line;
    },
    insert(line) {
      this.lines.splice(this.i, 0, line);
    },
  };
}

function isSeqLine(content) {
  return content === '-' || content.startsWith('- ');
}

function isMap(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function parseNode(state, indent) {
  const line = state.peek();
  if (!line || line.indent < indent) return null;
  if (isSeqLine(line.content)) return parseSeq(state, indent);
  return parseMap(state, indent);
}

function parseMap(state, indent) {
  const map = {};
  const seen = new Set();
  for (;;) {
    const line = state.peek();
    if (!line || line.indent < indent) break;
    if (line.indent > indent) {
      yamlFail(line.lineNo, `unexpected indentation (${line.indent} spaces, expected ${indent})`);
    }
    if (isSeqLine(line.content)) break;
    const sep = findKeySeparator(line.content);
    if (sep < 0) yamlFail(line.lineNo, `expected "key: value" but found "${line.content}"`);
    const key = parseKey(line.content.slice(0, sep), line.lineNo);
    if (seen.has(key)) yamlFail(line.lineNo, `duplicate key "${key}" in the same map`, { key });
    seen.add(key);
    const rest = line.content.slice(sep + 1).trim();
    state.next();
    if (rest !== '') {
      map[key] = parseValue(rest, line.lineNo);
      continue;
    }
    const child = state.peek();
    if (child && child.indent > indent) map[key] = parseNode(state, child.indent);
    else if (child && child.indent === indent && isSeqLine(child.content)) map[key] = parseSeq(state, indent);
    else map[key] = null;
  }
  return map;
}

function parseSeq(state, indent) {
  const arr = [];
  for (;;) {
    const line = state.peek();
    if (!line || line.indent < indent) break;
    if (line.indent > indent) {
      yamlFail(line.lineNo, `unexpected indentation (${line.indent} spaces, expected ${indent})`);
    }
    if (!isSeqLine(line.content)) break;
    state.next();
    let rest = '';
    let offset = 1;
    if (line.content !== '-') {
      const after = line.content.slice(1);
      rest = after.replace(/^ +/, '');
      offset = 1 + (after.length - rest.length);
    }
    if (rest === '') {
      const child = state.peek();
      if (child && child.indent > indent) arr.push(parseNode(state, child.indent));
      else arr.push(null);
      continue;
    }
    const virtualIndent = indent + offset;
    if (isSeqLine(rest)) {
      state.insert({ indent: virtualIndent, content: rest, lineNo: line.lineNo });
      arr.push(parseSeq(state, virtualIndent));
      continue;
    }
    if (findKeySeparator(rest) >= 0) {
      state.insert({ indent: virtualIndent, content: rest, lineNo: line.lineNo });
      arr.push(parseMap(state, virtualIndent));
      continue;
    }
    arr.push(parseValue(rest, line.lineNo));
  }
  return arr;
}

function findKeySeparator(content) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (quote) {
      if (quote === '"' && ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ']' || ch === '}') {
      depth -= 1;
      continue;
    }
    if (ch === ':' && depth === 0 && (i === content.length - 1 || content[i + 1] === ' ')) return i;
  }
  return -1;
}

function parseKey(raw, lineNo) {
  const text = raw.trim();
  if (text === '') yamlFail(lineNo, 'empty map key');
  if (text[0] === '&' || text[0] === '*') {
    yamlFail(lineNo, 'anchors and aliases (& and *) are not supported');
  }
  if (text[0] === '"' || text[0] === '\'') {
    const { value, end } = readQuoted(text, 0, lineNo);
    if (text.slice(end).trim() !== '') yamlFail(lineNo, 'unexpected content after a quoted key');
    return value;
  }
  return text;
}

function parseValue(raw, lineNo) {
  const text = raw.trim();
  if (text === '') return null;
  const head = text[0];
  if (head === '|' || head === '>') {
    yamlFail(lineNo, 'block scalars (| and >) are not supported; use a quoted single-line string');
  }
  if (head === '&' || head === '*') {
    yamlFail(lineNo, 'anchors and aliases (& and *) are not supported');
  }
  if (head === '[' || head === '{') return parseFlow(text, lineNo);
  if (head === '"' || head === '\'') {
    const { value, end } = readQuoted(text, 0, lineNo);
    if (text.slice(end).trim() !== '') yamlFail(lineNo, 'unexpected content after a quoted scalar');
    return value;
  }
  return coerceScalar(text);
}

function coerceScalar(text) {
  if (text === '~' || /^(null|Null|NULL)$/.test(text)) return null;
  if (/^(true|True|TRUE|yes|Yes|YES)$/.test(text)) return true;
  if (/^(false|False|FALSE|no|No|NO)$/.test(text)) return false;
  if (/^[-+]?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(text)) return Number.parseFloat(text);
  return text;
}

function readQuoted(text, start, lineNo) {
  const quote = text[start];
  let out = '';
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (quote === '\'') {
      if (ch === '\'') {
        if (text[i + 1] === '\'') {
          out += '\'';
          i += 2;
          continue;
        }
        return { value: out, end: i + 1 };
      }
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      const esc = text[i + 1];
      i += 2;
      if (esc === undefined) yamlFail(lineNo, 'unterminated escape in a double-quoted string');
      if (esc === 'n') out += '\n';
      else if (esc === 't') out += '\t';
      else if (esc === 'r') out += '\r';
      else if (esc === 'b') out += '\b';
      else if (esc === 'f') out += '\f';
      else if (esc === 'u') {
        const hex = text.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) yamlFail(lineNo, 'invalid unicode escape in a double-quoted string');
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
      } else out += esc;
      continue;
    }
    if (ch === '"') return { value: out, end: i + 1 };
    out += ch;
    i += 1;
  }
  return yamlFail(lineNo, 'unterminated quoted string');
}

function parseFlow(text, lineNo) {
  const state = { text, i: 0, lineNo };
  const value = parseFlowValue(state);
  skipFlowWs(state);
  if (state.i < state.text.length) {
    yamlFail(lineNo, `unexpected content after a flow collection: "${state.text.slice(state.i)}"`);
  }
  return value;
}

function skipFlowWs(state) {
  while (state.i < state.text.length && (state.text[state.i] === ' ' || state.text[state.i] === '\t')) {
    state.i += 1;
  }
}

function parseFlowValue(state) {
  skipFlowWs(state);
  const ch = state.text[state.i];
  if (ch === undefined) yamlFail(state.lineNo, 'unexpected end of flow collection');
  if (ch === '[') return parseFlowSeq(state);
  if (ch === '{') return parseFlowMap(state);
  if (ch === '"' || ch === '\'') {
    const { value, end } = readQuoted(state.text, state.i, state.lineNo);
    state.i = end;
    return value;
  }
  return coerceScalar(readFlowPlain(state));
}

function readFlowPlain(state) {
  const start = state.i;
  while (state.i < state.text.length && !',]}'.includes(state.text[state.i])) state.i += 1;
  const raw = state.text.slice(start, state.i).trim();
  if (raw === '') yamlFail(state.lineNo, 'empty value in a flow collection');
  if (raw[0] === '&' || raw[0] === '*') {
    yamlFail(state.lineNo, 'anchors and aliases (& and *) are not supported');
  }
  if (raw[0] === '|' || raw[0] === '>') {
    yamlFail(state.lineNo, 'block scalars (| and >) are not supported; use a quoted single-line string');
  }
  return raw;
}

function parseFlowSeq(state) {
  state.i += 1;
  const arr = [];
  skipFlowWs(state);
  if (state.text[state.i] === ']') {
    state.i += 1;
    return arr;
  }
  for (;;) {
    arr.push(parseFlowValue(state));
    skipFlowWs(state);
    const ch = state.text[state.i];
    if (ch === ',') {
      state.i += 1;
      skipFlowWs(state);
      if (state.text[state.i] === ']') {
        state.i += 1;
        return arr;
      }
      continue;
    }
    if (ch === ']') {
      state.i += 1;
      return arr;
    }
    yamlFail(state.lineNo, 'expected "," or "]" in a flow sequence');
  }
}

function parseFlowMap(state) {
  state.i += 1;
  const map = {};
  const seen = new Set();
  skipFlowWs(state);
  if (state.text[state.i] === '}') {
    state.i += 1;
    return map;
  }
  for (;;) {
    skipFlowWs(state);
    const key = readFlowKey(state);
    if (seen.has(key)) yamlFail(state.lineNo, `duplicate key "${key}" in the same map`, { key });
    seen.add(key);
    skipFlowWs(state);
    if (state.text[state.i] !== ':') {
      yamlFail(state.lineNo, `expected ":" after flow map key "${key}"`);
    }
    state.i += 1;
    map[key] = parseFlowValue(state);
    skipFlowWs(state);
    const ch = state.text[state.i];
    if (ch === ',') {
      state.i += 1;
      skipFlowWs(state);
      if (state.text[state.i] === '}') {
        state.i += 1;
        return map;
      }
      continue;
    }
    if (ch === '}') {
      state.i += 1;
      return map;
    }
    yamlFail(state.lineNo, 'expected "," or "}" in a flow map');
  }
}

function readFlowKey(state) {
  const ch = state.text[state.i];
  if (ch === '"' || ch === '\'') {
    const { value, end } = readQuoted(state.text, state.i, state.lineNo);
    state.i = end;
    return value;
  }
  const start = state.i;
  while (state.i < state.text.length && !':,}'.includes(state.text[state.i])) state.i += 1;
  const key = state.text.slice(start, state.i).trim();
  if (key === '') yamlFail(state.lineNo, 'empty key in a flow map');
  return key;
}

function emitMap(map, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  for (const key of Object.keys(map)) {
    const value = map[key];
    if (value === undefined) continue;
    const label = `${pad}${emitKey(key)}`;
    if (isMap(value)) {
      if (Object.keys(value).length === 0) out.push(`${label}: {}`);
      else {
        out.push(`${label}:`);
        out.push(...emitMap(value, indent + 2));
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) out.push(`${label}: []`);
      else if (value.every(isScalar)) out.push(`${label}: ${emitFlowSeq(value)}`);
      else {
        out.push(`${label}:`);
        out.push(...emitSeq(value, indent + 2));
      }
      continue;
    }
    out.push(`${label}: ${emitScalar(value)}`);
  }
  return out;
}

function emitSeq(arr, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  for (const item of arr) {
    if (isMap(item) && Object.keys(item).length > 0) {
      const block = emitMap(item, indent + 2);
      out.push(`${pad}- ${block[0].slice(indent + 2)}`);
      out.push(...block.slice(1));
      continue;
    }
    if (Array.isArray(item) && item.length > 0 && !item.every(isScalar)) {
      const block = emitSeq(item, indent + 2);
      out.push(`${pad}- ${block[0].slice(indent + 2)}`);
      out.push(...block.slice(1));
      continue;
    }
    if (isMap(item)) {
      out.push(`${pad}- {}`);
      continue;
    }
    if (Array.isArray(item)) {
      out.push(`${pad}- ${item.length === 0 ? '[]' : emitFlowSeq(item)}`);
      continue;
    }
    out.push(`${pad}- ${emitScalar(item === undefined ? null : item)}`);
  }
  return out;
}

function emitFlowSeq(arr) {
  return `[${arr.map((item) => emitScalar(item)).join(', ')}]`;
}

function emitKey(key) {
  const text = String(key);
  return needsQuote(text) ? JSON.stringify(text) : text;
}

function emitScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  const text = String(value);
  return needsQuote(text) ? JSON.stringify(text) : text;
}

function needsQuote(text) {
  if (text === '') return true;
  if (text !== text.trim()) return true;
  if (/[:#[\]{},&*!|>'"%@`\n\r\t]/.test(text)) return true;
  if (/^[-?]/.test(text)) return true;
  return coerceScalar(text) !== text;
}
