import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StateModel } from '../src/state.js';
import { JsonStore } from '../src/store.js';
import {
  Presets, Gangs, matchFrom, capture, applyValues, rampPath, UndoHistory,
  PRESET_PROPS, PROP_GROUPS,
} from '../src/control.js';

const quietLog = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, write() {},
};

function enumerated(value, allowed, writable = true) {
  return { value, writable, allowed };
}

/** Two bodies with deliberately different ISO tables, as FX3 vs FX30 really are. */
function makeState() {
  const state = new StateModel();
  state.replaceAll([
    { id: 'cam1', label: 'FX3', model: 'ILME-FX3', state: 'connected',
      status: { battery: 90, recordingState: 0 } },
    { id: 'cam2', label: 'FX30 A', model: 'ILME-FX30', state: 'connected',
      status: { battery: 80, recordingState: 0 } },
    { id: 'cam3', label: 'FX30 B', model: 'ILME-FX30', state: 'offline',
      status: { battery: -1, recordingState: -1 } },
  ], 'test');

  state.replaceProperties('cam1', {
    fNumber: enumerated(400, [280, 320, 400, 560, 800]),
    isoSensitivity: enumerated(640, [100, 200, 400, 640, 1600, 6400]),
    shutterSpeed: enumerated((1 << 16) | 50, [(1 << 16) | 50, (1 << 16) | 100]),
    exposureMode: enumerated(1, [0, 1, 2]),
    whiteBalance: enumerated(2, [0, 1, 2, 3]),
    colorTemp: { value: 5600, writable: true, range: { min: 2500, max: 9900, step: 100 } },
    wbTint: { value: 0, writable: true, range: { min: -7, max: 7, step: 1 } },
  });
  state.replaceProperties('cam2', {
    fNumber: enumerated(560, [280, 320, 400, 560, 800]),
    // Super 35 floor is higher and the list is shorter.
    isoSensitivity: enumerated(800, [250, 400, 800, 1600, 3200]),
    shutterSpeed: enumerated((1 << 16) | 100, [(1 << 16) | 50, (1 << 16) | 100]),
    exposureMode: enumerated(1, [0, 1, 2]),
    whiteBalance: enumerated(0, [0, 1, 2, 3]),
    colorTemp: { value: 4300, writable: true, range: { min: 2500, max: 9900, step: 100 } },
    wbTint: { value: 2, writable: true, range: { min: -7, max: 7, step: 1 } },
  });
  return state;
}

/** Records every write and mutates the mirror, as the real setter effectively does. */
function makeApplyFn(state, { failOn = () => false } = {}) {
  const calls = [];
  const fn = async (cameraId, prop, raw) => {
    calls.push({ cameraId, prop, raw });
    if (failOn(cameraId, prop, raw)) {
      return { ok: false, status: 422, body: { error: 'refused in current mode' } };
    }
    const cam = state.get(cameraId);
    if (cam?.properties?.[prop]) cam.properties[prop].value = raw;
    return { ok: true, status: 200, body: { applied: raw, exact: true } };
  };
  fn.calls = calls;
  return fn;
}

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-test-'));
  return new JsonStore(join(dir, 'store.json'), { presets: {}, scenes: {}, gangs: {} }, () => {});
}

// --- presets ---------------------------------------------------------------

test('capture takes exposure and colour but never focus', () => {
  const state = makeState();
  const values = capture(state.get('cam1'));
  assert.ok('fNumber' in values);
  assert.ok('colorTemp' in values);
  // Focus is deliberately excluded: absolute position is lens-dependent and a
  // preset that racks focus unpredictably is an on-set hazard.
  assert.ok(!('focusPosition' in values));
  assert.deepEqual(Object.keys(values).sort(), PRESET_PROPS.filter((p) => p in values).sort());
});

test('preset saves and recalls exposure state', async () => {
  const state = makeState();
  const presets = new Presets(newStore(), state, quietLog);
  assert.equal(presets.savePreset('cam1', 'wide').ok, true);

  const apply = makeApplyFn(state);
  state.get('cam1').properties.fNumber.value = 800;
  const r = await presets.recallPreset('cam1', 'wide', apply);
  assert.equal(r.ok, true);
  assert.equal(state.get('cam1').properties.fNumber.value, 400);
});

test('preset save refuses a disconnected camera instead of storing junk', () => {
  const state = makeState();
  const presets = new Presets(newStore(), state, quietLog);
  const r = presets.savePreset('cam3', 'nope');
  assert.equal(r.ok, false);
  assert.match(r.error, /offline/);
});

test('scene captures connected cameras and reports which were skipped', () => {
  const state = makeState();
  const presets = new Presets(newStore(), state, quietLog);
  const r = presets.saveScene('interview');
  assert.equal(r.ok, true);
  assert.deepEqual(r.cameras.sort(), ['cam1', 'cam2']);
  // The offline camera must be reported, not silently dropped — otherwise
  // recalling this scene later would quietly miss a body.
  assert.deepEqual(r.skipped, ['cam3']);
});

test('scene recall applies to every camera and reports partial failure', async () => {
  const state = makeState();
  const presets = new Presets(newStore(), state, quietLog);
  presets.saveScene('interview');

  state.get('cam1').properties.fNumber.value = 280;
  state.get('cam2').properties.fNumber.value = 280;

  const apply = makeApplyFn(state, { failOn: (id, prop) => id === 'cam2' && prop === 'colorTemp' });
  const r = await presets.recallScene('interview', apply);
  assert.equal(r.ok, false);
  assert.equal(state.get('cam1').properties.fNumber.value, 400);
  const cam2 = r.cameras.find((c) => c.cameraId === 'cam2');
  assert.equal(cam2.ok, false);
  // The rest of cam2 still applied; one refused property must not abort the camera.
  assert.equal(state.get('cam2').properties.fNumber.value, 560);
});

// --- gang ------------------------------------------------------------------

test('gang applies a linked change to other members', async () => {
  const state = makeState();
  const gangs = new Gangs(newStore(), state, quietLog);
  gangs.define('main', { cam1: { offsets: {} }, cam2: { offsets: {} } });

  const apply = makeApplyFn(state);
  const results = await gangs.apply('cam1', 'fNumber', 800, apply);
  assert.equal(results.length, 1);
  assert.equal(results[0].cameraId, 'cam2');
  assert.equal(state.get('cam2').properties.fNumber.value, 800);
});

test('gang honours a per-camera offset in steps', async () => {
  const state = makeState();
  const gangs = new Gangs(newStore(), state, quietLog);
  // cam2 sits one step down the list from cam1.
  gangs.define('main', { cam1: { offsets: {} }, cam2: { offsets: { fNumber: -1 } } });

  const apply = makeApplyFn(state);
  await gangs.apply('cam1', 'fNumber', 560, apply);
  // 560 is index 3 in [280,320,400,560,800]; one step down is 400.
  assert.equal(state.get('cam2').properties.fNumber.value, 400);
});

test('gang skips disconnected members without failing the others', async () => {
  const state = makeState();
  const gangs = new Gangs(newStore(), state, quietLog);
  gangs.define('main', { cam1: {}, cam2: {}, cam3: {} });

  const apply = makeApplyFn(state);
  const results = await gangs.apply('cam1', 'fNumber', 320, apply);
  // cam3 is offline, so it is planned around rather than attempted and failed.
  assert.deepEqual(results.map((r) => r.cameraId), ['cam2']);
});

test('a disabled gang does nothing', async () => {
  const state = makeState();
  const gangs = new Gangs(newStore(), state, quietLog);
  gangs.define('main', { cam1: {}, cam2: {} });
  gangs.setEnabled('main', false);
  const apply = makeApplyFn(state);
  assert.deepEqual(await gangs.apply('cam1', 'fNumber', 320, apply), []);
});

// --- match -----------------------------------------------------------------

test('match copies an exactly shared property verbatim', async () => {
  const state = makeState();
  const apply = makeApplyFn(state);
  const r = await matchFrom(state, 'cam1', ['cam2'], ['fNumber'], apply, quietLog);
  assert.equal(r.ok, true);
  assert.equal(state.get('cam2').properties.fNumber.value, 400);
  const result = r.cameras[0].results[0];
  assert.equal(result.approximated, false);
});

test('match approximates ISO across sensor sizes and says so', async () => {
  const state = makeState();
  const apply = makeApplyFn(state);
  const r = await matchFrom(state, 'cam1', ['cam2'], ['isoSensitivity'], apply, quietLog);
  const result = r.cameras[0].results[0];
  // The FX3's ISO 640 does not exist on the Super 35 body's list, so the value is
  // matched by position instead — and flagged, so the operator knows.
  assert.equal(result.approximated, true);
  assert.ok([250, 400, 800, 1600, 3200].includes(result.sent));
});

test('match refuses an offline reference', async () => {
  const state = makeState();
  const apply = makeApplyFn(state);
  const r = await matchFrom(state, 'cam3', ['cam1'], null, apply, quietLog);
  assert.equal(r.ok, false);
  assert.match(r.error, /offline/);
});

test('match reports a target that is offline without touching the others', async () => {
  const state = makeState();
  const apply = makeApplyFn(state);
  const r = await matchFrom(state, 'cam1', ['cam2', 'cam3'], ['fNumber'], apply, quietLog);
  assert.equal(r.ok, false);
  assert.equal(r.cameras.find((c) => c.cameraId === 'cam2').ok, true);
  assert.equal(r.cameras.find((c) => c.cameraId === 'cam3').ok, false);
});

// --- state model -----------------------------------------------------------

test('losing a camera clears its cached property values', () => {
  const state = makeState();
  assert.ok(state.get('cam1').properties.fNumber);
  state.applyConnectionState({ cameraId: 'cam1', state: 'reconnecting' });
  // Showing a pre-outage iris value would be a plausible lie; "—" is the truth.
  assert.deepEqual(state.get('cam1').properties, {});
});

test('losing camd marks every camera offline', () => {
  const state = makeState();
  state.setCamdConnected(true);
  state.setCamdConnected(false);
  for (const cam of state.list()) {
    assert.equal(cam.state, 'offline');
    assert.equal(cam.detail, 'camd unreachable');
  }
});

test('view exposes both raw values and labels', () => {
  const state = makeState();
  const v = state.view();
  const cam1 = v.cameras.find((c) => c.id === 'cam1');
  assert.equal(cam1.properties.fNumber.raw, 400);
  assert.equal(cam1.properties.fNumber.label, 'f/4.0');
  assert.equal(cam1.properties.shutterSpeed.label, '1/50');
});

// --- adoption --------------------------------------------------------------

test('suggested ids are readable, stable and unique', async () => {
  const { suggestId, normaliseMac } = await import('../src/adopt.js');
  assert.equal(suggestId('ILME-FX3', '6C:6E:07:18:49:93'), 'fx3');
  assert.equal(suggestId('ILME-FX30', '6C:6E:07:19:75:F0'), 'fx30');

  // A second body of the same model is disambiguated by its MAC tail rather than
  // a counter, so an id stays attached to a camera regardless of adoption order.
  const taken = new Set(['fx30']);
  assert.equal(suggestId('ILME-FX30', '6C:6E:07:19:75:F0', taken), 'fx30-f0');
  // And it must not read as a model number.
  assert.ok(!/^fx\d{4,}$/.test(suggestId('ILME-FX30', '6C:6E:07:18:59:EB', taken)));

  assert.equal(suggestId('', '', new Set()), 'camera');
});

test('MAC normalisation accepts the formats a human might type', async () => {
  const { normaliseMac } = await import('../src/adopt.js');
  const want = '6C:6E:07:18:59:EB';
  assert.equal(normaliseMac('6C:6E:07:18:59:EB'), want);
  assert.equal(normaliseMac('6c-6e-07-18-59-eb'), want);
  assert.equal(normaliseMac('6c6e071859eb'), want);
  assert.equal(normaliseMac('not a mac'), null);
  assert.equal(normaliseMac(''), null);
  assert.equal(normaliseMac(undefined), null);
});

// --- ramping and selective recall -------------------------------------------

test('rampPath walks an option list one legal stop at a time', () => {
  const iris = { value: 280, writable: true, allowed: [280, 320, 400, 560, 800] };
  const path = rampPath(iris, 800, 4);

  // Every intermediate value must be a real stop — a camera cannot be parked
  // halfway between f/4 and f/5.6 on the way somewhere.
  for (const v of path) assert.ok(iris.allowed.includes(v), `${v} is not a legal stop`);
  assert.equal(path[path.length - 1], 800, 'a ramp must finish exactly on target');
  assert.ok(path.length > 1, 'a four-step ramp across five stops should not jump');
  // Monotonic: an iris ramp that backs up mid-move is visible on air.
  for (let i = 1; i < path.length; i++) assert.ok(path[i] > path[i - 1]);
});

test('rampPath interpolates a continuous range and never overshoots', () => {
  const kelvin = { value: 3200, writable: true, range: { min: 2500, max: 9900, step: 100 } };
  const path = rampPath(kelvin, 5600, 6);

  assert.equal(path[path.length - 1], 5600);
  for (const v of path) {
    assert.ok(v >= 3200 && v <= 5600, `${v} is outside the ramp`);
    assert.equal(v % 100, 0, `${v} is not on the camera's 100K step`);
  }
});

test('rampPath degrades to a single jump when there is nowhere to ramp', () => {
  const iris = { value: 400, writable: true, allowed: [280, 320, 400, 560, 800] };
  // No transition requested.
  assert.deepEqual(rampPath(iris, 800, 1), [800]);
  // Already there.
  assert.deepEqual(rampPath(iris, 400, 8), [400]);
});

test('a ramped recall sends intermediate writes and lands on the stored value', async () => {
  const state = makeState();
  const presets = new Presets(newStore(), state, quietLog);
  presets.savePreset('cam1', 'wide');

  const apply = makeApplyFn(state);
  state.get('cam1').properties.fNumber.value = 800;
  const r = await presets.recallPreset('cam1', 'wide', apply, { transitionMs: 400 });

  assert.equal(r.ok, true);
  assert.equal(state.get('cam1').properties.fNumber.value, 400);
  const irisWrites = apply.calls.filter((c) => c.prop === 'fNumber');
  assert.ok(irisWrites.length > 1, 'a ramp should be more than one write');
  assert.equal(irisWrites[irisWrites.length - 1].raw, 400);
});

test('an unramped recall is exactly one write per property', async () => {
  const state = makeState();
  const presets = new Presets(newStore(), state, quietLog);
  presets.savePreset('cam1', 'wide');

  const apply = makeApplyFn(state);
  state.get('cam1').properties.fNumber.value = 800;
  state.get('cam1').properties.colorTemp.value = 3200;
  await presets.recallPreset('cam1', 'wide', apply);

  for (const prop of ['fNumber', 'colorTemp']) {
    assert.equal(apply.calls.filter((c) => c.prop === prop).length, 1, `${prop} was written twice`);
  }
});

test('recalling only white balance leaves exposure untouched', async () => {
  const state = makeState();
  const cam = state.get('cam1');
  const apply = makeApplyFn(state);

  await applyValues(cam, { fNumber: 800, colorTemp: 3200 }, apply,
    { only: PROP_GROUPS.colour.props });

  assert.equal(cam.properties.colorTemp.value, 3200, 'the selected group must be applied');
  assert.equal(cam.properties.fNumber.value, 400, 'iris must not move mid-take');
  assert.ok(!apply.calls.some((c) => c.prop === 'fNumber'));
});

test('recall groups only name properties presets actually store', () => {
  // A chip that selects a property no preset captures would silently do nothing.
  for (const [name, group] of Object.entries(PROP_GROUPS)) {
    assert.ok(group.props.length > 0, `${name} has no properties`);
    for (const prop of group.props) {
      assert.ok(PRESET_PROPS.includes(prop), `${name}.${prop} is not captured in presets`);
    }
  }
});

// --- undo -------------------------------------------------------------------

test('undo returns the value a property held before the change', () => {
  const undo = new UndoHistory();
  undo.record('cam1', 'fNumber', 400, 800);
  const entry = undo.popLast('cam1');
  assert.equal(entry.prop, 'fNumber');
  assert.equal(entry.from, 400);
  assert.equal(undo.popLast('cam1'), null, 'the entry must be consumed');
});

test('a ramp collapses to one undo, back to where it started', () => {
  // A two-second recall sends about twenty writes per property. Recording each
  // would make undo step back a single ramp increment, which is useless.
  const undo = new UndoHistory();
  const start = Date.now();
  for (let i = 0; i < 20; i++) {
    undo.record('cam1', 'fNumber', 400 + i * 20, 400 + (i + 1) * 20, start + i * 50);
  }
  assert.equal(undo.summary().cam1.depth, 1);
  const entry = undo.popLast('cam1');
  assert.equal(entry.from, 400, 'undo must reach the pre-ramp value');
  assert.equal(entry.to, 800);
});

test('changes further apart than the coalescing window stay separate', () => {
  const undo = new UndoHistory({ coalesceMs: 1000 });
  const t = Date.now();
  undo.record('cam1', 'fNumber', 400, 560, t);
  undo.record('cam1', 'fNumber', 560, 800, t + 5000);
  assert.equal(undo.summary().cam1.depth, 2);
  assert.equal(undo.popLast('cam1').from, 560);
  assert.equal(undo.popLast('cam1').from, 400);
});

test('a write with no known previous value is not recorded', () => {
  // Storing it would give undo a null to write back to the camera.
  const undo = new UndoHistory();
  assert.equal(undo.record('cam1', 'fNumber', undefined, 800), null);
  assert.equal(undo.record('cam1', 'fNumber', null, 800), null);
  assert.equal(undo.popLast('cam1'), null);
});

test('a write that changed nothing is not recorded', () => {
  const undo = new UndoHistory();
  assert.equal(undo.record('cam1', 'fNumber', 400, 400), null);
  assert.equal(undo.popLast('cam1'), null);
});

test('recording is suspended during an undo, so undo is not a toggle', () => {
  const undo = new UndoHistory();
  undo.record('cam1', 'fNumber', 400, 800);
  const entry = undo.popLast('cam1');

  undo.suspended = true;
  undo.record('cam1', 'fNumber', 800, entry.from);
  undo.suspended = false;

  assert.equal(undo.popLast('cam1'), null,
    'the undo write must not become a new undoable change');
});

test('revert goes back to the mark, not to the last nudge', () => {
  // Three iris nudges after a recall must revert to where the recall left it.
  const undo = new UndoHistory();
  const t = Date.now();
  undo.record('cam1', 'fNumber', 280, 400, t);        // before the recall
  undo.mark('cam1', 'scene "Interview"', t + 100);
  undo.record('cam1', 'fNumber', 400, 560, t + 200);
  undo.record('cam1', 'fNumber', 560, 630, t + 5000);
  undo.record('cam1', 'colorTemp', 5600, 3200, t + 6000);

  const found = undo.popToMark('cam1');
  assert.equal(found.mark.label, 'scene "Interview"');
  assert.equal(found.values.fNumber, 400, 'must take the earliest from, not the latest');
  assert.equal(found.values.colorTemp, 5600);

  // What came before the mark survives, and is still individually undoable.
  assert.equal(undo.popLast('cam1').from, 280);
});

test('a ramp does not fold across a mark', () => {
  // Otherwise a nudge made just after a recall would rewrite the recall's own
  // entry, and reverting would land on the nudge rather than before the recall.
  const undo = new UndoHistory({ coalesceMs: 10_000 });
  const t = Date.now();
  undo.record('cam1', 'fNumber', 280, 400, t);
  undo.mark('cam1', 'preset "Wide"', t + 10);
  undo.record('cam1', 'fNumber', 400, 560, t + 20);

  assert.equal(undo.summary().cam1.depth, 2);
  assert.equal(undo.popToMark('cam1').values.fNumber, 400);
});

test('revert with no mark reports nothing rather than reverting everything', () => {
  const undo = new UndoHistory();
  undo.record('cam1', 'fNumber', 400, 800);
  assert.equal(undo.popToMark('cam1'), null);
  assert.equal(undo.summary().cam1.depth, 1, 'history must be left alone');
});

test('history is bounded', () => {
  const undo = new UndoHistory({ limit: 5, coalesceMs: 0 });
  for (let i = 0; i < 50; i++) undo.record('cam1', `p${i}`, i, i + 1);
  assert.equal(undo.summary().cam1.depth, 5);
});

test('history is per camera', () => {
  const undo = new UndoHistory();
  undo.record('cam1', 'fNumber', 400, 800);
  undo.record('cam2', 'colorTemp', 5600, 3200);
  assert.equal(undo.popLast('cam1').prop, 'fNumber');
  assert.equal(undo.popLast('cam2').prop, 'colorTemp');
});

test('a camera that drops loses its history', () => {
  // The values it held before the outage are not somewhere it can be put back
  // to; it may have been power-cycled since.
  const undo = new UndoHistory();
  undo.record('cam1', 'fNumber', 400, 800);
  undo.forget('cam1');
  assert.equal(undo.popLast('cam1'), null);
});
