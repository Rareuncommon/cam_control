// E1.31 framing, byte by byte.
//
// The expected bytes are written out by hand from the layout in ANSI E1.31-2018
// rather than produced by the same code under test, so a mistake in the
// builder cannot be agreed with by the checker.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDataPacket, parseDataPacket, multicastAddress, cidBytes, newCid,
  SACN_PORT, OPTION_STREAM_TERMINATED,
} from '../src/lighting/sacn.js';

const CID = '0f5c2d1e-9a8b-4c7d-8e6f-112233445566';

test('a full-universe data packet has the E1.31 layout', () => {
  const slots = new Uint8Array(512);
  slots.set([175, 12, 178, 12, 20, 12, 30, 12, 6, 12]);
  const b = buildDataPacket({ cid: CID, sourceName: 'CamBridge', priority: 100, sequence: 7, universe: 1, slots });

  assert.equal(b.length, 638);
  const hex = (from, to) => b.subarray(from, to).toString('hex');
  // Root layer.
  assert.equal(hex(0, 2), '0010', 'preamble size');
  assert.equal(hex(2, 4), '0000', 'post-amble size');
  assert.equal(hex(4, 16), '4153432d45312e3137000000', 'ACN packet identifier "ASC-E1.17\\0\\0\\0"');
  assert.equal(hex(16, 18), '726e', 'root flags+length: 0x7000 | 622');
  assert.equal(hex(18, 22), '00000004', 'VECTOR_ROOT_E131_DATA');
  assert.equal(hex(22, 38), '0f5c2d1e9a8b4c7d8e6f112233445566', 'CID');
  // Framing layer.
  assert.equal(hex(38, 40), '7258', 'framing flags+length: 0x7000 | 600');
  assert.equal(hex(40, 44), '00000002', 'VECTOR_E131_DATA_PACKET');
  assert.equal(b.subarray(44, 53).toString('utf8'), 'CamBridge');
  assert.ok(b.subarray(53, 108).every((x) => x === 0), 'source name NUL-padded to 64 bytes');
  assert.equal(b[108], 100, 'priority');
  assert.equal(hex(109, 111), '0000', 'synchronization address: none');
  assert.equal(b[111], 7, 'sequence number');
  assert.equal(b[112], 0, 'options');
  assert.equal(hex(113, 115), '0001', 'universe');
  // DMP layer.
  assert.equal(hex(115, 117), '720b', 'DMP flags+length: 0x7000 | 523');
  assert.equal(b[117], 0x02, 'VECTOR_DMP_SET_PROPERTY');
  assert.equal(b[118], 0xa1, 'address type and data type');
  assert.equal(hex(119, 121), '0000', 'first property address');
  assert.equal(hex(121, 123), '0001', 'address increment');
  assert.equal(hex(123, 125), '0201', 'property value count: START code + 512');
  assert.equal(b[125], 0x00, 'DMX START code');
  assert.deepEqual([...b.subarray(126, 136)], [175, 12, 178, 12, 20, 12, 30, 12, 6, 12]);
  assert.ok(b.subarray(136).every((x) => x === 0));
});

test('the reader accepts what the builder writes and names a broken field', () => {
  const slots = [1, 2, 3];
  const b = buildDataPacket({ cid: CID, sourceName: 'CamBridge', priority: 150, sequence: 255, universe: 300, slots, options: OPTION_STREAM_TERMINATED });
  const p = parseDataPacket(b);
  assert.equal(p.cid, CID);
  assert.equal(p.sourceName, 'CamBridge');
  assert.equal(p.priority, 150);
  assert.equal(p.sequence, 255);
  assert.equal(p.universe, 300);
  assert.equal(p.options, 0x40);
  assert.deepEqual(p.slots, slots);
  const broken = Buffer.from(b);
  broken[117] = 0x03;
  assert.throws(() => parseDataPacket(broken), /DMP vector/);
});

test('a long source name is cut to 63 bytes without splitting a character', () => {
  const name = `${'x'.repeat(62)}é and more`;   // é is two bytes and would straddle byte 63
  const p = parseDataPacket(buildDataPacket({ cid: CID, sourceName: name, sequence: 0, universe: 1, slots: [0] }));
  assert.equal(p.sourceName, 'x'.repeat(62));
});

test('out-of-range universe, priority or slot count is refused, not wrapped', () => {
  const base = { cid: CID, sourceName: 's', sequence: 0, slots: [0] };
  assert.throws(() => buildDataPacket({ ...base, universe: 0 }), /universe/);
  assert.throws(() => buildDataPacket({ ...base, universe: 64000 }), /universe/);
  assert.throws(() => buildDataPacket({ ...base, universe: 1, priority: 201 }), /priority/);
  assert.throws(() => buildDataPacket({ ...base, universe: 1, slots: new Uint8Array(513) }), /slot count/);
  assert.throws(() => buildDataPacket({ ...base, universe: 1, cid: 'not-a-uuid' }), /CID/);
});

test('multicast groups, port and CIDs', () => {
  assert.equal(SACN_PORT, 5568);
  assert.equal(multicastAddress(1), '239.255.0.1');
  assert.equal(multicastAddress(300), '239.255.1.44');
  assert.equal(multicastAddress(63999), '239.255.249.255');
  const cid = newCid();
  assert.equal(cidBytes(cid).length, 16);
  assert.notEqual(newCid(), cid);
});
