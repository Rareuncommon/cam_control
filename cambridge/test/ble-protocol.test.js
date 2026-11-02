// The Bluetooth protocol's pieces on their own: chunking, the handshake
// proofs, session keys, sealing, and the message codecs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import * as P from '../src/ble/protocol.js';

test('chunks round-trip at every MTU, including empty and maximum messages', () => {
  for (const size of [8, 20, 23, 185, 244, 512]) {
    for (const len of [0, 1, 15, 16, 17, 500, 4096, P.MAX_MESSAGE]) {
      const msg = randomBytes(len);
      const chunks = P.chunk(msg, size, 7);
      assert.ok(chunks.every((c) => c.length <= size), `chunks fit ${size}`);
      assert.equal(chunks[0][0] & 0x80, 0x80, 'first flag');
      assert.equal(chunks.at(-1)[0] & 0x40, 0x40, 'last flag');
      const r = new P.Reassembler();
      let out = null;
      for (const c of chunks) out = r.push(c) ?? out;
      assert.ok(out && out.equals(msg), `size ${size}, length ${len}`);
      assert.equal(r.errors, 0);
    }
  }
  assert.throws(() => P.chunk(Buffer.alloc(P.MAX_MESSAGE + 1), 512, 0), RangeError);
});

test('a lost, foreign or over-long chunk is dropped, not misassembled', () => {
  const a = P.chunk(Buffer.alloc(100, 1), 20, 1);
  const b = P.chunk(Buffer.alloc(100, 2), 20, 2);
  const r = new P.Reassembler();
  r.push(a[0]); r.push(a[1]);
  assert.equal(r.push(b[2]), null, 'a chunk of another message');
  assert.ok(r.errors > 0);
  const r2 = new P.Reassembler();
  for (const c of a.slice(0, -2)) r2.push(c);
  assert.equal(r2.push(a.at(-1)), null, 'a missing middle chunk');
  const r3 = new P.Reassembler({ max: 50 });
  assert.equal(r3.push(a[0]), null, 'over the limit');
  assert.equal(r3.errors, 1);
  const r4 = new P.Reassembler();
  r4.push(a[0]);
  let out = null;
  for (const c of b) out = r4.push(c) ?? out;
  assert.ok(out.equals(Buffer.alloc(100, 2)), 'a new first chunk starts over');
});

test('the handshake: proofs bind both nonces, the device and the server', () => {
  const key = randomBytes(32);
  const parts = { serverNonce: randomBytes(16), clientNonce: randomBytes(16), deviceId: 'ph-1', serverId: '0123456789abcdef' };
  const proof = P.clientProof(key, parts);
  for (const k of Object.keys(parts)) {
    const changed = { ...parts, [k]: typeof parts[k] === 'string' ? `${parts[k]}x` : randomBytes(16) };
    assert.ok(!P.proofsEqual(proof, P.clientProof(key, changed)), `${k} matters`);
  }
  assert.ok(!P.proofsEqual(proof, P.serverProof(key, parts)), 'the two directions differ');
  const a = P.decodeAuth(P.encodeAuth({ deviceId: 'ph-1', clientNonce: parts.clientNonce, proof }));
  assert.deepEqual([a.deviceId, a.clientNonce.equals(parts.clientNonce), a.proof.equals(proof)], ['ph-1', true, true]);
  const h = P.decodeHello(P.encodeHello({ serverNonce: parts.serverNonce, serverId: parts.serverId }));
  assert.equal(h.serverId, parts.serverId);
});

test('sealed messages: readable only with the key, once, in order, unaltered', () => {
  const keys = P.sessionKeys(randomBytes(32), { serverNonce: randomBytes(16), clientNonce: randomBytes(16) });
  const phone = P.channels(keys, 'phone');
  const server = P.channels(keys, 'server');
  const m1 = phone.send.seal(Buffer.from('one'));
  const m2 = phone.send.seal(Buffer.from('two'));
  assert.equal(server.receive.open(m1).toString(), 'one');
  assert.throws(() => server.receive.open(m1), /replayed/);
  const bad = Buffer.from(m2);
  bad[12] ^= 1;
  assert.throws(() => server.receive.open(bad));
  assert.equal(server.receive.open(m2).toString(), 'two');
  assert.throws(() => phone.receive.open(phone.send.seal(Buffer.from('x'))), 'a message cannot be reflected back');
  const other = P.channels(P.sessionKeys(randomBytes(32), { serverNonce: randomBytes(16), clientNonce: randomBytes(16) }), 'server');
  assert.throws(() => other.receive.open(phone.send.seal(Buffer.from('x'))), 'another session cannot read it');
});

test('requests, responses and state frames, with deflate when it helps', () => {
  const r = P.decodeRequest(P.encodeRequest(42, { method: 'put', path: '/api/cameras/a/properties/iso', body: { value: 800 } }));
  assert.deepEqual(r, { reqId: 42, method: 'PUT', path: '/api/cameras/a/properties/iso', body: { value: 800 } });
  const big = { cameras: Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, label: 'Camera', properties: { iso: { raw: 800, label: 'ISO 800' } } })) };
  const s = P.encodeState(9, big);
  assert.equal(s[5] & P.FLAG_DEFLATE, P.FLAG_DEFLATE);
  assert.ok(s.length < JSON.stringify(big).length / 4, 'state compresses well');
  assert.deepEqual(P.decodeState(s), { seq: 9, frame: big });
  assert.deepEqual(P.decodeResponse(P.encodeResponse(7, 409, { ok: false })), { reqId: 7, status: 409, body: { ok: false } });
  assert.deepEqual(P.decodeResponse(P.encodeResponse(8, 204)), { reqId: 8, status: 204, body: undefined });
});
