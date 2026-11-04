// Phone app updates: CamBridge serves the APK the publish script left beside
// the config, to paired phones only, with its version and SHA-256.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import { signRequest } from '../src/devices.js';
import { createApp } from '../src/server.js';
import { createPhoneApp } from '../src/phone-app.js';

function signed(id, secret, { method = 'GET', target, body = '' }) {
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString('base64url');
  const sig = signRequest(Buffer.from(secret, 'base64url'), { method, target, ts, nonce, body: Buffer.from(body) });
  return `CamBridge-HMAC id=${id}, ts=${ts}, nonce=${nonce}, sig=${sig}`;
}

function publish(dir, meta, apk) {
  mkdirSync(dir, { recursive: true });
  if (apk) writeFileSync(join(dir, meta.file), apk);
  writeFileSync(join(dir, 'latest.json'), JSON.stringify(meta));
}

test('latest.json is read strictly: a whole-number version and an .apk in the same folder', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-phone-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = createPhoneApp({ dir });
  assert.deepEqual(app.describe(), { available: false, reason: 'nothing published' });

  publish(dir, { versionCode: 1.5, file: 'a.apk' }, Buffer.from('x'));
  assert.match(app.describe().reason, /whole-number versionCode/);
  publish(dir, { versionCode: 3, file: '../cambridge.json' });
  assert.match(app.describe().reason, /\.apk in the same folder/);
  publish(dir, { versionCode: 3, file: 'missing.apk' });
  assert.equal(app.describe().reason, 'missing.apk is missing');

  const apk = randomBytes(4096);
  publish(dir, { versionCode: 412, versionName: '1.1.0 (412)', file: 'CamBridge-412.apk' }, apk);
  assert.deepEqual(app.describe(), {
    available: true, versionCode: 412, versionName: '1.1.0 (412)', size: 4096,
    sha256: createHash('sha256').update(apk).digest('hex'),
  });
  const replaced = randomBytes(5000);
  publish(dir, { versionCode: 413, file: 'CamBridge-412.apk' }, replaced);
  assert.equal(app.describe().sha256, createHash('sha256').update(replaced).digest('hex'), 'a replaced file is hashed again');
});

test('paired phones see the version and download the APK; nobody else does', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-phone-app-'));
  const configPath = join(dir, 'cambridge.json');
  writeFileSync(configPath, JSON.stringify({
    cameras: [], cambridge: { bind: '127.0.0.1', port: 0, camdUrl: 'ws://127.0.0.1:1/ws', name: 'Studio' },
    logging: { dir: join(dir, 'logs'), level: 'info' },
  }));
  const app = createApp({ configPath });
  const { port } = await app.start();
  t.after(async () => { await app.stop(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;

  const made = await (await fetch(`${base}/api/devices`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Floor phone' }),
  })).json();
  const uri = new URL(made.pairing.uri);
  const dev = { id: uri.searchParams.get('id'), secret: uri.searchParams.get('k') };
  const activate = JSON.stringify({ name: 'Pixel 9a', model: 'Google Pixel 9a' });
  assert.equal((await fetch(`${base}/api/devices/activate`, {
    method: 'POST', body: activate,
    headers: { 'Content-Type': 'application/json', Authorization: signed(dev.id, dev.secret, { method: 'POST', target: '/api/devices/activate', body: activate }) },
  })).status, 200);
  const as = (target) => fetch(base + target, { headers: { Authorization: signed(dev.id, dev.secret, { target }) } });

  assert.equal((await fetch(`${base}/api/phone-app`)).status, 401, 'an unsigned request is refused');
  assert.equal((await fetch(`${base}/api/phone-app/apk`)).status, 401);
  assert.deepEqual(await (await as('/api/phone-app')).json(), { available: false, reason: 'nothing published' });
  assert.equal((await as('/api/phone-app/apk')).status, 404);

  const apk = randomBytes(200_000);
  publish(join(dir, 'phone-app'), { versionCode: 412, versionName: '1.1.0 (412)', file: 'CamBridge-412.apk' }, apk);
  const sha = createHash('sha256').update(apk).digest('hex');
  const about = await (await as('/api/phone-app')).json();
  assert.deepEqual(about, { available: true, versionCode: 412, versionName: '1.1.0 (412)', size: apk.length, sha256: sha });

  const r = await as('/api/phone-app/apk');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(r.headers.get('x-cambridge-sha256'), sha);
  const got = Buffer.from(await r.arrayBuffer());
  assert.ok(got.equals(apk), 'the bytes are the published APK');
});
