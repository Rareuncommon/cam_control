// The Canon XC driver against a protocol fake (test/fakes/canon-xc.js) that
// speaks the wire format from the spec notes: Livescope-Status, `:=` / `==?`
// replies, Digest, the multipart event stream.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { request } from '../src/ptz/http.js';
import { validateTable, coerce } from '../src/ptz/schema.js';
import { PtzCamera } from '../src/ptz/lifecycle.js';
import { DriverError } from '../src/ptz/driver.js';
import { driverFor } from '../src/ptz/drivers/index.js';
import {
  CanonXcPtz, MultipartReader, parseXc, panTiltSpeed, zoomSpeed, focusSpeed, parseAddonConfig,
} from '../src/ptz/drivers/canon-xc.js';
import { TABLE, GAPS } from '../src/ptz/tables/canon-cr-n500.js';
import { startFakeCanon } from './fakes/canon-xc.js';

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

function driver(fake, { auth = {}, options = {}, timeoutMs = 1000 } = {}) {
  return new CanonXcPtz({ host: '127.0.0.1', port: fake.port, auth, http: request, timeoutMs, options, log: () => {} });
}

const byId = Object.fromEntries(TABLE.map((e) => [e.id, e]));
/** The control.cgi requests the fake saw, as arrays of [key, value]. */
const controls = (fake) => fake.state.log.filter((l) => l.cmd === 'control').map((l) => l.params);
const lastControl = (fake) => controls(fake).at(-1);

async function rejects(p, kind, re) {
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof DriverError, `expected DriverError, got ${err}`);
    assert.equal(err.kind, kind, err.message);
    if (re) assert.match(err.message, re);
    return true;
  });
}

// --- table ---------------------------------------------------------------------

test('the CR-N500 table is sound', () => {
  assert.deepEqual(validateTable(TABLE), []);
  assert.ok(GAPS.length > 0);
  for (const e of TABLE) assert.ok(e.wire, `${e.id} has no wire descriptor`);
  // One entry per cross-vendor role.
  const roles = TABLE.filter((e) => e.role).map((e) => e.role);
  assert.equal(new Set(roles).size, roles.length);
  assert.equal(byId.focusMode.autoValue, 'auto');
  assert.equal(byId.focusMode.manualValue, 'manual');
  // Everything the add-on provides is impl-only, so flagged, and only offered with it.
  for (const e of TABLE.filter((x) => x.group === 'tracking')) {
    assert.equal(e.verify, true, e.id);
    assert.equal(e.requires, 'tracking', e.id);
  }
  assert.equal(driverFor('canon'), CanonXcPtz);
});

test('speed mapping: the slowest touch still moves, full stick is the maximum', () => {
  assert.equal(panTiltSpeed(0.001), 10);
  assert.equal(panTiltSpeed(-1), 10000);
  assert.equal(panTiltSpeed(0.5), 316);
  assert.equal(zoomSpeed(0.001), 1);
  assert.equal(zoomSpeed(-1), 15);
  assert.equal(focusSpeed(0.05), 0);
  assert.equal(focusSpeed(-1), 2);
});

test('XC reply and multipart parsing', () => {
  assert.deepEqual(parseXc('timestamp=1.0\r\nc.1.wb:=auto\nc.1.exp==?\ns.epoch:=Wed, 24 May 2023 15:44:37 +0900\n'), [
    ['timestamp', '=', '1.0'], ['c.1.wb', ':=', 'auto'], ['c.1.exp', '==', '?'],
    ['s.epoch', ':=', 'Wed, 24 May 2023 15:44:37 +0900'],
  ]);
  const parts = [];
  const r = new MultipartReader('boundary', (b) => parts.push(b));
  const body = 'c.1.zoom:=5070\n';
  const wire = `--boundary\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}\r\n--boundary\r\n\r\nx:=1\r\n--boundary--\r\n`;
  // Split at an awkward place: parts must survive arriving in pieces.
  r.push(Buffer.from(wire.slice(0, 30)));
  r.push(Buffer.from(wire.slice(30)));
  assert.deepEqual(parts, [body, 'x:=1\r\n']);
  assert.equal(r.ended, true);
  assert.deepEqual(parseAddonConfig('{"trackingEnable":"1"}'), { trackingEnable: '1' });
  assert.deepEqual(parseAddonConfig('trackingEnable=0\nsensitivity=5'), { trackingEnable: '0', sensitivity: '5' });
});

// --- probe, identity, auth --------------------------------------------------------

test('probe recognises the camera and nothing else', async () => {
  const fake = await startFakeCanon();
  const plain = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>hello</html>'); });
  const locked = createServer((req, res) => { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="other"' }); res.end(); });
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  await new Promise((r) => locked.listen(0, '127.0.0.1', r));
  try {
    const id = await CanonXcPtz.probe({ host: '127.0.0.1', port: fake.port, auth: {}, http: request, timeoutMs: 1000 });
    assert.deepEqual(id, { vendor: 'canon', model: 'CR-N500', firmware: '1.3.0' });
    assert.ok(fake.state.log.every((l) => l.cmd !== 'control'), 'probe must not control anything');
    assert.equal(await CanonXcPtz.probe({ host: '127.0.0.1', port: plain.address().port, auth: {}, http: request, timeoutMs: 1000 }), null);
    assert.equal(await CanonXcPtz.probe({ host: '127.0.0.1', port: locked.address().port, auth: { username: 'u', password: 'p' }, http: request, timeoutMs: 1000 }), null);
  } finally {
    plain.close(); locked.close(); await fake.close();
  }
});

test('Digest auth: the right password identifies, a wrong one is kind auth', async () => {
  const fake = await startFakeCanon({ username: 'operator', password: 'made-up-pass' });
  try {
    const ok = await driver(fake, { auth: { username: 'operator', password: 'made-up-pass' } }).identify();
    assert.equal(ok.vendor, 'canon');
    assert.equal(ok.model, 'CR-N500');
    assert.equal(ok.firmware, '1.3.0');
    assert.equal(ok.mac, '00:00:85:00:00:00');
    await rejects(driver(fake, { auth: { username: 'operator', password: 'wrong' } }).identify(), 'auth');
    await assert.rejects(
      CanonXcPtz.probe({ host: '127.0.0.1', port: fake.port, auth: { username: 'operator', password: 'wrong' }, http: request, timeoutMs: 1000 }),
      (err) => err.kind === 'auth' && !/wrong/.test(err.message));
  } finally { await fake.close(); }
});

test('a silent camera is a timeout', async () => {
  const fake = await startFakeCanon();
  try {
    const d = driver(fake, { timeoutMs: 300 });
    await d.identify();
    fake.setSilent(true);
    await rejects(d.heartbeat(), 'timeout');
    await rejects(d.read([byId.whiteBalance]), 'timeout');
    fake.setSilent(false);
    await d.heartbeat();
  } finally { await fake.close(); }
});

test('no tracking UI without the add-on; tracking entries and capability with it', async () => {
  const plain = await startFakeCanon();
  const withAddon = await startFakeCanon({ tracking: true });
  try {
    const a = driver(plain);
    await a.identify();
    assert.equal(a.capabilities().tracking, null);
    assert.ok(!a.schema().some((e) => e.requires === 'tracking'));

    const b = driver(withAddon);
    const id = await b.identify();
    assert.equal(id.tracking, true);
    assert.deepEqual(b.capabilities().tracking, { kind: 'autoTracking', label: 'Auto tracking (RA-AT001)' });
    assert.ok(b.schema().some((e) => e.id === 'autoTracking'));
    // Detection was a read, nothing else.
    assert.deepEqual(withAddon.state.log.map((l) => l.cmd), ['addon/get_config.cgi']);

    const got = await b.read([byId.autoTracking, byId.trackingSensitivity, byId.trackingLost]);
    assert.deepEqual(got.autoTracking, { value: false, writable: true });
    assert.equal(got.trackingSensitivity.value, 5);
    assert.equal(got.trackingLost.value, '0');
    await b.write(byId.autoTracking, true);
    assert.equal(withAddon.state.addon.trackingEnable, '1');
    assert.equal((await b.status()).tracking, true);
  } finally { await plain.close(); await withAddon.close(); }
});

// --- motion -----------------------------------------------------------------------

test('pan/tilt: directions, speed mapping, explicit stop of an idle axis, speed mode', async () => {
  const fake = await startFakeCanon();
  try {
    const d = driver(fake);
    await d.panTilt(0.5, 0);
    assert.deepEqual(lastControl(fake), [
      ['c.1.pan.speed.mode.dir', 'auto2'], ['c.1.pan', 'right'], ['c.1.pan.speed.dir', '316'], ['c.1.tilt', 'stop']]);
    await d.panTilt(-0.001, 1);
    assert.deepEqual(lastControl(fake), [
      ['c.1.pan.speed.mode.dir', 'auto2'], ['c.1.pan', 'left'], ['c.1.pan.speed.dir', '10'],
      ['c.1.tilt.speed.mode.dir', 'auto2'], ['c.1.tilt', 'up'], ['c.1.tilt.speed.dir', '10000']]);
    await d.panTilt(0, -0.5);
    assert.deepEqual(lastControl(fake), [
      ['c.1.pan', 'stop'], ['c.1.tilt.speed.mode.dir', 'auto2'], ['c.1.tilt', 'down'], ['c.1.tilt.speed.dir', '316']]);
    await d.panTilt(0, 0);
    assert.deepEqual(lastControl(fake), [['c.1.pan', 'stop'], ['c.1.tilt', 'stop']]);

    const constant = driver(fake, { options: { panTiltSpeedMode: 'manual' } });
    await constant.panTilt(1, 0);
    assert.deepEqual(lastControl(fake)[0], ['c.1.pan.speed.mode.dir', 'manual']);
    const camera = driver(fake, { options: { panTiltSpeedMode: 'camera' } });
    await camera.panTilt(1, 0);
    assert.deepEqual(lastControl(fake), [['c.1.pan', 'right'], ['c.1.pan.speed.dir', '10000'], ['c.1.tilt', 'stop']]);
    await camera.stop();
  } finally { await fake.close(); }
});

test('the head really moves, and position() normalises it', async () => {
  const fake = await startFakeCanon();
  try {
    const d = driver(fake);
    const p0 = await d.position();
    assert.equal(p0.pan, 0.5);              // pan 0 of −17000…17000
    assert.equal(p0.tilt, 0.25);            // tilt 0 of −3000…9000
    assert.equal(p0.zoom, 0);               // 7300 = the wide end
    assert.ok(Math.abs(p0.focus - 1352 / 2048) < 1e-9);
    await d.panTilt(1, 0);
    await d.zoom(1);
    await sleep(150);
    await d.stop();
    const p1 = await d.position();
    assert.ok(p1.pan > 0.5, `pan ${p1.pan}`);
    assert.ok(p1.zoom > 0, `zoom ${p1.zoom}`);
  } finally { await fake.close(); }
});

test('zoom and focus commands, and focus refused in AF', async () => {
  const fake = await startFakeCanon();
  try {
    const d = driver(fake);
    await d.zoom(0.001);
    assert.deepEqual(lastControl(fake), [['c.1.zoom', 'tele'], ['c.1.zoom.speed.dir', '1']]);
    await d.zoom(-1);
    assert.deepEqual(lastControl(fake), [['c.1.zoom', 'wide'], ['c.1.zoom.speed.dir', '15']]);
    await d.zoom(0);
    assert.deepEqual(lastControl(fake), [['c.1.zoom', 'stop']]);

    await rejects(d.focus(1), 'refused', /manual/);       // the camera answers c.1.focus.action==?
    await d.write(byId.focusMode, 'manual');
    await d.focus(1);
    assert.deepEqual(lastControl(fake), [['c.1.focus.speed', '2'], ['c.1.focus.action', 'far']]);
    await d.focus(-0.1);
    assert.deepEqual(lastControl(fake), [['c.1.focus.speed', '0'], ['c.1.focus.action', 'near']]);
    await d.focus(0);
    assert.deepEqual(lastControl(fake), [['c.1.focus.action', 'stop']]);
  } finally { await fake.close(); }
});

test('stop() sends every stop the notes call for, and the head is still', async () => {
  const fake = await startFakeCanon();
  try {
    const d = driver(fake);
    await d.write(byId.focusMode, 'manual');
    await d.panTilt(1, 1);
    await d.zoom(-1);
    await d.focus(1);
    const before = controls(fake).length;
    await d.stop();
    const sent = controls(fake).slice(before);
    assert.deepEqual(sent[0], [['c.1.pan', 'stop'], ['c.1.tilt', 'stop'], ['c.1.zoom', 'stop'], ['c.1.focus.action', 'stop']]);
    assert.deepEqual(sent[1], [['p.action', 'stop']]);
    assert.deepEqual(fake.state.vel, { pan: 0, tilt: 0, zoom: 0, focus: 0 });
    for (const k of ['c.1.pan.status', 'c.1.tilt.status', 'c.1.zoom.status']) assert.equal(fake.state.values.get(k), '0');
    // Safe when nothing moves.
    await d.stop();
  } finally { await fake.close(); }
});

test('another client holding control is a clear refusal, not a failure', async () => {
  const fake = await startFakeCanon();
  try {
    const d = driver(fake);
    fake.state.controlHeld = true;
    await rejects(d.panTilt(1, 0), 'refused', /another controller.*holds camera control/);
    await rejects(d.write(byId.knee, true), 'refused', /SKAARHOJ|Reactor/);
    await rejects(d.stop(), 'refused', /holds camera control/);
    // Reading still works: info.cgi needs no control right.
    await d.heartbeat();
    assert.equal((await d.read([byId.knee])).knee.value, false);
    fake.state.controlHeld = false;
    await d.stop();
  } finally { await fake.close(); }
});

// --- values -----------------------------------------------------------------------

test('read/write round trip: enum, scaled range, bool, snapping, text', async () => {
  const fake = await startFakeCanon();
  try {
    const d = driver(fake);
    const r0 = await d.read([byId.whiteBalance, byId.colorTemp, byId.gainValue, byId.knee, byId.ndFilter, byId.aeBrightness]);
    assert.equal(r0.whiteBalance.value, 'auto');
    assert.equal(r0.whiteBalance.allowed.length, 7);
    assert.equal(r0.colorTemp.value, 5600);
    assert.equal(r0.colorTemp.writable, false, 'colour temp is gated behind white balance');
    assert.equal(r0.gainValue.value, 0);
    assert.equal(r0.knee.value, false);
    assert.equal(r0.ndFilter.value, 0);
    assert.equal(r0.aeBrightness.writable, true);

    await d.write(byId.whiteBalance, 'kelvin');
    assert.equal(fake.state.values.get('c.1.wb'), 'kelvin');
    // 5650 is not one of the camera's steps; the nearest (5600) is sent and reported.
    const c = coerce(byId.colorTemp, 5650);
    assert.deepEqual(await d.write(byId.colorTemp, c.value), { applied: 5600 });
    await d.write(byId.colorTemp, 3200);
    assert.equal(fake.state.values.get('c.1.wb.kelvin'), '3200');

    await d.write(byId.gainMode, 'manual');
    await d.write(byId.gainValue, coerce(byId.gainValue, 6.5).value);
    assert.equal(fake.state.values.get('c.1.me.gain'), '65');            // dB×10 on the wire
    await d.write(byId.aeBrightness, -0.5);
    assert.equal(fake.state.values.get('c.1.ae.brightness'), '-2');      // EV×4
    await d.write(byId.knee, true);
    await d.write(byId.ndFilter, 1600);
    const r1 = await d.read([byId.gainValue, byId.knee, byId.ndFilter, byId.aeBrightness]);
    assert.equal(r1.gainValue.value, 6.5);
    assert.equal(r1.knee.value, true);
    assert.equal(r1.ndFilter.value, 1600);
    assert.equal(r1.aeBrightness.value, -0.5);

    await d.write(byId.whiteBalance, 'manual');
    await d.write(byId.wbManualGain, '300-200');
    assert.equal(fake.state.values.get('c.1.wb.value'), '300-200');
    await rejects(d.write(byId.wbManualGain, '3000-200'), 'refused', /1023/);
    // Every write went in the full key form.
    assert.ok(controls(fake).flat().every(([k]) => /^(c\.1\.|f\.|p)/.test(k)));
  } finally { await fake.close(); }
});

test('gate refusal, camera-refused value, unsupported setting', async () => {
  const fake = await startFakeCanon();
  try {
    const d = driver(fake);
    await rejects(d.write(byId.irisValue, 560), 'refused', /Iris mode set to Manual/);
    assert.equal(controls(fake).length, 0, 'a gated write is not sent');
    await rejects(d.write(byId.wbColorCorrection, 30), 'refused', /did not accept/);   // Livescope 403
    const got = await d.read([byId.colorBars, byId.knee]);
    assert.equal(got.colorBars.unsupported, true);
    assert.equal(got.knee.value, false);
    await rejects(d.write(byId.model, 'x'), 'unsupported');
  } finally { await fake.close(); }
});

test('standby: written through standby.cgi, then control is refused, info still works', async () => {
  const fake = await startFakeCanon();
  try {
    const d = driver(fake);
    await d.write(byId.powerState, 'standby');
    assert.equal(fake.state.values.get('f.standby'), 'standby');
    await rejects(d.panTilt(1, 0), 'refused', /standby/);
    await d.heartbeat();
    assert.equal((await d.read([byId.powerState])).powerState.value, 'standby');
    await d.write(byId.powerState, 'idle');
    await d.panTilt(0, 0);
  } finally { await fake.close(); }
});

test('actions: one-shot AF, one-shot WB, home', async () => {
  const fake = await startFakeCanon();
  try {
    const d = driver(fake);
    await d.action(byId.onePushAf);
    assert.deepEqual(lastControl(fake), [['c.1.focus.action', 'one_shot']]);
    await d.action(byId.wbSetA);
    assert.deepEqual(lastControl(fake), [['c.1.wb.action', 'one_shot_a']]);
    await d.action(byId.home);
    assert.deepEqual(lastControl(fake), [['c.1.pan', '0'], ['c.1.tilt', '0']]);
  } finally { await fake.close(); }
});

// --- presets, tally, picture ----------------------------------------------------------

test('presets: store, recall with speed, empty slot refused, delete', async () => {
  const fake = await startFakeCanon();
  try {
    const d = driver(fake);
    await d.presetStore(5);
    const stored = fake.state.log.filter((l) => l.cmd === 'preset/set').at(-1).params;
    assert.deepEqual(Object.fromEntries(stored), { p: '5', ptz: 'enabled', focus: 'enabled', exp: 'disabled', wb: 'disabled', is: 'disabled', cp: 'disabled' });
    await d.presetRecall(5, { speed: 0.5 });
    assert.deepEqual(lastControl(fake), [['p', '5'], ['p.ptzspeed', '50']]);
    await d.presetRecall(5);
    assert.deepEqual(lastControl(fake), [['p', '5']]);
    assert.equal(fake.state.values.get('p'), '5');
    const n = controls(fake).length;
    await rejects(d.presetRecall(6), 'refused', /empty/);
    assert.equal(controls(fake).length, n, 'an empty preset is not recalled');
    await d.presetDelete(5);
    assert.deepEqual(Object.fromEntries(fake.state.log.at(-1).params), { p: '5', cmd: 'delete' });
    await rejects(d.presetRecall(5), 'refused', /empty/);
    assert.equal(d.capabilities().presets, 100);
  } finally { await fake.close(); }
});

test('tally: one lamp and a mode, program wins', async () => {
  const fake = await startFakeCanon();
  try {
    const d = driver(fake);
    await d.setTally({ program: true, preview: true });
    assert.deepEqual(lastControl(fake), [['f.tally', 'on'], ['f.tally.mode', 'program']]);
    await d.setTally({ program: false, preview: true });
    assert.deepEqual(lastControl(fake), [['f.tally', 'on'], ['f.tally.mode', 'preview']]);
    await d.setTally({ program: false, preview: false });
    assert.deepEqual(lastControl(fake), [['f.tally', 'off']]);
    assert.equal(fake.state.values.get('f.tally'), 'off');
  } finally { await fake.close(); }
});

test('snapshot is a small JPEG from image.cgi', async () => {
  const fake = await startFakeCanon();
  try {
    const f = await driver(fake).snapshot();
    assert.equal(f.contentType, 'image/jpeg');
    assert.equal(f.body[0], 0xff);
    assert.equal(f.body[1], 0xd8);
    assert.deepEqual(fake.state.log.at(-1).params, [['v', 'jpg:640x360']]);
  } finally { await fake.close(); }
});

// --- push --------------------------------------------------------------------------

test('event stream: initial values, changes from other clients, reconnects, ends on close', async () => {
  const fake = await startFakeCanon({ username: 'operator', password: 'made-up-pass' });
  try {
    const d = driver(fake, { auth: { username: 'operator', password: 'made-up-pass' } });
    await d.identify();
    const values = {};
    const ptz = {};
    d.subscribe({ onValues: (v) => Object.assign(values, v), onPtz: (p) => Object.assign(ptz, p) });
    await until(() => values.whiteBalance);
    assert.equal(values.whiteBalance.value, 'auto');
    assert.equal(fake.state.streams.size, 1);

    fake.set('c.1.wb', 'daylight');                 // e.g. Reactor changed it
    await until(() => values.whiteBalance.value === 'daylight');
    fake.set('p', 3);
    await until(() => ptz.preset === 3);
    fake.set('c.1.exp', 'manual');                  // the gate moves: AE level becomes unwritable
    await until(() => values.aeBrightness?.writable === false);
    await d.panTilt(1, 0);
    await sleep(120);
    await d.panTilt(0, 0);
    await until(() => ptz.pan > 0.5);

    // The camera ends the stream: the driver reopens it on its own.
    for (const c of fake.state.streams) c.res.end('--boundary--\r\n');
    await until(() => fake.state.streams.size === 0);
    await until(() => fake.state.streams.size === 1, { timeoutMs: 4000 });

    d.close();
    await until(() => fake.state.streams.size === 0);
    await sleep(1200);
    assert.equal(fake.state.streams.size, 0, 'no reconnect after close()');
  } finally { await fake.close(); }
});

// --- end to end ---------------------------------------------------------------------

const FAST = {
  heartbeatIntervalMs: 100, heartbeatTimeoutMs: 400,
  reconnectBackoffMs: [50, 100], reconnectBackoffMaxMs: 100,
  positionFastMs: 50, positionIdleMs: 100, statusMs: 100, settingsMs: 30, fastSettingsMs: 100,
  deadmanMs: 200, commandTimeoutMs: 300,
};

test('PtzCamera end to end: connects, reads the table, survives the camera going silent', async () => {
  const fake = await startFakeCanon({ username: 'operator', password: 'made-up-pass' });
  const cam = new PtzCamera({
    entry: { id: 'canon1', label: 'Canon 1', vendor: 'canon', ip: '127.0.0.1', port: fake.port,
      auth: { username: 'operator', password: 'made-up-pass' } },
    Driver: CanonXcPtz,
    tuning: FAST,
  });
  const values = {};
  const states = [];
  cam.on('values', (e) => Object.assign(values, e.values));
  cam.on('state', (e) => states.push(e.state));
  cam.start();
  try {
    await until(() => cam.state === 'connected');
    assert.equal(cam.schema().model, 'CR-N500');
    assert.equal(cam.schema().capabilities.tracking, null);
    await until(() => values.whiteBalance && values.sharpness && values.tallyMode);
    await until(() => cam.schema().entries.find((e) => e.id === 'colorBars')?.available === false, { timeoutMs: 5000 });
    assert.ok(!cam.schema().entries.some((e) => 'wire' in e));

    const refused = await cam.write('colorTemp', 3200);
    assert.equal(refused.status, 409);
    assert.equal((await cam.write('whiteBalance', 'Colour temp.')).ok, true);
    assert.equal((await cam.write('colorTemp', 3200)).ok, true);
    await until(() => values.colorTemp?.value === 3200);

    cam.move({ pan: 0.4, tilt: 0 });
    await until(() => fake.state.vel.pan > 0);
    await until(() => fake.state.vel.pan === 0, { timeoutMs: 1500 });   // deadman

    assert.equal((await cam.preset('store', 7)).ok, true);
    assert.equal((await cam.preset('recall', 7)).ok, true);
    assert.equal((await cam.preset('recall', 101)).status, 400);

    fake.setSilent(true);
    await until(() => cam.state === 'reconnecting', { timeoutMs: 3000 });
    fake.setSilent(false);
    await until(() => cam.state === 'connected', { timeoutMs: 3000 });
    assert.ok(states.includes('reconnecting'));
    // Let the reconnect's first full read finish: lifecycle.js awaits it in
    // #connect without a catch, so stopping mid-sweep would surface as an
    // unhandled rejection (a foundation issue, reported, not worked around there).
    await sleep(800);
  } finally {
    await cam.stop();
    await fake.close();
  }
});
