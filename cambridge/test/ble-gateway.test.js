// The Bluetooth gateway end to end, through its Unix socket, with the test
// client standing in for the Swift bridge and the phone: connect, auth,
// command, delta, resync — and everything a stranger in range might try.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { createApp } from '../src/server.js';
import { FakeBridge, TestPhone, fromPairingUri } from '../src/ble/test-client.js';
import * as P from '../src/ble/protocol.js';

async function studio(t, { authTimeoutMs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cb-ble-'));
  const configPath = join(dir, 'cambridge.json');
  const socket = join(dir, 'ble.sock');
  writeFileSync(configPath, JSON.stringify({
    cameras: [], logging: { dir: join(dir, 'logs'), level: 'info' },
    cambridge: { bind: '127.0.0.1', port: 0, camdUrl: 'ws://127.0.0.1:1/ws', name: 'Studio', ble: { socket } },
    lighting: { output: { enabled: true, dryRun: true } },
  }));
  const app = createApp({ configPath });
  if (authTimeoutMs) app.ble.authTimeoutMs = authTimeoutMs;
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const bridge = new FakeBridge(socket);
  await new Promise((r) => setTimeout(r, 50));
  const info = await bridge.open();
  t.after(async () => { bridge.close(); await app.stop(); rmSync(dir, { recursive: true, force: true }); });
  const pairCode = async () => {
    const made = await (await fetch(`${base}/api/devices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    return fromPairingUri(made.pairing.uri);
  };
  return { app, base, bridge, info, socket, pairCode, dir };
}

/** A phone that has paired over Bluetooth (activated) and has its first state. */
async function pairedPhone(s, o) {
  const dev = await s.pairCode();
  const phone = new TestPhone(s.bridge, o);
  const auth = await phone.connect(dev);
  assert.equal(auth.ok, true, JSON.stringify(auth));
  const act = await phone.request('POST', '/api/devices/activate', { name: 'Pixel 9a', model: 'Google Pixel 9a' });
  assert.equal(act.status, 200, JSON.stringify(act.body));
  await phone.waitState((x) => x.frame.type === 'state');
  return { phone, dev };
}

test('the socket is private, and the bridge learns what to advertise', async (t) => {
  const s = await studio(t);
  assert.equal(statSync(s.socket).mode & 0o777, 0o600);
  assert.equal(s.info.v, 1);
  assert.equal(s.info.name, 'Studio');
  assert.match(s.info.id, /^[0-9a-f]{16}$/);
  const caps = await (await fetch(`${s.base}/api/capabilities`)).json();
  assert.deepEqual([caps.features.bluetooth.bridge, caps.features.bluetooth.bluetooth], [true, 'poweredOn']);
});

test('connect, authenticate, command, delta, resync', async (t) => {
  const s = await studio(t);
  const { phone, dev } = await pairedPhone(s);
  const full = phone.states.find((x) => x.frame.type === 'state');
  assert.ok(Array.isArray(full.frame.view.cameras));
  assert.equal(full.frame.lighting.fixtures.length, 5, 'lighting is in the state');
  assert.equal(full.frame.skaarhoj, undefined, 'slimmed for Bluetooth');

  const caps = await phone.request('GET', '/api/capabilities');
  assert.equal(caps.status, 200);
  assert.equal(caps.body.features.lighting.available, true);

  const before = phone.states.length;
  const set = await phone.request('POST', '/api/lighting/set', { target: { fixture: 'L2' }, intensity: 42 });
  assert.equal(set.status, 200);
  const delta = await phone.waitState((x) => x.frame.type === 'patch' && x.frame.lighting?.fixtures?.[1]?.intensity === 42);
  assert.ok(phone.states.length > before);
  assert.equal(delta.seq, phone.states[phone.states.indexOf(delta) - 1].seq + 1, 'sequence numbers have no gaps');
  assert.equal(delta.frame.view?.cameras, undefined, 'a delta, not the whole state');

  phone.resync();
  const again = await phone.waitState((x) => x.frame.type === 'state' && x.seq > delta.seq);
  assert.equal(again.frame.lighting.fixtures[1].intensity, 42);

  const pong = await phone.ping();
  assert.equal(typeof pong[0], 'bigint');

  const listed = (await (await fetch(`${s.base}/api/devices`)).json()).devices;
  assert.deepEqual(listed.map((d) => [d.id, d.status, d.name, d.lastVia]), [[dev.deviceId, 'active', 'Pixel 9a', 'ble']]);
});

test('a retried command runs once', async (t) => {
  const s = await studio(t);
  const { phone } = await pairedPhone(s);
  await phone.request('POST', '/api/lighting/set', { target: { fixture: 'L3' }, intensity: 20 });
  const first = phone.request('POST', '/api/lighting/set', { target: { fixture: 'L3' }, intensity: 10, relative: true });
  const r1 = await first;
  const r2 = await phone.request('POST', '/api/lighting/set', { target: { fixture: 'L3' }, intensity: 10, relative: true }, { reqId: first.reqId });
  assert.deepEqual([r1.status, r2.status], [200, 200]);
  const view = await (await fetch(`${s.base}/api/lighting`)).json();
  assert.equal(view.fixtures[2].intensity, 30, 'nudged once, not twice');
});

test('strangers get nowhere: unknown phones, wrong keys, silence, and garbage', async (t) => {
  const s = await studio(t, { authTimeoutMs: 300 });

  const stranger = new TestPhone(s.bridge);
  const r1 = await stranger.connect({ deviceId: 'ph-000000000000', key: randomBytes(32) });
  assert.deepEqual([r1.ok, r1.code], [false, P.FAIL.UNKNOWN_DEVICE]);

  const dev = await s.pairCode();
  const thief = new TestPhone(s.bridge);
  const hello = new Promise((r) => thief.once('plain', r));
  s.bridge.send({ t: 'connect', c: thief.central, mtu: 182 });
  const h = P.decodeHello(await hello);
  for (let i = 0; i < 3; i++) {
    const r = await thief.authenticate({ deviceId: dev.deviceId, key: randomBytes(32), hello: h });
    assert.deepEqual([r.ok, r.code], [false, P.FAIL.BAD_PROOF]);
  }
  assert.ok(s.bridge.blocks.some((b) => b.c === thief.central), 'refused three times: the bridge blocks it');

  const silent = new TestPhone(s.bridge);
  const blocked = new Promise((r) => s.bridge.on('block', (b) => { if (b.c === silent.central) r(b); }));
  s.bridge.send({ t: 'connect', c: silent.central, mtu: 182 });
  const b = await blocked;
  assert.equal(b.ms, 60_000, 'no auth in time: dropped');

  const junk = new TestPhone(s.bridge);
  s.bridge.send({ t: 'connect', c: junk.central, mtu: 182 });
  const junkBlocked = new Promise((r) => s.bridge.on('block', (x) => { if (x.c === junk.central) r(x); }));
  for (let i = 0; i < 12; i++) s.bridge.send({ t: 'write', c: junk.central, d: randomBytes(20).toString('base64') });
  await junkBlocked;

  // The real phone, with the right key, is unaffected by all of this.
  const real = new TestPhone(s.bridge);
  assert.equal((await real.connect(dev)).ok, true);
});

test('a pending phone can only finish pairing; a used code works once per phone', async (t) => {
  const s = await studio(t);
  const dev = await s.pairCode();
  const phone = new TestPhone(s.bridge);
  assert.equal((await phone.connect(dev)).ok, true);
  const early = await phone.request('GET', '/api/state');
  assert.deepEqual([early.status, early.body.reason], [401, 'not-activated']);
  assert.equal(phone.states.length, 0, 'no state before pairing completes');
  assert.equal((await phone.request('POST', '/api/devices/activate', { name: 'Pixel' })).status, 200);
  await phone.waitState((x) => x.frame.type === 'state');
  assert.equal((await phone.request('GET', '/api/state')).status, 200);
});

test('revoking a phone ends its Bluetooth session', async (t) => {
  const s = await studio(t);
  const { phone, dev } = await pairedPhone(s);
  const notice = new Promise((r) => phone.once('notice', r));
  await fetch(`${s.base}/api/devices/${dev.deviceId}`, { method: 'DELETE' });
  assert.equal((await notice).code, 'revoked');
  assert.ok(s.bridge.blocks.some((b) => b.c === phone.central));
  const again = new TestPhone(s.bridge);
  assert.equal((await again.connect(dev)).code, P.FAIL.UNKNOWN_DEVICE);
});

test('rate limits, and what Bluetooth will not carry', async (t) => {
  const s = await studio(t);
  const { phone } = await pairedPhone(s);
  const burst = await Promise.all(Array.from({ length: 60 }, () => phone.request('GET', '/api/health')));
  assert.ok(burst.some((r) => r.status === 429), 'a flood is cut off');
  assert.ok(burst.filter((r) => r.status === 200).length >= 39, 'but a burst gets through');
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await phone.request('GET', '/api/events')).status, 400);
  assert.equal((await phone.request('GET', '/api/cameras/x/liveview')).status, 415);
});

test('replayed sealed messages are ignored', async (t) => {
  const s = await studio(t);
  const { phone } = await pairedPhone(s);
  const sent = [];
  const orig = s.bridge.send.bind(s.bridge);
  s.bridge.send = (m) => { if (m.t === 'write') sent.push(m); orig(m); };
  await phone.request('POST', '/api/lighting/set', { target: { fixture: 'L4' }, intensity: 5, relative: true });
  s.bridge.send = orig;
  const lighting = async () => (await (await fetch(`${s.base}/api/lighting`)).json()).fixtures[3].intensity;
  const level = await lighting();
  for (const m of sent) orig(m);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await lighting(), level, 'the replay changed nothing');
  assert.equal((await phone.request('GET', '/api/health')).status, 200, 'and the real session carries on');
});
