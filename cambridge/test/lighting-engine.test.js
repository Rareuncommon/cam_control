// The lighting engine against a fake clock, and the sender's failure handling
// against a fake network. No packets leave the machine here; the loopback test
// (lighting-loopback.test.js) covers real UDP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { LightingEngine } from '../src/lighting/engine.js';
import { SacnOutput, resolveLocalAddress } from '../src/lighting/output.js';
import { builtInProfiles } from '../src/lighting/profiles.js';
import { SEED_FIXTURES, profileMap, resolveTarget } from '../src/lighting/fixtures.js';

const profiles = profileMap(builtInProfiles());
const fixtures = SEED_FIXTURES.map((f) => ({ ...f, groups: [...f.groups] }));

/** A clock and timers the test moves by hand. */
function fakeTime() {
  let t = 1_000_000;
  let pending = [];
  let seq = 0;
  const timers = {
    setTimeout(fn, ms) { const h = { fn, at: t + ms, id: seq++ }; pending.push(h); return h; },
    clearTimeout(h) { pending = pending.filter((x) => x !== h); },
  };
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      pending.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = pending[0];
      if (!next || next.at > end) break;
      pending.shift();
      t = next.at;
      next.fn();
    }
    t = end;
  };
  return { now: () => t, timers, advance, pending: () => pending.length };
}

/** Records every frame the engine hands over. */
function recorder(clock) {
  const frames = [];
  return { frames, send: (universe, slots, to) => frames.push({ at: clock.now(), universe, slots: [...slots.slice(0, 10)], to }) };
}

function rig() {
  const clock = fakeTime();
  const out = recorder(clock);
  const engine = new LightingEngine({ output: out, now: clock.now, timers: clock.timers });
  engine.configure(fixtures, profiles);
  engine.start();
  return { clock, out, engine };
}

const STUDIO = { l1: { intensity: 175 / 2.55, cct: 3200 + 12 * 2400 / 255 }, l2: { intensity: 178 / 2.55, cct: 3200 + 12 * 2400 / 255 },
  l3: { intensity: 20 / 2.55, cct: 3200 + 12 * 2400 / 255 }, l4: { intensity: 30 / 2.55, cct: 3200 + 12 * 2400 / 255 },
  l5: { intensity: 6 / 2.55, cct: 3200 + 12 * 2400 / 255 } };

test('nothing is sent until a state is known — never a frame of zeros', () => {
  const { clock, out, engine } = rig();
  clock.advance(5000);
  assert.equal(out.frames.length, 0, 'no frames before a state exists');
  engine.restore(STUDIO);
  assert.deepEqual(out.frames[0].slots, [175, 12, 178, 12, 20, 12, 30, 12, 6, 12], 'the restored state, at once');
  assert.deepEqual(out.frames[0].to, ['192.168.220.51', '192.168.220.52', '192.168.220.53', '192.168.220.54', '192.168.220.55']);
});

test('idle: the state is re-sent every 500 ms so receivers never time out', () => {
  const { clock, out, engine } = rig();
  engine.restore(STUDIO);
  out.frames.length = 0;
  clock.advance(5000);
  assert.equal(out.frames.length, 10);
  const gaps = out.frames.slice(1).map((f, i) => f.at - out.frames[i].at);
  assert.ok(gaps.every((g) => g === 500), `gaps ${gaps}`);
});

test('a fade is timed, sent at 40 Hz, and ends exactly on target', () => {
  const { clock, out, engine } = rig();
  engine.restore({ l1: { intensity: 0, cct: 3200 } });
  out.frames.length = 0;
  engine.set(resolveTarget(fixtures, { fixture: 'l1' }), { intensity: 100 }, { fadeMs: 1000 });
  clock.advance(500);
  const mid = out.frames.at(-1).slots[0];
  assert.ok(mid >= 120 && mid <= 135, `half way at 500 ms: ${mid}`);
  clock.advance(600);
  assert.equal(out.frames.at(-1).slots[0], 255, 'ends on target');
  const during = out.frames.filter((f) => f.at <= clock.now() - 100);
  const gaps = during.slice(1).map((f, i) => f.at - during[i].at);
  assert.ok(gaps.slice(0, 30).every((g) => g === 25), `40 Hz during the fade: ${gaps.slice(0, 10)}`);
  out.frames.length = 0;
  clock.advance(2000);
  assert.equal(out.frames.length, 4, 'back to the idle rate once settled');
});

test('a new command interrupts a fade from where it had got to', () => {
  const { clock, out, engine } = rig();
  engine.restore({ l1: { intensity: 0, cct: 3200 } });
  const l1 = resolveTarget(fixtures, { fixture: 'l1' });
  engine.set(l1, { intensity: 100 }, { fadeMs: 1000 });
  clock.advance(500);
  const at = engine.snapshot().l1.intensity;
  engine.set(l1, { intensity: 0 }, { fadeMs: 1000 });
  clock.advance(25);
  const next = engine.snapshot().l1.intensity;
  assert.ok(Math.abs(next - at) < 4, `no jump: ${at} -> ${next}`);
  clock.advance(1000);
  assert.equal(out.frames.at(-1).slots[0], 0);
});

test('dimmer and colour fades run independently on the same light', () => {
  const { clock, engine } = rig();
  engine.restore({ l1: { intensity: 0, cct: 3200 } });
  const l1 = resolveTarget(fixtures, { fixture: 'l1' });
  engine.set(l1, { intensity: 100 }, { fadeMs: 1000 });
  clock.advance(250);
  engine.set(l1, { cct: 5600 }, { fadeMs: 1000 });   // must not stop the dimmer fade
  clock.advance(750);
  const s = engine.snapshot().l1;
  assert.equal(s.intensity, 100);
  assert.ok(Math.abs(s.cct - 5000) < 1, `colour three quarters of the way, still fading: ${s.cct}`);
  assert.ok(engine.fading, 'the colour fade is still running');
});

test('relative nudges add up even while the last one is still fading', () => {
  const { clock, engine } = rig();
  engine.restore({ l1: { intensity: 50, cct: 3200 } });
  const l1 = resolveTarget(fixtures, { fixture: 'l1' });
  engine.set(l1, { intensity: 10 }, { relative: true, fadeMs: 1000 });
  clock.advance(100);
  engine.set(l1, { intensity: 10 }, { relative: true, fadeMs: 1000 });
  assert.equal(engine.targets().l1.intensity, 70);
  engine.set(l1, { intensity: 50 }, { relative: true });
  assert.equal(engine.targets().l1.intensity, 100, 'clamped at full');
  engine.set(l1, { cct: -9999 }, { relative: true });
  assert.equal(engine.targets().l1.cct, 3200, 'clamped at the warm end of the profile');
});

test('Identify flashes one light, then shows its state again', () => {
  const { clock, out, engine } = rig();
  engine.restore(STUDIO);
  out.frames.length = 0;
  assert.equal(engine.identify('l3', 1000), true);
  clock.advance(1000);
  const l3 = out.frames.map((f) => f.slots[4]);
  assert.ok(l3.includes(255) && l3.includes(0), 'full and off while flashing');
  assert.ok(out.frames.every((f) => f.slots[0] === 175), 'the other lights do not flash');
  clock.advance(600);
  assert.equal(out.frames.at(-1).slots[4], 20, 'back to its own level');
  assert.equal(engine.targets().l3.intensity, 20 / 2.55, 'the state was never touched');
  assert.equal(engine.identify('nope'), false);
});

test('a patch change keeps the state of fixtures that stay', () => {
  const { engine } = rig();
  engine.restore(STUDIO);
  const moved = fixtures.map((f) => (f.id === 'l5' ? { ...f, address: 20 } : f)).filter((f) => f.id !== 'l4');
  engine.configure(moved, profiles);
  const frame = engine.frames().get(1).slots;
  assert.deepEqual([...frame.slice(0, 6)], [175, 12, 178, 12, 20, 12]);
  assert.deepEqual([...frame.slice(6, 8)], [0, 0], 'L4 is gone');
  assert.deepEqual([...frame.slice(19, 21)], [6, 12], 'L5 moved with its state');
});

test('a failing output never stops the engine', () => {
  const clock = fakeTime();
  const logs = [];
  const engine = new LightingEngine({ output: { send() { throw new Error('boom'); } }, now: clock.now, timers: clock.timers, log: (l, m) => logs.push(m) });
  engine.configure(fixtures, profiles);
  engine.start();
  engine.restore(STUDIO);
  clock.advance(2000);
  assert.ok(logs.some((m) => /boom/.test(m)));
  assert.ok(clock.pending() > 0, 'still scheduled');
});

// --- the sender ---------------------------------------------------------------

const NICS = { en0: [{ family: 'IPv4', address: '10.0.0.5' }], en14: [{ family: 'IPv4', address: '192.168.220.66' }] };

test('the lighting address comes from the interface, or the configured address if this computer has it', () => {
  assert.deepEqual(resolveLocalAddress({ interface: 'en14' }, NICS), { ok: true, address: '192.168.220.66', interface: 'en14' });
  assert.deepEqual(resolveLocalAddress({ interface: 'en14', address: '192.168.220.66' }, NICS), { ok: true, address: '192.168.220.66', interface: 'en14' });
  assert.match(resolveLocalAddress({ interface: 'en14' }, { en0: NICS.en0 }).error, /en14 is not up/);
  assert.match(resolveLocalAddress({ interface: 'en14', address: '192.168.220.66' }, { en0: NICS.en0 }).error, /not on this computer — is en14 up/);
});

/** A dgram socket stand-in that records sends. */
function fakeSocketFactory({ failBind = false } = {}) {
  const sockets = [];
  const make = () => {
    const s = new EventEmitter();
    s.sent = [];
    s.bind = (opts, cb) => { s.bound = opts; if (failBind) setImmediate(() => s.emit('error', Object.assign(new Error('bind EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' }))); else setImmediate(cb); };
    s.send = (buf, port, dest, cb) => { s.sent.push({ buf, port, dest }); setImmediate(() => cb(null)); };
    s.setMulticastInterface = (a) => { s.mcastIf = a; };
    s.setMulticastTTL = () => {};
    s.close = () => { s.closed = true; };
    sockets.push(s);
    return s;
  };
  return { make, sockets };
}

const CID = '0f5c2d1e-9a8b-4c7d-8e6f-112233445566';
const settings = (over = {}) => ({ enabled: true, interface: 'en14', mode: 'unicast', cid: CID, ...over });
const tick = () => new Promise((r) => setImmediate(r));

test('output off, dry-run and live', async () => {
  const f = fakeSocketFactory();
  const out = new SacnOutput({ settings: settings({ enabled: false }), networkInterfaces: () => NICS, createSocket: f.make });
  await tick();
  out.send(1, new Uint8Array(512), ['192.168.220.51']);
  assert.equal(out.status().state, 'off');
  assert.equal(f.sockets[0].sent.length, 0, 'off sends nothing');

  out.configure(settings({ dryRun: true }));
  out.send(1, Uint8Array.from([1, 2, 3]), ['192.168.220.51']);
  assert.equal(out.status().state, 'dry-run');
  assert.equal(f.sockets[0].sent.length, 0, 'dry-run sends nothing');
  assert.deepEqual(out.frames()[1].slice(0, 3), [1, 2, 3], 'but shows what it would have sent');

  out.configure(settings());
  out.send(1, new Uint8Array(512), ['192.168.220.51', '192.168.220.52']);
  await tick();
  assert.equal(out.status().state, 'sending');
  assert.deepEqual(f.sockets[0].sent.map((s) => [s.dest, s.port]), [['192.168.220.51', 5568], ['192.168.220.52', 5568]]);
  assert.equal(f.sockets[0].bound.address, '192.168.220.66', 'bound to the lighting address');
  out.close();
});

test('multicast goes to the universe group on the lighting interface', async () => {
  const f = fakeSocketFactory();
  const out = new SacnOutput({ settings: settings({ mode: 'multicast' }), networkInterfaces: () => NICS, createSocket: f.make });
  await tick();
  out.send(1, new Uint8Array(512), ['192.168.220.51']);
  assert.deepEqual(f.sockets[0].sent.map((s) => s.dest), ['239.255.0.1']);
  assert.equal(f.sockets[0].mcastIf, '192.168.220.66');
  out.close();
});

test('en14 down: a status, a retry, no exception — and sending resumes when it is back', async () => {
  const f = fakeSocketFactory();
  let nics = { en0: NICS.en0 };
  const logs = [];
  const out = new SacnOutput({ settings: settings(), networkInterfaces: () => nics, createSocket: f.make, retryMs: 20, log: (l, m) => logs.push(m) });
  assert.equal(out.status().state, 'error');
  assert.match(out.status().error, /en14 is not up/);
  out.send(1, new Uint8Array(512), ['192.168.220.51']);   // must not throw
  nics = NICS;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(out.status().state, 'sending');
  out.send(1, new Uint8Array(512), ['192.168.220.51']);
  await tick();
  assert.equal(f.sockets.at(-1).sent.length, 1);
  out.close();
});

test('a bind failure is a status and a retry, not a crash', async () => {
  const f = fakeSocketFactory({ failBind: true });
  const out = new SacnOutput({ settings: settings(), networkInterfaces: () => NICS, createSocket: f.make, retryMs: 20 });
  await tick(); await tick();
  assert.equal(out.status().state, 'error');
  assert.match(out.status().error, /EADDRNOTAVAIL/);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(f.sockets.length >= 2, 'tried again');
  out.close();
});

test('sequence numbers count per universe and wrap at 255', async () => {
  const f = fakeSocketFactory();
  const out = new SacnOutput({ settings: settings(), networkInterfaces: () => NICS, createSocket: f.make });
  await tick();
  for (let i = 0; i < 258; i++) out.send(1, new Uint8Array(512), ['192.168.220.51']);
  out.send(2, new Uint8Array(512), ['192.168.220.52']);
  const seq = f.sockets[0].sent.map((s) => [s.buf.readUInt16BE(113), s.buf[111]]);
  assert.deepEqual(seq.slice(0, 2), [[1, 0], [1, 1]]);
  assert.deepEqual(seq.slice(255, 258), [[1, 255], [1, 0], [1, 1]]);
  assert.deepEqual(seq.at(-1), [2, 0], 'universe 2 has its own count');
  out.close();
});
