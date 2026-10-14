// SKAARHOJ Raw Panel client: CamBridge as the "host system" of a panel.
//
// Normally a SKAARHOJ PTZ Extreme runs Reactor on its own Blue Pill and drives
// the cameras itself; CamBridge only notices by polling. In Raw Panel Mode the
// panel stops thinking: it reports every button, encoder and joystick movement
// over TCP and lights whatever it is told to. This file speaks just enough of
// that protocol, and nothing about cameras — mapping.js decides what a button
// means.
//
// Every protocol fact below comes from the spec notes written for this task
// (`specs/skaarhoj-rawpanel.md`, cited as "notes §n"), which in turn cite
// SKAARHOJ's "Raw Panel Protocol V2" PDF (RWPv2) and the rawpanel-lib Go
// reference implementation (lib). Nothing is from memory.
//
// The protocol, as much of it as we use (ASCII form, one message per line):
//
//   The panel is the TCP server, the client connects (notes §2, RWPv2 p.2,4).
//   Blue Pill panels prefer binary protobuf but accept ASCII, and decide which
//   from the first four bytes a client sends — so the first thing we send is
//   `list`, which can never look like a binary length header (notes §2
//   "Recommendation for Node ASCII client", RWPv2 p.59).
//
//   Client -> panel:  list | PanelTopology? | map | HeartBeatTimer=<ms> | ping
//                     ack | Clear | HWC#<id>=<mode> | HWCc#<id>=<colour>
//                     HWCt#<id>=<pipe-separated text fields>
//   Panel -> client:  _model= _serial= _version= _name= _platform= _support= ...
//                     _panelTopology_svgbase=<svg> / _panelTopology_HWC=<json>
//                     map=<native>:<external>   ping   ack   nack
//                     HWC#<id>[.<edge>]=Down|Up|Press|Enc:<n>|Speed:<n>|Abs:<n>
//                     _isSleeping=0|1  EnvironmentalHealth=..  ErrorMsg=..  Msg=..
//
// What the file never does: throw on anything the panel sends. A panel that
// sends garbage is a panel whose events we ignore, not a CamBridge that stops.

import { connect } from 'node:net';
import { EventEmitter } from 'node:events';

/** notes §2: default 9923 (RWPv2 p.2; lib Readme.md:3), configurable on the panel. */
export const DEFAULT_PORT = 9923;

/**
 * LED state values for `HWC#<id>=<mode>` (notes §6.1, RWPv2 p.5-6).
 * 4 = on with the HWCc colour, 5 = dimmed with it; bit 5 (32) is the output
 * bit, which "should follow whether the On colour is commanded" — so on is
 * 32+4 = 36, the doc's own typical value.
 */
export const LED = Object.freeze({ OFF: 0, ON: 36, DIM: 5 });

/**
 * Colour indices for `HWCc#` (notes §6.2, RWPv2 p.7; matches lib pb.go).
 * On the wire the value is index + 128 (bit 7 = enable).
 */
export const COLOUR = Object.freeze({
  DEFAULT: 0, OFF: 1, WHITE: 2, WARM: 3, RED: 4, ROSE: 5, PINK: 6, PURPLE: 7,
  AMBER: 8, YELLOW: 9, DARKBLUE: 10, BLUE: 11, ICE: 12, CYAN: 13, SPRING: 14,
  GREEN: 15, MINT: 16, LIGHTGRAY: 17, DARKGRAY: 18,
});
/** notes §6.2: `0b10000000 | index` (lib converter_segments.go:37; RWPv2 p.6). */
export const colourValue = (index) => 0x80 | (index & 0x1f);

/**
 * notes §6.4: the whole HWCt string "cannot be longer than 64 characters. Only
 * ASCII 32-127" (RWPv2 p.43), p.8 says 63. The smaller one is used. Title is 10
 * chars on p.9 and 24 on p.44; lines are 24.
 */
const HWCT_MAX = 63;
const LINE_MAX = 24;

/** notes §6.4: no escape for `|` is documented, so it cannot appear in text at all. */
function cleanText(s, max = LINE_MAX) {
  return String(s ?? '').replace(/[^\x20-\x7e]/g, '').replace(/\|/g, '/').slice(0, max);
}

/**
 * Builds an `HWCt` value from named fields (notes §6.4, RWPv2 p.43-44).
 * Field indices: 0 value, 1 format, 2 icon bits, 3 title, 4 isLabel,
 * 5 label 1, 6 label 2. Trailing empty fields are trimmed, as lib does
 * (converterFunctions.go:914,1010).
 */
export function hwcText({ value = '', format = '', icon = '', title = '', isLabel = '', label1 = '', label2 = '' } = {}) {
  const fields = [
    value === '' ? '' : String(Math.trunc(Number(value)) || 0),
    String(format), String(icon), cleanText(title), isLabel === '' ? '' : (isLabel ? '1' : '0'),
    cleanText(label1), cleanText(label2),
  ];
  while (fields.length && fields.at(-1) === '') fields.pop();
  let out = fields.join('|');
  // Over the limit: shorten the second line first, then the first, rather
  // than letting the panel cut the string somewhere arbitrary.
  for (const i of [6, 5, 3]) {
    if (out.length <= HWCT_MAX) break;
    if (fields[i] === undefined) continue;
    fields[i] = fields[i].slice(0, Math.max(0, fields[i].length - (out.length - HWCT_MAX)));
    out = fields.join('|');
  }
  return out.slice(0, HWCT_MAX);
}

// notes §3.1, grammar from lib converterFunctions.go:1100
//   ^HWC#([0-9]+)(|.([0-9]+))=(Down|Up|Press|Abs|Speed|Enc)(|:([-0-9,]+))$
const EVENT_RE = /^HWC#(\d+)(?:\.(\d+))?=(Down|Up|Press|Abs|Speed|Enc)(?::([-0-9,]+))?$/;
// notes §3.1, lib converterFunctions.go:1098
const MAP_RE = /^map=(\d+):(\d+)$/;

/** notes §2: lib caps a frame at 8 MiB; the topology SVG is the only big line. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export class RawPanelClient extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.host
   * @param {number} [o.port=9923]
   * @param {number} [o.heartbeatMs=1000]   asked of the panel; must be > 200 (notes §2, RWPv2 p.13)
   * @param {number} [o.lostAfterMs]        silence that counts as a dead panel
   * @param {number} [o.initTimeoutMs=3000] how long to wait for the panel to answer `list`
   * @param {number[]} [o.backoffMs]
   * @param {(level: string, msg: string) => void} [o.log]
   */
  constructor({ host, port = DEFAULT_PORT, heartbeatMs = 1000, lostAfterMs, initTimeoutMs = 3000,
    backoffMs = [1000, 2000, 4000, 8000, 15000], connectTimeoutMs = 3000, log = () => {} }) {
    super();
    this.host = host;
    this.port = port;
    // notes §2: "HeartBeatTimer=<ms> (ms must be > 200)".
    this.heartbeatMs = Math.max(201, heartbeatMs);
    // The panel pings every heartbeatMs, and we ping it too; three missed
    // beats is a dead link rather than a busy one.
    this.lostAfterMs = lostAfterMs ?? Math.max(3 * this.heartbeatMs, 2500);
    this.initTimeoutMs = initTimeoutMs;
    this.backoffMs = backoffMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.log = log;

    this.socket = null;
    this.stopped = true;
    this.state = 'stopped';
    this.connected = false;
    this.detail = null;
    this.attempts = 0;
    this.timers = { reconnect: null, init: null, beat: null };
    this.buffer = '';
    this.discarding = false;
    this.lastHeard = 0;
    this.#resetPanel();
  }

  #resetPanel() {
    /** What `list` told us (notes §3.2). */
    this.info = {};
    this.support = null;
    /** Parsed `_panelTopology_HWC` JSON, or null. */
    this.topology = null;
    /** native id -> external id, from `map=` (notes §3.1). */
    this.map = new Map();
    this.mapReceived = false;
    this.sleeping = false;
  }

  // --- lifecycle -------------------------------------------------------------

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    this.#open();
  }

  /**
   * Disconnects for good. Clears the panel first, so a panel handed back to
   * Reactor is not left showing CamBridge's camera names until Reactor
   * repaints over them.
   */
  async stop() {
    this.stopped = true;
    clearTimeout(this.timers.reconnect);
    this.timers.reconnect = null;
    if (this.connected) this.send('Clear');   // notes §3.3 (RWPv2 p.10)
    this.#close('stopped', true);
    this.#setState('stopped', null);
  }

  #setState(state, detail) {
    const changed = state !== this.state || detail !== this.detail;
    this.state = state;
    this.detail = detail;
    if (changed) this.emit('status', this.status());
  }

  status() {
    return {
      state: this.state,
      connected: this.connected,
      detail: this.detail,
      panel: this.info.model ? {
        model: this.info.model, serial: this.info.serial ?? '', version: this.info.version ?? '',
        name: this.info.name ?? '', platform: this.info.platform ?? '',
      } : null,
    };
  }

  #open() {
    if (this.stopped) return;
    this.#resetPanel();
    this.buffer = '';
    this.discarding = false;
    this.#setState(this.attempts ? 'reconnecting' : 'connecting', this.detail);
    this.panelError = null;
    let sock;
    try {
      sock = connect({ host: this.host, port: this.port });
    } catch (err) {
      this.#setState('reconnecting', `cannot connect: ${err.message}`);
      this.#scheduleReconnect(false);
      return;
    }
    this.socket = sock;
    sock.setNoDelay(true);
    // utf8 through a StringDecoder: a label split across two chunks stays whole.
    sock.setEncoding('utf8');
    sock.setTimeout(this.connectTimeoutMs, () => {
      if (!this.connected && sock === this.socket) this.#fail(`no answer from ${this.host}:${this.port}`);
    });
    sock.on('connect', () => {
      if (sock !== this.socket) return;
      sock.setTimeout(0);
      this.lastHeard = Date.now();
      // notes §2: lib sends list, PanelTopology?, map, HeartBeatTimer at init
      // (gorwp/rawpanel.go:117-152). `list` goes first, because the first four
      // bytes are what settle an auto-detecting panel on ASCII (RWPv2 p.59).
      this.send('list');
      this.send('PanelTopology?');
      this.send('map');
      this.send(`HeartBeatTimer=${this.heartbeatMs}`);
      // notes §2: "a binary-only panel would not answer; detect by timeout on _model=".
      this.timers.init = setTimeout(() => this.#initTimedOut(), this.initTimeoutMs);
      this.timers.beat = setInterval(() => this.#beat(), this.heartbeatMs);
    });
    sock.on('data', (chunk) => {
      if (sock !== this.socket) return;
      try { this.#receive(chunk); } catch (err) {
        // Belt and braces: the parser is written not to throw, but a bug in it
        // must cost one line, not the connection or the process.
        this.log('warn', `panel line ignored: ${err.message}`);
      }
    });
    sock.on('error', (err) => {
      if (sock === this.socket) this.#fail(err.code === 'ECONNREFUSED'
        ? `${this.host}:${this.port} refused the connection — is Raw Panel Mode on?`
        : err.message);
    });
    sock.on('close', () => {
      if (sock === this.socket) this.#fail(this.panelError ?? 'the panel closed the connection');
    });
  }

  #initTimedOut() {
    if (this.connected) return;
    if (this.info.model) {
      // It answered `list` but sent no topology. Usable only with an explicit
      // mapping; say so rather than refusing outright.
      this.log('warn', 'the panel sent no topology; only skaarhoj.mapping can assign its controls');
      this.#ready();
      return;
    }
    // notes §2: until a panel in auto mode decides, it assumes binary; one
    // that never answers our ASCII `list` is binary-only, or not a panel.
    this.#fail('the panel did not answer in ASCII — it may be set to binary-only Raw Panel, or not be a SKAARHOJ panel', true);
  }

  #beat() {
    if (!this.socket) return;
    if (Date.now() - this.lastHeard > this.lostAfterMs) {
      this.#fail(`no heartbeat from the panel for ${Math.round((Date.now() - this.lastHeard) / 100) / 10}s`);
      return;
    }
    // notes §2: client `ping` -> panel answers `ack` (RWPv2 p.11); lib sends
    // one every second so a dead link is noticed (gorwp/rawpanel.go:158).
    this.send('ping');
  }

  #close(why, graceful = false) {
    clearTimeout(this.timers.init);
    clearInterval(this.timers.beat);
    this.timers.init = null;
    this.timers.beat = null;
    const sock = this.socket;
    // Forgotten before it is closed, so its own close and error events are
    // recognised as stale and do not start a second round of failure handling.
    this.socket = null;
    // Every socket that goes away says so, identified or not: whatever it
    // delivered must be let go of.
    if (sock) this.emit('linkDown', why);
    if (sock) {
      try {
        if (graceful) {
          // Let a final `Clear` reach the panel before the socket goes.
          sock.end();
          setTimeout(() => sock.destroy(), 300).unref?.();
        } else sock.destroy();
      } catch { /* already gone */ }
    }
    if (this.connected) {
      this.connected = false;
      this.log(why === 'stopped' ? 'info' : 'warn', `panel disconnected (${why})`);
      this.emit('disconnected', why);
    }
  }

  /** Something went wrong: drop the link and try again later. */
  #fail(why, slow = false) {
    this.#close(why);
    if (this.stopped) return;
    this.#setState(slow ? 'refused' : 'reconnecting', why);
    this.#scheduleReconnect(slow);
  }

  #scheduleReconnect(slow) {
    if (this.stopped || this.timers.reconnect) return;
    const list = this.backoffMs;
    // A panel that refused us on protocol grounds will not change its mind in
    // a second; retry at the slowest pace, in case someone fixes its settings.
    const delay = slow ? list.at(-1) : list[Math.min(this.attempts, list.length - 1)];
    this.attempts += 1;
    this.timers.reconnect = setTimeout(() => {
      this.timers.reconnect = null;
      this.#open();
    }, delay);
    this.timers.reconnect.unref?.();
  }

  #ready() {
    if (this.connected) return;
    clearTimeout(this.timers.init);
    this.connected = true;
    this.attempts = 0;
    const p = this.info;
    this.log('info', `panel connected at ${this.host}:${this.port}: ${p.model ?? '?'}`
      + `${p.serial ? ` serial ${p.serial}` : ''}${p.version ? ` ${p.version}` : ''}`);
    this.#setState('connected', null);
    // Listeners read `topology` themselves; 'topology' is only for one
    // pushed again mid-connection (notes §4, RWPv2 p.57-58).
    this.emit('connected', this.status().panel);
  }

  // --- receive ---------------------------------------------------------------

  #receive(chunk) {
    this.lastHeard = Date.now();
    let text = this.buffer + chunk;
    let nl;
    while ((nl = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, nl);
      text = text.slice(nl + 1);
      if (this.discarding) { this.discarding = false; continue; }
      // notes §2: lines end in NL; tolerate CR as lib does (trims "\r\n").
      this.#line(line.replace(/\r+$/, ''));
      if (!this.socket) return;   // the line closed the connection
    }
    if (text.length > MAX_LINE_BYTES) {
      // A line that never ends is not a line. Drop it and resynchronise on
      // the next newline instead of growing until the process falls over.
      this.log('warn', 'over-long line from the panel discarded');
      text = '';
      this.discarding = true;
    }
    this.buffer = text;
  }

  #line(line) {
    if (!line) return;
    // notes §3.1: panel `ping` must be answered with any command within 2 s,
    // usually `ack` (RWPv2 p.13; lib gorwp/rawpanel.go:271-276).
    if (line === 'ping') { this.send('ack'); return; }
    if (line === 'ack') return;
    if (line === 'nack') { this.log('debug', 'panel answered nack (it did not understand a command)'); return; }

    const ev = EVENT_RE.exec(line);
    if (ev) { this.#event(ev); return; }

    const mp = MAP_RE.exec(line);
    if (mp) { this.#mapEntry(Number(mp[1]), Number(mp[2])); return; }

    const eq = line.indexOf('=');
    if (eq < 0) { this.log('debug', `unrecognised panel line: ${line.slice(0, 80)}`); return; }
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    switch (key) {
      // notes §3.2: replies to `list` (RWPv2 p.10-11, 32-33).
      case '_model': this.info.model = value; break;
      case '_serial': this.info.serial = value; break;
      case '_version': this.info.version = value; break;
      case '_name': this.info.name = value; break;
      case '_platform': this.info.platform = value; break;
      case '_panelType': this.info.panelType = value; break;
      case '_support': {
        // notes §3.2: comma list incl. `ASCII`, `Binary` (RWPv2 p.33).
        this.support = value.split(',').map((s) => s.trim()).filter(Boolean);
        if (!this.support.includes('ASCII')) {
          this.#fail(`the panel reports no ASCII Raw Panel support (it offers: ${this.support.join(', ') || 'nothing'})`, true);
        }
        break;
      }
      case '_panelTopology_svgbase': break;   // background art; mapping needs only the JSON (notes §4)
      case '_panelTopology_HWC': this.#topology(value); break;
      // notes §3.1: sleep state, proactively (RWPv2 p.34).
      case '_isSleeping':
        this.sleeping = value === '1';
        this.emit('sleep', this.sleeping);
        break;
      // notes §3.1/§5: `Blocked` = the panel stopped sending triggers (RWPv2 p.35).
      case 'EnvironmentalHealth':
        this.emit('health', value);
        if (value !== 'Normal') this.log('warn', `panel environmental health: ${value}`);
        break;
      // notes §2: refusal (max clients / locked to IP) arrives as ErrorMsg and a close (RWPv2 p.35).
      case 'ErrorMsg':
        this.log('warn', `panel says: ${value.slice(0, 200)}`);
        this.panelError = `the panel says: ${value.slice(0, 200)}`;
        break;
      case 'Msg': this.log('info', `panel says: ${value.slice(0, 200)}`); break;
      default:
        // _heartBeatTimer, _bluePillReady, _serverModeMaxClients and friends:
        // informational, and nothing here depends on them.
        if (key.startsWith('_')) this.info[key.slice(1)] = value;
    }
    if (!this.connected && this.info.model && this.topology && this.socket) this.#ready();
  }

  #topology(json) {
    let t;
    try { t = JSON.parse(json); } catch (err) {
      this.log('warn', `panel topology is not valid JSON (${err.message}); ignored`);
      return;
    }
    if (!t || typeof t !== 'object' || !Array.isArray(t.HWc)) {
      this.log('warn', 'panel topology has no HWc list; ignored');
      return;
    }
    // notes §4: topology may be pushed again mid-connection; always use the latest.
    this.topology = t;
    if (this.connected) this.emit('topology', t);
  }

  #mapEntry(native, external) {
    // notes §3.1: value 0 = absent/disabled (e.g. asleep); bit 31 = offscreen,
    // TouchUI only — masked off here.
    const ext = external & 0x7fffffff;
    const before = this.map.get(native);
    this.mapReceived = true;
    this.map.set(native, ext);
    if (before !== ext) this.emit('map', { id: native, external: ext });
  }

  /** notes §3.1: an id the panel reports as `external` is topology id `native`. */
  toNative(external) {
    if (!this.mapReceived) return external;
    for (const [n, e] of this.map) if (e === external) return n;
    return external;
  }

  toExternal(native) {
    const e = this.map.get(native);
    return e ? e : native;
  }

  /** Whether a topology component is present, per the map (notes §3.1, RWPv2 p.31). */
  available(native) {
    if (!this.mapReceived) return true;
    return (this.map.get(native) ?? 0) !== 0;
  }

  #event(m) {
    // Input before the panel is identified is ignored. A reconnecting panel
    // can send a deflected joystick ahead of its topology; acting on it would
    // latch a move on roles from the previous connection, and if the socket
    // then died before identifying, nothing would ever release it.
    if (!this.connected) {
      this.log('debug', 'panel input before identification ignored');
      return;
    }
    const id = this.toNative(Number(m[1]));
    const edge = m[2] === undefined ? 0 : Number(m[2]);
    const kind = m[3];
    const values = m[4] === undefined ? [] : m[4].split(',').filter((s) => s !== '' && s !== '-').map(Number);
    if (values.some((v) => !Number.isFinite(v))) return;
    if (kind === 'Press') {
      // notes §3.1: legacy, Down and Up at once; lib expands to both (:1185-1204).
      this.emit('event', { id, edge, kind: 'Down' });
      this.emit('event', { id, edge, kind: 'Up' });
      return;
    }
    if ((kind === 'Enc' || kind === 'Speed' || kind === 'Abs') && values.length === 0) return;
    this.emit('event', { id, edge, kind, value: values[0], values });
  }

  // --- send ------------------------------------------------------------------

  send(line) {
    const sock = this.socket;
    if (!sock || sock.destroyed) return false;
    try {
      sock.write(`${line}\n`);   // notes §2: lines terminated by NL (RWPv2 p.61)
      return true;
    } catch (err) {
      this.log('debug', `send failed: ${err.message}`);
      return false;
    }
  }

  /**
   * LED colour then state. The colour is set first because it "only takes
   * effect when state is 4 or 5" (notes §6.1, RWPv2 p.7). One HWC per line,
   * as lib does for compatibility (notes §3.3).
   */
  setLed(id, { mode = LED.ON, colour = COLOUR.WHITE } = {}) {
    const ext = this.toExternal(id);
    this.send(`HWCc#${ext}=${colourValue(colour)}`);   // notes §6.2
    this.send(`HWC#${ext}=${mode}`);                   // notes §6.1
  }

  /** notes §6.4: `HWCt#<id>=<pipe string>`. */
  setText(id, fields) {
    this.send(`HWCt#${this.toExternal(id)}=${typeof fields === 'string' ? fields : hwcText(fields)}`);
  }

  /** notes §3.3: clears all LEDs and displays (RWPv2 p.10). */
  clear() { this.send('Clear'); }
}
