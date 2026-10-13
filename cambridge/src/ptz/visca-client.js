// VISCA as a client: the transport two PTZ drivers share.
//
// CamBridge already *serves* VISCA (../visca.js) so booth controllers can drive
// the Sony bodies. This is the other direction — CamBridge driving a PTZ head —
// and it is written from the vendors' notes, not from the server: the server
// is lenient about what it accepts, a client has to be exact about what it
// sends and careful about what it believes.
//
// Two framings, one behaviour:
//
// - **Sony VISCA over IP** (BRC-AM7): UDP, an 8-byte header in front of every
//   message — payload type (2), payload length (2), sequence number (4) — and
//   the camera echoes the sequence number in every reply to that message
//   (Sony VISCA Command List BRC-AM7 v2.0, "V-EN" p.10-11). UDP loses packets,
//   so Sony specifies a retransmit rule (V-EN p.12) which this follows.
// - **Raw VISCA over TCP** (PTZOptics Move SE, port 5678): no header at all,
//   replies are told apart only by order and by the socket nibble
//   (PTZOptics VISCA API p.4-6; vendor example-visca.py).
//
// What both share, and what the drivers get from here:
//
// - **One message awaiting its first reply at a time.** Sony: "send next
//   message after receiving the reply (ACK or error) to the previous one";
//   sending several raises the chance of buffer-overflow errors (V-EN p.5,
//   p.12). PTZOptics documents the same two command buffers (VISCA API p.6).
//   Calls may come from anywhere — the lifecycle queue, a tally refresh timer —
//   and are serialised here.
// - **Two command buffers.** A command that has been ACKed occupies a buffer
//   ("socket") until its Completion. A third command gets "buffer full"
//   (`90 60 03 FF`, V-EN p.8; VISCA API p.6). Occupancy is tracked; a command
//   that would be the third waits briefly for a Completion first.
// - **ACK is enough by default.** Drivers resolve a command when the camera
//   accepts it; `{ completion: true }` waits for the Completion instead.
// - **Errors become DriverError.** Every VISCA error the camera can return is
//   an answer — `refused` — with a code the driver can turn into a sentence
//   ("switch focus to manual"). Only silence is a `timeout`, and only a dead
//   socket is `network`, so a camera saying "no" never counts against health.
// - **Socket events never throw.** A camera rebooting mid-show is ordinary.

import dgram from 'node:dgram';
import net from 'node:net';
import { DriverError } from './driver.js';

export const FRAMING = Object.freeze({ SONY_IP: 'sony-ip', RAW_TCP: 'raw-tcp' });

// Sony VISCA-over-IP payload types (V-EN p.11).
const TYPE = Object.freeze({
  COMMAND: 0x0100,
  INQUIRY: 0x0110,
  REPLY: 0x0111,
  CONTROL: 0x0200,
  CONTROL_REPLY: 0x0201,
});

/**
 * VISCA error codes (third byte of `90 6z ee FF`).
 *
 * Sources: V-EN p.5, p.7-8 (Sony); PTZOptics VISCA API p.4-6. Identical in both.
 * Every one is a refusal: the camera heard the message and said no.
 */
export const VISCA_ERRORS = Object.freeze({
  0x01: { code: 'length', message: 'the camera rejected the message length' },
  0x02: { code: 'syntax', message: 'the camera does not accept that command or value' },
  0x03: { code: 'bufferFull', message: 'the camera is busy (both command buffers are full)' },
  0x04: { code: 'canceled', message: 'the command was cancelled' },
  0x05: { code: 'noSocket', message: 'no command was running in that buffer' },
  0x41: { code: 'notExecutable', message: 'the camera cannot do that in its current mode' },
});

/** The DriverError for a VISCA error reply. */
export function viscaError(errCode) {
  const e = VISCA_ERRORS[errCode];
  if (e) return new DriverError(e.message, { code: e.code, kind: 'refused' });
  return new DriverError(`the camera answered with VISCA error ${hexByte(errCode)}`, { code: 'visca', kind: 'refused' });
}

const hexByte = (b) => b.toString(16).padStart(2, '0');
/** `81 01 06 01 ...` — for logs. */
export const hex = (buf) => [...buf].map(hexByte).join(' ');

/** Reads `0p 0q 0r 0s` (one nibble per byte) as a number. */
export function nibbles(buf, from, count) {
  let v = 0;
  for (let i = 0; i < count; i++) v = (v << 4) | (buf[from + i] & 0x0f);
  return v >>> 0;
}

/** Writes a number as `count` nibble bytes, most significant first. */
export function toNibbles(value, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push((value >>> (i * 4)) & 0x0f);
  return out;
}

/** Two's-complement reading of an n-bit field. */
export function signed(value, bits) {
  const top = 2 ** (bits - 1);
  return value >= top ? value - 2 ** bits : value;
}

/**
 * Is this the first byte of a reply? `z0`, z = 8..F.
 *
 * Normally `90` (camera address 1 + 8). PTZOptics Move SE firmware before 12X
 * 9.1.56 / 20X 9.1.38 / 30X 9.1.42 put the *serial* VISCA address there when it
 * had been changed (`a0`, `b0` …; ptzoptics notes §2.1, FW-0112 known issues),
 * and a strict `90`-only parser drops those cameras. Accepting any `z0` costs
 * nothing: the camera at the other end of a unicast socket is the only one
 * that can be talking.
 */
const isReplyAddress = (b) => b >= 0x80 && (b & 0x0f) === 0;

/** Parses a VISCA reply `z0 tt ... FF`. */
function parseReply(r) {
  if (r.length < 3 || !isReplyAddress(r[0]) || r[r.length - 1] !== 0xff) return null;
  const kind = r[1] & 0xf0;
  const socket = r[1] & 0x0f;
  if (kind === 0x40) return { type: 'ack', socket };
  if (kind === 0x50) return socket === 0 ? { type: 'reply', socket, bytes: r } : { type: 'completion', socket };
  if (kind === 0x60) return { type: 'error', socket, err: r[2] };
  // `z0 38 FF` is the serial "network change" message; meaningless over IP and
  // not sent by PTZOptics (companion-module-ptzoptics-visca src/visca/port.ts:660,
  // impl only). Anything else unexpected is dropped too.
  return null;
}

const toBuf = (p) => (Buffer.isBuffer(p) ? p : Buffer.from(p));

export class ViscaClient {
  /**
   * @param {object} o
   * @param {string} o.host
   * @param {number} o.port
   * @param {'sony-ip'|'raw-tcp'} o.framing
   * @param {number} [o.timeoutMs=1500]   per call, all attempts included
   * @param {number} [o.localPort=0]      Sony only; see #openUdp
   * @param {number} [o.socketWaitMs=500] how long a third command waits for a free buffer
   * @param {number} [o.staleMs=10000]    a buffer whose Completion never came is free again after this
   * @param {(level: string, msg: string) => void} [o.log]
   */
  constructor({ host, port, framing, timeoutMs = 1500, localPort = 0, socketWaitMs = 500, staleMs = 10_000, log = () => {} }) {
    if (!Object.values(FRAMING).includes(framing)) throw new Error(`unknown VISCA framing ${framing}`);
    this.host = host;
    this.port = port;
    this.framing = framing;
    this.timeoutMs = timeoutMs;
    this.localPort = localPort;
    this.socketWaitMs = socketWaitMs;
    this.staleMs = staleMs;
    this.log = log;
    this.closed = false;
    /** When the camera last said anything at all. */
    this.lastReplyAt = 0;

    this.queue = [];
    this.pumping = false;
    /** The one job awaiting its first reply. */
    this.current = null;
    /** socket nibble -> [{ job?, seq?, at }] — a list, not a slot; see #occupy. */
    this.buffers = new Map();
    this.freeWaiters = [];

    // Sony
    this.udp = null;
    this.udpReady = null;
    this.seq = 0;
    this.resetPending = null;
    this.needReset = true;

    // Raw TCP
    this.tcp = null;
    this.tcpConnecting = null;
    this.rx = Buffer.alloc(0);
  }

  /**
   * Sends a command (`8x 01 ...`). Resolves `{ socket }` on ACK, or after the
   * Completion with `{ completion: true }`.
   */
  command(payload, { completion = false, timeoutMs } = {}) {
    return this.#enqueue({ kind: 'command', payload: toBuf(payload), completion, timeoutMs: timeoutMs ?? this.timeoutMs });
  }

  /** Sends an inquiry (`8x 09 ...`). Resolves with the whole reply, `90 50 ... FF`. */
  inquiry(payload, { timeoutMs } = {}) {
    return this.#enqueue({ kind: 'inquiry', payload: toBuf(payload), timeoutMs: timeoutMs ?? this.timeoutMs });
  }

  /** Commands ACKed and not yet completed, per buffer. For tests and diagnostics. */
  get occupied() {
    this.#prune();
    return [...this.buffers.values()].filter((l) => l.length).length;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const err = new DriverError('VISCA connection closed', { kind: 'network' });
    for (const j of this.queue) j.reject(err);
    this.queue = [];
    if (this.current) this.#finishFirst(this.current, err);
    this.#failBuffers(err);
    for (const w of this.freeWaiters) w();
    this.freeWaiters = [];
    if (this.udp) {
      try { this.udp.close(); } catch { /* already closed */ }
      this.udp = null;
    }
    if (this.tcp) {
      this.tcp.destroy();
      this.tcp = null;
    }
  }

  // --- the queue -------------------------------------------------------------

  #enqueue(job) {
    if (this.closed) return Promise.reject(new DriverError('VISCA connection closed', { kind: 'network' }));
    return new Promise((resolve, reject) => {
      let settled = false;
      job.resolve = (v) => { if (!settled) { settled = true; resolve(v); } };
      job.reject = (e) => { if (!settled) { settled = true; reject(e); } };
      job.settled = () => settled;
      this.queue.push(job);
      this.#pump();
    });
  }

  async #pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.closed) {
        const job = this.queue.shift();
        try {
          await this.#exchange(job);
        } catch (err) {
          job.reject(err instanceof DriverError ? err : new DriverError(err?.message ?? String(err), { kind: 'network' }));
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Sends one job and returns when its first reply (or failure) is in. */
  async #exchange(job) {
    const deadline = Date.now() + job.timeoutMs;
    if (job.kind === 'command') {
      // Third command while two buffers are busy: give a Completion a moment to
      // arrive rather than collect a certain "buffer full".
      if (this.occupied >= 2) await this.#waitForFree(Math.min(this.socketWaitMs, job.timeoutMs / 2));
    }
    if (this.framing === FRAMING.SONY_IP) await this.#exchangeSony(job, deadline);
    else await this.#exchangeRaw(job, deadline);

    // Buffer full means "not executed", so one retry cannot run anything
    // twice. (The PTZOptics module resends once in the same case:
    // companion-module-ptzoptics-visca src/visca/port.ts:939-950, impl.)
    if (job.retryBufferFull && !job.settled() && !this.closed) {
      job.retryBufferFull = false;
      await this.#waitForFree(Math.min(this.socketWaitMs, Math.max(0, deadline - Date.now())));
      job.retried = true;
      if (this.framing === FRAMING.SONY_IP) await this.#exchangeSony(job, deadline);
      else await this.#exchangeRaw(job, deadline);
    }
  }

  #finishFirst(job, err, value) {
    clearTimeout(job.timer);
    job.timer = null;
    if (this.current === job) this.current = null;
    const done = job.firstDone;
    job.firstDone = null;
    if (err) {
      // One retry on buffer full, decided by #exchange.
      if (err.code === 'bufferFull' && !job.retried && job.kind === 'command') job.retryBufferFull = true;
      else job.reject(err);
    } else if (value !== undefined) {
      job.resolve(value);
    }
    done?.();
  }

  // --- buffers ---------------------------------------------------------------

  /**
   * Marks buffer z busy with a command.
   *
   * A list per buffer rather than one slot: the PTZOptics Move SE "will, if
   * pressured, assign multiple commands to the same socket without always
   * clearing the socket" (companion-module-ptzoptics-visca src/visca/port.ts:
   * 340-352, impl). A Completion clears the oldest.
   */
  #occupy(z, entry) {
    if (!this.buffers.has(z)) this.buffers.set(z, []);
    this.buffers.get(z).push({ ...entry, at: Date.now() });
  }

  #release(z, { seq, err } = {}) {
    const list = this.buffers.get(z);
    if (!list?.length) return;
    // Sony replies carry the sequence number, so a Completion for a command we
    // never saw ACKed (its ACK was lost) must not free some other command's
    // buffer. Raw TCP has only the order to go on: the oldest.
    const i = seq !== undefined ? list.findIndex((e) => e.seq === seq) : 0;
    if (i < 0) return;
    const [e] = list.splice(i, 1);
    if (e.job) {
      if (err) e.job.reject(err);
      else e.job.resolve({ socket: z, completed: true });
    }
    const waiters = this.freeWaiters;
    this.freeWaiters = [];
    for (const w of waiters) w();
  }

  /** Forgets buffers whose Completion never came (lost on UDP, or a camera that never sends one). */
  #prune() {
    const now = Date.now();
    for (const [z, list] of this.buffers) {
      while (list.length && now - list[0].at > this.staleMs) {
        const e = list.shift();
        e.job?.reject(new DriverError('the camera accepted the command but never reported it complete', { kind: 'timeout' }));
        this.log('debug', `VISCA buffer ${z}: no completion, forgotten`);
      }
    }
  }

  #failBuffers(err) {
    for (const list of this.buffers.values()) for (const e of list) e.job?.reject(err);
    this.buffers.clear();
  }

  #waitForFree(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      this.freeWaiters.push(done);
    });
  }

  /** The first reply to `job` is an ACK on buffer z. */
  #acked(job, z, seq) {
    if (job.completion) {
      this.#occupy(z, { job, seq });
      this.#finishFirst(job, null, undefined);
    } else {
      this.#occupy(z, { seq });
      this.#finishFirst(job, null, { socket: z });
    }
  }

  // --- replies (both framings) -----------------------------------------------

  /**
   * One VISCA reply. `matchesCurrent` says whether it belongs to the message
   * awaiting its first reply — certain for Sony (sequence number), inferred
   * from order for raw TCP.
   */
  #onReply(bytes, { matchesCurrent, seq }) {
    this.lastReplyAt = Date.now();
    const r = parseReply(bytes);
    if (!r) {
      this.log('debug', `VISCA: ignored ${hex(bytes)}`);
      return;
    }
    const job = this.current;
    switch (r.type) {
      case 'ack':
        if (job && matchesCurrent && job.kind === 'command') this.#acked(job, r.socket, seq);
        return;
      case 'completion':
        // Sony: a Completion carrying the sequence number of the message still
        // waiting for its ACK means the ACK was lost and the command is done.
        if (job && matchesCurrent && seq !== undefined && job.kind === 'command') {
          this.#finishFirst(job, null, { socket: r.socket, completed: true });
          return;
        }
        this.#release(r.socket, { seq });
        return;
      case 'reply':
        // `90 50 ... FF`: an inquiry's answer, or a command completed without
        // using a buffer (V-EN p.7: e.g. IF_Clear). Either way, it is the end.
        if (job && matchesCurrent) {
          this.#finishFirst(job, null, job.kind === 'inquiry' ? Buffer.from(r.bytes) : { socket: 0 });
        }
        return;
      case 'error': {
        const err = viscaError(r.err);
        // Raw TCP cannot tell "error instead of an ACK" from "error instead of
        // a Completion" when both are possible (VISCA API p.6). Cancelled is
        // only ever about a running command; otherwise the message waiting for
        // its first reply is the one being answered — the camera rejects a
        // command it cannot run before assigning it a buffer.
        if (job && matchesCurrent && r.err !== 0x04) {
          // Not ACKed, so it never occupied a buffer of ours.
          this.#finishFirst(job, err);
          return;
        }
        if (r.socket) this.#release(r.socket, { seq, err });
        return;
      }
      default:
    }
  }

  // --- Sony VISCA over IP (UDP) ---------------------------------------------

  /**
   * Binds the UDP socket.
   *
   * Ephemeral local port by default. Whether the camera answers the sender's
   * port or a fixed one is not documented (sony notes §2.1 "Controller source
   * port": UNKNOWN; the Companion module binds 52381, impl only). 52381 is
   * also where CamBridge's own VISCA server listens, so binding it here would
   * collide; `localPort` exists for the case a camera turns out to reply only
   * to 52381.
   */
  #openUdp() {
    if (this.udpReady) return this.udpReady;
    this.udpReady = new Promise((resolve, reject) => {
      const s = dgram.createSocket('udp4');
      this.udp = s;
      const filterHost = net.isIP(this.host) ? this.host : null;
      s.on('message', (msg, rinfo) => {
        try {
          if (filterHost && rinfo.address !== filterHost) return;
          this.#onDatagram(msg);
        } catch (err) {
          this.log('debug', `VISCA: bad datagram (${err.message})`);
        }
      });
      s.on('error', (err) => {
        this.log('debug', `VISCA UDP: ${err.message}`);
        if (this.current) this.#finishFirst(this.current, new DriverError(`VISCA socket error: ${err.code ?? err.message}`, { kind: 'network' }));
        reject(new DriverError(`VISCA socket error: ${err.code ?? err.message}`, { kind: 'network' }));
      });
      s.bind(this.localPort, () => resolve());
    });
    this.udpReady.catch(() => { this.udpReady = null; });
    return this.udpReady;
  }

  #frame(type, seq, payload) {
    const b = Buffer.alloc(8 + payload.length);
    b.writeUInt16BE(type, 0);
    b.writeUInt16BE(payload.length, 2);
    b.writeUInt32BE(seq >>> 0, 4);
    payload.copy(b, 8);
    return b;
  }

  #sendUdp(buf) {
    if (!this.udp) return;
    this.udp.send(buf, this.port, this.host, (err) => {
      if (err) this.log('debug', `VISCA send failed: ${err.message}`);
    });
  }

  /** "If the sequence number reaches the limit, next value will be 0" (V-EN p.10). */
  #nextSeq() {
    this.seq = this.seq >= 0xffffffff ? 0 : this.seq + 1;
    return this.seq;
  }

  /**
   * RESET: control command, payload `01`, "resets the sequence number to 0;
   * the value that was set as the sequence number is ignored". Full datagram
   * `02 00 00 01 00 00 00 00 01` (V-EN p.11; Companion module src/visca.js:200).
   * Reply: control reply `02 01`, payload `01`.
   *
   * The first message after it uses sequence number 1. Sony says the counter
   * is reset "to 0" but not whether 0 or 1 comes next (sony notes Gaps 4); the
   * Companion module uses 1 against real cameras (src/visca.js:226, impl), and
   * reusing 0 risks looking like a retransmission of the RESET itself.
   */
  async #reset(timeoutMs) {
    await this.#openUdp();
    if (this.resetPending) return this.resetPending.promise;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const pending = { promise, resolve, reject, timer: null };
    this.resetPending = pending;
    const frame = this.#frame(TYPE.CONTROL, 0, Buffer.from([0x01]));
    const attemptMs = Math.max(100, Math.floor(timeoutMs / 2));
    let attempts = 0;
    const attempt = () => {
      if (this.closed) { reject(new DriverError('VISCA connection closed', { kind: 'network' })); return; }
      if (attempts++ >= 2) {
        reject(new DriverError('no answer over VISCA', { kind: 'timeout' }));
        return;
      }
      this.#sendUdp(frame);
      pending.timer = setTimeout(attempt, attemptMs);
    };
    attempt();
    try {
      await promise;
      this.seq = 0;
      this.needReset = false;
    } finally {
      clearTimeout(pending.timer);
      if (this.resetPending === pending) this.resetPending = null;
    }
  }

  #onDatagram(msg) {
    if (msg.length < 9) return;
    const type = msg.readUInt16BE(0);
    const len = msg.readUInt16BE(2);
    const seq = msg.readUInt32BE(4);
    if (8 + len > msg.length) return;
    const payload = msg.subarray(8, 8 + len);

    if (type === TYPE.CONTROL_REPLY || type === TYPE.CONTROL) {
      this.lastReplyAt = Date.now();
      if (payload[0] === 0x01 && this.resetPending) {
        this.resetPending.resolve();
        return;
      }
      if (payload[0] === 0x0f) this.#onControlError(payload[1] ?? 0, seq);
      return;
    }
    if (type !== TYPE.REPLY) return;
    const job = this.current;
    this.#onReply(payload, { matchesCurrent: !!job && job.seq === seq, seq });
  }

  /**
   * Control ERROR `0F pp` (V-EN p.11): pp 01 = abnormality in sequence number,
   * 02 = abnormality in message type. Which datagram type carries it, and
   * whether it echoes the sequence number, is not stated (sony notes Gaps 4),
   * so it is matched to the one message awaiting a reply.
   *
   * The sequence-number case is how Sony's retransmit rule (V-EN p.12) answers:
   * - a retransmitted *command* gets it when the original ran and only its ACK
   *   or Completion was lost — so it already executed, and that is success;
   * - a retransmitted *inquiry* gets it when its reply was lost — resend with
   *   a new sequence number;
   * - a first transmission getting it means our counter and the camera's
   *   disagree (another controller reset it, the camera rebooted) — RESET and
   *   resend once with a new number.
   */
  #onControlError(pp, seq) {
    const job = this.current;
    if (!job || job.kind === 'reset') return;
    if (seq !== 0 && seq !== job.seq) return;
    if (pp === 0x02) {
      this.#finishFirst(job, new DriverError('the camera rejected the VISCA message type', { code: 'message', kind: 'refused' }));
      return;
    }
    if (pp !== 0x01) return;
    if (job.retransmitted && job.kind === 'command') {
      this.#finishFirst(job, null, { socket: null, assumed: true });
      return;
    }
    if (job.renewed >= 1) {
      this.#finishFirst(job, new DriverError('the camera kept rejecting the VISCA sequence number', { code: 'sequence', kind: 'refused' }));
      return;
    }
    job.renewed += 1;
    const resetFirst = !job.retransmitted;
    clearTimeout(job.timer);
    (async () => {
      if (resetFirst) {
        this.needReset = true;
        await this.#reset(job.attemptMs * 2);
      }
      if (this.current !== job) return;
      this.#transmitSony(job, true);
    })().catch((err) => { if (this.current === job) this.#finishFirst(job, err); });
  }

  #exchangeSony(job, deadline) {
    return (async () => {
      const left = () => Math.max(50, deadline - Date.now());
      if (this.needReset) await this.#reset(Math.min(left(), 1000));
      // Two transmissions plus one resend with a fresh sequence number fit in
      // the call's budget; a camera that cannot answer one of three in that
      // time is not answering.
      job.attemptMs = Math.max(60, Math.floor(left() / 3));
      job.renewed = job.renewed ?? 0;
      await new Promise((done) => {
        job.firstDone = done;
        this.current = job;
        this.#transmitSony(job, true);
      });
    })();
  }

  /** Sends `job` — with a fresh sequence number, or as a retransmission with the same one. */
  #transmitSony(job, fresh) {
    if (fresh) {
      job.seq = this.#nextSeq();
      job.frame = this.#frame(job.kind === 'inquiry' ? TYPE.INQUIRY : TYPE.COMMAND, job.seq, job.payload);
      job.attempts = 1;
      job.retransmitted = false;
    }
    this.#sendUdp(job.frame);
    clearTimeout(job.timer);
    job.timer = setTimeout(() => this.#attemptTimedOut(job), job.attemptMs);
  }

  /**
   * No reply in time. Retransmit once with the **same** sequence number: a
   * lost command then runs and is ACKed, a command that already ran gets the
   * sequence error instead of running twice (V-EN p.12). That rule is what
   * makes retransmitting a pan command safe.
   */
  #attemptTimedOut(job) {
    if (this.current !== job) return;
    if (job.attempts < 2) {
      job.attempts += 1;
      job.retransmitted = true;
      this.#transmitSony(job, false);
      return;
    }
    this.#finishFirst(job, new DriverError('no answer over VISCA', { kind: 'timeout' }));
  }

  // --- raw VISCA over TCP ----------------------------------------------------

  /**
   * Connects, or reuses the open socket. A dropped socket is reopened by the
   * next call rather than by a timer: the lifecycle owns retry policy, and a
   * driver that is not being asked anything has no reason to reconnect.
   */
  #connectTcp(timeoutMs) {
    if (this.tcp && !this.tcp.destroyed && !this.tcp.connecting) return Promise.resolve();
    if (this.tcpConnecting) return this.tcpConnecting;
    this.tcpConnecting = new Promise((resolve, reject) => {
      const s = net.connect({ host: this.host, port: this.port });
      this.tcp = s;
      this.rx = Buffer.alloc(0);
      let open = false;
      const timer = setTimeout(() => {
        reject(new DriverError(`no answer on VISCA port ${this.port}`, { kind: 'timeout' }));
        s.destroy();
      }, timeoutMs);
      s.setNoDelay(true);
      s.once('connect', () => { open = true; clearTimeout(timer); resolve(); });
      s.on('data', (chunk) => {
        try { this.#onTcpData(s, chunk); } catch (err) { this.log('debug', `VISCA: bad data (${err.message})`); }
      });
      s.on('error', (err) => {
        this.log('debug', `VISCA TCP: ${err.code ?? err.message}`);
        if (!open) {
          clearTimeout(timer);
          reject(new DriverError(`cannot reach VISCA port ${this.port} (${err.code ?? err.message})`, { kind: 'network' }));
        }
      });
      s.on('close', () => {
        clearTimeout(timer);
        if (this.tcp !== s) return;
        this.tcp = null;
        this.rx = Buffer.alloc(0);
        const err = new DriverError('the camera closed the VISCA connection', { kind: 'network' });
        if (this.current) this.#finishFirst(this.current, err);
        // Whatever was running is in an unknown state; the buffers are not ours to count any more.
        this.#failBuffers(err);
      });
    });
    const p = this.tcpConnecting;
    p.then(() => { this.tcpConnecting = null; }, () => { this.tcpConnecting = null; });
    return p;
  }

  #onTcpData(s, chunk) {
    if (s !== this.tcp) return;
    this.rx = this.rx.length ? Buffer.concat([this.rx, chunk]) : chunk;
    for (;;) {
      const end = this.rx.indexOf(0xff);
      if (end < 0) {
        // A reply is at most 16 bytes; a megabyte with no terminator is not VISCA.
        if (this.rx.length > 4096) this.rx = Buffer.alloc(0);
        return;
      }
      const frame = this.rx.subarray(0, end + 1);
      this.rx = this.rx.subarray(end + 1);
      // A frame that does not start with an address byte is a fragment of
      // something we missed; resynchronise on the terminator.
      if (!isReplyAddress(frame[0])) {
        this.log('debug', `VISCA: skipped ${hex(frame)}`);
        continue;
      }
      this.#onReply(Buffer.from(frame), { matchesCurrent: !!this.current });
    }
  }

  #exchangeRaw(job, deadline) {
    return (async () => {
      await this.#connectTcp(Math.max(50, deadline - Date.now()));
      await new Promise((done) => {
        job.firstDone = done;
        this.current = job;
        const s = this.tcp;
        s.write(job.payload);
        job.timer = setTimeout(() => {
          if (this.current !== job) return;
          // No retransmit on TCP: the bytes either arrived or the socket is
          // dead, and a resend could run a move twice. Drop the socket, so a
          // late reply to this message cannot be taken as the answer to the
          // next one — raw VISCA has nothing else to tell them apart.
          this.#finishFirst(job, new DriverError('no answer over VISCA', { kind: 'timeout' }));
          if (this.tcp === s) s.destroy();
        }, Math.max(50, deadline - Date.now()));
      });
    })();
  }
}
