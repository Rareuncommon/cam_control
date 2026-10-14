// Sony BRC-AM7: CGI first, VISCA over IP when the camera lets us.
//
// Sources are the spec notes (specs/sony-brc-am7.md); citations use their keys:
// V-EN = Sony VISCA Command List BRC-AM7 v2.0, C-EN = CGI Command List v2.0,
// C-JP3 = the newer Japanese CGI list, HG = Help Guide.
//
// **Why CGI is the backbone.** VISCA on the AM7 is disabled unless the rear
// SETUP switch 4 is ON when the camera powers up *and* the administrator
// password has been set; the factory default is off, and nothing in the CGI
// or web menu turns it on (HG p.23, p.505; notes §2.1 "Enable VISCA", Gaps 1).
// A driver that needed VISCA would fail on most cameras out of the box, and
// the operator could not fix it from CamBridge. So:
//
// - identity, every setting, presets, snapshot and tally go over CGI, which
//   always works once the camera is set up;
// - pan/tilt and zoom velocity have CGI forms (`ptzf.cgi?PanTiltMove=`,
//   `ZoomMove=`, C-EN p.19) and use them when VISCA is off;
// - VISCA is used, when it answers, for what it does better — motion
//   (one UDP datagram rather than an HTTP request with Digest), position
//   inquiries, Auto Framing on/off, tally — and for the few things that only
//   exist there: focus velocity, detail, knee, backlight, spotlight;
// - identify() finds out which world we are in and says so: capabilities()
//   carries `visca: { available, reason, fix }`, and the read-only
//   `viscaStatus` setting puts the same sentence on the settings page, so the
//   operator is told exactly which switch to flip.
//
// If VISCA stops answering mid-session (a cable, a firewall), each call falls
// back to CGI on its own; a stop is never left waiting on a dead transport.
//
// **Other Sony models.** Any camera that answers Sony's CGI is accepted and
// reported by its own ModelName. The BRC-AM7 has a dedicated table; any other
// model gets the same table with every row marked verify (tableFor), and
// model-dependent numbers — preset count, speed steps, travel — come from
// what its CGI reports, or conservative defaults (UNKNOWN_MODEL). Auto
// Framing is offered only when the camera answers its inquiry.
//
// Per camera this holds one UDP socket on an ephemeral port, at most one
// timer for the tally refresh, and timers only while a stop that had to go
// over CGI is being re-sent over VISCA (ViscaRestop); close() releases all.
//
// Motion may run while a read is in progress (the lifecycle's motion lane).
// Moves and stops are `urgent` in the VISCA client, so they go ahead of any
// inquiry or tally refresh waiting there; CGI requests run side by side; and
// reads give way between requests when the lifecycle's `shouldYield` says a
// move is waiting.

import { PtzDriver, DriverError } from '../driver.js';
import { ViscaClient, ViscaRestop, FRAMING, nibbles, signed, toNibbles } from '../visca-client.js';
import { TABLE, GAPS } from '../tables/sony-brc-am7.js';

export { GAPS };

/** VISCA over IP: UDP 52381 (V-EN p.9; C-EN p.105). */
const VISCA_PORT = 52381;
/** CAM_VersionInq reply: vendor 0001 = Sony, model 051F = BRC-AM7 (V-EN p.22). */
const SONY_VENDOR = 0x0001;
const AM7_MODEL = 0x051f;
/** VISCA tally On lapses after 15 s without another On (V-EN p.13). Refresh well inside it. */
const TALLY_REFRESH_MS = 10_000;
/**
 * What is known about each model with a dedicated table. Everything here is
 * from the BRC-AM7 documents; another Sony that speaks the same protocol gets
 * the conservative defaults below instead, plus whatever its CGI reports.
 */
const MODELS = {
  'BRC-AM7': {
    table: TABLE,
    presets: 100,            // C-EN p.20 PresetNum=100; V-EN p.18 "00 to 63" hex
    ptMax: 127,              // Extended speed step is the factory default (C-EN p.13, p.19)
    zoomTele: 0x4000,        // optical wide 0000 .. tele 4000; 5556/6000 are Clear Image Zoom (V-EN p.27)
    focusNear: 0xf7ff,       // 0000 far .. F7FF near end of the operating range (V-EN p.27; C-EN p.14)
    panRange: { left: 175000, right: -175000 },   // 2ab98 .. d5468 (C-EN p.18)
    tiltRange: { low: -30000, high: 210000 },     // desktop f8ad0 .. 33450 (C-EN p.18)
  },
};

/**
 * Other Sony remote cameras (BRC-X400/H800, SRG, FR7 ...) speak the same CGI
 * and VISCA over IP but have different ranges. Until one has its own table:
 * - 24 pan/tilt speed steps, which every Sony "Normal" step setting accepts
 *   (V-EN p.18), unless the camera reports PanTiltMaxVelocity;
 * - presets from the camera's PresetNum, else 16 — a guess kept small so a
 *   panel never offers numbers the camera lacks;
 * - pan/tilt normalised only from the ranges the camera reports; zoom and
 *   focus left raw.
 */
const UNKNOWN_MODEL = { table: null, presets: 16, ptMax: 24, zoomTele: null, focusNear: null, panRange: null, tiltRange: null };

/** The model's profile; matching on the start of ModelName ("BRC-AM7", "BRC-AM7 ..."). */
function profileFor(model) {
  const key = Object.keys(MODELS).find((m) => String(model ?? '').toUpperCase().startsWith(m));
  return key ? { key, ...MODELS[key] } : { key: null, ...UNKNOWN_MODEL };
}

/**
 * The parameter table for a model: its own when there is one, otherwise the
 * BRC-AM7 table with every row marked verify. The lifecycle hides rows the
 * camera refuses, so an untested Sony shows what it actually has. A new
 * dedicated table is one line in MODELS.
 */
export function tableFor(model) {
  const p = profileFor(model);
  return p.table ?? TABLE.map((e) => ({ ...e, verify: true }));
}
/** High-resolution zoom speed 0000..7FFE (V-EN p.16; = CGI ZoomMove 0..32766, C-EN p.19). */
const ZOOM_SPEED_MAX = 0x7ffe;

const VISCA_DOWN_FIX = 'Turn on rear SETUP switch 4 and restart the camera (the switch is read at power-on), and make sure the administrator password is set.';

const BYTES = Object.freeze({
  versionInq: [0x81, 0x09, 0x00, 0x02, 0xff],                     // V-EN p.22
  panTiltPosInq: [0x81, 0x09, 0x06, 0x12, 0xff],                  // V-EN p.21
  zoomPosInq: [0x81, 0x09, 0x04, 0x47, 0xff],                     // V-EN p.21
  focusPosInq: [0x81, 0x09, 0x04, 0x48, 0xff],                    // V-EN p.21
  afrInq: [0x81, 0x09, 0x7e, 0x04, 0x3a, 0xff],                   // V-EN p.21
  zoomStop: [0x81, 0x01, 0x04, 0x07, 0x00, 0xff],                 // V-EN p.16
  zoomStopHiRes: [0x81, 0x01, 0x7e, 0x04, 0x17, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff], // V-EN p.16
  focusStop: [0x81, 0x01, 0x04, 0x08, 0x00, 0xff],                // V-EN p.16
  panTiltStop: [0x81, 0x01, 0x06, 0x01, 0x01, 0x01, 0x03, 0x03, 0xff], // V-EN p.17: VV WW valid, DD EE 03 03
});

/** Velocities and stops jump queued inquiries in the VISCA client. */
const MOTION = Object.freeze({ urgent: true });

/**
 * There is no CGI focus stop: focus velocity exists only over VISCA (V-EN
 * p.16; notes §5 "focusDrive … CGI none"). `ptzf.cgi?Cancel=on` "cancels the
 * running PTZ command" (C-EN p.17) and is sent with the CGI stops, but the
 * notes do not say it stops a focus drive started over VISCA.
 */
const NO_CGI_FOCUS_STOP = 'focus may still be moving: it can only be stopped over VISCA, which is not answering '
  + '(the CGI has no focus stop; Cancel=on was sent but is not documented to stop focus)';

/** Pan/tilt drive `81 01 06 01 VV WW DD EE FF` (V-EN p.17). Direction bytes: pan 01 left / 02 right / 03 stop; tilt 01 up / 02 down / 03 stop. */
function panTiltBytes(vv, ww, dd, ee) {
  return [0x81, 0x01, 0x06, 0x01, vv, ww, dd, ee, 0xff];
}

/** |v| in 0..1 onto 1..max: the smallest non-zero velocity is the slowest speed, never a stop. */
export function speedFor(v, max) {
  return Math.min(max, Math.max(1, Math.round(Math.abs(v) * max)));
}

/** `Param=value&Param=value` (C-EN p.5). Values may be percent-encoded (C-JP3 p.4-5). */
export function parseParams(text) {
  const out = {};
  for (const part of String(text ?? '').trim().split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* not encoded */ }
    out[k] = v;
  }
  return out;
}

/** A field of a CGI position value: 5-digit two's-complement hex (C-EN p.13, p.16). */
const hex20 = (s) => signed(Number.parseInt(String(s).trim(), 16), 20);

const referer = (host, port) => `http://${host}${port && port !== 80 ? `:${port}` : ''}/`;

/** An HTTP result that was not 2xx, as the DriverError the lifecycle expects. */
function httpError(r) {
  if (r.kind === 'auth') return new DriverError('the camera refused the username or password', { kind: 'auth' });
  if (r.kind === 'timeout') return new DriverError('the camera did not answer', { kind: 'timeout' });
  if (r.kind === 'network') return new DriverError(`cannot reach the camera (${r.error})`, { kind: 'network' });
  // Sony does not document CGI error replies (notes §2.2, Gaps 10). 403 is the
  // likeliest answer to a failed Referer check or an IP filter; 404 a CGI
  // this firmware lacks; anything else is the camera saying no.
  if (r.status === 403) {
    return new DriverError('the camera refused the request (its Referer check, IP filter or user level)', { code: 'forbidden', kind: 'refused' });
  }
  if (r.status === 404) return new DriverError('this camera firmware does not have that command', { code: 'notFound', kind: 'unsupported' });
  return new DriverError(`the camera refused it (HTTP ${r.status})`, { code: `http${r.status}`, kind: 'refused' });
}

const isLinkFailure = (err) => err?.kind === 'timeout' || err?.kind === 'network';

export class SonyBrc extends PtzDriver {
  static vendor = 'sony';
  static label = 'Sony';
  static models = ['BRC-AM7'];
  // Sony gives no CGI rate and no VISCA number; the camera takes at most one
  // VISCA command per video frame (V-EN p.5; 1V = 41.7 ms at 23.98). 50 ms is
  // a conservative guess that covers every frame rate.
  static minIntervalMs = 50;
  // One CGI inquiry answers a whole group (imaging, ptzf, ...), so a batch of
  // 16 usually costs two or three requests.
  static readBatch = 16;

  /**
   * Read-only: one CGI inquiry, and — only when that is refused for
   * credentials — one VISCA version inquiry, which a Sony answers with vendor
   * 0001 and an AM7 with model 051F (V-EN p.22). The `Param=value&...` reply
   * with ModelName and SoftVersion is Sony's format (C-EN p.5, p.7); the
   * other vendors' CGIs answer JSON, `key="value"` lines or 404.
   */
  static async probe(ctx) {
    const port = ctx.port ?? 80;
    const r = await ctx.http({
      host: ctx.host, port, path: '/command/inquiry.cgi?inq=system', auth: ctx.auth,
      headers: { Referer: referer(ctx.host, port) }, timeoutMs: ctx.timeoutMs,
    });
    if (r.ok) {
      const p = parseParams(r.text);
      if (p.ModelName === undefined || (p.SoftVersion === undefined && p.CGIVersion === undefined)) return null;
      return { vendor: 'sony', model: p.ModelName || 'BRC-AM7', firmware: p.SoftVersion, serial: p.Serial };
    }
    if (r.kind !== 'auth') return null;
    const v = await probeVisca({ host: ctx.host, port: ctx.options?.viscaPort ?? VISCA_PORT, timeoutMs: Math.min(ctx.timeoutMs ?? 1500, 800) });
    if (v?.vendor === SONY_VENDOR) throw new DriverError('the camera refused the username or password', { kind: 'auth' });
    return null;
  }

  constructor(ctx) {
    super(ctx);
    this.port = ctx.port ?? 80;
    this.timeoutMs = ctx.timeoutMs ?? 3000;
    const o = ctx.options ?? {};
    this.visca = new ViscaClient({
      host: this.host,
      port: o.viscaPort ?? VISCA_PORT,
      framing: FRAMING.SONY_IP,
      timeoutMs: Math.min(this.timeoutMs, 1500),
      localPort: o.viscaLocalPort ?? 0,
      log: this.log,
    });
    /** Whether VISCA answers, and why not. */
    this.viscaState = { available: false, reason: 'not checked yet', lostMidSession: false };
    this.lastViscaProbe = 0;
    this.#useProfile(profileFor(o.model ?? 'BRC-AM7'));
    this.identity = null;
    this.entries = TABLE;
    this.byId = new Map(TABLE.map((e) => [e.id, e]));
    /** Last values seen, for gate checks. */
    this.seen = new Map();
    this.tally = { red: false, green: false };
    this.tallyTimer = null;
    this.tallyRefreshMs = o.tallyRefreshMs ?? TALLY_REFRESH_MS;
    this.closed = false;
    /**
     * Stops that went over CGI because VISCA did not take them, to be sent
     * over VISCA too once it answers (see ViscaRestop). A VISCA stop that
     * gets through again also means VISCA is back.
     */
    this.restop = new ViscaRestop({ log: this.log });
    /** Focus was driven over VISCA and no focus stop has been taken since. */
    this.focusMaybeMoving = false;
  }

  /** A move or stop is waiting for the camera: a read with more to ask hands back what it has. */
  #shouldYield() {
    try { return !!this.ctx?.shouldYield?.(); } catch { return false; }
  }

  #useProfile(p) {
    this.profile = p;
    this.ptMax = p.ptMax;
    this.presetCount = p.presets;
    this.panRange = p.panRange;
    this.tiltRange = p.tiltRange;
  }

  // --- transports --------------------------------------------------------------

  async #get(path, { timeoutMs = this.timeoutMs } = {}) {
    const r = await this.http({
      host: this.host, port: this.port, path, auth: this.auth, timeoutMs,
      // Referer check is on by default: without this header the camera only
      // accepts CGI from its own web page (C-EN p.3, p.60; HG p.458). Naming
      // the camera itself is what Sony says to send.
      headers: { Referer: referer(this.host, this.port) },
    });
    if (!r.ok) throw httpError(r);
    return r;
  }

  /** `GET /command/inquiry.cgi?inq=<group>` (C-EN p.5), one group per call so one unknown group cannot sink the rest. */
  async #inquiry(group) {
    const r = await this.#get(`/command/inquiry.cgi?inq=${encodeURIComponent(group)}`);
    return parseParams(r.text);
  }

  /** `GET /command/<cgi>.cgi?<Param>=<value>` (C-EN p.4); a path starting '/' is used as is (analytics, C-EN p.23). */
  async #set(cgiName, param, value) {
    const path = cgiName.startsWith('/') ? cgiName : `/command/${cgiName}.cgi`;
    await this.#get(`${path}?${param}=${value}`);
  }

  get #viscaUp() { return this.viscaState.available && !this.closed; }

  #viscaLost(err) {
    if (!this.viscaState.available) return;
    this.viscaState = { available: false, reason: `stopped answering (${err.message})`, lostMidSession: true };
    this.log('warn', 'VISCA stopped answering; using CGI');
  }

  /**
   * Tries VISCA, falls back to CGI when VISCA does not answer. A refusal over
   * VISCA is an answer and is passed on — the CGI would refuse the same.
   */
  async #viscaOr(viaVisca, viaCgi) {
    if (this.#viscaUp) {
      try {
        return await viaVisca();
      } catch (err) {
        if (!isLinkFailure(err) || !viaCgi) throw err;
        this.#viscaLost(err);
      }
    }
    if (!viaCgi) throw new DriverError('this needs VISCA, which is off on this camera. ' + VISCA_DOWN_FIX, { kind: 'unsupported' });
    return viaCgi();
  }

  async #probeVisca(timeoutMs = 700) {
    this.lastViscaProbe = Date.now();
    try {
      const r = await this.visca.inquiry(BYTES.versionInq, { timeoutMs });
      const vendor = (r[2] << 8) | r[3];
      const model = (r[4] << 8) | r[5];
      this.viscaModelId = model.toString(16).padStart(4, '0');
      if (vendor !== SONY_VENDOR || (this.profile.key === 'BRC-AM7' && model !== AM7_MODEL)) {
        this.log('info', `VISCA answers as vendor ${vendor.toString(16)} model ${model.toString(16)}, not a BRC-AM7`);
      }
      this.viscaState = { available: true, reason: null, lostMidSession: false };
    } catch (err) {
      if (!isLinkFailure(err)) {
        // It answered, only not to that: VISCA is on.
        this.viscaState = { available: true, reason: null, lostMidSession: false };
        return;
      }
      // Sony does not say whether a camera with VISCA off ignores datagrams or
      // answers an error (notes Gaps 1); silence is what we can observe.
      const pw = this.identity?.passwordSet;
      const reason = pw === false
        ? 'the administrator password has not been set'
        : 'no answer on UDP 52381 — rear SETUP switch 4 is off, or the port is blocked';
      this.viscaState = { available: false, reason, lostMidSession: false };
    }
  }

  // --- identity ------------------------------------------------------------------

  async identify() {
    const sys = await this.#inquiry('system');                   // C-EN p.7-8
    const identity = {
      vendor: 'sony',
      model: sys.ModelName || 'BRC-AM7',
      firmware: sys.SoftVersion,
      serial: sys.Serial,
      passwordSet: sys.PasswordChanged === undefined ? undefined : sys.PasswordChanged === '1',
    };
    this.identity = identity;
    this.#useProfile(profileFor(identity.model));
    identity.dedicatedTable = !!this.profile.key;

    // Sub-queries: a refusal means "not on this model"; silence is silence.
    const optional = (e, fallback) => { if (e.kind === 'refused' || e.kind === 'unsupported') return fallback; throw e; };
    const net = await this.#inquiry('network').catch((e) => optional(e, {}));     // C-EN p.52-53
    identity.mac = net.MacAddress;
    identity.name = net.CameraName;

    const ptzf = await this.#inquiry('ptzf').catch((e) => optional(e, {}));       // C-EN p.13-19
    this.#absorbPtzf(ptzf);
    // Preset count as the camera reports it (C-EN p.20), when it does.
    const pp = await this.#inquiry('presetposition').catch((e) => optional(e, {}));
    const reported = Number.parseInt(pp.PresetNum, 10);
    if (Number.isInteger(reported) && reported > 0 && reported <= 256) this.presetCount = reported;
    identity.presets = this.presetCount;

    // Auto Framing is in software 2.0 (V-EN p.18; C-EN p.23). A camera whose
    // CGI has no ptzautoframing group does not have it.
    const afr = await this.#inquiry('ptzautoframing').catch((e) => optional(e, null));
    identity.autoFraming = !!afr && afr.PtzAutoFraming !== undefined;

    await this.#probeVisca();
    identity.visca = this.#viscaSummary();
    identity.viscaModelId = this.viscaModelId;
    this.log('info', this.viscaState.available ? 'VISCA over IP answers' : `VISCA over IP off: ${this.viscaState.reason}`);
    return identity;
  }

  #absorbPtzf(p) {
    if (p.PanTiltMaxVelocity) this.ptMax = Number(p.PanTiltMaxVelocity) === 24 ? 24 : 127;      // C-EN p.18
    else if (p.PanTiltSpeedStep) this.ptMax = p.PanTiltSpeedStep === 'normal' ? 24 : 127;       // C-EN p.19
    if (p.PanMovementRange) {
      const [l, r] = p.PanMovementRange.split(',').map(hex20);
      if (Number.isFinite(l) && Number.isFinite(r) && l !== r) this.panRange = { left: l, right: r };
    }
    if (p.TiltMovementRange) {
      const [lo, hi] = p.TiltMovementRange.split(',').map(hex20);
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo !== hi) this.tiltRange = { low: Math.min(lo, hi), high: Math.max(lo, hi) };
    }
  }

  #viscaSummary() {
    const { available, reason } = this.viscaState;
    return { available, reason, fix: available ? null : VISCA_DOWN_FIX };
  }

  #viscaText() {
    const { available, reason } = this.viscaState;
    return available ? 'On — answering on UDP 52381' : `Off — ${reason}. ${VISCA_DOWN_FIX}`;
  }

  async heartbeat() {
    await this.#inquiry('system');
  }

  schema(identity = this.identity) {
    const visca = identity?.visca?.available ?? this.viscaState.available;
    const tracking = identity?.autoFraming ?? false;
    this.entries = tableFor(identity?.model ?? this.profile.key).filter((e) => (e.requires !== 'visca' || visca) && (e.requires !== 'tracking' || tracking));
    this.byId = new Map(this.entries.map((e) => [e.id, e]));
    return this.entries;
  }

  capabilities(identity = this.identity) {
    // This camera's live VISCA state; a stored identity's otherwise.
    const visca = identity === this.identity || !identity?.visca ? this.#viscaSummary() : identity.visca;
    return {
      panTilt: true,
      zoom: true,
      // Focus velocity exists only over VISCA (V-EN p.16; no CGI form, notes §5).
      focus: !!visca.available,
      presets: identity?.presets ?? this.presetCount,
      presetBase: 1,
      tracking: identity?.autoFraming ? { kind: 'autoFraming', label: 'PTZ Auto Framing' } : null,
      tally: true,
      snapshot: true,
      pointToCentre: false,
      power: false,
      visca,
    };
  }

  // --- settings ------------------------------------------------------------------

  /** Decodes one entry's value from an inquiry group's params; undefined when absent. */
  #decode(e, params) {
    const w = e.wire;
    const raw = params[w.param];
    if (raw === undefined) return undefined;
    let fields = raw.split(',');
    if (w.prefix) fields = fields.slice(w.prefix.length);
    const s = w.index !== undefined ? fields[w.index] : fields.join(',');
    if (s === undefined) return undefined;
    const v = w.codec.dec(s);
    return typeof v === 'number' && !Number.isFinite(v) ? undefined : v;
  }

  #writable(e, out) {
    if (e.readOnly) return false;
    if (!e.gate) return undefined;
    const g = out[e.gate.id]?.value ?? this.seen.get(e.gate.id);
    return g === undefined ? undefined : g === e.gate.value;
  }

  /**
   * Link failures come back as `{ superseded: true }` instead of a throw. The
   * lifecycle's first full read after connecting is awaited inside
   * `#connect()`, which nothing catches (lifecycle.js:226), so a timeout there
   * would be an unhandled rejection and stop the process. A superseded result
   * is skipped without counting as proof of life, so the heartbeat still
   * decides health. (Reported as a foundation change; remove when fixed.)
   */
  async read(entries) {
    try {
      return await this.#read(entries, { yieldable: true });
    } catch (err) {
      if (!isLinkFailure(err)) throw err;
      this.log('debug', `read not answered: ${err.message}`);
      return { superseded: true };
    }
  }

  /**
   * `yieldable`: the lifecycle's read. After its first request it gives way
   * to a waiting move or stop between requests, returning what it has; the
   * rest is asked on the next sweep. A write's own gate read never yields.
   */
  async #read(entries, { yieldable = false } = {}) {
    let requests = 0;
    const giveWay = () => yieldable && requests > 0 && this.#shouldYield();
    const out = {};
    const groups = new Map();
    const viaVisca = [];
    for (const e of entries) {
      if (e.type === 'action') continue;
      const w = e.wire ?? {};
      if (w.local === 'visca') out[e.id] = { value: this.#viscaText() };
      else if (w.inq) {
        if (!groups.has(w.inq)) groups.set(w.inq, []);
        groups.get(w.inq).push(e);
      } else if (w.visca) viaVisca.push(e);
    }

    let yielded = false;
    for (const [group, asked] of groups) {
      if (giveWay()) { yielded = true; break; }
      requests += 1;
      let params;
      try {
        params = await this.#inquiry(group);
      } catch (err) {
        if (err.kind === 'refused' || err.kind === 'unsupported') {
          for (const e of asked) out[e.id] = { error: err.message, unsupported: true };
          continue;
        }
        throw err;
      }
      if (group === 'ptzf') this.#absorbPtzf(params);
      // One inquiry answers its whole group; pass on everything this model's
      // table has in it, not only what was asked.
      for (const e of this.entries) {
        if (e.wire?.inq !== group || e.type === 'action') continue;
        const v = this.#decode(e, params);
        if (v === undefined) {
          if (asked.includes(e)) out[e.id] = { error: 'the camera does not report this setting', unsupported: true };
          continue;
        }
        out[e.id] = { value: v };
        this.seen.set(e.id, v);
      }
    }

    for (const e of yielded ? [] : viaVisca) {
      if (!this.#viscaUp) { out[e.id] = { error: 'needs VISCA, which is off' }; continue; }
      if (giveWay()) break;
      requests += 1;
      try {
        const v = e.wire.visca.dec(await this.visca.inquiry(e.wire.visca.inq));
        out[e.id] = { value: v };
        this.seen.set(e.id, v);
      } catch (err) {
        if (err.kind === 'refused') out[e.id] = { error: err.message, unsupported: true };
        else { this.#viscaLost(err); out[e.id] = { error: err.message }; }
      }
    }

    for (const [id, r] of Object.entries(out)) {
      if (r.error) continue;
      const e = this.byId.get(id);
      const w = e && this.#writable(e, out);
      if (w !== undefined) r.writable = w;
    }
    return out;
  }

  /** Fresh value of one entry, for a gate check. */
  async #current(e) {
    const r = (await this.#read([e]))[e.id];
    if (r?.error) throw new DriverError(`${e.label}: ${r.error}`, { kind: r.unsupported ? 'unsupported' : 'refused' });
    return r.value;
  }

  async write(entry, value) {
    if (entry.readOnly || entry.type === 'action') throw new DriverError(`${entry.label} cannot be set`, { kind: 'refused' });
    const w = entry.wire;
    if (entry.gate) {
      const gateEntry = this.byId.get(entry.gate.id);
      if (gateEntry) {
        const now = await this.#current(gateEntry);
        if (now !== entry.gate.value) {
          const want = gateEntry.options?.find((o) => o.value === entry.gate.value)?.label
            ?? (entry.gate.value === false ? 'off' : entry.gate.value === true ? 'on' : String(entry.gate.value));
          throw new DriverError(`${entry.label} can only be changed while ${gateEntry.label} is ${want}`, { code: 'gate', kind: 'refused' });
        }
      }
    }

    if (w.visca && !w.inq) {
      // VISCA-only rows (detail, knee, backlight, spotlight).
      if (!this.#viscaUp) throw new DriverError(`${entry.label} needs VISCA. ${VISCA_DOWN_FIX}`, { kind: 'unsupported' });
      await this.visca.command(w.visca.enc(value)).catch((err) => { throw this.#explain(err, entry); });
      this.seen.set(entry.id, value);
      return {};
    }

    const viaCgi = async () => {
      let encoded;
      if (w.index !== undefined) {
        // One field of a list: the others must be written back as they are.
        const params = await this.#inquiry(w.inq);
        const raw = params[w.param];
        if (raw === undefined) throw new DriverError(`the camera does not report ${entry.label}`, { kind: 'unsupported' });
        const fields = raw.split(',');
        const at = (w.prefix?.length ?? 0) + w.index;
        fields[at] = w.codec.enc(value);
        encoded = fields.map(encodeURIComponent).join(',');
      } else {
        const v = encodeURIComponent(w.codec.enc(value));
        encoded = w.prefix ? [...w.prefix.map(encodeURIComponent), v].join(',') : v;
      }
      await this.#set(w.set, w.param, encoded);
    };
    if (w.visca) {
      // Auto Framing on/off: VISCA when it answers (V-EN p.18), CGI otherwise (C-EN p.23).
      await this.#viscaOr(() => this.visca.command(w.visca.enc(value)).catch((err) => { throw this.#explain(err, entry); }), viaCgi);
    } else {
      await viaCgi();
    }
    this.seen.set(entry.id, value);
    if (w.param === 'PanTiltSpeedStep') this.ptMax = value === 'normal' ? 24 : 127;
    return {};
  }

  /** A VISCA refusal in words for this entry. */
  #explain(err, entry) {
    if (err.code === 'notExecutable') {
      return new DriverError(`${entry?.label ?? 'That'}: the camera cannot do that in its current mode`, { code: err.code, kind: 'refused' });
    }
    return err;
  }

  async action(entry, payload = {}) {
    const w = entry.wire ?? {};
    switch (w.act) {
      case 'press': {
        // Press then release, back to back: a gap of a second or more is a
        // long press (C-EN p.6).
        const viaCgi = async () => {
          await this.#set(w.set, w.param, 'press');
          await this.#set(w.set, w.param, 'release');
        };
        if (w.visca) {
          await this.#viscaOr(async () => { for (const b of w.visca) await this.visca.command(b); }, viaCgi);
        } else await viaCgi();
        return {};
      }
      case 'set': {
        const viaCgi = () => this.#set(w.set, w.param, encodeURIComponent(w.value));
        if (w.visca) await this.#viscaOr(async () => { for (const b of w.visca) await this.visca.command(b); }, viaCgi);
        else await viaCgi();
        return {};
      }
      case 'afrPoint': {
        // Person nearest a point, 0..10000 from the top left (C-EN p.26).
        const clampPt = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(10000, Math.round(Number(v)))) : d);
        const x = clampPt(payload?.x, 5000);
        const y = clampPt(payload?.y, 5000);
        await this.#set(w.set, w.param, `${x},${y}`);
        return {};
      }
      default:
        throw new DriverError(`${entry.label} is not supported`, { kind: 'unsupported' });
    }
  }

  // --- motion --------------------------------------------------------------------

  async panTilt(pan, tilt) {
    if (!pan && !tilt) { await this.#stopGroups(['panTilt']); return; }
    this.restop.cancel('panTilt');
    const max = this.ptMax;
    await this.#viscaOr(
      () => {
        // Both speed bytes must be valid even for an axis that is not moving
        // (V-EN p.17: VV/WW "still need valid values"); 01 is.
        const vv = pan === 0 ? 0x01 : speedFor(pan, max);
        const ww = tilt === 0 ? 0x01 : speedFor(tilt, max);
        const dd = pan > 0 ? 0x02 : pan < 0 ? 0x01 : 0x03;
        const ee = tilt > 0 ? 0x01 : tilt < 0 ? 0x02 : 0x03;
        return this.visca.command(panTiltBytes(vv, ww, dd, ee), MOTION);
      },
      () => {
        // ptzf.cgi?PanTiltMove=<dir>,<pan speed>,<tilt speed>; speeds 0..24 or
        // 0..127 (C-EN p.19). Stop's speed arguments are not specified; 0,0 is
        // in range (notes §5, an assumption).
        const v = pan === 0 ? '' : pan > 0 ? 'right' : 'left';
        const h = tilt === 0 ? '' : tilt > 0 ? 'up' : 'down';
        const dir = !v && !h ? 'stop' : [h, v].filter(Boolean).join('-');
        const ps = pan === 0 ? 0 : speedFor(pan, max);
        const ts = tilt === 0 ? 0 : speedFor(tilt, max);
        return this.#set('ptzf', 'PanTiltMove', `${dir},${ps},${ts}`);
      },
    );
  }

  async zoom(speed) {
    if (!speed) { await this.#stopGroups(['zoom']); return; }
    this.restop.cancel('zoom');
    await this.#viscaOr(
      async () => {
        // High-resolution zoom: 81 01 7E 04 17 02|03 0p 0p 0p 0p FF, tele 02,
        // wide 03, speed 0000..7FFE (V-EN p.16) — 32 767 steps rather than 8.
        const s = speedFor(speed, ZOOM_SPEED_MAX);
        await this.visca.command([0x81, 0x01, 0x7e, 0x04, 0x17, speed > 0 ? 0x02 : 0x03, ...toNibbles(s, 4), 0xff], MOTION);
      },
      // ZoomMove=<tele|wide|stop>,<0..32766> (C-EN p.19).
      () => this.#set('ptzf', 'ZoomMove', `${speed > 0 ? 'tele' : 'wide'},${speedFor(speed, ZOOM_SPEED_MAX)}`),
    );
  }

  async focus(speed) {
    if (!speed) { await this.#stopGroups(['focus']); return; }
    if (!this.#viscaUp) {
      throw new DriverError(`Focus speed control needs VISCA, which is off on this camera. ${VISCA_DOWN_FIX}`, { kind: 'unsupported' });
    }
    this.restop.cancel('focus');
    // Far 81 01 04 08 2p FF, near 3p, p 0 (slow)..7 (fast); stop 00. Manual
    // focus only — otherwise 90 6z 41 FF (V-EN p.16, p.8).
    const bytes = [0x81, 0x01, 0x04, 0x08, (speed > 0 ? 0x20 : 0x30) | (speedFor(speed, 8) - 1), 0xff];
    // Counted as moving from before it is sent: a lost ACK may still have run it.
    this.focusMaybeMoving = true;
    try {
      await this.visca.command(bytes, MOTION);
    } catch (err) {
      if (err.code === 'notExecutable') {
        this.focusMaybeMoving = false;
        throw new DriverError('Focus is on auto — set Focus mode to Manual to pull focus', { code: err.code, kind: 'refused' });
      }
      if (isLinkFailure(err)) this.#viscaLost(err);
      throw err;
    }
  }

  /**
   * One axis group's VISCA stop (V-EN p.16-17). Zoom sends the
   * high-resolution stop and then the standard one: the notes give both and
   * do not say one stops the other's motion. A focus stop refused as "not
   * executable" counts as taken — focus is on auto, so no manual focus drive
   * can be running.
   */
  async #viscaStop(group, o = MOTION) {
    if (group === 'panTilt') {
      await this.visca.command(BYTES.panTiltStop, o);
    } else if (group === 'zoom') {
      await this.visca.command(BYTES.zoomStopHiRes, o);
      await this.visca.command(BYTES.zoomStop, o);
    } else {
      try {
        await this.visca.command(BYTES.focusStop, o);
      } catch (err) {
        if (err.code !== 'notExecutable') throw err;
      }
      this.focusMaybeMoving = false;
    }
  }

  /** The re-stop over VISCA got through: VISCA answers again. */
  #viscaBack() {
    if (this.viscaState.available || this.closed) return;
    this.viscaState = { available: true, reason: null, lostMidSession: false };
    this.log('info', 'VISCA answers again');
  }

  /**
   * Stops these axis groups ('panTilt', 'zoom', 'focus'; pan/tilt first:
   * it is the axis that hits things).
   *
   * Over VISCA while it answers. If VISCA does not take a stop — no answer,
   * or refused (both command buffers still full after the client's retry) —
   * the CGI stops go out instead: `PanTiltMove=stop,0,0` and `ZoomMove=stop,0`
   * (C-EN p.19), then `Cancel=on`, "cancels the running PTZ command" (C-EN
   * p.17; notes §5 "Safest stop everything" lists all three). After a CGI
   * stop for a group that VISCA may have moved, the VISCA stop is sent again
   * as soon as VISCA answers, so a late VISCA move cannot outlast the stop.
   *
   * Focus has no CGI stop (see NO_CGI_FOCUS_STOP): when focus may be moving
   * and VISCA will not take the stop, this throws, so the motion controller
   * keeps the stop alive and retries, and the re-stop keeps trying VISCA.
   */
  async #stopGroups(groups) {
    let viscaErr = null;
    const wasUp = this.#viscaUp;
    if (wasUp) {
      try {
        for (const g of groups) {
          await this.#viscaStop(g);
          this.restop.cancel(g);
        }
        return;
      } catch (err) {
        viscaErr = err;
        if (isLinkFailure(err)) this.#viscaLost(err);
        this.log('warn', `VISCA stop not taken (${err.message}); stopping over CGI`);
      }
    }
    let focusPending = groups.includes('focus') && this.focusMaybeMoving;
    let cgiErr = null;
    const cgi = async (fn) => { try { await fn(); } catch (err) { cgiErr ??= err; } };
    if (groups.includes('panTilt')) await cgi(() => this.#set('ptzf', 'PanTiltMove', 'stop,0,0'));   // C-EN p.19
    if (groups.includes('zoom')) await cgi(() => this.#set('ptzf', 'ZoomMove', 'stop,0'));           // C-EN p.19
    // Cancel=on (C-EN p.17) cancels whatever PTZ command is running — on a
    // single-axis stop that could cut short a move on another axis, so it
    // goes with a stop of everything, or when focus may be moving and this
    // is the only thing left to try. Best effort: not every firmware may
    // have it, and the stops above are what count.
    if (groups.length === 3 || focusPending) {
      await this.#set('ptzf', 'Cancel', 'on').catch((err) => this.log('debug', `Cancel=on: ${err.message}`));
    }
    // Focus can only be stopped over VISCA. If VISCA was already marked down
    // (not tried above), one brief try now — after the CGI stops, so a dead
    // link does not hold up pan/tilt — in case it has come back.
    if (focusPending && !wasUp && !this.closed) {
      try {
        await this.#viscaStop('focus', { ...MOTION, timeoutMs: 500 });
        this.restop.cancel('focus');
        this.#viscaBack();
        focusPending = false;
      } catch (err) {
        viscaErr ??= err;
      }
    }
    // Re-send over VISCA once it answers — where VISCA could have moved the
    // head: it failed just now, or answered earlier in this session.
    if (viscaErr || this.viscaState.lostMidSession) {
      for (const g of groups) {
        if (g === 'focus' && !this.focusMaybeMoving) continue;
        this.restop.arm(g, (o) => this.#viscaStop(g, o), () => this.#viscaBack());
      }
    }
    if (cgiErr) {
      throw viscaErr
        ? new DriverError(`the stop did not reach the camera: VISCA ${viscaErr.message}; CGI ${cgiErr.message}`, { kind: cgiErr.kind, code: cgiErr.code })
        : cgiErr;
    }
    if (focusPending) {
      throw new DriverError(NO_CGI_FOCUS_STOP, { kind: viscaErr?.kind ?? 'timeout', code: 'focusNotStopped' });
    }
  }

  /**
   * Every axis. There is no single stop-all: pan/tilt stop, zoom stop (both
   * kinds, since high-res zoom is what we drive) and focus stop, each on its
   * own (V-EN p.6, p.16-17; notes §5 "Safest stop everything"). IF_Clear "does
   * not guarantee" the running operation stops, so it is not used. When
   * VISCA does not take them, the CGI stops go out instead (#stopGroups).
   */
  async stop() {
    await this.#stopGroups(['panTilt', 'zoom', 'focus']);
  }

  async position() {
    const read = await this.#viscaOr(
      async () => {
        // Three inquiries; a waiting move or stop goes between them, and
        // what was not asked is left out (undefined) rather than reported.
        const pt = await this.visca.inquiry(BYTES.panTiltPosInq);        // 90 50 0p×5 0t×5 FF (V-EN p.21)
        const z = this.#shouldYield() ? null : await this.visca.inquiry(BYTES.zoomPosInq);            // 90 50 0z×4 FF
        const f = !z || this.#shouldYield() ? null : await this.visca.inquiry(BYTES.focusPosInq);     // 90 50 0p×4 FF
        return {
          pan: signed(nibbles(pt, 2, 5), 20),
          tilt: signed(nibbles(pt, 7, 5), 20),
          zoom: z ? nibbles(z, 2, 4) : undefined,
          focus: f ? nibbles(f, 2, 4) : undefined,
        };
      },
      async () => {
        // AbsolutePTZF=pan,tilt,zoom,focus (C-EN p.17); padding of the reply
        // is not documented, so each field is parsed as plain hex.
        const p = await this.#inquiry('ptzf');
        this.#absorbPtzf(p);
        const f = String(p.AbsolutePTZF ?? '').split(',');
        if (f.length < 4) throw new DriverError('the camera did not report its position', { kind: 'refused' });
        return { pan: hex20(f[0]), tilt: hex20(f[1]), zoom: Number.parseInt(f[2], 16), focus: Number.parseInt(f[3], 16) };
      },
    );
    const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
    const { zoomTele, focusNear } = this.profile;
    return {
      // 0 = left end, 1 = right end: positive pan is right. Sony's pan counts
      // up to the left (2AB98 = +175° CCW, V-EN p.25).
      pan: this.panRange ? clamp01((this.panRange.left - read.pan) / (this.panRange.left - this.panRange.right)) : null,
      tilt: this.tiltRange ? clamp01((read.tilt - this.tiltRange.low) / (this.tiltRange.high - this.tiltRange.low)) : null,
      // Across the optical range; Clear Image Zoom beyond it reads as 1.
      // (Not asked this time — a read that gave way to a stop — stays undefined.)
      zoom: read.zoom === undefined ? undefined : zoomTele ? clamp01(read.zoom / zoomTele) : null,
      // 1 = far, matching positive focus velocity = far.
      focus: read.focus === undefined ? undefined : focusNear ? clamp01((focusNear - read.focus) / focusNear) : null,
      raw: read,
    };
  }

  async status() {
    // VISCA lost mid-session (not switched off at power-on, where asking
    // again cannot help): look for it again now and then, briefly.
    let asked = false;
    if (!this.viscaState.available && this.viscaState.lostMidSession && Date.now() - this.lastViscaProbe > 30_000) {
      asked = true;
      await this.#probeVisca(300);
      if (this.viscaState.available) this.log('info', 'VISCA answers again');
      else this.viscaState.lostMidSession = true;
    }
    const out = { visca: this.viscaState.available };
    // A second request gives way to a waiting move or stop.
    if (!this.identity?.autoFraming || (asked && this.#shouldYield())) return out;
    out.tracking = await this.#viscaOr(
      async () => (await this.visca.inquiry(BYTES.afrInq))[2] === 0x01,          // V-EN p.21: 1 = on
      async () => (await this.#inquiry('ptzautoframing')).PtzAutoFraming === 'on', // C-EN p.23
    );
    return out;
  }

  // --- presets -------------------------------------------------------------------

  #presetNumber(n) {
    if (!Number.isInteger(n) || n < 1 || n > this.presetCount) {
      throw new DriverError(`preset numbers on this camera run 1–${this.presetCount}`, { code: 'range', kind: 'refused' });
    }
    return n;
  }

  // Presets go over CGI (C-EN p.20-21), which works with VISCA off; VISCA's
  // own preset commands (81 01 04 3F 0x pp FF, V-EN p.18) are the same thing.
  async presetRecall(n) {
    await this.#set('presetposition', 'PresetCall', String(this.#presetNumber(n)));
    return {};
  }

  async presetStore(n) {
    // PresetSet=<n>,<name 0-32>,<thumbnail on|off> (C-EN p.21). The name is
    // left empty: CamBridge keeps its own names, and an invented one would
    // overwrite what someone typed on the camera's page. The camera keeps a
    // thumbnail so its own web page stays useful.
    await this.#set('presetposition', 'PresetSet', `${this.#presetNumber(n)},,on`);
    return {};
  }

  async presetDelete(n) {
    await this.#set('presetposition', 'PresetClear', String(this.#presetNumber(n)));   // C-EN p.20
    return {};
  }

  // --- picture and tally ---------------------------------------------------------

  async snapshot() {
    // /oneshotimage1 — stream 1's settings; not /oneshotimage.jpg (C-EN p.82).
    const r = await this.#get('/oneshotimage1');
    return { contentType: String(r.headers?.['content-type'] ?? 'image/jpeg').split(';')[0], body: r.body };
  }

  /**
   * Red for program, green for preview (a camera given both lights red, HG
   * p.493). The lamp follows these only with Tally control = External
   * (C-EN p.39); CamBridge does not change that setting behind anyone's back.
   *
   * A VISCA tally On lapses after 15 s without a repeat (V-EN p.13), and the
   * lifecycle calls setTally only when the state changes. So while either lamp
   * is on, a timer here repeats the On every 10 s; it stops when both are off
   * and in close(). The CGI form is refreshed the same way, since whether it
   * lapses is not documented and repeating an On is harmless.
   */
  async setTally({ program = false, preview = false } = {}) {
    this.tally = { red: !!program, green: !!preview };
    const on = this.tally.red || this.tally.green;
    if (on && !this.tallyTimer && !this.closed) {
      this.tallyTimer = setInterval(() => {
        this.#sendTally().catch((err) => this.log('debug', `tally refresh failed: ${err.message}`));
      }, this.tallyRefreshMs);
      this.tallyTimer.unref?.();
    } else if (!on && this.tallyTimer) {
      clearInterval(this.tallyTimer);
      this.tallyTimer = null;
    }
    await this.#sendTally();
  }

  async #sendTally() {
    const { red, green } = this.tally;
    await this.#viscaOr(
      async () => {
        await this.visca.command([0x81, 0x01, 0x7e, 0x01, 0x0a, 0x00, red ? 0x02 : 0x03, 0xff]);   // V-EN p.19
        await this.visca.command([0x81, 0x01, 0x7e, 0x04, 0x1a, 0x00, green ? 0x02 : 0x03, 0xff]); // V-EN p.19
      },
      async () => {
        await this.#set('tally', 'RTallyControl', red ? 'turn_on' : 'turn_off');               // C-EN p.39
        await this.#set('tally', 'GTallyControl', green ? 'turn_on' : 'turn_off');             // C-EN p.39
      },
    );
  }

  close() {
    this.closed = true;
    if (this.tallyTimer) clearInterval(this.tallyTimer);
    this.tallyTimer = null;
    this.restop.close();
    this.visca.close();
  }
}

/** One VISCA version inquiry on a throwaway client. Null when nothing answers. */
async function probeVisca({ host, port, timeoutMs }) {
  const c = new ViscaClient({ host, port, framing: FRAMING.SONY_IP, timeoutMs });
  try {
    const r = await c.inquiry(BYTES.versionInq);
    return { vendor: (r[2] << 8) | r[3], model: (r[4] << 8) | r[5] };
  } catch {
    return null;
  } finally {
    c.close();
  }
}
