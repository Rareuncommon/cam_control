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
        for (const frame of reply) this.udp.send(frame, rinfo.port, rinfo.address);
      });
      this.udp.bind(this.port, this.bind, () => {
        if (!this.useTcp) return resolve();
        this.tcpServer = createServer((socket) => {
          this.sockets.add(socket);
          socket.on('close', () => this.sockets.delete(socket));
          // A controller that goes away mid-command must not take the server
          // with it; a booth joystick unplugged during a service is routine.
          socket.on('error', (err) => this.log('debug', `VISCA TCP client: ${err.message}`));
          socket.on('data', async (data) => {
            const reply = await this.handlePacket(data);
            for (const frame of reply) socket.write(frame);
          });
        });
        this.tcpServer.on('error', (err) => {
          this.log('error', `VISCA TCP error: ${err.message}`);
          reject(err);
        });
        this.tcpServer.listen(this.port, this.bind, () => resolve());
      });
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
    if (!buf || buf.length === 0) return [];

    // Header-framed, or raw VISCA? A VISCA message always begins 0x8n.
    let sequence = 0;
    let message = buf;
    let framed = false;
    if (buf.length >= 8 && (buf[0] & 0x80) === 0) {
      const type = buf.readUInt16BE(0);
      const length = buf.readUInt16BE(2);
      sequence = buf.readUInt32BE(4);
      if (type !== PAYLOAD_COMMAND && type !== PAYLOAD_REPLY) return [];
      message = buf.subarray(8, 8 + length);
      framed = true;
    }
    if (message.length < 3) return [];

    // The address byte is 0x80 | address, so 0x81 is camera 1 and 0x83 camera 3.
    // Address 0 is not a real target; treat it as camera 1 so a controller that
    // sends 0x80 still reaches something rather than silently doing nothing.
    const address = (message[0] & 0x0f) || 1;
    const replies = await this.execute(address, message);
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
      await this.applyFn(cam.id, prop, next);
      return 'ok';
    }
    if (p.range) {
      const step = (p.range.step || 1) * IRIS_STEP;
      const next = Math.min(Math.max(current + direction * step, p.range.min), p.range.max);
      if (next === current) return 'refused';
      await this.applyFn(cam.id, prop, next);
      return 'ok';
    }
    return 'refused';
  }

  async #direct(cam, prop, value) {
    const p = cam.properties?.[prop];
    if (!p || !p.writable) return 'refused';
    await this.applyFn(cam.id, prop, value);
    return 'ok';
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
      await this.actionFn(cam.id, 'focusNudge', { steps: speed * 3 });
      return 'ok';
    }
    if (mode === 0x03 || highNibble === 0x30) {
      await this.actionFn(cam.id, 'focusNudge', { steps: -speed * 3 });
      return 'ok';
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
      await this.actionFn(cam.id, 'autofocus');
      return 'ok';
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
