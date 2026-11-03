// Quit must quit. A launcher that waited on a server still closing a browser's
// connection, or on a camera that would not disconnect, kept CamBridge in
// Activity Monitor after the panel said it had stopped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, createServer } from 'node:net';
import { spawn } from 'node:child_process';

import { createApp, stopAndExit } from '../src/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

function config(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-shutdown-'));
  const configPath = join(dir, 'cambridge.json');
  writeFileSync(configPath, JSON.stringify({
    cameras: [], cambridge: { bind: '127.0.0.1', port: 0, camdUrl: 'ws://127.0.0.1:1/ws', mdns: false, ble: { enabled: false } },
    logging: { dir: join(dir, 'logs'), level: 'info' },
  }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return configPath;
}

/** A connection holding a request half-sent, as a stalled client would. */
function halfRequest(port) {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1', () => {
      s.write('GET /api/state HTTP/1.1\r\nHost: x\r\n');
      resolve(s);
    });
    s.on('error', () => {});
  });
}

const quietLog = { info() {}, warn() {}, error() {} };

test('stop() returns promptly even with connections still open', async (t) => {
  const app = createApp({ configPath: config(t) });
  const { port } = await app.start();
  const stalled = await halfRequest(port);
  const keepAlive = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(keepAlive.status, 200);
  const t0 = Date.now();
  await app.stop();
  assert.ok(Date.now() - t0 < 2000, `stopped in ${Date.now() - t0} ms; before, close() waited for the stalled request`);
  assert.equal(app.stopStep, null);
  stalled.destroy();
});

test('stopAndExit exits at the deadline when a step hangs, naming the step', async () => {
  const warnings = [];
  const app = { log: { ...quietLog, warn: (_, m) => warnings.push(m) }, stopStep: 'ptz', stop: () => new Promise(() => {}) };
  const code = await new Promise((resolve) => stopAndExit(app, 'test', { deadlineMs: 50, exit: resolve }));
  assert.equal(code, 0);
  assert.match(warnings.join('\n'), /still stopping after 0\.05 s \(at: ptz\); exiting anyway/);
});

test('stopAndExit exits as soon as stop() finishes, and a second request exits at once', async () => {
  let release;
  const app = { log: quietLog, stopStep: null, stop: () => new Promise((r) => { release = r; }) };
  const exits = [];
  stopAndExit(app, 'first', { deadlineMs: 10_000, exit: (c) => exits.push(['second-or-done', c]) });
  stopAndExit(app, 'second', { exit: (c) => exits.push(['insist', c]) });
  assert.deepEqual(exits, [['insist', 0]]);
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(exits, [['insist', 0], ['second-or-done', 0]]);
});

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Runs the server under a bash "launcher", as CamBridge.app does. */
async function launched(t, configPath) {
  const port = await freePort();
  const sh = spawn('bash', ['-c', 'CAMBRIDGE_LAUNCHER_PID=$$ node cambridge/src/server.js --config "$1" --port "$2" & echo "$!"; wait', 'launcher', configPath, String(port)], {
    cwd: repo, env: { ...process.env, CAMBRIDGE_CAMD: 'off' }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => { try { sh.kill('SIGKILL'); } catch { /* gone */ } });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the server did not start: ${out}`)), 15_000);
    sh.stdout.on('data', (d) => {
      out += d;
      const pid = Number(out.split('\n')[0]);
      if (pid && /cambridge ready/.test(out)) { clearTimeout(timer); resolve({ sh, pid, port }); }
    });
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

test('the server exits on SIGTERM with a connection held open', async (t) => {
  const { pid, port } = await launched(t, config(t));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  const stalled = await halfRequest(port);
  process.kill(pid, 'SIGTERM');
  assert.ok(await gone(pid, 6000), 'exited within its 5 s deadline');
  stalled.destroy();
});

test('the server goes when its launcher is force-quit', async (t) => {
  const { sh, pid } = await launched(t, config(t));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  sh.kill('SIGKILL');
  assert.ok(await gone(pid, 6000), 'noticed the launcher had gone, and exited');
});

test('stop_children: TERM, then KILL whatever ignores it, and never waits past the grace', async () => {
  const script = `
    . scripts/stop-children.sh
    sh -c 'trap "" TERM; sleep 30' & stubborn=$!
    sleep 30 & polite=$!
    sh -c 'exit 0' & done_already=$!
    sleep 0.3
    start=$SECONDS
    stop_children 1 "$stubborn" "$polite" "$done_already" ""; status=$?
    echo "status=$status killed=$STOP_CHILDREN_KILLED stubborn=$stubborn took=$((SECONDS - start))"
    kill -0 "$stubborn" 2>/dev/null && ps -o stat= -p "$stubborn" | grep -qv Z && echo stubborn-alive
    kill -0 "$polite" 2>/dev/null && ps -o stat= -p "$polite" | grep -qv Z && echo polite-alive
    true`;
  const out = await new Promise((resolve, reject) => {
    const p = spawn('bash', ['-c', script], { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] });
    let o = '';
    p.stdout.on('data', (d) => { o += d; });
    p.on('exit', () => resolve(o));
    p.on('error', reject);
  });
  const m = out.match(/status=(\d+) killed=(\d*) stubborn=(\d+) took=(\d+)/);
  assert.ok(m, out);
  assert.equal(m[1], '1', 'reports that something had to be killed');
  assert.equal(m[2], m[3], 'only the process that ignored TERM was killed');
  assert.ok(Number(m[4]) <= 3, `took ${m[4]} s`);
  assert.doesNotMatch(out, /alive/);
});
