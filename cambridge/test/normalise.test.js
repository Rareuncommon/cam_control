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

// --- values read off a real ILME-FX30, 2026-07-26 --------------------------

test('decodes the exposure mode a real FX30 reported', async () => {
  const { exposureModeToLabel } = await import('../src/normalise.js');
  // 32853 = 0x8055. The camera arrived in Movie Flexible Exposure, which is why
  // iris and ISO came back read-only.
  assert.equal(exposureModeToLabel(32853), 'Movie Flexible');
  assert.equal(exposureModeToLabel(0x8053), 'Movie M');
  assert.equal(exposureModeToLabel(1), 'M');
  assert.equal(exposureModeToLabel(0x8000), 'Auto');
  // Unknown values must print recognisably, not silently as decimal.
  assert.match(exposureModeToLabel(0x9999), /0x9999/);
});

test('decodes the white balance values a real FX30 offered', async () => {
  const { whiteBalanceToLabel } = await import('../src/normalise.js');
  assert.equal(whiteBalanceToLabel(256), 'Colour Temp.');  // what it was set to
  assert.equal(whiteBalanceToLabel(17), 'Daylight');
  assert.equal(whiteBalanceToLabel(20), 'Tungsten');
  assert.equal(whiteBalanceToLabel(33), 'Fluor. Warm White');
  assert.equal(whiteBalanceToLabel(257), 'Custom 1');
});

test('focus modes are one-indexed, not zero-indexed', async () => {
  const { focusModeToLabel } = await import('../src/normalise.js');
  // The FX30 reported focusMode 3 with [3, 1] available. An earlier zero-indexed
  // guess would have called AF-C "AF-A" and MF "AF-S".
  assert.equal(focusModeToLabel(3), 'AF-C');
  assert.equal(focusModeToLabel(1), 'MF');
});

test('shutter values from the real camera decode correctly', async () => {
  const { shutterToLabel } = await import('../src/normalise.js');
  // Straight from the FX30's reported list.
  assert.equal(shutterToLabel(65596), '1/60');   // what it was set to
  assert.equal(shutterToLabel(65540), '1/4');
  assert.equal(shutterToLabel(73536), '1/8000');
});

test('auto/manual gates decode and explain a read-only control', async () => {
  const { autoManualToLabel, readOnlyReason, AUTO, MANUAL } = await import('../src/normalise.js');
  assert.equal(autoManualToLabel(1), 'Auto');
  assert.equal(autoManualToLabel(2), 'Manual');

  // With iris on Auto, the UI should explain rather than just grey out.
  const props = { irisMode: { raw: AUTO }, gainMode: { raw: MANUAL } };
  const reason = readOnlyReason('fNumber', props);
  assert.ok(reason);
  assert.match(reason.message, /Iris is set to Auto/);
  assert.equal(reason.fixTo, MANUAL);
  // Gain is already Manual, so there is nothing to explain there.
  assert.equal(readOnlyReason('isoSensitivity', props), null);
  assert.equal(readOnlyReason('colorTemp', props), null);
});
