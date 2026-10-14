// Talks to a running cambridge server.
//
// State arrives over Server-Sent Events rather than polling. On a Stream Deck
// that difference is visible: a record button that goes red the moment the
// camera rolls reads as the camera responding, and one that goes red up to a
// second later reads as the button being unreliable.
//
// A poll loop runs alongside as a backstop, slowly. SSE is the fast path; the
// poll is what recovers state if a frame is ever missed.

import { applyPatch } from './patch.js';

export const AUTH_MESSAGE = 'CamBridge needs a token \u2014 set one in the module config';

const RECONNECT_MS = [1000, 2000, 4000, 8000, 15000];

export class CambridgeApi {
  /**
   * @param {object} opts
   * @param {string} opts.host          cambridge address
   * @param {number} opts.port
   * @param {(level: string, msg: string) => void} opts.log
   * @param {(frame: object) => void} opts.onState    full state envelope:
   *        { view, alarms, alarmsByCamera, alarmSummary, roll, undo }
   * @param {(up: boolean, detail?: string) => void} opts.onConnection
   * @param {string} [opts.token]       bearer token; sent on every request and the stream. Never logged.
   * @param {() => void} [opts.onAuthError]  CamBridge answered 401/403
   * @param {typeof fetch} [opts.fetchImpl]           injected for tests
   */
  constructor({ host, port, log, onState, onConnection, token = '', onAuthError, fetchImpl = fetch }) {
    this.token = String(token ?? '').trim();
    this.onAuthError = onAuthError;
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

  #headers(extra) {
    const h = { ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return Object.keys(h).length ? h : undefined;
  }

  /** REST call. Never throws — a dead server must not take Companion down. */
  async request(method, path, body) {
    try {
      const res = await this.fetch(`${this.base}${path}`, {
        method,
        headers: this.#headers(body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      let parsed = null;
      try { parsed = await res.json(); } catch { /* empty body */ }
      if (res.status === 401 || res.status === 403) this.onAuthError?.();
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
    // /api/state returns the same envelope the stream pushes, so both paths
    // hand the instance an identical frame.
    if (r.ok && r.body) {
      // The poll is a full state too, so later patches build on it.
      this.frame = { type: 'state', ...r.body };
      this.onState(r.body);
    }
  }

  async #openStream() {
    if (this.stopped) return;
    this.controller = new AbortController();
    try {
      // ?patch=1: the full state once, then only what changed. With dozens of
      // cameras the full state is far too big to resend on every pan.
      const res = await this.fetch(`${this.base}/api/events?patch=1`, {
        headers: this.#headers({ Accept: 'text/event-stream' }),
        signal: this.controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        const e = new Error(AUTH_MESSAGE);
        e.auth = true;
        throw e;
      }
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
      if (err.auth) this.onAuthError?.();
      else this.onConnection(false, err.message);
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
        if (msg.type === 'state' && msg.view) {
          this.frame = msg;
          this.onState(msg);
        } else if (msg.type === 'patch' && this.frame) {
          const r = applyPatch(this.frame, msg);
          this.frame = r.frame;
          this.onState(r.frame);
          // A patch for a camera never seen: fetch the whole state rather than guess.
          if (r.resync) this.#poll();
        }
      } catch {
        this.log('debug', 'ignored malformed event frame');
      }
    }
  }
}
