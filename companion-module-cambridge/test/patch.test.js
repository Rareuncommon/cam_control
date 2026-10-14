// The patch merge is a copy of cambridge/public/patch.js. The copy has to stay
// identical — a module that merges patches differently from the panel shows a
// Stream Deck a different camera state — so that is the first thing checked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyPatch } from '../src/patch.js';

test('the module carries the panel\'s patch merge, unchanged', () => {
  const here = (p) => fileURLToPath(new URL(p, import.meta.url));
  assert.equal(readFileSync(here('../src/patch.js'), 'utf8'), readFileSync(here('../../cambridge/public/patch.js'), 'utf8'));
});

const base = () => ({
  type: 'state',
  view: { camdConnected: true, camdUsed: false, cameras: [
    { id: 'a', kind: 'ptz', state: 'connected', ptz: { pan: 0.5 }, properties: { gain: { raw: 0, label: '0 dB' }, iris: { raw: 4, label: '4' } } },
    { id: 'b', kind: 'ptz', state: 'connected', ptz: { pan: 0.1 }, properties: {} },
  ] },
  alarms: [],
});

test('a patch changes only what it names, and replaces changed cameras by identity', () => {
  const f = base();
  const r = applyPatch(f, {
    type: 'patch', view: { camdConnected: false },
    cameras: { a: { ptz: { pan: 0.7, moving: true }, properties: { gain: { raw: 6, label: '6 dB' } } } },
    alarms: [{ code: 'x' }],
  });
  assert.equal(r.resync, false);
  assert.deepEqual([...r.changed], ['a']);
  const [a, b] = r.frame.view.cameras;
  assert.equal(a.ptz.pan, 0.7);
  assert.equal(a.properties.gain.label, '6 dB');
  assert.equal(a.properties.iris.label, '4', 'untouched settings survive');
  assert.equal(b, f.view.cameras[1], 'an unchanged camera is the same object');
  assert.notEqual(a, f.view.cameras[0]);
  assert.equal(r.frame.view.camdConnected, false);
  assert.deepEqual(r.frame.alarms, [{ code: 'x' }]);
  assert.equal(f.view.cameras[0].ptz.pan, 0.5, 'the old frame is not mutated');
});

test('a whole-camera replace adds or swaps a camera; an unknown camera asks for a resync', () => {
  const r = applyPatch(base(), { type: 'patch', cameras: {
    b: { replace: true, id: 'b', kind: 'ptz', state: 'reconnecting', properties: {} },
    c: { replace: true, id: 'c', kind: 'ptz', state: 'connecting', properties: {} },
  } });
  assert.deepEqual(r.frame.view.cameras.map((c) => [c.id, c.state]),
    [['a', 'connected'], ['b', 'reconnecting'], ['c', 'connecting']]);
  assert.equal(applyPatch(base(), { type: 'patch', cameras: { z: { ptz: {} } } }).resync, true);
  const all = applyPatch(base(), { type: 'patch', cameras: { a: { properties: { only: { raw: 1 } }, replaceProperties: true } } });
  assert.deepEqual(Object.keys(all.frame.view.cameras[0].properties), ['only']);
});
