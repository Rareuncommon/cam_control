// The sACN sender: one UDP socket on the lighting network, and what to send it.
//
// Reliability is the brief here, not throughput — five panels at 40 Hz is
// nothing. So everything that can go wrong on a studio network is an ordinary
// event with a status, never an exception:
//   - en14 down, or its address gone: no socket, status says so, retried
//     every few seconds, and the camera side of CamBridge never notices;
//   - a send failing (cable out, switch rebooting): counted, logged once per
//     burst, and the next frame tries again;
//   - output switched off, or dry-run: nothing leaves the Mac at all.
//
// The socket is bound to the lighting interface's own address, so unicast
// leaves from en14 whatever the routing table thinks, and multicast is sent on
// en14 explicitly.

import { createSocket } from 'node:dgram';
import { networkInterfaces as osNetworkInterfaces } from 'node:os';
import { EventEmitter } from 'node:events';
import { isIPv4 } from 'node:net';

import { buildDataPacket, multicastAddress, SACN_PORT, DEFAULT_PRIORITY } from './sacn.js';

/**
 * Where to bind: the configured address if this Mac has it, otherwise the
 * named interface's IPv4 address.
 *
 * @returns {{ok: true, address: string, interface: string|null} | {ok: false, error: string}}
 */
export function resolveLocalAddress({ interface: iface, address }, nics = osNetworkInterfaces()) {
  const v4 = (list) => (list ?? []).filter((a) => a.family === 'IPv4' || a.family === 4).map((a) => a.address);
  if (address) {
    if (!isIPv4(address)) return { ok: false, error: `"${address}" is not an IPv4 address` };
    for (const [name, list] of Object.entries(nics)) {
      if (v4(list).includes(address)) return { ok: true, address, interface: name };
    }
    return { ok: false, error: `${address} is not on this computer${iface ? ` — is ${iface} up?` : ''}` };
  }
  if (!iface) return { ok: false, error: 'no lighting interface or address configured' };
  const addresses = v4(nics[iface]);
  if (!addresses.length) return { ok: false, error: `${iface} is not up (no IPv4 address)` };
  return { ok: true, address: addresses[0], interface: iface };
}

export class SacnOutput extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.settings   lighting.output from the config
   * @param {(level: string, msg: string) => void} [o.log]
   * @param {() => object} [o.networkInterfaces]  injectable, for tests
   * @param {(opts: object) => object} [o.createSocket]  injectable, for tests
   * @param {number} [o.retryMs=5000]
   */
  constructor({ settings, log = () => {}, networkInterfaces = osNetworkInterfaces, createSocket: make = createSocket, retryMs = 5000 }) {
    super();
    this.log = log;
    this.networkInterfaces = networkInterfaces;
    this.makeSocket = make;
    this.retryMs = retryMs;
    this.socket = null;
    this.binding = false;
    this.bound = null;          // { address, interface }
    this.error = null;
    this.sequences = new Map(); // universe -> last sequence number sent
    this.counters = { packets: 0, frames: 0, sendErrors: 0 };
    this.lastSentAt = null;
    this.lastFrames = new Map(); // universe -> slots, in dry-run and live alike
    this.retryTimer = null;
    this.watchTimer = null;
    this.errorBurst = 0;
    this.closed = false;
    this.configure(settings);
  }

  /** Applies new settings. A change of interface, address or mode rebinds. */
  configure(settings) {
    const s = settings ?? {};
    const before = this.settings;
    this.settings = {
      enabled: s.enabled === true,
      dryRun: s.dryRun === true,
      interface: s.interface ?? 'en14',
      address: s.address ?? '',
      mode: s.mode === 'multicast' ? 'multicast' : 'unicast',
      priority: Number.isInteger(s.priority) ? s.priority : DEFAULT_PRIORITY,
      sourceName: typeof s.sourceName === 'string' && s.sourceName.trim() ? s.sourceName.trim() : 'CamBridge',
      cid: s.cid,
      port: Number.isInteger(s.port) ? s.port : SACN_PORT,
    };
    const rebind = !before || before.interface !== this.settings.interface
      || before.address !== this.settings.address || before.mode !== this.settings.mode;
    if (rebind) this.#closeSocket();
    this.#ensureSocket();
  }

  /** True when frames will actually leave the computer. */
  get live() { return this.settings.enabled && !this.settings.dryRun && !!this.socket && !!this.bound; }

  /**
   * Sends one universe to its destinations, or records it in dry-run. Never throws.
   *
   * @param {number} universe
   * @param {Uint8Array} slots
   * @param {string[]} unicastTo  fixture addresses in this universe
   */
  send(universe, slots, unicastTo) {
    if (!this.settings.enabled || this.closed) return;
    this.lastFrames.set(universe, Uint8Array.from(slots));
    this.counters.frames += 1;
    if (this.settings.dryRun) return;
    if (!this.socket || !this.bound) return;   // retrying in the background; status says why
    const sequence = ((this.sequences.get(universe) ?? -1) + 1) & 0xff;
    this.sequences.set(universe, sequence);
    let packet;
    try {
      packet = buildDataPacket({
        cid: this.settings.cid, sourceName: this.settings.sourceName, priority: this.settings.priority,
        sequence, universe, slots,
      });
    } catch (err) {
      this.#fail(`cannot build a packet: ${err.message}`);
      return;
    }
    const destinations = this.settings.mode === 'multicast' ? [multicastAddress(universe)] : unicastTo;
    for (const dest of destinations) {
      try {
        this.socket.send(packet, this.settings.port, dest, (err) => {
          if (err) this.#sendError(dest, err);
          else { this.counters.packets += 1; this.lastSentAt = Date.now(); this.#sendOk(); }
        });
      } catch (err) {
        this.#sendError(dest, err);
      }
    }
  }

  status() {
    const s = this.settings;
    let state;
    if (!s.enabled) state = 'off';
    else if (s.dryRun) state = 'dry-run';
    else if (!this.bound) state = 'error';
    else if (this.errorBurst > 0) state = 'degraded';
    else state = 'sending';
    return {
      state,
      enabled: s.enabled,
      dryRun: s.dryRun,
      mode: s.mode,
      interface: s.interface,
      address: s.address,
      bound: this.bound,
      priority: s.priority,
      sourceName: s.sourceName,
      cid: s.cid,
      port: s.port,
      error: this.error,
      counters: { ...this.counters },
      lastSentAt: this.lastSentAt,
    };
  }

  /** The last frame per universe, as sent (or as it would have been, in dry-run). */
  frames() {
    return Object.fromEntries([...this.lastFrames].map(([u, slots]) => [u, [...slots]]));
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.watchTimer);
    this.#closeSocket();
  }

  #ensureSocket() {
    if (this.closed || this.socket || this.binding) return;
    // The socket is opened whenever the interface is there, enabled or not, so
    // Setup can say "en14 is down" before anyone turns output on.
    const where = resolveLocalAddress(this.settings, this.networkInterfaces());
    if (!where.ok) {
      this.#setError(where.error);
      this.#retryLater();
      return;
    }
    this.binding = true;
    let socket;
    try {
      socket = this.makeSocket({ type: 'udp4', reuseAddr: true });
    } catch (err) {
      this.binding = false;
      this.#setError(`cannot open a UDP socket: ${err.message}`);
      this.#retryLater();
      return;
    }
    socket.on('error', (err) => {
      // A socket error (the address vanished under it, say) closes it; the
      // retry loop opens a new one when the interface is back.
      this.binding = false;
      if (this.socket === socket) this.socket = null;
      this.bound = null;
      try { socket.close(); } catch { /* already closed */ }
      this.#setError(`sACN socket: ${err.message}`);
      this.#retryLater();
    });
    socket.bind({ address: where.address, port: 0 }, () => {
      this.binding = false;
      if (this.closed) { try { socket.close(); } catch { /* gone */ } return; }
      try {
        if (this.settings.mode === 'multicast') {
          socket.setMulticastInterface(where.address);
          socket.setMulticastTTL(8);
        }
      } catch (err) {
        this.log('warn', `multicast setup: ${err.message}`);
      }
      this.socket = socket;
      this.bound = { address: where.address, interface: where.interface };
      this.#setError(null);
      this.log('info', `sACN bound to ${where.address}${where.interface ? ` (${where.interface})` : ''}, ${this.settings.mode}`);
      this.#watchAddress();
      this.emit('status');
    });
  }

  /** Notices the lighting address disappearing (en14 unplugged) and rebinds when it returns. */
  #watchAddress() {
    clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => {
      const where = resolveLocalAddress(this.settings, this.networkInterfaces());
      if (where.ok && where.address === this.bound?.address) return;
      this.#closeSocket();
      this.#setError(where.ok ? `the lighting address changed to ${where.address}` : where.error);
      this.#ensureSocket();
    }, this.retryMs);
    this.watchTimer.unref?.();
  }

  #retryLater() {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.#ensureSocket();
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  #closeSocket() {
    clearInterval(this.watchTimer);
    this.watchTimer = null;
    if (this.socket) { try { this.socket.close(); } catch { /* already closed */ } }
    this.socket = null;
    this.bound = null;
  }

  #setError(message) {
    if (message === this.error) return;
    this.error = message;
    if (message) this.log('error', message);
    this.emit('status');
  }

  #fail(message) {
    this.counters.sendErrors += 1;
    this.#setError(message);
  }

  #sendError(dest, err) {
    this.counters.sendErrors += 1;
    // One line per burst, not one per packet at 40 Hz.
    if (this.errorBurst === 0) {
      this.log('warn', `sACN send to ${dest} failed: ${err.code ?? err.message}`);
      this.error = `sending to ${dest}: ${err.code ?? err.message}`;
      this.emit('status');
    }
    this.errorBurst += 1;
  }

  #sendOk() {
    if (this.errorBurst === 0) return;
    this.log('info', `sACN sending again after ${this.errorBurst} failed packet(s)`);
    this.errorBurst = 0;
    this.error = null;
    this.emit('status');
  }
}
