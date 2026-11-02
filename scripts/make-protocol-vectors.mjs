// Writes protocol/vectors/v1.json: worked examples of everything the phone
// app and CamBridge must agree on byte for byte — request signing, the
// Bluetooth handshake, session keys, sealing, chunking, message encodings,
// the state patch merge and the pairing QR. The app's tests read the same
// file (mobile/core), and cambridge's tests check it is current, so the two
// implementations cannot drift apart unnoticed.
//
//   node scripts/make-protocol-vectors.mjs           write it
//   node scripts/make-protocol-vectors.mjs --check   fail if it is stale

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const P = await import(new URL('cambridge/src/ble/protocol.js', root).href);
const { canonicalRequest, signRequest } = await import(new URL('cambridge/src/devices.js', root).href);
const { applyPatch } = await import(new URL('cambridge/public/patch.js', root).href);
const { qrMatrix } = await import(new URL('cambridge/src/qr.js', root).href);

/** Deterministic bytes: the vectors must not change from run to run. */
const bytes = (label, n) => {
  let out = Buffer.alloc(0);
  for (let i = 0; out.length < n; i++) out = Buffer.concat([out, createHash('sha256').update(`${label}:${i}`).digest()]);
  return out.subarray(0, n);
};
const hex = (b) => Buffer.from(b).toString('hex');

const deviceKey = bytes('device-key', 32);
const deviceId = 'ph-0123456789ab';
const serverId = '0123456789abcdef';
const serverNonce = bytes('server-nonce', 16);
const clientNonce = bytes('client-nonce', 16);
const parts = { serverNonce, clientNonce, deviceId, serverId };
const keys = P.sessionKeys(deviceKey, parts);

// Signed HTTP requests.
const http = [
  { method: 'GET', target: '/api/state', ts: '1800000000000', nonce: 'AAAAAAAAAAAAAAAAAAAAAA', body: '' },
  { method: 'PUT', target: '/api/cameras/fx3/properties/isoSensitivity', ts: '1800000001234', nonce: 'nonce-0123456789abcd', body: '{"value":800}' },
  { method: 'POST', target: '/api/lighting/set?x=1', ts: '1800000005000', nonce: 'Zm9vYmFyYmF6cXV4cXV1eA', body: '{"target":{"all":true},"intensity":50,"fadeMs":1000}' },
].map((r) => {
  const body = Buffer.from(r.body, 'utf8');
  return {
    ...r,
    canonical: canonicalRequest({ ...r, body }),
    signature: signRequest(deviceKey, { ...r, body }),
    header: `CamBridge-HMAC id=${deviceId}, ts=${r.ts}, nonce=${r.nonce}, sig=${signRequest(deviceKey, { ...r, body })}`,
  };
});

// Sealing: the first two messages each way of a session.
const phone = P.channels(keys, 'phone');
const server = P.channels(keys, 'server');
const reqInner = P.encodeRequest(7, { method: 'POST', path: '/api/record-all', body: { start: true } });
const sealed = [
  { direction: 'phoneToServer', counter: 1, inner: hex(reqInner), sealed: hex(phone.send.seal(reqInner)) },
  { direction: 'phoneToServer', counter: 2, inner: hex(Buffer.from([P.T.RESYNC])), sealed: hex(phone.send.seal(Buffer.from([P.T.RESYNC]))) },
  { direction: 'serverToPhone', counter: 1, inner: hex(P.encodeResponse(7, 200, { ok: true })), sealed: hex(server.send.seal(P.encodeResponse(7, 200, { ok: true }))) },
];

// Chunking.
const chunkMsg = bytes('chunk-message', 300);
const chunking = [20, 185].map((size) => ({ size, counter: 5, message: hex(chunkMsg), chunks: P.chunk(chunkMsg, size, 5).map(hex) }));

// Message encodings. Deflated payloads are decode-only: zlib and java.util.zip
// need not produce the same bytes, only the same meaning.
const stateFrame = { type: 'patch', cameras: { fx3: { status: { recording: true, battery: 80 } } }, lighting: { known: true } };
const bigState = { type: 'state', view: { camdConnected: true, cameras: Array.from({ length: 3 }, (_, i) => ({ id: `cam${i}`, label: `Camera ${i}`, properties: { isoSensitivity: { raw: 800, label: 'ISO 800', writable: true } } })) } };
const messages = {
  hello: { serverNonce: hex(serverNonce), serverId, bytes: hex(P.encodeHello({ serverNonce, serverId })) },
  auth: { deviceId, clientNonce: hex(clientNonce), proof: hex(P.clientProof(deviceKey, parts)), bytes: hex(P.encodeAuth({ deviceId, clientNonce, proof: P.clientProof(deviceKey, parts) })) },
  authOk: hex(P.encodeAuthOk(P.serverProof(deviceKey, parts))),
  authFail: hex(P.encodeAuthFail(P.FAIL.BAD_PROOF, 'the proof does not match')),
  request: { reqId: 7, method: 'POST', path: '/api/record-all', body: { start: true }, bytes: hex(reqInner) },
  response: { reqId: 7, status: 200, body: { ok: true }, bytes: hex(P.encodeResponse(7, 200, { ok: true })) },
  stateSmall: { seq: 3, frame: stateFrame, bytes: hex(P.encodeState(3, stateFrame)), decodeOnly: true },
  stateDeflated: { seq: 4, frame: bigState, bytes: hex(P.encodeState(4, bigState)), decodeOnly: true },
  ping: { t: '1800000000000', bytes: hex(P.encodePing(P.T.PING, 1800000000000)) },
  notice: { notice: { code: 'revoked', message: 'This phone was revoked in CamBridge Setup.' }, bytes: hex(P.encodeNotice({ code: 'revoked', message: 'This phone was revoked in CamBridge Setup.' })) },
};
// Sanity: the deflated vector really is deflated.
if (!(Buffer.from(messages.stateDeflated.bytes, 'hex')[5] & P.FLAG_DEFLATE)) throw new Error('expected a deflated state vector');
inflateRawSync(Buffer.from(messages.stateDeflated.bytes, 'hex').subarray(6));

// The state patch merge (cambridge/public/patch.js).
const frame0 = {
  type: 'state',
  view: { camdConnected: true, cameras: [
    { id: 'fx3', label: 'Wide', state: 'connected', status: { recording: false, battery: 90 }, properties: { fNumber: { raw: 400, label: 'f/4.0' }, isoSensitivity: { raw: 800, label: 'ISO 800' } } },
    { id: 'fx30a', label: 'Centre', state: 'connected', status: { recording: false, battery: 70 }, properties: { fNumber: { raw: 280, label: 'f/2.8' } } },
  ] },
  alarms: [], lighting: { known: false },
};
const patches = [
  { type: 'patch', view: { camdConnected: true }, cameras: { fx3: { properties: { isoSensitivity: { raw: 1600, label: 'ISO 1600' } } } }, alarms: [] },
  { type: 'patch', cameras: { fx30a: { status: { recording: true, battery: 69 }, recordStartedAt: 1800000000000 } }, lighting: { known: true, fixtures: [] } },
  { type: 'patch', cameras: { fx3: { replace: true, id: 'fx3', label: 'Wide (renamed)', state: 'offline', status: {}, properties: {} } } },
  { type: 'patch', cameras: { fx3: { properties: { fNumber: { raw: 560, label: 'f/5.6' } }, replaceProperties: true } } },
  { type: 'patch', cameras: { ghost: { status: { recording: true } } } },
];
let f = frame0;
const patchSteps = patches.map((p) => {
  const r = applyPatch(f, p);
  const step = { patch: p, expected: r.frame, changed: [...r.changed], resync: r.resync };
  f = r.frame;
  return step;
});

// The pairing QR.
const pairingUri = `cambridge://pair?v=1&sid=${serverId}&sn=Studio&h=192.168.1.20%2C192.168.220.66&p=8088&id=${deviceId}&k=${deviceKey.toString('base64url')}&exp=1800000600`;
const qr = { uri: pairingUri, rows: qrMatrix(pairingUri).map((row) => row.map((d) => (d ? '1' : '0')).join('')) };

const vectors = {
  $comment: 'Generated by scripts/make-protocol-vectors.mjs. Do not edit by hand.',
  version: 1,
  uuids: P.UUIDS,
  deviceKey: hex(deviceKey),
  deviceKeyBase64Url: deviceKey.toString('base64url'),
  deviceId,
  serverId,
  http,
  handshake: {
    serverNonce: hex(serverNonce), clientNonce: hex(clientNonce),
    clientProof: hex(P.clientProof(deviceKey, parts)), serverProof: hex(P.serverProof(deviceKey, parts)),
    phoneToServerKey: hex(keys.phoneToServer), serverToPhoneKey: hex(keys.serverToPhone),
  },
  sealed,
  chunking,
  messages,
  patch: { initial: frame0, steps: patchSteps },
  qr,
};

const out = `${JSON.stringify(vectors, null, 2)}\n`;
const path = new URL('protocol/vectors/v1.json', root);
if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(path, 'utf8'); } catch { /* missing */ }
  if (current !== out) { console.error('protocol/vectors/v1.json is stale: run node scripts/make-protocol-vectors.mjs'); process.exit(1); }
  console.log('protocol vectors are current');
} else {
  mkdirSync(new URL('protocol/vectors/', root), { recursive: true });
  writeFileSync(path, out);
  console.log(`wrote protocol/vectors/v1.json (${out.length} bytes)`);
}
