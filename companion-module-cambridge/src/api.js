// Talks to a running cambridge server.
//
// State arrives over Server-Sent Events rather than polling. On a Stream Deck
// that difference is visible: a record button that goes red the moment the
// camera rolls reads as the camera responding, and one that goes red up to a
// second later reads as the button being unreliable.
//
// A poll loop runs alongside as a backstop, slowly. SSE is the fast path; the
// poll is what recovers state if a frame is ever missed.

const RECONNECT_MS = [1000, 2000, 4000, 8000, 15000];

export class CambridgeApi {
  /**
   * @param {object} opts
   * @param {string} opts.host          cambridge address
   * @param {number} opts.port
   * @param {(level: string, msg: string) => void} opts.log
   * @param {(view: object) => void} opts.onState     full state snapshot
   * @param {(up: boolean, detail?: string) => void} opts.onConnection
   * @param {typeof fetch} [opts.fetchImpl]           injected for tests
   */
  constructor({ host, port, log, onState, onConnection, fetchImpl = fetch }) {
    this.base = `http://${host}:${port}`;
    this.log = log;
    this.onState = onState;
    this.onConnection = onConnection;
    this.fetch = fetchImpl;
    this.stopped = false;
    this.attempt = 0;
    this.controller = null;
    this.retryTimer = null;
    this.pollTimer = null;
  }

  start() {
    this.stopped = false;
    this.#openStream();
    // Slow backstop. If SSE is healthy this only ever confirms what we know.
    this.pollTimer = setInterval(() => { this.#poll(); }, 10_000);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pollTimer);
    this.retryTimer = null;
    this.pollTimer = null;
    try { this.controller?.abort(); } catch { /* already gone */ }
    this.controller = null;
  }

  /** REST call. Never throws — a dead server must not take Companion down. */
  async request(method, path, body) {
    try {
      const res = await this.fetch(`${this.base}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      let parsed = null;
      try { parsed = await res.json(); } catch { /* empty body */ }
      if (!res.ok) {
        this.log('warn', `${method} ${path} -> ${res.status} ${parsed?.error ?? ''}`.trim());
      }
      return { ok: res.ok, status: res.status, body: parsed };
    } catch (err) {
      this.log('error', `${method} ${path} failed: ${err.message}`);
      return { ok: false, status: 0, body: { error: err.message } };
    }
  }

  async #poll() {
    if (this.stopped) return;
    const r = await this.request('GET', '/api/state');
    if (r.ok && r.body) this.onState(r.body);
  }

  async #openStream() {
    if (this.stopped) return;
    this.controller = new AbortController();
    try {
      const res = await this.fetch(`${this.base}/api/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: this.controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`events endpoint returned ${res.status}`);

      this.attempt = 0;
      this.onConnection(true);

      // SSE frames are separated by a blank line. Chunks split anywhere, so the
      // tail of a partial frame has to be carried into the next read.
      let buffer = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        if (this.stopped) break;
        buffer += decoder.decode(chunk, { stream: true });
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          this.#handleFrame(frame);
        }
      }
      throw new Error('event stream ended');
    } catch (err) {
      if (this.stopped) return;
      this.onConnection(false, err.message);
      const wait = RECONNECT_MS[Math.min(this.attempt, RECONNECT_MS.length - 1)];
      this.attempt += 1;
      this.log('debug', `event stream lost (${err.message}); retrying in ${wait}ms`);
      this.retryTimer = setTimeout(() => this.#openStream(), wait);
    }
  }

  #handleFrame(frame) {
    for (const line of frame.split('\n')) {
      // ':' prefixed lines are keepalive comments, not data.
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        const msg = JSON.parse(payload);
        if (msg.type === 'state' && msg.view) this.onState(msg.view);
      } catch {
        this.log('debug', 'ignored malformed event frame');
      }
    }
  }
}
