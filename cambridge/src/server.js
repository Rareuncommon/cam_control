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
import { isIP } from 'node:net';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CamdClient } from './camd-client.js';
import { StateModel } from './state.js';
import { Logger } from './log.js';
import { JsonStore } from './store.js';
import { Presets, Gangs, matchFrom, UndoHistory, PRESET_PROPS, PROP_GROUPS, FOCUS_EXCLUDED_REASON } from './control.js';
import { Adoption, normaliseMac, suggestId } from './adopt.js';
import { AtemTally, tallyForCameras } from './atem.js';
import { decodeCCdP, toCameraWrites, cameraForDestination, WriteCoalescer } from './atem-cc.js';
import { ViscaServer } from './visca.js';
import { evaluate as evaluateAlarms, summarise, byCamera, resolveThresholds, DEFAULT_THRESHOLDS } from './alarms.js';
import { report as takeReport, rollState } from './takelog.js';
import { Auth, hashPin } from './auth.js';
import { PtzSource } from './ptz/source.js';
import { camdNeeded, isPtzEntry } from './venue.js';
import { detect as detectPtz } from './ptz/detect.js';
import { supported as supportedPtz } from './ptz/drivers/index.js';
import { needsAdmin, roleEntry } from './ptz/schema.js';
import { PtzPresetBook } from './ptz/presets.js';
import { RawPanelClient, DEFAULT_PORT as SKAARHOJ_PORT } from './skaarhoj/rawpanel.js';
import { PanelController } from './skaarhoj/mapping.js';

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
    // `link` is separate from `enabled` on purpose. Tally is read-only and safe
    // to leave on; Link writes to cameras from a decoder whose wrapper layout is
    // not yet confirmed against real hardware, so it is opt-in.
    atem: { enabled: false, host: '', port: 9910, mapping: {}, link: false, logRaw: false },
    visca: { enabled: false, bind: '0.0.0.0', port: 52381, tcp: true, mapping: {} },
    // Always on, unlike the integrations above: a studio that has not thought
    // about thresholds is exactly the one that needs the defaults.
    alarms: { ...DEFAULT_THRESHOLDS },
    // No PIN configured means the panel is open, and says so in the UI. Locking
    // it as a side effect of an upgrade — on a shoot day, with no way in —
    // would be worse than the exposure it prevents.
    auth: { operatorPin: null, adminPin: null, tokens: {} },
    // PTZ connection tuning. Empty means the lifecycle defaults, which are
    // the same heartbeat and backoff numbers camd uses for the Sony bodies.
    ptz: { tallyFromAtem: false },
    // Who drives a SKAARHOJ panel. 'reactor' (the default) leaves the panel's
    // own Reactor in charge of the cameras; CamBridge only sees its moves by
    // polling. 'drive' makes CamBridge the panel's Raw Panel host, which needs
    // Raw Panel Mode switched on at the panel — see docs/skaarhoj.md.
    skaarhoj: { mode: 'reactor', host: '', port: SKAARHOJ_PORT, mapping: {} },
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
      alarms: { ...defaults.alarms, ...(parsed.alarms ?? {}) },
      auth: { ...defaults.auth, ...(parsed.auth ?? {}) },
      ptz: { ...defaults.ptz, ...(parsed.ptz ?? {}) },
      skaarhoj: { ...defaults.skaarhoj, ...(parsed.skaarhoj ?? {}) },
    };
  } catch (err) {
    process.stderr.write(`cambridge: config ${path} is not valid JSON: ${err.message}\n`);
    process.exit(1);
  }
}

export { camdNeeded };

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

  const camdUsed = camdNeeded(cfg);
  if (!camdUsed) log.info('cambridge', 'no Sony bodies configured — running without camd');

  // PTZ heads are driven from here, not through camd: there is no SDK
  // involved, and each head speaks its own network protocol.
  const ptz = new PtzSource({
    cameras: cfg.cameras.filter(isPtzEntry),
    tuning: cfg.ptz,
    log: (level, msg) => log.write(level, 'ptz', msg),
  });
  const isPtz = (cameraId) => ptz.has(cameraId);
  /** A PTZ camera's table entry, from the schema the state model holds. */
  const ptzEntry = (cameraId, id) => state.ptzSchemas.get(cameraId)?.byId.get(id) ?? null;

  const state = new StateModel();
  state.camdUsed = camdUsed;
  // Presets live beside the config, not beside the logs. Deriving this from
  // logging.dir happened to work when both sat in the repo and broke the moment
  // logs moved to ~/Library/Logs.
  const store = new JsonStore(
    join(dirname(resolve(configPath)), 'cambridge-presets.json'),
    { presets: {}, scenes: {}, gangs: {} },
    (level, msg) => log.write(level, 'store', msg),
  );
  const presets = new Presets(store, state, log);
  const ptzPresets = new PtzPresetBook({
    store,
    dir: join(dirname(resolve(configPath)), 'ptz-thumbs'),
    log: (level, msg) => log.write(level, 'ptz', msg),
  });
  const gangs = new Gangs(store, state, log);
  const adoption = new Adoption(configPath, camd, log, ptz);

  const undo = new UndoHistory();
  const auth = new Auth(cfg.auth, (level, subject, msg) => log.write(level, subject, msg));
  if (!auth.enabled) {
    log.warn('auth', 'no PIN configured — anyone on this network can control the cameras');
  }

  /**
   * Injected setter used by presets, gang and match, so all writes are logged.
   *
   * Also the one choke point where undo history is captured. Every surface ends
   * up here — the panel's property PUT, gang fanout, preset and scene recall,
   * match, VISCA and the gamepad — so recording here catches all of them, and
   * recording anywhere else would catch some.
   */
  const applyFn = async (cameraId, prop, raw) => {
    // Admin-level PTZ settings never travel this path. It is the path presets,
    // gangs, undo, VISCA and ATEM Link share, and none of them should be able
    // to change a camera's IP address or password — even by accident, through
    // a preset that happened to capture one.
    if (isPtz(cameraId) && needsAdmin(ptzEntry(cameraId, prop))) {
      return { ok: false, status: 403, body: { error: `${ptzEntry(cameraId, prop).label} needs the admin settings` } };
    }
    const before = state.get(cameraId)?.properties?.[prop]?.value;
    const res = isPtz(cameraId)
      ? await ptz.setProperty(cameraId, prop, raw)
      : await camd.setProperty(cameraId, prop, raw);
    log.debug('set', `${cameraId} ${prop}=${raw} -> ${res.ok ? 'ok' : res.body?.error}`);
    // Only successful writes enter the history. A refused write did not change
    // the camera, so there is nothing to undo, and an entry for it would make
    // the next undo skip the change the operator actually wants back.
    if (res.ok) undo.record(cameraId, prop, before, res.body?.applied ?? raw);
    return res;
  };

  /** Applies a set of raw values without recording them as new history. */
  async function applyWithoutHistory(cameraId, values) {
    undo.suspended = true;
    try {
      const results = [];
      for (const [prop, raw] of Object.entries(values)) {
        const res = await applyFn(cameraId, prop, raw);
        results.push({ prop, ok: !!res.ok, value: raw, error: res.ok ? null : res.body?.error });
      }
      return results;
    } finally {
      undo.suspended = false;
    }
  }

  /**
   * The single path every camera action takes, from every surface.
   *
   * It exists for record intent. Telling an ordinary stop apart from a camera
   * giving up requires knowing a stop was asked for, and that has to be recorded
   * wherever the ask came from — panel, Companion, VISCA joystick or gamepad.
   * With VISCA calling camd directly this was two paths, and a stop pressed on
   * the joystick would have been reported as a fault.
   */
  const runAction = async (cameraId, action, body) => {
    if (isPtz(cameraId)) {
      // The same Reconnect button the Sony cards have; for a PTZ head it cuts
      // the backoff short.
      if (action === 'reconnect') return ptz.reconnect(cameraId);
      if (needsAdmin(ptzEntry(cameraId, action))) {
        return { ok: false, status: 403, body: { error: `${ptzEntry(cameraId, action).label} needs the admin settings` } };
      }
      return ptz.action(cameraId, action, body);
    }
    if (action === 'recordStart') state.markRecordIntent(cameraId, 'start');
    if (action === 'recordStop') state.markRecordIntent(cameraId, 'stop');
    return camd.action(cameraId, action, body);
  };

  // --- switcher tally -------------------------------------------------------
  // Read-only, and entirely optional. With no ATEM configured this stays null
  // and every tally indicator simply never lights.
  let atem = null;
  let atemWrites = null;
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
        // Off unless asked for: Reactor may already be driving these lamps, and
        // two masters for one lamp make it flicker between them.
        if (cfg.ptz.tallyFromAtem) {
          for (const id of ptz.ids()) {
            const t = byCamera[id] ?? { program: false, preview: false };
            ptz.setTally(id, { program: !!t.program, preview: !!t.preview });
          }
        }
      }
    });
    // Losing the switcher must clear tally rather than freeze it. A red light on
    // a camera that is no longer live is worse than no light at all.
    atem.on('disconnected', () => {
      log.warn('atem', 'switcher connection lost, clearing tally');
      state.applyTally({});
    });

    // --- ATEM Link ---
    // Camera control broadcast by the switcher, translated into ordinary
    // property writes. Every write goes through applyFn, so a move made on a
    // Blackmagic panel is logged, gang-aware and undoable exactly like one made
    // in the browser.
    if (cfg.atem.link || cfg.atem.logRaw) {
      atemWrites = new WriteCoalescer(
        (cameraId, prop, value) => applyFn(cameraId, prop, value),
        cfg.atem.coalesceMs ?? 120,
      );

      atem.on('cameraControl', (body) => {
        const decoded = decodeCCdP(body);

        // The capture mode. The wrapper layout this decoder assumes is not
        // confirmed against hardware, so this prints the bytes next to the
        // interpretation: move one control at a time on the panel and the log
        // says whether the two agree.
        if (cfg.atem.logRaw) {
          log.info('atem-link', decoded.ok
            ? `CCdP dest=${decoded.destination} ${decoded.category}.${decoded.parameter} `
              + `type=${decoded.dataType}${decoded.relative ? ' relative' : ''} `
              + `values=[${decoded.values.join(', ')}]  raw: ${decoded.raw}`
            : `CCdP undecodable (${decoded.error})  raw: ${decoded.raw}`);
        }
        if (!cfg.atem.link || !decoded.ok) return;

        const cameraId = cameraForDestination(cfg.atem.mapping, decoded.destination);
        if (!cameraId) return;   // an input with no camera behind it
        const camera = state.get(cameraId);
        if (!camera || camera.state !== 'connected') return;

        const { writes, skipped } = toCameraWrites(decoded, camera);
        for (const w of writes) {
          if (w.action) runAction(cameraId, w.action);
          else atemWrites.submit(cameraId, w.prop, w.value);
        }
        // Logged at debug: an unmapped wheel produces these continuously while
        // it is turning, and at info it would bury everything else.
        for (const s of skipped) {
          log.debug('atem-link', `${cameraId}: ignored ${s.category}.${s.parameter} — ${s.reason}`);
        }
      });

      log.info('atem', cfg.atem.link
        ? 'ATEM Link is ON — the switcher can drive camera exposure'
        : 'ATEM Link capture mode: logging camera control without acting on it');
    }
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
      actionFn: (cameraId, action, actionBody) => runAction(cameraId, action, actionBody),
      recallPreset: (name, cameraId) => presets.recallPreset(cameraId, name, applyFn),
      savePreset: (name, cameraId) => presets.savePreset(cameraId, name),
      mapping: cfg.visca.mapping,
      bind: cfg.visca.bind,
      port: cfg.visca.port,
      tcp: cfg.visca.tcp !== false,
      log: (level, msg) => log.write(level, 'visca', msg),
      udpHoldMs: cfg.visca.udpHoldMs ?? 30_000,
      // PTZ heads get motion, presets and focus. Writes and actions still go
      // through applyFn and runAction, so they are logged and refuse admin
      // settings exactly as the panel's do.
      ptz: {
        move: (id, v, o) => ptz.move(id, v, o),
        preset: (id, op, n) => ptz.preset(id, op, n),
        action: (id, entryId) => runAction(id, entryId),
        write: (id, entryId, value) => applyFn(id, entryId, value),
        entryByRole: (id, role) => roleEntry([...(state.ptzSchemas.get(id)?.byId.values() ?? [])], role),
        presetBase: (id) => state.ptzSchemas.get(id)?.capabilities?.presetBase ?? 1,
        releaseSource: (source) => ptz.releaseSource(source),
      },
    });
  }

  /**
   * A camera-native preset operation, with the bookkeeping CamBridge adds:
   * a picture and a name on store, forgetting both on delete. Shared by the
   * HTTP route and the SKAARHOJ panel so a preset stored from either looks
   * the same in the browser.
   */
  async function ptzPreset(cameraId, op, n, { speed, name } = {}) {
    const r = await ptz.preset(cameraId, op, n, { speed });
    let saved = null;
    if (r.ok && op === 'store') {
      // The head is at the stored position right now, so this frame is
      // the shot the preset recalls. A missing picture is not a failure.
      const frame = await ptz.snapshot(cameraId).catch(() => null);
      saved = ptzPresets.stored(cameraId, n, name, frame?.ok ? frame : null);
    }
    if (r.ok && op === 'delete') ptzPresets.forget(cameraId, n);
    // Names live here, not on the head, so no camera event will say one
    // changed: tell the panel directly.
    if (r.ok && op !== 'recall') skaarhoj?.controller.refresh();
    return { r, saved };
  }

  // --- SKAARHOJ panel, driven by CamBridge -----------------------------------
  // Off unless an admin switches it on. In the default 'reactor' mode the
  // panel's own Reactor drives the cameras and nothing here runs: the PTZ
  // lifecycle's polling is what keeps CamBridge in step with it.
  let skaarhoj = null;   // { client, controller } while driving a panel

  /** PTZ cameras in config order: the order of the panel's camera buttons. */
  function panelCameras() {
    return ptz.ids().map((id) => state.get(id)).filter(Boolean).map((c) => ({
      id: c.id, label: c.label, state: c.state, tally: c.tally ?? null, ptz: c.ptz ?? null,
    }));
  }

  function startSkaarhoj() {
    const sc = cfg.skaarhoj;
    if (skaarhoj || sc.mode !== 'drive') return;
    if (!sc.host) {
      log.warn('skaarhoj', 'mode is "drive" but no panel address is set; the panel is not being driven');
      return;
    }
    const slog = (level, msg) => log.write(level, 'skaarhoj', msg);
    const client = new RawPanelClient({
      host: sc.host,
      port: Number(sc.port) || SKAARHOJ_PORT,
      // Tuning, for tests and odd networks; the defaults follow the notes.
      ...(Number.isFinite(sc.heartbeatMs) ? { heartbeatMs: sc.heartbeatMs } : {}),
      ...(Number.isFinite(sc.lostAfterMs) ? { lostAfterMs: sc.lostAfterMs } : {}),
      ...(Array.isArray(sc.backoffMs) ? { backoffMs: sc.backoffMs } : {}),
      log: slog,
    });
    const controller = new PanelController({
      client,
      ptz,
      cameras: panelCameras,
      schema: (id) => { const r = ptz.schema(id); return r.ok ? r.body : null; },
      value: (id, prop) => state.get(id)?.properties?.[prop]?.value,
      // Through applyFn, like every other surface: logged, undoable, and
      // never an admin-level setting.
      setProperty: (id, prop, v) => applyFn(id, prop, v),
      preset: async (id, op, n) => (await ptzPreset(id, op, n)).r,
      presetName: (id, n) => ptzPresets.name(id, n),
      mapping: sc.mapping,
      log: slog,
    });
    controller.attach();
    const push = () => pushToClients(buildPush());
    client.on('status', push);
    controller.on('selected', push);
    controller.on('layout', push);
    skaarhoj = { client, controller };
    log.info('skaarhoj', `driving the panel at ${sc.host}:${client.port}`);
    client.start();
  }

  async function stopSkaarhoj() {
    if (!skaarhoj) return;
    const { client, controller } = skaarhoj;
    skaarhoj = null;
    // Motion first: whatever the stick was holding stops before the link goes.
    controller.detach();
    await client.stop();
    pushToClients(buildPush());
  }

  function skaarhojStatus() {
    const sc = cfg.skaarhoj;
    const st = skaarhoj?.client.status() ?? null;
    const cs = skaarhoj?.controller.status() ?? null;
    let detail = st?.detail ?? null;
    if (!skaarhoj) {
      detail = sc.mode === 'drive'
        ? 'no panel address set'
        : 'Reactor drives the cameras; CamBridge follows by polling';
    }
    return {
      mode: sc.mode,
      host: sc.host,
      port: Number(sc.port) || SKAARHOJ_PORT,
      connected: !!st?.connected,
      state: st?.state ?? 'off',
      panel: st?.panel ?? null,
      detail,
      selectedCameraId: cs?.selectedCameraId ?? null,
      topologySummary: st?.connected ? (cs?.topologySummary ?? null) : null,
    };
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

  const thresholds = resolveThresholds(cfg.alarms);
  /** Codes already logged, so a standing alarm is logged once, not every poll. */
  let loggedAlarms = new Set();

  /**
   * The full push payload.
   *
   * Alarms ride along with state rather than travelling on their own channel:
   * they are derived entirely from the state in the same message, and splitting
   * them would let a browser render a banner about a camera whose card reading
   * it has not received yet.
   */
  function buildPush() {
    const view = state.view();
    const alarms = evaluateAlarms(view.cameras, thresholds);
    logNewAlarms(alarms);
    return {
      type: 'state',
      view,
      alarms,
      alarmsByCamera: byCamera(alarms),
      alarmSummary: summarise(alarms),
      roll: rollState(view.cameras),
      undo: undo.summary(),
      skaarhoj: skaarhojStatus(),
    };
  }

  /**
   * Writes each alarm to the log once, on the edge.
   *
   * A draining card produces an alarm on every status poll for as long as it is
   * low. Logging all of them buries the transition that mattered under hundreds
   * of identical lines — the same mistake that made the daemon log unreadable
   * when SDK errors were logged per occurrence.
   */
  function logNewAlarms(alarms) {
    const now = new Set(alarms.map((a) => `${a.cameraId}:${a.code}`));
    for (const a of alarms) {
      const key = `${a.cameraId}:${a.code}`;
      if (loggedAlarms.has(key)) continue;
      log.write(a.level === 'critical' ? 'error' : 'warn', 'alarm',
        `${a.label} ${a.message}`);
    }
    for (const key of loggedAlarms) {
      if (!now.has(key)) log.info('alarm', `cleared: ${key}`);
    }
    loggedAlarms = now;
  }

  // Coalesce bursts: turning an iris wheel produces a stream of property events,
  // and repainting per event would swamp an iPad over Wi-Fi.
  let pushTimer = null;
  state.on('change', (change) => {
    // Tally, labels, values and presets all show on the panel; it repaints
    // only what changed, on its own short coalescing timer.
    skaarhoj?.controller.refresh();
    if (change.type === 'connectionState' || change.type === 'camdConnection'
        || change.type === 'tally') {
      // Connection transitions are the one thing that must never be delayed —
      // "camera offline" is the message the operator needs instantly. Tally is
      // the same: it has to track the cut, not trail it by a coalescing window.
      pushToClients(buildPush());
      return;
    }
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      pushToClients(buildPush());
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

  /** Shared by camd and the PTZ source: a camera changed connection state. */
  async function onConnectionState(ev) {
    const before = state.get(ev.cameraId)?.state;
    state.applyConnectionState(ev);
    log.info('camera', `${ev.cameraId} ${before ?? '?'} -> ${ev.state}` +
      (ev.detail ? ` (${ev.detail})` : ''));
    // Undo history does not survive an outage. The values a camera held
    // before it dropped are not somewhere it can be put back to — it may
    // have been power-cycled since — and offering to undo to them would be
    // offering to write a stale number to a body that never had it.
    if (ev.state !== 'connected') undo.forget(ev.cameraId);
    // A camera that just came back needs its full property set refetched;
    // camd republishes changes, but we want the complete picture immediately.
    if (ev.state === 'connected') await refreshProperties(ev.cameraId);
  }

  // --- PTZ event wiring -----------------------------------------------------
  // The same state model, fed from the PTZ source. Values arrive in batches
  // because one poll answers several settings at once.
  ptz.on('event', async (ev) => {
    switch (ev.event) {
      case 'ptzHello':
        state.replaceAll(ptz.snapshots(), null, 'ptz');
        break;
      case 'connectionState':
        await onConnectionState(ev);
        break;
      case 'ptzSchema': {
        const r = ptz.schema(ev.cameraId);
        if (r.ok) state.setPtzSchema(ev.cameraId, r.body);
        break;
      }
      case 'ptzValues':
        state.mergeProperties(ev.cameraId, ev.values);
        break;
      case 'ptzStatus':
        state.applyPtz(ev.cameraId, ev.ptz);
        break;
      default:
        log.debug('ptz', `unhandled event ${ev.event}`);
    }
  });

  camd.on('event', async (ev) => {
    switch (ev.event) {
      case 'hello':
        state.replaceAll(ev.cameras ?? [], ev.backend, 'camd');
        await refreshAllProperties();
        break;
      case 'connectionState':
        await onConnectionState(ev);
        break;
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
    const res = isPtz(cameraId)
      ? await ptz.getProperties(cameraId)
      : await camd.getProperties(cameraId);
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
    if (!camdUsed) return;
    const res = await camd.listCameras();
    if (res.ok && res.body?.cameras) {
      state.replaceAll(res.body.cameras, null, 'camd');
      await refreshAllProperties();
    }
  }

  /**
   * After a camera's IP address is changed from here: find it at the new
   * address, then update the stored address so the connection follows it.
   *
   * Only after it answers. Writing the new address first would turn a typo
   * into a camera CamBridge can no longer find at either address.
   */
  function followNewAddress(cameraId, newIp) {
    const entry = adoption.adopted().find((c) => c.id === cameraId);
    if (!entry) return;
    const deadline = Date.now() + 90_000;
    const attempt = async () => {
      const r = await detectPtz({ host: newIp, vendor: entry.vendor, ...entry.auth },
        { timeoutMs: 2500, log: (level, msg) => log.write(level, 'ptz', msg) });
      if (r.ok) {
        const u = await adoption.update(cameraId, { ip: newIp });
        log.info('ptz', u.ok ? `${cameraId} found at ${newIp}; stored address updated`
          : `${cameraId} found at ${newIp} but the config could not be updated: ${u.error}`);
        return;
      }
      if (Date.now() < deadline) setTimeout(attempt, 3000);
      else log.error('ptz', `${cameraId} did not answer at ${newIp} within 90s; still stored at ${entry.ip}`);
    };
    setTimeout(attempt, 3000);
  }

  // --- HTTP -----------------------------------------------------------------

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // Reused by every path-parameter route below.
    let m;

    try {
      // --- access control ---
      // Ahead of every route rather than sprinkled through them, so a route
      // added later is protected by default instead of protected if remembered.
      // Static files are served without a check: the login page has to be
      // reachable to log in, and the panel's own JS is not a secret — every
      // endpoint it calls is gated here regardless.
      const gated = path.startsWith('/api/');
      const who = { role: 'anonymous', label: 'anonymous' };
      if (gated) {
        const verdict = auth.authorise(req.method, path, req);
        Object.assign(who, verdict.who);
        if (!verdict.allowed) {
          log.warn('auth', `${verdict.status} ${req.method} ${path} (${verdict.who.label})`);
          // `authRequired` means "signing in would fix this", so it belongs on
          // the 401 only. A 403 is a valid session that lacks the role, and
          // flagging it the same way sends the panel to a login the operator
          // would pass — teaching them nothing about why it failed.
          return sendJson(res, verdict.status, {
            error: verdict.error,
            ...(verdict.status === 401 ? { authRequired: true } : { needsRole: 'admin' }),
          });
        }
      }
      /** Prefixes an audit line with who did it. */
      const actor = () => (who.label && who.label !== 'anonymous' ? `[${who.label}] ` : '');

      // --- auth ---
      if (path === '/api/auth/state' && req.method === 'GET') {
        return sendJson(res, 200, { ...auth.state(), you: { role: who.role, label: who.label } });
      }

      if (path === '/api/auth/login' && req.method === 'POST') {
        const body = await readBody(req);
        const result = auth.login(body?.pin ?? '');
        if (!result.ok) {
          log.warn('auth', `failed sign-in attempt from ${req.socket?.remoteAddress ?? '?'}`);
          return sendJson(res, 401, { error: result.error });
        }
        if (result.cookie) {
          res.setHeader('Set-Cookie', Auth.cookieHeader(result.cookie));
          log.info('auth', `signed in as ${result.role}`);
        }
        return sendJson(res, 200, { ok: true, role: result.role, open: !!result.open });
      }

      if (path === '/api/auth/logout' && req.method === 'POST') {
        if (who.id) auth.logout(who.id);
        res.setHeader('Set-Cookie', Auth.clearCookieHeader());
        return sendJson(res, 200, { ok: true });
      }

      // Setting a PIN is itself an admin action, which is why it is in
      // ADMIN_ROUTES — except on a panel with no PIN at all, where by
      // definition nobody could be admin yet and the first person to set one
      // is how the panel gets protected.
      if (path === '/api/auth/pin' && req.method === 'POST') {
        const body = await readBody(req);
        const role = body?.role === 'admin' ? 'adminPin' : 'operatorPin';
        const pin = String(body?.pin ?? '');
        if (pin.length < 4) {
          return sendJson(res, 400, { error: 'Use at least four characters.' });
        }
        const stored = hashPin(pin);
        auth[role] = stored;
        const saved = await adoption.saveAuth({ ...cfg.auth, [role]: stored });
        if (!saved.ok) return sendJson(res, 500, { error: saved.error });
        cfg.auth[role] = stored;
        log.info('auth', `${actor()}set the ${role === 'adminPin' ? 'admin' : 'operator'} PIN`);
        return sendJson(res, 200, { ok: true, ...auth.state() });
      }

      // --- events (SSE) ---
      if (path === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify(buildPush())}\n\n`);
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
      // The same envelope the SSE push carries, minus its `type`. One shape for
      // both paths: the Companion module falls back to polling this when its
      // stream drops, and a poll that returned less than the stream would make
      // alarms flicker off every time a network hiccup fell back.
      if (path === '/api/state' && req.method === 'GET') {
        const { type, ...envelope } = buildPush();
        return sendJson(res, 200, envelope);
      }

      // --- alarms ---
      // Same evaluation the SSE push uses, for anything that polls rather than
      // subscribes — a monitoring script, or curl at 3am.
      if (path === '/api/alarms' && req.method === 'GET') {
        const alarms = evaluateAlarms(state.view().cameras, thresholds);
        return sendJson(res, 200, {
          alarms,
          summary: summarise(alarms),
          thresholds,
          roll: rollState(state.list()),
        });
      }

      // --- take log ---
      // --- raw property dump (diagnostic) ---
      // Proxied straight through from camd. Operator-level rather than admin:
      // it is read-only, carries no credentials, and it is the one call that
      // answers "why won't this camera accept X" — putting it behind the admin
      // PIN would add friction to exactly the moment someone needs it.
      m = path.match(/^\/api\/cameras\/([^/]+)\/properties\/raw$/);
      if (m && req.method === 'GET') {
        const cameraId = decodeURIComponent(m[1]);
        if (isPtz(cameraId)) {
          // For a PTZ head the "unfiltered list" is its table with what the
          // camera turned out not to offer marked, next to the values it gave.
          const sch = ptz.schema(cameraId);
          const props = await ptz.getProperties(cameraId);
          return sendJson(res, sch.ok ? 200 : sch.status, sch.ok
            ? { ...sch.body, values: props.body?.properties ?? {} } : sch.body);
        }
        const r = await camd.request(
          'GET', `/cameras/${encodeURIComponent(cameraId)}/properties/raw`);
        return sendJson(res, r.ok ? 200 : (r.status || 502), r.body ?? { error: 'no answer from camd' });
      }

      if (path === '/api/takes' && req.method === 'GET') {
        return sendJson(res, 200, takeReport(state.takes));
      }

      // --- undo ---
      // Reverses the last property change on one camera. The write is made with
      // history suspended, so undo cannot become a toggle between two values.
      m = path.match(/^\/api\/cameras\/([^/]+)\/undo$/);
      if (m && req.method === 'POST') {
        const cameraId = decodeURIComponent(m[1]);
        const entry = undo.popLast(cameraId);
        if (!entry) {
          return sendJson(res, 200, { ok: true, cameraId, undone: null,
            detail: 'nothing to undo on this camera' });
        }
        const [result] = await applyWithoutHistory(cameraId, { [entry.prop]: entry.from });
        if (result.ok) await refreshProperties(cameraId);
        log.info('undo', `${actor()}${cameraId} ${entry.prop} ${entry.to} -> ${entry.from}` +
          (result.ok ? '' : ` FAILED: ${result.error}`));
        return sendJson(res, result.ok ? 200 : 502, {
          ok: result.ok, cameraId, undone: entry, error: result.error,
        });
      }

      // Undoes the last recall *and everything done since* — the answer to
      // "wrong scene, put it back".
      //
      // The mark is dropped before the recall applies anything, so what comes
      // back is the state from before it, not the state the recall produced.
      // The response says "undid", never "reverted to": the first reading of
      // "reverted to scene Interview" is the opposite of what this does.
      m = path.match(/^\/api\/cameras\/([^/]+)\/revert$/);
      if (m && req.method === 'POST') {
        const cameraId = decodeURIComponent(m[1]);
        const found = undo.popToMark(cameraId);
        if (!found) {
          return sendJson(res, 200, { ok: true, cameraId, undid: null,
            detail: 'no recall to undo on this camera' });
        }
        const results = await applyWithoutHistory(cameraId, found.values);
        if (results.some((r) => r.ok)) await refreshProperties(cameraId);
        const n = Object.keys(found.values).length;
        log.info('undo', `${actor()}${cameraId} undid ${found.mark.label} and everything since ` +
          `(${n} propert${n === 1 ? 'y' : 'ies'} restored)`);
        return sendJson(res, 200, {
          ok: results.every((r) => r.ok),
          cameraId,
          undid: found.mark.label,
          detail: `undid ${found.mark.label} and everything since it`,
          restored: n,
          results,
        });
      }

      // Dismiss a dropped-record alarm once it has been seen. Nothing else
      // clears it: the camera is not going to tell us it was noticed.
      m = path.match(/^\/api\/cameras\/([^/]+)\/acknowledge$/);
      if (m && req.method === 'POST') {
        const cameraId = decodeURIComponent(m[1]);
        const cleared = state.acknowledgeRecordDrop(cameraId);
        if (cleared) log.info('alarm', `${actor()}${cameraId} dropped-record alarm acknowledged`);
        return sendJson(res, 200, { ok: true, cameraId, cleared });
      }

      if (path === '/api/health' && req.method === 'GET') {
        const health = camdUsed ? await camd.health() : { ok: null, body: 'not used' };
        return sendJson(res, 200, {
          cambridge: 'ok',
          camdUsed,
          camdReachable: health.ok,
          camd: health.body ?? null,
          ptzCameras: ptz.ids().length,
          sseClients: sseClients.size,
          // Surfaced because two builds once used different config files, and an
          // invisible path made that look like lost data rather than a wrong path.
          configPath: resolve(configPath),
          logDir: resolve(cfg.logging.dir),
        });
      }

      // --- setup: discovery and adoption ---
      // Everything needed to add a camera from the browser. Discovery is annotated
      // with whether each body is already adopted, and by which entry, so the setup
      // page never offers to adopt a camera twice.
      if (path === '/api/discovered' && req.method === 'GET') {
        if (!camdUsed) {
          return sendJson(res, 200, {
            discovered: [],
            adoptedCount: adoption.adopted().length,
            camdUsed: false,
            credentialHint: 'This installation has no Sony bodies, so there is nothing to discover. '
              + 'Add PTZ cameras by IP address below.',
          });
        }
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
        const noAuth = list.filter((c) => !c.accessAuthRequired);
        // A camera reporting no access authentication is a warning, not a
        // convenience: on FX3/FX30 firmware the body then refuses SDK control
        // over the network entirely, connecting and dropping in a loop. Say so
        // here, where someone is looking at the camera that will do it.
        const credentialHint = noAuth.length
          ? `${noAuth.length === 1 ? 'A camera has' : `${noAuth.length} cameras have`} ` +
            'access authentication turned OFF. These bodies will not accept remote ' +
            'control in that state — turn [Access Authen. Settings] back On, then ' +
            'enter the username and password from [Access Authen. Info].'
          : needAuth.length
            ? `${needAuth.length} of these ${needAuth.length === 1 ? 'needs its password' : 'need their passwords'}, ` +
              'shown on the camera at MENU → Network → Network Option → [Access Authen. Info]. ' +
              'Each body has its own; you only enter them once.'
            : (list.length
              ? 'Every camera here is already added.'
              : 'No cameras seen yet. Check USB-LAN Connection and Remote Shooting on each body.');

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

      // --- SKAARHOJ panel mode ---
      if (path === '/api/skaarhoj' && req.method === 'GET') {
        return sendJson(res, 200, skaarhojStatus());
      }

      // Admin (ADMIN_ROUTES): it decides which system drives the cameras from
      // the panel, and it outlasts the shoot in the config file.
      if (path === '/api/skaarhoj' && req.method === 'PUT') {
        const body = (await readBody(req)) ?? {};
        const before = cfg.skaarhoj;
        const mode = body.mode ?? before.mode;
        if (mode !== 'reactor' && mode !== 'drive') {
          return sendJson(res, 400, { error: 'mode is "reactor" or "drive"' });
        }
        const host = body.host === undefined ? before.host : String(body.host ?? '').trim();
        if (host && !(isIP(host) || (host.length <= 253
            && /^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*$/.test(host)))) {
          return sendJson(res, 400, { error: `"${host}" is not an address` });
        }
        const port = body.port === undefined ? (Number(before.port) || SKAARHOJ_PORT) : Number(body.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return sendJson(res, 400, { error: 'port runs 1–65535' });
        }
        if (mode === 'drive' && !host) {
          return sendJson(res, 400, { error: "CamBridge needs the panel's address to drive it" });
        }
        const saved = adoption.saveSection('skaarhoj', { mode, host, port });
        if (!saved.ok) return sendJson(res, 500, { error: saved.error });
        // The file's block, so a mapping edited there by hand comes in too.
        cfg.skaarhoj = { ...cfg.skaarhoj, ...saved.block };
        const changed = mode !== before.mode || host !== before.host || port !== Number(before.port);
        if (mode !== before.mode) {
          log.info('skaarhoj', `${actor()}panel mode ${before.mode} -> ${mode}`
            + (mode === 'drive' ? ` (CamBridge drives the panel at ${host}:${port})` : ' (Reactor drives the cameras)'));
        } else if (changed) {
          log.info('skaarhoj', `${actor()}panel address ${before.host}:${before.port} -> ${host}:${port}`);
        }
        // Applied live: stop the old link (releasing any held motion) and
        // start the new one. Re-applied even when nothing changed, so a PUT
        // also picks up a mapping edited in the file.
        await stopSkaarhoj();
        startSkaarhoj();
        return sendJson(res, 200, skaarhojStatus());
      }

      // --- PTZ ---------------------------------------------------------------
      if (path === '/api/ptz/supported' && req.method === 'GET') {
        return sendJson(res, 200, { vendors: supportedPtz() });
      }

      // Add-by-IP, step one: what is at this address? Read-only on the camera.
      // Admin, because it sends credentials to whatever address it is given.
      if (path === '/api/ptz/detect' && req.method === 'POST') {
        const body = await readBody(req);
        const r = await detectPtz({
          host: body?.ip, port: body?.port, vendor: body?.vendor,
          username: body?.username, password: body?.password,
        }, { log: (level, msg) => log.write(level, 'ptz', msg) });
        log.info('ptz', `${actor()}detect ${body?.ip}: ${r.ok ? `${r.vendor} ${r.identity.model}` : 'nothing recognised'}`);
        return sendJson(res, r.ok ? 200 : 404, r);
      }

      // Step two: keep it.
      if (path === '/api/ptz/cameras' && req.method === 'POST') {
        const body = await readBody(req);
        const r = await adoption.addPtz(body ?? {});
        return sendJson(res, r.ok ? 201 : 409, r);
      }

      // The panic button: every PTZ head, every axis.
      if (path === '/api/ptz/stop-all' && req.method === 'POST') {
        log.info('ptz', `${actor()}STOP ALL`);
        await ptz.stopAll('stop all pressed');
        return sendJson(res, 200, { ok: true });
      }

      m = path.match(/^\/api\/cameras\/([^/]+)\/schema$/);
      if (m && req.method === 'GET') {
        const cameraId = decodeURIComponent(m[1]);
        if (!isPtz(cameraId)) return sendJson(res, 404, { error: `${cameraId} is not a PTZ camera` });
        const r = ptz.schema(cameraId);
        return sendJson(res, r.status, r.body);
      }

      m = path.match(/^\/api\/cameras\/([^/]+)\/ptz\/(move|stop|point|watch)$/);
      if (m && req.method === 'POST') {
        const [, cameraId, op] = m.map(decodeURIComponent);
        if (!isPtz(cameraId)) return sendJson(res, 404, { error: `${cameraId} is not a PTZ camera` });
        const body = (await readBody(req)) ?? {};
        let r;
        if (op === 'move') {
          // Not logged per call: a held joystick sends several a second. The
          // deadman's own log line says when a move ended and why.
          const v = {};
          for (const a of ['pan', 'tilt', 'zoom', 'focus']) if (a in body) v[a] = Number(body[a]);
          // A client may ask for a little more slack than the default (Wi-Fi
          // jitter), never enough to make the deadman meaningless.
          const holdMs = Math.min(Number(body.holdMs) || 0, 2000) || undefined;
          r = ptz.move(cameraId, v, { source: `http:${who.label}`, holdMs });
        } else if (op === 'stop') {
          r = await ptz.stopMotion(cameraId, `stop from ${who.label}`);
        } else if (op === 'point') {
          const x = Number(body.x); const y = Number(body.y);
          if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return sendJson(res, 400, { error: 'x and y run 0–1' });
          log.info('ptz', `${actor()}${cameraId} aim at ${x.toFixed(2)},${y.toFixed(2)}`);
          r = await ptz.pointToCentre(cameraId, { x, y });
        } else {
          ptz.watch(cameraId, Number(body.ms) || 5000);
          r = { ok: true, status: 200, body: {} };
        }
        return sendJson(res, r.ok ? 200 : (r.status || 502), { ok: r.ok, cameraId, ...(r.body ?? {}) });
      }

      // Camera-native presets: they live on the head, so Reactor, the vendor
      // web page and CamBridge all recall the same ones. Names and pictures
      // live here, because most heads cannot hold them.
      m = path.match(/^\/api\/cameras\/([^/]+)\/ptz\/presets$/);
      if (m && req.method === 'GET') {
        const cameraId = decodeURIComponent(m[1]);
        if (!isPtz(cameraId)) return sendJson(res, 404, { error: `${cameraId} is not a PTZ camera` });
        const caps = state.ptzSchemas.get(cameraId)?.capabilities;
        return sendJson(res, 200, {
          cameraId,
          base: caps?.presetBase ?? 1,
          count: caps?.presets ?? 0,
          presets: ptzPresets.list(cameraId),
        });
      }

      m = path.match(/^\/api\/cameras\/([^/]+)\/ptz\/presets\/(\d+)\/thumb$/);
      if (m && req.method === 'GET') {
        const t = ptzPresets.thumb(decodeURIComponent(m[1]), Number(m[2]));
        if (!t) return sendJson(res, 404, { error: 'no picture for that preset' });
        res.writeHead(200, { 'Content-Type': t.contentType, 'Content-Length': t.body.length, 'Cache-Control': 'no-cache' });
        return res.end(t.body);
      }

      m = path.match(/^\/api\/cameras\/([^/]+)\/ptz\/presets\/(\d+)(?:\/(recall|store))?$/);
      if (m && (req.method === 'POST' || req.method === 'DELETE' || req.method === 'PUT')) {
        const cameraId = decodeURIComponent(m[1]);
        const n = Number(m[2]);
        if (!isPtz(cameraId)) return sendJson(res, 404, { error: `${cameraId} is not a PTZ camera` });
        const body = (await readBody(req)) ?? {};
        if (req.method === 'PUT' && !m[3]) {
          const r = ptzPresets.rename(cameraId, n, body.name);
          return sendJson(res, r.ok ? 200 : 400, r);
        }
        const op = req.method === 'DELETE' ? 'delete' : m[3];
        if (!op) return sendJson(res, 404, { error: 'recall or store?' });
        const label = ptzPresets.name(cameraId, n);
        log.info('ptz', `${actor()}${cameraId} preset ${n}${label ? ` "${label}"` : ''} ${op}`);
        const { r, saved } = await ptzPreset(cameraId, op, n, { speed: body.speed, name: body.name });
        return sendJson(res, r.ok ? 200 : (r.status || 502), {
          ok: r.ok, cameraId, ...(r.body ?? {}), ...(saved ? { saved } : {}),
        });
      }

      // Admin settings and actions: network, users, firmware, reboot, reset.
      // Gated three ways, each for its own failure: the admin PIN (who), the
      // camera's name typed back (which — the wrong camera is the classic
      // mistake), and tally (when — never the camera that is on air).
      m = path.match(/^\/api\/cameras\/([^/]+)\/(admin-settings|admin-actions)\/([^/]+)$/);
      if (m && ((m[2] === 'admin-settings' && req.method === 'PUT') || (m[2] === 'admin-actions' && req.method === 'POST'))) {
        const [, cameraId, kind, id] = m.map(decodeURIComponent);
        if (!isPtz(cameraId)) return sendJson(res, 404, { error: `${cameraId} is not a PTZ camera` });
        const cam = state.get(cameraId);
        const entry = ptzEntry(cameraId, id);
        if (!entry) return sendJson(res, 404, { error: `this camera has no "${id}"` });
        if (!needsAdmin(entry)) return sendJson(res, 400, { error: `${entry.label} is an ordinary setting` });
        const body = (await readBody(req)) ?? {};
        const name = String(cam?.label ?? cameraId).trim().toLowerCase();
        if (String(body.confirm ?? '').trim().toLowerCase() !== name) {
          return sendJson(res, 400, { error: `Type the camera's name, "${cam?.label ?? cameraId}", to confirm.`, needsConfirm: true });
        }
        if (cam?.tally?.program) {
          return sendJson(res, 409, { error: `${cam.label} is on air. Take it off program first.` });
        }
        // Never the value of a secret in the log; the label says what changed.
        const shown = entry.secret ? '' : kind === 'admin-settings' ? ` = ${JSON.stringify(body.value)}` : '';
        log.warn('ptz', `${actor()}${cameraId} ADMIN ${kind === 'admin-settings' ? 'set' : 'run'} ${entry.label}${shown}`);
        const r = kind === 'admin-settings'
          ? await ptz.setProperty(cameraId, id, body.value)
          : await ptz.action(cameraId, id, body.payload);
        if (r.ok && kind === 'admin-settings' && entry.role === 'ipAddress') followNewAddress(cameraId, String(r.body?.applied ?? body.value));
        return sendJson(res, r.ok ? 200 : (r.status || 502), {
          ok: r.ok, cameraId, ...(r.body ?? {}),
          ...(r.ok && entry.role === 'ipAddress' ? { detail: 'CamBridge will reconnect at the new address once the camera answers there.' } : {}),
        });
      }

      // --- property set, with gang fanout ---
      m = path.match(/^\/api\/cameras\/([^/]+)\/properties\/([^/]+)$/);
      if (m && req.method === 'PUT') {
        const [, cameraId, prop] = m.map(decodeURIComponent);
        const body = await readBody(req);
        let raw;
        if (isPtz(cameraId)) {
          // PTZ tables have text and enum settings with string values; the
          // table, not this route, decides what is valid.
          raw = body?.value;
          if (raw === undefined || (raw !== null && typeof raw === 'object')) {
            return sendJson(res, 400, { error: 'body must be {"value": <value>}' });
          }
          const entry = ptzEntry(cameraId, prop);
          if (needsAdmin(entry)) {
            return sendJson(res, 403, {
              error: `${entry.label} changes something that outlasts this shoot — use the admin settings.`,
              needsRole: 'admin',
            });
          }
        } else {
          raw = Number(body?.value);
          if (!Number.isFinite(raw)) {
            return sendJson(res, 400, { error: 'body must be {"value": <number>}' });
          }
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
        log.info('action', `${actor()}${cameraId} ${action}${body ? ` ${JSON.stringify(body)}` : ''}`);
        const result = await runAction(cameraId, action, body ?? undefined);
        if (result.ok) await refreshProperties(cameraId);
        return sendJson(res, result.ok ? 200 : (result.status || 502), {
          ok: result.ok, cameraId, action, ...(result.body ?? {}),
        });
      }

      // --- record all (an on-set convenience worth having) ---
      if (path === '/api/record-all' && req.method === 'POST') {
        const body = await readBody(req);
        const want = body?.start !== false;
        // PTZ heads are not recorders; "record all" means every camera that rolls.
        const targets = state.list().filter((c) => c.state === 'connected' && c.kind !== 'ptz');
        log.info('action', `${actor()}record ${want ? 'start' : 'stop'} on ${targets.length} camera(s)`);
        const results = await Promise.all(targets.map(async (cam) => {
          const r = await runAction(cam.id, want ? 'recordStart' : 'recordStop');
          return { cameraId: cam.id, ok: r.ok, ...(r.body ?? {}) };
        }));
        const failed = results.filter((r) => !r.ok);
        if (failed.length) {
          log.error('action',
            `record ${want ? 'start' : 'stop'} failed on: ${failed.map((f) => f.cameraId).join(', ')}`);
        }
        return sendJson(res, 200, { ok: failed.length === 0, results });
      }

      // --- quit ---
      // The app runs as a macOS agent with no Dock icon, so this is the way out.
      // The launcher's PID is passed down so we can signal it rather than just
      // exiting: it owns camd too, and its trap is what stops both cleanly.
      if (path === '/api/shutdown' && req.method === 'POST') {
        log.info('cambridge', 'shutdown requested from the panel');
        sendJson(res, 200, { ok: true, stopping: true });
        const launcher = Number(process.env.CAMBRIDGE_LAUNCHER_PID);
        setTimeout(async () => {
          if (Number.isFinite(launcher) && launcher > 1) {
            try { process.kill(launcher, 'SIGTERM'); return; } catch { /* already gone */ }
          }
          // Started from a terminal, or the launcher has already exited. Stop
          // our own side cleanly; a camd started separately keeps running, which
          // is correct — we did not start it and must not assume we own it.
          camd.stop();
          await stopSkaarhoj();
          await ptz.stop();
          atem?.stop();
          atemWrites?.stop();
          await visca?.stop();
          process.exit(0);
        }, 150);
        return;
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
          undo.mark(cameraId, `preset "${name}"`);
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
          // A mark on every camera, not just the ones the scene names — the
          // operator reverts "the scene", and a camera left out of the mark
          // would be the one that stays wrong.
          for (const cam of state.list()) undo.mark(cam.id, `scene "${name}"`);
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
        const reference = state.get(referenceId);
        for (const id of targets) {
          undo.mark(id, `match to ${reference?.label ?? referenceId}`);
        }
        const r = await matchFrom(state, referenceId, targets, body?.props, applyFn, log);
        await refreshAllProperties();
        return sendJson(res, r.ok ? 200 : 409, r);
      }

      // --- liveview proxy ---
      // Proxied rather than linked directly so the browser only ever talks to
      // cambridge, and camd can stay bound to loopback.
      m = path.match(/^\/api\/cameras\/([^/]+)\/liveview$/);
      if (m && req.method === 'GET' && isPtz(decodeURIComponent(m[1]))) {
        // A PTZ head gives single frames; the panel only ever asks for single
        // frames (see startFeed), so there is no stream to emulate.
        const frame = await ptz.snapshot(decodeURIComponent(m[1]));
        if (!frame.ok) return sendJson(res, frame.status || 502, frame.body ?? { error: 'no picture' });
        res.writeHead(200, {
          'Content-Type': frame.contentType ?? 'image/jpeg',
          'Content-Length': frame.body.length,
          'Cache-Control': 'no-store',
        });
        return res.end(frame.body);
      }
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
    ptz,
    /** The live panel link while driving one, else null. */
    get skaarhoj() { return skaarhoj; },
    start() {
      if (camdUsed) camd.start();
      // Cameras into the state model before their first event can arrive, so
      // a connection state never lands on a camera the model does not know.
      state.replaceAll(ptz.snapshots(), null, 'ptz');
      ptz.start();
      startSkaarhoj();
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
      await stopSkaarhoj();
      await ptz.stop();
      atem?.stop();
      atemWrites?.stop();
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
