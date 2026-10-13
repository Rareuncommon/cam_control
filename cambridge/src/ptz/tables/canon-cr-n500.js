// Canon CR-N500: every setting the XC protocol exposes for this model.
//
// Source: Canon "XC Control Protocol Specifications" BPE-7216-005 (Sept 2023,
// third-party mirror) as summarised in specs/canon-cr-n500.md — "XC5 p.N" is
// the printed page of the parameter row. The tracking rows come from the
// Bitfocus companion-module-canon-ptz only ("CCP", impl) and are verify: true.
//
// `wire` (private, never sent to the browser):
//   key      the info.cgi / control.cgi item name, always the full `c.1.…` /
//            `f.…` form (XC5 p.11 does not say which abbreviations are legal)
//   scale    wire = value × scale (gain is dB×10 on the wire, EV is ×4 …)
//   on/off   wire codes of a bool
//   snap     range written as the nearest member of the camera's own `<key>.list`
//   query    an action's control.cgi query, or `path` for another command
//   addon    a setting of the on-camera RA-AT001 tracking add-on (not XC)
//
// Values are the camera's own codes wherever those read as words ('auto',
// 'kelvin'); numbers where the code is a number (F-number ×100, shutter 1/x).
//
// Rows marked verify: true are `impl`, `conflict`, or `group-read` in the notes
// (a multi-model cell of the spec table read by alignment), or take their
// option list from the spec's sample dump of a sibling model. The camera's own
// `<key>.list` replies are passed through as `allowed`, so a list that turns
// out different on a real CR-N500 narrows itself rather than offering a value
// the camera will refuse.

const onOff = { on: 'on', off: 'off' };
const opt = (value, label) => ({ value, label });

// XC5 p.58 sample list (CR-N700 dump); CR-N500 endpoints 280…1100 per XC5 p.129.
const IRIS = [280, 320, 340, 370, 400, 440, 450, 480, 520, 560, 620, 670, 730, 800, 870, 950, 1000, 1100];
// XC5 p.58 sample list (CR-N700 dump); "e.g. 60…2000" per XC5 p.131. 1/x denominators (derived).
const SHUTTER = [60, 75, 90, 100, 120, 150, 180, 210, 250, 300, 360, 420, 500, 600, 720, 840, 1000, 1200, 1400, 1700, 2000];

const range = (min, max, step = 1, unit = '') => ({ min, max, step, unit });

export const TABLE = [
  // --- camera / system: identity, read once -----------------------------------
  { id: 'cameraName', role: 'cameraName', group: 'camera', label: 'Camera name', type: 'text', readOnly: true, poll: 'once', verify: true,
    help: 'XC lists this as read-only; set it on the camera\'s web page.',
    wire: { key: 'c.1.name.utf8' } },                                   // XC5 p.127 (G--U); CCP writes it — conflict
  { id: 'model', group: 'system', label: 'Model', type: 'text', readOnly: true, poll: 'once',
    wire: { key: 's.hardware' } },                                      // XC5 p.125
  { id: 'firmwareVersion', group: 'system', label: 'Firmware version', type: 'text', readOnly: true, poll: 'once',
    wire: { key: 's.firmware' } },                                      // XC5 p.125
  { id: 'protocolVersion', group: 'system', label: 'XC protocol version', type: 'text', readOnly: true, poll: 'once',
    wire: { key: 's.protocol' } },                                      // XC5 p.125
  { id: 'macAddress', group: 'system', label: 'MAC address', type: 'text', readOnly: true, poll: 'once',
    wire: { key: 's.hardware.address' } },                              // XC5 p.125
  { id: 'hardwareId', group: 'system', label: 'Hardware ID', type: 'text', readOnly: true, poll: 'once',
    wire: { key: 's.hardware.id' } },                                   // XC5 p.125
  { id: 'startTime', group: 'system', label: 'Running since', type: 'text', readOnly: true, poll: 'once',
    wire: { key: 's.epoch' } },                                         // XC5 p.125
  { id: 'cameraStatus', group: 'system', label: 'Camera ready', type: 'enum', readOnly: true,
    options: [opt('enabled', 'Ready'), opt('disabled', 'Initialising')],
    wire: { key: 'c.1.status' } },                                      // XC5 p.127
  { id: 'systemStatus', group: 'system', label: 'System status', type: 'enum', readOnly: true,
    options: [opt('idle', 'Idle'), opt('busy', 'Busy')],
    wire: { key: 's.system.status' } },                                 // XC5 p.125
  { id: 'powerState', group: 'system', label: 'Power', type: 'enum', danger: 'reconnect',
    options: [opt('idle', 'On'), opt('standby', 'Standby')],
    help: 'In standby the camera accepts only status queries; picture and control stop until it is woken.',
    wire: { key: 'f.standby', standby: true } },                        // XC5 p.103-105, p.155
  { id: 'saveCameraInfo', group: 'system', label: 'Save camera information', type: 'action', danger: 'admin',
    help: 'XC "system action: save camera information in a batch".',
    wire: { query: 's.action=save' } },                                 // XC5 p.125

  // --- exposure ----------------------------------------------------------------
  { id: 'shootingMode', group: 'exposure', label: 'Shooting mode', type: 'enum', poll: 'fast',
    options: [opt('fullauto', 'Full auto'), opt('manual', 'Manual')],
    affects: ['exposureMode', 'whiteBalance', 'focusMode'],
    wire: { key: 'c.1.shooting' } },                                    // XC5 p.127
  { id: 'exposureMode', group: 'exposure', label: 'Exposure mode', type: 'enum', operate: true, poll: 'fast',
    options: [opt('auto', 'Auto (program AE)'), opt('manual', 'Manual')],
    affects: ['aeBrightness', 'meBrightness', 'irisValue', 'gainValue', 'shutterValue'],
    wire: { key: 'c.1.exp' } },                                         // XC5 p.127
  { id: 'aeBrightness', group: 'exposure', label: 'AE level', type: 'range', operate: true,
    range: range(-2, 2, 0.25, ' EV'), gate: { id: 'exposureMode', value: 'auto' },
    wire: { key: 'c.1.ae.brightness', scale: 4 } },                     // XC5 p.127-128: −8…8, EV×4
  { id: 'meBrightness', group: 'exposure', label: 'Exposure compensation (manual)', type: 'range',
    range: range(-2, 2, 0.25, ' EV'), gate: { id: 'exposureMode', value: 'manual' },
    wire: { key: 'c.1.me.brightness', scale: 4 } },                     // XC5 p.128
  { id: 'aePhotometry', group: 'exposure', label: 'Metering (auto)', type: 'enum',
    options: [opt('center', 'Centre-weighted'), opt('spotlight', 'Spotlight'), opt('backlight', 'Backlight')],
    wire: { key: 'c.1.ae.photometry' } },                               // XC5 p.128
  { id: 'mePhotometry', group: 'exposure', label: 'Metering (manual)', type: 'enum',
    options: [opt('center', 'Centre-weighted'), opt('spotlight', 'Spotlight'), opt('backlight', 'Backlight')],
    wire: { key: 'c.1.me.photometry' } },                               // XC5 p.128
  { id: 'aeResponse', group: 'exposure', label: 'AE response', type: 'range', range: range(0, 2),
    wire: { key: 'c.1.ae.resp' } },                                     // XC5 p.128
  { id: 'meResponse', group: 'exposure', label: 'AE response (manual)', type: 'range', range: range(0, 2),
    wire: { key: 'c.1.me.resp' } },                                     // XC5 p.128
  { id: 'irisMode', role: 'irisMode', group: 'exposure', label: 'Iris mode', type: 'enum', operate: true, poll: 'fast',
    options: [opt('auto', 'Auto'), opt('manual', 'Manual')], affects: ['irisValue'],
    wire: { key: 'c.1.me.diaphragm.mode' } },                           // XC5 p.128
  { id: 'irisValue', role: 'iris', group: 'exposure', label: 'Iris', type: 'enum', operate: true, verify: true,
    options: IRIS.map((f) => opt(f, `F${(f / 100).toFixed(1)}`)), gate: { id: 'irisMode', value: 'manual' },
    help: 'The camera narrows this list with the ND setting.',
    wire: { key: 'c.1.me.diaphragm' } },                                // XC5 p.129, list p.58 (sibling sample)
  { id: 'shutterMode', group: 'exposure', label: 'Shutter mode', type: 'enum', verify: true,
    options: [opt('auto', 'Auto'), opt('speed', 'Speed'), opt('slow', 'Slow'), opt('clearscan', 'Clear scan')],
    affects: ['shutterValue', 'clearScan'],
    wire: { key: 'c.1.me.shutter.mode' } },                             // XC5 p.130-131 (group-read)
  { id: 'shutterValue', role: 'shutter', group: 'exposure', label: 'Shutter', type: 'enum', operate: true, verify: true,
    options: SHUTTER.map((s) => opt(s, `1/${s}`)),
    wire: { key: 'c.1.me.shutter' } },                                  // XC5 p.131, list p.58 (sibling sample)
  { id: 'clearScan', group: 'exposure', label: 'Clear scan', type: 'range', range: range(59.94, 250.38, 0.01, ' Hz'),
    gate: { id: 'shutterMode', value: 'clearscan' },
    help: 'Limits depend on the system frequency; the camera rounds to its nearest step.',
    wire: { key: 'c.1.me.clearscan', scale: 100 } },                    // XC5 p.131: Hz×100, e.g. 5994…25038
  { id: 'aeFlickerReduction', group: 'exposure', label: 'Flicker reduction (auto)', type: 'enum',
    options: [opt('off', 'Off'), opt('auto', 'Auto')],
    wire: { key: 'c.1.ae.flickerreduct' } },                            // XC5 p.132
  { id: 'meFlickerReduction', group: 'exposure', label: 'Flicker reduction (manual)', type: 'enum',
    options: [opt('off', 'Off'), opt('auto', 'Auto')],
    wire: { key: 'c.1.me.flickerreduct' } },                            // XC5 p.132
  { id: 'gainMode', group: 'exposure', label: 'Gain mode', type: 'enum', operate: true, poll: 'fast',
    options: [opt('auto', 'Auto'), opt('manual', 'Manual')], affects: ['gainValue'],
    wire: { key: 'c.1.me.gain.mode' } },                                // XC5 p.132
  { id: 'gainValue', role: 'gain', group: 'exposure', label: 'Gain', type: 'range', operate: true, verify: true,
    range: range(-6, 33, 0.5, ' dB'), gate: { id: 'gainMode', value: 'manual' },
    wire: { key: 'c.1.me.gain', scale: 10 } },                          // XC5 p.133: dB×10, −60…330 (group-read)
  { id: 'aeGainLimit', group: 'exposure', label: 'AE gain limit', type: 'range', verify: true,
    range: range(0, 33, 0.5, ' dB'),
    wire: { key: 'c.1.ae.gainlimit.max', scale: 10 } },                 // XC5 p.133-134 (group-read)
  { id: 'meGainLimit', group: 'exposure', label: 'Gain limit (manual)', type: 'range', verify: true,
    range: range(-6, 33, 0.5, ' dB'),
    wire: { key: 'c.1.me.gainlimit.max', scale: 10 } },                 // XC5 p.134 (group-read)
  { id: 'ndFilter', role: 'nd', group: 'exposure', label: 'ND filter', type: 'enum', operate: true,
    options: [opt(0, 'Off'), opt(400, '1/4 (2 stops)'), opt(1600, '1/16 (4 stops)'), opt(6400, '1/64 (6 stops)')],
    affects: ['irisValue'],
    wire: { key: 'c.1.nd.filter' } },                                   // XC5 p.135

  // --- white balance -------------------------------------------------------------
  { id: 'whiteBalance', role: 'whiteBalanceMode', group: 'whiteBalance', label: 'White balance', type: 'enum', operate: true, poll: 'fast',
    options: [opt('auto', 'Auto'), opt('manual', 'Manual (R/B gain)'), opt('kelvin', 'Colour temp.'),
      opt('daylight', 'Daylight'), opt('tungsten', 'Tungsten'), opt('wb_a', 'Set A'), opt('wb_b', 'Set B')],
    affects: ['colorTemp', 'wbManualGain', 'wbColorCorrection'],
    wire: { key: 'c.1.wb' } },                                          // XC5 p.136
  { id: 'wbSetA', group: 'whiteBalance', label: 'One-shot WB → Set A', type: 'action', operate: true,
    affects: ['whiteBalance'],
    wire: { query: 'c.1.wb.action=one_shot_a' } },                      // XC5 p.136
  { id: 'wbSetB', group: 'whiteBalance', label: 'One-shot WB → Set B', type: 'action',
    affects: ['whiteBalance'],
    wire: { query: 'c.1.wb.action=one_shot_b' } },                      // XC5 p.136
  { id: 'colorTemp', role: 'colorTemp', group: 'whiteBalance', label: 'Colour temperature', type: 'range', operate: true,
    range: range(2000, 15000, 10, 'K'), gate: { id: 'whiteBalance', value: 'kelvin' },
    help: 'The camera has its own list of steps; the nearest one is used.',
    wire: { key: 'c.1.wb.kelvin', snap: true } },                       // XC5 p.136, p.59
  { id: 'wbManualGain', group: 'whiteBalance', label: 'Manual R/B gain', type: 'text',
    pattern: '^\\d{1,4}-\\d{1,4}$', maxLength: 9, gate: { id: 'whiteBalance', value: 'manual' },
    help: 'R-B, each 0–1023, e.g. 220-250.',
    wire: { key: 'c.1.wb.value', rbGain: true } },                      // XC5 p.136, p.59
  { id: 'wbColorCorrection', group: 'whiteBalance', label: 'Colour correction (CC)', type: 'range', range: range(-20, 20),
    help: '±5 in Daylight and Tungsten; not used in Manual.',
    wire: { key: 'c.1.wb.kelvin.cc' } },                                // XC5 p.136
  { id: 'wbResponse', group: 'whiteBalance', label: 'AWB response', type: 'range', range: range(0, 2),
    wire: { key: 'c.1.wb.resp' } },                                     // XC5 p.136
  { id: 'wbShiftR', group: 'whiteBalance', label: 'WB shift R', type: 'range', range: range(-50, 50),
    wire: { key: 'c.1.wb.shift.rgain' } },                              // XC5 p.142
  { id: 'wbShiftB', group: 'whiteBalance', label: 'WB shift B', type: 'range', range: range(-50, 50),
    wire: { key: 'c.1.wb.shift.bgain' } },                              // XC5 p.142

  // --- image ---------------------------------------------------------------------
  { id: 'customPicture', group: 'image', label: 'Custom picture', type: 'enum',
    options: [opt('normal1_bt709', 'Normal 1 / BT.709'), opt('normal1_bt2020', 'Normal 1 / BT.2020'),
      opt('widedr_bt709', 'Wide DR / BT.709'), opt('widedr_bt2020', 'Wide DR / BT.2020'),
      opt('clog3_bt2020', 'Canon Log 3 / BT.2020'), opt('clog3_bt709', 'Canon Log 3 / BT.709'), opt('off', 'Off')],
    affects: ['gamma', 'colorSpace', 'colorMatrix'],
    wire: { key: 'c.1.cp' } },                                          // XC5 p.137
  { id: 'gamma', group: 'image', label: 'Gamma', type: 'enum',
    options: [opt('normal1', 'Normal 1'), opt('normal2', 'Normal 2'), opt('normal3', 'Normal 3'), opt('normal4', 'Normal 4'),
      opt('widedr', 'Wide DR'), opt('clog3', 'Canon Log 3')],
    wire: { key: 'c.1.gamma' } },                                       // XC5 p.137
  { id: 'colorSpace', group: 'image', label: 'Colour space', type: 'enum',
    options: [opt('gamut_bt709', 'BT.709'), opt('gamut_bt2020', 'BT.2020')],
    wire: { key: 'c.1.colorspace' } },                                  // XC5 p.137
  { id: 'colorMatrix', group: 'image', label: 'Colour matrix', type: 'enum',
    options: [opt('video', 'Video'), opt('neutral', 'Neutral')],
    wire: { key: 'c.1.colormatrix' } },                                 // XC5 p.137
  { id: 'blackLevel', group: 'image', label: 'Master pedestal', type: 'range', range: range(-50, 50),
    wire: { key: 'c.1.blacklevel' } },                                  // XC5 p.138
  { id: 'blackLevelR', group: 'image', label: 'Master black R', type: 'range', range: range(-50, 50),
    wire: { key: 'c.1.blacklevel.red' } },                              // XC5 p.138
  { id: 'blackLevelB', group: 'image', label: 'Master black B', type: 'range', range: range(-50, 50),
    wire: { key: 'c.1.blacklevel.blue' } },                             // XC5 p.138
  { id: 'blackGamma', group: 'image', label: 'Black gamma level', type: 'range', range: range(-50, 50),
    wire: { key: 'c.1.blackgamma' } },                                  // XC5 p.138
  { id: 'blackGammaRange', group: 'image', label: 'Black gamma range', type: 'range', range: range(-20, 50),
    wire: { key: 'c.1.blackgamma.range' } },                            // XC5 p.138
  { id: 'blackGammaPoint', group: 'image', label: 'Black gamma point', type: 'range', range: range(-20, 50),
    wire: { key: 'c.1.blackgamma.point' } },                            // XC5 p.138-139
  { id: 'knee', group: 'image', label: 'Knee', type: 'bool',
    wire: { key: 'c.1.knee', ...onOff } },                              // XC5 p.139
  { id: 'kneeAutomatic', group: 'image', label: 'Knee automatic', type: 'bool',
    wire: { key: 'c.1.knee.automatic', ...onOff } },                    // XC5 p.139
  { id: 'kneeSlope', group: 'image', label: 'Knee slope', type: 'range', range: range(-35, 50),
    wire: { key: 'c.1.knee.slope' } },                                  // XC5 p.139
  { id: 'kneePoint', group: 'image', label: 'Knee point', type: 'range', range: range(50, 109),
    wire: { key: 'c.1.knee.point' } },                                  // XC5 p.139
  { id: 'kneeSaturation', group: 'image', label: 'Knee saturation', type: 'range', range: range(-10, 10),
    wire: { key: 'c.1.knee.saturation' } },                             // XC5 p.139
  { id: 'noiseReductionMode', group: 'image', label: 'Noise reduction mode', type: 'enum',
    options: [opt('auto', 'Auto'), opt('manual', 'Manual')], affects: ['noiseReduction'],
    wire: { key: 'c.1.nr.mode' } },                                     // XC5 p.139
  { id: 'noiseReduction', group: 'image', label: 'Noise reduction', type: 'range', range: range(0, 12),
    wire: { key: 'c.1.nr' } },                                          // XC5 p.139
  { id: 'sharpness', group: 'image', label: 'Sharpness', type: 'range', range: range(-10, 50),
    wire: { key: 'c.1.ac' } },                                          // XC5 p.140
  { id: 'sharpnessLimit', group: 'image', label: 'Sharpness limit', type: 'range', range: range(-50, 50),
    wire: { key: 'c.1.ac.limit' } },                                    // XC5 p.140
  { id: 'colorMatrixGain', group: 'image', label: 'Colour matrix gain', type: 'range', range: range(-50, 50),
    wire: { key: 'c.1.colormatrix.gain' } },                            // XC5 p.141
  { id: 'colorMatrixPhase', group: 'image', label: 'Colour matrix phase', type: 'range', range: range(-18, 18),
    wire: { key: 'c.1.colormatrix.phase' } },                           // XC5 p.141
  { id: 'colorMatrixRG', group: 'image', label: 'Colour matrix R-G', type: 'range', range: range(-50, 50),
    wire: { key: 'c.1.colormatrix.rg' } },                              // XC5 p.141
  { id: 'colorMatrixRB', group: 'image', label: 'Colour matrix R-B', type: 'range', range: range(-50, 50),
    wire: { key: 'c.1.colormatrix.rb' } },                              // XC5 p.142
  { id: 'colorMatrixGR', group: 'image', label: 'Colour matrix G-R', type: 'range', range: range(-50, 50),
    wire: { key: 'c.1.colormatrix.gr' } },                              // XC5 p.142
  { id: 'colorMatrixGB', group: 'image', label: 'Colour matrix G-B', type: 'range', range: range(-50, 50),
    wire: { key: 'c.1.colormatrix.gb' } },                              // XC5 p.142
  { id: 'colorMatrixBR', group: 'image', label: 'Colour matrix B-R', type: 'range', range: range(-50, 50),
    wire: { key: 'c.1.colormatrix.br' } },                              // XC5 p.142
  { id: 'colorMatrixBG', group: 'image', label: 'Colour matrix B-G', type: 'range', range: range(-50, 50),
    wire: { key: 'c.1.colormatrix.bg' } },                              // XC5 p.142
  { id: 'colorBars', group: 'image', label: 'Colour bars', type: 'bool', verify: true,
    help: 'Not listed for CR-N500 in the XC spec; hidden if the camera does not report it.',
    wire: { key: 'c.1.colorbar', ...onOff } },                          // CCP src/actions.js:2216-2227 (impl); XC5 p.135 absence — conflict
  { id: 'imageFlip', group: 'image', label: 'Image flip', type: 'enum', danger: 'admin',
    options: [opt(0, 'Standard'), opt(18000, 'Upside down (ceiling mount)')],
    help: 'An installation setting. Do not change during a show.',
    wire: { key: 'c.1.erotate' } },                                     // XC5 p.152

  // --- focus & zoom --------------------------------------------------------------
  { id: 'focusMode', role: 'focusMode', autoValue: 'auto', manualValue: 'manual',
    group: 'lens', label: 'Focus mode', type: 'enum', operate: true, poll: 'fast',
    options: [opt('auto', 'Auto'), opt('manual', 'Manual')], affects: ['focusPosition'],
    wire: { key: 'c.1.focus' } },                                       // XC5 p.145
  { id: 'onePushAf', role: 'onePushAf', group: 'lens', label: 'One-shot AF', type: 'action', operate: true,
    affects: ['focusPosition'],
    wire: { query: 'c.1.focus.action=one_shot' } },                     // XC5 p.145
  { id: 'focusPosition', group: 'lens', label: 'Focus position', type: 'range', range: range(0, 2048),
    gate: { id: 'focusMode', value: 'manual' },
    wire: { key: 'c.1.focus.value' } },                                 // XC5 p.145
  { id: 'focusLimit', group: 'lens', label: 'Focus limit', type: 'bool',
    wire: { key: 'c.1.focus.restrict', ...onOff } },                    // XC5 p.145
  { id: 'focusSpeed', group: 'lens', label: 'Manual focus speed', type: 'range', range: range(0, 2), verify: true,
    help: 'Also set by the focus control: its deflection picks the speed.',
    wire: { key: 'c.1.focus.speed' } },                                 // XC5 p.145-146 (group-read)
  { id: 'afMode', group: 'lens', label: 'AF mode', type: 'enum',
    options: [opt('continuous', 'Continuous'), opt('afboosted', 'AF-boosted MF')],
    wire: { key: 'c.1.focus.auto' } },                                  // XC5 p.146
  { id: 'afSpeed', group: 'lens', label: 'AF speed', type: 'range', range: range(0, 2),
    wire: { key: 'c.1.focus.auto.speed' } },                            // XC5 p.146
  { id: 'afResponse', group: 'lens', label: 'AF response', type: 'range', range: range(0, 2),
    wire: { key: 'c.1.focus.auto.resp' } },                             // XC5 p.147
  { id: 'afFrameSize', group: 'lens', label: 'AF frame size', type: 'enum',
    options: [opt('auto', 'Auto'), opt('large', 'Large'), opt('small', 'Small')],
    wire: { key: 'c.1.focus.frame.1' } },                               // XC5 p.146
  { id: 'afFrameX', group: 'lens', label: 'AF frame position X', type: 'range', range: range(0, 9999),
    wire: { key: 'c.1.focus.frame.1.x' } },                             // XC5 p.146
  { id: 'afFrameY', group: 'lens', label: 'AF frame position Y', type: 'range', range: range(0, 9999),
    wire: { key: 'c.1.focus.frame.1.y' } },                             // XC5 p.146
  { id: 'faceDetection', group: 'lens', label: 'Face detection AF', type: 'enum',
    options: [opt('off', 'Off'), opt('faceonly', 'Face only'), opt('facecatch', 'Face priority')],
    wire: { key: 'c.1.focus.detect' } },                                // XC5 p.146
  { id: 'afTracking', group: 'lens', label: 'AF subject tracking', type: 'bool',
    help: 'Keeps focus on a subject. Does not move the head.',
    wire: { key: 'c.1.focus.auto.track', ...onOff } },                  // XC5 p.146
  { id: 'afTrackingMode', group: 'lens', label: 'AF tracking mode', type: 'enum',
    options: [opt('mode1', 'AF frame at point'), opt('mode2', 'Track subject at point')],
    wire: { key: 'c.1.focus.auto.track.mode' } },                       // XC5 p.147
  { id: 'imageStabilizer', group: 'lens', label: 'Image stabiliser', type: 'enum',
    options: [opt('off', 'Off'), opt('on1', 'On (small shake)'), opt('on2', 'On (large shake)')],
    wire: { key: 'c.1.is' } },                                          // XC5 p.144-145
  { id: 'digitalZoomMode', group: 'lens', label: 'Digital zoom', type: 'enum',
    options: [opt('off', 'Off'), opt('dzoom', 'Digital zoom'), opt('mag', 'Digital teleconverter')],
    wire: { key: 'c.1.zoom.mode' } },                                   // XC5 p.148
  { id: 'teleconverter', group: 'lens', label: 'Digital teleconverter', type: 'enum',
    options: [opt(100, '1×'), opt(150, '1.5×'), opt(300, '3×'), opt(600, '6×')],
    wire: { key: 'c.1.zoom.mag' } },                                    // XC5 p.148-149: list in %

  // --- pan / tilt ----------------------------------------------------------------
  { id: 'home', role: 'home', group: 'ptz', label: 'Home (front, level)', type: 'action', operate: true, verify: true,
    help: 'No home command exists in XC; this drives to pan 0, tilt 0 at the camera\'s stored position speed. Zoom is left alone.',
    wire: { query: 'c.1.pan=0&c.1.tilt=0' } },                          // XC5 p.149/p.151 absolute; "home" = CCP src/actions.js:586 (impl)
  { id: 'panAcceleration', group: 'ptz', label: 'Pan acceleration', type: 'range', range: range(0, 2),
    wire: { key: 'c.1.pan.ramp' } },                                    // XC5 p.150
  { id: 'tiltAcceleration', group: 'ptz', label: 'Tilt acceleration', type: 'range', range: range(0, 2),
    wire: { key: 'c.1.tilt.ramp' } },                                   // XC5 p.152
  { id: 'headStatus', group: 'ptz', label: 'Pan/tilt head', type: 'enum', readOnly: true,
    options: [opt('initialized', 'Ready'), opt('uninitialized', 'Not initialised')],
    wire: { key: 'c.1.platform.status' } },                             // XC5 p.127
  { id: 'headError', group: 'ptz', label: 'Pan/tilt position error', type: 'enum', readOnly: true,
    options: [opt(0, 'None'), opt(1, 'Deviation detected')],
    wire: { key: 'c.1.platform.error' } },                              // XC5 p.127
  { id: 'headReinitialise', group: 'maintenance', label: 'Re-initialise pan/tilt head', type: 'action',
    danger: 'admin', verify: true,
    help: 'The head drives through its full travel to find its limits. Clear the space around it first.',
    wire: { path: 'maintain?cmd=platform_reset' } },                    // CCP src/actions.js:597-599 (impl; not in XC5)

  // --- tally ---------------------------------------------------------------------
  { id: 'tallyLamp', role: 'tally', group: 'tally', label: 'Tally lamp', type: 'bool', poll: 'fast',
    help: 'Also driven by CamBridge tally.',
    wire: { key: 'f.tally', ...onOff } },                               // XC5 p.155
  { id: 'tallyMode', group: 'tally', label: 'Tally lamp mode', type: 'enum', poll: 'fast',
    options: [opt('program', 'Program'), opt('preview', 'Preview')],
    wire: { key: 'f.tally.mode' } },                                    // XC5 p.155

  // --- video output / streaming (read-only in XC) --------------------------------
  { id: 'outputFormat', group: 'videoOut', label: 'Output format', type: 'text', readOnly: true, poll: 'once',
    help: 'width×height : frames per 1000 s : scan.',
    wire: { key: 'f.output1.videoinfo' } },                             // XC5 p.156, p.65
  { id: 'maxPictureSize', group: 'videoOut', label: 'System resolution', type: 'text', readOnly: true,
    wire: { key: 's.maxsize' } },                                       // XC5 p.125
  { id: 'videoStreams', group: 'streaming', label: 'Video streams', type: 'text', readOnly: true, poll: 'once',
    wire: { key: 'v.list' } },                                          // XC5 p.126-127

  // --- tracking: the RA-AT001 add-on, only when identify() finds it --------------
  // All impl-only (CCP src/tracking.js, src/actions.js), so all verify: true.
  { id: 'autoTracking', role: 'trackingEnabled', group: 'tracking', label: 'Auto tracking', type: 'bool', operate: true, poll: 'fast',
    requires: 'tracking', verify: true,
    help: 'The camera moves the head by itself while this is on.',
    wire: { addon: 'trackingEnable', on: '1', off: '0' } },            // CCP src/actions.js:3304-3315
  { id: 'trackingAutoZoom', group: 'tracking', label: 'Auto zoom', type: 'bool', requires: 'tracking', verify: true,
    wire: { addon: 'autoZoomEnable', on: '1', off: '0' } },            // CCP src/actions.js:3342-3353
  { id: 'trackingSensitivity', group: 'tracking', label: 'Tracking sensitivity', type: 'range', range: range(1, 10),
    requires: 'tracking', verify: true,
    wire: { addon: 'sensitivity' } },                                   // CCP src/actions.js:3402-3405 (1-10)
  { id: 'trackingTiltFixed', group: 'tracking', label: 'Fix tilt', type: 'bool', requires: 'tracking', verify: true,
    wire: { addon: 'tiltFixed', on: '1', off: '0' } },                 // CCP src/actions.js:3463
  { id: 'trackingLost', group: 'tracking', label: 'When the subject is lost', type: 'enum',
    requires: 'tracking', verify: true,
    options: [opt('0', 'Hold position'), opt('1', 'Return to home position')],
    wire: { addon: 'recoveryControl' } },                               // CCP src/actions.js:3503-3521
  { id: 'trackingTargetSize', group: 'tracking', label: 'Target size', type: 'range', range: range(1, 5),
    requires: 'tracking', verify: true,
    wire: { addon: 'targetSizeLevel' } },                               // CCP src/actions.js:4455-4460 (1-5)
];

/** What the CR-N500's web UI does that XC has no command for. */
export const GAPS = [
  'Network: IP address, DHCP, ports, HTTPS — settings protocol only, not XC',
  'Users and passwords, guest/authorised privileges — settings protocol only',
  'Firmware update, reboot, factory reset — settings protocol only',
  'Streaming: RTSP/RTP, RTMP(S), SRT, NDI|HX, FreeD configuration — settings protocol only (XC exposes stream parameters read-only)',
  'Video output format/resolution change — read-only in XC',
  'Audio settings — XC reports no audio device on CR-N500',
  'Serial number — no XC parameter',
  'Preset thumbnails and preset content flags per category — not offered here (presets store PTZ + focus)',
  'Traces (10 recorded PTZ paths) — XC has them (trace/set, trace/control); no CamBridge UI for them yet',
  'Pan/tilt speed mode (manual/auto1/auto2) — a per-session item in XC, so it is not a readable setting; the driver sends it with every move instead',
  'ND filter mode, monitoring assist, user LUT, look files — not supported on CR-N500 per XC5 Table A-1, or a single fixed value',
  'Tracking add-on: visibility limits, home position, target selection, halting area, restart and start time — CGI names known from CCP only, value formats unknown',
];

export default TABLE;
