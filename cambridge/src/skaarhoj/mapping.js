// What a SKAARHOJ panel's controls mean, when CamBridge is driving it.
//
// rawpanel.js reports "HWC 37 says Speed:-120"; this decides that HWC 37 is
// the joystick's pan axis and that the selected camera should pan left.
//
// There is no list of PTZ Extreme control numbers to work from: the notes say
// plainly that the HWC ids are undocumented (notes §7, §10.1), and a small
// batch of units even shipped with the joystick turned 90° (notes §5). So the
// roles are read from the topology the panel itself reports — what kind of
// input each control is, whether it has a display, where it sits — and an
// admin can pin any role to a specific id in `skaarhoj.mapping` when the
// guess is wrong. The guesses are described in detectRoles() and in
// docs/skaarhoj.md, so whoever is standing at the panel can predict them.
//
// Motion is the part that has to be right. The panel sends joystick values
// on change and nothing while the stick is held still (notes §5), so a
// joystick move is *latched* in the motion controller — it holds until the
// panel says Speed:0 — and every way the panel can stop being trustworthy
// (TCP drop, missed heartbeats, sleep, Blocked health, the axis vanishing
// from the map) releases it.

import { EventEmitter } from 'node:events';
import { LED, COLOUR, hwcText } from './rawpanel.js';
import { labelFor, needsAdmin } from '../ptz/schema.js';

/** The motion controller's name for this surface. releaseSource() uses it. */
export const SOURCE = 'skaarhoj';

/**
 * Settings the encoder bank shows first, by role (the coordinator's list):
 * the ones an operator rides during a shot. Other `operate` entries follow.
 */
const ENCODER_FIRST = ['iris', 'gain', 'shutter', 'nd', 'colorTemp'];

/**
 * Entries are bound by the role their driver tagged them with, and only by
 * that. Guessing from an id would bind an untagged entry that merely happens
 * to be called "gain" on some vendor to the gain encoder.
 */
export const roleOf = (entry) => entry?.role ?? null;

// --- topology ------------------------------------------------------------------

/** notes §4: `in` is "<type>[,param=value...]"; steps=, stepList=, max=, dim=. */
function parseIn(s) {
  const [type, ...rest] = String(s ?? '').split(',');
  const params = {};
  for (const p of rest) {
    const [k, v] = p.split('=');
    if (k && v !== undefined) params[k.trim()] = v.trim();
  }
  return {
    inType: type.trim(),
    max: Number.isFinite(Number(params.max)) && Number(params.max) > 0 ? Number(params.max) : null,
    dim: Number.isFinite(Number(params.dim)) ? Number(params.dim) : 0,
  };
}

const isButton = (t) => t === 'b' || t === 'b4' || t === 'b2v' || t === 'b2h';   // notes §4 `in` table
const isPulsed = (t) => t === 'p' || t === 'pb' || t === 'pi';
const isIntensity = (t) => t === 'iv' || t === 'ih' || t === 'ir' || t === 'i';
const isAbsolute = (t) => t === 'av' || t === 'ah' || t === 'ar' || t === 'a';

/**
 * Flattens the topology into one record per usable control.
 *
 * notes §4: a component's type is `typeIndex[type]` with `typeOverride` laid
 * over it; type 0 is disabled; a client should not use a control the map has
 * not reported (RWPv2 p.31, 52-54).
 */
export function components(topology, available = () => true) {
  const out = [];
  const index = topology?.typeIndex ?? {};
  for (const hw of Array.isArray(topology?.HWc) ? topology.HWc : []) {
    const id = Number(hw?.id);
    if (!Number.isInteger(id) || id <= 0 || !hw.type || !available(id)) continue;
    const base = index[String(hw.type)];
    if (!base || typeof base !== 'object') continue;
    const t = { ...base, ...(hw.typeOverride && typeof hw.typeOverride === 'object' ? hw.typeOverride : {}) };
    const { inType, max, dim } = parseIn(t.in);
    out.push({
      id,
      x: Number(hw.x) || 0,
      y: Number(hw.y) || 0,
      txt: String(hw.txt ?? ''),
      // Text the role guesses read. `desc` is the type's description, which
      // is where "Zoom Rocker" or "Joystick" would be said if anywhere.
      words: `${hw.txt ?? ''} ${t.desc ?? ''}`.toLowerCase(),
      inType, max, dim,
      out: t.out ? String(t.out) : '',
      disp: t.disp && typeof t.disp === 'object' ? t.disp : null,
      w: Number(t.w) || 0,
      // notes §4: no `h` means a circle. Rollers and rockers are drawn as
      // rectangles, encoders as circles — one of the few shape clues there is.
      h: Number(t.h) || 0,
      yang: Number(hw.UIyang) || 0,
      parent: Number(hw.UIparent) || 0,
    });
  }
  return out;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Reading order: rows top to bottom, then left to right. Returns rows. */
function rows(list) {
  const sorted = [...list].sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const c of sorted) {
    const row = out.at(-1);
    // Same row when within half a control's height of the row's first control.
    const tol = Math.max(20, (row?.[0].h || row?.[0].w || 100) / 2);
    if (row && Math.abs(c.y - row[0].y) <= tol) row.push(c);
    else out.push([c]);
  }
  for (const r of out) r.sort((a, b) => a.x - b.x);
  return out;
}

const OVERRIDE_SINGLE = ['pan', 'tilt', 'rotate', 'zoom', 'focus', 'stop', 'store', 'tracking', 'bankNext', 'bankPrev'];
const OVERRIDE_LIST = ['cameras', 'presets', 'encoders'];
const posInt = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/**
 * Decides which control does what.
 *
 * Heuristics, in order (each skips anything already pinned by the override):
 *
 *  1. Joystick. Intensity inputs (`iv`/`ih`/`ir`, which report Speed) are
 *     spring-loaded axes (notes §4, §5). A horizontal and a vertical axis
 *     that name each other in `UIyang` are the stick — pan and tilt. With no
 *     pairing, the first `ih` is pan and the `iv` nearest it is tilt. One
 *     intensity control with `dim>=2` reporting a vector is a whole stick.
 *     The rotary axis (`ir`) nearest the stick is its twist.
 *  2. Zoom. A control whose label or description says "zoom"; otherwise the
 *     unlabelled intensity axis left over after the stick (the PTZ Extreme
 *     has one rocker, "no labels", notes §7). An absolute control is only
 *     taken when labelled, because a fader that does not spring back would
 *     zoom for ever.
 *  3. Focus. A control labelled "focus"; otherwise an unlabelled pulsed input
 *     drawn as a rectangle — a roller, where encoders are circles. A control
 *     whose label says something else is never guessed into either role.
 *  4. Encoders. Every other pulsed input (`p`/`pb`/`pi`), in reading order.
 *     Each shows its setting on its own display if it has one, else on the
 *     nearest display-only control.
 *  5. Buttons, by label: "stop", "store"/"shift"/"save", "track".
 *     Bank and group buttons are found the same way: a label with "group"
 *     is the group button; "next", "prev", "bank", "page" or an arrow is a
 *     bank button (a bank button that says only "bank" or "page", or has
 *     both arrows, pages forward and wraps).
 *  6. The remaining buttons with displays, in reading order: camera buttons
 *     (at most `skaarhoj.mapping.cameraButtons`, by default a third of the
 *     display buttons up to 8), then presets from the start of the next row,
 *     then STORE and TRACKING if no labelled ones were found. When there are
 *     more cameras than camera buttons they are paged in banks; with no bank
 *     buttons found or pinned, the last two camera buttons become bank
 *     previous and next. STOP is never assigned by position: a stop button
 *     must be one somebody chose.
 *
 * @param {object|null} topology  the panel's `_panelTopology_HWC` JSON
 * @param {object} o
 * @param {number} o.cameraCount   cameras the panel can reach (after any group restriction)
 * @param {object} [o.override]   `skaarhoj.mapping` from the config
 * @param {(id: number) => boolean} [o.available]
 */
export function detectRoles(topology, { cameraCount = 0, override = {}, available } = {}) {
  const ov = override && typeof override === 'object' ? override : {};
  const comps = components(topology, available);
  const byId = new Map(comps.map((c) => [c.id, c]));
  const roles = {
    pan: null, tilt: null, rotate: null, vector: null, zoom: null, focus: null,
    stop: null, store: null, tracking: null,
    bankNext: null, bankPrev: null, group: null, bankFallback: false,
    cameras: [], presets: [], encoders: [], displays: {},
    pinned: [],
  };

  // --- the override first: what an admin pinned is never second-guessed ---
  const taken = new Set();
  for (const k of OVERRIDE_SINGLE) {
    const id = posInt(ov[k]);
    if (id) { roles[k] = id; taken.add(id); roles.pinned.push(k); }
  }
  // `mapping.group` is the *name* of a group to restrict the panel to, so the
  // button that cycles groups is pinned as `groupButton`.
  const groupButton = posInt(ov.groupButton);
  if (groupButton) { roles.group = groupButton; taken.add(groupButton); roles.pinned.push('groupButton'); }
  for (const k of OVERRIDE_LIST) {
    if (!Array.isArray(ov[k])) continue;
    roles[k] = ov[k].map(posInt).filter(Boolean);
    for (const id of roles[k]) taken.add(id);
    roles.pinned.push(k);
  }
  if (ov.encoderDisplays && typeof ov.encoderDisplays === 'object') {
    for (const [enc, disp] of Object.entries(ov.encoderDisplays)) {
      if (posInt(enc) && posInt(disp)) { roles.displays[posInt(enc)] = posInt(disp); taken.add(posInt(disp)); }
    }
  }
  const free = (c) => !taken.has(c.id);
  const take = (role, c) => { if (c) { roles[role] = c.id; taken.add(c.id); } return c; };
  const says = (c, re) => re.test(c.words);

  // --- 1. joystick ---
  const intensity = comps.filter((c) => isIntensity(c.inType) && free(c) && !says(c, /zoom|focus/));
  if (!roles.pan && !roles.tilt) {
    const vec = intensity.find((c) => c.dim >= 2);
    let pair = null;
    for (const c of intensity) {
      const o = byId.get(c.yang);
      if (!o || !intensity.includes(o)) continue;
      if (c.inType === 'ih' && o.inType === 'iv') { pair = [c, o]; break; }
      if (c.inType === 'iv' && o.inType === 'ih') { pair = [o, c]; break; }
    }
    if (pair) {
      take('pan', pair[0]);
      take('tilt', pair[1]);
    } else if (vec) {
      roles.vector = vec.id;
      taken.add(vec.id);
    } else {
      const h = intensity.find((c) => c.inType === 'ih' && free(c));
      take('pan', h);
      const vs = intensity.filter((c) => c.inType === 'iv' && free(c));
      if (h) vs.sort((a, b) => dist(a, h) - dist(b, h));
      take('tilt', vs[0]);
    }
  }
  const stick = byId.get(roles.pan) ?? byId.get(roles.tilt) ?? byId.get(roles.vector);
  if (!roles.rotate) {
    const rs = intensity.filter((c) => c.inType === 'ir' && free(c));
    const linked = rs.find((c) => c.yang === roles.pan || c.yang === roles.tilt || c.parent === roles.pan || c.parent === roles.tilt);
    if (stick) rs.sort((a, b) => dist(a, stick) - dist(b, stick));
    take('rotate', linked ?? rs.find((c) => says(c, /rotat|twist/)) ?? (stick ? rs[0] : undefined));
  }

  // --- 2. zoom ---
  if (!roles.zoom) {
    const labelled = comps.find((c) => free(c) && says(c, /zoom/)
      && (isIntensity(c.inType) || isAbsolute(c.inType) || isPulsed(c.inType)));
    take('zoom', labelled ?? comps.find((c) => free(c) && !c.txt && isIntensity(c.inType) && c.inType !== 'ir' && !says(c, /focus/)));
  }

  // --- 3. focus ---
  if (!roles.focus) {
    const labelled = comps.find((c) => free(c) && says(c, /focus/)
      && (isIntensity(c.inType) || isAbsolute(c.inType) || isPulsed(c.inType)));
    take('focus', labelled ?? comps.find((c) => free(c) && !c.txt && isPulsed(c.inType) && c.h > 0));
  }

  // --- 4. encoders, and where each shows its value ---
  if (!roles.pinned.includes('encoders')) {
    roles.encoders = rows(comps.filter((c) => free(c) && isPulsed(c.inType))).flat().map((c) => c.id);
    for (const id of roles.encoders) taken.add(id);
  }
  const displayOnly = comps.filter((c) => c.disp && !c.inType && free(c));
  for (const id of roles.encoders) {
    if (roles.displays[id]) continue;
    const enc = byId.get(id);
    if (!enc) continue;
    if (enc.disp) { roles.displays[id] = id; continue; }
    // Nearest unclaimed display within 6 cm (topology units are 1/10 mm, notes §4).
    const near = displayOnly.filter((d) => free(d)).sort((a, b) => dist(a, enc) - dist(b, enc))[0];
    if (near && dist(near, enc) <= 600) { roles.displays[id] = near.id; taken.add(near.id); }
  }

  // --- 5. labelled buttons ---
  const buttons = comps.filter((c) => isButton(c.inType));
  if (!roles.stop) take('stop', buttons.find((c) => free(c) && /\bstop\b/.test(c.words)));
  if (!roles.store) take('store', buttons.find((c) => free(c) && /\b(store|shift|save)\b/.test(c.words)));
  if (!roles.tracking) take('tracking', buttons.find((c) => free(c) && /track/.test(c.words)));
  // Bank and group buttons, by label. "group" is checked first so a button
  // labelled "Next group" cycles groups rather than banks.
  const navKind = (c) => {
    const w = c.words;
    if (/\bgroups?\b/.test(w)) return 'group';
    const next = /\bnext\b|▶|►|→|\b(bank|page)\s*(up|\+)/.test(w);
    const prev = /\bprev(ious)?\b|◀|◄|←|\b(bank|page)\s*(down|-)/.test(w);
    if (next && prev) return 'next';   // "◀▶": one button, pages on and wraps
    if (prev) return 'prev';
    if (next || /\b(bank|page)s?\b/.test(w)) return 'next';
    return null;
  };
  if (!roles.group) take('group', buttons.find((c) => free(c) && navKind(c) === 'group'));
  if (!roles.bankNext) take('bankNext', buttons.find((c) => free(c) && navKind(c) === 'next'));
  if (!roles.bankPrev) take('bankPrev', buttons.find((c) => free(c) && navKind(c) === 'prev'));

  // --- 6. display buttons by position ---
  const grid = rows(buttons.filter((c) => c.disp && free(c)));
  const flat = grid.flat();
  let at = 0;
  const hasBankButtons = !!(roles.bankNext || roles.bankPrev);
  // A third of the display buttons, so presets and the rest keep theirs
  // however many cameras there are; 8 on a PTZ Extreme.
  const displayButtons = comps.filter((c) => isButton(c.inType) && c.disp).length;
  const cap = posInt(ov.cameraButtons) ?? Math.max(2, Math.min(8, Math.floor(displayButtons / 3)));
  /** With nowhere else to page from, the last two camera buttons turn the banks. */
  const useLastTwoForBanks = (ids) => {
    roles.bankPrev = ids.at(-2);
    roles.bankNext = ids.at(-1);
    roles.bankFallback = true;
    taken.add(roles.bankPrev);
    taken.add(roles.bankNext);
    return ids.slice(0, -2);
  };
  let region = [];   // every button set aside for cameras, bank buttons included
  if (!roles.pinned.includes('cameras')) {
    const paging = cameraCount > cap;
    const slots = paging && !hasBankButtons ? Math.max(cap, 3) : Math.min(cap, cameraCount);
    region = flat.slice(0, slots).map((c) => c.id);
    roles.cameras = paging && !hasBankButtons && region.length >= 3 ? useLastTwoForBanks(region) : region;
    at = region.length;
  } else if (cameraCount > roles.cameras.length && !hasBankButtons && roles.cameras.length >= 3) {
    roles.cameras = useLastTwoForBanks(roles.cameras);
  }
  if (!roles.pinned.includes('presets')) {
    // Presets start on a fresh row when there is one, so the two groups read
    // as two groups on the panel.
    if (at > 0) {
      const lastRow = grid.findIndex((r) => r.some((c) => c.id === region.at(-1)));
      const nextRowStart = flat.indexOf(grid[lastRow + 1]?.[0]);
      if (nextRowStart > at) at = nextRowStart;
    }
    const want = Number.isInteger(ov.presetCount) && ov.presetCount >= 0 ? ov.presetCount : 8;
    roles.presets = flat.slice(at, at + want).filter(free).map((c) => c.id);
    at += roles.presets.length;
  }
  const rest = flat.slice(at).filter((c) => free(c) && !region.includes(c.id) && !roles.cameras.includes(c.id) && !roles.presets.includes(c.id));
  if (!roles.store) take('store', rest.shift());
  if (!roles.tracking) take('tracking', rest.shift());

  return roles;
}

/** A compact description of the roles, for the API and the log. */
export function summarise(roles, topology) {
  if (!roles) return null;
  return {
    components: Array.isArray(topology?.HWc) ? topology.HWc.length : 0,
    joystick: roles.vector ? { vector: roles.vector, rotate: roles.rotate }
      : { pan: roles.pan, tilt: roles.tilt, rotate: roles.rotate },
    zoom: roles.zoom,
    focus: roles.focus,
    cameraButtons: roles.cameras,
    bankPrev: roles.bankPrev,
    bankNext: roles.bankNext,
    bankButtonsAreCameras: roles.bankFallback,
    group: roles.group,
    presetButtons: roles.presets,
    store: roles.store,
    stop: roles.stop,
    tracking: roles.tracking,
    encoders: roles.encoders.map((id) => ({ id, display: roles.displays[id] ?? null })),
    pinned: roles.pinned,
  };
}

// --- the controller ------------------------------------------------------------

const AXES = ['pan', 'tilt', 'zoom', 'focus'];

/** What the group button calls cameras that have no group, once other groups exist. */
const UNGROUPED = 'Ungrouped';

/** The layout log line's bank/group part. */
const bankText = (s) => (s.bankPrev || s.bankNext || s.group
  ? `banks prev ${s.bankPrev ?? '-'} next ${s.bankNext ?? '-'}${s.bankButtonsAreCameras ? ' (camera buttons)' : ''}, group ${s.group ?? '-'}, ` : '');

export class PanelController extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./rawpanel.js').RawPanelClient} o.client
   * @param {import('../ptz/source.js').PtzSource} o.ptz
   * @param {() => Array<{id: string, label: string, group?: string|null, state: string, tally: object|null, ptz: object|null}>} o.cameras
   *        PTZ cameras in the operator's order
   * @param {(id: string) => {entries: object[], capabilities: object}|null} o.schema
   * @param {(id: string, prop: string) => any} o.value          current raw value
   * @param {(id: string, prop: string, v: any) => Promise<object>} o.setProperty  the server's applyFn
   * @param {(id: string, op: string, n: number) => Promise<object>} o.preset
   * @param {(id: string, n: number) => string|null} [o.presetName]
   * @param {object} [o.mapping]   `skaarhoj.mapping`
   * @param {(level: string, msg: string) => void} [o.log]
   */
  constructor({ client, ptz, cameras, schema, value, setProperty, preset, presetName = () => null,
    mapping = {}, log = () => {} }) {
    super();
    this.client = client;
    this.ptz = ptz;
    this.cameras = cameras;
    this.schemaOf = schema;
    this.valueOf = value;
    this.setProperty = setProperty;
    this.presetFn = preset;
    this.presetName = presetName;
    this.mapping = mapping && typeof mapping === 'object' ? mapping : {};
    this.log = log;

    // notes §5: deadband is UNKNOWN; the one trace shows ±12 of 500 near
    // centre, so the default ignores the first 5% of travel.
    const db = Number(this.mapping.deadband);
    this.deadband = Number.isFinite(db) && db >= 0 && db < 0.5 ? db : 0.05;
    // Sign conventions per axis are not documented (notes §10.4); CamBridge's
    // are pan + right, tilt + up, zoom + tele, focus + far. Flip per axis here.
    this.invert = Object.fromEntries(AXES.map((a) => [a, !!this.mapping[`invert${a[0].toUpperCase()}${a.slice(1)}`]]));

    this.roles = null;
    /** id -> component, from the last layout. */
    this.comps = new Map();
    this.selected = null;
    /** Which bank of cameras the camera buttons show (0-based), and which group (null: all). */
    this.bankIndex = 0;
    this.groupKey = null;
    this.warnedGroup = false;
    this.axes = { pan: 0, tilt: 0, zoom: 0, focus: 0 };
    this.shift = false;
    /** HWC id -> what was last sent, so a render sends only what changed. */
    this.sent = new Map();
    /** prop -> { value, at }: where an encoder is heading while writes catch up. */
    this.targets = new Map();
    this.writing = new Map();
    this.renderTimer = null;
    this.clearFirst = false;
    this.needsLayout = false;
    this.layoutHadMap = false;
    this.layoutCams = 0;
    this.layoutKey = null;
    this.listeners = [];
  }

  attach() {
    const on = (ev, fn) => { this.client.on(ev, fn); this.listeners.push([ev, fn]); };
    on('connected', () => { this.#layout(); });
    on('topology', () => { this.#layout(); });
    on('disconnected', (why) => this.#release(`panel disconnected (${why})`, true));
    on('sleep', (asleep) => {
      // notes §5: treat a sleeping panel's controls as released; notes §6.6:
      // the map is zeroed on sleep and restored on wake — repaint then.
      if (asleep) this.#release('panel went to sleep');
      else this.#repaint();
    });
    on('health', (h) => { if (h === 'Blocked') this.#release('panel reports Blocked: inputs are not trustworthy'); });
    on('map', ({ id, external }) => {
      const axis = [this.roles?.pan, this.roles?.tilt, this.roles?.rotate, this.roles?.vector, this.roles?.zoom, this.roles?.focus];
      if (external === 0 && axis.includes(id)) this.#release(`control ${id} left the panel map`);
      // The first map can arrive after `connected`; lay out again once it
      // has, so controls the panel marks absent are not given roles. Later
      // changes only repaint: the map is zeroed on sleep, and the notes say
      // not to restructure the layout for that (notes §4, RWPv2 p.57-58).
      if (!this.layoutHadMap) { this.needsLayout = true; this.refresh(); } else if (external !== 0) this.#repaint();
    });
    on('event', (ev) => {
      try { this.#event(ev); } catch (err) { this.log('warn', `panel event ${ev.id} ignored: ${err.message}`); }
    });
  }

  /** Stops listening and lets go of anything held. */
  detach() {
    for (const [ev, fn] of this.listeners) this.client.off(ev, fn);
    this.listeners = [];
    clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.#release('CamBridge stopped driving the panel', true);
  }

  status() {
    const { view, size, pages, bank, groupKey } = this.#page();
    return {
      selectedCameraId: this.#selected(),
      topologySummary: summarise(this.roles, this.client.topology),
      bank: { index: bank, count: pages, size, cameras: view.length },
      group: groupKey === null ? null : (groupKey || UNGROUPED),
    };
  }

  /** Something in the state model changed: repaint soon, coalesced. */
  refresh() {
    if (this.renderTimer || !this.client.connected) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.#render();
    }, 30);
    this.renderTimer.unref?.();
  }

  #layout() {
    const cams = this.#scope();
    this.needsLayout = false;
    this.layoutHadMap = this.client.mapReceived;
    this.layoutCams = cams.length;
    this.comps = new Map(components(this.client.topology).map((c) => [c.id, c]));
    this.roles = detectRoles(this.client.topology, {
      cameraCount: cams.length,
      override: this.mapping,
      available: (id) => this.client.available(id),
    });
    const s = summarise(this.roles, this.client.topology);
    const key = JSON.stringify(s);
    if (key === this.layoutKey) { this.#repaint(); return; }
    this.layoutKey = key;
    this.log('info', `panel layout: joystick ${JSON.stringify(s.joystick)}, zoom ${s.zoom}, focus ${s.focus}, `
      + `cameras [${s.cameraButtons}], ${bankText(s)}presets [${s.presetButtons}], store ${s.store}, stop ${s.stop}, `
      + `tracking ${s.tracking}, encoders [${this.roles.encoders}]${s.pinned.length ? `, pinned: ${s.pinned.join(' ')}` : ''}`);
    this.emit('layout', s);
    this.#repaint();
  }

  /**
   * Forget what the panel shows and draw everything again. Coalesced with
   * other renders: waking from sleep restores the map one entry at a time
   * (notes §6.6), and one `Clear` is enough for all of them.
   */
  #repaint() {
    this.sent.clear();
    this.clearFirst = true;
    this.refresh();
  }

  // --- input -------------------------------------------------------------------

  #event({ id, edge, kind, value, values }) {
    const r = this.roles;
    if (!r) return;
    if (id === r.vector && kind === 'Speed') {
      // notes §3.1: `Speed:dx,dy` for vector components. The order of the
      // values beyond "x then y" is not documented; a third is taken as twist.
      const comp = this.#comp(id);
      this.#axis('pan', this.#norm(values[0] ?? 0, kind, comp));
      this.#axis('tilt', this.#norm(values[1] ?? 0, kind, comp));
      if (!r.zoom && values.length > 2) this.#axis('zoom', this.#norm(values[2], kind, comp));
      this.#drive(['pan', 'tilt', 'zoom']);
      return;
    }
    if (id === r.pan && (kind === 'Speed' || kind === 'Abs')) { this.#axis('pan', this.#norm(value, kind, this.#comp(id))); this.#drive(['pan', 'tilt']); return; }
    if (id === r.tilt && (kind === 'Speed' || kind === 'Abs')) { this.#axis('tilt', this.#norm(value, kind, this.#comp(id))); this.#drive(['pan', 'tilt']); return; }
    // The twist zooms only when there is no rocker: two zoom controls that
    // could disagree are worse than one.
    if (id === r.rotate && !r.zoom && (kind === 'Speed' || kind === 'Abs')) { this.#axis('zoom', this.#norm(value, kind, this.#comp(id))); this.#drive(['zoom']); return; }
    if (id === r.zoom) { this.#velocityControl('zoom', id, kind, value); return; }
    if (id === r.focus) { this.#velocityControl('focus', id, kind, value); return; }

    if (kind === 'Enc') {
      const i = r.encoders.indexOf(id);
      if (i >= 0) this.#encoder(i, value);
      return;
    }
    if (kind !== 'Down' && kind !== 'Up') return;
    // notes §3.1: edge 16 is an encoder's push. Encoders do not double as
    // buttons here, so it never presses a camera or preset.
    if (edge === 16) return;

    if (id === r.store) {
      this.shift = kind === 'Down';
      this.refresh();
      return;
    }
    if (kind !== 'Down') return;
    if (id === r.stop) { this.#stopAll(); return; }
    if (id === r.bankNext) { this.#bank(+1); return; }
    if (id === r.bankPrev) { this.#bank(r.bankNext ? -1 : +1); return; }
    if (id === r.group) { this.#cycleGroup(); return; }
    const cam = r.cameras.indexOf(id);
    if (cam >= 0) { this.#select(cam); return; }
    const p = r.presets.indexOf(id);
    if (p >= 0) { this.#preset(p); return; }
    if (id === r.tracking) this.#tracking();
  }

  #comp(id) { return this.comps.get(id) ?? null; }

  /**
   * Panel units to CamBridge's -1..1, with the deadband taken out of the
   * middle and the rest stretched, so the slowest speed is still reachable.
   * notes §3.1/§5: Speed is -500..500; Abs is 0..1000; `max=` overrides
   * either (notes §4). An absolute control is read about its centre.
   */
  #norm(v, kind, comp) {
    if (!Number.isFinite(v)) return 0;
    let x;
    if (kind === 'Abs') {
      const max = comp?.max ?? 1000;
      x = (v - max / 2) / (max / 2);
    } else {
      x = v / (comp?.max ?? 500);
    }
    x = Math.max(-1, Math.min(1, x));
    const mag = Math.abs(x);
    if (mag <= this.deadband) return 0;
    return Math.sign(x) * Math.min(1, (mag - this.deadband) / (1 - this.deadband));
  }

  #axis(a, v) { this.axes[a] = this.invert[a] ? -v : v; }

  #velocityControl(axis, id, kind, value) {
    if (kind === 'Speed' || kind === 'Abs') {
      this.#axis(axis, this.#norm(value, kind, this.#comp(id)));
      this.#drive([axis]);
      return;
    }
    if (kind === 'Enc') {
      // A roller sends pulses, not a speed (notes §5). Each pulse is a short
      // burst, held only by the deadman — the roller stops sending when it
      // stops turning, so a latch here would be exactly the wrong thing.
      const cam = this.#selected();
      if (!cam || !Number.isFinite(value)) return;
      const v = Math.max(-1, Math.min(1, value * 0.25)) * (this.invert[axis] ? -1 : 1);
      this.ptz.move(cam, { [axis]: v }, { source: SOURCE, holdMs: 150 });
    }
  }

  /**
   * Sends the held axes. Latched: the panel sends nothing while the stick is
   * still, so the motion controller must not time it out; releaseSource() on
   * disconnect is what makes that safe (ptz/motion.js).
   */
  #drive(axes) {
    const cam = this.#selected();
    if (!cam) return;
    const v = {};
    for (const a of axes) v[a] = this.axes[a];
    const r = this.ptz.move(cam, v, { source: SOURCE, latch: true });
    if (r && !r.ok) this.log('debug', `move on ${cam} refused: ${r.body?.error ?? r.status}`);
  }

  /** Lets go of every axis this panel holds, on every camera. */
  #release(why, quiet = false) {
    const moving = AXES.some((a) => this.axes[a] !== 0);
    for (const a of AXES) this.axes[a] = 0;
    this.shift = false;
    this.ptz.releaseSource(SOURCE);
    if (moving || !quiet) this.log(moving ? 'warn' : 'info', `${moving ? 'motion released: ' : ''}${why}`);
    if (quiet) { this.sent.clear(); this.targets.clear(); }
  }

  #stopAll() {
    for (const a of AXES) this.axes[a] = 0;
    this.log('info', 'STOP pressed on the panel: stopping every PTZ camera');
    this.ptz.stopAll('SKAARHOJ STOP').catch(() => {});
  }

  // --- banks and groups --------------------------------------------------------

  /** The cameras this panel can reach: all of them, or the one configured group. */
  #scope() {
    const all = this.cameras();
    const want = typeof this.mapping.group === 'string' ? this.mapping.group.trim().toLowerCase() : '';
    if (!want) return all;
    const inGroup = all.filter((c) => (c.group ?? '').toLowerCase() === want);
    if (!inGroup.length && all.length && !this.warnedGroup) {
      this.warnedGroup = true;
      this.log('warn', `skaarhoj.mapping.group "${this.mapping.group}" matches no camera: the panel has none to drive`);
    }
    return inGroup;
  }

  /**
   * What the camera buttons show right now: the cameras in view (the scope,
   * narrowed to the chosen group), how many fit on a bank, and which bank.
   * Clamped here, so a camera removed or a group emptied cannot leave the
   * panel on a bank that no longer exists.
   */
  #page() {
    const scope = this.#scope();
    const keys = [];
    for (const c of scope) { const k = c.group ?? ''; if (!keys.includes(k)) keys.push(k); }
    // Cycling needs at least two groups to choose between.
    const groups = keys.length >= 2 ? keys : [];
    if (this.groupKey !== null && !groups.includes(this.groupKey)) this.groupKey = null;
    const view = this.groupKey === null ? scope : scope.filter((c) => (c.group ?? '') === this.groupKey);
    const size = this.roles?.cameras.length ?? 0;
    const pages = size ? Math.max(1, Math.ceil(view.length / size)) : 1;
    this.bankIndex = Math.max(0, Math.min(pages - 1, this.bankIndex));
    return { scope, view, groups, groupKey: this.groupKey, size, pages, bank: this.bankIndex };
  }

  /**
   * Moves the camera buttons to another bank, wrapping at the ends. It is a
   * display change only: the selected camera, and whatever the stick is
   * holding, are untouched.
   */
  #bank(step) {
    const { pages, bank } = this.#page();
    if (pages <= 1) return;
    this.bankIndex = (bank + step + pages) % pages;
    this.log('info', `panel showing bank ${this.bankIndex + 1}/${pages}`);
    this.emit('bank', this.bankIndex);
    this.refresh();
  }

  /** All cameras, then each group in turn. Like a bank change, it moves nothing. */
  #cycleGroup() {
    const { groups, groupKey } = this.#page();
    if (!groups.length) return;
    const options = [null, ...groups];
    this.groupKey = options[(options.indexOf(groupKey) + 1) % options.length];
    this.bankIndex = 0;
    this.log('info', `panel showing ${this.groupKey === null ? 'all cameras' : `group ${this.groupKey || UNGROUPED}`}`);
    this.emit('group', this.groupKey);
    this.refresh();
  }

  #selected() {
    const cams = this.#scope();
    if (!cams.length) return null;
    if (!cams.some((c) => c.id === this.selected)) this.selected = cams[0].id;
    return this.selected;
  }

  #select(i) {
    const { view, size, bank } = this.#page();
    const cam = view[bank * size + i];
    const prev = this.#selected();
    if (!cam || cam.id === prev) return;
    // The camera being left must not keep moving: the stick's next value goes
    // to the new one, and nothing would ever tell the old one to stop.
    if (AXES.some((a) => this.axes[a] !== 0)) {
      for (const a of AXES) this.axes[a] = 0;
      this.ptz.releaseSource(SOURCE);
    }
    this.selected = cam.id;
    this.targets.clear();
    this.log('info', `panel selected ${cam.label || cam.id}`);
    this.emit('selected', cam.id);
    this.refresh();
  }

  async #preset(i) {
    const cam = this.#selected();
    if (!cam) return;
    const caps = this.schemaOf(cam)?.capabilities;
    const n = (caps?.presetBase ?? 1) + i;
    if (!caps?.presets || i >= caps.presets) return;
    const op = this.shift ? 'store' : 'recall';
    // A recall replaces held motion on the camera (lifecycle.preset), so the
    // panel's idea of the stick must be reset with it.
    if (op === 'recall') for (const a of AXES) this.axes[a] = 0;
    this.log('info', `panel ${op} preset ${n} on ${cam}`);
    const r = await this.presetFn(cam, op, n);
    if (!r?.ok) this.log('warn', `preset ${n} ${op} on ${cam}: ${r?.body?.error ?? 'failed'}`);
    this.refresh();
  }

  /** The table entries this camera's encoders control, in bank order. */
  bank(cameraId = this.#selected()) {
    const entries = (this.schemaOf(cameraId)?.entries ?? [])
      .filter((e) => e.operate && e.available !== false && !needsAdmin(e)
        && (e.type === 'enum' || e.type === 'range' || e.type === 'bool'));
    const first = ENCODER_FIRST.map((role) => entries.find((e) => roleOf(e) === role)).filter(Boolean);
    return [...first, ...entries.filter((e) => !first.includes(e))];
  }

  #current(cam, entry) {
    const t = this.targets.get(entry.id);
    // A target is trusted for a moment: long enough for the write and its
    // re-read to land, short enough that a change from elsewhere shows.
    if (t && Date.now() - t.at < 1500) return t.value;
    return this.valueOf(cam, entry.id);
  }

  #encoder(i, pulses) {
    const cam = this.#selected();
    const entry = this.bank(cam)[i];
    if (!cam || !entry || !Number.isFinite(pulses) || pulses === 0) return;
    const now = this.#current(cam, entry);
    let next;
    if (entry.type === 'enum') {
      const opts = entry.options ?? [];
      let at = opts.findIndex((o) => String(o.value) === String(now));
      if (at < 0) at = 0;
      next = opts[Math.max(0, Math.min(opts.length - 1, at + pulses))]?.value;
    } else if (entry.type === 'range') {
      const { min, max, step } = entry.range;
      const base = Number.isFinite(Number(now)) ? Number(now) : min;
      const s = step > 0 ? step : (max - min) / 100;
      const decimals = String(s).split('.')[1]?.length ?? 0;
      next = Number(Math.max(min, Math.min(max, base + pulses * s)).toFixed(decimals));
    } else {
      next = pulses > 0;
    }
    if (next === undefined || String(next) === String(now)) return;
    this.targets.set(entry.id, { value: next, at: Date.now() });
    this.#write(cam, entry, next);
    this.refresh();
  }

  /**
   * One write in flight per setting; turns that arrive meanwhile collapse
   * into the latest value. An encoder spun hard would otherwise queue twenty
   * writes, and the camera would still be catching up after the hand let go.
   */
  async #write(cam, entry, v) {
    const key = `${cam}:${entry.id}`;
    if (this.writing.has(key)) { this.writing.set(key, { v }); return; }
    this.writing.set(key, null);
    let value = v;
    for (;;) {
      const r = await this.setProperty(cam, entry.id, value);
      if (!r?.ok) {
        this.log('debug', `${cam} ${entry.id}: ${r?.body?.error ?? 'refused'}`);
        this.targets.delete(entry.id);
      }
      const pending = this.writing.get(key);
      if (!pending) break;
      value = pending.v;
      this.writing.set(key, null);
    }
    this.writing.delete(key);
    this.refresh();
  }

  #trackingEntry(cam) {
    if (!this.schemaOf(cam)?.capabilities?.tracking) return null;
    return (this.schemaOf(cam)?.entries ?? []).find((e) => roleOf(e) === 'trackingEnabled' && e.available !== false) ?? null;
  }

  /** bool, or an enum with `onValue`/`offValue` (the coordinator's role contract). */
  #trackingOn(cam, entry) {
    const v = this.valueOf(cam, entry.id);
    return entry.type === 'bool' ? !!v : String(v) === String(entry.onValue);
  }

  async #tracking() {
    const cam = this.#selected();
    const entry = cam && this.#trackingEntry(cam);
    if (!entry) return;
    const on = this.#trackingOn(cam, entry);
    const next = entry.type === 'bool' ? !on : (on ? entry.offValue : entry.onValue);
    if (next === undefined) return;
    this.log('info', `panel turned tracking ${on ? 'off' : 'on'} on ${cam}`);
    const r = await this.setProperty(cam, entry.id, next);
    if (!r?.ok) this.log('warn', `tracking on ${cam}: ${r?.body?.error ?? 'refused'}`);
    this.refresh();
  }

  // --- output ------------------------------------------------------------------

  /** What every assigned control should show right now. */
  #desired() {
    const r = this.roles;
    const want = new Map();
    if (!r) return want;
    const page = this.#page();
    const { view, size, bank: shown } = page;
    const cams = this.#scope();
    const sel = this.#selected();
    const blank = hwcText({ format: 7 });   // notes §6.4: format 7 = hidden

    r.cameras.forEach((id, i) => {
      const c = view[shown * size + i];
      if (!c) { want.set(id, { led: { mode: LED.OFF, colour: COLOUR.OFF }, text: blank }); return; }
      const selected = c.id === sel;
      const pgm = !!c.tally?.program;
      const pvw = !pgm && !!c.tally?.preview;
      // Colour says tally, brightness says selection: a camera on program is
      // red whether or not this panel has it, and that must never be hidden.
      const colour = pgm ? COLOUR.RED : pvw ? COLOUR.GREEN : selected ? COLOUR.AMBER : COLOUR.WHITE;
      const title = pgm ? 'PGM' : pvw ? 'PVW' : c.state !== 'connected' ? 'OFFLINE' : 'CAM';
      want.set(id, {
        led: { mode: selected ? LED.ON : LED.DIM, colour },
        // isLabel 0 = solid title bar "shows current state" (notes §6.4): the selected one.
        text: hwcText({ title, isLabel: !selected, label1: c.label || c.id }),
      });
    });

    this.#desiredNav(want, page, sel, cams, blank);

    const caps = sel ? this.schemaOf(sel)?.capabilities : null;
    const base = caps?.presetBase ?? 1;
    const current = cams.find((c) => c.id === sel)?.ptz?.preset;
    r.presets.forEach((id, i) => {
      const n = base + i;
      if (!caps?.presets || i >= caps.presets) { want.set(id, { led: { mode: LED.OFF, colour: COLOUR.OFF }, text: blank }); return; }
      const name = this.presetName(sel, n);
      want.set(id, {
        led: { mode: current === n ? LED.ON : LED.DIM, colour: this.shift ? COLOUR.RED : COLOUR.BLUE },
        text: hwcText({ title: this.shift ? `STORE ${n}` : `PRESET ${n}`, isLabel: true, label1: name || String(n) }),
      });
    });

    if (r.store) {
      want.set(r.store, {
        led: { mode: this.shift ? LED.ON : LED.DIM, colour: COLOUR.RED },
        text: hwcText({ title: 'STORE', isLabel: true, label1: 'Hold + preset' }),
      });
    }
    if (r.stop) {
      want.set(r.stop, { led: { mode: LED.ON, colour: COLOUR.RED }, text: hwcText({ title: 'STOP', isLabel: true, label1: 'All PTZ' }) });
    }
    if (r.tracking) {
      const entry = sel ? this.#trackingEntry(sel) : null;
      const on = entry ? this.#trackingOn(sel, entry) : false;
      want.set(r.tracking, entry
        ? { led: { mode: on ? LED.ON : LED.DIM, colour: on ? COLOUR.GREEN : COLOUR.WHITE },
          text: hwcText({ title: 'TRACKING', isLabel: on ? 0 : 1, label1: on ? 'On' : 'Off' }) }
        : { led: { mode: LED.OFF, colour: COLOUR.OFF }, text: blank });
    }

    const bank = sel ? this.bank(sel) : [];
    r.encoders.forEach((id, i) => {
      const disp = r.displays[id];
      if (!disp) return;
      const entry = bank[i];
      if (!entry) { want.set(disp, { ...(want.get(disp) ?? {}), text: blank }); return; }
      want.set(disp, {
        ...(want.get(disp) ?? {}),
        text: hwcText({ title: entry.label, isLabel: true, label1: labelFor(entry, this.#current(sel, entry)) }),
      });
    });
    return want;
  }

  /**
   * The bank and group buttons. They say which bank is showing, and light red
   * when a camera that is on program is somewhere the camera buttons are not
   * showing: the camera buttons keep their own tally, so this covers the rest.
   */
  #desiredNav(want, { view, groups, groupKey, size, pages, bank }, sel, cams, blank) {
    const r = this.roles;
    const off = { led: { mode: LED.OFF, colour: COLOUR.OFF }, text: blank };
    const label = (c) => c?.label || c?.id || '';
    const selCam = cams.find((c) => c.id === sel);
    const bankOf = (c) => { const j = view.indexOf(c); return j < 0 ? -1 : Math.floor(j / size); };
    const onProgram = (c) => !!c.tally?.program;

    if ((r.bankNext || r.bankPrev) && size) {
      const before = view.find((c) => onProgram(c) && bankOf(c) < bank);
      const after = view.find((c) => onProgram(c) && bankOf(c) > bank);
      const both = !!(r.bankNext && r.bankPrev);
      const selBank = selCam ? bankOf(selCam) : bank;
      const draw = (id, dir, pgm) => {
        // A labelled bank button on a single bank stays lit-off but readable;
        // one borrowed from the camera buttons has nothing to say.
        if (pages <= 1) { want.set(id, r.bankFallback ? off : { led: { mode: LED.OFF, colour: COLOUR.OFF }, text: hwcText({ title: 'BANK', isLabel: true, label1: 'Bank 1/1' }) }); return; }
        const note = pgm ? `PGM: ${label(pgm)}` : selCam && selBank !== bank ? `Sel: ${label(selCam)}` : '';
        want.set(id, {
          led: pgm ? { mode: LED.ON, colour: COLOUR.RED } : { mode: LED.DIM, colour: COLOUR.WHITE },
          text: hwcText({ title: both ? (dir < 0 ? 'PREV <' : 'NEXT >') : 'BANK >', isLabel: true,
            label1: `Bank ${bank + 1}/${pages}`, label2: note }),
        });
      };
      if (both) {
        draw(r.bankPrev, -1, before);
        draw(r.bankNext, +1, after);
      } else {
        draw(r.bankNext ?? r.bankPrev, +1, before ?? after);
      }
    }

    if (r.group) {
      if (!groups.length) { want.set(r.group, off); return; }
      const named = groupKey === null ? 'All' : groupKey || UNGROUPED;
      const elsewhere = cams.find((c) => onProgram(c) && !view.includes(c));
      const note = elsewhere ? `PGM: ${label(elsewhere)}` : selCam && !view.includes(selCam) ? `Sel: ${label(selCam)}` : '';
      want.set(r.group, {
        led: elsewhere ? { mode: LED.ON, colour: COLOUR.RED } : { mode: LED.DIM, colour: COLOUR.WHITE },
        text: hwcText({ title: 'GROUP', isLabel: true, label1: named, label2: note }),
      });
    }
  }

  #render() {
    if (!this.client.connected || !this.roles) return;
    // A camera added or removed changes how many buttons select cameras.
    if (this.needsLayout || this.#scope().length !== this.layoutCams) { this.#layout(); return; }
    if (this.clearFirst) {
      this.clearFirst = false;
      this.sent.clear();
      this.client.clear();
    }
    for (const [id, w] of this.#desired()) {
      const comp = this.comps.get(id);
      const was = this.sent.get(id) ?? {};
      const now = { ...was };
      // LEDs only where the topology says there is one, or where an admin
      // pinned a control the topology does not describe.
      if (w.led && (!comp || comp.out)) {
        const key = `${w.led.mode}/${w.led.colour}`;
        if (was.led !== key) { this.client.setLed(id, w.led); now.led = key; }
      }
      if (w.text !== undefined && (!comp || comp.disp)) {
        if (was.text !== w.text) { this.client.setText(id, w.text); now.text = w.text; }
      }
      this.sent.set(id, now);
    }
  }
}
