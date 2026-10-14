// Canon PTZ heads over the XC control protocol (HTTP). Table: CR-N500.
//
// Source: Canon "XC Control Protocol Specifications" BPE-7216-005, via the spec
// notes (specs/canon-cr-n500.md). "XC5 p.N" is the spec's printed page; "CCP"
// is the Bitfocus companion-module-canon-ptz, cited only where it is the sole
// source (impl).
//
// Three things about XC shape this driver:
//
// - **HTTP 200 does not mean yes.** The command's result is the
//   `Livescope-Status` reply header (XC5 p.9). Every reply is checked, and a
//   non-zero status is a refusal (the camera answered), never a health failure.
//   301 is the one that matters on a busy rig: another client — a SKAARHOJ
//   panel, Reactor, the camera's web page — holds a privileged session, and our
//   general-priority request was not executed (XC5 p.18, p.73-75).
// - **Sessionless.** XC5 p.1/p.23 says almost everything works without a
//   session or control rights, and recommends skipping sessions for plain
//   control. A session would also have to be kept alive (60 s, XC5 p.24) and
//   would compete for control rights with the panels on the same head. So no
//   open.cgi here; every request stands alone. Keys are always sent in the full
//   `c.1.…` / `f.…` form, because XC5 p.11 does not say which abbreviations are
//   legal (CCP's short forms work, but are impl-only).
// - **Replies are `name:=value` lines**, where `name==?` means "not valid in
//   the current mode" (XC5 p.48, p.56, p.74). That is how a gated write fails,
//   so writes read their own key back from the reply.

import http from 'node:http';
import { PtzDriver, DriverError } from '../driver.js';
import { digestHeader, parseChallenge, knownScheme } from '../http.js';
import { TABLE } from '../tables/canon-cr-n500.js';

/** Every XC command lives under this path; after `wvhttp` it is case-insensitive. XC5 p.7 */
const XC = '/-wvhttp-01-/';
/** The RA-AT001 tracking add-on's CGI root, on the camera's own HTTP port. CCP src/config.js:118, src/tracking.js:36-39 (impl) */
const ADDON = '/cgi-addon/Auto_Tracking_RA-AT001/app_ctrl/';

/** XC5 p.72: "an interval of 30 ms or more" between separate control requests. */
const GAP_MS = 30;

/** Livescope-Status codes, XC5 p.9 Table 3-2. Words an operator can act on. */
const LIVESCOPE = {
  301: 'another controller (a SKAARHOJ panel, Reactor or the camera\'s web page) holds camera control, so the camera did not carry this out — try again once it lets go',
  302: 'the camera is not available',
  303: 'the camera reports a fault and cannot be controlled',
  401: 'the camera does not know this command',
  403: 'the camera did not accept that value',
  404: 'the camera did not finish the operation in time',
  406: 'the camera says a parameter is missing',
  407: 'the camera rejected the request',
  408: 'the camera is busy with another exclusive operation',
  409: 'the camera is busy moving recordings',
  410: 'the camera rejected the data',
  501: 'the camera does not know this session',
  503: 'too many clients are connected to the camera',
  507: 'the camera\'s user rights do not allow this',
  508: 'the camera is refusing new requests for now (connection limit)',
  509: 'the camera is in standby',
  510: 'the camera is going into standby',
  511: 'the camera is waking from standby',
};

function livescopeError(code) {
  const n = Number(code);
  const msg = LIVESCOPE[n] ?? `the camera refused the request (status ${n})`;
  // 401 here is "undefined command" — the camera lacks it, not a credentials problem.
  return new DriverError(msg, { code: `LS${n}`, kind: n === 401 ? 'unsupported' : 'refused' });
}

function transportError(r) {
  if (r.kind === 'auth') return new DriverError('the camera refused the username or password', { kind: 'auth' });
  if (r.kind === 'timeout') return new DriverError('the camera did not answer in time', { kind: 'timeout' });
  if (r.kind === 'network') return new DriverError(`cannot reach the camera (${r.error})`, { kind: 'network' });
  // The camera answered with an HTTP error (XC5 p.8 Table 3-1). That is a "no", not a dead camera.
  if (r.status === 404) return new DriverError('the camera does not offer this', { code: 'HTTP404', kind: 'unsupported' });
  if (r.status === 503) return new DriverError('the camera is overloaded for a moment (HTTP 503)', { code: 'HTTP503' });
  return new DriverError(`the camera answered HTTP ${r.status}`, { code: `HTTP${r.status}` });
}

/**
 * Splits an XC text reply into [key, op, value] triples. `op` is ':=' (changed
 * or first report), '==' (unchanged, or '?' = rejected) or '=' (timestamp,
 * realtime). XC5 p.48, p.56, p.69. The line terminator is not specified, so
 * both are accepted.
 */
export function parseXc(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^([^=:\s]+)(:=|==|=)(.*)$/.exec(line.trim());
    if (m) out.push([m[1], m[2], m[3]]);
  }
  return out;
}

/** Keys as-is; values URL-encoded but keeping `,` and `:` literal, as XC5's own examples write them. */
function query(pairs) {
  return pairs.map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%2C/gi, ',').replace(/%3A/gi, ':')}`).join('&');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// --- speed mapping -------------------------------------------------------------

/**
 * Pan/tilt: XC speed 100 = 1 °/s, CR-N500 range 10…10000 (XC5 p.150).
 * Exponential, so the stick spans the three decades evenly: a light touch
 * creeps at 0.1 °/s, half deflection is ~3 °/s, full is the head's 100 °/s.
 * A linear map would put everything an operator uses on air in the first 5 %
 * of travel.
 */
export function panTiltSpeed(v) {
  const a = Math.min(1, Math.abs(v));
  return Math.max(10, Math.min(10000, Math.round(10 * 1000 ** a)));
}

/**
 * Zoom: `c.1.zoom.speed.dir` 0…15 on CR-N500 (XC5 p.149). Mapped onto 1…15:
 * whether 0 is a moving speed or "none" is not stated, and a slowest creep that
 * silently does nothing would be worse than one step faster.
 */
export function zoomSpeed(v) {
  return Math.max(1, Math.min(15, 1 + Math.round(Math.min(1, Math.abs(v)) * 14)));
}

/** Focus: speed is the stored `c.1.focus.speed`, 0…2 on CR-N500 (XC5 p.145-146, group-read). */
export function focusSpeed(v) {
  const a = Math.abs(v);
  return a < 1 / 3 ? 0 : a < 2 / 3 ? 1 : 2;
}

/** Fallback travel when the camera has not reported min/max. XC5 p.145, p.148-151. */
const TRAVEL = {
  pan: { min: -17000, max: 17000 },
  tilt: { min: -3000, max: 9000 },
  zoom: { min: 570, max: 7300 },
  focus: { min: 0, max: 2048 },
};

const POSITION_KEYS = { pan: 'c.1.pan', tilt: 'c.1.tilt', zoom: 'c.1.zoom', focus: 'c.1.focus.value' };

// --- event stream --------------------------------------------------------------

/** Push: `info.cgi?type=stream`, multipart/x-mixed-replace (XC5 p.47-54, p.70-71). */
const STREAM_TIMEOUT_S = 60;       // a timestamp-only part after this long idle (XC5 p.53); our liveness signal
const STREAM_INTERVAL_MS = 500;    // position notifications during PTZ moves: 0|33|100|200|500|1000 (XC5 p.54)
const STREAM_RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];
/** The camera's client limit is unknown (notes §4); when it says "too many", stay away a good while. */
const STREAM_BUSY_RETRY_MS = 5 * 60_000;
const STREAM_MAX_BUFFER = 1 << 20;

/**
 * The scheme each camera (`host:port`) has challenged the event stream with.
 * The stream has its own HTTP code (http.js cannot hold a multipart response
 * open), so it keeps its own memory, the same rule as http.js: a camera that
 * has asked for Digest and later asks for Basic does not get the password —
 * Basic sends it in the clear, and the likeliest reason for the change is
 * that the address now belongs to something else, or is pretending.
 * Module-wide, so it outlives one connection's driver; bounded like
 * http.js's per-host caches.
 */
const streamSchemes = new Map();
const STREAM_SCHEMES_MAX = 512;
function rememberScheme(key, scheme) {
  // Digest, once seen, is never downgraded.
  if (streamSchemes.get(key) === 'digest' && scheme !== 'digest') return;
  streamSchemes.delete(key);
  streamSchemes.set(key, scheme);
  while (streamSchemes.size > STREAM_SCHEMES_MAX) streamSchemes.delete(streamSchemes.keys().next().value);
}

/** For tests: forget what the event stream learned about a camera's authentication. */
export function forgetStreamScheme(host, port = 80) { streamSchemes.delete(`${host}:${port}`); }

/** Reads a multipart/x-mixed-replace body part by part, by Content-Length where given. */
export class MultipartReader {
  constructor(boundary, onPart) {
    this.delim = Buffer.from(`--${boundary}`);
    this.buf = Buffer.alloc(0);
    this.onPart = onPart;
    this.ended = false;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > STREAM_MAX_BUFFER) throw new Error('event stream part too large');
    for (;;) {
      const at = this.buf.indexOf(this.delim);
      if (at < 0) return;
      const p = at + this.delim.length;
      if (this.buf.length < p + 2) return;
      if (this.buf[p] === 0x2d && this.buf[p + 1] === 0x2d) {   // "--boundary--": the stream is over
        this.ended = true;
        this.buf = Buffer.alloc(0);
        return;
      }
      const crlf = this.buf.indexOf('\r\n\r\n', p);
      const lf = this.buf.indexOf('\n\n', p);
      let hEnd = -1; let sep = 0;
      if (crlf >= 0 && (lf < 0 || crlf < lf)) { hEnd = crlf; sep = 4; } else if (lf >= 0) { hEnd = lf; sep = 2; }
      if (hEnd < 0) return;
      const headers = this.buf.subarray(p, hEnd).toString('latin1');
      const start = hEnd + sep;
      const len = /content-length:\s*(\d+)/i.exec(headers);
      let end;
      if (len) {
        end = start + Number(len[1]);
        if (this.buf.length < end) return;
      } else {
        end = this.buf.indexOf(this.delim, start);
        if (end < 0) return;
      }
      const body = this.buf.subarray(start, end).toString('utf8');
      this.buf = this.buf.subarray(end);
      this.onPart(body);
    }
  }
}

// --- tables per model --------------------------------------------------------------

/** Models with a table of their own. */
const TABLES = new Map([['CR-N500', TABLE]]);

/**
 * Any other Canon head that speaks XC (CR-N300, CR-N700, CR-X300…) gets the
 * CR-N500 table with every entry marked verify. XC answers an unknown item with
 * an error, so whatever that model lacks is hidden by the lifecycle rather than
 * shown and broken; what remains is worth checking with ptz-report.sh.
 */
const SIBLING = TABLE.map((e) => ({ ...e, verify: true }));

export function tableFor(model) {
  return TABLES.get(String(model ?? '').trim().toUpperCase()) ?? SIBLING;
}

// --- the driver ----------------------------------------------------------------

export class CanonXcPtz extends PtzDriver {
  static vendor = 'canon';
  static label = 'Canon';
  // Models with a table of their own; any other XC head is accepted — see tableFor().
  static models = [...TABLES.keys()];
  /** XC5 p.72: 30 ms or more between separate control requests. */
  static minIntervalMs = GAP_MS;
  /**
   * info.cgi takes any number of items in one request (XC5 p.54-55), and each
   * item brings its sub-items (lists, limits) with it, so a dozen per poll is
   * still one small reply.
   */
  static readBatch = 12;

  /**
   * Read-only: one info.cgi for the model name. The fingerprint is the
   * `Livescope-Status` header plus `s.hardware` beginning "Canon " (XC5 p.8,
   * p.56, p.70); a camera of another vendor fails both and gets null.
   */
  static async probe(ctx) {
    const r = await ctx.http({
      host: ctx.host, port: ctx.port ?? 80, auth: ctx.auth, timeoutMs: ctx.timeoutMs ?? 2500,
      path: `${XC}info.cgi?item=s.hardware,s.firmware,c.1.type`,
    });
    const ls = r.headers?.['livescope-status'];
    const speaksXc = ls !== undefined || /^vb\b/i.test(String(r.headers?.server ?? ''));
    if (r.kind === 'auth') {
      // Only claim "wrong password" for something that is recognisably XC;
      // another vendor's 401 is just not us.
      if (speaksXc) throw new DriverError('the camera refused the username or password', { kind: 'auth' });
      return null;
    }
    if (!r.ok || ls === undefined) return null;
    if (String(ls).trim() === '507') throw new DriverError(LIVESCOPE[507], { kind: 'auth' });
    if (String(ls).trim() !== '0') return null;
    const m = new Map(parseXc(r.text).map(([k, , v]) => [k, v]));
    const hw = m.get('c.1.type') ?? m.get('s.hardware') ?? '';
    if (!/^Canon\s/.test(hw)) return null;
    return { vendor: 'canon', model: hw.replace(/^Canon\s+/, ''), firmware: m.get('s.firmware') };
  }

  constructor(ctx) {
    super(ctx);
    this.port = ctx.port ?? 80;
    this.timeoutMs = ctx.timeoutMs ?? 3000;
    this.options = ctx.options ?? {};
    /** Last raw value seen per XC key, from any reply or the event stream. */
    this.cache = new Map();
    this.trackingAddon = false;
    this.lastSent = 0;
    /** The last caller's turn to wait out the gap (see #pace). */
    this.paceTail = Promise.resolve();
    this.closed = false;
    this.stream = null;

    /*
     * Pan/tilt speed mode. XC has three (XC5 p.72, p.149-152): `manual`
     * (constant °/s), `auto1` (screen-widths per second, via `speed.ratio`) and
     * `auto2` (the speed given is the speed at the wide end, scaled down as the
     * lens zooms in). With no mode named, the camera uses auto2.
     *
     * Choice: name the mode on every move rather than relying on whatever the
     * camera holds. The mode is a per-session/priority item (`P`), so a mode set
     * once may not persist for a sessionless client — and another controller may
     * have left it at auto1, where our `speed.dir` would be ignored for
     * `speed.ratio`. Default auto2: the same stick deflection moves the
     * *picture* at roughly the same rate at any zoom, which is what makes a
     * joystick usable at the tele end (at a fixed 100 °/s a full-tele shot is
     * unusable). `options.panTiltSpeedMode: 'manual'` gives constant °/s
     * instead; `'camera'` sends no mode at all.
     */
    const mode = this.options.panTiltSpeedMode ?? 'auto2';
    this.speedMode = mode === 'manual' || mode === 'auto2' ? mode : null;

    this.#useTable(TABLE);
  }

  /** Swaps in the table for the identified model. Called again from identify(). */
  #useTable(table) {
    this.entries = table;
    this.byId = new Map(table.map((e) => [e.id, e]));
    this.byKey = new Map();
    for (const e of table) {
      if (!e.wire?.key) continue;
      if (!this.byKey.has(e.wire.key)) this.byKey.set(e.wire.key, []);
      this.byKey.get(e.wire.key).push(e);
    }
  }

  // --- transport ---------------------------------------------------------------

  /**
   * Keeps the spec's 30 ms between requests (XC5 p.72). A move or stop may
   * now run alongside a read (the lifecycle's motion lane), so two callers
   * can pace at once. The waits take turns — each measures from the moment
   * the previous one actually went — so two callers never pick the same
   * slot. Only the wait is in turn, not the request: XC is plain HTTP, and a
   * stop goes out at most one gap after a read's request, never after its
   * reply.
   */
  #pace() {
    const turn = this.paceTail.then(async () => {
      const wait = this.lastSent + GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastSent = Date.now();
    });
    this.paceTail = turn;
    return turn;
  }

  /** A move or stop is waiting for the camera: a read with more to ask hands back what it has. */
  #shouldYield() {
    try { return !!this.ctx?.shouldYield?.(); } catch { return false; }
  }

  /** One XC request; throws DriverError for anything but HTTP 200 + Livescope-Status 0. */
  async #get(path, { pace = true, timeoutMs } = {}) {
    if (pace) await this.#pace();
    const r = await this.http({
      host: this.host, port: this.port, path, auth: this.auth, timeoutMs: timeoutMs ?? this.timeoutMs,
    });
    if (!r.ok) throw transportError(r);
    const ls = r.headers?.['livescope-status'];
    if (ls !== undefined && String(ls).trim() !== '0') throw livescopeError(String(ls).trim());
    return r;
  }

  /** info.cgi for these items (each with its sub-items). XC5 p.47-55 */
  async #info(items) {
    // An item selects its whole subtree, so drop any key already covered by an ancestor.
    const keys = [...new Set(items)].sort();
    const roots = keys.filter((k) => !keys.some((o) => o !== k && k.startsWith(`${o}.`)));
    const r = await this.#get(`${XC}info.cgi?item=${roots.join(',')}`);
    const got = new Map();
    for (const [k, op, v] of parseXc(r.text)) {
      if (op === '=') continue;   // timestamp, realtime
      got.set(k, v);
      this.cache.set(k, v);
    }
    return got;
  }

  /** control.cgi with these pairs, in order. Returns key → {op, value}. XC5 p.72-75 */
  async #control(pairs) {
    const r = await this.#get(`${XC}control.cgi?${query(pairs)}`);
    const got = new Map();
    for (const [k, op, v] of parseXc(r.text)) {
      got.set(k, { op, value: v });
      if (v !== '?') this.cache.set(k, v);
    }
    return got;
  }

  /** Throws refused for any of these keys the camera answered `==?` (not valid now). */
  #checkRejected(reply, keys, what) {
    for (const k of keys) {
      const r = reply.get(k);
      if (r && r.op === '==' && r.value === '?') {
        throw new DriverError(`${what}: not possible in the camera's current mode`, { code: 'rejected' });
      }
    }
  }

  // --- identity ----------------------------------------------------------------

  async identify() {
    let got;
    try {
      // s.hardware brings s.hardware.address and .id with it. XC5 p.125, p.127
      got = await this.#info(['s.hardware', 's.firmware', 's.protocol', 'c.1.type', 'c.1.name.utf8']);
    } catch (err) {
      // Insufficient privilege on a plain info request means the account (or
      // guest) has no rights on this camera at all — a credentials problem.
      if (err.code === 'LS507') throw new DriverError(err.message, { kind: 'auth' });
      throw err;
    }
    const hw = got.get('c.1.type') ?? got.get('s.hardware') ?? '';
    if (!/^Canon\s/.test(hw)) throw new DriverError('this does not identify as a Canon XC camera', { kind: 'unsupported' });
    const mac = got.get('s.hardware.address');
    this.trackingAddon = this.options.tracking === false ? false : await this.#probeAddon();
    const model = hw.replace(/^Canon\s+/, '');
    this.#useTable(tableFor(model));
    return {
      vendor: 'canon',
      model,
      firmware: got.get('s.firmware'),
      protocol: got.get('s.protocol'),
      mac: mac && /^[0-9a-f]{12}$/i.test(mac) ? mac.match(/../g).join(':').toLowerCase() : mac,
      name: got.get('c.1.name.utf8'),
      tracking: this.trackingAddon,
    };
  }

  /**
   * Is the RA-AT001 auto-tracking add-on installed (and answering) on this
   * camera? One read-only GET of its config. Everything about the add-on is
   * impl-only (CCP src/tracking.js:36-60): a camera without it simply gets no
   * tracking UI, so any failure here means "absent".
   */
  async #probeAddon() {
    try {
      const cfg = await this.#addonConfig(Math.min(this.timeoutMs, 2000));
      return cfg !== null && 'trackingEnable' in cfg;
    } catch {
      return false;
    }
  }

  /** The add-on's settings, or null. CCP reads `get_config.cgi` as JSON with string '0'/'1' values (src/actions.js:3326). */
  async #addonConfig(timeoutMs) {
    await this.#pace();
    const r = await this.http({ host: this.host, port: this.port, path: `${ADDON}get_config.cgi`, auth: this.auth, timeoutMs: timeoutMs ?? this.timeoutMs });
    if (!r.ok) {
      if (r.kind) throw transportError(r);
      return null;
    }
    return parseAddonConfig(r.text);
  }

  async heartbeat() {
    try {
      await this.#info(['c.1.status']);   // XC5 p.127
    } catch (err) {
      // A camera that answers "no" is alive.
      if (err.kind !== 'refused' && err.kind !== 'unsupported') throw err;
    }
  }

  schema() {
    return this.entries.filter((e) => e.requires !== 'tracking' || this.trackingAddon);
  }

  capabilities() {
    return {
      panTilt: true, zoom: true, focus: true,
      presets: 100, presetBase: 1,                                   // p.count 100, numbers 1…100 (XC5 p.20, p.152)
      tracking: this.trackingAddon ? { kind: 'autoTracking', label: 'Auto tracking (RA-AT001)' } : null,
      tally: true,
      snapshot: true,
      // Relative moves by screen ratio exist (`c.1.pan=v<±n>`, XC5 p.73-75) but
      // the notes leave the sign encoding open; a guess that moves the head the
      // wrong way is not worth the feature.
      pointToCentre: false,
      // Standby exists (table entry powerState), but the contract has no power call.
      power: false,
    };
  }

  // --- values --------------------------------------------------------------------

  #decode(entry, raw) {
    const w = entry.wire;
    switch (entry.type) {
      case 'bool': return raw === String(w.on);
      case 'range': {
        const n = Number(raw);
        if (!Number.isFinite(n)) return null;
        return Number((n / (w.scale ?? 1)).toFixed(4));
      }
      case 'enum': {
        const o = entry.options.find((x) => String(x.value) === raw);
        if (o) return o.value;
        return typeof entry.options[0]?.value === 'number' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
      }
      default: return raw;
    }
  }

  #encode(entry, value) {
    const w = entry.wire;
    switch (entry.type) {
      case 'bool': return value ? w.on : w.off;
      case 'range': {
        let n = Math.round(Number(value) * (w.scale ?? 1));
        const list = w.snap ? this.cache.get(`${w.key}.list`) : null;
        if (list) {
          // The camera's own steps (colour temperature is non-uniform, XC5 p.59).
          const steps = list.split(',').map(Number).filter(Number.isFinite);
          if (steps.length) n = steps.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), steps[0]);
        }
        return String(n);
      }
      default: return String(value);
    }
  }

  #gateOk(entry) {
    if (!entry.gate) return true;
    const g = this.byId.get(entry.gate.id);
    const raw = g?.wire?.key ? this.cache.get(g.wire.key) : undefined;
    return raw === undefined ? true : this.#decode(g, raw) === entry.gate.value;
  }

  /** One entry's read result from a key → raw map (a reply, or the cache). */
  #valueOf(entry, map) {
    const raw = map.get(entry.wire.key);
    if (raw === undefined) return { error: 'not reported by this camera', unsupported: true };
    const out = { value: this.#decode(entry, raw), writable: !entry.readOnly && this.#gateOk(entry) };
    if (entry.type === 'enum') {
      const list = map.get(`${entry.wire.key}.list`);
      if (list) {
        const codes = new Set(list.split(','));
        out.allowed = entry.options.filter((o) => codes.has(String(o.value))).map((o) => o.value);
      }
    }
    return out;
  }

  async read(entries) {
    const out = {};
    const xc = entries.filter((e) => e.wire?.key && e.type !== 'action');
    const addon = entries.filter((e) => e.wire?.addon);
    if (xc.length) {
      const keys = new Set(xc.map((e) => e.wire.key));
      for (const e of xc) {
        const g = e.gate && this.byId.get(e.gate.id);
        if (g?.wire?.key) keys.add(g.wire.key);
      }
      const got = await this.#info([...keys]);
      for (const e of xc) out[e.id] = this.#valueOf(e, got);
      // A second request (the add-on's) gives way to a waiting move or stop.
      if (this.#shouldYield()) return out;
    }
    if (addon.length) {
      const cfg = await this.#addonConfig();
      for (const e of addon) {
        const raw = cfg?.[e.wire.addon];
        if (raw === undefined) { out[e.id] = { error: 'not reported by the tracking add-on', unsupported: true }; continue; }
        out[e.id] = { value: this.#decode(e, String(raw)), writable: true };
      }
    }
    return out;
  }

  async write(entry, value) {
    const w = entry.wire ?? {};
    if (w.addon) {
      // CCP src/actions.js:3304 etc.: update_config.cgi?<param>=<value>; reply format unknown, so 2xx = done.
      await this.#pace();
      const r = await this.http({
        host: this.host, port: this.port, auth: this.auth, timeoutMs: this.timeoutMs,
        path: `${ADDON}update_config.cgi?${query([[w.addon, this.#encode(entry, value)]])}`,
      });
      if (!r.ok) throw transportError(r);
      return {};
    }
    if (w.standby) {
      // standby.cgi?cmd=standby|idle, reply "OK." (XC5 p.103-105)
      await this.#get(`${XC}standby.cgi?cmd=${value === 'standby' ? 'standby' : 'idle'}`);
      return {};
    }
    if (!w.key || entry.readOnly) throw new DriverError(`${entry.label} cannot be changed from here`, { kind: 'unsupported' });

    if (entry.gate) {
      const g = this.byId.get(entry.gate.id);
      const got = await this.#info([g.wire.key]);
      const raw = got.get(g.wire.key);
      // A camera that does not report the gate gets to decide for itself (its `==?`).
      if (raw !== undefined && this.#decode(g, raw) !== entry.gate.value) {
        const want = g.options?.find((o) => o.value === entry.gate.value)?.label ?? entry.gate.value;
        throw new DriverError(`${entry.label} needs ${g.label} set to ${want} first`, { code: 'gate' });
      }
    }
    if (w.rbGain) {
      const [r, b] = String(value).split('-').map(Number);
      if (!(r >= 0 && r <= 1023 && b >= 0 && b <= 1023)) {
        throw new DriverError(`${entry.label}: R and B each go from 0 to 1023`, { code: 'range' });
      }
    }
    const reply = await this.#control([[w.key, this.#encode(entry, value)]]);
    this.#checkRejected(reply, [w.key], entry.label);
    const back = reply.get(w.key);
    if (back && back.value !== '?') {
      const applied = this.#decode(entry, back.value);
      if (applied !== null && applied !== value) return { applied };
    }
    return {};
  }

  async action(entry) {
    const w = entry.wire ?? {};
    if (w.query) {
      const pairs = w.query.split('&').map((kv) => kv.split('='));
      const reply = await this.#control(pairs);
      this.#checkRejected(reply, pairs.map(([k]) => k), entry.label);
      return {};
    }
    if (w.path) {
      await this.#get(`${XC}${w.path}`);
      return {};
    }
    return super.action(entry);
  }

  // --- motion ----------------------------------------------------------------------

  /**
   * One control.cgi carrying both axes, so a diagonal starts as one move and an
   * axis returning to zero is stopped explicitly (`c.1.pan=stop` while tilting).
   * Direction words and speeds: XC5 p.149-152; pairing direction then speed in
   * one request as CCP does (src/actions.js:502).
   */
  async panTilt(pan, tilt) {
    const axis = (name, v, pos, neg) => {
      if (!v) return [[`c.1.${name}`, 'stop']];
      const pairs = [];
      if (this.speedMode) pairs.push([`c.1.${name}.speed.mode.dir`, this.speedMode]);
      pairs.push([`c.1.${name}`, v > 0 ? pos : neg], [`c.1.${name}.speed.dir`, panTiltSpeed(v)]);
      return pairs;
    };
    const build = () => [...axis('pan', pan, 'right', 'left'), ...axis('tilt', tilt, 'up', 'down')];
    const moving = [pan ? 'c.1.pan' : null, tilt ? 'c.1.tilt' : null].filter(Boolean);
    let reply;
    try {
      reply = await this.#control(build());
    } catch (err) {
      // If the camera will not take the speed mode from a sessionless client,
      // move without it rather than not at all, and stop asking.
      if (!this.speedMode || !moving.length || !['LS403', 'LS407', 'LS401'].includes(err.code)) throw err;
      this.log('warn', `pan/tilt speed mode not accepted (${err.message}); moving in the camera's own mode`);
      this.speedMode = null;
      reply = await this.#control(build());
    }
    if (this.speedMode && moving.length
        && ['pan', 'tilt'].some((a) => reply.get(`c.1.${a}.speed.mode.dir`)?.value === '?')) {
      this.log('warn', 'pan/tilt speed mode rejected; moving in the camera\'s own mode from now on');
      this.speedMode = null;
    }
    // An axis sent `stop` and answered `==?` did not stop: that is a failed
    // stop, not a detail (XC5 p.48, p.74).
    const stopping = [pan ? null : 'c.1.pan', tilt ? null : 'c.1.tilt'].filter(Boolean);
    await this.#throwIfStopRefused(reply, stopping, 'Pan/tilt');
    this.#checkRejected(reply, moving, 'Pan/tilt');
  }

  /**
   * Stop keys the camera answered `==?` to ("not valid in the current mode",
   * XC5 p.48, p.56, p.74): those axes were not stopped. A focus stop refused
   * while focus is on auto is the one exception — the manual focus drive it
   * would stop cannot be running then (focus mode `c.1.focus`, XC5 p.145).
   */
  async #stopRefusals(reply, keys) {
    const refused = keys.filter((k) => {
      const r = reply.get(k);
      return r && r.op === '==' && r.value === '?';
    });
    if (refused.includes('c.1.focus.action')) {
      let mode = null;
      try { mode = (await this.#info(['c.1.focus'])).get('c.1.focus'); } catch { /* unknown is not auto */ }
      if (mode === 'auto') refused.splice(refused.indexOf('c.1.focus.action'), 1);
    }
    return refused;
  }

  async #throwIfStopRefused(reply, keys, what) {
    const refused = await this.#stopRefusals(reply, keys);
    if (refused.length) {
      throw new DriverError(`${what}: the camera refused the stop (${refused.join(', ')} ==?) — it may still be moving`, { code: 'stopRejected', kind: 'refused' });
    }
  }

  /** XC5 p.148-149: `c.1.zoom=tele|wide|stop`, speed 0…15 on CR-N500. Positive is tele. */
  async zoom(speed) {
    if (!speed) {
      const reply = await this.#control([['c.1.zoom', 'stop']]);
      await this.#throwIfStopRefused(reply, ['c.1.zoom'], 'Zoom');
      return;
    }
    const reply = await this.#control([['c.1.zoom', speed > 0 ? 'tele' : 'wide'], ['c.1.zoom.speed.dir', zoomSpeed(speed)]]);
    this.#checkRejected(reply, ['c.1.zoom'], 'Zoom');
  }

  /**
   * XC5 p.145-146: `c.1.focus.action=near|far|stop`. The speed is not part of
   * the action but the stored MF speed (0…2), so it is set in the same request,
   * before the action. Focus is not switched to manual behind the operator's
   * back: in AF the camera's `==?` comes back as a refusal saying so.
   */
  async focus(speed) {
    if (!speed) {
      const reply = await this.#control([['c.1.focus.action', 'stop']]);
      await this.#throwIfStopRefused(reply, ['c.1.focus.action'], 'Focus');
      return;
    }
    const reply = await this.#control([['c.1.focus.speed', focusSpeed(speed)], ['c.1.focus.action', speed > 0 ? 'far' : 'near']]);
    this.#checkRejected(reply, ['c.1.focus.action'], 'Focus (switch focus to manual first)');
  }

  /**
   * XC has no single stop-all (notes §5.2, derived). The sequence:
   *   1. one request stopping pan, tilt, zoom and focus (XC5 p.145-151); a
   *      stop answered `==?` was not carried out (#stopRefusals);
   *   2. `p.action=stop`, which cancels a preset move in progress (XC5 p.153);
   *   3. read the moving flags (`c.1.pan|tilt|zoom.status`, `p.status`: 0
   *      stopped, 1 moving, XC5 p.148-152), and repeat 1 (and 2) once if
   *      anything still reports moving — XC5 p.72 says a multi-item request
   *      may be only partly carried out;
   *   4. after that second stop, read the flags again (a few times over half a
   *      second: a head decelerates), and if anything still reports moving,
   *      that is a failed stop.
   * Every step is attempted even if an earlier one failed; the first failure
   * is thrown at the end so the motion controller retries. A flag read that
   * fails is not a failure in itself — the stops were taken — only a flag
   * read that says "moving" after two stops is.
   */
  async stop() {
    const axes = [['c.1.pan', 'stop'], ['c.1.tilt', 'stop'], ['c.1.zoom', 'stop'], ['c.1.focus.action', 'stop']];
    let first = null;
    const attempt = async (pairs) => {
      try {
        const reply = await this.#control(pairs);
        // `p.action=stop` with no preset running may well be `==?`; p.status says whether one is.
        await this.#throwIfStopRefused(reply, pairs.map(([k]) => k).filter((k) => k !== 'p.action'), 'Stop');
      } catch (err) { first ??= err; }
    };
    const FLAGS = ['c.1.pan.status', 'c.1.tilt.status', 'c.1.zoom.status', 'p.status'];
    const stillMoving = async () => {
      try {
        const got = await this.#info(FLAGS);
        return FLAGS.filter((k) => got.get(k) === '1');
      } catch { return null; }
    };
    await attempt(axes);
    await attempt([['p.action', 'stop']]);
    let still = await stillMoving();
    if (still?.length) {
      if (still.some((k) => k !== 'p.status')) await attempt(axes);
      if (still.includes('p.status')) await attempt([['p.action', 'stop']]);
      for (let i = 0; i < 4; i++) {
        if (i) await sleep(150);
        still = await stillMoving();
        if (!still?.length) break;
      }
      if (still?.length) {
        first ??= new DriverError(`the head still reports moving (${still.join(', ')}) after two stops`, { code: 'stillMoving', kind: 'refused' });
      }
    }
    if (first) throw first;
  }

  #normalise(axis, raw) {
    const v = Number(raw);
    if (!Number.isFinite(v)) return null;
    const key = POSITION_KEYS[axis];
    const min = Number(this.cache.get(`${key}.min`) ?? TRAVEL[axis].min);
    const max = Number(this.cache.get(`${key}.max`) ?? TRAVEL[axis].max);
    if (!(max > min)) return null;
    // Zoom positions run from the telephoto end (low) to wide (high) — derived
    // from the sample dump, XC5 p.60 — so 0 = wide, 1 = tele as elsewhere.
    return axis === 'zoom' ? clamp01((max - v) / (max - min)) : clamp01((v - min) / (max - min));
  }

  /** Pan/tilt in 0.01°, right and up positive (XC5 p.149, p.151); zoom and focus positions (p.145, p.148). */
  async position() {
    const got = await this.#info(Object.values(POSITION_KEYS));
    const out = {};
    for (const [axis, key] of Object.entries(POSITION_KEYS)) out[axis] = this.#normalise(axis, got.get(key));
    return out;
  }

  /**
   * `p.status` is the cheap proof of life here (status() must reach the camera:
   * the lifecycle counts it as an answer). The last recalled preset `p` comes
   * from the event stream, because asking for `p` returns all 100 presets'
   * sub-items with it (XC5 p.54-55, p.152).
   */
  async status() {
    await this.#info(['p.status']);
    const out = {};
    const p = Number(this.cache.get('p'));
    if (Number.isInteger(p)) out.preset = p > 0 ? p : null;
    if (this.trackingAddon && !this.#shouldYield()) {
      try {
        const cfg = await this.#addonConfig();
        if (cfg && cfg.trackingEnable !== undefined) out.tracking = String(cfg.trackingEnable) === '1';
      } catch { /* the add-on not answering is not the camera not answering */ }
    }
    return out;
  }

  // --- presets ---------------------------------------------------------------------

  /**
   * `control.cgi?p=<n>` (XC5 p.76). An empty slot is refused here rather than
   * sent: `p.<n>.content` reads `disabled` for it (XC5 p.152-153). `o.speed`
   * (0–1, or 1–100) becomes `p.ptzspeed` 1…100, the synchronised PTZ speed;
   * without it the preset moves at its own stored speeds.
   */
  async presetRecall(n, o = {}) {
    const got = await this.#info([`p.${n}.content`]);
    if (got.get(`p.${n}.content`) === 'disabled') throw new DriverError(`preset ${n} is empty`, { code: 'empty' });
    const pairs = [['p', n]];
    const s = Number(o?.speed);
    if (Number.isFinite(s) && s > 0) {
      pairs.push(['p.ptzspeed', Math.max(1, Math.min(100, Math.round(s <= 1 ? s * 100 : s)))]);
    }
    const reply = await this.#control(pairs);
    this.#checkRejected(reply, ['p'], `Preset ${n}`);
  }

  /**
   * `preset/set` (XC5 p.93-96). Stores position and focus only. Exposure,
   * white balance, IS and custom picture are left out on purpose: a preset
   * recalled on air should move the shot, not change the look of the picture.
   */
  async presetStore(n) {
    await this.#get(`${XC}preset/set?${query([['p', n], ['ptz', 'enabled'], ['focus', 'enabled'],
      ['exp', 'disabled'], ['wb', 'disabled'], ['is', 'disabled'], ['cp', 'disabled']])}`);
  }

  /** `preset/set?p=<n>&cmd=delete` (XC5 p.94). CCP uses `all=disabled` instead (impl). */
  async presetDelete(n) {
    await this.#get(`${XC}preset/set?p=${n}&cmd=delete`);
  }

  // --- picture, tally ----------------------------------------------------------------

  /**
   * `image.cgi?v=jpg:640x360` (XC5 p.83-86), sessionless: a multiview tile does
   * not need more, and 640x360 is in the CR-N500's JPEG size list (XC5
   * p.126-127). If no stream matches, the camera gives the next smaller size.
   */
  async snapshot() {
    const r = await this.#get(`${XC}image.cgi?v=jpg:640x360`, { pace: false, timeoutMs: Math.max(this.timeoutMs, 4000) });
    const type = String(r.headers?.['content-type'] ?? '');
    if (!type.startsWith('image/')) throw new DriverError('the camera did not send a picture');
    return { contentType: type.split(';')[0], body: r.body };
  }

  /**
   * One lamp and one mode (XC5 p.155): `f.tally=on|off`, `f.tally.mode=program|preview`.
   * Program wins when both are asked — the camera on air must say so — and CCP
   * makes the same choice (src/actions.js:208-221). Lamp then mode in one
   * request, in CCP's order (src/actions.js:212); whether order matters is not
   * stated.
   */
  async setTally({ program, preview } = {}) {
    if (program) await this.#control([['f.tally', 'on'], ['f.tally.mode', 'program']]);
    else if (preview) await this.#control([['f.tally', 'on'], ['f.tally.mode', 'preview']]);
    else await this.#control([['f.tally', 'off']]);
  }

  // --- push ------------------------------------------------------------------------

  /**
   * The sessionless event stream: `info.cgi?type=stream` sends everything
   * asked for, then only what changes, as multipart parts (XC5 p.47-54,
   * p.70-71). It counts against the camera's client limit (number unknown), so
   * there is only ever one per camera, it backs right off when the camera says
   * it is full, and `options.push: false` turns it off.
   */
  subscribe({ onValues, onPtz } = {}) {
    if (this.options.push === false || this.closed) return;
    this.sub = { onValues: onValues ?? (() => {}), onPtz: onPtz ?? (() => {}) };
    this.streamAttempts = 0;
    this.#openStream();
  }

  #openStream(authorization) {
    if (this.closed || !this.sub) return;
    // c, f and p: camera settings and positions, tally/standby, and the last recalled preset.
    const path = `${XC}info.cgi?type=stream&item=c,f,p&timeout=${STREAM_TIMEOUT_S}&interval=${STREAM_INTERVAL_MS}`;
    const headers = authorization ? { Authorization: authorization } : {};
    let req;
    try {
      req = http.request({ host: this.host, port: this.port, path, headers, agent: false, insecureHTTPParser: true });
    } catch (err) {
      this.#retryStream(STREAM_RETRY_MS.at(-1), err.message);
      return;
    }
    this.stream = req;
    // Events from a request we have already given up on (replaced after a 401,
    // or closed) must not tear down its successor.
    const fail = (delay, why) => { if (this.stream === req) this.#retryStream(delay, why); };
    const watchdog = () => {
      clearTimeout(this.streamWatch);
      this.streamWatch = setTimeout(() => req.destroy(new Error('event stream went quiet')), (STREAM_TIMEOUT_S + 15) * 1000);
      this.streamWatch.unref?.();
    };
    watchdog();
    req.on('response', (res) => {
      if (res.statusCode === 401 && !authorization && this.auth?.username) {
        res.resume();
        const c = parseChallenge(res.headers['www-authenticate']);
        const user = this.auth.username;
        const pass = this.auth.password ?? '';
        const key = `${this.host}:${this.port}`;
        clearTimeout(this.streamWatch);
        let header = null;
        if (c?.scheme === 'digest') {
          rememberScheme(key, 'digest');
          header = digestHeader({ username: user, password: pass, method: 'GET', uri: path, challenge: c, nc: 1 });
        } else if (c?.scheme === 'basic') {
          // Digest seen on the stream, or on ordinary requests to this camera.
          if (streamSchemes.get(key) === 'digest' || knownScheme(this.host, this.port) === 'digest') {
            this.log('warn', 'event stream: the camera asked for Basic after using Digest — the password was not sent');
            fail(STREAM_BUSY_RETRY_MS, 'Basic asked for after Digest; password not sent');
            return;
          }
          rememberScheme(key, 'basic');
          header = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
        }
        if (header) { this.stream = null; req.destroy(); this.#openStream(header); } else fail(STREAM_BUSY_RETRY_MS, 'unknown authentication scheme');
        return;
      }
      const ls = String(res.headers['livescope-status'] ?? '').trim();
      const type = String(res.headers['content-type'] ?? '');
      if (res.statusCode !== 200 || ls !== '0' || !/multipart/i.test(type)) {
        res.resume();
        const busy = ['503', '508'].includes(ls) || res.statusCode === 503 || res.statusCode === 401;
        fail(busy ? STREAM_BUSY_RETRY_MS : undefined, `HTTP ${res.statusCode}, status ${ls || 'none'}`);
        return;
      }
      const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1] ?? 'boundary';
      const reader = new MultipartReader(boundary, (body) => {
        this.streamAttempts = 0;
        this.#onStreamPart(body);
      });
      res.on('data', (chunk) => {
        watchdog();
        try { reader.push(chunk); } catch (err) { req.destroy(err); }
      });
      res.on('end', () => fail(undefined, 'ended'));
      res.on('error', () => {});
    });
    req.on('error', (err) => fail(undefined, err.message));
    req.on('close', () => fail(undefined, 'closed'));
    req.end();
  }

  /** Quietly, with backoff. Safe to call several times for one failure. */
  #retryStream(delay, why) {
    clearTimeout(this.streamWatch);
    if (this.closed || this.streamRetry) return;
    const old = this.stream;
    this.stream = null;
    old?.destroy();
    const ms = delay ?? STREAM_RETRY_MS[Math.min(this.streamAttempts ?? 0, STREAM_RETRY_MS.length - 1)];
    this.streamAttempts = (this.streamAttempts ?? 0) + 1;
    this.log('debug', `event stream: ${why}; reopening in ${Math.round(ms / 1000)}s`);
    this.streamRetry = setTimeout(() => {
      this.streamRetry = null;
      this.#openStream();
    }, ms);
    this.streamRetry.unref?.();
  }

  #onStreamPart(body) {
    const changed = new Set();
    for (const [k, op, v] of parseXc(body)) {
      if (op === '=') continue;
      this.cache.set(k, v);
      changed.add(k);
    }
    if (!changed.size) return;   // a timestamp-only keepalive

    const values = {};
    const visible = new Set(this.schema().map((e) => e.id));
    for (const e of this.entries) {
      if (!visible.has(e.id) || !e.wire?.key || e.type === 'action') continue;
      const g = e.gate && this.byId.get(e.gate.id);
      const touched = changed.has(e.wire.key) || changed.has(`${e.wire.key}.list`) || (g?.wire?.key && changed.has(g.wire.key));
      if (!touched || !this.cache.has(e.wire.key)) continue;
      values[e.id] = this.#valueOf(e, this.cache);
    }
    try {
      if (Object.keys(values).length) this.sub.onValues(values);
      const ptz = {};
      for (const [axis, key] of Object.entries(POSITION_KEYS)) {
        if (changed.has(key)) ptz[axis] = this.#normalise(axis, this.cache.get(key));
      }
      if (changed.has('p')) {
        const p = Number(this.cache.get('p'));
        if (Number.isInteger(p)) ptz.preset = p > 0 ? p : null;
      }
      if (Object.keys(ptz).length) this.sub.onPtz(ptz);
    } catch (err) {
      this.log('debug', `event stream handler failed: ${err.message}`);
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.streamRetry);
    clearTimeout(this.streamWatch);
    this.streamRetry = null;
    this.stream?.destroy();
    this.stream = null;
  }
}

/**
 * The tracking add-on's config reply. CCP treats it as an object with string
 * values (axios parses JSON; src/actions.js:3326), so JSON first; `key=value`
 * lines as a fallback, since the real format is not documented anywhere.
 */
export function parseAddonConfig(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try {
    const j = JSON.parse(t);
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
  } catch { /* not JSON */ }
  const out = {};
  for (const line of t.split(/\r?\n|&/)) {
    const m = /^\s*([A-Za-z]\w*)\s*(?::=|=)\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return Object.keys(out).length ? out : null;
}

export default CanonXcPtz;
