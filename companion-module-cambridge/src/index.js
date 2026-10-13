// companion-module-cambridge — drive Sony FX3/FX30 bodies from a Stream Deck.
//
// The module is a thin client over the CamBridge HTTP API. It holds no camera
// logic of its own: ganging, presets, ramping and value snapping all happen in
// cambridge, so a change made from a Stream Deck and the same change made from
// the web panel take exactly the same path through the system. The only thing
// duplicated here is "one stop up from here" (src/step.js), and that is
// deliberate — it has to work with the state the module already has, without a
// round trip per keypress.

import { InstanceBase, InstanceStatus, Regex, runEntrypoint } from '@companion-module/base';

import { CambridgeApi } from './api.js';
import { buildActions } from './actions.js';
import { buildFeedbacks } from './feedbacks.js';
import { buildPresets } from './presets.js';
import { buildVariableDefinitions, buildVariableValues } from './variables.js';
import { STEPPABLE } from './step.js';
import { PtzHolds, isPtz } from './ptz.js';

class CambridgeInstance extends InstanceBase {
  constructor(internal) {
    super(internal);
    this.cameras = [];
    this.camdConnected = false;
    this.gangs = {};
    this.scenes = [];
    this.presetsByCamera = {};
    this.groups = {};
    this.alarms = [];
    this.alarmsByCamera = {};
    this.alarmSummary = null;
    this.roll = null;
    /** False at a venue with only PTZ heads, where there is no camd to be "down". */
    this.camdUsed = true;
    /** PTZ table entries per camera id, from GET /api/cameras/:id/schema. */
    this.ptzSchemas = {};
    /** Saved preset names per PTZ camera id: [{ n, name }]. */
    this.ptzPresetNames = {};
    this.ptzSchemaWanted = '';
    this.ptzSchemaInflight = new Set();
    this.ptzHolds = new PtzHolds({
      move: (id, axes) => this.api?.request('POST', `/api/cameras/${encodeURIComponent(id)}/ptz/move`, axes),
      stop: (id) => this.api?.request('POST', `/api/cameras/${encodeURIComponent(id)}/ptz/stop`),
      log: (level, msg) => this.log(level, msg),
    });
    /** Signature of the last definition rebuild, so we only rebuild when it matters. */
    this.definitionSignature = '';
  }

  async init(config) {
    this.config = config;
    this.updateStatus(InstanceStatus.Connecting);
    this.#connect();
  }

  async configUpdated(config) {
    this.config = config;
    this.api?.stop();
    // A held key must not outlive the connection it was started on. The stop is
    // best effort; the head's own deadman covers it if this does not arrive.
    this.ptzHolds.clearAll({ stop: true });
    this.updateStatus(InstanceStatus.Connecting);
    this.#connect();
  }

  async destroy() {
    this.ptzHolds.clearAll({ stop: true });
    this.api?.stop();
    this.api = null;
  }

  getConfigFields() {
    return [
      {
        type: 'static-text',
        id: 'intro',
        width: 12,
        label: 'CamBridge',
        value:
          'Connects to a running CamBridge server. Use the address you open the ' +
          'control panel on — the same one printed when CamBridge starts.',
      },
      {
        type: 'textinput', id: 'host', label: 'CamBridge address', width: 8,
        default: '127.0.0.1', regex: Regex.HOSTNAME,
      },
      {
        type: 'number', id: 'port', label: 'Port', width: 4,
        default: 8088, min: 1, max: 65535,
      },
    ];
  }

  #connect() {
    this.api = new CambridgeApi({
      host: this.config?.host || '127.0.0.1',
      port: Number(this.config?.port) || 8088,
      log: (level, msg) => this.log(level, msg),
      onState: (view) => this.applyState(view),
      onConnection: (up, detail) => {
        if (up) {
          this.updateStatus(InstanceStatus.Ok);
        } else {
          // Stop refreshing held motion: the server cannot be reached, so it is
          // the head's deadman that stops it, within about half a second.
          this.ptzHolds.clearAll();
          // The distinction matters to whoever is looking at Companion: this is
          // "cannot reach CamBridge", not "a camera is unhappy".
          this.updateStatus(InstanceStatus.ConnectionFailure, detail ?? 'cannot reach CamBridge');
        }
      },
    });
    this.api.start();
    this.refreshPresetLists();
  }

  // --- state ---------------------------------------------------------------

  /**
   * Public rather than #private so tests can drive it with a real state frame.
   *
   * Takes the whole envelope, not just the view: alarms are evaluated by
   * CamBridge and travel with the state they were derived from, so a Stream
   * Deck key showing a card warning and the panel banner can never disagree.
   */
  applyState(frame) {
    const view = frame?.view ?? frame ?? {};
    this.alarms = frame?.alarms ?? [];
    this.alarmsByCamera = frame?.alarmsByCamera ?? {};
    this.alarmSummary = frame?.alarmSummary ?? null;
    this.roll = frame?.roll ?? null;

    this.camdConnected = !!view.camdConnected;
    // A server that predates PTZ does not send this, and then camd is in use.
    this.camdUsed = view.camdUsed !== false;
    const incoming = view.cameras ?? [];

    // Tally is not part of the camera record CamBridge sends when the ATEM
    // listener is off, so carry forward anything we already know rather than
    // blanking the tally feedbacks on every state frame.
    const previousTally = new Map(this.cameras.map((c) => [c.id, c.tally]));
    this.cameras = incoming.map((c) => ({ ...c, tally: c.tally ?? previousTally.get(c.id) ?? null }));

    // Rebuild action/feedback dropdowns only when the camera set changes.
    // Doing it on every property tick would make Companion's UI unusable —
    // dropdowns would reset under the operator's cursor while editing a button.
    // A PTZ head's capabilities decide which buttons exist, so they count too;
    // its pan/tilt/zoom position, which changes constantly, does not.
    const signature = this.cameras.map((c) =>
      `${c.id}:${c.label}${isPtz(c) ? `:ptz:${JSON.stringify(c.capabilities ?? null)}` : ''}`).join('|');
    if (signature !== this.definitionSignature) {
      this.definitionSignature = signature;
      this.rebuildDefinitions();
    }
    this.#refreshPtzDefinitions();

    this.setVariableValues(buildVariableValues(this.cameras, {
      camdConnected: this.camdConnected,
      camdUsed: this.camdUsed,
      alarmsByCamera: this.alarmsByCamera,
      alarms: this.alarms,
      roll: this.roll,
    }));
    this.checkFeedbacks();
  }

  rebuildDefinitions() {
    this.setVariableDefinitions(buildVariableDefinitions(this.cameras));
    this.setActionDefinitions(buildActions(this));
    this.setFeedbackDefinitions(buildFeedbacks(this));
    this.setPresetDefinitions(buildPresets(this));
  }

  /**
   * Schemas and saved preset names decide what the PTZ dropdowns offer. They are
   * fetched when the set of PTZ heads (or what they can do) changes, and again
   * for a head whose schema could not be had yet — one that was still connecting.
   */
  #refreshPtzDefinitions() {
    const ptz = this.cameras.filter(isPtz);
    const wanted = ptz.map((c) => `${c.id}:${JSON.stringify(c.capabilities ?? null)}`).join('|');
    const changed = wanted !== this.ptzSchemaWanted;
    this.ptzSchemaWanted = wanted;
    const missing = ptz.filter((c) => c.state === 'connected' && !this.ptzSchemas[c.id]
      && !this.ptzSchemaInflight.has(c.id));
    if (!this.api || (!changed && !missing.length)) return;
    const targets = (changed ? ptz : missing).filter((c) => c.state === 'connected');
    for (const c of targets) this.ptzSchemaInflight.add(c.id);
    this.#loadPtzDetails(targets).finally(() => {
      for (const c of targets) this.ptzSchemaInflight.delete(c.id);
    });
  }

  async #loadPtzDetails(cams) {
    await Promise.all(cams.map(async (c) => {
      const r = await this.api.request('GET', `/api/cameras/${encodeURIComponent(c.id)}/schema`);
      if (r.ok && Array.isArray(r.body?.entries)) this.ptzSchemas[c.id] = r.body.entries;
    }));
    await this.refreshPtzPresetNames({ rebuild: false });
    // Drop what belongs to a head that has gone.
    const ids = new Set(this.cameras.filter(isPtz).map((c) => c.id));
    for (const id of Object.keys(this.ptzSchemas)) if (!ids.has(id)) delete this.ptzSchemas[id];
    this.rebuildDefinitions();
  }

  /** Saved preset names for every PTZ head, for the "by name" dropdowns. */
  async refreshPtzPresetNames({ rebuild = true } = {}) {
    if (!this.api) return;
    await Promise.all(this.cameras.filter(isPtz).map(async (c) => {
      const r = await this.api.request('GET', `/api/cameras/${encodeURIComponent(c.id)}/ptz/presets`);
      if (r.ok && Array.isArray(r.body?.presets)) {
        this.ptzPresetNames[c.id] = r.body.presets.filter((p) => p.name).map((p) => ({ n: p.n, name: p.name }));
      }
    }));
    if (rebuild) this.rebuildDefinitions();
  }

  /** Preset number -> "3 — Lectern", across PTZ heads (the number is what is sent). */
  ptzPresetNameChoices() {
    const seen = new Map();
    for (const list of Object.values(this.ptzPresetNames)) {
      for (const { n, name } of list ?? []) if (!seen.has(`${n}`)) seen.set(`${n}`, `${n} — ${name}`);
    }
    return [{ id: '', label: '(use the number)' },
      ...[...seen].sort((a, b) => Number(a[0]) - Number(b[0])).map(([id, label]) => ({ id, label }))];
  }

  /** Preset names, scene names and gang state come from a separate endpoint. */
  async refreshPresetLists() {
    const [presetsRes, gangsRes] = await Promise.all([
      this.api.request('GET', '/api/presets'),
      this.api.request('GET', '/api/gangs'),
    ]);
    if (presetsRes.ok && presetsRes.body) {
      this.presetsByCamera = presetsRes.body.presets ?? {};
      this.scenes = presetsRes.body.scenes ?? [];
      this.groups = presetsRes.body.groups ?? {};
    }
    if (gangsRes.ok && gangsRes.body) this.gangs = gangsRes.body.gangs ?? {};
    this.rebuildDefinitions();
  }

  // --- helpers used by actions/feedbacks -----------------------------------

  camera(id) {
    return this.cameras.find((c) => c.id === id) ?? null;
  }

  /**
   * `kind` narrows the list: 'sony' for controls that only mean something on a
   * cinema body (record, exposure steppers), 'ptz' for PTZ controls, and the
   * default for anything that works on either.
   */
  cameraChoices(kind = 'all') {
    const list = this.cameras.filter((c) =>
      kind === 'all' || (kind === 'ptz' ? isPtz(c) : !isPtz(c)));
    if (!list.length) {
      return [{ id: '', label: kind === 'ptz' ? '(no PTZ cameras yet)' : '(no cameras yet)' }];
    }
    return list.map((c) => ({ id: c.id, label: c.label || c.id }));
  }

  propChoices() {
    return STEPPABLE.map((p) => ({ id: p.id, label: p.label }));
  }

  /** Every preset name across all cameras — a button may target any camera. */
  presetChoices() {
    const names = new Set();
    for (const perCamera of Object.values(this.presetsByCamera)) {
      for (const name of Object.keys(perCamera ?? {})) names.add(name);
    }
    const list = [...names].sort().map((n) => ({ id: n, label: n }));
    return list.length ? list : [{ id: '', label: '(no presets saved yet)' }];
  }

  sceneChoices() {
    const list = this.scenes.map((s) => ({ id: s, label: s }));
    return list.length ? list : [{ id: '', label: '(no scenes saved yet)' }];
  }

  /** Turns selected recall groups into the property list the API expects. */
  groupProps(selected) {
    if (!Array.isArray(selected) || selected.length === 0) return null;
    const props = selected.flatMap((g) => this.groups?.[g]?.props ?? []);
    return props.length ? props : null;
  }

  async setProp(cameraId, prop, value) {
    return this.api.request(
      'PUT', `/api/cameras/${encodeURIComponent(cameraId)}/properties/${encodeURIComponent(prop)}`,
      { value });
  }
}

// Companion sets MODULE_MANIFEST and launches the module over IPC; runEntrypoint
// requires both and rejects without them. Guarding on it means the tests can
// import this file to exercise the real class, rather than testing a copy of it.
if (process.env.MODULE_MANIFEST) {
  runEntrypoint(CambridgeInstance, []);
}

export { CambridgeInstance };
