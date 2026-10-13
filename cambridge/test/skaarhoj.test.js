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

async function panelApp({ panel, mode = 'drive', mapping = {}, logLevel = 'error' } = {}) {
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
    cameras: [
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
