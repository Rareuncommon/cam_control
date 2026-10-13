// A Canon CR-N500 on the XC protocol, as the spec notes describe it.
//
// A real HTTP server speaking `/-wvhttp-01-/…`: `name:=value` replies, the
// `Livescope-Status` header carrying the result while HTTP stays 200, `==?`
// for a value the current mode will not take, Digest auth when credentials are
// set, the multipart `info.cgi?type=stream` event stream, presets, tally,
// standby, `image.cgi`, and (optionally) the RA-AT001 tracking add-on's CGIs.
// The head moves: direction moves integrate into positions over time.
//
// Test hooks on `state`: `log` (every command, with its parameters in order),
// `controlHeld` (another client holds privileged control: control.cgi answers
// Livescope 301), `values` (the info tree). `set(key, value)` changes a value
// "from another client" and pushes it to open event streams.
//
// Standalone: node test/fakes/canon-xc.js --port 8080 [--user u --pass p] [--tracking]

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const XC = '/-wvhttp-01-/';
const ADDON = '/cgi-addon/Auto_Tracking_RA-AT001/app_ctrl/';

const IRIS = '280,320,340,370,400,440,450,480,520,560,620,670,730,800,870,950,1000,1100';
const SHUTTER = '60,75,90,100,120,150,180,210,250,300,360,420,500,600,720,840,1000,1200,1400,1700,2000';
// The fake's own colour-temperature steps; the spec's list is non-uniform too (XC5 p.59).
const KELVIN = '2000,2500,2800,3200,3500,4000,4300,4800,5000,5600,6000,6500,7500,8000,10000,12000,15000';

/** A 64x36 grey-blue gradient JPEG — something a multiview tile can draw. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAkAEADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAQF/8QAFxABAQEBAAAAAAAAAAAAAAAAABMBEv/EABYBAQEBAAAAAAAAAAAAAAAAAAACBP/EABURAQEAAAAAAAAAAAAAAAAAAAAR/9oADAMBAAIRAxEAPwDEkSXSJNdZYhkSXSJFIhkSXSJFIhkSXSJFIukSXSJIq4hkSXSJFIhkSXSJFIhkSXSJFIr5w5wEqOcOcADnDnAA5w5wAf/Z',
  'base64');

function initialValues(model) {
  const v = new Map();
  const put = (k, val) => v.set(k, String(val));
  const enumOf = (k, value, list) => { put(k, value); put(`${k}.list`, list); };
  const rangeOf = (k, value, min, max) => { put(k, value); put(`${k}.min`, min); put(`${k}.max`, max); };

  // System, identity (XC5 p.125, p.127)
  put('s.hardware', `Canon ${model}`);
  put('s.hardware.id', 110);
  put('s.hardware.address', '000085000000');
  put('s.hardware.maxsize', '3840x2160');
  put('s.firmware', '1.3.0');
  put('s.protocol', '7.0.0');
  put('s.epoch', 'Wed, 24 May 2023 15:44:37 +0900');
  put('s.system.status', 'idle');
  put('s.maxsize', '1920x1080');
  put('s.action.list', 'save');
  put('c', 1);
  put('c.count', 1);
  put('c.1.type', `Canon ${model}`);
  put('c.1.status', 'enabled');
  put('c.1.name.utf8', 'Camera');
  put('c.1.platform.status', 'initialized');
  put('c.1.platform.error', 0);

  // Exposure (XC5 p.127-135)
  enumOf('c.1.shooting', 'manual', 'fullauto,manual');
  enumOf('c.1.exp', 'auto', 'auto,manual');
  rangeOf('c.1.ae.brightness', 0, -8, 8);
  rangeOf('c.1.me.brightness', 0, -8, 8);
  enumOf('c.1.ae.photometry', 'center', 'center,spotlight,backlight');
  enumOf('c.1.me.photometry', 'center', 'center,spotlight,backlight');
  rangeOf('c.1.ae.resp', 1, 0, 2);
  rangeOf('c.1.me.resp', 1, 0, 2);
  enumOf('c.1.me.diaphragm.mode', 'auto', 'auto,manual');
  enumOf('c.1.me.diaphragm', 400, IRIS);
  enumOf('c.1.me.shutter.mode', 'auto', 'auto,speed,slow,clearscan');
  enumOf('c.1.me.shutter', 60, SHUTTER);
  rangeOf('c.1.me.clearscan', 5994, 5994, 25038);
  enumOf('c.1.ae.flickerreduct', 'off', 'off,auto');
  enumOf('c.1.me.flickerreduct', 'off', 'off,auto');
  enumOf('c.1.me.gain.mode', 'auto', 'auto,manual');
  rangeOf('c.1.me.gain', 0, -60, 330);
  rangeOf('c.1.ae.gainlimit.max', 330, 0, 330);
  rangeOf('c.1.me.gainlimit.max', 330, -60, 330);
  enumOf('c.1.nd.mode', 'manual', 'manual');
  enumOf('c.1.nd.filter', 0, '0,400,1600,6400');

  // White balance (XC5 p.136, p.142)
  enumOf('c.1.wb', 'auto', 'auto,manual,kelvin,daylight,tungsten,wb_a,wb_b');
  put('c.1.wb.action.list', 'one_shot_a,one_shot_b');
  put('c.1.wb.value', '220-250');
  enumOf('c.1.wb.kelvin', 5600, KELVIN);
  rangeOf('c.1.wb.kelvin.cc', 0, -20, 20);
  rangeOf('c.1.wb.resp', 1, 0, 2);
  rangeOf('c.1.wb.shift.rgain', 0, -50, 50);
  rangeOf('c.1.wb.shift.bgain', 0, -50, 50);

  // Image (XC5 p.137-142). No c.1.colorbar: XC5 does not list it for CR-N500.
  enumOf('c.1.cp', 'normal1_bt709', 'normal1_bt709,normal1_bt2020,widedr_bt709,widedr_bt2020,clog3_bt2020,clog3_bt709,off');
  enumOf('c.1.gamma', 'normal1', 'normal1,normal2,normal3,normal4,widedr,clog3');
  enumOf('c.1.colorspace', 'gamut_bt709', 'gamut_bt709,gamut_bt2020');
  enumOf('c.1.colormatrix', 'video', 'video,neutral');
  for (const k of ['blacklevel', 'blacklevel.red', 'blacklevel.blue', 'blackgamma', 'ac.limit',
    'colormatrix.gain', 'colormatrix.rg', 'colormatrix.rb', 'colormatrix.gr', 'colormatrix.gb', 'colormatrix.br', 'colormatrix.bg']) {
    rangeOf(`c.1.${k}`, 0, -50, 50);
  }
  rangeOf('c.1.blackgamma.range', 0, -20, 50);
  rangeOf('c.1.blackgamma.point', 0, -20, 50);
  enumOf('c.1.knee', 'off', 'off,on');
  enumOf('c.1.knee.automatic', 'off', 'off,on');
  rangeOf('c.1.knee.slope', 0, -35, 50);
  rangeOf('c.1.knee.point', 95, 50, 109);
  rangeOf('c.1.knee.saturation', 0, -10, 10);
  enumOf('c.1.nr.mode', 'auto', 'manual,auto');
  rangeOf('c.1.nr', 6, 0, 12);
  rangeOf('c.1.ac', 0, -10, 50);
  rangeOf('c.1.colormatrix.phase', 0, -18, 18);
  enumOf('c.1.is', 'off', 'off,on1,on2');
  enumOf('c.1.erotate', 0, '0,18000');

  // Focus (XC5 p.145-147)
  enumOf('c.1.focus', 'auto', 'auto,manual');
  put('c.1.focus.action.list', 'stop,one_shot,near,far');
  rangeOf('c.1.focus.value', 1352, 0, 2048);
  enumOf('c.1.focus.restrict', 'off', 'off,on');
  rangeOf('c.1.focus.speed', 1, 0, 2);
  enumOf('c.1.focus.auto', 'continuous', 'continuous,afboosted');
  rangeOf('c.1.focus.auto.speed', 1, 0, 2);
  rangeOf('c.1.focus.auto.resp', 1, 0, 2);
  enumOf('c.1.focus.frame.1', 'auto', 'auto,large,small');
  rangeOf('c.1.focus.frame.1.x', 5000, 0, 9999);
  rangeOf('c.1.focus.frame.1.y', 5000, 0, 9999);
  enumOf('c.1.focus.detect', 'off', 'off,faceonly,facecatch');
  enumOf('c.1.focus.auto.track', 'off', 'off,on');
  enumOf('c.1.focus.auto.track.mode', 'mode1', 'mode1,mode2');

  // Zoom, pan, tilt (XC5 p.148-152)
  rangeOf('c.1.zoom', 7300, 570, 7300);
  put('c.1.zoom.status', 0);
  rangeOf('c.1.zoom.speed.dir', 8, 0, 15);
  enumOf('c.1.zoom.mode', 'off', 'off,dzoom,mag');
  enumOf('c.1.zoom.mag', 100, '100,150,300,600');
  for (const [axis, min, max] of [['pan', -17000, 17000], ['tilt', -3000, 9000]]) {
    rangeOf(`c.1.${axis}`, 0, min, max);
    put(`c.1.${axis}.status`, 0);
    rangeOf(`c.1.${axis}.speed.dir`, 625, 10, 10000);
    put(`c.1.${axis}.speed.mode.list`, 'manual,auto1,auto2');
    enumOf(`c.1.${axis}.speed.mode.dir`, 'auto2', 'manual,auto1,auto2');
    rangeOf(`c.1.${axis}.ramp`, 1, 0, 2);
  }

  // Tally, standby, outputs, streams (XC5 p.155-156, p.126-127)
  enumOf('f.tally', 'off', 'off,on');
  enumOf('f.tally.mode', 'program', 'preview,program');
  put('f.standby', 'idle');
  put('f.output.list', 'output1:hdmi_3g-sdi');
  put('f.output1.videoinfo', '1920x1080:59940:P');
  put('v.list', 'h264:1920x1080:0:59940,jpg:1280x720:6:14980');

  // Presets (XC5 p.152-154)
  put('p', 0);
  put('p.count', 100);
  put('p.status', 0);
  put('p.action.list', 'stop');
  for (let n = 1; n <= 100; n++) put(`p.${n}.content`, 'disabled');
  return v;
}

/** Keys that are status, not settings: control.cgi refuses them. */
const READ_ONLY = /^(s\.|v\.|c\.1\.(type|status|name|platform)|c\.1\.(pan|tilt|zoom)\.status|f\.output|f\.standby|p\.)|\.list$|\.min$|\.max$/;

/** Mode gates: a write to these while the mode is wrong answers `==?` (XC5 p.48, p.74). */
const GATES = {
  'c.1.ae.brightness': (v) => v.get('c.1.exp') === 'auto',
  'c.1.me.brightness': (v) => v.get('c.1.exp') === 'manual',
  'c.1.me.diaphragm': (v) => v.get('c.1.me.diaphragm.mode') === 'manual',
  'c.1.me.gain': (v) => v.get('c.1.me.gain.mode') === 'manual',
  'c.1.me.clearscan': (v) => v.get('c.1.me.shutter.mode') === 'clearscan',
  'c.1.wb.kelvin': (v) => v.get('c.1.wb') === 'kelvin',
  'c.1.wb.value': (v) => v.get('c.1.wb') === 'manual',
  'c.1.focus.value': (v) => v.get('c.1.focus') === 'manual',
};

export async function startFakeCanon({ port = 0, host = '127.0.0.1', username, password, model = 'CR-N500', tracking = false } = {}) {
  const values = initialValues(model);
  const started = Date.now();
  const state = {
    values,
    log: [],
    controlHeld: false,
    silent: false,
    requests: 0,
    streams: new Set(),
    presets: new Map(),
    /** Direction moves in progress, in position units per second. */
    vel: { pan: 0, tilt: 0, zoom: 0, focus: 0 },
    addon: tracking ? {
      trackingEnable: '0', autoZoomEnable: '1', sensitivity: '5', tiltFixed: '0',
      recoveryControl: '0', recoveryControlTime: '5', targetSizeLevel: '3',
    } : null,
  };
  const nonces = new Set();
  const md5 = (s) => createHash('md5').update(s).digest('hex');
  const realm = 'Canon fake';

  // --- the head ------------------------------------------------------------------
  const POS = { pan: 'c.1.pan', tilt: 'c.1.tilt', zoom: 'c.1.zoom', focus: 'c.1.focus.value' };
  let simAt = Date.now();
  let simTimer = null;
  const moving = () => Object.values(state.vel).some((x) => x !== 0);

  function integrate() {
    const now = Date.now();
    const dt = (now - simAt) / 1000;
    simAt = now;
    const changed = [];
    for (const [axis, key] of Object.entries(POS)) {
      const vel = state.vel[axis];
      if (!vel) continue;
      const min = Number(values.get(`${key}.min`));
      const max = Number(values.get(`${key}.max`));
      let x = Number(values.get(key)) + vel * dt;
      if (x <= min || x >= max) { x = Math.max(min, Math.min(max, x)); stopAxis(axis, changed); }
      values.set(key, String(Math.round(x)));
      changed.push(key);
    }
    return changed;
  }

  function stopAxis(axis, changed) {
    state.vel[axis] = 0;
    const flag = { pan: 'c.1.pan.status', tilt: 'c.1.tilt.status', zoom: 'c.1.zoom.status' }[axis];
    if (flag && values.get(flag) !== '0') { values.set(flag, '0'); changed?.push(flag); }
  }

  function startAxis(axis, vel, changed) {
    state.vel[axis] = vel;
    const flag = { pan: 'c.1.pan.status', tilt: 'c.1.tilt.status', zoom: 'c.1.zoom.status' }[axis];
    if (flag && values.get(flag) !== '1') { values.set(flag, '1'); changed.push(flag); }
    if (!simTimer) {
      simTimer = setInterval(() => {
        const changed2 = integrate();
        pushPositions(changed2);
        if (!moving()) { clearInterval(simTimer); simTimer = null; }
      }, 100);
      simTimer.unref?.();
    }
  }

  // --- replies -------------------------------------------------------------------
  const stamp = () => `timestamp=${((Date.now() - started) / 1000).toFixed(3)}\nrealtime=${(Date.now() / 1000).toFixed(3)}\n`;
  const baseHeaders = (ls = 0) => ({ 'Content-Type': 'text/plain;charset=utf-8', 'Livescope-Status': String(ls), Server: 'vb', 'Cache-Control': 'no-cache' });
  function reply(res, body = '', ls = 0) {
    res.writeHead(200, baseHeaders(ls));
    res.end(body);
  }

  function selected(selectors, key) {
    if (!selectors.length) return true;
    let hit = false;
    for (const s of selectors) {
      const ex = s.endsWith('!');
      const name = ex ? s.slice(0, -1) : s;
      if (key === name || key.startsWith(`${name}.`)) hit = !ex;
    }
    return hit;
  }
  const selectorsOf = (url) => url.searchParams.getAll('item').flatMap((x) => x.split(',')).filter(Boolean);
  const lines = (keys) => keys.map((k) => `${k}:=${values.get(k)}\n`).join('');

  // --- event streams ---------------------------------------------------------------
  function sendPart(client, body) {
    if (state.silent || client.res.writableEnded) return;
    const buf = Buffer.from(body, 'utf8');
    client.res.write(`--boundary\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${buf.length}\r\n\r\n`);
    client.res.write(buf);
    client.res.write('\r\n');
    armIdle(client);
  }

  function armIdle(client) {
    clearTimeout(client.idle);
    if (!client.timeoutS) return;
    client.idle = setTimeout(() => sendPart(client, stamp()), client.timeoutS * 1000);
    client.idle.unref?.();
  }

  function notify(keys) {
    const uniq = [...new Set(keys)];
    for (const c of state.streams) {
      const mine = uniq.filter((k) => values.has(k) && selected(c.selectors, k));
      if (mine.length) sendPart(c, stamp() + lines(mine));
    }
  }

  /** Positions during a move, at most every `interval` ms per client (XC5 p.54). */
  function pushPositions(changed) {
    const flags = changed.filter((k) => k.endsWith('.status'));
    const pos = changed.filter((k) => !k.endsWith('.status'));
    const now = Date.now();
    for (const c of state.streams) {
      const send = [...flags];
      if (c.interval > 0 && now - (c.lastPos ?? 0) >= c.interval) { send.push(...pos); c.lastPos = now; }
      if (!moving()) send.push(...pos);   // the final position when the move ends
      const mine = [...new Set(send)].filter((k) => selected(c.selectors, k));
      if (mine.length) sendPart(c, stamp() + lines(mine));
    }
  }

  // --- auth ----------------------------------------------------------------------
  function authorised(req) {
    if (!username) return true;
    const h = req.headers.authorization ?? '';
    const m = /^Digest\s+(.*)$/i.exec(h);
    if (!m) return false;
    const p = {};
    for (const x of m[1].matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)) p[x[1].toLowerCase()] = x[2] ?? x[3];
    if (p.username !== username || !nonces.has(p.nonce)) return false;
    const ha1 = md5(`${username}:${realm}:${password ?? ''}`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    return p.response === md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
  }

  function challenge(res) {
    const nonce = randomBytes(8).toString('hex');
    nonces.add(nonce);
    res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}"`, Server: 'vb' });
    res.end();
  }

  // --- commands --------------------------------------------------------------------
  function info(req, res, url) {
    const selectors = selectorsOf(url);
    const keys = [...values.keys()].filter((k) => selected(selectors, k));
    if (url.searchParams.get('type') !== 'stream') { reply(res, stamp() + lines(keys)); return; }
    const t = url.searchParams.get('timeout');
    if (t !== null && !/^\d+$/.test(t)) { reply(res, '', 403); return; }
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace;boundary=boundary', 'Livescope-Status': '0', Server: 'vb' });
    const client = { res, selectors, timeoutS: t ? Number(t) : 0, interval: Number(url.searchParams.get('interval') ?? 0), lastPos: 0 };
    state.streams.add(client);
    res.on('close', () => { clearTimeout(client.idle); state.streams.delete(client); });
    sendPart(client, stamp() + lines(keys));
  }

  function validate(key, val) {
    const list = values.get(`${key}.list`);
    if (list !== undefined) return list.split(',').includes(val);
    const min = values.get(`${key}.min`);
    if (min !== undefined) {
      const n = Number(val);
      return /^-?\d+$/.test(val) && n >= Number(min) && n <= Number(values.get(`${key}.max`));
    }
    if (key === 'c.1.wb.value') return /^\d{1,4}-\d{1,4}$/.test(val) && val.split('-').every((x) => Number(x) <= 1023);
    return false;
  }

  function control(req, res, url) {
    const pairs = [...url.searchParams.entries()];
    state.log.push({ cmd: 'control', params: pairs, at: Date.now() });
    if (state.controlHeld) { reply(res, '', 301); return; }      // XC5 p.73-75
    integrate();

    // Validate everything first: an invalid value is a 403 for the whole request (XC5 p.9).
    for (const [k, v] of pairs) {
      const axis = { 'c.1.pan': 'pan', 'c.1.tilt': 'tilt', 'c.1.zoom': 'zoom' }[k];
      const ok = axis
        ? ({ pan: ['left', 'right', 'stop'], tilt: ['up', 'down', 'stop'], zoom: ['tele', 'wide', 'stop'] }[axis].includes(v) || validate(k, v))
        : k === 'c.1.focus.action' || k === 'c.1.wb.action' || k === 'p.action' || k === 's.action'
          ? (values.get(`${k}.list`) ?? '').split(',').includes(v)
          : k === 'p' ? /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 100
            : k === 'p.ptzspeed' ? /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 100
              : k === 'p.ptztime' ? /^\d+$/.test(v) && Number(v) >= 2000 && Number(v) <= 99000
                : !READ_ONLY.test(k) && validate(k, v);
      if (!ok) { reply(res, '', 403); return; }
    }

    const out = [];
    const changed = [];
    const dirs = {};
    for (const [k, v] of pairs) {
      if (GATES[k] && !GATES[k](values)) { out.push(`${k}==?`); continue; }
      if (k === 'c.1.focus.action') {
        if ((v === 'near' || v === 'far') && values.get('c.1.focus') !== 'manual') { out.push(`${k}==?`); continue; }
        if (v === 'near' || v === 'far') dirs.focus = v === 'far' ? 1 : -1;
        if (v === 'stop') dirs.focus = 0;
        if (v === 'one_shot') { values.set('c.1.focus.value', '1024'); changed.push('c.1.focus.value'); }
        out.push(`${k}:=${v}`);
        continue;
      }
      if (['c.1.pan', 'c.1.tilt', 'c.1.zoom'].includes(k)) {
        const axis = k.slice(4);
        if (/^-?\d+$/.test(v)) {               // absolute position
          dirs[axis] = 0;
          values.set(k, v);
          changed.push(k);
        } else {
          dirs[axis] = { right: 1, up: 1, tele: -1, left: -1, down: -1, wide: 1, stop: 0 }[v];
        }
        out.push(`${k}:=${v}`);
        continue;
      }
      if (k === 'p') {
        const n = Number(v);
        if (values.get(`p.${n}.content`) !== 'enabled') { reply(res, '', 403); return; }
        for (const axis of Object.keys(POS)) stopAxis(axis, changed);
        for (const [axis, key] of Object.entries(POS)) { values.set(key, String(state.presets.get(n)[axis])); changed.push(key); }
        values.set('p', v);
        changed.push('p');
        out.push(`p:=${v}`);
        continue;
      }
      if (k === 'p.action') { values.set('p.status', '0'); out.push(`${k}:=${v}`); continue; }
      if (k === 'p.ptzspeed' || k === 'p.ptztime' || k === 's.action' || k === 'c.1.wb.action') { out.push(`${k}:=${v}`); continue; }
      if (values.get(k) === v) { out.push(`${k}==${v}`); continue; }
      values.set(k, v);
      changed.push(k);
      out.push(`${k}:=${v}`);
    }

    // Direction moves start after the whole request is read, with the speeds it carried.
    for (const [axis, d] of Object.entries(dirs)) {
      if (!d) { stopAxis(axis, changed); continue; }
      const speed = axis === 'focus' ? (Number(values.get('c.1.focus.speed')) + 1) * 200
        : axis === 'zoom' ? (Number(values.get('c.1.zoom.speed.dir')) + 1) * 200
          : Number(values.get(`c.1.${axis}.speed.dir`));          // 100 = 1°/s = 100 units/s
      startAxis(axis, d * speed, changed);
    }
    reply(res, out.join('\n') + (out.length ? '\n' : ''));
    if (changed.length) notify(changed);
  }

  function presetSet(req, res, url) {
    const q = url.searchParams;
    state.log.push({ cmd: 'preset/set', params: [...q.entries()], at: Date.now() });
    const p = q.get('p');
    if (!p) { reply(res, '', 406); return; }
    if (q.get('cmd') === 'delete') {
      const list = p.replace(/,$/, '').split(',');
      if (!list.every((x) => /^\d+$/.test(x) && Number(x) >= 1 && Number(x) <= 100)) { reply(res, '', 403); return; }
      const changed = [];
      for (const x of list) {
        for (const k of [...values.keys()]) if (k.startsWith(`p.${x}.`)) values.delete(k);
        values.set(`p.${x}.content`, 'disabled');
        state.presets.delete(Number(x));
        changed.push(`p.${x}.content`);
      }
      reply(res, `p:=${p}\n`);
      notify(changed);
      return;
    }
    const n = Number(p);
    if (!(n >= 1 && n <= 100)) { reply(res, '', 403); return; }
    integrate();
    state.presets.set(n, Object.fromEntries(Object.entries(POS).map(([a, k]) => [a, Number(values.get(k))])));
    const flags = {};
    for (const c of ['ptz', 'focus', 'exp', 'wb', 'is', 'cp']) flags[c] = q.get(c) ?? q.get('all') ?? 'ignored';
    values.set(`p.${n}.content`, 'enabled');
    const body = [`p:=${n}`];
    for (const [c, f] of Object.entries(flags)) {
      if (f === 'ignored') continue;
      values.set(`p.${n}.content.${c}`, f);
      body.push(`p.${n}.content.${c}:=${f}`);
    }
    if (q.get('name')) { values.set(`p.${n}.name.utf8`, q.get('name')); body.push(`p.${n}.name.utf8:=${q.get('name')}`); }
    reply(res, `${body.join('\n')}\n`);
    notify([`p.${n}.content`]);
  }

  function addon(req, res, url, cmd) {
    if (!state.addon) { res.writeHead(404, { Server: 'vb' }); res.end('Not Found'); return; }
    state.log.push({ cmd: `addon/${cmd}`, params: [...url.searchParams.entries()], at: Date.now() });
    if (cmd === 'get_config.cgi') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.addon));
      return;
    }
    if (cmd === 'track_info.cgi') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ camera_ptz_info: `${values.get('c.1.pan')}:${values.get('c.1.tilt')}:${values.get('c.1.zoom')}` }));
      return;
    }
    if (cmd === 'update_config.cgi') {
      for (const [k, v] of url.searchParams) if (k in state.addon) state.addon[k] = v;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }
    res.writeHead(404); res.end();
  }

  const server = createServer((req, res) => {
    state.requests += 1;
    if (state.silent) return;          // a pulled cable: the request just hangs
    if (!authorised(req)) { challenge(res); return; }
    const url = new URL(req.url, 'http://camera');
    const path = url.pathname;
    if (path.startsWith(ADDON)) { addon(req, res, url, path.slice(ADDON.length)); return; }
    if (!path.toLowerCase().startsWith(XC)) { res.writeHead(404, { Server: 'vb' }); res.end('Not Found'); return; }
    const cmd = path.slice(XC.length).toLowerCase();
    // In standby only open/close/session/info/standby are accepted (XC5 p.103).
    if (values.get('f.standby') === 'standby' && !['info.cgi', 'standby.cgi', 'open.cgi', 'close.cgi', 'session.cgi'].includes(cmd)) {
      reply(res, '', 509);
      return;
    }
    switch (cmd) {
      case 'info.cgi': info(req, res, url); return;
      case 'control.cgi': control(req, res, url); return;
      case 'preset/set': presetSet(req, res, url); return;
      case 'standby.cgi': {
        const c = url.searchParams.get('cmd');
        state.log.push({ cmd: 'standby', params: [['cmd', c]], at: Date.now() });
        if (c !== 'standby' && c !== 'idle') { reply(res, '', 403); return; }
        values.set('f.standby', c);
        reply(res, 'OK.');
        notify(['f.standby']);
        return;
      }
      case 'image.cgi': {
        const v = url.searchParams.get('v') ?? '';
        state.log.push({ cmd: 'image', params: [...url.searchParams.entries()], at: Date.now() });
        if (v && !v.startsWith('jpg')) { reply(res, '', 403); return; }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Livescope-Status': '0', 'Livescope-Frame-Number': '1', Server: 'vb', 'Content-Length': JPEG.length });
        res.end(JPEG);
        return;
      }
      case 'maintain': {
        state.log.push({ cmd: 'maintain', params: [...url.searchParams.entries()], at: Date.now() });
        reply(res, 'OK.');
        return;
      }
      default:
        reply(res, '', 401);     // Unknown Operator (XC5 p.9)
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));

  return {
    port: server.address().port,
    state,
    /** A change made by another client: applied and pushed to open streams. */
    set(key, value) { values.set(key, String(value)); notify([key]); },
    setSilent(on) { state.silent = !!on; },
    close() {
      clearInterval(simTimer);
      for (const c of state.streams) {
        clearTimeout(c.idle);
        try { c.res.end('--boundary--\r\n'); } catch { /* gone */ }
      }
      state.streams.clear();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
  };
  const fake = await startFakeCanon({
    port: Number(arg('port', 0)),
    host: arg('host', '127.0.0.1'),
    username: arg('user'),
    password: arg('pass'),
    tracking: process.argv.includes('--tracking'),
  });
  console.log(`fake Canon CR-N500 (XC) on 127.0.0.1:${fake.port}`);
  const stop = () => fake.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
