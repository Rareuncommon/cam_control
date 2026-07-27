// ATEM tally listener.
//
// Talks just enough of Blackmagic's switcher protocol to learn which input is on
// program and which is on preview. It never sends a command — this is read-only
// by design. A bug here should be incapable of cutting a source mid-take.
//
// The protocol, as much of it as we need:
//
//   Every packet starts with a 12-byte header:
//     [0]  top 3 bits are flags, bottom 5 bits are the high byte of the length
//     [1]  low byte of the length
//     [2..3]   session id
//     [4..5]   acked packet id
//     [6..9]   (retransmit / reserved)
//     [10..11] packet id
//
//   Flags: 0x08 = HELLO, 0x10 = ACK, 0x01 = ACK-REQUEST, 0x02 = RETRANSMIT.
//
//   After a HELLO exchange the switcher dumps its whole state as a run of
//   command blocks, then sends deltas. Each block is:
//     [0..1] block length (including these 8 header bytes)
//     [2..3] unused
//     [4..7] four-character command name
//     [8..]  payload
//
//   We care about two names:
//     TlIn — tally by input index: u16 count, then one byte per input,
//            bit 0 = program, bit 1 = preview.
//     TlSr — tally by source id: u16 count, then per source u16 id + 1 byte flags.
//            This is the one that maps cleanly onto ATEM input numbers.

import { createSocket } from 'node:dgram';
import { EventEmitter } from 'node:events';

const ATEM_PORT = 9910;

const FLAG_ACK_REQUEST = 0x01;
const FLAG_HELLO = 0x08;
const FLAG_ACK = 0x10;

export class AtemTally extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.host                 switcher address
   * @param {number} [opts.port]
   * @param {(level: string, msg: string) => void} [opts.log]
   */
  constructor({ host, port = ATEM_PORT, log = () => {} }) {
    super();
    this.host = host;
    this.port = port;
    this.log = log;
    this.socket = null;
    this.sessionId = 0;
    this.connected = false;
    this.stopped = false;
    this.helloTimer = null;
    this.watchdog = null;
    this.lastSeen = 0;
    /** input number -> { program, preview } */
    this.tally = new Map();
  }

  start() {
    this.stopped = false;
    this.#open();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.helloTimer);
    clearInterval(this.watchdog);
    this.helloTimer = null;
    this.watchdog = null;
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = null;
    this.connected = false;
  }

  #open() {
    if (this.stopped) return;
    this.socket = createSocket('udp4');
    this.socket.on('message', (msg) => this.handlePacket(msg));
    this.socket.on('error', (err) => {
      this.log('warn', `ATEM socket error: ${err.message}`);
      this.#reset();
    });
    this.socket.bind(() => {
      this.#sendHello();
      // Re-send HELLO until the switcher answers. A switcher powered on after
      // us must still be picked up without anyone restarting cambridge.
      this.helloTimer = setInterval(() => {
        if (!this.connected) this.#sendHello();
      }, 2000);
      // If a connected switcher goes quiet, tear down and start over. Stale
      // tally is worse than no tally: a red light on a camera that is not live
      // will get someone to walk in front of the shot that is.
      this.watchdog = setInterval(() => {
        if (this.connected && Date.now() - this.lastSeen > 5000) {
          this.log('warn', 'ATEM went quiet, reconnecting');
          this.#reset();
        }
      }, 1000);
    });
  }

  #reset() {
    const wasConnected = this.connected;
    this.connected = false;
    this.sessionId = 0;
    this.tally.clear();
    clearInterval(this.helloTimer);
    clearInterval(this.watchdog);
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = null;
    if (wasConnected) this.emit('disconnected');
    if (!this.stopped) setTimeout(() => this.#open(), 1000);
  }

  #header(flags, length, packetId = 0) {
    const buf = Buffer.alloc(12);
    buf.writeUInt8((flags << 3) | ((length >> 8) & 0x07), 0);
    buf.writeUInt8(length & 0xff, 1);
    buf.writeUInt16BE(this.sessionId, 2);
    buf.writeUInt16BE(packetId, 10);
    return buf;
  }

  #sendHello() {
    // A HELLO is a 20-byte packet: the header plus 8 bytes the switcher ignores
    // apart from one marker byte.
    const buf = Buffer.alloc(20);
    buf.writeUInt8((FLAG_HELLO << 3) | 0, 0);
    buf.writeUInt8(20, 1);
    buf.writeUInt8(0x01, 12);
    this.#send(buf);
  }

  #sendAck(packetId) {
    const buf = this.#header(FLAG_ACK, 12);
    buf.writeUInt16BE(packetId, 4);
    this.#send(buf);
  }

  #send(buf) {
    if (!this.socket) return;
    this.socket.send(buf, this.port, this.host, (err) => {
      if (err) this.log('debug', `ATEM send failed: ${err.message}`);
    });
  }

  /**
   * Parses one packet from the switcher and emits tally if it changed.
   * Public so it can be fed real packet bytes in tests without a socket.
   */
  handlePacket(msg) {
    if (msg.length < 12) return;
    this.lastSeen = Date.now();

    const flags = msg.readUInt8(0) >> 3;
    const length = ((msg.readUInt8(0) & 0x07) << 8) | msg.readUInt8(1);
    this.sessionId = msg.readUInt16BE(2);
    const packetId = msg.readUInt16BE(10);

    if (flags & FLAG_HELLO) {
      // Answering the hello completes the handshake; the state dump follows.
      this.#sendAck(0);
      if (!this.connected) {
        this.connected = true;
        this.log('info', `ATEM connected at ${this.host}`);
        this.emit('connected');
      }
      return;
    }

    if (flags & FLAG_ACK_REQUEST) this.#sendAck(packetId);

    // A packet can be header-only (a pure ack); only parse when there is payload.
    const end = Math.min(length, msg.length);
    if (end > 12) this.#parseCommands(msg.subarray(12, end));
  }

  #parseCommands(payload) {
    let offset = 0;
    let changed = false;
    while (offset + 8 <= payload.length) {
      const blockLength = payload.readUInt16BE(offset);
      // A zero or nonsense length would spin forever; treat it as end of packet.
      if (blockLength < 8 || offset + blockLength > payload.length) break;
      const name = payload.toString('ascii', offset + 4, offset + 8);
      const body = payload.subarray(offset + 8, offset + blockLength);
      if (name === 'TlSr') changed = this.#parseTlSr(body) || changed;
      else if (name === 'TlIn') changed = this.#parseTlIn(body) || changed;
      offset += blockLength;
    }
    if (changed) this.emit('tally', this.snapshot());
  }

  #set(input, program, preview) {
    const prev = this.tally.get(input);
    if (prev && prev.program === program && prev.preview === preview) return false;
    this.tally.set(input, { program, preview });
    return true;
  }

  /** Tally by source id — u16 count, then u16 source + u8 flags per entry. */
  #parseTlSr(body) {
    if (body.length < 2) return false;
    const count = body.readUInt16BE(0);
    let changed = false;
    for (let i = 0; i < count; i++) {
      const at = 2 + i * 3;
      if (at + 3 > body.length) break;
      const source = body.readUInt16BE(at);
      const flags = body.readUInt8(at + 2);
      changed = this.#set(source, (flags & 0x01) !== 0, (flags & 0x02) !== 0) || changed;
    }
    return changed;
  }

  /** Tally by input index — u16 count, then one flags byte per input, 1-based. */
  #parseTlIn(body) {
    if (body.length < 2) return false;
    const count = body.readUInt16BE(0);
    let changed = false;
    for (let i = 0; i < count; i++) {
      const at = 2 + i;
      if (at >= body.length) break;
      const flags = body.readUInt8(at);
      changed = this.#set(i + 1, (flags & 0x01) !== 0, (flags & 0x02) !== 0) || changed;
    }
    return changed;
  }

  /** @returns {Record<number, {program: boolean, preview: boolean}>} */
  snapshot() {
    return Object.fromEntries(this.tally);
  }
}

/**
 * Maps switcher inputs onto camera ids.
 *
 * Kept separate from the protocol so the mapping can be tested, and reasoned
 * about, without a switcher. `mapping` is `{ cameraId: inputNumber }` straight
 * out of the config file.
 */
export function tallyForCameras(mapping, snapshot) {
  const out = {};
  for (const [cameraId, input] of Object.entries(mapping ?? {})) {
    const t = snapshot?.[input];
    out[cameraId] = {
      input: Number(input),
      program: !!t?.program,
      preview: !!t?.preview,
    };
  }
  return out;
}
