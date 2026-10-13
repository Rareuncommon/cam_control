// One command at a time to a camera, most important first.
//
// PTZ heads are small embedded computers. Several of them document a minimum
// gap between commands, and all of them behave worse when a controller fires
// requests in parallel. So every command to a camera goes through one of these.
//
// Priority exists because a stop must never wait behind a settings poll. A
// joystick release that sits in a queue behind twenty "what is the knee point"
// queries is a camera still panning across the set.
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
    this.running = false;
    this.lastStart = 0;
    this.seq = 0;
    this.closed = false;
    this.timer = null;
  }

  get size() { return this.pending.length; }

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

  /** Drops pending jobs of a priority — polls, typically, when a camera drops. */
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

  #pump() {
    if (this.running || this.timer || this.pending.length === 0 || this.closed) return;
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) {
      this.timer = setTimeout(() => { this.timer = null; this.#pump(); }, wait);
      return;
    }
    const job = this.pending.shift();
    this.running = true;
    this.lastStart = Date.now();

    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      clearTimeout(guard);
      this.running = false;
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
  }
}
