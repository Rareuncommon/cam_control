import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fNumberToLabel, isoToLabel, isoValue, shutterToLabel, shutterSeconds,
  colorTempToLabel, tintToLabel, recordingStateToLabel, RECORDING_STATE,
  decorate, nearestOption, sharesRawScale, label,
} from '../src/normalise.js';

test('f-number decodes the x100 encoding', () => {
  assert.equal(fNumberToLabel(400), 'f/4.0');
  assert.equal(fNumberToLabel(280), 'f/2.8');
  assert.equal(fNumberToLabel(1600), 'f/16');
  assert.equal(fNumberToLabel(0), '—');
});

test('ISO splits the mode byte from the value', () => {
  assert.equal(isoToLabel(800), 'ISO 800');
  assert.equal(isoValue(800), 800);
  // Top byte set means an auto variant; the value still reads out of the low bits.
  assert.equal(isoToLabel((1 << 24) | 1600), 'ISO 1600 (auto)');
  assert.equal(isoValue((1 << 24) | 1600), 1600);
  assert.equal(isoToLabel(0), 'ISO AUTO');
});

test('shutter decodes numerator<<16 | denominator', () => {
  assert.equal(shutterToLabel((1 << 16) | 50), '1/50');
  assert.equal(shutterToLabel((1 << 16) | 4000), '1/4000');
  // Whole seconds appear as n/1.
  assert.equal(shutterToLabel((2 << 16) | 1), '2"');
  assert.equal(shutterSeconds((1 << 16) | 50), 0.02);
  assert.equal(shutterToLabel(0), '—');
});

test('colour temperature and tint format for display', () => {
  assert.equal(colorTempToLabel(5600), '5600K');
  assert.equal(tintToLabel(0), '0');
  assert.equal(tintToLabel(3), '+3');
  assert.equal(tintToLabel(-2), '-2');
});

test('recording state names the failure case explicitly', () => {
  assert.equal(recordingStateToLabel(RECORDING_STATE.RECORDING), 'recording');
  assert.equal(recordingStateToLabel(RECORDING_STATE.NOT_RECORDING), 'idle');
  // This is the one the UI must never render as a calm green dot.
  assert.equal(recordingStateToLabel(RECORDING_STATE.FAILED), 'FAILED');
});

test('labellers never throw on unexpected values', () => {
  // A surprising raw value should degrade to something printable, not crash the
  // panel mid-service.
  for (const v of [undefined, null, NaN, -1, 999999, 'x']) {
    assert.doesNotThrow(() => label('fNumber', v));
    assert.doesNotThrow(() => label('isoSensitivity', v));
    assert.doesNotThrow(() => label('shutterSpeed', v));
    assert.doesNotThrow(() => label('unknownProperty', v));
  }
});

test('decorate keeps raw values alongside labels', () => {
  const d = decorate('fNumber', { value: 400, writable: true, allowed: [280, 400, 560] });
  assert.equal(d.raw, 400);
  assert.equal(d.label, 'f/4.0');
  assert.equal(d.writable, true);
  assert.deepEqual(d.options.map((o) => o.label), ['f/2.8', 'f/4.0', 'f/5.6']);
});

test('nearestOption snaps to enumerated values', () => {
  const prop = { allowed: [280, 320, 400, 560] };
  assert.equal(nearestOption(prop, 410), 400);
  assert.equal(nearestOption(prop, 330), 320);
  assert.equal(nearestOption(prop, 10_000), 560);
});

test('nearestOption breaks exact ties deterministically', () => {
  // 300 sits exactly between 280 and 320. Which one is chosen matters less than
  // it being the same every time — gang and match both rely on the same input
  // producing the same output across cameras and runs.
  const prop = { allowed: [280, 320, 400] };
  assert.equal(nearestOption(prop, 300), 280);
  assert.equal(nearestOption({ allowed: [400, 320, 280] }, 300), 280);
});

test('nearestOption clamps and steps ranges', () => {
  const prop = { range: { min: 2500, max: 9900, step: 100 } };
  assert.equal(nearestOption(prop, 5640), 5600);
  assert.equal(nearestOption(prop, 100), 2500);
  assert.equal(nearestOption(prop, 99_999), 9900);
});

test('sharesRawScale distinguishes physical from per-sensor properties', () => {
  // Aperture and Kelvin mean the same thing on both bodies; ISO does not, because
  // the FX30 is Super 35 and its table starts higher.
  assert.equal(sharesRawScale('fNumber'), true);
  assert.equal(sharesRawScale('colorTemp'), true);
  assert.equal(sharesRawScale('isoSensitivity'), false);
  assert.equal(sharesRawScale('shutterSpeed'), false);
});
