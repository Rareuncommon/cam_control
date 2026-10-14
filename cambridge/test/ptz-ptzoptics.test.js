// PTZOptics Move SE driver against its protocol fake (test/fakes/ptzoptics.js):
// raw VISCA over TCP and the HTTP-CGI with Digest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { PtzOptics, tableFor, snapshotSupport, buildOf, parseLines, modelName } from '../src/ptz/drivers/ptzoptics.js';
import { TABLE, GAPS } from '../src/ptz/tables/ptzoptics-move-se.js';
import { validateTable } from '../src/ptz/schema.js';
import { request } from '../src/ptz/http.js';
import { PtzCamera } from '../src/ptz/lifecycle.js';
import { driverFor, DRIVERS } from '../src/ptz/drivers/index.js';
import { startFakePtzoptics } from './fakes/ptzoptics.js';
import { startFakeSony } from './fakes/sony-brc.js';

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

const AUTH = { username: 'admin', password: 'not-a-real-pass' };

function driver(fake, { auth = AUTH, timeoutMs = 800, options = {} } = {}) {
  return new PtzOptics({
    host: '127.0.0.1', port: fake.port, auth, http: request, timeoutMs,
    options: { viscaPort: fake.viscaPort, ...options },
  });
}

async function withFake(opts, fn) {
  const fake = await startFakePtzoptics({ password: AUTH.password, ...opts });
  const d = driver(fake, opts.driver);
  try {
    await fn(fake, d);
  } finally {
    d.close();
    await fake.close();
  }
}

const since = (fake, n) => fake.state.viscaLog.slice(n);
const entry = (d, id) => d.byId.get(id);

// --- table and helpers ----------------------------------------------------------

test('the Move SE table is sound, roles unique, conflicts flagged', () => {
  assert.deepEqual(validateTable(TABLE), []);
  const roles = TABLE.filter((e) => e.role).map((e) => e.role);
  assert.equal(new Set(roles).size, roles.length);
  for (const r of ['home', 'onePushAf', 'focusMode', 'iris', 'gain', 'shutter', 'whiteBalanceMode',
    'colorTemp', 'trackingEnabled', 'ipAddress', 'cameraName']) assert.ok(roles.includes(r), r);
  const fm = TABLE.find((e) => e.role === 'focusMode');
  assert.deepEqual([fm.autoValue, fm.manualValue], [2, 3]);
  for (const id of ['backlight', 'focusMode', 'shutter', 'gainManual', 'sharpness', 'saturation', 'noise3d', 'autoTracking']) {
    assert.equal(TABLE.find((e) => e.id === id).verify, true, id);
  }
  assert.ok(GAPS.length > 5);
  // Recalibration (moves the whole range, clears limits), mounting/inversion,
  // and turning stream or API authentication off: administrator's calls.
  for (const id of ['panTiltReset', 'imageOrientation', 'autoInversion', 'rtspAuth', 'onvifAuth']) {
    assert.equal(TABLE.find((e) => e.id === id).danger, 'admin', id);
  }
  assert.equal(tableFor('Move SE'), TABLE);
  assert.ok(tableFor('Move 4K').every((e) => e.verify));
  assert.equal(modelName({ device_model: 'F16.HI' }), 'Move SE');
  assert.equal(modelName({ device_model: 'F99.XX' }), 'PTZOptics F99.XX');
  assert.equal(modelName(null, 'Move SE'), 'Move SE');
});

test('firmware gates the snapshot URL per lens variant', () => {
  assert.equal(buildOf('SOC v9.1.66'), 66);
  assert.equal(snapshotSupport('9.1.66'), 'yes');
  assert.equal(snapshotSupport('9.1.30'), 'no');
  assert.equal(snapshotSupport('9.1.50'), 'maybe');
  assert.equal(snapshotSupport('9.1.50', '20X'), 'yes');
  assert.equal(snapshotSupport('9.1.50', '12X'), 'no');
  assert.equal(snapshotSupport(undefined), 'maybe');
  assert.deepEqual(parseLines('a="1"\nb="x y"'), { a: '1', b: 'x y' });
});

// --- probe and identity ----------------------------------------------------------

test('probe identifies a PTZOptics, and does not claim a plain server or a Sony', async () => {
  const fake = await startFakePtzoptics({ password: AUTH.password });
  const bare = await startFakePtzoptics({ password: AUTH.password, queries: false });
  const sony = await startFakeSony({ password: AUTH.password });
  const plain = createServer((req, res) => res.end('hello'));
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  const ctx = (port, extra = {}) => ({ host: '127.0.0.1', port, auth: AUTH, http: request, timeoutMs: 800, ...extra });
  try {
    const id = await PtzOptics.probe(ctx(fake.port, { options: { viscaPort: fake.viscaPort } }));
    assert.equal(id.vendor, 'ptzoptics');
    assert.equal(id.model, 'Move SE');
    // No get_* queries (as documented for the SE): raw VISCA on the control port decides.
    const id2 = await PtzOptics.probe(ctx(bare.port, { options: { viscaPort: bare.viscaPort } }));
    assert.equal(id2.vendor, 'ptzoptics');
    assert.equal(await PtzOptics.probe(ctx(plain.address().port, { options: { viscaPort: 9 } })), null);
    assert.equal(await PtzOptics.probe(ctx(sony.port, { options: { viscaPort: 9 } })), null);
    // And Sony's probe does not claim a PTZOptics.
    assert.equal(await driverFor('sony').probe(ctx(fake.port)), null);
    await assert.rejects(PtzOptics.probe(ctx(fake.port, { auth: { username: 'admin', password: 'wrong' }, options: { viscaPort: fake.viscaPort } })),
      (e) => e.kind === 'auth');
    assert.ok(fake.state.viscaLog.every((l) => l.startsWith('81 09')), 'probe only asked');
    assert.deepEqual([...DRIVERS.keys()].at(-1), 'fake');
  } finally {
    plain.close();
    await fake.close(); await bare.close(); await sony.close();
  }
});

test('identity and capabilities: presets keep operators off reserved numbers', async () => {
  await withFake({}, async (fake, d) => {
    const id = await d.identify();
    assert.equal(id.model, 'Move SE');
    assert.equal(id.firmware, 'SOC v9.1.66');
    assert.equal(id.serial, 'q1i0000001');
    const caps = d.capabilities(id);
    assert.equal(caps.presetBase, 0);
    assert.equal(caps.presets, 90, '0..89: below the first reserved number');
    assert.ok(caps.reservedPresets.includes(150));
    assert.deepEqual(caps.tracking, { kind: 'autoTracking', label: 'Auto tracking' });
    assert.equal(caps.tally, false);
    assert.equal(caps.snapshot, true);
    assert.ok(d.schema(id).some((e) => e.id === 'autoTracking'));
  });
});

test('pre-9.1.56 firmware answering a0 instead of 90 still works', async () => {
  await withFake({ replyAddress: 0xa0, firmware: '9.1.43' }, async (fake, d) => {
    await d.identify();
    await d.panTilt(0.5, 0);
    await d.stop();
    const p = await d.position();
    assert.equal(typeof p.raw.zoom, 'number');
  });
});

// --- motion ------------------------------------------------------------------------

test('motion: directions, slowest speeds, and three separate stops', async () => {
  await withFake({}, async (fake, d) => {
    await d.identify();
    let n = fake.state.viscaLog.length;
    await d.panTilt(0.001, 0);
    await d.panTilt(-1, 1);
    await d.panTilt(0, -0.5);
    await d.zoom(0.001);
    await d.zoom(-1);
    await d.zoom(0);
    assert.deepEqual(since(fake, n), [
      '81 01 06 01 01 01 02 03 ff',
      '81 01 06 01 18 14 01 01 ff',
      '81 01 06 01 01 0a 03 02 ff',
      '81 01 04 07 20 ff',
      '81 01 04 07 37 ff',
      '81 01 04 07 00 ff',
    ]);
    await assert.rejects(d.focus(0.3), (e) => e.kind === 'refused' && /Manual/.test(e.message));
    await d.write(entry(d, 'focusMode'), 3);
    n = fake.state.viscaLog.length;
    await d.focus(0.3);
    await d.focus(-0.3);
    assert.deepEqual(since(fake, n), ['81 01 04 08 02 ff', '81 01 04 08 03 ff']);

    // Since 9.1.46 a pan/tilt stop leaves zoom running, so stop() sends all three.
    await d.panTilt(0.5, 0);
    await d.zoom(0.5);
    n = fake.state.viscaLog.length;
    await d.stop();
    assert.deepEqual(since(fake, n), ['81 01 06 01 01 01 03 03 ff', '81 01 04 07 00 ff', '81 01 04 08 00 ff']);
    assert.equal(fake.state.head.v.pan, 0);
    assert.equal(fake.state.head.v.zoom, 0);
  });
});

test('stop goes over HTTP when the VISCA port does not answer', async () => {
  await withFake({ driver: { options: { viscaPort: 9 } } }, async (fake, d) => {
    const n = fake.state.cgiLog.length;
    await d.stop();
    assert.deepEqual(fake.state.cgiLog.slice(n), [
      'GET /cgi-bin/ptzctrl.cgi?ptzcmd&ptzstop', 'GET /cgi-bin/ptzctrl.cgi?ptzcmd&zoomstop', 'GET /cgi-bin/ptzctrl.cgi?ptzcmd&focusstop',
    ]);
  });
});

const PT_STOP = '81 01 06 01 01 01 03 03 ff';
const CGI_STOPS = ['GET /cgi-bin/ptzctrl.cgi?ptzcmd&ptzstop', 'GET /cgi-bin/ptzctrl.cgi?ptzcmd&zoomstop', 'GET /cgi-bin/ptzctrl.cgi?ptzcmd&focusstop'];

test('a VISCA stop refused twice with buffer full falls back to the CGI stops, then goes over VISCA too', async () => {
  await withFake({}, async (fake, d) => {
    await d.identify();
    await d.panTilt(0.5, 0);
    await d.zoom(0.5);
    fake.state.busy = true;                       // both command buffers full, and staying full
    const n = fake.state.cgiLog.length;
    const v = fake.state.viscaLog.length;
    await d.stop();
    assert.deepEqual(since(fake, v).slice(0, 2), [PT_STOP, PT_STOP], 'the client tried once more, as for any buffer full');
    assert.deepEqual(fake.state.cgiLog.slice(n), CGI_STOPS);
    assert.equal(fake.state.head.v.pan, 0);
    assert.equal(fake.state.head.v.zoom, 0);
    // One axis on its own does the same, with only that axis's CGI stop.
    fake.state.head.v.zoom = 0.5;
    const m = fake.state.cgiLog.length;
    await d.zoom(0);
    assert.deepEqual(fake.state.cgiLog.slice(m), ['GET /cgi-bin/ptzctrl.cgi?ptzcmd&zoomstop']);
    assert.equal(fake.state.head.v.zoom, 0);
    // Once the camera takes commands again, the VISCA stops follow.
    const k = fake.state.viscaLog.length;
    fake.state.busy = false;
    await until(() => since(fake, k).includes(PT_STOP) && since(fake, k).includes('81 01 04 07 00 ff'), { timeoutMs: 5000 });
  });
});

test('a stop that went over CGI is sent over VISCA again once VISCA answers: a late move cannot outlast it', async () => {
  await withFake({ driver: { timeoutMs: 400 } }, async (fake, d) => {
    await d.identify();
    await d.panTilt(0.5, 0);
    fake.state.viscaSilent = true;                // VISCA goes quiet; HTTP still answers
    await d.stop();
    assert.equal(fake.state.head.v.pan, 0, 'stopped over CGI');
    // The next stop does not wait out another VISCA timeout first.
    const t0 = Date.now();
    await d.panTilt(0, 0);
    assert.ok(Date.now() - t0 < 250, `second stop took ${Date.now() - t0} ms`);
    // The move sent before the stop arrives late: the head starts again.
    fake.state.head.v.pan = 0.5;
    const n = fake.state.viscaLog.length;
    fake.state.viscaSilent = false;
    await until(() => since(fake, n).includes(PT_STOP), { timeoutMs: 5000 });
    assert.equal(fake.state.head.v.pan, 0, 'the VISCA stop caught the late move');
  });
});

test('a new move cancels the pending VISCA re-stop', async () => {
  await withFake({ driver: { timeoutMs: 300 } }, async (fake, d) => {
    await d.identify();
    await d.panTilt(0.5, 0);
    fake.state.viscaSilent = true;
    await d.stop();
    fake.state.viscaSilent = false;
    await d.panTilt(0.25, 0);                     // the operator moves again
    const n = fake.state.viscaLog.length;
    await sleep(1200);
    assert.ok(!since(fake, n).includes(PT_STOP), 'no late stop cut across the new move');
    assert.ok(fake.state.head.v.pan > 0);
  });
});

test('a stop during a slow read waits for the one inquiry on the wire at most, and the read gives way', async () => {
  const fake = await startFakePtzoptics({ password: AUTH.password });
  let motionWaiting = false;
  const d = new PtzOptics({
    host: '127.0.0.1', port: fake.port, auth: AUTH, http: request, timeoutMs: 2000,
    options: { viscaPort: fake.viscaPort }, shouldYield: () => motionWaiting,
  });
  try {
    await d.identify();
    d.schema();
    await d.panTilt(0.5, 0);
    const DELAY = 250;
    fake.state.inquiryDelayMs = DELAY;
    const ids = ['exposureMode', 'expCompMode', 'backlight', 'antiFlicker', 'iris', 'wbMode', 'blackWhite', 'focusMode'];
    const reading = d.read(ids.map((id) => entry(d, id)));
    await sleep(30);
    motionWaiting = true;
    const t0 = Date.now();
    const n = fake.state.viscaLog.length;
    await d.stop();
    const took = Date.now() - t0;
    assert.ok(took < DELAY + 150, `stop took ${took} ms behind ${DELAY} ms inquiries`);
    assert.deepEqual(since(fake, n), [PT_STOP, '81 01 04 07 00 ff', '81 01 04 08 00 ff']);
    assert.equal(fake.state.head.v.pan, 0);
    const got = await reading;
    motionWaiting = false;
    const answered = ids.filter((id) => got[id]);
    assert.ok(answered.length >= 1 && answered.length < ids.length, `the read handed back ${answered.length} of ${ids.length}`);
    // position() gives way between its inquiries too: what it did not ask stays undefined.
    fake.state.inquiryDelayMs = 0;
    motionWaiting = true;
    const p = await d.position();
    motionWaiting = false;
    assert.equal(p.zoom, undefined);
    assert.ok(p.raw.pan !== undefined);
    assert.ok((await d.position()).zoom !== undefined);
  } finally {
    d.close();
    await fake.close();
  }
});

// --- settings -----------------------------------------------------------------------

test('read and write: enum via VISCA read + CGI write, gated range, bool, text, focus range', async () => {
  await withFake({}, async (fake, d) => {
    const id = await d.identify();
    d.schema(id);
    const got = await d.read(['exposureMode', 'iris', 'backlight', 'colorTemp', 'trackStart', 'redTuning', 'freeze']
      .map((x) => entry(d, x)));
    assert.equal(got.exposureMode.value, 0);
    assert.equal(got.iris.value, 10);
    assert.equal(got.backlight.value, false);
    assert.equal(got.colorTemp.value, 5500);
    assert.equal(got.colorTemp.writable, undefined, 'gate entry not in this batch');
    assert.equal(got.trackStart.value, 'live');
    assert.equal(got.redTuning.value, 0);
    assert.equal(got.freeze.value, null, 'write-only');

    await d.write(entry(d, 'backlight'), true);     // Auto exposure only
    await d.write(entry(d, 'exposureMode'), 3);
    await d.write(entry(d, 'iris'), 14);
    await assert.rejects(d.write(entry(d, 'backlight'), false), (e) => e.code === 'gate' && /Auto/.test(e.message));
    await d.write(entry(d, 'trackStart'), '12');
    await d.write(entry(d, 'redTuning'), -3);
    assert.equal(fake.state.image.aemode, '3');
    assert.equal(fake.state.image.iris, '14');
    assert.equal(fake.state.image.backlight, '2');
    assert.equal(fake.state.image.trackpreset, '12');
    assert.equal(fake.state.image.rgaintuning, '7');
    assert.ok(fake.state.cgiLog.includes('GET /cgi-bin/ptzctrl.cgi?post_image_value&aemode&3'));

    // Gate: colour temperature needs WB mode "colour temperature".
    await assert.rejects(d.write(entry(d, 'colorTemp'), 6000), (e) => e.kind === 'refused' && e.code === 'gate');
    await d.write(entry(d, 'wbMode'), 32);
    await d.write(entry(d, 'colorTemp'), 6000);
    assert.equal(fake.state.image.colortemp, '35');

    // Three values, one request.
    await d.write(entry(d, 'focusLimit'), true);
    await d.write(entry(d, 'focusLimitNear'), 3);
    assert.deepEqual(fake.state.focusRange, { enable: 1, near: 3, far: 11 });
    await assert.rejects(d.write(entry(d, 'focusLimitFar'), 2), (e) => e.code === 'range');

    // POST settings carry an empty body.
    await d.write(entry(d, 'stream1Fps'), 25);
    await d.write(entry(d, 'srtLatency'), 300);
    assert.equal(fake.state.video.fps_1, '25');
    assert.equal(fake.state.other.srt_latency, '300');
  });
});

test('on firmware without get_* queries, values read as unknown and stay writable', async () => {
  await withFake({ queries: false, driver: { options: { model: 'Move SE' } } }, async (fake, d) => {
    const id = await d.identify();
    assert.equal(id.model, 'Move SE');
    d.schema(id);
    const got = await d.read([entry(d, 'luminance'), entry(d, 'exposureMode'), entry(d, 'autoTracking')]);
    assert.deepEqual(got.luminance, { value: null });
    assert.equal(got.exposureMode.value, 0, 'VISCA inquiries still answer');
    assert.equal(got.autoTracking.value, null);
    await d.write(entry(d, 'luminance'), 11);
    assert.equal(fake.state.image.luminance, '11');
    assert.deepEqual(await d.status(), { tracking: undefined });
  });
});

test('a value the camera refuses, wrong password, silence', async () => {
  await withFake({ driver: { timeoutMs: 300 } }, async (fake, d) => {
    const id = await d.identify();
    d.schema(id);
    // The table would not let 20 through; sent anyway, the camera says no.
    await assert.rejects(d.write(entry(d, 'luminance'), 20), (e) => e.kind === 'refused');
    const bad = driver(fake, { auth: { username: 'admin', password: 'wrong' } });
    await assert.rejects(bad.identify(), (e) => e.kind === 'auth' && !/wrong/.test(e.message));
    bad.close();
    fake.setSilent(true);
    await assert.rejects(d.heartbeat(), (e) => e.kind === 'timeout');
    await assert.rejects(d.panTilt(0.5, 0), (e) => e.kind === 'timeout');
    fake.setSilent(false);
    // The timed-out socket was dropped; the next call reconnects.
    await d.heartbeat();
  });
});

// --- presets, tracking, picture ----------------------------------------------------------

test('presets over VISCA; reserved numbers refused with a reason', async () => {
  await withFake({}, async (fake, d) => {
    await d.identify();
    const n = fake.state.viscaLog.length;
    await d.presetStore(5);
    await d.presetRecall(5);
    await d.presetStore(152);
    assert.deepEqual(since(fake, n), ['81 01 04 3f 01 05 ff', '81 01 04 3f 02 05 ff', '81 01 04 3f 01 98 ff']);
    await assert.rejects(d.presetRecall(95), (e) => e.code === 'reserved' && /on-screen menu/.test(e.message));
    await assert.rejects(d.presetStore(150), (e) => e.code === 'reserved' && /tracking on/.test(e.message));
    await assert.rejects(d.presetRecall(90), (e) => e.code === 'reserved');
    await assert.rejects(d.presetRecall(255), (e) => e.code === 'range');
    await assert.rejects(d.presetDelete(5), (e) => e.kind === 'unsupported');
    assert.equal(fake.state.autotrack, false, 'nothing toggled tracking');
  });
});

test('auto tracking over CGI, subject select over VISCA', async () => {
  await withFake({}, async (fake, d) => {
    const id = await d.identify();
    d.schema(id);
    await d.write(entry(d, 'autoTracking'), true);
    assert.ok(fake.state.cgiLog.includes('GET /cgi-bin/param.cgi?set_overlay&autotracking&on'));
    assert.equal(fake.state.autotrack, true);
    assert.deepEqual(await d.status(), { tracking: true });
    const n = fake.state.viscaLog.length;
    await d.action(entry(d, 'trackSubjectRight'));
    assert.deepEqual(since(fake, n), ['81 0a 11 a3 03 ff']);
    await d.write(entry(d, 'autoTracking'), false);
    assert.equal((await d.read([entry(d, 'autoTracking')])).autoTracking.value, false);
  });
});

test('snapshot on new firmware; a clear unsupported on old', async () => {
  await withFake({}, async (fake, d) => {
    await d.identify();
    const f = await d.snapshot();
    assert.equal(f.contentType, 'image/jpeg');
    assert.ok(fake.state.cgiLog.includes('GET /snapshot0.jpg'));
  });
  await withFake({ firmware: '9.1.30' }, async (fake, d) => {
    const id = await d.identify();
    assert.equal(d.capabilities(id).snapshot, false);
    await assert.rejects(d.snapshot(), (e) => e.kind === 'unsupported' && /9\.1\.66/.test(e.message));
  });
  await withFake({ firmware: '9.1.50' }, async (fake, d) => {
    await d.identify();
    // In between the lens variants' thresholds: tried, and the 404 settles it.
    await assert.rejects(d.snapshot(), (e) => e.kind === 'unsupported');
    assert.equal(d.capabilities().snapshot, false);
  });
});

test('another PTZOptics model is accepted with an all-verify table', async () => {
  await withFake({}, async (fake, d) => {
    fake.state.device.device_model = 'F51.HI';
    const id = await d.identify();
    assert.equal(id.model, 'Move 4K');
    assert.equal(id.dedicatedTable, false);
    const schema = d.schema(id);
    assert.ok(schema.every((e) => e.verify === true));
    assert.ok(d.capabilities(id).tracking, 'its query reports autotrack');
    assert.equal((await d.position()).zoom, null, 'zoom range unknown off the Move SE');
  });
});

// --- end to end ---------------------------------------------------------------------------

test('end to end: PtzCamera connects, reads the table, survives silence and comes back', async () => {
  const fake = await startFakePtzoptics({ password: AUTH.password });
  const cam = new PtzCamera({
    entry: { id: 'se', label: 'SE', vendor: 'ptzoptics', ip: '127.0.0.1', port: fake.port, auth: AUTH, options: { viscaPort: fake.viscaPort } },
    Driver: PtzOptics,
    tuning: {
      heartbeatIntervalMs: 100, heartbeatTimeoutMs: 400, reconnectBackoffMs: [50, 100], reconnectBackoffMaxMs: 100,
      positionFastMs: 100, positionIdleMs: 200, statusMs: 200, settingsMs: 50, fastSettingsMs: 200, deadmanMs: 200,
      commandTimeoutMs: 300,
    },
  });
  const values = {};
  cam.on('values', (e) => Object.assign(values, e.values));
  cam.start();
  try {
    await until(() => cam.state === 'connected');
    await until(() => values.exposureMode && values.wbMode && values.luminance);
    assert.equal(cam.schema().capabilities.tracking.kind, 'autoTracking');
    assert.equal((await cam.write('wbMode', 'Outdoor')).ok, true);
    assert.equal(fake.state.image.wbmode, '2');
    assert.equal((await cam.preset('store', 89)).ok, true);
    // Inside the camera's range but reserved: refused before anything is sent, with the reason.
    const menu = await cam.preset('recall', 95);
    assert.equal(menu.status, 409);
    assert.match(menu.body.error, /on-screen menu/);
    assert.equal((await cam.preset('recall', 255)).status, 400, 'beyond the camera');
    cam.move({ pan: -0.5, tilt: 0 });
    await until(() => fake.state.head.v.pan < 0);
    await until(() => fake.state.head.v.pan === 0, { timeoutMs: 1500 });

    fake.setSilent(true);
    await until(() => cam.state === 'reconnecting', { timeoutMs: 3000 });
    fake.setSilent(false);
    await until(() => cam.state === 'connected', { timeoutMs: 5000 });
    await until(() => cam.timers.length > 0, { timeoutMs: 5000 });
  } finally {
    await cam.stop();
    await fake.close();
  }
});
