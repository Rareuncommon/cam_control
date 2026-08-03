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

/**
 * One camera's status, from either a snapshot or a statusUpdate event.
 *
 * Both shapes carry the same fields, and having drifted once already, they are
 * built here rather than spelled out twice.
 *
 * The `-1` defaults are load-bearing: they mean "the camera did not report
 * this", and the alarm layer refuses to act on them. Defaulting to 0 would turn
 * every camera that does not report card time into one with a full card.
 */
function statusFrom(s) {
  return {
    battery: s?.battery ?? -1,
    media: s?.media ?? '',
    mediaPresent: !!s?.mediaPresent,
    mediaSlot1Sec: s?.mediaSlot1Sec ?? -1,
    mediaSlot2Sec: s?.mediaSlot2Sec ?? -1,
    recordingState: s?.recordingState ?? -1,
    recording: !!s?.recording,
    recordingFailed: !!s?.recordingFailed,
  };
}

/**
 * How long after a stop command a camera may still be reported as recording
 * before we call the stop unexplained.
 *
 * Generous on purpose. The FX30 takes a moment to settle after the button pair,
 * and status is polled rather than pushed, so a tight window would report every
 * ordinary stop as a fault. The failure this guards against — a camera that
 * quietly leaves record hours into a shoot — is nowhere near this boundary.
 */
const STOP_INTENT_GRACE_MS = 20_000;

/** Take history is bounded: this runs for days at a time, unattended. */
const MAX_TAKES = 500;

export class StateModel extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} */
    this.cameras = new Map();
    this.camdConnected = false;
    this.backend = 'unknown';
    /** Completed and in-flight takes, oldest first. @type {object[]} */
    this.takes = [];
    /** cameraId -> { wanted: 'start'|'stop', at: number } */
    this.recordIntent = new Map();
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
      status: statusFrom(snap.status),
    };
  }

  get(id) { return this.cameras.get(id) ?? null; }
  list() { return [...this.cameras.values()]; }

  ensure(id) {
    if (!this.cameras.has(id)) {
      this.cameras.set(id, {
        id, label: id, model: '', ip: '', mac: '',
        state: 'offline', discovered: false, reconnectAttempts: 0, detail: null,
        status: statusFrom(null),
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

      // A camera that vanishes mid-take needs its take closed, but not called a
      // drop: from here we genuinely cannot tell whether it kept rolling on its
      // own card or stopped. `dropped: null` is that third answer, and the take
      // log prints it as unknown rather than picking one.
      if (cam.status?.recording) {
        const take = this.#openTakeFor(cam.id);
        if (take) {
          take.endedAt = Date.now();
          take.dropped = null;
        }
        // Clear the flag too, or the reconnect — which reports not-recording —
        // looks like an unexplained stop and raises a second, wrong alarm for
        // something already recorded above.
        cam.status = { ...cam.status, recording: false, recordDropped: false };
      }
      cam.recordStartedAt = null;
    }
    this.emit('change', { type: 'connectionState', cameraId: ev.cameraId, from: previous, to: ev.state });
  }

  /**
   * Records that a record start or stop was *asked for*.
   *
   * Without this there is no way to tell an ordinary stop from a camera giving
   * up: both look identical in the status stream. The server calls this around
   * every record command, from whichever surface issued it — panel, Companion,
   * VISCA or gamepad — so a stop pressed on a Stream Deck is not later reported
   * as a fault.
   */
  markRecordIntent(cameraId, wanted, at = Date.now()) {
    this.recordIntent.set(cameraId, { wanted, at });
  }

  applyStatus(ev) {
    const cam = this.ensure(ev.cameraId);
    const before = cam.status;
    const next = statusFrom(ev);

    // Carry the dropped flag forward; it is cleared deliberately, below, not by
    // the next status poll happening to arrive.
    next.recordDropped = before?.recordDropped ?? false;

    if (!before?.recording && next.recording) {
      cam.recordStartedAt = Date.now();
      next.recordDropped = false;
      this.takes.push({
        cameraId: cam.id,
        label: cam.label || cam.id,
        startedAt: cam.recordStartedAt,
        endedAt: null,
        dropped: false,
      });
      if (this.takes.length > MAX_TAKES) this.takes.shift();
    } else if (before?.recording && !next.recording) {
      const intent = this.recordIntent.get(cam.id);
      const asked = intent?.wanted === 'stop'
        && Date.now() - intent.at <= STOP_INTENT_GRACE_MS;
      next.recordDropped = !asked;
      const take = this.#openTakeFor(cam.id);
      if (take) {
        take.endedAt = Date.now();
        take.dropped = !asked;
      }
      cam.recordStartedAt = null;
    }

    cam.status = next;
    this.emit('change', { type: 'statusUpdate', cameraId: ev.cameraId });
  }

  #openTakeFor(cameraId) {
    for (let i = this.takes.length - 1; i >= 0; i--) {
      const t = this.takes[i];
      if (t.cameraId === cameraId && t.endedAt === null) return t;
    }
    return null;
  }

  /**
   * Clears a camera's dropped-record flag once the operator has seen it.
   *
   * An alarm that cannot be dismissed is an alarm that gets ignored, and the
   * flag would otherwise persist until the camera rolls again — which, for a
   * camera that dropped because its card filled, may be a long time.
   */
  acknowledgeRecordDrop(cameraId) {
    const cam = this.cameras.get(cameraId);
    if (!cam?.status?.recordDropped) return false;
    cam.status = { ...cam.status, recordDropped: false };
    this.emit('change', { type: 'statusUpdate', cameraId });
    return true;
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

  /**
   * Tally from the switcher, keyed by camera id.
   *
   * Held on the mirror rather than fetched, because tally has to be as instant
   * as the cut it reflects. It is deliberately *not* cleared when a camera goes
   * offline: the switcher is still putting that input on air, and hiding that
   * would be the wrong thing to tell the operator.
   */
  applyTally(byCamera) {
    let changed = false;
    for (const cam of this.cameras.values()) {
      const next = byCamera?.[cam.id] ?? null;
      const before = cam.tally ?? null;
      if (before?.program === next?.program && before?.preview === next?.preview) continue;
      cam.tally = next;
      changed = true;
    }
    if (changed) this.emit('change', { type: 'tally' });
    return changed;
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
        tally: cam.tally ?? null,
        // Sent as a start timestamp rather than an elapsed count, so the browser
        // can tick the timer itself instead of the server pushing once a second.
        recordStartedAt: cam.recordStartedAt ?? null,
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
