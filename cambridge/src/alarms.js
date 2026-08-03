// Shoot alarms — the things that lose a take.
//
// Deliberately a pure function over a state snapshot: no timers, no sockets, no
// camera. Everything here is decided from values the mirror already holds, which
// means the whole set can be tested against a handful of literals, and means an
// alarm cannot be produced by anything except the state the operator can see.
//
// Two rules shape the whole file:
//
//   1. **Never alarm on a value we do not have.** Every unreported figure is -1,
//      not zero. A camera that does not report battery must not read as a flat
//      battery, and a card whose remaining time is unknown must not read as a
//      full one. Guarding on `>= 0` at every entry point is the difference
//      between a warning system and a liar.
//
//   2. **Never alarm on a disconnected camera's last known values.** The mirror
//      keeps `status` across an outage, so a body that dropped ten minutes ago
//      still carries the battery it had then. Reporting that as live is the same
//      mistake as showing a stale iris. A disconnected camera gets exactly one
//      alarm — that it is disconnected.

/**
 * Defaults chosen against how long it takes to *act*, not round numbers.
 *
 * Five minutes of card is roughly the time to notice, walk to a tripod, swap a
 * card and get back — so that is critical, not warning. Fifteen minutes is
 * enough to finish a segment and swap between takes, which is what a warning is
 * for. Battery is the same logic against a smaller margin, because a body on
 * mains does not report a falling percentage at all.
 */
export const DEFAULT_THRESHOLDS = {
  batteryWarnPct: 30,
  batteryCriticalPct: 15,
  mediaWarnSec: 15 * 60,
  mediaCriticalSec: 5 * 60,
};

export const LEVELS = { critical: 2, warn: 1 };

/** Recording state 0x0002 — the camera itself reporting the recording failed. */
const RECORDING_FAILED = 0x0002;

export function resolveThresholds(configured) {
  const t = { ...DEFAULT_THRESHOLDS, ...(configured ?? {}) };
  // A critical threshold above its warning threshold would mean the warning
  // never fires — the camera goes straight to critical and the operator loses
  // the early notice that was the entire point. Clamp rather than reject: a
  // config typo must not stop the daemon from starting before a shoot.
  if (t.batteryCriticalPct > t.batteryWarnPct) t.batteryCriticalPct = t.batteryWarnPct;
  if (t.mediaCriticalSec > t.mediaWarnSec) t.mediaCriticalSec = t.mediaWarnSec;
  return t;
}

/** "4 min", "1 h 12 min", "38 s" — short enough for a badge. */
export function humanDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function alarm(level, cam, code, message) {
  return { level, cameraId: cam.id, label: cam.label || cam.id, code, message };
}

/**
 * Alarms for one camera.
 *
 * @param {object} cam        a camera from StateModel
 * @param {object} thresholds already through resolveThresholds()
 */
export function evaluateCamera(cam, thresholds = DEFAULT_THRESHOLDS) {
  const out = [];
  if (!cam) return out;

  // Rule 2. An offline camera's stored battery and card figures are from before
  // the outage; reporting them would be inventing a present tense for them.
  if (cam.state !== 'connected') {
    out.push(alarm('critical', cam, 'offline',
      cam.detail ? `is offline — ${cam.detail}` : 'is offline'));
    return out;
  }

  const st = cam.status ?? {};

  if (st.recordingState === RECORDING_FAILED) {
    out.push(alarm('critical', cam, 'recordFailed',
      'reports Recording Failed — it is not recording'));
  }

  // Set by the state model when a camera leaves record without being asked to.
  // This is the alarm worth the whole file: everything else is a number crossing
  // a line, and this one is a take that is silently not being captured.
  if (st.recordDropped) {
    out.push(alarm('critical', cam, 'recordDropped',
      'stopped recording on its own — nobody pressed stop'));
  }

  // Rule 1, and the one place it was easy to get wrong. `mediaPresent` is a
  // plain boolean, so "this camera has no card" and "this camera never told us
  // about its card" arrive identically as false — and alarming on the second
  // would put a permanent "has no card" on any body that does not report media.
  //
  // So the number is the only thing trusted here. Below zero means unreported
  // and nothing is claimed; zero means the camera says it cannot record any
  // more, without guessing whether that is a full card or an empty slot.
  const media = st.mediaSlot1Sec;
  if (Number.isFinite(media) && media >= 0) {
    const rolling = !!st.recording;
    if (media === 0) {
      out.push(alarm('critical', cam, 'media',
        'has no recording time left — card full, or no card'));
    } else if (media <= thresholds.mediaCriticalSec) {
      // While rolling, the remaining time is being spent; idle, it is only a
      // forecast. Which one it is changes what the operator does about it.
      out.push(alarm('critical', cam, 'media',
        rolling
          ? `card has ${humanDuration(media)} left and is recording now`
          : `card has ${humanDuration(media)} left — swap it before the next take`));
    } else if (media <= thresholds.mediaWarnSec) {
      out.push(alarm('warn', cam, 'media', `card has ${humanDuration(media)} left`));
    }
  }

  const battery = st.battery;
  if (Number.isFinite(battery) && battery >= 0) {
    if (battery <= thresholds.batteryCriticalPct) {
      out.push(alarm('critical', cam, 'battery', `battery is at ${battery}%`));
    } else if (battery <= thresholds.batteryWarnPct) {
      out.push(alarm('warn', cam, 'battery', `battery is at ${battery}%`));
    }
  }

  return out;
}

/**
 * Alarms across every camera, most severe first, then by camera label so the
 * order on screen does not shuffle between pushes.
 */
export function evaluate(cameras, configured) {
  const thresholds = resolveThresholds(configured);
  const all = [];
  for (const cam of cameras ?? []) all.push(...evaluateCamera(cam, thresholds));
  all.sort((a, b) => {
    const bySeverity = (LEVELS[b.level] ?? 0) - (LEVELS[a.level] ?? 0);
    if (bySeverity !== 0) return bySeverity;
    return a.label.localeCompare(b.label) || a.code.localeCompare(b.code);
  });
  return all;
}

/**
 * One line for the banner.
 *
 * A banner listing six alarms is a banner nobody reads, so this names the worst
 * one in full and counts the rest. Returns null when there is nothing wrong,
 * which is the signal to hide the banner entirely rather than show "all clear" —
 * a permanent green bar trains people to stop looking at that strip of screen.
 */
export function summarise(alarms) {
  if (!alarms?.length) return null;
  const worst = alarms[0];
  const others = alarms.length - 1;
  return {
    level: worst.level,
    count: alarms.length,
    text: `${worst.label} ${worst.message}`
      + (others > 0 ? ` — and ${others} other ${others === 1 ? 'alarm' : 'alarms'}` : ''),
  };
}

/** Alarms grouped by camera id, for per-card badges. */
export function byCamera(alarms) {
  const out = {};
  for (const a of alarms ?? []) (out[a.cameraId] ??= []).push(a);
  return out;
}
