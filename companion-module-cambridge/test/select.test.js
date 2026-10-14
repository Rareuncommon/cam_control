// Driving many PTZ heads from one page: the selected camera, banks of select
// keys, and keeping definition rebuilds off the position-update path.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { CambridgeInstance } from '../src/index.js';
import { applyPatch } from '../src/patch.js';
import { HOLD_REFRESH_MS, SELECTED } from '../src/ptz.js';
import { bankCount, bankSlots, stepSelection, bankSizeOf } from '../src/select.js';

if (typeof process.send !== 'function') process.send = () => true;

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeInstance(config = {}) {
  const captured = { actions: {}, feedbacks: {}, presets: {}, variableDefs: [], variables: {}, writes: [], checks: [] };
  const inst = new CambridgeInstance({ id: 'test', _isInstanceBaseProps: true, label: 'cambridge' });
  inst.config = config;
  inst.setActionDefinitions = (a) => { captured.actions = a; };
  inst.setFeedbackDefinitions = (f) => { captured.feedbacks = f; };
  inst.setPresetDefinitions = (p) => { captured.presets = p; };
  inst.setVariableDefinitions = (v) => { captured.variableDefs = v; };
  inst.setVariableValues = (v) => { captured.writes.push(Object.keys(v)); Object.assign(captured.variables, v); };
  inst.updateStatus = () => {};
  inst.log = () => {};
  inst.checkFeedbacks = (...ids) => { captured.checks.push(ids); };
  inst.parseVariablesInString = async (s) => s;
  return { inst, captured };
}

function recorder() {
  const sent = [];
  return {
    sent,
    request: async (method, path, body) => { sent.push({ method, path, body }); return { ok: true, status: 200, body: {} }; },
  };
}

function head(id, label, group = null, extra = {}) {
  return {
    id, kind: 'ptz', vendor: 'panasonic', label, group, model: 'AW-UE160', state: 'connected',
    tally: null, recordStartedAt: null,
    status: { battery: -1, media: '', recording: false, recordingFailed: false },
    ptz: { pan: 0.5, tilt: 0.25, zoom: 0.8, focus: 0.5, moving: false, tracking: false, preset: null },
    capabilities: { panTilt: true, zoom: true, focus: true, presets: 100, presetBase: 1, tally: true, tracking: null },
    properties: {},
    ...extra,
  };
}

const heads = (n, groupOf = () => null) => Array.from({ length: n }, (_, i) =>
  head(`cam${i + 1}`, `Cam ${i + 1}`, groupOf(i)));

const frame = (cameras) => ({ type: 'state', view: { camdConnected: false, camdUsed: false, cameras } });

// --- helpers -------------------------------------------------------------------

test('bank helpers: counts, slots and wrapping steps', () => {
  const list = heads(20);
  assert.equal(bankCount(20, 8), 3);
  assert.equal(bankCount(0, 8), 1);
  assert.deepEqual(bankSlots(list, 2, 8).map((c) => c?.id ?? null),
    ['cam17', 'cam18', 'cam19', 'cam20', null, null, null, null]);
  assert.equal(stepSelection(list, 'cam20', 1), 'cam1');
  assert.equal(stepSelection(list, 'cam1', -1), 'cam20');
  assert.equal(stepSelection(list, 'nope', 1), 'cam1');
  assert.equal(stepSelection(list, 'nope', -1), 'cam20');
  assert.equal(stepSelection([], 'x', 1), null);
  assert.equal(bankSizeOf({}), 8);
  assert.equal(bankSizeOf({ bankSize: 12 }), 12);
  assert.equal(bankSizeOf({ bankSize: 0 }), 8);
  assert.equal(bankSizeOf({ bankSize: 500 }), 32);
});

// --- selection -----------------------------------------------------------------

test('the first PTZ head is selected, and "(selected camera)" resolves to it', async () => {
  const { inst, captured } = makeInstance();
  const api = recorder();
  inst.api = api;
  inst.applyState(frame(heads(4)));
  await flush();
  api.sent.length = 0;
  assert.equal(inst.selectedPtz, 'cam1');
  assert.equal(captured.variables.ptz_selected, 'cam1');

  await captured.actions.ptzPresetRecall.callback({ options: { camera: SELECTED, preset: 4, byName: '' } });
  await inst.selectPtz('cam3');
  await captured.actions.ptzPresetRecall.callback({ options: { camera: SELECTED, preset: 4, byName: '' } });
  await captured.actions.ptzPresetRecall.callback({ options: { camera: 'cam2', preset: 4, byName: '' } });
  assert.deepEqual(api.sent.map((s) => s.path), [
    '/api/cameras/cam1/ptz/presets/4/recall',
    '/api/cameras/cam3/ptz/presets/4/recall',
    '/api/cameras/cam2/ptz/presets/4/recall',
  ]);
});

test('every PTZ action offers "(selected camera)" first and defaults to it', () => {
  const { inst, captured } = makeInstance();
  inst.applyState(frame(heads(4)));
  const ptzActions = Object.entries(captured.actions).filter(([k]) =>
    k.startsWith('ptz') && !['ptzSelect', 'ptzBank', 'ptzStopAll'].includes(k));
  assert.ok(ptzActions.length >= 10);
  for (const [k, def] of ptzActions) {
    const camera = def.options.find((o) => o.id === 'camera');
    assert.equal(camera.default, SELECTED, k);
    assert.equal(camera.choices[0].id, SELECTED, k);
  }
  for (const k of ['ptzPresetCurrent', 'ptzMoving']) {
    const camera = captured.feedbacks[k].options.find((o) => o.id === 'camera');
    assert.equal(camera.default, SELECTED, k);
  }
});

test('nothing selected means a "(selected camera)" action sends nothing', async () => {
  const { inst, captured } = makeInstance();
  const api = recorder();
  inst.api = api;
  inst.applyState(frame(heads(2)));
  inst.applyState(frame([]));
  assert.equal(inst.selectedPtz, null);
  inst.applyState(frame(heads(2)));
  // A head arriving with nothing selected selects the first.
  assert.equal(inst.selectedPtz, 'cam1');
  inst.selectedPtz = null;
  await flush();
  api.sent.length = 0;
  await captured.actions.ptzPresetRecall.callback({ options: { camera: SELECTED, preset: 1, byName: '' } });
  assert.deepEqual(api.sent, []);
});

test('select next / previous wrap, and can stay inside a group', async () => {
  const { inst, captured } = makeInstance();
  inst.applyState(frame(heads(6, (i) => (i % 2 ? 'Stage' : 'Hall'))));
  const sel = captured.actions.ptzSelect.callback;
  await sel({ options: { mode: 'previous', group: '' } });
  assert.equal(inst.selectedPtz, 'cam6');
  await sel({ options: { mode: 'next', group: '' } });
  assert.equal(inst.selectedPtz, 'cam1');
  // Hall = cam1, cam3, cam5.
  await sel({ options: { mode: 'next', group: 'Hall' } });
  assert.equal(inst.selectedPtz, 'cam3');
  await sel({ options: { mode: 'next', group: 'Hall' } });
  await sel({ options: { mode: 'next', group: 'Hall' } });
  assert.equal(inst.selectedPtz, 'cam1');
  // From a camera outside the group, next goes to the group's first.
  await sel({ options: { mode: 'camera', camera: 'cam2' } });
  await sel({ options: { mode: 'next', group: 'Hall' } });
  assert.equal(inst.selectedPtz, 'cam1');
  await sel({ options: { mode: 'previous', group: 'Stage' } });
  assert.equal(inst.selectedPtz, 'cam6');
  assert.deepEqual(captured.actions.ptzSelect.options.find((o) => o.id === 'group').choices.map((c) => c.id),
    ['', 'Hall', 'Stage']);
});

test('the selection survives list changes that keep its head, and falls back when it goes', () => {
  const { inst } = makeInstance();
  inst.applyState(frame(heads(5)));
  inst.selectPtz('cam4');
  inst.applyState(frame(heads(5).filter((c) => c.id !== 'cam2')));
  assert.equal(inst.selectedPtz, 'cam4');
  inst.applyState(frame([...heads(5), head('cam6', 'Cam 6')]));
  assert.equal(inst.selectedPtz, 'cam4');
  inst.applyState(frame(heads(3)));
  assert.equal(inst.selectedPtz, 'cam1');
});

test('a key held on the selected camera stops that camera when the selection moves', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  try {
    const { inst, captured } = makeInstance();
    const api = recorder();
    inst.api = api;
    inst.applyState(frame(heads(4)));
    await flush();

    captured.actions.ptzPanTilt.callback({ controlId: 'k1', options: { camera: SELECTED, direction: 'left', speed: 100 } });
    // A second key held on an explicit camera must be left alone.
    captured.actions.ptzZoom.callback({ controlId: 'k2', options: { camera: 'cam4', direction: 'in', speed: 100 } });
    await flush();
    const moves = (cam) => api.sent.filter((s) => s.path === `/api/cameras/${cam}/ptz/move`).length;
    assert.equal(moves('cam1'), 1);

    const stopped = inst.selectPtz('cam2');
    await stopped;
    assert.deepEqual(api.sent.at(-1), { method: 'POST', path: '/api/cameras/cam1/ptz/stop', body: undefined });
    assert.equal(inst.selectedPtz, 'cam2');
    assert.equal(api.sent.filter((s) => s.path === '/api/cameras/cam4/ptz/stop').length, 0);

    // Time passes with the key still down: cam1 is not refreshed, cam4 still is.
    const before = moves('cam1');
    for (let i = 0; i < 3; i++) { mock.timers.tick(HOLD_REFRESH_MS); await flush(); }
    assert.equal(moves('cam1'), before);
    assert.ok(moves('cam4') > 1);

    // The late release neither errors nor stops the newly selected head.
    api.sent.length = 0;
    await captured.actions.ptzRelease.callback({ controlId: 'k1', options: { camera: SELECTED } });
    assert.deepEqual(api.sent, []);

    // Reselecting the same camera while holding does not stop anything.
    captured.actions.ptzPanTilt.callback({ controlId: 'k1', options: { camera: SELECTED, direction: 'up', speed: 50 } });
    await flush();
    api.sent.length = 0;
    await inst.selectPtz('cam2');
    assert.deepEqual(api.sent, []);
    await captured.actions.ptzRelease.callback({ controlId: 'k1', options: { camera: SELECTED } });
    assert.equal(api.sent.at(-1).path, '/api/cameras/cam2/ptz/stop');
    await inst.ptzHolds.clearAll();
  } finally {
    mock.timers.reset();
  }
});

test('release on "(selected camera)" stops the camera the press started, even if the selection moved on', async () => {
  const { inst, captured } = makeInstance();
  const api = recorder();
  inst.api = api;
  inst.applyState(frame(heads(3)));
  captured.actions.ptzZoom.callback({ controlId: 'k', options: { camera: SELECTED, direction: 'in', speed: 50 } });
  await flush();
  // Moved without going through selectPtz: still released correctly.
  inst.selectedPtz = 'cam3';
  await captured.actions.ptzRelease.callback({ controlId: 'k', options: { camera: SELECTED } });
  assert.equal(api.sent.at(-1).path, '/api/cameras/cam1/ptz/stop');
  assert.equal(inst.ptzHolds.active, false);
});

test('"set any setting" on the selected camera uses the shared fields and the head\'s own table', async () => {
  const { inst, captured } = makeInstance();
  const api = recorder();
  inst.api = api;
  inst.applyState(frame(heads(2)));
  inst.ptzSchemas = {
    cam1: [{ id: 'wbMode', label: 'WB', type: 'enum', danger: 'none', available: true, options: [{ value: 'auto', label: 'Auto' }] }],
    cam2: [
      { id: 'wbMode', label: 'WB', type: 'enum', danger: 'none', available: true, options: [{ value: 'indoor', label: 'Indoor' }] },
      { id: 'gain', label: 'Gain', type: 'range', danger: 'none', available: true, range: { min: 0, max: 10, step: 1 } },
    ],
  };
  inst.rebuildDefinitions();
  const def = captured.actions.ptzSetting;
  assert.deepEqual(def.options.find((o) => o.id === 'setting_selected').choices.map((c) => c.id), ['wbMode', 'gain']);
  assert.deepEqual(def.options.find((o) => o.id === 'v_selected_wbMode').choices.map((c) => c.id), ['auto', 'indoor']);

  await inst.selectPtz('cam2');
  await def.callback({ options: { camera: SELECTED, setting_selected: 'gain', v_selected_gain: 4 } });
  // cam1 has no "gain": nothing is written.
  await inst.selectPtz('cam1');
  await def.callback({ options: { camera: SELECTED, setting_selected: 'gain', v_selected_gain: 4 } });
  assert.deepEqual(api.sent.filter((s) => s.method === 'PUT').map((s) => [s.path, s.body]),
    [['/api/cameras/cam2/properties/gain', { value: 4 }]]);
});

// --- variables and feedbacks ------------------------------------------------------

test('variables and feedbacks follow the selected camera without a rebuild', () => {
  const { inst, captured } = makeInstance();
  let rebuilds = 0;
  const real = inst.rebuildDefinitions.bind(inst);
  inst.rebuildDefinitions = () => { rebuilds += 1; real(); };
  const cams = heads(3, () => 'Stage');
  cams[1].ptz = { ...cams[1].ptz, pan: 0.1, tilt: 0.9, zoom: 0.4, preset: 7, tracking: true, moving: true };
  cams[1].capabilities = { ...cams[1].capabilities, tracking: { kind: 'autoTracking', label: 'Tracking' } };
  cams[1].tally = { program: true, preview: false };
  inst.applyState(frame(cams));
  assert.equal(rebuilds, 1);
  assert.equal(captured.variables.ptz_selected_label, 'Cam 1');

  inst.selectPtz('cam2');
  assert.equal(rebuilds, 1);
  const v = captured.variables;
  assert.equal(v.ptz_selected, 'cam2');
  assert.equal(v.ptz_selected_label, 'Cam 2');
  assert.equal(v.ptz_selected_group, 'Stage');
  assert.equal(v.ptz_selected_pan, 10);
  assert.equal(v.ptz_selected_tilt, 90);
  assert.equal(v.ptz_selected_zoom, 40);
  assert.equal(v.ptz_selected_preset, 7);
  assert.equal(v.ptz_selected_tracking, 'On');
  assert.equal(v.ptz_selected_moving, 'yes');
  assert.equal(v.ptz_selected_tally, 'PGM');

  const defined = new Set(captured.variableDefs.map((d) => d.variableId));
  for (const id of Object.keys(v).filter((k) => k.startsWith('ptz_'))) assert.ok(defined.has(id), id);

  const fb = captured.feedbacks;
  assert.equal(fb.ptzSelected.callback({ options: { camera: 'cam2' } }), true);
  assert.equal(fb.ptzSelected.callback({ options: { camera: 'cam1' } }), false);
  assert.equal(fb.ptzPresetCurrent.callback({ options: { camera: SELECTED, preset: 7 } }), true);
  assert.equal(fb.ptzTracking.callback({ options: { camera: SELECTED } }), true);
  assert.ok(captured.checks.at(-1).includes('ptzSelected'));

  // The selected camera's variables follow its position, too.
  const moved = heads(3, () => 'Stage');
  moved[1].ptz = { ...moved[1].ptz, pan: 0.75 };
  moved[1].capabilities = cams[1].capabilities;
  inst.applyState(frame(moved));
  assert.equal(v.ptz_selected_pan, 75);
  assert.equal(rebuilds, 1);
});

// --- banks -------------------------------------------------------------------------

test('banks of 8 over 20 cameras: slot labels, next / previous / go to, and select by slot', async () => {
  const { inst, captured } = makeInstance();
  inst.applyState(frame(heads(20)));
  const v = captured.variables;
  assert.equal(v.ptz_bank, 1);
  assert.equal(v.ptz_bank_count, 3);
  assert.equal(v.ptz_bank_slot_1_label, 'Cam 1');
  assert.equal(v.ptz_bank_slot_8_label, 'Cam 8');
  assert.ok(!captured.variableDefs.some((d) => d.variableId === 'ptz_bank_slot_9_label'));

  const bank = captured.actions.ptzBank.callback;
  bank({ options: { mode: 'next' } });
  assert.equal(v.ptz_bank, 2);
  assert.equal(v.ptz_bank_slot_1_label, 'Cam 9');
  bank({ options: { mode: 'next' } });
  assert.equal(v.ptz_bank, 3);
  assert.equal(v.ptz_bank_slot_4_label, 'Cam 20');
  assert.equal(v.ptz_bank_slot_5_label, '');
  bank({ options: { mode: 'next' } });
  assert.equal(v.ptz_bank, 1);
  bank({ options: { mode: 'previous' } });
  assert.equal(v.ptz_bank, 3);
  bank({ options: { mode: 'goto', bank: 2 } });
  assert.equal(v.ptz_bank, 2);
  bank({ options: { mode: 'goto', bank: 99 } });
  assert.equal(v.ptz_bank, 3);
  // Changing bank does not change the selection.
  assert.equal(inst.selectedPtz, 'cam1');

  bank({ options: { mode: 'goto', bank: 2 } });
  await captured.actions.ptzSelect.callback({ options: { mode: 'slot', slot: 3 } });
  assert.equal(inst.selectedPtz, 'cam11');
  // An empty slot selects nothing.
  bank({ options: { mode: 'goto', bank: 3 } });
  await captured.actions.ptzSelect.callback({ options: { mode: 'slot', slot: 7 } });
  assert.equal(inst.selectedPtz, 'cam11');
  // Selecting a camera in another bank brings that bank up.
  await captured.actions.ptzSelect.callback({ options: { mode: 'camera', camera: 'cam2' } });
  assert.equal(v.ptz_bank, 1);
});

test('slot feedbacks read the camera in the slot of the bank showing', () => {
  const { inst, captured } = makeInstance();
  const cams = heads(20);
  cams[9].tally = { program: true, preview: false };
  cams[10].state = 'offline';
  inst.applyState(frame(cams));
  const fb = captured.feedbacks;
  assert.equal(fb.ptzSlotSelected.callback({ options: { slot: 1 } }), true);
  assert.equal(fb.ptzSlotSelected.callback({ options: { slot: 2 } }), false);
  inst.moveBank('next');
  assert.equal(fb.ptzSlotSelected.callback({ options: { slot: 1 } }), false);
  assert.equal(fb.ptzSlotTally.callback({ options: { slot: 2, bus: 'program' } }), true);
  assert.equal(fb.ptzSlotTally.callback({ options: { slot: 1, bus: 'program' } }), false);
  assert.equal(fb.ptzSlotOffline.callback({ options: { slot: 3 } }), true);
  assert.equal(fb.ptzSlotOffline.callback({ options: { slot: 4 } }), false);
  // An empty slot is none of these.
  inst.moveBank('goto', 3);
  assert.equal(fb.ptzSlotOffline.callback({ options: { slot: 8 } }), false);
  assert.equal(fb.ptzSlotTally.callback({ options: { slot: 8, bus: 'either' } }), false);
});

test('the PTZ controller page: select row, bank keys, pad, zoom, focus, presets 1-8, STOP ALL', () => {
  const { inst, captured } = makeInstance();
  inst.applyState(frame(heads(20)));
  const ctl = Object.entries(captured.presets).filter(([, p]) => p.category === 'PTZ controller');
  const keys = ctl.map(([k]) => k);
  for (let n = 1; n <= 8; n += 1) assert.ok(keys.includes(`ctl_slot_${n}`), `slot ${n}`);
  assert.ok(!keys.includes('ctl_slot_9'));
  for (const k of ['ctl_bank_next', 'ctl_bank_previous', 'ctl_up', 'ctl_down-left', 'ctl_zoom_in', 'ctl_zoom_out',
    'ctl_focus_near', 'ctl_focus_far', 'ctl_stop_all', 'ctl_home', 'ctl_af', 'ctl_selected']) {
    assert.ok(keys.includes(k), k);
  }
  for (let n = 1; n <= 8; n += 1) assert.ok(keys.includes(`ctl_preset_${n}`), `preset ${n}`);

  const slot = captured.presets.ctl_slot_3;
  assert.match(slot.style.text, /ptz_bank_slot_3_label/);
  assert.deepEqual(slot.feedbacks.map((f) => f.feedbackId).sort(),
    ['ptzSlotOffline', 'ptzSlotSelected', 'ptzSlotTally', 'ptzSlotTally']);
  assert.equal(captured.presets.ctl_up.steps[0].down[0].options.camera, SELECTED);
  assert.equal(captured.presets.ctl_up.steps[0].up[0].options.camera, SELECTED);
  assert.equal(captured.presets.ctl_preset_5.steps[0].down[0].options.camera, SELECTED);

  // Everything a controller key references exists and every variable is defined.
  const defined = new Set(captured.variableDefs.map((d) => d.variableId));
  for (const [key, p] of ctl) {
    for (const step of p.steps) {
      for (const a of [...step.down, ...step.up]) assert.ok(captured.actions[a.actionId], `${key}: ${a.actionId}`);
    }
    for (const f of p.feedbacks) assert.ok(captured.feedbacks[f.feedbackId], `${key}: ${f.feedbackId}`);
    for (const m of String(p.style.text).matchAll(/\$\(cambridge:([a-z0-9_]+)\)/g)) {
      assert.ok(defined.has(m[1]), `${key} references undefined ${m[1]}`);
    }
  }
});

test('bank size is configurable and changing it rebuilds the definitions', async () => {
  const { inst, captured } = makeInstance({ bankSize: 5 });
  inst.applyState(frame(heads(12)));
  assert.equal(captured.variables.ptz_bank_count, 3);
  assert.ok(captured.presets.ctl_slot_5);
  assert.ok(!captured.presets.ctl_slot_6);
  assert.equal(captured.variables.ptz_bank_slot_5_label, 'Cam 5');

  inst.selectPtz('cam12');
  assert.equal(captured.variables.ptz_bank, 3);
  // configUpdated reconnects too; there is no server here, so only the definitions matter.
  await inst.configUpdated({ bankSize: 10 });
  inst.api?.stop();
  assert.ok(captured.presets.ctl_slot_10);
  assert.equal(captured.variables.ptz_bank_count, 2);
  assert.equal(captured.variables.ptz_bank, 2);
});

// --- definitions at scale --------------------------------------------------------

test('camera dropdowns show "Label (group)" in the order the server sent', () => {
  const { inst, captured } = makeInstance();
  const cams = [head('z', 'Zed', 'Stage'), head('a', 'Alpha', null), head('m', 'Mid', 'Hall')];
  inst.applyState(frame(cams));
  const choices = captured.actions.ptzPanTilt.options.find((o) => o.id === 'camera').choices;
  assert.deepEqual(choices.map((c) => [c.id, c.label]), [
    [SELECTED, '(selected camera)'], ['z', 'Zed (Stage)'], ['a', 'Alpha'], ['m', 'Mid (Hall)'],
  ]);
});

test('a renamed or regrouped camera rebuilds definitions; a position update does not', () => {
  const { inst } = makeInstance();
  let rebuilds = 0;
  const real = inst.rebuildDefinitions.bind(inst);
  inst.rebuildDefinitions = () => { rebuilds += 1; real(); };
  inst.applyState(frame(heads(6)));
  assert.equal(rebuilds, 1);
  const moved = heads(6);
  moved[2].ptz = { ...moved[2].ptz, pan: 0.9, moving: true };
  inst.applyState(frame(moved));
  assert.equal(rebuilds, 1);
  const grouped = heads(6);
  grouped[2].group = 'Balcony';
  inst.applyState(frame(grouped));
  assert.equal(rebuilds, 2);
  const renamed = heads(6);
  renamed[2].group = 'Balcony';
  renamed[3].label = 'Door';
  inst.applyState(frame(renamed));
  assert.equal(rebuilds, 3);
});

test('turning off per-camera buttons leaves the controller page and drops the per-camera categories', () => {
  const on = makeInstance();
  on.inst.applyState(frame(heads(10)));
  const off = makeInstance({ ptzPerCameraPresets: false });
  off.inst.applyState(frame(heads(10)));

  const count = (c) => Object.keys(c.captured.presets).length;
  const categories = (c) => new Set(Object.values(c.captured.presets).map((p) => p.category));
  assert.ok(categories(on).has('Cam 1 — PTZ'));
  assert.ok(![...categories(off)].some((x) => x.endsWith('— PTZ')));
  assert.ok(off.captured.presets.ctl_slot_1);
  assert.ok(off.captured.presets.ctl_stop_all);
  assert.ok(!off.captured.presets.tally_cam1);
  assert.ok(count(off) < 50, `${count(off)} presets`);
  assert.ok(count(on) > 10 * 20);
  // Actions and variables per camera stay (they are cheap and buttons may use them).
  assert.ok(off.captured.actions.ptzPanTilt);
  assert.ok(off.captured.variableDefs.some((d) => d.variableId === 'cam1_pan'));
});

test('48 cameras: one state frame rebuilds once, a following position patch rebuilds nothing', () => {
  const groups = ['Stage', 'Hall', 'Balcony', 'Foyer'];
  const cams = heads(48, (i) => groups[i % 4]);
  for (const perCamera of [true, false]) {
    const { inst, captured } = makeInstance({ ptzPerCameraPresets: perCamera });
    let rebuilds = 0;
    let rebuildMs = 0;
    const real = inst.rebuildDefinitions.bind(inst);
    inst.rebuildDefinitions = () => {
      rebuilds += 1;
      const t = performance.now();
      real();
      rebuildMs += performance.now() - t;
    };

    const full = frame(cams);
    let t = performance.now();
    inst.applyState(full);
    const frameMs = performance.now() - t;
    assert.equal(rebuilds, 1);
    assert.equal(captured.variables.camera_count, 48);

    // Patches the way the API client folds them in.
    let current = full;
    const patchTimes = [];
    const writtenPerPatch = [];
    for (let i = 0; i < 200; i += 1) {
      const id = `cam${(i % 48) + 1}`;
      const patch = { type: 'patch', cameras: { [id]: { ptz: { pan: (i % 100) / 100, tilt: 0.5, zoom: 0.5, moving: true } } } };
      current = applyPatch(current, patch).frame;
      captured.writes.length = 0;
      t = performance.now();
      inst.applyState(current);
      patchTimes.push(performance.now() - t);
      writtenPerPatch.push(captured.writes.flat().length);
    }
    assert.equal(rebuilds, 1, 'a position patch must not rebuild definitions');
    const sorted = [...patchTimes].sort((a, b) => a - b);
    const med = sorted[100];
    const max = sorted.at(-1);
    // Only that camera's variables and the summary/selection values are written.
    assert.ok(Math.max(...writtenPerPatch) < 60, `wrote ${Math.max(...writtenPerPatch)} variables per patch`);
    assert.ok(captured.variables.cam7_pan !== undefined);
    // Generous ceilings, not benchmarks; the real numbers are printed.
    assert.ok(med < 20, `patch median ${med}ms`);
    assert.ok(rebuildMs < 1000, `rebuild ${rebuildMs}ms`);
    console.log(`# 48 heads, per-camera buttons ${perCamera ? 'on' : 'off'}: first frame ${frameMs.toFixed(1)} ms ` +
      `(rebuild ${rebuildMs.toFixed(1)} ms, ${Object.keys(captured.presets).length} presets, ` +
      `${captured.variableDefs.length} variables, ${Object.keys(captured.actions).length} actions); ` +
      `position patch median ${med.toFixed(3)} ms, max ${max.toFixed(3)} ms, ` +
      `${Math.max(...writtenPerPatch)} variables written per patch`);
  }
});

test('a patch for the selected camera moves its selected-camera variables, still without a rebuild', () => {
  const { inst, captured } = makeInstance();
  let rebuilds = 0;
  const real = inst.rebuildDefinitions.bind(inst);
  inst.rebuildDefinitions = () => { rebuilds += 1; real(); };
  const full = frame(heads(48));
  inst.applyState(full);
  inst.selectPtz('cam30');
  const { frame: next } = applyPatch(full, { type: 'patch', cameras: { cam30: { ptz: { pan: 0.33, preset: 5 } } } });
  inst.applyState(next);
  assert.equal(captured.variables.ptz_selected_pan, 33);
  assert.equal(captured.variables.ptz_selected_preset, 5);
  assert.equal(captured.variables.cam30_pan, 33);
  assert.equal(rebuilds, 1);
});

test('tally is carried forward across frames that do not mention it', () => {
  const { inst } = makeInstance();
  const cams = heads(3);
  cams[1].tally = { program: true, preview: false };
  inst.applyState(frame(cams));
  inst.applyState(frame(heads(3)));
  assert.equal(inst.camera('cam2').tally.program, true);
});
