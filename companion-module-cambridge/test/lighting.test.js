// Lighting through the module: what each action sends CamBridge, the
// variables and feedbacks a lighting view produces, and the presets that
// rebuild Companion's old lighting pages.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CambridgeInstance } from '../src/index.js';
import { NUDGE_PCT, NUDGE_K, parseTarget, savedText, outputIs } from '../src/lighting.js';

if (typeof process.send !== 'function') process.send = () => true;

function makeInstance() {
  const captured = { actions: {}, feedbacks: {}, presets: {}, variableDefs: [], variables: {}, writes: [], rebuilds: 0, calls: [] };
  const inst = new CambridgeInstance({ id: 'test', _isInstanceBaseProps: true, label: 'cambridge' });
  inst.setActionDefinitions = (a) => { captured.actions = a; captured.rebuilds += 1; };
  inst.setFeedbackDefinitions = (f) => { captured.feedbacks = f; };
  inst.setPresetDefinitions = (p) => { captured.presets = p; };
  inst.setVariableDefinitions = (v) => { captured.variableDefs = v; };
  inst.setVariableValues = (v) => { captured.writes.push(v); Object.assign(captured.variables, v); };
  inst.updateStatus = () => {};
  inst.log = () => {};
  inst.checkFeedbacks = () => {};
  inst.api = { request: async (method, path, body) => { captured.calls.push([method, path, body]); return { ok: true, status: 200, body: {} }; } };
  return { inst, captured };
}

const K12 = 3200 + 12 * 2400 / 255;
const STUDIO = [175, 178, 20, 30, 6];

/** A lighting view in the shape GET /api/lighting and the stream carry. */
function lightingView({ state = 'dry-run', active = { type: 'look', id: 'studio' }, l1 = STUDIO[0] / 2.55 } = {}) {
  return {
    output: { state, enabled: state !== 'off', dryRun: state === 'dry-run', waitingForState: false, mode: 'unicast' },
    known: true,
    fading: false,
    fixtures: STUDIO.map((d, i) => ({
      id: `l${i + 1}`, name: `L${i + 1}`, profile: 'ikan-lyra-lbx8-poe-2ch', ip: `192.168.220.5${i + 1}`, universe: 1, address: i * 2 + 1,
      groups: i < 2 ? ['Key'] : [], footprint: 2, kelvin: { min: 3200, max: 5600 }, live: true,
      intensity: i === 0 ? l1 : d / 2.55, cct: K12, target: null, dmx: [i === 0 ? Math.round(l1 * 2.55) : d, 12], errors: [],
    })),
    groups: ['All', 'Key'],
    scenes: [1, 2, 3, 4, 5].map((slot) => (slot === 1
      ? { slot, name: 'Interview', savedAt: new Date().toISOString(), note: null, empty: false }
      : { slot, name: `Scene ${slot}`, savedAt: null, note: null, empty: true })),
    looks: [{ id: 'studio', name: 'Studio look', protected: true }, { id: 'off', name: 'Studio off', protected: true }],
    active,
    errors: [],
    profiles: [{ id: 'ikan-lyra-lbx8-poe-2ch', name: 'Ikan Lyra LBX8-POE — 2-channel', builtIn: true }],
  };
}

const frame = (lighting) => ({ view: { camdConnected: true, cameras: [] }, alarms: [], lighting });

test('actions send what CamBridge expects', async () => {
  const { inst, captured } = makeInstance();
  inst.applyState(frame(lightingView()));
  const run = (id, options) => captured.actions[id].callback({ options });

  await run('lightSet', { target: 'all', what: 'intensity', intensity: 100, cct: 4400, fadeMs: 1000 });
  await run('lightSet', { target: 'group:Key', what: 'both', intensity: 50, cct: 5600, fadeMs: 0 });
  await run('lightNudge', { target: 'fixture:l1', param: 'cct', amount: -NUDGE_K, fadeMs: 0 });
  await run('lightNudge', { target: 'all', param: 'intensity', amount: NUDGE_PCT, fadeMs: 0 });
  await run('lightSceneRecall', { slot: 3, fadeMs: 1000 });
  await run('lightSceneSave', { slot: 3 });
  await run('lightLook', { look: 'off', fadeMs: 1000 });
  await run('lightOutput', { mode: 'toggle' });
  await run('lightIdentify', { fixture: 'l2' });
  assert.deepEqual(captured.calls, [
    ['POST', '/api/lighting/set', { target: { all: true }, fadeMs: 1000, intensity: 100 }],
    ['POST', '/api/lighting/set', { target: { group: 'Key' }, fadeMs: 0, intensity: 50, cct: 5600 }],
    ['POST', '/api/lighting/set', { target: { fixture: 'l1' }, cct: -300, relative: true, fadeMs: 0 }],
    ['POST', '/api/lighting/set', { target: { all: true }, intensity: 10.2, relative: true, fadeMs: 0 }],
    ['POST', '/api/lighting/scenes/3/recall', { fadeMs: 1000 }],
    ['PUT', '/api/lighting/scenes/3', {}],
    ['POST', '/api/lighting/looks/off/recall', { fadeMs: 1000 }],
    ['PUT', '/api/lighting/output', { enabled: false }],
    ['POST', '/api/lighting/fixtures/l2/identify', { ms: 3000 }],
  ]);
  assert.deepEqual(captured.actions.lightSet.options[0].choices.map((c) => c.id),
    ['all', 'group:Key', 'fixture:l1', 'fixture:l2', 'fixture:l3', 'fixture:l4', 'fixture:l5']);
  assert.equal(captured.actions.lightSceneRecall.options[0].choices[0].label, '1 — Interview');
  assert.deepEqual(parseTarget(undefined), { all: true });
});

test('a ±10.2 % nudge is exactly the old ±26 DMX step, from any level', () => {
  for (let v = 0; v <= 255; v++) {
    const up = Math.round(Math.min(100, v / 2.55 + NUDGE_PCT) * 2.55);
    const down = Math.round(Math.max(0, v / 2.55 - NUDGE_PCT) * 2.55);
    assert.equal(up, Math.min(255, v + 26), `up from ${v}`);
    assert.equal(down, Math.max(0, v - 26), `down from ${v}`);
  }
});

test('variables: per light, per scene, output and what is showing', () => {
  const { inst, captured } = makeInstance();
  inst.applyState(frame(lightingView()));
  const v = captured.variables;
  assert.equal(v.light_l1_pct, 69);
  assert.equal(v.light_l1_k, 3313);
  assert.equal(v.light_l1_dmx, '175 12');
  assert.equal(v.light_l5_name, 'L5');
  assert.equal(v.light_all_pct, Math.round(STUDIO.reduce((a, b) => a + b / 2.55, 0) / 5));
  assert.equal(v.light_scene1_name, 'Interview');
  assert.match(String(v.light_scene1_saved), /^\d\d:\d\d$/);
  assert.equal(v.light_scene2_saved, 'empty');
  assert.equal(v.light_output, 'dry run');
  assert.equal(v.light_active, 'Studio look');
  const ids = new Set(captured.variableDefs.map((d) => d.variableId));
  for (const k of Object.keys(v).filter((k) => k.startsWith('light_'))) assert.ok(ids.has(k), `${k} is defined`);
  assert.equal(savedText({ empty: false, savedAt: '2026-10-28T10:00:00Z' }, new Date('2026-11-02T10:00:00Z')), '28 Oct');
});

test('feedbacks: the scene or look showing, empty slots, and the output state', () => {
  const { inst, captured } = makeInstance();
  inst.applyState(frame(lightingView({ active: { type: 'scene', slot: 1 } })));
  const fb = (id, options) => captured.feedbacks[id].callback({ options });
  assert.equal(fb('lightSceneActive', { slot: 1 }), true);
  assert.equal(fb('lightSceneActive', { slot: 2 }), false);
  assert.equal(fb('lightLookActive', { look: 'studio' }), false);
  assert.equal(fb('lightSceneEmpty', { slot: 2 }), true);
  assert.equal(fb('lightOutput', { state: 'dry-run' }), true);
  assert.equal(fb('lightOutput', { state: 'sending' }), false);
  const l = lightingView({ state: 'sending' });
  assert.equal(outputIs(l, 'sending'), true);
  assert.equal(outputIs({ ...l, output: { ...l.output, waitingForState: true } }, 'waiting'), true);
  assert.equal(outputIs({ ...l, output: { ...l.output, state: 'error' } }, 'problem'), true);
});

test('presets rebuild pages 5, 12 and 13, and only use what the module defines', () => {
  const { inst, captured } = makeInstance();
  inst.applyState(frame(lightingView()));
  const presets = captured.presets;
  const cats = new Set(Object.values(presets).map((p) => p.category));
  for (const c of ['Lighting — page 5: on/off and Studio look', 'Lighting — page 12: dimmers, colour and scenes', 'Lighting — page 13: warmer / cooler', 'Lighting — output']) {
    assert.ok(cats.has(c), c);
  }
  for (const id of ['light_on', 'light_off', 'light_studio', 'light_studio_off', 'light_all_down', 'light_all_up', 'light_cct_3200', 'light_cct_4400',
    'light_cct_5600', 'light_l1_down', 'light_l5_up', 'light_l3_k', 'light_scene1', 'light_scene5', 'light_all_warmer', 'light_all_cooler',
    'light_l2_warmer', 'light_l4_cooler', 'light_output', 'light_output_on', 'light_output_off']) {
    assert.ok(presets[id], id);
  }
  assert.match(presets.light_l1_up.style.text, /\$\(cambridge:light_l1_pct\)/);
  assert.deepEqual(presets.light_output.steps, [{ down: [], up: [] }], 'the output status key does nothing when pressed');

  // Tap to recall, hold 5 s to save.
  const scene = presets.light_scene2.steps[0];
  assert.deepEqual(scene.down, []);
  assert.deepEqual(scene.up, [{ actionId: 'lightSceneRecall', options: { slot: 2, fadeMs: 1000 } }]);
  assert.deepEqual(scene[5000], { options: { runWhileHeld: true }, actions: [{ actionId: 'lightSceneSave', options: { slot: 2 } }] });

  const vars = new Set(captured.variableDefs.map((d) => d.variableId));
  for (const [id, p] of Object.entries(presets).filter(([k]) => k.startsWith('light_'))) {
    for (const step of p.steps) {
      const groups = [step.down, step.up, ...Object.entries(step).filter(([k]) => /^\d+$/.test(k)).map(([, g]) => g.actions)];
      for (const a of groups.flat()) assert.ok(captured.actions[a.actionId], `${id}: action ${a.actionId}`);
    }
    for (const f of p.feedbacks) assert.ok(captured.feedbacks[f.feedbackId], `${id}: feedback ${f.feedbackId}`);
    for (const [, name] of p.style.text.matchAll(/\$\(cambridge:([a-z0-9_]+)\)/g)) assert.ok(vars.has(name), `${id}: variable ${name}`);
  }
});

test('a fade moves the readouts without rebuilding; an unchanged lighting view writes nothing', () => {
  const { inst, captured } = makeInstance();
  const f1 = frame(lightingView());
  inst.applyState(f1);
  const rebuilds = captured.rebuilds;
  inst.applyState(frame(lightingView({ l1: 40 })));
  assert.equal(captured.rebuilds, rebuilds, 'levels are not definitions');
  assert.equal(captured.variables.light_l1_pct, 40);
  const same = { ...f1, lighting: inst.lighting };
  captured.writes.length = 0;
  inst.applyState(same);
  assert.ok(captured.writes.every((w) => !Object.keys(w).some((k) => k.startsWith('light_'))), 'no lighting writes without a change');
});

test('link lost: lighting is unknown, not "off", and no key claims a scene', () => {
  const { inst, captured } = makeInstance();
  inst.applyState(frame(lightingView({ active: { type: 'scene', slot: 1 } })));
  inst.markStale();
  assert.equal(captured.variables.light_output, 'unknown');
  assert.equal(captured.feedbacks.lightSceneActive.callback({ options: { slot: 1 } }), false);
  assert.equal(captured.feedbacks.lightOutput.callback({ options: { state: 'off' } }), false);
});

test('a CamBridge without lighting gets the actions but no lighting buttons', () => {
  const { inst, captured } = makeInstance();
  inst.applyState(frame(undefined));
  assert.ok(captured.actions.lightSet);
  assert.ok(!Object.keys(captured.presets).some((k) => k.startsWith('light_')));
});

test('the real CamBridge lighting view drives the same variables and feedbacks', async (t) => {
  let Lighting;
  try { ({ Lighting } = await import('../../cambridge/src/lighting/service.js')); } catch {
    t.skip('cambridge is not beside the module');
    return;
  }
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'cb-module-'));
  const cfg = { lighting: { output: { enabled: true, dryRun: true } } };
  const L = new Lighting({
    readConfig: () => structuredClone(cfg), writeConfig: () => {}, storePath: join(dir, 'state.json'),
    outputOptions: { networkInterfaces: () => ({}), createSocket: () => { throw new Error('no network'); } },
  });
  t.after(() => { L.stop(); rmSync(dir, { recursive: true, force: true }); });
  L.recallLook('studio');
  L.set({ target: { all: true }, intensity: 0 });
  L.recallLook('studio');
  L.saveScene(2, { name: 'Panel' });

  const { inst, captured } = makeInstance();
  inst.applyState(frame(L.view()));
  assert.equal(captured.variables.light_l2_dmx, '178 12');
  assert.equal(captured.variables.light_scene2_name, 'Panel');
  assert.equal(captured.variables.light_output, 'dry run');
  assert.equal(captured.feedbacks.lightLookActive.callback({ options: { look: 'studio' } }), true);
  assert.ok(captured.presets.light_l5_up && captured.presets.light_scene5);
});
