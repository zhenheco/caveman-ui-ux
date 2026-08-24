// Caveman → AutoFlow handoff module.
// Contract: when a canonical Caveman audit produces actionable unresolved findings,
// this module prepares immutable handoff items and persists per-key receipts.
// It never launches AutoFlow or performs external side effects — it only prepares
// and persists the artifacts the runtime adapter needs.
//
// State vocabulary: pending|accepted|failed|implemented|verification_required|verified.
// AutoFlow must never set Caveman finding `resolved`; only same-finding Caveman verify may.

import { execSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ensureDir, readJson, sha256, writeJson } from './fsx.mjs';
import { runDir } from './paths.mjs';
import { validateSubset } from './validate.mjs';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HANDOFF_SCHEMA_PATH = join(SKILL_ROOT, 'schemas', 'handoff.schema.json');
let _handoffSchema = null;
export function handoffSchema() {
  if (!_handoffSchema) _handoffSchema = JSON.parse(readFileSync(HANDOFF_SCHEMA_PATH, 'utf8'));
  return _handoffSchema;
}

// The handoff states AutoFlow may record.
export const HANDOFF_STATES = ['pending', 'accepted', 'failed', 'implemented', 'verification_required', 'verified'];

// Severities that are eligible for handoff.
const ACTIONABLE_SEVERITIES = new Set(['blocker', 'critical', 'major']);

// Finding statuses that are NOT resolved (i.e. still actionable).
const UNRESOLVED_STATUSES = new Set(['open', 'improved', 'unchanged', 'regressed', 'not_comparable', 'not-comparable']);

// ---------------------------------------------------------------------------
// Recursion guard
// ---------------------------------------------------------------------------

/** True when the current process is running inside an AutoFlow execution. */
export function isRecursiveContext(env = process.env) {
  if (env.AUTOFLOW_EXECUTION_ID) return true;
  if (env.CAVEMAN_INSIDE_AUTOFLOW === '1') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Diagnostic validation
// ---------------------------------------------------------------------------

/** Validate that a diagnostic object has the required `code` and `message` fields. */
export function validateDiagnostic(diagnostic) {
  if (!diagnostic || typeof diagnostic !== 'object') {
    return { valid: false, error: 'diagnostic must be an object' };
  }
  if (typeof diagnostic.code !== 'string' || diagnostic.code.length === 0 || diagnostic.code.length > 100) {
    return { valid: false, error: 'diagnostic.code must be a non-empty string of at most 100 characters' };
  }
  if (typeof diagnostic.message !== 'string' || diagnostic.message.length === 0 || diagnostic.message.length > 2000) {
    return { valid: false, error: 'diagnostic.message must be a non-empty string of at most 2000 characters' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Finding selection
// ---------------------------------------------------------------------------

/** True when a fix_brief is complete enough for handoff. */
function isCompleteFixBrief(fixBrief) {
  if (!fixBrief || typeof fixBrief !== 'object') return false;
  if (typeof fixBrief.intent !== 'string' || fixBrief.intent.length === 0) return false;
  if (!Array.isArray(fixBrief.acceptance) || fixBrief.acceptance.length === 0) return false;
  if (typeof fixBrief.suggested_change !== 'string' || fixBrief.suggested_change.length === 0) return false;
  if (!Array.isArray(fixBrief.rule_ids) || fixBrief.rule_ids.length === 0) return false;
  return true;
}

/** True when the finding has at least one typed evidence entry. */
function hasTypedEvidence(finding) {
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) return false;
  return finding.evidence.every((entry) => typeof entry?.type === 'string' && entry.type.length > 0);
}

/**
 * Select actionable findings from an audit document.
 * Returns { items: [...], diagnostics: [...] }.
 * Diagnostics capture non-fatal reasons a finding was skipped.
 */
export function selectActionableFindings(audit) {
  const findings = Array.isArray(audit?.findings) ? audit.findings : [];
  const items = [];
  const diagnostics = [];

  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') continue;
    const id = finding.id || '?';
    const ruleId = finding.rule_id || '?';

    if (!ACTIONABLE_SEVERITIES.has(finding.severity)) continue;
    if (finding.status === 'resolved') continue;

    if (!hasTypedEvidence(finding)) {
      diagnostics.push({
        type: 'no_evidence',
        message: `finding ${id} (${ruleId}) has no typed evidence`,
        finding_id: id,
        rule_id: ruleId,
      });
      continue;
    }

    if (!isCompleteFixBrief(finding.fix_brief)) {
      diagnostics.push({
        type: 'incomplete_fix_brief',
        message: `finding ${id} (${ruleId}) has an incomplete fix_brief`,
        finding_id: id,
        rule_id: ruleId,
      });
      continue;
    }

    items.push(finding);
  }

  return { items, diagnostics };
}

// ---------------------------------------------------------------------------
// Audit validation
// ---------------------------------------------------------------------------

/**
 * Runtime-validate the canonical audit.json.
 * Requires `audit.run.run_id === --run` and selects only explicit allowed
 * unresolved statuses. Returns the validated audit or throws.
 */
export function validateAudit(audit, expectedRunId) {
  if (!audit || typeof audit !== 'object') {
    const error = new Error('audit.json is not a valid JSON object');
    error.code = 'AUDIT_INVALID';
    throw error;
  }
  const run = audit.run;
  if (!run || typeof run !== 'object' || typeof run.run_id !== 'string') {
    const error = new Error('audit.json is missing run.run_id');
    error.code = 'AUDIT_INVALID';
    throw error;
  }
  if (run.run_id !== expectedRunId) {
    const error = new Error(
      `audit run_id mismatch: expected ${expectedRunId}, got ${run.run_id}`,
    );
    error.code = 'AUDIT_RUN_MISMATCH';
    throw error;
  }
  return audit;
}

// ---------------------------------------------------------------------------
// Handoff item construction
// ---------------------------------------------------------------------------

/** Build one immutable handoff item from a finding. */
function projectHandoffTarget(target) {
  const projected = {};
  for (const key of ['route', 'normalized_route', 'locale', 'viewport', 'screen_id', 'url']) {
    if (target?.[key] !== undefined) projected[key] = target[key];
  }
  return projected;
}

function canonicalItemFromFinding(finding, runId, sourceAuditSha256, rollback) {
  const key = `${runId}:${finding.id}`;
  return {
    key,
    run_id: runId,
    finding_id: finding.id,
    severity: finding.severity,
    target: projectHandoffTarget(finding.target),
    fix_brief: {
      intent: finding.fix_brief.intent,
      acceptance: [...finding.fix_brief.acceptance],
      suggested_change: finding.fix_brief.suggested_change,
      rule_ids: [...finding.fix_brief.rule_ids],
      target: finding.fix_brief.target ? projectHandoffTarget(finding.fix_brief.target) : undefined,
    },
    evidence: finding.evidence.map((entry) => ({ ...entry })),
    source_audit_sha256: sourceAuditSha256,
    rollback,
  };
}

export function buildHandoffItem(finding, runId, sourceAuditSha256, repo, cwd) {
  return canonicalItemFromFinding(
    finding,
    runId,
    sourceAuditSha256,
    buildRollbackContract(repo, cwd, runId, finding.id),
  );
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Get the current HEAD commit SHA from a git repository.
 * Returns null if the directory is not a git repo or git is unavailable.
 */
function getHeadSha(repoPath) {
  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if the working tree has uncommitted changes (tracked files modified or untracked).
 * Returns { dirty: boolean, files: string[] }.
 *
 * Files under `.caveman-ui-ux/` are explicitly excluded: workflow state is preserved
 * across rollback and must not itself make every post-audit handoff impossible.
 */
function getDirtyStatus(repoPath) {
  try {
    const status = execSync('git -c status.relativePaths=false status --porcelain=v1 -z', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    const tokens = status.split('\0');
    const files = [];
    const isWorkflowPath = (path) => path === '.caveman-ui-ux' || path.startsWith('.caveman-ui-ux/');
    for (let index = 0; index < tokens.length; index += 1) {
      const record = tokens[index];
      if (!record || record.length < 4) continue;
      const statusCode = record.slice(0, 2);
      const affected = [record.slice(3)];
      if (/[RC]/.test(statusCode)) {
        const source = tokens[index + 1];
        if (source) affected.push(source);
        index += 1;
      }
      if (!affected.every(isWorkflowPath)) files.push(...affected);
    }
    return { dirty: files.length > 0, files };
  } catch {
    // Rollback safety is fail-closed: an unreadable worktree is not clean.
    return { dirty: true, files: ['<git-status-unavailable>'] };
  }
}

/**
 * Get the root of the git repository.
 * Returns the absolute path or null.
 */
function getGitRoot(repoPath) {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

/** Build a rollback contract for one finding using real git metadata. */
function buildRollbackContract(repo, cwd, runId, findingId) {
  const repoPath = repo || cwd;
  const headSha = getHeadSha(repoPath);
  const gitRoot = getGitRoot(repoPath);
  const dirtyStatus = getDirtyStatus(repoPath);

  // We always need a real HEAD SHA. prepareHandoff enforces this.
  const contract = {
    description: `Restore the pre-fix HEAD (${headSha || 'UNKNOWN'}) for finding ${findingId} from run ${runId}. `
      + 'The implementer should have created a branch or tag before applying the fix. '
      + 'Rollback means checking out the pre-fix commit while preserving workflow state.',
    pre_fix_head_ref: headSha || null,
    pre_fix_head_sha: headSha || null,
    git_root: gitRoot || null,
    dirty_worktree: dirtyStatus.dirty,
    dirty_files: dirtyStatus.dirty ? dirtyStatus.files : [],
    preserve_paths: [
      `.caveman-ui-ux/runs/${runId}/`,
      `.caveman-ui-ux/runs/${runId}/handoffs/`,
    ],
  };

  return contract;
}

// ---------------------------------------------------------------------------
// Receipt persistence
// ---------------------------------------------------------------------------

/** Sanitize a handoff key for use as a filename. */
function safeFileName(key) {
  return key.replace(/[^a-zA-Z0-9:_-]/g, '_').replace(/:/g, '_');
}

/**
 * Persist one receipt for a handoff key using exclusive creation.
 * Uses `wx` flag for atomic exclusive file creation.
 * Returns { created: true, path } on success, or { created: false, path, existing } if
 * a receipt already exists for this key.
 */
export function persistReceipt(runDirectory, key, data) {
  const handoffsDir = join(runDirectory, 'handoffs');
  ensureDir(handoffsDir);

  const receiptPath = join(handoffsDir, `${safeFileName(key)}.json`);

  if (existsSync(receiptPath)) {
    const existing = readJson(receiptPath);
    return { created: false, path: receiptPath, existing };
  }

  // Use wx flag for atomic exclusive creation: fails if the file already exists.
  writeFileSync(receiptPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { created: true, path: receiptPath };
}

/** Read a receipt from disk, or null if it does not exist. */
export function readReceipt(runDirectory, key) {
  const receiptPath = join(runDirectory, 'handoffs', `${safeFileName(key)}.json`);
  if (!existsSync(receiptPath)) return null;
  return readJson(receiptPath);
}

/**
 * Write (overwrite) a receipt, creating parent directories as needed.
 * Used for state transitions by the handoff record path.
 */
export function writeReceipt(runDirectory, key, data) {
  const handoffsDir = join(runDirectory, 'handoffs');
  ensureDir(handoffsDir);
  const receiptPath = join(handoffsDir, `${safeFileName(key)}.json`);
  writeFileSync(receiptPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return { path: receiptPath };
}

// ---------------------------------------------------------------------------
// Atomic dispatch claim — token-bound ownership
// ---------------------------------------------------------------------------

/**
 * Read the claim token from a claim file, or null if no claim exists.
 */
function readClaimToken(cwd, runId, key) {
  const directory = runDir(cwd, runId);
  const claimPath = join(directory, 'handoffs', 'claims', `${safeFileName(key)}.claim`);
  if (!existsSync(claimPath)) return null;
  try {
    const claim = readJson(claimPath);
    return typeof claim?.token === 'string' ? claim.token : null;
  } catch {
    return null;
  }
}

function readClaim(cwd, runId, key) {
  const claimPath = join(runDir(cwd, runId), 'handoffs', 'claims', `${safeFileName(key)}.claim`);
  if (!existsSync(claimPath)) return null;
  try { return readJson(claimPath); } catch { return null; }
}

function validateDispatchBinding(cwd, runId, key, claim) {
  const binding = claim?.dispatch_binding;
  if (!binding?.path || !binding?.sha256) {
    const error = new Error(`claim for ${key} is not bound to a finalized dispatch artifact`);
    error.code = 'DISPATCH_BINDING_INVALID';
    throw error;
  }
  try {
    const stat = lstatSync(binding.path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
  } catch {
    const error = new Error(`dispatch artifact for ${key} is missing, non-regular, or symlinked`);
    error.code = 'DISPATCH_BINDING_INVALID';
    throw error;
  }
  const raw = readFileSync(binding.path, 'utf8');
  if (sha256(raw) !== binding.sha256) {
    const error = new Error(`dispatch artifact digest changed after claim for ${key}`);
    error.code = 'DISPATCH_BINDING_INVALID';
    throw error;
  }
  let artifact;
  try { artifact = JSON.parse(raw); } catch { artifact = null; }
  const validation = artifact ? validateSubset(handoffSchema(), artifact) : { valid: false };
  if (!validation.valid || artifact.run_id !== runId || artifact.source_audit_sha256 !== claim.source_audit_sha256) {
    const error = new Error(`dispatch artifact contract is invalid for ${key}`);
    error.code = 'DISPATCH_BINDING_INVALID';
    throw error;
  }
  const matches = artifact.items.filter((item) => item.key === key);
  const prepared = readHandoffArtifact(cwd, runId, { requirePending: false }).items.find((item) => item.key === key);
  if (matches.length !== 1 || !prepared || JSON.stringify(matches[0]) !== JSON.stringify(prepared)) {
    const error = new Error(`dispatch item for ${key} does not match the canonical prepared item`);
    error.code = 'DISPATCH_BINDING_INVALID';
    throw error;
  }
}

/**
 * Attempt to atomically claim a handoff key for dispatch.
 * Uses a per-key exclusive lock file (`wx` flag) to serialize the entire
 * inspect-expired/takeover/create critical section. A fresh claim uses exclusive
 * creation; expired takeover occurs inside the lock.
 *
 * The claim includes a random token for ownership binding and durable expiry metadata.
 * Returns { claimed: true, claimPath, token } on success, or { claimed: false } if already claimed.
 *
 * Stale takeover: if an existing claim is older than CLAIM_TTL_MS (24 h), it is
 * treated as expired and can be taken over. Active unexpired foreign claims are rejected.
 */
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — exceeds normal AutoFlow full run
const LOCK_STALE_MS = 5000; // 5 seconds — stale lock timeout for crash recovery

function acquireLock(lockPath, staleMs = LOCK_STALE_MS) {
  try {
    writeFileSync(lockPath, String(process.pid), { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // A dead numeric owner can be recovered immediately after a crash. Never
    // delete a lock whose recorded process is still alive.
    try {
      const owner = Number(readFileSync(lockPath, 'utf8').trim());
      if (Number.isInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
          return false;
        } catch (killError) {
          if (killError.code === 'ESRCH') {
            try { unlinkSync(lockPath); } catch {}
            try {
              writeFileSync(lockPath, String(process.pid), { encoding: 'utf8', flag: 'wx' });
              return true;
            } catch (retryError) {
              if (retryError.code === 'EEXIST') return false;
              throw retryError;
            }
          }
          return false;
        }
      }
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > staleMs) {
        try { unlinkSync(lockPath); } catch {}
        writeFileSync(lockPath, String(process.pid), { encoding: 'utf8', flag: 'wx' });
        return true;
      }
    } catch {}
    return false;
  }
}

function releaseLock(lockPath) {
  try { unlinkSync(lockPath); } catch {}
}

function keyLockPath(cwd, runId, key) {
  return join(runDir(cwd, runId), 'handoffs', 'claims', `${safeFileName(key)}.lock`);
}

function claimBusyError(key) {
  const error = new Error(`handoff key "${key}" is busy; another claim/record operation holds its lock`);
  error.code = 'CLAIM_BUSY';
  return error;
}

function withKeyLock(cwd, runId, key, operation) {
  const lockPath = keyLockPath(cwd, runId, key);
  ensureDir(dirname(lockPath));
  if (!acquireLock(lockPath)) throw claimBusyError(key);
  try {
    return operation();
  } finally {
    releaseLock(lockPath);
  }
}

export function claimDispatchKey(cwd, runId, key) {
  const directory = runDir(cwd, runId);
  const claimsDir = join(directory, 'handoffs', 'claims');
  ensureDir(claimsDir);

  const claimPath = join(claimsDir, `${safeFileName(key)}.claim`);
  const lockPath = join(claimsDir, `${safeFileName(key)}.lock`);
  const token = randomUUID();
  const now = new Date().toISOString();

  if (!acquireLock(lockPath)) {
    return { claimed: false, claimPath, token: null };
  }

  try {
    // Inside the lock: inspect, expire, create.
    if (existsSync(claimPath)) {
      try {
        const existing = readJson(claimPath);
        const claimedAt = existing?.claimed_at;
        if (claimedAt) {
          const age = Date.now() - new Date(claimedAt).getTime();
          if (age < CLAIM_TTL_MS) {
            // Active unexpired claim — cannot steal.
            return { claimed: false, claimPath, token: null };
          }
          // Stale: remove the old claim file.
          try { unlinkSync(claimPath); } catch {}
        }
      } catch {
        // Corrupt claim file — remove and retry.
        try { unlinkSync(claimPath); } catch {}
      }
    }

    // Create the claim atomically with wx.
    try {
      writeFileSync(claimPath, JSON.stringify({
        key,
        run_id: runId,
        token,
        claimed_at: now,
        expires_at: new Date(Date.now() + CLAIM_TTL_MS).toISOString(),
      }), { encoding: 'utf8', flag: 'wx' });
      return { claimed: true, claimPath, token };
    } catch (err) {
      if (err.code === 'EEXIST') return { claimed: false, claimPath, token: null };
      throw err;
    }
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * After claiming a key, verify the receipt is still pending AND the claim token
 * still matches. If the receipt has been accepted/failed by another process or
 * the claim was removed/replaced, release the claim and return false.
 * This closes the TOCTOU race between claim and dispatch.
 */
export function verifyClaimStillPending(cwd, runId, key, token) {
  const directory = runDir(cwd, runId);
  const receipt = readReceipt(directory, key);
  if (!receipt || receipt.state !== 'pending') {
    releaseClaim(cwd, runId, key, token);
    return false;
  }
  const liveToken = readClaimToken(cwd, runId, key);
  if (!liveToken || liveToken !== token) {
    // Claim was removed or replaced by another process.
    return false;
  }
  return true;
}

/**
 * Release a dispatch claim. Only succeeds if the claim file exists and the
 * stored token matches the caller's token.
 * Returns true if the claim was released, false if it didn't exist or token mismatch.
 */
export function releaseClaim(cwd, runId, key, token) {
  const directory = runDir(cwd, runId);
  const claimPath = join(directory, 'handoffs', 'claims', `${safeFileName(key)}.claim`);
  try {
    if (!existsSync(claimPath)) return false;
    const liveToken = readClaimToken(cwd, runId, key);
    if (!liveToken || liveToken !== token) return false;
    writeFileSync(claimPath, '', { encoding: 'utf8', flag: 'w' });
    unlinkSync(claimPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finalize a dispatch claim after successful recordHandoff.
 * Removes the claim file (only if token matches) and creates a finalised marker.
 * Returns true if the claim was finalized or already finalized, false if token mismatch.
 *
 * Fix: if a final marker already exists but a live claim file is also present
 * (retry scenario), the claim is removed and the final marker is updated.
 * Token-bound: the final marker stores the token so same-token replay is idempotent
 * and a new token can update the marker.
 */
export function finalizeClaim(cwd, runId, key, token) {
  const lockPath = keyLockPath(cwd, runId, key);
  ensureDir(dirname(lockPath));
  if (!acquireLock(lockPath)) return false;
  try {
    return finalizeClaimUnlocked(cwd, runId, key, token);
  } finally {
    releaseLock(lockPath);
  }
}

function finalizeClaimUnlocked(cwd, runId, key, token) {
  const directory = runDir(cwd, runId);
  const claimPath = join(directory, 'handoffs', 'claims', `${safeFileName(key)}.claim`);
  const finalPath = join(directory, 'handoffs', 'claims', `${safeFileName(key)}.final`);

  // Idempotent: if already finalized with the same token, return true.
  if (existsSync(finalPath)) {
    try {
      const existing = readJson(finalPath);
      if (existing?.token === token && !existsSync(claimPath)) return true;
    } catch {}
  }

  if (!existsSync(claimPath)) {
    // No live claim — if final marker exists, it was from a previous attempt.
    if (existsSync(finalPath)) return true;
    return false;
  }

  // Verify token ownership before removing the claim.
  const liveToken = readClaimToken(cwd, runId, key);
  if (!liveToken || liveToken !== token) return false;

  try {
    unlinkSync(claimPath);
  } catch {
    // Claim was already removed by another process.
  }
  try {
    writeFileSync(finalPath, JSON.stringify({
      key,
      run_id: runId,
      token,
      finalized_at: new Date().toISOString(),
    }), { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Already finalized by another process — check if our token.
      try {
        const existing = readJson(finalPath);
        if (existing?.token === token) return true;
      } catch {}
      // Overwrite with our token (retry scenario).
      try { writeFileSync(finalPath, JSON.stringify({
        key, run_id: runId, token,
        finalized_at: new Date().toISOString(),
      }), 'utf8'); return true; } catch { return false; }
    }
    throw err;
  }
}

/**
 * Read audit.json from a run directory, validate it, select actionable findings,
 * and build the handoff payload. Handles recursion suppression.
 *
 * Only items with a pending receipt (or no receipt yet) are included.
 * Non-pending receipts (accepted/failed/implemented/verification_required/verified)
 * are never re-dispatched or overwritten to pending.
 *
 * Returns a handoff document matching schemas/handoff.schema.json.
 */
export function prepareHandoff({ cwd, runId, auditPath, repo, env = process.env }) {
  const directory = runDir(cwd, runId);
  const auditFile = auditPath || join(directory, 'audit.json');

  if (!existsSync(auditFile)) {
    const error = new Error(`audit.json not found at ${auditFile}`);
    error.code = 'AUDIT_NOT_FOUND';
    throw error;
  }

  const audit = validateAudit(readJson(auditFile), runId);
  const sourceAuditSha256 = sha256(JSON.stringify(audit));

  // Recursion guard: when running inside AutoFlow, suppress handoff.
  if (isRecursiveContext(env)) {
    const reason = env.AUTOFLOW_EXECUTION_ID
      ? `AUTOFLOW_EXECUTION_ID=${env.AUTOFLOW_EXECUTION_ID}`
      : 'CAVEMAN_INSIDE_AUTOFLOW=1';
    return {
      schema_version: 1,
      tool: { name: 'caveman-ui-ux', version: audit.tool?.version || '1.0.0' },
      run_id: runId,
      source_audit_sha256: sourceAuditSha256,
      repo: repo || cwd,
      cwd,
      suppressed_recursive: true,
      suppressed_reason: reason,
      items: [],
      item_count: 0,
      diagnostics: [{
        type: 'suppressed_recursive',
        message: `handoff suppressed: Caveman is running inside AutoFlow; reason: ${reason}`,
      }],
    };
  }

  const { items: selected, diagnostics } = selectActionableFindings(audit);
  if (selected.length === 0) {
    return {
      schema_version: 1,
      tool: { name: 'caveman-ui-ux', version: audit.tool?.version || '1.0.0' },
      run_id: runId,
      source_audit_sha256: sourceAuditSha256,
      repo: repo || cwd,
      cwd,
      suppressed_recursive: false,
      items: [],
      item_count: 0,
      diagnostics,
    };
  }

  // Establish a real rollback baseline.
  const repoPath = repo || cwd;
  const headSha = getHeadSha(repoPath);
  if (!headSha) {
    const error = new Error(
      `cannot establish a safe rollback baseline: no git HEAD commit found in ${repoPath}`,
    );
    error.code = 'NO_ROLLBACK_BASELINE';
    throw error;
  }

  // Fix #8: reject dirty worktree — rollback must be safe.
  const dirtyStatus = getDirtyStatus(repoPath);
  if (dirtyStatus.dirty) {
    const error = new Error(
      `cannot prepare handoff: git working tree is dirty. `
      + `Commit or stash changes before preparing a handoff. `
      + `Dirty files: ${dirtyStatus.files.slice(0, 10).join(', ')}${dirtyStatus.files.length > 10 ? ` +${dirtyStatus.files.length - 10} more` : ''}`,
    );
    error.code = 'DIRTY_WORKTREE';
    throw error;
  }

  const allItems = selected.map((finding) =>
    buildHandoffItem(finding, runId, sourceAuditSha256, repo || cwd, cwd));

  const now = new Date().toISOString();

  // Persist one receipt per key as 'pending', but only if no receipt exists
  // or the existing receipt is still in 'pending' state.
  for (const item of allItems) {
    const existing = readReceipt(directory, item.key);
    if (existing && existing.state !== 'pending') {
      // Non-pending receipt exists — do not re-dispatch or overwrite.
      continue;
    }
    if (!existing) {
      persistReceipt(directory, item.key, {
        state: 'pending',
        key: item.key,
        run_id: runId,
        finding_id: item.finding_id,
        source_audit_sha256: sourceAuditSha256,
        canonical_item_sha256: sha256(JSON.stringify(item)),
        rollback: item.rollback,
        created_at: now,
      });
    }
    // If existing and pending, leave it alone (idempotent).
  }

  // Fix #2: return only items whose current receipt is pending.
  const pendingItems = allItems.filter((item) => {
    const receipt = readReceipt(directory, item.key);
    return !receipt || receipt.state === 'pending';
  });

  const result = {
    schema_version: 1,
    tool: { name: 'caveman-ui-ux', version: audit.tool?.version || '1.0.0' },
    run_id: runId,
    source_audit_sha256: sourceAuditSha256,
    repo: repo || cwd,
    cwd,
    suppressed_recursive: false,
    items: pendingItems,
    item_count: pendingItems.length,
    diagnostics,
  };
  persistHandoffArtifact(cwd, runId, result);
  return result;
}

// ---------------------------------------------------------------------------
// Handoff artifact persistence (side-effect boundary)
// ---------------------------------------------------------------------------

/**
 * Persist the handoff items as a schema-valid artifact file.
 * Only items with a pending receipt are included.
 * Returns the path to the written artifact.
 */
export function persistHandoffArtifact(cwd, runId, handoffDoc) {
  const directory = runDir(cwd, runId);
  const handoffsDir = join(directory, 'handoffs');
  ensureDir(handoffsDir);

  const artifactPath = join(handoffsDir, 'handoff-items.json');

  if (existsSync(artifactPath)) {
    const existing = readHandoffArtifact(cwd, runId, { requirePending: false });
    if (existing.source_audit_sha256 !== handoffDoc.source_audit_sha256) {
      const error = new Error('canonical prepared handoff artifact is immutable and audit binding changed');
      error.code = 'PREPARED_ARTIFACT_IMMUTABLE';
      throw error;
    }
    const existingByKey = new Map(existing.items.map((item) => [item.key, item]));
    for (const item of handoffDoc.items) {
      if (JSON.stringify(existingByKey.get(item.key)) !== JSON.stringify(item)) {
        const error = new Error(`canonical prepared handoff item changed for ${item.key}`);
        error.code = 'PREPARED_ARTIFACT_IMMUTABLE';
        throw error;
      }
    }
    return artifactPath;
  }

  // Filter to only items that have a pending receipt.
  const pendingItems = handoffDoc.items.filter((item) => {
    const receipt = readReceipt(directory, item.key);
    return receipt && receipt.state === 'pending';
  });

  const artifact = {
    schema_version: 1,
    tool: handoffDoc.tool,
    run_id: handoffDoc.run_id,
    source_audit_sha256: handoffDoc.source_audit_sha256,
    items: pendingItems,
    item_count: pendingItems.length,
    diagnostics: handoffDoc.diagnostics,
  };

  writeJson(artifactPath, artifact);
  return artifactPath;
}

/**
 * Read and validate the persisted handoff artifact.
 * Validates against the real schemas/handoff.schema.json, detects tampered items,
 * and detects stale items (receipt no longer pending).
 * Returns the validated artifact or throws.
 */
export function readHandoffArtifact(cwd, runId, { requirePending = true } = {}) {
  const directory = runDir(cwd, runId);
  const artifactPath = join(directory, 'handoffs', 'handoff-items.json');

  if (!existsSync(artifactPath)) {
    const error = new Error(`handoff artifact not found at ${artifactPath}`);
    error.code = 'ARTIFACT_NOT_FOUND';
    throw error;
  }

  let artifact;
  try {
    artifact = readJson(artifactPath);
  } catch {
    const error = new Error(`handoff artifact is not valid JSON: ${artifactPath}`);
    error.code = 'ARTIFACT_INVALID';
    throw error;
  }

  if (!artifact || typeof artifact !== 'object') {
    const error = new Error(`handoff artifact is not a valid object: ${artifactPath}`);
    error.code = 'ARTIFACT_INVALID';
    throw error;
  }

  // Validate against the real handoff schema first.
  const schema = handoffSchema();
  const schemaResult = validateSubset(schema, artifact);
  if (!schemaResult.valid) {
    const detail = schemaResult.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    const error = new Error(
      `handoff artifact failed schema validation: ${detail}`,
    );
    error.code = 'ARTIFACT_INVALID';
    throw error;
  }

  if (artifact.schema_version !== 1) {
    const error = new Error(`handoff artifact schema_version must be 1, got ${artifact.schema_version}`);
    error.code = 'ARTIFACT_INVALID';
    throw error;
  }

  if (!artifact.tool || typeof artifact.tool !== 'object' || artifact.tool.name !== 'caveman-ui-ux' || typeof artifact.tool.version !== 'string') {
    const error = new Error('handoff artifact must have tool.name = "caveman-ui-ux" and tool.version');
    error.code = 'ARTIFACT_INVALID';
    throw error;
  }

  if (typeof artifact.run_id !== 'string' || artifact.run_id.length === 0) {
    const error = new Error('handoff artifact must have a non-empty run_id');
    error.code = 'ARTIFACT_INVALID';
    throw error;
  }

  if (artifact.run_id !== runId) {
    const error = new Error(
      `handoff artifact run_id ${artifact.run_id} does not match expected ${runId}`,
    );
    error.code = 'ARTIFACT_RUN_MISMATCH';
    throw error;
  }

  if (!Array.isArray(artifact.items)) {
    const error = new Error('handoff artifact items must be an array');
    error.code = 'ARTIFACT_INVALID';
    throw error;
  }

  if (typeof artifact.item_count !== 'number' || artifact.item_count !== artifact.items.length) {
    const error = new Error(
      `handoff artifact item_count ${artifact.item_count} does not match items length ${artifact.items.length}`,
    );
    error.code = 'ARTIFACT_INVALID';
    throw error;
  }

  // Fix #7: validate each item against its source_audit_sha256 and pending receipt.
  const sourceSha = artifact.source_audit_sha256;
  for (const item of artifact.items) {
    // Tamper detection: each item's source_audit_sha256 must match the artifact's.
    if (typeof item.source_audit_sha256 !== 'string' || item.source_audit_sha256 !== sourceSha) {
      const error = new Error(
        `handoff artifact item ${item.key} has mismatched source_audit_sha256 — artifact may be tampered`,
      );
      error.code = 'ARTIFACT_TAMPERED';
      throw error;
    }

    // Stale detection: each item must have a corresponding pending receipt.
    const receipt = readReceipt(directory, item.key);
    if (!receipt) {
      const error = new Error(
        `handoff artifact item ${item.key} has no corresponding receipt — artifact is stale`,
      );
      error.code = 'ARTIFACT_STALE';
      throw error;
    }
    if (requirePending && receipt.state !== 'pending') {
      const error = new Error(
        `handoff artifact item ${item.key} has receipt in state ${receipt.state}, not pending — artifact is stale`,
      );
      error.code = 'ARTIFACT_STALE';
      throw error;
    }
  }

  return artifact;
}

export function validateLifecycleSourceBinding({ cwd, runId, key, receipt: suppliedReceipt }) {
  const directory = runDir(cwd, runId);
  const receipt = suppliedReceipt || readReceipt(directory, key);
  if (!receipt || receipt.key !== key || receipt.run_id !== runId
    || key !== `${runId}:${receipt.finding_id}`) {
    const error = new Error(`receipt identity does not match lifecycle key ${key}`);
    error.code = 'SOURCE_BINDING_INVALID';
    throw error;
  }
  const auditPath = join(directory, 'audit.json');
  if (!existsSync(auditPath)) {
    const error = new Error(`source audit missing for ${key}`);
    error.code = 'SOURCE_BINDING_INVALID';
    throw error;
  }
  const audit = validateAudit(readJson(auditPath), runId);
  const auditHash = sha256(JSON.stringify(audit));
  if (!receipt.source_audit_sha256 || receipt.source_audit_sha256 !== auditHash) {
    const error = new Error(`source audit binding changed for ${key}`);
    error.code = 'SOURCE_AUDIT_TAMPERED';
    throw error;
  }
  const artifact = readHandoffArtifact(cwd, runId, { requirePending: false });
  if (artifact.source_audit_sha256 !== auditHash) {
    const error = new Error(`prepared artifact audit binding changed for ${key}`);
    error.code = 'SOURCE_AUDIT_TAMPERED';
    throw error;
  }
  const matches = artifact.items.filter((item) => item.key === key);
  const item = matches[0];
  const finding = (audit.findings || []).find((entry) => entry.id === receipt.finding_id);
  const expectedItem = finding
    ? canonicalItemFromFinding(finding, runId, auditHash, receipt.rollback)
    : null;
  const itemDigest = item ? sha256(JSON.stringify(item)) : null;
  if (matches.length !== 1 || !finding
    || typeof receipt.canonical_item_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(receipt.canonical_item_sha256)
    || receipt.canonical_item_sha256 !== itemDigest
    || JSON.stringify(item) !== JSON.stringify(expectedItem)) {
    const error = new Error(`prepared source item or rollback binding changed for ${key}`);
    error.code = 'SOURCE_BINDING_INVALID';
    throw error;
  }
  return { receipt, audit, item };
}

// ---------------------------------------------------------------------------
// Record entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Flow ID validation against AutoFlow state
// ---------------------------------------------------------------------------

const DEFAULT_AUTOFLOW_STATE_DIR = join(homedir(), '.claude', 'state', 'autoflow');

/**
 * Validate that a flowId refers to a real, persisted AutoFlow flow.
 * Reads `<stateDir>/<flowId>/status.json` and verifies:
 * - The file exists and is a regular file (not a symlink).
 * - The parsed `flow_id` field exactly matches the supplied flowId.
 * - `release_policy` equals `"handoff-only"`.
 * - `base_repo` resolves to the same canonical git repo as `expectedRepo`.
 * Returns { valid: true, flow_id } on success, or { valid: false, error }.
 *
 * Missing status.json is always invalid — no CI/test bypass.
 * Repository identity is compared via canonical Git top-level (git rev-parse --show-toplevel)
 * after resolving physical paths (realpath), so symlink prefixes (e.g. macOS /var → /private/var)
 * and subdirectories of the same worktree are treated as equivalent.
 * Tests must provide isolated valid state.
 *
 * @param {string} flowId — the flow id to validate
 * @param {string} expectedRepo — the Caveman project repo to match against base_repo
 * @param {string} [stateDir] — optional override for AutoFlow state directory (defaults to ~/.claude/state/autoflow)
 */
export function validateFlowId(flowId, expectedRepo, stateDir) {
  const dir = stateDir || DEFAULT_AUTOFLOW_STATE_DIR;

  if (!flowId || typeof flowId !== 'string') {
    return { valid: false, error: 'flowId is required' };
  }

  // Reject path traversal.
  if (flowId.includes('/') || flowId.includes('\\') || flowId === '.' || flowId === '..') {
    return { valid: false, error: `flowId must not contain path separators: ${JSON.stringify(flowId)}` };
  }

  const statusPath = join(dir, flowId, 'status.json');
  const flowDir = join(dir, flowId);

  if (!existsSync(statusPath)) {
    return { valid: false, error: `AutoFlow status not found at ${statusPath}` };
  }

  try {
    const stat = lstatSync(flowDir);
    if (stat.isSymbolicLink()) return { valid: false, error: `AutoFlow flow directory must not be a symlink: ${flowDir}` };
    if (!stat.isDirectory()) return { valid: false, error: `AutoFlow flow path is not a directory: ${flowDir}` };
  } catch {
    return { valid: false, error: `cannot stat AutoFlow flow directory: ${flowDir}` };
  }

  // Reject symlinks — the status file must be a real file.
  try {
    const stat = lstatSync(statusPath);
    if (!stat.isFile()) {
      return { valid: false, error: `AutoFlow status is not a regular file: ${statusPath}` };
    }
  } catch {
    return { valid: false, error: `cannot stat AutoFlow status: ${statusPath}` };
  }

  let status;
  try {
    status = readJson(statusPath);
  } catch {
    return { valid: false, error: `AutoFlow status is not valid JSON: ${statusPath}` };
  }

  if (!status || typeof status !== 'object') {
    return { valid: false, error: `AutoFlow status is not a valid object: ${statusPath}` };
  }

  if (status.flow_id !== flowId) {
    return { valid: false, error: `AutoFlow status flow_id ${JSON.stringify(status.flow_id)} does not match supplied flowId ${JSON.stringify(flowId)}` };
  }

  // Require handoff-only release policy.
  if (status.release_policy !== 'handoff-only') {
    return { valid: false, error: `AutoFlow status release_policy must be "handoff-only", got ${JSON.stringify(status.release_policy)}` };
  }

  // Require base_repo matches the Caveman project repo.
  if (expectedRepo) {
    if (!status.base_repo || typeof status.base_repo !== 'string') {
      return { valid: false, error: 'AutoFlow status is missing base_repo' };
    }
    // Resolve physical paths (realpath) to handle symlink prefixes (e.g. macOS /var → /private/var).
    let expectedReal;
    try {
      expectedReal = realpathSync(expectedRepo);
    } catch {
      return { valid: false, error: `Caveman repo path does not exist: ${expectedRepo}` };
    }
    let baseReal;
    try {
      baseReal = realpathSync(status.base_repo);
    } catch {
      return { valid: false, error: `AutoFlow status base_repo path does not exist: ${status.base_repo}` };
    }

    // Compare canonical Git repository identity (handles subdirectories of the same worktree).
    const expectedGitRoot = getGitRoot(expectedReal);
    if (!expectedGitRoot) {
      return { valid: false, error: `Caveman repo path is not a git repository: ${expectedRepo}` };
    }
    const baseGitRoot = getGitRoot(baseReal);
    if (!baseGitRoot) {
      return { valid: false, error: `AutoFlow status base_repo is not a git repository: ${status.base_repo}` };
    }

    // Resolve git roots to physical paths for final comparison.
    let expectedGitCanonical, baseGitCanonical;
    try {
      expectedGitCanonical = realpathSync(expectedGitRoot);
    } catch {
      return { valid: false, error: `cannot resolve Caveman git root: ${expectedGitRoot}` };
    }
    try {
      baseGitCanonical = realpathSync(baseGitRoot);
    } catch {
      return { valid: false, error: `cannot resolve AutoFlow git root: ${baseGitRoot}` };
    }

    if (expectedGitCanonical !== baseGitCanonical) {
      return { valid: false, error: `AutoFlow status base_repo ${JSON.stringify(status.base_repo)} does not match Caveman repo ${JSON.stringify(expectedRepo)}` };
    }
  }

  return { valid: true, flow_id: flowId };
}

/**
 * Transition table for recordHandoff.
 * Only pending → accepted/failed and idempotent replays are allowed.
 * Everything else is rejected.
 * Returns true for allowed, a string for structured conflict, false for disallowed.
 */
function allowedRecordTransition(existing, flowId, diagnostic) {
  if (flowId) {
    // pending → accepted is always allowed.
    if (existing.state === 'pending') return true;
    // accepted → accepted (same flow_id) is idempotent replay.
    if (existing.state === 'accepted' && existing.flow_id === flowId) return true;
    // accepted → accepted (different flow_id) is a conflict.
    if (existing.state === 'accepted' && existing.flow_id && existing.flow_id !== flowId) return 'CONFLICTING_FLOW_ID';
    return false;
  }
  if (diagnostic) {
    // pending → failed is always allowed.
    if (existing.state === 'pending' || existing.state === 'accepted' || existing.state === 'implemented') return true;
    // failed → failed (same diagnostic code) is idempotent replay.
    if (existing.state === 'failed' && existing.diagnostic?.code === diagnostic.code) return true;
    // failed → failed (different diagnostic code) is a conflict.
    if (existing.state === 'failed' && existing.diagnostic?.code !== diagnostic.code) return 'CONFLICTING_DIAGNOSTIC';
    return false;
  }
  return false;
}

/**
 * Record a flow id or diagnostic against a handoff key.
 *
 * Key validation: the key must have the exact `${runId}:` prefix and must refer
 * to a prepared receipt for that run.
 *
 * Transitions are guarded/monotonic:
 * - Replay of the same accepted flow ID is a no-op.
 * - A conflicting flow ID is a structured error.
 * - Accepted sets flow_id and clears diagnostic.
 * - Failed sets diagnostic and clears flow_id.
 *
 * AutoFlow-supplied record input can never set verified or resolved.
 *
 * Claim ownership: when a claim exists for this key, `claimToken` must match
 * the live claim token. An unrelated/no-token record against an active claim
 * fails with CLAIM_CONFLICT. If no claim exists, the manual record path is
 * preserved (no token required).
 *
 * @param {object} options
 * @param {string} options.cwd — project cwd
 * @param {string} options.runId — run id
 * @param {string} options.key — idempotency key <run_id>:<finding_id>
 * @param {string} [options.flowId] — AutoFlow execution/flow id
 * @param {object} [options.diagnostic] — structured diagnostic when the flow failed
 * @param {string} [options.claimToken] — claim token for ownership verification
 * @returns {object} the receipt (created or merged)
 */
export function recordHandoff({ cwd, runId, key, flowId, diagnostic, claimToken, autoflowStateDir }) {
  const directory = runDir(cwd, runId);

  // Validate key: must have exact `${runId}:` prefix.
  if (!key || typeof key !== 'string') {
    const error = new Error('handoff key is required');
    error.code = 'KEY_MISSING';
    throw error;
  }
  const prefix = `${runId}:`;
  if (!key.startsWith(prefix)) {
    const error = new Error(
      `handoff key "${key}" does not belong to run ${runId} (expected prefix "${prefix}")`,
    );
    error.code = 'KEY_RUN_MISMATCH';
    throw error;
  }

  const lockPath = keyLockPath(cwd, runId, key);
  ensureDir(dirname(lockPath));
  if (!acquireLock(lockPath)) throw claimBusyError(key);

  try {
  const existing = readReceipt(directory, key);

  if (!existing) {
    const error = new Error(
      `no prepared receipt found for key "${key}" in run ${runId} — run \`handoff prepare\` first`,
    );
    error.code = 'RECEIPT_NOT_FOUND';
    throw error;
  }

  const now = new Date().toISOString();

  const transition = allowedRecordTransition(existing, flowId, diagnostic);
  if (transition === false) {
    const error = new Error(
      `cannot transition key "${key}" from ${existing.state} to ${flowId ? 'accepted' : 'failed'}`,
    );
    error.code = 'INVALID_TRANSITION';
    throw error;
  }
  if (typeof transition === 'string') {
    // Structured conflict: CONFLICTING_FLOW_ID or CONFLICTING_DIAGNOSTIC.
    const error = new Error(
      transition === 'CONFLICTING_FLOW_ID'
        ? `handoff key "${key}" is already accepted with flow_id "${existing.flow_id}", `
          + `cannot accept with conflicting flow_id "${flowId}"`
        : `handoff key "${key}" is already failed with diagnostic code "${existing.diagnostic?.code}", `
          + `cannot record conflicting diagnostic code "${diagnostic?.code}"`,
    );
    error.code = transition;
    throw error;
  }

  // Idempotent replay: return existing unchanged.
  if (transition === true && ((flowId && existing.state === 'accepted') || (diagnostic && existing.state === 'failed'))) {
    return existing;
  }

  // Claim ownership: when a claim exists, the token must match.
  // If no claim exists, the manual record path is preserved.
  if (existing.state === 'pending') {
    const liveClaim = readClaim(cwd, runId, key);
    const liveToken = liveClaim?.token || null;
    if (flowId && !liveToken) {
      const error = new Error(`pending flow acceptance for ${key} requires a live dispatch claim`);
      error.code = 'FLOW_CLAIM_REQUIRED';
      throw error;
    }
    if (liveToken) {
      // An active claim exists — the caller must present the matching token.
      if (!claimToken || claimToken !== liveToken) {
        const error = new Error(
          `handoff key "${key}" has an active dispatch claim; `
          + `record requires the matching claim token (got ${claimToken ? 'mismatched token' : 'no token'})`,
        );
        error.code = 'CLAIM_CONFLICT';
        throw error;
      }
      if (flowId || existing.source_audit_sha256) validateDispatchBinding(cwd, runId, key, liveClaim);
    }
    // No claim exists: manual record path, no token needed.
  }

  // Flow identity is bound to the immutable prepared product repository, which
  // may differ from the directory holding Caveman run artifacts.
  if (flowId) {
    const artifact = readHandoffArtifact(cwd, runId, { requirePending: false });
    const preparedItems = artifact.items.filter((item) => item.key === key);
    const preparedItem = preparedItems[0];
    if (preparedItems.length !== 1
      || JSON.stringify(preparedItem.rollback) !== JSON.stringify(existing.rollback)
      || typeof preparedItem.rollback?.git_root !== 'string') {
      const error = new Error(`prepared rollback repository binding is invalid for ${key}`);
      error.code = 'SOURCE_BINDING_INVALID';
      throw error;
    }
    const validation = validateFlowId(flowId, preparedItem.rollback.git_root, autoflowStateDir);
    if (!validation.valid) {
      const error = new Error(`invalid flowId "${flowId}": ${validation.error}`);
      error.code = 'FLOW_ID_INVALID';
      throw error;
    }
  }

  if (flowId) {
    const merged = {
      ...existing,
      state: 'accepted',
      flow_id: flowId,
      diagnostic: null,
      recorded_at: now,
      updated_at: now,
    };
    writeReceipt(directory, key, merged);
    // Finalize any pending dispatch claim for this key (token-bound).
    finalizeClaimUnlocked(cwd, runId, key, claimToken);
    return merged;
  }

  if (diagnostic) {
    const validation = validateDiagnostic(diagnostic);
    if (!validation.valid) {
      const error = new Error(`invalid diagnostic: ${validation.error}`);
      error.code = 'DIAGNOSTIC_INVALID';
      throw error;
    }

    const merged = {
      ...existing,
      state: 'failed',
      flow_id: null,
      diagnostic,
      recorded_at: now,
      updated_at: now,
    };
    writeReceipt(directory, key, merged);
    // Finalize any pending dispatch claim for this key (token-bound).
    finalizeClaimUnlocked(cwd, runId, key, claimToken);
    return merged;
  }

  const error = new Error('recordHandoff requires flowId or diagnostic');
  error.code = 'RECORD_MISSING_ARGS';
  throw error;
  } finally {
    releaseLock(lockPath);
  }
}

// ---------------------------------------------------------------------------
// Caveman-owned completion path
// ---------------------------------------------------------------------------

/**
 * Transition a receipt from accepted → implemented.
 * Only AutoFlow may set this (but we validate it through the record path).
 * Replay of the same state is a no-op.
 */
export function transitionToImplemented({ cwd, runId, key }) {
  return withKeyLock(cwd, runId, key, () => {
  const directory = runDir(cwd, runId);
  const existing = readReceipt(directory, key);

  if (!existing) {
    const error = new Error(`no receipt found for key "${key}"`);
    error.code = 'RECEIPT_NOT_FOUND';
    throw error;
  }

  if (existing.state === 'implemented') {
    validateLifecycleSourceBinding({ cwd, runId, key, receipt: existing });
    return existing; // No-op.
  }

  if (existing.state !== 'accepted') {
    const error = new Error(
      `cannot transition key "${key}" from ${existing.state} to implemented (must be accepted)`,
    );
    error.code = 'INVALID_TRANSITION';
    throw error;
  }
  validateLifecycleSourceBinding({ cwd, runId, key, receipt: existing });
  const now = new Date().toISOString();
  const receipt = {
    ...existing,
    state: 'implemented',
    updated_at: now,
  };
  writeReceipt(directory, key, receipt);
  return receipt;
  });
}

/**
 * Transition a receipt to verification_required.
 * Called after AutoFlow implementation is complete.
 * Strict lifecycle: only implemented → verification_required.
 * Direct accepted → verification_required is not allowed; the implementer must
 * explicitly set implemented first.
 */
export function transitionToVerificationRequired({ cwd, runId, key }) {
  return withKeyLock(cwd, runId, key, () => {
  const directory = runDir(cwd, runId);
  const existing = readReceipt(directory, key);

  if (!existing) {
    const error = new Error(`no receipt found for key "${key}"`);
    error.code = 'RECEIPT_NOT_FOUND';
    throw error;
  }

  if (existing.state === 'verification_required') {
    validateLifecycleSourceBinding({ cwd, runId, key, receipt: existing });
    return existing; // No-op.
  }

  if (existing.state !== 'implemented') {
    const error = new Error(
      `cannot transition key "${key}" from ${existing.state} to verification_required (must be implemented)`,
    );
    error.code = 'INVALID_TRANSITION';
    throw error;
  }
  validateLifecycleSourceBinding({ cwd, runId, key, receipt: existing });
  const now = new Date().toISOString();
  const receipt = {
    ...existing,
    state: 'verification_required',
    updated_at: now,
  };
  writeReceipt(directory, key, receipt);
  return receipt;
  });
}

/**
 * Caveman-owned verify: read canonical verify.json and set verified on the receipt.
 *
 * Only resolved/improved are accepted verdicts.
 * Rejects: unchanged, not_comparable, missing evidence, regression.
 * Rejects: wrong run/finding.
 * AutoFlow can never call this path.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} options.runId — the source run (handoff run)
 * @param {string} options.verifyRunId — the verify run that produced verify.json
 * @param {string} options.key — the handoff key
 * @returns {object} the updated receipt
 */
export function verifyHandoff({ cwd, runId, verifyRunId, key }) {
  return withKeyLock(cwd, runId, key, () => {
  const directory = runDir(cwd, runId);
  const verifyDir = runDir(cwd, verifyRunId);
  const verifyPath = join(verifyDir, 'verify.json');

  const existing = readReceipt(directory, key);
  if (!existing) {
    const error = new Error(`no receipt found for key "${key}"`);
    error.code = 'RECEIPT_NOT_FOUND';
    throw error;
  }
  // Fix #3: enforce state machine — only verification_required may transition to verified.
  // Idempotent replay of already verified is allowed.
  if (existing.state === 'verified') {
    return existing; // No-op: already verified.
  }
  if (existing.state !== 'verification_required') {
    const error = new Error(
      `cannot verify key "${key}": receipt is in state ${existing.state} (must be verification_required)`,
    );
    error.code = 'VERIFY_INVALID_STATE';
    throw error;
  }
  if (!existsSync(verifyPath)) {
    const error = new Error(`verify.json not found at ${verifyPath}`);
    error.code = 'VERIFY_NOT_FOUND';
    throw error;
  }

  const verifyDoc = readJson(verifyPath);
  if (!verifyDoc || typeof verifyDoc !== 'object') {
    const error = new Error(`verify.json is not a valid object: ${verifyPath}`);
    error.code = 'VERIFY_INVALID';
    throw error;
  }
  if (verifyDoc.previous_run !== runId || verifyDoc.run_id !== verifyRunId) {
    const error = new Error(`verify.json run identity does not match ${runId} -> ${verifyRunId}`);
    error.code = 'VERIFY_RUN_MISMATCH';
    throw error;
  }
  // Find the verify entry for this finding.
  // Fix #5: production verify.json uses `id` (not `previous_id`).
  const findingId = existing.finding_id;
  const findings = Array.isArray(verifyDoc.findings) ? verifyDoc.findings : [];
  const entry = findings.find((f) => f.id === findingId);

  if (!entry) {
    const error = new Error(
      `verify.json does not contain a finding entry for finding_id ${findingId}`,
    );
    error.code = 'VERIFY_FINDING_NOT_FOUND';
    throw error;
  }

  const allowedStatuses = new Set(['resolved', 'improved']);
  const rejectedStatuses = new Set(['unchanged', 'not_comparable', 'not-comparable']);

  if (!allowedStatuses.has(entry.status)) {
    if (rejectedStatuses.has(entry.status)) {
      const error = new Error(
        `cannot verify key "${key}": verify status is ${entry.status} (must be resolved or improved)`,
      );
      error.code = 'VERIFY_STATUS_REJECTED';
      throw error;
    }
    if (entry.status === 'regressed') {
      const error = new Error(
        `cannot verify key "${key}": verify status is regressed`,
      );
      error.code = 'VERIFY_REGRESSION';
      throw error;
    }
    const error = new Error(
      `cannot verify key "${key}": unknown verify status ${entry.status}`,
    );
    error.code = 'VERIFY_STATUS_INVALID';
    throw error;
  }

  const verifyAuditPath = join(verifyDir, 'audit.json');
  if (!existsSync(verifyAuditPath)) {
    const error = new Error(`verification audit not found at ${verifyAuditPath}`);
    error.code = 'VERIFY_AUDIT_NOT_FOUND';
    throw error;
  }
  validateAudit(readJson(verifyAuditPath), verifyRunId);
  validateLifecycleSourceBinding({ cwd, runId, key, receipt: existing });

  const now = new Date().toISOString();
  const receipt = {
    ...existing,
    state: 'verified',
    verify_run_id: verifyRunId,
    verify_status: entry.status,
    verified_at: now,
    updated_at: now,
  };
  writeReceipt(directory, key, receipt);
  return receipt;
  });
}

// ---------------------------------------------------------------------------
// Batch claim: CLI-driven dispatch artifact
// ---------------------------------------------------------------------------

/**
 * Claim all currently pending items from the handoff artifact.
 * Writes a unique token-bound dispatch artifact (not shared dispatch-items.json).
 * Returns { dispatch_artifact_path, claims: [{key, claim_token, finding_id}] }.
 */
export function claimHandoff(cwd, runId) {
  const directory = runDir(cwd, runId);
  const handoffsDir = join(directory, 'handoffs');
  ensureDir(handoffsDir);
  const runLockPath = join(handoffsDir, 'dispatch-run.lock');
  if (!acquireLock(runLockPath, 60_000)) throw claimBusyError(`${runId}:dispatch`);
  try {
    // A crashed prior claimHandoff can leave claims that were never bound and
    // therefore were never dispatchable. Under the run lock they are safe to reclaim.
    try {
      const prepared = readHandoffArtifact(cwd, runId, { requirePending: false });
      for (const item of prepared.items) {
        const receipt = readReceipt(directory, item.key);
        if (receipt?.state !== 'pending') continue;
        const claim = readClaim(cwd, runId, item.key);
        if (claim && !claim.dispatch_binding) releaseClaim(cwd, runId, item.key, claim.token);
      }
    } catch (error) {
      if (error.code !== 'ARTIFACT_NOT_FOUND') throw error;
    }
    return claimHandoffUnderRunLock(cwd, runId);
  } finally {
    releaseLock(runLockPath);
  }
}

function claimHandoffUnderRunLock(cwd, runId) {
  const directory = runDir(cwd, runId);
  const handoffsDir = join(directory, 'handoffs');
  ensureDir(handoffsDir);

  // Re-read the canonical audit and compute its current hash.
  const auditPath = join(directory, 'audit.json');
  if (!existsSync(auditPath)) {
    const error = new Error(`audit.json not found at ${auditPath}`);
    error.code = 'AUDIT_NOT_FOUND';
    throw error;
  }
  const audit = validateAudit(readJson(auditPath), runId);
  const currentAuditSha256 = sha256(JSON.stringify(audit));

  const { items: selected } = selectActionableFindings(audit);
  const selectedEntries = selected.map((finding) => {
    const key = `${runId}:${finding.id}`;
    return { finding, key, receipt: readReceipt(directory, key) };
  });
  const pendingEntries = selectedEntries.filter((entry) => entry.receipt?.state === 'pending');

  if (pendingEntries.length === 0) {
    const anyReceipt = selectedEntries.some((entry) => entry.receipt);
    const error = new Error(
      anyReceipt
        ? 'no pending handoff items to claim (all receipts are in non-pending states)'
        : 'no pending handoff items to claim — run `handoff prepare` first',
    );
    error.code = 'NO_PENDING_ITEMS';
    throw error;
  }

  for (const { key, receipt } of pendingEntries) {
    if (!receipt?.source_audit_sha256) {
      const error = new Error(`receipt for ${key} is missing source_audit_sha256 binding`);
      error.code = 'AUDIT_BINDING_MISSING';
      throw error;
    }
    if (receipt.source_audit_sha256 !== currentAuditSha256) {
      const error = new Error(`receipt for ${key} no longer matches the canonical audit`);
      error.code = 'AUDIT_TAMPERED';
      throw error;
    }
  }

  // Only after receipt state/binding precedence is established, trust the
  // immutable artifact for the prepared product repository/rollback identity.
  const preparedArtifact = readHandoffArtifact(cwd, runId, { requirePending: false });
  if (preparedArtifact.source_audit_sha256 !== currentAuditSha256) {
    const error = new Error(`prepared handoff artifact audit binding does not match canonical audit`);
    error.code = 'AUDIT_TAMPERED';
    throw error;
  }
  const preparedByKey = new Map(preparedArtifact.items.map((item) => [item.key, item]));
  const pendingItems = pendingEntries.map(({ finding, key }) =>
    canonicalItemFromFinding(finding, runId, currentAuditSha256, preparedByKey.get(key)?.rollback));

  // The prepared artifact is the immutable baseline for dispatch. Cross-check
  // both the receipt and the audit-derived item before trusting rollback data.
  // Audit binding: every pending receipt must have a stored source_audit_sha256
  // that matches the current canonical audit. If the audit changed, the artifact
  // is missing/corrupt, or the receipt binding is absent/mismatched, fail closed.
  for (const item of pendingItems) {
    const receipt = readReceipt(directory, item.key);
    const preparedItem = preparedByKey.get(item.key);
    if (!preparedItem) {
      const error = new Error(`prepared handoff artifact is missing ${item.key}`);
      error.code = 'PREPARED_ITEM_TAMPERED';
      throw error;
    }
    if (JSON.stringify(receipt?.rollback) !== JSON.stringify(preparedItem.rollback)) {
      const error = new Error(`rollback baseline for ${item.key} does not match the canonical prepared item`);
      error.code = 'ROLLBACK_BASELINE_TAMPERED';
      throw error;
    }
    if (JSON.stringify(item.rollback) !== JSON.stringify(preparedItem.rollback)) {
      const error = new Error(`current repository baseline for ${item.key} changed after prepare`);
      error.code = 'ROLLBACK_BASELINE_MISMATCH';
      throw error;
    }
    if (JSON.stringify({ ...item, rollback: undefined }) !== JSON.stringify({ ...preparedItem, rollback: undefined })) {
      const error = new Error(`audit-derived handoff item ${item.key} does not match the canonical prepared item`);
      error.code = 'PREPARED_ITEM_TAMPERED';
      throw error;
    }
    const storedHash = receipt?.source_audit_sha256;
    if (!storedHash) {
      const error = new Error(
        `receipt for ${item.key} is missing source_audit_sha256 binding — re-run \`handoff prepare\` to bind it`,
      );
      error.code = 'AUDIT_BINDING_MISSING';
      throw error;
    }
    if (storedHash !== currentAuditSha256) {
      const error = new Error(
        `receipt for ${item.key} was bound to audit ${storedHash.slice(0, 16)}… but canonical audit is now ${currentAuditSha256.slice(0, 16)}… — audit may have changed`,
      );
      error.code = 'AUDIT_TAMPERED';
      throw error;
    }
    const rollbackRoot = receipt?.rollback?.git_root;
    const preparedHead = receipt?.rollback?.pre_fix_head_sha;
    const currentDirty = rollbackRoot ? getDirtyStatus(rollbackRoot) : { dirty: true, files: [] };
    if (currentDirty.dirty) {
      const error = new Error(`rollback worktree for ${item.key} is dirty: ${currentDirty.files.join(', ')}`);
      error.code = 'DIRTY_WORKTREE';
      throw error;
    }
    const currentHead = rollbackRoot ? getHeadSha(rollbackRoot) : null;
    if (!preparedHead || currentHead !== preparedHead) {
      const error = new Error(
        `rollback baseline for ${item.key} changed: prepared ${preparedHead || 'missing'}, current ${currentHead || 'missing'}`,
      );
      error.code = 'ROLLBACK_BASELINE_MISMATCH';
      throw error;
    }
  }

  const claims = [];
  const claimRecords = [];
  const claimedItems = [];
  const unclaimed = [];

  for (const item of pendingItems) {
    const result = claimDispatchKey(cwd, runId, item.key);
    if (result.claimed) {
      claims.push({ key: item.key, claim_token: result.token, finding_id: item.finding_id });
      claimRecords.push({ key: item.key, token: result.token, claimPath: result.claimPath });
      claimedItems.push(item);
    } else {
      unclaimed.push(item.key);
    }
  }

  if (claimedItems.length === 0) {
    const error = new Error(
      `all ${pendingItems.length} pending items are already claimed by active claims: ${unclaimed.join(', ')}`,
    );
    error.code = 'ALL_CLAIMED';
    throw error;
  }

  // Write a unique dispatch artifact using UUID to avoid collisions.
  const dispatchPath = join(handoffsDir, `dispatch-${randomUUID()}.json`);
  const dispatchArtifact = {
    schema_version: 1,
    tool: audit.tool || { name: 'caveman-ui-ux', version: '1.0.0' },
    run_id: runId,
    source_audit_sha256: currentAuditSha256,
    items: claimedItems,
    item_count: claimedItems.length,
    diagnostics: [],
    claimed_at: new Date().toISOString(),
  };
  const dispatchRaw = `${JSON.stringify(dispatchArtifact, null, 2)}\n`;
  try {
    writeFileSync(dispatchPath, dispatchRaw, { encoding: 'utf8', flag: 'wx' });
    const dispatchSha256 = sha256(dispatchRaw);
    for (const record of claimRecords) {
      const lockPath = keyLockPath(cwd, runId, record.key);
      if (!acquireLock(lockPath)) throw claimBusyError(record.key);
      try {
        const live = readClaim(cwd, runId, record.key);
        if (!live || live.token !== record.token) throw new Error(`claim ownership changed for ${record.key}`);
        writeFileSync(record.claimPath, JSON.stringify({
          ...live,
          source_audit_sha256: currentAuditSha256,
          dispatch_binding: { path: dispatchPath, sha256: dispatchSha256 },
        }), 'utf8');
      } finally {
        releaseLock(lockPath);
      }
    }
  } catch (err) {
    for (const record of claimRecords) releaseClaim(cwd, runId, record.key, record.token);
    try { unlinkSync(dispatchPath); } catch {}
    throw err;
  }

  return {
    dispatch_artifact_path: dispatchPath,
    claims,
    unclaimed: unclaimed.length > 0 ? unclaimed : [],
  };
}

// ---------------------------------------------------------------------------
// Retry: failed → pending with attempt history and cap
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;

/**
 * Retry a failed handoff key: transition failed → pending, preserving attempt history.
 * Active claims block retry. Never downgrades implemented/verification_required/verified.
 * Caps retries at MAX_RETRIES (default 3).
 */
export function retryHandoff(cwd, runId, key) {
  return withKeyLock(cwd, runId, key, () => {
  const directory = runDir(cwd, runId);
  const existing = readReceipt(directory, key);

  if (!existing) {
    const error = new Error(`no receipt found for key "${key}"`);
    error.code = 'RECEIPT_NOT_FOUND';
    throw error;
  }

  if (existing.state !== 'failed') {
    const error = new Error(
      `cannot retry key "${key}": receipt is in state ${existing.state} (must be failed)`,
    );
    error.code = 'INVALID_TRANSITION';
    throw error;
  }

  // Active claims block retry.
  if (readClaimToken(cwd, runId, key)) {
    const error = new Error(
      `cannot retry key "${key}": an active dispatch claim exists`,
    );
    error.code = 'CLAIM_CONFLICT';
    throw error;
  }

  const attempts = Array.isArray(existing.attempts) ? existing.attempts : [];
  if (attempts.length >= MAX_RETRIES) {
    const error = new Error(
      `cannot retry key "${key}": max retries (${MAX_RETRIES}) reached`,
    );
    error.code = 'MAX_RETRIES';
    throw error;
  }

  const now = new Date().toISOString();
  const receipt = {
    ...existing,
    state: 'pending',
    flow_id: null,
    diagnostic: null,
    attempts: [...attempts, {
      retried_at: now,
      previous_state: existing.state,
      previous_diagnostic: existing.diagnostic || null,
    }],
    updated_at: now,
  };
  writeReceipt(directory, key, receipt);
  return receipt;
  });
}
