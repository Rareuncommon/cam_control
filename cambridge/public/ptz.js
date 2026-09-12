// Pointer/keyboard movement sessions: renewed only while the operator holds a key.
export function createPtzUi({ el, api, toast, refresh }) {
  let active = null, catalog;
  const settings = new Map();
  const post = (id, action, body) => api('POST', `/api/cameras/${encodeURIComponent(id)}/actions/${action}`, body);
  function stop(repaint = true) {
    if (!active) return;
    const held = active; active = null; clearInterval(held.timer);
    held.button.classList.remove('primary');
    post(held.id, 'ptzStop', { controlId: held.controlId, sequence: ++held.sequence });
    if (repaint) refresh();
  }
  window.addEventListener('blur', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('pagehide', () => {
    if (active) fetch(`/api/cameras/${encodeURIComponent(active.id)}/actions/ptzStop`, { method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ controlId: active.controlId, sequence: ++active.sequence }) }).catch(() => {});
    stop();
  });
  function hold(button, camera, vector, speed) {
    const begin = () => {
      stop(false);
      const held = { id: camera.id, controlId: [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join(''), sequence: 0, button };
      active = held; button.classList.add('primary');
      const send = async () => {
        if (active !== held) return;
        const r = await post(camera.id, 'ptzMove', { controlId: held.controlId, sequence: ++held.sequence,
          leaseMs: 700, pan: (vector.pan ?? 0) * speed(), tilt: (vector.tilt ?? 0) * speed(), zoom: (vector.zoom ?? 0) * speed() });
        if (r.ok === false && active === held) stop();
      };
      held.timer = setInterval(send, 250); send();
    };
    button.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); begin(); button.setPointerCapture(e.pointerId); });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, () => { if (active?.button === button) stop(); });
    button.addEventListener('keydown', e => { if ([' ', 'Enter'].includes(e.key) && !e.repeat) { e.preventDefault(); begin(); } });
    button.addEventListener('blur', () => { if (active?.button === button) stop(); });
    button.addEventListener('keyup', e => { if ([' ', 'Enter'].includes(e.key)) { e.preventDefault(); stop(); } });
  }
  function card(camera) {
    if (!settings.has(camera.id)) settings.set(camera.id, { speed: 0.25, slot: 0 });
    const saved = settings.get(camera.id);
    const card = el('section', { class: 'cam ptz-card', 'data-ptz-id': camera.id });
    card.append(el('header', {}, el('h2', { text: camera.label }), el('span', { class: 'pill', text: camera.state })));
    const body = el('div', { class: 'body' });
    body.append(el('p', { class: 'note', text: `${camera.ptz.brand} · ${camera.ip} · ${camera.transport}` }));
    const speed = el('input', { type: 'range', min: '0.05', max: '1', step: '0.05', value: saved.speed, 'aria-label': 'Movement speed' });
    speed.addEventListener('input', () => { saved.speed = Number(speed.value); });
    body.append(el('label', {}, document.createTextNode('Movement speed'), speed));
    const pad = el('div', { class: 'ptz-pad', 'aria-label': 'Pan and tilt controls' });
    for (const [text, pan, tilt, label] of [['↖', -1, 1, 'Up left'], ['↑', 0, 1, 'Tilt up'], ['↗', 1, 1, 'Up right'],
      ['←', -1, 0, 'Pan left'], ['STOP', 0, 0, 'Stop all movement'], ['→', 1, 0, 'Pan right'],
      ['↙', -1, -1, 'Down left'], ['↓', 0, -1, 'Tilt down'], ['↘', 1, -1, 'Down right']]) {
      const button = el('button', { text, 'aria-label': label, title: label, class: text === 'STOP' ? 'danger' : '' });
      if (text === 'STOP') button.onclick = () => { stop(); post(camera.id, 'ptzStop', {}); };
      else hold(button, camera, { pan, tilt }, () => Number(speed.value));
      pad.append(button);
    }
    body.append(pad);
    const zoom = el('div', { class: 'line' });
    for (const [text, direction] of [['Zoom out', -1], ['Zoom in', 1]]) { const button = el('button', { text }); hold(button, camera, { zoom: direction }, () => Number(speed.value)); zoom.append(button); }
    body.append(zoom, el('p', { class: 'note', text: 'Hold to move; release to stop. An acknowledged command does not verify the physical position.' }));
    const status = camera.ptz.stopState === 'unconfirmed' ? 'STOP NOT CONFIRMED — check the camera and retry Stop.' : camera.detail ||
      (camera.ptz.lastResult ? `${camera.ptz.lastResult.action}: ${camera.ptz.lastResult.acknowledged ? 'acknowledged' : 'not acknowledged'}` : 'Use Check connection before moving.');
    body.append(el('p', { class: camera.ptz.stopState === 'unconfirmed' ? 'note warnnote' : 'note', text: status }));
    const controls = el('div', { class: 'line' },
      el('button', { text: 'Check connection', onclick: () => post(camera.id, 'ptzProbe', {}) }),
      el('button', { text: 'Home', onclick: () => post(camera.id, 'ptzHome', {}) }));
    const slot = el('input', { type: 'number', min: 0, max: camera.capabilities.presets.max, value: saved.slot, 'aria-label': 'Camera preset slot', class: 'ptz-slot' });
    slot.addEventListener('input', () => { saved.slot = Number(slot.value); });
    controls.append(slot, el('button', { text: 'Recall preset', onclick: () => post(camera.id, 'ptzPresetRecall', { slot: Number(slot.value) }) }),
      el('button', { text: 'Save preset', onclick: () => post(camera.id, 'ptzPresetSave', { slot: Number(slot.value) }) }));
    body.append(controls); card.append(body); return card;
  }
  async function setup() {
    if (catalog) return;
    const result = await api('GET', '/api/ptz/catalog');
    if (!result.profiles) return;
    catalog = result;
    const select = document.querySelector('#ptz-profile');
    for (const p of result.profiles) select.append(el('option', { value: p.id, text: `${p.brand} — ${p.model}` }));
    const update = () => {
      const p = result.profiles.find(p => p.id === select.value);
      document.querySelector('#ptz-port').value = p.port;
      document.querySelector('#ptz-reply-port').value = p.replyPort ?? 0;
      document.querySelector('#ptz-connection-note').textContent = p.note || `${p.protocol}; hardware validation pending.`;
      document.querySelector('#ptz-http-auth').hidden = p.protocol !== 'panasonic-http';
    };
    select.addEventListener('change', update); update();
    document.querySelector('#ptz-add-form').addEventListener('submit', async e => {
      e.preventDefault();
      const button = e.submitter; button.disabled = true;
      try {
        const r = await api('POST', '/api/ptz/cameras', { id: `ptz-${Date.now().toString(36)}`, profile: select.value,
          label: document.querySelector('#ptz-label').value, host: document.querySelector('#ptz-host').value.trim(),
          port: Number(document.querySelector('#ptz-port').value), replyPort: Number(document.querySelector('#ptz-reply-port').value), username: document.querySelector('#ptz-user').value,
          password: document.querySelector('#ptz-password').value, https: document.querySelector('#ptz-https').checked });
        if (r.ok) { document.querySelector('#ptz-password').value = ''; toast(`Added ${r.camera.label}`); refresh(); }
      } finally { button.disabled = false; }
    });
  }
  function renderList(cameras) {
    const list = document.querySelector('#ptz-added'); list.textContent = '';
    for (const c of cameras.filter(c => c.provider === 'network-ptz')) {
      list.append(el('div', { class: 'line' }, el('span', { text: `${c.label} — ${c.ip} (${c.state})` }),
        el('button', { text: 'Remove', onclick: async () => {
          const r = await api('DELETE', `/api/ptz/cameras/${encodeURIComponent(c.id)}`);
          if (r.ok) refresh();
        } })));
    }
  }
  return { card, setup, stop, renderList, get active() { return !!active; } };
}
