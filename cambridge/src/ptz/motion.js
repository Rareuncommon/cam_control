// Pan, tilt, zoom and focus velocity, with a deadman.
//
// Every other control in CamBridge sets a value and is done. Motion is
// different: "pan left at half speed" stays true on the camera until something
// says stop. If the thing that was going to say stop goes away — the iPad's
// Wi-Fi drops, the browser tab is backgrounded, Companion restarts — the head
// keeps panning into the wall.
//
// So motion here is never fire-and-forget. A velocity is held only for as long
// as its source keeps refreshing it (`holdMs`), and the controller stops the
// axis itself when the refreshes stop. The browser refreshes every ~150 ms
// while a finger is down; a missed refresh window stops the camera within
// half a second, which is the correct failure.
//
// Sources that genuinely cannot refresh — a SKAARHOJ joystick held still sends
// nothing, a VISCA controller sends one drive and one stop — may latch instead,
// but only over a connection whose loss we can see, and `releaseSource` is
// called when it drops.

import { PRIORITY } from './queue.js';

export const GROUPS = Object.freeze({
  panTilt: ['pan', 'tilt'],
  zoom: ['zoom'],
  focus: ['focus'],
});

const clamp = (v) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
/** Tiny velocities are joystick noise, not intent. */
const deadzone = (v) => (Math.abs(v) < 0.02 ? 0 : v);

/** Retry spacing for a stop that has not reached the camera: quick at first, then steady. */
const STOP_RETRY_MS = [100, 250, 500, 1000, 2000];

export class MotionController {
  /**
   * @param {object} o
   * @param {object} o.driver     has panTilt(p,t), zoom(s), focus(s), stop()
   * @param {import('./queue.js').CommandQueue} o.queue
   * @param {number} [o.deadmanMs=500]
   * @param {(level: string, msg: string) => void} [o.log]
   * @param {(moving: boolean) => void} [o.onMoving]
   */
  constructor({ driver, queue, deadmanMs = 500, log = () => {}, onMoving = () => {} }) {
    this.driver = driver;
    this.queue = queue;
    this.deadmanMs = deadmanMs;
    this.log = log;
    this.onMoving = onMoving;
    /** group -> { values: {axis: v}, source, expires: number (Infinity when latched) } */
    this.held = new Map();
    /**
     * group -> last vector the camera *accepted*, so a refresh that changes
     * nothing sends nothing. A stop is recorded here only once it has been
     * delivered: until then, every further stop must go out, not be
     * suppressed as a duplicate of one that never arrived.
     */
    this.sent = new Map();
    /**
     * Stops sent but not yet confirmed, by queue key ('move:panTilt', … or
     * 'move:all'). While any is outstanding the head may still be moving, and
     * is reported as such.
     */
    this.unconfirmed = new Map();
    this.timer = null;
    this.moving = false;
  }

  /** A stop has gone out and not yet been confirmed. */
  stopPending() { return this.unconfirmed.size > 0; }

  /**
   * Sets velocity on one or more axes.
   *
   * @param {{pan?: number, tilt?: number, zoom?: number, focus?: number}} v  each -1..1
   * @param {{source?: string, holdMs?: number, latch?: boolean}} [o]
   */
  drive(v, { source = 'panel', holdMs, latch = false } = {}) {
    // The ceiling is for in-process callers with a reason (a VISCA controller
    // over UDP, which cannot be watched for disconnection). The HTTP route
    // clamps its own callers far lower.
    const hold = latch ? Infinity : Math.min(Math.max(holdMs ?? this.deadmanMs, 100), 60_000);
    const now = Date.now();
    for (const [group, axes] of Object.entries(GROUPS)) {
      if (!axes.some((a) => a in v)) continue;
      const prev = this.held.get(group);
      const values = {};
      for (const a of axes) {
        values[a] = deadzone(clamp(a in v ? v[a] : (prev?.values?.[a] ?? 0)));
      }
      const still = axes.every((a) => values[a] === 0);
      if (still) this.held.delete(group);
      else this.held.set(group, { values, source, expires: now + hold });
      this.#send(group, values);
    }
    this.#arm();
    this.#updateMoving();
  }

  /**
   * Stops everything, now. Safe to call at any time, including when idle.
   * Resolves once the camera has taken the stop, or after the first few
   * attempts have failed — in which case it keeps trying in the background
   * for as long as nothing new is held.
   */
  async stopAll(reason = 'stop') {
    this.held.clear();
    this.#disarm();
    this.log('debug', `stop all (${reason})`);
    // Anything still waiting to be sent is now wrong.
    this.queue.supersede((j) => typeof j.key === 'string' && j.key.startsWith('move:'));
    return this.#stop('move:all', () => this.driver.stop(), 'stop', null, () => this.held.size === 0);
  }

  /** A source's connection went away: stop whatever it was holding. */
  releaseSource(source) {
    for (const [group, h] of [...this.held]) {
      if (h.source !== source) continue;
      this.held.delete(group);
      this.#send(group, Object.fromEntries(GROUPS[group].map((a) => [a, 0])));
      this.log('info', `${group} stopped: ${source} went away`);
    }
    this.#updateMoving();
  }

  /**
   * The camera dropped. Its motion state is unknown; forget ours without
   * sending anything (there is nothing to send to). The caller reads
   * `moving`/`stopPending()` first, so the lifecycle knows to send a stop when
   * it reconnects.
   */
  forget() {
    this.held.clear();
    this.sent.clear();
    // Outstanding stop loops see their key gone and stand down.
    this.unconfirmed.clear();
    this.#disarm();
    this.#updateMoving();
  }

  #send(group, values) {
    const prev = this.sent.get(group);
    const isStop = GROUPS[group].every((a) => values[a] === 0);
    // A duplicate move is suppressed. A stop is suppressed only when the
    // camera has confirmed this very stop and nothing has moved it since.
    if (prev && GROUPS[group].every((a) => prev[a] === values[a])
        && !(isStop && this.unconfirmed.has(`move:${group}`))) return;
    const call = group === 'panTilt'
      ? () => this.driver.panTilt(values.pan, values.tilt)
      : group === 'zoom' ? () => this.driver.zoom(values.zoom)
        : () => this.driver.focus(values.focus);
    if (isStop) {
      this.sent.delete(group);
      this.#stop(`move:${group}`, call, `${group} stop`, group, () => !this.held.has(group));
    } else {
      this.sent.set(group, values);
      this.queue.run(call, { priority: PRIORITY.MOTION, key: `move:${group}` })
        .catch((err) => {
          // The move did not arrive. Forget what we think we sent, so the next
          // refresh tries again rather than being suppressed as a duplicate.
          this.sent.delete(group);
          this.log('warn', `${group} move failed: ${err.message}`);
        });
    }
  }

  /**
   * Sends a stop and keeps sending it until the camera takes it.
   *
   * A lost move is a camera that does not start; a lost stop is a camera that
   * does not stop, and those are not the same size of problem. So a stop is
   * never given up on while it is still wanted: three quick attempts decide
   * what the caller is told, and after that it carries on, at a steadier pace,
   * until it lands, someone moves that axis again, or the camera is dropped.
   */
  #stop(key, call, what, group, stillWanted) {
    const token = {};
    this.unconfirmed.set(key, token);
    this.#updateMoving();
    let settle;
    const first = new Promise((r) => { settle = r; });
    const owns = () => this.unconfirmed.get(key) === token;
    (async () => {
      for (let attempt = 1; ; attempt++) {
        // Someone pushed the stick again while the last attempt was failing,
        // or a newer stop of the same kind took over. A retried stop now would
        // cancel the move they just asked for.
        if (!owns()) { settle({ ok: true, superseded: true }); return; }
        if (attempt > 1 && !stillWanted()) {
          this.unconfirmed.delete(key);
          this.#updateMoving();
          settle({ ok: true, superseded: true });
          return;
        }
        try {
          const r = await this.queue.run(call, { priority: PRIORITY.MOTION, key });
          if (r?.superseded) {
            // Replaced in the queue: by a newer stop (which owns the key now)
            // or by a move (which means it is no longer wanted). Loop to find out.
            continue;
          }
          if (owns()) {
            this.unconfirmed.delete(key);
            if (group) this.sent.set(group, Object.fromEntries(GROUPS[group].map((a) => [a, 0])));
            this.#updateMoving();
          }
          settle({ ok: true });
          return;
        } catch (err) {
          this.log(attempt >= 3 ? 'error' : 'warn', `${what} attempt ${attempt} failed: ${err.message}`);
          if (attempt === 3) settle({ ok: false, error: `${what} did not reach the camera — still trying` });
          await new Promise((r) => setTimeout(r, STOP_RETRY_MS[Math.min(attempt - 1, STOP_RETRY_MS.length - 1)]));
        }
      }
    })();
    return first;
  }

  #arm() {
    if (this.timer || this.held.size === 0) return;
    if ([...this.held.values()].every((h) => h.expires === Infinity)) return;
    this.timer = setInterval(() => this.#check(), 50);
    this.timer.unref?.();
  }

  #disarm() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  #check() {
    const now = Date.now();
    for (const [group, h] of [...this.held]) {
      if (h.expires > now) continue;
      this.held.delete(group);
      this.log('info', `${group} stopped: no refresh from ${h.source} for ${this.deadmanMs}ms`);
      this.#send(group, Object.fromEntries(GROUPS[group].map((a) => [a, 0])));
    }
    if (this.held.size === 0 || [...this.held.values()].every((h) => h.expires === Infinity)) this.#disarm();
    this.#updateMoving();
  }

  /** Moving means "may be moving": held, or a stop not yet confirmed. */
  #updateMoving() {
    const moving = this.held.size > 0 || this.unconfirmed.size > 0;
    if (moving === this.moving) return;
    this.moving = moving;
    this.onMoving(moving);
  }
}
