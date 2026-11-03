// Bonjour advertisement (against a fake spawn) and GET /api/capabilities.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MdnsAdvertiser, advertiseCommand } from '../src/mdns.js';
import { createApp } from '../src/server.js';

function fakeSpawn() {
  const children = [];
  const spawn = (bin, args) => {
    const c = new EventEmitter();
    c.bin = bin; c.args = args; c.killed = false;
    c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', null, 'SIGTERM')); };
    children.push(c);
    return c;
  };
  return { spawn, children };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the advertise command on macOS and Linux', () => {
  const o = { name: 'Studio', port: 8088, txt: { api: '1', id: 'abcdef0123456789' } };
  assert.deepEqual(advertiseCommand('darwin', o),
    ['/usr/bin/dns-sd', ['-R', 'Studio', '_cambridge._tcp', 'local', '8088', 'api=1', 'id=abcdef0123456789']]);
  assert.deepEqual(advertiseCommand('linux', o)[1], ['Studio', '_cambridge._tcp', '8088', 'api=1', 'id=abcdef0123456789']);
  assert.equal(advertiseCommand('win32', o), null);
});

test('the advertisement is restarted if it dies, and not after stop', async () => {
  const f = fakeSpawn();
  const logs = [];
  const m = new MdnsAdvertiser({ name: 'Studio', port: 8088, txt: { api: '1' }, spawn: f.spawn, platform: 'darwin', retryMs: 20, log: (l, s) => logs.push(s) });
  m.start();
  assert.equal(f.children.length, 1);
  f.children[0].emit('exit', 1, null);
  await wait(40);
  assert.equal(f.children.length, 2, 'respawned');
  m.stop();
  assert.equal(f.children[1].killed, true);
  await wait(60);
  assert.equal(f.children.length, 2, 'not after stop');
  assert.ok(logs.some((l) => /retrying in/.test(l)));
});

test('a missing tool is said once and not retried', async () => {
  const logs = [];
  const spawn = () => { const c = new EventEmitter(); setImmediate(() => c.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))); return c; };
  const m = new MdnsAdvertiser({ name: 'S', port: 1, spawn, platform: 'linux', retryMs: 10, log: (l, s) => logs.push(s) });
  m.start();
  await wait(50);
  assert.equal(logs.filter((l) => /not installed/.test(l)).length, 1);
  m.stop();
});

test('GET /api/capabilities says what this server offers', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-caps-'));
  const configPath = join(dir, 'cambridge.json');
  writeFileSync(configPath, JSON.stringify({ cameras: [], cambridge: { bind: '127.0.0.1', port: 0, camdUrl: 'ws://127.0.0.1:1/ws', name: 'Studio' }, logging: { dir: join(dir, 'logs'), level: 'error' } }));
  const app = createApp({ configPath });
  const { port } = await app.start();
  t.after(async () => { await app.stop(); rmSync(dir, { recursive: true, force: true }); });
  const caps = await (await fetch(`http://127.0.0.1:${port}/api/capabilities`)).json();
  assert.equal(caps.api, 1);
  assert.equal(caps.server.name, 'Studio');
  assert.match(caps.server.id, /^[0-9a-f]{16}$/);
  assert.equal(caps.features.lighting.available, true);
  assert.equal(caps.features.ptz, false);
  assert.equal(caps.auth.pin, false);
  assert.equal(caps.auth.signing, 'CamBridge-HMAC v1');
});
