// Filesystem + hashing helpers. Sync everywhere it is simple; node:fs and node:crypto only.

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** Create a directory (and parents) if it does not exist yet; returns the path. */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** True when the path exists. */
export function exists(path) {
  return existsSync(path);
}

/** Read a UTF-8 text file. */
export function readText(path) {
  return readFileSync(path, 'utf8');
}

/** Write a UTF-8 text file, creating parent directories as needed. */
export function writeText(path, text) {
  ensureDir(dirname(path));
  writeFileSync(path, text, 'utf8');
  return path;
}

/** Read and JSON.parse a file. */
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Write a value as 2-space-indented JSON with a trailing newline, creating parents. */
export function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

/** Deterministic key-sorted JSON string, used for config and content hashing. */
export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

/** sha256 hex digest of a string. */
export function sha256(str) {
  return createHash('sha256').update(String(str), 'utf8').digest('hex');
}

/** sha256 hex digest of a file's bytes. */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Sorted names of the immediate subdirectories of a path ([] when it does not exist). */
export function listDirs(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Recursively delete a path, ignoring absence. */
export function rmrf(path) {
  rmSync(path, { recursive: true, force: true });
  return path;
}

/** Copy one file, comparing content hashes: created | updated | skipped. */
export function copyFileHashed(src, dest) {
  const buf = readFileSync(src);
  const hash = createHash('sha256').update(buf).digest('hex');
  if (existsSync(dest)) {
    if (sha256File(dest) === hash) return { action: 'skipped', sha256: hash };
    writeFileSync(dest, buf);
    return { action: 'updated', sha256: hash };
  }
  ensureDir(dirname(dest));
  writeFileSync(dest, buf);
  return { action: 'created', sha256: hash };
}

/** Recursively copy a directory, returning one {path, relative, action, sha256} per file. */
export function copyTree(srcDir, destDir) {
  const results = [];
  walk(srcDir, destDir, '', results);
  return results;
}

function walk(srcDir, destDir, prefix, results) {
  if (!existsSync(srcDir)) return;
  for (const entry of readdirSync(srcDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    // .DS_Store is macOS noise that would otherwise land inside every installed bundle.
    if (entry.name === '.DS_Store') continue;
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      ensureDir(dest);
      walk(src, dest, relative, results);
      continue;
    }
    if (!entry.isFile() && !statSync(src).isFile()) continue;
    const { action, sha256: hash } = copyFileHashed(src, dest);
    results.push({ path: dest, relative, action, sha256: hash });
  }
}
