// The Lighting tab's decisions (public/lighting-logic.js), tested without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { outputSummary, nextFreeAddress, fieldErrors, sceneCaption, parseGroups, throttle, pct, kelvin } from '../public/lighting-logic.js';

test('the output pill speaks up only when something needs saying', () => {
  const base = { known: true, output: { state: 'sending', mode: 'unicast', address: '192.168.220.66', bound: { address: '192.168.220.66' } } };
  assert.equal(outputSummary(base).pill, false, 'sending normally: no pill');
  assert.deepEqual(['off', 'dry-run', 'error', 'degraded'].map((state) => {
    const s = outputSummary({ ...base, output: { ...base.output, state, error: 'en14 is not up (no IPv4 address)' } });
    return [s.pill, s.kind];
  }), [[true, ''], [true, 'warn'], [true, 'bad'], [true, 'bad']]);
  assert.match(outputSummary({ ...base, output: { ...base.output, state: 'error', error: 'en14 is not up (no IPv4 address)' } }).detail, /en14 is not up/);
  const waiting = outputSummary({ known: false, output: { ...base.output, waitingForState: true } });
  assert.equal(waiting.text, 'LIGHTS: WAITING');
  assert.equal(outputSummary({ unavailable: 'boom' }).kind, 'bad');
  assert.equal(outputSummary(null).pill, false);
});

test('the next free address skips what is patched, by footprint', () => {
  const seed = [1, 3, 5, 7, 9].map((address, i) => ({ id: `l${i + 1}`, universe: 1, address, footprint: 2 }));
  assert.equal(nextFreeAddress(seed, 1, 2), 11);
  assert.equal(nextFreeAddress(seed, 2, 2), 1, 'another universe is empty');
  assert.equal(nextFreeAddress(seed.filter((f) => f.id !== 'l2'), 1, 2), 3, 'a gap is used');
  assert.equal(nextFreeAddress(seed.filter((f) => f.id !== 'l2'), 1, 3), 11, 'unless it is too small');
  assert.equal(nextFreeAddress(seed, 1, 2, 'l5'), 9, 'the fixture being edited does not block itself');
  assert.equal(nextFreeAddress([{ id: 'x', universe: 1, address: 1, footprint: 511 }], 1, 2), null, 'full');
});

test('refused patch errors go by the edited fixture\'s fields; the rest are shown apart', () => {
  const errors = [
    { fixture: 'l6', field: 'address', message: 'L5 (9–10) and L6 (10–11) overlap in universe 1' },
    { fixture: 'l5', field: 'address', message: 'L5 (9–10) and L6 (10–11) overlap in universe 1' },
    { fixture: 'l6', field: 'ip', message: 'not an IPv4 address' },
  ];
  const r = fieldErrors(errors, 'l6');
  assert.deepEqual(Object.keys(r.fields), ['address', 'ip']);
  assert.equal(r.other.length, 1);
  assert.deepEqual(fieldErrors(['plain message']).other, ['plain message']);
});

test('small helpers', () => {
  assert.equal(sceneCaption({ empty: true }), 'empty');
  assert.match(sceneCaption({ empty: false, savedAt: '2026-11-02T14:32:00Z' }, new Date('2026-11-02T15:00:00Z')), /^saved \d\d:\d\d/);
  assert.match(sceneCaption({ empty: false, savedAt: '2026-10-01T14:32:00Z' }, new Date('2026-11-02T15:00:00Z')), /^saved .*Oct/);
  assert.deepEqual(parseGroups(' Key, Back ,,Key'), ['Key', 'Back']);
  assert.equal(pct(68.6), '69 %');
  assert.equal(kelvin(3312.9), '3313 K');
  assert.equal(pct(null), '—');
});

test('a fader drag sends at most every 80 ms, and always the last value', () => {
  let t = 0;
  const timers = [];
  const sent = [];
  const send = throttle((v) => sent.push([t, v]), 80, { now: () => t, setTimer: (fn, ms) => timers.push({ fn, at: t + ms }) });
  const run = (to) => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > to) break;
      const x = timers.shift();
      t = x.at;
      x.fn();
    }
    t = to;
  };
  for (let v = 0; v <= 30; v++) { send(v); run(t + 10); }
  run(t + 200);
  assert.ok(sent.length >= 3 && sent.length <= 5, `${sent.length} sends for 31 moves`);
  assert.equal(sent.at(-1)[1], 30, 'the last value always goes');
  assert.ok(sent.slice(1).every(([at], i) => at - sent[i][0] >= 80));
});
