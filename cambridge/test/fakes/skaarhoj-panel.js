// A pretend SKAARHOJ panel in Raw Panel Mode, for tests and rehearsals.
//
// A TCP server speaking the ASCII Raw Panel protocol the way the spec notes
// describe it (scratchpad specs/skaarhoj-rawpanel.md, "notes §n"): answers
// `list`, `PanelTopology?` and `map`, pings at the requested heartbeat and
// drops a client that does not answer within 2 s, answers `ping` with `ack`
// and anything it does not know with `nack`. It records every LED, colour and
// display command it is sent, and a test can make it press buttons, move the
// joystick, turn encoders, go silent or drop the connection.
//
// The topology is invented. The real PTZ Extreme's HWC ids and labels are not
// documented anywhere the notes could reach (notes §7, §10.1); this one has
// the same *kinds* of control the datasheet lists — 36 four-way buttons with
// displays, a joystick with left-right, up-down and rotate axes and a top
// button, an unlabelled zoom rocker, a focus roller, eight encoders with
// 112x32 displays and a large encoder (notes §7, DS p.2) — so the mapping's
// heuristics are tested against something shaped like the real thing.
//
// Standalone:  node test/fakes/skaarhoj-panel.js --port 9923
// Lines typed on stdin are sent to every connected client, e.g.
//   HWC#37=Speed:200    HWC#2=Down    HWC#45=Enc:1

import { createServer } from 'node:net';

/** Builds the invented PTZ-Extreme-shaped topology (notes §4 field names). */
export function defaultTopology({ labels = {} } = {}) {
  const HWc = [];
  // 36 four-way buttons with 64x32 displays, 6 x 6, ids 1-36 (DS p.2: x36).
  for (let i = 0; i < 36; i++) {
    HWc.push({ id: i + 1, x: 100 + (i % 6) * 150, y: 100 + Math.floor(i / 6) * 150, txt: labels[i + 1] ?? '', type: 1 });
  }
  // Joystick: left-right and up-down name each other in UIyang (notes §4).
  HWc.push({ id: 37, x: 2000, y: 500, txt: labels[37] ?? '', type: 2, UIyang: 38 });
  HWc.push({ id: 38, x: 2000, y: 500, txt: labels[38] ?? '', type: 3, UIyang: 37 });
  HWc.push({ id: 39, x: 2000, y: 500, txt: labels[39] ?? '', type: 4 });
  HWc.push({ id: 40, x: 2000, y: 420, txt: labels[40] ?? '', type: 9 });
  // "Large Aluminum Zoom Rocker, no labels" (DS p.2): nothing says zoom.
  HWc.push({ id: 41, x: 2500, y: 500, txt: labels[41] ?? '', type: 5 });
  // Focus roller, drawn as a rectangle.
  HWc.push({ id: 42, x: 1600, y: 500, txt: labels[42] ?? '', type: 6 });
  // Eight encoders with 112x32 displays, and the large encoder.
  for (let i = 0; i < 8; i++) HWc.push({ id: 43 + i, x: 100 + i * 220, y: 1200, txt: labels[43 + i] ?? '', type: 7 });
  HWc.push({ id: 51, x: 2200, y: 1200, txt: labels[51] ?? '', type: 8 });
  return {
    HWc,
    typeIndex: {
      1: { w: 120, h: 120, in: 'b4', out: 'rgb', desc: 'Four-way button w/display', subidx: 0,
        disp: { w: 64, h: 32, subidx: 0 }, sub: [{ _: 'd', _x: -32, _y: -16, _w: 64, _h: 32 }] },
      2: { w: 300, in: 'ih', desc: 'Joystick, Left-Right', subidx: 0 },
      3: { w: 300, in: 'iv', desc: 'Joystick, Up-Down', subidx: 0 },
      4: { w: 300, in: 'ir', desc: 'Joystick, Rotate', subidx: 0 },
      5: { w: 200, h: 600, in: 'iv', desc: 'Rocker', subidx: 0 },
      6: { w: 150, h: 500, in: 'p', desc: 'Roller', subidx: 0 },
      7: { w: 180, in: 'pb', desc: 'Encoder w/display', subidx: 0, disp: { w: 112, h: 32, subidx: -1 } },
      8: { w: 450, in: 'pb', desc: 'Large encoder', subidx: 0 },
      9: { w: 100, in: 'b', out: 'rgb', desc: 'Joystick top button', subidx: 0 },
    },
  };
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="1500"><rect width="3000" height="1500" fill="#222"/></svg>';

/**
 * @param {object} [o]
 * @param {number} [o.port=0]
 * @param {object} [o.topology]
 * @param {string|null} [o.support='ASCII,Binary']  `_support=` value; null leaves the line out
 * @param {boolean} [o.silent=false]  accept connections, never answer (a binary-only panel)
 * @param {string} [o.errorMsg]       refuse every client with ErrorMsg= and a close
 */
export function startFakePanel({ port = 0, host = '127.0.0.1', topology = defaultTopology(), support = 'ASCII,Binary',
  silent = false, errorMsg = null, model = 'SK_FAKEPTZ', serial = 'FAKE0001', log = () => {} } = {}) {
  const sockets = new Set();
  const panel = {
    port: 0,
    topology,
    /** Every line any client sent, in order. */
    received: [],
    /** HWC id -> last `HWC#` value / `HWCc#` value / `HWCt#` string (notes §6). */
    leds: new Map(),
    colours: new Map(),
    texts: new Map(),
    clears: 0,
    acks: 0,
    /** native id -> external id to report in `map=`; absent means the same id. */
    mapped: new Map(),
    connections: 0,
    frozen: false,
    get clients() { return sockets.size; },

    /** Sends a line to every client, as if the panel had produced it. */
    send(line) { for (const s of sockets) if (!s.destroyed) s.write(`${line}\n`); },
    // notes §3.1 event forms.
    press(id, edge = 0) { this.send(`HWC#${id}${edge ? `.${edge}` : ''}=Down`); },
    release(id, edge = 0) { this.send(`HWC#${id}${edge ? `.${edge}` : ''}=Up`); },
    speed(id, v) { this.send(`HWC#${id}=Speed:${Array.isArray(v) ? v.join(',') : v}`); },
    abs(id, v) { this.send(`HWC#${id}=Abs:${v}`); },
    enc(id, n) { this.send(`HWC#${id}=Enc:${n}`); },
    /** The TCP connection goes away, as when a cable is pulled or the panel reboots. */
    dropAll() { for (const s of sockets) s.destroy(); sockets.clear(); },
    /** Hung: keeps the socket open but sends and answers nothing. */
    freeze(on = true) { this.frozen = on; },
    close() {
      this.dropAll();
      return new Promise((r) => server.close(() => r()));
    },
  };

  const server = createServer((sock) => {
    sockets.add(sock);
    panel.connections += 1;
    sock.setEncoding('utf8');
    let buf = '';
    let pinger = null;
    let awaiting = null;
    const out = (line) => { if (!panel.frozen && !sock.destroyed) sock.write(`${line}\n`); };
    const done = () => { clearInterval(pinger); clearTimeout(awaiting); sockets.delete(sock); };
    sock.on('close', done);
    sock.on('error', done);

    if (errorMsg) {
      // notes §2: refusal is ErrorMsg= in ASCII, then a close (RWPv2 p.35).
      sock.write(`ErrorMsg=${errorMsg}\n`);
      sock.end();
      return;
    }

    sock.on('data', (chunk) => {
      if (silent || panel.frozen) return;
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line) continue;
        panel.received.push(line);
        log(`<- ${line}`);
        // notes §2: answering a ping with any command within 2 s keeps the client.
        clearTimeout(awaiting);
        awaiting = null;
        handle(line);
      }
    });

    function handle(line) {
      if (line === 'list') {
        // notes §3.2: one key=value line per field, lib emission order.
        out(`_model=${model}`);
        out(`_serial=${serial}`);
        out('_version=v0.0.0-fake');
        out('_name=Fake PTZ panel');
        out('_platform=simulator');
        out('_panelType=Emulation');
        if (support !== null) out(`_support=${support}`);
        return;
      }
      if (line === 'PanelTopology?') {
        // notes §3.2/§4: SVG line first, then the JSON line.
        out(`_panelTopology_svgbase=${SVG}`);
        out(`_panelTopology_HWC=${JSON.stringify(panel.topology)}`);
        return;
      }
      if (line === 'map') {
        // notes §3.1: `map=<native>:<external>`, 0 = absent. Identity unless a test says otherwise.
        for (const hw of panel.topology.HWc) out(`map=${hw.id}:${panel.mapped.get(hw.id) ?? hw.id}`);
        return;
      }
      if (line === 'ping') { out('ack'); return; }   // notes §2 (RWPv2 p.11)
      if (line === 'ack') { panel.acks += 1; return; }
      if (line === 'nack') return;
      let m = /^HeartBeatTimer=(\d+)$/.exec(line);
      if (m) {
        // notes §2: confirm with _heartBeatTimer, then ping every <ms>; a
        // client that does not answer within 2 s is dropped (RWPv2 p.13, 34).
        const ms = Math.max(201, Number(m[1]));
        out(`_heartBeatTimer=${ms}`);
        clearInterval(pinger);
        pinger = setInterval(() => {
          if (panel.frozen) return;
          out('ping');
          if (!awaiting) awaiting = setTimeout(() => { if (!panel.frozen) sock.destroy(); }, 2000);
        }, ms);
        return;
      }
      if (line === 'Clear') { panel.clears += 1; panel.leds.clear(); panel.colours.clear(); panel.texts.clear(); return; }
      if ((m = /^HWC#(\d+)=(\d+)$/.exec(line))) { panel.leds.set(Number(m[1]), Number(m[2])); return; }
      if ((m = /^HWCc#(\d+)=(\d+)$/.exec(line))) { panel.colours.set(Number(m[1]), Number(m[2])); return; }
      if ((m = /^HWCt#(\d+)=(.*)$/.exec(line))) { panel.texts.set(Number(m[1]), m[2]); return; }
      out('nack');   // notes §3: unknown command -> nack (RWPv2 p.14)
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      panel.port = server.address().port;
      resolve(panel);
    });
  });
}

// Run directly: a panel to point CamBridge at without hardware.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const at = process.argv.indexOf('--port');
  const port = at > -1 ? Number(process.argv[at + 1]) : 9923;
  const panel = await startFakePanel({ port, host: '0.0.0.0', log: (l) => process.stdout.write(`${l}\n`) });
  process.stdout.write(`fake SKAARHOJ panel on port ${panel.port}; type lines (e.g. HWC#37=Speed:200) to send them\n`);
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    pending += d;
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line) panel.send(line);
    }
  });
}
