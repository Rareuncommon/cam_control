// VISCA-over-IP server.
//
// Makes CamBridge answer to VISCA, so the hardware that already exists in a
// booth — a PTZ joystick, a controller panel, Companion's VISCA module — can
// drive the Sony bodies. Nothing here talks to a camera directly; every command
// turns into the same property write the web panel would make.
//
// These are cinema bodies, not PTZ heads: there is no pan, tilt or zoom motor to
// drive. Commands that would move a head are answered with a VISCA error rather
// than silently ignored, so a controller shows the operator that the axis does
// nothing instead of leaving them wondering why the shot will not move.
//
// Framing. VISCA over IP (Sony's own scheme, also used by most PTZ vendors)
// wraps each message in an 8-byte header:
//
//   [0..1] payload type   0x0100 = VISCA command, 0x0111 = VISCA reply
//   [2..3] payload length
//   [4..7] sequence number
//   [8..]  the VISCA message itself, 0x8x .. 0xFF
//
// Some controllers speak raw VISCA over TCP with no header at all, so both are
// accepted: if the first byte looks like a VISCA address byte rather than a
// header, it is parsed as raw.

import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';

const PAYLOAD_COMMAND = 0x0100;
const PAYLOAD_REPLY = 0x0111;

// VISCA replies. The socket number in the low nibble is echoed as 1; nothing
// here queues commands deeply enough for it to mean anything more.
const ACK = [0x41];
const COMPLETION = [0x51];
const ERR_SYNTAX = [0x60, 0x02];
const ERR_NOT_EXECUTABLE = [0x61, 0x41];

/** f-number is transported ×100 by camd; VISCA iris positions are a table index. */
const IRIS_STEP = 1;

// A VISCA message is at most 16 bytes including its address byte and 0xFF
// terminator. Anything claiming more is not VISCA.
const MAX_MESSAGE = 16;
// Per-connection bounds (audit CS5): bytes waiting for a terminator/header,
// and complete messages waiting for the camera. A peer beyond either is not a
// controller and is disconnected.
const MAX_BUFFERED = 1024;
const MAX_QUEUED = 32;

/**
 * Splits a byte stream into complete VISCA messages.
 *
 * TCP delivers bytes, not packets: one read may hold half a command or three.
 * Each connection gets its own decoder; UDP datagrams go through
 * parseDatagram() instead, since a datagram is exactly one message.
 * push() returns complete messages, or throws on a stream that cannot be
 * VISCA (the caller drops the connection).
 */
export class ViscaStreamDecoder {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out = [];
    while (this.buf.length) {
      if ((this.buf[0] & 0x80) === 0) {
        // Header-framed.
        if (this.buf.length < 8) break;
        const type = this.buf.readUInt16BE(0);
        const length = this.buf.readUInt16BE(2);
        if ((type !== PAYLOAD_COMMAND && type !== PAYLOAD_REPLY) || length < 3 || length > MAX_MESSAGE) {
          throw new Error('not a VISCA-over-IP header');
        }
        if (this.buf.length < 8 + length) break;
        const message = this.buf.subarray(8, 8 + length);
        const sequence = this.buf.readUInt32BE(4);
        this.buf = this.buf.subarray(8 + length);
        if (message[length - 1] !== 0xff || (message[0] & 0x80) === 0) throw new Error('unterminated VISCA message');
        out.push({ message: Buffer.from(message), sequence, framed: true, type });
      } else {
        // Raw VISCA: runs to the first 0xFF.
        const end = this.buf.indexOf(0xff);
        if (end < 0) {
          if (this.buf.length > MAX_MESSAGE) throw new Error('unterminated VISCA message');
          break;
        }
        if (end + 1 > MAX_MESSAGE) throw new Error('oversized VISCA message');
        out.push({ message: Buffer.from(this.buf.subarray(0, end + 1)), sequence: 0, framed: false });
        this.buf = this.buf.subarray(end + 1);
      }
    }
    if (this.buf.length > MAX_BUFFERED) throw new Error('too much unframed VISCA data');
    return out;
  }
}

/** One complete message from a datagram, or null when it is not exactly one. */
export function parseDatagram(buf) {
  if (!buf || buf.length === 0) return null;
  const decoder = new ViscaStreamDecoder();
  let messages;
  try { messages = decoder.push(buf); } catch { return null; }
  if (messages.length !== 1 || decoder.buf.length !== 0) return null;
  return messages[0];
}

export class ViscaServer {
  /**
   * @param {object} opts
   * @param {object} opts.state                  the StateModel mirror
   * @param {(cameraId: string, prop: string, raw: number) => Promise<any>} opts.applyFn
   * @param {(cameraId: string, action: string, body?: object) => Promise<any>} opts.actionFn
   * @param {(name: string, cameraId: string) => Promise<any>} opts.recallPreset
   * @param {(name: string, cameraId: string) => any} opts.savePreset
   * @param {Record<string, string|number>} opts.mapping   cameraId -> VISCA address
   * @param {(level: string, msg: string) => void} opts.log
   */
  constructor({ state, applyFn, actionFn, recallPreset, savePreset, mapping = {},
    bind = '0.0.0.0', port = 52381, tcp = true, log = () => {} }) {
    this.state = state;
    this.applyFn = applyFn;
    this.actionFn = actionFn;
    this.recallPreset = recallPreset;
    this.savePreset = savePreset;
    this.bind = bind;
    this.port = port;
    this.useTcp = tcp;
    this.log = log;
    this.udp = null;
    this.tcpServer = null;
    this.sockets = new Set();

    // VISCA address 1 is the first camera. Build both directions once.
    this.byAddress = new Map();
    const entries = Object.entries(mapping);
    if (entries.length) {
      for (const [cameraId, address] of entries) this.byAddress.set(Number(address), cameraId);
    }
    this.autoMap = entries.length === 0;
  }

  /**
   * Which camera a VISCA address refers to.
   *
   * With no explicit mapping, addresses follow the camera order CamBridge already
   * uses, so a single-camera booth works with no configuration at all.
   */
  cameraFor(address) {
    if (!this.autoMap) return this.byAddress.get(address) ?? null;
    const list = this.state.list();
    return list[address - 1]?.id ?? null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.udp = createSocket('udp4');
      this.udp.on('error', (err) => {
        this.log('error', `VISCA UDP error: ${err.message}`);
        reject(err);
      });
      this.udp.on('message', async (msg, rinfo) => {
        const reply = await this.handlePacket(msg);
        const udp = this.udp;
        if (!udp) return;
        for (const frame of reply) udp.send(frame, rinfo.port, rinfo.address);
      });
      this.udp.bind(this.port, this.bind, () => {
        if (!this.useTcp) return resolve();
        this.tcpServer = createServer((socket) => this.#serveTcp(socket));
        this.tcpServer.on('error', (err) => {
          this.log('error', `VISCA TCP error: ${err.message}`);
          reject(err);
        });
        this.tcpServer.listen(this.port, this.bind, () => resolve());
      });
    });
  }

  /**
   * One TCP controller. Bytes are decoded incrementally (audit CS5) and each
   * complete message is executed in arrival order, one at a time, so replies
   * cannot interleave and a slow camera cannot pile up unbounded work.
   */
  #serveTcp(socket) {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    // A controller that goes away mid-command must not take the server
    // with it; a booth joystick unplugged during a shoot is routine.
    socket.on('error', (err) => this.log('debug', `VISCA TCP client: ${err.message}`));
    const decoder = new ViscaStreamDecoder();
    const queue = [];
    let running = false;
    const drain = async () => {
      if (running) return;
      running = true;
      try {
        while (queue.length && !socket.destroyed) {
          const m = queue.shift();
          const frames = await this.#executeMessage(m);
          for (const frame of frames) if (!socket.destroyed) socket.write(frame);
        }
      } finally { running = false; }
    };
    socket.on('data', (data) => {
      let messages;
      try { messages = decoder.push(data); }
      catch (err) {
        this.log('warn', `VISCA TCP client dropped: ${err.message}`);
        socket.destroy();
        return;
      }
      if (queue.length + messages.length > MAX_QUEUED) {
        this.log('warn', 'VISCA TCP client dropped: too many commands waiting');
        socket.destroy();
        return;
      }
      queue.push(...messages);
      drain();
    });
  }

  async stop() {
    try { this.udp?.close(); } catch { /* already closed */ }
    for (const s of this.sockets) { try { s.destroy(); } catch { /* gone */ } }
    this.sockets.clear();
    this.udp = null;
    if (this.tcpServer) {
      await new Promise((r) => this.tcpServer.close(r));
      this.tcpServer = null;
    }
  }

  /**
   * Parses a packet and returns the frames to send back.
   * Pure enough to test without a socket.
   */
  async handlePacket(buf) {
    // Exactly one complete, terminated message, or nothing (audit CS5: the
    // advertised length and the 0xFF terminator used to go unchecked).
    const m = parseDatagram(buf);
    return m ? this.#executeMessage(m) : [];
  }

  async #executeMessage({ message, sequence, framed }) {
    // The address byte is 0x80 | address, so 0x81 is camera 1 and 0x83 camera 3.
    // Address 0 is not a real target; treat it as camera 1 so a controller that
    // sends 0x80 still reaches something rather than silently doing nothing.
    const address = (message[0] & 0x0f) || 1;
    let replies;
    try {
      replies = await this.execute(address, message);
    } catch (err) {
      // A camera write that throws is a failure the controller must see, not an
      // unhandled rejection with no reply (audit CS6).
      this.log('warn', `VISCA command failed: ${err.message}`);
      replies = [[0x90, ...ERR_NOT_EXECUTABLE, 0xff]];
    }
    return replies.map((payload) => this.#frame(payload, sequence, framed));
  }

  #frame(payloadBytes, sequence, framed) {
    const body = Buffer.from(payloadBytes);
    if (!framed) return body;
    const head = Buffer.alloc(8);
    head.writeUInt16BE(PAYLOAD_REPLY, 0);
    head.writeUInt16BE(body.length, 2);
    head.writeUInt32BE(sequence, 4);
    return Buffer.concat([head, body]);
  }

  /** @returns {Promise<number[][]>} raw VISCA payloads to return, in order */
  async execute(address, msg) {
    const cameraId = this.cameraFor(address);
    const reply = (bytes) => [0x90, ...bytes, 0xff];
    if (!cameraId) return [reply(ERR_NOT_EXECUTABLE)];

    const cam = this.state.get(cameraId);
    if (!cam || cam.state !== 'connected') return [reply(ERR_NOT_EXECUTABLE)];

    const body = [...msg.subarray(1, msg.length - 1)];   // strip address and 0xFF
    const [category, ...rest] = body;

    // 0x09 = inquiry, 0x01 = command.
    if (category === 0x09) {
      const answer = this.inquire(cam, rest);
      return [answer ? [0x90, 0x50, ...answer, 0xff] : reply(ERR_NOT_EXECUTABLE)];
    }
    if (category !== 0x01) return [reply(ERR_SYNTAX)];

    const handled = await this.command(cam, rest);
    if (handled === 'syntax') return [reply(ERR_SYNTAX)];
    if (handled === 'refused') return [reply(ERR_NOT_EXECUTABLE)];
    // ACK then completion, which is what a controller waits for.
    return [reply(ACK), reply(COMPLETION)];
  }

  /** @returns {Promise<'ok'|'syntax'|'refused'>} */
  async command(cam, bytes) {
    const [group, ...rest] = bytes;

    // 0x04 = camera settings, 0x06 = pan/tilt (which these bodies do not have).
    if (group === 0x06) return 'refused';
    if (group !== 0x04) return 'syntax';

    const [code, ...args] = rest;
    switch (code) {
      case 0x0b: return this.#iris(cam, args);
      case 0x0c: return this.#gain(cam, args);
      case 0x0a: return this.#shutter(cam, args);
      case 0x35: return this.#whiteBalance(cam, args);
      case 0x08: return this.#focus(cam, args);
      case 0x18: return this.#focusMode(cam, args);
      case 0x3f: return this.#memory(cam, args);
      default: return 'syntax';
    }
  }

  /** Steps through a property's own legal list rather than inventing values. */
  async #walk(cam, prop, direction) {
    const p = cam.properties?.[prop];
    if (!p || !p.writable) return 'refused';
    const options = p.allowed ?? null;
    const current = p.value ?? p.raw;
    if (options?.length) {
      const sorted = [...options].sort((a, b) => a - b);
      const idx = sorted.indexOf(current);
      if (idx < 0) return 'refused';
      const next = sorted[idx + direction];
      if (next === undefined) return 'refused';
      return this.#applied(await this.applyFn(cam.id, prop, next));
    }
    if (p.range) {
      const step = (p.range.step || 1) * IRIS_STEP;
      const next = Math.min(Math.max(current + direction * step, p.range.min), p.range.max);
      if (next === current) return 'refused';
      return this.#applied(await this.applyFn(cam.id, prop, next));
    }
    return 'refused';
  }

  async #direct(cam, prop, value) {
    const p = cam.properties?.[prop];
    if (!p || !p.writable) return 'refused';
    return this.#applied(await this.applyFn(cam.id, prop, value));
  }

  /**
   * Completion is only sent for a write the camera accepted (audit CS6). The
   * writable check above is a snapshot; the camera can still refuse (a mode
   * change, a state transition, camd timing out), and that must reach the
   * controller as "not executable" rather than a false completion.
   */
  #applied(result) {
    return result && result.ok === false ? 'refused' : 'ok';
  }

  /**
   * VISCA iris: 0x02 up, 0x03 down, 0x00 reset, 0x4p direct.
   *
   * "Up" in VISCA means a more open iris — more light — so it walks *down* the
   * f-number list, the same inversion the panel and the Stream Deck use.
   */
  #iris(cam, args) {
    const mode = args[0];
    if (mode === 0x02) return this.#walk(cam, 'fNumber', -1);
    if (mode === 0x03) return this.#walk(cam, 'fNumber', 1);
    if (args.length >= 5) {
      // Direct: four nibbles, low to high, forming the raw value.
      const raw = ((args[1] & 0x0f) << 12) | ((args[2] & 0x0f) << 8)
        | ((args[3] & 0x0f) << 4) | (args[4] & 0x0f);
      return this.#direct(cam, 'fNumber', raw);
    }
    return Promise.resolve('syntax');
  }

  #gain(cam, args) {
    const mode = args[0];
    if (mode === 0x02) return this.#walk(cam, 'isoSensitivity', 1);
    if (mode === 0x03) return this.#walk(cam, 'isoSensitivity', -1);
    return Promise.resolve('syntax');
  }

  #shutter(cam, args) {
    const mode = args[0];
    if (mode === 0x02) return this.#walk(cam, 'shutterSpeed', 1);
    if (mode === 0x03) return this.#walk(cam, 'shutterSpeed', -1);
    return Promise.resolve('syntax');
  }

  #whiteBalance(cam, args) {
    // Only the modes that map onto something a Sony body actually has.
    const map = { 0x00: 0, 0x01: 1, 0x02: 2, 0x05: 4 };
    const value = map[args[0]];
    if (value === undefined) return Promise.resolve('syntax');
    return this.#direct(cam, 'whiteBalance', value);
  }

  async #focus(cam, args) {
    const mode = args[0];
    // 0x02 far, 0x03 near, 0x01 stop. Variable-speed forms carry speed in the
    // low nibble (0x2p / 0x3p); the speed is used as the nudge size.
    if (mode === 0x01) return 'ok';
    const highNibble = mode & 0xf0;
    const speed = (mode & 0x0f) || 3;
    if (mode === 0x02 || highNibble === 0x20) {
      return this.#applied(await this.actionFn(cam.id, 'focusNudge', { steps: speed * 3 }));
    }
    if (mode === 0x03 || highNibble === 0x30) {
      return this.#applied(await this.actionFn(cam.id, 'focusNudge', { steps: -speed * 3 }));
    }
    if (args.length >= 5) {
      const raw = ((args[1] & 0x0f) << 12) | ((args[2] & 0x0f) << 8)
        | ((args[3] & 0x0f) << 4) | (args[4] & 0x0f);
      return this.#direct(cam, 'focusPosition', raw);
    }
    return 'syntax';
  }

  async #focusMode(cam, args) {
    // 0x02 auto, 0x03 manual, 0x01 trigger a one-shot AF.
    if (args[0] === 0x01) {
      return this.#applied(await this.actionFn(cam.id, 'autofocus'));
    }
    return 'refused';
  }

  /** CAM_Memory: 0x00 reset, 0x01 set, 0x02 recall — mapped onto CamBridge presets. */
  async #memory(cam, args) {
    const mode = args[0];
    const slot = args[1];
    if (slot === undefined) return 'syntax';
    const name = `visca-${slot}`;
    if (mode === 0x01) {
      const r = this.savePreset(name, cam.id);
      return r?.ok === false ? 'refused' : 'ok';
    }
    if (mode === 0x02) {
      const r = await this.recallPreset(name, cam.id);
      return r?.ok === false ? 'refused' : 'ok';
    }
    return 'syntax';
  }

  /** Inquiries a controller uses to sync its display. @returns {number[]|null} */
  inquire(cam, bytes) {
    const [group, code] = bytes;
    if (group !== 0x04) return null;
    const nibbles = (value) => [
      (value >> 12) & 0x0f, (value >> 8) & 0x0f, (value >> 4) & 0x0f, value & 0x0f,
    ];
    const raw = (prop) => {
      const v = cam.properties?.[prop]?.value ?? cam.properties?.[prop]?.raw;
      return Number.isFinite(v) ? v : null;
    };
    switch (code) {
      case 0x4b: { const v = raw('fNumber'); return v === null ? null : nibbles(v); }
      case 0x4c: { const v = raw('isoSensitivity'); return v === null ? null : nibbles(v); }
      case 0x4a: { const v = raw('shutterSpeed'); return v === null ? null : nibbles(v); }
      case 0x48: { const v = raw('focusPosition'); return v === null ? null : nibbles(v); }
      case 0x35: { const v = raw('whiteBalance'); return v === null ? null : [v & 0x0f]; }
      default: return null;
    }
  }
}
