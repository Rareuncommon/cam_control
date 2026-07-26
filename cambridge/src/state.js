// Mirrored multi-camera state model.
//
// camd is the source of truth; this keeps a local copy so the UI can be served
// instantly and so gang/match/preset logic has something to read without a round
// trip per camera. Every mutation emits a change event, which is what drives SSE
// to the browser.
//
// Deliberately not authoritative: on any reconnect the mirror is rebuilt from
// camd's hello snapshot rather than merged, because a mirror that quietly retains
// pre-outage values is how a UI ends up showing an iris that is not real.

import { EventEmitter } from 'node:events';
import { decorate, RECORDING_STATE } from './normalise.js';

export class StateModel extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} */
    this.cameras = new Map();
    this.camdConnected = false;
    this.backend = 'unknown';
  }

  /** Rebuilds from camd's snapshot. Cameras absent from the snapshot are dropped. */
  replaceAll(snapshotList, backend) {
    if (backend) this.backend = backend;
    const seen = new Set();
    for (const snap of snapshotList) {
      seen.add(snap.id);
      const existing = this.cameras.get(snap.id);
      this.cameras.set(snap.id, {
        ...(existing ?? {}),
        ...this.#fromSnapshot(snap),
        // Properties are intentionally not carried over: they are refetched.
        properties: existing?.properties ?? {},
      });
    }
    for (const id of [...this.cameras.keys()]) {
      if (!seen.has(id)) this.cameras.delete(id);
    }
    this.emit('change', { type: 'all' });
  }

  #fromSnapshot(snap) {
    return {
      id: snap.id,
      label: snap.label,
      model: snap.model,
      ip: snap.ip,
      mac: snap.mac,
      state: snap.state,
      discovered: !!snap.discovered,
      reconnectAttempts: snap.reconnectAttempts ?? 0,
      detail: snap.detail ?? null,
      status: {
        battery: snap.status?.battery ?? -1,
        media: snap.status?.media ?? '',
        mediaPresent: !!snap.status?.mediaPresent,
        recordingState: snap.status?.recordingState ?? -1,
        recording: !!snap.status?.recording,
        recordingFailed: !!snap.status?.recordingFailed,
      },
    };
  }

  get(id) { return this.cameras.get(id) ?? null; }
  list() { return [...this.cameras.values()]; }

  ensure(id) {
    if (!this.cameras.has(id)) {
      this.cameras.set(id, {
        id, label: id, model: '', ip: '', mac: '',
        state: 'offline', discovered: false, reconnectAttempts: 0, detail: null,
        status: { battery: -1, media: '', mediaPresent: false,
                  recordingState: -1, recording: false, recordingFailed: false },
        properties: {},
      });
    }
    return this.cameras.get(id);
  }

  applyConnectionState(ev) {
    const cam = this.ensure(ev.cameraId);
    const previous = cam.state;
    cam.state = ev.state;
    if (ev.model) cam.model = ev.model;
    if (ev.ip) cam.ip = ev.ip;
    if (ev.mac) cam.mac = ev.mac;
    cam.reconnectAttempts = ev.reconnectAttempts ?? cam.reconnectAttempts;
    cam.detail = ev.detail ?? null;

    // Values learned before an outage must not survive it. Clearing here means the
    // UI shows "—" until camd republishes, which is honest; keeping them would show
    // a plausible lie.
    if (ev.state !== 'connected' && previous === 'connected') {
      cam.properties = {};
    }
    this.emit('change', { type: 'connectionState', cameraId: ev.cameraId, from: previous, to: ev.state });
  }

  applyStatus(ev) {
    const cam = this.ensure(ev.cameraId);
    cam.status = {
      battery: ev.battery ?? -1,
      media: ev.media ?? '',
      mediaPresent: !!ev.mediaPresent,
      recordingState: ev.recordingState ?? -1,
      recording: !!ev.recording,
      recordingFailed: !!ev.recordingFailed,
    };
    this.emit('change', { type: 'statusUpdate', cameraId: ev.cameraId });
  }

  applyPropertyChange(ev) {
    const cam = this.ensure(ev.cameraId);
    const prev = cam.properties[ev.prop];
    cam.properties[ev.prop] = {
      value: ev.value,
      writable: ev.writable ?? prev?.writable ?? false,
      allowed: prev?.allowed,
      range: prev?.range,
    };
    this.emit('change', {
      type: 'propertyChanged',
      cameraId: ev.cameraId,
      prop: ev.prop,
      from: prev?.value,
      to: ev.value,
    });
  }

  /** Wholesale property refresh from GET /cameras/:id/properties. */
  replaceProperties(cameraId, properties) {
    const cam = this.ensure(cameraId);
    cam.properties = properties ?? {};
    this.emit('change', { type: 'properties', cameraId });
  }

  setCamdConnected(connected) {
    if (this.camdConnected === connected) return;
    this.camdConnected = connected;
    if (!connected) {
      // The daemon is gone: every camera's state is unknown, and saying so is the
      // point. Fail loud in the UI.
      for (const cam of this.cameras.values()) {
        cam.state = 'offline';
        cam.detail = 'camd unreachable';
        cam.properties = {};
      }
    }
    this.emit('change', { type: 'camdConnection', connected });
  }

  /** The shape the browser consumes: raw values plus labels and options. */
  view() {
    return {
      camdConnected: this.camdConnected,
      backend: this.backend,
      cameras: this.list().map((cam) => ({
        id: cam.id,
        label: cam.label,
        model: cam.model,
        ip: cam.ip,
        mac: cam.mac,
        state: cam.state,
        detail: cam.detail,
        reconnectAttempts: cam.reconnectAttempts,
        status: {
          ...cam.status,
          recordingLabel:
            cam.status.recordingState === RECORDING_STATE.FAILED ? 'FAILED'
              : cam.status.recording ? 'REC' : 'idle',
        },
        properties: Object.fromEntries(
          Object.entries(cam.properties).map(([name, p]) => [name, decorate(name, p)]),
        ),
      })),
    };
  }
}
