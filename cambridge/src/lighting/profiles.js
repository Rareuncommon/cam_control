// Fixture profiles: what a fixture's DMX channels mean.
//
// A profile is data. A new kind of fixture is a new JSON file in profiles/ (or
// one added from the Lighting tab), not new code, as long as it is made of the
// channel types below. Lighting state is kept in physical units — intensity in
// percent, colour temperature in kelvin — and only becomes DMX here, through
// the profile, on its way to the wire.
//
// Channel types:
//   intensity  0–100 % onto the channel's DMX range (`dmx: [min, max]`, default
//              the full range)
//   cct        kelvin onto DMX through `curve`: [dmx, kelvin] points, DMX
//              ascending, kelvin strictly one way. Straight lines between the
//              points, so a measured, non-linear curve is just more points.
//   fixed      always sends `value` (a mode or strobe channel that must sit at
//              one setting)
// `size: 2` makes a channel 16-bit (coarse then fine). A fixture may have at
// most one intensity and one cct channel: that is what the state model holds.
// Colour (RGB and friends) is not a channel type yet; adding it means adding
// colour to the state model, which is code.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROFILE_DIR = new URL('./profiles/', import.meta.url);
export const CHANNEL_TYPES = ['intensity', 'cct', 'fixed'];

const max = (size) => (size === 2 ? 65535 : 255);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The profiles shipped with CamBridge. Read-only; a copy can be edited as a custom profile. */
export function builtInProfiles() {
  const out = [];
  for (const file of readdirSync(PROFILE_DIR).filter((f) => f.endsWith('.json')).sort()) {
    const p = JSON.parse(readFileSync(fileURLToPath(new URL(file, PROFILE_DIR)), 'utf8'));
    out.push({ ...p, builtIn: true });
  }
  return out;
}

/**
 * Checks a profile. Errors are returned, never fixed: a profile that silently
 * became something else would drive the lights somewhere nobody chose.
 *
 * @returns {string[]} problems, empty when the profile is usable
 */
export function validateProfile(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return ['a profile must be an object'];
  if (typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(p.id)) {
    errors.push('id must be 1–64 characters: lower-case letters, digits, "-", "_" or "."');
  }
  if (typeof p.name !== 'string' || !p.name.trim()) errors.push('a name is required');
  if (!Array.isArray(p.channels) || p.channels.length === 0) {
    errors.push('at least one channel is required');
    return errors;
  }
  const counts = { intensity: 0, cct: 0 };
  let footprint = 0;
  p.channels.forEach((c, i) => {
    const at = `channel ${i + 1}`;
    if (!CHANNEL_TYPES.includes(c?.type)) {
      errors.push(`${at}: type must be one of ${CHANNEL_TYPES.join(', ')}`);
      return;
    }
    const size = c.size ?? 1;
    if (size !== 1 && size !== 2) errors.push(`${at}: size must be 1 (8-bit) or 2 (16-bit)`);
    footprint += size === 2 ? 2 : 1;
    if (c.type in counts) counts[c.type] += 1;
    const top = max(size);
    if (c.type === 'intensity' && c.dmx !== undefined) {
      if (!Array.isArray(c.dmx) || c.dmx.length !== 2 || !c.dmx.every((v) => Number.isInteger(v) && v >= 0 && v <= top)
          || c.dmx[0] === c.dmx[1]) {
        errors.push(`${at}: dmx must be [min, max], two different whole numbers within 0–${top}`);
      }
    }
    if (c.type === 'cct') {
      const curve = c.curve;
      if (!Array.isArray(curve) || curve.length < 2) {
        errors.push(`${at}: curve needs at least two [dmx, kelvin] points`);
      } else {
        const okPoint = (pt) => Array.isArray(pt) && pt.length === 2 && Number.isInteger(pt[0])
          && pt[0] >= 0 && pt[0] <= top && Number.isFinite(pt[1]) && pt[1] >= 1000 && pt[1] <= 20000;
        if (!curve.every(okPoint)) {
          errors.push(`${at}: each curve point is [dmx 0–${top}, kelvin 1000–20000]`);
        } else {
          const dmxUp = curve.every((pt, k) => k === 0 || pt[0] > curve[k - 1][0]);
          const kUp = curve.every((pt, k) => k === 0 || pt[1] > curve[k - 1][1]);
          const kDown = curve.every((pt, k) => k === 0 || pt[1] < curve[k - 1][1]);
          if (!dmxUp) errors.push(`${at}: curve DMX values must rise point by point`);
          if (!kUp && !kDown) errors.push(`${at}: curve kelvin must rise (or fall) all the way, or one kelvin would have two DMX values`);
        }
      }
    }
    if (c.type === 'fixed' && !(Number.isInteger(c.value) && c.value >= 0 && c.value <= top)) {
      errors.push(`${at}: a fixed channel needs a value within 0–${top}`);
    }
  });
  if (counts.intensity > 1) errors.push('at most one intensity channel');
  if (counts.cct > 1) errors.push('at most one cct channel');
  if (footprint > 512) errors.push(`the footprint is ${footprint} channels; a universe has 512`);
  return errors;
}

/** How many DMX addresses a fixture with this profile takes. */
export function footprint(profile) {
  return profile.channels.reduce((n, c) => n + (c.size === 2 ? 2 : 1), 0);
}

/** The kelvin range a profile can produce, or null when it has no cct channel. */
export function kelvinRange(profile) {
  const c = profile.channels.find((ch) => ch.type === 'cct');
  if (!c) return null;
  const ks = c.curve.map((pt) => pt[1]);
  return { min: Math.min(...ks), max: Math.max(...ks) };
}

export function hasIntensity(profile) { return profile.channels.some((c) => c.type === 'intensity'); }
export function hasCct(profile) { return profile.channels.some((c) => c.type === 'cct'); }

/** Kelvin -> DMX through the curve; outside the curve, the nearest end. */
export function kelvinToDmx(channel, kelvin) {
  const curve = channel.curve;
  const rising = curve[curve.length - 1][1] > curve[0][1];
  const pts = rising ? curve : [...curve].reverse();   // kelvin ascending
  const k = clamp(kelvin, pts[0][1], pts[pts.length - 1][1]);
  for (let i = 1; i < pts.length; i++) {
    const [d0, k0] = pts[i - 1];
    const [d1, k1] = pts[i];
    if (k <= k1) return Math.round(d0 + ((k - k0) * (d1 - d0)) / (k1 - k0));
  }
  return pts[pts.length - 1][0];
}

/** DMX -> kelvin through the curve; outside it, the nearest end. */
export function dmxToKelvin(channel, dmx) {
  const curve = channel.curve;
  const d = clamp(dmx, curve[0][0], curve[curve.length - 1][0]);
  for (let i = 1; i < curve.length; i++) {
    const [d0, k0] = curve[i - 1];
    const [d1, k1] = curve[i];
    if (d <= d1) return k0 + ((d - d0) * (k1 - k0)) / (d1 - d0);
  }
  return curve[curve.length - 1][1];
}

function intensityToDmx(channel, pct) {
  const [lo, hi] = channel.dmx ?? [0, max(channel.size ?? 1)];
  return Math.round(lo + (clamp(pct, 0, 100) / 100) * (hi - lo));
}

function dmxToIntensity(channel, v) {
  const [lo, hi] = channel.dmx ?? [0, max(channel.size ?? 1)];
  return clamp(((v - lo) / (hi - lo)) * 100, 0, 100);
}

/**
 * One fixture's state as its DMX channels, in footprint order.
 * A value the fixture's state does not have (no CCT known yet) sends 0.
 *
 * @param {object} profile
 * @param {{intensity?: number, cct?: number}} state  percent, kelvin
 * @returns {number[]}
 */
export function encode(profile, state) {
  const out = [];
  for (const c of profile.channels) {
    let v = 0;
    if (c.type === 'intensity') v = intensityToDmx(c, state.intensity ?? 0);
    else if (c.type === 'cct') v = state.cct === undefined || state.cct === null ? 0 : kelvinToDmx(c, state.cct);
    else if (c.type === 'fixed') v = c.value;
    if (c.size === 2) out.push((v >> 8) & 0xff, v & 0xff);
    else out.push(v & 0xff);
  }
  return out;
}

/**
 * DMX channels back to state: for looks and scenes that were written down in
 * DMX (the Studio look, scenes imported from Companion).
 *
 * @param {object} profile
 * @param {number[]} values  footprint-ordered DMX values
 * @returns {{intensity?: number, cct?: number}}
 */
export function decode(profile, values) {
  const out = {};
  let at = 0;
  for (const c of profile.channels) {
    const v = c.size === 2 ? ((values[at] ?? 0) << 8) | (values[at + 1] ?? 0) : (values[at] ?? 0);
    at += c.size === 2 ? 2 : 1;
    if (c.type === 'intensity') out.intensity = dmxToIntensity(c, v);
    else if (c.type === 'cct') out.cct = dmxToKelvin(c, v);
  }
  return out;
}
