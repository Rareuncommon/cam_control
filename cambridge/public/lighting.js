// The Lighting tab: faders, looks and scenes, the patch, and output.
//
// Built once into its section and then updated in place from the event
// stream, so a fade pushing ten views a second moves the faders and readouts
// without rebuilding them — and never under a finger: a fader being dragged
// is left alone until shortly after it is let go.

import {
  outputSummary, nextFreeAddress, fieldErrors, sceneCaption, pct, kelvin, parseGroups, throttle,
} from './lighting-logic.js';

const FADES = [[0, 'Snap'], [500, '0.5 s'], [1000, '1 s'], [2000, '2 s'], [3000, '3 s'], [5000, '5 s']];
// Companion's buttons moved the dimmer by 26 of 255 (about 10 %) and the
// colour by 32 of 255 (about 300 K on the 3200–5600 K curve).
const NUDGE_PCT = 10;
const NUDGE_K = 300;
const CCT_PRESETS = [3200, 4400, 5600];
const FADE_KEY = 'cambridge.lighting.fadeMs';

export function createLighting({ root, pill, el, api, toast, show }) {
  let view = null;
  const sig = { faders: null, scenes: null, patch: null, profiles: null };
  /** Fader key -> time after which the server's value may be shown again. */
  const holding = new Map();
  const faders = new Map();
  let lastError = 0;

  const add = (parent, ...kids) => { for (const k of kids) if (k) parent.append(k); return parent; };
  const setText = (n, t) => { if (n && n.textContent !== t) n.textContent = t; };
  const held = (key) => (holding.get(key) ?? 0) > performance.now();
  const hold = (key) => holding.set(key, Infinity);
  // Long enough for the echo of the last value sent to come back.
  const release = (key) => holding.set(key, performance.now() + 800);

  let fadeMs = 1000;
  try {
    const stored = localStorage.getItem(FADE_KEY);
    const v = stored === null ? NaN : Number(stored);
    if (FADES.some(([ms]) => ms === v)) fadeMs = v;
  } catch { /* private mode */ }

  async function call(method, path, body, { quiet = false } = {}) {
    const r = await api(method, path, body, { quiet: true });
    if (!r.httpOk && !quiet && r.httpStatus !== 401) {
      // A drag that fails fails forty times; say so once.
      if (performance.now() - lastError > 3000) toast(r.error ?? `${method} ${path} failed`, 'bad', 7000);
      lastError = performance.now();
    }
    return r;
  }
  const set = (target, values) => call('POST', '/api/lighting/set', { target, ...values, fadeMs: values.fadeMs ?? 0 });

  // --- skeleton ----------------------------------------------------------------

  const unavailable = el('div', { class: 'card lt-alert', hidden: true });
  const configErrors = el('div', { class: 'card lt-alert', hidden: true });

  const statusText = el('strong', { text: '' });
  const statusDetail = el('div', { class: 'note' });
  const counters = el('div', { class: 'note mono' });
  const outBtn = el('button', { class: 'small', onclick: () => toggleOutput() });
  const dryBtn = el('button', { class: 'small', onclick: () => toggleDryRun() });
  const statusCard = el('div', { class: 'card' },
    el('h3', { text: 'Lighting output' }),
    el('div', { class: 'line' }, statusText, el('span', { class: 'spacer' }), dryBtn, outBtn),
    statusDetail, counters);

  const fadeSel = el('select', { id: 'lt-fade', 'aria-label': 'Fade time', onchange: () => {
    fadeMs = Number(fadeSel.value);
    try { localStorage.setItem(FADE_KEY, String(fadeMs)); } catch { /* private mode */ }
  } });
  for (const [ms, label] of FADES) fadeSel.append(el('option', { value: ms, text: label }));
  fadeSel.value = String(fadeMs);
  const looksRow = el('div', { class: 'line lt-looks' });
  const scenesGrid = el('div', { class: 'lt-scenes' });
  const scenesCard = el('div', { class: 'card' },
    el('div', { class: 'line' }, el('h3', { text: 'Looks & scenes' }), el('span', { class: 'spacer' }),
      el('span', { class: 'field' }, el('label', { class: 'note', for: 'lt-fade', text: 'Fade' }), fadeSel)),
    el('div', { class: 'sub', text: 'Studio look and Studio off are built in and cannot be saved over. A scene saves where every light is now.' }),
    looksRow, scenesGrid);

  const masterBox = el('div', { class: 'lt-masters' });
  const groupBox = el('div', { class: 'lt-groups' });
  const fixtureBox = el('div', { class: 'lt-faders' });
  const fadersCard = el('div', { class: 'card' },
    el('h3', { text: 'Lights' }),
    el('div', { class: 'sub', text: 'Faders move the lights straight away. Readouts follow the lights, fades included.' }),
    masterBox, groupBox, fixtureBox);

  const patchTable = el('table', { class: 'list lt-patch' });
  const patchCard = el('div', { class: 'card' },
    el('div', { class: 'line' }, el('h3', { text: 'Fixtures' }), el('span', { class: 'spacer' }),
      el('button', { class: 'small primary', text: 'Add fixture', onclick: () => openEditor(null) })),
    el('div', { class: 'sub', text: 'Changing the patch needs the admin PIN. A fixture with a problem is left out of the output until it is fixed.' }),
    el('div', { class: 'tablescroll' }, patchTable));

  const outForm = buildOutputForm();
  const transfer = buildTransfer();
  const profilesBox = buildProfiles();

  add(root, unavailable, configErrors, statusCard, scenesCard, fadersCard, patchCard, outForm.card, transfer.card, profilesBox.card);
  const editor = buildEditor();
  root.append(editor.dialog);
  pill?.addEventListener('click', () => show?.());

  // --- live view ---------------------------------------------------------------

  function onView(next) {
    if (!next) return;
    view = next;
    const s = outputSummary(view);
    if (pill) {
      pill.hidden = !s.pill;
      setText(pill, s.text);
      const cls = `pill lt-pill ${s.kind}`.trim();
      if (pill.className !== cls) pill.className = cls;
    }
    unavailable.hidden = !view.unavailable;
    if (view.unavailable) {
      setText(unavailable, s.detail);
      for (const card of [statusCard, scenesCard, fadersCard, patchCard, outForm.card, transfer.card, profilesBox.card]) card.hidden = true;
      return;
    }
    for (const card of [statusCard, scenesCard, fadersCard, patchCard, outForm.card, transfer.card, profilesBox.card]) card.hidden = false;
    renderStatus(s);
    renderConfigErrors();
    renderScenes();
    renderFaders();
    renderPatch();
    outForm.update();
  }

  function renderStatus(s) {
    const o = view.output;
    setText(statusText, s.pill ? s.text : 'Sending');
    statusText.className = s.kind ? `lt-state ${s.kind}` : 'lt-state';
    setText(statusDetail, s.detail);
    setText(outBtn, o.enabled ? 'Turn output off' : 'Turn output on');
    outBtn.className = o.enabled ? 'small' : 'small primary';
    setText(dryBtn, o.dryRun ? 'Leave dry run' : 'Dry run');
    const c = o.counters ?? {};
    const last = o.lastSentAt ? new Date(o.lastSentAt).toLocaleTimeString() : 'never';
    setText(counters, `${o.mode} · priority ${o.priority} · “${o.sourceName}” · ${c.packets ?? 0} packets, ${c.sendErrors ?? 0} errors · last sent ${last}`);
  }

  function renderConfigErrors() {
    const list = view.errors ?? [];
    configErrors.hidden = list.length === 0;
    const key = JSON.stringify(list);
    if (configErrors.dataset.sig === key) return;
    configErrors.dataset.sig = key;
    configErrors.textContent = '';
    add(configErrors, el('h3', { text: 'The lighting settings have problems' }));
    for (const e of list) configErrors.append(el('div', { class: 'note', text: e.message ?? String(e) }));
  }

  async function toggleOutput() {
    const o = view.output;
    if (!o.enabled && !o.dryRun) {
      const ok = confirm('Turn lighting output on?\n\nCamBridge will start sending to the lights. Companion’s SACN connection must be disabled first: two sources on one universe fight, and the lights flicker between them.');
      if (!ok) return;
    }
    const r = await call('PUT', '/api/lighting/output', { enabled: !o.enabled });
    if (r.httpOk) toast(r.output.enabled ? `Lighting output on${r.output.dryRun ? ' (dry run)' : ''}` : 'Lighting output off');
  }

  async function toggleDryRun() {
    const o = view.output;
    if (o.dryRun && o.enabled) {
      const ok = confirm('Leave dry run?\n\nCamBridge will start sending to the lights. Companion’s SACN connection must be disabled first.');
      if (!ok) return;
    }
    await call('PUT', '/api/lighting/output', { dryRun: !o.dryRun });
  }

  // --- looks and scenes ------------------------------------------------------------

  function renderScenes() {
    const key = JSON.stringify([view.looks, view.scenes, view.active]);
    if (sig.scenes === key) return;
    sig.scenes = key;
    looksRow.textContent = '';
    for (const look of view.looks ?? []) {
      const on = view.active?.type === 'look' && view.active.id === look.id;
      looksRow.append(el('button', {
        class: `big lt-look${on ? ' on' : ''}`,
        title: 'Built in and protected',
        text: `🔒 ${look.name}`,
        'aria-pressed': on ? 'true' : 'false',
        onclick: () => call('POST', `/api/lighting/looks/${encodeURIComponent(look.id)}/recall`, { fadeMs }),
      }));
    }
    scenesGrid.textContent = '';
    for (const sc of view.scenes ?? []) {
      const on = view.active?.type === 'scene' && view.active.slot === sc.slot;
      const tile = el('div', { class: `lt-scene${on ? ' on' : ''}${sc.empty ? ' empty' : ''}` },
        el('div', { class: 'lt-scene-name', text: `${sc.slot} · ${sc.name}` }),
        el('div', { class: 'note', text: sceneCaption(sc) }));
      const row = el('div', { class: 'line nowrap' },
        el('button', { class: 'small primary', text: 'Recall', disabled: sc.empty,
          onclick: () => call('POST', `/api/lighting/scenes/${sc.slot}/recall`, { fadeMs }) }),
        el('button', { class: 'small', text: 'Save', title: 'Save where the lights are now into this scene', onclick: () => saveScene(sc) }),
        el('button', { class: 'small ghost', text: 'Rename', disabled: sc.empty, onclick: () => renameScene(sc) }),
        el('button', { class: 'small ghost', text: 'Clear', disabled: sc.empty, onclick: () => clearScene(sc) }));
      tile.append(row);
      scenesGrid.append(tile);
    }
  }

  async function saveScene(sc) {
    if (!view.known) { toast('Nothing to save yet: set the lights or recall a look first.', 'warn'); return; }
    if (!sc.empty && !confirm(`Replace scene ${sc.slot} “${sc.name}” with where the lights are now?`)) return;
    const r = await call('PUT', `/api/lighting/scenes/${sc.slot}`, {});
    if (r.httpOk) toast(`Scene ${sc.slot} saved`);
  }

  async function renameScene(sc) {
    const name = prompt(`Name for scene ${sc.slot}?`, sc.name);
    if (name === null || name.trim() === sc.name) return;
    await call('PATCH', `/api/lighting/scenes/${sc.slot}`, { name: name.trim() });
  }

  async function clearScene(sc) {
    if (!confirm(`Clear scene ${sc.slot} “${sc.name}”? The lights do not change.`)) return;
    await call('DELETE', `/api/lighting/scenes/${sc.slot}`);
  }

  // --- faders ----------------------------------------------------------------------

  /** One intensity or colour fader with its readout. `onSet` gets the value. */
  function fader(key, { min, max, step, label, format, onSet }) {
    const input = el('input', { type: 'range', min, max, step, 'aria-label': label });
    const out = el('output', { class: 'lt-readout' });
    const send = throttle((v) => onSet(v));
    input.addEventListener('input', () => { hold(key); setText(out, format(Number(input.value))); send(Number(input.value)); });
    input.addEventListener('change', () => { send(Number(input.value)); release(key); });
    input.addEventListener('pointercancel', () => release(key));
    const f = { input, out, show(v) {
      if (!Number.isFinite(v)) { input.disabled = true; setText(out, '—'); return; }
      input.disabled = false;
      if (!held(key) && Number(input.value) !== v) input.value = String(v);
      if (!held(key)) setText(out, format(v));
    } };
    faders.set(key, f);
    return f;
  }

  function nudges(target, { intensity = true, cct = true } = {}) {
    const b = (text, title, values) => el('button', { class: 'small', text, title, onclick: () => set(target, { ...values, relative: true, fadeMs: 300 }) });
    return el('div', { class: 'line nowrap lt-nudge' },
      intensity ? b(`−${NUDGE_PCT}%`, 'Dimmer down', { intensity: -NUDGE_PCT }) : null,
      intensity ? b(`+${NUDGE_PCT}%`, 'Dimmer up', { intensity: NUDGE_PCT }) : null,
      cct ? b('Warmer', `−${NUDGE_K} K`, { cct: -NUDGE_K }) : null,
      cct ? b('Cooler', `+${NUDGE_K} K`, { cct: NUDGE_K }) : null);
  }

  function renderFaders() {
    const live = view.fixtures.filter((f) => f.live);
    const key = JSON.stringify([view.fixtures.map((f) => [f.id, f.name, f.kelvin, f.live, f.errors]), view.groups]);
    if (sig.faders !== key) {
      sig.faders = key;
      faders.clear();
      masterBox.textContent = '';
      groupBox.textContent = '';
      fixtureBox.textContent = '';
      buildMasters(live);
      for (const g of (view.groups ?? []).filter((g) => g !== 'All')) {
        groupBox.append(el('div', { class: 'lt-row lt-group' },
          el('div', { class: 'lt-name', text: g }), nudges({ group: g })));
      }
      for (const f of view.fixtures) buildFixtureRow(f);
    }
    // Values, every view.
    const heading = live.map((f) => f.target ?? {});
    const avg = (p) => {
      const v = heading.map((h) => h[p]).filter(Number.isFinite);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
    };
    faders.get('all:i')?.show(avg('intensity'));
    faders.get('all:k')?.show(avg('cct'));
    for (const f of view.fixtures) {
      faders.get(`${f.id}:i`)?.show(f.intensity);
      faders.get(`${f.id}:k`)?.show(f.cct);
      setText(fixtureBox.querySelector(`[data-dmx="${CSS.escape(f.id)}"]`), f.dmx ? `DMX ${f.dmx.join(' · ')}` : '');
    }
  }

  function buildMasters(live) {
    if (!live.length) {
      masterBox.append(el('div', { class: 'note', text: 'No fixtures are patched and working. Add or fix one under Fixtures.' }));
      return;
    }
    const ranges = live.map((f) => f.kelvin).filter(Boolean);
    const kMin = ranges.length ? Math.min(...ranges.map((r) => r.min)) : null;
    const kMax = ranges.length ? Math.max(...ranges.map((r) => r.max)) : null;
    const i = fader('all:i', { min: 0, max: 100, step: 1, label: 'All lights, dimmer', format: pct,
      onSet: (v) => set({ all: true }, { intensity: v }) });
    const row = el('div', { class: 'lt-row lt-master' }, el('div', { class: 'lt-name', text: 'All' }), i.input, i.out);
    if (kMin !== null) {
      const k = fader('all:k', { min: kMin, max: kMax, step: 10, label: 'All lights, colour temperature', format: kelvin,
        onSet: (v) => set({ all: true }, { cct: v }) });
      add(row, k.input, k.out);
    } else add(row, el('span'), el('span'));
    row.append(el('span'));
    masterBox.append(row,
      el('div', { class: 'line lt-master-tools' },
        nudges({ all: true }, { cct: kMin !== null }),
        kMin !== null ? el('div', { class: 'line nowrap' }, ...CCT_PRESETS.filter((k) => k >= kMin && k <= kMax).map((k) =>
          el('button', { class: 'small', text: `${k} K`, title: `Every light to ${k} K`, onclick: () => set({ all: true }, { cct: k, fadeMs }) }))) : null),
      el('div', { class: 'note', text: 'The All faders set every light to the same value; the buttons move each light from where it is.' }));
  }

  function buildFixtureRow(f) {
    const row = el('div', { class: `lt-row${f.live ? '' : ' lt-off'}` });
    const name = el('div', { class: 'lt-name' }, el('div', { text: f.name }), el('div', { class: 'note mono', 'data-dmx': f.id }));
    if (!f.live) {
      add(row, name, el('div', { class: 'note lt-err', text: f.errors.length ? f.errors.join(' · ') : 'Not in the output.' }));
      fixtureBox.append(row);
      return;
    }
    const i = fader(`${f.id}:i`, { min: 0, max: 100, step: 1, label: `${f.name} dimmer`, format: pct,
      onSet: (v) => set({ fixture: f.id }, { intensity: v }) });
    add(row, name, i.input, i.out);
    if (f.kelvin) {
      const k = fader(`${f.id}:k`, { min: f.kelvin.min, max: f.kelvin.max, step: 10, label: `${f.name} colour temperature`, format: kelvin,
        onSet: (v) => set({ fixture: f.id }, { cct: v }) });
      add(row, k.input, k.out);
    } else add(row, el('span'), el('span'));
    row.append(el('button', { class: 'small ghost', text: 'Identify', title: 'Flash this light for three seconds',
      onclick: async () => {
        const r = await call('POST', `/api/lighting/fixtures/${encodeURIComponent(f.id)}/identify`, { ms: 3000 });
        if (r.httpOk && !r.visible) toast(`Output is ${view.output.state === 'dry-run' ? 'in dry run' : 'not sending'}: ${f.name} will not flash.`, 'warn');
      } }));
    fixtureBox.append(row);
  }

  // --- the patch ---------------------------------------------------------------------

  function renderPatch() {
    const key = JSON.stringify([view.fixtures.map((f) => [f.id, f.name, f.profile, f.ip, f.universe, f.address, f.footprint, f.groups, f.errors]), view.profiles]);
    if (sig.patch === key) return;
    sig.patch = key;
    patchTable.textContent = '';
    patchTable.append(el('tr', {}, ...['Name', 'Type', 'IP address', 'Universe', 'Address', 'Groups', ''].map((t) => el('th', { text: t }))));
    const profileName = (id) => view.profiles?.find((p) => p.id === id)?.name ?? id;
    for (const f of view.fixtures) {
      const span = f.footprint > 1 ? `${f.address}–${f.address + f.footprint - 1}` : `${f.address}`;
      patchTable.append(el('tr', { class: f.errors.length ? 'lt-bad' : '' },
        el('td', {}, el('div', { text: f.name }), ...f.errors.map((e) => el('div', { class: 'note lt-err', text: e }))),
        el('td', { class: 'note', text: profileName(f.profile) }),
        el('td', { class: 'mono', text: f.ip }),
        el('td', { text: String(f.universe) }),
        el('td', { text: span }),
        el('td', { class: 'note', text: (f.groups ?? []).join(', ') }),
        el('td', {}, el('div', { class: 'line nowrap' },
          el('button', { class: 'small', text: 'Edit', onclick: () => openEditor(f) }),
          el('button', { class: 'small ghost', text: 'Duplicate', onclick: () => openEditor(f, { duplicate: true }) }),
          el('button', { class: 'small ghost', text: 'Remove', onclick: () => removeFixture(f) })))));
    }
    if (!view.fixtures.length) patchTable.append(el('tr', {}, el('td', { colspan: 7, class: 'note', text: 'No fixtures. Add one to start.' })));
  }

  async function removeFixture(f) {
    if (!confirm(`Remove ${f.name} from the patch?\n\nThe light itself is not changed; CamBridge stops sending to it.`)) return;
    const r = await call('DELETE', `/api/lighting/fixtures/${encodeURIComponent(f.id)}`);
    if (r.httpOk) toast(`${f.name} removed`);
  }

  function buildEditor() {
    const dialog = el('dialog', { class: 'lt-editor' });
    const title = el('h3');
    const fields = {
      name: el('input', { type: 'text', id: 'lt-f-name', autocomplete: 'off', placeholder: 'e.g. Key left' }),
      profile: el('select', { id: 'lt-f-profile' }),
      ip: el('input', { type: 'text', id: 'lt-f-ip', inputmode: 'decimal', autocomplete: 'off', placeholder: 'e.g. 192.168.220.56' }),
      universe: el('input', { type: 'number', id: 'lt-f-universe', min: 1, max: 63999, step: 1 }),
      address: el('input', { type: 'number', id: 'lt-f-address', min: 1, max: 512, step: 1 }),
      groups: el('input', { type: 'text', id: 'lt-f-groups', autocomplete: 'off', placeholder: 'optional, e.g. Key, Back' }),
    };
    const errs = Object.fromEntries(Object.keys(fields).map((k) => [k, el('div', { class: 'note lt-err', role: 'alert' })]));
    const other = el('div', { class: 'note lt-err', role: 'alert' });
    const freeBtn = el('button', { type: 'button', class: 'small ghost', text: 'Next free', onclick: () => suggest() });
    const grid = el('div', { class: 'formgrid', style: 'margin-top:12px' });
    const labels = { name: 'Name', profile: 'Type', ip: 'IP address', universe: 'Universe', address: 'Start address', groups: 'Groups' };
    for (const [k, input] of Object.entries(fields)) {
      const cell = k === 'address' ? el('div', {}, el('div', { class: 'line nowrap' }, input, freeBtn), errs[k]) : el('div', {}, input, errs[k]);
      grid.append(el('label', { for: input.id, text: labels[k] }), cell);
    }
    const saveBtn = el('button', { class: 'primary', text: 'Save' });
    dialog.append(title,
      el('div', { class: 'sub note', text: 'Address and universe as set on the light. Nothing is saved if anything here is wrong.' }),
      grid, other,
      el('div', { class: 'line', style: 'margin-top:14px;justify-content:flex-end' },
        el('button', { class: 'ghost', text: 'Cancel', onclick: () => dialog.close() }), saveBtn));

    let editing = null;
    const footprint = () => view.profiles?.find((p) => p.id === fields.profile.value)?.footprint
      ?? view.fixtures.find((f) => f.profile === fields.profile.value)?.footprint ?? 2;
    const suggest = () => {
      const u = Number(fields.universe.value) || 1;
      const at = nextFreeAddress(view.fixtures, u, footprint(), editing?.id ?? null);
      if (at) fields.address.value = String(at);
      else setText(errs.address, `Universe ${u} has no room for another ${footprint()}-channel fixture.`);
    };
    const clearErrors = () => { for (const e of Object.values(errs)) setText(e, ''); setText(other, ''); };

    saveBtn.addEventListener('click', async () => {
      clearErrors();
      const body = {
        name: fields.name.value.trim(),
        profile: fields.profile.value,
        ip: fields.ip.value.trim(),
        universe: fields.universe.value === '' ? null : Number(fields.universe.value),
        address: fields.address.value === '' ? null : Number(fields.address.value),
        groups: parseGroups(fields.groups.value),
      };
      saveBtn.disabled = true;
      try {
        const r = editing
          ? await call('PUT', `/api/lighting/fixtures/${encodeURIComponent(editing.id)}`, body, { quiet: true })
          : await call('POST', '/api/lighting/fixtures', body, { quiet: true });
        if (r.httpOk) { dialog.close(); toast(`${body.name} saved`); return; }
        if (r.httpStatus === 400 && r.errors) {
          const { fields: byField, other: rest } = fieldErrors(r.errors, r.fixture ?? editing?.id);
          for (const [k, list] of Object.entries(byField)) if (errs[k]) setText(errs[k], list.join(' '));
          // The other half of an overlap repeats the message already by the field.
          const shown = new Set(Object.entries(byField).filter(([k]) => errs[k]).flatMap(([, l]) => l));
          const extra = [...rest, ...Object.entries(byField).filter(([k]) => !errs[k]).flatMap(([, l]) => l)];
          setText(other, [...new Set(extra.filter((m) => !shown.has(m)))].join(' '));
          return;
        }
        setText(other, r.error ?? `Could not save (${r.httpStatus}).`);
      } finally { saveBtn.disabled = false; }
    });
    fields.profile.addEventListener('change', () => { if (!editing) suggest(); });

    return {
      dialog,
      open(f, { duplicate = false } = {}) {
        editing = duplicate ? null : f;
        clearErrors();
        setText(title, f ? (duplicate ? `Duplicate ${f.name}` : `Edit ${f.name}`) : 'Add fixture');
        fields.profile.textContent = '';
        for (const p of view.profiles ?? []) fields.profile.append(el('option', { value: p.id, text: p.name }));
        const base = f ?? { universe: view.fixtures[0]?.universe ?? 1, profile: view.fixtures[0]?.profile ?? view.profiles?.[0]?.id };
        fields.name.value = duplicate ? `${f.name} copy` : f?.name ?? '';
        fields.profile.value = base.profile ?? '';
        fields.ip.value = duplicate ? '' : f?.ip ?? '';
        fields.universe.value = String(base.universe ?? 1);
        fields.groups.value = (base.groups ?? []).join(', ');
        if (f && !duplicate) fields.address.value = String(f.address);
        else suggest();
        dialog.showModal();
        fields.name.focus();
      },
    };
  }
  const openEditor = (f, o) => editor.open(f, o);

  // --- output settings (admin) ---------------------------------------------------------

  function buildOutputForm() {
    const f = {
      interface: el('input', { type: 'text', id: 'lt-o-if', autocomplete: 'off', placeholder: 'en14' }),
      address: el('input', { type: 'text', id: 'lt-o-addr', inputmode: 'decimal', autocomplete: 'off', placeholder: 'empty: use the interface’s address' }),
      mode: el('select', { id: 'lt-o-mode' }, el('option', { value: 'unicast', text: 'Unicast — to each light’s IP' }), el('option', { value: 'multicast', text: 'Multicast — to the universe group' })),
      priority: el('input', { type: 'number', id: 'lt-o-prio', min: 0, max: 200, step: 1 }),
      sourceName: el('input', { type: 'text', id: 'lt-o-name', autocomplete: 'off', maxlength: 63 }),
    };
    const labels = { interface: 'Interface', address: 'Send from', mode: 'Mode', priority: 'Priority', sourceName: 'Source name' };
    const grid = el('div', { class: 'formgrid' });
    for (const [k, input] of Object.entries(f)) grid.append(el('label', { for: input.id, text: labels[k] }), input);
    const cid = el('div', { class: 'note mono' });
    const msg = el('div', { class: 'note', role: 'status' });
    let dirty = false;
    for (const input of Object.values(f)) input.addEventListener('input', () => { dirty = true; });
    for (const input of Object.values(f)) input.addEventListener('change', () => { dirty = true; });
    const save = el('button', { class: 'small primary', text: 'Save network settings', onclick: async () => {
      const body = {
        interface: f.interface.value.trim(), address: f.address.value.trim(), mode: f.mode.value,
        priority: Number(f.priority.value), sourceName: f.sourceName.value.trim(),
      };
      const r = await call('PUT', '/api/lighting/output', body, { quiet: true });
      if (r.httpOk) { dirty = false; setText(msg, 'Saved.'); update(); return; }
      setText(msg, r.httpStatus === 403 ? 'That needs the admin PIN.' : (r.error ?? 'Could not save.'));
    } });
    const reset = el('button', { class: 'small ghost', text: 'Undo changes', onclick: () => { dirty = false; setText(msg, ''); update(); } });
    const card = el('details', { class: 'card lt-details' },
      el('summary', { text: 'Output network settings' }),
      el('div', { class: 'sub', text: 'Admin. The lights listen for sACN (E1.31) on port 5568; priority 100 is the usual default. Unicast sends each universe to the IPs of the lights in it.' }),
      grid, cid, el('div', { class: 'line', style: 'margin-top:12px' }, save, reset, msg));
    function update() {
      if (!view || view.unavailable) return;
      const o = view.output;
      setText(cid, `CID ${o.cid} · ${o.bound ? `bound to ${o.bound.address}${o.bound.interface ? ` (${o.bound.interface})` : ''}` : 'not bound'} · port ${o.port}`);
      if (dirty || card.contains(document.activeElement)) return;
      f.interface.value = o.interface ?? '';
      f.address.value = o.address ?? '';
      f.mode.value = o.mode;
      f.priority.value = String(o.priority);
      f.sourceName.value = o.sourceName ?? '';
    }
    return { card, update };
  }

  // --- import / export ---------------------------------------------------------------------

  function buildTransfer() {
    const file = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    const scenes = el('input', { type: 'checkbox', id: 'lt-imp-scenes', checked: true });
    const preview = el('div', { class: 'lt-preview' });
    let pending = null;

    const exportBtn = el('button', { class: 'small', text: 'Export…', onclick: async () => {
      const res = await fetch('/api/lighting/export');
      if (!res.ok) { toast(res.status === 403 ? 'Export needs the admin PIN.' : `Export failed (${res.status})`, 'bad'); return; }
      const blob = new Blob([JSON.stringify(await res.json(), null, 2)], { type: 'application/json' });
      const a = el('a', { href: URL.createObjectURL(blob), download: `cambridge-lighting-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } });
    const importBtn = el('button', { class: 'small', text: 'Import…', onclick: () => { file.value = ''; file.click(); } });

    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      preview.textContent = '';
      let doc;
      try { doc = JSON.parse(await chosen.text()); } catch {
        preview.append(el('div', { class: 'note lt-err', text: `${chosen.name} is not a JSON file.` }));
        return;
      }
      const r = await call('POST', '/api/lighting/import', { doc, scenes: scenes.checked }, { quiet: true });
      showPreview(r, doc, chosen.name);
    });

    function showPreview(r, doc, name) {
      preview.textContent = '';
      pending = null;
      if (r.httpStatus === 403) { preview.append(el('div', { class: 'note lt-err', text: 'Import needs the admin PIN.' })); return; }
      if (!r.httpOk) {
        preview.append(el('div', { class: 'note lt-err', text: `${name}: ${r.error}` }));
        for (const e of r.errors ?? []) preview.append(el('div', { class: 'note lt-err', text: `• ${e}` }));
        return;
      }
      pending = doc;
      const bits = [`${r.fixtures} fixture(s)`, `${r.profiles} custom profile(s)`, r.scenes === null ? 'scenes left as they are' : `${r.scenes} scene(s)`];
      preview.append(
        el('div', { class: 'note', text: `${name}: ${bits.join(', ')}. No problems found. Nothing has changed yet.` }),
        el('div', { class: 'line', style: 'margin-top:8px' },
          el('button', { class: 'small primary', text: 'Replace the patch with this', onclick: async () => {
            if (!confirm('Replace the fixtures and profiles (and scenes, if ticked) with this file?')) return;
            const done = await call('POST', '/api/lighting/import', { doc: pending, scenes: scenes.checked, confirm: true });
            if (done.httpOk) { toast('Lighting imported'); preview.textContent = ''; pending = null; }
          } }),
          el('button', { class: 'small ghost', text: 'Cancel', onclick: () => { preview.textContent = ''; pending = null; } })));
    }

    // The one-time move of Companion's scenes (scene1–scene5 custom variables).
    const companion = el('div', { class: 'lt-preview' });
    const companionBtn = el('button', { class: 'small', text: 'Read scenes from Companion…', onclick: () => readCompanion() });

    async function readCompanion() {
      companion.textContent = '';
      companionBtn.disabled = true;
      let r;
      try { r = await call('POST', '/api/lighting/import/companion', {}, { quiet: true }); } finally { companionBtn.disabled = false; }
      if (r.httpStatus === 403) { companion.append(el('div', { class: 'note lt-err', text: 'Reading Companion needs the admin PIN.' })); return; }
      if (!r.httpOk) { companion.append(el('div', { class: 'note lt-err', text: r.error ?? 'Could not read Companion.' })); return; }
      const table = el('table', { class: 'list' },
        el('tr', {}, ...['Scene', 'In Companion', 'Becomes', 'Saved', 'Notes'].map((t) => el('th', { text: t }))));
      for (const s of r.scenes) {
        const becomes = s.importable ? Object.entries(s.dmx).map(([n, v]) => `${n} ${v.join('/')}`).join(' · ') : '—';
        const notes = [...s.problems, s.importable && s.replaces ? `replaces “${s.replaces}”` : null].filter(Boolean);
        table.append(el('tr', { class: s.importable ? '' : 'lt-bad' },
          el('td', { text: String(s.slot) }),
          el('td', { class: 'mono', text: s.raw ?? '(not set)' }),
          el('td', { class: 'mono', text: becomes }),
          el('td', { class: 'note', text: s.saved ?? '' }),
          el('td', { class: 'note', text: notes.join('; ') })));
      }
      companion.append(
        el('div', { class: 'note', text: `Read from Companion at ${r.source}, universe ${r.universe}. Nothing has been written yet.` }),
        el('div', { class: 'tablescroll' }, table));
      if (!r.importable) { companion.append(el('div', { class: 'note lt-err', text: 'None of these can be imported.' })); return; }
      companion.append(el('div', { class: 'line', style: 'margin-top:8px' },
        el('button', { class: 'small primary', text: `Import ${r.importable} scene${r.importable === 1 ? '' : 's'}`, onclick: async () => {
          if (!confirm('Write these scenes into CamBridge? Scenes in the same slots are replaced. Companion is not changed.')) return;
          const done = await call('POST', '/api/lighting/import/companion', { confirm: true });
          if (done.httpOk) { toast(`Imported scene${done.imported.length === 1 ? '' : 's'} ${done.imported.join(', ')} from Companion`); companion.textContent = ''; }
        } }),
        el('button', { class: 'small ghost', text: 'Cancel', onclick: () => { companion.textContent = ''; } })));
    }

    const card = el('details', { class: 'card lt-details' },
      el('summary', { text: 'Import & export' }),
      el('div', { class: 'sub', text: 'Admin. The fixtures, custom fixture types and scenes as one JSON file. An import is checked and shown first; nothing changes until you confirm.' }),
      el('div', { class: 'line' }, exportBtn, importBtn,
        el('label', { class: 'note', for: 'lt-imp-scenes' }, scenes, document.createTextNode(' include scenes')), file),
      preview,
      el('h3', { text: 'Scenes from Companion', style: 'margin-top:16px' }),
      el('div', { class: 'sub', text: 'Once, when moving over: reads Companion’s scene1–scene5 custom variables (read only) and shows what each becomes before anything is written.' }),
      companionBtn, companion);
    return { card, preview };
  }

  // --- fixture types --------------------------------------------------------------------------

  function buildProfiles() {
    const list = el('div', { class: 'lt-profiles' });
    const text = el('textarea', { rows: 8, spellcheck: 'false', class: 'mono', placeholder: '{ "id": "…", "name": "…", "channels": [ { "type": "intensity" }, … ] }' });
    const msg = el('div', { class: 'note', role: 'status' });
    const card = el('details', { class: 'card lt-details' },
      el('summary', { text: 'Fixture types' }),
      el('div', { class: 'sub', text: 'What each fixture type’s DMX channels mean. A new type is a new profile, pasted here as JSON (admin); the built-in ones cannot be changed.' }),
      list,
      el('div', { style: 'margin-top:10px' }, text),
      el('div', { class: 'line', style: 'margin-top:8px' },
        el('button', { class: 'small', text: 'Add fixture type', onclick: async () => {
          let p;
          try { p = JSON.parse(text.value); } catch { setText(msg, 'That is not valid JSON.'); return; }
          const r = await call('POST', '/api/lighting/profiles', p, { quiet: true });
          if (r.httpOk) { text.value = ''; setText(msg, 'Added.'); load(); return; }
          setText(msg, r.httpStatus === 403 ? 'That needs the admin PIN.' : [r.error, ...(r.errors ?? []).map((e) => e.message ?? e)].join(' '));
        } }), msg));
    card.addEventListener('toggle', () => { if (card.open) load(); });

    async function load() {
      const r = await call('GET', '/api/lighting/profiles', undefined, { quiet: true });
      list.textContent = '';
      for (const p of r.profiles ?? []) {
        const channels = p.channels.map((c, i) => {
          const what = c.type === 'cct' ? `CCT ${p.kelvin?.min}–${p.kelvin?.max} K${c.curveVerified === false ? ' (curve not measured)' : ''}`
            : c.type === 'intensity' ? 'Dimmer' : `${c.label ?? 'Fixed'} = ${c.value ?? 0}`;
          return `${i + 1}: ${what}${c.size === 2 ? ' (16-bit)' : ''}`;
        }).join(' · ');
        list.append(el('div', { class: 'lt-profile' },
          el('div', {}, el('strong', { text: p.name }), el('span', { class: 'note mono', text: `  ${p.id}${p.builtIn ? ' · built in' : ''}` })),
          el('div', { class: 'note', text: channels }),
          p.builtIn ? null : el('button', { class: 'small ghost', text: 'Remove', onclick: async () => {
            if (!confirm(`Remove the fixture type “${p.name}”?`)) return;
            const d = await call('DELETE', `/api/lighting/profiles/${encodeURIComponent(p.id)}`);
            if (d.httpOk) load();
          } })));
      }
    }
    return { card };
  }

  return { onView };
}
