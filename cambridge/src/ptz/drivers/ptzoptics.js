// PTZOptics Move SE: raw VISCA over TCP for motion and reads, HTTP-CGI for settings.
//
// Sources are the spec notes (specs/ptzoptics-move-se.md) and their keys:
// VISCA-PDF / HTTP-PDF = PTZOptics developer docs (2026), FW-* = Move SE
// firmware changelogs, COMP = Bitfocus companion-module-ptzoptics-visca
// (implementation only, but run against a real Move SE G3).
//
// Transport choices, and why:
//
// - **VISCA over TCP 5678, raw.** Vendor examples and Companion both drive the
//   SE that way (notes §2.1). UDP 1259's framing — header or not — is not
//   documented anywhere, and "Sony VISCA over IP" on 52381 is not described
//   by PTZOptics at all, so neither is used.
// - The SE has two VISCA command buffers ("Both command sockets are in use",
//   VISCA-PDF p.6); visca-client.js tracks them.
// - Replies start `90`, except on firmware before 12X 9.1.56 / 20X 9.1.38 /
//   30X 9.1.42, where a changed serial address leaked into the IP reply
//   (`a0`, `b0`...; FW-0112 known issues). visca-client.js accepts any `z0`.
// - **HTTP Digest** on the CGI since firmware 12X 9.1.43 (Feb 2025, "enabled
//   by default", FW-0213). ctx.http answers a Digest challenge.
//
// The SE documents its CGI *setters* (HTTP-PDF lists the SE per command) but
// none of the `get_*` queries — those are listed for the Move 4K / Link 4K
// only. So identity parsing and every value read through a query are marked
// verify, and when a query turns out to be missing the value is reported as
// unknown (null) instead of the setting disappearing.
//
// **Other PTZOptics models** (Move 4K, Link, Studio, G2/G3) speak the same
// raw VISCA and CGI. They are accepted and named from get_device_conf's
// `device_model` (or `options.model` in the config entry); the Move SE has a
// dedicated table and any other model gets it with every row marked verify
// (tableFor). Auto tracking is offered on another model only if its query
// reports an `autotrack` key; snapshot firmware thresholds are the SE's.
//
// Per camera: one TCP socket, no timers.

import { PtzDriver, DriverError } from '../driver.js';
import { ViscaClient, FRAMING, nibbles, signed } from '../visca-client.js';
import { TABLE, GAPS } from '../tables/ptzoptics-move-se.js';

export { GAPS };

/** VISCA over TCP, default port (HTTP-PDF p.173; MSE-STREAM; COMP config.ts:58). */
const VISCA_TCP_PORT = 5678;

/**
 * Presets 0..254, with 90-99 and 150-151 not presets at all: 90 calls home,
 * 95 toggles the OSD menu, 91-94 / 96-99 are reserved (EX-SAVE banner),
 * 150 turns tracking on and 151 off (FW-0112). HTTP-PDF still calls 100-254
 * assignable, and Companion's validity check (presets.ts:5-12) lets 150/151
 * through; storing over 150 or recalling 95 from a panel would be a nasty
 * surprise on air, so the driver refuses them.
 */
const PRESET_MAX = 254;
const RESERVED_PRESETS = Object.freeze([90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 150, 151]);
/**
 * The panel's grid is 0..89 — every number below the first reserved one.
 * 100-149 and 152-254 are valid too (capabilities().presetMax); the lifecycle
 * accepts them, and #presetNumber refuses the reserved ones with a reason.
 */
const PRESET_BASE = 0;
const PRESET_COUNT = 90;

/** Pan speed 01..18h (1-24), tilt 01..14h (1-20) (VISCA-PDF p.24-27; COMP actions/pan-tilt.ts:60). */
const PAN_MAX = 0x18;
const TILT_MAX = 0x14;
/**
 * First firmware with `/snapshot0.jpg` per lens variant (FW-0930). Build
 * numbers differ by lens, and nothing on the wire says which lens it is, so
 * the config entry may say (`options.lens: '12X'|'20X'|'30X'`).
 */
const SNAPSHOT_SINCE_SE = { '12X': 66, '20X': 44, '30X': 46 };

/** Zoom 0000 full wide .. 4000 full tele (HTTP-PDF p.140, SE+). */
const ZOOM_TELE = 0x4000;

/**
 * Models with a dedicated table, and what is known of each. `deviceModel` is
 * the `device_model` field of get_device_conf: F51.HI is the Move 4K in
 * HTTP-PDF's example (p.187); F16.HI for the Move SE comes from the brief, not
 * from a source I could read (verify). A config entry can name the model
 * (`options.model: 'Move SE'`) when the camera does not report one.
 */
const MODELS = {
  'Move SE': { table: TABLE, zoomTele: ZOOM_TELE, tracking: true, snapshotSince: SNAPSHOT_SINCE_SE },
};
const DEVICE_MODEL_NAMES = { 'F16.HI': 'Move SE', 'F51.HI': 'Move 4K' };

/** Name for whatever the camera reported. */
export function modelName(dev, configured) {
  if (configured) return String(configured);
  const code = dev?.device_model;
  if (code && DEVICE_MODEL_NAMES[code]) return DEVICE_MODEL_NAMES[code];
  if (code) return `PTZOptics ${code}`;
  return 'PTZOptics (model not reported)';
}

/**
 * Model -> table. The Move SE has its own; any other PTZOptics (Move 4K, Link,
 * Studio, G2/G3) gets the Move SE table with every row marked verify — the
 * lifecycle hides what the camera refuses. A new dedicated table is one line
 * in MODELS.
 */
export function tableFor(model) {
  return MODELS[model]?.table ?? TABLE.map((e) => ({ ...e, verify: true }));
}

const BYTES = Object.freeze({
  powerInq: [0x81, 0x09, 0x04, 0x00, 0xff],                     // VISCA-PDF p.19 -> 90 50 02 FF (on)
  panTiltPosInq: [0x81, 0x09, 0x06, 0x12, 0xff],                // EX-SAVE get_position; COMP pan-tilt.ts:5
  zoomPosInq: [0x81, 0x09, 0x04, 0x47, 0xff],                   // VISCA-PDF p.22
  focusPosInq: [0x81, 0x09, 0x04, 0x48, 0xff],                  // VISCA-PDF p.22
  zoomStop: [0x81, 0x01, 0x04, 0x07, 0x00, 0xff],               // VISCA-PDF p.28
  focusStop: [0x81, 0x01, 0x04, 0x08, 0x00, 0xff],              // VISCA-PDF p.13
});

/** |v| in 0..1 onto 1..max; the smallest non-zero velocity is the slowest speed. */
export function speedFor(v, max) {
  return Math.min(max, Math.max(1, Math.round(Math.abs(v) * max)));
}

/** `key="value"` lines (HTTP-PDF query style b, p.180-190). */
export function parseLines(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*"?(.*?)"?\s*;?\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** `9.1.NN` out of whatever version string the camera gives. */
export function buildOf(firmware) {
  // "v9.1.66", "SOC v9.1.66", "9.1.66": no word boundary between v and 9.
  const m = /(?:^|[^\d.])9\.1\.(\d+)(?![\d.])/.exec(String(firmware ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Whether this firmware has /snapshot0.jpg: 'yes', 'no', or 'maybe' when the
 * build number falls between the lens variants' thresholds and the lens is
 * not known.
 */
export function snapshotSupport(firmware, lens, since = SNAPSHOT_SINCE_SE) {
  const build = buildOf(firmware);
  if (build === null || !since) return 'maybe';
  const need = since[String(lens ?? '').toUpperCase()];
  if (need !== undefined) return build >= need ? 'yes' : 'no';
  const all = Object.values(since);
  if (build >= Math.max(...all)) return 'yes';
  if (build < Math.min(...all)) return 'no';
  return 'maybe';
}

function httpError(r) {
  if (r.kind === 'auth') return new DriverError('the camera refused the username or password', { kind: 'auth' });
  if (r.kind === 'timeout') return new DriverError('the camera did not answer', { kind: 'timeout' });
  if (r.kind === 'network') return new DriverError(`cannot reach the camera (${r.error})`, { kind: 'network' });
  // Error bodies other than 401 are not documented (notes §2.4).
  if (r.status === 404) return new DriverError('this camera firmware does not have that command', { code: 'notFound', kind: 'unsupported' });
  return new DriverError(`the camera refused it (HTTP ${r.status})`, { code: `http${r.status}`, kind: 'refused' });
}

const isLinkFailure = (err) => err?.kind === 'timeout' || err?.kind === 'network';

/** A JSON body with a Result other than Success is a refusal (schema `{Result: Success}`, HTTP-PDF p.6). */
function checkResult(r) {
  const text = r.text ?? '';
  if (!text.trim().startsWith('{')) return;
  let j;
  try { j = JSON.parse(text); } catch { return; }
  if (j && typeof j.Result === 'string' && !/^success$/i.test(j.Result)) {
    throw new DriverError(`the camera refused it (${j.Result})`, { code: 'result', kind: 'refused' });
  }
}

export class PtzOptics extends PtzDriver {
  static vendor = 'ptzoptics';
  static label = 'PTZOptics';
  static models = ['Move SE'];
  // No source gives a minimum interval (notes §2.3). The VISCA client already
  // waits for each reply before the next message; 50 ms between commands is a
  // conservative guess on top, well under a joystick's refresh.
  static minIntervalMs = 50;
  // Reads are a VISCA inquiry each, or one of a few CGI queries shared by many
  // entries, so a batch of 8 is a handful of round trips.
  static readBatch = 8;

  /**
   * Read-only and cheap: one HTTP query, then — only if that is not
   * conclusive — a VISCA power inquiry on TCP 5678.
   *
   * `get_device_conf` answers JSON whose `mirrors` field is the PTZOptics
   * firmware server (HTTP-PDF p.187; GEN3-UI): the strongest vendor marker,
   * but documented for the Move 4K / Link 4K only (verify). A Sony or
   * Panasonic has no such route and no raw VISCA on TCP 5678, so the fallback
   * (raw VISCA answering `90 50 0p FF` on 5678 — the PTZOptics default port)
   * does not claim them.
   */
  static async probe(ctx) {
    const port = ctx.port ?? 80;
    const r = await ctx.http({
      host: ctx.host, port, path: '/cgi-bin/param.cgi?get_device_conf', auth: ctx.auth, timeoutMs: ctx.timeoutMs,
    });
    if (r.ok) {
      const d = parseDeviceConf(r.text);
      if (d && /ptzoptics/i.test(`${d.mirrors ?? ''} ${d.devname ?? ''} ${d.devtype ?? ''}`)) {
        return { vendor: 'ptzoptics', model: modelName(d, ctx.options?.model), firmware: d.versioninfo, serial: d.serial_num, name: d.devname };
      }
    }
    const viscaPort = ctx.options?.viscaPort ?? VISCA_TCP_PORT;
    const answers = await probeVisca({ host: ctx.host, port: viscaPort, timeoutMs: Math.min(ctx.timeoutMs ?? 1500, 1500) });
    if (!answers) return null;
    if (r.kind === 'auth') throw new DriverError('the camera refused the username or password', { kind: 'auth' });
    return { vendor: 'ptzoptics', model: modelName(null, ctx.options?.model) };
  }

  constructor(ctx) {
    super(ctx);
    this.port = ctx.port ?? 80;
    this.timeoutMs = ctx.timeoutMs ?? 3000;
    const o = ctx.options ?? {};
    this.lens = o.lens;
    this.configuredModel = o.model;
    this.model = o.model ?? 'Move SE';
    this.tracking = false;
    this.visca = new ViscaClient({
      host: this.host,
      port: o.viscaPort ?? VISCA_TCP_PORT,
      framing: FRAMING.RAW_TCP,
      timeoutMs: Math.min(this.timeoutMs, 2000),
      log: this.log,
    });
    this.identity = null;
    this.entries = TABLE;
    this.byId = new Map(TABLE.map((e) => [e.id, e]));
    this.seen = new Map();
    /** CGI queries found missing on this camera; not asked again until reconnect. */
    this.missing = new Set();
    this.snapshotState = 'maybe';
  }

  // --- transports --------------------------------------------------------------

  async #http(path, { method = 'GET' } = {}) {
    const r = await this.http({
      host: this.host, port: this.port, path, method, auth: this.auth, timeoutMs: this.timeoutMs,
      // POST commands want an empty body with Content-Length: 0 (notes §2.4).
      body: method === 'POST' ? '' : undefined,
    });
    if (!r.ok) throw httpError(r);
    return r;
  }

  async #cgi(path, method = 'GET') {
    checkResult(await this.#http(path, { method }));
  }

  /** One of the `get_*` queries, parsed. null when this camera does not have it. */
  async #conf(name, cache) {
    if (cache?.has(name)) return cache.get(name);
    const paths = {
      // `image` is two queries whose keys are not split between them by any
      // source; both are fetched and merged.
      image: ['/cgi-bin/param.cgi?get_image_conf', '/cgi-bin/param.cgi?get_advance_image_conf'],  // HTTP-PDF p.180-190 (4K)
      advance: ['/cgi-bin/param.cgi?get_advance_image_conf'],     // HTTP-PDF p.189 (4K): autotrack
      video: ['/cgi-bin/param.cgi?get_media_video'],             // HTTP-PDF (4K)
      audio: ['/cgi-bin/param.cgi?get_media_audio'],             // HTTP-PDF (4K)
      ir: ['/cgi-bin/param.cgi?query_ir_info'],                  // HTTP-PDF p.254 (4K read)
      device: ['/cgi-bin/param.cgi?get_device_conf'],            // HTTP-PDF p.186 (4K)
    }[name];
    let merged = null;
    for (const p of paths) {
      if (this.missing.has(p)) continue;
      try {
        const r = await this.#http(p);
        const parsed = name === 'device' ? parseDeviceConf(r.text) : parseLines(r.text);
        if (parsed) merged = { ...(merged ?? {}), ...parsed };
      } catch (err) {
        if (err.kind !== 'unsupported' && err.kind !== 'refused') throw err;
        this.missing.add(p);
      }
    }
    cache?.set(name, merged);
    return merged;
  }

  // --- identity ------------------------------------------------------------------

  async identify() {
    // VISCA first: it is the control path, and the cheapest proof of life.
    let viscaErr = null;
    try {
      await this.visca.inquiry(BYTES.powerInq);
    } catch (err) {
      viscaErr = err;
    }
    let dev = null;
    try {
      dev = await this.#conf('device');
    } catch (err) {
      // A missing query is already null (#conf); anything else — wrong
      // password, no answer — is a camera that is not ready.
      throw err.kind === 'auth' || !viscaErr ? err : viscaErr;
    }
    // get_device_conf on the SE is unconfirmed: fields are optional.
    this.identity = {
      vendor: 'ptzoptics',
      model: modelName(dev, this.configuredModel),
      firmware: dev?.versioninfo,
      serial: dev?.serial_num,
      name: dev?.devname,
      deviceModel: dev?.device_model,
      viscaAvailable: !viscaErr,
    };
    this.model = this.identity.model;
    this.identity.dedicatedTable = !!MODELS[this.model];
    const profile = MODELS[this.model];
    // Snapshot firmware thresholds are Move SE ones; for anything else, try.
    this.snapshotState = snapshotSupport(this.identity.firmware, this.lens, profile?.snapshotSince);
    // Auto tracking: every Move SE has it (FW-0623 initial firmware, no
    // licence; MSE-TRACK). Another model only if its get_advance_image_conf
    // reports an `autotrack` key — otherwise no tracking is offered.
    this.tracking = !!profile?.tracking;
    if (!this.tracking) {
      const adv = await this.#conf('advance');
      this.tracking = adv?.autotrack !== undefined;
    }
    this.identity.tracking = this.tracking;
    if (viscaErr) this.log('warn', `VISCA on TCP ${this.visca.port} is not answering (${viscaErr.message}); motion will not work`);
    return this.identity;
  }

  async heartbeat() {
    await this.visca.inquiry(BYTES.powerInq);
  }

  schema(identity = this.identity) {
    const tracking = identity?.tracking ?? this.tracking;
    this.entries = tableFor(identity?.model ?? this.model).filter((e) => e.requires !== 'tracking' || tracking);
    this.byId = new Map(this.entries.map((e) => [e.id, e]));
    return this.entries;
  }

  capabilities() {
    return {
      panTilt: true,
      zoom: true,
      focus: true,
      presets: PRESET_COUNT,
      presetBase: PRESET_BASE,
      // The panel's grid is 0–89; Companion, VISCA and the SKAARHOJ panel may
      // use the rest of the camera's range, around the reserved numbers.
      presetMax: PRESET_MAX,
      reservedPresets: RESERVED_PRESETS,
      tracking: this.tracking ? { kind: 'autoTracking', label: 'Auto tracking' } : null,
      // No tally command and no tally connector on the SE (notes §8).
      tally: false,
      snapshot: this.snapshotState !== 'no',
      pointToCentre: false,
      power: false,
    };
  }

  // --- settings ------------------------------------------------------------------

  /**
   * Link failures come back as `{ superseded: true }`, not a throw: the
   * lifecycle's first read after connecting is awaited inside an uncaught
   * `#connect()` (lifecycle.js:226), where a timeout would be an unhandled
   * rejection. Superseded results are skipped and not counted as proof of
   * life, so the heartbeat still decides health. (Foundation change reported.)
   */
  async read(entries) {
    try {
      return await this.#read(entries);
    } catch (err) {
      if (!isLinkFailure(err)) throw err;
      this.log('debug', `read not answered: ${err.message}`);
      return { superseded: true };
    }
  }

  async #read(entries) {
    const out = {};
    const cache = new Map();
    for (const e of entries) {
      if (e.type === 'action') continue;
      const rd = e.wire?.read;
      if (!rd) { out[e.id] = { value: null }; continue; }        // write-only: nothing to read back
      try {
        let v;
        if (rd.local) v = this.identity?.[rd.local] ?? null;
        else if (rd.visca) v = rd.dec(await this.visca.inquiry(rd.visca));
        else if (rd.api) {
          const r = await this.#http(rd.api);
          v = rd.dec(JSON.parse(r.text));
        } else if (rd.conf) {
          const conf = await this.#conf(rd.conf, cache);
          const raw = conf?.[rd.key];
          // Not reported: unknown, still writable (see the header).
          v = raw === undefined || raw === null ? null : rd.dec(String(raw));
        }
        if (typeof v === 'number' && !Number.isFinite(v)) v = null;
        out[e.id] = { value: v };
        if (v !== null) this.seen.set(e.id, v);
      } catch (err) {
        if (err.kind === 'refused' || err.kind === 'unsupported' || err instanceof SyntaxError) {
          // A VISCA syntax error, a missing route: this camera does not offer it.
          out[e.id] = e.readOnly ? { error: err.message, unsupported: true } : { value: null };
          continue;
        }
        throw err;
      }
    }
    for (const [id, r] of Object.entries(out)) {
      const e = this.byId.get(id);
      if (!e?.gate || r.error) continue;
      const g = out[e.gate.id]?.value ?? this.seen.get(e.gate.id);
      if (g !== undefined && g !== null) r.writable = g === e.gate.value;
    }
    return out;
  }

  async write(entry, value) {
    if (entry.readOnly || entry.type === 'action') throw new DriverError(`${entry.label} cannot be set`, { kind: 'refused' });
    if (entry.gate) {
      const gateEntry = this.byId.get(entry.gate.id);
      const now = gateEntry ? (await this.#read([gateEntry]))[gateEntry.id]?.value : undefined;
      // An unknown gate (the SE did not report it) lets the camera decide.
      if (now !== undefined && now !== null && now !== entry.gate.value) {
        const want = gateEntry.options?.find((o) => o.value === entry.gate.value)?.label
          ?? (entry.gate.value === true ? 'on' : entry.gate.value === false ? 'off' : String(entry.gate.value));
        throw new DriverError(`${entry.label} can only be changed while ${gateEntry.label} is ${want}`, { code: 'gate', kind: 'refused' });
      }
    }
    const w = entry.wire.write;
    if (w.visca) {
      await this.visca.command(w.visca(value));
    } else if (w.focusRange) {
      await this.#writeFocusRange(w.focusRange, value);
    } else if (w.tracking) {
      await this.#setTracking(value);
    } else {
      await this.#cgi(w.path(value), w.method);
    }
    this.seen.set(entry.id, value);
    return {};
  }

  /**
   * Focus limit is one request with three values:
   * `param.cgi?post_zoomfocus&type=focusrange&enable=<0|1>&near=<0..11>&far=<0..11>`
   * (HTTP-PDF p.69, SE+). The two not being changed are sent as last seen.
   */
  async #writeFocusRange(which, value) {
    const ids = { enable: 'focusLimit', near: 'focusLimitNear', far: 'focusLimitFar' };
    const now = await this.#read(Object.values(ids).map((id) => this.byId.get(id)));
    const cur = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, now[id]?.value ?? this.seen.get(id)]));
    cur[which] = value;
    if (cur.near === null || cur.near === undefined || cur.far === null || cur.far === undefined) {
      throw new DriverError('the camera does not report its focus limits, so one cannot be changed on its own', { code: 'unknown', kind: 'refused' });
    }
    if (cur.near > cur.far) throw new DriverError('the nearest focus limit must not be beyond the furthest', { code: 'range', kind: 'refused' });
    await this.#cgi(`/cgi-bin/param.cgi?post_zoomfocus&type=focusrange&enable=${cur.enable ? 1 : 0}&near=${cur.near}&far=${cur.far}`);
  }

  /**
   * Auto tracking on/off: `param.cgi?set_overlay&autotracking&on|off`
   * (HTTP-PDF p.99, SE+). Only if this firmware lacks that route, the VISCA
   * form `81 0A 11 54 0p FF` (p 2 on / 3 off) — implementation-only (COMP
   * auto-tracking.ts:11).
   */
  async #setTracking(on) {
    try {
      await this.#cgi(`/cgi-bin/param.cgi?set_overlay&autotracking&${on ? 'on' : 'off'}`);
    } catch (err) {
      if (err.kind !== 'unsupported') throw err;
      this.log('info', 'tracking CGI missing; using the VISCA form (unverified on Move SE)');
      await this.visca.command([0x81, 0x0a, 0x11, 0x54, on ? 0x02 : 0x03, 0xff]);
    }
  }

  async action(entry) {
    const a = entry.wire?.act;
    if (!a) throw new DriverError(`${entry.label} is not supported`, { kind: 'unsupported' });
    if (a.visca) await this.visca.command(a.visca);
    else await this.#cgi(a.path, a.method);
    return {};
  }

  // --- motion --------------------------------------------------------------------

  /**
   * `81 01 06 01 VV WW DP DT FF`: both speed bytes always present, even for a
   * stopped axis (VISCA-PDF p.27). DP 01 left / 02 right / 03 stop; DT 01 up /
   * 02 down / 03 stop (VISCA-PDF p.24-25).
   */
  async panTilt(pan, tilt) {
    const vv = pan === 0 ? 0x01 : speedFor(pan, PAN_MAX);
    const ww = tilt === 0 ? 0x01 : speedFor(tilt, TILT_MAX);
    const dp = pan > 0 ? 0x02 : pan < 0 ? 0x01 : 0x03;
    const dt = tilt > 0 ? 0x01 : tilt < 0 ? 0x02 : 0x03;
    await this.visca.command([0x81, 0x01, 0x06, 0x01, vv, ww, dp, dt, 0xff]);
  }

  /** Tele `81 01 04 07 2p FF`, wide `3p`, p 0 (low)..7 (high); stop `00` (VISCA-PDF p.28-29). */
  async zoom(speed) {
    if (speed === 0) { await this.visca.command(BYTES.zoomStop); return; }
    const p = speedFor(speed, 8) - 1;
    await this.visca.command([0x81, 0x01, 0x04, 0x07, (speed > 0 ? 0x20 : 0x30) | p, 0xff]);
  }

  /**
   * Far `81 01 04 08 02 FF`, near `03`, stop `00` (VISCA-PDF p.13; COMP
   * focus.ts:5-7). The variable-speed form `2p`/`3p` exists but its range is
   * not stated (notes §5.1), so the fixed-speed form is used and the
   * magnitude only decides direction.
   */
  async focus(speed) {
    const b = speed === 0 ? 0x00 : speed > 0 ? 0x02 : 0x03;
    try {
      await this.visca.command([0x81, 0x01, 0x04, 0x08, b, 0xff]);
    } catch (err) {
      if (err.code === 'notExecutable') {
        throw new DriverError('Focus is on auto — set Focus mode to Manual to pull focus', { code: err.code, kind: 'refused' });
      }
      throw err;
    }
  }

  /**
   * Three separate stops. Since firmware 12X 9.1.46 / 20X 9.1.34 / 30X 9.1.39
   * a pan/tilt stop no longer stops zoom (FW-0112), so the pan/tilt stop
   * alone is not "stop everything" (notes §5). Pan/tilt goes first.
   *
   * If VISCA is not answering, the same three stops go over CGI
   * (`ptzcmd&ptzstop`, `zoomstop`, `focusstop`; HTTP-PDF p.124-143, SE+):
   * a stop must not depend on one socket.
   */
  async stop() {
    try {
      await this.visca.command([0x81, 0x01, 0x06, 0x01, 0x01, 0x01, 0x03, 0x03, 0xff]);
      await this.visca.command(BYTES.zoomStop);
      await this.visca.command(BYTES.focusStop).catch((err) => { if (isLinkFailure(err)) throw err; });
      return;
    } catch (err) {
      if (!isLinkFailure(err)) throw err;
      this.log('warn', `VISCA stop failed (${err.message}); stopping over HTTP`);
    }
    await this.#cgi('/cgi-bin/ptzctrl.cgi?ptzcmd&ptzstop');
    await this.#cgi('/cgi-bin/ptzctrl.cgi?ptzcmd&zoomstop');
    await this.#cgi('/cgi-bin/ptzctrl.cgi?ptzcmd&focusstop');
  }

  /**
   * Pan/tilt come back as four nibbles each (`90 50 0p×4 0t×4 FF`; EX-SAVE,
   * COMP pan-tilt.ts:5), but the Move SE's step scale is not documented
   * (notes Gaps 3: the 4K's ±0990 table does not apply to a ±170° head), so
   * they are reported raw and not normalised. Zoom spans 0000..4000 (HTTP-PDF
   * p.140, SE+). Focus range is undocumented.
   */
  async position() {
    const pt = await this.visca.inquiry(BYTES.panTiltPosInq);
    const z = await this.visca.inquiry(BYTES.zoomPosInq);
    const f = await this.visca.inquiry(BYTES.focusPosInq);
    const raw = {
      pan: pt.length >= 11 ? signed(nibbles(pt, 2, 4), 16) : null,
      tilt: pt.length >= 11 ? signed(nibbles(pt, 6, 4), 16) : null,
      zoom: nibbles(z, 2, 4),
      focus: nibbles(f, 2, 4),
    };
    const tele = MODELS[this.model]?.zoomTele;
    return { pan: null, tilt: null, zoom: tele ? Math.max(0, Math.min(1, raw.zoom / tele)) : null, focus: null, raw };
  }

  async status() {
    if (!this.tracking) return {};
    // Tracking state can only be read through get_advance_image_conf
    // (`autotrack`), which is Move 4K / Link 4K in the docs; null when absent.
    const conf = await this.#conf('advance');
    const t = conf?.autotrack;
    return { tracking: t === undefined ? undefined : Number(t) === 1 };
  }

  // --- presets -------------------------------------------------------------------

  #presetNumber(n) {
    if (!Number.isInteger(n) || n < 0 || n > PRESET_MAX) {
      throw new DriverError(`preset numbers on this camera run 0–${PRESET_MAX}`, { code: 'range', kind: 'refused' });
    }
    if (RESERVED_PRESETS.includes(n)) {
      const what = n === 90 ? 'calls Home' : n === 95 ? 'opens the on-screen menu'
        : n === 150 ? 'turns auto tracking on' : n === 151 ? 'turns auto tracking off' : 'is reserved';
      throw new DriverError(`preset ${n} ${what} on PTZOptics cameras; use 0–89, 100–149 or 152–254`, { code: 'reserved', kind: 'refused' });
    }
    return n;
  }

  /** `81 01 04 3F 02 pp FF`, pp = number (EX-SAVE recall_preset; COMP presets.ts:20). */
  async presetRecall(n) {
    await this.visca.command([0x81, 0x01, 0x04, 0x3f, 0x02, this.#presetNumber(n), 0xff]);
    return {};
  }

  /** `81 01 04 3F 01 pp FF` (EX-RESTORE set_preset; COMP presets.ts:14). */
  async presetStore(n) {
    await this.visca.command([0x81, 0x01, 0x04, 0x3f, 0x01, this.#presetNumber(n), 0xff]);
    return {};
  }

  // presetDelete: no documented command (notes §6) — the base class says so.

  // --- picture -------------------------------------------------------------------

  /**
   * `/snapshot0.jpg` (stream 1) from firmware 12X 9.1.66 / 20X 9.1.44 / 30X
   * 9.1.46 (FW-0930). Earlier firmware had snapshots but no source gives the
   * URL (notes §7), so there it is unsupported rather than guessed.
   */
  async snapshot() {
    const why = 'This camera\'s firmware has no documented snapshot URL; update to 12X 9.1.66, 20X 9.1.44 or 30X 9.1.46 or later.';
    if (this.snapshotState === 'no') throw new DriverError(why, { kind: 'unsupported' });
    let r;
    try {
      r = await this.#http('/snapshot0.jpg');
    } catch (err) {
      if (err.kind === 'unsupported') {
        this.snapshotState = 'no';
        throw new DriverError(why, { kind: 'unsupported' });
      }
      throw err;
    }
    this.snapshotState = 'yes';
    return { contentType: String(r.headers?.['content-type'] ?? 'image/jpeg').split(';')[0], body: r.body };
  }

  close() {
    this.visca.close();
  }
}

/** `{"status":200,"data":{...}}` (HTTP-PDF p.186-187); null if it is not that. */
function parseDeviceConf(text) {
  try {
    const j = JSON.parse(text);
    return j && typeof j.data === 'object' && j.data !== null ? j.data : null;
  } catch {
    return null;
  }
}

/** Raw VISCA on TCP: does a power inquiry come back as `z0 50 0p FF`? */
async function probeVisca({ host, port, timeoutMs }) {
  const c = new ViscaClient({ host, port, framing: FRAMING.RAW_TCP, timeoutMs });
  try {
    const r = await c.inquiry(BYTES.powerInq);
    return r.length === 4 && [0x02, 0x03, 0x04].includes(r[2]);
  } catch {
    return false;
  } finally {
    c.close();
  }
}
