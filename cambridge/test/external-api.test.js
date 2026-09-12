import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { hashPin } from '../src/auth.js';
import { blackmagicSimulator } from './external-simulator.js';

test('cinema HTTP lifecycle: roles, state, native values, record-all, redaction and restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-cinema-')), configPath = join(dir, 'config.json');
  const sim = await blackmagicSimulator(); let app, base;
  writeFileSync(configPath, JSON.stringify({ cameras: [], cambridge: { bind: '127.0.0.1', port: 0, camdUrl: 'ws://127.0.0.1:1/ws' }, logging: { dir: join(dir, 'logs'), level: 'error' }, auth: { adminPin: hashPin('test-only'), tokens: { 'test-admin': 'admin', 'test-operator': 'operator' } } }));
  async function start() { app = createApp({ configPath }); const address = await app.start(); base = `http://127.0.0.1:${address.port}`; }
  t.after(async () => { await app?.stop(); await sim.close(); rmSync(dir, { recursive: true, force: true }); });
  async function req(path, method = 'GET', body, role = 'admin') { const r = await fetch(base + path, { method, headers: { Authorization: `Bearer test-${role}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; }
  await start();
  const camera = { id: 'ext-cinema', provider: 'blackmagic-rest', host: '127.0.0.1', port: sim.port, username: 'test-user', password: 'test-only-secret' };
  assert.equal((await req('/api/external/cameras', 'POST', camera, 'operator')).status, 403);
  assert.equal((await req('/api/external/cameras', 'POST', camera)).status, 201);
  const view = (await req('/api/state')).body; assert.ok(!JSON.stringify(view).includes('test-only-secret')); assert.equal(view.view.cameras[0].external.controls[0].current, 400);
  assert.equal((await req('/api/external/cameras/ext-cinema/set', 'POST', { key: 'iso', value: 800 }, 'operator')).body.confirmed, true);
  assert.equal((await req('/api/record-all', 'POST', { start: true }, 'operator')).body.ok, true);
  const rolling = (await req('/api/state')).body.roll; assert.equal(rolling.all, true); assert.deepEqual((await req('/api/alarms')).body.roll, rolling);
  assert.equal((await req('/api/cameras/ext-cinema/actions/recordStop', 'POST', {}, 'operator')).body.ok, true); assert.equal(sim.state.recording, false);
  await app.stop(); await start(); await Promise.allSettled([...app.external.cameras.values()].flatMap(c => [...c.tasks]));
  assert.equal((await req('/api/state')).body.view.cameras[0].model, 'Blackmagic PYXIS 6K');
  assert.equal((await req('/api/external/cameras/ext-cinema', 'DELETE', undefined, 'operator')).status, 403);
  assert.equal((await req('/api/external/cameras/ext-cinema', 'DELETE')).status, 200);
  assert.equal(JSON.parse(readFileSync(configPath)).external.cameras.length, 0);
});
