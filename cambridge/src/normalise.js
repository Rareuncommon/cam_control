// Raw SDK value <-> human value translation.
//
// This is the layer the daemon deliberately refuses to do. camd reports exactly
// what the camera said; everything here interprets those numbers so a person can
// compare an FX3 against an FX30 without doing hex arithmetic in their head.
//
// Encodings marked CONFIRM are read from Sony's own RemoteCli parsing and the SDK
// headers, but have not yet been checked against a value seen on our hardware.
// Each decoder is total: an unexpected value degrades to showing the raw number
// rather than throwing, because a UI that crashes on a surprising value is worse
// than one that shows something ugly.

/** f-number is carried x100: 400 -> f/4.0. */
export function fNumberToLabel(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return '—';
  const f = raw / 100;
  // Sony's own display drops the trailing zero below f/10 but not above.
  return `f/${f < 10 ? f.toFixed(1) : f.toFixed(0)}`;
}

export function fNumberToStops(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  // log2 of the aperture ratio, so gang offsets can be expressed in stops rather
  // than in raw SDK steps that mean different things at different apertures.
  return Math.log2(raw / 100) * 2;
}

/**
 * ISO packs a mode in the top byte and the value in the low 24 bits.
 * CONFIRM: mode bit meanings beyond "non-zero implies an auto variant".
 */
export function isoToLabel(raw) {
  if (!Number.isFinite(raw)) return '—';
  const value = raw & 0x00ffffff;
  const mode = (raw >>> 24) & 0xff;
  if (value === 0) return 'ISO AUTO';
  return mode === 0 ? `ISO ${value}` : `ISO ${value} (auto)`;
}

export function isoValue(raw) {
  if (!Number.isFinite(raw)) return null;
  const v = raw & 0x00ffffff;
  return v === 0 ? null : v;
}

/** Shutter is numerator<<16 | denominator: 0x00010032 -> 1/50. */
export function shutterToLabel(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return '—';
  const num = raw >>> 16;
  const den = raw & 0xffff;
  if (den === 0) return String(raw);
  if (num === 0) return '—';
  if (den === 1) return `${num}"`;
  if (num === 1) return `1/${den}`;
  // Odd ratios do occur (some cine bodies report 2/50 style values).
  return `${num}/${den}`;
}

export function shutterSeconds(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const num = raw >>> 16;
  const den = raw & 0xffff;
  if (!num || !den) return null;
  return num / den;
}

export function colorTempToLabel(raw) {
  return Number.isFinite(raw) && raw > 0 ? `${raw}K` : '—';
}

export function tintToLabel(raw) {
  if (!Number.isFinite(raw)) return '—';
  if (raw === 0) return '0';
  return raw > 0 ? `+${raw}` : String(raw);
}

// CrWhiteBalanceSetting, CrDeviceProperty.h:1116. Verified against an FX30,
// which reports [17-20, 33-36, 256-259] and sits on 256 (Colour Temp.).
const WB_PRESETS = {
  0x0000: 'Auto',
  0x0001: 'Underwater Auto',
  0x0011: 'Daylight',
  0x0012: 'Shade',
  0x0013: 'Cloudy',
  0x0014: 'Tungsten',
  0x0020: 'Fluorescent',
  0x0021: 'Fluor. Warm White',
  0x0022: 'Fluor. Cool White',
  0x0023: 'Fluor. Day White',
  0x0024: 'Fluor. Daylight',
  0x0030: 'Flash',
  0x0100: 'Colour Temp.',
  0x0101: 'Custom 1',
  0x0102: 'Custom 2',
  0x0103: 'Custom 3',
  0x0104: 'Custom',
};
export function whiteBalanceToLabel(raw) {
  return WB_PRESETS[raw] ?? `WB ${raw}`;
}

// CrFocusMode, CrDeviceProperty.h:1138. One-indexed — an earlier zero-indexed
// guess mislabelled every mode by one.
const FOCUS_MODES = {
  0x0001: 'MF', 0x0002: 'AF-S', 0x0003: 'AF-C',
  0x0004: 'AF-A', 0x0005: 'AF-D', 0x0006: 'DMF', 0x0007: 'PF',
};
export function focusModeToLabel(raw) {
  return FOCUS_MODES[raw] ?? `Focus ${raw}`;
}

// CrExposureProgram, CrDeviceProperty.h:1018. The movie modes live at 0x8050+,
// which is where an FX30 actually sits — it shipped to us on 0x8055, Movie
// Flexible Exposure.
const EXPOSURE_MODES = {
  0x0001: 'M', 0x0002: 'P', 0x0003: 'A', 0x0004: 'S',
  0x8000: 'Auto',
  0x8050: 'Movie P', 0x8051: 'Movie A', 0x8052: 'Movie S',
  0x8053: 'Movie M', 0x8054: 'Movie Auto', 0x8055: 'Movie Flexible',
  0x8059: 'S&Q P', 0x805a: 'S&Q A', 0x805b: 'S&Q S',
  0x805c: 'S&Q M', 0x805d: 'S&Q Auto', 0x805e: 'S&Q Flexible',
};
export function exposureModeToLabel(raw) {
  return EXPOSURE_MODES[raw] ?? `Mode 0x${(raw >>> 0).toString(16)}`;
}

// Flexible Exposure Mode's per-parameter auto/manual switches.
// CrIrisModeSetting / CrShutterModeSetting / CrGainControlSetting, all 1=Auto,
// 2=Manual (CrDeviceProperty.h:2158+).
const AUTO_MANUAL = { 0x01: 'Auto', 0x02: 'Manual' };
export function autoManualToLabel(raw) {
  return AUTO_MANUAL[raw] ?? `Mode ${raw}`;
}

// CrExposureCtrlType, CrDeviceProperty.h:2172.
const EXPOSURE_CTRL_TYPE = { 0x01: 'P/A/S/M', 0x02: 'Flexible Exposure' };
export function exposureCtrlTypeToLabel(raw) {
  return EXPOSURE_CTRL_TYPE[raw] ?? `Type ${raw}`;
}

export const AUTO = 0x01;
export const MANUAL = 0x02;

/**
 * Explains why an exposure control is read-only, when the reason is recoverable.
 *
 * On an FX30 in Flexible Exposure mode, iris and gain default to Automatic, and
 * the SDK then reports fNumber and isoSensitivity as read-only with no value
 * list at all. That is indistinguishable from "this camera cannot do it" unless
 * you know to look at irisMode and gainMode — so the UI says so, and offers the
 * switch, rather than just greying out a control.
 */
export function readOnlyReason(propName, properties) {
  const gate = { fNumber: 'irisMode', isoSensitivity: 'gainMode', shutterSpeed: 'shutterMode' }[propName];
  if (!gate) return null;
  const gateProp = properties?.[gate];
  if (!gateProp || gateProp.raw !== AUTO) return null;
  const what = { irisMode: 'Iris', gainMode: 'Gain/ISO', shutterMode: 'Shutter' }[gate];
  return { gate, message: `${what} is set to Auto on the camera`, fixTo: MANUAL };
}

export const RECORDING_STATE = {
  NOT_RECORDING: 0x0000,
  RECORDING: 0x0001,
  FAILED: 0x0002,
  INTERVAL_WAITING: 0x0003,
};

export function recordingStateToLabel(raw) {
  switch (raw) {
    case RECORDING_STATE.NOT_RECORDING: return 'idle';
    case RECORDING_STATE.RECORDING: return 'recording';
    case RECORDING_STATE.FAILED: return 'FAILED';
    case RECORDING_STATE.INTERVAL_WAITING: return 'waiting';
    default: return 'unknown';
  }
}

/** Per-property label dispatch, keyed by camd's canonical property names. */
const LABELLERS = {
  fNumber: fNumberToLabel,
  isoSensitivity: isoToLabel,
  shutterSpeed: shutterToLabel,
  colorTemp: colorTempToLabel,
  wbTint: tintToLabel,
  whiteBalance: whiteBalanceToLabel,
  focusMode: focusModeToLabel,
  exposureMode: exposureModeToLabel,
  exposureCtrlType: exposureCtrlTypeToLabel,
  irisMode: autoManualToLabel,
  shutterMode: autoManualToLabel,
  gainMode: autoManualToLabel,
  recordingState: recordingStateToLabel,
  batteryLevel: (raw) => (Number.isFinite(raw) && raw >= 0 ? `${raw}%` : '—'),
};

export function label(propName, raw) {
  const fn = LABELLERS[propName];
  if (!fn) return raw === null || raw === undefined ? '—' : String(raw);
  return fn(raw);
}

/**
 * Decorates a camd properties object with labels and sorted option lists,
 * without discarding the raw values — the UI needs both, and any write must send
 * the raw value back untouched.
 */
export function decorate(propName, prop) {
  if (!prop) return null;
  const out = {
    raw: prop.value,
    label: label(propName, prop.value),
    writable: !!prop.writable,
  };
  if (Array.isArray(prop.allowed) && prop.allowed.length > 0) {
    out.options = prop.allowed
      .slice()
      .sort((a, b) => a - b)
      .map((raw) => ({ raw, label: label(propName, raw) }));
  }
  if (prop.range) out.range = prop.range;
  return out;
}

/**
 * Whether two bodies can meaningfully share a raw value for this property.
 *
 * The FX30 is Super 35 and the FX3 full-frame, so their ISO lists differ; copying
 * a raw ISO from one to the other can land on a value the target does not offer.
 * Match and gang use this to decide between copying raw and copying by label.
 */
export function sharesRawScale(propName) {
  // Aperture, temperature and tint are absolute physical quantities; ISO lists are
  // per-sensor and shutter is expressed identically but limited per frame rate.
  return ['fNumber', 'colorTemp', 'wbTint', 'whiteBalance', 'exposureMode'].includes(propName);
}

/**
 * Nearest legal option to a desired raw value, or null when nothing fits.
 *
 * Exact ties resolve to the lower value. That is arbitrary but deliberate: it has
 * to be deterministic, because gang and match both depend on the same input
 * producing the same output on every camera and every run.
 */
export function nearestOption(prop, wantRaw) {
  if (!prop) return null;
  if (Array.isArray(prop.allowed) && prop.allowed.length > 0) {
    let best = null;
    let bestDist = Infinity;
    for (const v of [...prop.allowed].sort((a, b) => a - b)) {
      const d = Math.abs(v - wantRaw);
      if (d < bestDist) { bestDist = d; best = v; }
    }
    return best;
  }
  if (prop.range) {
    const { min, max, step } = prop.range;
    let v = Math.min(Math.max(wantRaw, min), max);
    if (step > 1) v = min + Math.round((v - min) / step) * step;
    return v;
  }
  return wantRaw;
}
