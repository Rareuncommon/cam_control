// Working out "one stop up from here".
//
// This mirrors the stepper in the web panel deliberately: a Stream Deck button
// and the on-screen − / + must move a camera by the same amount, or the two
// controls disagree about what "one stop" means and an operator using both
// loses track of where the camera is.

/** Properties worth putting on a button, in the order an operator reaches for them. */
export const STEPPABLE = [
  { id: 'fNumber', label: 'Iris', invert: true },
  { id: 'isoSensitivity', label: 'ISO' },
  { id: 'shutterSpeed', label: 'Shutter' },
  { id: 'ndValue', label: 'ND filter', coarse: 5 },
  { id: 'colorTemp', label: 'Colour temperature (K)' },
  { id: 'wbTint', label: 'WB tint' },
  { id: 'contrast', label: 'Contrast' },
  { id: 'saturation', label: 'Saturation' },
  { id: 'sharpness', label: 'Sharpness' },
];

const SPEC = new Map(STEPPABLE.map((p) => [p.id, p]));

/**
 * The next raw value, `steps` away from where the property is now.
 *
 * Returns null when there is nowhere to go — already at the end of the list, or
 * the property is not something this camera exposes. Callers treat null as "do
 * nothing", which is what should happen when an operator holds down Iris Close
 * on a lens already wide open.
 *
 * `direction` is in operator terms, not raw terms: for iris, up means *more
 * light*, so it walks down the f-number list. That inversion is the whole reason
 * this is a shared function rather than inline arithmetic in two places.
 */
export function nextValue(prop, propName, direction, steps = 1) {
  if (!prop || !prop.writable) return null;
  const spec = SPEC.get(propName);
  const signed = (spec?.invert ? -direction : direction) * Math.max(1, steps);

  const options = prop.options?.length
    ? prop.options.map((o) => o.raw)
    : (prop.allowed ?? null);

  if (options?.length) {
    const current = prop.raw ?? prop.value;
    const idx = options.indexOf(current);
    // An unknown current value means the camera is reporting something outside
    // its own advertised list. Stepping from a guessed index would jump wildly,
    // so refuse rather than move the camera somewhere unintended.
    if (idx < 0) return null;
    const wanted = idx + signed;
    if (wanted < 0 || wanted > options.length - 1) return null;
    const next = options[wanted];
    return next === current ? null : next;
  }

  if (prop.range) {
    const current = prop.raw ?? prop.value;
    if (!Number.isFinite(current)) return null;
    const size = (prop.range.step || 1) * (spec?.coarse ?? 1);
    const next = Math.min(Math.max(current + signed * size, prop.range.min), prop.range.max);
    return next === current ? null : next;
  }

  return null;
}

/** The nearest legal value to `wanted`, for setting an exact figure from a button. */
export function snap(prop, wanted) {
  if (!prop) return wanted;
  const options = prop.options?.length
    ? prop.options.map((o) => o.raw)
    : (prop.allowed ?? null);
  if (options?.length) {
    let best = options[0];
    let bestGap = Math.abs(options[0] - wanted);
    for (const o of options) {
      const gap = Math.abs(o - wanted);
      // Strictly-less keeps the tie-break deterministic and biased low, matching
      // nearestOption in the cambridge server.
      if (gap < bestGap) { best = o; bestGap = gap; }
    }
    return best;
  }
  if (prop.range) {
    const { min, max, step } = prop.range;
    const clamped = Math.min(Math.max(wanted, min), max);
    if (!step || step <= 1) return Math.round(clamped);
    return min + Math.round((clamped - min) / step) * step;
  }
  return wanted;
}
