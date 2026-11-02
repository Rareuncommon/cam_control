// The Bluetooth gateway: where phones on Bluetooth become CamBridge clients.
//
// The Swift bridge (blebridge/) owns the radio and nothing else. It connects
// to this gateway over a Unix socket beside the config (mode 0600, so only
// this Mac user can), and passes each phone's GATT writes in and our
// notifications out, as newline-delimited JSON:
//
//   bridge → gateway  {t:"hello", v:1, bridge}   {t:"bt", state}
//                     {t:"connect", c, mtu}  {t:"mtu", c, mtu}
//                     {t:"write", c, d}       {t:"disconnect", c}
//   gateway → bridge  {t:"info", d}           {t:"notify", c, d}
//                     {t:"block", c, ms}
//
// `c` is a central's id, `d` base64 bytes. Everything that matters happens
// here: the handshake, sealing, requests, state. See protocol.js and
// docs/ble-protocol.md.
//
// A request from a phone runs through the same router as a request over
// Wi-Fi, as that paired phone: same permissions, same logging, no second
// command set to keep in step.

import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync, chmodSync, statSync } from 'node:fs';

import * as P from './protocol.js';

const AUTH_TIMEOUT_MS = 10_000;
const MAX_AUTH_TRIES = 3;
const DEVICE_FAILS = 5;
const DEVICE_COOLDOWN_MS = 60_000;
const BLOCK_MS = 60_000;
const DEDUPE_MS = 120_000;
const DEDUPE_MAX = 256;
const BUCKET = { capacity: 40, perSecond: 20 };
const MAX_LINE = 2 * 1024 * 1024;
const MAX_REQUEST_BODY = 64 * 1024;

/** Camera fields the app does not use: dropped from frames sent over Bluetooth. */
const HEAVY_CAMERA_FIELDS = ['ip', 'mac', 'deviceId', 'hostKey', 'fingerprint', 'observedFingerprint', 'support', 'transport', 'reconnectAttempts'];
const HEAVY_ENVELOPE = ['skaarhoj', 'undo'];

/** A state or patch frame, slimmed for Bluetooth. */
export function compactFrame(frame) {
  const out = { ...frame };
  for (const k of HEAVY_ENVELOPE) delete out[k];
  const strip = (cam) => {
    const c = { ...cam };
    for (const k of HEAVY_CAMERA_FIELDS) delete c[k];
    return c;
  };
  if (out.view?.cameras) out.view = { ...out.view, cameras: out.view.cameras.map(strip) };
  if (out.cameras) out.cameras = Object.fromEntries(Object.entries(out.cameras).map(([id, p]) => [id, p.replace ? strip(p) : p]));
  return out;
}

export class BleGateway extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.socketPath
   * @param {import('../devices.js').DeviceRegistry} o.devices
   * @param {(r: {method: string, target: string, body: any, device: object}) => Promise<{status: number, contentType: string, body: Buffer}>} o.dispatch
   * @param {() => {id: string, name: string}} o.serverInfo
   * @param {(fn: (u: {full: object, patch: object|null}) => void) => () => void} o.subscribe
   *   live state: called with the current full frame and the patch that made
   *   it (null when a whole new frame was sent)
   * @param {(level: string, msg: string) => void} [o.log]
   * @param {() => number} [o.now]
   * @param {number} [o.authTimeoutMs]
   */
  constructor({ socketPath, devices, dispatch, serverInfo, subscribe, log = () => {}, now = Date.now, authTimeoutMs = AUTH_TIMEOUT_MS }) {
    super();
    Object.assign(this, { socketPath, devices, dispatch, serverInfo, subscribe, log, now, authTimeoutMs });
    this.bridge = null;
    this.bridgeInfo = null;
    this.bluetooth = 'unknown';
    this.sessions = new Map();          // central id -> Session
    this.deviceFails = new Map();       // device id -> [times]
    this.dedupe = new Map();            // `${device}:${reqId}` -> {at, inner|null, waiters}
    this.buckets = new Map();           // device id -> {tokens, at}
    this.latest = null;                 // the current full frame
    this.unsubscribe = null;
    this.server = null;
    this.onRevoked = (id) => this.#revoked(id);
  }

  start() {
    if (this.socketPath.length > 100) {
      this.log('error', `ble: socket path too long for a Unix socket (${this.socketPath.length} chars): ${this.socketPath}`);
      return;
    }
    // A socket left by a crash would stop listen(); a file that is not a socket is left alone.
    try { if (existsSync(this.socketPath) && statSync(this.socketPath).isSocket()) rmSync(this.socketPath); } catch { /* checked below */ }
    this.server = createServer((sock) => this.#accept(sock));
    this.server.on('error', (err) => this.log('error', `ble: gateway socket: ${err.message}`));
    this.server.listen(this.socketPath, () => {
      try { chmodSync(this.socketPath, 0o600); } catch (err) { this.log('warn', `ble: cannot restrict the socket: ${err.message}`); }
      this.log('info', `ble: waiting for the bridge on ${this.socketPath}`);
    });
    this.server.unref?.();
    this.devices.on('revoked', this.onRevoked);
    this.unsubscribe = this.subscribe((u) => this.#onFrame(u));
  }

  stop() {
    this.devices.off('revoked', this.onRevoked);
    this.unsubscribe?.();
    for (const s of this.sessions.values()) clearTimeout(s.authTimer);
    this.sessions.clear();
    this.bridge?.destroy();
    this.bridge = null;
    this.server?.close();
    try { if (existsSync(this.socketPath)) rmSync(this.socketPath); } catch { /* gone */ }
  }

  status() {
    return {
      bridge: !!this.bridge,
      bridgeVersion: this.bridgeInfo,
      bluetooth: this.bluetooth,
      phones: [...this.sessions.values()].filter((s) => s.state === 'open').map((s) => s.device.id),
    };
  }

  // --- the bridge link ----------------------------------------------------------------

  #accept(sock) {
    if (this.bridge) {
      this.log('warn', 'ble: a second bridge connected; replacing the first');
      this.bridge.destroy();
      this.sessions.clear();
    }
    this.bridge = sock;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_LINE) { this.log('error', 'ble: bridge sent an over-long line; dropping it'); sock.destroy(); return; }
      let at;
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { this.log('warn', 'ble: unreadable line from the bridge'); continue; }
        try { this.#fromBridge(msg); } catch (err) { this.log('error', `ble: ${err.message}`); }
      }
    });
    const gone = () => {
      if (this.bridge !== sock) return;
      this.bridge = null;
      this.sessions.clear();
      this.log('warn', 'ble: bridge disconnected');
      this.emit('status');
    };
    sock.on('close', gone);
    sock.on('error', () => {});
  }

  #toBridge(msg) {
    if (!this.bridge) return;
    try { this.bridge.write(`${JSON.stringify(msg)}\n`); } catch { /* the close handler tidies up */ }
  }

  #fromBridge(m) {
    switch (m.t) {
      case 'hello': {
        this.bridgeInfo = typeof m.bridge === 'string' ? m.bridge.slice(0, 60) : 'blebridge';
        if (typeof m.bt === 'string') this.bluetooth = m.bt;
        const info = this.serverInfo();
        this.#toBridge({ t: 'info', d: Buffer.from(JSON.stringify({ v: P.VERSION, id: info.id, name: info.name })).toString('base64') });
        this.log('info', `ble: bridge connected (${this.bridgeInfo}), Bluetooth ${this.bluetooth}`);
        this.emit('status');
        return;
      }
      case 'bt':
        this.bluetooth = String(m.state ?? 'unknown');
        this.log(this.bluetooth === 'poweredOn' ? 'info' : 'warn', `ble: Bluetooth is ${this.bluetooth}`);
        this.emit('status');
        return;
      case 'connect': this.#session(m.c, m.mtu); return;
      case 'mtu': { const s = this.sessions.get(m.c); if (s) s.mtu = clampMtu(m.mtu); return; }
      case 'write': this.#write(m.c, m.d); return;
      case 'disconnect': {
        const s = this.sessions.get(m.c);
        if (s) { clearTimeout(s.authTimer); this.sessions.delete(m.c); if (s.device) this.log('info', `ble: ${label(s)} disconnected`); }
        return;
      }
      default:
    }
  }

  // --- sessions ---------------------------------------------------------------------------

  #session(central, mtu) {
    if (typeof central !== 'string' || !central) return null;
    let s = this.sessions.get(central);
    if (s) { if (mtu) s.mtu = clampMtu(mtu); return s; }
    s = {
      central, mtu: clampMtu(mtu), state: 'hello', reasm: new P.Reassembler(), out: 0, tries: 0, errors: 0,
      serverNonce: randomBytes(P.NONCE_BYTES), device: null, pending: false, ch: null, seq: 0,
    };
    // Anyone in range can connect; nobody gets anywhere without proving the key, quickly.
    s.authTimer = setTimeout(() => this.#refuse(s, P.FAIL.TIMEOUT, 'no authentication in time'), this.authTimeoutMs);
    s.authTimer.unref?.();
    this.sessions.set(central, s);
    this.#send(s, P.encodeHello({ serverNonce: s.serverNonce, serverId: this.serverInfo().id }));
    return s;
  }

  #send(s, message) {
    if (!this.sessions.has(s.central)) return;
    s.out = (s.out + 1) & 0x3f;
    for (const c of P.chunk(message, s.mtu, s.out)) this.#toBridge({ t: 'notify', c: s.central, d: c.toString('base64') });
  }

  #sendSealed(s, inner) {
    this.#send(s, s.ch.send.seal(inner));
  }

  #refuse(s, code, why) {
    if (!this.sessions.has(s.central)) return;
    this.#send(s, P.encodeAuthFail(code, why));
    this.log('warn', `ble: refused ${s.central.slice(0, 8)}${s.device ? ` (${s.device.id})` : ''}: ${why}`);
    this.#close(s);
  }

  #close(s) {
    clearTimeout(s.authTimer);
    this.sessions.delete(s.central);
    // CoreBluetooth gives a peripheral no way to disconnect a central; the
    // bridge refuses its writes for a while instead.
    this.#toBridge({ t: 'block', c: s.central, ms: BLOCK_MS });
  }

  #write(central, d) {
    const s = this.sessions.get(central) ?? this.#session(central, 0);
    if (!s) return;
    let bytes;
    try { bytes = Buffer.from(String(d), 'base64'); } catch { return; }
    const message = s.reasm.push(bytes);
    if (s.reasm.errors > 8) { this.#refuse(s, P.FAIL.PROTOCOL, 'too many malformed chunks'); return; }
    if (!message) return;
    if (s.state === 'hello') { this.#auth(s, message); return; }
    let inner;
    try {
      inner = s.ch.receive.open(message);
    } catch (err) {
      s.errors += 1;
      this.log('warn', `ble: ${label(s)}: ${err.message}`);
      if (s.errors >= 3) this.#refuse(s, P.FAIL.PROTOCOL, 'messages that do not open');
      return;
    }
    this.#inner(s, inner).catch((err) => this.log('error', `ble: ${label(s)}: ${err.message}`));
  }

  #auth(s, message) {
    let a;
    try { a = P.decodeAuth(message); } catch { this.#refuse(s, P.FAIL.PROTOCOL, 'expected AUTH'); return; }
    if (a.version !== P.VERSION) { this.#refuse(s, P.FAIL.PROTOCOL, `protocol version ${a.version} is not supported`); return; }
    if (this.#deviceCoolingDown(a.deviceId)) { this.#refuse(s, P.FAIL.RATE_LIMITED, 'too many failed attempts; wait a minute'); return; }
    const k = this.devices.keyFor(a.deviceId);
    const fail = (code, why) => {
      this.#deviceFailed(a.deviceId);
      s.tries += 1;
      if (s.tries >= MAX_AUTH_TRIES) { this.#refuse(s, code, why); return; }
      this.#send(s, P.encodeAuthFail(code, why));
    };
    if (!k.ok) {
      fail(k.reason === 'pairing-expired' ? P.FAIL.PAIRING_EXPIRED : P.FAIL.UNKNOWN_DEVICE,
        k.reason === 'pairing-expired' ? 'the pairing code expired; pair again' : 'this phone is not paired with CamBridge, or was revoked');
      return;
    }
    const serverId = this.serverInfo().id;
    const parts = { serverNonce: s.serverNonce, clientNonce: a.clientNonce, deviceId: a.deviceId, serverId };
    if (!P.proofsEqual(a.proof, P.clientProof(k.key, parts))) { fail(P.FAIL.BAD_PROOF, 'the proof does not match'); return; }
    clearTimeout(s.authTimer);
    s.state = 'open';
    s.device = k.device;
    s.pending = k.device.status === 'pending';
    s.ch = P.channels(P.sessionKeys(k.key, parts), 'server');
    this.devices.touch(a.deviceId, 'ble');
    this.#send(s, P.encodeAuthOk(P.serverProof(k.key, parts)));
    this.log('info', `ble: ${label(s)} connected${s.pending ? ' (finishing pairing)' : ''}`);
    this.emit('status');
    if (!s.pending) this.#sendFull(s);
  }

  async #inner(s, inner) {
    switch (inner[0]) {
      case P.T.REQUEST: return this.#request(s, inner);
      case P.T.RESYNC: if (!s.pending) this.#sendFull(s); return undefined;
      case P.T.PING: this.#sendSealed(s, P.encodePing(P.T.PONG, inner.readBigUInt64BE(1))); return undefined;
      default: this.log('warn', `ble: ${label(s)}: unknown message 0x${inner[0].toString(16)}`); return undefined;
    }
  }

  async #request(s, inner) {
    let r;
    try { r = P.decodeRequest(inner); } catch (err) { this.log('warn', `ble: ${label(s)}: ${err.message}`); return; }
    const key = `${s.device.id}:${r.reqId}`;
    const reply = (status, body) => P.encodeResponse(r.reqId, status, body);
    this.#sweepDedupe();
    const seen = this.dedupe.get(key);
    if (seen) {
      // A retry after a dropped link: the same answer, not a second run.
      if (seen.inner) this.#sendSealed(s, seen.inner);
      else seen.waiters.push(s);
      return;
    }
    if (!this.#take(s.device.id)) { this.#sendSealed(s, reply(429, { error: 'too many commands; slow down' })); return; }
    const entry = { at: this.now(), inner: null, waiters: [s] };
    this.dedupe.set(key, entry);

    let status;
    let body;
    if (s.pending && !(r.method === 'POST' && r.path === '/api/devices/activate')) {
      [status, body] = [401, { error: 'finish pairing first', deviceRejected: true, reason: 'not-activated' }];
    } else if (/\/liveview$/.test(r.path.split('?')[0])) {
      [status, body] = [415, { error: 'live view is Wi-Fi only' }];
    } else if (/^\/api\/events\b/.test(r.path)) {
      [status, body] = [400, { error: 'live state comes as STATE messages over Bluetooth' }];
    } else if (!r.path.startsWith('/api/')) {
      [status, body] = [404, { error: 'only /api/ paths' }];
    } else if (r.body !== undefined && Buffer.byteLength(JSON.stringify(r.body)) > MAX_REQUEST_BODY) {
      [status, body] = [413, { error: 'request body too large for Bluetooth' }];
    } else {
      try {
        const res = await this.dispatch({ method: r.method, target: r.path, body: r.body, device: this.devices.get(s.device.id) ?? s.device });
        if (!/json/.test(res.contentType ?? '')) {
          [status, body] = [415, { error: 'not available over Bluetooth (not JSON)' }];
        } else {
          status = res.status;
          body = res.body.length ? JSON.parse(res.body.toString('utf8')) : undefined;
        }
      } catch (err) {
        [status, body] = [502, { error: err.message }];
      }
      if (s.pending && status === 200 && r.path === '/api/devices/activate') {
        for (const x of this.sessions.values()) if (x.device?.id === s.device.id) x.pending = false;
      }
    }
    entry.inner = reply(status, body);
    for (const w of entry.waiters) if (this.sessions.get(w.central) === w && w.ch) this.#sendSealed(w, entry.inner);
    entry.waiters = [];
    if (r.path === '/api/devices/activate' && status === 200) this.#sendFull(s);
  }

  #sweepDedupe() {
    const cutoff = this.now() - DEDUPE_MS;
    for (const [k, v] of this.dedupe) if (v.at < cutoff && v.inner) this.dedupe.delete(k);
    while (this.dedupe.size > DEDUPE_MAX) this.dedupe.delete(this.dedupe.keys().next().value);
  }

  #take(deviceId) {
    const now = this.now();
    const b = this.buckets.get(deviceId) ?? { tokens: BUCKET.capacity, at: now };
    b.tokens = Math.min(BUCKET.capacity, b.tokens + ((now - b.at) / 1000) * BUCKET.perSecond);
    b.at = now;
    this.buckets.set(deviceId, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  #deviceFailed(id) {
    const now = this.now();
    const list = (this.deviceFails.get(id) ?? []).filter((t) => t > now - DEVICE_COOLDOWN_MS);
    list.push(now);
    this.deviceFails.set(id, list);
  }

  #deviceCoolingDown(id) {
    const now = this.now();
    const list = (this.deviceFails.get(id) ?? []).filter((t) => t > now - DEVICE_COOLDOWN_MS);
    this.deviceFails.set(id, list);
    return list.length >= DEVICE_FAILS;
  }

  #revoked(id) {
    for (const s of [...this.sessions.values()]) {
      if (s.device?.id !== id) continue;
      if (s.ch) this.#sendSealed(s, P.encodeNotice({ code: 'revoked', message: 'This phone was revoked in CamBridge Setup.' }));
      this.log('info', `ble: ${label(s)} revoked; session closed`);
      this.#close(s);
    }
    this.emit('status');
  }

  // --- state -------------------------------------------------------------------------------

  #onFrame({ full, patch }) {
    this.latest = full;
    // Packed once, sealed per phone.
    let packed = null;
    for (const s of this.sessions.values()) {
      if (s.state !== 'open' || s.pending || !s.fullSent) continue;
      packed ??= compactFrame(patch ?? full);
      this.#sendSealed(s, P.encodeState(++s.seq, packed));
    }
  }

  #sendFull(s) {
    if (!this.latest) return;
    s.fullSent = true;
    this.#sendSealed(s, P.encodeState(++s.seq, compactFrame(this.latest)));
  }
}

function clampMtu(mtu) {
  const n = Number(mtu);
  return Number.isFinite(n) && n >= 20 ? Math.min(n, 512) : 20;
}

function label(s) {
  return s.device ? `${s.device.name ?? s.device.id}` : s.central.slice(0, 8);
}
