// A protocol fake of a Sony BRC-AM7: VISCA over IP on UDP and the CGI over
// HTTP with Digest auth, both as the spec notes (specs/sony-brc-am7.md)
// describe them.
//
// It holds state (settings, a head that moves while driven, presets, tally,
// Auto Framing), enforces Digest and the Referer check, answers the VISCA
// error replies Sony documents, and can be told to go silent or to have VISCA
// switched off (rear SETUP switch 4 off, the factory default).
//
// What it does not model (Sony does not document it, or it does not matter
// here): CGI error bodies (an invalid value gets HTTP 400, a failed Referer
// check 403 — both guesses); multi-parameter CGI calls beyond simple
// key=value; command-buffer occupancy beyond an on/off "busy" switch;
// Completion timing (sent straight after the ACK); the IP Setup protocol on
// UDP 52380; RTSP/SRT/NDI; brute-force lockout; menus.
//
//   node test/fakes/sony-brc.js --port 8080 [--visca-port 52381] [--username admin --password secret] [--no-visca]

import http from 'node:http';
import dgram from 'node:dgram';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const md5 = (s) => createHash('md5').update(s).digest('hex');

const ro = 'ro';
const tok = (...v) => v;
const rng = (min, max) => ({ min, max });
const ONOFF = tok('on', 'off');

/**
 * The CGI parameters this fake knows: name -> [inquiry group, set CGI, default, allowed].
 * allowed: list of tokens, {min, max} integers, a function, null (anything), or 'ro'.
 * Defaults are the bold values in C-EN where the notes give them.
 */
const PARAMS = {
  // system (C-EN p.7)
  ModelName: ['system', null, 'BRC-AM7', ro],
  Serial: ['system', null, '5012345', ro],
  SoftVersion: ['system', null, '2.00', ro],
  CGIVersion: ['system', null, '8.0.0', ro],
  Power: ['system', null, 'on', ro],
  PasswordChanged: ['system', null, '1', ro],
  // project (C-EN p.41-43)
  RecFormatFrequency: ['project', 'project', '5994', tok('11988', '10000', '5994', '5000', '2997', '2500', '2398')],
  RecFormatCodecCategory: ['project', 'project', 'xavc_s', tok('xavc', 'xavc_s')],
  RecFormatVideoQuality: ['project', 'project', 'high', tok('high', 'middle', 'low')],
  SimulRecEnable: ['project', 'project', 'off', ONOFF],
  ProxyRecEnable: ['project', 'project', 'off', ONOFF],
  BaseSettingShootingMode: ['project', 'project', 'custom', tok('custom', 'flexible_iso')],
  BaseSettingTargetDisplay: ['project', 'project', 'bt_709', tok('bt_709', 'hlg')],
  MediaRecordingStatus: ['cameraoperation', null, 'standby', ro],
  // imaging (C-EN p.30-35)
  ExposureISOGainMode: ['imaging', null, 'gain', ro],
  ExposureGain: ['imaging', 'imaging', '9', rng(6, 45)],
  ExposureISO: ['imaging', 'imaging', '12', rng(7, 25)],
  ExposureAGCEnable: ['imaging', 'imaging', 'off', ONOFF],
  ExposureAutoIris: ['imaging', 'imaging', 'off', ONOFF],
  ExposureIris: ['imaging', 'imaging', '31488', (v) => v === '27366' || (/^\d+$/.test(v) && +v >= 30975 && +v <= 32000)],
  ExposureFNumber: ['imaging', null, '560', ro],
  ExposureAutoShutterEnable: ['imaging', 'imaging', 'off', ONOFF],
  ExposureShutterMode: ['imaging', 'imaging', 'speed', tok('speed', 'angle')],
  ExposureShutterSpeedEnable: ['imaging', 'imaging', 'on', ONOFF],
  ExposureExposureTime: ['imaging', 'imaging', '16', rng(1, 25)],
  ExposureAngle: ['imaging', 'imaging', '17', rng(1, 29)],
  ExposureECSEnable: ['imaging', 'imaging', 'off', ONOFF],
  ExposureECS: ['imaging', 'imaging', '0', rng(0, 1120)],
  ExposureCompensation: ['imaging', 'imaging', '12', rng(0, 24)],
  ExposureNDFilterMode: ['imaging', null, 'variable', ro],
  ExposureAutoNDFilterEnable: ['imaging', 'imaging', 'off', ONOFF],
  ExposureNDClear: ['imaging', 'imaging', 'filtered', tok('filtered', 'clear')],
  ExposureNDPresetSelect: ['imaging', 'imaging', 'clear', tok('clear', 'nd1', 'nd2', 'nd3')],
  ExposureNDVariable: ['imaging', 'imaging', '0', rng(0, 20)],
  WhiteBalanceMode: ['imaging', 'imaging', 'memory_a', tok('atw', 'memory_a', 'preset')],
  WhiteBalancePreset: ['imaging', 'imaging', '3200', rng(2000, 15000)],
  WhiteBalanceColorTemp: ['imaging', 'imaging', '3200', rng(2000, 15000)],
  WhiteBalanceTint: ['imaging', 'imaging', '0', rng(-99, 99)],
  WhiteBalanceCrGain: ['imaging', 'imaging', '0', rng(-990, 990)],
  WhiteBalanceCbGain: ['imaging', 'imaging', '0', rng(-990, 990)],
  WhiteBalanceOffsetColorTemp: ['imaging', 'imaging', '0', rng(-99, 99)],
  WhiteBalanceOffsetTint: ['imaging', 'imaging', '0', rng(-99, 99)],
  ColorBar: ['camera', 'camera', 'off', ONOFF],
  MasterBlack: ['paint', 'paint', '0', rng(-990, 990)],
  RBlack: ['paint', 'paint', '0', rng(-990, 990)],
  BBlack: ['paint', 'paint', '0', rng(-990, 990)],
  BaseLookCurrentBaseLook: ['baselook', null, 's-cinetone', ro],
  SceneFileCurrentSceneFile: ['scenefile', 'scenefile', '0', rng(0, 16)],
  LutHdmiStream: ['shooting', 'shooting', 'off', ONOFF],
  LutSdi: ['shooting', 'shooting', 'off', ONOFF],
  // ptzf (C-EN p.13-19)
  FocusMode: ['ptzf', 'ptzf', 'auto', tok('auto', 'manual')],
  AbsoluteFocus: ['ptzf', 'ptzf', '1000', (v) => /^[0-9a-fA-F]{1,4}$/.test(v)],
  TeleConvertMode: ['ptzf', 'ptzf', 'off', ONOFF],
  AFAssistControl: ['ptzf', 'ptzf', 'on', ONOFF],
  FocusAFSubjShiftSens: ['ptzf', 'ptzf', '5', rng(1, 5)],
  FocusAFTransitionSpeed: ['ptzf', 'ptzf', '5', rng(1, 7)],
  FocusFaceEyeDetectionAF: ['ptzf', 'ptzf', 'priority_af', tok('only_af', 'priority_af', 'off')],
  TouchFocusInMF: ['ptzf', 'ptzf', 'tracking_af', tok('tracking_af', 'spot_focus')],
  ZoomSpeedScale: ['ptzf', 'ptzf', '100', rng(10, 100)],
  PanTiltSpeedStep: ['ptzf', 'ptzf', 'extended', tok('normal', 'extended')],
  PanTiltSpeedMode: ['ptzf', 'ptzf', 'normal', tok('normal', 'slow')],
  RampCurve: ['ptzf', 'ptzf', '8', rng(1, 9)],
  PanTiltSpeedScale: ['ptzf', 'ptzf', '25', rng(10, 100)],
  SettingPosition: ['ptzf', 'ptzf', 'desktop', tok('desktop', 'ceiling')],
  PanDirection: ['ptzf', 'ptzf', 'normal', tok('normal', 'opposite')],
  TiltDirection: ['ptzf', 'ptzf', 'normal', tok('normal', 'opposite')],
  PanLimitMode: ['ptzf', 'ptzf', 'unlimited', tok('unlimited', 'limited')],
  TiltLimitMode: ['ptzf', 'ptzf', 'unlimited', tok('unlimited', 'limited')],
  PanMovementRange: ['ptzf', null, '2ab98,d5468', ro],
  TiltMovementRange: ['ptzf', null, 'f8ad0,33450', ro],
  // presetposition (C-EN p.20-22)
  SpeedSelect: ['presetposition', 'presetposition', 'separate', tok('separate', 'common')],
  CommonSpeed: ['presetposition', 'presetposition', '127', rng(1, 127)],
  PresetRampCurve: ['presetposition', 'presetposition', '8', rng(1, 9)],
  PresetNum: ['presetposition', null, '100', ro],
  // ptzautoframing (C-EN p.23-27; C-JP3 p.25-32)
  PtzAutoFraming: ['ptzautoframing', '/analytics/ptzautoframing', 'off', ONOFF],
  PtzAutoFramingTrackingStatus: ['ptzautoframing', null, 'idle', ro],
  PtzAutoFramingPause: ['ptzautoframing', '/analytics/ptzautoframing', 'off', ONOFF],
  PtzAutoFramingInitialSetup: ['ptzautoframing', null, 'initialized', ro],
  PtzAutoFramingFramingMode: ['ptzautoframing', '/analytics/ptzautoframing', 'person', tok('person', 'ball_sports')],
  PtzAutoFramingTriggerType: ['ptzautoframing', '/analytics/ptzautoframing', 'manual', tok('auto', 'manual')],
  PtzAutoFramingMultiTrackingEnable: ['ptzautoframing', '/analytics/ptzautoframing', 'off', ONOFF],
  PtzAutoFramingMultiTrackingTargetNum: ['ptzautoframing', '/analytics/ptzautoframing', '2', rng(2, 8)],
  PtzAutoFramingMultiTrackingWaitTime: ['ptzautoframing', '/analytics/ptzautoframing', '0', rng(0, 60)],
  PtzAutoFramingAdjustSetting: ['ptzautoframing', '/analytics/ptzautoframing', '0,0,1200', (v) => {
    const [a, b, c] = v.split(',').map(Number);
    return v.split(',').length === 3 && a >= -50 && a <= 70 && b >= -50 && b <= 50 && c >= 160 && c <= 3500;
  }],
  PtzAutoFramingLeadRoomLevel: ['ptzautoframing', '/analytics/ptzautoframing', 'off', tok('off', 'low', 'middle', 'high')],
  PtzAutoFramingAutoControlScope: ['ptzautoframing', '/analytics/ptzautoframing', 'pan_tilt_zoom', tok('pan_tilt_zoom', 'pan_tilt', 'pan')],
  PtzAutoFramingSpeedPan: ['ptzautoframing', '/analytics/ptzautoframing', '4', rng(1, 5)],
  PtzAutoFramingSpeedTilt: ['ptzautoframing', '/analytics/ptzautoframing', '4', rng(1, 5)],
  PtzAutoFramingSpeedZoom: ['ptzautoframing', '/analytics/ptzautoframing', '4', rng(1, 5)],
  PtzAutoFramingSensitivityPan: ['ptzautoframing', '/analytics/ptzautoframing', '3', rng(0, 5)],
  PtzAutoFramingSensitivityTilt: ['ptzautoframing', '/analytics/ptzautoframing', '3', rng(0, 5)],
  PtzAutoFramingSensitivityZoom: ['ptzautoframing', '/analytics/ptzautoframing', '3', rng(0, 5)],
  PtzAutoFramingDetectionArea: ['ptzautoframing', '/analytics/ptzautoframing', '0,0,10000,10000', null],
  PtzAutoFramingDetectionPart: ['ptzautoframing', '/analytics/ptzautoframing', 'head', tok('head', 'ankle')],
  PtzAutoFramingRegisteredFaceTracking: ['ptzautoframing', '/analytics/ptzautoframing', 'on', ONOFF],
  PtzAutoFramingIndividualIdentification: ['ptzautoframing', '/analytics/ptzautoframing', 'on', ONOFF],
  PtzAutoFramingFaceLostWaitTime: ['ptzautoframing', '/analytics/ptzautoframing', '0', rng(0, 60)],
  PtzAutoFramingDetectionRestartTime: ['ptzautoframing', '/analytics/ptzautoframing', '0', rng(0, 600)],
  PtzAutoFramingLostWaitTime: ['ptzautoframing', '/analytics/ptzautoframing', '6', rng(1, 60)],
  PtzAutoFramingAutoStartEnable: ['ptzautoframing', '/analytics/ptzautoframing', 'off', ONOFF],
  PtzAutoFramingFaceIndicatorEnable3: ['ptzautoframing', '/analytics/ptzautoframing', 'on', ONOFF],
  PtzAutoFramingTrackingRangeEnable: ['ptzautoframing', '/analytics/ptzautoframing', '1,off', (v) => /^1,(on|off)$/.test(v)],
  PtzAutoFramingTrackingRangeRect: ['ptzautoframing', '/analytics/ptzautoframing', '1,0,0,10000,10000', (v) => /^1(,\d+){4}$/.test(v)],
  PtzAutoFramingMultiTrackingCurrentTargetNum: ['ptzautoframing', null, '0,0', ro],
  // tally (C-EN p.39-40)
  TallyControlMode: ['tally', 'tally', 'internal', tok('internal', 'external', 'ptz_afr')],
  TallyLampBrightness: ['tally', 'tally', 'high', tok('off', 'low', 'high')],
  GTallyLampEnable: ['tally', 'tally', 'on', ONOFF],
  YTallyLampEnable: ['tally', 'tally', 'on', ONOFF],
  RTallyControl: ['tally', 'tally', 'turn_off', tok('turn_on', 'turn_off')],
  GTallyControl: ['tally', 'tally', 'turn_off', tok('turn_on', 'turn_off')],
  TallyTsiUmdEnable: ['tally', 'tally', '0', tok('0', '1')],
  TallyTsiUmdPort: ['tally', 'tally', '8900', rng(1024, 65534)],
  TallyTsiUmdIndex: ['tally', 'tally', '1', rng(0, 65534)],
  // monitoring, streaming, audio (C-EN p.48-68)
  MonitoringOutputFormat: ['monitoring', 'monitoring', 's3840p_h1920p', null],
  MonitoringOutputDisplayHdmiEnable: ['monitoring', 'monitoring', 'on', ONOFF],
  MonitoringOutputDisplaySdiEnable: ['monitoring', 'monitoring', 'on', ONOFF],
  StreamMode: ['stream', 'stream', 'rtsp', tok('rtsp', 'rtmp', 'srt-caller', 'srt-listener', 'ndi_hx', 'off')],
  StreamStatus: ['stream', null, 'off', ro],
  ImageCodec1: ['codecconfig', 'codecconfig', 'h264', tok('h264', 'h265')],
  ImageCodec2: ['codecconfig', 'codecconfig', 'off', tok('h264', 'h265', 'off')],
  BitRate1: ['codecconfig', 'codecconfig', '16000', rng(512, 80000)],
  CBR1: ['codecconfig', 'codecconfig', 'on', ONOFF],
  AudioIn: ['codecconfig', 'codecconfig', 'off', ONOFF],
  AuthenRTSP: ['rtspconfig', 'rtspconfig', 'on', ONOFF],
  RTSPPort: ['rtspconfig', 'rtspconfig', '554', (v) => v === '554' || (+v >= 1024 && +v <= 65534)],
  SrtListenPort: ['srt', 'srt', '4201', rng(1024, 65534)],
  SrtPeerLatency: ['srt', 'srt', '120', rng(20, 8000)],
  AudioInputMasterLevel: ['audio', 'audio', '99', rng(0, 99)],
  ...Object.fromEntries([1, 2, 3, 4].flatMap((n) => [
    [`AudioInputCH${n}Level`, ['audio', 'audio', '49', rng(0, 99)]],
    [`AudioInputCH${n}LevelControl`, ['audio', 'audio', 'auto', tok('auto', 'manual')]],
  ])),
  ...Object.fromEntries([1, 2].flatMap((n) => [
    [`AudioInputIn${n}Select`, ['audio', 'audio', 'mic', tok('mic', 'line')]],
    [`AudioInputIn${n}Mic48V`, ['audio', 'audio', 'off', ONOFF]],
  ])),
  // network, auth, user, system (C-EN p.51-60, p.10-11, p.74)
  CameraName: ['network', 'network', 'BRC-AM7', (v) => /^[A-Za-z0-9 ]{0,8}$/.test(v)],
  Dhcp: ['network', 'network', 'on', ONOFF],
  Ip: ['network', 'network', '192.0.2.10', null],
  Subnetmask: ['network', 'network', '255.255.255.0', null],
  Gateway: ['network', 'network', '192.0.2.1', null],
  CurrentIp: ['network', null, '192.0.2.10', ro],
  MacAddress: ['network', null, '02:00:5e:00:00:07', ro],
  HttpPort: ['network', 'network', '80', null],
  IPSetupSetEnable: ['network', 'network', 'on', ONOFF],
  RefererCheck: ['auth', 'auth', 'on', ONOFF],
  BruteForceAttackProtection: ['auth', 'auth', 'on', ONOFF],
  DigestAuthNonceDuration: ['user', 'user', '300', rng(1, 3600)],
  IRReceive: ['remotecontrol', 'remotecontrol', 'on', ONOFF],
  TemperatureWarning: ['status', null, '0', ro],
  PowerSupplyVoltageWarning: ['status', null, 'normal', ro],
};

/** VISCA payload bytes as `81 01 ...` for the log. */
const hx = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
const nib = (v, n) => Array.from({ length: n }, (_, i) => (v >>> ((n - 1 - i) * 4)) & 0x0f);
const fromNib = (b, at, n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 4) | (b[at + i] & 0x0f); return v; };
const hexN = (v, n) => ((v < 0 ? v + 2 ** (n * 4) : v) >>> 0).toString(16).padStart(n, '0');

function tinyJpeg() {
  // SOI, a comment, EOI: enough for a client to see image/jpeg bytes.
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x06]), Buffer.from('fake'), Buffer.from([0xff, 0xd9])]);
}

export async function startFakeSony({
  port = 0, viscaPort = 0, host = '127.0.0.1', username = 'admin', password = 'secret',
  visca = true, passwordSet = true, autoFraming = true, model = 'BRC-AM7', presetNum = 100,
} = {}) {
  const realm = 'Sony Network Camera';
  const params = Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, v[2]]));
  params.PasswordChanged = passwordSet ? '1' : '0';
  // Another Sony model on the same protocol (sibling-model tests).
  params.ModelName = model;
  params.PresetNum = String(presetNum);
  const state = {
    params,
    autoFraming,
    // Rear SETUP switch 4, read at power-on, and the admin password (HG p.23).
    viscaEnabled: visca && passwordSet,
    silent: false,
    head: { pan: 0, tilt: 0, zoom: 0, focus: 0x1000, v: { pan: 0, tilt: 0, zoom: 0 }, at: Date.now() },
    presets: new Map(),
    tally: { red: false, green: false },
    cgiLog: [],
    viscaLog: [],
    /** Datagrams to ignore, as if lost on the way in. */
    dropRequests: 0,
    /** Replies to swallow, as if lost on the way back. */
    dropReplies: 0,
    /** When true, every command gets buffer full. */
    busy: false,
    /** Answer every CGI request after this many ms. */
    cgiDelayMs: 0,
    afr: false,
  };
  const nonce = randomBytes(8).toString('hex');
  const held = new Set();

  const ptMax = () => (params.PanTiltSpeedStep === 'normal' ? 24 : 127);
  function integrate() {
    const h = state.head;
    const now = Date.now();
    const dt = (now - h.at) / 1000;
    h.at = now;
    // Full speed ~60°/s pan/tilt (V-EN p.25), full zoom range in ~3 s. v.pan
    // is positive to the right; Sony's pan coordinate counts up to the left
    // (2AB98 = +175° CCW, V-EN p.25).
    h.pan = Math.max(-175000, Math.min(175000, h.pan - h.v.pan * 60000 * dt));
    h.tilt = Math.max(-30000, Math.min(210000, h.tilt + h.v.tilt * 60000 * dt));
    h.zoom = Math.max(0, Math.min(0x4000, h.zoom + h.v.zoom * 0x4000 / 3 * dt));
  }

  // --- CGI -------------------------------------------------------------------

  function authorised(req) {
    const h = req.headers.authorization;
    if (!h || !/^Digest /i.test(h)) return false;
    const p = {};
    for (const m of h.slice(7).matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)) p[m[1].toLowerCase()] = m[2] ?? m[3];
    if (p.username !== username || p.nonce !== nonce) return false;
    const ha1 = md5(`${username}:${realm}:${password}`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    const want = p.qop ? md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
    return p.response === want;
  }

  function inquiryBody(groups) {
    integrate();
    const extra = {
      ptzf: {
        PanTiltMaxVelocity: String(ptMax()),
        AbsolutePTZF: [hexN(Math.round(state.head.pan), 5), hexN(Math.round(state.head.tilt), 5),
          hexN(Math.round(state.head.zoom), 4), hexN(state.head.focus, 4)].join(','),
        PtzfStatus: `${state.head.v.pan || state.head.v.tilt ? 'moving' : 'idle'},${state.head.v.pan || state.head.v.tilt ? 'moving' : 'idle'},${state.head.v.zoom ? 'moving' : 'idle'},idle`,
      },
      ptzautoframing: { PtzAutoFraming: state.afr ? 'on' : 'off', PtzAutoFramingTrackingStatus: state.afr ? 'waiting' : 'idle' },
      tally: { RTallyControl: state.tally.red ? 'turn_on' : 'turn_off', GTallyControl: state.tally.green ? 'turn_on' : 'turn_off' },
    };
    const out = [];
    for (const g of groups) {
      if (g === 'ptzautoframing' && !state.autoFraming) return null;
      const names = Object.entries(PARAMS).filter(([, d]) => d[0] === g).map(([k]) => k);
      if (!names.length && !extra[g]) return null;
      const values = { ...Object.fromEntries(names.map((k) => [k, params[k]])), ...(extra[g] ?? {}) };
      for (const [k, v] of Object.entries(values)) out.push(`${k}=${encodeURIComponent(v).replace(/%2C/g, ',')}`);
    }
    return out.join('&');
  }

  /** A set CGI call; returns an HTTP status. */
  function applySet(cgi, query) {
    for (const part of query.split('&')) {
      if (!part) continue;
      const i = part.indexOf('=');
      const name = i < 0 ? part : part.slice(0, i);
      let value = i < 0 ? '' : part.slice(i + 1);
      try { value = decodeURIComponent(value); } catch { return 400; }
      const st = command(cgi, name, value);
      if (st !== null) { if (st !== 200) return st; continue; }
      const def = PARAMS[name];
      if (!def || def[1] !== cgi || def[3] === ro) return 400;
      const allowed = def[3];
      const ok = allowed === null ? true
        : Array.isArray(allowed) ? allowed.includes(value)
          : typeof allowed === 'function' ? allowed(value)
            : /^-?\d+$/.test(value) && +value >= allowed.min && +value <= allowed.max;
      if (!ok) return 400;
      // AbsoluteFocus is valid only in manual focus (C-EN p.15).
      if (name === 'AbsoluteFocus') {
        if (params.FocusMode !== 'manual') return 400;
        state.head.focus = parseInt(value, 16);
      }
      if (name === 'PtzAutoFraming') state.afr = value === 'on';
      if (name === 'RTallyControl') state.tally.red = value === 'turn_on';
      if (name === 'GTallyControl') state.tally.green = value === 'turn_on';
      params[name] = value;
    }
    return 200;
  }

  /** CGI commands (not stored settings). null = not a command. */
  function command(cgi, name, value) {
    const h = state.head;
    switch (`${cgi}:${name}`) {
      case 'ptzf:PanTiltMove': {
        const [dir, ps, ts] = value.split(',');
        const max = ptMax();
        if (!['up', 'down', 'left', 'right', 'up-left', 'up-right', 'down-left', 'down-right', 'stop'].includes(dir)) return 400;
        if (!(+ps >= 0 && +ps <= max && +ts >= 0 && +ts <= max)) return 400;
        integrate();
        h.v.pan = dir.includes('right') ? +ps / max : dir.includes('left') ? -ps / max : 0;
        h.v.tilt = dir.includes('up') ? +ts / max : dir.includes('down') ? -ts / max : 0;
        return 200;
      }
      case 'ptzf:ZoomMove': {
        const [dir, sp] = value.split(',');
        if (!['tele', 'wide', 'stop'].includes(dir) || !(+sp >= 0 && +sp <= 32766)) return 400;
        integrate();
        h.v.zoom = dir === 'tele' ? Math.max(0.01, sp / 32766) : dir === 'wide' ? -Math.max(0.01, sp / 32766) : 0;
        return 200;
      }
      case 'ptzf:FocusPushAFMF':
      case 'imaging:WhiteBalanceWBSet':
        return ['press', 'release'].includes(value) ? 200 : 400;
      case 'cameraoperation:MediaRecording':
        if (value === 'press') params.MediaRecordingStatus = params.MediaRecordingStatus === 'rec' ? 'standby' : 'rec';
        return ['press', 'release'].includes(value) ? 200 : 400;
      case 'ptzf:PanTiltReset':
        integrate(); Object.assign(h, { pan: 0, tilt: 0 }); return 200;
      case 'ptzf:Cancel':
        // "Cancels the running PTZ command" (C-EN p.17). Whether it stops a
        // VISCA focus drive is not documented; the fake leaves focus alone.
        if (value !== 'on') return 400;
        integrate(); Object.assign(h.v, { pan: 0, tilt: 0, zoom: 0 }); return 200;
      case 'presetposition:HomePos':
        if (value !== 'recall') return 400;
        integrate(); Object.assign(h, { pan: 0, tilt: 0 }); return 200;
      case 'presetposition:PresetCall': {
        const n = +value;
        if (!(n >= 1 && n <= 100)) return 400;
        const p = state.presets.get(n);
        if (!p) return 400;
        integrate(); Object.assign(h, p); return 200;
      }
      case 'presetposition:PresetSet': {
        const [n] = value.split(',');
        if (!(+n >= 1 && +n <= 100)) return 400;
        integrate(); state.presets.set(+n, { pan: h.pan, tilt: h.tilt, zoom: h.zoom, focus: h.focus }); return 200;
      }
      case 'presetposition:PresetClear':
        if (!(+value >= 1 && +value <= 100)) return 400;
        state.presets.delete(+value); return 200;
      case '/analytics/ptzautoframing:PtzAutoFramingObjectPosition':
        return /^\d+,\d+$/.test(value) ? 200 : 400;
      case '/analytics/ptzautoframing:PtzAutoFramingPresetCall':
        return ['1', '2', '3'].includes(value) ? 200 : 400;
      case '/analytics/ptzautoframingexe:PtzAutoFramingRestart':
      case '/analytics/ptzautoframingexe:PtzAutoFramingMoveStartPosition':
      case '/analytics/ptzautoframingexe:PtzAutoFramingDecideStartPosition':
        return value === 'on' ? 200 : 400;
      case '/analytics/ptzautoframingexe:PtzAutoFramingCourtVerticesReset':
        return value === 'reset' ? 200 : 400;
      case 'main:System':
        return ['on', 'reboot', 'standby'].includes(value) ? 200 : 400;
      case 'main:FactoryDefault':
        return ['soft', 'network', 'hard'].includes(value) ? 200 : 400;
      default:
        return null;
    }
  }

  const server = http.createServer((req, res) => {
    // A slow web server: every CGI answer takes this long.
    if (state.cgiDelayMs && !req.delayed) {
      req.delayed = true;
      setTimeout(() => server.emit('request', req, res), state.cgiDelayMs);
      return;
    }
    if (state.silent) { held.add(res); res.on('close', () => held.delete(res)); return; }
    if (!authorised(req)) {
      res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}", algorithm=MD5` });
      res.end();
      return;
    }
    // Referer check (C-EN p.3): with it on, CGI is accepted only with a Referer.
    if (params.RefererCheck === 'on' && !req.headers.referer) { res.writeHead(403); res.end(); return; }
    const [path, query = ''] = req.url.split('?');
    state.cgiLog.push(req.url);
    if (path === '/oneshotimage1') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(tinyJpeg());
      return;
    }
    if (path === '/command/inquiry.cgi') {
      const groups = query.split('&').filter((p) => p.startsWith('inq=')).map((p) => decodeURIComponent(p.slice(4)));
      const body = groups.length ? inquiryBody(groups) : null;
      if (body === null) { res.writeHead(400); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(body);
      return;
    }
    let m = /^\/command\/([a-z0-9-]+)\.cgi$/.exec(path);
    let cgi = m?.[1];
    if (!m) {
      m = /^(\/analytics\/(?:ptzautoframing|ptzautoframingexe))\.cgi$/.exec(path);
      cgi = m?.[1];
      if (m && !state.autoFraming) { res.writeHead(404); res.end(); return; }
    }
    if (!cgi) { res.writeHead(404); res.end(); return; }
    const st = applySet(cgi, query);
    res.writeHead(st, { 'Content-Type': 'text/plain' });
    res.end(st === 200 ? 'OK' : '');
  });

  // --- VISCA over IP ---------------------------------------------------------

  const udp = dgram.createSocket('udp4');
  const executed = [];
  let socketNo = 0;

  function frame(type, seq, payload) {
    const b = Buffer.alloc(8 + payload.length);
    b.writeUInt16BE(type, 0); b.writeUInt16BE(payload.length, 2); b.writeUInt32BE(seq >>> 0, 4);
    Buffer.from(payload).copy(b, 8);
    return b;
  }

  function viscaCommand(p) {
    const h = state.head;
    const is = (...b) => b.every((x, i) => p[i] === x);
    const bool = (b) => (b === 0x02 ? true : b === 0x03 ? false : null);
    if (p[0] !== 0x81 || p[p.length - 1] !== 0xff) return { error: 0x02 };
    if (is(0x81, 0x01, 0x06, 0x01) && p.length === 9) {
      const [vv, ww, dd, ee] = [p[4], p[5], p[6], p[7]];
      const max = ptMax();
      if (vv < 1 || vv > max || ww < 1 || ww > max || ![1, 2, 3].includes(dd) || ![1, 2, 3].includes(ee)) return { error: 0x02 };
      integrate();
      h.v.pan = dd === 2 ? vv / max : dd === 1 ? -vv / max : 0;
      h.v.tilt = ee === 1 ? ww / max : ee === 2 ? -ww / max : 0;
      return { ok: true };
    }
    if (is(0x81, 0x01, 0x04, 0x07) && p.length === 6) {
      const b = p[4];
      integrate();
      if (b === 0x00) h.v.zoom = 0;
      else if (b === 0x02 || b === 0x03) h.v.zoom = b === 0x02 ? 0.5 : -0.5;
      else if ((b & 0xf0) === 0x20 || (b & 0xf0) === 0x30) h.v.zoom = ((b & 0x0f) + 1) / 8 * ((b & 0xf0) === 0x20 ? 1 : -1);
      else return { error: 0x02 };
      return { ok: true };
    }
    if (is(0x81, 0x01, 0x7e, 0x04, 0x17) && p.length === 11) {
      const s = fromNib(p, 6, 4);
      if (s > 0x7ffe || ![0, 2, 3].includes(p[5])) return { error: 0x02 };
      integrate();
      h.v.zoom = p[5] === 0 ? 0 : Math.max(0.01, s / 0x7ffe) * (p[5] === 2 ? 1 : -1);
      return { ok: true };
    }
    if (is(0x81, 0x01, 0x04, 0x08) && p.length === 6) {
      if (params.FocusMode !== 'manual') return { error: 0x41 };
      return { ok: true };
    }
    if (is(0x81, 0x01, 0x06, 0x04, 0xff)) { integrate(); Object.assign(h, { pan: 0, tilt: 0 }); return { ok: true }; }
    if (is(0x81, 0x01, 0x7e, 0x01, 0x0a, 0x00) && p.length === 8) {
      const v = bool(p[6]); if (v === null) return { error: 0x02 };
      state.tally.red = v; params.RTallyControl = v ? 'turn_on' : 'turn_off'; return { ok: true };
    }
    if (is(0x81, 0x01, 0x7e, 0x04, 0x1a, 0x00) && p.length === 8) {
      const v = bool(p[6]); if (v === null) return { error: 0x02 };
      state.tally.green = v; params.GTallyControl = v ? 'turn_on' : 'turn_off'; return { ok: true };
    }
    if (is(0x81, 0x01, 0x7e, 0x04, 0x3a) && p.length === 7) {
      if (!state.autoFraming || params.PtzAutoFramingInitialSetup !== 'initialized') return { error: 0x41 };
      if (p[5] !== 0 && p[5] !== 1) return { error: 0x02 };
      state.afr = p[5] === 1; return { ok: true };
    }
    if (is(0x81, 0x01, 0x7e, 0x04, 0x58) && p.length === 7) return { ok: true };
    if (is(0x81, 0x01, 0x04, 0x3f) && p.length === 7) {
      const n = p[5] + 1;
      if (n < 1 || n > 100) return { error: 0x02 };
      integrate();
      if (p[4] === 0x01) state.presets.set(n, { pan: h.pan, tilt: h.tilt, zoom: h.zoom, focus: h.focus });
      else if (p[4] === 0x02) { const s = state.presets.get(n); if (s) Object.assign(h, s); }
      else if (p[4] === 0x00) state.presets.delete(n);
      else return { error: 0x02 };
      return { ok: true };
    }
    // VISCA-only image settings, kept in the same store.
    const simple = [
      [[0x81, 0x01, 0x04, 0x33], 'backlight'], [[0x81, 0x01, 0x04, 0x3a], 'spotlight'],
      [[0x81, 0x01, 0x7e, 0x01, 0x60], 'detail'], [[0x81, 0x01, 0x7e, 0x01, 0x6d], 'knee'],
    ];
    for (const [pre, key] of simple) {
      if (is(...pre) && p.length === pre.length + 2) {
        const v = bool(p[pre.length]); if (v === null) return { error: 0x02 };
        state[key] = v; return { ok: true };
      }
    }
    if (is(0x81, 0x01, 0x04, 0x42, 0x00, 0x00) && p.length === 9) { state.detailLevel = fromNib(p, 6, 2); return { ok: true }; }
    if (is(0x81, 0x01, 0x7e, 0x01, 0x54) && p.length === 7) { state.kneeMode = p[5]; return { ok: true }; }
    if (is(0x81, 0x01, 0x7e, 0x01, 0x6f) && p.length === 8) { state.kneeSlope = fromNib(p, 5, 2); return { ok: true }; }
    if (is(0x81, 0x01, 0x7e, 0x01, 0x6e) && p.length === 8) { state.kneePoint = fromNib(p, 5, 2); return { ok: true }; }
    return { error: 0x02 };
  }

  function viscaInquiry(p) {
    const is = (...b) => b.length === p.length && b.every((x, i) => p[i] === x);
    const h = state.head;
    const b23 = (v) => (v ? 0x02 : 0x03);
    integrate();
    if (is(0x81, 0x09, 0x00, 0x02, 0xff)) return [0x00, 0x01, 0x05, 0x1f, 0x02, 0x00, 0x02];       // V-EN p.22
    if (is(0x81, 0x09, 0x04, 0x00, 0xff)) return [0x02];
    if (is(0x81, 0x09, 0x06, 0x12, 0xff)) return [...nib(Math.round(h.pan) & 0xfffff, 5), ...nib(Math.round(h.tilt) & 0xfffff, 5)];
    if (is(0x81, 0x09, 0x04, 0x47, 0xff)) return nib(Math.round(h.zoom), 4);
    if (is(0x81, 0x09, 0x04, 0x48, 0xff)) return nib(h.focus, 4);
    if (is(0x81, 0x09, 0x7e, 0x04, 0x3a, 0xff)) return state.autoFraming ? [state.afr ? 0x01 : 0x00] : null;
    if (is(0x81, 0x09, 0x7e, 0x01, 0x0a, 0xff)) return [b23(state.tally.red)];
    if (is(0x81, 0x09, 0x7e, 0x04, 0x1a, 0xff)) return [b23(state.tally.green)];
    if (is(0x81, 0x09, 0x04, 0x33, 0xff)) return [b23(state.backlight)];
    if (is(0x81, 0x09, 0x04, 0x3a, 0xff)) return [b23(state.spotlight)];
    if (is(0x81, 0x09, 0x7e, 0x01, 0x60, 0xff)) return [b23(state.detail ?? true)];
    if (is(0x81, 0x09, 0x04, 0x42, 0xff)) return [0x00, 0x00, ...nib(state.detailLevel ?? 7, 2)];
    if (is(0x81, 0x09, 0x7e, 0x01, 0x6d, 0xff)) return [b23(state.knee)];
    if (is(0x81, 0x09, 0x7e, 0x01, 0x54, 0xff)) return [state.kneeMode ?? 0];
    if (is(0x81, 0x09, 0x7e, 0x01, 0x6f, 0xff)) return [0x00, 0x00, ...nib(state.kneeSlope ?? 99, 2)];
    if (is(0x81, 0x09, 0x7e, 0x01, 0x6e, 0xff)) return [0x00, 0x00, ...nib(state.kneePoint ?? 20, 2)];
    return null;
  }

  udp.on('message', (msg, rinfo) => {
    try {
      if (state.silent || !state.viscaEnabled || msg.length < 9) return;
      if (state.dropRequests > 0) { state.dropRequests -= 1; return; }
      const type = msg.readUInt16BE(0);
      const seq = msg.readUInt32BE(4);
      const payload = msg.subarray(8, 8 + msg.readUInt16BE(2));
      const send = (t, p) => {
        if (state.dropReplies > 0) { state.dropReplies -= 1; return; }
        udp.send(frame(t, seq, p), rinfo.port, rinfo.address);
      };
      if (type === 0x0200) {
        if (payload[0] === 0x01) { executed.length = 0; send(0x0201, [0x01]); }
        return;
      }
      if (type !== 0x0100 && type !== 0x0110) { send(0x0201, [0x0f, 0x02]); return; }
      // A message with a sequence number already handled is a retransmission:
      // ERROR, sequence abnormality (V-EN p.12).
      if (executed.includes(seq)) { send(0x0201, [0x0f, 0x01]); return; }
      executed.push(seq);
      if (executed.length > 64) executed.shift();
      state.viscaLog.push(hx(payload));
      if (type === 0x0110) {
        const data = viscaInquiry(payload);
        send(0x0111, data ? [0x90, 0x50, ...data, 0xff] : [0x90, 0x60, 0x02, 0xff]);
        return;
      }
      if (state.busy) { send(0x0111, [0x90, 0x60, 0x03, 0xff]); return; }
      const r = viscaCommand(payload);
      socketNo = socketNo === 1 ? 2 : 1;
      if (r.error === 0x41) { send(0x0111, [0x90, 0x60 | socketNo, 0x41, 0xff]); return; }
      if (r.error) { send(0x0111, [0x90, 0x60, r.error, 0xff]); return; }
      send(0x0111, [0x90, 0x40 | socketNo, 0xff]);
      send(0x0111, [0x90, 0x50 | socketNo, 0xff]);
    } catch {
      // A malformed datagram is not worth crashing a test over.
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  await new Promise((resolve) => udp.bind(viscaPort, host, resolve));

  return {
    port: server.address().port,
    viscaPort: udp.address().port,
    state,
    setSilent(on) {
      state.silent = !!on;
      if (!on) for (const res of held) { try { res.destroy(); } catch { /* gone */ } }
    },
    async close() {
      for (const res of held) { try { res.destroy(); } catch { /* gone */ } }
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      try { udp.close(); } catch { /* closed */ }
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
  const httpPort = Number(arg('port', 8080));
  const fake = await startFakeSony({
    port: httpPort,
    viscaPort: Number(arg('visca-port', httpPort + 1)),
    host: arg('host', '127.0.0.1'),
    username: arg('username', 'admin'),
    password: arg('password', 'secret'),
    visca: !process.argv.includes('--no-visca'),
  });
  console.log(JSON.stringify({ fake: 'sony-brc-am7', http: fake.port, visca: fake.viscaPort }));
}
