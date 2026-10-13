// PTZOptics Move SE (12X / 20X / 30X) parameter table.
//
// From the spec notes (specs/ptzoptics-move-se.md). Their source keys:
//   HTTP-PDF   PTZOptics HTTP API (2026), with a per-command model list
//   VISCA-PDF  PTZOptics VISCA API (2026), not model-scoped
//   FW-*       Move SE firmware changelogs; MSE-* Move SE pages; GEN3-UI family web UI
//   COMP       Bitfocus companion-module-ptzoptics-visca (implementation only)
//
// Which transport for what:
// - **Writes go over CGI** where HTTP-PDF lists Move SE for the command
//   ("SE+"): the brief's rule, and the only per-model scoping any source has.
// - **Reads use VISCA inquiries** where VISCA-PDF documents one (model-agnostic
//   but vendor-written), because every CGI query (`get_image_conf`,
//   `get_advance_image_conf`, `get_media_video`, ...) is documented for Move
//   4K / Link 4K only, never for the SE (notes §2.4, Gaps 2). Rows that can
//   only be read through such a query carry `verify: true`; if the SE turns
//   out not to have it, the driver reports the value as unknown (null) and
//   the setting stays writable, rather than hiding a control that works.
// - Conflicts between documents are `verify: true`, with the SE-documented
//   option chosen and the reason in a comment.
//
// Enum option values are the vendor's wire codes (numbers that mean nothing
// on their own); the labels are what the web UI shows.
//
// wire (private, read by drivers/ptzoptics.js):
//   read   { visca: bytes, dec(reply) }      a VISCA inquiry
//          { conf: 'image'|'video'|'audio'|'device'|'ir', key, dec(string) }
//          { api: path, dec(json) }          the newer JSON API
//          { local: 'model'|'firmware'|'serial' }
//   write  { method, path(value) }           one HTTP request
//          { visca(value) -> bytes }         a VISCA command
//          { focusRange: 'enable'|'near'|'far' } (three values, one request)
//          { tracking: true }                CGI, with the VISCA form as fallback
//   act    for actions: { method, path } or { visca: bytes }

const opts = (pairs) => pairs.map(([value, label]) => ({ value, label }));
const num = (s) => Number(s);
const on2 = (s) => Number(s) === 2;          // 2 = on, 3 = off (HTTP-PDF on/off pairs)
const one = (s) => Number(s) === 1;

/** `GET /cgi-bin/ptzctrl.cgi?post_image_value&<key>&<value>` — GET despite the name (notes §2.4). */
const image = (key, enc = (v) => String(v)) => ({
  method: 'GET', path: (v) => `/cgi-bin/ptzctrl.cgi?post_image_value&${key}&${encodeURIComponent(enc(v))}`,
});
/** `POST /cgi-bin/param.cgi?post_media_video&<key>&<value>`, empty body (HTTP-PDF p.257-285). */
const video = (key, enc = (v) => String(v)) => ({
  method: 'POST', path: (v) => `/cgi-bin/param.cgi?post_media_video&${key}&${encodeURIComponent(enc(v))}`,
});
/** `POST /cgi-bin/param.cgi?<cgi>&<key>=<value>`, empty body (HTTP-PDF network / audio / NDI sections). */
const post = (cgi, key, enc = (v) => String(v)) => ({
  method: 'POST', path: (v) => `/cgi-bin/param.cgi?${cgi}&${key}=${encodeURIComponent(enc(v))}`,
});

/** VISCA inquiry reading `90 50 0p FF` as the code p. */
const vByte = (b) => ({ visca: [0x81, 0x09, 0x04, b, 0xff], dec: (r) => r[2] });
/** VISCA inquiry reading `90 50 00 00 0p 0q FF` as pq. */
const vPQ = (b, f = (n) => n) => ({ visca: [0x81, 0x09, 0x04, b, 0xff], dec: (r) => f(((r[4] & 0x0f) << 4) | (r[5] & 0x0f)) });
/** A key in a `get_*` query reply — Move 4K / Link 4K only in HTTP-PDF. */
const key = (conf, k, dec = num) => ({ conf, key: k, dec });

// SE iris table (HTTP-PDF p.54-55, SE+; COMP src/camera/exposure.ts:62-119 maps
// VISCA identically). The Move 4K uses a different 0-12 table.
const IRIS = [[0, 'Closed'], [6, 'F11.0'], [7, 'F9.6'], [8, 'F8.0'], [9, 'F6.8'], [10, 'F5.6'], [11, 'F4.8'],
  [12, 'F4.0'], [13, 'F3.4'], [14, 'F2.8'], [15, 'F2.4'], [16, 'F2.0'], [17, 'F1.8']];
// SE / Studio shutter table (HTTP-PDF p.62-63, SE+). COMP's table is the Move
// 4K's (1/30, 1/60, 1/90 ...), hence verify.
const SHUTTER = ['1/30', '1/50', '1/60', '1/100', '1/125', '1/200', '1/250', '1/350', '1/500', '1/725',
  '1/1000', '1/1500', '1/2000', '1/3000', '1/4000', '1/6000', '1/10000'];
const STREAM1_SIZES = [['PIC_HD1080', '1920×1080'], ['PIC_HD720', '1280×720'], ['PIC_HD576', '1024×576'],
  ['PIC_960_540', '960×540'], ['PIC_D1', '720×480'], ['PIC_720_408', '720×408'], ['PIC_VGA', '640×480'],
  ['PIC_640_360', '640×360']];
const STREAM2_SIZES = [['PIC_HD720', '1280×720'], ['PIC_D1', '720×480'], ['PIC_720_408', '720×408'],
  ['PIC_VGA', '640×480'], ['PIC_640_360', '640×360'], ['PIC_480_320', '480×320'], ['PIC_QVGA', '320×240']];
const IPV4 = '^(\\d{1,3})(\\.\\d{1,3}){3}$';

export const TABLE = [
  // --- exposure -------------------------------------------------------------
  { id: 'exposureMode', group: 'exposure', label: 'Exposure mode', type: 'enum', operate: true, poll: 'fast',
    affects: ['iris', 'shutter', 'gainManual'],
    options: opts([[0, 'Auto'], [3, 'Manual'], [10, 'Shutter priority'], [11, 'Iris priority'], [13, 'Bright']]),
    wire: { read: vByte(0x39), write: image('aemode') } },              // HTTP-PDF p.44 (SE+); VISCA-PDF p.9,20; COMP exposure.ts:13 — Bright back on SE since FW-0112
  { id: 'expCompMode', group: 'exposure', label: 'Exposure compensation', type: 'bool',
    gate: { id: 'exposureMode', value: 0 },
    wire: { read: { ...vByte(0x3e), dec: (r) => r[2] === 0x02 }, write: image('expcomp_mode', (v) => (v ? 2 : 3)) } }, // HTTP-PDF p.42 (SE+); VISCA-PDF p.10,20
  { id: 'expCompLevel', group: 'exposure', label: 'Exposure compensation level', type: 'range', verify: true,
    range: { min: -7, max: 7, step: 1 }, gate: { id: 'expCompMode', value: true },
    wire: { read: key('image', 'expcomp_level', (s) => Number(s) - 7), write: image('expcomp_level', (v) => v + 7) } }, // HTTP-PDF p.40 (SE+): 0..14 = -7..+7; read key 4K only
  // Backlight: HTTP-PDF's text says 1 Off / 2 On / 3 Enhanced, its schema says
  // 2 On / 3 Off; the schema matches VISCA 02/03, so that is used (conflict).
  { id: 'backlight', group: 'exposure', label: 'Backlight compensation', type: 'bool', verify: true,
    gate: { id: 'exposureMode', value: 0 },
    wire: { read: { ...vByte(0x33), dec: (r) => r[2] === 0x02 }, write: image('backlight', (v) => (v ? 2 : 3)) } }, // HTTP-PDF p.38 (SE+); VISCA-PDF p.11,21
  { id: 'antiFlicker', group: 'exposure', label: 'Anti-flicker', type: 'enum',
    options: opts([[0, 'Off'], [1, '50 Hz'], [2, '60 Hz']]),
    wire: { read: vByte(0x55), write: image('antiflicker') } },        // HTTP-PDF p.46 (SE+); VISCA-PDF p.12,21
  { id: 'gainLimit', group: 'exposure', label: 'Gain limit', type: 'range', verify: true, range: { min: 0, max: 15, step: 1 },
    wire: { read: key('image', 'gain_limit'), write: image('gainLimit') } }, // HTTP-PDF p.48 (SE+)
  // Manual gain: the CGI form (0-7, SE+) is used; VISCA-PDF prints the direct
  // command with the Reset/Up/Down opcode 0C, probably a typo (conflict).
  { id: 'gainManual', group: 'exposure', label: 'Gain', type: 'range', operate: true, verify: true, role: 'gain',
    range: { min: 0, max: 7, step: 1 }, gate: { id: 'exposureMode', value: 3 },
    wire: { read: key('image', 'manual_gain'), write: image('gain') } },  // HTTP-PDF p.50 (SE+); VISCA-PDF p.10
  { id: 'meterRegion', group: 'exposure', label: 'Metering', type: 'enum', verify: true,
    options: opts([[0, 'Average'], [1, 'Center'], [2, 'Smart'], [3, 'Top']]),
    wire: { read: key('image', 'meter'), write: image('meter') } },      // HTTP-PDF p.56 (SE+)
  { id: 'drc', group: 'exposure', label: 'DRC', type: 'range', verify: true, range: { min: 0, max: 8, step: 1 },
    wire: { read: key('image', 'drc'), write: image('drc') } },          // HTTP-PDF p.58 (SE+)
  { id: 'iris', group: 'exposure', label: 'Iris', type: 'enum', operate: true, role: 'iris',
    help: 'Manual and iris-priority exposure only.',
    options: opts(IRIS),
    wire: { read: vPQ(0x4b), write: image('iris') } },                   // HTTP-PDF p.54 (SE+); VISCA-PDF p.9,22; COMP exposure.ts:62
  { id: 'shutter', group: 'exposure', label: 'Shutter', type: 'enum', operate: true, verify: true, role: 'shutter',
    help: 'Manual and shutter-priority exposure only.',
    options: SHUTTER.map((label, i) => ({ value: i + 1, label })),
    wire: { read: key('image', 'shutter'), write: image('shutter') } },  // HTTP-PDF p.62 (SE+) vs COMP (4K table): conflict; VISCA shutter opcodes misprinted in VISCA-PDF p.10

  // --- white balance --------------------------------------------------------
  { id: 'wbMode', group: 'whiteBalance', label: 'White balance', type: 'enum', operate: true, poll: 'fast',
    role: 'whiteBalanceMode', affects: ['redGain', 'blueGain', 'colorTemp'],
    options: opts([[0, 'Auto'], [1, 'Indoor'], [2, 'Outdoor'], [3, 'One push'], [5, 'Manual'], [32, 'Colour temperature']]),
    wire: { read: vByte(0x35), write: image('wbmode') } },               // HTTP-PDF p.35 (SE+); VISCA-PDF p.7,20; COMP white-balance.ts:14
  { id: 'wbOnePush', group: 'whiteBalance', label: 'One-push white balance', type: 'action', operate: true,
    help: 'One-push mode only.',
    wire: { act: { method: 'GET', path: '/cgi-bin/ptzctrl.cgi?post_image_value&onepush&0' } } }, // HTTP-PDF p.29 (SE+)
  { id: 'redGain', group: 'whiteBalance', label: 'Red gain', type: 'range', verify: true,
    range: { min: 0, max: 255, step: 1 }, gate: { id: 'wbMode', value: 5 },
    wire: { read: vPQ(0x43), write: image('rgain') } },                  // HTTP-PDF p.31 (SE+); VISCA-PDF p.7,22 (VISCA range not stated)
  { id: 'blueGain', group: 'whiteBalance', label: 'Blue gain', type: 'range', verify: true,
    range: { min: 0, max: 255, step: 1 }, gate: { id: 'wbMode', value: 5 },
    wire: { read: vPQ(0x44), write: image('bgain') } },                  // HTTP-PDF p.20 (SE+); VISCA-PDF p.8,22
  { id: 'colorTemp', group: 'whiteBalance', label: 'Colour temperature', type: 'range', operate: true, verify: true,
    role: 'colorTemp', range: { min: 2500, max: 8000, step: 100, unit: 'K' }, gate: { id: 'wbMode', value: 32 },
    wire: { read: key('image', 'temperature', (s) => 2500 + 100 * Number(s)), write: image('colortemp', (v) => Math.round((v - 2500) / 100)) } }, // HTTP-PDF p.24-27 (SE+): n = 2500 + 100n K
  { id: 'redTuning', group: 'whiteBalance', label: 'Red fine tune', type: 'range', range: { min: -10, max: 10, step: 1 },
    wire: { read: vPQ(0x12, (n) => n - 10), write: image('rgaintuning', (v) => v + 10) } }, // HTTP-PDF p.33 (SE+); VISCA-PDF p.8,22
  { id: 'blueTuning', group: 'whiteBalance', label: 'Blue fine tune', type: 'range', range: { min: -10, max: 10, step: 1 },
    wire: { read: vPQ(0x13, (n) => n - 10), write: image('bgaintuning', (v) => v + 10) } }, // HTTP-PDF p.22 (SE+); VISCA-PDF p.8,22
  { id: 'awbSensitivity', group: 'whiteBalance', label: 'AWB sensitivity', type: 'enum', writeOnly: true,
    options: opts([[0, 'High'], [1, 'Normal'], [2, 'Low']]),
    wire: { write: { visca: (v) => [0x81, 0x01, 0x04, 0xa9, v, 0xff] } } }, // VISCA-PDF p.17; COMP white-balance.ts:50

  // --- image ----------------------------------------------------------------
  { id: 'luminance', group: 'image', label: 'Luminance', type: 'range', verify: true, range: { min: 0, max: 14, step: 1 },
    wire: { read: key('image', 'luminance'), write: image('luminance') } }, // HTTP-PDF p.84 (SE+)
  { id: 'contrast', group: 'image', label: 'Contrast', type: 'range', verify: true, range: { min: 0, max: 14, step: 1 },
    wire: { read: key('image', 'contrast'), write: image('contrast') } }, // HTTP-PDF p.80 (SE+)
  { id: 'saturation', group: 'image', label: 'Saturation', type: 'range', verify: true, range: { min: 0, max: 14, step: 1 },
    help: 'HTTP API: 0 = 60 %, 4 = 100 %, 14 = 200 %. The SE pages say 20–200 %; check on the camera.',
    wire: { read: key('image', 'saturation'), write: image('saturation') } }, // HTTP-PDF p.86 (SE+) vs MSE-IMG: conflict
  { id: 'hue', group: 'image', label: 'Hue', type: 'range', verify: true, range: { min: 0, max: 14, step: 1 },
    wire: { read: key('image', 'hue'), write: image('hue') } },          // HTTP-PDF p.82 (SE+)
  { id: 'sharpness', group: 'image', label: 'Sharpness', type: 'range', verify: true, range: { min: 0, max: 16, step: 1 },
    help: 'The SE/Studio HTTP form is 0–16; the web UI pages say 0–11.',
    wire: { read: key('image', 'sharpness'), write: image('sharpness') } }, // HTTP-PDF p.90 (SE+) vs MSE-IMG / GEN3-UI: conflict
  { id: 'blackWhite', group: 'image', label: 'Black & white', type: 'bool',
    wire: { read: { visca: [0x81, 0x09, 0x04, 0x63, 0xff], dec: (r) => r[2] === 0x04 }, write: image('bwmode', (v) => (v ? 1 : 0)) } }, // HTTP-PDF p.101 (SE+); VISCA-PDF p.16,21
  { id: 'imageOrientation', group: 'image', label: 'Flip / mirror', type: 'enum', verify: true,
    options: opts([[0, 'Off'], [1, 'Flip'], [2, 'Mirror'], [3, 'Flip + mirror']]),
    wire: { read: key('image', 'imageOrientation'), write: image('imageorientation') } }, // HTTP-PDF p.107 (SE+)
  { id: 'autoInversion', group: 'image', label: 'Auto inversion (ceiling)', type: 'bool', verify: true,
    wire: { read: key('image', 'inversionMode', (s) => Number(s) === 2), write: image('inversionmode', (v) => (v ? 2 : 0)) } }, // HTTP-PDF p.97 (SE+): [2, 0]
  { id: 'noise2d', group: 'image', label: '2D noise reduction', type: 'enum', verify: true,
    options: opts([[0, 'Off'], [1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, 'Auto']]),
    wire: { read: key('image', 'nr2d'), write: image('noise2d') } },     // HTTP-PDF p.93 (SE+)
  { id: 'noise3d', group: 'image', label: '3D noise reduction', type: 'enum', verify: true,
    options: opts([[0, 'Off'], ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, String(n)]), [9, 'Auto']]),
    wire: { read: key('image', 'nr3d'), write: image('noise3d') } },     // HTTP-PDF p.95 (SE+) and MSE-IMG agree; GEN3-UI says 1-5: conflict
  { id: 'digitalZoom', group: 'image', label: 'Zoom mode', type: 'enum', verify: true,
    options: opts([[0, 'Optical'], [1, 'Digital 2×'], [2, 'Digital 4×'], [3, 'Digital 8×'], [4, 'Digital 16×']]),
    wire: { read: key('image', 'digitalzoom'), write: image('digitalzoom') } }, // HTTP-PDF p.121 (SE+)
  { id: 'freeze', group: 'image', label: 'Freeze picture', type: 'bool', writeOnly: true,
    wire: { write: { visca: (v) => [0x81, 0x01, 0x04, 0x62, v ? 0x02 : 0x03, 0xff] } } }, // VISCA-PDF p.16

  // --- focus & zoom ---------------------------------------------------------
  // Focus mode: HTTP-PDF's text lists 1 AF / 2 one-shot / 3 MF but its schema
  // is [2, 3] with 2 = AF, 3 = MF, matching VISCA 02/03 (conflict; the schema
  // and VISCA win). One-shot AF is the separate snapFocus action.
  { id: 'focusMode', group: 'lens', label: 'Focus mode', type: 'enum', operate: true, poll: 'fast', verify: true,
    role: 'focusMode', autoValue: 2, manualValue: 3,
    options: opts([[2, 'Auto'], [3, 'Manual']]),
    wire: { read: vByte(0x38), write: image('focusmode') } },           // HTTP-PDF p.73 (SE+); VISCA-PDF p.13,19; COMP focus.ts:9
  { id: 'snapFocus', group: 'lens', label: 'One-shot AF', type: 'action', operate: true, role: 'onePushAf',
    wire: { act: { method: 'GET', path: '/cgi-bin/param.cgi?set_focus&one_shot_focus' } } }, // HTTP-PDF p.138 (SE+)
  { id: 'afZone', group: 'lens', label: 'AF zone', type: 'enum', verify: true,
    options: opts([[0, 'Top'], [1, 'Center'], [2, 'Bottom'], [3, 'Front']]),
    wire: { read: key('image', 'focus_zone'), write: image('focusregion') } }, // HTTP-PDF p.67 (SE+)
  { id: 'afSensitivity', group: 'lens', label: 'AF sensitivity', type: 'enum', verify: true,
    options: opts([[1, 'High'], [2, 'Normal'], [3, 'Low']]),
    wire: { read: key('image', 'focus_sens'), write: image('focussense') } }, // HTTP-PDF p.75 (SE+)
  { id: 'focusLock', group: 'lens', label: 'Focus lock', type: 'bool', verify: true,
    wire: { read: key('image', 'focus_mode_status', (s) => s === 'lock'),
      write: { method: 'GET', path: (v) => `/cgi-bin/param.cgi?ptzcmd&${v ? 'lock_mfocus' : 'unlock_mfocus'}` } } }, // HTTP-PDF p.71 (SE+)
  { id: 'focusLimit', group: 'lens', label: 'Focus range limit', type: 'bool', verify: true,
    wire: { read: key('image', 'focuslimit', (s) => Number(s) === 1), write: { focusRange: 'enable' } } }, // HTTP-PDF p.69 (SE+)
  { id: 'focusLimitNear', group: 'lens', label: 'Focus limit: nearest', type: 'range', verify: true,
    range: { min: 0, max: 11, step: 1, unit: ' m' }, gate: { id: 'focusLimit', value: true },
    wire: { read: key('image', 'nearestpos'), write: { focusRange: 'near' } } }, // HTTP-PDF p.69 (SE+)
  { id: 'focusLimitFar', group: 'lens', label: 'Focus limit: furthest', type: 'range', verify: true,
    range: { min: 0, max: 11, step: 1, unit: ' m' }, gate: { id: 'focusLimit', value: true }, help: '11 = infinity.',
    wire: { read: key('image', 'furthestpos'), write: { focusRange: 'far' } } }, // HTTP-PDF p.69 (SE+)

  // --- pan / tilt -----------------------------------------------------------
  { id: 'home', group: 'ptz', label: 'Home', type: 'action', operate: true, role: 'home',
    wire: { act: { visca: [0x81, 0x01, 0x06, 0x04, 0xff] } } },          // VISCA-PDF p.26; COMP pan-tilt.ts:71
  { id: 'panTiltReset', group: 'ptz', label: 'Pan / tilt recalibrate', type: 'action', danger: 'admin',
    help: 'The head moves through its whole range, and pan/tilt limits are cleared.',
    wire: { act: { method: 'GET', path: '/cgi-bin/param.cgi?pan_tiltdrive_reset' } } }, // HTTP-PDF p.128 (SE+); MSE-PTLIM
  { id: 'ptLimits', group: 'ptz', label: 'Pan / tilt limits', type: 'text', readOnly: true,
    help: 'Set them with the PTZOptics tools; firmware 12X 9.1.66 / 20X 9.1.44 / 30X 9.1.46 or later reports them.',
    wire: { read: { api: '/api/v1/info/pt-limit',
      dec: (j) => `pan ${j.panMin}° to ${j.panMax}°, tilt ${j.tiltMin}° to ${j.tiltMax}°` } } }, // FW-0930
  { id: 'motionSync', group: 'ptz', label: 'Motion sync', type: 'bool', verify: true,
    wire: { read: key('image', 'motionsync', on2), write: image('motionsync', (v) => (v ? 2 : 3)) } }, // HTTP-PDF p.109 (SE+)
  { id: 'presetFreeze', group: 'presets', label: 'Freeze picture during recall', type: 'bool', verify: true,
    wire: { read: key('image', 'presetfreeze', on2), write: image('presetfreeze', (v) => (v ? 2 : 3)) } }, // HTTP-PDF p.113 (SE+)
  { id: 'presetTour', group: 'presets', label: 'Preset tour', type: 'bool', verify: true,
    help: 'Moves the head from preset to preset on its own.',
    wire: { read: key('image', 'presetinspection', on2), write: image('presetinspection', (v) => (v ? 2 : 3)) } }, // HTTP-PDF p.111 (SE+)
  { id: 'displayInfo', group: 'videoOut', label: 'Show info on output', type: 'bool', writeOnly: true,
    wire: { write: image('displayinfo', (v) => (v ? 2 : 3)) } },         // HTTP-PDF p.105 (SE+)
  { id: 'power', group: 'system', label: 'Power', type: 'enum', danger: 'admin',
    options: opts([[2, 'On'], [3, 'Standby']]),
    wire: { read: vByte(0x00), write: { visca: (v) => [0x81, 0x01, 0x04, 0x00, v, 0xff] } } }, // VISCA-PDF p.19; COMP power.ts:11

  // --- tracking -------------------------------------------------------------
  // On/off over CGI (HTTP-PDF p.99, SE+). The VISCA form 81 0A 11 54 0p FF is
  // implementation-only (COMP auto-tracking.ts:11, citing a G3 PDF that could
  // not be read), so it is only a fallback if the CGI is missing. Reading the
  // state uses get_advance_image_conf `autotrack`, a 4K/Link-only query.
  { id: 'autoTracking', group: 'tracking', label: 'Auto tracking', type: 'bool', operate: true, poll: 'fast',
    requires: 'tracking', verify: true, role: 'trackingEnabled',
    wire: { read: key('image', 'autotrack', one), write: { tracking: true } } },
  { id: 'trackStart', group: 'tracking', label: 'Tracking start location', type: 'text', requires: 'tracking', verify: true,
    pattern: '^(live|home|0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-4])$',
    help: '"live" (Track now), "home", or a preset number.',
    wire: { read: key('image', 'trackstart', String), write: image('trackpreset') } }, // HTTP-PDF p.119 (SE+)
  { id: 'trackingOverlay', group: 'tracking', label: 'Tracking box in picture', type: 'bool', writeOnly: true,
    requires: 'tracking',
    wire: { write: image('trackingoverlay', (v) => (v ? 1 : 0)) } },    // HTTP-PDF p.117 (Move SE only)
  ...[['Left', 0x02, 'Track subject to the left'], ['Right', 0x03, 'Track subject to the right'],
    ['Confirm', 0x04, 'Confirm tracked subject']].map(([k, p, label]) => ({
    id: `trackSubject${k}`, group: 'tracking', label, type: 'action', operate: true, requires: 'tracking',
    wire: { act: { visca: [0x81, 0x0a, 0x11, 0xa3, p, 0xff] } },        // FW-0213, FW-0112 (12X 9.1.43+ / 20X 9.1.32+ / 30X 9.1.34+)
  })),

  // --- video ----------------------------------------------------------------
  { id: 'videoOutputs', group: 'videoOut', label: 'Simultaneous outputs', type: 'enum', danger: 'reconnect', writeOnly: true,
    options: opts([['all-30fps', 'USB / IP / HDMI-SDI at 30 fps'], ['USB_IP', 'USB + IP'],
      ['USB_HDMI-SDI', 'USB + HDMI/SDI'], ['HDMI-SDI_IP', 'HDMI/SDI + IP']]),
    wire: { write: video('video_ability') } },                           // HTTP-PDF p.282 (SE+)
  { id: 'refreshRate', group: 'videoOut', label: 'Frame rate family', type: 'enum', danger: 'admin', verify: true,
    options: opts([['50', '50 Hz'], ['60', '60 Hz'], ['dial', 'Follow the dial']]),
    wire: { read: key('video', 'vinorm', String), write: video('vinorm') } }, // HTTP-PDF p.263 (SE+)
  { id: 'encodeProfile', group: 'streaming', label: 'Encoding profile', type: 'enum', verify: true,
    options: opts([['highprofile', 'High'], ['mainprofile', 'Main'], ['baseline', 'Baseline']]),
    wire: { read: key('video', 'profile', String), write: video('profile') } }, // HTTP-PDF p.259 (SE+)
  { id: 'ndiMode', group: 'streaming', label: 'Video template (NDI)', type: 'enum', danger: 'reconnect', verify: true,
    options: opts([['off', 'Off'], ['ultra', 'Ultra'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]),
    wire: { read: key('video', 'ndi_mode', String), write: video('ndi_mode') } }, // HTTP-PDF p.284 (SE+)
  ...[1, 2].flatMap((n) => [
    { id: `stream${n}Codec`, group: 'streaming', label: `Stream ${n} codec`, type: 'enum', verify: true,
      options: opts([['H264', 'H.264'], ['H265', 'H.265']]),
      wire: { read: key('video', `protocol_${n}`, String), write: video(`protocol_${n}`) } }, // HTTP-PDF p.269 (SE+, H264/H265 only)
    { id: `stream${n}Size`, group: 'streaming', label: `Stream ${n} resolution`, type: 'enum', verify: true,
      options: opts(n === 1 ? STREAM1_SIZES : STREAM2_SIZES),
      wire: { read: key('video', `size_${n}`, String), write: video(`size_${n}`) } }, // HTTP-PDF p.277 (SE+)
    { id: `stream${n}Bitrate`, group: 'streaming', label: `Stream ${n} bit rate`, type: 'range', verify: true,
      range: { min: 32, max: n === 1 ? 102400 : 20480, step: 1, unit: ' kbps' },
      wire: { read: key('video', `bps_${n}`), write: video(`bps_${n}`) } }, // HTTP-PDF p.267; GEN3-UI (stream 2 max)
    { id: `stream${n}Fps`, group: 'streaming', label: `Stream ${n} frame rate`, type: 'range', verify: true,
      range: { min: 1, max: 60, step: 1, unit: ' fps' },
      wire: { read: key('video', `fps_${n}`), write: video(`fps_${n}`) } }, // HTTP-PDF p.271 (SE+)
    { id: `stream${n}Gop`, group: 'streaming', label: `Stream ${n} I-frame interval`, type: 'range', verify: true,
      range: { min: 1, max: 1200, step: 1 },
      wire: { read: key('video', `gop_${n}`), write: video(`gop_${n}`) } }, // HTTP-PDF p.273 (SE+)
  ]),
  { id: 'rtmp1Enable', group: 'streaming', label: 'RTMP stream 1', type: 'bool', writeOnly: true,
    wire: { write: post('post_network_other_conf', 'rtmp1_en', (v) => (v ? 1 : 0)) } }, // HTTP-PDF p.220 (SE+)
  { id: 'rtmp1Url', group: 'streaming', label: 'RTMP stream 1 URL', type: 'text', writeOnly: true, maxLength: 512,
    wire: { write: post('post_network_other_conf', 'rtmp1_mrl') } },    // HTTP-PDF p.224 (SE+)
  { id: 'rtmp1Key', group: 'streaming', label: 'RTMP stream 1 key', type: 'text', writeOnly: true, secret: true, danger: 'admin',
    wire: { write: post('post_network_other_conf', 'rtmp1_key') } },    // HTTP-PDF p.222 (SE+)
  { id: 'srtEnable', group: 'streaming', label: 'SRT', type: 'bool', writeOnly: true,
    wire: { write: post('post_network_other_conf', 'srt_en', (v) => (v ? 1 : 0)) } }, // HTTP-PDF p.232 (SE+)
  { id: 'srtMode', group: 'streaming', label: 'SRT mode', type: 'enum', writeOnly: true,
    options: opts([['caller', 'Caller'], ['listener', 'Listener']]),
    wire: { write: post('post_network_other_conf', 'srt_mode') } },     // HTTP-PDF p.238 (SE+)
  { id: 'srtPort', group: 'streaming', label: 'SRT port', type: 'range', writeOnly: true, range: { min: 1025, max: 65535, step: 1 },
    wire: { write: post('post_network_other_conf', 'srt_port') } },     // HTTP-PDF p.242 (SE+)
  { id: 'srtLatency', group: 'streaming', label: 'SRT latency', type: 'range', writeOnly: true,
    range: { min: 20, max: 8000, step: 1, unit: ' ms' }, wire: { write: post('post_network_other_conf', 'srt_latency') } }, // HTTP-PDF p.236 (SE+)
  { id: 'rtspAuth', group: 'streaming', label: 'RTSP authentication', type: 'bool', writeOnly: true,
    wire: { write: post('post_network_other_conf', 'rtsp_auth_en', (v) => (v ? 1 : 0)) } }, // HTTP-PDF p.226 (SE+)
  { id: 'rtspPort', group: 'streaming', label: 'RTSP port', type: 'range', writeOnly: true, danger: 'reconnect',
    range: { min: 554, max: 65535, step: 1 }, help: '554, or 1025–65535.',
    wire: { write: post('post_network_other_conf', 'rtsp_port') } },    // HTTP-PDF p.228 (SE+)
  { id: 'multicast', group: 'streaming', label: 'RTP multicast', type: 'bool', writeOnly: true,
    wire: { write: post('post_network_other_conf', 'multicast_en', (v) => (v ? 1 : 0)) } }, // HTTP-PDF p.210 (SE+)
  { id: 'onvif', group: 'streaming', label: 'ONVIF', type: 'bool', writeOnly: true, danger: 'reconnect',
    wire: { write: post('post_network_other_conf', 'onvif_en', (v) => (v ? 1 : 0)) } }, // HTTP-PDF p.218 (SE+)
  { id: 'onvifAuth', group: 'streaming', label: 'ONVIF authentication', type: 'bool', writeOnly: true,
    wire: { write: post('post_network_other_conf', 'onvif_auth_en', (v) => (v ? 1 : 0)) } }, // HTTP-PDF p.216 (SE+)
  { id: 'ndiName', group: 'streaming', label: 'NDI name', type: 'text', writeOnly: true, maxLength: 64,
    wire: { write: post('post_ndi_info', 'channelName') } },            // HTTP-PDF p.145 (SE+)

  // --- audio ----------------------------------------------------------------
  { id: 'audioEnable', group: 'audio', label: 'Audio', type: 'bool', verify: true,
    wire: { read: key('audio', 'audio_switch', one), write: post('post_media_audio', 'audio_switch', (v) => (v ? 1 : 0)) } }, // HTTP-PDF p.7 (SE+)
  { id: 'audioInVolume', group: 'audio', label: 'Input volume', type: 'range', verify: true, range: { min: 0, max: 30, step: 1 },
    wire: { read: key('audio', 'volume_value'), write: post('post_media_audio', 'volume_value') } }, // HTTP-PDF p.11 (SE: 0-30)
  { id: 'audioLineOut', group: 'audio', label: 'Line-out volume', type: 'range', verify: true, range: { min: 0, max: 30, step: 1 },
    help: 'Firmware 9.1.66 needs a restart for this to take effect.',
    wire: { read: key('audio', 'lineout_volume'), write: post('post_media_audio', 'lineout_volume') } }, // HTTP-PDF p.13; FW-0930
  { id: 'audioSampleRate', group: 'audio', label: 'Sample rate', type: 'enum', verify: true,
    options: opts([['32', '32 kHz'], ['44.1', '44.1 kHz'], ['48', '48 kHz']]),
    wire: { read: key('audio', 'samplerate', String), write: post('post_media_audio', 'samplerate') } }, // HTTP-PDF p.15 vs FW-0112: conflict
  { id: 'audioBitrate', group: 'audio', label: 'Audio bit rate', type: 'enum', verify: true,
    options: opts([['96', '96 kbps'], ['128', '128 kbps']]),
    wire: { read: key('audio', 'streamrate', String), write: post('post_media_audio', 'streamrate') } }, // HTTP-PDF p.9 (SE+)

  // --- network --------------------------------------------------------------
  { id: 'deviceId', group: 'network', label: 'Device ID', type: 'text', role: 'cameraName', verify: true, maxLength: 32,
    help: 'Also the camera\'s mDNS name (<id>.local).',
    wire: { read: key('device', 'devname', String), write: post('post_devinfo_conf', 'devname') } }, // HTTP-PDF p.153 (SE+); read p.187 (4K)
  { id: 'dhcp', group: 'network', label: 'DHCP', type: 'enum', writeOnly: true, danger: 'reconnect',
    options: opts([[1, 'DHCP'], [0, 'Static']]),
    wire: { write: post('post_network_info_conf', 'dhcp') } },          // HTTP-PDF p.161
  { id: 'ipAddress', group: 'network', label: 'IP address', type: 'text', writeOnly: true, danger: 'reconnect', role: 'ipAddress',
    pattern: IPV4, wire: { write: post('post_network_info_conf', 'ipaddr') } }, // HTTP-PDF p.159
  { id: 'netmask', group: 'network', label: 'Subnet mask', type: 'text', writeOnly: true, danger: 'reconnect',
    pattern: IPV4, wire: { write: post('post_network_info_conf', 'netmask') } }, // HTTP-PDF p.163
  { id: 'gateway', group: 'network', label: 'Gateway', type: 'text', writeOnly: true, danger: 'reconnect',
    pattern: IPV4, wire: { write: post('post_network_info_conf', 'gateway') } }, // HTTP-PDF p.157
  { id: 'dns', group: 'network', label: 'DNS', type: 'text', writeOnly: true, danger: 'reconnect',
    pattern: IPV4, wire: { write: post('post_network_info_conf', 'fdns') } }, // HTTP-PDF p.155
  { id: 'httpPort', group: 'network', label: 'HTTP port', type: 'range', writeOnly: true, danger: 'reconnect',
    range: { min: 80, max: 65535, step: 1 }, help: '80, or 1025–65535.',
    wire: { write: post('post_network_other_conf', 'httpport') } },     // HTTP-PDF p.171
  { id: 'viscaTcpPort', group: 'network', label: 'VISCA TCP port', type: 'range', writeOnly: true, danger: 'reconnect',
    range: { min: 1025, max: 65535, step: 1 }, help: 'CamBridge uses this port (default 5678).',
    wire: { write: post('post_network_other_conf', 'ptzport') } },      // HTTP-PDF p.173
  { id: 'viscaUdpPort', group: 'network', label: 'VISCA UDP port', type: 'range', writeOnly: true, danger: 'reconnect',
    range: { min: 1025, max: 65535, step: 1 }, wire: { write: post('post_network_other_conf', 'udpport') } }, // HTTP-PDF p.175

  // --- system ---------------------------------------------------------------
  { id: 'model', group: 'system', label: 'Model', type: 'text', readOnly: true, poll: 'once', wire: { read: { local: 'model' } } },
  { id: 'firmware', group: 'system', label: 'Firmware', type: 'text', readOnly: true, poll: 'once', wire: { read: { local: 'firmware' } } },
  { id: 'serial', group: 'system', label: 'Serial number', type: 'text', readOnly: true, poll: 'once', wire: { read: { local: 'serial' } } },
  { id: 'irChannel', group: 'system', label: 'IR remote channel', type: 'enum', verify: true,
    options: opts([[1, '1'], [2, '2'], [3, '3'], [4, '4']]),
    wire: { read: key('ir', 'IR_Channel'), write: { method: 'GET', path: (v) => `/cgi-bin/param.cgi?post_ir_info=&ir_id=${v}` } } }, // HTTP-PDF p.254 (SE+)

  // --- maintenance ----------------------------------------------------------
  { id: 'reboot', group: 'maintenance', label: 'Restart camera', type: 'action', danger: 'admin',
    wire: { act: { method: 'POST', path: '/cgi-bin/param.cgi?post_reboot' } } }, // HTTP-PDF p.249 (SE+)
  { id: 'menuReset', group: 'maintenance', label: 'Reset OSD menu settings', type: 'action', danger: 'admin',
    wire: { act: { method: 'GET', path: '/cgi-bin/param.cgi?set_overlay&osdreset&trigger' } } }, // HTTP-PDF p.252 (SE+)
  { id: 'networkReset', group: 'maintenance', label: 'Reset network settings', type: 'action', danger: 'admin',
    help: 'Also resets the login, ports and NTP (firmware 9.1.66).',
    wire: { act: { method: 'GET', path: '/cgi-bin/param.cgi?set_overlay&networkreset&trigger' } } }, // HTTP-PDF p.253 (SE+); FW-0930
  { id: 'factoryReset', group: 'maintenance', label: 'Factory reset', type: 'action', danger: 'admin',
    wire: { act: { method: 'GET', path: '/cgi-bin/param.cgi?set_overlay&fullreset&trigger' } } }, // HTTP-PDF p.251 (SE+)
];

/** Web-UI settings with no documented command (notes §9-§11). */
export const GAPS = [
  'Auto Framing vs Auto Tracking selection (Automation tab): only on/off is documented',
  'Tracking stop location, time delay, target-loss timeout and target-loss preset',
  'Tracking state readout on the Move SE (no SE-scoped query)',
  'Preset delete, preset names and thumbnails; which preset was last recalled',
  'Tally lamp control (none documented for the SE; no tally connector)',
  'Image Presets switch (recall position only)',
  'Bright mode level and WDR strength: commands exist, ranges are not documented',
  'USB mode (UVC / host), FreeD output, Speed tab',
  'Static IP fallback, MTU, NTP settings',
  'Admin password, guest account, HTTP authentication switch, HTTPS certificate',
  'Firmware upload and update mirror',
  'NDI on/off and transport, audio codec (AAC / G.711)',
  'Privacy mode (VISCA 81 01 3F 0A 12, firmware 9.1.66+): not offered, it turns the head away',
  'Reading any network, streaming or NDI setting back (setters only are SE-listed)',
];
