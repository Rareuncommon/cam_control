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
    /** group -> last vector actually sent, so a refresh that changes nothing sends nothing */
    this.sent = new Map();
    this.timer = null;
    this.moving = false;
  }

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

  /** Stops everything, now. Safe to call at any time, including when idle. */
  async stopAll(reason = 'stop') {
    this.held.clear();
    this.#disarm();
    for (const g of Object.keys(GROUPS)) this.sent.delete(g);
    this.#updateMoving();
    this.log('debug', `stop all (${reason})`);
    // Anything still waiting to be sent is now wrong.
    this.queue.supersede((j) => typeof j.key === 'string' && j.key.startsWith('move:'));
    return this.#withRetry(() => this.driver.stop(), 'move:all', 'stop', () => this.held.size === 0);
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
   * sending anything (there is nothing to send to), and let the lifecycle send
   * a stop when it reconnects.
   */
  forget() {
    this.held.clear();
    this.sent.clear();
    this.#disarm();
    this.#updateMoving();
  }

  #send(group, values) {
    const prev = this.sent.get(group);
    if (prev && GROUPS[group].every((a) => prev[a] === values[a])) return;
    this.sent.set(group, values);
    const call = group === 'panTilt'
      ? () => this.driver.panTilt(values.pan, values.tilt)
      : group === 'zoom' ? () => this.driver.zoom(values.zoom)
        : () => this.driver.focus(values.focus);
    const isStop = GROUPS[group].every((a) => values[a] === 0);
    if (isStop) {
      this.#withRetry(call, `move:${group}`, `${group} stop`, () => !this.held.has(group));
    } else {
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
   * Stops are retried. A lost move is a camera that does not start; a lost stop
   * is a camera that does not stop, and those are not the same size of problem.
   */
  async #withRetry(call, key, what, stillWanted) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Someone pushed the stick again while the last attempt was failing. A
      // retried stop now would cancel the move they just asked for.
      if (attempt > 1 && !stillWanted()) return { ok: true, superseded: true };
      try {
        const r = await this.queue.run(call, { priority: PRIORITY.MOTION, key });
        if (r?.superseded) return { ok: true, superseded: true };
        return { ok: true };
      } catch (err) {
        this.log(attempt === 3 ? 'error' : 'warn', `${what} attempt ${attempt} failed: ${err.message}`);
      }
    }
    return { ok: false, error: `${what} did not reach the camera` };
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

  #updateMoving() {
    const moving = this.held.size > 0;
    if (moving === this.moving) return;
    this.moving = moving;
    this.onMoving(moving);
  }
}
