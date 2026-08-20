// Canonical path resolution for the skill bundle, the user state dir and run artifacts.
// Contract §3 — never hardcode an absolute home path; everything derives from
// import.meta.url, process.env or the target project cwd.

import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDirs } from './fsx.mjs';

export const ROOT_DIR_NAME = '.caveman-ui-ux';

/** Absolute path of the skill bundle root (the parent of scripts/). */
export function skillRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Absolute path of the per-user state dir (axe cache, misc caches). */
export function stateDir() {
  return process.env.CAVEMAN_STATE_DIR || join(homedir(), '.claude', 'state', 'caveman-ui-ux');
}

/** Absolute path of .caveman-ui-ux inside the audited project. */
export function rootDir(cwd) {
  return join(resolveCwd(cwd), ROOT_DIR_NAME);
}

/** Absolute path of the runs container. */
export function runsDir(cwd) {
  return join(rootDir(cwd), 'runs');
}

/** Absolute path of one run directory. */
export function runDir(cwd, runId) {
  return join(runsDir(cwd), runId);
}

/** Absolute path of one screen directory inside a run. */
export function screenDir(cwd, runId, screenId) {
  return join(runDir(cwd, runId), 'screens', screenId);
}

/** Absolute path of the adapter install manifest. */
export function installManifestPath(cwd) {
  return join(rootDir(cwd), 'install-manifest.json');
}

/** Newest run id (directory names sort chronologically) or null when there is none. */
export function latestRunId(cwd) {
  const ids = listDirs(runsDir(cwd)).filter((name) => name.startsWith('run_'));
  return ids.length ? ids[ids.length - 1] : null;
}

/** Path relative to cwd using forward slashes, for stable artifact contents. */
export function relToCwd(cwd, abs) {
  const base = resolveCwd(cwd);
  const target = isAbsolute(abs) ? abs : resolve(base, abs);
  return relative(base, target).split(sep).join('/');
}

function resolveCwd(cwd) {
  return resolve(cwd || process.cwd());
}
