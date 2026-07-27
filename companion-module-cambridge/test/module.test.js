// Exercises the real module class against a stub Companion host.
//
// InstanceBase's constructor wants a host IPC object, and every setXDefinitions
// call goes through it. Rather than reimplement the module for testing, the stub
// below captures those calls so we can assert on what Companion would actually
// be handed: the action list, the feedback results, the variable values.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CambridgeInstance } from '../src/index.js';
import { nextValue, snap } from '../src/step.js';
import { buildVariableValues, varId } from '../src/variables.js';

// InstanceBase builds an IPC wrapper in its constructor and refuses to be
// created without Companion's handshake props. Satisfying both is all it takes
// to drive the real class here rather than a reimplementation of it.
if (typeof process.send !== 'function') process.send = () => true;

/** Enough of Companion's internals for InstanceBase to construct and run. */
function makeInstance() {
  const captured = {
    actions: {}, feedbacks: {}, presets: {}, variableDefs: [], variables: {},
    status: null, statusMessage: null, logs: [], feedbackChecks: 0,
  };

  const inst = new CambridgeInstance({ id: 'test', _isInstanceBaseProps: true, label: 'cambridge' });

  // InstanceBase routes these through private host plumbing that only exists
  // under Companion, so replace them at the instance level.
  inst.setActionDefinitions = (a) => { captured.actions = a; };
  inst.setFeedbackDefinitions = (f) => { captured.feedbacks = f; };
  inst.setPresetDefinitions = (p) => { captured.presets = p; };
  inst.setVariableDefinitions = (v) => { captured.variableDefs = v; };
  inst.setVariableValues = (v) => { Object.assign(captured.variables, v); };
  inst.updateStatus = (s, m) => { captured.status = s; captured.statusMessage = m ?? null; };
  inst.log = (level, msg) => { captured.logs.push(`${level}: ${msg}`); };
  inst.checkFeedbacks = () => { captured.feedbackChecks += 1; };
  inst.parseVariablesInString = async (s) => s;

  return { inst, captured };
}

/** Two cameras in the shape cambridge's /api/state actually returns. */
function sampleView({ recording = false } = {}) {
  return {
    camdConnected: true,
    cameras: [
      {
        id: 'fx3', label: 'Wide', model: 'ILME-FX3', state: 'connected',
        status: { battery: 87, media: 'SLOT1 128GB', recording, recordingFailed: false },
        properties: {
          fNumber: { raw: 400, label: 'f/4.0', writable: true,
            options: [280, 320, 400, 560, 800].map((r) => ({ raw: r, label: `f/${r / 100}` })) },
          isoSensitivity: { raw: 640, label: 'ISO 640', writable: true,
            options: [200, 400, 640, 1600].map((r) => ({ raw: r, label: `ISO ${r}` })) },
          colorTemp: { raw: 5600, label: '5600K', writable: true,
            range: { min: 2500, max: 9900, step: 100 } },
          irisMode: { raw: 1, label: 'Auto', writable: true },
        },
      },
      {
        id: 'fx30-a', label: 'Centre', model: 'ILME-FX30', state: 'offline',
        status: { battery: -1, media: '', recording: false, recordingFailed: false },
        properties: {},
      },
    ],
  };
}

// --- stepping ---------------------------------------------------------------

test('iris steps invert so "up" means more light', () => {
  const iris = {
    raw: 400, writable: true,
    options: [280, 320, 400, 560, 800].map((r) => ({ raw: r })),
  };
  // Up = more light = a smaller f-number. Getting this backwards would make
  // every iris button on the deck work the wrong way.
  assert.equal(nextValue(iris, 'fNumber', 1), 320);
  assert.equal(nextValue(iris, 'fNumber', -1), 560);
});

test('ISO steps do not invert', () => {
  const iso = { raw: 400, writable: true, options: [200, 400, 640, 1600].map((r) => ({ raw: r })) };
  assert.equal(nextValue(iso, 'isoSensitivity', 1), 640);
  assert.equal(nextValue(iso, 'isoSensitivity', -1), 200);
});

test('stepping past the end of a list does nothing rather than wrapping', () => {
  const iris = { raw: 280, writable: true, options: [280, 320, 400].map((r) => ({ raw: r })) };
  // 280 is the widest; "more light" has nowhere to go. Wrapping round to f/4
  // would darken the shot at exactly the moment the operator wanted it brighter.
  assert.equal(nextValue(iris, 'fNumber', 1), null);
  assert.equal(nextValue(iris, 'fNumber', -1), 320);
});

test('a range property steps by its own step size', () => {
  const kelvin = { raw: 5600, writable: true, range: { min: 2500, max: 9900, step: 100 } };
  assert.equal(nextValue(kelvin, 'colorTemp', 1), 5700);
  assert.equal(nextValue(kelvin, 'colorTemp', 1, 5), 6100);
  // And clamps at the end of the range instead of running past it.
  assert.equal(nextValue({ ...kelvin, raw: 9900 }, 'colorTemp', 1), null);
});

test('a read-only property never steps', () => {
  const iris = { raw: 400, writable: false, options: [280, 400].map((r) => ({ raw: r })) };
  assert.equal(nextValue(iris, 'fNumber', 1), null);
});

test('an off-list current value refuses to step rather than guessing', () => {
  // The camera is reporting something outside its own advertised list. Stepping
  // from a guessed index could move the iris several stops in one press.
  const iris = { raw: 999, writable: true, options: [280, 320, 400].map((r) => ({ raw: r })) };
  assert.equal(nextValue(iris, 'fNumber', 1), null);
});

test('snap picks the nearest legal value, biased low on a tie', () => {
  const iris = { options: [280, 320].map((r) => ({ raw: r })) };
  assert.equal(snap(iris, 300), 280);
  assert.equal(snap(iris, 318), 320);
  const kelvin = { range: { min: 2500, max: 9900, step: 100 } };
  assert.equal(snap(kelvin, 5643), 5600);
  assert.equal(snap(kelvin, 99999), 9900);
});

// --- module wiring ----------------------------------------------------------

test('a state frame builds actions, feedbacks, presets and variables', () => {
  const { inst, captured } = makeInstance();
  inst.applyState(sampleView());

  // The actions an operator needs on a deck must all be offered.
  for (const id of ['record', 'propStep', 'propSet', 'presetRecall', 'sceneRecall', 'match',
    'autofocus', 'menuKey', 'autoManual']) {
    assert.ok(captured.actions[id], `missing action ${id}`);
  }
  for (const id of ['recording', 'recordingFailed', 'cameraState', 'tally', 'autoMode']) {
    assert.ok(captured.feedbacks[id], `missing feedback ${id}`);
  }
  assert.ok(Object.keys(captured.presets).length > 0, 'no ready-made buttons');

  const v = varId('fx3');
  assert.equal(captured.variables[`${v}_iris`], 'f/4.0');
  assert.equal(captured.variables[`${v}_recording`], 'idle');
  assert.equal(captured.variables[`${v}_battery`], '87%');
  // An offline camera must still report, not vanish from the deck.
  assert.equal(captured.variables[`${varId('fx30-a')}_state`], 'offline');
  assert.equal(captured.variables.connected_count, 1);
  assert.equal(captured.variables.cameras_down, 'Centre');
});

test('every variable a preset button references is actually defined', () => {
  // A button showing "$(cambridge:fx3_iris)" literally, because nothing declared
  // that variable, is the classic Companion module bug.
  const { inst, captured } = makeInstance();
  inst.applyState(sampleView());

  const defined = new Set(captured.variableDefs.map((d) => d.variableId));
  const referenced = new Set();
  for (const preset of Object.values(captured.presets)) {
    for (const m of JSON.stringify(preset).matchAll(/\$\(cambridge:([a-zA-Z0-9_]+)\)/g)) {
      referenced.add(m[1]);
    }
  }
  assert.ok(referenced.size > 0, 'presets reference no variables at all');
  for (const name of referenced) {
    assert.ok(defined.has(name), `preset references undefined variable ${name}`);
  }
});

test('feedbacks report the camera state Companion will colour buttons with', () => {
  const { inst, captured } = makeInstance();
  inst.applyState(sampleView({ recording: true }));

  assert.equal(captured.feedbacks.recording.callback({ options: { camera: 'fx3' } }), true);
  assert.equal(captured.feedbacks.recording.callback({ options: { camera: 'fx30-a' } }), false);
  assert.equal(captured.feedbacks.anyRecording.callback({ options: {} }), true);
  // One camera is offline, so "all connected are recording" is true (only fx3 is
  // connected) but "any camera down" must also be true.
  assert.equal(captured.feedbacks.anyCameraDown.callback({ options: {} }), true);
  assert.equal(
    captured.feedbacks.cameraState.callback({ options: { camera: 'fx30-a', state: '__notok__' } }), true);
  // Iris is on Auto in the sample, which is what the amber warning is for.
  assert.equal(
    captured.feedbacks.autoMode.callback({ options: { camera: 'fx3', which: 'irisMode' } }), true);
});

test('a feedback for a camera that has gone away returns false, not a crash', () => {
  const { inst, captured } = makeInstance();
  inst.applyState(sampleView());
  // A button still referencing a removed camera must simply go dark.
  assert.equal(captured.feedbacks.recording.callback({ options: { camera: 'deleted' } }), false);
  assert.equal(captured.feedbacks.tally.callback({ options: { camera: 'deleted', bus: 'program' } }), false);
});

test('record toggle sends the opposite of what the camera is doing', async () => {
  const { inst, captured } = makeInstance();
  const sent = [];
  inst.api = {
    request: async (method, path, body) => { sent.push({ method, path, body }); return { ok: true }; },
    stop() {},
  };
  inst.applyState(sampleView({ recording: true }));

  await captured.actions.record.callback({ options: { camera: 'fx3', mode: 'toggle' } });
  assert.match(sent[0].path, /recordStop$/);

  inst.applyState(sampleView({ recording: false }));
  await captured.actions.record.callback({ options: { camera: 'fx3', mode: 'toggle' } });
  assert.match(sent[1].path, /recordStart$/);
});

test('"toggle all" stops everything when any camera is already rolling', async () => {
  const { inst, captured } = makeInstance();
  const sent = [];
  inst.api = {
    request: async (method, path, body) => { sent.push({ method, path, body }); return { ok: true }; },
    stop() {},
  };
  inst.applyState(sampleView({ recording: true }));

  await captured.actions.record.callback({ options: { camera: '__all__', mode: 'toggle' } });
  assert.equal(sent[0].path, '/api/record-all');
  // Safer reading of one press mid-take: stop, rather than start the stragglers.
  assert.equal(sent[0].body.start, false);
});

test('a step action turns into a property write of the next legal value', async () => {
  const { inst, captured } = makeInstance();
  const sent = [];
  inst.api = {
    request: async (method, path, body) => { sent.push({ method, path, body }); return { ok: true }; },
    stop() {},
  };
  inst.applyState(sampleView());

  await captured.actions.propStep.callback({
    options: { camera: 'fx3', prop: 'fNumber', direction: '1', steps: 1 },
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].path, /\/properties\/fNumber$/);
  assert.equal(sent[0].body.value, 320);
});

test('a step with nowhere to go sends nothing at all', async () => {
  const { inst, captured } = makeInstance();
  const sent = [];
  inst.api = { request: async (...a) => { sent.push(a); return { ok: true }; }, stop() {} };
  const view = sampleView();
  view.cameras[0].properties.fNumber.raw = 280;   // already wide open
  inst.applyState(view);

  await captured.actions.propStep.callback({
    options: { camera: 'fx3', prop: 'fNumber', direction: '1', steps: 1 },
  });
  assert.equal(sent.length, 0, 'a dead-end step must not write to the camera');
});

test('scene recall passes the ramp and the selected groups through', async () => {
  const { inst, captured } = makeInstance();
  const sent = [];
  inst.api = {
    request: async (method, path, body) => { sent.push({ method, path, body }); return { ok: true }; },
    stop() {},
  };
  inst.groups = { colour: { props: ['whiteBalance', 'colorTemp'] }, look: { props: ['contrast'] } };
  inst.applyState(sampleView());

  await captured.actions.sceneRecall.callback({
    options: { scene: 'Interview', ramp: 2000, groups: ['colour'] },
  });
  assert.equal(sent[0].path, '/api/scenes/Interview');
  assert.equal(sent[0].body.transitionMs, 2000);
  assert.deepEqual(sent[0].body.only, ['whiteBalance', 'colorTemp']);

  // No groups selected means the whole scene, which the API expects as null.
  await captured.actions.sceneRecall.callback({
    options: { scene: 'Interview', ramp: 0, groups: [] },
  });
  assert.equal(sent[1].body.only, null);
});

test('dropdowns are only rebuilt when the camera set changes', () => {
  const { inst } = makeInstance();
  let rebuilds = 0;
  const realRebuild = inst.rebuildDefinitions.bind(inst);
  inst.rebuildDefinitions = () => { rebuilds += 1; realRebuild(); };

  inst.applyState(sampleView());
  assert.equal(rebuilds, 1);

  // An iris tweak must not rebuild definitions — that resets dropdowns under the
  // cursor of anyone editing a button in Companion at the time.
  const changed = sampleView();
  changed.cameras[0].properties.fNumber.raw = 560;
  inst.applyState(changed);
  assert.equal(rebuilds, 1);

  // Renaming a camera must, so the new name shows in every dropdown.
  const renamed = sampleView();
  renamed.cameras[0].label = 'Wide Left';
  inst.applyState(renamed);
  assert.equal(rebuilds, 2);
});

test('tally survives a state frame that does not carry it', () => {
  const { inst, captured } = makeInstance();
  inst.applyState(sampleView());
  // Tally arrives from the ATEM listener, on its own cadence.
  inst.cameras[0].tally = { program: true, preview: false };
  assert.equal(captured.feedbacks.tally.callback({ options: { camera: 'fx3', bus: 'program' } }), true);

  // An ordinary property update must not wipe it.
  inst.applyState(sampleView());
  assert.equal(captured.feedbacks.tally.callback({ options: { camera: 'fx3', bus: 'program' } }), true);
});

test('camera ids with hyphens become legal Companion variable ids', () => {
  // $(cambridge:fx30-a_iris) would not parse; the hyphen has to go.
  assert.equal(varId('fx30-a'), 'fx30_a');
  assert.equal(varId('FX3'), 'fx3');
});

test('recording variable distinguishes failed from idle', () => {
  const values = buildVariableValues([
    { id: 'a', label: 'A', state: 'connected', status: { recording: true, recordingFailed: false } },
    { id: 'b', label: 'B', state: 'connected', status: { recording: false, recordingFailed: true } },
  ]);
  assert.equal(values.a_recording, 'REC');
  // A camera that failed to record must never read as idle — that is the whole
  // point of the distinction.
  assert.equal(values.b_recording, 'FAILED');
  assert.equal(values.recording_count, 1);
});
