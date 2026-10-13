// Sony BRC-AM7 driver against its protocol fake (test/fakes/sony-brc.js):
// CGI with Digest + Referer, VISCA over IP on UDP, and the camera as
// delivered — VISCA switched off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { SonyBrc, tableFor, speedFor } from '../src/ptz/drivers/sony-brc.js';
import { TABLE, GAPS } from '../src/ptz/tables/sony-brc-am7.js';
import { validateTable, coerce } from '../src/ptz/schema.js';
import { request } from '../src/ptz/http.js';
import { PtzCamera } from '../src/ptz/lifecycle.js';
import { driverFor } from '../src/ptz/drivers/index.js';
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
  return new SonyBrc({
    host: '127.0.0.1', port: fake.port, auth, http: request, timeoutMs,
    options: { viscaPort: fake.viscaPort, ...options },
  });
}

async function withFake(opts, fn) {
  const fake = await startFakeSony({ password: AUTH.password, ...opts });
  const d = driver(fake, opts.driver);
  try {
    await fn(fake, d);
  } finally {
    d.close();
    await fake.close();
  }
}

const viscaSince = (fake, n) => fake.state.viscaLog.slice(n);
const entry = (d, id) => d.byId.get(id) ?? TABLE.find((e) => e.id === id);

// --- table --------------------------------------------------------------------

test('the BRC-AM7 table is sound, roles are unique, and S3-only rows are flagged', () => {
  assert.deepEqual(validateTable(TABLE), []);
  const roles = TABLE.filter((e) => e.role).map((e) => e.role);
  assert.equal(new Set(roles).size, roles.length);
  for (const r of ['home', 'onePushAf', 'focusMode', 'iris', 'irisMode', 'gain', 'shutter', 'nd',
    'whiteBalanceMode', 'colorTemp', 'trackingEnabled', 'tally', 'ipAddress', 'cameraName']) {
    assert.ok(roles.includes(r), `role ${r}`);
  }
  const fm = TABLE.find((e) => e.role === 'focusMode');
  assert.equal(fm.autoValue, 'auto');
  assert.equal(fm.manualValue, 'manual');
  for (const id of ['afrFramingMode', 'afrControlScope', 'afrSpeedPan', 'afrSensitivityZoom', 'afrCompSize']) {
    assert.equal(TABLE.find((e) => e.id === id).verify, true, id);
  }
  assert.ok(TABLE.filter((e) => e.requires === 'tracking').every((e) => e.group === 'tracking'));
  assert.ok(GAPS.length > 5);
  // Any other Sony model: same rows, every one to be verified.
  const other = tableFor('BRC-X400');
  assert.equal(other.length, TABLE.length);
  assert.ok(other.every((e) => e.verify === true));
  assert.equal(tableFor('BRC-AM7'), TABLE);
});

test('speed mapping: the smallest non-zero velocity is the slowest speed', () => {
  assert.equal(speedFor(0.0001, 127), 1);
  assert.equal(speedFor(-1, 127), 127);
  assert.equal(speedFor(0.5, 24), 12);
});

// --- probe and identity ------------------------------------------------------------

test('probe identifies the camera, and is null for a server that is not a Sony', async () => {
  const fake = await startFakeSony({ password: AUTH.password });
  const plain = createServer((req, res) => res.end('<html>hello</html>'));
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  try {
    const id = await SonyBrc.probe({ host: '127.0.0.1', port: fake.port, auth: AUTH, http: request, timeoutMs: 800 });
    assert.equal(id.vendor, 'sony');
    assert.equal(id.model, 'BRC-AM7');
    const none = await SonyBrc.probe({ host: '127.0.0.1', port: plain.address().port, auth: AUTH, http: request, timeoutMs: 800 });
    assert.equal(none, null);
    // Wrong password: the CGI says 401, the VISCA version inquiry says Sony.
    await assert.rejects(SonyBrc.probe({
      host: '127.0.0.1', port: fake.port, auth: { username: 'admin', password: 'wrong' }, http: request, timeoutMs: 800,
      options: { viscaPort: fake.viscaPort },
    }), (e) => e.kind === 'auth');
    // Probing never moved anything or changed a setting.
    assert.ok(fake.state.viscaLog.every((l) => l.startsWith('81 09')));
    assert.ok(fake.state.cgiLog.every((u) => u.startsWith('/command/inquiry.cgi')));
    assert.equal(driverFor('sony'), SonyBrc);
  } finally {
    plain.close();
    await fake.close();
  }
});

test('with VISCA on: identity, Auto Framing, focus control', async () => {
  await withFake({}, async (fake, d) => {
    const id = await d.identify();
    assert.equal(id.model, 'BRC-AM7');
    assert.equal(id.firmware, '2.00');
    assert.equal(id.mac, '02:00:5e:00:00:07');
    assert.equal(id.viscaModelId, '051f');
    const caps = d.capabilities(id);
    assert.deepEqual(caps.tracking, { kind: 'autoFraming', label: 'PTZ Auto Framing' });
    assert.equal(caps.presets, 100);
    assert.equal(caps.presetBase, 1);
    assert.equal(caps.focus, true);
    assert.equal(caps.visca.available, true);
    const schema = d.schema(id);
    assert.ok(schema.some((e) => e.id === 'detail'));
    assert.ok(schema.some((e) => e.id === 'afrEnable'));
    // Every CGI request carried a Referer naming the camera (the check is on by default).
    assert.equal(fake.state.params.RefererCheck, 'on');
  });
});

test('with VISCA off (SETUP switch 4): CGI does everything it can, and the operator is told what to switch on', async () => {
  await withFake({ visca: false }, async (fake, d) => {
    const id = await d.identify();
    const caps = d.capabilities(id);
    assert.equal(caps.visca.available, false);
    assert.match(caps.visca.reason, /SETUP switch 4/);
    assert.match(caps.visca.fix, /SETUP switch 4.*restart/);
    assert.equal(caps.focus, false, 'focus velocity exists only over VISCA');
    assert.ok(caps.tracking, 'Auto Framing still works over CGI');
    const schema = d.schema(id);
    assert.ok(!schema.some((e) => e.requires === 'visca'));
    const status = await d.read([entry(d, 'viscaStatus')]);
    assert.match(status.viscaStatus.value, /^Off — .*SETUP switch 4/);

    const n = fake.state.cgiLog.length;
    await d.panTilt(0.001, 0);
    await d.panTilt(-1, 0.5);
    await d.zoom(0.5);
    await d.stop();
    assert.deepEqual(fake.state.cgiLog.slice(n), [
      '/command/ptzf.cgi?PanTiltMove=right,1,0',
      '/command/ptzf.cgi?PanTiltMove=up-left,127,64',
      '/command/ptzf.cgi?ZoomMove=tele,16383',
      '/command/ptzf.cgi?PanTiltMove=stop,0,0',
      '/command/ptzf.cgi?ZoomMove=stop,0',
    ]);
    await assert.rejects(d.focus(0.5), (e) => e.kind === 'unsupported' && /SETUP switch 4/.test(e.message));
    assert.equal(fake.state.viscaLog.length, 0, 'nothing reached VISCA (the fake ignores it while off)');
    // Auto Framing on over CGI.
    await d.write(entry(d, 'afrEnable'), true);
    assert.equal(fake.state.afr, true);
    assert.ok(fake.state.cgiLog.at(-1).startsWith('/analytics/ptzautoframing.cgi?PtzAutoFraming=on'));
    assert.equal((await d.status()).tracking, true);
  });
});

test('with no administrator password, the reason says so', async () => {
  await withFake({ passwordSet: false }, async (fake, d) => {
    const id = await d.identify();
    assert.match(d.capabilities(id).visca.reason, /administrator password/);
  });
});

// --- motion over VISCA ----------------------------------------------------------------

test('VISCA motion: directions, slowest speed, speed steps, and every stop', async () => {
  await withFake({}, async (fake, d) => {
    await d.identify();
    let n = fake.state.viscaLog.length;
    await d.panTilt(0.001, 0);          // slow right
    await d.panTilt(-1, 1);             // full up-left
    await d.panTilt(0, -0.25);          // down
    assert.deepEqual(viscaSince(fake, n), [
      '81 01 06 01 01 01 02 03 ff',
      '81 01 06 01 7f 7f 01 01 ff',
      '81 01 06 01 01 20 03 02 ff',
    ]);
    // Normal speed step: 24 steps, 01..18h.
    await d.write(entry(d, 'panTiltSpeedStep'), 'normal');
    n = fake.state.viscaLog.length;
    await d.panTilt(1, 0);
    assert.deepEqual(viscaSince(fake, n), ['81 01 06 01 18 01 02 03 ff']);

    n = fake.state.viscaLog.length;
    await d.zoom(0.00001);
    await d.zoom(-1);
    await d.zoom(0);
    assert.deepEqual(viscaSince(fake, n), [
      '81 01 7e 04 17 02 00 00 00 01 ff',
      '81 01 7e 04 17 03 07 0f 0f 0e ff',
      '81 01 7e 04 17 00 00 00 00 00 ff',
      '81 01 04 07 00 ff',
    ]);

    // Focus drive needs manual focus; in auto the camera says not executable.
    await assert.rejects(d.focus(0.5), (e) => e.kind === 'refused' && /Manual/.test(e.message));
    await d.write(entry(d, 'focusMode'), 'manual');
    n = fake.state.viscaLog.length;
    await d.focus(1);
    await d.focus(-0.01);
    assert.deepEqual(viscaSince(fake, n), ['81 01 04 08 27 ff', '81 01 04 08 30 ff']);

    n = fake.state.viscaLog.length;
    await d.stop();
    assert.deepEqual(viscaSince(fake, n), [
      '81 01 06 01 01 01 03 03 ff',
      '81 01 7e 04 17 00 00 00 00 00 ff',
      '81 01 04 07 00 ff',
      '81 01 04 08 00 ff',
    ]);
    assert.equal(fake.state.head.v.pan, 0);
    // stop() is fine in auto focus too, where the focus stop is refused.
    await d.write(entry(d, 'focusMode'), 'auto');
    await d.stop();
  });
});

test('position is normalised with positive pan to the right', async () => {
  await withFake({}, async (fake, d) => {
    await d.identify();
    fake.state.head.pan = -87500;      // half way to the right end (Sony counts up to the left)
    fake.state.head.zoom = 0x2000;
    const p = await d.position();
    assert.ok(Math.abs(p.pan - 0.75) < 0.01, `pan ${p.pan}`);
    assert.ok(Math.abs(p.zoom - 0.5) < 0.01);
    assert.equal(p.raw.pan, -87500);
  });
});

test('VISCA stops answering mid-session: motion and stop fall back to CGI', async () => {
  await withFake({ driver: { timeoutMs: 400 } }, async (fake, d) => {
    await d.identify();
    fake.state.viscaEnabled = false;
    const n = fake.state.cgiLog.length;
    await d.panTilt(0.5, 0);
    assert.equal(d.capabilities().visca.available, false);
    await d.stop();
    assert.deepEqual(fake.state.cgiLog.slice(n), [
      '/command/ptzf.cgi?PanTiltMove=right,64,0',
      '/command/ptzf.cgi?PanTiltMove=stop,0,0',
      '/command/ptzf.cgi?ZoomMove=stop,0',
    ]);
  });
});

// --- settings ---------------------------------------------------------------------------

test('read and write: enum, scaled range, bool, list field, prefixed value, VISCA-only', async () => {
  await withFake({}, async (fake, d) => {
    const id = await d.identify();
    d.schema(id);
    const got = await d.read(['wbMode', 'gain', 'agc', 'afrCompSize', 'afrRangeEnable', 'backlight', 'aeLevel'].map((x) => entry(d, x)));
    assert.equal(got.wbMode.value, 'memory_a');
    assert.equal(got.gain.value, 0, 'ExposureGain 9 is 0 dB');
    assert.equal(got.agc.value, false);
    assert.equal(got.afrCompSize.value, 1200);
    assert.equal(got.afrRangeEnable.value, false);
    assert.equal(got.backlight.value, false);
    assert.equal(got.aeLevel.value, 0);
    assert.ok(got.wbOffsetTint, 'one inquiry answers its whole group');

    await d.write(entry(d, 'wbMode'), 'atw');
    await d.write(entry(d, 'gain'), 6);
    await d.write(entry(d, 'agc'), true);
    await d.write(entry(d, 'afrCompSize'), 2000);
    await d.write(entry(d, 'afrCompVertical'), -20);
    await d.write(entry(d, 'afrRangeEnable'), true);
    await d.write(entry(d, 'backlight'), true);
    await d.write(entry(d, 'aeLevel'), -1.25);
    assert.equal(fake.state.params.WhiteBalanceMode, 'atw');
    assert.equal(fake.state.params.ExposureGain, '15');
    assert.equal(fake.state.params.ExposureAGCEnable, 'on');
    assert.equal(fake.state.params.PtzAutoFramingAdjustSetting, '-20,0,2000');
    assert.equal(fake.state.params.PtzAutoFramingTrackingRangeEnable, '1,on');
    assert.equal(fake.state.backlight, true);
    assert.equal(fake.state.params.ExposureCompensation, '7');
    const back = await d.read([entry(d, 'gain'), entry(d, 'backlight'), entry(d, 'wbColorTemp')]);
    assert.equal(back.gain.value, 6);
    assert.equal(back.backlight.value, true);
    assert.equal(back.wbColorTemp.writable, false, 'gated behind Memory A');
  });
});

test('gate refusal, a value the camera refuses, wrong password, silence', async () => {
  await withFake({ driver: { timeoutMs: 300 } }, async (fake, d) => {
    const id = await d.identify();
    d.schema(id);
    await d.write(entry(d, 'wbMode'), 'atw');
    await assert.rejects(d.write(entry(d, 'wbColorTemp'), 5600),
      (e) => e.kind === 'refused' && e.code === 'gate' && /Memory A/.test(e.message));
    // In the entry's range, refused by the camera (RTSP port 600 is neither 554 nor 1024+).
    const port = entry(d, 'rtspPort');
    assert.equal(coerce(port, 600).ok, true);
    await assert.rejects(d.write(port, 600), (e) => e.kind === 'refused');
    // Nothing logged a password: errors never carry it.
    const bad = driver(fake, { auth: { username: 'admin', password: 'wrong' } });
    await assert.rejects(bad.identify(), (e) => e.kind === 'auth' && !/wrong/.test(e.message));
    bad.close();
    fake.setSilent(true);
    await assert.rejects(d.heartbeat(), (e) => e.kind === 'timeout');
    await assert.rejects(d.identify(), (e) => e.kind === 'timeout');
    fake.setSilent(false);
  });
});

// --- presets, actions, tally, picture -----------------------------------------------------

test('presets over CGI: store, recall, delete, and 1..100 only', async () => {
  await withFake({}, async (fake, d) => {
    await d.identify();
    fake.state.head.pan = 1000;
    await d.presetStore(100);
    fake.state.head.pan = 5000;
    await d.presetRecall(100);
    assert.equal(Math.round(fake.state.head.pan), 1000);
    await d.presetDelete(100);
    assert.ok(!fake.state.presets.has(100));
    assert.ok(fake.state.cgiLog.includes('/command/presetposition.cgi?PresetSet=100,,on'));
    assert.ok(fake.state.cgiLog.includes('/command/presetposition.cgi?PresetCall=100'));
    await assert.rejects(d.presetRecall(101), (e) => e.kind === 'refused');
    await assert.rejects(d.presetRecall(100), (e) => e.kind === 'refused', 'an empty preset is refused by the camera');
  });
});

test('actions: press/release pairs, Auto Framing over VISCA, target by point', async () => {
  await withFake({}, async (fake, d) => {
    await d.identify();
    let n = fake.state.cgiLog.length;
    await d.action(entry(d, 'wbSet'));
    assert.deepEqual(fake.state.cgiLog.slice(n), [
      '/command/imaging.cgi?WhiteBalanceWBSet=press', '/command/imaging.cgi?WhiteBalanceWBSet=release',
    ]);
    let v = fake.state.viscaLog.length;
    await d.action(entry(d, 'pushAF'));
    await d.action(entry(d, 'home'));
    assert.deepEqual(viscaSince(fake, v), ['81 01 7e 04 58 01 ff', '81 01 7e 04 58 00 ff', '81 01 06 04 ff']);
    v = fake.state.viscaLog.length;
    await d.write(entry(d, 'afrEnable'), true);
    assert.deepEqual(viscaSince(fake, v), ['81 01 7e 04 3a 01 ff']);
    assert.equal((await d.status()).tracking, true);
    n = fake.state.cgiLog.length;
    await d.action(entry(d, 'afrSelectTarget'), { x: 2500, y: 4000 });
    await d.action(entry(d, 'afrPreset2'));
    assert.deepEqual(fake.state.cgiLog.slice(n), [
      '/analytics/ptzautoframing.cgi?PtzAutoFramingObjectPosition=2500,4000',
      '/analytics/ptzautoframing.cgi?PtzAutoFramingPresetCall=2',
    ]);
  });
});

test('tally: red for program, refreshed inside the 15 s VISCA expiry, stopped by close()', async () => {
  await withFake({ driver: { options: { tallyRefreshMs: 60 } } }, async (fake, d) => {
    await d.identify();
    await d.setTally({ program: true, preview: false });
    assert.equal(fake.state.tally.red, true);
    const count = () => fake.state.viscaLog.filter((l) => l === '81 01 7e 01 0a 00 02 ff').length;
    const first = count();
    await until(() => count() >= first + 2, { timeoutMs: 1000 });
    await d.setTally({ program: false, preview: true });
    assert.equal(fake.state.tally.red, false);
    assert.equal(fake.state.tally.green, true);
    d.close();
    const after = fake.state.viscaLog.length;
    await sleep(200);
    assert.equal(fake.state.viscaLog.length, after, 'no refresh after close');
    assert.equal(d.tallyTimer, null);
  });
});

test('snapshot comes from /oneshotimage1', async () => {
  await withFake({}, async (fake, d) => {
    await d.identify();
    const f = await d.snapshot();
    assert.equal(f.contentType, 'image/jpeg');
    assert.equal(f.body[0], 0xff);
    assert.equal(f.body[1], 0xd8);
    assert.ok(fake.state.cgiLog.includes('/oneshotimage1'));
  });
});

test('another Sony model is accepted, named as it reports, and its table is all verify', async () => {
  await withFake({ model: 'SRG-A40', presetNum: 256, autoFraming: false }, async (fake, d) => {
    const id = await d.identify();
    assert.equal(id.model, 'SRG-A40');
    assert.equal(id.dedicatedTable, false);
    const caps = d.capabilities(id);
    assert.equal(caps.presets, 256, 'preset count as the camera reports it');
    assert.equal(caps.tracking, null, 'no Auto Framing unless its inquiry answers');
    const schema = d.schema(id);
    assert.ok(schema.length > 50);
    assert.ok(schema.every((e) => e.verify === true));
    assert.ok(!schema.some((e) => e.requires === 'tracking'));
  });
});

// --- end to end ------------------------------------------------------------------------------

test('end to end: PtzCamera connects, reads the table, survives silence and comes back', async () => {
  const fake = await startFakeSony({ password: AUTH.password });
  const cam = new PtzCamera({
    entry: { id: 'am7', label: 'AM7', vendor: 'sony', ip: '127.0.0.1', port: fake.port, auth: AUTH, options: { viscaPort: fake.viscaPort } },
    Driver: SonyBrc,
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
    await until(() => values.wbMode && values.afrEnable && values.gain);
    assert.equal(values.wbMode.value, 'memory_a');
    assert.equal(cam.schema().capabilities.tracking.kind, 'autoFraming');
    assert.ok(!cam.schema().entries.some((e) => 'wire' in e));
    const w = await cam.write('wbMode', 'ATW');
    assert.equal(w.ok, true);
    assert.equal(fake.state.params.WhiteBalanceMode, 'atw');
    assert.equal((await cam.preset('store', 3)).ok, true);
    assert.equal((await cam.preset('recall', 101)).status, 400);
    cam.move({ pan: 0.5, tilt: 0 });
    await until(() => fake.state.head.v.pan > 0);
    await until(() => fake.state.head.v.pan === 0, { timeoutMs: 1500 });

    fake.setSilent(true);
    await until(() => cam.state === 'reconnecting', { timeoutMs: 3000 });
    fake.setSilent(false);
    await until(() => cam.state === 'connected', { timeoutMs: 5000 });
    // Let the reconnect's first full read finish: stopping in the middle of
    // it rejects an await inside the lifecycle's uncaught #connect()
    // (foundation issue, reported).
    await until(() => cam.timers.length > 0, { timeoutMs: 5000 });
  } finally {
    await cam.stop();
    await fake.close();
  }
});
