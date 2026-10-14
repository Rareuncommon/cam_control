// A protocol fake of a PTZOptics Move SE: raw VISCA over TCP (default 5678)
// and the HTTP-CGI with Digest auth, as the spec notes
// (specs/ptzoptics-move-se.md) describe them.
//
// State: image settings, a head that moves while driven, presets (with 90,
// 95, 150 and 151 behaving as the camera's special numbers), auto tracking.
// Options model the firmware differences the driver has to cope with:
//   firmware     '9.1.66' (snapshot0/1 and /api/v1 exist) or older
//   queries      false = no get_* queries (they are documented for the 4K only)
//   replyAddress 0xa0 = the pre-9.1.56 quirk where replies start a0, not 90
//
// What it does not model: CGI reply bodies beyond {"Result":"Success"} (the
// real format is undocumented) and an invalid value answered with HTTP 400 (a
// guess); UDP 1259 and the 52381 "Sony" port; RTSP/SRT/NDI; command-buffer
// occupancy beyond an on/off "busy" switch; Completion timing (straight after
// the ACK); FreeD; the OSD menu; preset recall speed.
//
//   node test/fakes/ptzoptics.js --port 8081 [--visca-port 5678] [--username admin --password secret]

import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const md5 = (s) => createHash('md5').update(s).digest('hex');
const hx = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
const nib = (v, n) => Array.from({ length: n }, (_, i) => (v >>> ((n - 1 - i) * 4)) & 0x0f);
const range = (a, b) => (v) => /^-?\d+$/.test(v) && +v >= a && +v <= b;
const oneOf = (...l) => (v) => l.map(String).includes(String(v));
const any = () => true;

/**
 * Image settings: CGI write key (post_image_value&<key>&<v>) -> [read key in
 * get_*_conf, default, valid]. Values from HTTP-PDF p.20-121 (SE+).
 */
const IMAGE = {
  aemode: ['exposure_mode', '0', oneOf(0, 3, 10, 11, 13)],
  expcomp_mode: [null, '3', oneOf(2, 3)],
  expcomp_level: ['expcomp_level', '7', range(0, 14)],
  backlight: [null, '3', oneOf(2, 3)],
  antiflicker: ['antiflicker', '0', range(0, 2)],
  gainLimit: ['gain_limit', '5', range(0, 15)],
  gain: ['manual_gain', '0', range(0, 7)],
  meter: ['meter', '0', range(0, 3)],
  drc: ['drc', '0', range(0, 8)],
  iris: ['iris', '10', oneOf(0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17)],
  shutter: ['shutter', '3', range(1, 17)],
  wbmode: ['wb_mode', '0', oneOf(0, 1, 2, 3, 5, 32)],
  rgain: ['rgain', '128', range(0, 255)],
  bgain: ['bgain', '128', range(0, 255)],
  colortemp: ['temperature', '30', range(0, 55)],
  rgaintuning: ['rgain_tuning', '10', range(0, 20)],
  bgaintuning: ['bgain_tuning', '10', range(0, 20)],
  luminance: ['luminance', '8', range(0, 14)],
  contrast: ['contrast', '9', range(0, 14)],
  saturation: ['saturation', '4', range(0, 14)],
  hue: ['hue', '8', range(0, 14)],
  sharpness: ['sharpness', '9', range(0, 16)],
  bwmode: ['blackwhite_mode', '0', oneOf(0, 1)],
  imageorientation: ['imageOrientation', '0', range(0, 3)],
  inversionmode: ['inversionMode', '0', oneOf(0, 2)],
  noise2d: ['nr2d', '6', range(0, 6)],
  noise3d: ['nr3d', '7', range(0, 9)],
  digitalzoom: ['digitalzoom', '0', range(0, 4)],
  focusmode: ['focus_mode', '2', oneOf(2, 3)],
  focusregion: ['focus_zone', '1', range(0, 3)],
  focussense: ['focus_sens', '2', range(1, 3)],
  motionsync: ['motionsync', '3', oneOf(2, 3)],
  presetfreeze: ['presetfreeze', '3', oneOf(2, 3)],
  presetinspection: ['presetinspection', '3', oneOf(2, 3)],
  displayinfo: [null, '3', oneOf(2, 3)],
  trackpreset: ['trackstart', 'live', (v) => /^(0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-4]|live|home)$/.test(v)],
  trackingoverlay: [null, '0', oneOf(0, 1)],
  onepush: [null, '0', oneOf(0)],
};

const VIDEO = {
  video_ability: ['all-30fps', oneOf('all-30fps', 'USB_IP', 'USB_HDMI-SDI', 'HDMI-SDI_IP')],
  vinorm: ['60', oneOf('50', '60', 'dial')],
  profile: ['highprofile', oneOf('highprofile', 'mainprofile', 'baseline')],
  ndi_mode: ['high', oneOf('off', 'ultra', 'high', 'medium', 'low')],
  protocol_1: ['H264', oneOf('H264', 'H265')], protocol_2: ['H264', oneOf('H264', 'H265')],
  size_1: ['PIC_HD1080', any], size_2: ['PIC_640_360', any],
  bps_1: ['8192', range(32, 102400)], bps_2: ['1024', range(32, 20480)],
  fps_1: ['30', range(1, 60)], fps_2: ['30', range(1, 60)],
  gop_1: ['60', range(1, 1200)], gop_2: ['60', range(1, 1200)],
};

const AUDIO = {
  audio_switch: ['1', oneOf(0, 1)], adts_flag: ['0', oneOf(0, 1)], streamrate: ['128', oneOf(96, 128)],
  samplerate: ['48', oneOf('32', '44.1', '48')], volume_value: ['15', range(0, 30)],
  lineout_volume: ['15', range(0, 30)], usbaudio_switch: ['0', oneOf(0, 1)],
};

function tinyJpeg() {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x06]), Buffer.from('fake'), Buffer.from([0xff, 0xd9])]);
}

export async function startFakePtzoptics({
  port = 0, viscaPort = 0, host = '127.0.0.1', username = 'admin', password = 'secret',
  firmware = '9.1.66', queries = true, replyAddress = 0x90,
} = {}) {
  const realm = 'ptzoptics';
  const nonce = randomBytes(8).toString('hex');
  const state = {
    image: Object.fromEntries(Object.entries(IMAGE).map(([k, v]) => [k, v[1]])),
    video: Object.fromEntries(Object.entries(VIDEO).map(([k, v]) => [k, v[0]])),
    audio: Object.fromEntries(Object.entries(AUDIO).map(([k, v]) => [k, v[0]])),
    other: {},
    device: { devname: 'ptzoptics', devtype: 'MOVE-SE', mirrors: 'https://firmware.ptzoptics.com/', versioninfo: `SOC v${firmware}`, serial_num: 'q1i0000001', device_model: 'F16.HI' },
    ir: 1,
    focusLock: false,
    focusRange: { enable: 0, near: 0, far: 11 },
    autotrack: false,
    trackingSubject: [],
    power: 2,
    awbSens: 1,
    freeze: false,
    head: { pan: 0, tilt: 0, zoom: 0, focus: 0x0400, v: { pan: 0, tilt: 0, zoom: 0, focus: 0 }, at: Date.now() },
    presets: new Map(),
    firmware,
    queries,
    replyAddress,
    silent: false,
    busy: false,
    /** VISCA alone goes quiet (the HTTP side still answers): bytes are read and ignored. */
    viscaSilent: false,
    /** VISCA inquiry replies take this long (a busy camera). */
    inquiryDelayMs: 0,
    cgiLog: [],
    viscaLog: [],
  };
  const build = Number(/9\.1\.(\d+)/.exec(firmware)?.[1] ?? 0);
  const held = new Set();
  const sockets = new Set();

  function integrate() {
    const h = state.head;
    const now = Date.now();
    const dt = (now - h.at) / 1000;
    h.at = now;
    // Units are the camera's own (undocumented scale on the SE); roughly 0x0990 per 170°.
    h.pan = Math.max(-2448, Math.min(2448, h.pan + h.v.pan * 1500 * dt));
    h.tilt = Math.max(-432, Math.min(1296, h.tilt + h.v.tilt * 1000 * dt));
    h.zoom = Math.max(0, Math.min(0x4000, h.zoom + h.v.zoom * 0x4000 / 3 * dt));
    h.focus = Math.max(0, Math.min(0xffff, h.focus + h.v.focus * 0x1000 * dt));
  }

  // --- VISCA over TCP --------------------------------------------------------

  let socketNo = 0;
  function viscaHandle(p) {
    const h = state.head;
    const is = (...b) => b.every((x, i) => p[i] === x);
    const len = p.length;
    if (p[0] !== 0x81) return { error: 0x02 };
    // Inquiries: 81 09 ...
    if (p[1] === 0x09) {
      integrate();
      const pq = (v) => [0x00, 0x00, (v >> 4) & 0x0f, v & 0x0f];
      const map = {
        '81 09 04 00 ff': [state.power],
        '81 09 06 12 ff': [...nib(Math.round(h.pan) & 0xffff, 4), ...nib(Math.round(h.tilt) & 0xffff, 4)],
        '81 09 04 47 ff': nib(Math.round(h.zoom), 4),
        '81 09 04 48 ff': nib(Math.round(h.focus), 4),
        '81 09 04 39 ff': [Number(state.image.aemode)],
        '81 09 04 3e ff': [Number(state.image.expcomp_mode)],
        '81 09 04 33 ff': [Number(state.image.backlight)],
        '81 09 04 55 ff': [Number(state.image.antiflicker)],
        '81 09 04 4b ff': pq(Number(state.image.iris)),
        '81 09 04 35 ff': [Number(state.image.wbmode)],
        '81 09 04 43 ff': pq(Number(state.image.rgain)),
        '81 09 04 44 ff': pq(Number(state.image.bgain)),
        '81 09 04 12 ff': pq(Number(state.image.rgaintuning)),
        '81 09 04 13 ff': pq(Number(state.image.bgaintuning)),
        '81 09 04 63 ff': [state.image.bwmode === '1' ? 0x04 : 0x00],
        '81 09 04 38 ff': [Number(state.image.focusmode)],
      };
      const data = map[hx(p)];
      return data ? { reply: data } : { error: 0x02 };
    }
    if (state.busy) return { error: 0x03 };
    if (is(0x81, 0x01, 0x06, 0x01) && len === 9) {
      const [vv, ww, dp, dt] = [p[4], p[5], p[6], p[7]];
      if (vv < 1 || vv > 0x18 || ww < 1 || ww > 0x14 || ![1, 2, 3].includes(dp) || ![1, 2, 3].includes(dt)) return { error: 0x02 };
      integrate();
      h.v.pan = dp === 2 ? vv / 0x18 : dp === 1 ? -vv / 0x18 : 0;
      h.v.tilt = dt === 1 ? ww / 0x14 : dt === 2 ? -ww / 0x14 : 0;
      // Since 9.1.46 a pan/tilt stop no longer stops zoom (FW-0112); before, it did.
      if (dp === 3 && dt === 3 && build < 46) h.v.zoom = 0;
      return { ok: true };
    }
    if (is(0x81, 0x01, 0x04, 0x07) && len === 6) {
      const b = p[4];
      integrate();
      if (b === 0x00) h.v.zoom = 0;
      else if (b === 0x02 || b === 0x03) h.v.zoom = b === 0x02 ? 0.5 : -0.5;
      else if ((b & 0xf0) === 0x20 || (b & 0xf0) === 0x30) h.v.zoom = (((b & 0x0f) + 1) / 8) * ((b & 0xf0) === 0x20 ? 1 : -1);
      else return { error: 0x02 };
      return { ok: true };
    }
    if (is(0x81, 0x01, 0x04, 0x08) && len === 6) {
      const b = p[4];
      if (![0x00, 0x02, 0x03].includes(b)) return { error: 0x02 };
      if (b !== 0x00 && state.image.focusmode !== '3') return { error: 0x41 };
      integrate();
      h.v.focus = b === 0x02 ? 1 : b === 0x03 ? -1 : 0;
      return { ok: true };
    }
    if (is(0x81, 0x01, 0x06, 0x04, 0xff)) { integrate(); Object.assign(h, { pan: 0, tilt: 0 }); return { ok: true }; }
    if (is(0x81, 0x01, 0x04, 0x3f) && len === 7) {
      const n = p[5];
      if (n > 254 || ![1, 2].includes(p[4])) return { error: 0x02 };
      integrate();
      if (p[4] === 0x02) {
        // The special numbers (EX-SAVE banner; FW-0112).
        if (n === 90) Object.assign(h, { pan: 0, tilt: 0 });
        else if (n === 150) state.autotrack = true;
        else if (n === 151) state.autotrack = false;
        else { const s = state.presets.get(n); if (s) Object.assign(h, s); }
      } else {
        state.presets.set(n, { pan: h.pan, tilt: h.tilt, zoom: h.zoom, focus: h.focus });
      }
      return { ok: true };
    }
    if (is(0x81, 0x0a, 0x11, 0x54) && len === 6) {
      if (![2, 3].includes(p[4])) return { error: 0x02 };
      state.autotrack = p[4] === 2; return { ok: true };
    }
    if (is(0x81, 0x0a, 0x11, 0xa3) && len === 6) {
      if (![2, 3, 4].includes(p[4])) return { error: 0x02 };
      if (!state.autotrack) return { error: 0x41 };
      state.trackingSubject.push(p[4]); return { ok: true };
    }
    if (is(0x81, 0x01, 0x04, 0xa9) && len === 6) { if (p[4] > 2) return { error: 0x02 }; state.awbSens = p[4]; return { ok: true }; }
    if (is(0x81, 0x01, 0x04, 0x62) && len === 6) { if (![2, 3].includes(p[4])) return { error: 0x02 }; state.freeze = p[4] === 2; return { ok: true }; }
    if (is(0x81, 0x01, 0x04, 0x00) && len === 6) { if (![2, 3].includes(p[4])) return { error: 0x02 }; state.power = p[4]; return { ok: true }; }
    return { error: 0x02 };
  }

  const viscaServer = net.createServer((sock) => {
    sockets.add(sock);
    let rx = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));
    sock.on('data', (chunk) => {
      if (state.silent || state.viscaSilent) return;
      rx = Buffer.concat([rx, chunk]);
      for (;;) {
        const end = rx.indexOf(0xff);
        if (end < 0) break;
        const p = rx.subarray(0, end + 1);
        rx = rx.subarray(end + 1);
        state.viscaLog.push(hx(p));
        const r = viscaHandle(p);
        const a = state.replyAddress;
        try {
          if (r.reply && state.inquiryDelayMs) {
            const out = Buffer.from([a, 0x50, ...r.reply, 0xff]);
            setTimeout(() => { try { sock.write(out); } catch { /* gone */ } }, state.inquiryDelayMs);
            continue;
          }
          if (r.reply) { sock.write(Buffer.from([a, 0x50, ...r.reply, 0xff])); continue; }
          socketNo = socketNo === 1 ? 2 : 1;
          if (r.error === 0x41) { sock.write(Buffer.from([a, 0x60 | socketNo, 0x41, 0xff])); continue; }
          if (r.error) { sock.write(Buffer.from([a, 0x60, r.error, 0xff])); continue; }
          sock.write(Buffer.from([a, 0x40 | socketNo, 0xff, a, 0x50 | socketNo, 0xff]));
        } catch { /* client gone */ }
      }
    });
  });

  // --- HTTP-CGI --------------------------------------------------------------

  function authorised(req) {
    const h = req.headers.authorization;
    if (!h || !/^Digest /i.test(h)) return false;
    const p = {};
    for (const m of h.slice(7).matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)) p[m[1].toLowerCase()] = m[2] ?? m[3];
    if (p.username !== username || p.nonce !== nonce) return false;
    const ha1 = md5(`${username}:${realm}:${password}`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    return p.response === md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
  }

  const lines = (obj) => Object.entries(obj).map(([k, v]) => `${k}="${v}"`).join('\n');
  function imageConf(half) {
    const out = {};
    const keys = Object.entries(IMAGE).filter(([, d]) => d[0]);
    // The split between the two queries is not documented; any split will do.
    for (const [i, [k, d]] of keys.entries()) if ((i % 2 === 0) === (half === 0)) out[d[0]] = state.image[k];
    if (half === 1) {
      out.autotrack = state.autotrack ? '1' : '0';
      out.focus_mode_status = state.focusLock ? 'lock' : 'unlock';
      out.focuslimit = String(state.focusRange.enable);
      out.nearestpos = String(state.focusRange.near);
      out.furthestpos = String(state.focusRange.far);
    }
    return lines(out);
  }

  const ok = (res, body = '{"Result":"Success"}') => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body); };
  const bad = (res, status = 400) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end('{"Result":"Error"}'); };

  function handle(req, res) {
    const [path, query = ''] = req.url.split('?');
    const parts = query.split('&').map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
    const kv = Object.fromEntries(parts.filter((s) => s.includes('=')).map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]));
    state.cgiLog.push(`${req.method} ${req.url}`);

    if (path === '/snapshot0.jpg' || path === '/snapshot1.jpg') {
      if (build < 66) return bad(res, 404);
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return res.end(tinyJpeg());
    }
    if (path === '/api/v1/info/pt-limit') {
      if (build < 66) return bad(res, 404);
      return ok(res, JSON.stringify({ panMax: 170, panMin: -170, tiltMax: 90, tiltMin: -30 }));
    }
    if (path === '/cgi-bin/ptzctrl.cgi') {
      if (parts[0] === 'post_image_value') {
        const [, k, v] = parts;
        const d = IMAGE[k];
        if (!d || v === undefined || !d[2](v)) return bad(res);
        state.image[k] = v;
        return ok(res);
      }
      if (parts[0] === 'ptzcmd') {
        const h = state.head;
        integrate();
        const a = parts[1];
        if (a === 'ptzstop') { h.v.pan = 0; h.v.tilt = 0; return ok(res); }
        if (a === 'zoomstop') { h.v.zoom = 0; return ok(res); }
        if (a === 'focusstop') { h.v.focus = 0; return ok(res); }
        if (a === 'home') { Object.assign(h, { pan: 0, tilt: 0 }); return ok(res); }
        return bad(res);
      }
      return bad(res, 404);
    }
    if (path === '/cgi-bin/param.cgi') {
      const c = parts[0];
      if (req.method === 'GET' && c.startsWith('get_') || c === 'query_ir_info') {
        if (!state.queries) return bad(res, 404);
        if (c === 'get_device_conf') return ok(res, JSON.stringify({ status: 200, data: state.device }));
        if (c === 'get_image_conf') return ok(res, imageConf(0));
        if (c === 'get_advance_image_conf') return ok(res, imageConf(1));
        if (c === 'get_media_video') return ok(res, lines(state.video));
        if (c === 'get_media_audio') return ok(res, lines(state.audio));
        if (c === 'query_ir_info') return ok(res, lines({ IR_Channel: state.ir }));
        return bad(res, 404);
      }
      if (c === 'set_overlay') {
        if (parts[1] === 'autotracking' && ['on', 'off'].includes(parts[2])) { state.autotrack = parts[2] === 'on'; return ok(res); }
        if (['osdreset', 'networkreset', 'fullreset'].includes(parts[1]) && parts[2] === 'trigger') return ok(res);
        return bad(res);
      }
      if (c === 'set_focus' && parts[1] === 'one_shot_focus') return ok(res);
      if (c === 'ptzcmd' && ['lock_mfocus', 'unlock_mfocus'].includes(parts[1])) { state.focusLock = parts[1] === 'lock_mfocus'; return ok(res); }
      if (c === 'pan_tiltdrive_reset') return ok(res);
      if (c === 'post_ir_info=') {
        if (!range(1, 4)(kv.ir_id)) return bad(res);
        state.ir = Number(kv.ir_id); return ok(res);
      }
      if (c === 'post_zoomfocus' && kv.type === 'focusrange') {
        if (!oneOf(0, 1)(kv.enable) || !range(0, 11)(kv.near) || !range(0, 11)(kv.far)) return bad(res);
        state.focusRange = { enable: +kv.enable, near: +kv.near, far: +kv.far }; return ok(res);
      }
      if (req.method !== 'POST') return bad(res, 404);
      if (c === 'post_media_video') {
        const [, k, v] = parts;
        if (!VIDEO[k] || v === undefined || !VIDEO[k][1](v)) return bad(res);
        state.video[k] = v; return ok(res);
      }
      if (c === 'post_media_audio') {
        const [k, v] = Object.entries(kv)[0] ?? [];
        if (!AUDIO[k] || !AUDIO[k][1](v)) return bad(res);
        state.audio[k] = v; return ok(res);
      }
      if (['post_network_other_conf', 'post_network_info_conf', 'post_ndi_info'].includes(c)) {
        Object.assign(state.other, kv); return ok(res);
      }
      if (c === 'post_devinfo_conf' && kv.devname !== undefined) { state.device.devname = kv.devname; return ok(res); }
      if (c === 'post_reboot') return ok(res);
      return bad(res);
    }
    return bad(res, 404);
  }

  const server = http.createServer((req, res) => {
    if (state.silent) { held.add(res); res.on('close', () => held.delete(res)); return; }
    if (!authorised(req)) {
      res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}"` });
      res.end();
      return;
    }
    req.resume();
    req.on('end', () => {
      try { handle(req, res); } catch { bad(res, 500); }
    });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  await new Promise((resolve) => viscaServer.listen(viscaPort, host, resolve));

  return {
    port: server.address().port,
    viscaPort: viscaServer.address().port,
    state,
    setSilent(on) {
      state.silent = !!on;
      if (!on) for (const res of held) { try { res.destroy(); } catch { /* gone */ } }
    },
    /** Drops every VISCA connection, as a camera reboot would. */
    dropConnections() { for (const s of sockets) s.destroy(); },
    async close() {
      for (const res of held) { try { res.destroy(); } catch { /* gone */ } }
      for (const s of sockets) s.destroy();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      await new Promise((r) => viscaServer.close(() => r()));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
  const httpPort = Number(arg('port', 8081));
  const fake = await startFakePtzoptics({
    port: httpPort,
    viscaPort: Number(arg('visca-port', httpPort + 1)),
    host: arg('host', '127.0.0.1'),
    username: arg('username', 'admin'),
    password: arg('password', 'secret'),
    firmware: arg('firmware', '9.1.66'),
  });
  console.log(JSON.stringify({ fake: 'ptzoptics-move-se', http: fake.port, visca: fake.viscaPort }));
}
