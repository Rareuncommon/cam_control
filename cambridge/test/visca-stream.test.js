// CS5 and CS6 (audit 2026-09-23): VISCA over TCP is a byte stream, and a
// camera that refuses a write must not be reported to the controller as done.
//
// Loopback TCP to an in-process ViscaServer with a mock camera mirror. No
// camera, switcher or joystick is involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { once } from 'node:events';

import { StateModel } from '../src/state.js';
import { ViscaServer } from '../src/visca.js';

function rig({ refuse = false } = {}) {
  const state = new StateModel();
  state.replaceAll([{ id: 'cam1', label: 'Wide', state: 'connected', status: {} }], 'test');
  state.replaceProperties('cam1', {
    fNumber: { value: 400, writable: true, allowed: [280, 320, 400, 560, 800] },
    whiteBalance: { value: 0, writable: true, allowed: [0, 1, 2, 4] },
  });
  const writes = [];
  const actions = [];
  const visca = new ViscaServer({
    state, bind: '127.0.0.1', port: 0, tcp: true, mapping: { cam1: 1 },
    applyFn: async (cameraId, prop, raw) => {
      writes.push({ prop, raw });
      if (refuse) return { ok: false, status: 422, body: { error: 'refused in current mode' } };
      state.get(cameraId).properties[prop].value = raw;
      return { ok: true, body: { applied: raw } };
    },
    actionFn: async (cameraId, action, body) => { actions.push({ action, body }); return refuse ? { ok: false, status: 502 } : { ok: true }; },
    recallPreset: async () => ({ ok: true }),
    savePreset: () => ({ ok: true }),
  });
  return { visca, writes, actions, state };
}

const IRIS_UP = [0x81, 0x01, 0x04, 0x0b, 0x02, 0xff];
const WB_AUTO = [0x81, 0x01, 0x04, 0x35, 0x00, 0xff];
function framed(bytes, sequence) {
  const head = Buffer.alloc(8);
  head.writeUInt16BE(0x0100, 0);
  head.writeUInt16BE(bytes.length, 2);
  head.writeUInt32BE(sequence, 4);
  return Buffer.concat([head, Buffer.from(bytes)]);
}

async function tcpClient(visca) {
  const socket = connect(visca.tcpServer.address().port, '127.0.0.1');
  await once(socket, 'connect');
  socket.setNoDelay(true);
  const received = [];
  socket.on('data', (d) => received.push(...d));
  return { socket, received };
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('a framed command split across TCP segments is reassembled, not misread', async (t) => {
  const { visca, writes } = rig();
  await visca.start(); t.after(() => visca.stop());
  const { socket, received } = await tcpClient(visca);
  t.after(() => socket.destroy());
  const frame = framed(IRIS_UP, 11);
  socket.write(frame.subarray(0, 5));
  await settle(60);
  socket.write(frame.subarray(5));
  await settle();
  assert.deepEqual(writes, [{ prop: 'fNumber', raw: 320 }]);
  // ACK then completion, each framed with the controller's sequence number.
  assert.equal(received.length, 2 * (8 + 3));
});

test('two raw commands coalesced into one TCP read both execute, in order', async (t) => {
  const { visca, writes } = rig();
  await visca.start(); t.after(() => visca.stop());
  const { socket, received } = await tcpClient(visca);
  t.after(() => socket.destroy());
  socket.write(Buffer.from([...IRIS_UP, ...WB_AUTO]));
  await settle();
  assert.deepEqual(writes.map((w) => w.prop), ['fNumber', 'whiteBalance']);
  assert.deepEqual(received, [0x90, 0x41, 0xff, 0x90, 0x51, 0xff, 0x90, 0x41, 0xff, 0x90, 0x51, 0xff]);
});

test('a framed message that is not terminated or is truncated is never executed', async () => {
  const { visca, writes } = rig();
  // Header claims 6 bytes; only 4 present.
  assert.deepEqual(await visca.handlePacket(framed(IRIS_UP, 1).subarray(0, 12)), []);
  // Correct length but the last byte is not the 0xFF terminator.
  assert.deepEqual(await visca.handlePacket(framed([0x81, 0x01, 0x04, 0x0b, 0x02, 0x00], 2)), []);
  // Raw message with no terminator.
  assert.deepEqual(await visca.handlePacket(Buffer.from([0x81, 0x01, 0x04, 0x0b, 0x02])), []);
  assert.equal(writes.length, 0);
});

test('an unterminated TCP stream is bounded and the connection dropped', async (t) => {
  const { visca, writes } = rig();
  await visca.start(); t.after(() => visca.stop());
  const { socket } = await tcpClient(visca);
  const closed = once(socket, 'close');
  socket.write(Buffer.alloc(64 * 1024, 0x81));
  await Promise.race([closed, settle(1000)]);
  assert.equal(socket.destroyed || socket.readableEnded, true, 'server must drop a peer that never frames');
  assert.equal(writes.length, 0);
});

test('a camera refusing the write is reported as not executable, not completed', async () => {
  const { visca, writes } = rig({ refuse: true });
  const replies = await visca.handlePacket(framed(IRIS_UP, 3));
  assert.equal(writes.length, 1);
  assert.equal(replies.length, 1);
  assert.deepEqual([...replies[0].subarray(8)], [0x90, 0x61, 0x41, 0xff]);

  const focus = await visca.handlePacket(framed([0x81, 0x01, 0x04, 0x08, 0x02, 0xff], 4));
  assert.deepEqual([...focus[0].subarray(8)], [0x90, 0x61, 0x41, 0xff]);
});

test('a throwing camera write becomes a VISCA error, not an unhandled rejection', async () => {
  const { visca } = rig();
  visca.applyFn = async () => { throw new Error('camd went away'); };
  const replies = await visca.handlePacket(framed(IRIS_UP, 5));
  assert.deepEqual([...replies[0].subarray(8)], [0x90, 0x61, 0x41, 0xff]);
});

// --- After the merge with the PTZ forwarding listener ---------------------------

test('a VISCA-over-IP RESET control frame is skipped, not taken for garbage', async (t) => {
  const { visca, writes } = rig();
  await visca.start(); t.after(() => visca.stop());
  const { socket, received } = await tcpClient(visca);
  t.after(() => socket.destroy());
  // What a Sony-protocol controller sends first: payload type 0x0200, one byte.
  const reset = Buffer.from([0x02, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01]);
  socket.write(Buffer.concat([reset, framed(IRIS_UP, 1)]));
  await settle();
  assert.equal(socket.destroyed, false, 'the controller is still connected');
  assert.deepEqual(writes, [{ prop: 'fNumber', raw: 320 }]);
  assert.equal(received.length, 2 * (8 + 3));
});

test('a controller that disconnects never has a queued move run after its release', async (t) => {
  const state = new StateModel();
  state.replaceAll([{ id: 'head', label: 'Head', state: 'connected' }], null, 'ptz');
  const calls = [];
  let finishRecall;
  const ptz = {
    move: (id, v, o) => { calls.push(['move', o.source]); return { ok: true }; },
    // A recall the camera takes its time over, so the drive behind it waits.
    preset: (id, op, n) => { calls.push(['preset', n]); return new Promise((r) => { finishRecall = () => r({ ok: true }); }); },
    action: async () => ({ ok: true }), write: async () => ({ ok: true }),
    entryByRole: () => null, presetBase: () => 1,
    releaseSource: (s) => calls.push(['release', s]),
  };
  const visca = new ViscaServer({ state, ptz, bind: '127.0.0.1', port: 0, tcp: true,
    applyFn: async () => ({ ok: true }), actionFn: async () => ({ ok: true }) });
  await visca.start(); t.after(() => visca.stop());
  const { socket } = await tcpClient(visca);
  const RECALL_2 = [0x81, 0x01, 0x04, 0x3f, 0x02, 0x02, 0xff];
  const PAN_LEFT = [0x81, 0x01, 0x06, 0x01, 0x10, 0x10, 0x01, 0x03, 0xff];
  socket.write(Buffer.from([...RECALL_2, ...PAN_LEFT]));
  await settle(60);
  socket.destroy();          // gone while the drive is still queued
  await settle(60);
  finishRecall();
  await settle();
  assert.equal(calls.filter((c) => c[0] === 'move').length, 0,
    'the queued drive must not run: it would latch with nothing left to release it');
  assert.ok(calls.some((c) => c[0] === 'release'));
});
