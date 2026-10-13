// PTZ support, against state frames shaped like the ones CamBridge pushes.
//
// Press-and-hold is the part worth the most care: the server stops an axis that
// is not refreshed within ~500 ms, so a key that stays down must keep sending
// and a key that comes up (or a connection that goes away) must stop sending.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { CambridgeInstance } from '../src/index.js';
import { PtzHolds, usableEntries, HOLD_REFRESH_MS, HOLD_MAX_MS } from '../src/ptz.js';
import { buildVariableValues, buildVariableDefinitions } from '../src/variables.js';

if (typeof process.send !== 'function') process.send = () => true;

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeInstance() {
  const captured = {
    actions: {}, feedbacks: {}, presets: {}, variableDefs: [], variables: {}, logs: [],
  };
  const inst = new CambridgeInstance({ id: 'test', _isInstanceBaseProps: true, label: 'cambridge' });
  inst.setActionDefinitions = (a) => { captured.actions = a; };
  inst.setFeedbackDefinitions = (f) => { captured.feedbacks = f; };
  inst.setPresetDefinitions = (p) => { captured.presets = p; };
  inst.setVariableDefinitions = (v) => { captured.variableDefs = v; };
  inst.setVariableValues = (v) => { Object.assign(captured.variables, v); };
  inst.updateStatus = () => {};
  inst.log = (level, msg) => { captured.logs.push(`${level}: ${msg}`); };
  inst.checkFeedbacks = () => {};
  inst.parseVariablesInString = async (s) => s;
  return { inst, captured };
}

/** A request recorder standing in for CambridgeApi.request. */
function recorder(answers = {}) {
  const sent = [];
  return {
    sent,
    request: async (method, path, body) => {
      sent.push({ method, path, body });
      const hit = answers[`${method} ${path}`];
      return hit ?? { ok: true, status: 200, body: {} };
    },
  };
}

const TABLE = [
  { id: 'wbMode', group: 'whiteBalance', label: 'White balance', type: 'enum', danger: 'none', available: true,
    options: [{ value: 'auto', label: 'Auto' }, { value: 'indoor', label: 'Indoor' }] },
  { id: 'panTiltSpeedLimit', group: 'ptz', label: 'Speed limit', type: 'range', danger: 'none', available: true,
    range: { min: 1, max: 100, step: 1 } },
  { id: 'trackingEnabled', group: 'tracking', label: 'Auto tracking', type: 'bool', danger: 'none',
    operate: true, available: true },
  { id: 'tallyLabel', group: 'tally', label: 'Tally label', type: 'text', danger: 'none', available: true },
  { id: 'ipAddress', group: 'network', label: 'IP address', type: 'text', danger: 'reconnect', available: true },
  { id: 'adminPassword', group: 'users', label: 'Admin password', type: 'text', danger: 'admin', available: true },
  { id: 'gammaMode', group: 'image', label: 'Gamma', type: 'enum', danger: 'none', available: false,
    options: [{ value: 'a', label: 'A' }] },
  { id: 'home', group: 'ptz', label: 'Go home', type: 'action', danger: 'none', available: true },
  { id: 'reboot', group: 'maintenance', label: 'Reboot', type: 'action', danger: 'admin', available: true },
];

function ptzCamera(id, label, { tracking = false, ptz = {}, state = 'connected' } = {}) {
  return {
    id, kind: 'ptz', vendor: 'panasonic', label, model: 'AW-UE160', state,
    tally: null, recordStartedAt: null,
    status: { battery: -1, media: '', recording: false, recordingFailed: false },
    ptz: { pan: 0.5, tilt: 0.25, zoom: 0.8, focus: 0.5, moving: false, tracking: false, preset: null, ...ptz },
    capabilities: {
      panTilt: true, zoom: true, focus: true, presets: 100, presetBase: 1, tally: true, pointToCentre: true,
      tracking: tracking ? { kind: 'autoTracking', label: 'Auto tracking' } : null,
    },
    properties: { wbMode: { raw: 'auto', label: 'Auto', writable: true } },
  };
}

function sonyCamera() {
  return {
    id: 'fx3', kind: 'cine', vendor: 'sony', label: 'Wide', model: 'ILME-FX3', state: 'connected',
    status: { battery: 87, media: 'SLOT1', recording: false, recordingFailed: false },
    properties: {
      fNumber: {
        raw: 400, label: 'f/4.0', writable: true,
        options: [280, 400].map((r) => ({ raw: r, label: `f/${r / 100}` })),
      },
    },
  };
}

function ptzOnlyFrame(overrides = {}) {
  return {
    view: {
      camdConnected: false, camdUsed: false, backend: 'ptz',
      cameras: [ptzCamera('left', 'Left'), ptzCamera('right', 'Right', { tracking: true })],
      ...overrides,
    },
  };
}

function mixedFrame() {
  return {
    view: {
      camdConnected: true, camdUsed: true,
      cameras: [sonyCamera(), ptzCamera('right', 'Right', { tracking: true })],
    },
  };
}

// --- definitions ------------------------------------------------------------

test('PTZ cameras appear in PTZ dropdowns and not in Sony-only ones', () => {
  const { inst, captured } = makeInstance();
  inst.api = recorder();
  inst.applyState(mixedFrame());
  const ids = (def) => def.options.find((o) => o.id === 'camera').choices.map((c) => c.id);

  assert.deepEqual(ids(captured.actions.ptzPanTilt), ['right']);
  assert.deepEqual(ids(captured.actions.record).sort(), ['__all__', 'fx3']);
  assert.deepEqual(ids(captured.actions.propStep), ['fx3']);
  assert.deepEqual(ids(captured.actions.propSet), ['fx3']);
  assert.deepEqual(ids(captured.actions.presetRecall), ['fx3']);
  // Things that mean something on either kind keep listing both.
  assert.deepEqual(ids(captured.actions.undo).sort(), ['fx3', 'right']);
  assert.deepEqual(ids(captured.feedbacks.recording), ['fx3']);
  assert.deepEqual(ids(captured.feedbacks.ptzTracking), ['right']);
  assert.deepEqual(ids(captured.feedbacks.tally).sort(), ['fx3', 'right']);
  assert.deepEqual(ids(captured.feedbacks.cameraState).sort(), ['fx3', 'right']);
});

test('a Sony-only venue defines no PTZ actions, feedbacks or buttons', () => {
  const { inst, captured } = makeInstance();
  inst.applyState({ view: { camdConnected: true, cameras: [sonyCamera()] } });
  assert.ok(!Object.keys(captured.actions).some((k) => k.startsWith('ptz')));
  assert.ok(!Object.keys(captured.feedbacks).some((k) => k.startsWith('ptz')));
  assert.ok(!Object.keys(captured.presets).some((k) => k.startsWith('ptz_')));
  assert.ok(captured.presets.record_fx3);
  assert.ok(!captured.variableDefs.some((d) => d.variableId.endsWith('_pan')));
});

test('PTZ cameras do not get record, exposure or autofocus buttons', () => {
  const { inst, captured } = makeInstance();
  inst.applyState(ptzOnlyFrame());
  const keys = Object.keys(captured.presets);
  assert.ok(!keys.some((k) => /^(record|iris_open|iris_close|iso_up|iso_down|af|status)_(left|right)$/.test(k)));
  assert.ok(keys.includes('tally_left'));
});

test('each PTZ camera gets a category with pad, zoom, focus, presets 1-8, STOP ALL and tracking where supported', () => {
  const { inst, captured } = makeInstance();
  inst.applyState(ptzOnlyFrame());
  const left = Object.entries(captured.presets).filter(([k]) => k.startsWith('ptz_') && k.endsWith('_left'));
  assert.deepEqual([...new Set(left.map(([, p]) => p.category))], ['Left — PTZ']);
  for (const d of ['up-left', 'up', 'up-right', 'left', 'right', 'down-left', 'down', 'down-right']) {
    assert.ok(captured.presets[`ptz_${d}_left`], d);
  }
  for (const k of ['zoom_in', 'zoom_out', 'focus_near', 'focus_far', 'stop_all']) {
    assert.ok(captured.presets[`ptz_${k}_left`], k);
  }
  for (let n = 1; n <= 8; n += 1) assert.ok(captured.presets[`ptz_preset_${n}_left`], `preset ${n}`);
  assert.ok(!captured.presets.ptz_preset_9_left);
  // Tracking only where the camera has it.
  assert.ok(!captured.presets.ptz_tracking_left);
  assert.ok(captured.presets.ptz_tracking_right);

  // Hold buttons carry a down action and a matching release.
  const pad = captured.presets.ptz_up_left;
  assert.equal(pad.steps[0].down[0].actionId, 'ptzPanTilt');
  assert.equal(pad.steps[0].up[0].actionId, 'ptzRelease');
  assert.equal(pad.steps[0].up[0].options.camera, 'left');
});

test('every action and feedback a PTZ button references exists, and every variable is defined', () => {
  const { inst, captured } = makeInstance();
  inst.applyState(ptzOnlyFrame());
  const defined = new Set(captured.variableDefs.map((d) => d.variableId));
  for (const [key, p] of Object.entries(captured.presets)) {
    for (const step of p.steps) {
      for (const a of [...step.down, ...step.up]) assert.ok(captured.actions[a.actionId], `${key}: ${a.actionId}`);
    }
    for (const f of p.feedbacks) assert.ok(captured.feedbacks[f.feedbackId], `${key}: ${f.feedbackId}`);
    for (const m of String(p.style.text).matchAll(/\$\(cambridge:([a-z0-9_]+)\)/g)) {
      assert.ok(defined.has(m[1]), `${key} references undefined ${m[1]}`);
    }
  }
});

test('definitions rebuild when capabilities change, not on a position update', () => {
  const { inst } = makeInstance();
  let rebuilds = 0;
  const real = inst.rebuildDefinitions.bind(inst);
  inst.rebuildDefinitions = () => { rebuilds += 1; real(); };

  inst.applyState(ptzOnlyFrame());
  assert.equal(rebuilds, 1);

  const moved = ptzOnlyFrame();
  moved.view.cameras[0].ptz = { ...moved.view.cameras[0].ptz, pan: 0.9, moving: true, preset: 3 };
  inst.applyState(moved);
  assert.equal(rebuilds, 1);

  const gainedTracking = ptzOnlyFrame();
  gainedTracking.view.cameras[0].capabilities.tracking = { kind: 'autoTracking', label: 'Auto tracking' };
  inst.applyState(gainedTracking);
  assert.equal(rebuilds, 2);
});

// --- schema ------------------------------------------------------------------

test('schemas are fetched when the PTZ set changes and drive the "set any setting" choices', async () => {
  const { inst, captured } = makeInstance();
  const api = recorder({
    'GET /api/cameras/left/schema': { ok: true, status: 200, body: { entries: TABLE } },
    'GET /api/cameras/right/schema': { ok: true, status: 200, body: { entries: TABLE } },
    'GET /api/cameras/right/ptz/presets': {
      ok: true, status: 200, body: { base: 1, count: 100, presets: [{ n: 4, name: 'Lectern', thumb: true }] },
    },
  });
  inst.api = api;
  inst.applyState(ptzOnlyFrame());
  await flush(); await flush();

  const fetched = api.sent.filter((s) => s.path.endsWith('/schema')).map((s) => s.path).sort();
  assert.deepEqual(fetched, ['/api/cameras/left/schema', '/api/cameras/right/schema']);

  const setting = captured.actions.ptzSetting;
  const choices = setting.options.find((o) => o.id === 'setting_left').choices.map((c) => c.id);
  // Ordinary writable settings only: not danger, not unavailable, not actions.
  assert.deepEqual(choices, ['wbMode', 'panTiltSpeedLimit', 'trackingEnabled', 'tallyLabel']);
  assert.deepEqual(usableEntries(TABLE).map((e) => e.id), choices);

  // Values come from the entry: enum options, a bounded number, on/off.
  const wb = setting.options.find((o) => o.id === 'v_left_wbMode');
  assert.deepEqual(wb.choices.map((c) => c.label), ['Auto', 'Indoor']);
  assert.equal(setting.options.find((o) => o.id === 'v_left_panTiltSpeedLimit').max, 100);
  assert.equal(setting.options.find((o) => o.id === 'v_left_trackingEnabled').type, 'dropdown');
  // The value field only shows for its own camera + setting.
  assert.match(wb.isVisibleExpression, /"left"/);
  assert.match(wb.isVisibleExpression, /setting_left/);

  // Functions list only the harmless ones.
  const fn = captured.actions.ptzFunction.options.find((o) => o.id === 'fn_left');
  assert.deepEqual(fn.choices.map((c) => c.id), ['home']);

  // Saved preset names feed the by-name dropdown.
  const byName = captured.actions.ptzPresetRecall.options.find((o) => o.id === 'byName');
  assert.ok(byName.choices.some((c) => c.id === '4' && c.label.includes('Lectern')));
});

test('a camera that was still connecting gets its schema once it connects', async () => {
  const { inst } = makeInstance();
  const api = recorder({ 'GET /api/cameras/left/schema': { ok: false, status: 503, body: {} } });
  inst.api = api;
  const frame = ptzOnlyFrame();
  frame.view.cameras[0].state = 'connecting';
  inst.applyState(frame);
  await flush(); await flush();
  const count = () => api.sent.filter((s) => s.path === '/api/cameras/left/schema').length;
  assert.equal(count(), 0, 'not asked while it cannot answer');

  api.request = async (method, path, body) => {
    api.sent.push({ method, path, body });
    if (path === '/api/cameras/left/schema') return { ok: true, status: 200, body: { entries: TABLE } };
    return { ok: true, status: 200, body: {} };
  };
  inst.applyState(ptzOnlyFrame());
  await flush(); await flush();
  assert.equal(count(), 1);
  assert.ok(inst.ptzSchemas.left);

  // Already have it: further frames do not ask again.
  inst.applyState(ptzOnlyFrame());
  await flush();
  assert.equal(count(), 1);
});

// --- actions -------------------------------------------------------------------

test('set-any-setting writes the right value for each type', async () => {
  const { inst, captured } = makeInstance();
  const api = recorder({
    'GET /api/cameras/left/schema': { ok: true, status: 200, body: { entries: TABLE } },
  });
  inst.api = api;
  inst.applyState(ptzOnlyFrame());
  await flush(); await flush();
  api.sent.length = 0;

  const run = (options) => captured.actions.ptzSetting.callback({ options: { camera: 'left', ...options } });
  await run({ setting_left: 'wbMode', v_left_wbMode: 'indoor' });
  await run({ setting_left: 'panTiltSpeedLimit', v_left_panTiltSpeedLimit: '40' });
  await run({ setting_left: 'trackingEnabled', v_left_trackingEnabled: 'false' });
  // Never reaches the server: not an ordinary setting.
  await run({ setting_left: 'ipAddress', v_left_ipAddress: '10.0.0.9' });

  assert.deepEqual(api.sent.map((s) => [s.method, s.path, s.body]), [
    ['PUT', '/api/cameras/left/properties/wbMode', { value: 'indoor' }],
    ['PUT', '/api/cameras/left/properties/panTiltSpeedLimit', { value: 40 }],
    ['PUT', '/api/cameras/left/properties/trackingEnabled', { value: false }],
  ]);
});

test('preset recall and store use the number, a saved name wins, and store carries the name', async () => {
  const { inst, captured } = makeInstance();
  const api = recorder();
  inst.api = api;
  inst.applyState(ptzOnlyFrame());
  await flush();
  api.sent.length = 0;

  await captured.actions.ptzPresetRecall.callback({ options: { camera: 'left', preset: 3, byName: '' } });
  await captured.actions.ptzPresetRecall.callback({ options: { camera: 'left', preset: 3, byName: '7' } });
  await captured.actions.ptzPresetStore.callback({
    options: { camera: 'left', preset: 2, byName: '', name: ' Pulpit ' },
  });
  const posts = api.sent.filter((s) => s.method === 'POST');
  assert.deepEqual(posts.map((s) => [s.path, s.body]), [
    ['/api/cameras/left/ptz/presets/3/recall', {}],
    ['/api/cameras/left/ptz/presets/7/recall', {}],
    ['/api/cameras/left/ptz/presets/2/store', { name: 'Pulpit' }],
  ]);
});

test('home, one-push AF and tracking are found by role, whatever the vendor calls them', async () => {
  const table = [
    { id: 'goHome', group: 'ptz', label: 'Home', type: 'action', role: 'home', danger: 'none', available: true },
    { id: 'pushAf', group: 'lens', label: 'AF', type: 'action', role: 'onePushAf', danger: 'none', available: true },
    { id: 'autoTrack', group: 'tracking', label: 'Tracking', type: 'enum', role: 'trackingEnabled',
      onValue: 'run', offValue: 'stop', danger: 'none', available: true,
      options: [{ value: 'run', label: 'Run' }, { value: 'stop', label: 'Stop' }] },
  ];
  const { inst, captured } = makeInstance();
  const api = recorder({ 'GET /api/cameras/right/schema': { ok: true, status: 200, body: { entries: table } } });
  inst.api = api;
  inst.applyState(ptzOnlyFrame());
  await flush(); await flush();
  api.sent.length = 0;

  await captured.actions.ptzHome.callback({ options: { camera: 'right' } });
  await captured.actions.ptzOnePushAf.callback({ options: { camera: 'right' } });
  // Left has no schema roles: nothing is sent, nothing throws.
  await captured.actions.ptzHome.callback({ options: { camera: 'left' } });
  await captured.actions.ptzTracking.callback({ options: { camera: 'right', mode: 'on' } });
  await captured.actions.ptzTracking.callback({ options: { camera: 'right', mode: 'off' } });
  assert.deepEqual(api.sent.map((s) => [s.method, s.path, s.body]), [
    ['POST', '/api/cameras/right/actions/goHome', undefined],
    ['POST', '/api/cameras/right/actions/pushAf', undefined],
    ['PUT', '/api/cameras/right/properties/autoTrack', { value: 'run' }],
    ['PUT', '/api/cameras/right/properties/autoTrack', { value: 'stop' }],
  ]);
  assert.ok(captured.presets.ptz_home_right && captured.presets.ptz_af_right);
  assert.ok(!captured.presets.ptz_home_left);
});

test('tracking toggles from the pushed state and can be forced on or off', async () => {
  const { inst, captured } = makeInstance();
  const api = recorder({
    'GET /api/cameras/right/schema': { ok: true, status: 200, body: { entries: TABLE } },
  });
  inst.api = api;
  inst.applyState(ptzOnlyFrame());
  await flush(); await flush();
  api.sent.length = 0;

  const act = captured.actions.ptzTracking;
  assert.deepEqual(act.options[0].choices.map((c) => c.id), ['right']);
  await act.callback({ options: { camera: 'right', mode: 'toggle' } });
  const frame = ptzOnlyFrame();
  frame.view.cameras[1].ptz.tracking = true;
  inst.applyState(frame);
  await act.callback({ options: { camera: 'right', mode: 'toggle' } });
  await act.callback({ options: { camera: 'right', mode: 'on' } });
  const puts = api.sent.filter((s) => s.method === 'PUT');
  assert.deepEqual(puts.map((s) => s.body.value), [true, false, true]);
  assert.equal(puts[0].path, '/api/cameras/right/properties/trackingEnabled');
});

test('STOP ALL clears local holds then calls the server-wide stop', async () => {
  const { inst, captured } = makeInstance();
  const api = recorder();
  inst.api = api;
  inst.applyState(ptzOnlyFrame());
  await flush();
  inst.ptzHolds.start('k|ptzPanTilt', 'left', { pan: 0.5 });
  await captured.actions.ptzStopAll.callback({ options: {} });
  assert.equal(inst.ptzHolds.active, false);
  assert.ok(api.sent.some((s) => s.method === 'POST' && s.path === '/api/ptz/stop-all'));
});

// --- feedbacks and variables ------------------------------------------------------

test('feedbacks follow the pushed PTZ state', () => {
  const { inst, captured } = makeInstance();
  const frame = ptzOnlyFrame();
  frame.view.cameras[1].ptz = { ...frame.view.cameras[1].ptz, tracking: true, moving: true, preset: 5 };
  inst.applyState(frame);
  const fb = (id, options) => captured.feedbacks[id].callback({ options });
  assert.equal(fb('ptzTracking', { camera: 'right' }), true);
  assert.equal(fb('ptzTracking', { camera: 'left' }), false);
  assert.equal(fb('ptzMoving', { camera: 'right' }), true);
  assert.equal(fb('ptzPresetCurrent', { camera: 'right', preset: 5 }), true);
  assert.equal(fb('ptzPresetCurrent', { camera: 'right', preset: 4 }), false);
  assert.equal(fb('ptzPresetCurrent', { camera: 'left', preset: 1 }), false);
  assert.equal(fb('ptzMoving', { camera: 'gone' }), false);
  // Existing feedbacks still work on a PTZ head.
  assert.equal(fb('cameraState', { camera: 'left', state: 'connected' }), true);
  const t = ptzOnlyFrame();
  t.view.cameras[0].tally = { program: true, preview: false };
  inst.applyState(t);
  assert.equal(fb('tally', { camera: 'left', bus: 'program' }), true);
});

test('PTZ variables: position as 0-100, preset, tracking, moving', () => {
  const { inst, captured } = makeInstance();
  const frame = ptzOnlyFrame();
  frame.view.cameras[1].ptz = { pan: 0.123, tilt: 1, zoom: 0, focus: 0.5, moving: true, tracking: true, preset: 12 };
  inst.applyState(frame);
  const v = captured.variables;
  assert.equal(v.right_pan, 12);
  assert.equal(v.right_tilt, 100);
  assert.equal(v.right_zoom, 0);
  assert.equal(v.right_preset, 12);
  assert.equal(v.right_tracking, 'On');
  assert.equal(v.right_moving, 'yes');
  assert.equal(v.left_tracking, 'n/a');
  assert.equal(v.left_preset, '');
  assert.equal(v.left_moving, 'no');
  const defined = captured.variableDefs.map((d) => d.variableId);
  for (const s of ['pan', 'tilt', 'zoom', 'preset', 'tracking', 'moving']) assert.ok(defined.includes(`left_${s}`));
  assert.ok(!defined.includes('left_iris'));
});

test('a position the head has not reported yet reads as empty, not 0', () => {
  const cams = [ptzCamera('left', 'Left', { ptz: { pan: null, tilt: null, zoom: null } })];
  const values = buildVariableValues(cams, {});
  assert.equal(values.left_pan, '');
  assert.equal(values.left_zoom, '');
  assert.ok(buildVariableDefinitions(cams).length > 0);
});

test('with no camd in use, the daemon reads "not used" and never alarms', () => {
  const { inst, captured } = makeInstance();
  inst.applyState(ptzOnlyFrame());
  assert.equal(captured.variables.daemon, 'not used');
  assert.equal(captured.feedbacks.camdDown.callback({ options: {} }), false);

  // With camd in use and unreachable it still says so.
  inst.applyState({ view: { camdConnected: false, camdUsed: true, cameras: [sonyCamera()] } });
  assert.equal(captured.variables.daemon, 'UNREACHABLE');
  assert.equal(captured.feedbacks.camdDown.callback({ options: {} }), true);

  // A server that does not send the flag at all is an older one, with camd.
  inst.applyState({ view: { camdConnected: false, cameras: [sonyCamera()] } });
  assert.equal(captured.variables.daemon, 'UNREACHABLE');
});

// --- press and hold ---------------------------------------------------------------

function holdHarness(opts = {}) {
  const calls = [];
  const holds = new PtzHolds({
    move: async (id, axes) => { calls.push(['move', id, { ...axes }]); },
    stop: async (id) => { calls.push(['stop', id]); },
    log: () => {},
    ...opts,
  });
  return { holds, calls };
}

test('a held key sends at once, refreshes while down, and stops on release', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  try {
    const { holds, calls } = holdHarness();
    holds.start('c1|ptzPanTilt', 'left', { pan: 0.5, tilt: 0 });
    await flush();
    assert.deepEqual(calls, [['move', 'left', { pan: 0.5, tilt: 0 }]]);

    mock.timers.tick(HOLD_REFRESH_MS * 3);
    await flush();
    assert.equal(calls.filter((c) => c[0] === 'move').length, 4);
    assert.ok(HOLD_REFRESH_MS < 500, 'must refresh inside the server deadman');

    await holds.release('c1|', 'left');
    assert.deepEqual(calls.at(-1), ['stop', 'left']);
    const after = calls.length;
    mock.timers.tick(HOLD_REFRESH_MS * 5);
    await flush();
    assert.equal(calls.length, after, 'no refreshes after release');
    assert.equal(holds.active, false);
  } finally {
    mock.timers.reset();
  }
});

test('two keys held on one camera share a request; releasing one zeroes only its axes', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  try {
    const { holds, calls } = holdHarness();
    holds.start('pan|ptzPanTilt', 'left', { pan: 1, tilt: 0 });
    holds.start('zoom|ptzZoom', 'left', { zoom: -0.5 });
    await flush();
    mock.timers.tick(HOLD_REFRESH_MS);
    await flush();
    assert.deepEqual(calls.at(-1), ['move', 'left', { pan: 1, tilt: 0, zoom: -0.5 }]);

    await holds.release('zoom|', 'left');
    assert.deepEqual(calls.at(-1), ['move', 'left', { zoom: 0 }]);
    mock.timers.tick(HOLD_REFRESH_MS);
    await flush();
    assert.deepEqual(calls.at(-1), ['move', 'left', { pan: 1, tilt: 0 }]);
    assert.ok(!calls.some((c) => c[0] === 'stop'), 'head not stopped while the pan key is down');

    await holds.release('pan|', 'left');
    assert.deepEqual(calls.at(-1), ['stop', 'left']);
  } finally {
    mock.timers.reset();
  }
});

test('different cameras hold independently', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  try {
    const { holds, calls } = holdHarness();
    holds.start('a|ptzPanTilt', 'left', { pan: 1 });
    holds.start('b|ptzPanTilt', 'right', { pan: -1 });
    await flush();
    await holds.release('a|', 'left');
    mock.timers.tick(HOLD_REFRESH_MS);
    await flush();
    assert.deepEqual(calls.filter((c) => c[0] === 'stop'), [['stop', 'left']]);
    assert.deepEqual(calls.at(-1), ['move', 'right', { pan: -1 }]);
    await holds.clearAll();
  } finally {
    mock.timers.reset();
  }
});

test('releasing something that is not held does nothing', async () => {
  const { holds, calls } = holdHarness();
  await holds.release('nope|', 'left');
  assert.deepEqual(calls, []);
});

test('a key that never reports release is stopped after the safety ceiling', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  try {
    const logs = [];
    const { holds, calls } = holdHarness({ log: (l, m) => logs.push(m) });
    holds.start('c|ptzZoom', 'left', { zoom: 1 });
    await flush();
    mock.timers.tick(HOLD_MAX_MS + HOLD_REFRESH_MS * 2);
    await flush();
    assert.deepEqual(calls.at(-1), ['stop', 'left']);
    assert.equal(holds.active, false);
    assert.ok(logs.some((m) => /never reported release/.test(m)));
  } finally {
    mock.timers.reset();
  }
});

test('a stop is queued behind a move in flight so a late move cannot restart the head', async () => {
  const order = [];
  let finishMove;
  const holds = new PtzHolds({
    move: () => new Promise((resolve) => { finishMove = () => { order.push('move done'); resolve(); }; }),
    stop: async () => { order.push('stop'); },
    log: () => {},
    refreshMs: 10_000,
  });
  holds.start('c|ptzPanTilt', 'left', { pan: 1 });
  const released = holds.release('c|', 'left');
  await flush();
  assert.deepEqual(order, []);
  finishMove();
  await released;
  assert.deepEqual(order, ['move done', 'stop']);
});

test('the pad actions drive the hold timer, and release stops it, per control', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  try {
    const { inst, captured } = makeInstance();
    const api = recorder();
    inst.api = api;
    inst.applyState(ptzOnlyFrame());
    await flush();
    api.sent.length = 0;

    const press = (actionId, options, controlId = 'ctl-1') =>
      captured.actions[actionId].callback({ controlId, options: { camera: 'left', speed: 50, ...options } });
    press('ptzPanTilt', { direction: 'up-left' });
    await flush();
    assert.deepEqual(api.sent.at(-1), {
      method: 'POST', path: '/api/cameras/left/ptz/move', body: { pan: -0.5, tilt: 0.5 },
    });
    mock.timers.tick(HOLD_REFRESH_MS * 2);
    await flush();
    assert.equal(api.sent.filter((s) => s.path.endsWith('/ptz/move')).length, 3);

    await captured.actions.ptzRelease.callback({ controlId: 'ctl-1', options: { camera: 'left' } });
    assert.deepEqual(api.sent.at(-1), { method: 'POST', path: '/api/cameras/left/ptz/stop', body: undefined });

    // Zoom out and focus near are negative; speed scales the magnitude.
    press('ptzZoom', { direction: 'out', speed: 100 }, 'ctl-2');
    press('ptzFocus', { direction: 'near', speed: 20 }, 'ctl-3');
    await flush();
    const last = api.sent.filter((s) => s.path.endsWith('/ptz/move')).at(-1);
    assert.deepEqual(last.body, { zoom: -1, focus: -0.2 });
    await inst.ptzHolds.clearAll();
  } finally {
    mock.timers.reset();
  }
});

test('a dropped connection clears held timers without a request to a dead server', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  const { inst } = makeInstance();
  try {
    await inst.init({ host: '127.0.0.1', port: 1 });
    const sent = [];
    inst.ptzHolds.moveFn = async (id, axes) => { sent.push(['move', id, axes]); };
    inst.ptzHolds.stopFn = async (id) => { sent.push(['stop', id]); };
    inst.ptzHolds.start('c|ptzPanTilt', 'left', { pan: 1 });
    await flush();
    assert.equal(inst.ptzHolds.active, true);
    inst.api.onConnection(false, 'event stream ended');
    assert.equal(inst.ptzHolds.active, false);
    await flush();
    assert.deepEqual(sent, [['move', 'left', { pan: 1 }]], 'no stop request: the server cannot be reached');
  } finally {
    await inst.destroy();
    globalThis.fetch = realFetch;
  }
});

test('destroy clears held timers and asks the heads to stop', async () => {
  const { inst } = makeInstance();
  const sent = [];
  inst.ptzHolds.moveFn = async () => {};
  inst.ptzHolds.stopFn = async (id) => { sent.push(id); };
  inst.ptzHolds.start('c|ptzZoom', 'left', { zoom: 1 });
  await inst.destroy();
  await flush();
  assert.equal(inst.ptzHolds.active, false);
  assert.deepEqual(sent, ['left']);
});
