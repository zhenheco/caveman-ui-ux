// B1-B3: target.start_command lifecycle and splitArgv array handling.
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { splitArgv, withTargetApp } from '../lib/capture.mjs';
import { CavemanError, EXIT } from '../lib/errors.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, '..', '..');
const CLI = join(SKILL_ROOT, 'scripts', 'caveman.mjs');

// --- helpers ----------------------------------------------------------------

/** Allocate a free port on 127.0.0.1, close it, and return the port number. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/** A fresh temp directory that we can rm -rf afterwards. */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'caveman-startcmd-'));
}

/** Write a minimal server.mjs that appends to SPAWN_MARKER and serves one HTML page. */
function writeServerScript(dir, port) {
  const script = join(dir, 'server.mjs');
  writeFileSync(script, [
    "import { createServer } from 'node:http';",
    "import { appendFileSync } from 'node:fs';",
    'const marker = process.env.SPAWN_MARKER;',
    "if (marker) appendFileSync(marker, 'x');",
    `const port = ${port};`,
    "createServer((_req, res) => {",
    "  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
    "  res.end('<!doctype html><html lang=en><head><title>Test</title></head><body><main><h1>Hello</h1></main></body></html>');",
    "}).listen(port, '127.0.0.1');",
  ].join('\n'), 'utf8');
  return script;
}

// --- browser check for T2 CLI tests -----------------------------------------

let t2SkipReason = false;
try {
  const doctor = spawnSync(process.execPath, [CLI, 'doctor', '--json'], {
    encoding: 'utf8', timeout: 300000, cwd: SKILL_ROOT,
  });
  const doctorJson = JSON.parse(doctor.stdout);
  const checks = doctorJson?.checks || [];
  const pwOk = checks.find((c) => c.name === 'playwright')?.status === 'ok';
  const brOk = checks.find((c) => c.name === 'browser')?.status === 'ok';
  if (!pwOk || !brOk) t2SkipReason = `browser unavailable (playwright=${pwOk}, browser=${brOk})`;
} catch {
  t2SkipReason = 'doctor check failed';
}

// ===========================================================================
// B1: splitArgv
// ===========================================================================

test('B1: splitArgv returns array as-is (no quote-splitting)', () => {
  const argv = ['npm', 'run', 'dev', '--', '--port', '3111'];
  assert.deepStrictEqual(splitArgv(argv), argv);
});

test('B1: splitArgv rejects array with non-string elements', () => {
  assert.throws(() => splitArgv(['npm', null, 'dev']), (err) => {
    assert.ok(err instanceof CavemanError);
    assert.equal(err.exitCode, EXIT.CONFIG);
    assert.match(err.message, /index 1/);
    return true;
  });
  assert.throws(() => splitArgv(['npm', 123, 'dev']), (err) => {
    assert.ok(err instanceof CavemanError);
    assert.equal(err.exitCode, EXIT.CONFIG);
    assert.match(err.message, /index 1/);
    return true;
  });
  assert.throws(() => splitArgv(['npm', '', 'dev']), (err) => {
    assert.ok(err instanceof CavemanError);
    assert.equal(err.exitCode, EXIT.CONFIG);
    assert.match(err.message, /index 1/);
    return true;
  });
  assert.throws(() => splitArgv([{}, 'run']), (err) => {
    assert.ok(err instanceof CavemanError);
    assert.equal(err.exitCode, EXIT.CONFIG);
    assert.match(err.message, /index 0/);
    return true;
  });
});

test('B1: splitArgv empty array returns [] (blank error from startTargetApp)', () => {
  assert.deepStrictEqual(splitArgv([]), []);
});

test('B1: splitArgv string form unchanged', () => {
  assert.deepStrictEqual(splitArgv('npm run dev'), ['npm', 'run', 'dev']);
  assert.deepStrictEqual(splitArgv('echo "hello world"'), ['echo', 'hello world']);
  assert.deepStrictEqual(splitArgv("echo 'hello world'"), ['echo', 'hello world']);
  assert.throws(() => splitArgv('echo "unclosed'), (err) => {
    assert.ok(err instanceof CavemanError);
    assert.match(err.message, /unterminated/);
    return true;
  });
});

// ===========================================================================
// B2: withTargetApp lifecycle management
// ===========================================================================

test('B2: withTargetApp is exported', () => {
  assert.equal(typeof withTargetApp, 'function');
});

test('B2: withTargetApp calls fn without spawning when no start_command', async () => {
  let called = false;
  const config = { target: { base_url: 'http://127.0.0.1:19999' } };
  await withTargetApp(config, process.cwd(), () => {}, async () => {
    called = true;
  });
  assert.equal(called, true);
});

// T1.1 — mutation-proof: uses a sentinel marker file to prove the child was never spawned.
// The old test only asserted `called === true`, which stays green even when the TCP guard
// is removed because a spawned child exits, the probe hits the pre-existing server, and
// the fn still runs.  A sentinel file written by start_command proves the guard blocked it.
test('B2: withTargetApp does not spawn when server already listening (no start log)', async () => {
  const port = await freePort();
  const marker = join(tmpdir(), `caveman-spawn-marker-${Date.now()}`);
  const baseUrl = `http://127.0.0.1:${port}`;

  const server = createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  try {
    const config = {
      target: {
        base_url: baseUrl,
        start_command: ['node', '-e',
          `require('fs').appendFileSync(${JSON.stringify(marker)},'x');require('http').createServer((q,s)=>{s.writeHead(200);s.end('ok')}).listen(${port},'127.0.0.1')`,
        ],
      },
    };

    const logLines = [];
    let fnCalled = false;
    await withTargetApp(config, process.cwd(), (msg) => { logLines.push(msg); }, async () => {
      fnCalled = true;
    });

    assert.equal(fnCalled, true, 'fn must be called');
    // 1. No spawn log — direct evidence the guard blocked the spawn.
    assert.equal(logLines.some((l) => l.includes('starting target app')), false,
      'must not log "starting target app" (guard blocked spawn)');
    // 2. Reuse log — direct evidence the guard took the reuse path.
    assert.equal(logLines.some((l) => l.includes('reusing the server already listening')), true,
      'must log "reusing the server already listening" (guard took reuse path)');
    // 3. Marker absent — auxiliary signal (not the sole spawn proof).
    assert.equal(existsSync(marker), false, 'start_command must NOT have been spawned (marker absent)');
    // 4. Pre-existing server must still be alive after withTargetApp returns.
    const alive = await fetch(baseUrl).then(() => true).catch(() => false);
    assert.equal(alive, true, 'pre-existing server must still be alive after withTargetApp');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try { rmSync(marker); } catch {}
  }
});

// T1.2 — the TCP guard uses isPortInUse (connect), not probeUrl (HTTP GET).
// A server that accepts TCP immediately but delays the HTTP response by 2.5 s
// (simulating Next.js cold compilation) must still be detected as "already listening"
// and therefore must NOT trigger a spawn.
test('B2: withTargetApp does not spawn when TCP connects but HTTP is slow (2.5s)', async () => {
  const port = await freePort();
  const marker = join(tmpdir(), `caveman-spawn-marker-${Date.now()}`);
  const baseUrl = `http://127.0.0.1:${port}`;

  const server = createServer((_req, res) => {
    setTimeout(() => { res.writeHead(200); res.end('ok'); }, 2500);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  try {
    const config = {
      target: {
        base_url: baseUrl,
        start_command: ['node', '-e',
          `require('fs').appendFileSync(${JSON.stringify(marker)},'x');require('http').createServer((q,s)=>{s.writeHead(200);s.end('ok')}).listen(${port},'127.0.0.1')`,
        ],
      },
    };

    const logLines = [];
    let fnCalled = false;
    await withTargetApp(config, process.cwd(), (msg) => { logLines.push(msg); }, async () => {
      fnCalled = true;
    });

    assert.equal(fnCalled, true, 'fn must be called');
    // 1. No spawn log — TCP guard detected the listening socket and blocked spawn.
    assert.equal(logLines.some((l) => l.includes('starting target app')), false,
      'must not log "starting target app" (TCP guard blocked spawn)');
    // 2. Reuse log — the guard took the reuse path.
    assert.equal(logLines.some((l) => l.includes('reusing the server already listening')), true,
      'must log "reusing the server already listening" (guard took reuse path)');
    // 3. Marker absent — auxiliary signal.
    assert.equal(existsSync(marker), false, 'start_command must NOT have been spawned (marker absent)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try { rmSync(marker); } catch {}
  }
});

test('B2: withTargetApp spawns when start_command set and base_url not answering', async () => {
  const config = {
    target: {
      base_url: 'http://127.0.0.1:19992',
      start_command: ['node', '-e', "require('http').createServer((_q,s)=>{s.writeHead(200);s.end('hi')}).listen(19992,'127.0.0.1')"],
      wait: { strategy: 'load', timeout_ms: 10000, settle_ms: 100 },
    },
  };
  let called = false;
  await withTargetApp(config, process.cwd(), () => {}, async () => {
    called = true;
  });
  assert.equal(called, true);
  // After fn returns, the server should be stopped.
  const probe = await fetch('http://127.0.0.1:19992').then(() => true).catch(() => false);
  assert.equal(probe, false, 'server should be stopped after withTargetApp');
});

test('B2: withTargetApp stops child when fn throws', async () => {
  const config = {
    target: {
      base_url: 'http://127.0.0.1:19993',
      start_command: ['node', '-e', "require('http').createServer((_q,s)=>{s.writeHead(200);s.end('hi')}).listen(19993,'127.0.0.1')"],
      wait: { strategy: 'load', timeout_ms: 10000, settle_ms: 100 },
    },
  };
  await assert.rejects(
    () => withTargetApp(config, process.cwd(), () => {}, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  // Server should be stopped even though fn threw.
  const probe = await fetch('http://127.0.0.1:19993').then(() => true).catch(() => false);
  assert.equal(probe, false, 'server should be stopped after fn throws');
});

// ===========================================================================
// T2: CLI integration — prove the four commands are wired to withTargetApp
// ===========================================================================

// T2.1: evidence standalone after a completed capture, with no server running,
// must still succeed.  If evidence did not wrap withTargetApp it would fail
// because there is nothing listening on base_url.
test('T2: evidence standalone succeeds after capture when no server is running', { skip: t2SkipReason }, async () => {
  const cwd = tempDir();
  const port = await freePort();
  const marker = join(cwd, 'spawn-marker');
  writeServerScript(cwd, port);

  const config = {
    version: 1,
    target: {
      base_url: `http://127.0.0.1:${port}`,
      start_command: ['node', join(cwd, 'server.mjs')],
      wait: { timeout_ms: 10000 },
    },
    viewports: [{ id: 'mobile', width: 375, height: 812 }],
  };
  writeFileSync(join(cwd, 'caveman.config.json'), JSON.stringify(config, null, 2), 'utf8');

  const env = { ...process.env, SPAWN_MARKER: marker };

  try {
    // Step 1: capture — starts the app, takes screenshots, stops the app.
    const capture = spawnSync(process.execPath, [CLI, 'capture', '--cwd', cwd, '--viewports', 'mobile', '--json'], {
      encoding: 'utf8', timeout: 120000, cwd, env,
    });
    assert.equal(capture.status, 0, `capture failed (${capture.status}):\n${capture.stderr}`);

    // Server must be stopped after capture.
    const probeAfterCapture = await fetch(`http://127.0.0.1:${port}`).then(() => true).catch(() => false);
    assert.equal(probeAfterCapture, false, 'server must be stopped after capture');

    // Clear the marker so we can detect the evidence step's own spawn.
    try { rmSync(marker); } catch {}

    // Step 2: evidence — no server is running, so evidence must start it itself.
    const evidence = spawnSync(process.execPath, [CLI, 'evidence', '--cwd', cwd, '--no-lighthouse', '--json'], {
      encoding: 'utf8', timeout: 120000, cwd, env,
    });
    assert.equal(evidence.status, 0, `evidence failed (${evidence.status}):\n${evidence.stderr}`);

    // evidence must have started the app itself.
    assert.equal(existsSync(marker), true, 'evidence must have spawned the app (marker exists)');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// T2.2: the `audit` command runs capture + evidence inside a single withTargetApp
// wrapper.  The marker file must contain exactly 1 byte — not 2, not 4 — proving
// the app was spawned once for the entire audit, not once per stage.
test('T2: audit spawns the app exactly once (marker length = 1)', { skip: t2SkipReason }, async () => {
  const cwd = tempDir();
  const port = await freePort();
  const marker = join(cwd, 'spawn-marker');
  writeServerScript(cwd, port);

  const config = {
    version: 1,
    target: {
      base_url: `http://127.0.0.1:${port}`,
      start_command: ['node', join(cwd, 'server.mjs')],
      wait: { timeout_ms: 10000 },
    },
    viewports: [{ id: 'mobile', width: 375, height: 812 }],
  };
  writeFileSync(join(cwd, 'caveman.config.json'), JSON.stringify(config, null, 2), 'utf8');

  const env = { ...process.env, SPAWN_MARKER: marker };

  try {
    const audit = spawnSync(process.execPath, [
      CLI, 'audit', '--cwd', cwd, '--no-llm', '--no-lighthouse',
      '--allow-missing-technical', '--viewports', 'mobile', '--json',
    ], {
      encoding: 'utf8', timeout: 300000, cwd, env,
    });

    assert.equal(audit.status, 0, `audit failed (${audit.status}):\n${audit.stderr}`);

    // Marker must exist and contain exactly 1 byte — the app was spawned once.
    assert.equal(existsSync(marker), true, 'audit must have spawned the app');
    const content = readFileSync(marker, 'utf8');
    assert.equal(content.length, 1,
      `audit must spawn exactly once, got ${content.length} byte(s): ${JSON.stringify(content)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});