// One PTZ camera's connection: identify, poll, heartbeat, reconnect.
//
// This is the policy half of a PTZ camera; the driver is the protocol half.
// Everything here is the same for every vendor, which is the point — four
// cameras with four web UIs become one behaviour.
//
// Three rules carried over from the Sony side, each learnt the hard way there:
//
// - **Errors are information, not health.** A camera that refuses "set knee
//   point" in its current mode is still a camera. Only a missed heartbeat makes
//   it offline.
// - **One dead camera never stalls another.** Each has its own queue, timers
//   and backoff; nothing here is shared.
// - **The camera is the source of truth.** A SKAARHOJ panel running Reactor, or
//   the vendor's own web page, changes values behind CamBridge's back. So
//   everything is polled, everything is re-read after a write, and nothing is
//   assumed from what we last sent.

import { EventEmitter } from 'node:events';
import { CommandQueue, PRIORITY } from './queue.js';
import { MotionController } from './motion.js';
import { coerce, publicSchema } from './schema.js';
import { DriverError } from './driver.js';
import { request } from './http.js';

export const DEFAULTS = Object.freeze({
  heartbeatIntervalMs: 2000,
  heartbeatTimeoutMs: 6000,
  reconnectBackoffMs: [1000, 2000, 4000, 8000, 15000],
  reconnectBackoffMaxMs: 15000,
  /** Position while someone is watching or the head is moving. */
  positionFastMs: 250,
  /** Position otherwise — still often enough to notice a panel move. */
  positionIdleMs: 2000,
  statusMs: 1000,
  /** One batch of settings every this often; a full sweep takes (entries / batch) × this. */
  settingsMs: 400,
  /** Settings marked poll:'fast' (modes that flip under an operator's feet). */
  fastSettingsMs: 2000,
  deadmanMs: 500,
  commandTimeoutMs: 3000,
  /** Snapshots shared between viewers for this long. */
  snapshotCacheMs: 120,
});

const describe = (err) => (err instanceof Error ? err.message : String(err));

/** How a failed driver call maps onto the HTTP-ish shape the server already speaks. */
function failure(err) {
  const kind = err?.kind ?? 'network';
  const status = kind === 'refused' ? 409
    : kind === 'unsupported' ? 501
      : kind === 'auth' ? 401
        : kind === 'timeout' ? 504 : 502;
  return { ok: false, status, body: { error: describe(err) } };
}

export class PtzCamera extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.entry     the camera's config entry: { id, label, vendor, ip, port?, auth, options? }
   * @param {typeof import('./driver.js').PtzDriver} o.Driver
   * @param {object} [o.tuning]  overrides for DEFAULTS
   * @param {(level: string, msg: string) => void} [o.log]
   * @param {Function} [o.http]  injected for tests; defaults to http.js request
   */
  constructor({ entry, Driver, tuning = {}, log = () => {}, http = request }) {
    super();
    this.entry = entry;
    this.id = entry.id;
    this.Driver = Driver;
    this.t = { ...DEFAULTS, ...tuning };
    this.log = (level, msg) => log(level, `${this.id}: ${msg}`);
    this.http = http;

    // Connecting from the outset: start() follows construction at once, and a
    // camera reported offline for the instant before its first attempt raises
    // an alarm per camera at every start-up — forty-eight of them at a big venue.
    this.state = 'connecting';
    this.detail = null;
    this.reconnectAttempts = 0;
    this.identity = null;
    this.entries = [];
    this.byId = new Map();
    this.caps = null;
    /** Entries the camera refused to answer — not offered, not polled. */
    this.unavailable = new Set();
    /** Last value seen per entry, for change detection. */
    this.values = new Map();
    this.ptz = { pan: null, tilt: null, zoom: null, focus: null, moving: false, tracking: null, preset: null };
    /** Someone has the Operate card open until this time. */
    this.watchUntil = 0;

    this.queue = null;
    this.driver = null;
    this.motion = null;
    this.timers = [];
    this.reconnectTimer = null;
    this.stopped = true;
    this.lastOk = 0;
    this.cursor = 0;
    this.due = {};
    this.inflight = new Set();
    this.snap = null;
    this.movingAtDrop = false;
  }

  // --- lifecycle -------------------------------------------------------------

  start() {
    this.stopped = false;
    this.#reconnectNow();
  }

  /**
   * Try again now, rather than at the end of the backoff. For the operator who
   * has just plugged the camera back in and does not want to wait 15 s.
   */
  reconnect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.state === 'connected') return;
    this.reconnectAttempts = 0;
    this.#reconnectNow();
  }

  /** #connect never rejects by design; this makes sure a bug in it is a log line, not a crash. */
  #reconnectNow() {
    this.#connect().catch((err) => {
      this.log('error', `connect failed unexpectedly: ${describe(err)}`);
      this.#scheduleReconnect();
    });
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    // Leaving a head moving because CamBridge quit is the one way to make
    // stopping worse than not stopping.
    if (this.motion?.moving && this.state === 'connected') {
      await Promise.race([this.motion.stopAll('CamBridge stopping'), new Promise((r) => setTimeout(r, 1000))]);
    }
    this.#teardown();
    // Quietly: a camera is stopped because CamBridge is shutting down or the
    // camera is being removed, and in neither case is "offline" news. The
    // source drops removed cameras from the state model itself.
    this.state = 'offline';
    this.detail = 'stopped';
  }

  #teardown() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.motion?.forget();
    this.queue?.close();
    try { this.driver?.close(); } catch { /* already closed */ }
    this.inflight.clear();
  }

  #setState(state, detail = null) {
    const changed = state !== this.state || detail !== this.detail;
    this.state = state;
    this.detail = detail;
    if (changed) {
      this.emit('state', {
        cameraId: this.id,
        state,
        detail,
        reconnectAttempts: this.reconnectAttempts,
        model: this.identity?.model,
        ip: this.entry.ip,
      });
    }
  }

  async #connect() {
    if (this.stopped) return;
    this.#teardown();
    this.queue = new CommandQueue({
      minIntervalMs: this.Driver.minIntervalMs ?? 0,
      jobTimeoutMs: this.t.commandTimeoutMs * 3,
    });
    this.driver = new this.Driver({
      host: this.entry.ip,
      port: this.entry.port,
      auth: this.entry.auth ?? {},
      http: this.http,
      log: this.log,
      timeoutMs: this.t.commandTimeoutMs,
      options: this.entry.options ?? {},
    });
    this.motion = new MotionController({
      driver: this.driver,
      queue: this.queue,
      deadmanMs: this.t.deadmanMs,
      log: this.log,
      onMoving: (moving) => this.#ptzStatus({ moving }),
    });

    this.#setState(this.reconnectAttempts ? 'reconnecting' : 'connecting');
    let identity;
    try {
      identity = await this.queue.run(() => this.driver.identify(), { priority: PRIORITY.WRITE });
    } catch (err) {
      if (err?.kind === 'auth') {
        this.#setState('unauthorized', 'the camera refused the username or password');
      } else {
        this.#setState(this.reconnectAttempts ? 'reconnecting' : 'offline', describe(err));
      }
      this.#scheduleReconnect();
      return;
    }
    if (this.stopped) return;

    this.identity = identity;
    this.entries = this.driver.schema(identity) ?? [];
    this.byId = new Map(this.entries.map((e) => [e.id, e]));
    this.caps = this.driver.capabilities(identity);
    this.unavailable.clear();
    this.values.clear();
    this.lastOk = Date.now();

    // Stop only if *we* were moving the head when the link went. A stop sent
    // on every reconnect would cut across a move someone is making from
    // Reactor or the camera's own page at that moment.
    if (this.movingAtDrop) {
      this.movingAtDrop = false;
      this.motion.stopAll('reconnected while a move was held').catch(() => {});
    }

    this.reconnectAttempts = 0;
    this.#setState('connected');
    this.emit('schema', { cameraId: this.id });
    this.log('info', `connected: ${identity.vendor} ${identity.model}${identity.firmware ? ` fw ${identity.firmware}` : ''}`);

    // Push, where the protocol has it. Polling carries on regardless: push
    // makes a change from Reactor show up at once, polling makes sure a
    // dropped event stream never leaves the panel quietly wrong.
    if (typeof this.driver.subscribe === 'function') {
      try {
        this.driver.subscribe({
          onValues: (got) => { this.lastOk = Date.now(); this.#absorb(got); },
          onPtz: (p) => this.#ptzStatus(p),
        });
      } catch (err) {
        this.log('warn', `change notifications unavailable: ${describe(err)}`);
      }
    }

    // Everything once, up front, so the panel is complete within a few seconds
    // rather than filling in over a full sweep. A camera that drops in the
    // middle of it is a lost connection like any other — and the heartbeat
    // that would normally notice is not running yet.
    try {
      await this.#readEntries(this.entries.filter((e) => e.type !== 'action' && e.poll !== 'never'), PRIORITY.POLL);
    } catch (err) {
      if (this.stopped) return;
      this.#drop(`lost during the first read: ${describe(err)}`);
      return;
    }
    this.#poll('position');
    this.#poll('status');
    if (this.stopped || this.state !== 'connected') return;
    this.due = { heartbeat: 0, position: 0, status: 0, settings: 0, fast: 0 };
    this.timers.push(setInterval(() => this.#tick(), 50));
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const list = this.t.reconnectBackoffMs;
    const delay = Math.min(list[Math.min(this.reconnectAttempts, list.length - 1)], this.t.reconnectBackoffMaxMs);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#reconnectNow();
    }, delay);
  }

  #drop(reason) {
    if (this.state !== 'connected') return;
    this.log('warn', `connection lost (${reason})`);
    this.movingAtDrop = !!this.motion?.moving;
    this.#teardown();
    this.reconnectAttempts = 1;
    this.#setState('reconnecting', reason);
    this.#ptzStatus({ moving: false });
    this.#scheduleReconnect();
  }

  // --- scheduling ------------------------------------------------------------

  #tick() {
    if (this.state !== 'connected') return;
    const now = Date.now();
    if (now - this.lastOk > this.t.heartbeatTimeoutMs) {
      this.#drop(`no answer for ${Math.round((now - this.lastOk) / 1000)}s`);
      return;
    }
    const fast = now < this.watchUntil || this.motion?.moving;
    const plan = [
      ['position', fast ? this.t.positionFastMs : this.t.positionIdleMs],
      ['status', this.t.statusMs],
      ['fast', this.t.fastSettingsMs],
      ['settings', this.t.settingsMs],
      // Polls succeeding are proof of life; the heartbeat only has to run when
      // nothing else has.
      ['heartbeat', this.t.heartbeatIntervalMs],
    ];
    for (const [what, every] of plan) {
      if (now < (this.due[what] ?? 0)) continue;
      if (what === 'heartbeat' && now - this.lastOk < this.t.heartbeatIntervalMs) {
        this.due.heartbeat = this.lastOk + this.t.heartbeatIntervalMs;
        continue;
      }
      this.due[what] = now + every;
      this.#poll(what);
    }
  }

  /** One poll of a kind, never two of the same kind in flight. */
  #poll(what) {
    if (this.inflight.has(what) || !this.queue) return;
    this.inflight.add(what);
    const run = async () => {
      switch (what) {
        case 'heartbeat':
          await this.queue.run(() => this.driver.heartbeat(), { priority: PRIORITY.POLL });
          this.lastOk = Date.now();
          return;
        case 'position': {
          if (!this.caps?.panTilt && !this.caps?.zoom) return;
          const p = await this.queue.run(() => this.driver.position(), { priority: PRIORITY.POLL });
          this.lastOk = Date.now();
          if (p && !p.superseded) this.#ptzStatus(p);
          return;
        }
        case 'status': {
          const s = await this.queue.run(() => this.driver.status(), { priority: PRIORITY.POLL });
          this.lastOk = Date.now();
          if (s && !s.superseded) this.#ptzStatus(s);
          // Capabilities can change under a running connection — a Sony whose
          // VISCA stops answering loses focus velocity — so they are re-asked
          // here rather than fixed at connect.
          const caps = this.driver.capabilities(this.identity);
          if (JSON.stringify(caps) !== JSON.stringify(this.caps)) {
            this.caps = caps;
            this.emit('schema', { cameraId: this.id });
          }
          return;
        }
        case 'fast': {
          const list = this.entries.filter((e) => e.poll === 'fast' && !this.unavailable.has(e.id));
          if (list.length) await this.#readEntries(list, PRIORITY.POLL);
          return;
        }
        case 'settings': {
          const list = this.entries.filter((e) => e.type !== 'action' && !this.unavailable.has(e.id)
            && (e.poll ?? 'slow') === 'slow');
          if (!list.length) return;
          const n = Math.max(1, this.Driver.readBatch ?? 4);
          if (this.cursor >= list.length) this.cursor = 0;
          const batch = list.slice(this.cursor, this.cursor + n);
          this.cursor += n;
          await this.#readEntries(batch, PRIORITY.POLL);
          return;
        }
        default:
      }
    };
    run()
      .catch((err) => {
        // A failed poll is logged at debug: the heartbeat decides health, and a
        // camera that refuses one query a second would otherwise fill the log.
        this.log('debug', `${what} poll failed: ${describe(err)}`);
      })
      .finally(() => this.inflight.delete(what));
  }

  async #readEntries(list, priority) {
    const n = Math.max(1, this.Driver.readBatch ?? 4);
    for (let i = 0; i < list.length; i += n) {
      if (this.state !== 'connected' && this.state !== 'connecting' && this.state !== 'reconnecting') return;
      const batch = list.slice(i, i + n);
      let got;
      try {
        got = await this.queue.run(() => this.driver.read(batch), { priority });
      } catch (err) {
        if (err?.kind === 'refused' || err?.kind === 'unsupported') {
          // The whole batch was refused. Find out which entry by asking one at
          // a time next sweep, rather than writing off four settings for one.
          if (batch.length === 1) this.#markUnavailable(batch[0], describe(err));
          else for (const e of batch) await this.#readEntries([e], priority);
          continue;
        }
        throw err;
      }
      if (!got || got.superseded) continue;
      this.lastOk = Date.now();
      this.#absorb(got);
    }
  }

  #markUnavailable(entry, why) {
    if (this.unavailable.has(entry.id)) return;
    this.unavailable.add(entry.id);
    this.log('debug', `${entry.id} not offered by this camera (${why})`);
    this.emit('schema', { cameraId: this.id });
  }

  /** Folds a read result into the mirror and announces what changed. */
  #absorb(got) {
    const changed = {};
    for (const [id, r] of Object.entries(got)) {
      const entry = this.byId.get(id);
      if (!entry) continue;   // a driver answering more than asked, for an entry this model lacks
      if (r?.error) {
        if (r.unsupported) this.#markUnavailable(entry, r.error);
        continue;
      }
      const prop = {
        value: r.value,
        writable: r.writable ?? !entry.readOnly,
        ...(r.allowed ? { allowed: r.allowed } : {}),
        ...(r.range ? { range: r.range } : {}),
      };
      const prev = this.values.get(id);
      if (prev && prev.value === prop.value && prev.writable === prop.writable
          && JSON.stringify(prev.allowed) === JSON.stringify(prop.allowed)) continue;
      this.values.set(id, prop);
      changed[id] = prop;
    }
    if (Object.keys(changed).length) this.emit('values', { cameraId: this.id, values: changed });
  }

  #ptzStatus(patch) {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || k === 'superseded') continue;
      const rounded = typeof v === 'number' ? Math.round(v * 10000) / 10000 : v;
      if (this.ptz[k] !== rounded) { this.ptz[k] = rounded; changed = true; }
    }
    if (changed) this.emit('ptz', { cameraId: this.id, ptz: { ...this.ptz } });
  }

  // --- what the server asks for ----------------------------------------------

  /** The table as the browser sees it, with what this camera turned out to lack marked. */
  schema() {
    return {
      cameraId: this.id,
      vendor: this.identity?.vendor ?? this.entry.vendor,
      model: this.identity?.model ?? this.entry.model ?? '',
      firmware: this.identity?.firmware ?? null,
      capabilities: this.caps,
      entries: publicSchema(this.entries).map((e) => (this.unavailable.has(e.id) ? { ...e, available: false } : e)),
    };
  }

  properties() {
    return Object.fromEntries(this.values);
  }

  /**
   * Someone is looking at this camera's Operate card: poll position fast for a
   * while. A lease rather than a counter, because a browser tab that is closed
   * never says goodbye — a counter would stay raised for ever.
   */
  watch(ms = 5000) {
    const was = Date.now() < this.watchUntil;
    this.watchUntil = Date.now() + Math.min(Math.max(ms, 0), 30_000);
    if (!was) this.due.position = 0;
  }

  #ready() {
    if (this.state !== 'connected') {
      return { ok: false, status: 503, body: { error: `${this.entry.label ?? this.id} is ${this.state}` } };
    }
    return null;
  }

  async write(id, value) {
    const notReady = this.#ready();
    if (notReady) return notReady;
    const entry = this.byId.get(id);
    if (!entry || this.unavailable.has(id)) {
      return { ok: false, status: 404, body: { error: `this camera has no setting "${id}"` } };
    }
    const c = coerce(entry, value);
    if (!c.ok) return { ok: false, status: 400, body: { error: c.error } };
    let r;
    try {
      r = await this.queue.run(() => this.driver.write(entry, c.value), { priority: PRIORITY.WRITE });
    } catch (err) {
      return failure(err);
    }
    this.lastOk = Date.now();
    const applied = r?.applied ?? c.value;
    // Re-read what we wrote and anything it moves, from the camera. What we
    // sent is a request; what it reports is the answer.
    const reread = [entry, ...(entry.affects ?? []).map((a) => this.byId.get(a)).filter(Boolean)]
      .filter((e) => e.type !== 'action' && !e.writeOnly);
    this.#readEntries(reread, PRIORITY.WRITE).catch(() => {});
    return { ok: true, status: 200, body: { applied } };
  }

  async action(id, payload) {
    const notReady = this.#ready();
    if (notReady) return notReady;
    const entry = this.byId.get(id);
    if (!entry || entry.type !== 'action' || this.unavailable.has(id)) {
      return { ok: false, status: 404, body: { error: `this camera has no action "${id}"` } };
    }
    try {
      const r = await this.queue.run(() => this.driver.action(entry, payload), { priority: PRIORITY.WRITE });
      this.lastOk = Date.now();
      const reread = (entry.affects ?? []).map((a) => this.byId.get(a)).filter(Boolean);
      if (reread.length) this.#readEntries(reread, PRIORITY.WRITE).catch(() => {});
      return { ok: true, status: 200, body: r ?? {} };
    } catch (err) {
      return failure(err);
    }
  }

  /**
   * Velocity. Returns immediately: a joystick cannot wait for the camera to
   * acknowledge each update, and the deadman — not this reply — is what keeps
   * it safe.
   */
  move(v, o) {
    const notReady = this.#ready();
    if (notReady) return notReady;
    this.motion.drive(v, o);
    return { ok: true, status: 200, body: { moving: this.motion.moving } };
  }

  async stopMotion(reason = 'stop') {
    if (!this.motion || this.state !== 'connected') return { ok: true, status: 200, body: {} };
    const r = await this.motion.stopAll(reason);
    return r.ok ? { ok: true, status: 200, body: {} } : { ok: false, status: 502, body: { error: r.error } };
  }

  releaseSource(source) { this.motion?.releaseSource(source); }

  async preset(op, n, o = {}) {
    const notReady = this.#ready();
    if (notReady) return notReady;
    const max = this.caps?.presets ?? 0;
    const base = this.caps?.presetBase ?? 1;
    // `presets` from `presetBase` is the range the panel offers. A camera may
    // accept more above it (presetMax) with numbers reserved for its own
    // functions in between — PTZOptics' 150 turns tracking on — which are
    // refused here with the driver's own reason, before anything is sent.
    const top = this.caps?.presetMax ?? base + max - 1;
    if (!Number.isInteger(n) || n < base || n > top) {
      return { ok: false, status: 400, body: { error: `preset numbers on this camera run ${base}–${top}` } };
    }
    // A reserved number with a reason is refused here; a bare number is left
    // to the driver, which refuses it before sending and says why.
    const reserved = this.caps?.reservedPresets?.find?.((r) => typeof r === 'object' && r.n === n);
    if (reserved) {
      return { ok: false, status: 400, body: { error: reserved.reason ?? `preset ${n} is reserved on this camera` } };
    }
    const fn = { recall: () => this.driver.presetRecall(n, o), store: () => this.driver.presetStore(n),
      delete: () => this.driver.presetDelete(n) }[op];
    if (!fn) return { ok: false, status: 400, body: { error: `unknown preset operation ${op}` } };
    try {
      // A recall replaces any held motion; a stick still held would fight it.
      if (op === 'recall') this.motion.forget();
      await this.queue.run(fn, { priority: PRIORITY.WRITE });
      this.lastOk = Date.now();
      if (op === 'recall') { this.#ptzStatus({ preset: n }); this.due.position = 0; }
      return { ok: true, status: 200, body: { preset: n } };
    } catch (err) {
      return failure(err);
    }
  }

  async pointToCentre(point) {
    const notReady = this.#ready();
    if (notReady) return notReady;
    if (!this.caps?.pointToCentre) {
      return { ok: false, status: 501, body: { error: 'this camera cannot aim at a point in the picture' } };
    }
    try {
      await this.queue.run(() => this.driver.pointToCentre(point), { priority: PRIORITY.WRITE });
      this.due.position = 0;
      return { ok: true, status: 200, body: {} };
    } catch (err) {
      return failure(err);
    }
  }

  async setTally(t) {
    if (this.state !== 'connected' || !this.caps?.tally) return;
    try {
      await this.queue.run(() => this.driver.setTally(t), { priority: PRIORITY.WRITE, key: 'tally' });
    } catch (err) {
      this.log('debug', `tally not set: ${describe(err)}`);
    }
  }

  /**
   * One frame. Not queued behind commands — snapshots come from the camera's
   * picture path, not its control path — but one at a time, and shared between
   * every viewer asking within the same instant.
   */
  async snapshot() {
    if (this.state !== 'connected') {
      return { ok: false, status: 503, body: { error: `${this.entry.label ?? this.id} is ${this.state}` } };
    }
    const now = Date.now();
    if (this.snap?.frame && now - this.snap.at < this.t.snapshotCacheMs) return this.snap.frame;
    if (this.snap?.pending) return this.snap.pending;
    const pending = this.driver.snapshot()
      .then((f) => ({ ok: true, status: 200, contentType: f.contentType, body: f.body }))
      .catch((err) => failure(err))
      .then((frame) => {
        this.snap = { at: Date.now(), frame, pending: null };
        return frame;
      });
    this.snap = { ...(this.snap ?? {}), pending };
    return pending;
  }
}

export { DriverError };
