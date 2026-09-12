import { createExternalUi } from './external.js';
import { createPtzUi } from './ptz.js';
import { createGamepadControl } from './gamepad.js';
import {
  histogram, clipStats, applyFalseColour, markClipping, buildFalseColourLut,
  drawHistogram, drawGuides, drawClipReadout, FALSE_COLOUR_BANDS,
  containRect, pointToImage,
} from './scopes.js';

// CamBridge control panel.
//
// Vanilla JS, no build step. The organising idea for the UI is that a booth
// operator during a shoot should never have to hunt: the controls they touch
// most are big, always visible, and show their value without opening anything.
// Everything else lives behind "More".

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) n.append(kid);
  return n;
};
// Node.append() stringifies null into a literal "null" text node. Every control
// builder below returns null when the camera does not expose that property, so
// appending them has to go through here.
const add = (parent, ...kids) => { for (const k of kids) if (k) parent.append(k); return parent; };

let view = { camdConnected: false, cameras: [], backend: '' };
// Alarms arrive with the state they are derived from, in the same push, so the
// banner can never describe a camera whose readings have not arrived yet.
let alarms = [];
let alarmsByCamera = {};
let alarmSummary = null;
let roll = null;
let undoState = {};
let meta = { focusNote: '', scenes: [], presets: {}, groups: {} };
let discovery = { discovered: [], credentialHint: '' };
let health = {};
let currentView = 'control';
let soloFeed = null;
let gangSelection = new Set();
let interacting = null;
const externalUi = createExternalUi({ el, api, toast });
const ptzUi = createPtzUi({ el, api, toast, refresh: () => render() });
// Persisted so a booth iPad comes back the way it was left.
let advanced = localStorage.getItem('cb.advanced') === '1';
let rampMs = Number(localStorage.getItem('cb.rampMs') ?? 0);
// Which camera a gamepad drives. Deliberately not persisted as "enabled" —
// gamepad control always starts off, so a controller left plugged in over the
// week cannot move a camera the moment the panel is opened.
let padCamera = localStorage.getItem('cb.padCamera') ?? null;

// Monitoring assists. Persisted like the rest of the panel's preferences, so a
// booth iPad left on false colour comes back on false colour.
//
// 'off' | 'false' | 'clip' — one at a time, because false colour replaces the
// picture and clipping marks overlay it, and showing both means seeing neither.
let scopeMode = localStorage.getItem('cb.scopeMode') ?? 'off';
let guides = (() => {
  const stored = { thirds: false, centre: false, safe: false, matte: 'off',
                   histogram: false, clipReadout: false };
  try { return { ...stored, ...JSON.parse(localStorage.getItem('cb.guides') ?? '{}') }; }
  catch { return stored; }
})();
const falseColourLut = buildFalseColourLut();

function saveScopePrefs() {
  localStorage.setItem('cb.scopeMode', scopeMode);
  localStorage.setItem('cb.guides', JSON.stringify(guides));
}

/** Short badge text per alarm code; the full sentence is the tooltip. */
const ALARM_BADGE = {
  media: 'CARD',
  battery: 'BATTERY',
  recordFailed: 'REC FAILED',
  recordDropped: 'REC DROPPED',
};

/** "12:04" — mm:ss, or h:mm:ss once a take passes an hour. */
function clockDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

/**
 * Elapsed record time.
 *
 * The server sends a start timestamp rather than a running count, and this
 * ticks locally — pushing a new state once a second for a timer would mean the
 * whole panel repaints once a second all through a take.
 */
function recTimer(cam) {
  if (!cam.recordStartedAt) return null;
  const span = el('span', { class: 'rectime' });
  const text = () => clockDuration((Date.now() - cam.recordStartedAt) / 1000);

  // Set before returning, while the span is still detached. Checking
  // isConnected first — as the obvious version of this does — sees a node that
  // the caller has not appended yet, and stops the timer before it ever starts.
  span.textContent = text();

  const id = setInterval(() => {
    // Cards are rebuilt on every state push, so the previous span is orphaned.
    // Stopping here is what keeps a repaint from leaving an interval behind.
    if (!span.isConnected) { clearInterval(id); return; }
    span.textContent = text();
  }, 1000);
  return span;
}

/** Undo, showing what it would reverse so it is never a blind press. */
function undoButton(cam) {
  const u = undoState[cam.id];
  if (!u?.last && !u?.hasMark) return null;
  const wrap = el('span', { class: 'undo' });
  if (u.last) {
    add(wrap, el('button', {
      class: 'small ghost',
      text: `Undo ${propLabel(u.last.prop)}`,
      title: `Put ${propLabel(u.last.prop)} back to what it was before the last change`,
      onclick: () => api('POST', `/api/cameras/${encodeURIComponent(cam.id)}/undo`),
    }));
  }
  if (u.hasMark) {
    add(wrap, el('button', {
      class: 'small ghost',
      text: 'Undo recall',
      title: 'Undo the last preset or scene recall, and everything changed since',
      onclick: () => api('POST', `/api/cameras/${encodeURIComponent(cam.id)}/revert`),
    }));
  }
  return wrap;
}

/** Human name for a property, for the undo button. */
function propLabel(prop) {
  return ({
    fNumber: 'iris', isoSensitivity: 'ISO', shutterSpeed: 'shutter',
    colorTemp: 'Kelvin', wbTint: 'tint', whiteBalance: 'WB',
    ndValue: 'ND', focusPosition: 'focus',
  })[prop] ?? prop;
}

/** Card remaining, as time rather than the daemon's display string. */
function mediaChip(st) {
  const secs = st.mediaSlot1Sec;
  if (!Number.isFinite(secs) || secs < 0) {
    // -1 means the camera did not report it. Saying so beats printing "0:00",
    // which reads as a full card.
    return el('span', { text: 'card —', title: 'This camera does not report card time' });
  }
  return el('span', { text: `card ${clockDuration(secs)}` });
}

function toast(message, kind = 'ok', ttl = 5000) {
  const t = el('div', { class: `toast ${kind}`, text: message });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ttl);
}

let redirectingToLogin = false;

async function api(method, path, body, { quiet = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }

  // A session that expired mid-shoot must land on the sign-in page rather than
  // toasting "unauthorised" once per control and leaving a dead panel on screen.
  //
  // Guarded because location.replace() does not stop requests already in
  // flight: the panel fires several on load, and without this each one would
  // call replace() again on its way back.
  if (res.status === 401 && data?.authRequired) {
    if (!redirectingToLogin) {
      redirectingToLogin = true;
      location.replace('/login.html');
    }
    return {};
  }
  // 403 is different: the session is fine, the action needs admin. Say which,
  // and stay where we are — bouncing to a login the operator would pass would
  // teach them nothing about why it did not work.
  // `quiet` is for callers that explain the failure better themselves. Without
  // it they get two toasts: the raw daemon string and their own sentence.
  if (!res.ok && !quiet) toast(data?.error ?? `${method} ${path} failed (${res.status})`, 'bad', 9000);
  // Deliberately NOT named `ok`. Several endpoints return {ok:false} in the
  // body with HTTP 200 to report a partial result — record-all with one camera
  // refusing is the live example — so overwriting `ok` with the transport's
  // view would report that as a clean success.
  return { ...(data ?? {}), httpOk: res.ok, httpStatus: res.status };
}

const setProp = (id, prop, value) =>
  api('PUT', `/api/cameras/${encodeURIComponent(id)}/properties/${prop}`, { value });
const doAction = (id, action, body) =>
  api('POST', `/api/cameras/${encodeURIComponent(id)}/actions/${action}`, body);

/** Cameras already known to refuse a focus point, so we explain once, not per tap. */
const noPointFocus = new Set();

/**
 * Tap-to-focus, with an honest answer when the body will not take a point.
 *
 * Some bodies do not expose an AF area position over the SDK at all — an FX30
 * on the rig answered "afAreaPositionAFS is not supported by this body". Left
 * alone that surfaced as a raw daemon string on every single tap, which reads
 * as a broken feature rather than an unsupported one.
 *
 * Plain autofocus does work on those bodies, so the fallback is offered rather
 * than merely apologised for — and offered, not performed, because AF on the
 * camera's own area is a different thing from focusing where someone pointed,
 * and doing it unasked would be quietly wrong.
 */
async function tapFocus(cam, point) {
  if (noPointFocus.has(cam.id)) {
    toast(`${cam.label} cannot focus on a point — use AF`, 'warn', 4000);
    return;
  }

  const res = await api('POST',
    `/api/cameras/${encodeURIComponent(cam.id)}/actions/tapFocus`, point, { quiet: true });
  if (res.httpOk) return;

  if (res.reason === 'afAreaUnsupported') {
    // Remember, so the next twenty taps during a take do not each repeat it.
    noPointFocus.add(cam.id);
    toastAction(
      `${cam.label} does not accept a focus point. Its autofocus still works.`,
      'Focus with AF',
      () => doAction(cam.id, 'autofocus'));
    return;
  }
  if (res.reason === 'afAreaRefused') {
    toastAction(
      `${cam.label} refused a focus point in its current mode — check Focus Area on the body.`,
      'Focus with AF',
      () => doAction(cam.id, 'autofocus'));
    return;
  }
  toast(res.error ?? 'Tap to focus failed', 'bad', 8000);
}

/** A toast with one button on it. */
function toastAction(message, label, onClick) {
  const t = el('div', { class: 'toast warn' });
  add(t, el('span', { text: message }));
  add(t, el('button', {
    class: 'small ghost',
    text: label,
    onclick: () => { t.remove(); onClick(); },
  }));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 12_000);
}

// --- controls ---------------------------------------------------------------

// Tally from the switcher. Only rendered when an ATEM is actually configured —
// an always-present "off" badge would train the eye to ignore the one place it
// most needs to look.
function tallyBadge(cam) {
  if (!cam.tally) return null;
  if (cam.tally.program) return el('span', { class: 'pill pgm', text: 'ON AIR' });
  if (cam.tally.preview) return el('span', { class: 'pill pvw', text: 'PVW' });
  return null;
}

function stateBadge(cam) {
  const map = {
    connected: ['ok', 'ready'],
    connecting: ['warn', 'connecting…'],
    reconnecting: ['warn', `reconnecting ${cam.reconnectAttempts || ''}`.trim()],
    unauthorized: ['bad', 'wrong password'],
    offline: ['bad', 'offline'],
  };
  const [kind, text] = map[cam.state] ?? ['bad', cam.state];
  return el('span', { class: `pill ${kind}`, text, title: cam.detail ?? '' });
}

/**
 * The main control: −, the value, +.
 *
 * A stepper beats a dropdown here for three reasons — the current value is
 * always readable without opening anything, the targets are big enough for a
 * finger, and stepping one stop at a time is what an operator actually wants
 * mid-take. Tapping the value itself opens the full list for a big jump.
 */
function stepper(cam, propName, name, opts = {}) {
  const prop = cam.properties?.[propName];
  if (!prop) return null;
  const live = cam.state === 'connected' && prop.writable;
  const options = prop.options ?? null;
  const invert = !!opts.invert;  // for iris, "+" should mean "more light"

  const move = async (dir) => {
    if (!live) return;
    const step = invert ? -dir : dir;
    if (options?.length) {
      const idx = options.findIndex((o) => o.raw === prop.raw);
      const next = options[Math.min(Math.max((idx < 0 ? 0 : idx) + step, 0), options.length - 1)];
      if (next && next.raw !== prop.raw) await setProp(cam.id, propName, next.raw);
      return;
    }
    if (prop.range) {
      const s = prop.range.step || 1;
      const next = Math.min(Math.max(prop.raw + step * s * (opts.coarse ?? 1), prop.range.min), prop.range.max);
      if (next !== prop.raw) await setProp(cam.id, propName, next);
    }
  };

  const readout = el('div', {
    class: 'readout', text: prop.label ?? '—',
    title: live && options?.length ? 'Tap to pick from the full list' : '',
    onclick: () => { if (live && options?.length) openPicker(cam, propName, name); },
  });

  return el('div', { class: `stepper${live ? '' : ' locked'}` },
    el('div', { class: 'name', text: name }),
    el('div', { class: 'ctl' },
      el('button', { disabled: !live, onclick: () => move(-1), 'aria-label': `${name} down` },
        document.createTextNode('−')),
      readout,
      el('button', { disabled: !live, onclick: () => move(1), 'aria-label': `${name} up` },
        document.createTextNode('+'))));
}

// Iris/ISO/shutter can read as unsupported when the camera simply has that
// parameter on Auto in Flexible Exposure mode. Say so, and offer the switch.
function autoGate(cam, propName) {
  const gate = { fNumber: 'irisMode', isoSensitivity: 'gainMode', shutterSpeed: 'shutterMode' }[propName];
  if (!gate) return null;
  const g = cam.properties?.[gate];
  if (!g || g.raw !== 1) return null;
  const what = { irisMode: 'Iris', gainMode: 'ISO', shutterMode: 'Shutter' }[gate];
  return el('div', { class: 'gate' },
    el('span', { class: 'note', text: `${what} is on Auto` }),
    el('button', {
      class: 'small', disabled: !g.writable,
      onclick: () => setProp(cam.id, gate, 2),
    }, document.createTextNode('Set Manual')));
}

function toggleRow(cam, propName, name) {
  const prop = cam.properties?.[propName];
  if (!prop) return null;
  const on = prop.raw === 1;
  const live = cam.state === 'connected' && prop.writable;
  return el('div', { class: 'row' },
    el('label', { text: name }),
    el('button', {
      class: on ? 'primary small' : 'small', disabled: !live,
      onclick: () => setProp(cam.id, propName, on ? 0 : 1),
    }, document.createTextNode(on ? 'On' : 'Off')));
}

function sliderRow(cam, propName, name) {
  const prop = cam.properties?.[propName];
  if (!prop?.range) return null;
  const live = cam.state === 'connected' && prop.writable;
  const value = el('span', { class: 'value', text: prop.label ?? '—' });
  const key = `${cam.id}:${propName}`;
  const input = el('input', {
    type: 'range', disabled: !live,
    min: prop.range.min, max: prop.range.max, step: prop.range.step || 1, value: prop.raw,
    'data-key': key,
    oninput: (e) => { interacting = key; value.textContent = e.target.value; },
    onchange: async (e) => { interacting = null; await setProp(cam.id, propName, Number(e.target.value)); },
  });
  return el('div', { class: 'row' },
    el('label', { text: name }),
    el('div', { class: 'slide' }, input, value));
}

function focusRow(cam) {
  const prop = cam.properties?.focusPosition;
  const connected = cam.state === 'connected';
  const abs = !!(prop && prop.writable && prop.range);
  const slider = el('input', {
    type: 'range', disabled: !abs,
    min: prop?.range?.min ?? 0, max: prop?.range?.max ?? 1000,
    step: prop?.range?.step || 1, value: prop?.raw ?? 0,
    'data-key': `${cam.id}:focusPosition`,
    title: abs ? 'Absolute focus' : 'Switch the camera to MF for absolute focus',
    oninput: () => { interacting = `${cam.id}:focusPosition`; },
    onchange: async (e) => { interacting = null; await setProp(cam.id, 'focusPosition', Number(e.target.value)); },
  });
  const nudge = (steps, t) => el('button', {
    class: 'small', disabled: !connected,
    title: 'Relative focus — works on lenses without absolute positioning',
    onclick: () => doAction(cam.id, 'focusNudge', { steps }),
  }, document.createTextNode(t));
  return el('div', { class: 'row' },
    el('label', { text: 'Focus' }),
    el('div', { class: 'focusrow' }, slider, nudge(-10, '◀'), nudge(10, '▶'),
      el('button', { class: 'small', disabled: !connected, onclick: () => doAction(cam.id, 'autofocus') },
        document.createTextNode('AF'))));
}

function menuPad(cam) {
  const key = (k, t, cls = '') => el('button', {
    class: cls, disabled: cam.state !== 'connected',
    onclick: () => doAction(cam.id, 'key', { key: k }),
  }, document.createTextNode(t));
  return el('div', {},
    el('div', { class: 'note', style: 'margin-bottom:6px' },
      document.createTextNode('Drives the camera’s own menu. Watch it on Multiview.')),
    el('div', { class: 'dpad' },
      el('span', { class: 'blank' }), key('up', '▲'), el('span', { class: 'blank' }),
      key('left', '◀'), key('set', 'SET', 'primary'), key('right', '▶'),
      key('menu', 'MENU', 'small'), key('down', '▼'), key('back', 'BACK', 'small')));
}

// --- camera card ------------------------------------------------------------

function cameraCard(cam) {
  const rec = cam.status?.recording;
  const failed = cam.status?.recordingFailed;
  const connected = cam.state === 'connected';

  const tallyClass = cam.tally?.program ? ' pgm' : cam.tally?.preview ? ' pvw' : '';

  const card = el('section', {
    class: `cam${rec ? ' recording' : ''}${connected ? '' : ' offline'}${tallyClass}`,
    'data-id': cam.id,
  });
  card.append(el('header', {},
    el('span', { class: `recdot${rec ? ' on' : ''}${failed ? ' failed' : ''}` }),
    el('div', {},
      el('h2', { text: cam.label || cam.id }),
      el('div', { class: 'meta', text:
        `${cam.model || 'unknown'} · ${cam.ip || cam.transport || '—'}` +
        (cam.properties?.exposureMode ? ` · ${cam.properties.exposureMode.label}` : '') })),
    el('span', { class: 'spacer' }),
    tallyBadge(cam),
    padCamera === cam.id && gamepad?.enabled ? el('span', { class: 'pill', text: '🎮' }) : null,
    stateBadge(cam)));

  const body = el('div', { class: 'body' });
  if (!connected) {
    body.append(el('div', { class: 'note', text: cam.detail || 'No live values while disconnected.' }));
    body.append(el('button', { onclick: () => doAction(cam.id, 'reconnect') },
      document.createTextNode('Reconnect')));
    card.append(body);
    return card;
  }

  // Connected, but the body is telling us nothing. An empty card with a lone
  // Record button reads as a broken app; it is actually a camera that will not
  // answer property queries, and the operator can only fix that at the tripod.
  if (Object.keys(cam.properties ?? {}).length === 0) {
    body.append(el('div', { class: 'note warnnote' },
      document.createTextNode('Connected, but this camera is not reporting any '
        + 'settings, so there is nothing to control and Record is unsafe to press.')));
    body.append(el('div', { class: 'note' },
      document.createTextNode('On the camera itself: leave any menu, take it out of '
        + 'playback so it is showing a live picture, and confirm Remote Shooting is '
        + 'still On. If it stays like this, power-cycle that body — a session left '
        + 'open by earlier software will do exactly this.')));
    body.append(el('div', { class: 'btnrow' },
      el('button', { onclick: () => doAction(cam.id, 'reconnect') },
        document.createTextNode('Reconnect')),
      el('button', { class: 'small', onclick: () => switchView('setup') },
        document.createTextNode('Setup'))));
    card.append(body);
    return card;
  }

  // The four an operator touches during a shoot, plus ND when the body has it.
  add(body, stepper(cam, 'fNumber', 'Iris', { invert: true }), autoGate(cam, 'fNumber'));
  add(body, stepper(cam, 'isoSensitivity', 'ISO'), autoGate(cam, 'isoSensitivity'));
  add(body, stepper(cam, 'shutterSpeed', 'Shutter'), autoGate(cam, 'shutterSpeed'));
  add(body, stepper(cam, 'ndValue', 'ND', { coarse: 5 }));
  add(body, stepper(cam, 'colorTemp', 'Kelvin', { coarse: 1 }));

  const recRow = el('div', { class: 'btnrow' },
    el('button', {
      class: rec ? 'big' : 'danger big',
      disabled: cam.capabilities?.record?.available === false,
      title: cam.capabilities?.record?.reason || '',
      onclick: () => doAction(cam.id, rec ? 'recordStop' : 'recordStart'),
    }, document.createTextNode(rec ? '■ Stop' : '● Record')));
  add(recRow, recTimer(cam), undoButton(cam));
  body.append(recRow);

  const st = cam.status ?? {};
  const statusRow = el('div', { class: 'status' });
  add(statusRow,
    el('span', { text: `Battery ${st.battery >= 0 ? st.battery + '%' : '—'}` }),
    mediaChip(st),
    cam.properties?.ndDensity ? el('span', { text: cam.properties.ndDensity.label }) : null,
    failed ? el('span', { class: 'pill bad', text: 'RECORDING FAILED' }) : null);
  // Badges rather than another line of prose: at a glance the operator needs to
  // know which camera, not to read a sentence.
  for (const a of alarmsByCamera[cam.id] ?? []) {
    if (a.code === 'offline') continue;   // the card already says so, larger
    add(statusRow, el('span', {
      class: `pill ${a.level === 'critical' ? 'bad' : 'warn'}`,
      text: ALARM_BADGE[a.code] ?? a.code,
      title: `${a.label} ${a.message}`,
    }));
  }
  body.append(statusRow);

  // Everything else, behind a disclosure so the main card stays uncluttered.
  const more = el('details', { class: 'more', open: advanced });
  more.append(el('summary', { text: 'More controls' }));
  const inner = el('div', { class: 'inner' });
  add(inner,
    stepper(cam, 'whiteBalance', 'WB mode'),
    sliderRow(cam, 'wbTint', 'Tint'),
    focusRow(cam),
    stepper(cam, 'focusMode', 'AF mode'),
    stepper(cam, 'ndMode', 'ND mode'),
    sliderRow(cam, 'contrast', 'Contrast'),
    sliderRow(cam, 'saturation', 'Saturation'),
    sliderRow(cam, 'sharpness', 'Sharpness'),
    toggleRow(cam, 'zebraDisplay', 'Zebra'),
    toggleRow(cam, 'peakingDisplay', 'Peaking'),
    toggleRow(cam, 'subjectRecognitionAF', 'Track'),
    toggleRow(cam, 'steadyShotMovie', 'SteadyShot'),
    el('div', { class: 'btnrow' },
      el('button', { class: 'small', onclick: () => savePreset(cam) }, document.createTextNode('Save preset')),
      presetPicker(cam)),
    menuPad(cam));
  more.append(inner);
  body.append(more);

  card.append(body);
  return card;
}

async function savePreset(cam) {
  const name = prompt(`Preset name for ${cam.label}?`);
  if (!name) return;
  const r = await api('PUT', `/api/cameras/${cam.id}/presets/${encodeURIComponent(name)}`);
  if (r.ok) { toast(`Saved "${name}" for ${cam.label}`); loadMeta(); }
}

function presetPicker(cam) {
  const names = Object.keys(meta.presets?.[cam.id] ?? {});
  if (!names.length) return el('span', { class: 'note', text: 'no presets yet' });
  const sel = el('select', { class: 'small', style: 'max-width:170px' });
  sel.append(el('option', { value: '' }, document.createTextNode('Recall…')));
  for (const n of names) sel.append(el('option', { value: n }, document.createTextNode(n)));
  sel.addEventListener('change', async (e) => {
    const name = e.target.value;
    e.target.value = '';
    if (!name) return;
    const r = await api('POST', `/api/cameras/${cam.id}/presets/${encodeURIComponent(name)}`,
      { transitionMs: rampMs });
    if (r.ok) toast(`Recalled "${name}" on ${cam.label}`);
  });
  return sel;
}

// --- value picker dialog ----------------------------------------------------

function openPicker(cam, propName, title) {
  const prop = cam.properties?.[propName];
  if (!prop?.options?.length) return;
  const dlg = $('#picker');
  $('#picker-title').textContent = `${cam.label} — ${title}`;
  const list = $('#picker-list');
  list.textContent = '';
  for (const o of prop.options) {
    list.append(el('button', {
      class: o.raw === prop.raw ? 'primary' : '',
      onclick: async () => { dlg.close(); await setProp(cam.id, propName, o.raw); },
    }, document.createTextNode(o.label)));
  }
  dlg.showModal();
}

// --- views ------------------------------------------------------------------

function renderControl() {
  if (ptzUi.active) return;
  const editing = document.activeElement?.matches('.external-control input, .external-control select') ? document.activeElement.closest('.external-card') : null;
  if (editing) {
    const old = [...$('#grid').children];
    view.cameras.forEach((cam, i) => {
      if (old[i] === editing && editing.dataset.externalId === cam.id) return;
      const card = cam.provider === 'network-ptz' ? ptzUi.card(cam) : cam.external ? externalUi.card(cam) : cameraCard(cam);
      if (old[i]) old[i].replaceWith(card); else $('#grid').append(card);
    });
    old.slice(view.cameras.length).forEach(c => c.remove());
    return;
  }
  const grid = $('#grid');
  grid.textContent = '';
  if (!view.cameras.length) {
    grid.append(el('section', { class: 'cam' }, el('div', { class: 'body' },
      el('div', { class: 'note', text: view.camdConnected
        ? 'No cameras added yet.'
        : 'The camera daemon is not running, so there is nothing to control yet.' }),
      view.camdConnected
        ? el('button', { class: 'primary', onclick: () => switchView('setup') },
            document.createTextNode('Add a camera'))
        : el('div', { class: 'mono', text: './scripts/start.sh' }))));
  }
  for (const cam of view.cameras) grid.append(cam.provider === 'network-ptz' ? ptzUi.card(cam) : cam.external ? externalUi.card(cam) : cameraCard(cam));
}

// Live feeds, one polling loop per tile.
//
// This used to point an <img> at an MJPEG (multipart/x-mixed-replace) stream,
// which Chrome and Firefox render and Safari does not — it fires "error"
// instead. On a Mac the panel opens in whatever the default browser is, so the
// feed was black for exactly the reason that is hardest to guess from the app
// side: single frames worked perfectly and only the stream failed.
//
// Polling single frames is a little less efficient and works in every browser.
// One request in flight at a time, so a slow camera throttles itself rather than
// building a queue of stale frames.
const FEED_INTERVAL_MS = 100;
let feedStops = [];

function stopAllFeeds() {
  for (const stop of feedStops) stop();
  feedStops = [];
}

/**
 * Frames are decoded and drawn to a canvas rather than assigned to an <img>.
 *
 * The fetch loop, the one-request-in-flight rule and the consecutive-failure
 * counting below are unchanged — that shape is why the feeds work at all, and
 * is not something to disturb for a drawing change. What is gone is the object
 * URL dance: createImageBitmap takes the blob directly, so there is no URL to
 * create, assign in the right order, and revoke.
 *
 * The canvas is what makes scopes possible: once a frame is drawn, the pixels
 * are readable, and exposure analysis costs no extra traffic because the camera
 * is only ever asked for what it was already sending.
 */
function startFeed(cam, canvas, onFailure) {
  let stopped = false;
  let failures = 0;
  let frame = 0;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let lastHist = null;
  let lastClip = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const r = await fetch(
        `/api/cameras/${encodeURIComponent(cam.id)}/liveview?single=1`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      if (stopped) return;
      if (blob.size > 0) {
        const bitmap = await createImageBitmap(blob);
        if (stopped) { bitmap.close(); return; }
        drawFrame(ctx, canvas, bitmap, cam, { frame, lastHist, lastClip }, (h, c) => {
          lastHist = h; lastClip = c;
        });
        bitmap.close();
        frame += 1;
        failures = 0;
      }
    } catch (err) {
      // A camera reconnecting should not kill the tile; several in a row means
      // it is genuinely not producing.
      if (++failures === 10) onFailure(err);
    }
    if (!stopped) setTimeout(tick, FEED_INTERVAL_MS);
  };

  tick();
  return () => { stopped = true; };
}

/**
 * Draws one frame, plus whatever scopes and guides are switched on.
 *
 * Scopes are recomputed every SCOPE_EVERY_N frames and the previous result is
 * redrawn in between. A histogram that updates three times a second is
 * indistinguishable from one that updates ten times a second to anyone reading
 * it, and the difference is three full-frame pixel passes per second per
 * camera on a machine that is also running the shoot.
 */
const SCOPE_EVERY_N = 3;

function drawFrame(ctx, canvas, bitmap, cam, { frame, lastHist, lastClip }, remember) {
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  }
  const w = canvas.width;
  const h = canvas.height;
  ctx.drawImage(bitmap, 0, 0, w, h);

  const wantPixels = scopeMode !== 'off' || guides.histogram || guides.clipReadout;
  let hist = lastHist;
  let clip = lastClip;

  if (wantPixels) {
    const image = ctx.getImageData(0, 0, w, h);
    if (scopeMode === 'false') {
      applyFalseColour(image.data, falseColourLut);
      ctx.putImageData(image, 0, 0);
    } else if (scopeMode === 'clip') {
      markClipping(image.data);
      ctx.putImageData(image, 0, 0);
    }
    if (frame % SCOPE_EVERY_N === 0) {
      hist = guides.histogram ? histogram(image.data) : null;
      clip = guides.clipReadout ? clipStats(image.data) : null;
      remember(hist, clip);
    }
  }

  drawGuides(ctx, w, h, guides);
  if (guides.histogram && hist) {
    drawHistogram(ctx, hist, { x: w - Math.min(150, w * 0.34) - 8, y: 8,
      w: Math.min(150, w * 0.34), h: Math.min(60, h * 0.22) });
  }
  if (guides.clipReadout && clip) drawClipReadout(ctx, clip, { x: 8, y: h - 25 });
}

function feedTile(cam) {
  const rec = cam.status?.recording;
  const tallyClass = cam.tally?.program ? ' pgm' : cam.tally?.preview ? ' pvw' : '';
  const tile = el('div', { class: `feed${rec ? ' recording' : ''}${tallyClass}` });

  if (cam.state === 'connected') {
    const img = el('canvas', { class: 'feedcanvas', title: 'Click to focus here',
      role: 'img', 'aria-label': `${cam.label} live view` });
    const reason = el('div', { class: 'note', text: 'Waiting for the first frame…' });
    const fallback = el('div', { class: 'placeholder' },
      el('div', { text: 'No live view from this camera' }), reason);
    fallback.style.display = 'none';

    feedStops.push(startFeed(cam, img, async () => {
      img.style.display = 'none';
      fallback.style.display = 'flex';
      // Ask once more, and report whatever the camera actually says rather than
      // guessing at a cause.
      try {
        const r = await fetch(`/api/cameras/${encodeURIComponent(cam.id)}/liveview?single=1`);
        const body = await r.json().catch(() => null);
        reason.textContent = body?.error
          ?? `The camera stopped sending frames (HTTP ${r.status}).`;
      } catch (e) {
        reason.textContent = `Could not reach the live view endpoint: ${e.message}`;
      }
    }));

    // Tap-to-focus. Coordinates go up normalised, so the browser never needs to
    // know anything about the camera's AF grid.
    //
    // Measured against the picture, not the element. The canvas fills the tile
    // but `object-fit: contain` letterboxes the frame inside it, so the element
    // rect includes bars the camera knows nothing about. Using it meant every
    // tap on a feed whose shape differs from the 16:9 tile landed somewhere
    // else — invisible against the fake backend's 16:9 test card, which is the
    // one ratio where the two rects coincide.
    img.addEventListener('click', async (e) => {
      const r = img.getBoundingClientRect();
      const point = pointToImage(
        e.clientX - r.left, e.clientY - r.top, r.width, r.height,
        img.width, img.height);

      // A tap on a letterbox bar is not a request to focus at the edge of
      // frame. Do nothing rather than send a coordinate nobody pointed at.
      if (!point) return;

      const box = containRect(r.width, r.height, img.width, img.height);
      const mark = el('div', { class: 'tapmark' });
      mark.style.left = `${box.x + point.x * box.w}px`;
      mark.style.top = `${box.y + point.y * box.h}px`;
      tile.append(mark);
      setTimeout(() => mark.remove(), 1100);
      await tapFocus(cam, point);
    });
    tile.append(img, fallback);
  } else {
    tile.append(el('div', { class: 'placeholder' },
      el('div', { text: cam.state }), el('div', { class: 'note', text: cam.detail ?? '' })));
  }

  tile.append(el('div', { class: 'overlay' },
    el('span', { class: `recdot${rec ? ' on' : ''}` }),
    el('span', { text: cam.label || cam.id }),
    tallyBadge(cam),
    el('span', { class: 'spacer' }),
    el('span', { class: 'note', text: cam.properties?.fNumber?.label ?? '' })));

  tile.append(el('div', { class: 'tools' },
    el('button', { class: 'small', onclick: () => doAction(cam.id, 'autofocus') },
      document.createTextNode('AF')),
    el('button', {
      class: rec ? 'small' : 'small danger',
      disabled: cam.capabilities?.record?.available === false,
      title: cam.capabilities?.record?.reason || '',
      onclick: () => doAction(cam.id, rec ? 'recordStop' : 'recordStart'),
    }, document.createTextNode(rec ? '■' : '●')),
    el('button', {
      class: 'small',
      onclick: () => { soloFeed = soloFeed === cam.id ? null : cam.id; renderMultiview(); },
    }, document.createTextNode(soloFeed === cam.id ? 'Show all' : 'Enlarge'))));
  return tile;
}

function renderMultiview() {
  const grid = $('#mvgrid');
  // Every rebuild abandons the old <img> elements, so their polling loops have
  // to be stopped or they pile up: leave and re-enter the tab a few times and
  // the cameras are being asked for frames by a dozen dead tiles.
  stopAllFeeds();
  grid.textContent = '';
  const cams = soloFeed ? view.cameras.filter((c) => c.id === soloFeed) : view.cameras;
  grid.className = soloFeed ? 'solo' : '';
  if (!cams.length) {
    grid.append(el('div', { class: 'note', style: 'padding:12px', text: 'No cameras to show.' }));
    return;
  }
  for (const cam of cams.filter(c => c.provider !== 'network-ptz' && !c.external)) grid.append(feedTile(cam));
}

function renderSetup() {
  ptzUi.renderList(view.cameras);
  externalUi.renderList(view.cameras);
  $('#discover-hint').textContent = discovery.credentialHint ?? '';
  // Where this instance actually reads and writes. Invisible paths turned a
  // wrong config file into "the app forgot my cameras".
  const paths = $('#paths');
  if (paths) {
    paths.textContent = health.configPath
      ? `Cameras saved in ${health.configPath} · logs in ${health.logDir}`
      : '';
  }
  const dt = $('#discovered-table');
  dt.textContent = '';
  dt.append(el('tr', {}, el('th', { text: 'Model' }), el('th', { text: 'Address' }),
    el('th', { text: 'Connection' }), el('th', { text: '' })));
  const list = discovery.discovered ?? [];
  if (!list.length) {
    dt.append(el('tr', {}, el('td', { colspan: '4', class: 'note',
      text: 'No cameras seen yet. Connect a supported camera in USB PC Remote mode or enable its supported network remote connection.' })));
  }
  for (const cam of list) {
    dt.append(el('tr', {},
      // Triage a rack at a glance. A camera with authentication off is called
      // out as a problem rather than a convenience: these bodies refuse remote
      // control in that state, so "no password needed" would read as good news
      // about a camera that is never going to connect.
      el('td', {}, el('div', { text: cam.model || 'unknown' }),
        el('div', { class: 'note', text:
          cam.accessAuthRequired ? 'Enter this camera’s access credentials'
            : 'This connection does not request credentials' }),
        el('div', { class: 'note', text: cam.support?.listedBySdk
          ? (cam.support.verification === 'historical-rig-use' ? 'Previously used on the studio rig' : 'SDK-listed · awaiting hardware validation')
          : 'Detected by SDK · model not in the catalog' })),
      el('td', { class: 'mono', text: cam.ip || '—' }),
      el('td', { class: 'mono', text: cam.transport || (cam.mac ? 'Network' : 'SDK device'),
        title: cam.mac || cam.deviceId || 'No usable device identity' }),
      el('td', {}, cam.adopted
        ? el('span', { class: 'pill ok', text: `added as ${cam.adoptedAs?.label ?? ''}` })
        : el('button', { class: 'small primary', disabled: cam.adoptable === false,
            title: cam.adoptable === false ? 'SDK did not provide a usable identity; cannot safely bind this camera' : 'Add camera',
            onclick: () => openAdopt(cam) },
            document.createTextNode('Add')))));
  }

  const at = $('#adopted-table');
  at.textContent = '';
  at.append(el('tr', {}, el('th', { text: 'Name' }), el('th', { text: 'Model' }),
    el('th', { text: 'State' }), el('th', { text: '' })));
  if (!view.cameras.length) {
    at.append(el('tr', {}, el('td', { colspan: '4', class: 'note', text: 'Nothing added yet.' })));
  }
  for (const cam of view.cameras.filter(c => c.provider !== 'network-ptz' && !c.external)) {
    at.append(el('tr', {},
      el('td', { text: cam.label }),
      el('td', { class: 'note', text: cam.model || '—' }),
      el('td', {}, stateBadge(cam)),
      el('td', {}, el('div', { class: 'line' },
        el('button', { class: 'small', onclick: () => openEdit(cam) }, document.createTextNode('Edit')),
        el('button', {
          class: 'small', onclick: async () => {
            if (!confirm(`Remove "${cam.label}"? The camera itself is not changed.`)) return;
            const r = await api('DELETE', `/api/cameras/${encodeURIComponent(cam.id)}/adoption`);
            if (r.ok) { toast(`Removed ${cam.label}`); refreshSetup(); }
          },
        }, document.createTextNode('Remove'))))));
  }
}

// --- adoption dialog --------------------------------------------------------

let adoptTarget = null;
let editTarget = null;

/** Shows or hides the credential fields according to what the body asks for. */
function setAuthVisible(needsAuth) {
  $('#adopt-auth').style.display = needsAuth ? '' : 'none';
  $('#adopt-noauth').style.display = needsAuth ? 'none' : '';
}

/**
 * Whether a camera wants credentials, by MAC.
 *
 * Adopted cameras do not carry the flag — it comes from discovery — so an
 * already-added camera is looked up in the discovery list. Unknown means assume
 * it does need them: asking unnecessarily is a nuisance, but hiding the fields
 * from a camera that needs them is a dead end with no way out.
 */
function needsAuthFor(cam) {
  const found = (discovery.discovered ?? []).find((d) =>
    (cam.mac && d.mac === cam.mac) || (cam.deviceId && d.deviceId === cam.deviceId));
  return found ? found.accessAuthRequired !== false : true;
}

function openAdopt(cam) {
  adoptTarget = cam; editTarget = null;
  $('#adopt-title').textContent = `Add ${cam.model || 'camera'}`;
  $('#adopt-sub').textContent = `${cam.transport || (cam.ip ? 'Network' : 'USB / SDK')} · ${cam.ip || cam.mac || 'Direct camera connection'}`;
  $('#adopt-label').value = ''; $('#adopt-user').value = ''; $('#adopt-pass').value = '';
  $('#adopt-user').placeholder = 'from the camera screen';
  $('#adopt-pass').placeholder = 'from the camera screen';
  setAuthVisible(cam.accessAuthRequired !== false);
  $('#adopt-confirm').textContent = 'Add camera';
  $('#adopt-dialog').showModal();
  $('#adopt-label').focus();
}

function openEdit(cam) {
  editTarget = cam; adoptTarget = null;
  $('#adopt-title').textContent = `Edit ${cam.label}`;
  $('#adopt-sub').textContent = `${cam.transport || (cam.ip ? 'Network' : 'USB / SDK')} · ${cam.ip || cam.mac || 'Direct camera connection'}`;
  $('#adopt-label').value = cam.label ?? '';
  $('#adopt-user').value = ''; $('#adopt-pass').value = '';
  // Credentials are never sent to the browser, so blank means "leave alone".
  $('#adopt-user').placeholder = 'leave blank to keep current';
  $('#adopt-pass').placeholder = 'leave blank to keep current';
  setAuthVisible(needsAuthFor(cam));
  $('#adopt-confirm').textContent = 'Save';
  $('#adopt-dialog').showModal();
  $('#adopt-label').focus();
}

let portfolio = null;
function renderPortfolio() {
  if (!portfolio) return;
  const filter = ($('#portfolio-search').value || '').toLowerCase();
  $('#portfolio-summary').textContent = `${portfolio.models.length} Sony models listed for SDK ${portfolio.sdkVersion}. ${portfolio.connectionNote}`;
  const table = $('#portfolio-table');
  table.textContent = '';
  table.append(el('tr', {}, ...['Camera', 'Family', 'Validation'].map((text) => el('th', { text }))));
  for (const m of portfolio.models.filter((m) => [m.name, m.model, m.family, ...m.aliases].join(' ').toLowerCase().includes(filter))) {
    table.append(el('tr', {}, el('td', { text: `${m.name} (${m.model})` }),
      el('td', { text: m.family }), el('td', { text: m.verification === 'historical-rig-use'
        ? 'Prior studio use' : 'Hardware validation pending' })));
  }
}
$('#portfolio-search').addEventListener('input', renderPortfolio);
async function refreshSetup() {
  await ptzUi.setup();
  await externalUi.setup();
  discovery = await api('GET', '/api/discovered');
  if (!portfolio) {
    const result = await api('GET', '/api/camera-support');
    if (Array.isArray(result.models)) { portfolio = result; renderPortfolio(); }
  }
  renderSetup();
}

// --- shared -----------------------------------------------------------------

function render() {
  const pill = $('#camd-pill');
  pill.textContent = view.camdConnected ? 'connected' : 'daemon offline';
  pill.className = `pill ${view.camdConnected ? 'ok' : 'bad'}`;

  renderBanner();
  renderRollPill();

  const activeKey = document.activeElement?.dataset?.key ?? interacting;
  if (currentView === 'control') renderControl();
  else if (currentView === 'setup') renderSetup();
  // Multiview is not re-rendered on state change: replacing an <img> restarts
  // its MJPEG stream, so the feeds would flicker on every property update.
  if (activeKey) {
    const restore = document.querySelector(`[data-key="${CSS.escape(activeKey)}"]`);
    if (restore) restore.focus({ preventScroll: true });
  }
  renderTools();
}

/**
 * The banner.
 *
 * One line, always the worst thing that is true. It used to hand-roll its own
 * conditions — recording-failed, then any camera not connected — which the
 * alarm evaluator now covers along with card, battery and dropped records, so
 * the banner reads that instead of deciding for itself. The daemon being
 * unreachable still comes first and separately: with no daemon there is no
 * state to raise alarms from, and every camera would otherwise be reported
 * offline individually when the real problem is one process.
 */
function renderBanner() {
  const banner = $('#banner');
  banner.textContent = '';
  banner.classList.remove('warn');

  if (!view.camdConnected) {
    // Name the log. The panel being up means cambridge and the config are fine,
    // so the daemon either failed to start or died — and its own log is the only
    // place that says which.
    banner.textContent = 'Sony SDK camera service is offline. Network PTZ controls remain independent. '
      + (health.logDir ? `Check ${health.logDir}/camd.stdout.log` : 'Check the camd log.');
    banner.classList.add('show');
    return;
  }

  // An unprotected panel is worth saying so on every screen, not only in Setup
  // where someone has to go looking. It ranks below a live alarm: a card about
  // to fill is this minute's problem and this is this week's.
  if (!alarmSummary && authState.enabled === false && authState.warning) {
    add(banner, el('span', { text: `⚠️ ${authState.warning}` }));
    add(banner, el('button', {
      class: 'small ghost', text: 'Set a PIN',
      onclick: () => switchView('setup'),
    }));
    banner.classList.add('warn', 'show');
    return;
  }

  if (!alarmSummary) { banner.classList.remove('show'); return; }

  add(banner, el('span', { text: alarmSummary.text }));
  // Only a dropped record can be dismissed, and only because nothing else will
  // ever clear it — the camera is not going to tell us it was noticed. A card
  // alarm has no dismiss button on purpose: it goes away when the card does.
  const dropped = alarms.filter((a) => a.code === 'recordDropped');
  for (const a of dropped) {
    add(banner, el('button', {
      class: 'small ghost',
      text: `Dismiss ${a.label}`,
      onclick: () => api('POST', `/api/cameras/${encodeURIComponent(a.cameraId)}/acknowledge`),
    }));
  }
  if (alarmSummary.level !== 'critical') banner.classList.add('warn');
  banner.classList.add('show');
}

/**
 * "3 of 3 rolling" in the top bar.
 *
 * The question asked most often during a shoot, and until now answerable only
 * by reading three separate record buttons. Counts connected cameras only — an
 * offline body has its own, louder alarm, and folding it in here would turn
 * "all rolling" into a claim about a camera nobody can see.
 */
function renderRollPill() {
  const pill = $('#roll-pill');
  if (!pill) return;
  if (!roll || roll.total === 0 || roll.idle) {
    pill.style.display = 'none';
    return;
  }
  pill.style.display = '';
  pill.textContent = `${roll.rolling} of ${roll.total} rolling`;
  pill.className = `pill ${roll.all ? 'rec' : 'warn'}`;
  pill.title = roll.all
    ? 'Every connected camera is recording'
    : `Not rolling: ${roll.notRolling.map((c) => c.label).join(', ')}`;
}

function renderTools() {
  const refSel = $('#match-ref');
  const prev = refSel.value;
  refSel.textContent = '';
  for (const c of view.cameras.filter(c => c.provider !== 'network-ptz' && !c.external)) {
    refSel.append(el('option', { value: c.id, selected: c.id === prev },
      document.createTextNode(`${c.label}${c.state === 'connected' ? '' : ' (offline)'}`)));
  }
  const sceneSel = $('#scene-list');
  const prevScene = sceneSel.value;
  sceneSel.textContent = '';
  for (const s of meta.scenes ?? []) {
    sceneSel.append(el('option', { value: s, selected: s === prevScene }, document.createTextNode(s)));
  }
  const holder = $('#gang-members');
  holder.textContent = '';
  for (const c of view.cameras.filter(c => c.provider !== 'network-ptz' && !c.external)) {
    holder.append(el('div', {
      class: `chip${gangSelection.has(c.id) ? ' on' : ''}`,
      onclick: (e) => {
        gangSelection.has(c.id) ? gangSelection.delete(c.id) : gangSelection.add(c.id);
        e.currentTarget.classList.toggle('on');
      },
    }, document.createTextNode(c.label)));
  }
  $('#focus-note').textContent = meta.focusNote ?? '';
  renderPadCameras();
}

function switchView(name) {
  ptzUi.stop();
  // Leaving Multiview must stop the feeds; nothing is displaying them.
  if (currentView === 'multiview' && name !== 'multiview') stopAllFeeds();
  currentView = name;
  soloFeed = null;
  for (const b of document.querySelectorAll('nav.tabs button')) {
    b.classList.toggle('active', b.dataset.view === name);
  }
  for (const s of document.querySelectorAll('.view')) {
    s.classList.toggle('active', s.id === `view-${name}`);
  }
  if (name === 'multiview') renderMultiview();
  if (name === 'setup') refreshSetup();
  if (name === 'control') renderControl();
}

// --- wiring -----------------------------------------------------------------

for (const b of document.querySelectorAll('nav.tabs button')) {
  b.addEventListener('click', () => switchView(b.dataset.view));
}
$('#mv-refresh').addEventListener('click', renderMultiview);

// --- monitoring assists -----------------------------------------------------
// None of these restart the feeds. The draw path reads the current settings on
// every frame, so a toggle takes effect on the next one — switching a guide on
// mid-take must not blank three pictures for a moment while they reconnect.
$('#scope-mode').addEventListener('change', (e) => {
  scopeMode = e.target.value;
  saveScopePrefs();
});
$('#matte').addEventListener('change', (e) => {
  guides.matte = e.target.value;
  saveScopePrefs();
});
for (const chip of document.querySelectorAll('#guide-chips .chip')) {
  chip.addEventListener('click', () => {
    const key = chip.dataset.guide;
    guides[key] = !guides[key];
    chip.classList.toggle('on', guides[key]);
    saveScopePrefs();
  });
}

$('#scope-key').addEventListener('click', () => {
  const table = $('#scope-key-table');
  table.textContent = '';
  table.append(el('tr', {}, el('th', { text: '' }), el('th', { text: 'Range' }),
    el('th', { text: 'Means' })));
  let from = 0;
  for (const band of FALSE_COLOUR_BANDS) {
    const swatch = el('td');
    swatch.append(el('span', { class: 'swatch' }));
    swatch.firstChild.style.background = `rgb(${band.colour.join(',')})`;
    table.append(el('tr', {}, swatch,
      el('td', { text: `${from}–${band.max}%` }),
      el('td', { text: band.label })));
    from = band.max;
  }
  $('#scope-key-dialog').showModal();
});
$('#scope-key-close').addEventListener('click', () => $('#scope-key-dialog').close());

/** Puts the controls where the stored preferences say they are. */
function restoreScopeControls() {
  $('#scope-mode').value = scopeMode;
  $('#matte').value = guides.matte ?? 'off';
  for (const chip of document.querySelectorAll('#guide-chips .chip')) {
    chip.classList.toggle('on', !!guides[chip.dataset.guide]);
  }
}
restoreScopeControls();
$('#picker-close').addEventListener('click', () => $('#picker').close());
$('#adopt-cancel').addEventListener('click', () => $('#adopt-dialog').close());

$('#advanced-toggle').addEventListener('click', (e) => {
  advanced = !advanced;
  localStorage.setItem('cb.advanced', advanced ? '1' : '0');
  e.target.classList.toggle('primary', advanced);
  renderControl();
});
$('#advanced-toggle').classList.toggle('primary', advanced);

const ramp = $('#ramp');
ramp.value = String(rampMs);
ramp.addEventListener('change', () => {
  rampMs = Number(ramp.value) || 0;
  localStorage.setItem('cb.rampMs', String(rampMs));
  toast(rampMs ? `Presets will ramp over ${rampMs / 1000}s` : 'Presets will jump instantly');
});

$('#rec-all').addEventListener('click', async () => {
  const r = await api('POST', '/api/record-all', { start: true });
  const bad = (r.results ?? []).filter((x) => !x.ok);
  if (bad.length) toast(`Record FAILED on: ${bad.map((b) => b.cameraId).join(', ')}`, 'bad', 12000);
  else toast('All cameras recording');
});
$('#stop-all').addEventListener('click', async () => {
  const r = await api('POST', '/api/record-all', { start: false });
  const bad = (r.results ?? []).filter((x) => !x.ok);
  if (bad.length) toast(`Stop FAILED on: ${bad.map((b) => b.cameraId).join(', ')}`, 'bad', 12000);
  else toast('All cameras stopped');
});

$('#scene-save').addEventListener('click', async () => {
  const name = $('#scene-name').value.trim();
  if (!name) return toast('Give the scene a name first', 'warn');
  const r = await api('PUT', `/api/scenes/${encodeURIComponent(name)}`);
  if (r.ok) {
    toast(`Saved scene "${name}"` + (r.skipped?.length ? ` (skipped: ${r.skipped.join(', ')})` : ''));
    $('#scene-name').value = '';
    loadMeta();
  }
});
$('#scene-recall').addEventListener('click', async () => {
  const name = $('#scene-list').value;
  if (!name) return;
  const only = [...document.querySelectorAll('#recall-groups .chip.on')].map((c) => c.dataset.group)
    .flatMap((g) => meta.groups?.[g]?.props ?? []);
  const r = await api('POST', `/api/scenes/${encodeURIComponent(name)}`,
    { transitionMs: rampMs, only: only.length ? only : null });
  if (r.ok) toast(`Recalled "${name}"${rampMs ? ` over ${rampMs / 1000}s` : ''}`);
});
$('#scene-delete').addEventListener('click', async () => {
  const name = $('#scene-list').value;
  if (!name || !confirm(`Delete scene "${name}"?`)) return;
  await api('DELETE', `/api/scenes/${encodeURIComponent(name)}`);
  loadMeta();
});

$('#match-go').addEventListener('click', async () => {
  const reference = $('#match-ref').value;
  if (!reference) return;
  const r = await api('POST', '/api/match', { reference });
  const approx = (r.cameras ?? []).flatMap((c) => (c.results ?? []).filter((x) => x.approximated));
  if (r.ok) {
    toast(`Matched to ${reference}` + (approx.length ? ` — ${approx.length} value(s) approximated` : ''),
      approx.length ? 'warn' : 'ok', 8000);
  }
});

$('#gang-save').addEventListener('click', async () => {
  if (gangSelection.size < 2) return toast('Pick at least two cameras to link', 'warn');
  const members = {};
  for (const id of gangSelection) members[id] = { offsets: {} };
  await api('PUT', '/api/gangs/main', { members });
  toast(`Linked ${[...gangSelection].join(', ')}`);
  loadMeta();
});
$('#gang-clear').addEventListener('click', async () => {
  await api('DELETE', '/api/gangs/main');
  gangSelection.clear();
  toast('Cameras unlinked');
  loadMeta();
});

// --- access control ---------------------------------------------------------

let authState = { enabled: false, warning: null, you: { role: 'anonymous' } };

async function refreshAuth() {
  authState = await api('GET', '/api/auth/state');
  const box = $('#auth-state');
  if (box) {
    box.textContent = authState.enabled
      ? `Protected by PIN. You are signed in as ${authState.you?.role ?? 'unknown'}.`
      : (authState.warning ?? 'No PIN is set.');
    box.classList.toggle('bad', !authState.enabled);
  }
  renderBanner();
}

$('#pin-save')?.addEventListener('click', async () => {
  const pin = $('#pin-value').value;
  const role = $('#pin-role').value;
  const res = await api('POST', '/api/auth/pin', { pin, role });
  if (res.ok) {
    $('#pin-value').value = '';
    $('#pin-msg').textContent = `${role === 'admin' ? 'Admin' : 'Operator'} PIN set.`;
    toast('PIN saved');
    await refreshAuth();
  }
});

$('#sign-out')?.addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  location.replace('/login.html');
});

// The take log. Fetched on demand rather than pushed: it is read between
// setups or after a shoot, not watched, and it grows all day.
$('#takes-refresh').addEventListener('click', async () => {
  const data = await api('GET', '/api/takes');
  const table = $('#takes-table');
  table.textContent = '';
  if (!data.takes?.length) {
    table.append(el('tr', {}, el('td', { class: 'note', text: 'Nothing has been recorded yet.' })));
    return;
  }
  table.append(el('tr', {},
    el('th', { text: 'Take' }), el('th', { text: 'Started' }),
    el('th', { text: 'Length' }), el('th', { text: 'Cameras' })));

  for (const t of [...data.takes].reverse()) {
    const cams = el('td');
    for (const c of t.cameras) {
      add(cams, el('span', {
        class: c.outcome === 'ok' || c.outcome === 'rolling' ? 'pill ok' : 'pill bad',
        text: c.label,
        title: c.outcomeText,
      }));
    }
    // A camera that was in other takes but not this one is the column worth
    // having: it separates "missed take four" from "never rolled all day".
    for (const mcam of t.missing) {
      add(cams, el('span', { class: 'pill warn', text: mcam.label, title: 'did not roll on this take' }));
    }
    table.append(el('tr', {},
      el('td', { text: String(t.take) }),
      el('td', { text: new Date(t.startedAt).toLocaleTimeString() }),
      el('td', { text: t.duration }),
      cams));
  }
});

$('#adopt-confirm').addEventListener('click', async () => {
  const label = $('#adopt-label').value.trim();
  const username = $('#adopt-user').value.trim();
  const password = $('#adopt-pass').value;
  if (adoptTarget) {
    if (adoptTarget.accessAuthRequired && (!username || !password)) {
      return toast('This camera needs the username and password from its screen', 'warn', 9000);
    }
    const r = await api('POST', '/api/adopt', {
      mac: adoptTarget.mac, deviceId: adoptTarget.deviceId, model: adoptTarget.model, ip: adoptTarget.ip, label, username, password,
    });
    if (r.ok) { toast(`Added ${r.camera?.label ?? label}`); $('#adopt-dialog').close(); refreshSetup(); }
    return;
  }
  if (editTarget) {
    const r = await api('PATCH', `/api/cameras/${encodeURIComponent(editTarget.id)}/adoption`,
      { label, username, password });
    if (r.ok) { toast(`Updated ${label || editTarget.label}`); $('#adopt-dialog').close(); refreshSetup(); }
  }
});

// Recall-group chips: which parts of a scene get restored.
for (const chip of document.querySelectorAll('#recall-groups .chip')) {
  chip.addEventListener('click', () => chip.classList.toggle('on'));
}

// CamBridge runs as a macOS agent with no Dock icon, so this is the way to stop
// it. Confirmed first: it takes the cameras offline for everyone, not just this
// browser tab.
$('#quit').addEventListener('click', async () => {
  const rolling = view.cameras.filter((c) => c.status?.recording);
  const warning = rolling.length
    ? `${rolling.map((c) => c.label).join(', ')} ${rolling.length === 1 ? 'is' : 'are'} RECORDING.\n\n`
    : '';
  if (!confirm(`${warning}Quit CamBridge? This disconnects every camera and stops the control panel for everyone.`)) return;
  await api('POST', '/api/shutdown');
  document.body.innerHTML =
    '<div style="padding:40px;font:16px -apple-system,sans-serif;color:#93a1b0">' +
    'CamBridge has stopped. Open it again from Applications.</div>';
});

// --- gamepad ----------------------------------------------------------------

/** The camera a gamepad drives: the chosen one, or the first connected one. */
function padTarget() {
  const chosen = view.cameras.find((c) => c.id === padCamera && c.state === 'connected' && c.provider !== 'network-ptz' && !c.external);
  return chosen ?? view.cameras.find((c) => c.state === 'connected' && c.provider !== 'network-ptz' && !c.external) ?? null;
}

// Properties where pushing "up" should walk *down* the raw scale. Iris is the
// one that matters: up means more light, which is a lower f-number. This is the
// same rule the on-screen stepper uses, kept here so a stick and the − / +
// buttons never disagree about which way is brighter.
const PAD_INVERTED = { fNumber: true };

/** `intent` is +1 for stick up/right, in operator terms, not raw terms. */
async function padStep(propName, intent, coarse) {
  const cam = padTarget();
  const prop = cam?.properties?.[propName];
  if (!cam || !prop || !prop.writable) return;
  const direction = PAD_INVERTED[propName] ? -intent : intent;

  if (prop.options?.length) {
    const idx = prop.options.findIndex((o) => o.raw === prop.raw);
    if (idx < 0) return;
    const next = prop.options[idx + direction];
    if (!next) return;
    await setProp(cam.id, propName, next.raw);
    return;
  }
  if (prop.range) {
    const size = (prop.range.step || 1) * coarse;
    const next = Math.min(Math.max(prop.raw + direction * size, prop.range.min), prop.range.max);
    if (next !== prop.raw) await setProp(cam.id, propName, next);
  }
}

async function padAction(action) {
  const cam = padTarget();
  if (action === 'recordAll') {
    const anyRolling = view.cameras.some((c) => c.status?.recording);
    await api('POST', '/api/record-all', { start: !anyRolling });
    return;
  }
  if (!cam) return;
  if (action === 'recordToggle') {
    await doAction(cam.id, cam.status?.recording ? 'recordStop' : 'recordStart');
  } else if (action === 'autofocus') {
    await doAction(cam.id, 'autofocus');
  } else if (action === 'nextCamera' || action === 'prevCamera') {
    const live = view.cameras.filter(c => c.state === 'connected' && c.provider !== 'network-ptz' && !c.external);
    if (live.length < 2) return;
    const at = live.findIndex((c) => c.id === cam.id);
    const step = action === 'nextCamera' ? 1 : -1;
    const next = live[(at + step + live.length) % live.length];
    setPadCamera(next.id);
    toast(`Gamepad now drives ${next.label}`);
  }
}

function setPadCamera(id) {
  padCamera = id;
  localStorage.setItem('cb.padCamera', id ?? '');
  const sel = $('#pad-camera');
  if (sel) sel.value = id ?? '';
  renderControl();
}

const gamepad = createGamepadControl({
  onStep: (prop, direction, coarse) => padStep(prop, direction, coarse),
  onButton: (action) => padAction(action),
  onStatus: ({ connected, name }) => {
    $('#pad-status').textContent = connected ? name : 'No gamepad detected';
    $('#pad-toggle').disabled = !connected;
    // The header button is the only hint most people will see, so it only
    // appears once a controller is actually plugged in.
    $('#pad-open').style.display = connected ? '' : 'none';
  },
});
gamepad.start();

$('#pad-toggle').addEventListener('click', () => {
  gamepad.setEnabled(!gamepad.enabled);
  const on = gamepad.enabled;
  $('#pad-toggle').textContent = on ? 'Gamepad control is ON' : 'Gamepad control is off';
  $('#pad-toggle').classList.toggle('primary', on);
  $('#pad-open').classList.toggle('primary', on);
  toast(on ? `Gamepad drives ${padTarget()?.label ?? 'nothing yet'}` : 'Gamepad control off');
  renderControl();
});

/** Kept in step with the camera list, not just filled once when opened. */
function renderPadCameras() {
  const sel = $('#pad-camera');
  if (!sel) return;
  const target = padTarget()?.id ?? '';
  sel.textContent = '';
  for (const c of view.cameras.filter(c => c.provider !== 'network-ptz' && !c.external)) {
    sel.append(el('option', { value: c.id, selected: c.id === target },
      document.createTextNode(c.label)));
  }
}

$('#pad-open').addEventListener('click', () => {
  renderPadCameras();
  $('#pad-dialog').showModal();
});
$('#pad-camera').addEventListener('change', (e) => setPadCamera(e.target.value));
$('#pad-close').addEventListener('click', () => $('#pad-dialog').close());

async function loadMeta() {
  meta = await api('GET', '/api/presets');
  health = await api('GET', '/api/health');
  const gangs = await api('GET', '/api/gangs');
  const active = Object.entries(gangs.gangs ?? {}).filter(([, g]) => g.enabled);
  $('#gang-state').textContent = active.length
    ? `Linked: ${active.map(([, g]) => Object.keys(g.members).join(' + ')).join('; ')}`
    : 'Not linked.';
  renderTools();
}

// SSE. EventSource reconnects by itself, which is what a booth iPad waking from
// sleep needs.
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type !== 'state') return;
      const changed =
        msg.view.cameras.length !== view.cameras.length ||
        msg.view.cameras.some((c, i) => c.id !== view.cameras[i]?.id || c.state !== view.cameras[i]?.state);
      view = msg.view;
      alarms = msg.alarms ?? [];
      alarmsByCamera = msg.alarmsByCamera ?? {};
      alarmSummary = msg.alarmSummary ?? null;
      roll = msg.roll ?? null;
      undoState = msg.undo ?? {};
      render();
      if (currentView === 'multiview' && changed) renderMultiview();
    } catch { /* ignore malformed frame */ }
  };
  es.onerror = () => {
    $('#camd-pill').textContent = 'reconnecting…';
    $('#camd-pill').className = 'pill warn';
  };
}

loadMeta();
refreshAuth();
connectEvents();
setInterval(() => { if (currentView === 'setup') refreshSetup(); }, 5000);
