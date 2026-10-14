// Every PTZ camera, as one source of events — the PTZ counterpart of CamdClient.
//
// camd speaks for the Sony bodies; this speaks for the PTZ heads. The server
// subscribes to both the same way and routes each command to whichever owns
// the camera, so presets, undo, alarms, Companion and the SSE push work for a
// PTZ camera without knowing it is one.
//
// The replies keep camd's `{ ok, status, body }` shape for the same reason.

import { EventEmitter } from 'node:events';
import { PtzCamera } from './lifecycle.js';
import { DRIVERS } from './drivers/index.js';
import { request, forgetHost } from './http.js';

export { isPtzEntry } from '../venue.js';

export class PtzSource extends EventEmitter {
  /**
   * @param {object} o
   * @param {object[]} o.cameras   PTZ entries from the config
   * @param {object} [o.tuning]    lifecycle overrides (config `ptz` block)
   * @param {(level: string, msg: string) => void} [o.log]
   * @param {Map} [o.drivers]
   * @param {Function} [o.http]
   */
  constructor({ cameras = [], tuning = {}, log = () => {}, drivers = DRIVERS, http = request } = {}) {
    super();
    this.tuning = tuning;
    this.log = log;
    this.drivers = drivers;
    this.http = http;
    /** @type {Map<string, {entry: object, cam: PtzCamera | null}>} */
    this.cameras = new Map();
    this.started = false;
    for (const e of cameras) this.#create(e);
  }

  #create(entry) {
    const Driver = this.drivers.get(String(entry.vendor ?? '').toLowerCase()) ?? null;
    let cam = null;
    if (Driver) {
      cam = new PtzCamera({ entry, Driver, tuning: this.tuning, log: this.log, http: this.http });
      cam.on('state', (ev) => this.emit('event', { event: 'connectionState', ...ev }));
      cam.on('values', (ev) => this.emit('event', { event: 'ptzValues', ...ev }));
      cam.on('ptz', (ev) => this.emit('event', { event: 'ptzStatus', ...ev }));
      cam.on('schema', (ev) => this.emit('event', { event: 'ptzSchema', ...ev }));
    } else {
      this.log('error', `${entry.id}: no driver for vendor "${entry.vendor}"`);
    }
    this.cameras.set(entry.id, { entry, cam });
    return cam;
  }

  start() {
    this.started = true;
    for (const { cam } of this.cameras.values()) cam?.start();
  }

  async stop() {
    this.started = false;
    await Promise.all([...this.cameras.values()].map(({ cam }) => cam?.stop()));
  }

  has(id) { return this.cameras.has(id); }
  camera(id) { return this.cameras.get(id)?.cam ?? null; }
  ids() { return [...this.cameras.keys()]; }

  /** Snapshots in the shape StateModel.replaceAll takes. */
  snapshots() {
    return [...this.cameras.values()].map(({ entry, cam }) => ({
      id: entry.id,
      label: entry.label || entry.id,
      model: cam?.identity?.model ?? entry.model ?? '',
      vendor: entry.vendor,
      ip: entry.ip,
      mac: entry.mac ?? '',
      state: cam ? cam.state : 'offline',
      detail: cam ? cam.detail : `CamBridge has no driver for "${entry.vendor}" cameras`,
      reconnectAttempts: cam?.reconnectAttempts ?? 0,
    }));
  }

  /** Adds a camera at runtime — after Setup's add-by-IP. */
  add(entry) {
    if (this.cameras.has(entry.id)) throw new Error(`camera "${entry.id}" already exists`);
    const cam = this.#create(entry);
    if (this.started) cam?.start();
    this.emit('event', { event: 'ptzHello' });
  }

  async remove(id) {
    const rec = this.cameras.get(id);
    if (!rec) return false;
    await rec.cam?.stop();
    // Cached challenges and sockets for the old address go too: a removed or
    // re-addressed camera's credentials should not outlive its entry.
    forgetHost(rec.entry.ip, rec.entry.port ?? 80);
    this.cameras.delete(id);
    this.emit('event', { event: 'ptzHello' });
    return true;
  }

  /** Replace a camera's entry (new IP, new credentials): reconnect it in place. */
  async update(id, entry) {
    await this.remove(id);
    this.add(entry);
  }

  #missing(id) {
    return { ok: false, status: 404, body: { error: `no PTZ camera "${id}"` } };
  }

  async getProperties(id) {
    const cam = this.camera(id);
    if (!cam) return this.#missing(id);
    return { ok: true, status: 200, body: { properties: cam.properties() } };
  }

  setProperty(id, prop, value) {
    const cam = this.camera(id);
    return cam ? cam.write(prop, value) : this.#missing(id);
  }

  action(id, name, payload) {
    const cam = this.camera(id);
    return cam ? cam.action(name, payload) : this.#missing(id);
  }

  schema(id) {
    const cam = this.camera(id);
    return cam ? { ok: true, status: 200, body: cam.schema() } : this.#missing(id);
  }

  move(id, v, o) {
    const cam = this.camera(id);
    return cam ? cam.move(v, o) : this.#missing(id);
  }

  stopMotion(id, reason) {
    const cam = this.camera(id);
    return cam ? cam.stopMotion(reason) : this.#missing(id);
  }

  /** Stops every PTZ camera. The panic button. */
  /**
   * Stops every PTZ camera and says, per camera, whether the stop was
   * confirmed. A panic button that answers "OK" while a head whose link has
   * dropped is still moving is worse than one that names it.
   * @returns {Promise<Array<{cameraId: string, label: string, ok: boolean, error?: string}>>}
   */
  async stopAll(reason = 'stop all') {
    return Promise.all([...this.cameras.values()].map(async ({ entry, cam }) => {
      const r = cam ? await cam.stopMotion(reason) : { ok: false, body: { error: 'no driver' } };
      return { cameraId: entry.id, label: entry.label || entry.id, ok: !!r.ok, ...(r.ok ? {} : { error: r.body?.error }) };
    }));
  }

  preset(id, op, n, o) {
    const cam = this.camera(id);
    return cam ? cam.preset(op, n, o) : this.#missing(id);
  }

  pointToCentre(id, point) {
    const cam = this.camera(id);
    return cam ? cam.pointToCentre(point) : this.#missing(id);
  }

  snapshot(id) {
    const cam = this.camera(id);
    return cam ? cam.snapshot() : this.#missing(id);
  }

  reconnect(id) {
    const cam = this.camera(id);
    if (!cam) return this.#missing(id);
    cam.reconnect();
    return { ok: true, status: 200, body: { state: cam.state } };
  }

  watch(id, ms) { this.camera(id)?.watch(ms); }

  /** A control surface disconnected: stop whatever it held, on every camera. */
  releaseSource(source) {
    for (const { cam } of this.cameras.values()) cam?.releaseSource(source);
  }

  setTally(id, t) { return this.camera(id)?.setTally(t); }
}
