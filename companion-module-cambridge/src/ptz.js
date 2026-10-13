// PTZ heads: everything the module adds for Panasonic / Sony / Canon / PTZOptics
// cameras driven by CamBridge.
//
// Same rule as the rest of the module — a thin client. Which settings a camera
// has, what they are called and what values they take all come from CamBridge's
// schema for that camera; nothing about a vendor is written down here.
//
// The one thing that is genuinely this module's job is press-and-hold. Motion
// on a head is a velocity that stays true until something says stop, so CamBridge
// stops an axis itself if it is not refreshed within about half a second (the
// deadman). A held Stream Deck key therefore has to keep refreshing for as long
// as it is down, and that loop lives here (PtzHolds).

import { combineRgb } from '@companion-module/base';
import { varId } from './variables.js';

const WHITE = combineRgb(255, 255, 255);
const BLACK = combineRgb(0, 0, 0);
const DARK = combineRgb(20, 22, 26);
const RED = combineRgb(200, 20, 30);
const AMBER = combineRgb(240, 160, 20);
const GREEN = combineRgb(40, 170, 80);
const BLUE = combineRgb(30, 90, 190);

/** The deadman is ~500 ms; refreshing at 150 ms survives two lost requests. */
export const HOLD_REFRESH_MS = 150;
/**
 * A key that never reports its release (page change mid-press, a lost event)
 * must not pan the head into the wall forever, because we would keep refreshing
 * it. Nobody holds a key this long on purpose.
 */
export const HOLD_MAX_MS = 60_000;

export const isPtz = (cam) => cam?.kind === 'ptz';

const enc = encodeURIComponent;

// --- press and hold -------------------------------------------------------

/**
 * Keeps held motion alive. One timer per camera, however many keys are down on
 * it, so a pan key and a zoom key held together make one request per tick.
 */
export class PtzHolds {
  /**
   * @param {object} o
   * @param {(cameraId: string, axes: object) => Promise<any>} o.move   POST .../ptz/move
   * @param {(cameraId: string) => Promise<any>} o.stop                 POST .../ptz/stop
   * @param {(level: string, msg: string) => void} o.log
   * @param {number} [o.refreshMs]
   * @param {number} [o.maxMs]
   */
  constructor({ move, stop, log, refreshMs = HOLD_REFRESH_MS, maxMs = HOLD_MAX_MS }) {
    this.moveFn = move;
    this.stopFn = stop;
    this.log = log;
    this.refreshMs = refreshMs;
    this.maxMs = maxMs;
    /** cameraId -> { holds: Map<key, {axes, since}>, timer, pending } */
    this.cameras = new Map();
  }

  /** Whether anything is being held — for tests and for the connection-drop path. */
  get active() { return this.cameras.size > 0; }

  /** @param {string} key  identifies the pressed key, e.g. "<controlId>|ptzPanTilt" */
  start(key, cameraId, axes) {
    let cam = this.cameras.get(cameraId);
    if (!cam) {
      cam = { holds: new Map(), timer: null, pending: Promise.resolve() };
      this.cameras.set(cameraId, cam);
    }
    cam.holds.set(key, { axes, since: Date.now() });
    this.#send(cameraId, cam);
    if (!cam.timer) cam.timer = setInterval(() => this.#tick(cameraId), this.refreshMs);
  }

  /**
   * Button up: drops every hold belonging to this control. If other keys are
   * still holding the camera, only the released axes are zeroed; otherwise the
   * whole head is told to stop.
   */
  release(controlPrefix, cameraId) {
    const cam = this.cameras.get(cameraId);
    if (!cam) return Promise.resolve();
    const freed = new Set();
    for (const [key, hold] of cam.holds) {
      if (key.startsWith(controlPrefix)) {
        for (const a of Object.keys(hold.axes)) freed.add(a);
        cam.holds.delete(key);
      }
    }
    if (cam.holds.size === 0) return this.#finish(cameraId, cam);
    // Another key is still down: zero only what this one drove.
    const still = this.#merged(cam);
    const zero = {};
    for (const a of freed) if (!(a in still)) zero[a] = 0;
    if (Object.keys(zero).length === 0) return Promise.resolve();
    return this.#chain(cam, () => this.moveFn(cameraId, zero));
  }

  /**
   * Drops everything locally. With `stop` it also tells each head to stop; without
   * it (the server is unreachable) the head's own deadman does the stopping.
   */
  clearAll({ stop = false } = {}) {
    const jobs = [];
    for (const [id, cam] of this.cameras) {
      clearInterval(cam.timer);
      cam.timer = null;
      if (stop) jobs.push(this.#chain(cam, () => this.stopFn(id)));
    }
    this.cameras.clear();
    return Promise.all(jobs);
  }

  #merged(cam) {
    const out = {};
    for (const hold of cam.holds.values()) Object.assign(out, hold.axes);
    return out;
  }

  /** Serialises requests per camera, so a stop can never overtake a move and be undone by it. */
  #chain(cam, fn) {
    cam.pending = cam.pending.then(fn, fn).catch(() => {});
    return cam.pending;
  }

  #send(cameraId, cam) {
    return this.#chain(cam, () => this.moveFn(cameraId, this.#merged(cam)));
  }

  #tick(cameraId) {
    const cam = this.cameras.get(cameraId);
    if (!cam) return;
    const now = Date.now();
    for (const [key, hold] of cam.holds) {
      if (now - hold.since > this.maxMs) {
        this.log('warn', `${cameraId}: a held key never reported release; stopping after ${this.maxMs / 1000}s`);
        cam.holds.delete(key);
      }
    }
    if (cam.holds.size === 0) { this.#finish(cameraId, cam); return; }
    this.#send(cameraId, cam);
  }

  #finish(cameraId, cam) {
    clearInterval(cam.timer);
    cam.timer = null;
    this.cameras.delete(cameraId);
    return this.#chain(cam, () => this.stopFn(cameraId));
  }
}

// --- directions -----------------------------------------------------------

// Positive pan is right and positive tilt is up, as CamBridge defines them.
const DIRECTIONS = [
  { id: 'up-left', label: 'Up-left', pan: -1, tilt: 1, glyph: '↖' },
  { id: 'up', label: 'Up', pan: 0, tilt: 1, glyph: '↑' },
  { id: 'up-right', label: 'Up-right', pan: 1, tilt: 1, glyph: '↗' },
  { id: 'left', label: 'Left', pan: -1, tilt: 0, glyph: '←' },
  { id: 'right', label: 'Right', pan: 1, tilt: 0, glyph: '→' },
  { id: 'down-left', label: 'Down-left', pan: -1, tilt: -1, glyph: '↙' },
  { id: 'down', label: 'Down', pan: 0, tilt: -1, glyph: '↓' },
  { id: 'down-right', label: 'Down-right', pan: 1, tilt: -1, glyph: '↘' },
];

const speedField = {
  type: 'number', id: 'speed', label: 'Speed (%)', default: 50, min: 1, max: 100, range: true,
};

/** Speed option as a 0..1 magnitude. */
const speedOf = (options) => Math.max(0.01, Math.min(1, (Number(options.speed) || 50) / 100));

// --- schema-driven settings -----------------------------------------------

/** Settings a Stream Deck key may change: ordinary, writable, available now. */
export function usableEntries(entries) {
  return (entries ?? []).filter((e) =>
    e.type !== 'action'
    && !e.readOnly
    && (e.danger ?? 'none') === 'none'
    && e.available !== false);
}

/** Camera functions ("home", one-push AF): table entries of type action. */
export function usableFunctions(entries) {
  return (entries ?? []).filter((e) =>
    e.type === 'action' && (e.danger ?? 'none') === 'none' && e.available !== false);
}

/** The entry a cross-vendor function lives in. Ids differ per vendor; `role` does not. */
export function roleEntry(entries, role) {
  return (entries ?? []).find((e) => e.role === role) ?? null;
}

/** The table entry that switches tracking on and off, if the camera has one. */
export function trackingEntry(entries) {
  const byRole = roleEntry(entries, 'trackingEnabled');
  if (byRole) return byRole;
  // A table without roles: any ordinary on/off switch in the tracking group.
  const bools = (entries ?? []).filter((e) => e.group === 'tracking' && e.type === 'bool' && !e.readOnly);
  return bools.find((e) => e.id === 'trackingEnabled') ?? bools.find((e) => e.operate) ?? bools[0] ?? null;
}

/** What to write to turn tracking on or off: a bool, or the enum's own on/off value. */
export function trackingValue(entry, on) {
  if (entry?.type === 'enum') return on ? entry.onValue : entry.offValue;
  return on;
}

const entryLabel = (e) => `${e.group ? `${e.group}: ` : ''}${e.label}`;

/** The value field for one table entry, shown only when that camera + setting is picked. */
function valueField(camId, entry) {
  const base = {
    id: `v_${varId(camId)}_${entry.id}`,
    label: 'Value',
    isVisibleExpression:
      `$(options:camera) == ${JSON.stringify(camId)} && $(options:setting_${varId(camId)}) == ${JSON.stringify(entry.id)}`,
  };
  switch (entry.type) {
    case 'enum':
      return {
        ...base, type: 'dropdown', default: entry.options[0]?.value ?? '',
        choices: entry.options.map((o) => ({ id: o.value, label: o.label })),
      };
    case 'bool':
      return {
        ...base, type: 'dropdown', default: 'true',
        choices: [{ id: 'true', label: 'On' }, { id: 'false', label: 'Off' }],
      };
    case 'range':
      return {
        ...base, type: 'number', default: entry.range.min, min: entry.range.min, max: entry.range.max,
        step: entry.range.step > 0 ? entry.range.step : undefined,
      };
    default:
      return { ...base, type: 'textinput', default: '', useVariables: true };
  }
}

/** The preset number an action means: a saved name wins over the typed number. */
function presetNumber(options) {
  const n = options.byName !== undefined && options.byName !== '' ? Number(options.byName) : Number(options.preset);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// --- actions --------------------------------------------------------------

export function buildPtzActions(self) {
  const cams = self.cameras.filter(isPtz);
  if (!cams.length) return {};
  const camChoices = self.cameraChoices('ptz');
  const camField = () => ({
    type: 'dropdown', id: 'camera', label: 'Camera', default: camChoices[0]?.id ?? '', choices: camChoices,
  });
  const holdKey = (ev, actionId) => `${ev.controlId ?? 'anon'}|${actionId}`;
  const maxPreset = Math.max(1, ...cams.map((c) => c.capabilities?.presets ?? 0));
  const visibleFor = (c) => `$(options:camera) == ${JSON.stringify(c.id)}`;

  /** Runs the camera function tagged with `role`, or says why nothing happened. */
  const runRole = (camera, role) => {
    const entry = roleEntry(self.ptzSchemas[camera], role);
    if (!entry) {
      self.log('debug', `${camera} has no "${role}" function`);
      return;
    }
    return self.api.request('POST', `/api/cameras/${enc(camera)}/actions/${enc(entry.id)}`);
  };

  const actions = {
    ptzPanTilt: {
      name: 'PTZ: pan / tilt while held',
      description: 'Pressing starts the move and keeps it alive. Put "PTZ: release" on the button\'s release.',
      options: [
        camField(),
        {
          type: 'dropdown', id: 'direction', label: 'Direction', default: 'up',
          choices: DIRECTIONS.map((d) => ({ id: d.id, label: d.label })),
        },
        speedField,
      ],
      callback: (ev) => {
        const d = DIRECTIONS.find((x) => x.id === ev.options.direction);
        if (!d) return;
        const s = speedOf(ev.options);
        self.ptzHolds.start(holdKey(ev, 'ptzPanTilt'), ev.options.camera, { pan: d.pan * s, tilt: d.tilt * s });
      },
    },

    ptzZoom: {
      name: 'PTZ: zoom while held',
      options: [
        camField(),
        {
          type: 'dropdown', id: 'direction', label: 'Direction', default: 'in',
          choices: [{ id: 'in', label: 'Zoom in (tele)' }, { id: 'out', label: 'Zoom out (wide)' }],
        },
        speedField,
      ],
      callback: (ev) => {
        const s = speedOf(ev.options);
        self.ptzHolds.start(holdKey(ev, 'ptzZoom'), ev.options.camera,
          { zoom: ev.options.direction === 'out' ? -s : s });
      },
    },

    ptzFocus: {
      name: 'PTZ: manual focus while held',
      options: [
        camField(),
        {
          type: 'dropdown', id: 'direction', label: 'Direction', default: 'far',
          choices: [{ id: 'near', label: 'Focus nearer' }, { id: 'far', label: 'Focus further' }],
        },
        speedField,
      ],
      callback: (ev) => {
        const s = speedOf(ev.options);
        self.ptzHolds.start(holdKey(ev, 'ptzFocus'), ev.options.camera,
          { focus: ev.options.direction === 'near' ? -s : s });
      },
    },

    ptzRelease: {
      name: 'PTZ: release (stop held movement)',
      description: 'Use on the button\'s release. Stops what this button started and leaves other held keys alone.',
      options: [camField()],
      callback: (ev) => self.ptzHolds.release(`${ev.controlId ?? 'anon'}|`, ev.options.camera),
    },

    ptzStopAll: {
      name: 'PTZ: STOP ALL',
      options: [],
      callback: async () => {
        await self.ptzHolds.clearAll();
        return self.api.request('POST', '/api/ptz/stop-all');
      },
    },

    ptzPresetRecall: {
      name: 'PTZ: recall preset',
      options: [
        camField(),
        { type: 'number', id: 'preset', label: 'Preset number', default: 1, min: 0, max: maxPreset + 100 },
        {
          type: 'dropdown', id: 'byName', label: 'Or pick a saved name (overrides the number)',
          default: '', choices: self.ptzPresetNameChoices(),
        },
      ],
      callback: (ev) => {
        const n = presetNumber(ev.options);
        if (n === null) return;
        return self.api.request('POST', `/api/cameras/${enc(ev.options.camera)}/ptz/presets/${n}/recall`, {});
      },
    },

    ptzPresetStore: {
      name: 'PTZ: store preset',
      options: [
        camField(),
        { type: 'number', id: 'preset', label: 'Preset number', default: 1, min: 0, max: maxPreset + 100 },
        {
          type: 'dropdown', id: 'byName', label: 'Or overwrite a saved name (overrides the number)',
          default: '', choices: self.ptzPresetNameChoices(),
        },
        { type: 'textinput', id: 'name', label: 'Name (optional)', default: '', useVariables: true },
      ],
      callback: async (ev) => {
        const n = presetNumber(ev.options);
        if (n === null) return;
        const name = (await self.parseVariablesInString(String(ev.options.name ?? ''))).trim();
        const r = await self.api.request(
          'POST', `/api/cameras/${enc(ev.options.camera)}/ptz/presets/${n}/store`, name ? { name } : {});
        await self.refreshPtzPresetNames();
        return r;
      },
    },

    ptzFunction: {
      name: 'PTZ: run a camera function (home, one-push AF ...)',
      options: [
        camField(),
        ...cams.map((c) => {
          const fns = usableFunctions(self.ptzSchemas[c.id]);
          return {
            type: 'dropdown', id: `fn_${varId(c.id)}`, label: 'Function',
            default: fns[0]?.id ?? '',
            choices: fns.length ? fns.map((e) => ({ id: e.id, label: entryLabel(e) })) : [{ id: '', label: '(none)' }],
            isVisibleExpression: visibleFor(c),
          };
        }),
      ],
      callback: (ev) => {
        const id = ev.options[`fn_${varId(ev.options.camera)}`];
        if (!id) return;
        return self.api.request('POST', `/api/cameras/${enc(ev.options.camera)}/actions/${enc(id)}`);
      },
    },

    ptzHome: {
      name: 'PTZ: go to home position',
      options: [camField()],
      callback: (ev) => runRole(ev.options.camera, 'home'),
    },

    ptzOnePushAf: {
      name: 'PTZ: one-push autofocus',
      options: [camField()],
      callback: (ev) => runRole(ev.options.camera, 'onePushAf'),
    },

    ptzSetting: {
      name: 'PTZ: set any setting',
      description: 'Every ordinary setting the camera\'s own table offers. Network, users, firmware and reset are not listed.',
      options: [
        camField(),
        ...cams.flatMap((c) => {
          const entries = usableEntries(self.ptzSchemas[c.id]);
          if (!entries.length) {
            return [{
              type: 'static-text', id: `none_${varId(c.id)}`, label: 'Settings',
              value: 'Settings load once the camera has connected.',
              isVisibleExpression: visibleFor(c),
            }];
          }
          return [
            {
              type: 'dropdown', id: `setting_${varId(c.id)}`, label: 'Setting', default: entries[0].id,
              choices: entries.map((e) => ({ id: e.id, label: entryLabel(e) })),
              isVisibleExpression: visibleFor(c),
            },
            ...entries.map((e) => valueField(c.id, e)),
          ];
        }),
      ],
      callback: async (ev) => {
        const camera = ev.options.camera;
        const entry = usableEntries(self.ptzSchemas[camera])
          .find((e) => e.id === ev.options[`setting_${varId(camera)}`]);
        if (!entry) return;
        let value = ev.options[`v_${varId(camera)}_${entry.id}`];
        if (entry.type === 'bool') value = value === true || value === 'true';
        else if (entry.type === 'range') value = Number(value);
        else if (entry.type === 'text') value = await self.parseVariablesInString(String(value ?? ''));
        else if (entry.type === 'enum') {
          value = entry.options.find((o) => String(o.value) === String(value))?.value ?? value;
        }
        return self.setProp(camera, entry.id, value);
      },
    },
  };

  const withTracking = cams.filter((c) => c.capabilities?.tracking);
  if (withTracking.length) {
    const trackChoices = withTracking.map((c) => ({ id: c.id, label: c.label || c.id }));
    actions.ptzTracking = {
      name: 'PTZ: tracking on / off / toggle',
      options: [
        { type: 'dropdown', id: 'camera', label: 'Camera', default: trackChoices[0].id, choices: trackChoices },
        {
          type: 'dropdown', id: 'mode', label: 'Action', default: 'toggle',
          choices: [{ id: 'toggle', label: 'Toggle' }, { id: 'on', label: 'On' }, { id: 'off', label: 'Off' }],
        },
      ],
      callback: (ev) => {
        const cam = self.camera(ev.options.camera);
        const on = ev.options.mode === 'on' ? true : ev.options.mode === 'off' ? false : !cam?.ptz?.tracking;
        const entry = trackingEntry(self.ptzSchemas[ev.options.camera]);
        return self.setProp(ev.options.camera, entry?.id ?? 'trackingEnabled', trackingValue(entry, on));
      },
    };
  }

  return actions;
}

// --- feedbacks ------------------------------------------------------------

export function buildPtzFeedbacks(self) {
  const cams = self.cameras.filter(isPtz);
  if (!cams.length) return {};
  const choices = self.cameraChoices('ptz');
  const camField = () => ({
    type: 'dropdown', id: 'camera', label: 'Camera', default: choices[0]?.id ?? '', choices,
  });

  return {
    ptzTracking: {
      name: 'PTZ: tracking is active',
      type: 'boolean',
      defaultStyle: { bgcolor: GREEN, color: WHITE },
      options: [camField()],
      callback: (fb) => !!self.camera(fb.options.camera)?.ptz?.tracking,
    },

    ptzPresetCurrent: {
      name: 'PTZ: preset is the current one',
      type: 'boolean',
      defaultStyle: { bgcolor: BLUE, color: WHITE },
      options: [camField(), { type: 'number', id: 'preset', label: 'Preset number', default: 1, min: 0, max: 999 }],
      callback: (fb) => {
        const cur = self.camera(fb.options.camera)?.ptz?.preset;
        return cur !== null && cur !== undefined && Number(cur) === Number(fb.options.preset);
      },
    },

    ptzMoving: {
      name: 'PTZ: head is moving',
      type: 'boolean',
      defaultStyle: { bgcolor: AMBER, color: BLACK },
      options: [camField()],
      callback: (fb) => !!self.camera(fb.options.camera)?.ptz?.moving,
    },
  };
}

// --- variables ------------------------------------------------------------

export const PTZ_VARIABLES = [
  ['pan', 'Pan position (0-100)'],
  ['tilt', 'Tilt position (0-100)'],
  ['zoom', 'Zoom position (0-100)'],
  ['preset', 'Current preset'],
  ['tracking', 'Tracking (On / Off / n/a)'],
  ['moving', 'Moving (yes / no)'],
];

const percent = (v) => (Number.isFinite(v) ? Math.round(Math.max(0, Math.min(1, v)) * 100) : '');

export function ptzVariableValues(cam) {
  const v = varId(cam.id);
  const p = cam.ptz ?? {};
  return {
    [`${v}_pan`]: percent(p.pan),
    [`${v}_tilt`]: percent(p.tilt),
    [`${v}_zoom`]: percent(p.zoom),
    [`${v}_preset`]: p.preset ?? '',
    [`${v}_tracking`]: !cam.capabilities?.tracking ? 'n/a' : p.tracking ? 'On' : 'Off',
    [`${v}_moving`]: p.moving ? 'yes' : 'no',
  };
}

// --- ready-made buttons ---------------------------------------------------

const padStyle = (text, size = '18') => ({ text, size, color: WHITE, bgcolor: DARK });

/** A press-and-hold button: motion on down, stop on up. */
const holdButton = (category, name, text, size, start, release) => ({
  type: 'button',
  category,
  name,
  style: padStyle(text, size),
  steps: [{ down: [start], up: [release] }],
  feedbacks: [],
});

export function buildPtzPresets(self) {
  const presets = {};

  for (const cam of self.cameras.filter(isPtz)) {
    const v = varId(cam.id);
    const name = cam.label || cam.id;
    const category = `${name} — PTZ`;
    const caps = cam.capabilities ?? {};
    const opts = { camera: cam.id };
    const release = { actionId: 'ptzRelease', options: opts };

    if (caps.panTilt !== false) {
      for (const d of DIRECTIONS) {
        presets[`ptz_${d.id}_${v}`] = holdButton(category, `${name}: ${d.label}`, d.glyph, '28',
          { actionId: 'ptzPanTilt', options: { ...opts, direction: d.id, speed: 50 } }, release);
      }
    }
    if (caps.zoom !== false) {
      presets[`ptz_zoom_in_${v}`] = holdButton(category, `${name}: zoom in`, 'ZOOM\\n+', '18',
        { actionId: 'ptzZoom', options: { ...opts, direction: 'in', speed: 50 } }, release);
      presets[`ptz_zoom_out_${v}`] = holdButton(category, `${name}: zoom out`, 'ZOOM\\n−', '18',
        { actionId: 'ptzZoom', options: { ...opts, direction: 'out', speed: 50 } }, release);
    }
    if (caps.focus) {
      presets[`ptz_focus_near_${v}`] = holdButton(category, `${name}: focus near`, 'FOCUS\\nNEAR', '14',
        { actionId: 'ptzFocus', options: { ...opts, direction: 'near', speed: 50 } }, release);
      presets[`ptz_focus_far_${v}`] = holdButton(category, `${name}: focus far`, 'FOCUS\\nFAR', '14',
        { actionId: 'ptzFocus', options: { ...opts, direction: 'far', speed: 50 } }, release);
    }

    // Only where this camera's table has the function.
    const tap = (text, name, actionId) => ({
      type: 'button',
      category,
      name,
      style: padStyle(text, '18'),
      steps: [{ down: [{ actionId, options: opts }], up: [] }],
      feedbacks: [],
    });
    if (roleEntry(self.ptzSchemas?.[cam.id], 'home')) {
      presets[`ptz_home_${v}`] = tap('HOME', `${name}: home`, 'ptzHome');
    }
    if (roleEntry(self.ptzSchemas?.[cam.id], 'onePushAf')) {
      presets[`ptz_af_${v}`] = tap('AF', `${name}: one-push AF`, 'ptzOnePushAf');
    }

    const count = Math.min(8, caps.presets ?? 0);
    const base = caps.presetBase ?? 1;
    for (let i = 0; i < count; i += 1) {
      const n = base + i;
      presets[`ptz_preset_${n}_${v}`] = {
        type: 'button',
        category,
        name: `${name}: preset ${n}`,
        style: padStyle(`PRESET\\n${n}`, '18'),
        steps: [{ down: [{ actionId: 'ptzPresetRecall', options: { ...opts, preset: n, byName: '' } }], up: [] }],
        feedbacks: [
          { feedbackId: 'ptzPresetCurrent', options: { ...opts, preset: n }, style: { bgcolor: BLUE, color: WHITE } },
        ],
      };
    }

    if (caps.tracking) {
      presets[`ptz_tracking_${v}`] = {
        type: 'button',
        category,
        name: `${name}: tracking`,
        style: padStyle(`${caps.tracking.label ?? 'TRACK'}\\n$(cambridge:${v}_tracking)`, '14'),
        steps: [{ down: [{ actionId: 'ptzTracking', options: { ...opts, mode: 'toggle' } }], up: [] }],
        feedbacks: [{ feedbackId: 'ptzTracking', options: opts, style: { bgcolor: GREEN, color: WHITE } }],
      };
    }

    presets[`ptz_stop_all_${v}`] = {
      type: 'button',
      category,
      name: `${name}: STOP ALL`,
      style: { text: 'STOP\\nALL', size: '18', color: WHITE, bgcolor: RED },
      steps: [{ down: [{ actionId: 'ptzStopAll', options: {} }], up: [] }],
      feedbacks: [{ feedbackId: 'ptzMoving', options: opts, style: { bgcolor: AMBER, color: BLACK } }],
    };
  }

  return presets;
}
