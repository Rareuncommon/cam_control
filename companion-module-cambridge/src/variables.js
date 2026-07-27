// Companion variables.
//
// Values are the *labels* CamBridge already computes ("f/4.0", "1/50", "5600K"),
// not raw SDK integers. A button that reads $(cambridge:wide_iris) should show
// what the camera's own screen shows; nobody wants to see 400 and translate.
// Raw values are still available with a _raw suffix for expressions that need
// to do arithmetic.

const PER_CAMERA = [
  ['label', 'Name'],
  ['model', 'Model'],
  ['state', 'Connection state'],
  ['recording', 'Recording (REC / idle / FAILED)'],
  ['iris', 'Iris'],
  ['iso', 'ISO'],
  ['shutter', 'Shutter'],
  ['kelvin', 'Colour temperature'],
  ['wb', 'White balance mode'],
  ['nd', 'ND filter'],
  ['battery', 'Battery %'],
  ['media', 'Media'],
  ['tally', 'Tally (PGM / PVW / off)'],
];

/** Companion variable ids must be simple; camera ids may contain hyphens. */
export function varId(cameraId) {
  return String(cameraId).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}

export function buildVariableDefinitions(cameras) {
  const defs = [
    { variableId: 'camera_count', name: 'Number of cameras' },
    { variableId: 'connected_count', name: 'Number of connected cameras' },
    { variableId: 'recording_count', name: 'Number of cameras recording' },
    { variableId: 'daemon', name: 'CamBridge daemon state' },
    { variableId: 'cameras_down', name: 'Names of cameras not connected' },
    { variableId: 'tally_program', name: 'Camera currently on program' },
  ];
  for (const cam of cameras) {
    const v = varId(cam.id);
    for (const [suffix, name] of PER_CAMERA) {
      defs.push({ variableId: `${v}_${suffix}`, name: `${cam.label || cam.id}: ${name}` });
    }
    // Raw companions for the numeric ones, for expressions.
    for (const suffix of ['iris', 'iso', 'shutter', 'kelvin', 'nd']) {
      defs.push({ variableId: `${v}_${suffix}_raw`, name: `${cam.label || cam.id}: ${suffix} (raw)` });
    }
  }
  return defs;
}

const label = (cam, prop) => cam.properties?.[prop]?.label ?? '';
const raw = (cam, prop) => {
  const value = cam.properties?.[prop]?.raw;
  return Number.isFinite(value) ? value : '';
};

export function buildVariableValues(cameras, { camdConnected = true } = {}) {
  const values = {
    camera_count: cameras.length,
    connected_count: cameras.filter((c) => c.state === 'connected').length,
    recording_count: cameras.filter((c) => c.status?.recording).length,
    daemon: camdConnected ? 'connected' : 'UNREACHABLE',
    cameras_down: cameras.filter((c) => c.state !== 'connected').map((c) => c.label || c.id).join(', '),
    tally_program: cameras.filter((c) => c.tally?.program).map((c) => c.label || c.id).join(', '),
  };

  for (const cam of cameras) {
    const v = varId(cam.id);
    const t = cam.tally;
    values[`${v}_label`] = cam.label ?? cam.id;
    values[`${v}_model`] = cam.model ?? '';
    values[`${v}_state`] = cam.state ?? 'unknown';
    values[`${v}_recording`] = cam.status?.recordingFailed ? 'FAILED'
      : cam.status?.recording ? 'REC' : 'idle';
    values[`${v}_iris`] = label(cam, 'fNumber');
    values[`${v}_iso`] = label(cam, 'isoSensitivity');
    values[`${v}_shutter`] = label(cam, 'shutterSpeed');
    values[`${v}_kelvin`] = label(cam, 'colorTemp');
    values[`${v}_wb`] = label(cam, 'whiteBalance');
    values[`${v}_nd`] = label(cam, 'ndValue') || label(cam, 'ndDensity');
    values[`${v}_battery`] = Number.isFinite(cam.status?.battery) && cam.status.battery >= 0
      ? `${cam.status.battery}%` : '—';
    values[`${v}_media`] = cam.status?.media ?? '';
    values[`${v}_tally`] = t?.program ? 'PGM' : t?.preview ? 'PVW' : 'off';

    values[`${v}_iris_raw`] = raw(cam, 'fNumber');
    values[`${v}_iso_raw`] = raw(cam, 'isoSensitivity');
    values[`${v}_shutter_raw`] = raw(cam, 'shutterSpeed');
    values[`${v}_kelvin_raw`] = raw(cam, 'colorTemp');
    values[`${v}_nd_raw`] = raw(cam, 'ndValue');
  }
  return values;
}
