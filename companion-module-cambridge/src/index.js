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
    this.updateStatus(InstanceStatus.Connecting);
    this.#connect();
  }

  async destroy() {
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
      { type: 'textinput', id: 'token', label: 'Access token (when a PIN is enabled)',
        width: 12, default: '', isPassword: true },
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
      token: this.config?.token || '',
      log: (level, msg) => this.log(level, msg),
      onState: (view) => this.applyState(view),
      onConnection: (up, detail) => {
        if (up) {
          this.updateStatus(InstanceStatus.Ok);
        } else {
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
    const incoming = view.cameras ?? [];

    // Tally is not part of the camera record CamBridge sends when the ATEM
    // listener is off, so carry forward anything we already know rather than
    // blanking the tally feedbacks on every state frame.
    const previousTally = new Map(this.cameras.map((c) => [c.id, c.tally]));
    this.cameras = incoming.map((c) => ({ ...c, tally: c.tally ?? previousTally.get(c.id) ?? null }));

    // Rebuild action/feedback dropdowns only when the camera set changes.
    // Doing it on every property tick would make Companion's UI unusable —
    // dropdowns would reset under the operator's cursor while editing a button.
    const signature = this.cameras.map((c) => `${c.id}:${c.label}`).join('|');
    if (signature !== this.definitionSignature) {
      this.definitionSignature = signature;
      this.rebuildDefinitions();
    }

    this.setVariableValues(buildVariableValues(this.cameras, {
      camdConnected: this.camdConnected,
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

  cameraChoices() {
    if (!this.cameras.length) return [{ id: '', label: '(no cameras yet)' }];
    return this.cameras.map((c) => ({ id: c.id, label: c.label || c.id }));
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
