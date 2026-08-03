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
  ['card', 'Card time remaining'],
  ['alarm', 'Worst alarm, or empty'],
  ['rectime', 'Elapsed record time'],
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
    { variableId: 'rolling', name: 'Rolling count, e.g. "2 of 3"' },
    { variableId: 'alarm_count', name: 'Number of active alarms' },
    { variableId: 'alarm', name: 'Worst active alarm, or empty' },
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

/** "12:04", or "—" when the camera does not report the figure. */
function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(s % 60)}` : `${mm}:${pad(s % 60)}`;
}

export function buildVariableValues(cameras, {
  camdConnected = true, alarmsByCamera = {}, alarms = [], roll = null, now = Date.now(),
} = {}) {
  const connected = cameras.filter((c) => c.state === 'connected').length;
  const values = {
    camera_count: cameras.length,
    connected_count: connected,
    recording_count: cameras.filter((c) => c.status?.recording).length,
    daemon: camdConnected ? 'connected' : 'UNREACHABLE',
    cameras_down: cameras.filter((c) => c.state !== 'connected').map((c) => c.label || c.id).join(', '),
    tally_program: cameras.filter((c) => c.tally?.program).map((c) => c.label || c.id).join(', '),
    rolling: roll ? `${roll.rolling} of ${roll.total}` : `0 of ${connected}`,
    alarm_count: alarms.length,
    // Alarms arrive most severe first, so the head is the one to show.
    alarm: alarms.length ? `${alarms[0].label} ${alarms[0].message}` : '',
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
    values[`${v}_card`] = clock(cam.status?.mediaSlot1Sec);
    values[`${v}_rectime`] = cam.recordStartedAt
      ? clock((now - cam.recordStartedAt) / 1000) : '';
    const worst = (alarmsByCamera?.[cam.id] ?? [])[0];
    values[`${v}_alarm`] = worst ? worst.message : '';
    values[`${v}_tally`] = t?.program ? 'PGM' : t?.preview ? 'PVW' : 'off';

    values[`${v}_iris_raw`] = raw(cam, 'fNumber');
    values[`${v}_iso_raw`] = raw(cam, 'isoSensitivity');
    values[`${v}_shutter_raw`] = raw(cam, 'shutterSpeed');
    values[`${v}_kelvin_raw`] = raw(cam, 'colorTemp');
    values[`${v}_nd_raw`] = raw(cam, 'ndValue');
  }
  return values;
}
