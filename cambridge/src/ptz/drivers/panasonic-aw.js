// Panasonic integrated cameras (AW-UE160) over the HTTP CGI protocol.
//
// Every command is one HTTP GET carrying the camera's own command string:
// pan/tilt-head commands to /cgi-bin/aw_ptz (they start with '#', which has to
// be sent as %23), camera commands to /cgi-bin/aw_cam. The reply body is the
// answer — an echo for a setting, the value for a query, or ER1/ER2/ER3.
// (IF p.5, p.7, p.19-20; IF = AW-UE160 Interface Specification, Mar. 1 2025.)
//
// Changes made elsewhere (the camera's menu, a Panasonic RP panel, its web
// page) arrive through the update notification: CamBridge registers a TCP
// port and the camera connects back to it with each change (IF p.9-12). That
// is the one place this driver opens a listening socket.
//
// Spec notes: scratchpad specs/panasonic-aw-ue160.md (sections cited as §n).

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { PtzDriver, DriverError } from '../driver.js';
import { TABLE } from '../tables/panasonic-aw-ue160.js';

// The spec asks for a 16 ms gap between pan/tilt-head commands, over IP as over
// RS-422 (IF p.6, p.8). It gives no figure for aw_cam commands (§2: UNKNOWN), so
// the same floor is applied to every request rather than guessing a smaller one.
const MIN_GAP_MS = 16;

// The usable pan/tilt range as the #APC remark prints it (IF p.78): pan 2D09h
// (−175°) – D2F5h (+175°); tilt 8E38h (−30°) – 1C71h (+210°). Tilt counts run
// the other way (0000h = UP LIMIT, FFFFh = DOWN LIMIT), so "up" is the smaller
// number. Normalising across these is derived, not stated: confirm on a camera.
const PAN_MIN = 0x2D09, PAN_MAX = 0xD2F5;
const TILT_DOWN = 0x8E38, TILT_UP = 0x1C71;
// Zoom 555h = WIDE … FFFh = TELE, focus 555h = NEAR … FFFh = FAR (IF p.67, p.80).
const LENS_MIN = 0x555, LENS_MAX = 0xFFF;

// #UPVS in SPEED TABLE unit: 001–999 fall into 30 bands (IF p.83). The first
// value of each band, speed 1…30; 999 (and 000) is speed 30.
const UPVS_BANDS = [1, 276, 302, 328, 354, 380, 405, 431, 457, 483, 509, 535, 560, 586, 612, 638, 664, 690,
  715, 741, 767, 793, 819, 845, 870, 896, 922, 948, 974, 999];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const pad = (n, w, base = 10) => n.toString(base).toUpperCase().padStart(w, '0');

/**
 * -1..1 onto the 2-digit speed scale every Panasonic velocity command uses:
 * 01 = full one way, 49 = slowest that way, 50 = stop, 51 = slowest the other
 * way, 99 = full (#PTS, #Z, #F, #HV1: IF p.67, p.77, p.81). Any non-zero input
 * moves at least at the slowest speed. The spec lists only the end points and
 * the stop; that the steps between are linear is assumed (§5).
 */
export function speedCode(v) {
  if (!Number.isFinite(v) || v === 0) return '50';
  const k = Math.max(1, Math.min(49, Math.round(Math.abs(v) * 49)));
  return pad(v > 0 ? 50 + k : 50 - k, 2);
}

/** URL form of a command: '#' must travel as %23 (IF p.7); ':' is left as the spec's examples write it. */
export function commandUrl(path, cmd) {
  const enc = encodeURIComponent(cmd).replace(/%3A/gi, ':');
  return `/cgi-bin/${path === 'ptz' ? 'aw_ptz' : 'aw_cam'}?cmd=${enc}&res=1`;
}

// --- values ↔ data ---------------------------------------------------------------

const isHex = (s) => /^[0-9A-Fa-f]+$/.test(s);

function decimalsOf(x) {
  const s = String(x);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

/** Turns the data part of a reply into a value for the entry. `undefined` when the data does not fit. */
export function decode(entry, data) {
  const c = entry.wire.codec;
  if (!c) return undefined;
  const d = String(data).trim();
  switch (c.k) {
    case 'bool': {
      if (!isHex(d)) return undefined;
      return parseInt(d, c.base) !== parseInt(c.f, c.base);
    }
    case 'enum': {
      if (!isHex(d)) return undefined;
      const n = parseInt(d, c.base);
      const o = entry.options.find((x) => parseInt(x.value, c.base) === n);
      return o ? o.value : d.toUpperCase();
    }
    case 'map': {
      const v = c.r[parseInt(d, 10)];
      return v ?? d;
    }
    case 'lin': {
      let f = d;
      if (c.field !== undefined) f = d.split(':')[c.field] ?? '';
      const sp = c.special && Object.entries(c.special).find(([k]) => k.toUpperCase() === f.toUpperCase());
      if (sp) return sp[1];
      if (!isHex(f)) return undefined;
      const n = parseInt(f, c.base);
      const v = c.a * n + c.b;
      const dec = Math.max(decimalsOf(c.a), decimalsOf(entry.range?.step ?? 1));
      return Number(v.toFixed(dec));
    }
    case 'band': {
      if (!/^\d+$/.test(d)) return undefined;
      const n = parseInt(d, 10);
      if (n === 0 || n >= 999) return 30;
      let speed = 1;
      for (const [i, lo] of UPVS_BANDS.entries()) if (n >= lo) speed = i + 1;
      return speed;
    }
    case 'ascii': {
      if (!isHex(d)) return undefined;
      let s = '';
      for (let i = 0; i + 1 < d.length; i += 2) {
        const code = parseInt(d.slice(i, i + 2), 16);
        if (code === 0) break;
        s += String.fromCharCode(code);
      }
      return s.replace(/\s+$/, '');
    }
    case 'bits': {
      if (!isHex(d)) return d;
      const n = parseInt(d, 16);
      if (n === 0) return 'No error';
      return c.names.filter((_, i) => n & (1 << i)).join(', ') || `code ${d}`;
    }
    case 'raw':
    default:
      return d;
  }
}

/** The data part of a set command for a value already checked by schema.coerce. */
export function encode(entry, value) {
  const c = entry.wire.codec;
  switch (c?.k) {
    case 'bool': return value ? c.t : c.f;
    case 'enum': return String(value);
    case 'map': {
      const w = c.w[value];
      if (w === undefined) throw new DriverError(`${entry.label} cannot be set to that`, { kind: 'refused' });
      return w;
    }
    case 'lin': {
      const n = Math.round((Number(value) - c.b) / c.a);
      if (n < 0) throw new DriverError(`${entry.label} cannot be set to ${value}`, { kind: 'refused' });
      return pad(n, c.w, c.base) + (c.suffix ?? '');
    }
    case 'band': {
      const s = Math.max(1, Math.min(30, Math.round(Number(value))));
      return pad(UPVS_BANDS[s - 1], 3);
    }
    case 'ascii': {
      let hex = '';
      for (const ch of String(value).slice(0, c.chars)) hex += pad(ch.charCodeAt(0) & 0x7f, 2, 16);
      return hex.padEnd(c.chars * 2, '0');
    }
    case 'raw': return String(value);
    default:
      throw new DriverError(`${entry.label} cannot be changed from here`, { kind: 'unsupported' });
  }
}

/**
 * Splits the update-notification stream into messages.
 *
 * Framing per IF p.10: Reserve 22 bytes, Size 2 bytes, Reserve 4 bytes, the
 * information (Size − 8 bytes, at most 504), Reserve 24 bytes; the information
 * is `\r\n<reply string>\r\n`. The byte order of Size is not stated (§4.1):
 * big-endian is tried first, little-endian if that gives an impossible length.
 * A frame that cannot be made sense of is left for `scanText` once the camera
 * closes the connection — the Companion module's way, looking only for the
 * CRLF-wrapped text.
 *
 * @param {Buffer} buf
 * @param {{final?: boolean}} [o]  the camera has closed the connection: a
 *   last frame whose trailing reserve never came is still read
 * @returns {{messages: string[], rest: Buffer, stuck: boolean}}
 */
export function parseNotifications(buf, { final = false } = {}) {
  const messages = [];
  let b = buf;
  while (b.length >= 28) {
    let len = b.readUInt16BE(22) - 8;
    if (!(len >= 0 && len <= 504)) len = b.readUInt16LE(22) - 8;
    if (!(len >= 0 && len <= 504)) return { messages, rest: b, stuck: true };
    const total = 28 + len + 24;
    if (b.length < (final ? 28 + len : total)) break;
    const info = b.subarray(28, 28 + len).toString('latin1');
    const lines = info.split('\r\n').map((s) => s.trim()).filter((s) => /^[\x21-\x7e][\x20-\x7e]*$/.test(s));
    if (!lines.length) return { messages, rest: b, stuck: true };
    messages.push(...lines);
    b = b.subarray(Math.min(total, b.length));
  }
  return { messages, rest: b, stuck: false };
}

/** Last resort for bytes that did not frame: every CRLF-wrapped printable string in them. */
export function scanText(buf) {
  const s = buf.toString('latin1');
  const out = [];
  const re = /\r\n([\x21-\x7e][\x20-\x7e]*?)\r\n/g;
  let m;
  while ((m = re.exec(s)) !== null) { out.push(m[1].trim()); re.lastIndex -= 2; }
  return out;
}

// Longest reply prefix first, so 'pTS…' is never read as power 'p…'.
const PREFIXES = (() => {
  const list = [];
  for (const e of TABLE) {
    if (!e.wire.codec || e.wire.via || e.type === 'action') continue;
    for (const p of [e.wire.r, ...(e.wire.alt ?? [])]) if (p && e.wire.path !== 'cgi') list.push([p, e]);
  }
  return list.sort((a, b) => b[0].length - a[0].length);
})();

/**
 * Finds the entries a reply line carries a value for. A prefix without a ':'
 * separator (the ptz replies) only matches when the data is exactly as wide as
 * the entry's, so 'p' (power) does not swallow 'pE000000000313'.
 */
export function matchLine(line) {
  const text = line.replace(/:0x/gi, ':');   // camdata.html writes hex as 0x.. (IF ch. 9)
  const hits = [];
  let best = -1;
  for (const [p, e] of PREFIXES) {
    if (best > p.length) break;
    if (!text.startsWith(p)) continue;
    const data = text.slice(p.length);
    const c = e.wire.codec;
    if (!p.endsWith(':') && c.w && ['bool', 'enum', 'lin'].includes(c.k) && !c.field && data.length !== c.w) continue;
    const value = decode(e, data);
    if (value === undefined) continue;
    best = p.length;
    hits.push([e, value]);
  }
  return hits;
}

/** key=value lines of a web CGI reply (WEB: "key=value" CRLF, sometimes with spaces around '='). */
function keyValues(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([^=\s]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

const STANDBY = 'the camera is in standby (or busy) — power it on, or wait, and try again';

export class PanasonicAw extends PtzDriver {
  static vendor = 'panasonic';
  static label = 'Panasonic';
  static models = ['AW-UE160'];
  static minIntervalMs = MIN_GAP_MS;
  // Most values come from one /live/camdata.html read; the rest are one
  // request each, so a batch stays small enough to keep moves responsive.
  static readBatch = 8;

  /**
   * Read-only: QID answers "OID:AW-…" (IF p.97, §3). `/cgi-bin/aw_cam` with an
   * OID reply is Panasonic's alone among the vendors CamBridge knows.
   */
  static async probe(ctx) {
    const r = await ctx.http({
      host: ctx.host, port: ctx.port ?? 80, path: commandUrl('cam', 'QID'), auth: ctx.auth,
      timeoutMs: ctx.timeoutMs ?? 2500, headers: { Connection: 'close' },
    });
    if (r.kind === 'auth') throw new DriverError('the camera refused the username or password', { kind: 'auth' });
    if (!r.ok) return null;
    const m = /^OID:(AW-[\w-]+)/.exec(String(r.text ?? '').trim());
    if (!m) return null;
    return { vendor: 'panasonic', model: m[1] };
  }

  constructor(ctx) {
    super(ctx);
    this.port = ctx.port ?? 80;
    this.timeoutMs = ctx.timeoutMs ?? 3000;
    this.options = ctx.options ?? {};
    this.hasTracking = false;
    /** Last value seen per entry id, for gates. */
    this.known = new Map();
    this.camdata = { ok: this.options.camdata !== false, at: 0, map: null, seen: new Set() };
    this.lastStart = 0;
    this.chain = Promise.resolve();
    /** False after a timeout or network failure, until a request gets through. */
    this.reachable = true;
    this.push = null;
    this.closed = false;
    this.byId = new Map(TABLE.map((e) => [e.id, e]));
  }

  // --- transport ------------------------------------------------------------------

  /**
   * One HTTP request, after the previous one and at least 16 ms after it began.
   *
   * `Connection: close` on every request: the spec says the camera does not
   * keep HTTP connections alive and connects and disconnects for each command
   * (IF p.8). The shared transport pools keep-alive sockets per host; without
   * this, the next command would be written to a socket the camera has already
   * dropped.
   */
  #get(path, { timeoutMs = this.timeoutMs } = {}) {
    const run = async () => {
      const wait = this.lastStart + MIN_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastStart = Date.now();
      const r = await this.http({
        host: this.host, port: this.port, path, auth: this.auth, timeoutMs,
        headers: { Connection: 'close' },
      });
      this.reachable = r.kind !== 'timeout' && r.kind !== 'network';
      return r;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  /** Whole-call failures from the transport, as DriverErrors. Credentials never appear in messages. */
  static #transportError(r) {
    if (r.kind === 'auth') return new DriverError('the camera refused the username or password', { kind: 'auth' });
    if (r.kind === 'timeout') return new DriverError('the camera did not answer in time', { kind: 'timeout' });
    if (r.kind === 'network') return new DriverError(`cannot reach the camera (${r.error})`, { kind: 'network' });
    if (r.status === 403) return new DriverError('the camera needs an administrator login for this', { kind: 'auth', code: 'HTTP403' });
    if (r.status === 404) return new DriverError('the camera does not offer this', { kind: 'unsupported', code: 'HTTP404' });
    return new DriverError(`the camera answered HTTP ${r.status}`, { kind: 'refused', code: `HTTP${r.status}` });
  }

  /**
   * Sends one command and returns the reply text. ER1/ER2/ER3 (eR… for ptz
   * commands) become DriverErrors: ER1 = unsupported command, ER2 = standby or
   * busy, ER3 = outside the acceptable range (IF p.19-20). All three mean the
   * camera answered, so none counts against its health.
   */
  async #cmd(path, cmd) {
    const r = await this.#get(commandUrl(path, cmd));
    if (!r.ok) throw PanasonicAw.#transportError(r);
    const text = String(r.text ?? '').trim();
    const m = /^[eE]R([123]):(.*)$/.exec(text);
    if (m) {
      const code = `ER${m[1]}`;
      if (code === 'ER1') throw new DriverError('the camera does not support this command', { kind: 'unsupported', code });
      if (code === 'ER2') throw new DriverError(STANDBY, { kind: 'refused', code });
      throw new DriverError('the camera refused the value as out of range', { kind: 'refused', code });
    }
    return text;
  }

  async #cgi(path) {
    const r = await this.#get(path);
    if (!r.ok) throw PanasonicAw.#transportError(r);
    return String(r.text ?? '');
  }

  // --- identity -------------------------------------------------------------------

  async identify() {
    let model = null;
    let standby = false;
    try {
      const id = await this.#cmd('cam', 'QID');                    // IF p.97
      model = /^OID:(.+)$/.exec(id)?.[1] ?? null;
      if (!model) throw new DriverError('this does not answer like a Panasonic camera', { kind: 'refused' });
    } catch (err) {
      if (err.code !== 'ER2') throw err;
      standby = true;
    }
    const identity = { vendor: 'panasonic', model: model ?? 'AW-UE160' };
    const soft = async (fn) => { try { return await fn(); } catch (err) { if (['timeout', 'network', 'auth'].includes(err.kind) && err.code !== 'HTTP403') throw err; return null; } };
    const fw = await soft(() => this.#cmd('cam', 'QSV'));          // OSV:Vxx.xx, IF p.92
    if (fw) identity.firmware = /^OSV:(.+)$/.exec(fw)?.[1];
    const title = await soft(() => this.#cmd('cam', 'QSJ:5C'));    // OSJ:5C:<hex>, IF p.97
    const titleEntry = this.byId.get('cameraTitle');
    if (title?.startsWith(titleEntry.wire.r)) identity.name = decode(titleEntry, title.slice(titleEntry.wire.r.length));
    const info = await soft(() => this.#cgi('/cgi-bin/getinfo?FILE=1'));   // WEB p.8-10 (Live level)
    if (info) {
      const kv = Object.fromEntries(keyValues(info));
      if (kv.MAC) identity.mac = kv.MAC;
      if (kv.SERIAL) identity.serial = kv.SERIAL;
      if (!model && kv.NAME) identity.model = kv.NAME;
    }
    if (standby) identity.standby = true;
    // Auto tracking: the UE160 spec documents only a status query (QSL:B6),
    // no command to turn tracking on or off, and Auto Framing has no command
    // at all — it runs from Panasonic Media Production Suite on a PC (§9, FW
    // 2.01 notes). So tracking is reported, read-only, when the camera answers
    // that query, and CamBridge offers no tracking controls.
    const b6 = await (async () => { try { return await this.#cmd('cam', 'QSL:B6'); } catch (err) { return err; } })();
    if (b6 instanceof DriverError) {
      if (['timeout', 'network'].includes(b6.kind)) throw b6;
      this.hasTracking = b6.code !== 'ER1' && b6.code !== 'HTTP404';
    } else {
      this.hasTracking = b6.startsWith('OSL:B6:');
    }
    return identity;
  }

  /**
   * #O, the power state. A camera in standby still answers it; one that
   * answers "busy" is alive too, so a refusal is not a missed heartbeat.
   */
  async heartbeat() {
    try {
      await this.#cmd('ptz', '#O');                                // IF p.97
    } catch (err) {
      if (err.kind === 'refused' || err.kind === 'unsupported') return;
      throw err;
    }
  }

  schema() {
    // Rows reached through the joystick, presets or push are not settings;
    // tracking rows only exist on a camera that reports tracking.
    return TABLE.filter((e) => !e.wire.via && (e.requires !== 'tracking' || this.hasTracking));
  }

  capabilities() {
    return {
      panTilt: true, zoom: true, focus: true,
      presets: 100, presetBase: 1,                                  // PRESET001–100 (IF p.85)
      tracking: this.hasTracking ? { kind: 'externalTracking', label: 'Auto tracking (status only)' } : null,
      tally: true, snapshot: true, pointToCentre: false, power: false,
    };
  }

  // --- reading ----------------------------------------------------------------------

  /**
   * /live/camdata.html: most settings in one reply, one line each (IF p.18,
   * ch. 9 "camdata.html" column). Reused for a quarter of a second so a sweep
   * of small batches does not fetch it for every batch, and dropped after any
   * write so a re-read sees the change.
   */
  async #camdataMap() {
    if (!this.camdata.ok) return null;
    if (this.camdata.map && Date.now() - this.camdata.at < 250) return this.camdata.map;
    const r = await this.#get('/live/camdata.html');
    if (!r.ok) {
      if (r.kind === 'timeout' || r.kind === 'network') throw PanasonicAw.#transportError(r);
      // Not offered, or not with these credentials: ask setting by setting.
      this.camdata.ok = false;
      return null;
    }
    const map = new Map();
    for (const line of String(r.text ?? '').split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      for (const [e, value] of matchLine(t)) map.set(e.id, value);
    }
    this.camdata.map = map;
    this.camdata.at = Date.now();
    for (const id of map.keys()) this.camdata.seen.add(id);
    return map;
  }

  #forgetCamdata() { this.camdata.map = null; }

  /** One entry by its own query. Returns {value} or {error, unsupported?}; throws only for timeouts and network. */
  async #readOne(e) {
    const w = e.wire;
    try {
      if (w.path === 'cgi') return { value: await this.#readCgi(e) };
      if (w.codec?.k === 'presetEntries') return { value: await this.#presetEntries() };
      const text = await this.#cmd(w.path, w.q);
      if (!text.startsWith(w.r)) return { error: `unexpected reply "${text.slice(0, 40)}"` };
      const value = decode(e, text.slice(w.r.length));
      if (value === undefined) return { error: `unexpected reply "${text.slice(0, 40)}"` };
      return { value };
    } catch (err) {
      if (err.kind === 'timeout' || err.kind === 'network') throw err;
      if (err.kind === 'unsupported') return { error: err.message, unsupported: true };
      // Standby (ER2), a range complaint or a login the camera wants for this
      // CGI: the setting exists; it just has no value right now.
      return { error: err.message };
    }
  }

  async #readCgi(e) {
    const w = e.wire;
    const text = await this.#cgi(w.get);
    if (w.raw) return text.trim().slice(0, 2000);
    const kv = keyValues(text);
    if (w.key) {
      const hit = kv.find(([k]) => k === w.key);
      if (!hit) throw new DriverError(`no ${w.key} in the reply`, { kind: 'refused' });
      if (e.type === 'bool') return hit[1] === w.t;
      if (e.type === 'range') return Number(hit[1]);
      return hit[1];
    }
    const re = typeof w.summary === 'string' ? new RegExp(`^(${w.summary})`) : null;
    return kv.filter(([k]) => !re || re.test(k)).map(([k, v]) => `${k}=${v}`).join(', ').slice(0, 2000);
  }

  /** #PE00–#PE02: 40 presets per reply, bit 0 = Data1·40 + 1 (IF p.85). */
  async #presetEntries() {
    const stored = [];
    for (const block of [0, 1, 2]) {
      const text = await this.#cmd('ptz', `#PE${pad(block, 2)}`);
      const m = /^pE(\d\d)([0-9A-Fa-f]{10})$/.exec(text);
      if (!m) throw new DriverError(`unexpected reply "${text.slice(0, 40)}"`, { kind: 'refused' });
      const bits = BigInt(`0x${m[2]}`);
      for (let i = 0; i < 40; i++) if ((bits >> BigInt(i)) & 1n) stored.push(block * 40 + i + 1);
    }
    return stored.filter((n) => n <= 100).join(', ') || 'none';
  }

  #writable(e, values) {
    if (e.readOnly) return false;
    if (!e.gate) return undefined;
    const g = values[e.gate.id]?.value ?? this.known.get(e.gate.id);
    return g === undefined ? undefined : g === e.gate.value;
  }

  /**
   * A timeout or dropped connection while reading answers null rather than
   * throwing, and later reads answer null at once until any request gets
   * through again. The lifecycle's first full read after connecting is not
   * guarded against a throw (an unhandled rejection), and a camera lost in
   * the middle of that sweep would otherwise cost one timeout per batch before
   * the heartbeat could notice. Null leaves the lifecycle's proof-of-life
   * clock alone, so the heartbeat still decides health.
   */
  async read(entries) {
    if (!this.reachable) return null;
    try {
      return await this.#read(entries);
    } catch (err) {
      if (err.kind === 'timeout' || err.kind === 'network') return null;
      throw err;
    }
  }

  async #read(entries) {
    const out = {};
    const want = entries.filter((e) => e.type !== 'action' && !e.wire.via);
    for (const e of want.filter((x) => x.writeOnly)) out[e.id] = { value: '', writable: true };
    const queried = want.filter((e) => !e.writeOnly);
    if (!queried.length) return out;

    const cam = await this.#camdataMap();
    const values = {};
    if (cam) {
      // Everything camdata carried, not only what was asked: the lifecycle uses the extra.
      for (const [id, value] of cam) values[id] = { value };
    }
    for (const e of queried) {
      if (values[e.id]) continue;
      values[e.id] = await this.#readOne(e);
    }
    // A gate the batch did not include, asked once so writability is right.
    for (const e of queried) {
      if (!e.gate || values[e.gate.id] || this.known.has(e.gate.id)) continue;
      const g = this.byId.get(e.gate.id);
      if (g) values[g.id] = await this.#readOne(g);
    }
    for (const [id, r] of Object.entries(values)) if (r.value !== undefined) this.known.set(id, r.value);
    for (const [id, r] of Object.entries(values)) {
      const e = this.byId.get(id);
      if (!e) continue;
      if (r.error) { out[id] = r; continue; }
      const writable = this.#writable(e, values);
      out[id] = writable === undefined ? { value: r.value } : { value: r.value, writable };
    }
    return out;
  }

  // --- writing ----------------------------------------------------------------------

  /** The camera refuses some settings in some modes (IF section 8 remarks, §10c); say which before sending. */
  async #checkGate(e) {
    if (!e.gate) return;
    const g = this.byId.get(e.gate.id);
    const r = await this.#readOne(g);
    if (r.error) return;   // cannot tell: let the camera decide
    this.known.set(g.id, r.value);
    if (r.value === e.gate.value) return;
    const want = g.type === 'bool' ? (e.gate.value ? 'on' : 'off')
      : g.options?.find((o) => o.value === e.gate.value)?.label ?? e.gate.value;
    throw new DriverError(`${e.label} can only be changed while ${g.label} is ${want}`, { kind: 'refused', code: 'gate' });
  }

  async write(entry, value) {
    const w = entry.wire;
    if (entry.readOnly || entry.type === 'action') throw new DriverError(`${entry.label} is read-only`, { kind: 'refused' });
    if (w.via) throw new DriverError(`${entry.label} is not changed as a setting`, { kind: 'unsupported' });
    await this.#checkGate(entry);
    this.#forgetCamdata();
    if (w.path === 'cgi') {
      if (!w.set) throw new DriverError(`${entry.label} is changed in the camera's web page`, { kind: 'unsupported' });
      const v = entry.type === 'bool' ? (value ? w.t : w.f) : String(value);
      await this.#cgi(`${w.set}${encodeURIComponent(v)}`);
      this.known.set(entry.id, value);
      return {};
    }
    if (!w.s) throw new DriverError(`${entry.label} is read-only`, { kind: 'refused' });
    await this.#cmd(w.path, w.s + encode(entry, value));
    this.known.set(entry.id, value);
    return {};
  }

  async action(entry, payload) {
    const w = entry.wire;
    if (w.via) throw new DriverError(`${entry.label} is not offered here`, { kind: 'unsupported' });
    this.#forgetCamdata();
    if (w.path === 'cgi') {
      if (w.random) {
        // Randomnum: a hex string of 16 single-byte characters (WEB p.43).
        await this.#cgi(`${w.set}${randomBytes(8).toString('hex').toUpperCase()}`);
        return {};
      }
      const choice = typeof payload === 'string' ? payload : payload?.value;
      if (!w.choices?.includes(choice)) {
        throw new DriverError(`${entry.label} needs one of: ${w.choices.join(', ')}`, { kind: 'refused' });
      }
      await this.#cgi(`${w.set}${choice}`);
      return {};
    }
    let data = w.data ?? '';
    if (w.param) {
      const p = w.param;
      const raw = typeof payload === 'object' && payload !== null
        ? (payload.value ?? payload.preset ?? payload.n ?? payload.steps) : payload;
      const n = raw === undefined || raw === null || raw === '' ? p.dflt : Number(raw);
      if (!Number.isInteger(n) || n < p.min || n > p.max) {
        throw new DriverError(`${entry.label} needs a whole number from ${p.min} to ${p.max}`, { kind: 'refused' });
      }
      data = pad(n + p.off, p.w, p.base);
    } else if (w.textParam) {
      const t = typeof payload === 'string' ? payload : payload?.value;
      if (typeof t !== 'string' || !new RegExp(w.textParam).test(t)) {
        throw new DriverError(`${entry.label} needs a value in the form shown in its help`, { kind: 'refused' });
      }
      data = t.toUpperCase();
    }
    await this.#cmd(w.path, w.s + data);
    return {};
  }

  // --- motion ---------------------------------------------------------------------

  /**
   * #PTS: pan then tilt, 01 = left/down full, 50 = stop, 99 = right/up full
   * (IF p.77; the Companion module sends the same, src/actions.js:107-114).
   */
  async panTilt(pan, tilt) {
    this.#forgetCamdata();
    await this.#cmd('ptz', `#PTS${speedCode(pan)}${speedCode(tilt)}`);
  }

  /** #Z: 01 wide full … 49 wide slowest, 50 stop, 51 tele slowest … 99 tele full (IF p.67). */
  async zoom(speed) {
    await this.#cmd('ptz', `#Z${speedCode(speed)}`);
  }

  /** #F: 01 near full … 50 stop … 99 far full (IF p.67). */
  async focus(speed) {
    await this.#cmd('ptz', `#F${speedCode(speed)}`);
  }

  /**
   * Stop everything. #HV150505050 sets pan, tilt, zoom and focus to 50 (stop)
   * in one command — the only single stop-everything command in the spec
   * (IF p.81) — so it goes first. No implementation has been seen using it,
   * so the three per-axis stops the notes give as the fallback that always
   * works (#PTS5050, #Z50, #F50; IF p.67, p.77) follow it every time.
   * Throws when any per-axis stop did not reach the camera, so the motion
   * controller retries the whole set. "Busy" (ER2) is not a failure here: a
   * camera in standby has nothing moving.
   */
  async stop() {
    this.#forgetCamdata();
    const errors = [];
    try { await this.#cmd('ptz', '#HV150505050'); } catch (err) { if (['timeout', 'network', 'auth'].includes(err.kind)) errors.push(err); }
    for (const cmd of ['#PTS5050', '#Z50', '#F50']) {
      try { await this.#cmd('ptz', cmd); } catch (err) { if (err.code !== 'ER2') errors.push(err); }
    }
    if (errors.length) throw errors.find((e) => e.kind !== 'refused' && e.kind !== 'unsupported') ?? errors[0];
  }

  /** #PTV: pan, tilt (4 hex), zoom, focus, iris (3 hex) in one reply (IF p.80). */
  async position() {
    const text = await this.#cmd('ptz', '#PTV');
    const m = /^pTV([0-9A-Fa-f]{4})([0-9A-Fa-f]{4})([0-9A-Fa-f]{3})([0-9A-Fa-f]{3})([0-9A-Fa-f]{3})$/.exec(text);
    if (!m) throw new DriverError(`unexpected position reply "${text.slice(0, 40)}"`, { kind: 'refused' });
    const [p, t, z, f, i] = m.slice(1).map((h) => parseInt(h, 16));
    return {
      pan: clamp01((p - PAN_MIN) / (PAN_MAX - PAN_MIN)),
      tilt: clamp01((TILT_DOWN - t) / (TILT_DOWN - TILT_UP)),
      zoom: clamp01((z - LENS_MIN) / (LENS_MAX - LENS_MIN)),
      focus: clamp01((f - LENS_MIN) / (LENS_MAX - LENS_MIN)),
      raw: { pan: m[1], tilt: m[2], zoom: m[3], focus: m[4], iris: m[5] },
    };
  }

  /** Power state (#O: p1 on, p0 standby, p3 starting) and, where present, the tracking status. */
  async status() {
    const out = {};
    const p = await this.#cmd('ptz', '#O').catch((err) => { if (err.kind === 'timeout' || err.kind === 'network') throw err; return null; });
    const power = { 1: 'on', 0: 'standby', 3: 'starting' }[/^p(\d)$/.exec(p ?? '')?.[1]];
    if (power) out.power = power;
    if (this.hasTracking) {
      // Read-only: AUTO TRACKING MODE 0 OFF / 1 ON and TRACKING STATUS 0 NOT
      // TRACKING / 1 TRACKING / 2 LOST (IF p.38). There is no command to change either.
      const mode = await this.#readOne(this.byId.get('autoTrackingMode'));
      if (mode.value !== undefined) out.tracking = mode.value;
      const st = await this.#readOne(this.byId.get('trackingStatus'));
      if (st.value !== undefined) out.trackingState = { 0: 'idle', 1: 'tracking', 2: 'lost' }[Number(st.value)] ?? null;
    }
    return out;
  }

  // --- presets --------------------------------------------------------------------

  #presetData(n) {
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      throw new DriverError('preset numbers on this camera run 1–100', { kind: 'refused' });
    }
    return pad(n - 1, 2);   // data 00–99 = PRESET001–PRESET100 (IF p.85)
  }

  /**
   * #R[nn]. The reply (s[nn]) comes at once; the head reports arrival later
   * with a q[nn] push (IF p.16), which subscribe() turns into the reached preset.
   *
   * o.speed (1–30, or 0–1 as a fraction) sets the camera's preset speed
   * (#UPVS) first. That is a camera setting, not part of the recall, so it
   * stays until changed; and it is only sent while PRESET SPEED UNIT is
   * SPEED TABLE, since in TIME unit the same command means seconds (IF p.83).
   */
  async presetRecall(n, o = {}) {
    const data = this.#presetData(n);
    this.#forgetCamdata();
    if (Number.isFinite(o?.speed) && o.speed > 0) {
      const speed = o.speed <= 1 ? Math.max(1, Math.round(o.speed * 30)) : Math.min(30, Math.round(o.speed));
      const unit = await this.#readOne(this.byId.get('presetSpeedUnit'));
      if (unit.value === '0') await this.#cmd('ptz', `#UPVS${encode(this.byId.get('presetSpeed'), speed)}`);
      else this.log('debug', 'preset speed not set: PRESET SPEED UNIT is not SPEED TABLE');
    }
    const r = await this.#cmd('ptz', `#R${data}`);
    if (r !== `s${data}`) this.log('debug', `preset recall answered "${r}"`);
    return {};
  }

  async presetStore(n) {
    const data = this.#presetData(n);
    await this.#cmd('ptz', `#M${data}`);                           // IF p.85
    return {};
  }

  async presetDelete(n) {
    const data = this.#presetData(n);
    await this.#cmd('ptz', `#C${data}`);                           // IF p.85
    return {};
  }

  // --- picture and tally ----------------------------------------------------------

  /**
   * One JPEG from /cgi-bin/camera (WEB p.16-17): no UID needed, `page` defeats
   * caches. 640×360 by default — enough for a multiview tile or a preset
   * picture at about 60 KB (WEB p.11-12); `options.snapshotResolution` takes
   * 320, 640, 1280, 1920 or 3840. Not queued behind commands (it is the picture
   * path), so it does not go through the 16 ms command spacing either.
   */
  async snapshot() {
    const res = [320, 640, 1280, 1920, 3840].includes(Number(this.options.snapshotResolution))
      ? Number(this.options.snapshotResolution) : 640;
    const r = await this.http({
      host: this.host, port: this.port, path: `/cgi-bin/camera?resolution=${res}&page=${Date.now()}`,
      auth: this.auth, timeoutMs: this.timeoutMs, headers: { Connection: 'close' },
    });
    if (!r.ok) throw PanasonicAw.#transportError(r);
    if (!r.body?.length) throw new DriverError('the camera sent an empty picture', { kind: 'refused' });
    const type = String(r.headers?.['content-type'] ?? '');
    return { contentType: type.startsWith('image/') ? type : 'image/jpeg', body: r.body };
  }

  /** Red lamp = program (TLR), green = preview (TLG): the command tally inputs (IF p.36). */
  async setTally({ program = false, preview = false } = {}) {
    await this.#cmd('cam', `TLR:${program ? 1 : 0}`);
    await this.#cmd('cam', `TLG:${preview ? 1 : 0}`);
  }

  // --- push ------------------------------------------------------------------------

  /**
   * Update notifications (IF p.9-12, §4). CamBridge listens on a TCP port and
   * registers it with /cgi-bin/event?connect=start&my_port=P&uid=0; the camera
   * then connects to that port for each change. The camera has to reach
   * CamBridge, so the listener binds every interface — a firewall on the
   * CamBridge machine must allow inbound TCP from the cameras to it. The port
   * is ephemeral unless `options.notifyPort` fixes one (for such a firewall).
   *
   * One registration per camera: the camera serves at most five receivers at
   * once (IF p.12), and a Panasonic RP panel takes one of those. A failed
   * registration is logged and left: polling carries on regardless.
   */
  subscribe({ onValues, onPtz }) {
    if (this.options.push === false || this.push) return;
    this.push = { server: null, port: null, registered: false, sockets: new Set() };
    this.#startPush(onValues, onPtz).catch((err) => {
      this.log('warn', `change notifications unavailable: ${err.message}`);
      this.#stopPush();
    });
  }

  async #startPush(onValues, onPtz) {
    const push = this.push;
    const server = net.createServer((sock) => this.#accept(sock, onValues, onPtz));
    push.server = server;
    server.on('error', (err) => this.log('warn', `notification listener: ${err.message}`));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(this.options.notifyPort) || 0, () => { server.off('error', reject); resolve(); });
    });
    push.port = server.address().port;
    if (this.closed || this.push !== push) { server.close(); return; }
    const r = await this.#get(`/cgi-bin/event?connect=start&my_port=${push.port}&uid=0`);   // IF p.11: 204 No Content
    if (!r.ok) throw PanasonicAw.#transportError(r);
    push.registered = true;
    if (this.closed || this.push !== push) { this.#deregister(push.port); return; }
    this.log('debug', `change notifications on port ${push.port}`);
  }

  #accept(sock, onValues, onPtz) {
    const from = String(sock.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (net.isIP(this.host) && from !== this.host) { sock.destroy(); return; }
    const push = this.push;
    if (!push) { sock.destroy(); return; }
    push.sockets.add(sock);
    let buf = Buffer.alloc(0);
    const deliver = (lines) => { for (const l of lines) this.#notified(l, onValues, onPtz); };
    sock.setTimeout(30_000, () => sock.destroy());
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // A stream that never frames is kept only as far as scanText needs it.
      if (buf.length > 64 * 1024) buf = buf.subarray(buf.length - 4096);
      const { messages, rest } = parseNotifications(buf);
      deliver(messages);
      buf = rest;
    });
    const finish = () => {
      if (buf.length) {
        const { messages, rest, stuck } = parseNotifications(buf, { final: true });
        deliver(messages);
        if (stuck) deliver(scanText(rest));
      }
      buf = Buffer.alloc(0);
      push.sockets.delete(sock);
    };
    sock.on('end', finish);
    sock.on('error', () => push.sockets.delete(sock));
    sock.on('close', () => push.sockets.delete(sock));
  }

  /** One notification line: same text as a query reply (IF p.10), plus q[nn] and a few status forms. */
  #notified(line, onValues, onPtz) {
    if (this.closed) return;
    try {
      let m = /^q(\d\d)$/.exec(line);                              // preset reached (IF p.16)
      if (m) { onPtz({ preset: Number(m[1]) + 1 }); return; }
      m = /^aPC([0-9A-Fa-f]{4})([0-9A-Fa-f]{4})$/.exec(line);       // pan/tilt (IF p.78)
      if (m) {
        onPtz({
          pan: clamp01((parseInt(m[1], 16) - PAN_MIN) / (PAN_MAX - PAN_MIN)),
          tilt: clamp01((TILT_DOWN - parseInt(m[2], 16)) / (TILT_DOWN - TILT_UP)),
        });
        return;
      }
      m = /^(?:axz|gz)([0-9A-Fa-f]{3})$/.exec(line);
      if (m) onPtz({ zoom: clamp01((parseInt(m[1], 16) - LENS_MIN) / (LENS_MAX - LENS_MIN)) });
      m = /^(?:axf|gf)([0-9A-Fa-f]{3})$/.exec(line);
      if (m) onPtz({ focus: clamp01((parseInt(m[1], 16) - LENS_MIN) / (LENS_MAX - LENS_MIN)) });
      m = /^p([013])$/.exec(line);
      if (m) onPtz({ power: { 1: 'on', 0: 'standby', 3: 'starting' }[m[1]] });
      const hits = matchLine(line);
      if (!hits.length) return;
      this.#forgetCamdata();
      const values = {};
      for (const [e, value] of hits) {
        this.known.set(e.id, value);
        values[e.id] = { value };
        if (e.id === 'autoTrackingMode' && this.hasTracking) onPtz({ tracking: value });
      }
      for (const [id, r] of Object.entries(values)) {
        const writable = this.#writable(this.byId.get(id), values);
        if (writable !== undefined) r.writable = writable;
      }
      // Entries gated on a value that just changed.
      for (const e of TABLE) {
        if (e.gate && values[e.gate.id] && !values[e.id] && this.known.has(e.id)) {
          values[e.id] = { value: this.known.get(e.id), writable: this.#writable(e, values) };
        }
      }
      onValues(values);
    } catch (err) {
      this.log('debug', `notification "${line.slice(0, 40)}" not used: ${err.message}`);
    }
  }

  /** "The update notification receive end step must be taken without fail" (IF p.11-12). */
  #deregister(port) {
    this.#get(`/cgi-bin/event?connect=stop&my_port=${port}&uid=0`, { timeoutMs: 1500 })
      .catch(() => {});
  }

  #stopPush() {
    const push = this.push;
    this.push = null;
    if (!push) return;
    if (push.registered) this.#deregister(push.port);
    for (const s of push.sockets) s.destroy();
    try { push.server?.close(); } catch { /* not listening */ }
  }

  close() {
    this.closed = true;
    this.#stopPush();
  }
}

export default PanasonicAw;
