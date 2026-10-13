// CamBridge driving a SKAARHOJ panel over Raw Panel: the client against a
// fake panel, the role heuristics against invented topologies, and the whole
// app — joystick to simulated head — with the safety cases that matter most:
// a panel that vanishes while the stick is deflected must leave nothing moving.
//
// Everything here is tested against test/fakes/skaarhoj-panel.js only. The
// fake speaks the protocol as the spec notes describe it; the real PTZ
// Extreme's topology, sign conventions and timing are not known (see
// docs/skaarhoj.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RawPanelClient, hwcText, LED, COLOUR, colourValue } from '../src/skaarhoj/rawpanel.js';
import { detectRoles, components } from '../src/skaarhoj/mapping.js';
import { startFakePanel, defaultTopology } from './fakes/skaarhoj-panel.js';
import { fakeHead, resetFakeHeads } from '../src/ptz/drivers/fake.js';
import { createApp } from '../src/server.js';
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

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
/** What the default 5% deadband makes of a panel speed (-500..500). */
const scaled = (speed) => Math.sign(speed) * (Math.abs(speed) / 500 - 0.05) / 0.95;

function client(port, extra = {}) {
  return new RawPanelClient({ host: '127.0.0.1', port, heartbeatMs: 250, lostAfterMs: 900, backoffMs: [100, 200], ...extra });
}

// --- the client --------------------------------------------------------------

test('handshake: list first, then topology, map and heartbeat; panel identified', async () => {
  const panel = await startFakePanel();
  const c = client(panel.port);
  try {
    const connected = new Promise((r) => c.once('connected', r));
    c.start();
    const info = await connected;
    assert.deepEqual(panel.received.slice(0, 4), ['list', 'PanelTopology?', 'map', 'HeartBeatTimer=250']);
    assert.equal(info.model, 'SK_FAKEPTZ');
    assert.equal(info.serial, 'FAKE0001');
    assert.equal(c.status().connected, true);
    assert.equal(c.topology.HWc.length, 51);
    await until(() => c.mapReceived && c.available(37));
  } finally { await c.stop(); await panel.close(); }
});

test('ping is answered with ack, and the client pings the panel too', async () => {
  const panel = await startFakePanel();
  const c = client(panel.port);
  try {
    c.start();
    await until(() => c.connected);
    await until(() => panel.acks >= 2, { timeoutMs: 2000 });
    assert.ok(panel.received.includes('ping'));
    // Well past the panel's 2 s answer window, and still connected.
    await sleep(600);
    assert.equal(c.connected, true);
  } finally { await c.stop(); await panel.close(); }
});

test('events are parsed, and garbage is ignored without dropping the link', async () => {
  const panel = await startFakePanel();
  const c = client(panel.port);
  const events = [];
  c.on('event', (e) => events.push(e));
  try {
    c.start();
    await until(() => c.connected);
    for (const line of [
      'HWC#abc=Down', 'HWC#5=Sideways', 'HWC#37=Speed:', '_panelTopology_HWC={not json',
      'map=x:y', '\u0000\u0001\u0002binary', '=', 'HWC#45=Enc:--',
      `x${'y'.repeat(100000)}`,
    ]) panel.send(line);
    panel.send('HWC#5.4=Down');
    panel.send('HWC#37=Speed:-120');
    panel.send('HWC#45=Enc:-2');
    panel.send('HWC#9=Press');
    panel.send('HWC#60=Speed:3,4');
    await until(() => events.length >= 6);
    assert.deepEqual(events.map((e) => [e.id, e.edge, e.kind, e.value ?? null]), [
      [5, 4, 'Down', null], [37, 0, 'Speed', -120], [45, 0, 'Enc', -2],
      [9, 0, 'Down', null], [9, 0, 'Up', null], [60, 0, 'Speed', 3],
    ]);
    assert.deepEqual(events[5].values, [3, 4]);
    assert.equal(c.connected, true);
    assert.equal(c.topology.HWc.length, 51, 'a bad topology line does not replace a good one');
  } finally { await c.stop(); await panel.close(); }
});

test('a panel without ASCII support is refused, with a reason', async () => {
  const binary = await startFakePanel({ support: 'Binary' });
  const silent = await startFakePanel({ silent: true });
  const refusing = await startFakePanel({ errorMsg: 'Max clients reached' });
  const a = client(binary.port);
  const b = client(silent.port, { initTimeoutMs: 300 });
  const e = client(refusing.port);
  try {
    a.start(); b.start(); e.start();
    await until(() => a.state === 'refused');
    assert.match(a.detail, /no ASCII/);
    await until(() => b.state === 'refused');
    assert.match(b.detail, /did not answer in ASCII/);
    await until(() => /Max clients reached/.test(e.detail ?? ''));
    assert.equal(a.connected || b.connected || e.connected, false);
  } finally {
    await a.stop(); await b.stop(); await e.stop();
    await binary.close(); await silent.close(); await refusing.close();
  }
});

test('a dropped link reconnects, and a hung panel counts as dropped', async () => {
  const panel = await startFakePanel();
  const c = client(panel.port);
  const seen = [];
  c.on('connected', () => seen.push('up'));
  c.on('disconnected', (why) => seen.push(`down: ${why}`));
  try {
    c.start();
    await until(() => c.connected);
    panel.dropAll();
    await until(() => seen.length >= 3, { timeoutMs: 2000 });
    assert.equal(seen[1], 'down: the panel closed the connection');
    assert.equal(panel.connections, 2);
    panel.freeze();
    await until(() => seen.some((s) => /no heartbeat/.test(s)), { timeoutMs: 2000 });
  } finally { await c.stop(); await panel.close(); }
});

test('HWCt text is clipped to what the panel accepts', () => {
  assert.equal(hwcText({ title: 'Gain', isLabel: true, label1: '3 dB' }), '|||Gain|1|3 dB');
  assert.equal(hwcText({ format: 7 }), '|7');
  const long = hwcText({ title: 'T'.repeat(40), isLabel: true, label1: 'a|bé'.repeat(20), label2: 'z'.repeat(30) });
  assert.ok(long.length <= 63);
  assert.ok(!long.slice(5).includes('|1|a|'), 'a pipe in text cannot split a field');
  assert.equal(colourValue(COLOUR.RED), 132);   // notes §6.2: 132 = red
  assert.equal(LED.ON, 36);
});

// --- roles from topology ---------------------------------------------------------

test('roles come from the topology, not from fixed ids', () => {
  const r = detectRoles(defaultTopology(), { cameraCount: 2 });
  assert.deepEqual([r.pan, r.tilt, r.rotate, r.zoom, r.focus], [37, 38, 39, 41, 42]);
  assert.deepEqual(r.encoders, [43, 44, 45, 46, 47, 48, 49, 50, 51]);
  assert.equal(r.displays[43], 43, 'an encoder with its own display uses it');
  assert.equal(r.displays[51], undefined, 'the large encoder has none');
  assert.deepEqual(r.cameras, [1, 2]);
  assert.deepEqual(r.presets, [7, 8, 9, 10, 11, 12, 13, 14], 'presets start on the next row');
  assert.equal(r.store, 15);
  assert.equal(r.tracking, 16);
  assert.equal(r.stop, null, 'STOP is never assigned by position');

  // Labels win over position, and a stick without UIyang pairing is still found.
  const t = defaultTopology({ labels: { 36: 'STOP', 30: 'Store', 42: 'Iris' } });
  for (const hw of t.HWc) delete hw.UIyang;
  const r2 = detectRoles(t, { cameraCount: 3 });
  assert.deepEqual([r2.pan, r2.tilt, r2.zoom], [37, 38, 41]);
  assert.equal(r2.stop, 36);
  assert.equal(r2.store, 30);
  assert.equal(r2.focus, null, 'a roller labelled for something else is not focus');
  assert.deepEqual(r2.cameras, [1, 2, 3]);

  // A whole stick as one vector component.
  const v = defaultTopology();
  v.typeIndex[2] = { w: 300, in: 'i,dim=2', desc: 'Joystick' };
  v.HWc = v.HWc.filter((hw) => hw.id !== 38);
  delete v.HWc.find((hw) => hw.id === 37).UIyang;
  const r3 = detectRoles(v, { cameraCount: 1 });
  assert.equal(r3.vector, 37);
  assert.equal(r3.pan, null);
  assert.equal(r3.zoom, 41);

  // Controls the map says are absent are not used.
  const r4 = detectRoles(defaultTopology(), { cameraCount: 1, available: (id) => id !== 41 });
  assert.equal(r4.zoom, null);
});

test('the mapping override pins roles, and the guesses work around it', () => {
  const r = detectRoles(defaultTopology(), {
    cameraCount: 2,
    override: { pan: 38, tilt: 37, cameras: [31, 32], stop: 36, encoders: [44, 43], encoderDisplays: { 44: 45 }, presetCount: 3 },
  });
  assert.deepEqual([r.pan, r.tilt, r.stop], [38, 37, 36]);
  assert.deepEqual(r.cameras, [31, 32]);
  assert.deepEqual(r.encoders, [44, 43]);
  assert.equal(r.displays[44], 45);
  assert.deepEqual(r.presets, [1, 2, 3], 'pinned buttons are not handed out again');
  assert.ok(r.pinned.includes('cameras'));
});

test('a nonsense topology yields no roles rather than an exception', () => {
  for (const t of [null, {}, { HWc: 'x' }, { HWc: [null, { id: 'a' }, { id: 3, type: 9 }], typeIndex: 5 },
    { HWc: [{ id: 1, type: 1 }], typeIndex: { 1: { in: 42 } } }]) {
    const r = detectRoles(t, { cameraCount: 2 });
    assert.equal(r.pan, null);
    assert.deepEqual(r.cameras, []);
    assert.ok(Array.isArray(components(t)));
  }
});

// --- the app driving the panel -------------------------------------------------

const FAST = {
  heartbeatIntervalMs: 100, heartbeatTimeoutMs: 300,
  reconnectBackoffMs: [50, 100], reconnectBackoffMaxMs: 100,
  positionFastMs: 50, positionIdleMs: 100, statusMs: 100, settingsMs: 50, fastSettingsMs: 100,
  deadmanMs: 300,
};

async function panelApp({ panel, mode = 'drive', mapping = {}, logLevel = 'error', cameras = null } = {}) {
  resetFakeHeads();
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-skaarhoj-'));
  const configPath = join(dir, 'cambridge.json');
  writeFileSync(configPath, JSON.stringify({
    cambridge: { bind: '127.0.0.1', port: 0 },
    logging: { dir: join(dir, 'logs'), level: logLevel },
    ptz: FAST,
    skaarhoj: {
      mode, host: mode === 'drive' ? '127.0.0.1' : '', port: panel.port, mapping,
      heartbeatMs: 250, lostAfterMs: 900, backoffMs: [100, 200],
    },
    cameras: cameras ?? [
      { id: 'left', kind: 'ptz', vendor: 'fake', label: 'Left', ip: 'fake-left' },
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
    return { status: r.status, body: await r.json() };
  };
  return { app, call, dir, configPath };
}

/** Both heads connected and their tables on the panel. */
async function ready(app, panel) {
  await until(() => app.state.list().filter((c) => c.kind === 'ptz').every((c) => c.state === 'connected'));
  await until(() => app.skaarhoj?.client.connected);
  await until(() => /Iris/.test(panel.texts.get(43) ?? ''));
}

test('camera buttons show names, selection and tally', async () => {
  const panel = await startFakePanel();
  const { app, call } = await panelApp({ panel });
  try {
    await ready(app, panel);
    await until(() => /Left/.test(panel.texts.get(1) ?? '') && /Right/.test(panel.texts.get(2) ?? ''));
    assert.equal(panel.leds.get(1), LED.ON);
    assert.equal(panel.colours.get(1), colourValue(COLOUR.AMBER));
    assert.equal(panel.leds.get(2), LED.DIM);
    assert.equal(panel.colours.get(2), colourValue(COLOUR.WHITE));
    assert.equal((await call('GET', '/api/skaarhoj')).body.selectedCameraId, 'left');

    panel.press(2, 4);   // a four-way button reports an edge; any edge selects
    panel.release(2, 4);
    await until(() => panel.leds.get(2) === LED.ON && panel.leds.get(1) === LED.DIM);
    assert.equal((await call('GET', '/api/skaarhoj')).body.selectedCameraId, 'right');

    app.state.applyTally({ left: { program: true, preview: false }, right: { program: false, preview: true } });
    await until(() => panel.colours.get(1) === colourValue(COLOUR.RED) && panel.colours.get(2) === colourValue(COLOUR.GREEN));
    assert.match(panel.texts.get(1), /PGM/);
  } finally { await app.stop(); await panel.close(); }
});

test('joystick drives the selected head, latched, and Speed:0 stops it', async () => {
  const panel = await startFakePanel();
  const { app } = await panelApp({ panel });
  try {
    await ready(app, panel);
    const head = fakeHead('fake-left');
    panel.speed(37, 400);
    await until(() => near(head.v.pan, scaled(400)));
    panel.speed(38, -250);
    await until(() => near(head.v.tilt, scaled(-250)));
    // The panel sends nothing while the stick is held: the move must outlive
    // the 300 ms deadman.
    await sleep(600);
    assert.ok(near(head.v.pan, scaled(400)), 'a held stick keeps moving');
    panel.speed(37, 0);
    panel.speed(38, 0);
    await until(() => head.v.pan === 0 && head.v.tilt === 0);
    // Inside the deadband is centre.
    panel.speed(37, 12);
    await sleep(100);
    assert.equal(head.v.pan, 0);
    // The rocker zooms; the twist does not, because there is a rocker.
    panel.speed(39, 500);
    await sleep(100);
    assert.equal(head.v.zoom, 0);
    panel.speed(41, 250);
    await until(() => near(head.v.zoom, scaled(250)));
    panel.speed(41, 0);
    await until(() => head.v.zoom === 0);
    // The roller sends pulses: a burst, ended by the deadman, not latched.
    panel.enc(42, 2);
    await until(() => head.v.focus > 0);
    await until(() => head.v.focus === 0, { timeoutMs: 1500 });
  } finally { await app.stop(); await panel.close(); }
});

test('the panel vanishing while the stick is deflected stops the head', async () => {
  const panel = await startFakePanel();
  const { app } = await panelApp({ panel });
  try {
    await ready(app, panel);
    const head = fakeHead('fake-left');
    panel.speed(37, 500);
    panel.speed(41, -500);
    await until(() => head.v.pan === 1 && head.v.zoom === -1);
    panel.dropAll();
    await until(() => head.v.pan === 0 && head.v.zoom === 0, { timeoutMs: 1500 });

    // And when it hangs rather than closes: the heartbeat notices.
    await until(() => app.skaarhoj.client.connected, { timeoutMs: 2000 });
    panel.speed(37, -500);
    await until(() => head.v.pan === -1);
    panel.freeze();
    await until(() => head.v.pan === 0, { timeoutMs: 2500 });
    assert.equal(app.skaarhoj.client.connected, false);
    panel.freeze(false);
    await until(() => app.skaarhoj.client.connected, { timeoutMs: 3000 });
    // Reconnected with the stick assumed centred: nothing moves until it says so.
    await sleep(200);
    assert.equal(head.v.pan, 0);
  } finally { await app.stop(); await panel.close(); }
});

test('switching camera stops the one being left', async () => {
  const panel = await startFakePanel();
  const { app } = await panelApp({ panel });
  try {
    await ready(app, panel);
    const left = fakeHead('fake-left');
    const right = fakeHead('fake-right');
    panel.speed(37, 300);
    await until(() => left.v.pan > 0);
    panel.press(2);
    await until(() => left.v.pan === 0);
    await sleep(100);
    assert.equal(right.v.pan, 0, 'the stick has to move again before the new camera does');
    panel.speed(37, 350);
    await until(() => right.v.pan > 0);
    assert.equal(left.v.pan, 0);
  } finally { await app.stop(); await panel.close(); }
});

test('encoders step the selected camera\'s operate settings, role-tagged ones first', async () => {
  const panel = await startFakePanel();
  const { app } = await panelApp({ panel });
  try {
    await ready(app, panel);
    const head = fakeHead('fake-left');
    // Bank: iris, gain, shutter, colorTemp (by role), then the other operate entries.
    assert.deepEqual(app.skaarhoj.controller.bank('left').map((e) => e.id).slice(0, 4), ['iris', 'gain', 'shutter', 'colorTemp']);
    await until(() => /Gain/.test(panel.texts.get(44) ?? '') && /0 dB/.test(panel.texts.get(44)));
    panel.enc(44, 1);
    await until(() => head.values.gain === 3);
    panel.enc(44, 2);
    await until(() => head.values.gain === 9);
    await until(() => /9 dB/.test(panel.texts.get(44) ?? ''));
    panel.enc(45, 1);
    await until(() => head.values.shutter === '1/60');
    panel.enc(45, -5);   // clamps at the first option
    await until(() => head.values.shutter === '1/25');
    // The encoder's push is not a button press.
    panel.press(44, 16);
    await sleep(80);
    assert.equal(head.values.gain, 9);
  } finally { await app.stop(); await panel.close(); }
});

test('preset buttons recall, and with STORE held they store', async () => {
  const panel = await startFakePanel();
  const { app, call } = await panelApp({ panel });
  try {
    await ready(app, panel);
    const head = fakeHead('fake-left');
    await until(() => /PRESET 1/.test(panel.texts.get(7) ?? ''));
    assert.equal((await call('POST', '/api/cameras/left/ptz/presets/1/store', { name: 'Lectern' })).status, 200);
    await until(() => /Lectern/.test(panel.texts.get(7) ?? ''));
    const at = head.pan;
    head.pan = 0.9;
    panel.press(7);
    await until(() => near(head.pan, at, 1e-3));

    panel.press(15);   // STORE held
    await until(() => /STORE 2/.test(panel.texts.get(8) ?? ''));
    panel.press(8);
    await until(() => head.presets.has(2));
    panel.release(15);
    await until(() => /PRESET 2/.test(panel.texts.get(8) ?? ''));
  } finally { await app.stop(); await panel.close(); }
});

test('tracking toggles on the camera that has it, and only there', async () => {
  const panel = await startFakePanel();
  const { app } = await panelApp({ panel });
  try {
    await ready(app, panel);
    panel.press(16);
    await sleep(100);
    assert.equal(fakeHead('fake-left').values.trackingEnabled, false);
    panel.press(2);
    await until(() => /Off/.test(panel.texts.get(16) ?? ''));
    panel.press(16);
    await until(() => fakeHead('fake-right').values.trackingEnabled === true);
    await until(() => /On/.test(panel.texts.get(16) ?? ''));
  } finally { await app.stop(); await panel.close(); }
});

test('a control the map marks absent gets no role; the twist zooms instead of a missing rocker', async () => {
  const panel = await startFakePanel();
  panel.mapped.set(41, 0);
  const { app, call } = await panelApp({ panel });
  try {
    await ready(app, panel);
    await until(async () => (await call('GET', '/api/skaarhoj')).body.topologySummary?.zoom === null);
    const head = fakeHead('fake-left');
    panel.speed(41, 500);
    await sleep(100);
    assert.equal(head.v.zoom, 0, 'an absent control is not obeyed');
    panel.speed(39, -250);
    await until(() => near(head.v.zoom, scaled(-250)));
    panel.speed(39, 0);
    await until(() => head.v.zoom === 0);
  } finally { await app.stop(); await panel.close(); }
});

test('a labelled STOP stops everything; an overridden mapping is obeyed', async () => {
  const panel = await startFakePanel({ topology: defaultTopology({ labels: { 36: 'STOP' } }) });
  const { app } = await panelApp({ panel, mapping: { cameras: [31, 32], pan: 38, tilt: 37 } });
  try {
    await ready(app, panel);
    await until(() => panel.colours.get(36) === colourValue(COLOUR.RED));
    panel.press(32);
    await until(() => app.skaarhoj.controller.status().selectedCameraId === 'right');
    const right = fakeHead('fake-right');
    panel.speed(38, 400);   // pinned as pan
    await until(() => near(right.v.pan, scaled(400)));
    assert.equal(right.v.tilt, 0);
    panel.press(36);
    await until(() => right.v.pan === 0);
  } finally { await app.stop(); await panel.close(); }
});

test('mode is switched by an admin through the API, persisted, and applied live', async () => {
  const panel = await startFakePanel();
  const { app, call, configPath, dir } = await panelApp({ panel, mode: 'reactor', mapping: { presetCount: 4 }, logLevel: 'info' });
  try {
    assert.equal(requiredRole('PUT', '/api/skaarhoj'), 'admin');
    assert.equal(requiredRole('GET', '/api/skaarhoj'), 'operator');

    const off = await call('GET', '/api/skaarhoj');
    assert.equal(off.body.mode, 'reactor');
    assert.equal(off.body.connected, false);
    assert.equal(off.body.panel, null);
    await sleep(100);
    assert.equal(panel.connections, 0, 'reactor mode never touches the panel');

    assert.equal((await call('PUT', '/api/skaarhoj', { mode: 'sideways' })).status, 400);
    assert.equal((await call('PUT', '/api/skaarhoj', { mode: 'drive', host: '' })).status, 400);
    assert.equal((await call('PUT', '/api/skaarhoj', { mode: 'drive', host: '127.0.0.1', port: 70000 })).status, 400);
    assert.equal((await call('PUT', '/api/skaarhoj', { mode: 'drive', host: 'bad host!' })).status, 400);

    const on = await call('PUT', '/api/skaarhoj', { mode: 'drive', host: '127.0.0.1', port: panel.port });
    assert.equal(on.status, 200);
    assert.equal(on.body.mode, 'drive');
    const st = await until(async () => {
      const r = (await call('GET', '/api/skaarhoj')).body;
      return r.connected && r.topologySummary ? r : null;
    });
    assert.deepEqual(st.panel, { model: 'SK_FAKEPTZ', serial: 'FAKE0001', version: 'v0.0.0-fake', name: 'Fake PTZ panel', platform: 'simulator' });
    assert.equal(st.selectedCameraId, 'left');
    assert.deepEqual(st.topologySummary.presetButtons, [7, 8, 9, 10], 'the mapping from the file came along');
    assert.equal((await call('GET', '/api/state')).body.skaarhoj.connected, true);

    const file = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(file.skaarhoj.mode, 'drive');
    assert.equal(file.skaarhoj.port, panel.port);
    assert.deepEqual(file.skaarhoj.mapping, { presetCount: 4 });
    assert.equal(file.cameras.length, 2, 'the rest of the config is untouched');

    // Back to Reactor: the panel is cleared and let go.
    const clears = panel.clears;
    const back = await call('PUT', '/api/skaarhoj', { mode: 'reactor' });
    assert.equal(back.body.connected, false);
    await until(() => panel.clients === 0);
    assert.ok(panel.clears > clears, 'displays are cleared for Reactor');
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).skaarhoj.mode, 'reactor');

    await sleep(50);
    const logs = readFileSync(join(dir, 'logs', 'cambridge.log'), 'utf8');
    assert.match(logs, /panel mode reactor -> drive/);
    assert.match(logs, /panel mode drive -> reactor/);
  } finally { await app.stop(); await panel.close(); }
});

// --- many cameras: banks and groups ---------------------------------------------
//
// The default invented topology has 36 display buttons (ids 1-36, six to a
// row), so the default cap is 8 camera buttons: with more cameras than that
// and no bank buttons, buttons 7 and 8 page and buttons 1-6 select, and the
// presets start on the next row (13-20).

const pad = (n) => String(n).padStart(2, '0');
/** `n` simulated PTZ heads: c01 "Cam 01" ..., optionally grouped by `groupOf(i)`. */
function fakeCameras(n, groupOf = null) {
  return Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    return { id: `c${pad(i)}`, kind: 'ptz', vendor: 'fake', label: `Cam ${pad(i)}`, ip: `fake-c${pad(i)}`,
      ...(groupOf ? { group: groupOf(i) } : {}) };
  });
}
const colourOf = (panel, id) => panel.colours.get(id);
const shows = (panel, id, re) => re.test(panel.texts.get(id) ?? '');
const tap = (panel, id) => { panel.press(id, 4); panel.release(id, 4); };
const status = async (call) => (await call('GET', '/api/skaarhoj')).body;

async function readyMany(app, panel, n) {
  await until(() => app.state.list().filter((c) => c.kind === 'ptz' && c.state === 'connected').length === n, { timeoutMs: 8000 });
  await until(() => app.skaarhoj?.client.connected);
  await until(() => /Iris/.test(panel.texts.get(43) ?? ''), { timeoutMs: 5000 });
}

test('camera buttons are capped, presets keep their buttons, and the last two camera buttons page when nothing else does', () => {
  // Few cameras: unchanged, one button each.
  const few = detectRoles(defaultTopology(), { cameraCount: 4 });
  assert.deepEqual(few.cameras, [1, 2, 3, 4]);
  assert.equal(few.bankNext, null);
  assert.equal(few.bankFallback, false);
  // Exactly the cap: still no paging.
  assert.deepEqual(detectRoles(defaultTopology(), { cameraCount: 8 }).cameras, [1, 2, 3, 4, 5, 6, 7, 8]);

  for (const n of [20, 48, 200]) {
    const r = detectRoles(defaultTopology(), { cameraCount: n });
    assert.deepEqual(r.cameras, [1, 2, 3, 4, 5, 6], `${n} cameras`);
    assert.deepEqual([r.bankPrev, r.bankNext, r.bankFallback], [7, 8, true]);
    assert.deepEqual(r.presets, [13, 14, 15, 16, 17, 18, 19, 20], 'presets keep a full set, on the next row');
    assert.equal(r.store, 21);
    assert.equal(r.tracking, 22);
  }

  // The cap is configurable; paging needs at least three buttons to be useful.
  const ten = detectRoles(defaultTopology(), { cameraCount: 48, override: { cameraButtons: 10 } });
  assert.equal(ten.cameras.length, 8);
  assert.deepEqual([ten.bankPrev, ten.bankNext], [9, 10]);
  const small = detectRoles(defaultTopology(), { cameraCount: 3, override: { cameraButtons: 2 } });
  assert.deepEqual([small.cameras.length, small.bankFallback], [1, true]);
});

test('bank and group buttons are found by label, and pinned ones win', () => {
  const t = (labels) => defaultTopology({ labels });
  const lab = detectRoles(t({ 35: 'Bank -', 36: 'Bank +', 34: 'Group' }), { cameraCount: 48 });
  assert.deepEqual([lab.bankPrev, lab.bankNext, lab.group, lab.bankFallback], [35, 36, 34, false]);
  assert.deepEqual(lab.cameras, [1, 2, 3, 4, 5, 6, 7, 8], 'every camera button selects when real bank buttons exist');
  assert.deepEqual(lab.presets, [13, 14, 15, 16, 17, 18, 19, 20]);

  const arrows = detectRoles(t({ 30: '◀', 31: '▶' }), { cameraCount: 20 });
  assert.deepEqual([arrows.bankPrev, arrows.bankNext], [30, 31]);
  const words = detectRoles(t({ 30: 'Prev', 31: 'Next page' }), { cameraCount: 20 });
  assert.deepEqual([words.bankPrev, words.bankNext], [30, 31]);
  const lone = detectRoles(t({ 30: 'Page' }), { cameraCount: 20 });
  assert.deepEqual([lone.bankPrev, lone.bankNext], [null, 30], 'a lone "page" button pages forward');
  const both = detectRoles(t({ 30: '◀▶' }), { cameraCount: 20 });
  assert.deepEqual([both.bankPrev, both.bankNext], [null, 30]);
  assert.equal(detectRoles(t({ 30: 'Next group' }), { cameraCount: 20 }).group, 30, '"next group" is the group button');

  const pinned = detectRoles(t({ 35: 'Bank -', 36: 'Bank +' }), {
    cameraCount: 20, override: { bankNext: 20, bankPrev: 19, groupButton: 18, cameras: [1, 2, 3, 4] },
  });
  assert.deepEqual([pinned.bankPrev, pinned.bankNext, pinned.group], [19, 20, 18]);
  assert.deepEqual(pinned.cameras, [1, 2, 3, 4]);
  assert.ok(pinned.pinned.includes('bankNext'));
  assert.ok(![...pinned.presets, pinned.store, pinned.tracking].some((id) => [18, 19, 20, 35, 36].includes(id)),
    'pinned and labelled bank buttons are not handed out again');

  // Pinned cameras with more cameras than buttons: the last two of them page.
  const pc = detectRoles(defaultTopology(), { cameraCount: 20, override: { cameras: [1, 2, 3, 4, 5] } });
  assert.deepEqual([pc.cameras, pc.bankPrev, pc.bankNext], [[1, 2, 3], 4, 5]);
});

test('20 cameras: banks page, say which bank, keep tally on every bank, and signal a program camera elsewhere', async () => {
  const panel = await startFakePanel();
  const { app, call } = await panelApp({ panel, cameras: fakeCameras(20) });
  try {
    await readyMany(app, panel, 20);
    // Bank 1 of 4 (6 + 6 + 6 + 2): c01-c06 on buttons 1-6.
    await until(() => shows(panel, 6, /Cam 06/) && shows(panel, 8, /Bank 1\/4/));
    assert.match(panel.texts.get(7), /Bank 1\/4/);
    assert.match(panel.texts.get(7), /PREV/);
    assert.match(panel.texts.get(8), /NEXT/);
    let st = await status(call);
    assert.deepEqual(st.bank, { index: 0, count: 4, size: 6, cameras: 20 });
    assert.equal(st.topologySummary.bankButtonsAreCameras, true);

    // A camera on program on bank 2: nothing on bank 1 is red, but the next-bank button is.
    app.state.applyTally({ c10: { program: true, preview: false }, c15: { program: false, preview: true } });
    await until(() => panel.leds.get(8) === LED.ON && colourOf(panel, 8) === colourValue(COLOUR.RED));
    assert.match(panel.texts.get(8), /PGM: Cam 10/);
    assert.notEqual(colourOf(panel, 7), colourValue(COLOUR.RED));
    assert.equal(colourOf(panel, 1), colourValue(COLOUR.AMBER), 'the selected camera is amber');
    assert.equal(colourOf(panel, 2), colourValue(COLOUR.WHITE));

    // Next bank: c07-c12. c10 (button 4) shows its tally though it is not selected.
    tap(panel, 8);
    await until(() => shows(panel, 1, /Cam 07/) && shows(panel, 8, /Bank 2\/4/));
    await until(() => colourOf(panel, 4) === colourValue(COLOUR.RED));
    assert.match(panel.texts.get(4), /PGM/);
    assert.notEqual(colourOf(panel, 8), colourValue(COLOUR.RED), 'the program camera is on this bank now');
    assert.notEqual(colourOf(panel, 7), colourValue(COLOUR.RED));
    // The selected camera is still c01, off this bank: say so on the bank buttons.
    assert.match(panel.texts.get(7), /Sel: Cam 01/);
    assert.equal((await status(call)).selectedCameraId, 'c01', 'a bank change selects nothing');

    // Bank 3: c13-c18. The preview camera c15 is green on button 3; program is behind us.
    tap(panel, 8);
    await until(() => shows(panel, 1, /Cam 13/) && shows(panel, 8, /Bank 3\/4/));
    await until(() => colourOf(panel, 3) === colourValue(COLOUR.GREEN));
    await until(() => panel.leds.get(7) === LED.ON && colourOf(panel, 7) === colourValue(COLOUR.RED));
    assert.match(panel.texts.get(7), /PGM: Cam 10/);

    // Last bank has two cameras; the other buttons go blank. Then it wraps.
    tap(panel, 8);
    await until(() => shows(panel, 2, /Cam 20/) && shows(panel, 8, /Bank 4\/4/));
    await until(() => !/Cam/.test(panel.texts.get(3) ?? 'Cam') && panel.leds.get(3) === LED.OFF);
    tap(panel, 8);
    await until(() => shows(panel, 1, /Cam 01/) && shows(panel, 8, /Bank 1\/4/));
    tap(panel, 7);   // previous from the first wraps to the last
    await until(() => shows(panel, 1, /Cam 19/) && shows(panel, 7, /Bank 4\/4/));
    st = await status(call);
    assert.equal(st.bank.index, 3);
  } finally { await app.stop(); await panel.close(); }
});

test('selecting a camera on another bank stops the previous one; a bank change moves nothing', async () => {
  const panel = await startFakePanel();
  const { app, call } = await panelApp({ panel, cameras: fakeCameras(20) });
  try {
    await readyMany(app, panel, 20);
    const first = fakeHead('fake-c01');
    const far = fakeHead('fake-c14');
    panel.speed(37, 400);
    await until(() => first.v.pan > 0);

    // Paging while the stick is held: c01 keeps moving, and nothing else starts.
    tap(panel, 8);
    tap(panel, 8);
    await until(() => shows(panel, 1, /Cam 13/));
    await sleep(150);
    assert.ok(first.v.pan > 0, 'a bank change does not stop the camera being driven');
    assert.equal(far.v.pan, 0);
    assert.equal((await status(call)).selectedCameraId, 'c01');

    // Pick c14 (button 2 on bank 3): c01 stops first, and the stick has to move again.
    tap(panel, 2);
    await until(() => first.v.pan === 0);
    await sleep(100);
    assert.equal(far.v.pan, 0);
    assert.equal((await status(call)).selectedCameraId, 'c14');
    await until(() => panel.leds.get(2) === LED.ON);
    panel.speed(37, 300);
    await until(() => far.v.pan > 0);
    assert.equal(first.v.pan, 0);

    // Presets act on the camera that is selected, not the one on the bank.
    panel.speed(37, 0);
    await until(() => far.v.pan === 0);
    assert.equal((await call('POST', '/api/cameras/c14/ptz/presets/1/store', {})).status, 200);
    const stored = far.pan;
    far.pan = 0.9;
    tap(panel, 7);
    await until(() => shows(panel, 1, /Cam 07/));
    panel.press(13);
    await until(() => near(far.pan, stored, 1e-3));
  } finally { await app.stop(); await panel.close(); }
});

test('48 cameras with labelled bank buttons and a pinned cap', async () => {
  const panel = await startFakePanel({ topology: defaultTopology({ labels: { 35: 'Bank -', 36: 'Bank +' } }) });
  const { app, call } = await panelApp({ panel, cameras: fakeCameras(48), mapping: { cameraButtons: 10 } });
  try {
    await readyMany(app, panel, 48);
    await until(() => shows(panel, 10, /Cam 10/) && shows(panel, 36, /Bank 1\/5/));
    assert.match(panel.texts.get(35), /Bank 1\/5/);
    const st = await status(call);
    assert.deepEqual(st.topologySummary.cameraButtons, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(st.topologySummary.bankButtonsAreCameras, false);
    assert.equal(st.bank.count, 5);
    for (let i = 0; i < 4; i += 1) tap(panel, 36);
    await until(() => shows(panel, 1, /Cam 41/) && shows(panel, 36, /Bank 5\/5/));
    await until(() => shows(panel, 8, /Cam 48/) && !shows(panel, 9, /Cam/));
    tap(panel, 35);
    await until(() => shows(panel, 1, /Cam 31/) && shows(panel, 35, /Bank 4\/5/));
    // A program camera on bank 5 lights the next button, not the previous.
    app.state.applyTally({ c45: { program: true, preview: false } });
    await until(() => colourOf(panel, 36) === colourValue(COLOUR.RED));
    assert.notEqual(colourOf(panel, 35), colourValue(COLOUR.RED));
  } finally { await app.stop(); await panel.close(); }
});

test('48 cameras with no bank buttons: the last two camera buttons page, all eight banks reachable', async () => {
  const panel = await startFakePanel();
  const { app, call } = await panelApp({ panel, cameras: fakeCameras(48) });
  try {
    await readyMany(app, panel, 48);
    await until(() => shows(panel, 8, /Bank 1\/8/));
    for (let i = 0; i < 7; i += 1) tap(panel, 8);
    await until(() => shows(panel, 1, /Cam 43/) && shows(panel, 6, /Cam 48/) && shows(panel, 8, /Bank 8\/8/));
    tap(panel, 3);
    await until(() => panel.leds.get(3) === LED.ON);
    assert.equal((await status(call)).selectedCameraId, 'c45');
  } finally { await app.stop(); await panel.close(); }
});

test('pinned bank buttons in the mapping are obeyed', async () => {
  const panel = await startFakePanel();
  const { app, call } = await panelApp({
    panel, cameras: fakeCameras(20), mapping: { cameras: [1, 2, 3, 4], bankNext: 6, bankPrev: 5 },
  });
  try {
    await readyMany(app, panel, 20);
    await until(() => shows(panel, 6, /Bank 1\/5/));
    tap(panel, 6);
    await until(() => shows(panel, 1, /Cam 05/) && shows(panel, 5, /Bank 2\/5/));
    tap(panel, 5);
    tap(panel, 5);
    await until(() => shows(panel, 1, /Cam 17/));
    const st = await status(call);
    assert.deepEqual([st.topologySummary.bankPrev, st.topologySummary.bankNext], [5, 6]);
    assert.ok(st.topologySummary.pinned.includes('bankNext'));
  } finally { await app.stop(); await panel.close(); }
});

test('groups: the group button cycles them, banks restart, and the selected camera is not moved', async () => {
  const panel = await startFakePanel({ topology: defaultTopology({ labels: { 34: 'Group' } }) });
  const cameras = fakeCameras(14, (i) => (i <= 10 ? 'Studio' : 'Stage'));
  const { app, call } = await panelApp({ panel, cameras });
  try {
    await readyMany(app, panel, 14);
    await until(() => shows(panel, 34, /All/) && shows(panel, 8, /Bank 1\/3/));
    const st = await status(call);
    assert.equal(st.topologySummary.group, 34);
    assert.equal(st.group, null);

    tap(panel, 8);   // bank 2 of "all"
    await until(() => shows(panel, 1, /Cam 07/));
    // Group 1: Studio, ten cameras, two banks.
    tap(panel, 34);
    await until(() => shows(panel, 34, /Studio/) && shows(panel, 1, /Cam 01/) && shows(panel, 8, /Bank 1\/2/));
    assert.equal((await status(call)).group, 'Studio');
    // Group 2: Stage, four cameras, one bank: the borrowed bank buttons go quiet.
    tap(panel, 34);
    await until(() => shows(panel, 34, /Stage/) && shows(panel, 1, /Cam 11/) && shows(panel, 4, /Cam 14/));
    await until(() => !/Bank/.test(panel.texts.get(8) ?? '') && panel.leds.get(8) === LED.OFF);
    // The selected camera (c01, in Studio) is still selected; the group button says so.
    assert.match(panel.texts.get(34), /Sel: Cam 01/);
    assert.equal((await status(call)).selectedCameraId, 'c01');
    // A camera on program in another group lights the group button red.
    app.state.applyTally({ c03: { program: true, preview: false } });
    await until(() => colourOf(panel, 34) === colourValue(COLOUR.RED));
    // Selecting in the group works; then back to all.
    tap(panel, 2);
    await until(() => panel.leds.get(2) === LED.ON);
    assert.equal((await status(call)).selectedCameraId, 'c12');
    tap(panel, 34);
    await until(() => shows(panel, 34, /All/) && shows(panel, 1, /Cam 01/));
    assert.equal((await status(call)).group, null);
  } finally { await app.stop(); await panel.close(); }
});

test('mapping.group restricts the panel to one group, case-insensitively, with no paging when it fits', async () => {
  const panel = await startFakePanel();
  const cameras = fakeCameras(30, (i) => (i <= 24 ? 'Studio' : 'Stage'));
  const { app, call } = await panelApp({ panel, cameras, mapping: { group: 'stage' } });
  try {
    await until(() => app.state.list().filter((c) => c.state === 'connected').length === 30, { timeoutMs: 8000 });
    await until(() => app.skaarhoj?.client.connected);
    await until(() => shows(panel, 1, /Cam 25/) && shows(panel, 6, /Cam 30/));
    const st = await status(call);
    assert.deepEqual(st.topologySummary.cameraButtons, [1, 2, 3, 4, 5, 6]);
    assert.equal(st.topologySummary.bankNext, null);
    assert.equal(st.selectedCameraId, 'c25', 'the first camera of the group, not of the venue');
    // A stick move drives that camera; button 6 selects c30 and stops it first.
    const head = fakeHead('fake-c25');
    panel.speed(37, 300);
    await until(() => head.v.pan > 0);
    tap(panel, 6);
    await until(() => head.v.pan === 0);
    assert.equal((await status(call)).selectedCameraId, 'c30');
    assert.equal(fakeHead('fake-c01').v.pan, 0);
  } finally { await app.stop(); await panel.close(); }
});
