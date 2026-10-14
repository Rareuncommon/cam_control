// Applying the server's event-stream patches to a full state frame.
//
// The stream starts with one full `state` frame and then sends `patch` frames
// carrying only what changed: one camera's position while it pans, one
// setting when it is turned. This folds a patch into the frame the client
// already holds. Kept free of the DOM so the Companion module carries an
// identical copy (companion-module-cambridge/src/patch.js) and the two cannot
// drift apart unnoticed — both are tested against the same cases.
//
// Cameras that changed are replaced with new objects rather than mutated, so
// a renderer can tell what changed by identity alone.

/** Per-camera fields a patch may carry, besides properties. */
const FIELDS = ['status', 'recordStartedAt', 'ptz', 'tally', 'capabilities', 'state', 'detail',
  'reconnectAttempts', 'label', 'group'];

/** Envelope fields every frame carries alongside the camera list. */
const ENVELOPE = ['alarms', 'alarmsByCamera', 'alarmSummary', 'roll', 'undo', 'skaarhoj'];

/**
 * @param {object} frame  the client's current full frame: { view: { cameras, … }, alarms, … }
 * @param {object} msg    a `patch` message
 * @returns {{frame: object, changed: Set<string>, resync: boolean}}
 *   `changed` lists cameras that changed; `resync` is true when the patch
 *   named a camera the client never saw, and the full state should be fetched.
 */
export function applyPatch(frame, msg) {
  const changed = new Set();
  let resync = false;
  const view = { ...frame.view, ...(msg.view ?? {}) };
  const cameras = [...(frame.view?.cameras ?? [])];
  const index = new Map(cameras.map((c, i) => [c.id, i]));

  for (const [id, p] of Object.entries(msg.cameras ?? {})) {
    const i = index.get(id);
    if (p.replace) {
      const { replace, ...cam } = p;
      if (i === undefined) { index.set(id, cameras.length); cameras.push(cam); } else cameras[i] = cam;
      changed.add(id);
      continue;
    }
    if (i === undefined) { resync = true; continue; }
    const cam = { ...cameras[i] };
    if (p.properties) {
      cam.properties = p.replaceProperties ? p.properties : { ...cam.properties, ...p.properties };
    }
    for (const k of FIELDS) if (k in p) cam[k] = p[k];
    cameras[i] = cam;
    changed.add(id);
  }

  view.cameras = cameras;
  const next = { ...frame, view };
  for (const k of ENVELOPE) if (k in msg) next[k] = msg[k];
  return { frame: next, changed, resync };
}
