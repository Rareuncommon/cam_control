// The CamBridge Bluetooth LE protocol, version 1: the bytes between the phone
// app and the BLE gateway (src/ble/gateway.js). The Swift bridge on the Mac
// only carries them; it understands none of this. The full spec, with the
// reasoning, is docs/ble-protocol.md; protocol/vectors/v1.json holds worked
// examples both this file and the app are tested against.
//
// Three layers, outermost first:
//   1. Chunks: one GATT write or notification each. A message longer than one
//      chunk is split and reassembled here.
//   2. Messages: HELLO / AUTH / AUTH_OK / AUTH_FAIL in the clear, then
//      everything SEALED with AES-256-GCM under per-session keys.
//   3. Inside a sealed message: REQUEST / RESPONSE (REST over Bluetooth),
//      STATE (the event stream's frames), RESYNC, PING / PONG, NOTICE.
//
// Security does not rest on Bluetooth pairing. The link must be encrypted
// (bonded) to touch the data characteristics, but neither macOS nor Android
// lets an app insist on LE Secure Connections, so the phone also proves it
// holds its pairing secret (HMAC challenge), the server proves it back, and
// every message after that is sealed and numbered: nothing can be read,
// changed or replayed by anyone in range without the phone's key.

import { createHmac, createCipheriv, createDecipheriv, hkdfSync, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const VERSION = 1;

/** GATT: one service, three characteristics. */
export const UUIDS = Object.freeze({
  service: '8bc28765-0c3d-4e3a-b86e-7b066d7e4e4e',
  info: '8bc28766-0c3d-4e3a-b86e-7b066d7e4e4e', // read, open: {"v":1,"id":…,"name":…}
  rx: '8bc28767-0c3d-4e3a-b86e-7b066d7e4e4e',   // phone → Mac: write with response, encrypted link
  tx: '8bc28768-0c3d-4e3a-b86e-7b066d7e4e4e',   // Mac → phone: notify, encrypted link
});

export const T = Object.freeze({
  HELLO: 0x01, AUTH: 0x02, AUTH_OK: 0x03, AUTH_FAIL: 0x04, SEALED: 0x10,
  REQUEST: 0x20, RESPONSE: 0x21, STATE: 0x30, RESYNC: 0x31, PING: 0x40, PONG: 0x41, NOTICE: 0x50,
});

export const FAIL = Object.freeze({
  UNKNOWN_DEVICE: 1, PAIRING_EXPIRED: 2, BAD_PROOF: 3, RATE_LIMITED: 4, PROTOCOL: 5, TIMEOUT: 6,
});

export const MAX_MESSAGE = 256 * 1024;
export const NONCE_BYTES = 16;
const FLAG_FIRST = 0x80;
const FLAG_LAST = 0x40;
export const FLAG_DEFLATE = 0x01;
const DIR = Object.freeze({ phoneToServer: 1, serverToPhone: 2 });

const AUTH_LABEL = Buffer.from('CamBridge BLE auth v1\0');
const SERVER_LABEL = Buffer.from('CamBridge BLE server v1\0');
const SESSION_INFO = Buffer.from('CamBridge BLE session v1');

// --- chunks ----------------------------------------------------------------------

/**
 * Splits one message into chunks of at most `size` bytes.
 * The first chunk carries the total length; every chunk carries the
 * message counter (mod 64), so a lost or interleaved chunk is noticed.
 */
export function chunk(message, size, counter) {
  if (size < 8) throw new RangeError('chunk size must be at least 8');
  if (message.length > MAX_MESSAGE) throw new RangeError(`message of ${message.length} bytes exceeds ${MAX_MESSAGE}`);
  const out = [];
  const tag = counter & 0x3f;
  let offset = 0;
  let first = true;
  do {
    const head = first ? 4 : 1;
    const take = Math.min(size - head, message.length - offset);
    const last = offset + take >= message.length;
    const c = Buffer.alloc(head + take);
    c[0] = (first ? FLAG_FIRST : 0) | (last ? FLAG_LAST : 0) | tag;
    if (first) c.writeUIntBE(message.length, 1, 3);
    message.copy(c, head, offset, offset + take);
    out.push(c);
    offset += take;
    first = false;
  } while (offset < message.length);
  return out;
}

/** Reassembles chunks. `push` returns a whole message, or null; problems are counted, not thrown. */
export class Reassembler {
  constructor({ max = MAX_MESSAGE } = {}) {
    this.max = max;
    this.partial = null;
    this.errors = 0;
  }

  push(c) {
    if (!c || c.length < 1) { this.errors++; return null; }
    const flags = c[0];
    const tag = flags & 0x3f;
    if (flags & FLAG_FIRST) {
      if (this.partial) this.errors++; // an unfinished message was abandoned
      if (c.length < 4) { this.partial = null; this.errors++; return null; }
      const length = c.readUIntBE(1, 3);
      if (length > this.max) { this.partial = null; this.errors++; return null; }
      this.partial = { tag, length, parts: [c.subarray(4)], got: c.length - 4 };
    } else {
      if (!this.partial || this.partial.tag !== tag) { this.partial = null; this.errors++; return null; }
      this.partial.parts.push(c.subarray(1));
      this.partial.got += c.length - 1;
    }
    const p = this.partial;
    if (p.got > p.length) { this.partial = null; this.errors++; return null; }
    if (!(flags & FLAG_LAST)) return null;
    this.partial = null;
    if (p.got !== p.length) { this.errors++; return null; }
    return Buffer.concat(p.parts, p.length);
  }
}

// --- handshake ---------------------------------------------------------------------

export function encodeHello({ serverNonce, serverId }) {
  return Buffer.concat([Buffer.from([T.HELLO, VERSION]), serverNonce, Buffer.from(serverId, 'utf8')]);
}

export function decodeHello(m) {
  if (m[0] !== T.HELLO || m.length < 2 + NONCE_BYTES) throw new Error('not a HELLO');
  return { version: m[1], serverNonce: m.subarray(2, 2 + NONCE_BYTES), serverId: m.subarray(2 + NONCE_BYTES).toString('utf8') };
}

const authInput = (label, a, b, deviceId, serverId) =>
  Buffer.concat([label, a, b, Buffer.from(deviceId, 'utf8'), Buffer.from(serverId, 'utf8')]);

/** The phone's proof: it holds the key paired as `deviceId`. */
export function clientProof(key, { serverNonce, clientNonce, deviceId, serverId }) {
  return createHmac('sha256', key).update(authInput(AUTH_LABEL, serverNonce, clientNonce, deviceId, serverId)).digest();
}

/** The server's proof back: it holds the same key, so the phone is talking to its CamBridge. */
export function serverProof(key, { serverNonce, clientNonce, deviceId, serverId }) {
  return createHmac('sha256', key).update(authInput(SERVER_LABEL, clientNonce, serverNonce, deviceId, serverId)).digest();
}

export function encodeAuth({ deviceId, clientNonce, proof }) {
  const id = Buffer.from(deviceId, 'utf8');
  if (id.length > 64) throw new RangeError('device id too long');
  return Buffer.concat([Buffer.from([T.AUTH, VERSION, id.length]), id, clientNonce, proof]);
}

export function decodeAuth(m) {
  if (m[0] !== T.AUTH || m.length < 3) throw new Error('not an AUTH');
  const len = m[2];
  if (m.length !== 3 + len + NONCE_BYTES + 32) throw new Error('AUTH has the wrong length');
  return {
    version: m[1],
    deviceId: m.subarray(3, 3 + len).toString('utf8'),
    clientNonce: m.subarray(3 + len, 3 + len + NONCE_BYTES),
    proof: m.subarray(3 + len + NONCE_BYTES),
  };
}

export function encodeAuthOk(proof) { return Buffer.concat([Buffer.from([T.AUTH_OK]), proof]); }
export function encodeAuthFail(code, message) { return Buffer.concat([Buffer.from([T.AUTH_FAIL, code]), Buffer.from(message, 'utf8')]); }

export function proofsEqual(a, b) { return a.length === b.length && timingSafeEqual(a, b); }

/** Per-session keys, one per direction, from the device key and both nonces. */
export function sessionKeys(key, { serverNonce, clientNonce }) {
  const okm = Buffer.from(hkdfSync('sha256', key, Buffer.concat([serverNonce, clientNonce]), SESSION_INFO, 64));
  return { phoneToServer: okm.subarray(0, 32), serverToPhone: okm.subarray(32, 64) };
}

// --- sealing -------------------------------------------------------------------------

function iv(direction, counter) {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(direction, 0);
  b.writeBigUInt64BE(BigInt(counter), 4);
  return b;
}

/** One direction of a session: seals with an increasing counter, or opens and refuses anything not newer. */
export class Channel {
  constructor(key, direction) {
    this.key = key;
    this.direction = direction;
    this.sent = 0;
    this.received = 0;
  }

  seal(inner) {
    this.sent += 1;
    const head = Buffer.alloc(9);
    head[0] = T.SEALED;
    head.writeBigUInt64BE(BigInt(this.sent), 1);
    const c = createCipheriv('aes-256-gcm', this.key, iv(this.direction, this.sent));
    c.setAAD(head);
    const body = Buffer.concat([c.update(inner), c.final()]);
    return Buffer.concat([head, body, c.getAuthTag()]);
  }

  /** @returns {Buffer} the inner message; throws if forged, altered or replayed */
  open(m) {
    if (m[0] !== T.SEALED || m.length < 9 + 16 + 1) throw new Error('not a sealed message');
    const counter = Number(m.readBigUInt64BE(1));
    if (counter <= this.received) throw new Error('replayed or out-of-order message');
    const d = createDecipheriv('aes-256-gcm', this.key, iv(this.direction, counter));
    d.setAAD(m.subarray(0, 9));
    d.setAuthTag(m.subarray(m.length - 16));
    const inner = Buffer.concat([d.update(m.subarray(9, m.length - 16)), d.final()]);
    this.received = counter;
    return inner;
  }
}

export function channels(keys, side) {
  const p2s = new Channel(keys.phoneToServer, DIR.phoneToServer);
  const s2p = new Channel(keys.serverToPhone, DIR.serverToPhone);
  return side === 'server' ? { send: s2p, receive: p2s } : { send: p2s, receive: s2p };
}

// --- inner messages ------------------------------------------------------------------------

/** JSON payloads over a size are deflated (raw DEFLATE, RFC 1951): state frames shrink about tenfold. */
export function packJson(value, { deflateOver = 256 } = {}) {
  const raw = Buffer.from(value === undefined ? '' : JSON.stringify(value), 'utf8');
  if (raw.length > deflateOver) {
    const packed = deflateRawSync(raw);
    if (packed.length < raw.length) return { flags: FLAG_DEFLATE, payload: packed };
  }
  return { flags: 0, payload: raw };
}

export function unpackJson(flags, payload) {
  const raw = flags & FLAG_DEFLATE ? inflateRawSync(payload, { maxOutputLength: 8 * MAX_MESSAGE }) : payload;
  return raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
}

export function encodeRequest(reqId, { method, path, body }) {
  const { flags, payload } = packJson({ m: method, p: path, ...(body === undefined ? {} : { b: body }) });
  const head = Buffer.alloc(6);
  head[0] = T.REQUEST;
  head.writeUInt32BE(reqId >>> 0, 1);
  head[5] = flags;
  return Buffer.concat([head, payload]);
}

export function decodeRequest(m) {
  if (m[0] !== T.REQUEST || m.length < 6) throw new Error('not a REQUEST');
  const v = unpackJson(m[5], m.subarray(6));
  if (!v || typeof v.m !== 'string' || typeof v.p !== 'string') throw new Error('REQUEST needs m and p');
  return { reqId: m.readUInt32BE(1), method: v.m.toUpperCase(), path: v.p, body: v.b };
}

export function encodeResponse(reqId, status, body) {
  const { flags, payload } = packJson(body);
  const head = Buffer.alloc(8);
  head[0] = T.RESPONSE;
  head.writeUInt32BE(reqId >>> 0, 1);
  head.writeUInt16BE(status, 5);
  head[7] = flags;
  return Buffer.concat([head, payload]);
}

export function decodeResponse(m) {
  if (m[0] !== T.RESPONSE || m.length < 8) throw new Error('not a RESPONSE');
  return { reqId: m.readUInt32BE(1), status: m.readUInt16BE(5), body: unpackJson(m[7], m.subarray(8)) };
}

export function encodeState(seq, frame) {
  const { flags, payload } = packJson(frame, { deflateOver: 0 });
  const head = Buffer.alloc(6);
  head[0] = T.STATE;
  head.writeUInt32BE(seq >>> 0, 1);
  head[5] = flags;
  return Buffer.concat([head, payload]);
}

export function decodeState(m) {
  if (m[0] !== T.STATE || m.length < 6) throw new Error('not a STATE');
  return { seq: m.readUInt32BE(1), frame: unpackJson(m[5], m.subarray(6)) };
}

export function encodePing(type, t) {
  const b = Buffer.alloc(9);
  b[0] = type;
  b.writeBigUInt64BE(BigInt(t), 1);
  return b;
}

export function encodeNotice(notice) {
  return Buffer.concat([Buffer.from([T.NOTICE]), Buffer.from(JSON.stringify(notice), 'utf8')]);
}
