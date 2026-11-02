// sACN over real UDP on 127.0.0.1: the sender and engine as they run in the
// studio, with a listener standing in for the lights. Checks the packets as a
// receiver would see them — framing, CID, name, priority, universe, sequence,
// slot values — and the timing: an immediate frame on a change, the idle
// refresh, and 40 Hz while fading. Nothing leaves the loopback interface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';

import { SacnOutput } from '../src/lighting/output.js';
import { LightingEngine } from '../src/lighting/engine.js';
import { parseDataPacket } from '../src/lighting/sacn.js';
import { builtInProfiles, decode } from '../src/lighting/profiles.js';
import { profileMap } from '../src/lighting/fixtures.js';

const CID = '6f1d2c3b-4a59-4e8d-9c7b-a1b2c3d4e5f6';
const profiles = profileMap(builtInProfiles());
const lyra = profiles.get('ikan-lyra-lbx8-poe-2ch');
// The engine does not validate the patch (the service does, and refuses
// 127.x), so the loopback fixtures can all point at the listener.
const fixtures = [1, 3, 5, 7, 9].map((address, i) => ({
  id: `l${i + 1}`, name: `L${i + 1}`, profile: lyra.id, ip: '127.0.0.1', universe: 1, address, groups: [],
}));
const STUDIO = [175, 12, 178, 12, 20, 12, 30, 12, 6, 12];
const studioState = () => Object.fromEntries(fixtures.map((f, i) => [f.id, decode(lyra, STUDIO.slice(i * 2, i * 2 + 2))]));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function listener() {
  const sock = createSocket('udp4');
  const packets = [];
  sock.on('message', (msg, rinfo) => packets.push({ at: performance.now(), msg, rinfo, p: parseDataPacket(msg) }));
  sock.bind(0, '127.0.0.1');
  await once(sock, 'listening');
  return { sock, packets, port: sock.address().port };
}

async function sender(port, over = {}) {
  const output = new SacnOutput({
    settings: { enabled: true, interface: '', address: '127.0.0.1', port, cid: CID, sourceName: 'CamBridge loopback', priority: 120, ...over },
  });
  output.open();
  if (!output.bound) await once(output, 'status');
  assert.ok(output.bound, output.status().error ?? 'bound');
  const engine = new LightingEngine({ output, idleMs: 100 });
  engine.configure(fixtures, profiles);
  engine.start();
  return { output, engine };
}

test('loopback: E1.31 packets as a receiver sees them', async () => {
  const rx = await listener();
  const { output, engine } = await sender(rx.port);
  try {
    await wait(250);
    assert.equal(rx.packets.length, 0, 'nothing before a state is known');

    engine.restore(studioState());
    await wait(20);
    assert.equal(rx.packets.length, 1, 'the restored state goes out at once');
    const first = rx.packets[0];
    assert.equal(first.msg.length, 638, 'a full 512-slot data packet');
    assert.equal(first.p.cid, CID);
    assert.equal(first.p.sourceName, 'CamBridge loopback');
    assert.equal(first.p.priority, 120);
    assert.equal(first.p.universe, 1);
    assert.equal(first.p.startCode, 0);
    assert.equal(first.p.options, 0, 'not preview, not terminated');
    assert.equal(first.p.syncAddress, 0);
    assert.equal(first.p.sequence, 0);
    assert.deepEqual(first.p.slots.slice(0, 10), STUDIO);
    assert.ok(first.p.slots.slice(10).every((v) => v === 0), 'unpatched slots are 0');
    assert.equal(first.rinfo.address, '127.0.0.1', 'sent from the bound address');

    // Idle: the same frame again every 100 ms (500 in the studio), each with
    // the next sequence number.
    await wait(450);
    const idle = rx.packets.slice();
    assert.ok(idle.length >= 4 && idle.length <= 7, `idle refresh (${idle.length} packets in ~470 ms)`);
    idle.forEach((x, i) => {
      assert.equal(x.p.sequence, i, 'sequence counts up by one');
      assert.deepEqual(x.p.slots.slice(0, 10), STUDIO);
    });
  } finally {
    engine.stop();
    output.close();
    rx.sock.close();
  }
});

test('loopback: a fade runs at about 40 Hz, ends on target, and the sequence wraps', async () => {
  const rx = await listener();
  const { output, engine } = await sender(rx.port);
  try {
    engine.restore(studioState());
    await wait(20);
    rx.packets.length = 0;

    const t0 = performance.now();
    engine.set(fixtures, { intensity: 0 }, { fadeMs: 500 });
    await wait(650);
    const during = rx.packets.filter((x) => x.at - t0 <= 500);
    // 40 Hz is 20 frames in 500 ms; timers on a busy CI box run late, never early.
    assert.ok(during.length >= 12 && during.length <= 23, `${during.length} frames during a 500 ms fade`);
    const dimmer = during.map((x) => x.p.slots[0]);
    assert.ok(dimmer.every((v, i) => i === 0 || v <= dimmer[i - 1]), `L1 only goes down: ${dimmer}`);
    assert.ok(dimmer[0] > 100 && dimmer.at(-1) < 60, `a smooth fade, not a snap: ${dimmer}`);
    const last = rx.packets.at(-1).p.slots.slice(0, 10);
    assert.deepEqual(last, [0, 12, 0, 12, 0, 12, 0, 12, 0, 12], 'ends exactly at 0, CCT untouched');

    const gaps = during.slice(1).map((x, i) => x.at - during[i].at);
    const median = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    assert.ok(median >= 20 && median <= 40, `median frame gap ${median.toFixed(1)} ms`);

    // Sequence numbers are per universe and wrap 255 → 0.
    output.sequences.set(1, 253);
    rx.packets.length = 0;
    engine.set(fixtures, { intensity: 10 });
    await wait(250);
    assert.deepEqual(rx.packets.slice(0, 3).map((x) => x.p.sequence), [254, 255, 0]);
  } finally {
    engine.stop();
    output.close();
    rx.sock.close();
  }
});

test('loopback: dry-run and output off send nothing; turning output on resumes at once', async () => {
  const rx = await listener();
  const { output, engine } = await sender(rx.port, { dryRun: true });
  try {
    engine.restore(studioState());
    await wait(250);
    assert.equal(rx.packets.length, 0, 'dry-run sends nothing');
    assert.deepEqual(output.frames()[1].slice(0, 10), STUDIO, 'but shows the frame it would have sent');

    output.configure({ ...output.settings, dryRun: false, enabled: false });
    await wait(250);
    assert.equal(rx.packets.length, 0, 'off sends nothing');

    output.configure({ ...output.settings, enabled: true });
    await wait(150);
    assert.ok(rx.packets.length >= 1, 'on again: sending');
    assert.deepEqual(rx.packets[0].p.slots.slice(0, 10), STUDIO, 'and the first frame is the state, not zeros');
  } finally {
    engine.stop();
    output.close();
    rx.sock.close();
  }
});
