import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StateModel } from '../src/state.js';
import { JsonStore } from '../src/store.js';
import { Presets, Gangs, matchFrom, capture, PRESET_PROPS } from '../src/control.js';

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
  // preset that racks focus unpredictably is a service-time hazard.
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
  const r = presets.saveScene('worship');
  assert.equal(r.ok, true);
  assert.deepEqual(r.cameras.sort(), ['cam1', 'cam2']);
  // The offline camera must be reported, not silently dropped — otherwise
  // recalling this scene later would quietly miss a body.
  assert.deepEqual(r.skipped, ['cam3']);
});

test('scene recall applies to every camera and reports partial failure', async () => {
  const state = makeState();
  const presets = new Presets(newStore(), state, quietLog);
  presets.saveScene('worship');

  state.get('cam1').properties.fNumber.value = 280;
  state.get('cam2').properties.fNumber.value = 280;

  const apply = makeApplyFn(state, { failOn: (id, prop) => id === 'cam2' && prop === 'colorTemp' });
  const r = await presets.recallScene('worship', apply);
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
