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

import { CambridgeApi, AUTH_MESSAGE } from './api.js';
import { buildActions } from './actions.js';
import { buildFeedbacks } from './feedbacks.js';
import { buildPresets } from './presets.js';
import { buildVariableDefinitions, buildVariableValues } from './variables.js';
import { STEPPABLE } from './step.js';
import { PtzHolds, holdCeilingMs, HOLD_MAX_MIN_S, HOLD_MAX_MAX_S, HOLD_MAX_DEFAULT_S, isPtz, SELECTED, SELECTED_TAG } from './ptz.js';
import {
  bankSizeOf, bankCount, bankOf, stepSelection, selectionVariableDefs, selectionVariableValues,
} from './select.js';

/** Runs `fn` over `items` with at most `limit` in flight: 48 heads must not mean 48 requests at once. */
async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const SCHEMA_FETCH_CONCURRENCY = 6;

/** "Label (group)" when the camera has a group. */
const cameraLabel = (c) => (c.group ? `${c.label || c.id} (${c.group})` : (c.label || c.id));

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
    /** PTZ heads in the order the server sent them (the operator's order). */
    this.ptzCams = [];
    /**
     * Which PTZ head "(selected camera)" means. Local to this module instance:
     * another surface has its own. Null only while there is no PTZ head.
     */
    this.selectedPtz = null;
    /** Which bank of camera-select keys is showing, 0-based. */
    this.ptzBank = 0;
    /** id -> { src, cam }: what we received and the record we built from it. */
    this.mappedCameras = new Map();
    this.signatureCache = new WeakMap();
    this.lastAlarmsByCamera = {};
  }

  /** Camera-select keys per bank. Part of the definitions, so changing it rebuilds them. */
  get bankSize() { return bankSizeOf(this.config); }

  /** Whether each PTZ head also gets its own button category (off for big venues). */
  get ptzPerCameraPresets() { return this.config?.ptzPerCameraPresets !== false; }

  async init(config) {
    this.config = config;
    this.ptzHolds.maxMs = holdCeilingMs(config?.holdCeilingSec);
    this.updateStatus(InstanceStatus.Connecting);
    this.#connect();
  }

  async configUpdated(config) {
    this.config = config;
    this.ptzHolds.maxMs = holdCeilingMs(config?.holdCeilingSec);
    // Bank size and the per-camera button switch change the definitions.
    const signature = this.#signature();
    if (this.cameras.length && signature !== this.definitionSignature) {
      this.definitionSignature = signature;
      this.#reconcileSelection();
      this.rebuildDefinitions();
      this.#publishSelection();
    }
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
      {
        type: 'secret-text', id: 'token', label: 'Access token', width: 12,
        default: '',
        tooltip: 'Only needed once CamBridge has a PIN set. A token from CamBridge\'s config (tokens). Sent as "Authorization: Bearer ..." on every request. Treat it as a password.',
      },
      {
        type: 'number', id: 'holdCeilingSec', label: 'Held-key safety limit (seconds)', width: 6,
        default: HOLD_MAX_DEFAULT_S, min: HOLD_MAX_MIN_S, max: HOLD_MAX_MAX_S,
        tooltip: 'If a held PTZ key never reports its release, movement stops after this long.',
      },
      {
        type: 'number', id: 'bankSize', label: 'Camera-select keys per bank', width: 6,
        default: 8, min: 1, max: 32,
      },
      {
        type: 'checkbox', id: 'ptzPerCameraPresets', width: 6, default: true,
        label: 'Ready-made buttons for every PTZ camera',
        tooltip: 'Turn off at a venue with many heads: the "PTZ controller" buttons drive any camera, and the long per-camera lists go away.',
      },
    ];
  }

  #connect() {
    this.api = new CambridgeApi({
      host: this.config?.host || '127.0.0.1',
      port: Number(this.config?.port) || 8088,
      log: (level, msg) => this.log(level, msg),
      token: this.config?.token,
      onAuthError: () => {
        this.ptzHolds.clearAll();
        this.updateStatus(InstanceStatus.AuthenticationFailure, AUTH_MESSAGE);
      },
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
    //
    // A patched frame reuses the objects of every camera that did not change,
    // so those are recognised by identity and keep the record built for them.
    // That is what lets one head panning among 48 cost one head's work.
    const previous = this.mappedCameras;
    const mapped = new Map();
    const changedIds = new Set();
    this.cameras = incoming.map((c) => {
      const old = previous.get(c.id);
      const tally = c.tally ?? old?.cam.tally ?? null;
      if (old && old.src === c && old.cam.tally === tally) {
        mapped.set(c.id, old);
        return old.cam;
      }
      const cam = { ...c, tally };
      mapped.set(c.id, { src: c, cam });
      changedIds.add(c.id);
      return cam;
    });
    this.mappedCameras = mapped;
    this.ptzCams = this.cameras.filter(isPtz);

    // Rebuild action/feedback dropdowns only when the camera set, a name, a
    // group or what a head can do changes. Doing it on every property tick
    // would make Companion's UI unusable — dropdowns would reset under the
    // operator's cursor while editing a button. A PTZ head's pan/tilt/zoom
    // position, which changes constantly, is not part of it.
    const signature = this.#signature();
    const rebuilt = signature !== this.definitionSignature;
    this.#reconcileSelection();
    if (rebuilt) {
      this.definitionSignature = signature;
      this.rebuildDefinitions();
    }
    this.#refreshPtzDefinitions();

    // Which cameras' variables need writing: the changed ones, anyone whose
    // alarms changed, and anyone rolling (their elapsed time moves with the clock).
    let only = null;
    if (!rebuilt) {
      only = changedIds;
      for (const c of this.cameras) {
        if (c.recordStartedAt || this.alarmsByCamera[c.id] !== this.lastAlarmsByCamera[c.id]) only.add(c.id);
      }
    }
    this.lastAlarmsByCamera = this.alarmsByCamera;

    this.setVariableValues({
      ...buildVariableValues(this.cameras, {
        camdConnected: this.camdConnected,
        camdUsed: this.camdUsed,
        alarmsByCamera: this.alarmsByCamera,
        alarms: this.alarms,
        roll: this.roll,
        only,
      }),
      ...this.#selectionValues(),
    });
    this.checkFeedbacks();
  }

  #cameraSignature(c) {
    let sig = this.signatureCache.get(c);
    if (sig === undefined) {
      sig = `${c.id}:${c.label}:${c.group ?? ''}${isPtz(c) ? `:ptz:${JSON.stringify(c.capabilities ?? null)}` : ''}`;
      this.signatureCache.set(c, sig);
    }
    return sig;
  }

  #signature() {
    return `${this.cameras.map((c) => this.#cameraSignature(c)).join('|')}#${this.bankSize}#${this.ptzPerCameraPresets}`;
  }

  rebuildDefinitions() {
    this.setVariableDefinitions([
      ...buildVariableDefinitions(this.cameras),
      ...(this.ptzCams.length ? selectionVariableDefs(this.bankSize) : []),
    ]);
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
    await mapLimit(cams, SCHEMA_FETCH_CONCURRENCY, async (c) => {
      const r = await this.api.request('GET', `/api/cameras/${encodeURIComponent(c.id)}/schema`);
      if (r.ok && Array.isArray(r.body?.entries)) this.ptzSchemas[c.id] = r.body.entries;
    });
    await this.refreshPtzPresetNames({ rebuild: false });
    // Drop what belongs to a head that has gone.
    const ids = new Set(this.cameras.filter(isPtz).map((c) => c.id));
    for (const id of Object.keys(this.ptzSchemas)) if (!ids.has(id)) delete this.ptzSchemas[id];
    this.rebuildDefinitions();
  }

  /** Saved preset names for every PTZ head, for the "by name" dropdowns. */
  async refreshPtzPresetNames({ rebuild = true } = {}) {
    if (!this.api) return;
    await mapLimit(this.cameras.filter(isPtz), SCHEMA_FETCH_CONCURRENCY, async (c) => {
      const r = await this.api.request('GET', `/api/cameras/${encodeURIComponent(c.id)}/ptz/presets`);
      if (r.ok && Array.isArray(r.body?.presets)) {
        this.ptzPresetNames[c.id] = r.body.presets.filter((p) => p.name).map((p) => ({ n: p.n, name: p.name }));
      }
    });
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

  // --- selected camera and banks ---------------------------------------------

  /** The camera id an action's camera option means: "(selected camera)" becomes the selection (or null). */
  resolvePtz(option) {
    return option === SELECTED ? this.selectedPtz : option;
  }

  /** The camera in bank slot `n` (1-based) of the bank showing, or null. */
  bankCamera(n) {
    return this.ptzCams[this.ptzBank * this.bankSize + (n - 1)] ?? null;
  }

  /**
   * Selects a head. A key still held on the previous selection is stopped first
   * (the stop is queued before anything else can be sent), so moving the
   * selection mid-press can never leave a head panning with nobody holding it.
   */
  selectPtz(id) {
    if (!this.ptzCams.some((c) => c.id === id)) return Promise.resolve();
    const stopped = this.selectedPtz !== id ? this.ptzHolds.releaseTagged(SELECTED_TAG) : Promise.resolve();
    this.selectedPtz = id;
    // The bank follows the selection, so a "next camera" key never selects
    // something the bank row is not showing.
    this.ptzBank = bankOf(this.ptzCams, id, this.bankSize);
    this.#publishSelection();
    return stopped;
  }

  selectBankSlot(n) {
    const cam = this.bankCamera(n);
    return cam ? this.selectPtz(cam.id) : Promise.resolve();
  }

  /** Next / previous head, optionally only within one group. */
  stepPtz(direction, group = '') {
    const list = group ? this.ptzCams.filter((c) => c.group === group) : this.ptzCams;
    const id = stepSelection(list, this.selectedPtz, direction);
    return id ? this.selectPtz(id) : Promise.resolve();
  }

  /** Changes which cameras the select keys show; the selection stays where it is. */
  moveBank(mode, number = 1) {
    const count = bankCount(this.ptzCams.length, this.bankSize);
    if (mode === 'next') this.ptzBank = (this.ptzBank + 1) % count;
    else if (mode === 'previous') this.ptzBank = (this.ptzBank - 1 + count) % count;
    else this.ptzBank = Math.max(0, Math.min(count - 1, (Number.isFinite(number) ? number : 1) - 1));
    this.#publishSelection();
  }

  /**
   * Keeps the selection pointing at a head that exists. A selection survives
   * every camera-list change that leaves its head in place; if the head has
   * gone the first one is selected, and anything held on it is stopped.
   */
  #reconcileSelection() {
    const had = this.selectedPtz;
    if (!this.ptzCams.some((c) => c.id === had)) {
      this.selectedPtz = this.ptzCams[0]?.id ?? null;
      if (had !== null) this.ptzHolds.releaseTagged(SELECTED_TAG);
      this.ptzBank = this.selectedPtz ? bankOf(this.ptzCams, this.selectedPtz, this.bankSize) : 0;
    } else {
      this.ptzBank = Math.min(this.ptzBank, bankCount(this.ptzCams.length, this.bankSize) - 1);
    }
  }

  #selectionValues() {
    return selectionVariableValues({
      selected: this.camera(this.selectedPtz),
      list: this.ptzCams,
      bank: this.ptzBank,
      bankSize: this.bankSize,
    });
  }

  /** Selection or bank moved: refresh the variables and feedbacks that read them. */
  #publishSelection() {
    if (!this.ptzCams.length) return;
    this.setVariableValues(this.#selectionValues());
    this.checkFeedbacks('ptzSelected', 'ptzSlotSelected', 'ptzSlotTally', 'ptzSlotOffline',
      'ptzTracking', 'ptzPresetCurrent', 'ptzMoving');
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
    // Server order, not alphabetical: it is the operator's order. A group, when
    // there is one, is shown so 48 names stay tellable apart.
    return list.map((c) => ({ id: c.id, label: cameraLabel(c) }));
  }

  /** PTZ cameras for a dropdown, with "(selected camera)" first. */
  ptzCameraChoices() {
    return [{ id: SELECTED, label: '(selected camera)' }, ...this.cameraChoices('ptz')];
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
