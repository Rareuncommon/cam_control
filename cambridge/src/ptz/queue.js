// One command at a time to a camera, most important first — and a stop never
// waits behind a read.
//
// PTZ heads are small embedded computers. Several of them document a minimum
// gap between commands, and all of them behave worse when a controller fires
// requests in parallel. So every command to a camera goes through one of these.
//
// Motion has a lane of its own. Priority alone only reorders what is waiting;
// it does nothing about a settings read already running, and a read on a slow
// head can be several requests and several seconds. A stop that waits for it
// is a camera still panning across the set — an independent review measured
// six seconds. So a motion job starts as soon as no other motion job is
// running, even while a read is in flight, and reads are asked to yield
// between their requests (`motionWaiting`). Motion jobs still run one at a
// time, in order, and still keep the camera's minimum gap.
//
// Keyed jobs replace each other: when a joystick produces ten velocity updates
// while the camera is still answering the first, only the newest is worth
// sending. The superseded ones resolve as `{ superseded: true }` rather than
// rejecting, because nothing went wrong — something better came along.

export const PRIORITY = Object.freeze({ MOTION: 0, WRITE: 1, POLL: 2 });

export class CommandQueue {
  /**
   * @param {object} [o]
   * @param {number} [o.minIntervalMs=0]  gap between the starts of consecutive commands
   * @param {number} [o.jobTimeoutMs=10000] a job that never settles is abandoned after this
   */
  constructor({ minIntervalMs = 0, jobTimeoutMs = 10_000 } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.jobTimeoutMs = jobTimeoutMs;
    /** @type {Array<{fn: Function, priority: number, key?: string, resolve: Function, reject: Function, seq: number}>} */
    this.pending = [];
    /** A non-motion job is running. */
    this.running = false;
    /** A motion job is running. */
    this.motionRunning = false;
    this.lastStart = 0;
    this.seq = 0;
    this.closed = false;
    this.timer = null;
  }

  get size() { return this.pending.length; }

  /** True while a motion job waits or runs: a read should yield at its next request. */
  get motionWaiting() {
    return this.motionRunning || this.pending.some((j) => j.priority === PRIORITY.MOTION);
  }

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @param {{priority?: number, key?: string}} [o]
   * @returns {Promise<T | {superseded: true}>}
   */
  run(fn, { priority = PRIORITY.POLL, key } = {}) {
    if (this.closed) return Promise.reject(new Error('camera connection closed'));
    return new Promise((resolve, reject) => {
      if (key !== undefined) {
        const i = this.pending.findIndex((j) => j.key === key);
        if (i >= 0) {
          const old = this.pending[i];
          this.pending.splice(i, 1);
          old.resolve({ superseded: true });
        }
      }
      this.pending.push({ fn, priority, key, resolve, reject, seq: this.seq++ });
      // Stable by priority, then arrival.
      this.pending.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.#pump();
    });
  }

  /** Drops pending jobs matching a predicate — polls, typically, when a camera drops. */
  drop(predicate, reason = 'dropped') {
    const keep = [];
    for (const j of this.pending) {
      if (predicate(j)) j.reject(new Error(reason));
      else keep.push(j);
    }
    this.pending = keep;
  }

  /** Resolves pending jobs as superseded — a stop overtaking queued moves. */
  supersede(predicate) {
    const keep = [];
    for (const j of this.pending) {
      if (predicate(j)) j.resolve({ superseded: true });
      else keep.push(j);
    }
    this.pending = keep;
  }

  close(reason = 'camera connection closed') {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const j of this.pending) j.reject(new Error(reason));
    this.pending = [];
  }

  reopen() { this.closed = false; }

  /** The next job that may start now, given what is running. */
  #next() {
    // Motion: whenever no other motion job runs, read or no read.
    if (!this.motionRunning) {
      const i = this.pending.findIndex((j) => j.priority === PRIORITY.MOTION);
      if (i >= 0) return i;
    }
    // Everything else: only when nothing at all is running.
    if (!this.running && !this.motionRunning && this.pending.length) return 0;
    return -1;
  }

  #pump() {
    if (this.timer || this.closed) return;
    const i = this.#next();
    if (i < 0) return;
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) {
      this.timer = setTimeout(() => { this.timer = null; this.#pump(); }, wait);
      return;
    }
    const [job] = this.pending.splice(i, 1);
    const motion = job.priority === PRIORITY.MOTION;
    if (motion) this.motionRunning = true; else this.running = true;
    this.lastStart = Date.now();

    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      clearTimeout(guard);
      if (motion) this.motionRunning = false; else this.running = false;
      queueMicrotask(() => this.#pump());
      return true;
    };
    // A driver promise that never settles must not freeze the camera forever.
    const guard = setTimeout(() => {
      if (finish()) job.reject(new Error(`command did not complete within ${this.jobTimeoutMs}ms`));
    }, this.jobTimeoutMs);

    let result;
    try {
      result = Promise.resolve(job.fn());
    } catch (err) {
      result = Promise.reject(err);
    }
    result.then(
      (v) => { if (finish()) job.resolve(v); },
      (e) => { if (finish()) job.reject(e); },
    );
    // A motion job started alongside a read may leave room for the next.
    queueMicrotask(() => this.#pump());
  }
}
