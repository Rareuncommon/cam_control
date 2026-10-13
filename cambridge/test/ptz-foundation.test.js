// The PTZ foundation: transport, queue, deadman, tables, lifecycle, and the
// server running with no Sony bodies at all.
//
// Vendor drivers have their own tests against protocol fakes. These use the
// simulated head (drivers/fake.js), which sits behind the driver contract
// directly, so what is being tested is the part every vendor shares.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { digestHeader, parseChallenge, request } from '../src/ptz/http.js';
import { CommandQueue, PRIORITY } from '../src/ptz/queue.js';
import { MotionController } from '../src/ptz/motion.js';
import { validateTable, coerce, labelFor, publicSchema } from '../src/ptz/schema.js';
import { PtzCamera } from '../src/ptz/lifecycle.js';
import { FakePtz, fakeHead, resetFakeHeads } from '../src/ptz/drivers/fake.js';
import { camdNeeded, createApp } from '../src/server.js';
import { requiredRole } from '../src/auth.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, { timeoutMs = 3000, stepMs = 20 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  throw new Error('condition not met in time');
}

// --- http / digest ----------------------------------------------------------

test('digest response matches the worked example in RFC 2617', () => {
  const challenge = parseChallenge(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", '
    + 'nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  assert.equal(challenge.scheme, 'digest');
  assert.equal(challenge.params.qop, 'auth,auth-int');
  const h = digestHeader({
    username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html',
    challenge, nc: 1, cnonce: '0a4f113b',
  });
  assert.match(h, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(h, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
});

/** A camera-like server that wants Digest, and can be told to go silent. */
function digestServer({ user = 'admin', pass = 'secret', realm = 'cam' } = {}) {
  const nonce = 'abc123';
  const md5 = (s) => createHash('md5').update(s).digest('hex');
  const seen = { requests: 0, silent: false };
  const srv = createServer((req, res) => {
    seen.requests += 1;
    if (seen.silent) return;   // never answer
    const a = parseChallenge(req.headers.authorization);
    if (a?.scheme === 'digest') {
      const p = a.params;
      const ha1 = md5(`${user}:${realm}:${pass}`);
      const ha2 = md5(`${req.method}:${p.uri}`);
      const want = md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
      if (p.username === user && p.response === want) {
        res.end(`ok ${req.url}`);
        return;
      }
    }
    res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}"` });
    res.end();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen })));
}

test('request authenticates with Digest, then reuses the challenge', async () => {
  const { srv, port, seen } = await digestServer();
  try {
    const r1 = await request({ host: '127.0.0.1', port, path: '/cgi-bin/q?x=1', auth: { username: 'admin', password: 'secret' } });
    assert.equal(r1.ok, true);
    assert.equal(r1.text, 'ok /cgi-bin/q?x=1');
    const before = seen.requests;
    const r2 = await request({ host: '127.0.0.1', port, path: '/cgi-bin/q?x=2', auth: { username: 'admin', password: 'secret' } });
    assert.equal(r2.ok, true);
    // One round trip, not two: the cached challenge authenticated it up front.
    assert.equal(seen.requests - before, 1);
  } finally { srv.close(); }
});

test('a wrong password is reported as auth, a silent camera as a timeout', async () => {
  const { srv, port, seen } = await digestServer();
  try {
    const bad = await request({ host: '127.0.0.1', port, path: '/a', auth: { username: 'admin', password: 'nope' } });
    assert.equal(bad.ok, false);
    assert.equal(bad.kind, 'auth');
    seen.silent = true;
    const slow = await request({ host: '127.0.0.1', port, path: '/b', timeoutMs: 150 });
    assert.equal(slow.kind, 'timeout');
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('an unreachable camera is a network failure, not a throw', async () => {
  const r = await request({ host: '127.0.0.1', port: 9, path: '/', timeoutMs: 500 });
  assert.equal(r.ok, false);
  assert.ok(['network', 'timeout'].includes(r.kind));
});

// --- queue ------------------------------------------------------------------

test('motion overtakes a running read; motion runs one at a time; newer moves supersede', async () => {
  const q = new CommandQueue();
  const order = [];
  let releaseRead;
  let releaseM1;
  const readGate = new Promise((r) => { releaseRead = r; });
  const m1Gate = new Promise((r) => { releaseM1 = r; });
  const read = q.run(async () => { order.push('read'); await readGate; return 'r'; });
  const poll = q.run(async () => { order.push('poll'); return 'p'; }, { priority: PRIORITY.POLL });
  // A stop does not wait for the read already running — the reason the lane exists.
  const m1 = q.run(async () => { order.push('m1'); await m1Gate; return 'm1'; }, { priority: PRIORITY.MOTION, key: 'move:a' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['read', 'm1']);
  assert.equal(q.motionWaiting, true, 'a read can see it should yield');
  // While m1 runs, two more moves on the same key: only the newest goes out.
  const m2 = q.run(async () => { order.push('m2'); return 'm2'; }, { priority: PRIORITY.MOTION, key: 'move:a' });
  const m3 = q.run(async () => { order.push('m3'); return 'm3'; }, { priority: PRIORITY.MOTION, key: 'move:a' });
  releaseM1();
  assert.equal(await m1, 'm1');
  assert.deepEqual(await m2, { superseded: true });
  assert.equal(await m3, 'm3');
  releaseRead();
  assert.equal(await read, 'r');
  assert.equal(await poll, 'p');
  assert.deepEqual(order, ['read', 'm1', 'm3', 'poll']);
  assert.equal(q.motionWaiting, false);
});

test('queue honours the minimum gap between commands', async () => {
  const q = new CommandQueue({ minIntervalMs: 60 });
  const starts = [];
  await Promise.all([1, 2, 3].map(() => q.run(async () => { starts.push(Date.now()); })));
  assert.ok(starts[1] - starts[0] >= 55, `gap ${starts[1] - starts[0]}`);
  assert.ok(starts[2] - starts[1] >= 55, `gap ${starts[2] - starts[1]}`);
});

test('a job that never settles does not freeze the queue', async () => {
  const q = new CommandQueue({ jobTimeoutMs: 80 });
  const hung = q.run(() => new Promise(() => {}));
  const next = q.run(async () => 'after');
  await assert.rejects(hung, /did not complete/);
  assert.equal(await next, 'after');
});

// --- motion / deadman -------------------------------------------------------

function recordingDriver() {
  const calls = [];
  return {
    calls,
    panTilt: async (p, t) => { calls.push(['panTilt', p, t]); },
    zoom: async (s) => { calls.push(['zoom', s]); },
    focus: async (s) => { calls.push(['focus', s]); },
    stop: async () => { calls.push(['stop']); },
  };
}

test('a move that is not refreshed is stopped by the deadman', async () => {
  const d = recordingDriver();
  const m = new MotionController({ driver: d, queue: new CommandQueue(), deadmanMs: 150 });
  m.drive({ pan: 0.5, tilt: 0 });
  await sleep(30);
  assert.deepEqual(d.calls[0], ['panTilt', 0.5, 0]);
  assert.equal(m.moving, true);
  await until(() => d.calls.some((c) => c[0] === 'panTilt' && c[1] === 0 && c[2] === 0), { timeoutMs: 600 });
  assert.equal(m.moving, false);
});

test('refreshing keeps the move alive, and an identical refresh sends nothing', async () => {
  const d = recordingDriver();
  const m = new MotionController({ driver: d, queue: new CommandQueue(), deadmanMs: 150 });
  for (let i = 0; i < 6; i++) { m.drive({ zoom: 0.3 }); await sleep(60); }
  assert.equal(d.calls.filter((c) => c[0] === 'zoom').length, 1);
  assert.equal(m.moving, true);
  m.drive({ zoom: 0 });
  await sleep(20);
  assert.deepEqual(d.calls.at(-1), ['zoom', 0]);
});

test('axes are independent: stopping zoom does not stop a pan', async () => {
  const d = recordingDriver();
  const m = new MotionController({ driver: d, queue: new CommandQueue(), deadmanMs: 1000 });
  m.drive({ pan: -1, tilt: 0.2 });
  m.drive({ zoom: 0.5 });
  m.drive({ zoom: 0 });
  await sleep(30);
  assert.equal(m.moving, true);
  assert.ok(!d.calls.some((c) => c[0] === 'panTilt' && c[1] === 0));
  await m.stopAll('test');
});

test('a latched source is stopped when it goes away', async () => {
  const d = recordingDriver();
  const m = new MotionController({ driver: d, queue: new CommandQueue(), deadmanMs: 100 });
  m.drive({ pan: 1, tilt: 0 }, { source: 'skaarhoj', latch: true });
  await sleep(250);
  assert.equal(m.moving, true, 'a latched move outlives the deadman');
  m.releaseSource('skaarhoj');
  await sleep(20);
  assert.deepEqual(d.calls.at(-1), ['panTilt', 0, 0]);
  assert.equal(m.moving, false);
});

test('a failed stop is retried; a failed move is not', async () => {
  const d = recordingDriver();
  let fails = 2;
  d.stop = async () => { d.calls.push(['stop']); if (fails-- > 0) throw new Error('lost'); };
  const m = new MotionController({ driver: d, queue: new CommandQueue() });
  const r = await m.stopAll('test');
  assert.equal(r.ok, true);
  assert.equal(d.calls.filter((c) => c[0] === 'stop').length, 3);
});

// --- tables -----------------------------------------------------------------

test('the simulated table is sound, and coercion is strict about substance', () => {
  const head = new FakePtz({ host: 'fake-t1', options: { tracking: true } });
  const table = head.schema();
  assert.deepEqual(validateTable(table), []);
  const byId = Object.fromEntries(table.map((e) => [e.id, e]));
  assert.deepEqual(coerce(byId.trackingEnabled, 'on'), { ok: true, value: true });
  assert.deepEqual(coerce(byId.wbMode, 'Colour temp.'), { ok: true, value: 'manual' });
  assert.equal(coerce(byId.wbMode, 'sunset').ok, false);
  assert.deepEqual(coerce(byId.colorTemp, 5649), { ok: true, value: 5600 });
  assert.equal(coerce(byId.colorTemp, 99999).ok, false);
  assert.deepEqual(coerce(byId.iris, 5.66), { ok: true, value: 5.7 });
  assert.equal(coerce(byId.ipAddress, '10.0.0.999x').ok, false);
  assert.equal(labelFor(byId.gain, 6), '6 dB');
  assert.equal(labelFor(byId.adminPassword, 'hunter2'), '••••••');
  assert.ok(!('wire' in publicSchema([{ ...byId.gain, wire: { q: 'x' } }])[0]));
});

test('validateTable catches the mistakes a long table invites', () => {
  const problems = validateTable([
    { id: 'a', group: 'exposure', label: 'A', type: 'enum', options: [{ value: 1, label: 'x' }, { value: 1, label: 'y' }] },
    { id: 'a', group: 'nowhere', label: 'B', type: 'range', range: { min: 5, max: 1 } },
    { id: 'Bad', group: 'image', label: '', type: 'thing' },
  ]);
  assert.ok(problems.some((p) => /duplicate option/.test(p)));
  assert.ok(problems.some((p) => /duplicate id/.test(p)));
  assert.ok(problems.some((p) => /unknown group/.test(p)));
  assert.ok(problems.some((p) => /min <= max/.test(p)));
  assert.ok(problems.some((p) => /camelCase/.test(p)));
  assert.ok(problems.some((p) => /unknown type/.test(p)));
});

// --- lifecycle --------------------------------------------------------------

const FAST = {
  heartbeatIntervalMs: 100, heartbeatTimeoutMs: 300,
  reconnectBackoffMs: [50, 100], reconnectBackoffMaxMs: 100,
  positionFastMs: 50, positionIdleMs: 100, statusMs: 100, settingsMs: 50, fastSettingsMs: 100,
  deadmanMs: 200,
};

function fakeCamera(host, extra = {}) {
  const cam = new PtzCamera({
    entry: { id: host, label: host.toUpperCase(), vendor: 'fake', ip: host, ...extra },
    Driver: FakePtz,
    tuning: FAST,
  });
  const events = { state: [], values: {}, ptz: null };
  cam.on('state', (e) => events.state.push(e.state));
  cam.on('values', (e) => Object.assign(events.values, e.values));
  cam.on('ptz', (e) => { events.ptz = e.ptz; });
  return { cam, events };
}

test('a camera connects, reads its whole table, and reports position', async () => {
  resetFakeHeads();
  const { cam, events } = fakeCamera('fake-a');
  cam.start();
  try {
    await until(() => cam.state === 'connected');
    await until(() => events.values.colorTemp);
    assert.equal(events.values.colorTemp.value, 5600);
    assert.equal(events.values.iris.writable, false, 'iris is gated behind iris mode');
    await until(() => events.ptz?.pan !== null && events.ptz?.pan !== undefined);
    assert.equal(cam.schema().capabilities.presets, 10);
  } finally { await cam.stop(); }
});

test('writes are validated, sent, and read back from the camera', async () => {
  resetFakeHeads();
  const { cam, events } = fakeCamera('fake-b');
  cam.start();
  try {
    await until(() => cam.state === 'connected');
    const bad = await cam.write('wbMode', 'sunset');
    assert.equal(bad.status, 400);
    const refused = await cam.write('colorTemp', 3200);
    assert.equal(refused.status, 409, 'the camera refuses while white balance is automatic');
    assert.match(refused.body.error, /manual/);
    assert.equal((await cam.write('wbMode', 'manual')).ok, true);
    const ok = await cam.write('colorTemp', 3249);
    assert.equal(ok.ok, true);
    assert.equal(ok.body.applied, 3200);
    await until(() => events.values.colorTemp?.value === 3200);
    // The camera is the source of truth: a change made behind our back shows up.
    fakeHead('fake-b').values.detail = 7;
    await until(() => events.values.detail?.value === 7);
  } finally { await cam.stop(); }
});

test('a silent camera goes to reconnecting and comes back on its own', async () => {
  resetFakeHeads();
  const { cam, events } = fakeCamera('fake-c');
  cam.start();
  try {
    await until(() => cam.state === 'connected');
    fakeHead('fake-c').down = true;
    await until(() => cam.state === 'reconnecting', { timeoutMs: 2000 });
    fakeHead('fake-c').down = false;
    await until(() => cam.state === 'connected', { timeoutMs: 2000 });
    // Cameras start out connecting, so the first transition reported is to connected.
    assert.deepEqual(events.state.filter((s, i, a) => s !== a[i - 1]).slice(0, 2),
      ['connected', 'reconnecting']);
  } finally { await cam.stop(); }
});

test('a move held when the link dropped is stopped on reconnect; otherwise nothing is sent', async () => {
  resetFakeHeads();
  const { cam } = fakeCamera('fake-d');
  cam.start();
  try {
    await until(() => cam.state === 'connected');
    const head = fakeHead('fake-d');
    cam.move({ pan: 1, tilt: 0 }, { latch: true, source: 'test' });
    await until(() => head.v.pan === 1);
    head.down = true;
    await until(() => cam.state === 'reconnecting', { timeoutMs: 2000 });
    head.down = false;
    await until(() => cam.state === 'connected', { timeoutMs: 2000 });
    await until(() => head.log.some((l) => l[0] === 'stop'));
    assert.equal(head.v.pan, 0);

    // A second drop with nothing held: no stop on reconnect, so a move made
    // from Reactor at that moment is not cut across.
    const stops = head.log.filter((l) => l[0] === 'stop').length;
    head.down = true;
    await until(() => cam.state === 'reconnecting', { timeoutMs: 2000 });
    head.down = false;
    await until(() => cam.state === 'connected', { timeoutMs: 2000 });
    await sleep(100);
    assert.equal(head.log.filter((l) => l[0] === 'stop').length, stops);
  } finally { await cam.stop(); }
});

test('presets are bounded by what the camera has', async () => {
  resetFakeHeads();
  const { cam } = fakeCamera('fake-e');
  cam.start();
  try {
    await until(() => cam.state === 'connected');
    assert.equal((await cam.preset('store', 3)).ok, true);
    assert.equal((await cam.preset('recall', 3)).ok, true);
    assert.equal((await cam.preset('recall', 11)).status, 400);
    assert.equal((await cam.preset('recall', 4)).status, 409, 'empty preset is a refusal');
  } finally { await cam.stop(); }
});

// --- the server, PTZ-only ---------------------------------------------------

test('camd is used unless every configured camera is a PTZ head', () => {
  assert.equal(camdNeeded({ camd: {}, cameras: [] }), true);
  assert.equal(camdNeeded({ camd: {}, cameras: [{ kind: 'ptz' }] }), false);
  assert.equal(camdNeeded({ camd: {}, cameras: [{ kind: 'ptz' }, { model: 'ILME-FX3' }] }), true);
  assert.equal(camdNeeded({ camd: { enabled: true }, cameras: [{ kind: 'ptz' }] }), true);
});

test('PTZ admin routes are admin, and so are the adoption routes the panel really calls', () => {
  assert.equal(requiredRole('DELETE', '/api/cameras/wide/adoption'), 'admin');
  assert.equal(requiredRole('PATCH', '/api/cameras/wide/adoption'), 'admin');
  assert.equal(requiredRole('POST', '/api/ptz/detect'), 'admin');
  assert.equal(requiredRole('POST', '/api/ptz/cameras'), 'admin');
  assert.equal(requiredRole('PUT', '/api/cameras/ptz1/admin-settings/ipAddress'), 'admin');
  assert.equal(requiredRole('POST', '/api/cameras/ptz1/admin-actions/reboot'), 'admin');
  assert.equal(requiredRole('POST', '/api/cameras/ptz1/ptz/move'), 'operator');
  assert.equal(requiredRole('PUT', '/api/cameras/ptz1/properties/gain'), 'operator');
});

async function ptzOnlyApp() {
  resetFakeHeads();
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-ptz-'));
  const configPath = join(dir, 'cambridge.json');
  writeFileSync(configPath, JSON.stringify({
    cambridge: { bind: '127.0.0.1', port: 0 },
    // Info, not error: the no-passwords-in-the-log check below should read
    // everything an ordinary installation writes.
    logging: { dir: join(dir, 'logs'), level: 'info' },
    ptz: { ...FAST, deadmanMs: 300 },
    cameras: [
      { id: 'left', kind: 'ptz', vendor: 'fake', label: 'Left', ip: 'fake-left', auth: { username: 'u', password: 'pw-not-logged' } },
      { id: 'right', kind: 'ptz', vendor: 'fake', label: 'Right', ip: 'fake-right', options: { tracking: true } },
    ],
  }));
  const app = createApp({ configPath });
  const addr = await app.start();
  const base = `http://127.0.0.1:${addr.port}`;
  const call = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, type, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  return { app, call, dir, configPath };
}

test('a PTZ-only venue runs without camd and controls its heads', async () => {
  const { app, call, dir, configPath } = await ptzOnlyApp();
  try {
    const health = await call('GET', '/api/health');
    assert.equal(health.body.camdUsed, false);
    assert.equal(health.body.ptzCameras, 2);

    await until(async () => (await call('GET', '/api/state')).body.view.cameras.every((c) => c.state === 'connected'));
    const { view } = (await call('GET', '/api/state')).body;
    assert.equal(view.camdUsed, false);
    const right = view.cameras.find((c) => c.id === 'right');
    assert.equal(right.kind, 'ptz');
    await until(async () => (await call('GET', '/api/state')).body.view.cameras.find((c) => c.id === 'right').properties.wbMode);
    const r2 = (await call('GET', '/api/state')).body.view.cameras.find((c) => c.id === 'right');
    assert.equal(r2.properties.wbMode.label, 'Auto');
    assert.equal(r2.capabilities.tracking.kind, 'autoTracking');

    // Tracking exists on the camera that has it, and only there.
    const sRight = await call('GET', '/api/cameras/right/schema');
    const sLeft = await call('GET', '/api/cameras/left/schema');
    assert.ok(sRight.body.entries.some((e) => e.id === 'trackingEnabled'));
    assert.ok(!sLeft.body.entries.some((e) => e.id === 'trackingEnabled'));
    assert.ok(!sLeft.body.entries.some((e) => 'wire' in e));

    // An ordinary setting, by label, with undo.
    const set = await call('PUT', '/api/cameras/left/properties/wbMode', { value: 'Indoor' });
    assert.equal(set.status, 200);
    assert.equal(fakeHead('fake-left').values.wbMode, 'indoor');
    const undone = await call('POST', '/api/cameras/left/undo');
    assert.equal(undone.body.ok, true);
    assert.equal(fakeHead('fake-left').values.wbMode, 'auto');

    // Moving, and the deadman stopping it when the refreshes stop.
    const mv = await call('POST', '/api/cameras/left/ptz/move', { pan: 0.8, tilt: -0.2 });
    assert.equal(mv.status, 200);
    await until(() => fakeHead('fake-left').v.pan === 0.8);
    await until(() => fakeHead('fake-left').v.pan === 0, { timeoutMs: 1500 });

    // Picture.
    const frame = await call('GET', '/api/cameras/left/liveview?single=1');
    assert.equal(frame.status, 200);
    assert.equal(frame.type, 'image/png');
    assert.equal(frame.body.subarray(1, 4).toString(), 'PNG');

    // Presets on the head.
    assert.equal((await call('POST', '/api/cameras/left/ptz/presets/2/store')).status, 200);
    assert.equal((await call('POST', '/api/cameras/left/ptz/presets/2/recall')).status, 200);

    // Dangerous settings: not through the ordinary route, not through actions,
    // and not without the camera's name typed back.
    const sneaky = await call('PUT', '/api/cameras/left/properties/ipAddress', { value: '10.1.1.1' });
    assert.equal(sneaky.status, 403);
    const reboot = await call('POST', '/api/cameras/left/actions/reboot');
    assert.equal(reboot.status, 403);
    const unconfirmed = await call('PUT', '/api/cameras/left/admin-settings/adminPassword', { value: 'x' });
    assert.equal(unconfirmed.status, 400);
    assert.equal(unconfirmed.body.needsConfirm, true);
    const confirmed = await call('PUT', '/api/cameras/left/admin-settings/adminPassword', { value: 'new-secret', confirm: 'left' });
    assert.equal(confirmed.status, 200);
    assert.equal(fakeHead('fake-left').values.adminPassword, 'new-secret');

    // Record-all leaves PTZ heads alone.
    const rec = await call('POST', '/api/record-all', { start: true });
    assert.equal(rec.body.results.length, 0);

    // Nothing logged a password.
    await sleep(50);
    const logs = readFileSync(join(dir, 'logs', 'cambridge.log'), 'utf8');
    assert.ok(!logs.includes('pw-not-logged'));
    assert.ok(!logs.includes('new-secret'));
    assert.ok(readFileSync(configPath, 'utf8').length > 0);
  } finally {
    await app.stop();
  }
});

test('presets stored from CamBridge get a name and a picture', async () => {
  const { app, call } = await ptzOnlyApp();
  try {
    await until(async () => (await call('GET', '/api/state')).body.view.cameras.every((c) => c.state === 'connected'));
    await until(async () => (await call('GET', '/api/cameras/left/schema')).body.capabilities);
    const stored = await call('POST', '/api/cameras/left/ptz/presets/4/store', { name: 'Lectern' });
    assert.equal(stored.status, 200);
    assert.equal(stored.body.saved.name, 'Lectern');
    const list = await call('GET', '/api/cameras/left/ptz/presets');
    assert.equal(list.body.count, 10);
    assert.deepEqual(list.body.presets.map((p) => [p.n, p.name, p.thumb]), [[4, 'Lectern', true]]);
    const thumb = await call('GET', '/api/cameras/left/ptz/presets/4/thumb');
    assert.equal(thumb.status, 200);
    assert.equal(thumb.type, 'image/png');
    assert.equal((await call('PUT', '/api/cameras/left/ptz/presets/4', { name: 'Pulpit' })).body.name, 'Pulpit');
    assert.equal((await call('DELETE', '/api/cameras/left/ptz/presets/4')).status, 200);
    assert.equal((await call('GET', '/api/cameras/left/ptz/presets')).body.presets.length, 0);
    assert.equal((await call('GET', '/api/cameras/left/ptz/presets/4/thumb')).status, 404);
  } finally {
    await app.stop();
  }
});

test('a camera that drops during its first full read reconnects instead of crashing', async () => {
  resetFakeHeads();
  const { cam } = fakeCamera('fake-f');
  const head = fakeHead('fake-f');
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  // Answer identify, then go silent as the table is being read.
  const realRead = FakePtz.prototype.read;
  let reads = 0;
  FakePtz.prototype.read = async function (entries) {
    reads += 1;
    if (reads === 1) head.down = true;
    return realRead.call(this, entries);
  };
  try {
    cam.start();
    await until(() => cam.state === 'reconnecting', { timeoutMs: 2000 });
    FakePtz.prototype.read = realRead;
    head.down = false;
    await until(() => cam.state === 'connected', { timeoutMs: 2000 });
    await sleep(50);
    assert.deepEqual(unhandled, []);
  } finally {
    FakePtz.prototype.read = realRead;
    process.off('unhandledRejection', onUnhandled);
    await cam.stop();
  }
});

test('PTZ heads can be added by host name, and reconnected on demand', async () => {
  const { app, call } = await ptzOnlyApp();
  try {
    const bad = await call('POST', '/api/ptz/cameras', { ip: 'not a host!', vendor: 'fake' });
    assert.equal(bad.status, 409);
    const added = await call('POST', '/api/ptz/cameras', { ip: 'fake-new', vendor: 'fake', label: 'New' });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const id = added.body.camera.id;
    await until(async () => (await call('GET', '/api/state')).body.view.cameras.find((c) => c.id === id)?.state === 'connected');

    fakeHead('fake-new').down = true;
    await until(async () => (await call('GET', '/api/state')).body.view.cameras.find((c) => c.id === id)?.state === 'reconnecting');
    fakeHead('fake-new').down = false;
    const r = await call('POST', `/api/cameras/${id}/actions/reconnect`);
    assert.equal(r.status, 200);
    await until(async () => (await call('GET', '/api/state')).body.view.cameras.find((c) => c.id === id)?.state === 'connected',
      { timeoutMs: 1000 });
  } finally {
    await app.stop();
  }
});

test('a camera can offer presets above its grid, around numbers it reserves', async () => {
  resetFakeHeads();
  const { cam } = fakeCamera('fake-g');
  cam.start();
  try {
    await until(() => cam.state === 'connected');
    cam.caps = { ...cam.caps, presetMax: 20, reservedPresets: [{ n: 15, reason: 'preset 15 runs the wiper' }] };
    assert.equal((await cam.preset('recall', 15)).body.error, 'preset 15 runs the wiper');
    assert.equal((await cam.preset('recall', 21)).status, 400);
    // 12 is above the 10-preset grid but within presetMax; the simulated head refuses it as empty.
    assert.equal((await cam.preset('recall', 12)).status, 409);
  } finally { await cam.stop(); }
});

// --- review regressions: a head must never be left moving ---------------------

test('a stop that fails keeps being retried, and a later stop is not swallowed as a duplicate', async () => {
  const d = recordingDriver();
  let failing = true;
  d.panTilt = async (p, t) => {
    d.calls.push(['panTilt', p, t]);
    if (p === 0 && t === 0 && failing) throw new Error('timeout');
  };
  const m = new MotionController({ driver: d, queue: new CommandQueue(), deadmanMs: 5000 });
  m.drive({ pan: 0.5, tilt: 0 });
  m.drive({ pan: 0, tilt: 0 });
  await sleep(30);
  assert.equal(m.moving, true, 'an unconfirmed stop still counts as moving');
  assert.equal(m.stopPending(), true);
  // The operator lets go again, or the deadman fires: that stop goes out.
  const before = d.calls.filter((c) => c[1] === 0).length;
  m.drive({ pan: 0, tilt: 0 });
  await sleep(20);
  assert.ok(d.calls.filter((c) => c[1] === 0).length > before, 'a repeated stop is sent, not suppressed');
  failing = false;
  await until(() => !m.stopPending(), { timeoutMs: 3000 });
  assert.equal(m.moving, false);
});

test('a link lost while a stop is unconfirmed stops the head on reconnect', async () => {
  resetFakeHeads();
  const { cam } = fakeCamera('fake-r1');
  cam.start();
  try {
    await until(() => cam.state === 'connected');
    const head = fakeHead('fake-r1');
    cam.move({ pan: 0.5 }, { latch: true, source: 'test' });
    await until(() => head.v.pan === 0.5);
    // The switch port flaps exactly as the operator lets go.
    head.down = true;
    cam.move({ pan: 0, tilt: 0 }, { latch: true, source: 'test' });
    await until(() => cam.state === 'reconnecting', { timeoutMs: 2000 });
    head.down = false;
    await until(() => cam.state === 'connected', { timeoutMs: 2000 });
    await until(() => head.v.pan === 0, { timeoutMs: 2000 });
  } finally { await cam.stop(); }
});

test('Reconnect pressed during an attempt does not start a second one', async () => {
  resetFakeHeads();
  const head = fakeHead('fake-r2');
  let identifies = 0;
  const realIdentify = FakePtz.prototype.identify;
  FakePtz.prototype.identify = async function () {
    identifies += 1;
    await sleep(150);
    return realIdentify.call(this);
  };
  const { cam, events } = fakeCamera('fake-r2');
  try {
    cam.start();
    await sleep(20);
    cam.reconnect();
    cam.reconnect();
    await until(() => cam.state === 'connected', { timeoutMs: 2000 });
    await sleep(300);
    assert.equal(identifies, 1);
    assert.equal(cam.state, 'connected');
    assert.ok(!events.state.includes('offline'), events.state.join(' > '));
  } finally {
    FakePtz.prototype.identify = realIdentify;
    head.down = false;
    await cam.stop();
  }
});

test('shutting down during a slow read still stops the head, and refuses new moves', async () => {
  resetFakeHeads();
  const { cam } = fakeCamera('fake-r3');
  cam.start();
  const realRead = FakePtz.prototype.read;
  try {
    await until(() => cam.state === 'connected');
    const head = fakeHead('fake-r3');
    cam.move({ pan: 0.7 }, { latch: true, source: 'test' });
    await until(() => head.v.pan === 0.7);
    FakePtz.prototype.read = async function (e) { await sleep(1500); return realRead.call(this, e); };
    cam.due.settings = 0;
    await sleep(80);   // a slow read is now in flight
    const stopping = cam.stop();
    assert.equal(cam.move({ pan: 1 }).ok, false, 'no new motion while stopping');
    const t0 = Date.now();
    await stopping;
    assert.equal(head.v.pan, 0, 'the stop reached the head');
    assert.ok(Date.now() - t0 < 1000, 'and did not wait for the read');
  } finally {
    FakePtz.prototype.read = realRead;
    await cam.stop();
  }
});

test('a refused preset recall leaves the head stopped, not moving with nobody owning it', async () => {
  resetFakeHeads();
  const { cam } = fakeCamera('fake-r4');
  cam.start();
  try {
    await until(() => cam.state === 'connected');
    const head = fakeHead('fake-r4');
    cam.move({ pan: 0.6 }, { latch: true, source: 'test' });
    await until(() => head.v.pan === 0.6);
    const r = await cam.preset('recall', 3);   // empty: refused
    assert.equal(r.status, 409);
    assert.equal(head.v.pan, 0);
  } finally { await cam.stop(); }
});

test('STOP on a camera that is not connected says it is not confirmed', async () => {
  resetFakeHeads();
  const { cam } = fakeCamera('fake-r5');
  cam.start();
  try {
    await until(() => cam.state === 'connected');
    fakeHead('fake-r5').down = true;
    await until(() => cam.state === 'reconnecting', { timeoutMs: 2000 });
    const r = await cam.stopMotion('panic');
    assert.equal(r.ok, false);
    assert.equal(r.body.unconfirmed, true);
    assert.equal(cam.movingAtDrop, true, 'and the reconnect will send it');
  } finally {
    fakeHead('fake-r5').down = false;
    await cam.stop();
  }
});

test('STOP ALL names the heads whose stop was not confirmed; two cameras cannot share an address', async () => {
  const { app, call } = await ptzOnlyApp();
  try {
    await until(async () => (await call('GET', '/api/state')).body.view.cameras.every((c) => c.state === 'connected'));
    const ok = await call('POST', '/api/ptz/stop-all');
    assert.equal(ok.body.ok, true);
    assert.deepEqual(ok.body.unconfirmed, []);
    fakeHead('fake-right').down = true;
    await until(async () => (await call('GET', '/api/state')).body.view.cameras.find((c) => c.id === 'right').state !== 'connected',
      { timeoutMs: 3000 });
    const partial = await call('POST', '/api/ptz/stop-all');
    assert.equal(partial.body.ok, false);
    assert.deepEqual(partial.body.unconfirmed, ['Right']);
    fakeHead('fake-right').down = false;

    const clash = await call('PATCH', '/api/cameras/left/adoption', { ip: 'fake-right' });
    assert.equal(clash.status, 409);
    assert.match(clash.body.error, /already "Right"/);
  } finally {
    await app.stop();
  }
});
