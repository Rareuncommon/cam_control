'use strict';
// CamBridge control panel.
//
// Vanilla JS, no build step. The organising idea for the UI is that a booth
// operator during a service should never have to hunt: the controls they touch
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
let meta = { focusNote: '', scenes: [], presets: {}, groups: {} };
let discovery = { discovered: [], credentialHint: '' };
let currentView = 'control';
let soloFeed = null;
let gangSelection = new Set();
let interacting = null;
// Persisted so a booth iPad comes back the way it was left.
let advanced = localStorage.getItem('cb.advanced') === '1';
let rampMs = Number(localStorage.getItem('cb.rampMs') ?? 0);

function toast(message, kind = 'ok', ttl = 5000) {
  const t = el('div', { class: `toast ${kind}`, text: message });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ttl);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  // Fail loud: the operator must know a command did not land.
  if (!res.ok) toast(data?.error ?? `${method} ${path} failed (${res.status})`, 'bad', 9000);
  return data ?? {};
}

const setProp = (id, prop, value) =>
  api('PUT', `/api/cameras/${encodeURIComponent(id)}/properties/${prop}`, { value });
const doAction = (id, action, body) =>
  api('POST', `/api/cameras/${encodeURIComponent(id)}/actions/${action}`, body);

// --- controls ---------------------------------------------------------------

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
 * mid-service. Tapping the value itself opens the full list for a big jump.
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

  const card = el('section', {
    class: `cam${rec ? ' recording' : ''}${connected ? '' : ' offline'}`, 'data-id': cam.id,
  });
  card.append(el('header', {},
    el('span', { class: `recdot${rec ? ' on' : ''}${failed ? ' failed' : ''}` }),
    el('div', {},
      el('h2', { text: cam.label || cam.id }),
      el('div', { class: 'meta', text:
        `${cam.model || 'unknown'} · ${cam.ip || '—'}` +
        (cam.properties?.exposureMode ? ` · ${cam.properties.exposureMode.label}` : '') })),
    el('span', { class: 'spacer' }),
    stateBadge(cam)));

  const body = el('div', { class: 'body' });
  if (!connected) {
    body.append(el('div', { class: 'note', text: cam.detail || 'No live values while disconnected.' }));
    body.append(el('button', { onclick: () => doAction(cam.id, 'reconnect') },
      document.createTextNode('Reconnect')));
    card.append(body);
    return card;
  }

  // The four an operator touches during a service, plus ND when the body has it.
  add(body, stepper(cam, 'fNumber', 'Iris', { invert: true }), autoGate(cam, 'fNumber'));
  add(body, stepper(cam, 'isoSensitivity', 'ISO'), autoGate(cam, 'isoSensitivity'));
  add(body, stepper(cam, 'shutterSpeed', 'Shutter'), autoGate(cam, 'shutterSpeed'));
  add(body, stepper(cam, 'ndValue', 'ND', { coarse: 5 }));
  add(body, stepper(cam, 'colorTemp', 'Kelvin', { coarse: 1 }));

  body.append(el('div', { class: 'btnrow' },
    el('button', {
      class: rec ? 'big' : 'danger big',
      onclick: () => doAction(cam.id, rec ? 'recordStop' : 'recordStart'),
    }, document.createTextNode(rec ? '■ Stop' : '● Record'))));

  const st = cam.status ?? {};
  body.append(el('div', { class: 'status' },
    el('span', { text: `Battery ${st.battery >= 0 ? st.battery + '%' : '—'}` }),
    el('span', { text: st.media || 'media —' }),
    cam.properties?.ndDensity ? el('span', { text: cam.properties.ndDensity.label }) : null,
    failed ? el('span', { class: 'pill bad', text: 'RECORDING FAILED' }) : null));

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
  for (const cam of view.cameras) grid.append(cameraCard(cam));
}

function feedTile(cam) {
  const rec = cam.status?.recording;
  const tile = el('div', { class: `feed${rec ? ' recording' : ''}` });

  if (cam.state === 'connected') {
    const img = el('img', {
      src: `/api/cameras/${encodeURIComponent(cam.id)}/liveview?t=${Date.now()}`,
      alt: `${cam.label} live view`,
      title: 'Click to focus here',
    });
    const fallback = el('div', { class: 'placeholder' },
      el('div', { text: 'No live view from this camera' }),
      el('div', { class: 'note', text: 'Live view may need enabling on the body.' }));
    fallback.style.display = 'none';
    img.addEventListener('error', () => { img.style.display = 'none'; fallback.style.display = 'flex'; });

    // Tap-to-focus. Coordinates go up normalised, so the browser never needs to
    // know anything about the camera's AF grid.
    img.addEventListener('click', async (e) => {
      const r = img.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      const mark = el('div', { class: 'tapmark' });
      mark.style.left = `${e.clientX - r.left}px`;
      mark.style.top = `${e.clientY - r.top}px`;
      tile.append(mark);
      setTimeout(() => mark.remove(), 1100);
      await doAction(cam.id, 'tapFocus', { x, y });
    });
    tile.append(img, fallback);
  } else {
    tile.append(el('div', { class: 'placeholder' },
      el('div', { text: cam.state }), el('div', { class: 'note', text: cam.detail ?? '' })));
  }

  tile.append(el('div', { class: 'overlay' },
    el('span', { class: `recdot${rec ? ' on' : ''}` }),
    el('span', { text: cam.label || cam.id }),
    el('span', { class: 'spacer' }),
    el('span', { class: 'note', text: cam.properties?.fNumber?.label ?? '' })));

  tile.append(el('div', { class: 'tools' },
    el('button', { class: 'small', onclick: () => doAction(cam.id, 'autofocus') },
      document.createTextNode('AF')),
    el('button', {
      class: rec ? 'small' : 'small danger',
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
  grid.textContent = '';
  const cams = soloFeed ? view.cameras.filter((c) => c.id === soloFeed) : view.cameras;
  grid.className = soloFeed ? 'solo' : '';
  if (!cams.length) {
    grid.append(el('div', { class: 'note', style: 'padding:12px', text: 'No cameras to show.' }));
    return;
  }
  for (const cam of cams) grid.append(feedTile(cam));
}

function renderSetup() {
  $('#discover-hint').textContent = discovery.credentialHint ?? '';
  const dt = $('#discovered-table');
  dt.textContent = '';
  dt.append(el('tr', {}, el('th', { text: 'Model' }), el('th', { text: 'Address' }),
    el('th', { text: 'MAC' }), el('th', { text: '' })));
  const list = discovery.discovered ?? [];
  if (!list.length) {
    dt.append(el('tr', {}, el('td', { colspan: '4', class: 'note',
      text: 'No cameras seen yet. Check USB-LAN Connection and Remote Shooting are on.' })));
  }
  for (const cam of list) {
    dt.append(el('tr', {},
      el('td', {}, el('div', { text: cam.model || 'unknown' }),
        cam.accessAuthRequired ? el('div', { class: 'note', text: 'needs password' }) : null),
      el('td', { class: 'mono', text: cam.ip || '—' }),
      el('td', { class: 'mono', text: cam.mac || '—' }),
      el('td', {}, cam.adopted
        ? el('span', { class: 'pill ok', text: `added as ${cam.adoptedAs?.label ?? ''}` })
        : el('button', { class: 'small primary', onclick: () => openAdopt(cam) },
            document.createTextNode('Add')))));
  }

  const at = $('#adopted-table');
  at.textContent = '';
  at.append(el('tr', {}, el('th', { text: 'Name' }), el('th', { text: 'Model' }),
    el('th', { text: 'State' }), el('th', { text: '' })));
  if (!view.cameras.length) {
    at.append(el('tr', {}, el('td', { colspan: '4', class: 'note', text: 'Nothing added yet.' })));
  }
  for (const cam of view.cameras) {
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

function openAdopt(cam) {
  adoptTarget = cam; editTarget = null;
  $('#adopt-title').textContent = `Add ${cam.model || 'camera'}`;
  $('#adopt-sub').textContent = `${cam.ip || 'unknown address'} · ${cam.mac}`;
  $('#adopt-label').value = ''; $('#adopt-user').value = ''; $('#adopt-pass').value = '';
  $('#adopt-user').placeholder = 'from the camera screen';
  $('#adopt-pass').placeholder = 'from the camera screen';
  $('#adopt-confirm').textContent = 'Add camera';
  $('#adopt-dialog').showModal();
  $('#adopt-label').focus();
}

function openEdit(cam) {
  editTarget = cam; adoptTarget = null;
  $('#adopt-title').textContent = `Edit ${cam.label}`;
  $('#adopt-sub').textContent = `${cam.ip || 'unknown address'} · ${cam.mac}`;
  $('#adopt-label').value = cam.label ?? '';
  $('#adopt-user').value = ''; $('#adopt-pass').value = '';
  // Credentials are never sent to the browser, so blank means "leave alone".
  $('#adopt-user').placeholder = 'leave blank to keep current';
  $('#adopt-pass').placeholder = 'leave blank to keep current';
  $('#adopt-confirm').textContent = 'Save';
  $('#adopt-dialog').showModal();
  $('#adopt-label').focus();
}

async function refreshSetup() {
  discovery = await api('GET', '/api/discovered');
  renderSetup();
}

// --- shared -----------------------------------------------------------------

function render() {
  const pill = $('#camd-pill');
  pill.textContent = view.camdConnected ? 'connected' : 'daemon offline';
  pill.className = `pill ${view.camdConnected ? 'ok' : 'bad'}`;

  const banner = $('#banner');
  const failed = view.cameras.filter((c) => c.status?.recordingFailed);
  const bad = view.cameras.filter((c) => c.state !== 'connected');
  if (!view.camdConnected) {
    banner.textContent = 'The camera daemon is not reachable — no control is possible.';
    banner.classList.add('show');
  } else if (failed.length) {
    banner.textContent = `RECORDING FAILED on ${failed.map((c) => c.label).join(', ')}`;
    banner.classList.add('show');
  } else if (bad.length) {
    banner.textContent = bad.map((c) => `${c.label}: ${c.state}`).join('   ·   ');
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }

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

function renderTools() {
  const refSel = $('#match-ref');
  const prev = refSel.value;
  refSel.textContent = '';
  for (const c of view.cameras) {
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
  for (const c of view.cameras) {
    holder.append(el('div', {
      class: `chip${gangSelection.has(c.id) ? ' on' : ''}`,
      onclick: (e) => {
        gangSelection.has(c.id) ? gangSelection.delete(c.id) : gangSelection.add(c.id);
        e.currentTarget.classList.toggle('on');
      },
    }, document.createTextNode(c.label)));
  }
  $('#focus-note').textContent = meta.focusNote ?? '';
}

function switchView(name) {
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

$('#adopt-confirm').addEventListener('click', async () => {
  const label = $('#adopt-label').value.trim();
  const username = $('#adopt-user').value.trim();
  const password = $('#adopt-pass').value;
  if (adoptTarget) {
    if (adoptTarget.accessAuthRequired && (!username || !password)) {
      return toast('This camera needs the username and password from its screen', 'warn', 9000);
    }
    const r = await api('POST', '/api/adopt', {
      mac: adoptTarget.mac, model: adoptTarget.model, ip: adoptTarget.ip, label, username, password,
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

async function loadMeta() {
  meta = await api('GET', '/api/presets');
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
connectEvents();
setInterval(() => { if (currentView === 'setup') refreshSetup(); }, 5000);
