import { createExternalUi } from './external.js';
import { createGamepadControl } from './gamepad.js';
import { createPtz } from './ptz.js';
import { createBus } from './bus.js';
import { createBulkAdd } from './bulkadd.js';
import { applyPatch } from './patch.js';
import {
  buildFalseColourLut, measureThenOverlay,
  drawHistogram, drawGuides, drawClipReadout, FALSE_COLOUR_BANDS,
  containRect, pointToImage,
} from './scopes.js';
import {
  tileModel, recordActionFor, feedHealth, recordAllOutcome, stepOption, gamepadTarget, gamepadCandidates,
} from './panel-logic.js';

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
  // A clickable div or span (the value readouts, recall-group chips) is
  // otherwise unreachable from the keyboard. Give it a button's semantics:
  // focusable, announced as a button, and activated by Enter or Space.
  const native = ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'CANVAS', 'LABEL', 'OPTION'];
  if (typeof attrs.onclick === 'function' && !native.includes(n.tagName)) {
    if (!n.hasAttribute('role')) n.setAttribute('role', 'button');
    if (!n.hasAttribute('tabindex')) n.tabIndex = 0;
    n.addEventListener('keydown', (e) => {
      if (e.target !== n || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      n.click();
    });
  }
  return n;
};
// Node.append() stringifies null into a literal "null" text node. Every control
// builder below returns null when the camera does not expose that property, so
// appending them has to go through here.
const add = (parent, ...kids) => { for (const k of kids) if (k) parent.append(k); return parent; };
// Writes that happen on every push go through these, so a push that changes
// nothing a node shows leaves the node alone. With dozens of cameras a push
// arrives several times a second, and rewriting the same text each time is
// work the browser does for nothing (and noise for anyone measuring).
const setText = (n, t) => { if (n && n.textContent !== t) n.textContent = t; };
const setShown = (n, on) => { const v = on ? '' : 'none'; if (n && n.style.display !== v) n.style.display = v; };
const setClass = (n, c) => { if (n && n.className !== c) n.className = c; };

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
    identityChanged: ['bad', 'identity changed'],
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
      // An off-list current value is refused, as the gamepad and Companion
      // do; it used to step from the first entry, an unrelated setting.
      const next = stepOption(options, prop.raw, step);
      if (next) await setProp(cam.id, propName, next.raw);
      else if (!options.some((o) => o.raw === prop.raw)) {
        toast(`${name} is at a value this camera does not list; pick one from the list`, 'warn');
      }
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
  if (cam.state === 'identityChanged') {
    // The camera presented a different SSH host key than the one pinned at
    // pairing. Credentials were not sent. Reconnecting cannot help; only a
    // deliberate re-pair after comparing fingerprints can.
    body.append(el('div', { class: 'note bad', role: 'alert',
      text: 'This camera\'s identity changed, so its password was not sent. If the camera was reset or replaced, '
        + 'compare the fingerprint below with its Access Authen. Info screen before re-pairing. '
        + 'If it was not, another device may be answering for it.' }));
    body.append(el('div', { class: 'note', text: `Pinned: ${cam.fingerprint ?? '—'}` }));
    body.append(el('div', { class: 'note', text: `Presented now: ${cam.observedFingerprint || '(no key; authentication turned off?)'}` }));
    body.append(el('button', { onclick: async () => {
      const shown = cam.observedFingerprint || '(none)';
      if (!confirm(`Re-pair ${cam.label}?\n\nOnly continue if the camera's Access Authen. Info screen shows:\n${shown}`)) return;
      const r = await api('POST', `/api/cameras/${encodeURIComponent(cam.id)}/adoption/repin`, { fingerprint: cam.observedFingerprint ?? '' });
      if (r.ok) toast(`Re-paired ${cam.label}`);
    } }, document.createTextNode('Re-pair after checking…')));
    card.append(body);
    return card;
  }
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

/**
 * The PTZ side of the panel: Operate cards, the settings sheet, presets,
 * add-by-IP and the SKAARHOJ card. Kept in its own module because none of it
 * applies to a Sony body, and handed this file's helpers rather than
 * importing them so app.js stays the one place that owns the page.
 */
const ptzUi = createPtz({
  el, add, api, toast, stateBadge, tallyBadge,
  controlActive: () => currentView === 'control',
  switchView: (name) => switchView(name),
  refreshSetup: () => refreshSetup(),
  undo: (id) => undoState[id] ?? null,
  padDrives: (id) => !!gamepad?.enabled && padTarget()?.id === id,
  presetsChanged: () => { bus.presetsChanged(); if (currentView === 'control') renderControl(); },
});

/**
 * The camera bus and the selected-camera layout (bus.js), and the group
 * filter shared by Control, Multiview and the Setup list.
 */
const bus = createBus({
  el, add,
  keysActive: () => currentView === 'control'
    && bus.layoutFor(view.cameras.filter((c) => c.kind === 'ptz').length) === 'select',
  endHoldsFor: (id) => ptzUi.endHoldsFor(id),
  presetName: (id, n) => ptzUi.presetName(id, n),
  onChange: (why) => {
    if (currentView === 'control') renderControl();
    if (why === 'group') {
      if (currentView === 'multiview') syncMultiview();
      if (currentView === 'setup') renderSetup();
    }
  },
});

const bulkAdd = createBulkAdd({
  el, api, toast,
  isActive: () => currentView === 'setup',
  refreshSetup: () => refreshSetup(),
});

/** Last-built Sony card per camera, with what it was built from. */
const cineCards = new Map();

/**
 * What a Sony card shows, as one string. A card is rebuilt only when this
 * changes: PTZ heads push position several times a second while they move,
 * and rebuilding every card on each push would drop a slider mid-drag and
 * close an open "More controls" on every camera in the room.
 */
function cineSig(cam) {
  return JSON.stringify([cam, undoState[cam.id] ?? null, alarmsByCamera[cam.id] ?? null,
    advanced, meta.presets?.[cam.id] ?? null, padCamera, !!gamepad?.enabled]);
}

/** A Sony (or stills/cinema) card, rebuilt only when what it shows changed (see cineSig). */
function cineNode(cam) {
  const sig = cineSig(cam);
  let c = cineCards.get(cam.id);
  if (!c || c.sig !== sig) {
    // A stills or cinema camera's control being edited is not replaced under
    // the operator's cursor; it catches up once they leave it.
    const editing = document.activeElement;
    if (c && cam.external && c.node.contains(editing)
        && editing.matches('.external-control input, .external-control select')) return c.node;
    // Keep whichever disclosure the operator opened or closed by hand.
    const wasOpen = c?.node.querySelector('details.more')?.open;
    c = { sig, node: cam.external ? externalUi.card(cam) : cameraCard(cam) };
    const more = c.node.querySelector('details.more');
    if (more && wasOpen !== undefined) more.open = wasOpen;
    cineCards.set(cam.id, c);
  }
  return c.node;
}

/**
 * The Control view.
 *
 * Two layouts for PTZ heads (bus.js): every head's Operate card, which is
 * right for a small room, or the camera bus with a full card only for the
 * selected head(s), which is the only thing that works for dozens. Auto picks
 * by head count; the operator can override it.
 *
 * Cards whose camera did not change are skipped by identity (ptzUi.card), and
 * cards no longer shown are taken down (ptzUi.keepOnly) — which ends any
 * press on them, stops their picture and lets their watch lease lapse.
 */
function renderControl() {
  if (ptzUi.active) return;
  const grid = $('#grid');
  const nodes = [];
  const ptzCams = view.cameras.filter((c) => c.kind === 'ptz');
  const layout = bus.layoutFor(ptzCams.length);
  const select = layout === 'select';
  bus.renderBar($('#ctl-bar'), ptzCams, view.cameras, layout);
  const shown = bus.filter(view.cameras);
  const keep = new Set();
  if (!view.cameras.length) {
    const noDaemon = view.camdUsed !== false && !view.camdConnected;
    nodes.push(el('section', { class: 'cam' }, el('div', { class: 'body' },
      el('div', { class: 'note', text: noDaemon
        ? 'The camera daemon is not running, so there is nothing to control yet.'
        : 'No cameras added yet.' }),
      noDaemon
        ? el('div', { class: 'mono', text: './scripts/start.sh' })
        : el('button', { class: 'primary', onclick: () => switchView('setup') },
            document.createTextNode('Add a camera')))));
  }
  if (select) {
    const shownPtz = shown.filter((c) => c.kind === 'ptz');
    const ids = bus.resolve(ptzCams, shownPtz);
    bus.renderBus($('#bus'), shownPtz, ids);
    ids.forEach((id, i) => {
      const node = ptzUi.card(ptzCams.find((c) => c.id === id));
      // Which panel is which, when riding more than one: the bus names them
      // A–D, and the active one is what a tap or a key replaces.
      bus.setAttr(node, 'data-slot', ids.length > 1 ? 'ABCD'[i] : null);
      bus.setAttr(node, 'data-active', ids.length > 1 && i === bus.active ? '1' : null);
      keep.add(id);
      nodes.push(node);
    });
    for (const cam of shown) if (cam.kind !== 'ptz') nodes.push(cineNode(cam));
  } else {
    bus.renderBus(null, [], []);
    for (const cam of shown) {
      if (cam.kind !== 'ptz') { nodes.push(cineNode(cam)); continue; }
      const node = ptzUi.card(cam);
      bus.setAttr(node, 'data-slot', null);
      bus.setAttr(node, 'data-active', null);
      keep.add(cam.id);
      nodes.push(node);
    }
  }
  // Before the grid is rearranged: a card leaving the screen ends its presses
  // (sending stop) and stops polling its picture.
  ptzUi.keepOnly(keep);
  const busBox = $('#bus');
  if (busBox.hidden === select) busBox.hidden = !select;
  $('#ctl-main').classList.toggle('select', select);
  grid.classList.toggle('panels', select);
  bus.setAttr(grid, 'data-up', select ? String(keep.size) : null);
  for (const id of [...cineCards.keys()]) {
    if (!view.cameras.some((cam) => cam.id === id && cam.kind !== 'ptz')) cineCards.delete(id);
  }
  // In place, never by clearing the grid: a PTZ card being held must not be
  // detached even for a moment, because detaching it ends the pointer capture
  // — which stops the head under the operator's thumb.
  nodes.forEach((n, i) => { if (grid.children[i] !== n) grid.insertBefore(n, grid.children[i] ?? null); });
  while (grid.children.length > nodes.length) grid.lastElementChild.remove();
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
//
// The pause between frames scales with how many tiles are polling, so that
// the whole wall asks for about the same number of frames a second however
// many cameras are on it: FEED_BUDGET_FPS shared between the tiles on screen,
// but never faster than FEED_MIN_MS for one tile nor slower than FEED_MAX_MS.
//
//    tiles on screen    each tile every    whole wall
//          1-4             100 ms           <= 40 frames/s
//           12             300 ms              40 frames/s
//           48            1200 ms              40 frames/s
//
// Forty a second is what four tiles at ten frames a second always cost, so a
// big venue costs the server and the cameras no more than a small one. Tiles
// scrolled out of view, and every tile while the tab is hidden, ask for
// nothing and do not count towards the share.
const FEED_MIN_MS = 100;
const FEED_MAX_MS = 2000;
const FEED_BUDGET_FPS = 40;
/** How often a paused tile checks whether it is back on screen. */
const FEED_PAUSED_MS = 400;

/** cameraId -> multiview tile controller. Tiles persist across pushes. */
const mvTiles = new Map();

const mvIo = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((list) => {
    for (const e of list) {
      const t = mvTiles.get(e.target.dataset.id);
      if (t) t.visible = e.isIntersecting;
    }
  }, { rootMargin: '120px 0px' })
  : null;

function pollingTiles() {
  let n = 0;
  for (const t of mvTiles.values()) if (t.live && t.visible) n += 1;
  return n;
}

function feedIntervalMs() {
  const n = Math.max(1, pollingTiles());
  return Math.min(FEED_MAX_MS, Math.max(FEED_MIN_MS, Math.round((1000 * n) / FEED_BUDGET_FPS)));
}

function dropTile(t) {
  t.stop();
  mvIo?.unobserve(t.node);
  t.node.remove();
  mvTiles.delete(t.id);
}

function stopAllFeeds() {
  for (const t of [...mvTiles.values()]) dropTile(t);
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
function startFeed(cam, canvas, onFailure, tile, onRecover = () => {}) {
  let stopped = false;
  const health = feedHealth(10);
  let frame = 0;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let lastHist = null;
  let lastClip = null;

  const tick = async () => {
    if (stopped) return;
    // Off screen, or the tab hidden: ask for nothing, and look again shortly.
    if (!tile.visible || document.visibilityState === 'hidden') {
      setTimeout(tick, FEED_PAUSED_MS);
      return;
    }
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
        // A feed that was hidden after repeated failures comes back by itself
        // once frames flow again, rather than waiting for Restart feeds.
        if (health.ok() === 'show') onRecover();
      }
    } catch (err) {
      // A camera reconnecting should not kill the tile; several in a row means
      // it is genuinely not producing.
      if (health.fail() === 'hide') onFailure(err);
    }
    if (!stopped) setTimeout(tick, feedIntervalMs());
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
    // Measured from the camera's pixels BEFORE any overlay recolours them
    // (audit CS2); the overlay only changes what is drawn.
    const measure = frame % SCOPE_EVERY_N === 0;
    const r = measureThenOverlay(image.data, {
      mode: scopeMode, measure, histogram: guides.histogram, clipReadout: guides.clipReadout, lut: falseColourLut,
    });
    if (r.overlaid) ctx.putImageData(image, 0, 0);
    if (measure) {
      hist = guides.histogram ? r.hist : null;
      clip = guides.clipReadout ? r.clip : null;
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

/** What decides a tile's structure; anything else is updated in place. */
const tileKey = (cam) => `${cam.state === 'connected'}|${cam.kind}|${soloFeed === cam.id}`;

function feedClass(cam) {
  const rec = cam.status?.recording;
  const tallyClass = cam.tally?.program ? ' pgm' : cam.tally?.preview ? ' pvw' : '';
  return `feed${rec ? ' recording' : ''}${tallyClass}`;
}

/**
 * One multiview tile. Built once per camera and connection state; tally,
 * recording and the overlay text are updated in place, so a push never
 * restarts a picture.
 */
function feedTile(cam) {
  const tile = el('div', { class: feedClass(cam), 'data-id': cam.id });
  const t = { id: cam.id, node: tile, cam, key: tileKey(cam), live: cam.state === 'connected',
    visible: !mvIo, stop: () => {}, update: null };

  const isPtz = cam.kind === 'ptz';
  if (cam.state === 'connected') {
    const img = el('canvas', { class: 'feedcanvas',
      title: isPtz ? (cam.capabilities?.pointToCentre ? 'Tap to aim the camera here' : '') : 'Click to focus here',
      role: 'img', 'aria-label': `${cam.label} live view` });
    const reason = el('div', { class: 'note', text: 'Waiting for the first frame…' });
    const fallback = el('div', { class: 'placeholder' },
      el('div', { text: 'No live view from this camera' }), reason);
    fallback.style.display = 'none';

    t.stop = startFeed(cam, img, async () => {
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
    }, t, () => {
      // Frames are flowing again: the picture comes back by itself.
      img.style.display = '';
      fallback.style.display = 'none';
    });

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
      // A PTZ head has no focus point to set; the useful thing a tap can mean
      // is "put this in the middle of the shot".
      if (isPtz) await ptzUi.aim(view.cameras.find((c) => c.id === cam.id) ?? cam, point);
      else await tapFocus(cam, point);
    });
    tile.append(img, fallback);
  } else {
    tile.append(el('div', { class: 'placeholder' },
      el('div', { text: cam.state }), el('div', { class: 'note', text: cam.detail ?? '' })));
  }

  const overlay = el('div', { class: 'overlay' });
  const tools = el('div', { class: 'tools' });
  tile.append(overlay, tools);
  const enlarge = () => { soloFeed = soloFeed === cam.id ? null : cam.id; syncMultiview(); };

  t.update = (c) => {
    t.cam = c;
    setClass(tile, feedClass(c));
    const rec = !!c.status?.recording;
    const note = isPtz ? (c.model ?? '') : (c.properties?.fNumber?.label ?? '');
    const sig = JSON.stringify([rec, c.label, c.tally?.program, c.tally?.preview, note]);
    if (overlay.dataset.sig !== sig) {
      overlay.dataset.sig = sig;
      overlay.textContent = '';
      add(overlay,
        el('span', { class: `recdot${rec ? ' on' : ''}` }),
        el('span', { text: c.label || c.id }),
        tallyBadge(c),
        el('span', { class: 'spacer' }),
        el('span', { class: 'note', text: note }));
    }
    const toolSig = JSON.stringify([rec, c.capabilities?.record?.available, soloFeed === c.id]);
    if (tools.dataset.sig !== toolSig) {
      tools.dataset.sig = toolSig;
      tools.textContent = '';
      const big = el('button', { class: 'small', onclick: enlarge },
        document.createTextNode(soloFeed === c.id ? 'Show all' : 'Enlarge'));
      if (isPtz) {
        // Not a recorder and no AF point: the useful extras live on its Operate card.
        tools.append(el('button', { class: 'small', onclick: () => ptzUi.openSettings(c.id) },
          document.createTextNode('Settings')), big);
      } else {
        tools.append(
          el('button', { class: 'small', onclick: () => doAction(c.id, 'autofocus') },
            document.createTextNode('AF')),
          el('button', {
            class: rec ? 'small' : 'small danger',
            disabled: c.capabilities?.record?.available === false,
            title: c.capabilities?.record?.reason || (rec ? 'Stop recording' : 'Start recording'),
            'aria-label': `${rec ? 'Stop recording' : 'Start recording'}: ${c.label || c.id}`,
            // What the camera is doing when the button is pressed, not when it
            // was drawn (audit CS1).
            onclick: () => {
              const action = recordActionFor(c.id, () => view.cameras);
              if (action) doAction(c.id, action);
            },
          }, document.createTextNode(rec ? '■' : '●')),
          big);
      }
    }
  };
  t.update(cam);
  return t;
}

/**
 * Brings the multiview in step with the camera list, the group filter and
 * Enlarge. Only tiles whose camera changed are touched, and only a tile whose
 * camera connected or dropped is rebuilt; every other push leaves the
 * pictures running.
 */
function syncMultiview() {
  const grid = $('#mvgrid');
  bus.renderChips($('#mv-groups'), view.cameras);
  // Stills and cinema bodies give no live view here; their cards are on Control.
  const pictured = view.cameras.filter((c) => !c.external);
  const cams = soloFeed
    ? pictured.filter((c) => c.id === soloFeed)
    : bus.filter(pictured);
  setClass(grid, soloFeed ? 'solo' : cams.length > 9 ? 'dense' : '');
  const none = grid.querySelector(':scope > .mv-none');
  if (!cams.length) {
    stopAllFeeds();
    if (!none) grid.append(el('div', { class: 'note mv-none', style: 'padding:12px', text: 'No cameras to show.' }));
    return;
  }
  none?.remove();
  const want = new Set(cams.map((c) => c.id));
  for (const t of [...mvTiles.values()]) if (!want.has(t.id)) dropTile(t);
  cams.forEach((cam, i) => {
    let t = mvTiles.get(cam.id);
    if (t && t.key !== tileKey(cam)) { dropTile(t); t = null; }
    if (!t) {
      t = feedTile(cam);
      mvTiles.set(cam.id, t);
      mvIo?.observe(t.node);
    } else if (t.cam !== cam) t.update(cam);
    if (grid.children[i] !== t.node) grid.insertBefore(t.node, grid.children[i] ?? null);
  });
}

/** Restart feeds: every tile rebuilt from scratch. */
function renderMultiview() {
  stopAllFeeds();
  syncMultiview();
}

let setupSig = null;

function renderSetup() {
  // Only when something Setup shows has changed. A moving PTZ head pushes
  // state several times a second, and rebuilding the tables each time can
  // swallow a tap on Edit or Remove between press and release.
  const filterText = ($('#cam-filter')?.value ?? '').trim().toLowerCase();
  const sig = JSON.stringify([discovery, health.configPath, view.camdUsed, filterText, reordering,
    bus.filter(view.cameras).length,
    view.cameras.map((c) => [c.id, c.kind, c.label, c.model, c.vendor, c.ip, c.group, c.state, c.detail, c.reconnectAttempts])]);
  if (sig === setupSig) return;
  setupSig = sig;
  renderGroupList();
  externalUi.renderList(view.cameras);
  // A venue with only PTZ heads runs no daemon and has no Sony bodies to
  // discover; a section that can only ever say "nothing found" is noise.
  $('#discover-card').hidden = view.camdUsed === false || discovery.camdUsed === false;
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

  // A long list gets a search box and the group chips; the order shown is
  // the operator's order, which is also the bus's and Multiview's.
  const long = view.cameras.length > 8;
  $('#cam-filter-row').hidden = !long;
  bus.renderChips($('#setup-groups'), view.cameras);
  const matches = (c) => !filterText || [c.label, c.ip, c.model, c.vendor, c.group]
    .some((v) => String(v ?? '').toLowerCase().includes(filterText));
  // Stills and cinema cameras are listed, and removed, on their own card.
  const listed = (long ? bus.filter(view.cameras) : view.cameras)
    .filter((c) => !c.external && matches(c));
  const anyGroup = view.cameras.some((c) => c.group);

  const at = $('#adopted-table');
  const focusKey = document.activeElement?.dataset?.move;
  at.textContent = '';
  at.append(el('tr', {}, el('th', { text: 'Order', class: 'ordercol' }), el('th', { text: 'Name' }),
    anyGroup ? el('th', { text: 'Group' }) : null,
    el('th', { text: 'Model', class: 'col-model' }), el('th', { text: 'State' }), el('th', { text: '' })));
  const cols = anyGroup ? 6 : 5;
  if (!view.cameras.length) {
    at.append(el('tr', {}, el('td', { colspan: String(cols), class: 'note', text: 'Nothing added yet.' })));
  } else if (!listed.length) {
    at.append(el('tr', {}, el('td', { colspan: String(cols), class: 'note', text: 'No camera matches that.' })));
  }
  listed.forEach((cam, i) => {
    const arrow = (dir, text, label) => el('button', {
      class: 'small ghost', text, 'aria-label': `${label} ${cam.label}`, title: label,
      'data-move': `${cam.id}:${dir}`,
      disabled: reordering || (dir < 0 ? i === 0 : i === listed.length - 1),
      onclick: () => moveCamera(cam.id, dir, listed),
    });
    at.append(el('tr', {},
      el('td', { class: 'ordercol' }, el('div', { class: 'line nowrap' },
        arrow(-1, '\u25b2', 'Move up'), arrow(1, '\u25bc', 'Move down'))),
      el('td', { text: cam.label }),
      anyGroup ? el('td', {}, cam.group ? el('span', { class: 'pill', text: cam.group }) : null) : null,
      el('td', { class: 'note col-model', text: cam.kind === 'ptz'
        ? `${cam.model || cam.vendor || 'PTZ'} · ${cam.ip || '—'}`
        : (cam.model || '—') }),
      el('td', {}, stateBadge(cam)),
      el('td', {}, el('div', { class: 'line nowrap' },
        el('button', { class: 'small', onclick: () => openEdit(cam) }, document.createTextNode('Edit')),
        el('button', {
          class: 'small', onclick: async () => {
            if (!confirm(`Remove "${cam.label}"? The camera itself is not changed.`)) return;
            const r = await api('DELETE', `/api/cameras/${encodeURIComponent(cam.id)}/adoption`);
            if (r.ok) { toast(`Removed ${cam.label}`); refreshSetup(); }
          },
        }, document.createTextNode('Remove'))))));
  });
  // Keep a keyboard user on the arrow they pressed, which the rebuild replaced.
  if (focusKey) at.querySelector(`[data-move="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

/** Group names for the group fields' suggestions. */
function renderGroupList() {
  const dl = $('#group-list');
  if (!dl) return;
  const groups = [...new Set(view.cameras.map((c) => c.group).filter(Boolean))];
  const sig = JSON.stringify(groups);
  if (dl.dataset.sig === sig) return;
  dl.dataset.sig = sig;
  dl.textContent = '';
  for (const g of groups) dl.append(el('option', { value: g }));
}

let reordering = false;

/**
 * Moves a camera one place up or down among the cameras listed, and saves
 * the whole order. Relative to what is listed, so with a group or search
 * filter on, "up" means past the camera above it on screen.
 */
async function moveCamera(id, dir, listed) {
  const i = listed.findIndex((c) => c.id === id);
  const other = listed[i + dir];
  if (!other || reordering) return;
  const ids = view.cameras.map((c) => c.id).filter((x) => x !== id);
  ids.splice(ids.indexOf(other.id) + (dir > 0 ? 1 : 0), 0, id);
  reordering = true;
  renderSetup();
  const r = await api('PUT', '/api/cameras/order', { ids }).finally(() => { reordering = false; });
  if (r.httpOk && Array.isArray(r.order)) {
    // Put the list in the saved order now rather than wait for the push, so a
    // second press straight after the first moves from where this one left it.
    applyOrder(r.order);
  }
  renderSetup();
}

/** Reorders the cameras this page holds, keeping every camera object as it is. */
function applyOrder(order) {
  const byId = new Map(view.cameras.map((c) => [c.id, c]));
  const next = order.map((id) => byId.get(id)).filter(Boolean);
  for (const c of view.cameras) if (!order.includes(c.id)) next.push(c);
  view = { ...view, cameras: next };
  if (frame) frame = { ...frame, view };
  ptzUi.onView(view);
  render();
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
  setDialogKind(false);
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

/** The dialog serves both kinds; a PTZ head is reached by address and has no Sony menus. */
function setDialogKind(ptz, edit = false) {
  for (const n of document.querySelectorAll('#adopt-dialog .ptz-only')) n.hidden = !ptz;
  for (const n of document.querySelectorAll('#adopt-dialog .sony-only')) n.hidden = ptz;
  for (const n of document.querySelectorAll('#adopt-dialog .edit-only')) n.hidden = !edit;
}

function openEdit(cam) {
  editTarget = cam; adoptTarget = null;
  const ptz = cam.kind === 'ptz';
  setDialogKind(ptz, true);
  $('#adopt-title').textContent = `Edit ${cam.label}`;
  $('#adopt-group').value = cam.group ?? '';
  $('#adopt-sub').textContent = ptz
    ? `${cam.model || cam.vendor || 'PTZ camera'} · ${cam.ip || 'unknown address'}`
    : `${cam.transport || (cam.ip ? 'Network' : 'USB / SDK')} · ${cam.ip || cam.mac || 'Direct camera connection'}`;
  $('#adopt-label').value = cam.label ?? '';
  $('#adopt-ip').value = ptz ? (cam.ip ?? '') : '';
  $('#adopt-user').value = ''; $('#adopt-pass').value = '';
  // Credentials are never sent to the browser, so blank means "leave alone".
  $('#adopt-user').placeholder = 'leave blank to keep current';
  $('#adopt-pass').placeholder = 'leave blank to keep current';
  setAuthVisible(ptz || needsAuthFor(cam));
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
  bulkAdd.resume();
  await externalUi.setup();
  discovery = await api('GET', '/api/discovered');
  if (!portfolio) {
    const result = await api('GET', '/api/camera-support');
    if (Array.isArray(result.models)) { portfolio = result; renderPortfolio(); }
  }
  renderSetup();
  ptzUi.refreshSkaarhoj($);
}

// --- shared -----------------------------------------------------------------

function render() {
  const pill = $('#camd-pill');
  // A PTZ-only venue runs no daemon on purpose. A permanent "daemon offline"
  // there would be the panel crying wolf, so the pill is simply not shown.
  setShown(pill, view.camdUsed !== false);
  setText(pill, view.camdConnected ? 'connected' : 'daemon offline');
  setClass(pill, `pill ${view.camdConnected ? 'ok' : 'bad'}`);

  // STOP ALL whenever there is a head to stop. Record all / Stop all only
  // when there is something that records: PTZ heads are not recorders, and a
  // record button that does nothing at a PTZ-only venue invites the wrong press.
  const anyPtz = view.cameras.some((c) => c.kind === 'ptz');
  const anySony = view.cameras.some((c) => c.kind !== 'ptz' && !c.external);
  const anyRecorder = anySony || view.cameras.some((c) => c.external && c.provider === 'blackmagic-rest');
  // With no cameras yet, everything shows: a fresh install is not a PTZ venue.
  const empty = view.cameras.length === 0;
  setShown($('#ptz-stop-all'), anyPtz);
  setShown($('#rec-all'), empty || anyRecorder);
  setShown($('#stop-all'), empty || anyRecorder);
  setShown($('#advanced-toggle'), empty || anySony);
  // Scenes, match and link capture Sony exposure and colour; with no Sony
  // body there is nothing for them to capture, and a drawer of controls that
  // cannot do anything is a drawer someone opens mid-shoot to find out.
  setShown(document.querySelector('details.tools'), empty || anySony);

  renderBanner();
  renderRollPill();

  const activeKey = document.activeElement?.dataset?.key ?? interacting;
  if (currentView === 'control') renderControl();
  else if (currentView === 'setup') renderSetup();
  // Multiview tiles are updated in place (syncMultiview, from adopt): a push
  // never restarts a picture.
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
let bannerSig = null;

function renderBanner() {
  const banner = $('#banner');
  // Every push carries the alarms afresh; the banner is redrawn only when
  // what it would say is different.
  const sig = JSON.stringify([view.camdUsed ?? health.camdUsed, view.camdConnected, health.logDir,
    alarmSummary, authState.enabled, authState.warning,
    alarms.filter((a) => a.code === 'recordDropped').map((a) => [a.cameraId, a.label])]);
  if (sig === bannerSig) return;
  bannerSig = sig;
  banner.textContent = '';
  banner.classList.remove('warn');

  // Never at a venue that runs without camd: there is no daemon to be missing.
  const camdUsed = view.camdUsed ?? health.camdUsed;
  if (camdUsed !== false && !view.camdConnected) {
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
    setShown(pill, false);
    return;
  }
  setShown(pill, true);
  setText(pill, `${roll.rolling} of ${roll.total} rolling`);
  setClass(pill, `pill ${roll.all ? 'rec' : 'warn'}`);
  const title = roll.all
    ? 'Every connected camera is recording'
    : `Not rolling: ${roll.notRolling.map((c) => c.label).join(', ')}`;
  if (pill.title !== title) pill.title = title;
}

let toolsSig = null;

function renderTools() {
  // Rebuilt only when what it lists changes. PTZ position arrives several
  // times a second, and replacing a <select>'s options closes it on an iPad.
  const sig = JSON.stringify([view.cameras.map((c) => [c.id, c.label, c.state]),
    meta.scenes, meta.focusNote, [...gangSelection], padCamera]);
  if (sig === toolsSig) return;
  toolsSig = sig;
  const refSel = $('#match-ref');
  const prev = refSel.value;
  refSel.textContent = '';
  for (const c of view.cameras.filter((c) => c.kind !== 'ptz' && !c.external)) {
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
  for (const c of view.cameras.filter((c) => c.kind !== 'ptz' && !c.external)) {
    holder.append(el('button', {
      type: 'button',
      class: `chip${gangSelection.has(c.id) ? ' on' : ''}`,
      'aria-pressed': String(gangSelection.has(c.id)),
      onclick: (e) => {
        gangSelection.has(c.id) ? gangSelection.delete(c.id) : gangSelection.add(c.id);
        e.currentTarget.classList.toggle('on');
        e.currentTarget.setAttribute('aria-pressed', String(gangSelection.has(c.id)));
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
  if (name === 'setup') { setupSig = null; refreshSetup(); }
  if (name === 'control') renderControl();
}

// --- wiring -----------------------------------------------------------------

for (const b of document.querySelectorAll('nav.tabs button')) {
  b.addEventListener('click', () => switchView(b.dataset.view));
}
$('#mv-refresh').addEventListener('click', renderMultiview);
$('#cam-filter')?.addEventListener('input', () => renderSetup());

// With more than one panel up, a touch anywhere on a panel makes it the one
// the bus and the number keys act on. Capture phase, so it is decided before
// the panel's own controls see the press; nothing is detached by it.
$('#grid').addEventListener('pointerdown', (e) => {
  const slot = e.target.closest?.('.ptzcam[data-slot]')?.dataset.slot;
  if (slot) bus.setActive('ABCD'.indexOf(slot));
}, true);

// The bus sticks below the header, whose height changes as it wraps.
{
  const top = $('#top');
  const setHdr = () => document.documentElement.style.setProperty('--hdr', `${top.offsetHeight}px`);
  setHdr();
  if (typeof ResizeObserver === 'function') new ResizeObserver(setHdr).observe(top);
}

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
    chip.setAttribute('aria-pressed', String(!!guides[key]));
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
    chip.setAttribute('aria-pressed', String(!!guides[chip.dataset.guide]));
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

// Success only when the server answered, at least one camera took part and
// every one confirmed; an empty or failed result is never "all recording".
for (const [id, start] of [['#rec-all', true], ['#stop-all', false]]) {
  $(id).addEventListener('click', async () => {
    const r = await api('POST', '/api/record-all', { start }, { quiet: true });
    const outcome = recordAllOutcome(r, start);
    toast(outcome.message, outcome.level, outcome.level === 'ok' ? undefined : 12000);
  });
}
// The PTZ panic button. Separate from "Stop all", which stops recording: one
// is about cards and one is about heads, and they must never be confused.
$('#ptz-stop-all').addEventListener('click', () => ptzUi.stopAll());
ptzUi.wireSetup($);
bulkAdd.wire($);

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
  const r = await api('PUT', '/api/gangs/main', { members });
  if (r.ok) toast(`Linked ${[...gangSelection].join(', ')}`);
  loadMeta();
});
$('#gang-clear').addEventListener('click', async () => {
  const r = await api('DELETE', '/api/gangs/main');
  if (r.ok) {
    gangSelection.clear();
    toast('Cameras unlinked');
  }
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
    const body = { label, username, password };
    // A PTZ head is reached by address, so its address is editable here.
    const ip = $('#adopt-ip').value.trim();
    if (editTarget.kind === 'ptz' && ip && ip !== editTarget.ip) body.ip = ip;
    // An empty group takes the camera out of its group.
    const group = $('#adopt-group').value.trim();
    if (group !== (editTarget.group ?? '')) body.group = group;
    const r = await api('PATCH', `/api/cameras/${encodeURIComponent(editTarget.id)}/adoption`, body);
    if (r.ok) { toast(`Updated ${label || editTarget.label}`); $('#adopt-dialog').close(); refreshSetup(); }
  }
});

// Recall-group chips: which parts of a scene get restored.
for (const chip of document.querySelectorAll('#recall-groups .chip')) {
  chip.addEventListener('click', () => chip.setAttribute('aria-pressed', String(chip.classList.toggle('on'))));
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

/**
 * The camera a gamepad drives: only the one the operator chose, while it is
 * connected. Losing it drives nothing until someone chooses again (it used to
 * fall through silently to the first connected body).
 */
function padTarget() {
  // In the camera-bus layout the gamepad drives the selected head, like the
  // on-screen joystick, a Stream Deck page and the SKAARHOJ panel do: one
  // selection, every surface. The small-venue card layout keeps its own pick.
  const ptzCount = view.cameras.filter((c) => c.kind === 'ptz').length;
  if (ptzCount && bus.layoutFor(ptzCount) === 'select') {
    const sel = view.cameras.find((c) => c.id === bus.selectedId && c.state === 'connected');
    if (sel) return sel;
  }
  // The camera chosen for the pad, while it is connected. Losing it drives
  // nothing until someone chooses again — it never falls through to another
  // body (audit, 2026-09-23).
  return gamepadTarget(padCamera, view.cameras);
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
  if (!cam && (action === 'nextCamera' || action === 'prevCamera')) {
    // Choosing with the pad's own buttons is a deliberate reselection.
    const live = gamepadCandidates(view.cameras);
    if (!live.length) return;
    const next = action === 'nextCamera' ? live[0] : live[live.length - 1];
    setPadCamera(next.id);
    toast(`Gamepad now drives ${next.label}`);
    return;
  }
  if (!cam) {
    toast('The gamepad has no camera: choose one in Gamepad control', 'warn');
    return;
  }
  const ptz = cam.kind === 'ptz';
  if (action === 'recordToggle') {
    if (ptz) return;   // a PTZ head is not a recorder
    await doAction(cam.id, cam.status?.recording ? 'recordStop' : 'recordStart');
  } else if (action === 'autofocus') {
    if (ptz) ptzUi.padAutofocus(cam);
    else await doAction(cam.id, 'autofocus');
  } else if (action === 'nextCamera' || action === 'prevCamera') {
    const live = gamepadCandidates(view.cameras);
    if (live.length < 2) return;
    const at = live.findIndex((c) => c.id === cam.id);
    const step = action === 'nextCamera' ? 1 : -1;
    const next = live[(at + step + live.length) % live.length];
    setPadCamera(next.id);
    toast(`Gamepad now drives ${next.label}`);
  }
}

function setPadCamera(id) {
  // Whatever the sticks were doing belonged to the previous camera.
  ptzUi.padRelease();
  padCamera = id;
  localStorage.setItem('cb.padCamera', id ?? '');
  const sel = $('#pad-camera');
  if (sel) sel.value = id ?? '';
  renderControl();
}

const gamepad = createGamepadControl({
  onStep: (prop, direction, coarse) => padStep(prop, direction, coarse),
  // A PTZ target takes the sticks as velocity — left stick pan/tilt, right
  // stick zoom and focus — through the same refresh-or-stop holds the
  // on-screen joystick uses. `null` means the pad went away or was switched
  // off, which must stop the head.
  onSticks: (axes) => {
    const cam = axes ? padTarget() : null;
    if (!cam || cam.kind !== 'ptz') { ptzUi.padRelease(); return false; }
    ptzUi.padSticks(cam, axes);
    return true;
  },
  onButton: (action) => padAction(action),
  onStatus: ({ connected, name, disarmed }) => {
    $('#pad-status').textContent = connected ? name : 'No gamepad detected';
    if (disarmed) {
      // Unplugging disarms control; say so and reflect it on the toggle.
      $('#pad-toggle').textContent = 'Gamepad control is off';
      $('#pad-toggle').classList.remove('primary');
      $('#pad-open').classList.remove('primary');
      toast('Gamepad disconnected; gamepad control switched off', 'warn');
      renderControl();
    }
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
  toast(on ? (padTarget() ? `Gamepad drives ${padTarget().label}` : 'Choose the camera the gamepad drives') : 'Gamepad control off', on && !padTarget() ? 'warn' : undefined);
  renderControl();
});

/** Kept in step with the camera list, not just filled once when opened. */
function renderPadCameras() {
  const sel = $('#pad-camera');
  if (!sel) return;
  const target = padTarget()?.id ?? '';
  sel.textContent = '';
  // An explicit "none" so a lost or never-chosen target is visible, rather
  // than the select showing (and implying) the first camera.
  sel.append(el('option', { value: '', selected: !target }, document.createTextNode('Choose a camera…')));
  for (const c of gamepadCandidates(view.cameras)) {
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
//
// The stream starts with the full state and then sends patches — only what
// changed — because with dozens of cameras the full state is far too big to
// resend each time one of them pans. A reconnect starts again from the full
// state, so a patch is never applied to a frame from before an outage.
let frame = null;
let undoJson = null;

/**
 * A full frame — on connect, after a reconnect, when cameras are added,
 * reordered or regrouped — brings a new object for every camera. Where one is
 * unchanged, keep the object already held, so that "same object" still means
 * "nothing to redraw" and forty-eight cards and tiles are not rebuilt because
 * one camera was renamed.
 */
function keepUnchanged(next) {
  const before = new Map(view.cameras.map((c) => [c.id, c]));
  next.view.cameras = next.view.cameras.map((c) => {
    const b = before.get(c.id);
    return b && JSON.stringify(b) === JSON.stringify(c) ? b : c;
  });
}

function adopt(next) {
  frame = next;
  view = next.view;
  alarms = next.alarms ?? [];
  alarmsByCamera = next.alarmsByCamera ?? {};
  alarmSummary = next.alarmSummary ?? null;
  roll = next.roll ?? null;
  // Every frame carries the undo summary afresh. Kept as the same object while
  // it says the same thing, so a card's "has my undo changed" is an identity test.
  const u = JSON.stringify(next.undo ?? {});
  if (u !== undoJson) { undoJson = u; undoState = next.undo ?? {}; }
  ptzUi.onView(view);
  render();
  if (currentView === 'multiview') syncMultiview();
}

async function resync() {
  const r = await fetch('/api/state').catch(() => null);
  if (!r?.ok) return;
  const next = { type: 'state', ...(await r.json()) };
  keepUnchanged(next);
  adopt(next);
}

// ?profile on the URL records how long each pushed frame takes to apply and
// render, as User Timing measures ("cb:patch", "cb:state") for the browser's
// performance tools. Off by default: measures accumulate.
const PROFILE = /[?&]profile\b/.test(location.search);

function connectEvents() {
  const es = new EventSource('/api/events?patch=1');
  es.onmessage = (e) => {
    const t0 = performance.now();
    let kind = null;
    try {
      const msg = JSON.parse(e.data);
      kind = msg.type;
      if (msg.type === 'state') { keepUnchanged(msg); adopt(msg); return; }
      if (msg.type !== 'patch' || !frame) return;
      const r = applyPatch(frame, msg);
      adopt(r.frame);
      if (r.resync) resync();
    } catch { /* ignore malformed frame */ } finally {
      if (PROFILE && kind) performance.measure(`cb:${kind}`, { start: t0, end: performance.now() });
    }
  };
  es.onerror = () => {
    // About CamBridge itself, not the daemon, so shown at every venue.
    $('#camd-pill').style.display = '';
    $('#camd-pill').textContent = 'reconnecting…';
    $('#camd-pill').className = 'pill warn';
  };
}

loadMeta();
refreshAuth();
connectEvents();
setInterval(() => { if (currentView === 'setup') refreshSetup(); }, 5000);
