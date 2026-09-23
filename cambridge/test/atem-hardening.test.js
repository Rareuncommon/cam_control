// CS3, CS4 and the coalescer observation (audit 2026-09-23).
//
// Packets are built in memory and handed to the parser the way the UDP socket
// would, with sender metadata. No switcher, socket or camera is involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AtemTally } from '../src/atem.js';
import { decodeCCdP, toCameraWrites, TYPE, WRAPPER, FIXED16_SCALE, WriteCoalescer } from '../src/atem-cc.js';

const PEER = { address: '192.0.2.10', port: 9910 };

function block(name, payload) {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt16BE(8 + payload.length, 0);
  buf.write(name, 4, 'ascii');
  Buffer.from(payload).copy(buf, 8);
  return buf;
}
function packet(blocks, { flags = 0x01, packetId = 1, session = 0x8001, length } = {}) {
  const payload = Buffer.concat(blocks);
  const len = length ?? 12 + payload.length;
  const head = Buffer.alloc(12);
  head.writeUInt8((flags << 3) | ((len >> 8) & 0x07), 0);
  head.writeUInt8(len & 0xff, 1);
  head.writeUInt16BE(session, 2);
  head.writeUInt16BE(packetId, 10);
  return Buffer.concat([head, payload]);
}
const hello = (session = 0x1234) => packet([Buffer.alloc(8)], { flags: 0x08, packetId: 0, session });
const tally = (onAir) => block('TlIn', [0, 1, onAir ? 1 : 0]);
function ccBody(values = [0.5]) {
  const body = Buffer.alloc(WRAPPER.values + values.length * 2);
  body.writeUInt8(1, WRAPPER.destination); body.writeUInt8(0, WRAPPER.category); body.writeUInt8(3, WRAPPER.parameter);
  body.writeUInt8(TYPE.FIXED16, WRAPPER.dataType); body.writeUInt8(values.length, WRAPPER.elementCount);
  values.forEach((v, i) => body.writeInt16BE(Math.round(v * FIXED16_SCALE), WRAPPER.values + i * 2));
  return body;
}

function switcher() {
  const atem = new AtemTally({ host: PEER.address, port: PEER.port });
  atem.socket = { send: () => {}, close: () => {} };
  atem.peerAddress = PEER.address;
  const seen = { tally: [], control: [] };
  atem.on('tally', (t) => seen.tally.push(t));
  atem.on('cameraControl', (b) => seen.control.push(b));
  return { atem, seen };
}

test('packets from anyone but the configured switcher are ignored', () => {
  const { atem, seen } = switcher();
  atem.receive(hello(), { address: '198.51.100.7', port: 9910 });
  assert.equal(atem.connected, false, 'a spoofed HELLO must not connect');
  atem.receive(hello(), PEER);
  assert.equal(atem.connected, true);
  atem.receive(packet([block('CCdP', ccBody())]), { address: PEER.address, port: 50000 });
  atem.receive(packet([tally(true)]), { address: '198.51.100.7', port: 9910 });
  assert.equal(seen.control.length, 0);
  assert.equal(seen.tally.length, 0);
});

test('nothing but a HELLO is accepted before the handshake', () => {
  const { atem, seen } = switcher();
  atem.receive(packet([block('CCdP', ccBody())]), PEER);
  atem.receive(packet([tally(true)]), PEER);
  assert.equal(seen.control.length + seen.tally.length, 0);
});

test('the session is pinned after the handshake and a different one is dropped', () => {
  const { atem, seen } = switcher();
  atem.receive(hello(), PEER);
  atem.receive(packet([tally(true)], { session: 0x8001, packetId: 1 }), PEER);
  assert.equal(seen.tally.length, 1);
  atem.receive(packet([block('CCdP', ccBody())], { session: 0x8999, packetId: 2 }), PEER);
  assert.equal(seen.control.length, 0, 'foreign session');
});

test('a retransmitted packet is acknowledged but not acted on twice', () => {
  const { atem, seen } = switcher();
  atem.receive(hello(), PEER);
  const p = packet([block('CCdP', ccBody())], { packetId: 5 });
  atem.receive(p, PEER);
  atem.receive(p, PEER);
  assert.equal(seen.control.length, 1);
});

test('a packet whose header length disagrees with its size is dropped', () => {
  const { atem, seen } = switcher();
  atem.receive(hello(), PEER);
  atem.receive(packet([block('CCdP', ccBody())], { length: 200 }), PEER);
  atem.receive(packet([block('CCdP', ccBody())], { length: 14 }), PEER);
  assert.equal(seen.control.length, 0);
});

test('CS4: an element count the payload cannot hold is refused, not partially decoded', () => {
  const body = ccBody([0.5, 0.25]);
  body.writeUInt8(50, WRAPPER.elementCount);
  const d = decodeCCdP(body);
  assert.equal(d.ok, false);
  assert.equal(toCameraWrites(d, { properties: {} }).writes.length, 0);
});

test('CS4: an unsupported data type is refused', () => {
  const body = ccBody([0.5]);
  body.writeUInt8(77, WRAPPER.dataType);
  assert.equal(decodeCCdP(body).ok, false);
});

test('CS4: a mapped control with a missing or wrongly typed value writes nothing', () => {
  const camera = { properties: {
    fNumber: { value: 400, writable: true, allowed: [280, 400, 800, 1600, 2200] },
    focusPosition: { value: 500, writable: true, range: { min: 0, max: 1000, step: 1 } },
    zoomPosition: { value: 0, writable: true, range: { min: 0, max: 1000, step: 1 } },
  } };
  for (const parameter of [0, 3, 8]) {
    const empty = ccBody([]);
    empty.writeUInt8(parameter, WRAPPER.parameter);
    const d = decodeCCdP(empty);
    const r = toCameraWrites(d, camera);
    assert.equal(r.writes.length, 0, `0.${parameter} with no value must not write an endpoint`);
  }
  // Iris sent as INT8 instead of the documented fixed point.
  const wrongType = ccBody([0.5]);
  wrongType.writeUInt8(TYPE.INT8, WRAPPER.dataType);
  assert.equal(toCameraWrites(decodeCCdP(wrongType), camera).writes.length, 0);
});

test('coalescer drains never overlap and stop cancels the rest of an active batch', async () => {
  let active = 0, maxActive = 0;
  const sent = [];
  const c = new WriteCoalescer(async (cameraId, prop, value) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 30));
    sent.push(`${prop}=${value}`);
    active--;
  }, 5);
  c.submit('a', 'fNumber', 1);
  c.submit('a', 'iso', 1);
  await new Promise((r) => setTimeout(r, 15));   // first flush is mid-batch
  c.submit('a', 'fNumber', 2);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(maxActive, 1, 'two drains wrote concurrently');
  assert.deepEqual(sent, ['fNumber=1', 'iso=1', 'fNumber=2'], 'latest value applied last');

  sent.length = 0;
  c.submit('b', 'x', 1); c.submit('b', 'y', 1); c.submit('b', 'z', 1);
  await new Promise((r) => setTimeout(r, 20));    // first write in flight
  c.stop();
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(sent.length <= 1, `stop must cancel the remainder of the batch, sent ${sent}`);
});
