// ATEM Link — the switcher's camera control, translated to Sony properties.
//
// An ATEM hardware panel, or the Camera page in ATEM Software Control, sends
// camera-control data for whatever input the operator is adjusting. This turns
// that into ordinary CamBridge property writes, so a shading engineer can work
// the Blackmagic panel they already own and drive FX3s and FX30s with it.
//
// Two things in here have very different standing, and conflating them is how
// this ends up writing plausible nonsense to a live camera:
//
// **The payload semantics are documented.** Blackmagic publishes the SDI Camera
// Control Protocol in the ATEM manuals: an 8-bit destination, command length,
// command id and reserved byte, then category, parameter, data type and
// operation, then values. Data type 128 is signed 5.11 fixed point, so a raw
// value divides by 2048. Aperture normalised is 0..1, gain is dB as a signed
// byte, manual white balance is two int16s (kelvin then tint), exposure is an
// int32 of microseconds. Those are quoted from the spec, not remembered.
//
// **The ATEM's wrapper around it is not.** How the switcher lays a CCdP block
// out around that payload is community-reverse-engineered and is NOT confirmed
// against the hardware in this studio. `WRAPPER` below is a hypothesis. It is
// why ATEM Link is off by default and why `logRaw` exists: point it at a real
// switcher, move one control at a time, read the hex, and correct this from
// what actually arrives rather than from what anyone believes.

import { nearestOption } from './normalise.js';

/** Blackmagic data types, from the published protocol table. */
export const TYPE = {
  VOID: 0,        // also boolean
  INT8: 1,
  INT16: 2,
  INT32: 3,
  INT64: 4,
  STRING: 5,
  FIXED16: 128,   // signed 5.11 fixed point
};

/** 5.11 fixed point: eleven fractional bits. */
export const FIXED16_SCALE = 2048;

/**
 * Byte offsets inside a CCdP payload.
 *
 * UNVERIFIED — see the file header. Kept as data rather than inlined so that
 * correcting it against a real capture is a one-line change here instead of a
 * rewrite of the parser.
 */
export const WRAPPER = {
  destination: 0,
  category: 1,
  parameter: 2,
  relative: 3,
  dataType: 4,
  elementCount: 7,
  values: 8,
};

/**
 * Decodes one CCdP block body.
 *
 * Returns the decoded fields *and* the raw bytes, always. The raw bytes are what
 * make the wrapper hypothesis checkable in the field: a decode that looks
 * sensible and a hex dump that disagrees is the whole reason this returns both.
 *
 * @param {Buffer} body the block payload, after the 8-byte command header
 */
export function decodeCCdP(body) {
  if (!body || body.length < WRAPPER.values) {
    return { ok: false, error: 'CCdP block too short', raw: hex(body) };
  }

  const dataType = body.readUInt8(WRAPPER.dataType);
  const count = Math.max(0, body.readUInt8(WRAPPER.elementCount));
  const values = readValues(body.subarray(WRAPPER.values), dataType, count);

  return {
    ok: true,
    destination: body.readUInt8(WRAPPER.destination),
    category: body.readUInt8(WRAPPER.category),
    parameter: body.readUInt8(WRAPPER.parameter),
    // Non-zero means the values are an offset from the current setting rather
    // than an absolute target. We refuse those rather than guessing — see
    // toCameraWrites.
    relative: body.readUInt8(WRAPPER.relative) !== 0,
    dataType,
    values,
    raw: hex(body),
  };
}

function readValues(buf, dataType, count) {
  const out = [];
  const take = (size, read) => {
    for (let i = 0; i < count && (i + 1) * size <= buf.length; i++) {
      out.push(read(i * size));
    }
  };
  switch (dataType) {
    case TYPE.VOID: break;
    case TYPE.INT8: take(1, (o) => buf.readInt8(o)); break;
    case TYPE.INT16: take(2, (o) => buf.readInt16BE(o)); break;
    case TYPE.INT32: take(4, (o) => buf.readInt32BE(o)); break;
    case TYPE.INT64: take(8, (o) => Number(buf.readBigInt64BE(o))); break;
    case TYPE.FIXED16: take(2, (o) => buf.readInt16BE(o) / FIXED16_SCALE); break;
    case TYPE.STRING: out.push(buf.toString('utf8').replace(/\0+$/, '')); break;
    default: break;
  }
  return out;
}

function hex(buf) {
  if (!buf?.length) return '';
  return Buffer.from(buf).toString('hex').replace(/(..)/g, '$1 ').trim();
}

// --- mapping to Sony properties ---------------------------------------------

/**
 * Normalised aperture (0..1) to a Sony f-number.
 *
 * Blackmagic's normalised aperture is linear in *aperture area*, not in
 * f-stops: 0.0 is the smallest opening and 1.0 the largest. Mapping it
 * linearly onto the f-number list would make the top half of the panel's
 * travel do almost nothing and the bottom half jump several stops. So the
 * position is converted through the body's own list by index, which keeps one
 * detent on the panel worth one step on the camera — what a shader expects.
 */
export function normalisedApertureToFNumber(normalised, prop) {
  const options = prop?.allowed;
  if (!Array.isArray(options) || options.length === 0) return null;
  const sorted = [...options].sort((a, b) => a - b);
  const n = Math.min(1, Math.max(0, normalised));
  // 1.0 = largest opening = smallest f-number, so the list is walked backwards.
  const index = Math.round((1 - n) * (sorted.length - 1));
  return sorted[index];
}

/** Sony ISO from a gain in dB, relative to the body's base sensitivity. */
export function gainDbToIso(db, prop, { base = 800 } = {}) {
  if (!Number.isFinite(db)) return null;
  const want = base * (10 ** (db / 20));
  return nearestOption(prop, Math.round(want));
}

/** Exposure in microseconds to Sony's packed numerator<<16 | denominator. */
export function exposureUsToShutter(microseconds, prop) {
  if (!Number.isFinite(microseconds) || microseconds <= 0) return null;
  const denominator = Math.round(1_000_000 / microseconds);
  const packed = (1 << 16) | Math.min(0xffff, Math.max(1, denominator));
  return nearestOption(prop, packed);
}

/**
 * What a decoded block should write to a camera.
 *
 * Returns a list rather than a single write because one block can carry several
 * values — manual white balance is kelvin and tint together.
 *
 * Anything not confidently mapped is returned as a `skipped` entry with the
 * reason, never as a guess. A wrong write to a camera that is on air is worse
 * than no write, and a silent no-op is worse than either, because it looks like
 * a broken panel rather than an unsupported control.
 */
export function toCameraWrites(decoded, camera) {
  if (!decoded?.ok) return { writes: [], skipped: [{ reason: decoded?.error ?? 'undecodable' }] };

  const props = camera?.properties ?? {};
  const writes = [];
  const skipped = [];
  const skip = (reason) => skipped.push({
    reason, category: decoded.category, parameter: decoded.parameter,
  });

  if (decoded.relative) {
    // Applying an offset needs the camera's current value, and the panel's
    // notion of a step is not the body's. Absolute is what the ATEM sends for
    // wheel and slider moves; relative shows up for trims we cannot honour
    // faithfully.
    skip('relative adjustments are not supported — the panel step is not the camera step');
    return { writes, skipped };
  }

  const v = decoded.values;
  const key = `${decoded.category}.${decoded.parameter}`;

  switch (key) {
    // --- lens ---
    case '0.1':
      writes.push({ action: 'autofocus' });
      break;

    case '0.0': {
      const prop = props.focusPosition;
      if (!prop?.writable) { skip('this lens does not report a focus position'); break; }
      const range = prop.range;
      if (!range) { skip('focus has no reported range'); break; }
      const n = Math.min(1, Math.max(0, v[0] ?? 0));
      writes.push({ prop: 'focusPosition', value: Math.round(range.min + n * (range.max - range.min)) });
      break;
    }

    case '0.3': {
      const prop = props.fNumber;
      if (!prop?.writable) { skip('iris is not writable — it is probably on Auto'); break; }
      const value = normalisedApertureToFNumber(v[0] ?? 0, prop);
      if (value === null) skip('this body reported no aperture list');
      else writes.push({ prop: 'fNumber', value });
      break;
    }

    case '0.8': {
      const prop = props.zoomPosition;
      if (!prop?.range) { skip('this lens does not report a zoom position'); break; }
      const n = Math.min(1, Math.max(0, v[0] ?? 0));
      writes.push({
        prop: 'zoomPosition',
        value: Math.round(prop.range.min + n * (prop.range.max - prop.range.min)),
      });
      break;
    }

    // --- video ---
    case '1.2': {
      const [kelvin, tint] = v;
      if (Number.isFinite(kelvin) && props.colorTemp?.writable) {
        writes.push({ prop: 'colorTemp', value: nearestOption(props.colorTemp, kelvin) });
      }
      if (Number.isFinite(tint) && props.wbTint?.writable) {
        writes.push({ prop: 'wbTint', value: nearestOption(props.wbTint, tint) });
      }
      if (!writes.length) skip('white balance is not writable on this body right now');
      break;
    }

    case '1.5': {
      const prop = props.shutterSpeed;
      if (!prop?.writable) { skip('shutter is not writable — it is probably on Auto'); break; }
      const value = exposureUsToShutter(v[0], prop);
      if (value === null) skip('exposure value out of range');
      else writes.push({ prop: 'shutterSpeed', value });
      break;
    }

    case '1.13': {
      const prop = props.isoSensitivity;
      if (!prop?.writable) { skip('ISO is not writable — it is probably on Auto'); break; }
      const value = gainDbToIso(v[0], prop);
      if (value === null) skip('could not map that gain to an ISO on this body');
      else writes.push({ prop: 'isoSensitivity', value });
      break;
    }

    case '1.14': {
      const prop = props.isoSensitivity;
      if (!prop?.writable) { skip('ISO is not writable — it is probably on Auto'); break; }
      writes.push({ prop: 'isoSensitivity', value: nearestOption(prop, v[0]) });
      break;
    }

    // Colour correction — lift, gamma, gain, saturation wheels.
    //
    // Deliberately not mapped. Blackmagic's model is a lift/gamma/gain colour
    // wheel per channel; Sony's Creative Look is a handful of scalar trims.
    // There is no faithful conversion, and an approximate one would move the
    // look of a camera that is on air in a way nobody asked for. Logged so the
    // operator learns the wheel does nothing rather than wondering why the
    // picture drifted.
    case '8.0': case '8.1': case '8.2': case '8.3': case '8.4':
      skip('colour correction wheels have no faithful Sony equivalent');
      break;

    default:
      skip('no mapping for this control');
  }

  return { writes, skipped };
}

/**
 * Which camera a destination number refers to.
 *
 * Uses the same `atem.mapping` the tally already consumes — one map, not two.
 * A studio that has told CamBridge which input each camera is plugged into has
 * already answered this question.
 */
export function cameraForDestination(mapping, destination) {
  for (const [cameraId, input] of Object.entries(mapping ?? {})) {
    if (Number(input) === Number(destination)) return cameraId;
  }
  return null;
}

/**
 * Coalesces bursts, per camera and property.
 *
 * A hardware wheel emits a flood — dozens of positions a second. Forwarding
 * each one queues SDK writes the camera acknowledges one at a time, and a
 * spinning wheel would wedge a camera worker exactly as the property-refresh
 * storm did earlier in this project. Only the newest value for a property is
 * worth sending: the ones behind it are already stale.
 */
export class WriteCoalescer {
  /**
   * @param {(cameraId: string, prop: string, value: number) => Promise<any>} flushFn
   * @param {number} intervalMs
   */
  constructor(flushFn, intervalMs = 120) {
    this.flushFn = flushFn;
    this.intervalMs = intervalMs;
    /** @type {Map<string, {cameraId: string, prop: string, value: number}>} */
    this.pending = new Map();
    this.timer = null;
  }

  submit(cameraId, prop, value) {
    this.pending.set(`${cameraId}|${prop}`, { cameraId, prop, value });
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  async flush() {
    this.timer = null;
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const { cameraId, prop, value } of batch) {
      await this.flushFn(cameraId, prop, value);
    }
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}
