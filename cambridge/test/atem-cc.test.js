// ATEM Link decoding and mapping.
//
// Fed byte arrays rather than a switcher, the same way the tally parser's
// handlePacket is public so it can be tested without one.
//
// A caveat these tests cannot remove: they pin the decoder against the layout
// the decoder assumes. The Blackmagic *payload* semantics below are quoted from
// the published SDI Camera Control Protocol, so those are real; the ATEM's
// wrapper around them is a hypothesis until it is checked against a capture
// from the studio's own switcher. Passing here means the code does what it
// intends, not that the intention matches the hardware.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeCCdP, toCameraWrites, cameraForDestination, WriteCoalescer,
  normalisedApertureToFNumber, gainDbToIso, exposureUsToShutter,
  TYPE, FIXED16_SCALE, WRAPPER,
} from '../src/atem-cc.js';

/** Builds a CCdP body in the layout the decoder assumes. */
function ccdp({ destination = 1, category = 0, parameter = 3, relative = 0,
                dataType = TYPE.FIXED16, values = [] } = {}) {
  const sizes = {
    [TYPE.VOID]: 0, [TYPE.INT8]: 1, [TYPE.INT16]: 2,
    [TYPE.INT32]: 4, [TYPE.INT64]: 8, [TYPE.FIXED16]: 2,
  };
  const size = sizes[dataType] ?? 0;
  const body = Buffer.alloc(WRAPPER.values + Math.max(0, values.length * size));
  body.writeUInt8(destination, WRAPPER.destination);
  body.writeUInt8(category, WRAPPER.category);
  body.writeUInt8(parameter, WRAPPER.parameter);
  body.writeUInt8(relative, WRAPPER.relative);
  body.writeUInt8(dataType, WRAPPER.dataType);
  body.writeUInt8(values.length, WRAPPER.elementCount);
  values.forEach((v, i) => {
    const at = WRAPPER.values + i * size;
    if (dataType === TYPE.INT8) body.writeInt8(v, at);
    else if (dataType === TYPE.INT16) body.writeInt16BE(v, at);
    else if (dataType === TYPE.INT32) body.writeInt32BE(v, at);
    else if (dataType === TYPE.FIXED16) body.writeInt16BE(Math.round(v * FIXED16_SCALE), at);
  });
  return body;
}

const IRIS = [280, 320, 350, 400, 450, 500, 560, 630, 710, 800, 900, 1000, 1100, 1300, 1600, 2200];

function camera(over = {}) {
  return {
    id: 'fx3',
    label: 'Wide',
    state: 'connected',
    properties: {
      fNumber: { value: 400, writable: true, allowed: IRIS },
      isoSensitivity: { value: 800, writable: true, allowed: [200, 400, 800, 1600, 3200, 6400, 12800] },
      shutterSpeed: { value: (1 << 16) | 50, writable: true,
        allowed: [24, 30, 48, 50, 60, 100, 120, 250, 500, 1000].map((d) => (1 << 16) | d) },
      colorTemp: { value: 5600, writable: true, range: { min: 2500, max: 9900, step: 100 } },
      wbTint: { value: 0, writable: true, range: { min: -7, max: 7, step: 1 } },
      focusPosition: { value: 500, writable: true, range: { min: 0, max: 1000, step: 1 } },
      zoomPosition: { value: 0, writable: true, range: { min: 0, max: 1000, step: 1 } },
      ...(over.properties ?? {}),
    },
    ...over,
  };
}

// --- decoding ---------------------------------------------------------------

test('a fixed-point value decodes through the documented 5.11 scale', () => {
  // Type 128 is signed 5.11 fixed point, so eleven fractional bits.
  const d = decodeCCdP(ccdp({ dataType: TYPE.FIXED16, values: [0.5] }));
  assert.equal(d.ok, true);
  assert.equal(d.values[0], 0.5);
});

test('the raw bytes come back with every decode', () => {
  // The wrapper layout is unverified, so a decode that looks sensible next to a
  // hex dump that disagrees is the whole point of returning both.
  const d = decodeCCdP(ccdp({ destination: 3, values: [1] }));
  assert.match(d.raw, /^([0-9a-f]{2} )+[0-9a-f]{2}$/);
  assert.equal(d.destination, 3);
});

test('a truncated block is reported, not guessed at', () => {
  const d = decodeCCdP(Buffer.alloc(3));
  assert.equal(d.ok, false);
  assert.match(d.error, /too short/);
});

test('an empty or missing body does not throw', () => {
  assert.equal(decodeCCdP(null).ok, false);
  assert.equal(decodeCCdP(Buffer.alloc(0)).ok, false);
});

test('multi-value blocks decode every element', () => {
  // Manual white balance is two int16s: kelvin then tint.
  const d = decodeCCdP(ccdp({ category: 1, parameter: 2, dataType: TYPE.INT16, values: [3200, -4] }));
  assert.deepEqual(d.values, [3200, -4]);
});

test('a signed value stays signed', () => {
  const d = decodeCCdP(ccdp({ category: 1, parameter: 13, dataType: TYPE.INT8, values: [-6] }));
  assert.equal(d.values[0], -6);
});

test('a value count longer than the buffer reads only what is there', () => {
  // A malformed or truncated packet must not read past the end.
  const body = ccdp({ dataType: TYPE.INT16, values: [1, 2] });
  body.writeUInt8(50, WRAPPER.elementCount);
  const d = decodeCCdP(body);
  assert.equal(d.ok, true);
  assert.equal(d.values.length, 2);
});

// --- mapping ----------------------------------------------------------------

test('normalised aperture walks the body\'s own list, so one detent is one step', () => {
  // Blackmagic's normalised aperture is linear in aperture area, not stops.
  // Mapping it linearly onto f-numbers would make the top of the panel's travel
  // do almost nothing and the bottom jump several stops.
  assert.equal(normalisedApertureToFNumber(1, { allowed: IRIS }), 280, '1.0 = widest open');
  assert.equal(normalisedApertureToFNumber(0, { allowed: IRIS }), 2200, '0.0 = smallest');
  const middle = normalisedApertureToFNumber(0.5, { allowed: IRIS });
  assert.ok(middle > 280 && middle < 2200);
});

test('aperture is clamped rather than running off the list', () => {
  assert.equal(normalisedApertureToFNumber(5, { allowed: IRIS }), 280);
  assert.equal(normalisedApertureToFNumber(-3, { allowed: IRIS }), 2200);
});

test('a body with no aperture list yields nothing rather than a wrong value', () => {
  assert.equal(normalisedApertureToFNumber(0.5, { allowed: [] }), null);
  assert.equal(normalisedApertureToFNumber(0.5, null), null);
});

test('gain in dB maps onto the ISO list around the base sensitivity', () => {
  const prop = { allowed: [200, 400, 800, 1600, 3200, 6400] };
  assert.equal(gainDbToIso(0, prop), 800, '0 dB is base');
  assert.equal(gainDbToIso(6, prop), 1600, '+6 dB is one stop up');
  assert.equal(gainDbToIso(-6, prop), 400, '-6 dB is one stop down');
  assert.equal(gainDbToIso(12, prop), 3200);
});

test('exposure microseconds map to Sony\'s packed shutter', () => {
  // 1/50 is 20000us, and Sony packs numerator<<16 | denominator.
  const prop = { allowed: [24, 30, 48, 50, 60, 100].map((d) => (1 << 16) | d) };
  assert.equal(exposureUsToShutter(20_000, prop), (1 << 16) | 50);
  assert.equal(exposureUsToShutter(10_000, prop), (1 << 16) | 100);
  assert.equal(exposureUsToShutter(0, prop), null);
  assert.equal(exposureUsToShutter(-5, prop), null);
});

test('an iris move becomes an fNumber write', () => {
  const d = decodeCCdP(ccdp({ category: 0, parameter: 3, dataType: TYPE.FIXED16, values: [1] }));
  const { writes } = toCameraWrites(d, camera());
  assert.deepEqual(writes, [{ prop: 'fNumber', value: 280 }]);
});

test('white balance produces both kelvin and tint from one block', () => {
  const d = decodeCCdP(ccdp({ category: 1, parameter: 2, dataType: TYPE.INT16, values: [3200, -4] }));
  const { writes } = toCameraWrites(d, camera());
  assert.deepEqual(writes, [
    { prop: 'colorTemp', value: 3200 },
    { prop: 'wbTint', value: -4 },
  ]);
});

test('instantaneous autofocus becomes an action, not a property write', () => {
  const d = decodeCCdP(ccdp({ category: 0, parameter: 1, dataType: TYPE.VOID, values: [] }));
  const { writes } = toCameraWrites(d, camera());
  assert.deepEqual(writes, [{ action: 'autofocus' }]);
});

test('a control the camera has on Auto is skipped with the reason, not forced', () => {
  const cam = camera({ properties: { fNumber: { value: 400, writable: false, allowed: [] } } });
  const d = decodeCCdP(ccdp({ category: 0, parameter: 3, dataType: TYPE.FIXED16, values: [0.5] }));
  const { writes, skipped } = toCameraWrites(d, cam);
  assert.equal(writes.length, 0);
  assert.match(skipped[0].reason, /Auto/);
});

test('colour correction wheels are refused rather than approximated', () => {
  // Blackmagic's model is a lift/gamma/gain wheel per channel; Sony's Creative
  // Look is a few scalar trims. An approximate mapping would shift the look of
  // a camera that is on air in a way nobody asked for.
  for (const parameter of [0, 1, 2, 3, 4]) {
    const d = decodeCCdP(ccdp({ category: 8, parameter, dataType: TYPE.FIXED16, values: [0.2] }));
    const { writes, skipped } = toCameraWrites(d, camera());
    assert.equal(writes.length, 0);
    assert.match(skipped[0].reason, /no faithful Sony equivalent/);
  }
});

test('relative adjustments are refused rather than guessed', () => {
  const d = decodeCCdP(ccdp({ category: 0, parameter: 3, relative: 1, values: [0.1] }));
  const { writes, skipped } = toCameraWrites(d, camera());
  assert.equal(writes.length, 0);
  assert.match(skipped[0].reason, /relative/);
});

test('an unmapped control is reported, never silently dropped', () => {
  // A silent no-op looks like a broken panel; a logged skip teaches the
  // operator that the control is unsupported.
  const d = decodeCCdP(ccdp({ category: 4, parameter: 9, dataType: TYPE.INT8, values: [1] }));
  const { writes, skipped } = toCameraWrites(d, camera());
  assert.equal(writes.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /no mapping/);
});

test('an undecodable block produces no writes', () => {
  const { writes, skipped } = toCameraWrites(decodeCCdP(Buffer.alloc(2)), camera());
  assert.equal(writes.length, 0);
  assert.equal(skipped.length, 1);
});

// --- destination mapping ----------------------------------------------------

test('destinations resolve through the tally mapping, not a second one', () => {
  const mapping = { fx3: 1, 'fx30-a': 2, 'fx30-b': 3 };
  assert.equal(cameraForDestination(mapping, 2), 'fx30-a');
  assert.equal(cameraForDestination(mapping, '3'), 'fx30-b');
  assert.equal(cameraForDestination(mapping, 7), null, 'an input with no camera behind it');
  assert.equal(cameraForDestination(null, 1), null);
});

// --- coalescing -------------------------------------------------------------

test('a burst on one property collapses to its newest value', async () => {
  // A hardware wheel emits dozens of positions a second. Forwarding each queues
  // SDK writes the camera acknowledges one at a time, and a spinning wheel would
  // wedge a camera worker.
  const sent = [];
  const c = new WriteCoalescer((cameraId, prop, value) => {
    sent.push([cameraId, prop, value]);
  }, 20);

  for (let i = 0; i < 40; i++) c.submit('fx3', 'fNumber', 280 + i);
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(sent.length, 1, 'one write, not forty');
  assert.deepEqual(sent[0], ['fx3', 'fNumber', 319], 'and it is the newest value');
  c.stop();
});

test('different properties and cameras are not collapsed into each other', async () => {
  const sent = [];
  const c = new WriteCoalescer((cameraId, prop, value) => { sent.push(`${cameraId}.${prop}=${value}`); }, 20);
  c.submit('fx3', 'fNumber', 400);
  c.submit('fx3', 'colorTemp', 3200);
  c.submit('fx30-a', 'fNumber', 560);
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(sent.length, 3);
  assert.ok(sent.includes('fx3.fNumber=400'));
  assert.ok(sent.includes('fx3.colorTemp=3200'));
  assert.ok(sent.includes('fx30-a.fNumber=560'));
  c.stop();
});

test('stopping the coalescer drops what was pending', async () => {
  const sent = [];
  const c = new WriteCoalescer((id, p, v) => sent.push(v), 30);
  c.submit('fx3', 'fNumber', 400);
  c.stop();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sent.length, 0);
});
