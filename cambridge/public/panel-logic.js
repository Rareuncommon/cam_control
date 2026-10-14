// Decisions the control panel makes, kept free of the DOM so they can be
// tested without a browser (test/panel.test.js). app.js applies them.
//
// Written for the 2026-09-23 audit: multiview tiles froze the camera state they
// were built with (CS1), a hidden preview never came back, Record all could
// report success for nothing, an off-list value stepped to an unrelated one,
// and a gamepad silently moved to another camera.

const drivable = (c) => c && c.state === 'connected' && !c.external;

/** Everything a multiview tile shows that can change while its feed runs. */
export function tileModel(cam) {
  const recording = cam?.status?.recording === true;
  const tally = cam?.tally?.program ? ' pgm' : cam?.tally?.preview ? ' pvw' : '';
  const blocked = cam?.capabilities?.record?.available === false;
  return {
    recording,
    className: `feed${recording ? ' recording' : ''}${tally}`,
    label: cam?.label || cam?.id || '',
    fNumber: cam?.properties?.fNumber?.label ?? '',
    recordButton: {
      action: recording ? 'recordStop' : 'recordStart',
      text: recording ? '■' : '●',
      danger: !recording,
      disabled: blocked,
      title: blocked ? (cam.capabilities.record.reason || 'Recording is not available') : (recording ? 'Stop recording' : 'Start recording'),
    },
  };
}

/**
 * The record command for a camera as it is NOW, not as it was when its tile
 * was drawn. Null when there is no connected camera to command.
 */
export function recordActionFor(cameraId, getCameras) {
  const cam = getCameras().find((c) => c.id === cameraId);
  if (!cam || cam.state !== 'connected') return null;
  return cam.status?.recording === true ? 'recordStop' : 'recordStart';
}

/**
 * Tracks a live view's health. fail() answers 'hide' once, on the
 * `threshold`th consecutive failure; ok() answers 'show' on the first good
 * frame after that, so a feed that recovers is shown again without a manual
 * Restart feeds.
 */
export function feedHealth(threshold = 10) {
  let failures = 0;
  let hidden = false;
  return {
    fail() {
      failures += 1;
      if (!hidden && failures >= threshold) { hidden = true; return 'hide'; }
      return null;
    },
    ok() {
      failures = 0;
      if (hidden) { hidden = false; return 'show'; }
      return null;
    },
    get hidden() { return hidden; },
  };
}

/**
 * What to tell the operator after Record all / Stop all. Success needs a
 * successful response AND at least one camera AND every camera confirming;
 * an empty result or a top-level failure is never "all recording".
 */
export function recordAllOutcome(r, start) {
  const verb = start ? 'Record' : 'Stop';
  const results = Array.isArray(r?.results) ? r.results : [];
  const bad = results.filter((x) => !x.ok);
  if (bad.length) {
    return { level: 'bad', message: `${verb} FAILED on: ${bad.map((b) => b.cameraId).join(', ')}` };
  }
  if (r?.httpOk === false || r?.ok !== true) {
    return { level: 'bad', message: `${verb} all failed${r?.error ? `: ${r.error}` : ''}` };
  }
  if (!results.length) {
    return { level: 'bad', message: start ? 'No camera can record right now; nothing was started' : 'No camera to stop' };
  }
  const n = results.length;
  return { level: 'ok', message: `${n} camera${n === 1 ? '' : 's'} ${start ? 'recording' : 'stopped'}` };
}

/**
 * One step along a property's own list. Refuses (null) when the current value
 * is not on the list, matching the gamepad and Companion: stepping from an
 * unknown value used to start from the first entry, an unrelated setting.
 */
export function stepOption(options, currentRaw, step) {
  const idx = options.findIndex((o) => o.raw === currentRaw);
  if (idx < 0) return null;
  const next = options[idx + step];
  return next && next.raw !== currentRaw ? next : null;
}

/**
 * The camera a gamepad drives: the one the operator chose, while it is
 * connected. Losing it drives nothing until the operator chooses again; it no
 * longer falls through to the first connected body.
 */
export function gamepadTarget(chosenId, cameras) {
  if (!chosenId) return null;
  const cam = cameras.find((c) => c.id === chosenId);
  return drivable(cam) ? cam : null;
}

/** Cameras a gamepad may be pointed at. */
export const gamepadCandidates = (cameras) => cameras.filter(drivable);
