// Paired phones: signatures, replay and clock checks, pairing, revocation —
// and that browsers, Companion tokens and PINs work exactly as before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { DeviceRegistry, canonicalRequest, signRequest, parseAuthorization } from '../src/devices.js';
import { createApp } from '../src/server.js';
import { hashPin } from '../src/auth.js';

function registry(now = { t: 1_800_000_000_000 }) {
  let cfg = { auth: {} };
  const saves = [];
  const reg = new DeviceRegistry({
    readConfig: () => structuredClone(cfg),
    saveAuth: (patch) => { cfg.auth = { ...cfg.auth, ...structuredClone(patch) }; saves.push(patch); return { ok: true }; },
    now: () => now.t,
  });
  return { reg, now, cfg: () => cfg, saves };
}

/** What the app does for each request. */
function signed(id, secret, { method = 'GET', target = '/api/state', body = '', ts, nonce } = {}) {
  const t = String(ts ?? Date.now());
  const n = nonce ?? randomBytes(16).toString('base64url');
  const sig = signRequest(Buffer.from(secret, 'base64url'), { method, target, ts: t, nonce: n, body: Buffer.from(body) });
  return `CamBridge-HMAC id=${id}, ts=${t}, nonce=${n}, sig=${sig}`;
}

test('the canonical request, and parsing the header', () => {
  assert.equal(canonicalRequest({ method: 'put', target: '/api/x?y=1', ts: 5, nonce: 'n', body: Buffer.from('{}') }),
    'CAMBRIDGE-HMAC-V1\nPUT\n/api/x?y=1\n5\nn\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  assert.deepEqual(parseAuthorization('CamBridge-HMAC id=ph-1, ts=5, nonce=abc, sig=xyz'), { id: 'ph-1', ts: '5', nonce: 'abc', sig: 'xyz' });
  assert.equal(parseAuthorization('Bearer abc'), null);
  assert.equal(parseAuthorization('CamBridge-HMAC id=ph-1'), null);
});

test('a signed request passes once; replays, stale clocks, tampering and strangers do not', () => {
  const { reg, now } = registry();
  const { device, secret } = reg.create({ label: 'Pixel' });
  assert.equal(device.status, 'pending');
  const check = (authorization, o = {}) => reg.verifyRequest({
    method: o.method ?? 'GET', target: o.target ?? '/api/state', authorization, body: Buffer.from(o.body ?? ''), allowPending: o.allowPending,
  });

  const first = signed(device.id, secret, { ts: now.t, target: '/api/devices/activate', method: 'POST', body: '{"name":"Pixel 9a"}' });
  assert.equal(check(first, { method: 'POST', target: '/api/devices/activate', body: '{"name":"Pixel 9a"}' }).reason, 'not-activated',
    'a pending device can only activate');
  const okay = signed(device.id, secret, { ts: now.t, target: '/api/devices/activate', method: 'POST', body: '{"name":"Pixel 9a"}' });
  assert.equal(check(okay, { method: 'POST', target: '/api/devices/activate', body: '{"name":"Pixel 9a"}', allowPending: true }).ok, true);
  reg.activate(device.id, { name: 'Pixel 9a', model: 'Google Pixel 9a' });
  assert.equal(reg.get(device.id).status, 'active');

  const auth = signed(device.id, secret, { ts: now.t });
  assert.equal(check(auth).ok, true);
  assert.equal(check(auth).reason, 'replay', 'the same nonce twice');
  assert.equal(check(signed(device.id, secret, { ts: now.t }), { target: '/api/state?x=1' }).reason, 'bad-signature', 'a changed path');
  assert.equal(check(signed(device.id, secret, { ts: now.t, method: 'PUT', body: '{"value":1}' }), { method: 'PUT', body: '{"value":2}' }).reason,
    'bad-signature', 'a changed body');
  const stale = check(signed(device.id, secret, { ts: now.t - 121_000 }));
  assert.deepEqual([stale.reason, stale.serverTime], ['clock-skew', now.t]);
  assert.equal(check(signed('ph-nobody', secret, { ts: now.t })).reason, 'unknown-device');
  assert.equal(check(signed(device.id, Buffer.alloc(32).toString('base64url'), { ts: now.t })).reason, 'bad-signature');
  assert.equal(check('CamBridge-HMAC nonsense').reason, 'malformed');
  assert.equal(reg.get(device.id).lastVia, 'wifi');
});

test('an unused pairing code expires after ten minutes and is forgotten', () => {
  const { reg, now } = registry();
  const { device, secret } = reg.create();
  now.t += 10 * 60_000 + 1;
  const r = reg.verifyRequest({ method: 'POST', target: '/api/devices/activate', authorization: signed(device.id, secret, { ts: now.t, method: 'POST', target: '/api/devices/activate' }), body: Buffer.alloc(0), allowPending: true });
  assert.equal(r.reason, 'pairing-expired');
  assert.equal(reg.keyFor(device.id).reason, 'pairing-expired');
  assert.deepEqual(reg.list(), []);
});

test('revoking forgets the device at once, and says so', () => {
  const { reg, now, cfg } = registry();
  const { device, secret } = reg.create();
  reg.activate(device.id, { name: 'Pixel' });
  const revoked = [];
  reg.on('revoked', (id) => revoked.push(id));
  assert.equal(reg.revoke(device.id).ok, true);
  assert.deepEqual(revoked, [device.id]);
  assert.equal(cfg().auth.devices[device.id], undefined);
  assert.equal(reg.verifyRequest({ method: 'GET', target: '/api/state', authorization: signed(device.id, secret, { ts: now.t }), body: Buffer.alloc(0) }).reason, 'unknown-device');
  assert.equal(reg.revoke(device.id).status, 404);
});

test('too many failures from one address are slowed down', () => {
  const { reg, now } = registry();
  for (let i = 0; i < 30; i++) reg.verifyRequest({ method: 'GET', target: '/', authorization: 'CamBridge-HMAC x', body: Buffer.alloc(0), remote: '10.0.0.9' });
  assert.equal(reg.verifyRequest({ method: 'GET', target: '/', authorization: 'CamBridge-HMAC x', body: Buffer.alloc(0), remote: '10.0.0.9' }).status, 429);
  assert.equal(reg.verifyRequest({ method: 'GET', target: '/', authorization: 'CamBridge-HMAC x', body: Buffer.alloc(0), remote: '10.0.0.8' }).status, 401, 'other addresses unaffected');
  now.t += 61_000;
  assert.equal(reg.verifyRequest({ method: 'GET', target: '/', authorization: 'CamBridge-HMAC x', body: Buffer.alloc(0), remote: '10.0.0.9' }).status, 401);
});

// --- through the server --------------------------------------------------------

function setup(t, auth = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-devices-'));
  const configPath = join(dir, 'cambridge.json');
  writeFileSync(configPath, JSON.stringify({
    cameras: [], cambridge: { bind: '127.0.0.1', port: 0, camdUrl: 'ws://127.0.0.1:1/ws', name: 'Studio' },
    logging: { dir: join(dir, 'logs'), level: 'info' }, auth,
  }));
  const c = { dir, configPath };
  c.start = async () => { c.app = createApp({ configPath }); const a = await c.app.start(); c.base = `http://127.0.0.1:${a.port}`; };
  c.req = async (target, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(c.base + target, { method, headers: { 'Content-Type': 'application/json', ...headers }, body });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  c.as = (dev, target, { method = 'GET', body } = {}) => c.req(target, {
    method, body, headers: { Authorization: signed(dev.id, dev.secret, { method, target, body: body ?? '' }) },
  });
  c.config = () => JSON.parse(readFileSync(configPath, 'utf8'));
  t.after(async () => { await c.app?.stop(); rmSync(dir, { recursive: true, force: true }); });
  return c;
}

async function pair(c, headers = {}) {
  const made = await c.req('/api/devices', { method: 'POST', body: JSON.stringify({ label: 'Floor phone' }), headers });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const uri = new URL(made.body.pairing.uri);
  const dev = { id: uri.searchParams.get('id'), secret: uri.searchParams.get('k') };
  const act = await c.as(dev, '/api/devices/activate', { method: 'POST', body: JSON.stringify({ name: 'Pixel 9a', model: 'Google Pixel 9a' }) });
  assert.equal(act.status, 200, JSON.stringify(act.body));
  return { dev, uri, made };
}

test('an open panel: pairing, signed requests, and revocation', async (t) => {
  const c = setup(t);
  await c.start();
  assert.equal((await c.req('/api/state')).status, 200, 'unsigned requests work as before');

  const { dev, uri } = await pair(c);
  assert.equal(uri.protocol, 'cambridge:');
  assert.match(uri.searchParams.get('sid'), /^[0-9a-f]{16}$/);
  assert.equal(uri.searchParams.get('sn'), 'Studio');
  assert.equal(uri.searchParams.get('p'), new URL(c.base).port);
  assert.equal(Buffer.from(dev.secret, 'base64url').length, 32);
  const stored = c.config().auth.devices[dev.id];
  assert.equal(stored.secret, dev.secret, 'kept in the 0600 config');
  assert.equal(stored.name, 'Pixel 9a');

  const me = await c.as(dev, '/api/devices/me');
  assert.deepEqual([me.status, me.body.device.status, me.body.server.name], [200, 'active', 'Studio']);
  assert.equal((await c.as(dev, '/api/lighting/set', { method: 'POST', body: JSON.stringify({ target: { all: true }, intensity: 10 }) })).status, 200);
  const listed = (await c.req('/api/devices')).body.devices;
  assert.deepEqual(listed.map((d) => [d.id, d.status, d.lastVia]), [[dev.id, 'active', 'wifi']]);
  assert.ok(!JSON.stringify(listed).includes(dev.secret), 'the secret is never listed');

  // A forged signature is refused even though the panel is open.
  const forged = await c.req('/api/state', { headers: { Authorization: signed(dev.id, randomBytes(32).toString('base64url')) } });
  assert.deepEqual([forged.status, forged.body.deviceRejected, forged.body.reason], [401, true, 'bad-signature']);

  // The live stream closes when the phone is revoked.
  const ac = new AbortController();
  t.after(() => ac.abort());
  const stream = await fetch(`${c.base}/api/events?patch=1`, { headers: { Authorization: signed(dev.id, dev.secret, { target: '/api/events?patch=1' }) }, signal: ac.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  await reader.read();
  assert.equal((await c.req(`/api/devices/${dev.id}`, { method: 'DELETE' })).status, 200);
  const ended = await Promise.race([
    (async () => { for (;;) { const r = await reader.read(); if (r.done) return true; } })(),
    new Promise((r) => setTimeout(() => r(false), 2000)),
  ]);
  assert.equal(ended, true, 'the stream ended');
  const after = await c.as(dev, '/api/state');
  assert.deepEqual([after.status, after.body.reason], [401, 'unknown-device']);
  assert.equal(c.config().auth.devices[dev.id], undefined);
});

test('with a PIN: phones are operators; browsers, tokens and PIN changes are unaffected', async (t) => {
  const c = setup(t, { adminPin: hashPin('test-only-admin'), operatorPin: hashPin('test-only-op'), tokens: { 'test-companion': 'operator' } });
  await c.start();
  const admin = { Authorization: 'Bearer test-admin-token' };
  assert.equal((await c.req('/api/devices', { method: 'POST', body: '{}' })).status, 401, 'pairing needs a sign-in');
  assert.equal((await c.req('/api/devices', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer test-companion' } })).status, 403, 'and admin');

  // Sign in as admin the way the browser does.
  const login = await fetch(`${c.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: 'test-only-admin' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { dev } = await pair(c, { Cookie: cookie });
  void admin;

  assert.equal((await c.as(dev, '/api/state')).status, 200, 'a phone can operate');
  assert.equal((await c.as(dev, '/api/devices')).status, 403, 'but not pair or revoke phones');
  assert.equal((await c.req('/api/state')).status, 401, 'unsigned, unsigned-in is still refused');
  assert.equal((await c.req('/api/state', { headers: { Authorization: 'Bearer test-companion' } })).status, 200, 'Companion’s token still works');

  const pin = await c.req('/api/auth/pin', { method: 'POST', body: JSON.stringify({ role: 'operator', pin: 'test-only-new' }), headers: { Cookie: cookie } });
  assert.equal(pin.status, 200);
  assert.ok(c.config().auth.devices[dev.id], 'changing a PIN keeps the paired phones');
  assert.equal((await c.as(dev, '/api/state')).status, 200);

  const log = readFileSync(join(c.dir, 'logs', 'cambridge.log'), 'utf8');
  assert.match(log, /phone:Pixel 9a/);
});
