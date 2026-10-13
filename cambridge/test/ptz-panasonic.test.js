// Panasonic AW-UE160 driver against the protocol fake (test/fakes/panasonic-aw.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { request } from '../src/ptz/http.js';
import { validateTable, coerce } from '../src/ptz/schema.js';
import { PtzCamera } from '../src/ptz/lifecycle.js';
import { DRIVERS } from '../src/ptz/drivers/index.js';
import {
  PanasonicAw, speedCode, commandUrl, parseNotifications, scanText, matchLine,
} from '../src/ptz/drivers/panasonic-aw.js';
import { TABLE, GAPS } from '../src/ptz/tables/panasonic-aw-ue160.js';
import { startFakePanasonic, frameNotification } from './fakes/panasonic-aw.js';

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

const USER = 'operator';
const PASS = 'not-a-real-password';
const byId = Object.fromEntries(TABLE.map((e) => [e.id, e]));

function driverFor(fake, extra = {}) {
  return new PanasonicAw({
    host: '127.0.0.1', port: fake.port, auth: { username: USER, password: PASS },
    http: request, timeoutMs: 600, log: () => {}, options: {}, ...extra,
  });
}

/** The ptz/cam commands the fake received since `from`. */
const sent = (fake, from = 0, path) => fake.state.log.slice(from).filter((l) => !path || l[0] === path).map((l) => l[1]);

// --- table ---------------------------------------------------------------------

test('the AW-UE160 table is sound, and every row of the notes is accounted for', () => {
  assert.deepEqual(validateTable(TABLE), []);
  assert.ok(TABLE.length >= 535, `${TABLE.length} entries`);
  assert.ok(GAPS.length > 5);
  // Danger flags as the notes assign them: 17 admin + 3 reconnect rows in the
  // IF table (two of the admin rows expand into 8 + 3 file names), and the web
  // CGIs' 7 reconnect rows + restart.
  const admin = TABLE.filter((e) => e.danger === 'admin').map((e) => e.id);
  for (const id of ['savePresetMemory', 'deletePresetMemory', 'savePresetName', 'deletePresetName', 'deletePresetNameOSJ37',
    'deletePresetThumbnail', 'deletePresetThumbnailOSJ3B', 'frequency', 'format', 'sfpMode', 'operationLock',
    'releaseOperationLock', 'powerOnStandby', 'sceneFileStore', 'sceneFile1Name', 'userFileStore', 'userFile1Name', 'restart']) {
    assert.ok(admin.includes(id), `${id} is admin`);
  }
  for (const id of ['serialBaudRate', 'wirelessControl', 'wirelessId', 'network', 'streamMode', 'rtspSettings', 'mdnsHost', 'ipAddress']) {
    assert.equal(byId[id].danger, 'reconnect', id);
  }
  assert.equal(byId.ipAddress.role, 'ipAddress');
  // At most one entry per role.
  const roles = TABLE.filter((e) => e.role).map((e) => e.role);
  assert.equal(new Set(roles).size, roles.length);
  assert.equal(byId.focusMode.autoValue, '1');
  assert.equal(byId.focusMode.manualValue, '0');
  // Nothing that moves the head is a plain setting.
  for (const id of ['ptSpeedControl', 'zoomSpeedControl', 'ptAbsolutePositionControl', 'ptzfSpeedControl1', 'recallPresetMemory']) {
    assert.ok(byId[id].wire.via, `${id} is not offered as a setting`);
  }
  assert.equal(byId.home.verify, true, 'home is not a spec command');
});

test('wire helpers: speeds, URLs, reply matching', () => {
  assert.equal(speedCode(0), '50');
  assert.equal(speedCode(1), '99');
  assert.equal(speedCode(-1), '01');
  assert.equal(speedCode(0.001), '51', 'the smallest move is the slowest speed, not a stop');
  assert.equal(speedCode(-0.001), '49');
  assert.equal(speedCode(0.5), '75');
  assert.equal(commandUrl('ptz', '#PTS5050'), '/cgi-bin/aw_ptz?cmd=%23PTS5050&res=1');
  assert.equal(commandUrl('cam', 'OSL:2B:4'), '/cgi-bin/aw_cam?cmd=OSL:2B:4&res=1');
  const one = (line) => matchLine(line).map(([e, v]) => [e.id, v]);
  assert.deepEqual(one('OSL:25:0x0A'), [['gain', 2]], 'camdata hex with 0x');
  assert.deepEqual(one('p1'), [['powerOnStandby', '1']]);
  assert.deepEqual(one('pE000000000313'), [], 'a longer ptz reply is not the power state');
  assert.deepEqual(one('TLR:1'), [['rTallyControl', true]]);
  assert.deepEqual(one('OAW:2'), [['whiteBalanceModeOAW', 'awcA']], 'OAW reply codes differ from its write codes');
});

test('update notifications are framed as IF p.10 says, in any chunking', () => {
  const two = Buffer.concat([frameNotification('OSL:2B:4'), frameNotification('q07')]);
  assert.deepEqual(parseNotifications(two).messages, ['OSL:2B:4', 'q07']);
  // Split mid-frame: nothing until the rest arrives.
  const a = parseNotifications(two.subarray(0, 40));
  assert.deepEqual(a.messages, []);
  const b = parseNotifications(Buffer.concat([a.rest, two.subarray(40)]));
  assert.deepEqual(b.messages, ['OSL:2B:4', 'q07']);
  // Little-endian size works too (the byte order is not stated).
  const le = frameNotification('p1');
  le.writeUInt16LE(le.readUInt16BE(22), 22);
  assert.deepEqual(parseNotifications(le).messages, ['p1']);
  // Unframed text: the CRLF scan used when the connection closes.
  assert.deepEqual(scanText(Buffer.from('junk\r\nDCB:1\r\n')), ['DCB:1']);
});

// --- probe and identity ----------------------------------------------------------

test('probe recognises the camera, and nothing else', async () => {
  const fake = await startFakePanasonic({ username: USER, password: PASS });
  const other = createServer((req, res) => res.end('<html>a different camera</html>'));
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  try {
    const id = await PanasonicAw.probe({ host: '127.0.0.1', port: fake.port, auth: { username: USER, password: PASS }, http: request, timeoutMs: 800 });
    assert.deepEqual(id, { vendor: 'panasonic', model: 'AW-UE160' });
    assert.equal(await PanasonicAw.probe({ host: '127.0.0.1', port: other.address().port, auth: {}, http: request, timeoutMs: 800 }), null);
    await assert.rejects(PanasonicAw.probe({ host: '127.0.0.1', port: fake.port, auth: { username: USER, password: 'wrong' }, http: request, timeoutMs: 800 }),
      (err) => err.kind === 'auth' && !err.message.includes('wrong'));
    assert.ok(fake.state.log.every((l) => l[1] === 'QID'), 'the probe only asked the model');
    assert.equal(DRIVERS.get('panasonic'), PanasonicAw);
    assert.equal([...DRIVERS.keys()].at(-1), 'fake');
  } finally { other.close(); await fake.close(); }
});

test('identify reads model, firmware, title and tracking; every request closes its connection', async () => {
  const fake = await startFakePanasonic({ username: USER, password: PASS });
  const d = driverFor(fake);
  try {
    const id = await d.identify();
    assert.equal(id.model, 'AW-UE160');
    assert.equal(id.firmware, 'V02.01');
    assert.equal(id.name, 'AW-UE160');
    assert.equal(id.serial, 'FAKE00001');
    assert.deepEqual(d.capabilities().tracking, { kind: 'externalTracking', label: 'Auto tracking (status only)' });
    assert.equal(d.capabilities().presets, 100);
    assert.ok(d.schema().some((e) => e.id === 'autoTrackingMode'));
    assert.ok(!d.schema().some((e) => e.wire.via), 'motion rows are not offered as settings');
    // No keep-alive on this camera (IF p.8).
    assert.ok(fake.state.requests.filter((r) => r.url.startsWith('/cgi-bin/aw_')).every((r) => r.connection === 'close'));
  } finally { d.close(); await fake.close(); }
});

test('a camera without the tracking status has no tracking and no tracking entries', async () => {
  const fake = await startFakePanasonic({ tracking: false });
  const d = driverFor(fake, { auth: {} });
  try {
    await d.identify();
    assert.equal(d.capabilities().tracking, null);
    assert.ok(!d.schema().some((e) => e.requires === 'tracking'));
  } finally { d.close(); await fake.close(); }
});

test('wrong password is auth, a silent camera is a timeout', async () => {
  const fake = await startFakePanasonic({ username: USER, password: PASS });
  try {
    const bad = driverFor(fake, { auth: { username: USER, password: 'nope' } });
    await assert.rejects(bad.identify(), (err) => err.kind === 'auth' && !/nope/.test(err.message));
    const d = driverFor(fake);
    fake.setSilent(true);
    await assert.rejects(d.heartbeat(), (err) => err.kind === 'timeout');
    // Reads give up quietly (see read()); the heartbeat is what decides health.
    assert.equal(await d.read([byId.gain]), null);
    fake.setSilent(false);
    await d.heartbeat();
    assert.equal((await d.read([byId.gain])).gain.value, 0);
  } finally { await fake.close(); }
});

// --- motion -----------------------------------------------------------------------

test('velocities become #PTS / #Z / #F with the documented directions, and stop sends every stop', async () => {
  const fake = await startFakePanasonic();
  const d = driverFor(fake, { auth: {} });
  try {
    const from = fake.state.log.length;
    await d.panTilt(1, 0);           // right, full
    await d.panTilt(-0.01, 0.01);    // left slowest, up slowest
    await d.panTilt(0, -1);          // down full
    await d.zoom(0.5);               // tele
    await d.zoom(-1);                // wide full
    await d.focus(0.02);             // far slowest
    await d.focus(-0.5);             // near
    assert.deepEqual(sent(fake, from), ['#PTS9950', '#PTS4951', '#PTS5001', '#Z75', '#Z01', '#F51', '#F25']);
    assert.ok(fake.state.requests.some((r) => r.url === '/cgi-bin/aw_ptz?cmd=%23PTS9950&res=1'), '# travels as %23');

    const before = fake.state.log.length;
    await d.stop();
    assert.deepEqual(sent(fake, before), ['#HV150505050', '#PTS5050', '#Z50', '#F50']);
    assert.deepEqual(fake.state.speed, { pan: 50, tilt: 50, zoom: 50, focus: 50 });
  } finally { d.close(); await fake.close(); }
});

test('commands are at least 16 ms apart', async () => {
  const fake = await startFakePanasonic();
  const d = driverFor(fake, { auth: {} });
  try {
    const starts = [];
    const orig = d.http;
    d.http = (o) => { starts.push(Date.now()); return orig(o); };
    await Promise.all([d.zoom(0.3), d.zoom(0.4), d.zoom(0)]);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 15, `gap ${starts[i] - starts[i - 1]}`);
  } finally { d.close(); await fake.close(); }
});

test('position is normalised from #PTV', async () => {
  const fake = await startFakePanasonic();
  const d = driverFor(fake, { auth: {} });
  try {
    fake.state.pan = 0x2D09; fake.state.tilt = 0x1C71; fake.state.zoom = 0xFFF; fake.state.focus = 0x555;
    const p = await d.position();
    assert.equal(p.pan, 0);
    assert.equal(p.tilt, 1, 'tilt up is the smaller count');
    assert.equal(p.zoom, 1);
    assert.equal(p.focus, 0);
    assert.equal(p.raw.pan, '2D09');
  } finally { d.close(); await fake.close(); }
});

// --- settings ---------------------------------------------------------------------

test('read and write: enum, range, bool and text round trip through the camera', async () => {
  const fake = await startFakePanasonic({ username: USER, password: PASS });
  const d = driverFor(fake);
  try {
    await d.identify();
    const entries = ['whiteBalanceMode', 'gain', 'bar', 'cameraTitle', 'wbalVar', 'tally'].map((id) => byId[id]);
    let r = await d.read(entries);
    assert.equal(r.whiteBalanceMode.value, '0');
    assert.equal(r.gain.value, 0);
    assert.equal(r.bar.value, false);
    assert.equal(r.cameraTitle.value, 'AW-UE160');
    assert.equal(r.tally.value, true);
    assert.equal(r.wbalVar.writable, false, 'W.BAL VAR is gated behind WHITE BALANCE MODE = VAR');
    assert.ok(Object.keys(r).length > entries.length, 'camdata answers more than was asked');

    await d.write(byId.whiteBalanceMode, '4');
    assert.equal(fake.state.settings.get('OSL:2B:'), '4');
    await d.write(byId.gain, coerce(byId.gain, -6).value);
    assert.equal(fake.state.settings.get('OSL:25:'), '02');
    await d.write(byId.bar, true);
    assert.ok(sent(fake, 0, 'cam').includes('DCB:1'), 'BAR is set with DCB and read with QBR (IF p.35)');
    await d.write(byId.cameraTitle, 'Lectern cam');
    assert.equal(fake.state.settings.get('OSJ:5C:'), '4C65637465726E2063616D000000000000000000');
    await d.write(byId.wbalVar, 3200);
    assert.equal(fake.state.settings.get('OSI:20:'), '00C80:0');

    r = await d.read(entries);
    assert.equal(r.whiteBalanceMode.value, '4');
    assert.equal(r.gain.value, -6);
    assert.equal(r.bar.value, true);
    assert.equal(r.cameraTitle.value, 'Lectern cam');
    assert.equal(r.wbalVar.value, 3200);
    assert.equal(r.wbalVar.writable, true);
  } finally { d.close(); await fake.close(); }
});

test('values not in camdata.html are asked one by one; a camera without camdata is asked for everything', async () => {
  const fake = await startFakePanasonic({ camdata: false });
  const d = driverFor(fake, { auth: {} });
  try {
    const r = await d.read([byId.focusMode, byId.zoomScale, byId.limitationTiltUp]);
    assert.equal(r.focusMode.value, '1');
    assert.equal(r.zoomScale.value, 0);
    assert.equal(r.limitationTiltUp.value, false);
    assert.ok(sent(fake).includes('QAF') && sent(fake).includes('#LC1'));
  } finally { d.close(); await fake.close(); }
});

test('refusals: a gate, an out-of-range value, an unsupported command, standby', async () => {
  const fake = await startFakePanasonic();
  const d = driverFor(fake, { auth: {} });
  try {
    await d.identify();
    // Gate checked before sending.
    const n = fake.state.log.length;
    await assert.rejects(d.write(byId.wbalVar, 4000),
      (err) => err.kind === 'refused' && /WHITE BALANCE MODE is VAR/.test(err.message));
    assert.ok(!sent(fake, n).some((c) => c.startsWith('OSI:20:')), 'nothing was sent');
    // The camera says out of range (ER3).
    await assert.rejects(d.write(byId.zoomPositionControl, 0x555 - 1).catch((e) => { throw e; }),
      (err) => err.kind === 'refused' && err.code === 'ER3');
    // The camera does not know the command (ER1): the setting is unsupported, not an error.
    fake.state.settings.delete('OSL:C5:');
    const r = await d.read([byId.focusGuideStatus]);
    assert.equal(r.focusGuideStatus.unsupported, true);
    // Standby: ER2 is "refused" with a clear message, the heartbeat still passes,
    // and reads report no value without hiding the setting.
    fake.state.power = '0';
    await assert.rejects(d.write(byId.gain, 6), (err) => err.kind === 'refused' && /standby/.test(err.message));
    await d.heartbeat();
    const s = await d.read([byId.focusMode]);
    assert.ok(s.focusMode.error || s.focusMode.value !== undefined);
    assert.notEqual(s.focusMode.unsupported, true);
    assert.equal((await d.status()).power, 'standby');
    await d.stop();   // nothing moves in standby: busy is not a failed stop
  } finally { d.close(); await fake.close(); }
});

test('actions: one-push AF, inc/dec steps, home, restart guard', async () => {
  const fake = await startFakePanasonic();
  const d = driverFor(fake, { auth: {} });
  try {
    const n = fake.state.log.length;
    await d.action(byId.pushAutoFocus);
    await d.action(byId.shutterSpeedInc, { value: 10 });
    await d.action(byId.shutterSpeedInc);
    await d.action(byId.home);
    assert.deepEqual(sent(fake, n), ['OSE:69:1', 'OSJ:04:0A', 'OSJ:04:01', '#APC80008000']);
    await assert.rejects(d.action(byId.shutterSpeedInc, { value: 101 }), (err) => err.kind === 'refused');
    await assert.rejects(d.action(byId.recallPresetMemory, { value: 1 }), (err) => err.kind === 'unsupported');
  } finally { d.close(); await fake.close(); }
});

// --- presets, tally, snapshot --------------------------------------------------------

test('presets: store, recall (with speed), delete, numbered 1–100 on the wire as 00–99', async () => {
  const fake = await startFakePanasonic();
  const d = driverFor(fake, { auth: {} });
  try {
    fake.state.pan = 0x9000;
    await d.presetStore(1);
    await d.presetStore(100);
    fake.state.pan = 0x8000;
    const n = fake.state.log.length;
    await d.presetRecall(1, { speed: 30 });
    assert.deepEqual(sent(fake, n).filter((c) => c.startsWith('#')), ['#UPVS999', '#R00']);
    assert.equal(fake.state.pan, 0x9000);
    await d.presetDelete(100);
    assert.ok(sent(fake).includes('#M99') && sent(fake).includes('#C99'));
    await assert.rejects(d.presetRecall(101), (err) => err.kind === 'refused');
    const r = await d.read([byId.presetEntryConfirmation]);
    assert.equal(r.presetEntryConfirmation.value, '1');
  } finally { d.close(); await fake.close(); }
});

test('tally and snapshot', async () => {
  const fake = await startFakePanasonic({ username: USER, password: PASS });
  const d = driverFor(fake);
  try {
    await d.setTally({ program: true, preview: false });
    assert.deepEqual(sent(fake, 0, 'cam').slice(-2), ['TLR:1', 'TLG:0']);
    const f = await d.snapshot();
    assert.equal(f.contentType, 'image/jpeg');
    assert.equal(f.body[0], 0xFF);
    assert.equal(fake.state.lastSnapshot, '640');
  } finally { d.close(); await fake.close(); }
});

// --- push --------------------------------------------------------------------------

test('push: registers once, delivers changes and preset arrival, deregisters on close', async () => {
  const fake = await startFakePanasonic();
  const d = driverFor(fake, { auth: {} });
  const got = {};
  const ptz = [];
  try {
    await d.identify();
    d.subscribe({ onValues: (v) => Object.assign(got, v), onPtz: (p) => ptz.push(p) });
    await until(() => fake.state.receivers.size === 1);
    // Someone changes white balance at the camera.
    fake.changeLocally('OSL:2B:', '3');
    await until(() => got.whiteBalanceMode?.value === '3');
    fake.changeLocally('OSL:B6:', '0');
    await until(() => ptz.some((p) => p.tracking === false));
    await d.presetRecall(5);
    await until(() => ptz.some((p) => p.preset === 5));
    d.close();
    await until(() => fake.state.receivers.size === 0);
  } finally { d.close(); await fake.close(); }
});

test('push failing to register does not throw, and polling is unaffected', async () => {
  const fake = await startFakePanasonic();
  // Fill the camera's five notification slots (IF p.12).
  for (let i = 0; i < 5; i++) fake.state.receivers.set(`192.0.2.${i}:31004`, { host: '192.0.2.1', port: 9 });
  const logs = [];
  const d = driverFor(fake, { auth: {}, log: (lvl, msg) => logs.push([lvl, msg]) });
  try {
    d.subscribe({ onValues: () => {}, onPtz: () => {} });
    await until(() => logs.some(([lvl]) => lvl === 'warn'));
    await d.heartbeat();
  } finally { d.close(); await fake.close(); }
});

// --- end to end --------------------------------------------------------------------

test('PtzCamera connects, reads the table, survives the camera going silent and coming back', async () => {
  const fake = await startFakePanasonic({ username: USER, password: PASS });
  const cam = new PtzCamera({
    entry: { id: 'ue160', label: 'UE160', vendor: 'panasonic', ip: '127.0.0.1', port: fake.port, auth: { username: USER, password: PASS } },
    Driver: PanasonicAw,
    tuning: {
      heartbeatIntervalMs: 100, heartbeatTimeoutMs: 600, reconnectBackoffMs: [100, 200], reconnectBackoffMaxMs: 200,
      positionFastMs: 100, positionIdleMs: 200, statusMs: 200, settingsMs: 50, fastSettingsMs: 200, deadmanMs: 300,
      commandTimeoutMs: 400,
    },
  });
  const values = {};
  const states = [];
  cam.on('values', (e) => Object.assign(values, e.values));
  cam.on('state', (e) => states.push(e.state));
  cam.start();
  try {
    // The first full read of the table must finish before stop(): see the
    // report — the lifecycle does not catch a failure of that first sweep.
    const swept = () => cam.state === 'connected' && cam.timers.length > 0;
    await until(swept, { timeoutMs: 8000 });
    await until(() => values.whiteBalanceMode && values.cameraTitle && values.gain);
    assert.equal(values.cameraTitle.value, 'AW-UE160');
    assert.equal(cam.schema().capabilities.presets, 100);
    assert.equal(cam.schema().model, 'AW-UE160');
    // A write through the lifecycle, read back from the camera.
    assert.equal((await cam.write('whiteBalanceMode', 'PRESET 5600K')).ok, true);
    assert.equal(fake.state.settings.get('OSL:2B:'), '3');
    // Refused by the gate → 409, and the camera stays connected.
    assert.equal((await cam.write('wbalVar', 4000)).status, 409);
    assert.equal(cam.state, 'connected');
    // A joystick move, stopped by the deadman.
    cam.move({ pan: 0.5, tilt: 0 });
    await until(() => fake.state.speed.pan === 75);
    await until(() => fake.state.speed.pan === 50, { timeoutMs: 2000 });

    fake.setSilent(true);
    await until(() => cam.state === 'reconnecting', { timeoutMs: 4000 });
    fake.setSilent(false);
    await until(swept, { timeoutMs: 8000 });
    assert.ok(states.includes('reconnecting'));
  } finally {
    await cam.stop();
    await fake.close();
  }
});
