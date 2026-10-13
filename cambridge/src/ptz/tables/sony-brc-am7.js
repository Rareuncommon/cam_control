// Sony BRC-AM7 parameter table.
//
// Every row comes from the spec notes (scratchpad specs/sony-brc-am7.md),
// which cite Sony's own documents:
//   V-EN   VISCA Command List BRC-AM7, software 2.0, 5-066-065-12
//   C-EN   CGI Command List BRC-AM7, software 2.0, 5-066-066-12 (July 2025)
//   C-JP3  CGI Command List BRC-AM7, Japanese edition 5-066-066-03 (Feb 2026, newer)
//   HG     BRC-AM7 Help Guide 5-065-326-14
// Rows found only in C-JP3 (the Japanese 2026 edition, read for its ASCII
// tables only) carry `verify: true`, as do rows where C-EN and C-JP3 disagree.
//
// Almost everything is CGI, on purpose: VISCA on this camera is off until the
// rear SETUP switch 4 is on at power-on *and* an admin password is set
// (HG p.23), so a table that needed VISCA would be empty on most cameras as
// delivered. The few settings that exist only over VISCA (detail, knee,
// backlight, spotlight; notes §11.11) carry `requires: 'visca'` and are left
// out of the schema when VISCA is not answering.
//
// wire (private, read by drivers/sony-brc.js):
//   inq     inquiry group: GET /command/inquiry.cgi?inq=<inq>, reply Param=value&...
//   param   CGI parameter name, both for reading and writing
//   set     CGI to write with: 'imaging' -> /command/imaging.cgi; a leading '/'
//           is a full path (Auto Framing lives under /analytics/, C-EN p.23)
//   codec   { dec(string) -> value, enc(value) -> string }
//   index   the value is one field of a comma list (`v,h,size`); writes
//           read the list first and replace that field
//   prefix  fields written before the value and skipped when reading
//           (`PtzAutoFramingTrackingRangeEnable=1,on`: 1 is the range number)
//   visca   { inq: bytes, dec(reply) -> value, enc(value) -> bytes } — used
//           when VISCA answers (and the only path for VISCA-only rows)
//   act     for actions: 'press' (press then release, C-EN p.6), 'set'
//           (one value), or a driver-specific kind
//   local   values the driver knows itself (identity, VISCA availability)

import { toNibbles, nibbles } from '../visca-client.js';

// --- value codecs -------------------------------------------------------------

const ONOFF = { dec: (s) => s === 'on', enc: (v) => (v ? 'on' : 'off') };
const TURN = { dec: (s) => s === 'turn_on', enc: (v) => (v ? 'turn_on' : 'turn_off') };
const BIT = { dec: (s) => s === '1', enc: (v) => (v ? '1' : '0') };
const INT = { dec: (s) => Number.parseInt(s, 10), enc: (v) => String(Math.round(v)) };
const TOKEN = { dec: (s) => s, enc: (v) => String(v) };
const TEXT = { dec: (s) => s, enc: (v) => String(v) };
/** Wire value = value × k (R gain -990..990 is -99.0..99.0, C-EN p.35). */
const scaled = (k) => ({ dec: (s) => Number(s) / k, enc: (v) => String(Math.round(v * k)) });
/** Wire value = value + o (gain 9 = 0 dB, C-EN p.30). */
const offset = (o) => ({ dec: (s) => Number(s) - o, enc: (v) => String(Math.round(v + o)) });
/** AE level: wire 0..24 in quarter EV, 12 = ±0 (C-EN p.100). */
const QUARTER_EV = { dec: (s) => (Number(s) - 12) / 4, enc: (v) => String(Math.round(v * 4 + 12)) };
const HEX4 ={ dec: (s) => Number.parseInt(s, 16), enc: (v) => Math.round(v).toString(16).padStart(4, '0') };

// --- VISCA codecs (payloads without the 8-byte IP header) ---------------------

/** On/off as `0p`, 2 = on, 3 = off — the common VISCA shape. */
const viscaBool = (inq, set) => ({
  inq,
  dec: (r) => r[2] === 0x02,
  enc: (v) => [...set, v ? 0x02 : 0x03, 0xff],
});

// --- option lists -------------------------------------------------------------

const opts = (pairs) => pairs.map(([value, label]) => ({ value, label }));

// ExposureISO index -> ISO (C-EN p.98). Index 7 was not captured from the PDF
// (notes §10.3 iso), so it is not offered.
const ISO = [[8, 320], [9, 400], [10, 500], [11, 640], [12, 800], [13, 1000], [14, 1250], [15, 1600],
  [16, 2000], [17, 2500], [18, 3200], [19, 4000], [20, 5000], [21, 6400], [22, 8000], [23, 10000],
  [24, 12800], [25, 16000]];

// ExposureNDVariable 0..20 (C-EN p.99; V-EN p.25).
const ND = ['1/4', '1/5', '1/6', '1/7', '1/8', '1/10', '1/11', '1/13', '1/16', '1/19', '1/23', '1/27',
  '1/32', '1/38', '1/45', '1/54', '1/64', '1/76', '1/91', '1/108', '1/128'];

// ExposureAngle 1..29 (C-EN p.97, notes Appendix A).
const ANGLES = ['64F', '32F', '16F', '8F', '7F', '6F', '5F', '4F', '3F', '2F', '360.0°', '300.0°', '270.0°',
  '240.0°', '216.0°', '210.0°', '180.0°', '172.8°', '150.0°', '144.0°', '120.0°', '90.0°', '86.4°', '72.0°',
  '45.0°', '30.0°', '22.5°', '11.25°', '5.6°'];

// MonitoringOutputFormat (C-EN p.48, p.100): SDI1 / SDI2 / HDMI.
const OUTPUT_FORMATS = [
  ['s3840p_h3840p', '2160p / 1080p (A) / 2160p'],
  ['s3840p_h1920p', '2160p / 1080p / 1080p'],
  ['s3840p_h1920i', '2160p / – / 1080i'],
  ['s1920plva_h1920p', '1080p LvA / 1080p LvA / 1080p'],
  ['s1920plva_h1920i', '1080p LvA / – / 1080i'],
  ['s1920plvb_h1920p', '1080p LvB / 1080p LvA / 1080p'],
  ['s1920plvb_h1920i', '1080p LvB / – / 1080i'],
  ['s1920p_h1920p', '1080p / 1080p / 1080p'],
  ['s1920i_h1920i', '1080i / – / 1080i'],
  ['snone_h3840p', '– / 1080p / 2160p'],
  ['snone_h720p', '– / – / 480p or 576p'],
  ['s1920ipsf_h1920p', '1080PsF / 1080p / 1080p'],
  ['s1920ipsf_h1920i', '1080PsF / – / 1080i'],
  ['s1280p_h1280p', '720p / 720p / 720p'],
];

const AFR = '/analytics/ptzautoframing.cgi';
const AFR_EXE = '/analytics/ptzautoframingexe.cgi';
const IPV4 = '^(\\d{1,3})(\\.\\d{1,3}){3}$';
const RECT = '^\\d{1,5},\\d{1,5},\\d{1,5},\\d{1,5}$';

/** CGI setting read from `inq` and written to `set`. */
const cgi = (inq, param, codec, set = inq, extra = {}) => ({ inq, param, set, codec, ...extra });

export const TABLE = [
  // --- camera ---------------------------------------------------------------
  { id: 'powerState', group: 'camera', label: 'Power', type: 'enum', readOnly: true, poll: 'slow',
    options: opts([['on', 'On'], ['standby', 'Standby']]),
    wire: cgi('system', 'Power', TOKEN) },                                           // C-EN p.7
  { id: 'recFrequency', group: 'camera', label: 'System frequency', type: 'enum', danger: 'admin',
    help: 'Changes the video system; outputs and streams drop while it switches.',
    options: opts([['11988', '119.88'], ['10000', '100'], ['5994', '59.94'], ['5000', '50'],
      ['2997', '29.97'], ['2500', '25'], ['2398', '23.98']]),
    wire: cgi('project', 'RecFormatFrequency', TOKEN) },                             // C-EN p.41
  { id: 'recCodecCategory', group: 'camera', label: 'Codec category', type: 'enum',
    options: opts([['xavc', 'XAVC (MXF)'], ['xavc_s', 'XAVC S (MP4)']]),
    wire: cgi('project', 'RecFormatCodecCategory', TOKEN) },                         // C-EN p.42
  { id: 'recVideoQuality', group: 'camera', label: 'Recording quality', type: 'enum',
    options: opts([['high', 'High'], ['middle', 'Middle'], ['low', 'Low']]),
    wire: cgi('project', 'RecFormatVideoQuality', TOKEN) },                          // C-EN p.42
  { id: 'recSimul', group: 'camera', label: 'Simul Rec', type: 'bool',
    wire: cgi('project', 'SimulRecEnable', ONOFF) },                                 // C-EN p.43
  { id: 'recProxy', group: 'camera', label: 'Proxy rec', type: 'bool',
    wire: cgi('project', 'ProxyRecEnable', ONOFF) },                                 // C-EN p.43
  { id: 'recordingStatus', group: 'camera', label: 'Recording', type: 'enum', readOnly: true, poll: 'fast',
    options: opts([['standby', 'Standby'], ['rec', 'Recording']]),
    wire: cgi('cameraoperation', 'MediaRecordingStatus', TOKEN) },                   // C-EN p.36
  { id: 'recordButton', group: 'camera', label: 'Record start / stop', type: 'action', affects: ['recordingStatus'],
    wire: { act: 'press', set: 'cameraoperation', param: 'MediaRecording' } },       // C-EN p.36

  // --- exposure -------------------------------------------------------------
  { id: 'shootingMode', group: 'exposure', label: 'Shooting mode', type: 'enum',
    options: opts([['custom', 'Custom'], ['flexible_iso', 'Flexible ISO']]),
    wire: cgi('project', 'BaseSettingShootingMode', TOKEN) },                         // C-EN p.41
  { id: 'isoGainMode', group: 'exposure', label: 'ISO / gain', type: 'enum', readOnly: true,
    options: opts([['iso', 'ISO'], ['gain', 'Gain']]),
    wire: cgi('imaging', 'ExposureISOGainMode', TOKEN) },                            // C-EN p.30
  { id: 'gain', group: 'exposure', label: 'Gain', type: 'range', operate: true, role: 'gain',
    range: { min: -3, max: 36, step: 1, unit: ' dB' }, gate: { id: 'isoGainMode', value: 'gain' },
    help: 'Gain mode only.',
    wire: cgi('imaging', 'ExposureGain', offset(9)) },                               // C-EN p.30, p.99: 6=-3 dB, 9=0 dB, 45=36 dB
  { id: 'iso', group: 'exposure', label: 'ISO', type: 'enum', operate: true,
    options: ISO.map(([v, iso]) => ({ value: v, label: `ISO ${iso}` })), gate: { id: 'isoGainMode', value: 'iso' },
    wire: cgi('imaging', 'ExposureISO', INT) },                                      // C-EN p.30, p.98
  { id: 'agc', group: 'exposure', label: 'AGC', type: 'bool',
    wire: cgi('imaging', 'ExposureAGCEnable', ONOFF) },                              // C-EN p.33
  { id: 'autoIris', group: 'exposure', label: 'Auto iris', type: 'bool', operate: true, poll: 'fast',
    role: 'irisMode', autoValue: true, manualValue: false, affects: ['iris', 'fNumber'],
    wire: cgi('imaging', 'ExposureAutoIris', ONOFF) },                               // C-EN p.34; V-EN p.14
  { id: 'iris', group: 'exposure', label: 'Iris', type: 'range', operate: true, role: 'iris',
    range: { min: 30975, max: 32000, step: 1 }, gate: { id: 'autoIris', value: false }, affects: ['fNumber'],
    help: '32000 = F2.8, 30975 = F11; one step is 1/256 EV. The camera reads back in steps of 64.',
    wire: cgi('imaging', 'ExposureIris', INT) },                                     // C-EN p.33
  { id: 'fNumber', group: 'exposure', label: 'F-number', type: 'range', readOnly: true,
    range: { min: 2.8, max: 655.33, step: 0.01 }, help: '655.33 means the iris is closed.',
    wire: cgi('imaging', 'ExposureFNumber', scaled(100)) },                          // C-EN p.33 (F x100; 65533 = closed)
  { id: 'autoShutter', group: 'exposure', label: 'Auto shutter', type: 'bool', affects: ['shutterSpeed'],
    wire: cgi('imaging', 'ExposureAutoShutterEnable', ONOFF) },                      // C-EN p.34
  { id: 'shutterMode', group: 'exposure', label: 'Shutter mode', type: 'enum',
    options: opts([['speed', 'Speed'], ['angle', 'Angle']]),
    wire: cgi('imaging', 'ExposureShutterMode', TOKEN) },                            // C-EN p.31
  { id: 'shutterEnable', group: 'exposure', label: 'Shutter', type: 'bool',
    wire: cgi('imaging', 'ExposureShutterSpeedEnable', ONOFF) },                     // C-EN p.32
  { id: 'shutterSpeed', group: 'exposure', label: 'Shutter speed', type: 'range', operate: true, role: 'shutter',
    range: { min: 1, max: 25, step: 1 }, gate: { id: 'shutterMode', value: 'speed' },
    help: 'Index 1–25; what each step means depends on the frame rate (18 = 1/120, 20 = 1/250, 25 = 1/8000).',
    wire: cgi('imaging', 'ExposureExposureTime', INT) },                             // C-EN p.32, p.97
  { id: 'shutterAngle', group: 'exposure', label: 'Shutter angle', type: 'enum',
    options: ANGLES.map((label, i) => ({ value: i + 1, label })), gate: { id: 'shutterMode', value: 'angle' },
    wire: cgi('imaging', 'ExposureAngle', INT) },                                    // C-EN p.32, p.97
  { id: 'ecsEnable', group: 'exposure', label: 'ECS', type: 'bool',
    wire: cgi('imaging', 'ExposureECSEnable', ONOFF) },                              // C-EN p.32
  { id: 'ecs', group: 'exposure', label: 'ECS frequency', type: 'range',
    range: { min: 0, max: 1120, step: 1 }, gate: { id: 'ecsEnable', value: true },
    help: 'Index; the frequency it gives depends on the frame rate.',
    wire: cgi('imaging', 'ExposureECS', INT) },                                      // C-EN p.32, p.98
  { id: 'aeLevel', group: 'exposure', label: 'AE level', type: 'range', operate: true,
    range: { min: -3, max: 3, step: 0.25, unit: ' EV' },
    wire: cgi('imaging', 'ExposureCompensation', QUARTER_EV) },                      // C-EN p.33, p.100: 0=-3.0, 12=0, 24=+3.0
  { id: 'ndMode', group: 'exposure', label: 'ND filter mode', type: 'enum', readOnly: true,
    options: opts([['preset', 'Preset'], ['variable', 'Variable']]),
    wire: cgi('imaging', 'ExposureNDFilterMode', TOKEN) },                           // C-EN p.31 (inquiry only)
  { id: 'autoND', group: 'exposure', label: 'Auto ND', type: 'bool', affects: ['ndVariable'],
    wire: cgi('imaging', 'ExposureAutoNDFilterEnable', ONOFF) },                     // C-EN p.34
  { id: 'ndClear', group: 'exposure', label: 'ND clear', type: 'enum',
    options: opts([['filtered', 'ND on'], ['clear', 'Clear']]),
    wire: cgi('imaging', 'ExposureNDClear', TOKEN) },                                // C-EN p.31
  { id: 'ndPresetSelect', group: 'exposure', label: 'ND preset', type: 'enum', gate: { id: 'ndMode', value: 'preset' },
    options: opts([['clear', 'Clear'], ['nd1', 'ND 1'], ['nd2', 'ND 2'], ['nd3', 'ND 3']]),
    wire: cgi('imaging', 'ExposureNDPresetSelect', TOKEN) },                         // C-EN p.31
  { id: 'ndVariable', group: 'exposure', label: 'ND (variable)', type: 'enum', operate: true, role: 'nd',
    options: ND.map((label, i) => ({ value: i, label })), gate: { id: 'ndMode', value: 'variable' },
    wire: cgi('imaging', 'ExposureNDVariable', INT) },                               // C-EN p.31, p.99
  { id: 'colorBar', group: 'exposure', label: 'Colour bars', type: 'bool',
    help: 'PTZ Auto Framing cannot run while colour bars are on.',
    wire: cgi('camera', 'ColorBar', ONOFF) },                                        // C-EN p.73; HG p.171
  { id: 'backlight', group: 'exposure', label: 'Backlight compensation', type: 'bool', requires: 'visca',
    wire: { visca: viscaBool([0x81, 0x09, 0x04, 0x33, 0xff], [0x81, 0x01, 0x04, 0x33]) } }, // V-EN p.14, p.20
  { id: 'spotlight', group: 'exposure', label: 'Spotlight compensation', type: 'bool', requires: 'visca',
    wire: { visca: viscaBool([0x81, 0x09, 0x04, 0x3a, 0xff], [0x81, 0x01, 0x04, 0x3a]) } }, // V-EN p.14, p.20

  // --- white balance --------------------------------------------------------
  { id: 'wbMode', group: 'whiteBalance', label: 'White balance', type: 'enum', operate: true, poll: 'fast',
    role: 'whiteBalanceMode',
    options: opts([['atw', 'ATW'], ['memory_a', 'Memory A'], ['preset', 'Preset']]),
    affects: ['wbColorTemp', 'wbPreset'],
    wire: cgi('imaging', 'WhiteBalanceMode', TOKEN) },                               // C-EN p.34; V-EN p.15
  { id: 'wbSet', group: 'whiteBalance', label: 'WB set', type: 'action', operate: true,
    affects: ['wbColorTemp', 'wbTint', 'wbRGain', 'wbBGain'],
    wire: { act: 'press', set: 'imaging', param: 'WhiteBalanceWBSet' } },             // C-EN p.35
  { id: 'wbPreset', group: 'whiteBalance', label: 'Preset white', type: 'range',
    range: { min: 2000, max: 15000, step: 1, unit: 'K' }, gate: { id: 'wbMode', value: 'preset' },
    wire: cgi('imaging', 'WhiteBalancePreset', INT) },                               // C-EN p.34
  { id: 'wbColorTemp', group: 'whiteBalance', label: 'Colour temperature', type: 'range', operate: true,
    role: 'colorTemp', range: { min: 2000, max: 15000, step: 1, unit: 'K' }, gate: { id: 'wbMode', value: 'memory_a' },
    wire: cgi('imaging', 'WhiteBalanceColorTemp', INT) },                            // C-EN p.35
  { id: 'wbTint', group: 'whiteBalance', label: 'Tint', type: 'range',
    range: { min: -99, max: 99, step: 1 }, gate: { id: 'wbMode', value: 'memory_a' },
    wire: cgi('imaging', 'WhiteBalanceTint', INT) },                                 // C-EN p.35
  { id: 'wbRGain', group: 'whiteBalance', label: 'R gain', type: 'range',
    range: { min: -99, max: 99, step: 0.1 }, gate: { id: 'wbMode', value: 'memory_a' },
    wire: cgi('imaging', 'WhiteBalanceCrGain', scaled(10)) },                        // C-EN p.35 (x10)
  { id: 'wbBGain', group: 'whiteBalance', label: 'B gain', type: 'range',
    range: { min: -99, max: 99, step: 0.1 }, gate: { id: 'wbMode', value: 'memory_a' },
    wire: cgi('imaging', 'WhiteBalanceCbGain', scaled(10)) },                        // C-EN p.35 (x10)
  { id: 'wbOffsetColorTemp', group: 'whiteBalance', label: 'ATW offset (colour temp.)', type: 'range',
    range: { min: -99, max: 99, step: 1 }, gate: { id: 'wbMode', value: 'atw' },
    wire: cgi('imaging', 'WhiteBalanceOffsetColorTemp', INT) },                      // C-EN p.35
  { id: 'wbOffsetTint', group: 'whiteBalance', label: 'ATW offset (tint)', type: 'range',
    range: { min: -99, max: 99, step: 1 }, gate: { id: 'wbMode', value: 'atw' },
    wire: cgi('imaging', 'WhiteBalanceOffsetTint', INT) },                           // C-EN p.35

  // --- image ----------------------------------------------------------------
  { id: 'masterBlack', group: 'image', label: 'Master black', type: 'range', range: { min: -99, max: 99, step: 0.1 },
    wire: cgi('paint', 'MasterBlack', scaled(10)) },                                 // C-EN p.47
  { id: 'rBlack', group: 'image', label: 'R black', type: 'range', range: { min: -99, max: 99, step: 0.1 },
    wire: cgi('paint', 'RBlack', scaled(10)) },                                      // C-EN p.47
  { id: 'bBlack', group: 'image', label: 'B black', type: 'range', range: { min: -99, max: 99, step: 0.1 },
    wire: cgi('paint', 'BBlack', scaled(10)) },                                      // C-EN p.47
  { id: 'detail', group: 'image', label: 'Detail', type: 'bool', requires: 'visca',
    wire: { visca: viscaBool([0x81, 0x09, 0x7e, 0x01, 0x60, 0xff], [0x81, 0x01, 0x7e, 0x01, 0x60]) } }, // V-EN p.16, p.20
  { id: 'detailLevel', group: 'image', label: 'Detail level', type: 'range', requires: 'visca',
    range: { min: -7, max: 7, step: 1 },
    wire: { visca: {                                                                 // V-EN p.16, p.20: 00=-7, 07=0, 0E=+7
      inq: [0x81, 0x09, 0x04, 0x42, 0xff],
      dec: (r) => nibbles(r, 4, 2) - 7,
      enc: (v) => [0x81, 0x01, 0x04, 0x42, 0x00, 0x00, ...toNibbles(v + 7, 2), 0xff],
    } } },
  { id: 'knee', group: 'image', label: 'Knee', type: 'bool', requires: 'visca',
    wire: { visca: viscaBool([0x81, 0x09, 0x7e, 0x01, 0x6d, 0xff], [0x81, 0x01, 0x7e, 0x01, 0x6d]) } }, // V-EN p.16, p.21
  { id: 'kneeMode', group: 'image', label: 'Knee mode', type: 'enum', requires: 'visca',
    options: opts([[0, 'Auto'], [4, 'Manual']]),
    wire: { visca: {                                                                 // V-EN p.16, p.21
      inq: [0x81, 0x09, 0x7e, 0x01, 0x54, 0xff],
      dec: (r) => r[2] & 0x0f,
      enc: (v) => [0x81, 0x01, 0x7e, 0x01, 0x54, v, 0xff],
    } } },
  { id: 'kneeSlope', group: 'image', label: 'Knee slope', type: 'range', requires: 'visca',
    range: { min: -99, max: 99, step: 1 }, gate: { id: 'kneeMode', value: 4 },
    wire: { visca: {                                                                 // V-EN p.16, p.21: 00=-99, 63=0, C6=+99
      inq: [0x81, 0x09, 0x7e, 0x01, 0x6f, 0xff],
      dec: (r) => nibbles(r, 4, 2) - 99,
      enc: (v) => [0x81, 0x01, 0x7e, 0x01, 0x6f, ...toNibbles(v + 99, 2), 0xff],
    } } },
  { id: 'kneePoint', group: 'image', label: 'Knee point', type: 'range', requires: 'visca', verify: true,
    range: { min: 75, max: 109, step: 1, unit: '%' }, gate: { id: 'kneeMode', value: 4 },
    help: 'Sony gives only the ends (00 = 75 %, 22h = 109 %); one percent per step is assumed between them.',
    wire: { visca: {                                                                 // V-EN p.16, p.21
      inq: [0x81, 0x09, 0x7e, 0x01, 0x6e, 0xff],
      dec: (r) => nibbles(r, 4, 2) + 75,
      enc: (v) => [0x81, 0x01, 0x7e, 0x01, 0x6e, ...toNibbles(v - 75, 2), 0xff],
    } } },
  { id: 'baseLook', group: 'image', label: 'Base look', type: 'text', readOnly: true,
    wire: cgi('baselook', 'BaseLookCurrentBaseLook', TOKEN) },                       // C-EN p.46 (inquiry only)
  { id: 'sceneFile', group: 'image', label: 'Scene file', type: 'range', range: { min: 0, max: 16, step: 1 },
    help: '0 = off.',
    wire: cgi('scenefile', 'SceneFileCurrentSceneFile', INT) },                      // C-EN p.45
  { id: 'targetDisplay', group: 'image', label: 'Target display', type: 'enum',
    options: opts([['bt_709', 'BT.709'], ['hlg', 'HLG']]),
    wire: cgi('project', 'BaseSettingTargetDisplay', TOKEN) },                       // C-EN p.41
  { id: 'lutHdmiStream', group: 'image', label: 'Monitor LUT (HDMI / stream)', type: 'bool',
    wire: cgi('shooting', 'LutHdmiStream', ONOFF) },                                 // C-EN p.38
  { id: 'lutSdi', group: 'image', label: 'Monitor LUT (SDI)', type: 'bool',
    wire: cgi('shooting', 'LutSdi', ONOFF) },                                        // C-EN p.38

  // --- focus & zoom ---------------------------------------------------------
  { id: 'focusMode', group: 'lens', label: 'Focus mode', type: 'enum', operate: true, poll: 'fast',
    role: 'focusMode', autoValue: 'auto', manualValue: 'manual', affects: ['focusPosition'],
    help: 'Focus settings cannot be changed while PTZ Auto Framing runs.',
    options: opts([['auto', 'Auto'], ['manual', 'Manual']]),
    wire: cgi('ptzf', 'FocusMode', TOKEN) },                                         // C-EN p.16; V-EN p.16; HG p.171
  { id: 'pushAF', group: 'lens', label: 'Push AF', type: 'action', operate: true, role: 'onePushAf',
    affects: ['focusPosition'],
    wire: { act: 'press', set: 'ptzf', param: 'FocusPushAFMF',                      // C-EN p.16 (press/release pair)
      visca: [[0x81, 0x01, 0x7e, 0x04, 0x58, 0x01, 0xff], [0x81, 0x01, 0x7e, 0x04, 0x58, 0x00, 0xff]] } }, // V-EN p.16
  { id: 'focusPosition', group: 'lens', label: 'Focus position', type: 'range',
    range: { min: 0, max: 0xf7ff, step: 1 }, gate: { id: 'focusMode', value: 'manual' },
    help: '0 = far end, 63487 = near end.',
    wire: cgi('ptzf', 'AbsoluteFocus', HEX4) },                                      // C-EN p.15 (0000..ffff; operating to F7FF)
  { id: 'teleConvert', group: 'lens', label: 'Tele convert', type: 'bool',
    help: 'Changing this requires PTZ Auto Framing to be set up again.',
    wire: cgi('ptzf', 'TeleConvertMode', ONOFF) },                                   // C-EN p.19; HG p.171
  { id: 'afAssist', group: 'lens', label: 'AF assist', type: 'bool',
    wire: cgi('ptzf', 'AFAssistControl', ONOFF) },                                   // C-EN p.15
  { id: 'afSubjectShiftSens', group: 'lens', label: 'AF subject shift sensitivity', type: 'range',
    range: { min: 1, max: 5, step: 1 }, wire: cgi('ptzf', 'FocusAFSubjShiftSens', INT) }, // C-EN p.15
  { id: 'afTransitionSpeed', group: 'lens', label: 'AF transition speed', type: 'range',
    range: { min: 1, max: 7, step: 1 }, wire: cgi('ptzf', 'FocusAFTransitionSpeed', INT) }, // C-EN p.15
  { id: 'faceEyeAF', group: 'lens', label: 'Face / eye detection AF', type: 'enum',
    options: opts([['only_af', 'Face only AF'], ['priority_af', 'Face priority AF'], ['off', 'Off']]),
    wire: cgi('ptzf', 'FocusFaceEyeDetectionAF', TOKEN) },                           // C-EN p.15
  { id: 'touchFocusInMF', group: 'lens', label: 'Touch focus in MF', type: 'enum',
    options: opts([['tracking_af', 'Tracking AF'], ['spot_focus', 'Spot focus']]),
    wire: cgi('ptzf', 'TouchFocusInMF', TOKEN) },                                    // C-EN p.16
  { id: 'zoomSpeedScale', group: 'lens', label: 'Web zoom speed scale', type: 'range',
    range: { min: 10, max: 100, step: 1 }, wire: cgi('ptzf', 'ZoomSpeedScale', INT) }, // C-EN p.19

  // --- pan / tilt -----------------------------------------------------------
  { id: 'home', group: 'ptz', label: 'Home', type: 'action', operate: true, role: 'home',
    wire: { act: 'set', set: 'presetposition', param: 'HomePos', value: 'recall',    // C-EN p.20
      visca: [[0x81, 0x01, 0x06, 0x04, 0xff]] } },                                   // V-EN p.18
  // Settings that move the head on their own, invert or unlimit its travel, or
  // outlast the shoot are admin: an operator's slip here is a head swinging
  // the wrong way, or into the set.
  { id: 'panTiltReset', group: 'ptz', label: 'Pan / tilt reset', type: 'action', danger: 'admin',
    help: 'Re-initialises the head: it moves through its whole range.',
    wire: { act: 'set', set: 'ptzf', param: 'PanTiltReset', value: 'on' } },         // C-EN p.17
  { id: 'panTiltSpeedStep', group: 'ptz', label: 'P/T speed step', type: 'enum',
    help: 'Extended gives 127 speed steps, Normal 24. CamBridge follows whichever is set.',
    options: opts([['normal', 'Normal (24)'], ['extended', 'Extended (127)']]),
    wire: cgi('ptzf', 'PanTiltSpeedStep', TOKEN) },                                  // C-EN p.13, p.19; V-EN p.18
  { id: 'panTiltSpeedMode', group: 'ptz', label: 'P/T speed mode', type: 'enum',
    options: opts([['normal', 'Normal'], ['slow', 'Slow']]),
    wire: cgi('ptzf', 'PanTiltSpeedMode', TOKEN) },                                  // C-EN p.19
  { id: 'rampCurve', group: 'ptz', label: 'P/T acceleration', type: 'range', range: { min: 1, max: 9, step: 1 },
    wire: cgi('ptzf', 'RampCurve', INT) },                                           // C-EN p.17
  { id: 'panTiltSpeedScale', group: 'ptz', label: 'Web P/T speed scale', type: 'range',
    range: { min: 10, max: 100, step: 1 }, wire: cgi('ptzf', 'PanTiltSpeedScale', INT) }, // C-EN p.19
  { id: 'settingPosition', group: 'ptz', label: 'Install position', type: 'enum', danger: 'admin',
    help: 'Changes the tilt range and directions, and requires PTZ Auto Framing to be set up again.',
    options: opts([['desktop', 'Desktop'], ['ceiling', 'Ceiling']]),
    wire: cgi('ptzf', 'SettingPosition', TOKEN) },                                   // C-EN p.17; HG p.171
  { id: 'panDirection', group: 'ptz', label: 'Pan direction', type: 'enum', danger: 'admin',
    options: opts([['normal', 'Normal'], ['opposite', 'Opposite']]),
    wire: cgi('ptzf', 'PanDirection', TOKEN) },                                      // C-EN p.17
  { id: 'tiltDirection', group: 'ptz', label: 'Tilt direction', type: 'enum', danger: 'admin',
    options: opts([['normal', 'Normal'], ['opposite', 'Opposite']]),
    wire: cgi('ptzf', 'TiltDirection', TOKEN) },                                     // C-EN p.17
  { id: 'panLimitMode', group: 'ptz', label: 'Pan limit', type: 'enum', danger: 'admin',
    options: opts([['unlimited', 'Unlimited'], ['limited', 'Limited']]),
    wire: cgi('ptzf', 'PanLimitMode', TOKEN) },                                      // C-EN p.18
  { id: 'tiltLimitMode', group: 'ptz', label: 'Tilt limit', type: 'enum', danger: 'admin',
    options: opts([['unlimited', 'Unlimited'], ['limited', 'Limited']]),
    wire: cgi('ptzf', 'TiltLimitMode', TOKEN) },                                     // C-EN p.18
  { id: 'ptzfStatus', group: 'ptz', label: 'Pan, tilt, zoom, focus status', type: 'text', readOnly: true, poll: 'fast',
    wire: cgi('ptzf', 'PtzfStatus', TEXT) },                                         // C-EN p.19

  // --- presets --------------------------------------------------------------
  { id: 'presetSpeedSelect', group: 'presets', label: 'Recall speed', type: 'enum',
    options: opts([['separate', 'Separate per preset'], ['common', 'Common']]),
    wire: cgi('presetposition', 'SpeedSelect', TOKEN) },                             // C-EN p.22
  { id: 'presetCommonSpeed', group: 'presets', label: 'Common recall speed', type: 'range',
    range: { min: 1, max: 127, step: 1 }, gate: { id: 'presetSpeedSelect', value: 'common' },
    wire: cgi('presetposition', 'CommonSpeed', INT) },                               // C-EN p.22
  { id: 'presetRampCurve', group: 'presets', label: 'Recall acceleration', type: 'range',
    range: { min: 1, max: 9, step: 1 }, wire: cgi('presetposition', 'PresetRampCurve', INT) }, // C-EN p.20

  // --- tracking: PTZ Auto Framing -------------------------------------------
  // On/off goes over VISCA when VISCA answers (V-EN p.18, p.21:
  // 81 01 7E 04 3A 0p FF, p 1 start / 0 stop) and over CGI otherwise; both
  // are Sony-documented, the VISCA pair is also in the Companion module.
  { id: 'afrEnable', group: 'tracking', label: 'PTZ Auto Framing', type: 'bool', operate: true, poll: 'fast',
    requires: 'tracking', role: 'trackingEnabled', affects: ['afrStatus'],
    help: 'Wait a second after a zoom move before turning it on. Needs the initial setup done on the camera\'s web page.',
    wire: cgi('ptzautoframing', 'PtzAutoFraming', ONOFF, AFR, {                     // C-EN p.23; C-JP3 p.25
      visca: {
        inq: [0x81, 0x09, 0x7e, 0x04, 0x3a, 0xff],
        dec: (r) => (r[2] & 0x0f) === 0x01,
        enc: (v) => [0x81, 0x01, 0x7e, 0x04, 0x3a, v ? 0x01 : 0x00, 0xff],
      } }) },
  { id: 'afrStatus', group: 'tracking', label: 'Framing status', type: 'enum', readOnly: true, poll: 'fast',
    requires: 'tracking',
    options: opts([['idle', 'Stopped'], ['missing', 'Target lost'], ['preparing', 'Preparing'],
      ['searching', 'Searching'], ['tracking', 'Tracking'], ['waiting', 'Waiting for target']]),
    wire: cgi('ptzautoframing', 'PtzAutoFramingTrackingStatus', TOKEN, AFR) },        // C-EN p.27
  { id: 'afrPause', group: 'tracking', label: 'Pause framing', type: 'bool', operate: true, poll: 'fast',
    requires: 'tracking', wire: cgi('ptzautoframing', 'PtzAutoFramingPause', ONOFF, AFR) }, // C-EN p.27
  { id: 'afrInitialSetup', group: 'tracking', label: 'Initial setup', type: 'enum', readOnly: true,
    requires: 'tracking',
    options: opts([['uninitialized', 'Not done'], ['initialized', 'Done']]),
    wire: cgi('ptzautoframing', 'PtzAutoFramingInitialSetup', TOKEN, AFR) },          // C-EN p.23
  { id: 'afrFramingMode', group: 'tracking', label: 'Framing mode', type: 'enum', requires: 'tracking', verify: true,
    help: 'After a change the camera may refuse another change, or turning framing on, for several tens of seconds.',
    options: opts([['person', 'Person'], ['ball_sports', 'Ball sports']]),
    wire: cgi('ptzautoframing', 'PtzAutoFramingFramingMode', TOKEN, AFR) },           // C-JP3 p.28 only; HG p.176
  { id: 'afrTriggerType', group: 'tracking', label: 'Start tracking', type: 'enum', requires: 'tracking',
    options: opts([['manual', 'When a target is chosen'], ['auto', 'When someone enters the detection area']]),
    wire: cgi('ptzautoframing', 'PtzAutoFramingTriggerType', TOKEN, AFR) },           // C-EN p.24
  { id: 'afrMultiEnable', group: 'tracking', label: 'Frame several people', type: 'bool', requires: 'tracking',
    wire: cgi('ptzautoframing', 'PtzAutoFramingMultiTrackingEnable', ONOFF, AFR) },   // C-EN p.23
  { id: 'afrMultiTargetNum', group: 'tracking', label: 'Number of people', type: 'range', requires: 'tracking',
    range: { min: 2, max: 8, step: 1 }, gate: { id: 'afrMultiEnable', value: true },
    wire: cgi('ptzautoframing', 'PtzAutoFramingMultiTrackingTargetNum', INT, AFR) },  // C-EN p.23
  { id: 'afrMultiWaitTime', group: 'tracking', label: 'Wait for people', type: 'range', requires: 'tracking',
    range: { min: 0, max: 60, step: 1, unit: ' s' }, help: '0 = do not start until everyone is found.',
    wire: cgi('ptzautoframing', 'PtzAutoFramingMultiTrackingWaitTime', INT, AFR) },  // C-EN p.23
  { id: 'afrCompVertical', group: 'tracking', label: 'Composition: vertical', type: 'range', requires: 'tracking',
    range: { min: -50, max: 70, step: 1 },
    wire: cgi('ptzautoframing', 'PtzAutoFramingAdjustSetting', INT, AFR, { index: 0 }) }, // C-EN p.24
  { id: 'afrCompHorizontal', group: 'tracking', label: 'Composition: horizontal', type: 'range', requires: 'tracking',
    range: { min: -50, max: 50, step: 1 },
    wire: cgi('ptzautoframing', 'PtzAutoFramingAdjustSetting', INT, AFR, { index: 1 }) }, // C-EN p.24
  { id: 'afrCompSize', group: 'tracking', label: 'Composition: size', type: 'range', requires: 'tracking', verify: true,
    range: { min: 250, max: 3500, step: 1 },
    help: 'Per mille of a person\'s height. C-EN says 250–3500, the newer Japanese list 160–3500; the safe common range is offered.',
    wire: cgi('ptzautoframing', 'PtzAutoFramingAdjustSetting', INT, AFR, { index: 2 }) }, // C-EN p.24 vs C-JP3 p.26 (conflict)
  { id: 'afrLeadRoom', group: 'tracking', label: 'Lead room', type: 'enum', requires: 'tracking',
    options: opts([['off', 'Off'], ['low', 'Weak'], ['middle', 'Medium'], ['high', 'Strong']]),
    wire: cgi('ptzautoframing', 'PtzAutoFramingLeadRoomLevel', TOKEN, AFR) },        // C-EN p.24
  { id: 'afrControlScope', group: 'tracking', label: 'Automatic control of', type: 'enum', requires: 'tracking', verify: true,
    options: opts([['pan_tilt_zoom', 'Pan, tilt and zoom'], ['pan_tilt', 'Pan and tilt'], ['pan', 'Pan only']]),
    wire: cgi('ptzautoframing', 'PtzAutoFramingAutoControlScope', TOKEN, AFR) },     // C-JP3 p.27 only; HG p.179
  ...['Pan', 'Tilt', 'Zoom'].map((axis) => ({
    id: `afrSpeed${axis}`, group: 'tracking', label: `Framing speed: ${axis.toLowerCase()}`, type: 'range',
    requires: 'tracking', verify: true, range: { min: 1, max: 5, step: 1 }, help: '1 slow – 5 fast.',
    wire: cgi('ptzautoframing', `PtzAutoFramingSpeed${axis}`, INT, AFR),            // C-JP3 p.27 only; HG p.179
  })),
  ...['Pan', 'Tilt', 'Zoom'].map((axis) => ({
    id: `afrSensitivity${axis}`, group: 'tracking', label: `Framing sensitivity: ${axis.toLowerCase()}`, type: 'range',
    requires: 'tracking', verify: true, range: { min: 0, max: 5, step: 1 },
    help: '0 = move until the composition is reached, then hold still.',
    wire: cgi('ptzautoframing', `PtzAutoFramingSensitivity${axis}`, INT, AFR),      // C-JP3 p.27 only; HG p.179
  })),
  { id: 'afrDetectionArea', group: 'tracking', label: 'Detection area (x,y,w,h)', type: 'text', requires: 'tracking',
    pattern: RECT, help: '0–10000 across the picture, from the top left. Width at least 1000, height at least 2000.',
    wire: cgi('ptzautoframing', 'PtzAutoFramingDetectionArea', TEXT, AFR) },         // C-EN p.25
  { id: 'afrDetectionPart', group: 'tracking', label: 'Detect by', type: 'enum', requires: 'tracking',
    options: opts([['head', 'Head'], ['ankle', 'Ankle']]),
    wire: cgi('ptzautoframing', 'PtzAutoFramingDetectionPart', TOKEN, AFR) },        // C-EN p.25
  { id: 'afrRegisteredFace', group: 'tracking', label: 'Registered face tracking', type: 'bool', requires: 'tracking',
    wire: cgi('ptzautoframing', 'PtzAutoFramingRegisteredFaceTracking', ONOFF, AFR) }, // C-EN p.25
  { id: 'afrIndividualId', group: 'tracking', label: 'Personal identification', type: 'bool', requires: 'tracking',
    wire: cgi('ptzautoframing', 'PtzAutoFramingIndividualIdentification', ONOFF, AFR) }, // C-EN p.25
  { id: 'afrFaceLostWait', group: 'tracking', label: 'Tracking timeout', type: 'range', requires: 'tracking',
    range: { min: 0, max: 60, step: 1, unit: ' s' }, help: '0 = no timeout. After it, the head returns to its start position.',
    wire: cgi('ptzautoframing', 'PtzAutoFramingFaceLostWaitTime', INT, AFR) },       // C-EN p.25; HG p.182
  { id: 'afrRestartTime', group: 'tracking', label: 'Detection restart', type: 'range', requires: 'tracking',
    range: { min: 0, max: 600, step: 1, unit: ' s' }, help: '0 = no restart.',
    wire: cgi('ptzautoframing', 'PtzAutoFramingDetectionRestartTime', INT, AFR) },   // C-EN p.25
  { id: 'afrLostWait', group: 'tracking', label: 'Wait when target lost', type: 'range', requires: 'tracking',
    range: { min: 1, max: 60, step: 1, unit: ' s' },
    wire: cgi('ptzautoframing', 'PtzAutoFramingLostWaitTime', INT, AFR) },           // C-EN p.25
  { id: 'afrAutoStart', group: 'tracking', label: 'Start framing at power on', type: 'bool', requires: 'tracking',
    wire: cgi('ptzautoframing', 'PtzAutoFramingAutoStartEnable', ONOFF, AFR) },      // C-EN p.25
  { id: 'afrFaceIndicator', group: 'tracking', label: 'Show detection frames in stream', type: 'bool', requires: 'tracking',
    wire: cgi('ptzautoframing', 'PtzAutoFramingFaceIndicatorEnable3', ONOFF, AFR) }, // C-EN p.25
  { id: 'afrRangeEnable', group: 'tracking', label: 'Tracking range', type: 'bool', requires: 'tracking',
    wire: cgi('ptzautoframing', 'PtzAutoFramingTrackingRangeEnable', ONOFF, AFR, { prefix: ['1'] }) }, // C-EN p.26
  { id: 'afrRangeRect', group: 'tracking', label: 'Tracking range (x,y,w,h)', type: 'text', requires: 'tracking',
    pattern: RECT, gate: { id: 'afrRangeEnable', value: true },
    wire: cgi('ptzautoframing', 'PtzAutoFramingTrackingRangeRect', TEXT, AFR, { prefix: ['1'] }) }, // C-EN p.26
  { id: 'afrCurrentTargets', group: 'tracking', label: 'People framed (now, max)', type: 'text', readOnly: true,
    requires: 'tracking', poll: 'fast',
    wire: cgi('ptzautoframing', 'PtzAutoFramingMultiTrackingCurrentTargetNum', TEXT, AFR) }, // C-EN p.27
  { id: 'afrSelectTarget', group: 'tracking', label: 'Frame the person at a point', type: 'action', operate: true,
    requires: 'tracking', affects: ['afrStatus'],
    help: 'Payload {x, y}, 0–10000 from the top left; without one, the person nearest the centre.',
    wire: { act: 'afrPoint', set: AFR, param: 'PtzAutoFramingObjectPosition' } },     // C-EN p.26
  ...[1, 2, 3].map((n) => ({
    id: `afrPreset${n}`, group: 'tracking', label: `Framing preset ${n}`, type: 'action', requires: 'tracking',
    affects: ['afrCompVertical', 'afrCompHorizontal', 'afrCompSize'],
    wire: { act: 'set', set: AFR, param: 'PtzAutoFramingPresetCall', value: String(n) }, // C-EN p.27
  })),
  { id: 'afrRestart', group: 'tracking', label: 'Restart detection', type: 'action', requires: 'tracking',
    help: 'Automatic start mode only: return to the start position and look again.',
    wire: { act: 'set', set: AFR_EXE, param: 'PtzAutoFramingRestart', value: 'on' } }, // C-EN p.28
  { id: 'afrMoveStart', group: 'tracking', label: 'Go to start position', type: 'action', requires: 'tracking',
    wire: { act: 'set', set: AFR_EXE, param: 'PtzAutoFramingMoveStartPosition', value: 'on' } }, // C-EN p.28
  { id: 'afrDecideStart', group: 'tracking', label: 'Make this the start position', type: 'action', requires: 'tracking',
    danger: 'admin', help: 'Overwrites the start position saved by the framing setup.',
    wire: { act: 'set', set: AFR_EXE, param: 'PtzAutoFramingDecideStartPosition', value: 'on' } }, // C-EN p.28
  { id: 'afrCourtReset', group: 'tracking', label: 'Reset court corners', type: 'action', requires: 'tracking',
    danger: 'admin', verify: true,
    wire: { act: 'set', set: AFR_EXE, param: 'PtzAutoFramingCourtVerticesReset', value: 'reset' } }, // C-JP3 p.33 only

  // --- tally ----------------------------------------------------------------
  { id: 'tallyMode', group: 'tally', label: 'Tally control', type: 'enum',
    help: 'CamBridge drives the lamp only in External. PTZ AFR shows framing status in blue.',
    options: opts([['internal', 'Internal'], ['external', 'External'], ['ptz_afr', 'PTZ AFR status']]),
    wire: cgi('tally', 'TallyControlMode', TOKEN) },                                 // C-EN p.39; HG p.493
  { id: 'tallyBrightness', group: 'tally', label: 'Tally lamp', type: 'enum', role: 'tally',
    options: opts([['off', 'Off'], ['low', 'Low'], ['high', 'High']]),
    wire: cgi('tally', 'TallyLampBrightness', TOKEN) },                              // C-EN p.39
  { id: 'tallyGreenLamp', group: 'tally', label: 'Green lamp enabled', type: 'bool',
    wire: cgi('tally', 'GTallyLampEnable', ONOFF) },                                 // C-EN p.39
  { id: 'tallyYellowLamp', group: 'tally', label: 'Yellow lamp enabled', type: 'bool',
    wire: cgi('tally', 'YTallyLampEnable', ONOFF) },                                 // C-EN p.39
  { id: 'tallyRed', group: 'tally', label: 'Red tally', type: 'bool', readOnly: true, poll: 'fast',
    wire: cgi('tally', 'RTallyControl', TURN) },                                     // C-EN p.39
  { id: 'tallyGreen', group: 'tally', label: 'Green tally', type: 'bool', readOnly: true, poll: 'fast',
    wire: cgi('tally', 'GTallyControl', TURN) },                                     // C-EN p.39
  { id: 'tsiUmd', group: 'tally', label: 'TSL UMD tally input', type: 'bool', danger: 'reconnect',
    wire: cgi('tally', 'TallyTsiUmdEnable', BIT) },                                  // C-EN p.40
  { id: 'tsiUmdPort', group: 'tally', label: 'TSL UMD port', type: 'range', danger: 'reconnect',
    range: { min: 1024, max: 65534, step: 1 }, wire: cgi('tally', 'TallyTsiUmdPort', INT) }, // C-EN p.40
  { id: 'tsiUmdIndex', group: 'tally', label: 'TSL UMD index', type: 'range',
    range: { min: 0, max: 65534, step: 1 }, wire: cgi('tally', 'TallyTsiUmdIndex', INT) }, // C-EN p.40

  // --- video output ---------------------------------------------------------
  { id: 'outputFormat', group: 'videoOut', label: 'Output format (SDI1 / SDI2 / HDMI)', type: 'enum', danger: 'admin',
    help: 'Outputs drop while it switches; stream sizes may change with it.',
    options: opts(OUTPUT_FORMATS), wire: cgi('monitoring', 'MonitoringOutputFormat', TOKEN) }, // C-EN p.48, p.100
  { id: 'osdHdmi', group: 'videoOut', label: 'Menu / status on HDMI and stream', type: 'bool',
    wire: cgi('monitoring', 'MonitoringOutputDisplayHdmiEnable', ONOFF) },           // C-EN p.48
  { id: 'osdSdi', group: 'videoOut', label: 'Menu / status on SDI', type: 'bool',
    wire: cgi('monitoring', 'MonitoringOutputDisplaySdiEnable', ONOFF) },            // C-EN p.48

  // --- streaming ------------------------------------------------------------
  { id: 'streamMode', group: 'streaming', label: 'Stream mode', type: 'enum',
    help: 'NDI|HX and SRT modes reset codec settings.',
    options: opts([['rtsp', 'RTSP'], ['rtmp', 'RTMP'], ['srt-caller', 'SRT caller'], ['srt-listener', 'SRT listener'],
      ['ndi_hx', 'NDI|HX'], ['off', 'Off']]),
    wire: cgi('stream', 'StreamMode', TOKEN) },                                      // C-EN p.62
  { id: 'streamStatus', group: 'streaming', label: 'Stream status', type: 'enum', readOnly: true,
    options: opts([['invalid', 'Invalid'], ['off', 'Off'], ['ready', 'Ready'], ['ready-ssl', 'Ready (SSL)'],
      ['streaming', 'Streaming'], ['streaming-ssl', 'Streaming (SSL)']]),
    wire: cgi('stream', 'StreamStatus', TOKEN) },                                    // C-EN p.62
  { id: 'imageCodec1', group: 'streaming', label: 'Stream 1 codec', type: 'enum',
    options: opts([['h264', 'H.264'], ['h265', 'H.265']]), wire: cgi('codecconfig', 'ImageCodec1', TOKEN) }, // C-EN p.68
  { id: 'imageCodec2', group: 'streaming', label: 'Stream 2 codec', type: 'enum',
    options: opts([['h264', 'H.264'], ['h265', 'H.265'], ['off', 'Off']]), wire: cgi('codecconfig', 'ImageCodec2', TOKEN) }, // C-EN p.68
  { id: 'bitRate1', group: 'streaming', label: 'Stream 1 bit rate', type: 'range',
    range: { min: 512, max: 80000, step: 1, unit: ' kbps' }, help: 'Applies when CBR is on.',
    wire: cgi('codecconfig', 'BitRate1', INT) },                                     // C-EN p.66
  { id: 'cbr1', group: 'streaming', label: 'Stream 1 CBR', type: 'bool', wire: cgi('codecconfig', 'CBR1', ONOFF) }, // C-EN p.66
  { id: 'rtspAuth', group: 'streaming', label: 'RTSP authentication', type: 'bool', danger: 'admin',
    help: 'Off lets anyone on the network watch the stream.',
    wire: cgi('rtspconfig', 'AuthenRTSP', ONOFF) },                                  // C-EN p.62
  { id: 'rtspPort', group: 'streaming', label: 'RTSP port', type: 'range', danger: 'reconnect',
    range: { min: 554, max: 65534, step: 1 }, help: '554, or 1024–65534.',
    wire: cgi('rtspconfig', 'RTSPPort', INT) },                                      // C-EN p.62
  { id: 'srtListenPort', group: 'streaming', label: 'SRT listen port', type: 'range', danger: 'reconnect',
    range: { min: 1024, max: 65534, step: 1 }, wire: cgi('srt', 'SrtListenPort', INT) }, // C-EN p.64
  { id: 'srtLatency', group: 'streaming', label: 'SRT latency', type: 'range',
    range: { min: 20, max: 8000, step: 1, unit: ' ms' }, wire: cgi('srt', 'SrtPeerLatency', INT) }, // C-EN p.64

  // --- audio ----------------------------------------------------------------
  { id: 'audioStream', group: 'audio', label: 'Streaming audio', type: 'bool', help: 'RTMP needs this on.',
    wire: cgi('codecconfig', 'AudioIn', ONOFF) },                                    // C-EN p.65
  { id: 'audioMaster', group: 'audio', label: 'Master level', type: 'range', range: { min: 0, max: 99, step: 1 },
    wire: cgi('audio', 'AudioInputMasterLevel', INT) },                              // C-EN p.50
  ...[1, 2, 3, 4].map((n) => ({
    id: `audioLevelCh${n}`, group: 'audio', label: `CH${n} level`, type: 'range', range: { min: 0, max: 99, step: 1 },
    wire: cgi('audio', `AudioInputCH${n}Level`, INT),                                // C-EN p.49
  })),
  ...[1, 2, 3, 4].map((n) => ({
    id: `audioLevelControlCh${n}`, group: 'audio', label: `CH${n} level control`, type: 'enum',
    options: opts([['auto', 'Auto'], ['manual', 'Manual']]),
    wire: cgi('audio', `AudioInputCH${n}LevelControl`, TOKEN),                       // C-EN p.49
  })),
  ...[1, 2].map((n) => ({
    id: `audioIn${n}Select`, group: 'audio', label: `Input ${n} type`, type: 'enum',
    options: opts([['mic', 'Mic'], ['line', 'Line']]),
    wire: cgi('audio', `AudioInputIn${n}Select`, TOKEN),                             // C-EN p.49-50
  })),
  ...[1, 2].map((n) => ({
    id: `audioIn${n}Phantom`, group: 'audio', label: `Input ${n} +48V`, type: 'bool',
    help: 'Phantom power; only for microphones that need it.',
    wire: cgi('audio', `AudioInputIn${n}Mic48V`, ONOFF),                             // C-EN p.49-50
  })),

  // --- network --------------------------------------------------------------
  { id: 'cameraName', group: 'network', label: 'Camera name', type: 'text', role: 'cameraName',
    maxLength: 8, pattern: '^[A-Za-z0-9 ]{0,8}$',
    wire: cgi('network', 'CameraName', TEXT) },                                      // C-EN p.53 (0-8 alphanumeric)
  { id: 'dhcp', group: 'network', label: 'DHCP', type: 'bool', danger: 'reconnect',
    wire: cgi('network', 'Dhcp', ONOFF) },                                           // C-EN p.52
  { id: 'ipAddress', group: 'network', label: 'IP address', type: 'text', danger: 'reconnect', role: 'ipAddress',
    pattern: IPV4, wire: cgi('network', 'Ip', TEXT) },                               // C-EN p.52
  { id: 'subnetMask', group: 'network', label: 'Subnet mask', type: 'text', danger: 'reconnect',
    pattern: IPV4, wire: cgi('network', 'Subnetmask', TEXT) },                       // C-EN p.52
  { id: 'gateway', group: 'network', label: 'Gateway', type: 'text', danger: 'reconnect',
    pattern: IPV4, wire: cgi('network', 'Gateway', TEXT) },                          // C-EN p.52
  { id: 'currentIp', group: 'network', label: 'Current IP address', type: 'text', readOnly: true,
    wire: cgi('network', 'CurrentIp', TEXT) },                                       // C-EN p.52
  { id: 'macAddress', group: 'network', label: 'MAC address', type: 'text', readOnly: true, poll: 'once',
    wire: cgi('network', 'MacAddress', TEXT) },                                      // C-EN p.52
  { id: 'httpPort', group: 'network', label: 'HTTP port', type: 'range', danger: 'reconnect',
    range: { min: 80, max: 65534, step: 1 }, help: '80, or 1024–65534.',
    wire: cgi('network', 'HttpPort', INT) },                                         // C-EN p.51
  { id: 'refererCheck', group: 'network', label: 'Referer check', type: 'bool', danger: 'reconnect',
    help: 'CamBridge sends a Referer naming the camera, so it works with this on.',
    wire: cgi('auth', 'RefererCheck', ONOFF) },                                      // C-EN p.60
  { id: 'ipSetupEnable', group: 'network', label: 'Accept IP setup tool', type: 'bool', danger: 'reconnect',
    wire: cgi('network', 'IPSetupSetEnable', ONOFF) },                               // C-EN p.53
  { id: 'viscaStatus', group: 'network', label: 'VISCA over IP', type: 'text', readOnly: true, poll: 'slow',
    help: 'Needs rear SETUP switch 4 ON (read at power-on) and the administrator password set. Without it CamBridge uses CGI: focus speed control, detail and knee are unavailable.',
    wire: { local: 'visca' } },                                                      // HG p.23, p.505

  // --- users ----------------------------------------------------------------
  { id: 'bruteForceProtection', group: 'users', label: 'Brute-force protection', type: 'bool', danger: 'admin',
    help: 'Blocks a computer after repeated wrong passwords (default 8, for 60 s).',
    wire: cgi('auth', 'BruteForceAttackProtection', ONOFF) },                        // C-EN p.59
  { id: 'digestNonceDuration', group: 'users', label: 'Digest nonce lifetime', type: 'range', danger: 'admin',
    range: { min: 1, max: 3600, step: 1, unit: ' s' }, wire: cgi('user', 'DigestAuthNonceDuration', INT) }, // C-EN p.51

  // --- system ---------------------------------------------------------------
  { id: 'model', group: 'system', label: 'Model', type: 'text', readOnly: true, poll: 'once',
    wire: cgi('system', 'ModelName', TEXT) },                                        // C-EN p.7
  { id: 'firmware', group: 'system', label: 'Software version', type: 'text', readOnly: true, poll: 'once',
    wire: cgi('system', 'SoftVersion', TEXT) },                                      // C-EN p.7
  { id: 'serial', group: 'system', label: 'Serial number', type: 'text', readOnly: true, poll: 'once',
    wire: cgi('system', 'Serial', TEXT) },                                           // C-EN p.7
  { id: 'irRemote', group: 'system', label: 'IR remote', type: 'bool',
    wire: cgi('remotecontrol', 'IRReceive', ONOFF) },                                // C-EN p.74
  { id: 'temperatureWarning', group: 'system', label: 'Temperature warning', type: 'bool', readOnly: true,
    wire: cgi('status', 'TemperatureWarning', BIT) },                                // C-EN p.10
  { id: 'powerSupplyWarning', group: 'system', label: 'Supply voltage', type: 'enum', readOnly: true,
    options: opts([['normal', 'Normal'], ['low', 'Low'], ['insufficient', 'Insufficient']]),
    wire: cgi('status', 'PowerSupplyVoltageWarning', TOKEN) },                       // C-EN p.11

  // --- maintenance ----------------------------------------------------------
  { id: 'reboot', group: 'maintenance', label: 'Restart camera', type: 'action', danger: 'admin',
    wire: { act: 'set', set: 'main', param: 'System', value: 'reboot' } },           // C-EN p.73
  { id: 'resetImageSettings', group: 'maintenance', label: 'Reset image settings', type: 'action', danger: 'admin',
    wire: { act: 'set', set: 'main', param: 'FactoryDefault', value: 'soft' } },     // C-EN p.73
  { id: 'resetNetwork', group: 'maintenance', label: 'Reset network settings', type: 'action', danger: 'admin',
    wire: { act: 'set', set: 'main', param: 'FactoryDefault', value: 'network' } },  // C-EN p.73
  { id: 'factoryReset', group: 'maintenance', label: 'Factory reset', type: 'action', danger: 'admin',
    wire: { act: 'set', set: 'main', param: 'FactoryDefault', value: 'hard' } },     // C-EN p.73
];

/**
 * In the camera's menus or web UI, with no documented CGI or VISCA command
 * (notes §11 items 6, 11), or documented but not offered here.
 */
export const GAPS = [
  'Zoom type (Optical / Clear Image Zoom): menu only, no command',
  'Tele convert has no VISCA inquiry (CGI only)',
  'Lens / flange-back adjustment, APR, measurement',
  'Noise suppression, flicker reduction, soft skin effect, NIGHTSHOT',
  'Image stabilisation, including optical stabilisation added in firmware 3.01 (newer manual not obtained)',
  'Matrix / multi matrix',
  'Genlock, timecode / user bits, hours meter, service menu',
  'User accounts: Sony says "use from the web menu, do not use directly"; value format undocumented',
  'Face registration database (facedb.cgi) and court corner positions: documented, not offered here',
  'Per-preset Auto Framing settings (PresetPtzAfr*, Japanese 2026 list only)',
  'Auto Framing setup file save/restore (model placeholder in the path unresolved)',
  'Per-preset recall speed, duration and zoom/focus behaviour (per-preset values, not single settings)',
];
