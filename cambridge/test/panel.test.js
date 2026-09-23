// Panel logic behind CS1, CS2 and the lower-priority UI observations of the
// 2026-09-23 audit. The browser panel's decisions live in small pure modules
// (public/scopes.js, public/panel-logic.js) so they can be tested here; DOM
// wiring in app.js only applies them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { histogram, clipStats, applyFalseColour, markClipping, buildFalseColourLut, measureThenOverlay } from '../public/scopes.js';
import { tileModel, recordActionFor, feedHealth, recordAllOutcome, stepOption, gamepadTarget } from '../public/panel-logic.js';
import { createGamepadControl } from '../public/gamepad.js';

/** 100 pixels: 40 pure white (clipped), 30 pure black (crushed), 30 mid grey. */
function frame() {
  const px = [];
  for (let i = 0; i < 40; i++) px.push(255, 255, 255, 255);
  for (let i = 0; i < 30; i++) px.push(0, 0, 0, 255);
  for (let i = 0; i < 30; i++) px.push(128, 128, 128, 255);
  return new Uint8ClampedArray(px);
}

// --- CS2 -------------------------------------------------------------------

test('CS2: the audited order (overlay, then measure) hides real clipping', () => {
  const data = frame();
  markClipping(data);                       // what drawFrame did first
  const after = clipStats(data, { step: 1 });
  const truth = clipStats(frame(), { step: 1 });
  assert.ok(truth.over > 0.3, 'the source really is clipped');
  assert.ok(after.over < truth.over, 'measuring the recoloured pixels under-reports clipping');
});

for (const mode of ['clip', 'false']) {
  test(`CS2: scopes are measured from the original pixels with the ${mode} overlay on`, () => {
    const data = frame();
    const truthHist = histogram(frame());
    const truthClip = clipStats(frame());
    const out = measureThenOverlay(data, { mode, measure: true, histogram: true, clipReadout: true, lut: buildFalseColourLut() });
    assert.deepEqual(out.clip, truthClip);
    assert.deepEqual([...out.hist], [...truthHist]);
    assert.ok(out.overlaid, 'the overlay is still drawn');
    assert.notDeepEqual([...data], [...frame()], 'pixels were recoloured for display');
  });
}

test('CS2: nothing is measured on frames between scope updates', () => {
  const out = measureThenOverlay(frame(), { mode: 'off', measure: false, histogram: true, clipReadout: true });
  assert.equal(out.hist, undefined);
  assert.equal(out.clip, undefined);
});

// --- CS1: tiles follow current camera data ----------------------------------

const cam = (over = {}) => ({ id: 'a', label: 'Wide', state: 'connected', status: { recording: false }, capabilities: { record: { available: true } }, properties: { fNumber: { label: 'f/4' } }, ...over });

test('CS1: a tile model tracks idle -> recording -> idle without rebuilding', () => {
  const idle = tileModel(cam());
  assert.equal(idle.recording, false);
  assert.equal(idle.recordButton.action, 'recordStart');
  const rolling = tileModel(cam({ status: { recording: true }, tally: { program: true } }));
  assert.equal(rolling.recording, true);
  assert.equal(rolling.recordButton.action, 'recordStop');
  assert.match(rolling.className, /recording/);
  assert.match(rolling.className, /pgm/);
  const back = tileModel(cam({ label: 'Renamed', properties: { fNumber: { label: 'f/5.6' } } }));
  assert.equal(back.recordButton.action, 'recordStart');
  assert.equal(back.label, 'Renamed');
  assert.equal(back.fNumber, 'f/5.6');
  const blocked = tileModel(cam({ capabilities: { record: { available: false, reason: 'no card' } } }));
  assert.equal(blocked.recordButton.disabled, true);
  assert.equal(blocked.recordButton.title, 'no card');
});

test('CS1: the record button acts on the camera as it is at click time', () => {
  let current = [cam()];
  const getCameras = () => current;
  current = [cam({ status: { recording: true } })];   // started from elsewhere after the tile was built
  assert.equal(recordActionFor('a', getCameras), 'recordStop');
  current = [cam({ status: { recording: false } })];
  assert.equal(recordActionFor('a', getCameras), 'recordStart');
  current = [cam({ state: 'offline' })];
  assert.equal(recordActionFor('a', getCameras), null, 'no command to a camera that is not connected');
  assert.equal(recordActionFor('gone', getCameras), null);
});

// --- preview recovery -------------------------------------------------------

test('preview hidden after repeated failures reappears on the next good frame', () => {
  const h = feedHealth(10);
  for (let i = 0; i < 9; i++) assert.equal(h.fail(), null);
  assert.equal(h.fail(), 'hide');
  assert.equal(h.fail(), null, 'hidden once, not on every further failure');
  assert.equal(h.ok(), 'show');
  assert.equal(h.ok(), null);
});

// --- Record all -------------------------------------------------------------

test('Record all never reports success for an empty or failed result', () => {
  assert.equal(recordAllOutcome({ ok: false, results: [] }, true).level, 'bad');
  assert.equal(recordAllOutcome({ ok: true, results: [] }, true).level, 'bad', 'zero cameras is not "all recording"');
  assert.equal(recordAllOutcome({}, true).level, 'bad');
  assert.equal(recordAllOutcome({ httpOk: false, error: 'x' }, false).level, 'bad');
  const partial = recordAllOutcome({ ok: false, results: [{ cameraId: 'a', ok: true }, { cameraId: 'b', ok: false }] }, true);
  assert.equal(partial.level, 'bad');
  assert.match(partial.message, /b/);
  const good = recordAllOutcome({ ok: true, results: [{ cameraId: 'a', ok: true }, { cameraId: 'b', ok: true }] }, false);
  assert.equal(good.level, 'ok');
  assert.match(good.message, /2 cameras stopped/);
});

// --- stepper refusal --------------------------------------------------------

test('stepping from an off-list value is refused, like the gamepad and Companion', () => {
  const options = [280, 400, 560].map((raw) => ({ raw }));
  assert.equal(stepOption(options, 400, 1)?.raw, 560);
  assert.equal(stepOption(options, 560, 1), null, 'no wrap past the end');
  assert.equal(stepOption(options, 450, 1), null, 'an unknown current value does not jump to the first entry');
});

// --- gamepad target ---------------------------------------------------------

test('a gamepad never silently moves to another camera', () => {
  const cams = [cam({ id: 'a' }), cam({ id: 'b' })];
  assert.equal(gamepadTarget('b', cams)?.id, 'b');
  assert.equal(gamepadTarget('b', [cams[0], cam({ id: 'b', state: 'offline' })]), null, 'lost target is not replaced by the first connected body');
  assert.equal(gamepadTarget(null, cams), null, 'no chosen camera means nothing is driven');
});

test('unplugging the gamepad disarms control so replugging does not resume it', () => {
  let pads = [{ id: 'pad', connected: true, axes: [0, 0, 0, 0], buttons: [] }];
  const statuses = [];
  let frameCb = null;
  globalThis.navigator ??= {};
  const nav = globalThis.navigator;
  const originalGet = nav.getGamepads;
  Object.defineProperty(nav, 'getGamepads', { value: () => pads, configurable: true });
  globalThis.requestAnimationFrame = (cb) => { frameCb = cb; return 1; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const g = createGamepadControl({ onStep() {}, onButton() {}, onStatus: (s) => statuses.push(s) });
    g.start();
    frameCb(0);
    g.setEnabled(true);
    pads = [];
    frameCb(16);
    assert.equal(g.enabled, false);
    assert.equal(statuses.at(-1).disarmed, true);
    pads = [{ id: 'pad', connected: true, axes: [0, -1, 0, 0], buttons: [] }];
    frameCb(32);
    assert.equal(g.enabled, false, 'replugging requires switching control on again');
    g.stop();
  } finally {
    if (originalGet) Object.defineProperty(nav, 'getGamepads', { value: originalGet, configurable: true });
    delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame;
  }
});
