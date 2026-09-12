export function createExternalUi({ el, api, toast }) {
  let initialized = false;
  const post = (id, action, body) => api('POST', `/api/external/cameras/${encodeURIComponent(id)}/${action}`, body);
  function card(camera) {
    const result = el('section', { class: 'cam external-card', 'data-external-id': camera.id });
    result.append(el('header', {}, el('h2', { text: camera.label }), el('span', { class: 'pill', text: camera.state })));
    const body = el('div', { class: 'body' });
    body.append(el('p', { class: 'note', text: `${camera.model} · ${camera.transport}` }));
    const buttons = el('div', { class: 'line' }, el('button', { text: 'Refresh controls', disabled: camera.external.busy, onclick: () => post(camera.id, 'refresh', {}) }));
    if (camera.provider === 'blackmagic-rest') for (const [text, action] of [['Record', 'recordStart'], ['Stop recording', 'recordStop']]) buttons.append(el('button', { text, disabled: action === 'recordStart' && (camera.external.busy || !camera.capabilities.record.available), onclick: () => api('POST', `/api/cameras/${encodeURIComponent(camera.id)}/actions/${action}`, {}) }));
    if (camera.capabilities.capture.available) buttons.append(el('button', { text: 'Take photo to card', disabled: camera.external.busy, onclick: () => post(camera.id, 'capture', {}) }));
    body.append(buttons);
    if (camera.capabilities.record.available) body.append(el('p', { text: camera.status.recording ? 'Recording' : 'Not recording' }));
    for (const c of camera.external.controls) {
      const label = el('label', { class: 'external-control' }, el('span', { text: c.label }));
      let input;
      if (c.choices.length) {
        input = el('select', { 'aria-label': c.label });
        input.append(el('option', { value: '', text: `Current: ${c.current}`, selected: true }));
        for (const choice of c.choices) input.append(el('option', { value: choice.index, text: choice.label }));
      } else input = el('input', { type: 'number', value: c.current, min: c.min, max: c.max, step: c.step, 'aria-label': c.label });
      input.disabled = camera.external.busy || camera.state !== 'connected';
      const apply = el('button', { text: 'Apply', disabled: input.disabled, onclick: () => { if (input.value !== '') post(camera.id, 'set', { key: c.key, value: Number(input.value) }); } });
      label.append(input, apply); body.append(label);
    }
    body.append(el('p', { class: 'note', text: camera.detail || (camera.external.busy ? 'Waiting for the camera…' : 'Controls reflect the connected camera. New models await hardware validation.') }));
    if (camera.provider === 'gphoto2') body.append(el('p', { class: 'note', text: 'For still capture, set the camera capture target to its memory card. USB movie recording and live view are not enabled.' }));
    result.append(body); return result;
  }
  async function setup() {
    if (initialized) return; initialized = true;
    const catalog = await api('GET', '/api/external/catalog');
    if (!Array.isArray(catalog.models)) { initialized = false; return; }
    const search = document.querySelector('#external-search');
    const renderCatalog = () => {
      const query = search.value.trim().toLowerCase();
      const matches = catalog.models.filter(c => `${c.brand} ${c.model} ${c.provider}`.toLowerCase().includes(query));
      const table = document.querySelector('#external-catalog-table'); table.textContent = '';
      table.append(el('tr', {}, ...['Camera', 'Connection', 'Validation'].map(text => el('th', { text }))));
      for (const c of matches.slice(0, 40)) table.append(el('tr', {}, el('td', { text: c.model }), el('td', { text: c.provider === 'gphoto2' ? 'USB' : 'Network' }), el('td', { text: 'Hardware test pending' })));
      document.querySelector('#external-search-count').textContent = `${matches.length} matching profiles${matches.length > 40 ? '; first 40 shown — narrow your search' : ''}`;
    };
    search.addEventListener('input', renderCatalog); renderCatalog();
    const model = document.querySelector('#external-model');
    for (const c of catalog.models ?? []) if (c.provider === 'blackmagic-rest') model.append(el('option', { value: c.model, text: c.model }));
    document.querySelector('#external-catalog-count').textContent = `${catalog.models?.length ?? 0} stills/cinema profiles, including regional model aliases. USB controls are discovered from the connected body.`;
    document.querySelector('#external-scan').onclick = async e => {
      e.target.disabled = true;
      try {
        const r = await api('GET', '/api/external/discovered'); const list = document.querySelector('#external-usb-list'); list.textContent = '';
        for (const c of r.cameras ?? []) list.append(el('div', { class: 'line' }, el('span', { text: `${c.model} · ${c.port}` }), el('button', { text: 'Add USB camera', onclick: async e => {
          e.target.disabled = true; try { const added = await api('POST', '/api/external/cameras', { id: `ext-${Date.now().toString(36)}`, provider: 'gphoto2', ...c }); if (added.ok) toast('USB camera added'); } finally { e.target.disabled = false; }
        } })));
        if (r.cameras?.length === 0) list.append(el('p', { text: 'No non-Sony USB cameras found. Enable tethering/PC Remote and close other camera apps.' }));
      } finally { e.target.disabled = false; }
    };
    document.querySelector('#external-add-form').onsubmit = async e => {
      e.preventDefault(); e.submitter.disabled = true;
      try { const r = await api('POST', '/api/external/cameras', { id: `ext-${Date.now().toString(36)}`, provider: 'blackmagic-rest', model: model.value,
        label: document.querySelector('#external-label').value, host: document.querySelector('#external-host').value.trim(), port: Number(document.querySelector('#external-port').value),
        https: document.querySelector('#external-https').checked, username: document.querySelector('#external-user').value, password: document.querySelector('#external-password').value });
        if (r.ok) { document.querySelector('#external-password').value = ''; toast('Cinema camera added'); }
      } finally { e.submitter.disabled = false; }
    };
  }
  function renderList(cameras) {
    const list = document.querySelector('#external-added'); list.textContent = '';
    for (const c of cameras.filter(c => c.external)) list.append(el('div', { class: 'line' }, el('span', { text: `${c.label} · ${c.model}` }), el('button', { text: 'Remove', onclick: () => api('DELETE', `/api/external/cameras/${encodeURIComponent(c.id)}`) })));
  }
  return { card, setup, renderList };
}
