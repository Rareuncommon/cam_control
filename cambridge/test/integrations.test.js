// ATEM tally parsing and the VISCA server.
//
// Neither needs its hardware to be tested: the ATEM parser is fed real packet
// bytes, and the VISCA server is fed real command frames. What cannot be tested
// here is whether a given switcher or joystick sends exactly these bytes, which
// is noted in the docs as needing the real thing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AtemTally, tallyForCameras } from '../src/atem.js';
import { ViscaServer } from '../src/visca.js';
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
