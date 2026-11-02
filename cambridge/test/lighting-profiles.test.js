// Fixture profiles and the patch: percent/kelvin <-> DMX, and the errors a bad
// patch must produce rather than quietly repair.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  builtInProfiles, validateProfile, footprint, kelvinRange, encode, decode, kelvinToDmx, dmxToKelvin,
} from '../src/lighting/profiles.js';
import {
  SEED_FIXTURES, validatePatch, profileMap, validateCustomProfiles, groupNames, resolveTarget,
} from '../src/lighting/fixtures.js';

const lyra = builtInProfiles().find((p) => p.id === 'ikan-lyra-lbx8-poe-2ch');
const profiles = profileMap(builtInProfiles());

test('the built-in Lyra profile is valid, two channels, 3200–5600 K', () => {
  assert.ok(lyra, 'shipped');
  assert.deepEqual(validateProfile(lyra), []);
  assert.equal(footprint(lyra), 2);
  assert.deepEqual(kelvinRange(lyra), { min: 3200, max: 5600 });
  assert.equal(lyra.channels[1].curveVerified, false, 'the curve is marked as not checked with a meter');
});

test('the linear CCT curve matches the formula the current UI uses', () => {
  const cct = lyra.channels[1];
  for (const v of [0, 12, 64, 128, 200, 255]) {
    assert.ok(Math.abs(dmxToKelvin(cct, v) - (3200 + (v * 2400) / 255)) < 1e-9, `DMX ${v}`);
    assert.equal(kelvinToDmx(cct, dmxToKelvin(cct, v)), v, `round trip ${v}`);
  }
  assert.equal(kelvinToDmx(cct, 4400), 128);
  assert.equal(kelvinToDmx(cct, 2000), 0, 'below the range clamps to the warm end');
  assert.equal(kelvinToDmx(cct, 9000), 255, 'above clamps to the cool end');
});

test('the Studio look survives DMX -> state -> DMX exactly', () => {
  const look = [175, 12, 178, 12, 20, 12, 30, 12, 6, 12];
  for (let i = 0; i < 5; i++) {
    const dmx = look.slice(2 * i, 2 * i + 2);
    assert.deepEqual(encode(lyra, decode(lyra, dmx)), dmx);
  }
  const l1 = decode(lyra, [175, 12]);
  assert.ok(Math.abs(l1.intensity - 68.627) < 0.001);
  assert.ok(Math.abs(l1.cct - 3312.94) < 0.01);
});

test('a measured, non-linear curve is just more points', () => {
  const curved = {
    id: 'curved', name: 'Curved', channels: [
      { type: 'intensity' },
      { type: 'cct', curve: [[0, 2700], [100, 3200], [200, 5000], [255, 6500]] },
    ],
  };
  assert.deepEqual(validateProfile(curved), []);
  const cct = curved.channels[1];
  assert.equal(kelvinToDmx(cct, 3200), 100);
  assert.equal(kelvinToDmx(cct, 4100), 150);
  assert.equal(dmxToKelvin(cct, 50), 2950);
  // Kelvin falling as DMX rises is allowed too (some fixtures run cool to warm).
  const reversed = { ...curved, channels: [{ type: 'cct', curve: [[0, 6500], [255, 2700]] }] };
  assert.deepEqual(validateProfile(reversed), []);
  assert.equal(kelvinToDmx(reversed.channels[0], 6500), 0);
  assert.equal(kelvinToDmx(reversed.channels[0], 2700), 255);
});

test('16-bit, ranged and fixed channels encode as the profile says', () => {
  const p = {
    id: 'big', name: 'Big', channels: [
      { type: 'fixed', value: 7 },
      { type: 'intensity', size: 2 },
      { type: 'cct', curve: [[0, 2800], [65535, 6000]], size: 2 },
      { type: 'intensity-not' },
    ],
  };
  assert.match(validateProfile(p).join(), /channel 4: type must be one of/);
  p.channels.pop();
  assert.deepEqual(validateProfile(p), []);
  assert.equal(footprint(p), 5);
  assert.deepEqual(encode(p, { intensity: 100, cct: 2800 }), [7, 255, 255, 0, 0]);
  assert.deepEqual(encode(p, { intensity: 50, cct: 6000 }), [7, 128, 0, 255, 255]);
  const ranged = { id: 'r', name: 'R', channels: [{ type: 'intensity', dmx: [10, 200] }] };
  assert.deepEqual(encode(ranged, { intensity: 0 }), [10]);
  assert.deepEqual(encode(ranged, { intensity: 100 }), [200]);
});

test('profile mistakes are named, never fixed', () => {
  const bad = (channels, more = {}) => validateProfile({ id: 'x', name: 'X', channels, ...more });
  assert.match(bad([]).join(), /at least one channel/);
  assert.match(bad([{ type: 'cct', curve: [[0, 3200]] }]).join(), /at least two/);
  assert.match(bad([{ type: 'cct', curve: [[10, 3200], [5, 5600]] }]).join(), /DMX values must rise/);
  assert.match(bad([{ type: 'cct', curve: [[0, 3200], [100, 5600], [255, 4000]] }]).join(), /kelvin must rise/);
  assert.match(bad([{ type: 'intensity' }, { type: 'intensity' }]).join(), /at most one intensity/);
  assert.match(bad([{ type: 'fixed', value: 300 }]).join(), /fixed channel needs a value/);
  assert.match(validateProfile({ id: 'Bad Id', name: '', channels: [{ type: 'intensity' }] }).join(), /id must be.*name is required/);
});

test('the seed patch is the studio\'s five Lyras and is valid', () => {
  assert.deepEqual(SEED_FIXTURES.map((f) => [f.name, f.ip, f.universe, f.address]), [
    ['L1', '192.168.220.51', 1, 1],
    ['L2', '192.168.220.52', 1, 3],
    ['L3', '192.168.220.53', 1, 5],
    ['L4', '192.168.220.54', 1, 7],
    ['L5', '192.168.220.55', 1, 9],
  ]);
  assert.deepEqual(validatePatch(SEED_FIXTURES, profiles), []);
});

test('overlapping addresses are an error on both fixtures', () => {
  const patch = SEED_FIXTURES.map((f) => ({ ...f }));
  patch[1].address = 2;   // L2 now 2–3, over L1 (1–2) and L3 starts at 5
  const errors = validatePatch(patch, profiles);
  assert.deepEqual(errors.map((e) => e.fixture).sort(), ['l1', 'l2']);
  assert.match(errors[0].message, /L1 \(1–2\) and L2 \(2–3\) overlap in universe 1/);
  // The same addresses in another universe are fine.
  patch[1].universe = 2;
  assert.deepEqual(validatePatch(patch, profiles), []);
});

test('out-of-range addresses, duplicate names and bad fields are errors', () => {
  const f = (over) => ({ ...SEED_FIXTURES[0], ...over });
  const fields = (patch) => validatePatch(patch, profiles).map((e) => `${e.fixture}:${e.field}`);
  assert.deepEqual(fields([f({ address: 512 })]), ['l1:address'], 'two channels from 512 run past the end');
  assert.deepEqual(fields([f({ address: 0 })]), ['l1:address']);
  assert.deepEqual(fields([f({ universe: 0 })]), ['l1:universe']);
  assert.deepEqual(fields([f({ ip: '192.168.220' })]), ['l1:ip']);
  assert.deepEqual(fields([f({ ip: '239.255.0.1' })]), ['l1:ip'], 'a multicast group is not a fixture');
  assert.deepEqual(fields([f({ profile: 'nope' })]), ['l1:profile']);
  assert.deepEqual(fields([f({}), f({ id: 'l1b', name: 'l1', address: 3 })]), ['l1b:name'], 'names differ only in case');
  assert.deepEqual(fields([f({}), f({ name: 'Other', address: 3 })]), ['l1:id']);
  assert.deepEqual(fields([f({ groups: ['All'] })]), ['l1:groups']);
});

test('custom profiles may not take a built-in id', () => {
  const builtIns = builtInProfiles();
  const errors = validateCustomProfiles([{ ...lyra, name: 'Mine' }], builtIns);
  assert.match(errors[0].message, /already a built-in profile/);
});

test('groups and targets', () => {
  const patch = SEED_FIXTURES.map((x, i) => ({ ...x, groups: i < 2 ? ['Key'] : ['Fill'] }));
  assert.deepEqual(groupNames(patch), ['All', 'Key', 'Fill']);
  assert.deepEqual(resolveTarget(patch, { group: 'key' }).map((x) => x.id), ['l1', 'l2']);
  assert.deepEqual(resolveTarget(patch, { group: 'All' }).length, 5);
  assert.deepEqual(resolveTarget(patch, {}).length, 5);
  assert.deepEqual(resolveTarget(patch, { fixture: 'L3' }).map((x) => x.id), ['l3'], 'by name');
  assert.deepEqual(resolveTarget(patch, { fixture: 'l4' }).map((x) => x.id), ['l4'], 'by id');
  assert.equal(resolveTarget(patch, { fixture: 'L9' }), null);
  assert.equal(resolveTarget(patch, { group: 'Back' }), null);
});
