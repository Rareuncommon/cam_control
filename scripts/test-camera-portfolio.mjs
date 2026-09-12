// Real HTTP + WebSocket acceptance against the SDK-free, six-body simulator.
// Uses temporary config and loopback ports; never reads a studio camera config.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../cambridge/src/server.js';
import { hashPin } from '../cambridge/src/auth.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'cambridge-portfolio-'));
const configPath = join(dir, 'config.json');
let daemon, app, base, output = '';
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const port = await freePort();
const cfg = { cameras: [], camd: { bind: '127.0.0.1', restPort: port,
  connection: { discoveryIntervalMs: 100, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 500,
    reconnectBackoffMs: [100], reconnectBackoffMaxMs: 100 } },
  cambridge: { bind: '127.0.0.1', port: 0, camdUrl: `ws://127.0.0.1:${port}/ws` },
  logging: { dir: join(dir, 'logs'), level: 'error' },
  auth: { adminPin: hashPin('test-admin-pin'), operatorPin: hashPin('test-operator-pin'),
    tokens: { 'test-admin': 'admin', 'test-operator': 'operator' } } };
writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });
async function until(fn, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch { /* startup */ }
    await delay(75);
  }
  throw new Error(`Timed out: ${label}\n${output.slice(-2000)}`);
}
async function request(path, method = 'GET', body, token = 'test-admin') {
  const response = await fetch(base + path, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  return { status: response.status, body: await response.json() };
}
async function start() {
  output = '';
  daemon = spawn(join(root, 'camd/build/camd'), ['--config', configPath, '--fake-portfolio'],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stdout.on('data', chunk => { output += chunk; });
  daemon.stderr.on('data', chunk => { output += chunk; });
  daemon.on('error', error => { output += error.message; });
  await until(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, 'daemon startup');
  app = createApp({ configPath });
  const address = await app.start();
  base = `http://127.0.0.1:${address.port}`;
}
async function stop() {
  if (app) { await app.stop(); app = null; }
  if (daemon && daemon.exitCode === null) {
    const exited = once(daemon, 'exit');
    daemon.kill('SIGTERM');
    const timer = setTimeout(() => daemon.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  daemon = null;
}
try {
  await start();
  assert.equal((await request('/api/camera-support', 'GET', undefined, '')).status, 401);
  const catalog = await request('/api/camera-support', 'GET', undefined, 'test-operator');
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.models.length, 32);
  assert.equal((await request('/api/record-all', 'POST', { start: true }, 'test-operator')).body.ok, false);
  const discovered = await until(async () => {
    const r = await request('/api/discovered');
    return r.body.discovered?.length === 6 && r.body.discovered;
  }, 'six-camera discovery');
  assert.equal(new Set(discovered.map(c => c.identity)).size, 6);
  assert.equal(discovered.filter(c => c.transport === 'USB').length, 3);
  assert.ok(discovered.every(c => c.adoptable && !c.adopted));
  for (const camera of discovered) {
    const r = await request('/api/adopt', 'POST', { ...camera,
      username: camera.accessAuthRequired ? 'test-user' : '',
      password: camera.accessAuthRequired ? 'test-password' : '' });
    assert.equal(r.status, 201, JSON.stringify(r));
    assert.equal(r.body.ok, true);
  }
  async function connected() {
    const r = await request('/api/state');
    const cameras = r.body.view?.cameras ?? [];
    return cameras.length === 6 && cameras.every(c => c.state === 'connected' &&
      Object.keys(c.properties ?? {}).length > 0) && cameras;
  }
  const cameras = await until(connected, 'all adopted bodies connected');
  const usb = cameras.filter(c => c.model === 'ILCE-7M4');
  assert.equal(usb.length, 2);
  assert.notEqual(usb[0].deviceId, usb[1].deviceId);
  assert.notEqual(usb[0].id, usb[1].id);
  for (const camera of cameras) {
    assert.equal(camera.support.listedBySdk, true);
    assert.equal(camera.capabilities.schemaVersion, 1);
    assert.equal(camera.capabilities.panTilt.available, false);
    const property = Object.entries(camera.properties).find(([name, p]) =>
      p.writable && name === 'colorTemp');
    assert.ok(property, `${camera.id} has a simulated writable Kelvin control`);
    const changed = await request(`/api/cameras/${camera.id}/properties/colorTemp`, 'PUT', { value: 5600 }, 'test-operator');
    assert.equal(changed.status, 200, JSON.stringify(changed));
    for (const action of ['recordStart', 'recordStop']) {
      const r = await request(`/api/cameras/${camera.id}/actions/${action}`, 'POST', {}, 'test-operator');
      assert.equal(r.status, 200, JSON.stringify(r));
      assert.equal(r.body.ok, true);
    }
  }
  for (const method of ['PATCH', 'DELETE']) {
    assert.equal((await request(`/api/cameras/${usb[0].id}/adoption`, method,
      method === 'PATCH' ? { label: 'Forbidden rename' } : undefined, 'test-operator')).status, 403);
  }
  const adopted = (await request('/api/discovered')).body.discovered;
  assert.ok(adopted.every(c => c.adopted));
  const saved = JSON.parse(readFileSync(configPath));
  assert.equal(saved.cameras.length, 6);
  assert.equal(saved.cameras.filter(c => c.deviceId).length, 3);
  await stop();
  await start();
  const restored = await until(connected, 'six bodies restored after full restart');
  for (const camera of usb) assert.equal(restored.find(c => c.id === camera.id).deviceId, camera.deviceId);
  assert.ok((await request('/api/discovered')).body.discovered.every(c => c.adopted));
  console.log('PASS: 32 profiles; six unique USB/network cameras adopted, controlled, and restored; operator permissions verified.');
} finally {
  await stop();
  rmSync(dir, { recursive: true, force: true });
}
