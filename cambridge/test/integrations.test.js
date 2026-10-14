// ATEM tally parsing and the VISCA server.
//
// Neither needs its hardware to be tested: the ATEM parser is fed real packet
// bytes, and the VISCA server is fed real command frames. What cannot be tested
// here is whether a given switcher or joystick sends exactly these bytes, which
// is noted in the docs as needing the real thing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AtemTally, tallyForCameras } from '../src/atem.js';
import { ViscaServer, matchesAllow } from '../src/visca.js';
import { StateModel } from '../src/state.js';

// --- ATEM -------------------------------------------------------------------

/** Builds the ATEM command block wrapper around a payload. */
function block(name, payload) {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt16BE(8 + payload.length, 0);
  buf.write(name, 4, 'ascii');
  Buffer.from(payload).copy(buf, 8);
  return buf;
}

/** Wraps command blocks in the 12-byte ATEM packet header. */
function packet(blocks, { flags = 0, packetId = 1 } = {}) {
  const payload = Buffer.concat(blocks);
  const length = 12 + payload.length;
  const head = Buffer.alloc(12);
  head.writeUInt8((flags << 3) | ((length >> 8) & 0x07), 0);
  head.writeUInt8(length & 0xff, 1);
  head.writeUInt16BE(0x1234, 2);
  head.writeUInt16BE(packetId, 10);
  return Buffer.concat([head, payload]);
}

/** Feeds a packet exactly as the UDP socket would, with a stub socket for acks. */
function feed(atem, buf) {
  atem.socket = { send: () => {}, close: () => {} };
  atem.handlePacket(buf);
}

test('TlSr tally maps switcher sources to program and preview', () => {
  const atem = new AtemTally({ host: '10.0.0.1' });
  // Source 1 on program, source 2 on preview, source 3 on neither.
  const payload = Buffer.alloc(2 + 3 * 3);
  payload.writeUInt16BE(3, 0);
  payload.writeUInt16BE(1, 2); payload.writeUInt8(0x01, 4);
  payload.writeUInt16BE(2, 5); payload.writeUInt8(0x02, 7);
  payload.writeUInt16BE(3, 8); payload.writeUInt8(0x00, 10);

  feed(atem, packet([block('TlSr', payload)]));

  const snap = atem.snapshot();
  assert.deepEqual(snap[1], { program: true, preview: false });
  assert.deepEqual(snap[2], { program: false, preview: true });
  assert.deepEqual(snap[3], { program: false, preview: false });
});

test('TlIn tally is one-based, matching the numbers on the switcher', () => {
  const atem = new AtemTally({ host: '10.0.0.1' });
  // Three inputs: the second one is live. Input numbering starting at 0 here
  // would light the wrong camera.
  const payload = Buffer.from([0x00, 0x03, 0x00, 0x01, 0x02]);
  feed(atem, packet([block('TlIn', payload)]));

  const snap = atem.snapshot();
  assert.equal(snap[1].program, false);
  assert.equal(snap[2].program, true);
  assert.equal(snap[3].preview, true);
});

test('a tally change is emitted once, and an unchanged repeat is silent', () => {
  const atem = new AtemTally({ host: '10.0.0.1' });
  let emissions = 0;
  atem.on('tally', () => { emissions += 1; });

  const payload = Buffer.from([0x00, 0x02, 0x01, 0x00]);
  feed(atem, packet([block('TlIn', payload)]));
  assert.equal(emissions, 1);

  // The switcher re-sends state constantly. Re-emitting on every repeat would
  // push an SSE frame to every browser several times a second for no reason.
  feed(atem, packet([block('TlIn', payload)]));
  assert.equal(emissions, 1);

  feed(atem, packet([block('TlIn', Buffer.from([0x00, 0x02, 0x00, 0x01]))]));
  assert.equal(emissions, 2);
});

test('a malformed command block stops parsing instead of looping forever', () => {
  const atem = new AtemTally({ host: '10.0.0.1' });
  // A zero block length is the shape that would spin: offset never advances.
  const bad = Buffer.alloc(12);
  bad.writeUInt16BE(0, 0);
  bad.write('TlIn', 4, 'ascii');
  feed(atem, packet([bad]));
  assert.deepEqual(atem.snapshot(), {});
});

test('unknown command blocks are skipped without disturbing tally', () => {
  const atem = new AtemTally({ host: '10.0.0.1' });
  // A real switcher sends dozens of blocks we do not care about, in one packet
  // with the tally we do.
  feed(atem, packet([
    block('_ver', Buffer.from([0x00, 0x02, 0x00, 0x1e])),
    block('TlIn', Buffer.from([0x00, 0x01, 0x01])),
    block('InPr', Buffer.alloc(30)),
  ]));
  assert.equal(atem.snapshot()[1].program, true);
});

test('tally is mapped onto camera ids by the configured input numbers', () => {
  const snapshot = { 1: { program: true, preview: false }, 2: { program: false, preview: true } };
  const mapped = tallyForCameras({ wide: 1, centre: 2, tight: 4 }, snapshot);
  assert.equal(mapped.wide.program, true);
  assert.equal(mapped.centre.preview, true);
  // A camera mapped to an input the switcher never mentioned must read as off,
  // not as undefined — a tally light is either on or it is not.
  assert.deepEqual(mapped.tight, { input: 4, program: false, preview: false });
});

// --- VISCA ------------------------------------------------------------------

function makeVisca({ connected = true } = {}) {
  const state = new StateModel();
  state.replaceAll([
    { id: 'cam1', label: 'Wide', model: 'ILME-FX3',
      state: connected ? 'connected' : 'offline', status: {} },
  ], 'test');
  state.replaceProperties('cam1', {
    fNumber: { value: 400, writable: true, allowed: [280, 320, 400, 560, 800] },
    isoSensitivity: { value: 640, writable: true, allowed: [200, 400, 640, 1600] },
    whiteBalance: { value: 0, writable: true, allowed: [0, 1, 2, 4] },
    focusPosition: { value: 100, writable: true, range: { min: 0, max: 1000, step: 1 } },
  });

  const writes = [];
  const actions = [];
  const visca = new ViscaServer({
    state,
    applyFn: async (cameraId, prop, raw) => {
      writes.push({ cameraId, prop, raw });
      const p = state.get(cameraId)?.properties?.[prop];
      if (p) p.value = raw;
      return { ok: true, body: { applied: raw } };
    },
    actionFn: async (cameraId, action, body) => { actions.push({ cameraId, action, body }); return { ok: true }; },
    recallPreset: async () => ({ ok: true }),
    savePreset: () => ({ ok: true }),
    mapping: { cam1: 1 },
  });
  return { visca, writes, actions, state };
}

/** A VISCA-over-IP frame around a raw message. */
function viscaFrame(bytes, sequence = 7) {
  const body = Buffer.from(bytes);
  const head = Buffer.alloc(8);
  head.writeUInt16BE(0x0100, 0);
  head.writeUInt16BE(body.length, 2);
  head.writeUInt32BE(sequence, 4);
  return Buffer.concat([head, body]);
}

const IRIS_UP = [0x81, 0x01, 0x04, 0x0b, 0x02, 0xff];
const IRIS_DOWN = [0x81, 0x01, 0x04, 0x0b, 0x03, 0xff];

test('VISCA iris up opens the lens — more light, a lower f-number', async () => {
  const { visca, writes } = makeVisca();
  const replies = await visca.handlePacket(viscaFrame(IRIS_UP));

  assert.equal(writes.length, 1);
  assert.equal(writes[0].prop, 'fNumber');
  // f/4.0 -> f/3.2. Walking the other way would darken the shot when the
  // operator pushed the ring towards open.
  assert.equal(writes[0].raw, 320);
  // A controller waits for ACK then completion; one without the other hangs it.
  assert.equal(replies.length, 2);
  assert.equal(replies[0].subarray(8)[1], 0x41);
  assert.equal(replies[1].subarray(8)[1], 0x51);
});

test('VISCA iris down closes the lens', async () => {
  const { visca, writes } = makeVisca();
  await visca.handlePacket(viscaFrame(IRIS_DOWN));
  assert.equal(writes[0].raw, 560);
});

test('VISCA replies echo the sequence number the controller sent', async () => {
  const { visca } = makeVisca();
  const replies = await visca.handlePacket(viscaFrame(IRIS_UP, 4242));
  // A controller matches replies to commands by sequence; getting this wrong
  // makes every command look unanswered.
  assert.equal(replies[0].readUInt32BE(4), 4242);
  assert.equal(replies[0].readUInt16BE(0), 0x0111);
});

test('raw VISCA over TCP works without the IP header', async () => {
  const { visca, writes } = makeVisca();
  // Some controllers open a TCP socket and send bare VISCA.
  const replies = await visca.handlePacket(Buffer.from(IRIS_UP));
  assert.equal(writes.length, 1);
  // The reply must be bare too, or the controller cannot parse it.
  assert.equal(replies[0][0], 0x90);
  assert.equal(replies[0][replies[0].length - 1], 0xff);
});

test('pan and tilt are refused rather than silently ignored', async () => {
  const { visca, writes } = makeVisca();
  // These bodies have no head. A controller must be told, so the operator does
  // not stand there pushing a stick that will never do anything.
  const replies = await visca.handlePacket(
    viscaFrame([0x81, 0x01, 0x06, 0x01, 0x18, 0x14, 0x03, 0x01, 0xff]));
  assert.equal(writes.length, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].subarray(8)[1], 0x61);
});

test('commands for a disconnected camera are refused, not queued', async () => {
  const { visca, writes } = makeVisca({ connected: false });
  const replies = await visca.handlePacket(viscaFrame(IRIS_UP));
  assert.equal(writes.length, 0);
  assert.equal(replies[0].subarray(8)[1], 0x61);
});

test('an address with no camera behind it is refused', async () => {
  const { visca, writes } = makeVisca();
  // Address 3, but only one camera is mapped.
  const replies = await visca.handlePacket(viscaFrame([0x83, 0x01, 0x04, 0x0b, 0x02, 0xff]));
  assert.equal(writes.length, 0);
  assert.equal(replies[0].subarray(8)[1], 0x61);
});

test('stepping past the end of the iris list is refused, not clamped silently', async () => {
  const { visca, writes, state } = makeVisca();
  state.get('cam1').properties.fNumber.value = 280;   // already wide open
  const replies = await visca.handlePacket(viscaFrame(IRIS_UP));
  assert.equal(writes.length, 0);
  assert.equal(replies[0].subarray(8)[1], 0x61);
});

test('focus near and far become relative nudges', async () => {
  const { visca, actions } = makeVisca();
  await visca.handlePacket(viscaFrame([0x81, 0x01, 0x04, 0x08, 0x02, 0xff]));
  await visca.handlePacket(viscaFrame([0x81, 0x01, 0x04, 0x08, 0x03, 0xff]));
  assert.equal(actions[0].action, 'focusNudge');
  assert.ok(actions[0].body.steps > 0, 'far should nudge positive');
  assert.ok(actions[1].body.steps < 0, 'near should nudge negative');
});

test('one-shot autofocus triggers an AF action', async () => {
  const { visca, actions } = makeVisca();
  await visca.handlePacket(viscaFrame([0x81, 0x01, 0x04, 0x18, 0x01, 0xff]));
  assert.equal(actions[0].action, 'autofocus');
});

test('an iris inquiry answers with the current value in nibbles', async () => {
  const { visca } = makeVisca();
  const replies = await visca.handlePacket(viscaFrame([0x81, 0x09, 0x04, 0x4b, 0xff]));
  const payload = replies[0].subarray(8);
  assert.equal(payload[1], 0x50, 'inquiry replies are a completion, not an ack');
  // 400 == 0x0190, sent as four nibbles high to low.
  assert.deepEqual([...payload.subarray(2, 6)], [0x0, 0x1, 0x9, 0x0]);
});

test('an unknown command is a syntax error, not a crash', async () => {
  const { visca } = makeVisca();
  const replies = await visca.handlePacket(viscaFrame([0x81, 0x01, 0x04, 0x7e, 0x01, 0xff]));
  assert.equal(replies[0].subarray(8)[1], 0x60);
});

test('a truncated packet is dropped without throwing', async () => {
  const { visca } = makeVisca();
  assert.deepEqual(await visca.handlePacket(Buffer.from([0x81])), []);
  assert.deepEqual(await visca.handlePacket(Buffer.alloc(0)), []);
});

test('VISCA addresses fall back to camera order when nothing is mapped', () => {
  const state = new StateModel();
  state.replaceAll([
    { id: 'a', label: 'A', state: 'connected', status: {} },
    { id: 'b', label: 'B', state: 'connected', status: {} },
  ], 'test');
  const visca = new ViscaServer({ state, applyFn: async () => {}, actionFn: async () => {} });
  // So a one-camera booth needs no configuration at all.
  assert.equal(visca.cameraFor(1), 'a');
  assert.equal(visca.cameraFor(2), 'b');
  assert.equal(visca.cameraFor(3), null);
});

// --- VISCA forwarding to PTZ heads ---------------------------------------------

function ptzViscaRig() {
  const state = new StateModel();
  state.replaceAll([{ id: 'canon', label: 'Canon', state: 'connected' }], null, 'ptz');
  const calls = [];
  const entries = {
    home: { id: 'homeAction', role: 'home', type: 'action' },
    onePushAf: { id: 'afOnce', role: 'onePushAf', type: 'action' },
    focusMode: { id: 'fm', role: 'focusMode', type: 'enum', autoValue: 'auto', manualValue: 'manual' },
  };
  const ptz = {
    move: (id, v, o) => { calls.push(['move', id, v, o]); return { ok: true }; },
    preset: async (id, op, n) => { calls.push(['preset', id, op, n]); return { ok: true }; },
    action: async (id, e) => { calls.push(['action', id, e]); return { ok: true }; },
    write: async (id, e, v) => { calls.push(['write', id, e, v]); return { ok: true }; },
    entryByRole: (id, role) => entries[role] ?? null,
    presetBase: () => 1,
    releaseSource: (s) => calls.push(['release', s]),
  };
  const server = new ViscaServer({ state, ptz, applyFn: async () => ({ ok: true }), actionFn: async () => ({ ok: true }) });
  return { server, calls };
}

const COMPLETION_REPLY = [0x90, 0x51, 0xff];

test('VISCA pan/tilt drives a PTZ head instead of being refused', async () => {
  const { server, calls } = ptzViscaRig();
  const tcp = { id: 'visca-tcp:x', tcp: true };
  // Pan-tiltDrive: speed 0x0c both, right + up.
  const r = await server.handlePacket(Buffer.from([0x81, 0x01, 0x06, 0x01, 0x0c, 0x0c, 0x02, 0x01, 0xff]), tcp);
  assert.deepEqual([...r.at(-1)], COMPLETION_REPLY);
  const [, id, v, o] = calls[0];
  assert.equal(id, 'canon');
  assert.equal(v.pan, 0.5);
  assert.equal(v.tilt, 0.5);
  assert.deepEqual(o, { source: 'visca-tcp:x', holdMs: 60_000 });

  // Stop, left/down, and a UDP controller's move is held for less.
  await server.handlePacket(Buffer.from([0x81, 0x01, 0x06, 0x01, 0x18, 0x01, 0x01, 0x02, 0xff]), { id: 'u', tcp: false });
  assert.deepEqual(calls[1][2], { pan: -1, tilt: -1 / 0x18 });
  assert.equal(calls[1][3].holdMs, 10_000);
  await server.handlePacket(Buffer.from([0x81, 0x01, 0x06, 0x01, 0x01, 0x01, 0x03, 0x03, 0xff]), tcp);
  assert.deepEqual(calls[2][2], { pan: 0, tilt: 0 });
});

test('VISCA zoom, focus, home, one-push and memory reach a PTZ head', async () => {
  const { server, calls } = ptzViscaRig();
  const send = (...b) => server.handlePacket(Buffer.from([0x81, 0x01, ...b, 0xff]), { id: 't', tcp: true });
  await send(0x04, 0x07, 0x27);          // zoom tele, speed 7 = full
  await send(0x04, 0x07, 0x30);          // zoom wide, speed 0 = slowest
  await send(0x04, 0x07, 0x00);          // zoom stop
  await send(0x04, 0x08, 0x02);          // focus far, standard
  await send(0x06, 0x04);                // home
  await send(0x04, 0x18, 0x01);          // one-push AF
  await send(0x04, 0x38, 0x03);          // focus manual
  await send(0x04, 0x3f, 0x02, 0x04);    // recall memory slot 4 -> preset 5
  assert.deepEqual(calls.map((c) => c.slice(0, 4)), [
    ['move', 'canon', { zoom: 1 }, { source: 't', holdMs: 60_000 }],
    ['move', 'canon', { zoom: -0.125 }, { source: 't', holdMs: 60_000 }],
    ['move', 'canon', { zoom: 0 }, { source: 't', holdMs: 60_000 }],
    ['move', 'canon', { focus: 0.5 }, { source: 't', holdMs: 60_000 }],
    ['action', 'canon', 'homeAction'],
    ['action', 'canon', 'afOnce'],
    ['write', 'canon', 'fm', 'manual'],
    ['preset', 'canon', 'recall', 5],
  ]);
});

test('a camera with its own VISCA port is that camera whatever address the packet carries', async () => {
  const { createSocket } = await import('node:dgram');
  const state = new StateModel();
  state.replaceAll([
    { id: 'one', label: 'One', state: 'connected' },
    { id: 'two', label: 'Two', state: 'connected' },
  ], null, 'ptz');
  const calls = [];
  const ptz = {
    move: (id, v) => { calls.push([id, v]); return { ok: true }; },
    preset: async () => ({ ok: true }), action: async () => ({ ok: true }), write: async () => ({ ok: true }),
    entryByRole: () => null, presetBase: () => 1, releaseSource: () => {},
  };
  const base = 41000 + Math.floor(Math.random() * 2000);
  const server = new ViscaServer({ state, ptz, port: base, tcp: false, cameraPorts: { two: base + 1 },
    applyFn: async () => ({ ok: true }), actionFn: async () => ({ ok: true }) });
  await server.start();
  const client = createSocket('udp4');
  try {
    // Each command is answered twice — ACK, then Completion — so wait for both.
    const send = (port) => new Promise((resolve) => {
      let n = 0;
      const on = () => { if (++n === 2) { client.off('message', on); resolve(); } };
      client.on('message', on);
      // Address 1 on both ports: on the shared port that is the first camera,
      // on camera two's own port it is camera two.
      client.send(Buffer.from([0x81, 0x01, 0x06, 0x01, 0x18, 0x18, 0x02, 0x03, 0xff]), port, '127.0.0.1');
    });
    await send(base);
    await send(base + 1);
    assert.deepEqual(calls.map((c) => c[0]), ['one', 'two']);
  } finally {
    client.close();
    await server.stop();
  }
});

test('VISCA over TCP: a stop split across chunks, and a drive and stop in one chunk, both arrive', async () => {
  const net = await import('node:net');
  const state = new StateModel();
  state.replaceAll([{ id: 'one', label: 'One', state: 'connected' }], null, 'ptz');
  const calls = [];
  const ptz = {
    move: (id, v, o) => { calls.push(v); return { ok: true }; },
    preset: async () => ({ ok: true }), action: async () => ({ ok: true }), write: async () => ({ ok: true }),
    entryByRole: () => null, presetBase: () => 1, releaseSource: () => {},
  };
  const port = 43000 + Math.floor(Math.random() * 2000);
  const server = new ViscaServer({ state, ptz, port, tcp: true,
    applyFn: async () => ({ ok: true }), actionFn: async () => ({ ok: true }) });
  await server.start();
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  try {
    const drive = [0x81, 0x01, 0x06, 0x01, 0x10, 0x10, 0x01, 0x03, 0xff];
    const stop = [0x81, 0x01, 0x06, 0x01, 0x10, 0x10, 0x03, 0x03, 0xff];
    sock.write(Buffer.from([...drive, ...stop]));          // coalesced
    await new Promise((r) => setTimeout(r, 100));
    sock.write(Buffer.from(drive));
    await new Promise((r) => setTimeout(r, 50));
    sock.write(Buffer.from(stop.slice(0, 5)));             // split
    await new Promise((r) => setTimeout(r, 50));
    sock.write(Buffer.from(stop.slice(5)));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(calls.map((v) => v.pan === 0 ? 'stop' : 'drive'), ['drive', 'stop', 'drive', 'stop']);
  } finally {
    sock.destroy();
    await server.stop();
  }
});

test('VISCA refuses controllers outside the allowlist, and preset store unless enabled', async () => {
  const state = new StateModel();
  state.replaceAll([{ id: 'one', label: 'One', state: 'connected' }], null, 'ptz');
  const calls = [];
  const ptz = {
    move: () => ({ ok: true }), preset: async (id, op, n) => { calls.push([op, n]); return { ok: true }; },
    action: async () => ({ ok: true }), write: async () => ({ ok: true }),
    entryByRole: () => null, presetBase: () => 1, releaseSource: () => {},
  };
  const server = new ViscaServer({ state, ptz, allow: ['192.0.2.0/24'],
    applyFn: async () => ({ ok: true }), actionFn: async () => ({ ok: true }) });
  const p = { id: 't', tcp: true };
  const store = await server.handlePacket(Buffer.from([0x81, 0x01, 0x04, 0x3f, 0x01, 0x02, 0xff]), p);
  assert.deepEqual([...store.at(-1)], [0x90, 0x61, 0x41, 0xff], 'store refused');
  await server.handlePacket(Buffer.from([0x81, 0x01, 0x04, 0x3f, 0x02, 0x02, 0xff]), p);
  assert.deepEqual(calls, [['recall', 3]], 'recall still works');
});

test('the VISCA allowlist matches addresses and blocks, including IPv4-mapped forms', () => {
  assert.equal(matchesAllow('192.0.2.7', ['192.0.2.0/24']), true);
  assert.equal(matchesAllow('::ffff:192.0.2.7', ['192.0.2.0/24']), true);
  assert.equal(matchesAllow('198.51.100.7', ['192.0.2.0/24']), false);
  assert.equal(matchesAllow('192.0.2.7', ['192.0.2.7']), true);
  assert.equal(matchesAllow('192.0.2.8', ['192.0.2.7']), false);
  assert.equal(matchesAllow('192.0.2.8', ['nonsense', '192.0.2.8/32']), true);
});
