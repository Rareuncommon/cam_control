// A protocol fake of a Panasonic AW-UE160: the HTTP CGI command protocol and
// the TCP update notification, as the spec notes describe them.
//
// What it speaks (notes §2-§8):
//   GET /cgi-bin/aw_ptz?cmd=%23…&res=1 and /cgi-bin/aw_cam?cmd=…&res=1, with
//   the camera's reply strings and its ER1/ER2/ER3 errors (eR… for ptz);
//   /live/camdata.html; /cgi-bin/event?connect=start|stop&my_port=P&uid=0 and a
//   TCP connection back to P per change, framed as IF p.10 describes;
//   /cgi-bin/camera?resolution=… (a JPEG); /cgi-bin/getinfo; a few get_/set_
//   web CGIs. Standby (#O0) answers ER2 to everything but the power, model
//   and version queries.
//
// Settings are held generically: the reply prefix of a query (OSL:2B:, d6)
// keys the stored data, a set command finds its key by the same prefix. They
// are seeded from the driver's table, which is the one place the fake leans on
// driver data — it decides only which settings exist and their starting
// values. Ranges are checked (ER3) from the table's codec.
//
// Auth: when a username is given every path wants HTTP Basic (the notes do
// not say which scheme the camera uses; CamBridge's transport answers either).
//
//   node test/fakes/panasonic-aw.js --port 8080 [--user u --pass p] [--standby]

import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { TABLE } from '../../src/ptz/tables/panasonic-aw-ue160.js';

const pad = (n, w, base = 16) => Math.round(n).toString(base).toUpperCase().padStart(w, '0');

/** A frame as IF p.10 lays it out: 22 reserved, Size (BE here), 4 reserved, info, 24 reserved. */
export function frameNotification(text) {
  const info = Buffer.from(`\r\n${text}\r\n`, 'latin1');
  const head = Buffer.alloc(28);
  head.writeUInt16BE(info.length + 8, 22);
  return Buffer.concat([head, info, Buffer.alloc(24)]);
}

function seed(state) {
  for (const e of TABLE) {
    const w = e.wire;
    if (w.via || !w.r || !w.codec || w.path === 'cgi') continue;
    const c = w.codec;
    let data;
    switch (c.k) {
      case 'bool': data = c.f; break;
      case 'enum': data = e.options.find((o) => !o.readOnly)?.value ?? e.options[0].value; break;
      case 'map': data = Object.keys(c.r)[0]; break;
      case 'lin': {
        const v = Math.min(Math.max(0, e.range.min), e.range.max);
        data = pad((v - c.b) / c.a, c.w, c.base) + (c.suffix ?? '');
        break;
      }
      case 'band': data = '999'; break;
      case 'ascii': data = '0'.repeat(c.chars * 2); break;
      case 'bits': data = '0'.repeat(c.w); break;
      default: data = '0';
    }
    state.settings.set(w.r, data);
    state.meta.set(w.r, e);
  }
  // A few realistic starting values.
  state.settings.set('OSJ:5C:', Buffer.from('AW-UE160').toString('hex').toUpperCase().padEnd(40, '0'));
  state.settings.set('OSL:2B:', '0');          // WHITE BALANCE MODE AWB A
  state.settings.set('OSL:2A:', '0');          // ATW off
  state.settings.set('OAF:', '1');             // focus auto
  state.settings.set('ORS:', '1');             // auto iris on
  state.settings.set('OSL:25:', '08');         // gain 0 dB
  state.settings.set('OSE:77:', '0');          // 59.94 Hz
  state.settings.set('tAE', '1');              // tally enabled
}

export async function startFakePanasonic({
  port = 0, username, password, model = 'AW-UE160', tracking = true, camdata = true,
  camdataExclude = ['OSL:C5:', 'OSL:C6:', 'OSJ:3D:'],
} = {}) {
  const state = {
    model,
    firmware: 'V02.01',
    power: '1',
    pan: 0x8000, tilt: 0x8000, zoom: 0x555, focus: 0x800, iris: 0x800,
    speed: { pan: 50, tilt: 50, zoom: 50, focus: 50 },
    at: Date.now(),
    presets: new Map(),
    lastPreset: 0,
    settings: new Map(),
    meta: new Map(),
    web: { cam_title: 'AW-UE160', rtsp_port: '554', domain: '0', mode: '0', ip4_addr: '127.0.0.1' },
    receivers: new Map(),       // "addr:port" -> { host, port }
    log: [],                    // every command, decoded: ['ptz', '#PTS9950']
    requests: [],               // { url, connection }
    silent: false,
    pushes: [],
  };
  seed(state);
  if (!tracking) { state.settings.delete('OSL:B6:'); state.settings.delete('OSL:BB:'); }
  else { state.settings.set('OSL:B6:', '1'); state.settings.set('OSL:BB:', '1'); }

  function integrate() {
    const now = Date.now();
    const dt = (now - state.at) / 1000;
    state.at = now;
    const lim = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    state.pan = lim(state.pan + (state.speed.pan - 50) * 300 * dt, 0x2D09, 0xD2F5);
    state.tilt = lim(state.tilt - (state.speed.tilt - 50) * 300 * dt, 0x1C71, 0x8E38);
    state.zoom = lim(state.zoom + (state.speed.zoom - 50) * 40 * dt, 0x555, 0xFFF);
    state.focus = lim(state.focus + (state.speed.focus - 50) * 40 * dt, 0x555, 0xFFF);
  }

  /** Tell every registered receiver; one TCP connection per notification. */
  function notify(text) {
    state.pushes.push(text);
    for (const r of state.receivers.values()) {
      const s = net.connect(r.port, r.host, () => { s.end(frameNotification(text)); });
      s.on('error', () => {});
      s.setTimeout(2000, () => s.destroy());
    }
  }

  function inRange(key, data) {
    const e = state.meta.get(key);
    const c = e?.wire.codec;
    if (!c) return true;
    if (c.k === 'lin' && e.range) {
      const f = c.field !== undefined ? data.split(':')[c.field] : data;
      if (!/^[0-9A-Fa-f]+$/.test(f)) return false;
      const v = c.a * parseInt(f, c.base) + c.b;
      return v >= e.range.min - 1e-9 && v <= e.range.max + 1e-9;
    }
    if (c.k === 'enum') return e.options.some((o) => parseInt(o.value, c.base) === parseInt(data, c.base));
    if (c.k === 'bool') return data === c.f || data === c.t;
    return true;
  }

  const err = (path, n, name) => (path === 'ptz' ? `eR${n}:${name}` : `ER${n}:${name}`);

  // --- aw_cam -------------------------------------------------------------------
  function cam(cmd) {
    const name = cmd.split(':')[0];
    if (cmd === 'QID') return `OID:${state.model}`;
    if (cmd === 'QSV') return `OSV:${state.firmware}`;
    if (cmd === 'QSL:99') return `OSL:99:${state.firmware}-000-00.00`;
    if (state.power !== '1') return err('cam', 2, name);
    // Commands whose set and reply differ from the O…/Q… pattern (IF p.35-36, p.49-50, p.87).
    const alias = { DCB: 'OBR:', TLR: 'OLR:', TLG: 'OLG:', TLY: 'OLY:', DUS: 'OUS:' };
    let m = /^(DCB|TLR|TLG|TLY|DUS):([01])$/.exec(cmd);
    if (m) {
      state.settings.set(alias[m[1]], m[2]);
      notify(`${m[1] === 'DCB' || m[1] === 'DUS' ? alias[m[1]] : `${m[1]}:`}${m[2]}`);
      return cmd;
    }
    m = /^OAW:(\d)$/.exec(cmd);
    if (m) {
      const reply = { 0: '0', 1: '2', 2: '3', 3: '1', 4: '4', 5: '5', 9: '9' }[m[1]];
      if (reply === undefined) return err('cam', 3, 'OAW');
      state.settings.set('OAW:', reply);
      notify(`OAW:${reply}`);
      return cmd;
    }
    m = /^XSF:(\d)$/.exec(cmd);
    if (m) {
      state.settings.set('OSF:', String((Number(m[1]) + 9) % 10));
      return cmd;
    }
    if (cmd === 'QSF') return `OSF:${state.settings.get('OSF:') ?? '8'}`;
    if (cmd === 'OWS' || cmd === 'OAS') {
      if (state.settings.get('d6') === '1' && cmd === 'OWS') return err('cam', 2, cmd);   // not at NIGHT (IF p.23)
      setTimeout(() => notify(cmd), 30);                                                  // completion push (IF p.17)
      return cmd;
    }
    if (cmd.startsWith('Q')) {
      const key = `O${cmd.slice(1)}:`;
      if (state.settings.has(key)) return `${key}${state.settings.get(key)}`;
      return err('cam', 1, name);
    }
    // A set: the longest stored key the command starts with.
    let key = null;
    for (const k of state.settings.keys()) {
      if (/^[A-Z]/.test(k) && cmd.startsWith(k) && (!key || k.length > key.length)) key = k;
    }
    // Write-only commands (actions): acknowledge with an echo.
    if (!key) {
      if (/^(OSE:69|OSJ:0[4578]|OSI:1[EF]|OSJ:4[89]|OSL:3[01]|OSL:9[023]|OSJ:3[6-9AB]|OSJ:28|OSL:E[79]|D(PG|IT|UP|DW)|C(UP|DW|RT|LT)|OSJ:3[EF])(:|$)/.test(cmd)) return cmd;
      return err('cam', 1, name);
    }
    const data = cmd.slice(key.length);
    if (!inRange(key, data)) return err('cam', 3, name);
    // One mode rule from IF section 8, so the camera's own refusal can be seen:
    // W.BAL VAR only while WHITE BALANCE MODE is VAR (IF p.23).
    if (key === 'OSI:20:' && state.settings.get('OSL:2B:') !== '4') return err('cam', 2, name);
    state.settings.set(key, data);
    notify(`${key}${data}`);
    return cmd;
  }

  // --- aw_ptz -------------------------------------------------------------------
  function ptz(cmd) {
    const body = cmd.slice(1);
    if (body === 'O') return `p${state.power}`;
    let m = /^O([01])$/.exec(body);
    if (m) { state.power = m[1]; notify(`p${m[1]}`); return `p${m[1]}`; }
    if (state.power !== '1') return err('ptz', 2, body.replace(/\d+$/, ''));
    integrate();
    m = /^PTS(\d\d)(\d\d)$/.exec(body);
    if (m) { state.speed.pan = Number(m[1]); state.speed.tilt = Number(m[2]); return `pTS${m[1]}${m[2]}`; }
    m = /^Z(\d\d)$/.exec(body);
    if (m) { state.speed.zoom = Number(m[1]); return `zS${m[1]}`; }
    m = /^F(\d\d)$/.exec(body);
    if (m) { state.speed.focus = Number(m[1]); return `fS${m[1]}`; }
    m = /^HV1(\d\d)(\d\d)(\d\d)(\d\d)$/.exec(body);
    if (m) {
      const axes = ['pan', 'tilt', 'zoom', 'focus'];
      m.slice(1).forEach((d, i) => { if (d !== '00') state.speed[axes[i]] = Number(d); });
      return `hV1${m.slice(1).join('')}`;
    }
    if (body === 'PTV') {
      return `pTV${pad(state.pan, 4)}${pad(state.tilt, 4)}${pad(state.zoom, 3)}${pad(state.focus, 3)}${pad(state.iris, 3)}`;
    }
    if (body === 'APC') return `aPC${pad(state.pan, 4)}${pad(state.tilt, 4)}`;
    m = /^APC([0-9A-F]{4})([0-9A-F]{4})$/.exec(body);
    if (m) {
      state.pan = parseInt(m[1], 16); state.tilt = parseInt(m[2], 16);
      notify(`aPC${m[1]}${m[2]}`);
      return `aPC${m[1]}${m[2]}`;
    }
    m = /^I(\d\d)?$/.exec(body);                       // iris 01–99, reply iC (IF p.67)
    if (m) {
      if (m[1]) {
        if (m[1] === '00') return err('ptz', 3, 'I');
        state.iris = 0x555 + Math.round(((Number(m[1]) - 1) / 98) * (0xFFF - 0x555));
        state.settings.set('iC', m[1]);
        notify(`iC${m[1]}`);
      }
      return `iC${state.settings.get('iC') ?? '50'}`;
    }
    m = /^UPVS(\d{3})?$/.exec(body);                   // 000–999 (IF p.83)
    if (m) {
      if (m[1]) { state.settings.set('uPVS', m[1]); notify(`uPVS${m[1]}`); }
      return `uPVS${state.settings.get('uPVS')}`;
    }
    m = /^AX([ZFI])([0-9A-F]{3})?$/.exec(body);
    if (m) {
      const axis = { Z: 'zoom', F: 'focus', I: 'iris' }[m[1]];
      if (m[2]) {
        const v = parseInt(m[2], 16);
        if (v < 0x555) return err('ptz', 3, `AX${m[1]}`);     // the spec's own ER3 example is #AXZ000 (IF p.20)
        state[axis] = v;
      }
      return `ax${m[1].toLowerCase()}${pad(state[axis], 3)}`;
    }
    if (body === 'GZ') return `gz${pad(state.zoom, 3)}`;
    if (body === 'GF') return `gf${pad(state.focus, 3)}`;
    m = /^R(\d\d)$/.exec(body);
    if (m) {
      const n = Number(m[1]);
      const p = state.presets.get(n);
      state.lastPreset = n;
      if (p) Object.assign(state, p);
      setTimeout(() => notify(`q${m[1]}`), 40);      // arrival (IF p.16)
      return `s${m[1]}`;
    }
    m = /^M(\d\d)$/.exec(body);
    if (m) {
      const { pan, tilt, zoom, focus } = state;
      state.presets.set(Number(m[1]), { pan, tilt, zoom, focus });
      return `s${m[1]}`;
    }
    m = /^C(\d\d)$/.exec(body);
    if (m) { state.presets.delete(Number(m[1])); return `s${m[1]}`; }
    if (body === 'S') return `s${pad(state.lastPreset, 2, 10)}`;
    m = /^PE(0[0-2])$/.exec(body);
    if (m) {
      let bits = 0n;
      for (const n of state.presets.keys()) {
        const i = n - Number(m[1]) * 40;
        if (i >= 0 && i < 40) bits |= 1n << BigInt(i);
      }
      return `pE${m[1]}${bits.toString(16).toUpperCase().padStart(10, '0')}`;
    }
    // Generic: reply prefix = the command name with its first letter in lower case.
    let key = null;
    for (const k of state.settings.keys()) {
      if (!/^[a-z]/.test(k)) continue;
      const name = k[0].toUpperCase() + k.slice(1);
      if (body.startsWith(name) && (!key || k.length > key.length)) key = k;
    }
    if (!key) return err('ptz', 1, body.replace(/[0-9A-F]+$/, '') || body);
    const data = body.slice(key.length);
    if (data === '') return `${key}${state.settings.get(key)}`;
    if (!inRange(key, data)) return err('ptz', 3, key[0].toUpperCase() + key.slice(1));
    state.settings.set(key, data);
    notify(`${key}${data}`);
    return `${key}${data}`;
  }

  function camdataPage() {
    const lines = [`p${state.power}`, `OID:${state.model}`];
    for (const [k, v] of state.settings) {
      if (camdataExclude.includes(k)) continue;
      const c = state.meta.get(k)?.wire.codec;
      // Numeric values carry 0x in camdata.html (IF ch. 9; the UE150 dump agrees).
      const hex = k.includes(':') && c && (c.base === 16) && ['lin', 'enum'].includes(c.k);
      lines.push(`${k}${hex ? '0x' : ''}${v}`);
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  function authorised(req) {
    if (!username) return true;
    const h = String(req.headers.authorization ?? '');
    if (!h.startsWith('Basic ')) return false;
    return Buffer.from(h.slice(6), 'base64').toString() === `${username}:${password ?? ''}`;
  }

  const sockets = new Set();
  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url, connection: req.headers.connection });
    if (state.silent) return;   // hold the request open, never answer
    if (!authorised(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fake-aw"' });
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://camera');
    const send = (status, text, type = 'text/plain') => {
      // The camera closes after every exchange (IF p.8).
      res.writeHead(status, { 'Content-Type': type, Connection: 'close' });
      res.end(text);
    };
    switch (url.pathname) {
      case '/cgi-bin/aw_cam': {
        const cmd = url.searchParams.get('cmd') ?? '';
        state.log.push(['cam', cmd]);
        send(200, cam(cmd));
        return;
      }
      case '/cgi-bin/aw_ptz': {
        const cmd = url.searchParams.get('cmd') ?? '';
        state.log.push(['ptz', cmd]);
        if (!cmd.startsWith('#')) { send(200, 'eR1:'); return; }
        send(200, ptz(cmd));
        return;
      }
      case '/live/camdata.html':
        if (!camdata) { send(404, ''); return; }
        send(200, camdataPage(), 'text/html');
        return;
      case '/cgi-bin/event': {
        const p = Number(url.searchParams.get('my_port'));
        const host = String(req.socket.remoteAddress).replace(/^::ffff:/, '');
        const key = `${host}:${p}`;
        if (url.searchParams.get('connect') === 'start') {
          // At most five receivers (IF p.12). What a sixth gets is not stated; 503 here.
          if (!state.receivers.has(key) && state.receivers.size >= 5) { send(503, ''); return; }
          state.receivers.set(key, { host, port: p });
        } else {
          state.receivers.delete(key);
        }
        res.writeHead(204, { Connection: 'close' });
        res.end();
        return;
      }
      case '/cgi-bin/man_session':
        send(200, `Event session:${state.receivers.size}`);
        return;
      case '/cgi-bin/camera': {
        // A tiny JPEG-shaped body: SOI … EOI. Enough for "is it a picture".
        const res2 = url.searchParams.get('resolution');
        state.lastSnapshot = res2;
        res.writeHead(200, { 'Content-Type': 'image/jpeg', Connection: 'close' });
        res.end(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0xFF, 0xD9]));
        return;
      }
      case '/cgi-bin/getinfo':
        send(200, ['MAC=02-00-00-00-00-01', 'SERIAL=FAKE00001', `VERSION=${state.firmware}`, `NAME=${state.model}`, 'ePort=31004'].join('\r\n'));
        return;
      case '/cgi-bin/get_basic':
        send(200, `cam_title=${state.web.cam_title}\r\nplugin_download=enable\r\nplugin_disp=0`);
        return;
      case '/cgi-bin/set_basic':
        state.web.cam_title = url.searchParams.get('cam_title') ?? state.web.cam_title;
        send(200, '');
        return;
      case '/cgi-bin/get_network':
        send(200, `ip4_dhcp=0\r\nip4_addr=${state.web.ip4_addr}\r\nip4_netmask=255.255.255.0\r\nport=80`);
        return;
      case '/cgi-bin/get_rtsp':
        send(200, `rtsp_port=${state.web.rtsp_port}`);
        return;
      case '/cgi-bin/set_rtsp':
        state.web.rtsp_port = url.searchParams.get('rtsp_port') ?? state.web.rtsp_port;
        send(200, '');
        return;
      case '/cgi-bin/get_timecode_overlay':
        send(200, `mode=${state.web.mode}`);
        return;
      case '/cgi-bin/set_timecode_overlay':
        state.web.mode = url.searchParams.get('mode') ?? state.web.mode;
        send(200, '');
        return;
      default:
        send(404, '');
    }
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    state,
    /** Silent: requests are accepted and never answered (the client's timeout ends them). */
    setSilent(on) { state.silent = !!on; },
    /** A change made at the camera itself (its menu, an RP panel): stored and pushed. */
    changeLocally(key, data) {
      state.settings.set(key, data);
      notify(`${key}${data}`);
    },
    notify,
    close() {
      return new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      });
    },
  };
}

// Standalone: node test/fakes/panasonic-aw.js --port N [--user u --pass p] [--standby]
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : dflt;
  };
  const fake = await startFakePanasonic({
    port: Number(arg('port', 0)), username: arg('user'), password: arg('pass'),
  });
  if (process.argv.includes('--standby')) fake.state.power = '0';
  console.log(`fake Panasonic AW-UE160 on 127.0.0.1:${fake.port}`);
}
