// The lighting service: persistence, scenes, the protected looks, restart
// restore, the patch and output settings — against a temp directory, a fake
// clock and a fake network. Nothing here sends a packet anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Lighting } from '../src/lighting/service.js';
import { parseDataPacket } from '../src/lighting/sacn.js';

const LYRA = 'ikan-lyra-lbx8-poe-2ch';
const STUDIO_DMX = [175, 12, 178, 12, 20, 12, 30, 12, 6, 12];
const OFF_DMX = [0, 12, 0, 12, 0, 12, 0, 12, 0, 12];
const NICS = { en0: [{ family: 'IPv4', address: '10.0.0.5' }], en14: [{ family: 'IPv4', address: '192.168.220.66' }] };
const tick = () => new Promise((r) => setImmediate(r));

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
  return { now: () => t, timers, advance };
}

function fakeSockets() {
  const sockets = [];
  const make = () => {
    const s = new EventEmitter();
    s.sent = [];
    s.bind = (opts, cb) => { s.bound = opts; setImmediate(cb); };
    s.send = (buf, port, dest, cb) => { s.sent.push({ buf, port, dest }); setImmediate(() => cb(null)); };
    s.setMulticastInterface = () => {};
    s.setMulticastTTL = () => {};
    s.close = () => { s.closed = true; };
    sockets.push(s);
    return s;
  };
  return { make, sockets, packets: () => sockets.flatMap((s) => s.sent) };
}

/**
 * A Lighting service on a temp directory. `config` is cambridge.json; the
 * same directory can be handed to a second instance to play a restart.
 */
function rig({ config = {}, dir = mkdtempSync(join(tmpdir(), 'cb-lighting-')), nics = NICS, writeFails = false, readFails = false } = {}) {
  let cfg = structuredClone(config);
  const writes = [];
  const logs = [];
  const clock = fakeTime();
  const net = fakeSockets();
  const L = new Lighting({
    readConfig: () => { if (readFails) throw new Error('unreadable'); return structuredClone(cfg); },
    writeConfig: (c) => { if (writeFails) throw new Error('disk full'); cfg = structuredClone(c); writes.push(structuredClone(c)); },
    storePath: join(dir, 'cambridge-lighting.json'),
    log: (level, msg) => logs.push(`${level}: ${msg}`),
    outputOptions: { networkInterfaces: () => nics, createSocket: net.make, retryMs: 20 },
    engineOptions: { now: clock.now, timers: clock.timers },
  });
  return { L, dir, cfg: () => cfg, writes, logs, clock, net, store: () => JSON.parse(readFileSync(join(dir, 'cambridge-lighting.json'), 'utf8')) };
}

const dryRun = { lighting: { output: { enabled: true, dryRun: true } } };
const slots = (L) => (L.output.frames()[1] ?? []).slice(0, 10);
const cleanup = (...rigs) => { for (const r of rigs) { r.L.stop(); rmSync(r.dir, { recursive: true, force: true }); } };

test('first start: the five Lyras, output off, no state, and a CID made once and kept', () => {
  const a = rig();
  const v = a.L.view();
  assert.deepEqual(v.fixtures.map((f) => [f.id, f.name, f.ip, f.universe, f.address]), [
    ['l1', 'L1', '192.168.220.51', 1, 1], ['l2', 'L2', '192.168.220.52', 1, 3], ['l3', 'L3', '192.168.220.53', 1, 5],
    ['l4', 'L4', '192.168.220.54', 1, 7], ['l5', 'L5', '192.168.220.55', 1, 9],
  ]);
  assert.ok(v.fixtures.every((f) => f.live && f.profile === LYRA && f.footprint === 2 && f.errors.length === 0));
  assert.deepEqual(v.fixtures[0].kelvin, { min: 3200, max: 5600 });
  assert.equal(v.output.state, 'off', 'output is off until someone turns it on');
  assert.equal(v.output.mode, 'unicast');
  assert.equal(v.known, false);
  assert.deepEqual(v.scenes.map((s) => [s.slot, s.empty]), [[1, true], [2, true], [3, true], [4, true], [5, true]]);
  assert.deepEqual(v.looks, [{ id: 'studio', name: 'Studio look', protected: true }, { id: 'off', name: 'Studio off', protected: true }]);
  assert.equal(a.writes.length, 0, 'starting does not write cambridge.json');

  const cid = a.store().cid;
  assert.match(cid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(v.output.cid, cid);
  a.L.stop();
  const b = rig({ dir: a.dir });
  assert.equal(b.L.view().output.cid, cid, 'the same CID after a restart');
  cleanup(b);
});

test('the Studio look is exactly 175 12 178 12 20 12 30 12 6 12, and Off is 0 12 …', () => {
  const r = rig({ config: dryRun });
  r.L.start();
  r.clock.advance(3000);
  assert.deepEqual(r.L.output.frames(), {}, 'no frame at all before a state exists');
  assert.equal(r.L.view().output.waitingForState, true);

  assert.equal(r.L.recallLook('studio').status, 200);
  assert.deepEqual(slots(r.L), STUDIO_DMX);
  assert.deepEqual(r.L.view().active, { type: 'look', id: 'studio' });
  assert.deepEqual(r.L.view().fixtures.map((f) => f.dmx), [[175, 12], [178, 12], [20, 12], [30, 12], [6, 12]]);

  r.L.recallLook('off', { fadeMs: 1000 });
  r.clock.advance(500);
  const mid = slots(r.L);
  assert.ok(mid[0] > 0 && mid[0] < 175, `half-way down, not snapped (${mid[0]})`);
  r.clock.advance(500);
  assert.deepEqual(slots(r.L), OFF_DMX);
  assert.deepEqual(r.L.view().active, { type: 'look', id: 'off' });

  assert.equal(r.L.recallLook('nope').status, 404);
  assert.equal(r.L.recallLook('studio', { fadeMs: 120_000 }).status, 400);
  cleanup(r);
});

test('scenes: save, recall with a fade, rename and clear — and the looks cannot be saved over', () => {
  const r = rig({ config: dryRun });
  r.L.start();
  assert.equal(r.L.saveScene(1).status, 409, 'nothing to save before a state exists');

  r.L.set({ target: { all: true }, intensity: 50, cct: 4400 });
  const saved = r.L.saveScene(1, { name: 'Interview' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.scene.name, 'Interview');
  assert.ok(Date.parse(saved.body.scene.savedAt));
  assert.deepEqual(r.L.view().active, { type: 'scene', slot: 1 });

  r.L.recallLook('studio');
  assert.equal(r.L.recallScene(1, { fadeMs: 1000 }).status, 200);
  r.clock.advance(1000);
  assert.deepEqual(slots(r.L), [128, 128, 128, 128, 128, 128, 128, 128, 128, 128]);
  assert.deepEqual(r.L.view().active, { type: 'scene', slot: 1 });

  // A scene saved mid-fade is where the fade was going, not where it had got to.
  r.L.recallLook('studio', { fadeMs: 1000 });
  r.clock.advance(300);
  r.L.saveScene(2);
  assert.deepEqual(r.store().scenes['2'].state.l1.intensity, 175 / 2.55);
  assert.equal(r.store().scenes['2'].name, 'Scene 2');

  assert.equal(r.L.renameScene(1, 'Panel').status, 200);
  assert.equal(r.L.view().scenes[0].name, 'Panel');
  assert.equal(r.L.renameScene(1, '  ').status, 400);
  assert.equal(r.L.renameScene(1, 'x'.repeat(41)).status, 400);
  assert.equal(r.L.renameScene(3, 'Empty').status, 409);
  assert.equal(r.L.saveScene(4, { name: 'x'.repeat(41) }).status, 400);

  for (const slot of ['studio', 'off', 0, 6, -1, 1.5, '']) {
    assert.equal(r.L.saveScene(slot).status, 404, `saving to ${JSON.stringify(slot)} is refused`);
  }
  assert.equal(r.L.recallScene(3).status, 409, 'an empty scene does nothing');
  assert.equal(r.L.recallScene(9).status, 404);

  assert.equal(r.L.clearScene(2).status, 200);
  assert.equal(r.L.view().scenes[1].empty, true);
  assert.deepEqual(Object.keys(r.store().scenes), ['1'], 'scenes are on disk at once');
  assert.equal(r.store().scenes['1'].name, 'Panel');
  cleanup(r);
});

test('the scene count is configurable', () => {
  const r = rig({ config: { lighting: { sceneCount: 8 } } });
  assert.equal(r.L.view().scenes.length, 8);
  r.L.set({ target: { all: true }, intensity: 10 });
  assert.equal(r.L.saveScene(8).status, 200);
  assert.equal(r.L.saveScene(9).status, 404);
  cleanup(r);
});

test('a restart restores the last state and sends it — the first packet is the look, never zeros', async () => {
  const a = rig({ config: dryRun });
  a.L.start();
  a.L.recallLook('studio');
  a.L.stop();
  assert.deepEqual(Object.keys(a.store().state), ['l1', 'l2', 'l3', 'l4', 'l5']);

  const live = { lighting: { output: { enabled: true } } };
  const b = rig({ config: live, dir: a.dir });
  assert.equal(b.L.view().known, true);
  b.L.start();
  await tick(); // the socket binds
  b.clock.advance(2100);
  await tick();
  const packets = b.net.packets();
  assert.ok(packets.length >= 5 * 4, `sending (${packets.length} packets)`);
  for (const p of packets) {
    const parsed = parseDataPacket(p.buf);
    assert.deepEqual([...parsed.slots.slice(0, 10)], STUDIO_DMX, 'every packet carries the restored look');
    assert.equal(parsed.universe, 1);
    assert.equal(parsed.cid, a.store().cid);
    assert.equal(parsed.sourceName, 'CamBridge');
    assert.equal(parsed.priority, 100);
  }
  assert.deepEqual([...new Set(packets.map((p) => p.dest))].sort(),
    ['192.168.220.51', '192.168.220.52', '192.168.220.53', '192.168.220.54', '192.168.220.55']);
  assert.equal(b.L.view().output.state, 'sending');
  cleanup(b);
});

test('a saved state for fixtures no longer in the patch is not restored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-lighting-'));
  writeFileSync(join(dir, 'cambridge-lighting.json'), JSON.stringify({ cid: null, state: { gone: { intensity: 80 } }, scenes: {} }));
  const r = rig({ config: dryRun, dir });
  r.L.start();
  r.clock.advance(2000);
  assert.equal(r.L.view().known, false);
  assert.deepEqual(r.L.output.frames(), {}, 'still nothing sent');
  cleanup(r);
});

test('set: absolute and relative, by fixture, name, group or all — a target is required', () => {
  const groups = { lighting: { fixtures: [
    { id: 'l1', name: 'L1', profile: LYRA, ip: '192.168.220.51', universe: 1, address: 1, groups: ['Key'] },
    { id: 'l2', name: 'L2', profile: LYRA, ip: '192.168.220.52', universe: 1, address: 3, groups: ['Key'] },
    { id: 'l3', name: 'L3', profile: LYRA, ip: '192.168.220.53', universe: 1, address: 5, groups: [] },
  ] } };
  const r = rig({ config: groups });
  r.L.start();
  assert.equal(r.L.set({ intensity: 50 }).status, 400, 'no target is not "all"');
  assert.equal(r.L.set({ target: {}, intensity: 50 }).status, 400);
  assert.equal(r.L.set({ target: { all: true } }).status, 400, 'nothing to set');
  assert.equal(r.L.set({ target: { all: true }, intensity: 'lots' }).status, 400);
  assert.equal(r.L.set({ target: { fixture: 'L9' }, intensity: 50 }).status, 404);
  assert.equal(r.L.set({ target: { group: 'Fill' }, intensity: 50 }).status, 404);
  assert.equal(r.L.set({ target: { all: true }, intensity: 50, fadeMs: -1 }).status, 400);
  assert.equal(r.L.view().known, false, 'refused commands change nothing');

  assert.deepEqual(r.L.set({ target: { all: true }, intensity: 40, cct: 3200 }).body.fixtures, ['l1', 'l2', 'l3']);
  assert.deepEqual(r.L.set({ target: { group: 'key' }, intensity: 10, relative: true }).body.fixtures, ['l1', 'l2']);
  r.L.set({ target: { fixture: 'L3' }, cct: 300, relative: true });
  r.L.set({ target: { fixture: 'l3' }, intensity: 200 });
  const s = Object.fromEntries(r.L.view().fixtures.map((f) => [f.id, [f.intensity, f.cct]]));
  assert.deepEqual(s, { l1: [50, 3200], l2: [50, 3200], l3: [100, 3500] }, 'clamped to 100 %');
  assert.deepEqual(r.L.view().groups, ['All', 'Key']);
  cleanup(r);
});

test('the patch: a bad change is refused with field errors, and nothing is written', () => {
  const r = rig({ config: dryRun });
  r.L.start();
  r.L.recallLook('studio');

  const overlap = r.L.addFixture({ name: 'L6', profile: LYRA, ip: '192.168.220.56', universe: 1, address: 10 });
  assert.equal(overlap.status, 400);
  assert.ok(overlap.body.errors.some((e) => e.fixture === 'l6' && e.field === 'address' && /L5 \(9–10\) and L6 \(10–11\) overlap in universe 1/.test(e.message)),
    JSON.stringify(overlap.body.errors));
  assert.equal(r.writes.length, 0);
  assert.equal(r.L.view().fixtures.length, 5);

  const added = r.L.addFixture({ name: 'L6', profile: LYRA, ip: '192.168.220.56', universe: '1', address: '11', groups: ['Back'] });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.fixture.id, 'l6');
  assert.equal(added.body.fixture.intensity, 0, 'a new light starts dark');
  assert.deepEqual(r.cfg().lighting.fixtures.map((f) => f.id), ['l1', 'l2', 'l3', 'l4', 'l5', 'l6']);
  assert.equal(r.cfg().lighting.output.enabled, true, 'the output settings survive a patch write');
  assert.deepEqual(slots(r.L), STUDIO_DMX, 'the others did not move');

  const before = r.writes.length;
  for (const [changes, field] of [[{ address: 'abc' }, 'address'], [{ name: 'l1' }, 'name'], [{ ip: '192.168.220.256' }, 'ip'],
    [{ universe: 0 }, 'universe'], [{ profile: 'nope' }, 'profile'], [{ address: 512 }, 'address']]) {
    const res = r.L.updateFixture('l6', changes);
    assert.equal(res.status, 400, JSON.stringify(changes));
    assert.ok(res.body.errors.some((e) => e.field === field), `${JSON.stringify(changes)} → ${JSON.stringify(res.body.errors)}`);
  }
  assert.equal(r.writes.length, before, 'none of them were written');
  assert.equal(r.L.updateFixture('nope', { address: 20 }).status, 404);

  assert.equal(r.L.updateFixture('l6', { name: 'Backlight', address: 20 }).status, 200);
  assert.deepEqual(r.L.view().fixtures.find((f) => f.id === 'l6').name, 'Backlight', 'the id stays when the name changes');
  assert.equal(r.L.removeFixture('l6').status, 200);
  assert.equal(r.L.removeFixture('l6').status, 404);
  assert.equal(r.L.view().fixtures.length, 5);
  cleanup(r);
});

test('a hand-edited patch with a clash: both lights are left out and flagged; the rest keep working', () => {
  const clash = { lighting: { output: { enabled: true, dryRun: true }, fixtures: [
    { id: 'l1', name: 'L1', profile: LYRA, ip: '192.168.220.51', universe: 1, address: 1 },
    { id: 'l2', name: 'L2', profile: LYRA, ip: '192.168.220.52', universe: 1, address: 2 },
    { id: 'l3', name: 'L3', profile: LYRA, ip: '192.168.220.53', universe: 1, address: 5 },
  ] } };
  const r = rig({ config: clash });
  const v = r.L.view();
  assert.deepEqual(v.fixtures.map((f) => [f.id, f.live, f.errors.length > 0]), [['l1', false, true], ['l2', false, true], ['l3', true, false]]);
  assert.match(v.fixtures[0].errors[0], /overlap/);
  assert.ok(r.logs.some((l) => /^error: lighting config: .*overlap/.test(l)), 'and logged');
  r.L.start();
  r.L.set({ target: { all: true }, intensity: 100 });
  assert.deepEqual(slots(r.L).slice(0, 6), [0, 0, 0, 0, 255, 0]);
  cleanup(r);
});

test('output: on/off and dry-run are for operators; the network needs the admin PIN', async () => {
  const r = rig();
  assert.equal(r.L.setOutput({ enabled: true }).status, 200);
  assert.equal(r.cfg().lighting.output.enabled, true);
  assert.deepEqual(r.cfg().lighting.fixtures.map((f) => f.id), ['l1', 'l2', 'l3', 'l4', 'l5'], 'the seed patch is written out with it');
  assert.equal(r.L.setOutput({ dryRun: true }).body.output.state, 'dry-run');

  for (const change of [{ priority: 150 }, { interface: 'en0' }, { address: '10.0.0.5' }, { mode: 'multicast' }, { sourceName: 'X' }]) {
    assert.equal(r.L.setOutput(change).status, 403, JSON.stringify(change));
  }
  assert.equal(r.L.setOutput({ priority: 150 }, { admin: true }).status, 200);
  assert.equal(r.cfg().lighting.output.priority, 150);
  for (const bad of [{ priority: 201 }, { priority: 1.5 }, { address: 'lights' }, { mode: 'broadcast' }, { sourceName: '' },
    { sourceName: 'é'.repeat(32) }, { cid: 'not-a-uuid' }, { port: 70000 }]) {
    const res = r.L.setOutput(bad, { admin: true });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal(r.cfg().lighting.output.priority, 150, 'refused changes leave the config alone');
  assert.equal(r.L.view().output.priority, 150);
  cleanup(r);
});

test('en14 down: the error is in the view, commands still work, nothing throws', async () => {
  const r = rig({ config: { lighting: { output: { enabled: true } } }, nics: { en0: NICS.en0 } });
  r.L.start();
  const v = r.L.view();
  assert.equal(v.output.state, 'error');
  assert.match(v.output.error, /192\.168\.220\.66 is not on this computer — is en14 up\?/);
  assert.equal(r.L.recallLook('studio').status, 200);
  r.clock.advance(2000);
  assert.equal(r.net.packets().length, 0);
  cleanup(r);
});

test('custom profiles: added and used; built-ins and profiles in use cannot be removed', () => {
  const r = rig();
  const dimmer = { id: 'generic-dimmer', name: 'Generic dimmer', channels: [{ type: 'intensity', label: 'Dimmer' }] };
  assert.equal(r.L.addProfile({ id: 'Bad Id', name: 'x', channels: [] }).status, 400);
  assert.equal(r.L.addProfile({ ...dimmer, id: LYRA }).status, 400, 'a built-in id cannot be reused');
  assert.equal(r.L.addProfile(dimmer).status, 200);
  assert.deepEqual(r.cfg().lighting.profiles, [dimmer]);
  assert.ok(r.L.view().profiles.some((p) => p.id === 'generic-dimmer' && !p.builtIn));
  assert.ok(r.L.view({ full: true }).profiles.find((p) => p.id === LYRA).channels.length === 2);

  assert.equal(r.L.addFixture({ name: 'Practical', profile: 'generic-dimmer', ip: '192.168.220.60', universe: 1, address: 20 }).status, 200);
  assert.deepEqual(r.L.view().fixtures.at(-1).kelvin, null);
  assert.match(r.L.removeProfile('generic-dimmer').body.error, /used by Practical/);
  assert.equal(r.L.updateProfile(LYRA, dimmer).status, 409);
  assert.equal(r.L.removeProfile(LYRA).status, 409);
  assert.equal(r.L.updateProfile('generic-dimmer', { ...dimmer, name: 'Dimmer' }).status, 200);
  r.L.removeFixture('practical');
  assert.equal(r.L.removeProfile('generic-dimmer').status, 200);
  assert.equal(r.L.removeProfile('generic-dimmer').status, 404);
  cleanup(r);
});

test('export and import: a dry run first, and nothing changes until it is confirmed', () => {
  const r = rig({ config: dryRun });
  r.L.start();
  r.L.recallLook('studio');
  r.L.saveScene(1, { name: 'Studio copy' });
  const doc = r.L.exportConfig();
  assert.equal(doc.type, 'cambridge-lighting');
  assert.equal(doc.fixtures.length, 5);
  assert.equal(doc.scenes['1'].name, 'Studio copy');

  const moved = structuredClone(doc);
  moved.fixtures[4].address = 21;
  delete moved.scenes;
  const preview = r.L.importConfig(moved);
  assert.deepEqual([preview.status, preview.body.dryRun, preview.body.fixtures, preview.body.scenes], [200, true, 5, null]);
  assert.equal(r.L.view().fixtures[4].address, 9, 'a preview changes nothing');

  const broken = structuredClone(doc);
  broken.fixtures[1].address = 1;
  const refused = r.L.importConfig(broken, { dryRun: false });
  assert.equal(refused.status, 400);
  assert.ok(refused.body.errors.some((e) => /overlap/.test(e)));
  assert.equal(r.L.importConfig({ type: 'something-else' }).status, 400);

  assert.equal(r.L.importConfig(moved, { dryRun: false }).status, 200);
  assert.equal(r.L.view().fixtures[4].address, 21);
  assert.equal(r.cfg().lighting.fixtures[4].address, 21);
  assert.equal(r.L.view().scenes[0].name, 'Studio copy', 'an export without scenes leaves the scenes alone');
  assert.equal(r.cfg().lighting.output.dryRun, true);
  cleanup(r);
});

test('a broken store, an unreadable config or a failing disk: logged, never thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-lighting-'));
  writeFileSync(join(dir, 'cambridge-lighting.json'), '{ not json');
  const r = rig({ dir, readFails: true });
  assert.equal(r.L.view().fixtures.length, 5, 'falls back to the seed patch');
  assert.ok(r.logs.some((l) => /unreadable/.test(l)));
  assert.ok(r.logs.some((l) => /cannot read config/.test(l)));
  cleanup(r);

  const w = rig({ writeFails: true });
  const res = w.L.setOutput({ enabled: true });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /disk full/);
  assert.equal(w.L.view().output.enabled, false, 'the setting did not change behind a failed save');
  cleanup(w);
});

test('view events are coalesced and never fire from inside a command', async () => {
  const r = rig({ config: dryRun });
  r.L.start();
  let events = 0;
  r.L.on('view', () => { events += 1; });
  r.L.set({ target: { all: true }, intensity: 10 });
  r.L.set({ target: { all: true }, intensity: 20 });
  r.L.saveScene(1);
  assert.equal(events, 0);
  await tick();
  assert.equal(events, 1);
  cleanup(r);
});

test('state is saved shortly after it stops changing, and on stop', async () => {
  const r = rig({ config: dryRun });
  r.L.start();
  r.L.set({ target: { fixture: 'l1' }, intensity: 33 });
  assert.equal(r.store().state, null, 'not on every fader step');
  await new Promise((res) => setTimeout(res, 600));
  assert.equal(r.store().state.l1.intensity, 33);
  r.L.set({ target: { fixture: 'l1' }, intensity: 44 });
  r.L.stop();
  assert.equal(r.store().state.l1.intensity, 44);
  rmSync(r.dir, { recursive: true, force: true });
});

test('bad hand-edited settings are reported and fall back to safe defaults', () => {
  const r = rig({ config: { lighting: { output: { enabled: 'yes', priority: 'high', mode: 'unicast' }, sceneCount: 0, fixtures: 'L1 L2' } } });
  const v = r.L.view();
  assert.equal(v.output.enabled, false, 'output stays off rather than reading "yes" as on');
  assert.equal(v.output.priority, 100);
  assert.equal(v.scenes.length, 5);
  assert.deepEqual(v.fixtures, [], 'a broken patch is not replaced with a guess');
  const messages = v.errors.map((e) => e.message).join(' | ');
  for (const bit of ['output.enabled', 'output.priority', 'sceneCount', 'fixtures is not a list']) assert.ok(messages.includes(bit), messages);
  r.L.start();
  assert.equal(r.L.set({ target: { all: true }, intensity: 50 }).status, 200, 'still answers');
  cleanup(r);
});
