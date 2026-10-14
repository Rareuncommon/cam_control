// VISCA-over-IP server.
//
// Makes CamBridge answer to VISCA, so the hardware that already exists in a
// booth — a PTZ joystick, a controller panel, Companion's VISCA module — can
// drive the Sony bodies. Nothing here talks to a camera directly; every command
// turns into the same property write the web panel would make.
//
// For the cinema bodies there is no pan, tilt or zoom motor to drive. Commands
// that would move a head are answered with a VISCA error rather than silently
// ignored, so a controller shows the operator that the axis does nothing
// instead of leaving them wondering why the shot will not move.
//
// For PTZ heads the same commands are forwarded to the head's own driver. Most
// of those heads speak VISCA themselves; forwarding still earns its place
// because the Canon does not, and because one controller then drives every
// head through the same deadman and logging as the panel.
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
import { createServer, isIPv4 } from 'node:net';

/** A partial message held for the next chunk is never allowed to grow past this. */
const MAX_CARRY = 1024;

/**
 * Splits bytes into whole VISCA messages.
 *
 * TCP is a stream, not a sequence of packets: a drive and its stop written
 * back to back can arrive as one chunk, and one stop can arrive as two. An
 * earlier version treated each chunk as one message, so the first case ran
 * the drive and dropped the stop — a latched head panning until the
 * controller hung up. So every chunk is split into complete messages, in
 * order, and an incomplete tail waits for the bytes that finish it.
 *
 * Both framings: the 8-byte VISCA-over-IP header (first byte 0x01/0x02) and
 * raw VISCA (first byte 0x8n, ending 0xFF).
 *
 * Nothing malformed is ever run (audit CS5). A message must be 3–16 bytes,
 * start 0x8n and end 0xFF; a header must announce such a length. A malformed
 * message is skipped whole. Bytes that can never become a message — a raw run
 * with no terminator inside sixteen bytes, or a carry past its limit — set
 * `bad`, and a TCP peer that sends them is not a controller.
 *
 * @param {Buffer} data
 * @returns {{messages: Array<{message: Buffer, sequence: number, framed: boolean}>, rest: Buffer, bad: boolean}}
 */
export function splitMessages(data) {
  const messages = [];
  let bad = false;
  let at = 0;
  const wellFormed = (m) => m.length >= 3 && m.length <= MAX_MESSAGE
    && (m[0] & 0x80) !== 0 && m[m.length - 1] === 0xff;
  while (at < data.length) {
    const first = data[at];
    if ((first & 0x80) !== 0) {
      const end = data.indexOf(0xff, at);
      if (end < 0 || end - at + 1 > MAX_MESSAGE) {
        if (end < 0 && data.length - at <= MAX_MESSAGE) break;   // a raw message still arriving
        // No terminator where one must be: never a VISCA message.
        bad = true;
        at = end < 0 ? data.length : end + 1;
        continue;
      }
      messages.push({ message: data.subarray(at, end + 1), sequence: 0, framed: false });
      at = end + 1;
      continue;
    }
    if (data.length - at < 8) break;            // a header still arriving
    const type = data.readUInt16BE(at);
    const length = data.readUInt16BE(at + 2);
    // Control frames (a controller's sequence-number RESET when it connects)
    // and device-setting commands are VISCA-over-IP, just not camera commands:
    // skipped, never a reason to drop the controller.
    if (PAYLOAD_SKIPPED.has(type) && length <= MAX_MESSAGE) {
      if (data.length - at < 8 + length) break;
      at += 8 + length;
      continue;
    }
    if ((type !== PAYLOAD_COMMAND && type !== PAYLOAD_REPLY && type !== PAYLOAD_INQUIRY)
        || length < 3 || length > MAX_MESSAGE) {
      at += 1;                                  // not a header: skip a byte and resynchronise
      bad = true;
      continue;
    }
    if (data.length - at < 8 + length) break;   // a body still arriving
    const message = data.subarray(at + 8, at + 8 + length);
    if (wellFormed(message)) {
      messages.push({ message, sequence: data.readUInt32BE(at + 4), framed: true });
    } else {
      bad = true;                               // the length was right, the message is not
    }
    at += 8 + length;
  }
  const rest = data.subarray(at);
  if (rest.length > MAX_CARRY) return { messages, rest: Buffer.alloc(0), bad: true };
  return { messages, rest, bad };
}

/** "192.0.2.10" or "192.0.2.0/24"; IPv4 only, which is what VISCA controllers use. */
export function matchesAllow(address, allow) {
  const ip = String(address ?? '').replace(/^::ffff:/, '');
  if (!isIPv4(ip)) return false;
  const n = (a) => a.split('.').reduce((x, o) => x * 256 + Number(o), 0);
  for (const rule of allow) {
    const [base, bits] = String(rule).split('/');
    if (!isIPv4(base)) continue;
    const prefix = bits === undefined ? 32 : Number(bits);
    if (!(prefix >= 0 && prefix <= 32)) continue;
    const size = 2 ** (32 - prefix);
    if (Math.floor(n(ip) / size) === Math.floor(n(base) / size)) return true;
  }
  return false;
}

const PAYLOAD_COMMAND = 0x0100;
const PAYLOAD_INQUIRY = 0x0110;
const PAYLOAD_REPLY = 0x0111;
/** Device setting command, control command, control reply. */
const PAYLOAD_SKIPPED = new Set([0x0120, 0x0200, 0x0201]);

// VISCA replies. The socket number in the low nibble is echoed as 1; nothing
// here queues commands deeply enough for it to mean anything more.
const ACK = [0x41];
const COMPLETION = [0x51];
const ERR_SYNTAX = [0x60, 0x02];
const ERR_NOT_EXECUTABLE = [0x61, 0x41];

/** f-number is transported ×100 by camd; VISCA iris positions are a table index. */
const IRIS_STEP = 1;

// A VISCA message is at most 16 bytes including its address byte and 0xFF
// terminator. Anything claiming more is not VISCA (audit CS5).
const MAX_MESSAGE = 16;
// Complete messages one TCP controller may have waiting for the camera. A
// peer beyond this is not a controller, and is disconnected (audit CS5).
const MAX_QUEUED = 32;

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
    bind = '0.0.0.0', port = 52381, tcp = true, log = () => {}, ptz = null, udpHoldMs = 10_000,
    cameraPorts = {}, allow = [], allowPresetStore = false }) {
    /**
     * Controller addresses allowed to send commands. Empty means any host —
     * the old behaviour, logged as a warning at start, because VISCA carries
     * no credentials and the PIN does not apply to it.
     */
    this.allow = Array.isArray(allow) ? allow : [];
    /**
     * Storing over or deleting a PTZ head's own presets from VISCA. Off by
     * default: a controller with no PIN should not be able to wipe the
     * presets an operator built, and recalling is what a joystick is for.
     */
    this.allowPresetStore = !!allowPresetStore;
    /**
     * `peer|address` -> camera a move went to. A stop is sent to that camera
     * whatever the camera order is by the time it arrives — reordering
     * mid-move used to send the stop to whichever camera now had the address.
     */
    this.routes = new Map();
    /**
     * cameraId -> port. A VISCA address is three bits, so the shared port can
     * tell at most seven cameras apart — and VISCA-over-IP controllers do not
     * use the address anyway; they pick a camera by IP and port. So each
     * camera may have a port of its own, where every packet means that camera
     * whatever address it carries. A controller then adds CamBridge once per
     * camera, at this machine's address and that camera's port.
     */
    this.cameraPorts = Object.entries(cameraPorts ?? {})
      .map(([cameraId, p]) => [cameraId, Number(p)])
      .filter(([, p]) => Number.isInteger(p) && p > 0 && p < 65536);
    /** Listeners beyond the shared one: { udp, tcp } per dedicated port. */
    this.dedicated = [];
    this.state = state;
    /**
     * PTZ forwarding: { move(id, v, o), preset(id, op, n), action(id, entryId),
     * write(id, entryId, value), entryByRole(id, role), presetBase(id), releaseSource(source) }.
     */
    this.ptz = ptz;
    /**
     * How long a move from a UDP controller is held without a repeat. UDP has
     * no connection to watch, so a controller that crashes mid-move would
     * otherwise leave the head moving for ever; TCP controllers latch instead
     * and are released when their socket closes.
     */
    this.udpHoldMs = udpHoldMs;
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
    // The operator's order, so address 1 is the first camera on the panel.
    const list = this.state.ordered?.() ?? this.state.list();
    return list[address - 1]?.id ?? null;
  }

  /**
   * One UDP socket and (optionally) one TCP server on a port. `cameraId`
   * fixes which camera every packet on it means; null is the shared port,
   * where the VISCA address decides.
   */
  #listen(port, cameraId) {
    const where = cameraId ? `port ${port} (${cameraId})` : `port ${port}`;
    return new Promise((resolve, reject) => {
      const l = { udp: createSocket('udp4'), tcp: null, sockets: new Set() };
      l.udp.on('error', (err) => {
        this.log('error', `VISCA UDP error on ${where}: ${err.message}`);
        reject(err);
      });
      // One chain per sender, so its commands run in the order sent even when
      // one of them (a preset recall) takes a while.
      const udpChains = new Map();
      l.udp.on('message', (msg, rinfo) => {
        if (!this.#allowed(rinfo.address)) return;
        const id = `visca-udp:${rinfo.address}:${rinfo.port}`;
        const prev = udpChains.get(id) ?? Promise.resolve();
        const next = prev.then(async () => {
          const reply = await this.handlePacket(msg, { id, tcp: false, cameraId });
          for (const frame of reply) l.udp.send(frame, rinfo.port, rinfo.address);
        }).catch((err) => this.log('debug', `VISCA UDP: ${err.message}`));
        udpChains.set(id, next);
        next.finally(() => { if (udpChains.get(id) === next) udpChains.delete(id); });
      });
      l.udp.bind(port, this.bind, () => {
        if (!this.useTcp) return resolve(l);
        l.tcp = createServer((socket) => {
          if (!this.#allowed(socket.remoteAddress)) {
            this.log('warn', `VISCA: refused a controller at ${socket.remoteAddress} (not in visca.allow)`);
            socket.destroy();
            return;
          }
          l.sockets.add(socket);
          const peer = { id: `visca-tcp:${socket.remoteAddress}:${socket.remotePort}`, tcp: true, cameraId };
          let carry = Buffer.alloc(0);
          let chain = Promise.resolve();
          let waiting = 0;
          socket.on('close', () => {
            peer.closed = true;
            l.sockets.delete(socket);
            // Whatever this controller was holding stops with it.
            this.ptz?.releaseSource(peer.id);
          });
          // A controller that goes away mid-command must not take the server
          // with it; a booth joystick unplugged during a shoot is routine.
          socket.on('error', (err) => this.log('debug', `VISCA TCP client: ${err.message}`));
          socket.on('data', (data) => {
            if (peer.closed) return;
            const { messages, rest, bad } = splitMessages(Buffer.concat([carry, data]));
            carry = rest;
            // Bytes that can never be VISCA, or more commands waiting than any
            // controller sends, are not a controller (audit CS5). It is cut
            // off, and nothing it sent runs after that.
            if (bad || waiting + messages.length > MAX_QUEUED) {
              this.log('warn', `VISCA: dropped ${socket.remoteAddress} — ${bad ? 'not VISCA' : 'too many commands waiting'}`);
              socket.destroy();
              return;
            }
            waiting += messages.length;
            // In order, one at a time: a drive and its stop in one chunk must
            // reach the camera as a drive and then a stop.
            chain = chain.then(async () => {
              for (const m of messages) {
                waiting -= 1;
                // A controller already gone must not start a move: its moves
                // latch, and the release for it has already been sent.
                if (peer.closed) continue;
                const reply = await this.#handleMessage(m, peer);
                if (peer.closed) this.ptz?.releaseSource(peer.id);
                else for (const frame of reply) socket.write(frame);
              }
            }).catch((err) => this.log('debug', `VISCA TCP: ${err.message}`));
          });
        });
        l.tcp.on('error', (err) => {
          this.log('error', `VISCA TCP error on ${where}: ${err.message}`);
          reject(err);
        });
        l.tcp.listen(port, this.bind, () => resolve(l));
      });
    });
  }

  #allowed(address) {
    return this.allow.length === 0 || matchesAllow(address, this.allow);
  }

  /**
   * The camera order changed. Address-based routing now points elsewhere, so
   * every move a controller holds is released (stopped) rather than left
   * latched on a camera the controller can no longer address.
   */
  onCameraOrderChanged() {
    const peers = new Set([...this.routes.keys()].map((k) => k.split('|')[0]));
    this.routes.clear();
    for (const id of peers) this.ptz?.releaseSource(id);
  }

  async start() {
    if (this.allow.length === 0) {
      this.log('warn', 'VISCA accepts commands from any host on the network; set visca.allow to limit it to your controllers');
    }
    const shared = await this.#listen(this.port, null);
    this.udp = shared.udp;
    this.tcpServer = shared.tcp;
    this.sockets = shared.sockets;
    // A dedicated port that cannot open is logged and skipped: one camera's
    // joystick missing is better than none of them working.
    for (const [cameraId, port] of this.cameraPorts) {
      try {
        this.dedicated.push(await this.#listen(port, cameraId));
      } catch (err) {
        this.log('error', `VISCA port ${port} for ${cameraId} could not open (${err.message})`);
      }
    }
  }

  async stop() {
    const all = [{ udp: this.udp, tcp: this.tcpServer, sockets: this.sockets }, ...this.dedicated];
    for (const l of all) {
      try { l.udp?.close(); } catch { /* already closed */ }
      for (const s of l.sockets ?? []) { try { s.destroy(); } catch { /* gone */ } }
      l.sockets?.clear();
      if (l.tcp) await new Promise((r) => l.tcp.close(r));
    }
    this.udp = null;
    this.tcpServer = null;
    this.dedicated = [];
  }

  /**
   * Parses a packet and returns the frames to send back.
   * Pure enough to test without a socket.
   */
  async handlePacket(buf, peer = { id: 'visca', tcp: false }) {
    if (!buf || buf.length === 0) return [];
    // A datagram can carry more than one message too; every one is run, in order.
    const { messages } = splitMessages(buf);
    const out = [];
    for (const m of messages) out.push(...await this.#handleMessage(m, peer));
    return out;
  }

  async #handleMessage({ message, sequence, framed }, peer) {
    if (message.length < 3) return [];
    // The address byte is 0x80 | address, so 0x81 is camera 1 and 0x83 camera 3.
    // Address 0 is not a real target; treat it as camera 1 so a controller that
    // sends 0x80 still reaches something rather than silently doing nothing.
    const address = (message[0] & 0x0f) || 1;
    let replies;
    try {
      replies = await this.execute(address, message, peer);
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
  async execute(address, msg, peer = { id: 'visca', tcp: false }) {
    const routeKey = `${peer.id}|${address}`;
    const cameraId = peer.cameraId ?? this.routes.get(routeKey) ?? this.cameraFor(address);
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

    const handled = cam.kind === 'ptz' && this.ptz
      ? await this.#ptzCommand(cam, rest, peer, routeKey)
      : await this.command(cam, rest);
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

  /**
   * Motion, presets and focus for a PTZ head.
   *
   * Byte layouts are Sony's VISCA command list (BRC-AM7, 5-066-065-12): Pan-
   * tiltDrive p.17, Home p.18, Zoom/Focus p.16, Focus mode p.16, Memory p.18.
   * Controllers send this common subset whichever head they were made for.
   *
   * @returns {Promise<'ok'|'syntax'|'refused'>}
   */
  async #ptzCommand(cam, bytes, peer, routeKey) {
    const [group, code, ...args] = bytes;
    const hold = peer.tcp ? { source: peer.id, latch: true } : { source: peer.id, holdMs: this.udpHoldMs };
    const moving = this.motionByRoute ??= new Map();
    const move = (v) => {
      // Remember where this controller's motion went while any axis moves,
      // so its stop goes to the same camera.
      const axes = { ...(moving.get(routeKey) ?? {}), ...v };
      if (Object.values(axes).some((x) => x !== 0)) {
        moving.set(routeKey, axes);
        if (!peer.cameraId) this.routes.set(routeKey, cam.id);
      } else {
        moving.delete(routeKey);
        this.routes.delete(routeKey);
      }
      return this.ptz.move(cam.id, v, hold)?.ok === false ? 'refused' : 'ok';
    };
    const byRole = async (role, fn) => {
      const entry = this.ptz.entryByRole(cam.id, role);
      if (!entry) return 'refused';
      const r = await fn(entry);
      return r?.ok === false ? 'refused' : 'ok';
    };
    // Variable speed in the low nibble, 0 (slow) to 7 (fast); the fixed-speed
    // forms take the middle.
    const variable = (a, up, down) => {
      if (a === 0x00) return 0;
      if (a === up) return 0.5;
      if (a === down) return -0.5;
      if ((a & 0xf0) === (up << 4)) return ((a & 0x0f) + 1) / 8;
      if ((a & 0xf0) === (down << 4)) return -((a & 0x0f) + 1) / 8;
      return null;
    };

    if (group === 0x06 && code === 0x01) {
      // Pan-tiltDrive: VV WW DD EE. Speeds 01–18 in the normal step range;
      // anything above (the extended range) is full speed.
      if (args.length < 4) return 'syntax';
      const [vv, ww, dd, ee] = args;
      const sp = (x) => Math.min(1, Math.max(1, x) / 0x18);
      const pan = { 0x01: -sp(vv), 0x02: sp(vv), 0x03: 0 }[dd];
      const tilt = { 0x01: sp(ww), 0x02: -sp(ww), 0x03: 0 }[ee];
      if (pan === undefined || tilt === undefined) return 'syntax';
      return move({ pan, tilt });
    }
    if (group === 0x06 && code === 0x04) {
      return byRole('home', (e) => this.ptz.action(cam.id, e.id));
    }
    if (group === 0x04 && code === 0x07) {
      const v = variable(args[0], 0x02, 0x03);
      return v === null ? 'syntax' : move({ zoom: v });
    }
    if (group === 0x04 && code === 0x08) {
      const v = variable(args[0], 0x02, 0x03);
      return v === null ? 'syntax' : move({ focus: v });
    }
    if (group === 0x04 && code === 0x38) {
      return byRole('focusMode', (e) => {
        const value = args[0] === 0x02 ? e.autoValue : args[0] === 0x03 ? e.manualValue : undefined;
        return value === undefined ? { ok: false } : this.ptz.write(cam.id, e.id, value);
      });
    }
    if (group === 0x04 && code === 0x18 && args[0] === 0x01) {
      return byRole('onePushAf', (e) => this.ptz.action(cam.id, e.id));
    }
    if (group === 0x04 && code === 0x3f) {
      // Memory: 00 reset, 01 set, 02 recall; the slot is zero-based on the
      // wire and the camera's own numbering starts wherever it starts.
      const [mode, slot] = args;
      if (slot === undefined) return 'syntax';
      const op = { 0x00: 'delete', 0x01: 'store', 0x02: 'recall' }[mode];
      if (!op) return 'syntax';
      if (op !== 'recall' && !this.allowPresetStore) {
        this.log('info', `VISCA: refused preset ${op} on ${cam.id} (visca.allowPresetStore is off)`);
        return 'refused';
      }
      const r = await this.ptz.preset(cam.id, op, this.ptz.presetBase(cam.id) + slot);
      return r?.ok === false ? 'refused' : 'ok';
    }
    return 'refused';
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
