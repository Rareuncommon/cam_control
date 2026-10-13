// A simulated PTZ head, for `--fake` rehearsals and the tests.
//
// Not a protocol fake — the vendor fakes in test/fakes/ speak the real wire
// formats. This one sits behind the driver contract directly, so the lifecycle,
// deadman, panel and Companion can be exercised without any vendor's bytes.
// It moves: velocities integrate into a position, and the snapshot is rendered
// from that position, so a joystick on the panel visibly pans the picture.
//
// State lives per host in a module-level map, so a "reconnect" finds the same
// camera where it was left — as a real one would be.

import { deflateSync, crc32 } from 'node:zlib';
import { PtzDriver, DriverError } from '../driver.js';

const heads = new Map();

function headFor(host) {
  let h = heads.get(host);
  if (!h) {
    h = {
      pan: 0.5, tilt: 0.5, zoom: 0, focus: 0.5,
      v: { pan: 0, tilt: 0, zoom: 0, focus: 0 },
      at: Date.now(),
      presets: new Map(),
      values: {
        irisMode: 'auto', iris: 5.6, gain: 0, shutter: '1/50',
        wbMode: 'auto', colorTemp: 5600, detail: 0,
        focusMode: 'auto', panTiltSpeedLimit: 100,
        trackingEnabled: false, trackingTarget: 'centre',
        tallyEnable: true, cameraName: 'Simulated PTZ', ipAddress: host,
        adminPassword: '',
      },
      down: false,
      log: [],
    };
    heads.set(host, h);
  }
  return h;
}

/** Test hook: the simulated camera's internals. */
export function fakeHead(host) { return headFor(host); }
export function resetFakeHeads() { heads.clear(); }

/** Degrees of travel per second at full speed, as a fraction of the axis. */
const RATE = { pan: 0.25, tilt: 0.25, zoom: 0.35, focus: 0.5 };

function integrate(h) {
  const now = Date.now();
  const dt = (now - h.at) / 1000;
  h.at = now;
  for (const a of ['pan', 'tilt', 'zoom', 'focus']) {
    h[a] = Math.max(0, Math.min(1, h[a] + h.v[a] * RATE[a] * dt));
  }
}

const SHUTTERS = ['1/25', '1/50', '1/60', '1/100', '1/120', '1/250', '1/500'];

const TABLE = [
  { id: 'cameraName', group: 'camera', label: 'Camera name', type: 'text', maxLength: 32, role: 'cameraName' },
  { id: 'irisMode', group: 'exposure', label: 'Iris mode', type: 'enum', operate: true, role: 'irisMode',
    options: [{ value: 'auto', label: 'Auto' }, { value: 'manual', label: 'Manual' }] },
  { id: 'iris', group: 'exposure', label: 'Iris', type: 'range', operate: true, role: 'iris',
    range: { min: 1.6, max: 11, step: 0.1, unit: '' }, gate: { id: 'irisMode', value: 'manual' } },
  { id: 'gain', group: 'exposure', label: 'Gain', type: 'range', operate: true, role: 'gain',
    range: { min: -3, max: 36, step: 3, unit: ' dB' } },
  { id: 'shutter', group: 'exposure', label: 'Shutter', type: 'enum', operate: true, role: 'shutter',
    options: SHUTTERS.map((s) => ({ value: s, label: s })) },
  { id: 'wbMode', group: 'whiteBalance', label: 'White balance', type: 'enum', operate: true, role: 'whiteBalanceMode',
    options: [{ value: 'auto', label: 'Auto' }, { value: 'indoor', label: 'Indoor' },
      { value: 'outdoor', label: 'Outdoor' }, { value: 'manual', label: 'Colour temp.' }] },
  { id: 'colorTemp', group: 'whiteBalance', label: 'Colour temperature', type: 'range', operate: true, role: 'colorTemp',
    range: { min: 2000, max: 15000, step: 100, unit: 'K' }, gate: { id: 'wbMode', value: 'manual' } },
  { id: 'detail', group: 'image', label: 'Detail', type: 'range', range: { min: -10, max: 10, step: 1 } },
  { id: 'focusMode', group: 'lens', label: 'Focus mode', type: 'enum', operate: true, role: 'focusMode',
    autoValue: 'auto', manualValue: 'manual',
    options: [{ value: 'auto', label: 'Auto' }, { value: 'manual', label: 'Manual' }] },
  { id: 'onePushAf', group: 'lens', label: 'One-push AF', type: 'action', operate: true, role: 'onePushAf' },
  { id: 'panTiltSpeedLimit', group: 'ptz', label: 'Speed limit', type: 'range',
    range: { min: 10, max: 100, step: 10, unit: '%' } },
  { id: 'home', group: 'ptz', label: 'Home', type: 'action', operate: true, role: 'home' },
  { id: 'trackingEnabled', group: 'tracking', label: 'Auto tracking', type: 'bool', operate: true, requires: 'tracking', role: 'trackingEnabled' },
  { id: 'trackingTarget', group: 'tracking', label: 'Target', type: 'enum', requires: 'tracking', role: 'trackingTarget',
    options: [{ value: 'centre', label: 'Centre' }, { value: 'largest', label: 'Largest person' }] },
  { id: 'tallyEnable', group: 'tally', label: 'Tally lamp', type: 'bool' },
  { id: 'ipAddress', group: 'network', label: 'IP address', type: 'text', danger: 'reconnect', role: 'ipAddress',
    pattern: '^\\d{1,3}(\\.\\d{1,3}){3}$' },
  { id: 'adminPassword', group: 'users', label: 'Admin password', type: 'text', danger: 'admin', secret: true, writeOnly: true },
  { id: 'reboot', group: 'maintenance', label: 'Restart camera', type: 'action', danger: 'admin' },
];

export class FakePtz extends PtzDriver {
  static vendor = 'fake';
  static label = 'Simulated';
  static models = ['Simulated PTZ'];
  static minIntervalMs = 0;

  static async probe(ctx) {
    if (!String(ctx.host).startsWith('fake')) return null;
    return { vendor: 'fake', model: 'Simulated PTZ', firmware: '1.0' };
  }

  constructor(ctx) {
    super(ctx);
    this.head = headFor(ctx.host);
    this.tracking = !!ctx.options?.tracking;
  }

  #alive() {
    if (this.head.down) throw new DriverError('no answer', { kind: 'timeout' });
  }

  async identify() {
    this.#alive();
    return { vendor: 'fake', model: 'Simulated PTZ', firmware: '1.0', serial: this.host, name: this.head.values.cameraName };
  }

  async heartbeat() { this.#alive(); }

  schema() {
    return TABLE.filter((e) => e.requires !== 'tracking' || this.tracking);
  }

  capabilities() {
    return {
      panTilt: true, zoom: true, focus: true,
      presets: 10, presetBase: 1,
      tracking: this.tracking ? { kind: 'autoTracking', label: 'Auto tracking' } : null,
      tally: true, snapshot: true, pointToCentre: true, power: false,
    };
  }

  async read(entries) {
    this.#alive();
    const out = {};
    for (const e of entries) {
      if (e.type === 'action') continue;
      if (e.writeOnly) { out[e.id] = { value: '', writable: true }; continue; }
      const writable = !e.gate || this.head.values[e.gate.id] === e.gate.value;
      out[e.id] = { value: this.head.values[e.id], writable };
    }
    return out;
  }

  async write(entry, value) {
    this.#alive();
    if (entry.gate && this.head.values[entry.gate.id] !== entry.gate.value) {
      throw new DriverError(`${entry.label} is automatic — switch it to manual first`);
    }
    this.head.values[entry.id] = value;
    this.head.log.push(['write', entry.id, value]);
    return {};
  }

  #setV(axes) {
    this.#alive();
    integrate(this.head);
    Object.assign(this.head.v, axes);
    this.head.log.push(['move', { ...axes }]);
  }

  async panTilt(pan, tilt) { this.#setV({ pan, tilt }); }
  async zoom(speed) { this.#setV({ zoom: speed }); }
  async focus(speed) { this.#setV({ focus: speed }); }
  async stop() { this.#setV({ pan: 0, tilt: 0, zoom: 0, focus: 0 }); this.head.log.push(['stop']); }

  async position() {
    this.#alive();
    integrate(this.head);
    const { pan, tilt, zoom, focus } = this.head;
    return { pan, tilt, zoom, focus };
  }

  async status() {
    this.#alive();
    return { tracking: this.tracking ? !!this.head.values.trackingEnabled : undefined };
  }

  async presetRecall(n) {
    this.#alive();
    const p = this.head.presets.get(n);
    if (!p) throw new DriverError(`preset ${n} is empty`);
    integrate(this.head);
    Object.assign(this.head, p);
    return {};
  }

  async presetStore(n) {
    this.#alive();
    integrate(this.head);
    const { pan, tilt, zoom, focus } = this.head;
    this.head.presets.set(n, { pan, tilt, zoom, focus });
    return {};
  }

  async presetDelete(n) { this.#alive(); this.head.presets.delete(n); return {}; }

  async action(entry) {
    this.#alive();
    this.head.log.push(['action', entry.id]);
    if (entry.id === 'home') Object.assign(this.head, { pan: 0.5, tilt: 0.5 });
    if (entry.id === 'onePushAf') this.head.focus = 0.5;
    return {};
  }

  async pointToCentre({ x, y }) {
    this.#alive();
    integrate(this.head);
    const fov = 1 - this.head.zoom * 0.8;
    this.head.pan = Math.max(0, Math.min(1, this.head.pan + (x - 0.5) * fov * 0.5));
    this.head.tilt = Math.max(0, Math.min(1, this.head.tilt - (y - 0.5) * fov * 0.5));
    return {};
  }

  async setTally(t) { this.#alive(); this.head.tally = t; }

  async snapshot() {
    this.#alive();
    integrate(this.head);
    return { contentType: 'image/png', body: renderFrame(this.head) };
  }
}

/** A small PNG of the "set" as seen from the head's position. No dependencies: zlib does the work. */
function renderFrame(h, w = 320, ht = 180) {
  const fov = 1 - h.zoom * 0.8;              // fraction of the world visible
  const cx = h.pan, cy = 1 - h.tilt;
  const blur = Math.abs(h.focus - 0.5) * 2;    // out of focus away from 0.5
  const raw = Buffer.alloc((w * 3 + 1) * ht);
  let o = 0;
  for (let y = 0; y < ht; y++) {
    raw[o++] = 0; // filter: none
    const wy = cy + (y / ht - 0.5) * fov * 0.5625;
    for (let x = 0; x < w; x++) {
      const wx = cx + (x / w - 0.5) * fov;
      const gx = Math.abs(((wx * 20) % 1 + 1) % 1 - 0.5) < 0.03 * (1 + blur * 3);
      const gy = Math.abs(((wy * 20) % 1 + 1) % 1 - 0.5) < 0.03 * (1 + blur * 3);
      const hue = ((wx % 1) + 1) % 1;
      const r = Math.round(128 + 100 * Math.sin(hue * 6.283));
      const g = Math.round(128 + 100 * Math.sin(hue * 6.283 + 2.094));
      const b = Math.round(128 + 100 * Math.sin(hue * 6.283 + 4.189));
      const shade = Math.max(0.2, Math.min(1, 1 - wy * 0.6));
      const line = gx || gy ? 255 : null;
      raw[o++] = line ?? Math.round(r * shade);
      raw[o++] = line ?? Math.round(g * shade);
      raw[o++] = line ?? Math.round(b * shade);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(ht, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
