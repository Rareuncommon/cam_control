// A stand-in for the Swift bridge and the phone, for testing the Bluetooth
// gateway without a radio: it connects to the gateway's Unix socket as the
// bridge would, and speaks the phone's side of the protocol for one or more
// simulated phones ("centrals").
//
// Used by test/ble-gateway.test.js, and by scripts/ble-test-client.mjs to
// check a running CamBridge on the Mac (stop the real bridge first: the
// gateway takes one bridge at a time).

import { connect } from 'node:net';
import { EventEmitter, once } from 'node:events';
import { randomBytes } from 'node:crypto';

import * as P from './protocol.js';

/** The bridge end of the Unix socket. Phones attach to it. */
export class FakeBridge extends EventEmitter {
  constructor(socketPath) {
    super();
    this.socketPath = socketPath;
    this.phones = new Map();
    this.blocks = [];
    this.info = null;
  }

  async open() {
    this.sock = connect(this.socketPath);
    await once(this.sock, 'connect');
    this.sock.setEncoding('utf8');
    let buf = '';
    this.sock.on('data', (d) => {
      buf += d;
      let at;
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 1);
        if (line) this.#in(JSON.parse(line));
      }
    });
    this.send({ t: 'hello', v: 1, bridge: 'test-client', bt: 'poweredOn' });
    const [info] = await once(this, 'info');
    return info;
  }

  #in(m) {
    if (m.t === 'info') { this.info = JSON.parse(Buffer.from(m.d, 'base64').toString('utf8')); this.emit('info', this.info); return; }
    if (m.t === 'block') { this.blocks.push(m); this.emit('block', m); return; }
    if (m.t === 'notify') this.phones.get(m.c)?.receiveChunk(Buffer.from(m.d, 'base64'));
  }

  send(m) { this.sock.write(`${JSON.stringify(m)}\n`); }

  close() { this.sock?.destroy(); }
}

/** One phone, as the app behaves. */
export class TestPhone extends EventEmitter {
  constructor(bridge, { central = `central-${randomBytes(4).toString('hex')}`, mtu = 185 } = {}) {
    super();
    Object.assign(this, { bridge, central, mtu });
    this.reasm = new P.Reassembler();
    this.out = 0;
    this.ch = null;
    this.pending = new Map();
    this.states = [];
    this.notices = [];
    this.fails = [];
    this.reqId = randomBytes(4).readUInt32BE(0) & 0x7fffffff;
    bridge.phones.set(central, this);
  }

  receiveChunk(c) {
    const m = this.reasm.push(c);
    if (!m) return;
    if (!this.ch) { this.emit('plain', m); return; }
    let inner;
    try { inner = this.ch.receive.open(m); } catch (err) { this.emit('error-message', err); return; }
    switch (inner[0]) {
      case P.T.RESPONSE: {
        const r = P.decodeResponse(inner);
        this.pending.get(r.reqId)?.(r);
        this.pending.delete(r.reqId);
        this.emit('response', r);
        return;
      }
      case P.T.STATE: { const s = P.decodeState(inner); this.states.push(s); this.emit('state', s); return; }
      case P.T.PONG: this.emit('pong', inner.readBigUInt64BE(1)); return;
      case P.T.NOTICE: { const n = JSON.parse(inner.subarray(1).toString('utf8')); this.notices.push(n); this.emit('notice', n); return; }
      default:
    }
  }

  /** Sends one message, chunked to this phone's MTU. */
  writeMessage(m) {
    this.out = (this.out + 1) & 0x3f;
    for (const c of P.chunk(m, this.mtu - 3, this.out)) this.bridge.send({ t: 'write', c: this.central, d: c.toString('base64') });
  }

  /** Subscribes (the bridge's "connect"), waits for HELLO, authenticates. */
  async connect({ deviceId, key }) {
    const hello = once(this, 'plain');
    this.bridge.send({ t: 'connect', c: this.central, mtu: this.mtu - 3 });
    const h = P.decodeHello((await hello)[0]);
    return this.authenticate({ deviceId, key, hello: h });
  }

  async authenticate({ deviceId, key, hello }) {
    const clientNonce = randomBytes(P.NONCE_BYTES);
    const parts = { serverNonce: hello.serverNonce, clientNonce, deviceId, serverId: hello.serverId };
    const answer = once(this, 'plain');
    this.writeMessage(P.encodeAuth({ deviceId, clientNonce, proof: P.clientProof(key, parts) }));
    const [m] = await answer;
    if (m[0] === P.T.AUTH_FAIL) {
      const fail = { code: m[1], message: m.subarray(2).toString('utf8') };
      this.fails.push(fail);
      return { ok: false, ...fail };
    }
    if (m[0] !== P.T.AUTH_OK || !P.proofsEqual(m.subarray(1), P.serverProof(key, parts))) {
      throw new Error('the server could not prove it holds the key');
    }
    this.ch = P.channels(P.sessionKeys(key, parts), 'phone');
    return { ok: true, serverId: hello.serverId };
  }

  /** A REST call over Bluetooth. `reqId` repeats a request (as a retry would). */
  request(method, path, body, { reqId } = {}) {
    const id = reqId ?? (this.reqId = (this.reqId + 1) >>> 0);
    const done = new Promise((resolve) => this.pending.set(id, resolve));
    this.writeMessage(this.ch.send.seal(P.encodeRequest(id, { method, path, body })));
    return Object.assign(done, { reqId: id });
  }

  resync() { this.writeMessage(this.ch.send.seal(Buffer.from([P.T.RESYNC]))); }

  ping() {
    const pong = once(this, 'pong');
    this.writeMessage(this.ch.send.seal(P.encodePing(P.T.PING, Date.now())));
    return pong;
  }

  /** Waits for a STATE message that satisfies `pred`. */
  async waitState(pred = () => true, ms = 3000) {
    const hit = this.states.find((s) => pred(s));
    if (hit) return hit;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.off('state', on); reject(new Error('no matching state in time')); }, ms);
      const on = (s) => { if (pred(s)) { clearTimeout(t); this.off('state', on); resolve(s); } };
      this.on('state', on);
    });
  }

  disconnect() { this.bridge.send({ t: 'disconnect', c: this.central }); }
}

/** A pairing URI's device id and key. */
export function fromPairingUri(uri) {
  const u = new URL(uri);
  return { deviceId: u.searchParams.get('id'), key: Buffer.from(u.searchParams.get('k'), 'base64url') };
}
