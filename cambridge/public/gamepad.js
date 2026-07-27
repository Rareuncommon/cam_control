'use strict';
// Gamepad control.
//
// A cheap USB gamepad is the closest thing to a real CCU panel a church budget
// usually reaches, and a thumbstick beats tapping a stepper for the slow iris
// ride through a song.
//
// Two rules shape everything here:
//
//  1. Analogue sticks are continuous, cameras are not. A stick held off-centre
//     produces a *rate*, and this converts that rate into discrete steps at a
//     sensible cadence. Sending on every animation frame would flood the camera
//     with writes it has to acknowledge one at a time.
//
//  2. Nothing happens until the operator opts in. A gamepad plugged in for a
//     different purpose must never move a camera, so control stays off until it
//     is switched on, and the selected camera is explicit.

const DEADZONE = 0.22;
// Gap between steps at full and at barely-past-the-deadzone deflection.
// Full deflection is ~5 steps a second: enough to cross the iris range in a
// couple of seconds, slow enough that a nudge does not overshoot several stops
// before the operator can let go.
const FAST_MS = 190;
const SLOW_MS = 700;

export function createGamepadControl({ onStep, onButton, onStatus }) {
  let enabled = false;
  let rafHandle = null;
  const nextDue = new Map();      // axis key -> timestamp
  const wasPressed = new Map();   // button index -> boolean
  let lastPadName = '';

  // Axis → what it drives. Left stick is exposure, right stick is focus and
  // colour, which keeps the two hands doing unrelated jobs.
  //
  // `axisInvert` is only about the *stick*: a browser reports a Y axis as
  // negative when pushed up, so Y axes need flipping to turn a reading into
  // "the operator pushed up". What "up" then means for a given property — for
  // iris, a lower f-number — is decided in the panel, next to the same rule the
  // on-screen steppers use. Folding both flips into one flag is how the iris
  // ends up moving the wrong way.
  const AXES = [
    { axis: 1, prop: 'fNumber', axisInvert: true, label: 'Iris' },
    { axis: 0, prop: 'colorTemp', axisInvert: false, label: 'Kelvin', coarse: 1 },
    { axis: 3, prop: 'focusPosition', axisInvert: true, label: 'Focus', coarse: 4 },
    { axis: 2, prop: 'isoSensitivity', axisInvert: false, label: 'ISO' },
  ];

  // Button → action. Indices follow the "standard" gamepad mapping, which is
  // what a browser reports for essentially every modern controller.
  const BUTTONS = {
    0: { action: 'recordToggle', label: 'Record' },      // A / cross
    1: { action: 'autofocus', label: 'AF' },             // B / circle
    2: { action: 'prevCamera', label: 'Previous camera' },
    3: { action: 'nextCamera', label: 'Next camera' },
    4: { action: 'prevCamera', label: 'Previous camera' },
    5: { action: 'nextCamera', label: 'Next camera' },
    9: { action: 'recordAll', label: 'Record all' },     // start
  };

  function pad() {
    // getGamepads() returns a live snapshot; entries may be null as pads come
    // and go, and the array is not a real Array on some browsers.
    for (const p of navigator.getGamepads?.() ?? []) if (p?.connected) return p;
    return null;
  }

  function poll(now) {
    rafHandle = requestAnimationFrame(poll);
    const p = pad();
    if (!p) {
      if (lastPadName) { lastPadName = ''; onStatus({ connected: false, name: '' }); }
      return;
    }
    if (p.id !== lastPadName) {
      lastPadName = p.id;
      onStatus({ connected: true, name: p.id });
    }
    if (!enabled) return;

    for (const spec of AXES) {
      const raw = p.axes[spec.axis] ?? 0;
      const magnitude = Math.abs(raw);
      if (magnitude < DEADZONE) { nextDue.delete(spec.axis); continue; }

      // Rescale past the deadzone so the first responsive position is a slow
      // crawl rather than an immediate jump to full speed.
      const scaled = (magnitude - DEADZONE) / (1 - DEADZONE);
      const gap = SLOW_MS - (SLOW_MS - FAST_MS) * scaled;
      const due = nextDue.get(spec.axis) ?? 0;
      if (now < due) continue;
      nextDue.set(spec.axis, now + gap);

      // Emit operator intent: +1 means the stick went up or right, whatever that
      // turns out to mean for the property being driven.
      const intent = (raw > 0 ? 1 : -1) * (spec.axisInvert ? -1 : 1);
      onStep(spec.prop, intent, spec.coarse ?? 1, spec.label);
    }

    for (const [index, spec] of Object.entries(BUTTONS)) {
      const pressed = !!p.buttons[index]?.pressed;
      const before = wasPressed.get(index) ?? false;
      wasPressed.set(index, pressed);
      // Edge-triggered: a held record button must not toggle every frame.
      if (pressed && !before) onButton(spec.action, spec.label);
    }
  }

  return {
    get enabled() { return enabled; },
    setEnabled(value) {
      enabled = !!value;
      if (!enabled) nextDue.clear();
    },
    start() {
      if (rafHandle === null) rafHandle = requestAnimationFrame(poll);
    },
    stop() {
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      rafHandle = null;
    },
    mapping: { AXES, BUTTONS },
  };
}
