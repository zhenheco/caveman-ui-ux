// Retention sweep for privacy.retention_days. Contract §3 defines the run layout; ADR-002
// forces a second copy of every screenshot into the per-user state dir (identity-free path),
// so a sweep that only walks .caveman-ui-ux/runs/ leaves full-fidelity screenshots of the
// audited UI in $HOME forever. This module owns both roots and nothing else.
// Age comes from the run id timestamp, never from mtime: copying, restoring or `touch`ing a
// run dir must not resurrect an expired run.

import { readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { runsDir, stateDir } from './paths.mjs';

const RUN_ID_RE = /^run_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_[0-9a-f]{6}$/;
const DAY_MS = 86400000;

/** Absolute path of the identity-free staging dir holding one run's blind screenshots. */
export function stagedBlindDir(runId) {
  return join(stateDir(), 'blind', runId);
}

/** UTC epoch ms encoded in a run id, or null when the name is not a well-formed run id. */
function runIdTime(runId) {
  const match = RUN_ID_RE.exec(runId);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (!Number.isFinite(ms)) return null;
  // Round-trip guard: Date.UTC silently rolls month 13 or day 32 over into a plausible date.
  const stamp = new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return stamp === `${y}${mo}${d}T${h}${mi}${s}Z` ? ms : null;
}

/** Immediate subdirectory names of a path, sorted; [] when it does not exist. Skips symlinks. */
function subdirs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

/** Total bytes of the regular files under a directory; best effort, 0 when unreadable. */
function dirBytes(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirBytes(path);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      total += statSync(path).size;
    } catch {
      // Vanished between readdir and stat; nothing to count.
    }
  }
  return total;
}

/** Delete one directory only after proving it resolves inside `root`; null when refused. */
function removeInside(root, dir) {
  let realRoot;
  let realDir;
  try {
    realRoot = realpathSync(root);
    realDir = realpathSync(dir);
  } catch {
    return null;
  }
  // The guard, not the caller, is what keeps rm inside the two roots we own: a symlinked or
  // crafted entry resolves outside `root` and is skipped instead of deleted.
  if (realDir === realRoot || !realDir.startsWith(realRoot + sep)) return null;
  const bytes = dirBytes(realDir);
  rmSync(realDir, { recursive: true, force: true });
  return bytes;
}

/** Delete runs older than retentionDays plus their staged blind screenshots. */
export function pruneRuns({ cwd, retentionDays, now = new Date(), log } = {}) {
  const result = { removedRuns: [], removedStaged: [], freedBytes: 0 };
  const days = Number(retentionDays);
  const nowMs = new Date(now).getTime();
  // retention_days <= 0 (or unset/garbage) means the sweep is disabled, not "delete everything".
  if (!Number.isFinite(days) || days <= 0 || !Number.isFinite(nowMs)) return result;
  const cutoff = nowMs - days * DAY_MS;
  const note = typeof log === 'function' ? log : () => {};

  const runsRoot = runsDir(cwd);
  for (const runId of subdirs(runsRoot)) {
    const time = runIdTime(runId);
    // Unparseable name: not ours to delete.
    if (time === null || time >= cutoff) continue;
    const bytes = removeInside(runsRoot, join(runsRoot, runId));
    if (bytes === null) continue;
    result.removedRuns.push(runId);
    result.freedBytes += bytes;
    note(`retention: removed run ${runId}`);
  }

  // Staged screenshots outlive their run: sweep every staging dir whose run is gone from this
  // project, which also covers the runs just deleted above.
  // ponytail: stateDir() is shared across projects, so a run staged by another project reads as
  // an orphan here and gets reclaimed; staged copies are disposable (prepare re-stages them).
  // Give each project its own CAVEMAN_STATE_DIR if that matters.
  const stagedRoot = join(stateDir(), 'blind');
  const live = new Set(subdirs(runsRoot));
  for (const runId of subdirs(stagedRoot)) {
    if (runIdTime(runId) === null || live.has(runId)) continue;
    const bytes = removeInside(stagedRoot, join(stagedRoot, runId));
    if (bytes === null) continue;
    result.removedStaged.push(runId);
    result.freedBytes += bytes;
    note(`retention: removed staged blind screenshots for ${runId}`);
  }

  return result;
}
