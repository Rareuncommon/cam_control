// cambridge — application server and web UI host.
//
// Node's built-in http plus Server-Sent Events for push. No npm dependencies:
// nothing to install before a shoot, nothing to break on a Node upgrade. SSE
// rather than a WebSocket server because the browser channel is one-way — the UI
// posts actions over ordinary fetch — and EventSource reconnects on its own.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CamdClient } from './camd-client.js';
import { StateModel } from './state.js';
import { Logger } from './log.js';
import { JsonStore } from './store.js';
import { Presets, Gangs, matchFrom, PRESET_PROPS, PROP_GROUPS, FOCUS_EXCLUDED_REASON } from './control.js';
import { Adoption, normaliseMac, suggestId } from './adopt.js';
import { AtemTally, tallyForCameras } from './atem.js';
import { ViscaServer } from './visca.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

// --- config -----------------------------------------------------------------

function loadConfig(path) {
  const defaults = {
    cambridge: { bind: '0.0.0.0', port: 8088, camdUrl: 'ws://127.0.0.1:8787/ws' },
    camd: { bind: '127.0.0.1', restPort: 8787, wsPath: '/ws' },
    logging: { dir: './logs', level: 'info' },
    cameras: [],
    // Both off unless the config asks for them: a studio without a switcher or a
    // joystick should not have sockets it never uses listening on the network.
    atem: { enabled: false, host: '', port: 9910, mapping: {} },
    visca: { enabled: false, bind: '0.0.0.0', port: 52381, tcp: true, mapping: {} },
  };
  if (!existsSync(path)) {
    process.stderr.write(`cambridge: no config at ${path}, using defaults\n`);
    return defaults;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      cambridge: { ...defaults.cambridge, ...(parsed.cambridge ?? {}) },
      camd: { ...defaults.camd, ...(parsed.camd ?? {}) },
      logging: { ...defaults.logging, ...(parsed.logging ?? {}) },
      cameras: parsed.cameras ?? [],
      atem: { ...defaults.atem, ...(parsed.atem ?? {}) },
      visca: { ...defaults.visca, ...(parsed.visca ?? {}) },
    };
  } catch (err) {
    process.stderr.write(`cambridge: config ${path} is not valid JSON: ${err.message}\n`);
    process.exit(1);
  }
}

// --- helpers ----------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/**
 * Turns a bind address into URLs a human can actually open.
 *
 * Printing the bind address is useless when it is 0.0.0.0 — that is a listening
 * wildcard, not a destination, and browsers on macOS will not load it. What the
 * operator needs is localhost for this machine and the LAN address for the booth
 * iPad, so print both.
 */
function browsableUrls(bindAddr, port) {
  if (bindAddr && bindAddr !== '0.0.0.0' && bindAddr !== '::') {
    return [`http://${bindAddr}:${port}`];
  }
  const urls = [`http://localhost:${port}`];
  for (const [, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${port}`);
    }
  }
  return urls;
}

async function readBody(req, limitBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return null;
  return JSON.parse(text);
}

// --- application ------------------------------------------------------------

export function createApp({ configPath = './config/cambridge.json' } = {}) {
  const cfg = loadConfig(configPath);
  const log = new Logger({
    dir: cfg.logging.dir,
    level: cfg.logging.level,
    maxSizeBytes: (cfg.logging.rotate?.maxSizeMb ?? 20) * 1024 * 1024,
    maxFiles: cfg.logging.rotate?.maxFiles ?? 30,
  });

  const camdBase = `http://${cfg.camd.bind === '0.0.0.0' ? '127.0.0.1' : cfg.camd.bind}:${cfg.camd.restPort}`;
  const camdWs = cfg.cambridge.camdUrl
    ?? `ws://127.0.0.1:${cfg.camd.restPort}${cfg.camd.wsPath}`;

  const camd = new CamdClient({
    baseUrl: camdBase,
    wsUrl: camdWs,
    log: (level, msg) => log.write(level, 'camd', msg),
  });

  const state = new StateModel();
  const store = new JsonStore(
    join(cfg.logging.dir, '..', 'config', 'cambridge-presets.json'),
    { presets: {}, scenes: {}, gangs: {} },
    (level, msg) => log.write(level, 'store', msg),
  );
  const presets = new Presets(store, state, log);
  const gangs = new Gangs(store, state, log);
  const adoption = new Adoption(configPath, camd, log);

  /** Injected setter used by presets, gang and match, so all writes are logged. */
  const applyFn = async (cameraId, prop, raw) => {
    const res = await camd.setProperty(cameraId, prop, raw);
    log.debug('set', `${cameraId} ${prop}=${raw} -> ${res.ok ? 'ok' : res.body?.error}`);
    return res;
  };

  // --- switcher tally -------------------------------------------------------
  // Read-only, and entirely optional. With no ATEM configured this stays null
  // and every tally indicator simply never lights.
  let atem = null;
  if (cfg.atem.enabled && cfg.atem.host) {
    atem = new AtemTally({
      host: cfg.atem.host,
      port: cfg.atem.port,
      log: (level, msg) => log.write(level, 'atem', msg),
    });
    atem.on('tally', (snapshot) => {
      const byCamera = tallyForCameras(cfg.atem.mapping, snapshot);
      if (state.applyTally(byCamera)) {
        const live = Object.entries(byCamera).filter(([, t]) => t.program).map(([id]) => id);
        log.info('tally', live.length ? `program: ${live.join(', ')}` : 'program: none');
      }
    });
    // Losing the switcher must clear tally rather than freeze it. A red light on
    // a camera that is no longer live is worse than no light at all.
    atem.on('disconnected', () => {
      log.warn('atem', 'switcher connection lost, clearing tally');
      state.applyTally({});
    });
  }

  // --- VISCA -----------------------------------------------------------------
  // Lets a hardware joystick or a VISCA controller drive the same cameras. Every
  // command lands on applyFn, so a move made from a joystick is logged and
  // gang-aware exactly like one made from the browser.
  let visca = null;
  if (cfg.visca.enabled) {
    visca = new ViscaServer({
      state,
      applyFn,
      actionFn: (cameraId, action, actionBody) => camd.action(cameraId, action, actionBody),
      recallPreset: (name, cameraId) => presets.recallPreset(cameraId, name, applyFn),
      savePreset: (name, cameraId) => presets.savePreset(cameraId, name),
      mapping: cfg.visca.mapping,
      bind: cfg.visca.bind,
      port: cfg.visca.port,
      tcp: cfg.visca.tcp !== false,
      log: (level, msg) => log.write(level, 'visca', msg),
    });
  }

  // --- SSE fanout -----------------------------------------------------------
  const sseClients = new Set();

  function pushToClients(payload) {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
      // A slow or dead browser tab must not block the others or throw.
      try { res.write(frame); } catch { sseClients.delete(res); }
    }
  }

  // Coalesce bursts: turning an iris wheel produces a stream of property events,
  // and repainting per event would swamp an iPad over Wi-Fi.
  let pushTimer = null;
  state.on('change', (change) => {
    if (change.type === 'connectionState' || change.type === 'camdConnection'
        || change.type === 'tally') {
      // Connection transitions are the one thing that must never be delayed —
      // "camera offline" is the message the operator needs instantly. Tally is
      // the same: it has to track the cut, not trail it by a coalescing window.
      pushToClients({ type: 'state', view: state.view() });
      return;
    }
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      pushToClients({ type: 'state', view: state.view() });
    }, 60);
  });

  // --- camd event wiring ----------------------------------------------------
  camd.on('camdConnected', async () => {
    state.setCamdConnected(true);
    await refreshEverything();
  });

  camd.on('camdDisconnected', () => {
    state.setCamdConnected(false);
  });

  camd.on('event', async (ev) => {
    switch (ev.event) {
      case 'hello':
        state.replaceAll(ev.cameras ?? [], ev.backend);
        await refreshAllProperties();
        break;
      case 'connectionState': {
        const before = state.get(ev.cameraId)?.state;
        state.applyConnectionState(ev);
        log.info('camera', `${ev.cameraId} ${before ?? '?'} -> ${ev.state}` +
          (ev.detail ? ` (${ev.detail})` : ''));
        // A camera that just came back needs its full property set refetched;
        // camd republishes changes, but we want the complete picture immediately.
        if (ev.state === 'connected') await refreshProperties(ev.cameraId);
        break;
      }
      case 'statusUpdate': {
        const prev = state.get(ev.cameraId)?.status;
        state.applyStatus(ev);
        if (prev && prev.recording !== ev.recording) {
          log.info('camera', `${ev.cameraId} recording ${ev.recording ? 'STARTED' : 'stopped'}`);
        }
        if (ev.recordingFailed) {
          log.error('camera', `${ev.cameraId} reports Recording_Failed`);
        }
        break;
      }
      case 'propertyChanged':
        state.applyPropertyChange(ev);
        break;
      default:
        log.debug('camd', `unhandled event ${ev.event}`);
    }
  });

  async function refreshProperties(cameraId) {
    const res = await camd.getProperties(cameraId);
    if (res.ok && res.body?.properties) {
      state.replaceProperties(cameraId, res.body.properties);
    }
  }

  async function refreshAllProperties() {
    await Promise.all(state.list()
      .filter((c) => c.state === 'connected')
      .map((c) => refreshProperties(c.id)));
  }

  async function refreshEverything() {
    const res = await camd.listCameras();
    if (res.ok && res.body?.cameras) {
      state.replaceAll(res.body.cameras);
      await refreshAllProperties();
    }
  }

  // --- HTTP -----------------------------------------------------------------

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      // --- events (SSE) ---
      if (path === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ type: 'state', view: state.view() })}\n\n`);
        sseClients.add(res);
        // Comment frames keep proxies and sleeping iPads from dropping the stream.
        const keepAlive = setInterval(() => {
          try { res.write(': keepalive\n\n'); } catch { /* closed */ }
        }, 15_000);
        req.on('close', () => {
          clearInterval(keepAlive);
          sseClients.delete(res);
        });
        return;
      }

      // --- state ---
      if (path === '/api/state' && req.method === 'GET') {
        return sendJson(res, 200, state.view());
      }

      if (path === '/api/health' && req.method === 'GET') {
        const health = await camd.health();
        return sendJson(res, 200, {
          cambridge: 'ok',
          camdReachable: health.ok,
          camd: health.body ?? null,
          sseClients: sseClients.size,
        });
      }

      // --- setup: discovery and adoption ---
      // Everything needed to add a camera from the browser. Discovery is annotated
      // with whether each body is already adopted, and by which entry, so the setup
      // page never offers to adopt a camera twice.
      if (path === '/api/discovered' && req.method === 'GET') {
        const d = await camd.discovered();
        if (!d.ok) return sendJson(res, 502, d.body ?? { error: 'camd unreachable' });
        const adopted = adoption.adopted();
        const byMac = new Map(adopted.map((c) => [normaliseMac(c.mac), c]));
        const takenIds = new Set(adopted.map((c) => c.id));
        const list = (d.body?.discovered ?? []).map((cam) => {
          const mac = normaliseMac(cam.mac);
          const owner = byMac.get(mac);
          return {
            ...cam,
            mac: mac ?? cam.mac,
            adopted: !!owner,
            adoptedAs: owner ? { id: owner.id, label: owner.label } : null,
            suggestedId: owner ? owner.id : suggestId(cam.model, mac, takenIds),
          };
        });
        // The hint tracks what is actually on the network. Telling an operator to
        // go and read credentials off three screens, when none of the cameras
        // wants any, is how a setup page trains people to ignore it.
        const needAuth = list.filter((c) => c.accessAuthRequired && !c.adopted);
        const credentialHint = needAuth.length === 0
          ? (list.length
            ? 'None of these cameras uses a password — give each one a name and add it.'
            : 'No cameras seen yet. Check USB-LAN Connection and Remote Shooting on each body.')
          : `${needAuth.length} of these ${needAuth.length === 1 ? 'needs a password' : 'need passwords'}, ` +
            'shown on the camera at MENU → Network → Network Option → [Access Authen. Info]. ' +
            'Turning [Access Authen. Settings] off on a body removes its password entirely.';

        return sendJson(res, 200, {
          discovered: list,
          adoptedCount: adopted.length,
          credentialHint,
        });
      }

      if (path === '/api/adopt' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body?.mac) return sendJson(res, 400, { error: 'mac is required' });
        const result = await adoption.adopt(body);
        if (result.ok) await refreshEverything();
        return sendJson(res, result.ok ? 201 : 409, result);
      }

      let am = path.match(/^\/api\/cameras\/([^/]+)\/adoption$/);
      if (am) {
        const id = decodeURIComponent(am[1]);
        if (req.method === 'DELETE') {
          const result = await adoption.forget(id);
          if (result.ok) await refreshEverything();
          return sendJson(res, result.ok ? 200 : 404, result);
        }
        if (req.method === 'PATCH' || req.method === 'PUT') {
          const body = await readBody(req);
          const result = await adoption.update(id, body ?? {});
          if (result.ok) await refreshEverything();
          return sendJson(res, result.ok ? 200 : 404, result);
        }
      }

      // --- property set, with gang fanout ---
      let m = path.match(/^\/api\/cameras\/([^/]+)\/properties\/([^/]+)$/);
      if (m && req.method === 'PUT') {
        const [, cameraId, prop] = m.map(decodeURIComponent);
        const body = await readBody(req);
        const raw = Number(body?.value);
        if (!Number.isFinite(raw)) {
          return sendJson(res, 400, { error: 'body must be {"value": <number>}' });
        }
        const primary = await applyFn(cameraId, prop, raw);
        // Gang members follow the value that was actually applied, not the one
        // requested — otherwise linked cameras drift from the source whenever the
        // source snaps to a different step.
        const appliedRaw = primary.body?.applied ?? raw;
        const linked = primary.ok
          ? await gangs.apply(cameraId, prop, appliedRaw, applyFn)
          : [];
        if (primary.ok) await refreshProperties(cameraId);
        for (const l of linked) if (l.ok) await refreshProperties(l.cameraId);
        return sendJson(res, primary.ok ? 200 : (primary.status || 502), {
          ok: primary.ok,
          cameraId,
          prop,
          ...(primary.body ?? {}),
          linked,
        });
      }

      // --- actions ---
      m = path.match(/^\/api\/cameras\/([^/]+)\/actions\/([^/]+)$/);
      if (m && req.method === 'POST') {
        const [, cameraId, action] = m.map(decodeURIComponent);
        const body = await readBody(req);
        log.info('action', `${cameraId} ${action}${body ? ` ${JSON.stringify(body)}` : ''}`);
        const result = await camd.action(cameraId, action, body ?? undefined);
        if (result.ok) await refreshProperties(cameraId);
        return sendJson(res, result.ok ? 200 : (result.status || 502), {
          ok: result.ok, cameraId, action, ...(result.body ?? {}),
        });
      }

      // --- record all (an on-set convenience worth having) ---
      if (path === '/api/record-all' && req.method === 'POST') {
        const body = await readBody(req);
        const want = body?.start !== false;
        const targets = state.list().filter((c) => c.state === 'connected');
        log.info('action', `record ${want ? 'start' : 'stop'} on ${targets.length} camera(s)`);
        const results = await Promise.all(targets.map(async (cam) => {
          const r = await camd.action(cam.id, want ? 'recordStart' : 'recordStop');
          return { cameraId: cam.id, ok: r.ok, ...(r.body ?? {}) };
        }));
        const failed = results.filter((r) => !r.ok);
        if (failed.length) {
          log.error('action',
            `record ${want ? 'start' : 'stop'} failed on: ${failed.map((f) => f.cameraId).join(', ')}`);
        }
        return sendJson(res, 200, { ok: failed.length === 0, results });
      }

      // --- presets ---
      if (path === '/api/presets' && req.method === 'GET') {
        return sendJson(res, 200, {
          presets: store.data.presets,
          scenes: Object.keys(store.data.scenes),
          focusNote: FOCUS_EXCLUDED_REASON,
          capturedProps: PRESET_PROPS,
          groups: PROP_GROUPS,
        });
      }

      m = path.match(/^\/api\/cameras\/([^/]+)\/presets\/([^/]+)$/);
      if (m) {
        const [, cameraId, name] = m.map(decodeURIComponent);
        if (req.method === 'PUT')    return sendJson(res, 200, presets.savePreset(cameraId, name));
        if (req.method === 'DELETE') return sendJson(res, 200, presets.deletePreset(cameraId, name));
        if (req.method === 'POST') {
          const body = await readBody(req);
          const r = await presets.recallPreset(cameraId, name, applyFn, {
            transitionMs: Number(body?.transitionMs) || 0,
            only: Array.isArray(body?.only) && body.only.length ? body.only : null,
          });
          if (r.ok) await refreshProperties(cameraId);
          return sendJson(res, r.ok ? 200 : 409, r);
        }
      }

      // --- scenes ---
      m = path.match(/^\/api\/scenes\/([^/]+)$/);
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (req.method === 'PUT')    return sendJson(res, 200, presets.saveScene(name));
        if (req.method === 'DELETE') return sendJson(res, 200, presets.deleteScene(name));
        if (req.method === 'POST') {
          const body = await readBody(req);
          const r = await presets.recallScene(name, applyFn, {
            transitionMs: Number(body?.transitionMs) || 0,
            only: Array.isArray(body?.only) && body.only.length ? body.only : null,
          });
          await refreshAllProperties();
          return sendJson(res, r.ok ? 200 : 409, r);
        }
      }

      // --- gangs ---
      if (path === '/api/gangs' && req.method === 'GET') {
        return sendJson(res, 200, { gangs: gangs.list() });
      }
      m = path.match(/^\/api\/gangs\/([^/]+)$/);
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (req.method === 'PUT') {
          const body = await readBody(req);
          return sendJson(res, 200, gangs.define(name, body?.members ?? {}));
        }
        if (req.method === 'DELETE') return sendJson(res, 200, gangs.remove(name));
        if (req.method === 'POST') {
          const body = await readBody(req);
          return sendJson(res, 200, gangs.setEnabled(name, body?.enabled !== false));
        }
      }

      // --- match ---
      if (path === '/api/match' && req.method === 'POST') {
        const body = await readBody(req);
        const referenceId = body?.reference;
        if (!referenceId) return sendJson(res, 400, { error: 'reference camera id required' });
        const targets = body?.targets?.length
          ? body.targets
          : state.list().filter((c) => c.id !== referenceId && c.state === 'connected').map((c) => c.id);
        const r = await matchFrom(state, referenceId, targets, body?.props, applyFn, log);
        await refreshAllProperties();
        return sendJson(res, r.ok ? 200 : 409, r);
      }

      // --- liveview proxy ---
      // Proxied rather than linked directly so the browser only ever talks to
      // cambridge, and camd can stay bound to loopback.
      m = path.match(/^\/api\/cameras\/([^/]+)\/liveview$/);
      if (m && req.method === 'GET') {
        const cameraId = decodeURIComponent(m[1]);
        const single = url.searchParams.get('single') === '1';
        const upstream = `${camd.liveviewUrl(cameraId)}${single ? '?single=1' : ''}`;
        try {
          const r = await fetch(upstream);
          res.writeHead(r.status, {
            'Content-Type': r.headers.get('content-type') ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
          if (!r.body) { res.end(); return; }
          for await (const chunk of r.body) res.write(chunk);
          res.end();
        } catch (err) {
          if (!res.headersSent) sendJson(res, 502, { error: `liveview unavailable: ${err.message}` });
          else res.end();
        }
        return;
      }

      // --- static ---
      if (req.method === 'GET') {
        const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
        const full = resolve(PUBLIC_DIR, rel);
        // Refuse anything that escapes the public directory.
        if (!full.startsWith(resolve(PUBLIC_DIR))) {
          return sendJson(res, 403, { error: 'forbidden' });
        }
        try {
          const data = await readFile(full);
          res.writeHead(200, {
            'Content-Type': MIME[extname(full)] ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
          return res.end(data);
        } catch {
          return sendJson(res, 404, { error: `not found: ${path}` });
        }
      }

      return sendJson(res, 404, { error: `no route for ${req.method} ${path}` });
    } catch (err) {
      log.error('http', `${req.method} ${path}: ${err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    }
  });

  return {
    server,
    cfg,
    log,
    state,
    camd,
    presets,
    gangs,
    atem,
    visca,
    start() {
      camd.start();
      if (atem) {
        log.info('atem', `watching switcher at ${cfg.atem.host}:${cfg.atem.port} for tally`);
        atem.start();
      }
      if (visca) {
        // A VISCA port clash must not stop the cameras working. Say so and carry
        // on: losing the joystick is an inconvenience, losing the panel is not.
        visca.start().then(
          () => log.info('visca', `listening on ${cfg.visca.bind}:${cfg.visca.port}`),
          (err) => log.error('visca', `could not start (${err.message}); joystick control is off`),
        );
      }
      return new Promise((resolvePromise, rejectPromise) => {
        // Without this, a port clash surfaces as an unhandled 'error' event and a
        // raw stack trace — which reads like a crash of unknown cause rather than
        // "something is already on this port". camd says it plainly; so should this.
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            process.stderr.write(
              `\ncambridge: port ${cfg.cambridge.port} is already in use — ` +
              'is another cambridge already running?\n' +
              `  Find it:  lsof -ti:${cfg.cambridge.port}\n` +
              `  Stop it:  lsof -ti:${cfg.cambridge.port} | xargs kill\n\n`);
          } else {
            process.stderr.write(`\ncambridge: cannot listen: ${err.message}\n\n`);
          }
          camd.stop();
          rejectPromise(err);
        });
        server.listen(cfg.cambridge.port, cfg.cambridge.bind, () => {
          const urls = browsableUrls(cfg.cambridge.bind, cfg.cambridge.port);
          log.info('cambridge', `listening on ${urls.join('  ')}, camd at ${camdBase}`);
          resolvePromise({ ...server.address(), urls });
        });
      });
    },
    async stop() {
      camd.stop();
      atem?.stop();
      await visca?.stop();
      for (const c of sseClients) { try { c.end(); } catch { /* closed */ } }
      sseClients.clear();
      await new Promise((r) => server.close(r));
    },
  };
}

// Run directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const argIndex = process.argv.indexOf('--config');
  const configPath = argIndex > -1 ? process.argv[argIndex + 1] : './config/cambridge.json';
  const portIndex = process.argv.indexOf('--port');
  const app = createApp({ configPath });
  if (portIndex > -1) app.cfg.cambridge.port = Number(process.argv[portIndex + 1]);
  let addr;
  try {
    addr = await app.start();
  } catch {
    // start() has already explained the problem in plain language.
    process.exit(1);
  }
  const [primary, ...lan] = addr.urls;
  process.stdout.write(`\ncambridge ready\n\n  Open:      ${primary}\n`);
  for (const url of lan) {
    process.stdout.write(`  On iPad:   ${url}\n`);
  }
  process.stdout.write('\n');
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      app.log.info('cambridge', `${sig} received, shutting down`);
      await app.stop();
      process.exit(0);
    });
  }
}
