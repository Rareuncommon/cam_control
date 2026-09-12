import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPin } from '../src/auth.js';
import { createApp } from '../src/server.js';
import { viscaSimulator, panasonicSimulator } from './ptz-simulator.js';

test('HTTP PTZ lifecycle works without SDK: authorization, lease Stop, redaction, persistence and removal', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-ptz-api-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ cameras: [], cambridge: { bind: '127.0.0.1', port: 0, camdUrl: 'ws://127.0.0.1:1/ws' }, logging: { dir: join(dir, 'logs'), level: 'error' }, auth: { adminPin: hashPin('test-admin-pin'), operatorPin: hashPin('test-operator-pin'), tokens: { 'test-admin': 'admin', 'test-operator': 'operator' } } }));
  const sony = await viscaSimulator('visca-udp'), panasonic = await panasonicSimulator();
  let app = createApp({ configPath }), base;
  t.after(async () => { await app.stop(); await sony.close(); await panasonic.close(); rmSync(dir, { recursive: true, force: true }); });
  async function start() { const address = await app.start(); base = `http://127.0.0.1:${address.port}`; }
  async function req(path, method = 'GET', body, role = 'admin') {
    const r = await fetch(base + path, { method, headers: { Authorization: `Bearer test-${role}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }
  await start();
  const camera = { id: 'ptz-sony', profile: 'visca-udp', host: '127.0.0.1', port: sony.port };
  assert.equal((await req('/api/ptz/cameras', 'POST', camera, 'operator')).status, 403);
  assert.equal((await req('/api/ptz/cameras', 'POST', camera)).status, 201);
  assert.equal((await req('/api/ptz/cameras', 'POST', { id: 'ptz-pana', profile: 'panasonic-http', host: '127.0.0.1', port: panasonic.port, password: 'test-only-secret' })).status, 201);
  const view = await req('/api/state'); assert.equal(view.body.view.cameras.length, 2);
  assert.ok(!JSON.stringify(view).includes('test-only-secret'));
  assert.equal((await req('/api/cameras/ptz-sony/actions/%70tzPresetSave', 'POST', { slot: 1 }, 'operator')).status, 403);
  assert.equal((await req('/api/cameras/ptz-sony/actions/ptzMove', 'POST', { controlId: 'http-test', sequence: 1, pan: 0.5, leaseMs: 150 }, 'operator')).status, 202);
  await delay(450); await app.ptz.drain(app.ptz.get('ptz-sony'));
  assert.equal(app.ptz.get('ptz-sony').stopState, 'acknowledged');
  assert.equal(sony.events.at(-2).payload.toString('hex'), '8101060101010303ff');
  assert.equal(sony.events.at(-1).payload.toString('hex'), '8101040700ff');
  assert.equal((await req('/api/cameras/ptz-sony/actions/ptzMove', 'POST', { controlId: 'http-test', sequence: 2, pan: 0.5 }, 'operator')).status, 409);
  await app.stop(); app = createApp({ configPath }); await start();
  assert.equal((await req('/api/ptz/cameras')).body.cameras.length, 2);
  await app.ptz.drain(app.ptz.get('ptz-sony'));
  assert.equal((await req('/api/ptz/cameras/ptz-sony', 'DELETE')).status, 200);
  assert.equal(JSON.parse(readFileSync(configPath)).ptz.cameras.length, 1);
});
