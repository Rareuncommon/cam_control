// Client for the camd daemon: REST for commands, WebSocket for events.
//
// Uses Node 22's built-in WebSocket and fetch, so cambridge has no npm
// dependencies at all. That is not minimalism for its own sake — it means no
// install step before a shoot, and nothing to break on a Node upgrade.
//
// The connection to camd is itself treated as unreliable. camd may be restarted
// under launchd while cambridge keeps running, so this reconnects with backoff
// and re-announces state rather than assuming a single lifetime.

import { EventEmitter } from 'node:events';

export class CamdClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl  e.g. http://127.0.0.1:8787
   * @param {string} opts.wsUrl    e.g. ws://127.0.0.1:8787/ws
   * @param {(level: string, msg: string) => void} [opts.log]
   */
  constructor({ baseUrl, wsUrl, log = () => {} }) {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.wsUrl = wsUrl;
    this.log = log;
    this.ws = null;
    this.connected = false;
    this.stopped = false;
    this.backoffMs = 500;
    this.maxBackoffMs = 10_000;
    this.reconnectTimer = null;
  }

  start() {
    this.stopped = false;
    this.#openSocket();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      try { this.ws.close(); } catch { /* already gone */ }
      this.ws = null;
    }
  }

  #openSocket() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch (err) {
      this.#scheduleReconnect(`cannot construct socket: ${err.message}`);
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      this.backoffMs = 500;
      this.log('info', `connected to camd at ${this.wsUrl}`);
      this.emit('camdConnected');
    });

    ws.addEventListener('message', (ev) => {
      let payload;
      try {
        payload = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        // A malformed frame is camd's problem, not a reason to drop the link.
        this.log('warn', 'ignoring unparseable frame from camd');
        return;
      }
      this.emit('event', payload);
    });

    ws.addEventListener('error', () => {
      // The close handler does the reconnect; an error alone is not actionable and
      // Node emits both.
    });

    ws.addEventListener('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.ws = null;
      if (wasConnected) {
        this.log('warn', 'camd connection lost');
        this.emit('camdDisconnected');
      }
      this.#scheduleReconnect('socket closed');
    });
  }

  #scheduleReconnect(reason) {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.log('debug', `reconnecting to camd in ${delay}ms (${reason})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#openSocket();
    }, delay);
  }

  /** Low-level request. Returns { ok, status, body } and never throws. */
  async request(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const init = {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: {},
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      let parsed = null;
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      }
      return { ok: res.ok, status: res.status, body: parsed };
    } catch (err) {
      // camd being down must surface as a clean failure the UI can display, not an
      // unhandled rejection that takes the Node process with it.
      const message = err.name === 'TimeoutError'
        ? 'camd did not respond within 10s'
        : `cannot reach camd: ${err.message}`;
      return { ok: false, status: 503, body: { error: message } };
    }
  }

  listCameras()          { return this.request('GET', '/cameras'); }
  discovered()           { return this.request('GET', '/discovered'); }
  health()               { return this.request('GET', '/health'); }
  getProperties(id)      { return this.request('GET', `/cameras/${encodeURIComponent(id)}/properties`); }

  setProperty(id, prop, rawValue) {
    return this.request(
      'PUT',
      `/cameras/${encodeURIComponent(id)}/properties/${encodeURIComponent(prop)}`,
      { value: rawValue },
    );
  }

  action(id, name, payload) {
    return this.request(
      'POST',
      `/cameras/${encodeURIComponent(id)}/actions/${encodeURIComponent(name)}`,
      payload,
    );
  }

  liveviewUrl(id) {
    return `${this.baseUrl}/cameras/${encodeURIComponent(id)}/liveview`;
  }
}
