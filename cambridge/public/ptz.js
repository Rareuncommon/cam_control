import { containRect, pointToImage } from './scopes.js';

// PTZ heads in the control panel.
//
// A Sony body is a recorder with settings; a PTZ head is also a thing that
// moves. Moving is the part that can go wrong in a way nobody can undo from a
// chair — a head left panning hits its end stop on air — so the rule that
// shapes this file is that motion is never fire-and-forget. A press refreshes
// its velocity while it is held, and every way a press can end (finger up,
// pointer stolen, tab hidden, window blurred, page closed, the card being
// rebuilt underneath it) sends stop. The server's deadman stops the head if
// all of that still fails.
//
// The rest — settings, presets, tracking — is described by the camera's own
// table (GET /api/cameras/:id/schema), so this file is written once against
// that shape rather than once per vendor. A camera shows a control only when
// its table or its capabilities say it has one.

/** Mirrors GROUPS in src/ptz/schema.js — the order the settings sheet uses. */
const GROUPS = [
  ['camera', 'Camera'], ['exposure', 'Exposure'], ['whiteBalance', 'White balance'],
  ['image', 'Image'], ['lens', 'Focus & zoom'], ['ptz', 'Pan / tilt'], ['presets', 'Presets'],
  ['tracking', 'Tracking & framing'], ['videoOut', 'Video output'], ['streaming', 'Streaming'],
  ['audio', 'Audio'], ['tally', 'Tally'], ['network', 'Network'], ['users', 'Users'],
  ['system', 'System'], ['maintenance', 'Maintenance'],
];
const GROUP_LABEL = Object.fromEntries(GROUPS);
const GROUP_ORDER = Object.fromEntries(GROUPS.map(([id], i) => [id, i]));

// While a finger is down the velocity is re-sent this often. The server's
// deadman is 500 ms by default, so three refreshes fit in one window and a
// single dropped request does not stutter the move.
const SEND_EVERY_MS = 150;
// "Someone is looking at this card": the server polls position fast for the
// lease. Renewed well inside its length so a slow request never lets it lapse.
const WATCH_EVERY_MS = 4000;
const WATCH_LEASE_MS = 6000;
// A framing preview, not a monitor. Multiview is where the picture lives; this
// only has to show where the head is pointing, and four of these at ten frames
// a second each would be most of what the heads are asked for.
const PREVIEW_EVERY_MS = 400;

const camPath = (id, rest) => `/api/cameras/${encodeURIComponent(id)}/${rest}`;
const same = (a, b) => String(a) === String(b);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Storage can throw (private mode, blocked site data). A preference that
// cannot be remembered is a preference that resets; it is not a broken panel.
function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* not remembered */ }
}

/**
 * Stick displacement to velocity.
 *
 * A small dead centre so a resting thumb is still, then a curve that is mostly
 * square: the first third of the travel is a crawl, for the slow creep into a
 * close-up, and the last third is where speed is. A linear stick makes the
 * fine moves — the ones that are actually seen on air — the hardest to do.
 */
function shape(m, deadzone = 0.1) {
  if (m <= deadzone) return 0;
  const t = Math.min(1, (m - deadzone) / (1 - deadzone));
  return 0.2 * t + 0.8 * t * t;
}

// The server treats |v| < 0.02 as noise. A fine move at a low speed scale can
// land under that and do nothing, which reads as a dead control; this floor
// keeps the slowest move a move.
const MIN_SPEED = 0.03;
const floorSpeed = (v) => (v === 0 ? 0 : Math.sign(v) * Math.max(Math.abs(v), MIN_SPEED));

export function createPtz(ctx) {
  const { el, add, api, toast, stateBadge, tallyBadge } = ctx;

  // --- motion ---------------------------------------------------------------

  /** Every press currently driving a head, from any control. */
  const holds = new Set();

  /**
   * Motion requests go straight to fetch rather than through api(): a held
   * stick sends several a second, and api() would toast each failure. One
   * explanation per press is the right amount.
   *
   * keepalive so the stop sent from pagehide still leaves the browser.
   */
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      keepalive: true,
      cache: 'no-store',
    });
  }

  /**
   * One press on one head, over some of its axes.
   *
   * Sends the current velocity now and then every SEND_EVERY_MS until end().
   * end() is idempotent and always sends a stop, whatever happened before it:
   * the axes it held are zeroed, and if nothing else is driving that head an
   * explicit stop follows. A move still in flight when the press ends gets a
   * second stop behind it, because two requests on two connections can arrive
   * in either order and the late move must not be the last word.
   */
  class Hold {
    constructor(camId, axes) {
      this.camId = camId;
      this.axes = axes;
      this.v = Object.fromEntries(axes.map((a) => [a, 0]));
      this.lastSentAt = 0;
      this.sentNonZero = false;
      this.inFlight = false;
      this.ended = false;
      this.complained = false;
      holds.add(this);
      this.timer = setInterval(() => this.send(), SEND_EVERY_MS);
    }

    set(v) {
      if (this.ended) return;
      for (const a of this.axes) this.v[a] = Number.isFinite(v[a]) ? clamp(v[a], -1, 1) : 0;
      // Respond to a change straight away rather than on the next tick, but
      // never stack requests: the tick will carry the latest value.
      if (!this.inFlight && Date.now() - this.lastSentAt > 60) this.send();
    }

    send() {
      if (this.ended || this.inFlight) return;
      const nonZero = this.axes.some((a) => this.v[a] !== 0);
      // A centred stick needs saying once, not every tick.
      if (!nonZero && !this.sentNonZero) return;
      this.inFlight = true;
      this.lastSentAt = Date.now();
      this.sentNonZero = nonZero;
      post(camPath(this.camId, 'ptz/move'), { ...this.v })
        .then(async (r) => {
          if (r.status === 401) { location.replace('/login.html'); return; }
          if (!r.ok && !this.complained) {
            this.complained = true;
            const b = await r.json().catch(() => null);
            toast(b?.error ?? `Move refused (${r.status})`, 'bad', 7000);
          }
        })
        .catch(() => { /* the deadman covers a request that never arrived */ })
        .finally(() => {
          this.inFlight = false;
          if (this.ended) this.sendStop();
        });
    }

    end() {
      if (this.ended) return;
      this.ended = true;
      clearInterval(this.timer);
      holds.delete(this);
      this.sendStop();
    }

    sendStop() {
      const zero = Object.fromEntries(this.axes.map((a) => [a, 0]));
      post(camPath(this.camId, 'ptz/move'), zero).catch(() => {});
      const others = [...holds].some((h) => h.camId === this.camId);
      if (!others) post(camPath(this.camId, 'ptz/stop'), {}).catch(() => {});
    }
  }

  function endAllHolds() { for (const h of [...holds]) h.end(); }
  function endHoldsFor(camId) { for (const h of [...holds]) if (h.camId === camId) h.end(); }

  // The ways a press can end without a pointerup reaching us. iPadOS in
  // particular backgrounds a tab mid-gesture when a notification is pulled
  // down, and the finger lifts somewhere this page never hears about.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') endAllHolds();
  });
  window.addEventListener('blur', endAllHolds);
  window.addEventListener('pagehide', endAllHolds);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && holds.size) endAllHolds(); });

  /** The panic button. Ends this panel's presses first so none re-starts a head. */
  async function stopAll() {
    endAllHolds();
    const r = await api('POST', '/api/ptz/stop-all');
    if (!r.httpOk) return;
    // Name any head whose stop was not confirmed: a link that dropped
    // mid-move means that head may still be moving, and it is the one the
    // operator has to deal with now.
    if (r.unconfirmed?.length) toast(`Stop NOT confirmed on ${r.unconfirmed.join(', ')} — check those heads`, 'bad', 12000);
    else toast('Every PTZ head stopped');
  }

  // --- speed ----------------------------------------------------------------

  // One scale for every head, remembered per browser: it is a property of the
  // operator's hands and the shot, not of a camera.
  let speed = clamp(Number(load('cb.ptzSpeed', '60')) || 60, 5, 100);
  const speedListeners = new Set();
  function setSpeed(v) {
    speed = clamp(Math.round(v), 5, 100);
    save('cb.ptzSpeed', String(speed));
    for (const fn of speedListeners) fn();
  }

  // --- state from the server ------------------------------------------------

  let view = { cameras: [] };
  const camById = (id) => view.cameras.find((c) => c.id === id) ?? null;

  /** cameraId -> { data, byId, key, loading, version } */
  const schemas = new Map();
  /** Bumped each time a camera comes (back) to connected, so its table is re-read. */
  const epochs = new Map();
  const lastState = new Map();

  function schemaKey(cam) {
    return `${epochs.get(cam.id) ?? 0}|${JSON.stringify(cam.capabilities ?? null)}`;
  }

  async function ensureSchema(cam) {
    const key = schemaKey(cam);
    const s = schemas.get(cam.id);
    if (s && (s.key === key || s.loading === key)) return;
    schemas.set(cam.id, { ...(s ?? {}), loading: key });
    const r = await api('GET', camPath(cam.id, 'schema'), undefined, { quiet: true });
    const now = schemas.get(cam.id);
    if (now?.loading !== key) return;   // superseded while in flight
    if (r.httpOk && Array.isArray(r.entries)) {
      const entries = r.entries.filter((e) => e.available !== false);
      schemas.set(cam.id, {
        data: { ...r, entries },
        byId: new Map(entries.map((e) => [e.id, e])),
        key, loading: null, version: (s?.version ?? 0) + 1,
      });
    } else {
      // Keep whatever we had; the next reconnect or capability change retries.
      schemas.set(cam.id, { ...(s ?? {}), key, loading: null });
    }
    refreshCam(cam.id);
    if (sheet?.open && sheet.camId === cam.id) renderSheet();
  }

  /** The camera object each id was last seen as; a patch replaces only what changed. */
  const seen = new Map();

  /** Whether this panel needs a camera's table: its card is built, or its sheet is open. */
  const wantsSchema = (id) => cards.has(id) || (sheet?.open && sheet.camId === id);

  /**
   * Called with every pushed view, before the panel renders.
   *
   * A patch for one camera leaves every other camera the same object, so
   * those are skipped by identity: with forty-eight heads this runs several
   * times a second while one of them pans, and the other forty-seven have
   * nothing to say. Tables are read only for cameras something on screen
   * shows — a head nobody has opened is not asked for its schema.
   */
  function onView(next) {
    view = next;
    const ids = new Set();
    let sheetCamChanged = false;
    for (const cam of view.cameras) {
      if (cam.kind !== 'ptz') continue;
      ids.add(cam.id);
      if (seen.get(cam.id) === cam) continue;
      seen.set(cam.id, cam);
      if (sheet?.camId === cam.id) sheetCamChanged = true;
      const prev = lastState.get(cam.id);
      if (cam.state === 'connected' && prev !== 'connected') {
        epochs.set(cam.id, (epochs.get(cam.id) ?? 0) + 1);
      }
      lastState.set(cam.id, cam.state);
      if (wantsSchema(cam.id)) ensureSchema(cam);
    }
    for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id);
    for (const id of [...schemas.keys()]) if (!ids.has(id)) schemas.delete(id);
    for (const [id, c] of cards) if (!ids.has(id)) { c.destroy(); cards.delete(id); }
    if (sheet?.open) {
      // Only when its own camera changed: another head panning is nothing to
      // the sheet, and re-checking every row of it several times a second is.
      if (!ids.has(sheet.camId)) sheet.dlg.close();
      else if (sheetCamChanged) renderSheet();
    }
  }

  const entriesOf = (camId) => schemas.get(camId)?.data?.entries ?? [];
  const entryOf = (camId, id) => schemas.get(camId)?.byId?.get(id) ?? null;
  const isDanger = (e) => !!e.danger && e.danger !== 'none';

  /**
   * The entry that is a cross-vendor function on this camera — one-push AF is
   * `onePushAf` on one head and `OAF` on another — found by the `role` the
   * driver tags it with (ROLES in src/ptz/schema.js). Null when the camera has
   * no such function, and the control that would use it is simply not drawn.
   */
  function roleOf(camId, role) {
    return entriesOf(camId).find((e) => e.role === role && !isDanger(e)) ?? null;
  }

  /**
   * On/off for an entry that is either a bool or a two-valued enum
   * (`onValue`/`offValue`, or `autoValue`/`manualValue` for focus).
   */
  function twoState(entry, prop, onKey, offKey) {
    if (entry.type === 'bool') {
      const on = prop ? (prop.raw === true || prop.raw === 1 || prop.raw === '1') : null;
      return { on, onValue: true, offValue: false };
    }
    const onValue = entry[onKey];
    const offValue = entry[offKey];
    if (onValue === undefined || offValue === undefined) return null;
    return { on: prop ? same(prop.raw, onValue) : null, onValue, offValue };
  }

  // --- generic table controls ----------------------------------------------

  /**
   * Keeps a container's rows in step with a list, rebuilding only rows whose
   * signature changed.
   *
   * Position updates arrive several times a second while a head moves, and
   * rebuilding every control on each one would close an open dropdown, drop a
   * half-typed value and — worst — tear a held button out from under a finger.
   * A row being used (focused field, or marked busy by a held button) is left
   * alone and catches up on the next push after it is let go.
   */
  function keyedRows(box, items) {
    const existing = new Map();
    for (const ch of [...box.children]) existing.set(ch.dataset.k, ch);
    let i = 0;
    for (const it of items) {
      let node = existing.get(it.key);
      existing.delete(it.key);
      if (!node || (node.dataset.sig !== it.sig && !inUse(node))) {
        const fresh = it.build();
        fresh.dataset.k = it.key;
        fresh.dataset.sig = it.sig;
        if (node) node.replaceWith(fresh);
        node = fresh;
      }
      if (box.children[i] !== node) box.insertBefore(node, box.children[i] ?? null);
      i += 1;
    }
    for (const n of existing.values()) n.remove();
  }

  function inUse(node) {
    if (node.dataset.busy) return true;
    const a = document.activeElement;
    return !!(a && node.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
  }

  /** Whether a write to this entry can be attempted right now. */
  function liveFor(cam, entry) {
    if (cam?.state !== 'connected' || entry.readOnly) return false;
    if (entry.type === 'action') return true;
    const p = cam.properties?.[entry.id];
    return !!p && p.writable !== false;
  }

  function optionsFor(entry, prop) {
    // A camera that narrows a list at run time sends the narrowed list with the
    // value; otherwise the table's list is the whole story.
    if (prop?.options?.length) return prop.options.map((o) => ({ value: o.raw, label: o.label }));
    return entry.options ?? [];
  }

  function rangeOf(entry, prop) { return entry.range ?? prop?.range ?? null; }

  function rangeLabel(entry, prop, v) {
    const r = rangeOf(entry, prop);
    if (!Number.isFinite(v)) return '—';
    const decimals = String(r?.step ?? 1).split('.')[1]?.length ?? 0;
    return `${v.toFixed(decimals)}${r?.unit ?? ''}`;
  }

  /** Sends only the latest value, one request at a time. */
  function coalesce(send) {
    let inflight = false;
    let pending = null;
    const pump = async () => {
      while (pending) {
        const { v } = pending;
        pending = null;
        inflight = true;
        try { await send(v); } finally { inflight = false; }
      }
    };
    return (v) => { pending = { v }; if (!inflight) pump(); };
  }

  /**
   * A button that repeats while held. Marks its row busy so a push does not
   * rebuild the row — and orphan the repeat — mid-press.
   */
  function repeatButton(label, aria, onStep, disabled) {
    let timer = null;
    let rowEl = null;
    const stop = () => {
      clearTimeout(timer); clearInterval(timer); timer = null;
      if (rowEl) { delete rowEl.dataset.busy; rowEl = null; }
    };
    const b = el('button', { disabled, 'aria-label': aria, class: 'rep' }, document.createTextNode(label));
    b.addEventListener('pointerdown', (e) => {
      if (b.disabled) return;
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch { /* fine without */ }
      rowEl = b.closest('[data-k]');
      if (rowEl) rowEl.dataset.busy = '1';
      onStep();
      timer = setTimeout(() => {
        timer = setInterval(() => { if (!b.isConnected) return stop(); onStep(); }, 110);
      }, 420);
    });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(t, stop);
    // Keyboard and assistive-tech presses arrive as a click with no pointer.
    b.addEventListener('click', (e) => { if (e.detail === 0) onStep(); });
    return b;
  }

  /**
   * The control for one table entry. `write(value)` decides where the value
   * goes — the ordinary property route, or the admin confirmation.
   */
  function entryControl(cam, entry, { write, admin = false } = {}) {
    const prop = cam.properties?.[entry.id];
    const live = liveFor(cam, entry) || (admin && cam.state === 'connected' && !entry.readOnly);
    const send = write ?? ((v) => setValue(cam, entry, v));

    if (entry.readOnly) {
      return el('span', { class: 'ptz-ro', text: prop?.label ?? '—' });
    }

    switch (entry.type) {
      case 'action':
        return el('button', {
          class: admin ? 'small danger' : 'small', disabled: !live,
          onclick: () => send(undefined),
        }, document.createTextNode(admin ? `${entry.label}…` : entry.label));

      case 'bool': {
        const on = prop?.raw === true || prop?.raw === 1 || prop?.raw === '1';
        return el('button', {
          class: on ? 'primary small toggle' : 'small toggle', disabled: !live || !prop,
          'aria-pressed': on ? 'true' : 'false',
          onclick: () => send(!on),
        }, document.createTextNode(prop ? (on ? 'On' : 'Off') : '—'));
      }

      case 'enum': {
        const opts = optionsFor(entry, prop);
        const short = opts.length <= 4 && opts.reduce((n, o) => n + String(o.label).length, 0) <= 30;
        if (short) {
          const seg = el('div', { class: 'seg', role: 'group', 'aria-label': entry.label });
          for (const o of opts) {
            const current = prop && same(o.value, prop.raw);
            seg.append(el('button', {
              class: current ? 'small primary' : 'small', disabled: !live,
              'aria-pressed': current ? 'true' : 'false',
              onclick: () => { if (!current) send(o.value); },
            }, document.createTextNode(o.label)));
          }
          return seg;
        }
        const sel = el('select', { disabled: !live, 'aria-label': entry.label });
        if (!prop || !opts.some((o) => same(o.value, prop.raw))) {
          sel.append(el('option', { value: '' }, document.createTextNode(prop?.label ?? '—')));
        }
        for (const o of opts) {
          sel.append(el('option', { value: String(o.value), selected: prop && same(o.value, prop.raw) },
            document.createTextNode(o.label)));
        }
        sel.addEventListener('change', () => {
          const o = opts.find((x) => same(x.value, sel.value));
          // Let go of the select so the next push can redraw it; a focused
          // control is deliberately left alone by keyedRows.
          sel.blur();
          if (o) send(o.value);
        });
        return sel;
      }

      case 'range': {
        const r = rangeOf(entry, prop);
        if (!r) return el('span', { class: 'ptz-ro', text: prop?.label ?? '—' });
        const step = r.step || 1;
        const decimals = String(step).split('.')[1]?.length ?? 0;
        let shown = Number(prop?.raw);
        const readout = el('button', {
          class: 'readout', disabled: !live,
          title: live ? 'Tap to type or slide to a value' : '',
        }, document.createTextNode(rangeLabel(entry, prop, shown)));
        const writer = admin ? send : coalesce((v) => send(v));
        const bump = (dir) => {
          const base = Number.isFinite(shown) ? shown : r.min;
          const next = Number(clamp(base + dir * step, r.min, r.max).toFixed(decimals));
          if (next === shown) return;
          shown = next;
          readout.textContent = rangeLabel(entry, prop, next);
          if (!admin) writer(next);
        };
        readout.addEventListener('click', async () => {
          const v = await askNumber({
            title: `${cam.label} — ${entry.label}`, min: r.min, max: r.max, step,
            unit: r.unit ?? '', value: Number.isFinite(shown) ? shown : r.min,
          });
          if (v !== null) send(v);
        });
        if (admin) {
          // One deliberate value through the confirmation, not a stream of
          // confirmations from a held +.
          return el('div', { class: 'ptz-range' }, readout);
        }
        return el('div', { class: 'ptz-range' },
          repeatButton('−', `${entry.label} down`, () => bump(-1), !live),
          readout,
          repeatButton('+', `${entry.label} up`, () => bump(1), !live));
      }

      case 'text': {
        const secret = entry.secret || entry.writeOnly;
        const input = el('input', {
          type: secret ? 'password' : 'text', disabled: !live,
          autocomplete: secret ? 'new-password' : 'off',
          placeholder: secret ? 'new value' : '',
          maxlength: entry.maxLength ?? null,
          'aria-label': entry.label,
        });
        if (!secret) input.value = prop?.raw ?? '';
        const go = () => {
          const v = input.value;
          if (secret && !v) return;
          input.blur();
          send(v);
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        return el('div', { class: 'ptz-text' }, input,
          el('button', { class: admin ? 'small danger' : 'small', disabled: !live, onclick: go },
            document.createTextNode(admin ? 'Change…' : 'Set')));
      }

      default:
        return el('span', { class: 'ptz-ro', text: prop?.label ?? '—' });
    }
  }

  async function setValue(cam, entry, value) {
    if (entry.type === 'action') {
      return api('POST', camPath(cam.id, `actions/${encodeURIComponent(entry.id)}`));
    }
    return api('PUT', camPath(cam.id, `properties/${encodeURIComponent(entry.id)}`), { value });
  }

  /**
   * "Iris mode is Auto — Set Manual". The same move the Sony cards make: a
   * control that cannot be changed says why, and offers the switch.
   */
  function gateNote(cam, entry) {
    if (!entry.gate) return null;
    const g = cam.properties?.[entry.gate.id];
    if (!g || same(g.raw, entry.gate.value)) return null;
    const ge = entryOf(cam.id, entry.gate.id);
    const target = ge?.options?.find((o) => same(o.value, entry.gate.value))?.label
      ?? (ge?.type === 'bool' ? (entry.gate.value ? 'On' : 'Off') : String(entry.gate.value));
    return el('div', { class: 'gate' },
      el('span', { class: 'note', text: `${ge?.label ?? entry.gate.id} is ${g.label}` }),
      el('button', {
        class: 'small', disabled: !(g.writable !== false && cam.state === 'connected'),
        onclick: () => api('PUT', camPath(cam.id, `properties/${encodeURIComponent(entry.gate.id)}`),
          { value: entry.gate.value }),
      }, document.createTextNode(`Set ${target}`)));
  }

  /** What a row depends on, so it is rebuilt when — and only when — that changes. */
  function rowSig(cam, entry) {
    const p = cam.properties?.[entry.id];
    const g = entry.gate ? cam.properties?.[entry.gate.id] : null;
    return JSON.stringify([cam.state, p?.raw, p?.label, p?.writable, p?.options?.length,
      g?.raw, g?.label, g?.writable]);
  }

  /** A compact Operate row: label, control, and the gate note under it. */
  function operateRow(cam, entry) {
    const wrap = el('div', { class: 'ptz-op' });
    if (entry.type === 'action') {
      wrap.classList.add('action');
      wrap.append(entryControl(cam, entry));
      return wrap;
    }
    add(wrap,
      el('div', { class: 'row' },
        el('label', { text: entry.label, title: entry.help ?? '' }),
        entryControl(cam, entry)),
      gateNote(cam, entry));
    return wrap;
  }

  /** AF / MF and one-push AF on one line, beside the focus rail. */
  function focusRow(cam, modeEntry, onePush) {
    const ctl = el('div', { class: 'ptz-afrow' });
    if (modeEntry) {
      const prop = cam.properties?.[modeEntry.id];
      const two = twoState(modeEntry, prop, 'autoValue', 'manualValue');
      if (two) {
        const live = liveFor(cam, modeEntry);
        const seg = el('div', { class: 'seg', role: 'group', 'aria-label': modeEntry.label });
        for (const [text, value, on] of [['AF', two.onValue, two.on === true], ['MF', two.offValue, two.on === false]]) {
          seg.append(el('button', {
            class: on ? 'small primary' : 'small', disabled: !live, 'aria-pressed': on ? 'true' : 'false',
            title: `${modeEntry.label}: ${text === 'AF' ? 'automatic' : 'manual'}`,
            onclick: () => { if (!on) setValue(cam, modeEntry, value); },
          }, document.createTextNode(text)));
        }
        ctl.append(seg);
      } else {
        ctl.append(entryControl(cam, modeEntry));
      }
    }
    if (onePush) {
      ctl.append(el('button', {
        class: 'small', disabled: cam.state !== 'connected', title: onePush.help ?? 'Focus once, then hold',
        onclick: () => setValue(cam, onePush),
      }, document.createTextNode(onePush.label)));
    }
    return el('div', { class: 'ptz-op' }, el('div', { class: 'row' }, el('label', { text: 'Focus' }), ctl));
  }

  /** The tracking switch: one wide button that says what it is doing. */
  function trackingSwitch(cam, entry) {
    const prop = cam.properties?.[entry.id];
    const two = twoState(entry, prop, 'onValue', 'offValue');
    if (!two) return operateRow(cam, entry);
    const on = two.on === true;
    return el('div', { class: 'ptz-op' }, el('button', {
      class: on ? 'primary big' : 'big', disabled: !liveFor(cam, entry),
      'aria-pressed': on ? 'true' : 'false', style: 'width:100%',
      onclick: () => setValue(cam, entry, on ? two.offValue : two.onValue),
    }, document.createTextNode(!prop ? `${entry.label}: —`
      : on ? '● Following — tap to stop' : `Start ${entry.label.toLowerCase()}`)));
  }

  function rowItems(cam, entries) {
    return entries.map((e) => ({
      key: e.id, sig: rowSig(cam, e) + schemas.get(cam.id)?.version,
      build: () => operateRow(cam, e),
    }));
  }

  // --- the Operate card -----------------------------------------------------

  /** cameraId -> card controller. Cards persist across pushes; see keyedRows. */
  const cards = new Map();

  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((list) => {
      for (const e of list) {
        const c = cards.get(e.target.dataset.id);
        if (!c) continue;
        const was = c.visible;
        c.visible = e.isIntersecting;
        if (c.visible && !was) leaseNow(c);
      }
    })
    : null;

  /**
   * The card for a camera, built once and updated in place thereafter.
   *
   * Skipped outright when nothing it shows can have changed: the same camera
   * object (a patch replaces only the cameras it names), the same undo entry
   * and the same gamepad target. Tables and presets arriving later update the
   * card through refreshCam, which does not come through here.
   */
  function card(cam) {
    let c = cards.get(cam.id);
    if (!c) {
      c = makeCard(cam.id);
      cards.set(cam.id, c);
      ensureSchema(cam);
    }
    const undo = ctx.undo(cam.id);
    const pad = ctx.padDrives(cam.id);
    if (c.cam === cam && c.seenUndo === undo && c.seenPad === pad) return c.node;
    c.seenUndo = undo;
    c.seenPad = pad;
    c.update(cam);
    return c.node;
  }

  /**
   * Takes down every card not in `ids`: its holds end (sending stop), its
   * picture stops polling and its watch lease lapses. The selected-camera
   * layout calls this as the selection moves, so only the heads on screen
   * cost anything.
   */
  function keepOnly(ids) {
    for (const [id, c] of cards) if (!ids.has(id)) { c.destroy(); cards.delete(id); }
  }

  /** Whether any press on this panel is driving the head. */
  const holding = (camId) => [...holds].some((h) => h.camId === camId);

  /** "Lectern" for preset 3, when this panel has read that camera's presets. */
  function presetName(camId, n) {
    return presetData.get(camId)?.presets?.find((p) => p.n === n)?.name ?? null;
  }

  function refreshCam(id) {
    const c = cards.get(id);
    const cam = camById(id);
    if (c && cam) c.update(cam);
  }

  function makeCard(id) {
    const node = el('section', { class: 'cam ptzcam', 'data-id': id });
    const header = el('header');
    const body = el('div', { class: 'body' });
    node.append(header, body);

    const c = {
      node, cam: null, visible: !io, dead: false, gen: 0,
      bodyKey: null, headerSig: null, parts: null,
      presetMode: 'recall', presetsExpanded: false,
      update, destroy,
    };
    io?.observe(node);
    // A select or text field let go: catch up with whatever arrived meanwhile.
    body.addEventListener('focusout', () => setTimeout(() => { if (c.cam) update(camById(id) ?? c.cam); }, 0));

    function destroy() {
      c.dead = true;
      c.gen += 1;
      endHoldsFor(id);
      io?.unobserve(node);
      node.remove();
    }

    function update(cam) {
      c.cam = cam;
      const tally = cam.tally?.program ? ' pgm' : cam.tally?.preview ? ' pvw' : '';
      node.className = `cam ptzcam${cam.state === 'connected' ? '' : ' offline'}${tally}`;
      renderHeader(cam);

      const sch = schemas.get(id);
      const mode = cam.state !== 'connected' ? `offline|${cam.state}|${cam.detail ?? ''}`
        : sch?.data ? `live|${sch.version}|${JSON.stringify(cam.capabilities ?? null)}`
          : 'loading';
      if (mode !== c.bodyKey) {
        // Whatever was being held belongs to the controls about to go.
        endHoldsFor(id);
        c.gen += 1;
        body.textContent = '';
        c.parts = null;
        c.bodyKey = mode;
        if (mode.startsWith('offline')) buildOffline(cam);
        else if (mode === 'loading') {
          body.append(el('div', { class: 'note', text: 'Reading this camera’s settings…' }));
        } else buildLive(cam);
      }
      if (c.parts) refreshLive(cam);
    }

    function renderHeader(cam) {
      const sig = JSON.stringify([cam.label, cam.model, cam.ip, cam.vendor, cam.state, cam.detail,
        cam.reconnectAttempts, cam.tally, cam.ptz?.tracking, cam.ptz?.moving,
        !!cam.capabilities?.tracking, ctx.padDrives(cam.id)]);
      if (sig === c.headerSig) return;
      c.headerSig = sig;
      header.textContent = '';
      add(header,
        el('span', { class: `recdot ptzdot${cam.ptz?.moving ? ' moving' : ''}`,
          title: cam.ptz?.moving ? 'Moving' : 'Still' }),
        el('div', { class: 'ptz-title' },
          el('h2', { text: cam.label || cam.id }),
          el('div', { class: 'meta', text: `${cam.model || cam.vendor || 'PTZ'} · ${cam.ip || '—'}` })),
        el('span', { class: 'spacer' }),
        cam.capabilities?.tracking && cam.ptz?.tracking
          ? el('span', { class: 'pill ok', text: 'TRACKING', title: cam.capabilities.tracking.label })
          : null,
        tallyBadge(cam),
        ctx.padDrives(cam.id) ? el('span', { class: 'pill', text: '🎮' }) : null,
        stateBadge(cam),
        el('button', {
          class: 'small ghost', title: `Every setting on ${cam.label}`,
          onclick: () => openSettings(id),
        }, document.createTextNode('Settings')));
    }

    function buildOffline(cam) {
      add(body,
        el('div', { class: 'note', text: cam.detail || 'No live values while disconnected.' }),
        el('div', { class: 'note', text: cam.state === 'unauthorized'
          ? 'Check the username and password in Setup.'
          : 'CamBridge keeps trying on its own; Reconnect tries now. If the address changed, edit it in Setup.' }),
        el('div', { class: 'btnrow' },
          // Cuts the backoff short — for someone who has just plugged the
          // camera back in and does not want to wait out the next retry.
          el('button', { class: 'small', onclick: () => api('POST', `/api/cameras/${encodeURIComponent(id)}/actions/reconnect`) },
            document.createTextNode('Reconnect')),
          el('button', { class: 'small', onclick: () => ctx.switchView('setup') },
            document.createTextNode('Setup')),
          el('button', { class: 'small', onclick: () => openSettings(id) },
            document.createTextNode('Settings'))));
    }

    function buildLive(cam) {
      const caps = cam.capabilities ?? {};
      const gen = c.gen;
      const p = {};
      // Picture, stick and rails share one grid: side by side on a card wide
      // enough (the stick beside a small picture, so both fit on an iPad
      // screen at once), stacked picture-first on a phone. See .ptz-motion.
      const motion = el('div', { class: `ptz-motion${caps.panTilt ? '' : ' nostick'}` });

      if (caps.snapshot) {
        p.canvas = el('canvas', { class: 'feedcanvas', role: 'img', 'aria-label': `${cam.label} picture`,
          title: caps.pointToCentre ? 'Tap to aim here' : '' });
        p.previewNote = el('div', { class: 'placeholder', text: 'Waiting for a picture…' });
        p.preview = el('div', { class: 'ptz-preview' }, p.canvas, p.previewNote);
        if (caps.pointToCentre) {
          p.canvas.addEventListener('click', (e) => aimFromEvent(c.cam, p.canvas, p.preview, e));
        }
        motion.append(p.preview);
        previewLoop(c, p, gen);
      }

      if (caps.panTilt) {
        p.stickCol = el('div', { class: 'ptz-stickcol' });
        p.stick = joystick(id);
        p.posText = el('div', { class: 'note ptz-pos' });
        p.ptzBox = el('div', { class: 'ptz-btns' });
        add(p.stickCol, p.stick, p.posText, p.ptzBox);
        motion.append(p.stickCol);
      }
      const rails = el('div', { class: 'ptz-railcol' });
      if (caps.zoom) {
        p.zoomRail = rail(id, 'zoom', { minus: 'Wide', plus: 'Tele', name: 'Zoom' });
        rails.append(p.zoomRail.node);
      }
      if (caps.focus) {
        p.focusRail = rail(id, 'focus', { minus: 'Near', plus: 'Far', name: 'Focus' });
        rails.append(p.focusRail.node);
      }
      p.lensBox = el('div', { class: 'ptz-rows' });
      rails.append(p.lensBox);
      if (caps.panTilt || caps.zoom || caps.focus) rails.append(speedRow());
      if (!caps.panTilt) p.ptzBox = el('div', { class: 'ptz-btns' });
      if (!caps.panTilt) rails.append(p.ptzBox);
      motion.append(rails);
      body.append(motion);

      if (caps.presets > 0) {
        p.presetSec = el('div', { class: 'ptz-sec' });
        body.append(p.presetSec);
        loadPresets(id);
      }
      if (caps.tracking) {
        p.trackSec = el('div', { class: 'ptz-sec ptz-track' });
        p.trackHead = el('div', { class: 'ptz-sechead' });
        p.trackBox = el('div', { class: 'ptz-rows' });
        p.trackSec.append(p.trackHead, p.trackBox);
        body.append(p.trackSec);
      }
      p.opBox = el('div', { class: 'ptz-rows ptz-operate' });
      body.append(p.opBox);
      p.foot = el('div', { class: 'btnrow ptz-foot' });
      body.append(p.foot);
      c.parts = p;
    }

    function refreshLive(cam) {
      const p = c.parts;
      const caps = cam.capabilities ?? {};
      const entries = entriesOf(id).filter((e) => !isDanger(e));
      const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—');

      if (p.posText) p.posText.textContent = `Pan ${pct(cam.ptz?.pan)} · Tilt ${pct(cam.ptz?.tilt)}`;
      p.zoomRail?.setReadout(`Zoom ${pct(cam.ptz?.zoom)}`);
      p.focusRail?.setReadout('Focus');

      // Functions found by role go beside the control they belong to, wherever
      // the vendor's table happened to file them.
      const focusMode = roleOf(id, 'focusMode');
      const onePush = roleOf(id, 'onePushAf');
      const home = roleOf(id, 'home');
      const trackOn = caps.tracking ? roleOf(id, 'trackingEnabled') : null;
      const placedIds = new Set([focusMode, onePush, home, trackOn].filter(Boolean).map((e) => e.id));

      const lensItems = [];
      if (focusMode || onePush) {
        lensItems.push({
          key: 'role:focus',
          sig: JSON.stringify([focusMode && rowSig(cam, focusMode), onePush?.id, cam.state, schemas.get(id)?.version]),
          build: () => focusRow(cam, focusMode, onePush),
        });
      }
      lensItems.push(...rowItems(cam, entries.filter((e) => e.operate && e.group === 'lens' && !placedIds.has(e.id))));
      keyedRows(p.lensBox, lensItems);

      const ptzItems = [];
      if (home) {
        ptzItems.push({
          key: 'role:home', sig: `${cam.state}|${home.id}`,
          build: () => el('button', {
            class: 'small', disabled: cam.state !== 'connected', title: home.help ?? 'Send the head to its home position',
            onclick: () => setValue(cam, home),
          }, document.createTextNode(`⌂ ${home.label}`)),
        });
      }
      ptzItems.push(...rowItems(cam, entries.filter((e) => e.operate && e.group === 'ptz' && !placedIds.has(e.id))));
      keyedRows(p.ptzBox, ptzItems);

      if (p.presetSec) renderPresets(c, cam);

      if (p.trackSec) {
        const label = caps.tracking?.label ?? 'Tracking';
        const on = cam.ptz?.tracking;
        // The switch says on or off itself; the heading only needs to when
        // this camera has no switch the panel can find.
        const sig = `${label}|${on}|${!!trackOn}`;
        if (p.trackHead.dataset.sig !== sig) {
          p.trackHead.dataset.sig = sig;
          p.trackHead.textContent = '';
          add(p.trackHead, el('span', { text: label }),
            trackOn ? null
              : on === true ? el('span', { class: 'pill ok', text: 'following' })
                : on === false ? el('span', { class: 'pill', text: 'off' }) : null);
        }
        // The on/off switch first and big, then everything else the table
        // files under tracking that is safe on a shoot. The block is this
        // camera's framing feature, so its few settings belong together here
        // rather than split between card and sheet.
        const trackItems = [];
        if (trackOn) {
          trackItems.push({
            key: 'role:tracking', sig: rowSig(cam, trackOn) + schemas.get(id)?.version,
            build: () => trackingSwitch(cam, trackOn),
          });
        }
        const targetRole = roleOf(id, 'trackingTarget');
        const rest = entries.filter((e) => !placedIds.has(e.id)
          && (e.group === 'tracking' || e === targetRole));
        trackItems.push(...rowItems(cam, rest));
        keyedRows(p.trackBox, trackItems);
        for (const e of rest) placedIds.add(e.id);
      }

      // The rest of what the table marks as operate, by group, with a small
      // heading where the group changes.
      const placed = new Set(['lens', 'ptz', 'tracking', 'presets']);
      const ops = entries.filter((e) => e.operate && !placed.has(e.group) && !placedIds.has(e.id))
        .sort((a, b) => (GROUP_ORDER[a.group] ?? 99) - (GROUP_ORDER[b.group] ?? 99));
      const items = [];
      let lastGroup = null;
      for (const e of ops) {
        if (e.group !== lastGroup) {
          lastGroup = e.group;
          const text = GROUP_LABEL[e.group] ?? e.group;
          items.push({ key: `h:${e.group}`, sig: text, build: () => el('h4', { class: 'ptz-grouphead', text }) });
        }
        items.push(...rowItems(cam, [e]));
      }
      keyedRows(p.opBox, items);

      const u = ctx.undo(id);
      const undoSig = JSON.stringify(u?.last ?? null) + (u?.hasMark ? 'm' : '');
      if (p.foot.dataset.sig !== undoSig) {
        p.foot.dataset.sig = undoSig;
        p.foot.textContent = '';
        if (u?.last) {
          const label = entryOf(id, u.last.prop)?.label ?? u.last.prop;
          p.foot.append(el('button', {
            class: 'small ghost', text: `Undo ${label}`,
            title: `Put ${label} back to what it was before the last change`,
            onclick: () => api('POST', camPath(id, 'undo')),
          }));
        }
      }
    }

    return c;
  }

  /** Small framing picture, polled while the card is actually on screen. */
  function previewLoop(c, p, gen) {
    const g2d = p.canvas.getContext('2d');
    let failures = 0;
    const tick = async () => {
      if (c.dead || c.gen !== gen) return;
      const ready = c.visible && ctx.controlActive() && document.visibilityState === 'visible'
        && c.cam?.state === 'connected';
      if (!ready) { setTimeout(tick, 700); return; }
      try {
        const r = await fetch(camPath(c.cam.id, 'liveview?single=1'), { cache: 'no-store' });
        if (!r.ok) {
          const b = await r.json().catch(() => null);
          throw new Error(b?.error ?? `HTTP ${r.status}`);
        }
        const bitmap = await createImageBitmap(await r.blob());
        if (c.dead || c.gen !== gen) { bitmap.close(); return; }
        if (p.canvas.width !== bitmap.width || p.canvas.height !== bitmap.height) {
          p.canvas.width = bitmap.width;
          p.canvas.height = bitmap.height;
        }
        g2d.drawImage(bitmap, 0, 0);
        bitmap.close();
        failures = 0;
        p.previewNote.style.display = 'none';
      } catch (err) {
        if (++failures >= 3) {
          p.previewNote.textContent = `No picture: ${err.message}`;
          p.previewNote.style.display = 'flex';
        }
      }
      setTimeout(tick, failures >= 3 ? 2000 : PREVIEW_EVERY_MS);
    };
    tick();
  }

  // --- aiming at a point in the picture -------------------------------------

  const cannotAim = new Set();

  /** Re-centre the head on a point (0..1 in the picture). */
  async function aim(cam, point) {
    if (!cam.capabilities?.pointToCentre) {
      // Once per camera: tapping a tile twenty times should not stack twenty toasts.
      if (!cannotAim.has(cam.id)) {
        cannotAim.add(cam.id);
        toast(`${cam.label} cannot aim at a point in the picture — use the joystick on Control.`, 'warn', 7000);
      }
      return;
    }
    const r = await api('POST', camPath(cam.id, 'ptz/point'), point, { quiet: true });
    if (!r.httpOk) toast(r.error ?? `${cam.label} could not aim there`, 'bad', 7000);
  }

  function aimFromEvent(cam, canvas, holder, e) {
    if (!cam) return;
    const r = canvas.getBoundingClientRect();
    const point = pointToImage(e.clientX - r.left, e.clientY - r.top, r.width, r.height,
      canvas.width, canvas.height);
    if (!point) return;   // a letterbox bar is not a place in the picture
    const box = containRect(r.width, r.height, canvas.width, canvas.height);
    const mark = el('div', { class: 'tapmark' });
    mark.style.left = `${box.x + point.x * box.w}px`;
    mark.style.top = `${box.y + point.y * box.h}px`;
    holder.append(mark);
    setTimeout(() => mark.remove(), 1100);
    aim(cam, point);
  }

  // --- joystick and rails ---------------------------------------------------

  const isLive = (id) => camById(id)?.state === 'connected';

  /**
   * Pan/tilt pad. Displacement from the centre is velocity, the way a real
   * PTZ joystick works: hold off-centre to keep moving, let go to stop.
   *
   * Pointer capture keeps the drag ours when a finger slides off the pad,
   * and is also what tells us — through lostpointercapture — when the browser
   * takes the pointer away for its own gesture.
   */
  function joystick(camId) {
    const puck = el('div', { class: 'puck' });
    const pad = el('div', {
      class: 'ptz-stick', role: 'application', tabindex: '0',
      'aria-label': 'Pan and tilt: hold and drag away from the centre; arrow keys nudge',
    }, el('div', { class: 'ring' }), el('div', { class: 'cross' }), puck);
    let pointer = null;
    let hold = null;

    const finish = () => {
      if (pointer === null) return;
      pointer = null;
      hold?.end();
      hold = null;
      puck.style.transform = '';
      pad.classList.remove('active');
    };

    const track = (e) => {
      const r = pad.getBoundingClientRect();
      const R = r.width / 2;
      const dx = (e.clientX - (r.left + R)) / R;
      const dy = (e.clientY - (r.top + r.height / 2)) / R;
      const m = Math.hypot(dx, dy);
      const mm = Math.min(m, 1);
      const ux = m ? dx / m : 0;
      const uy = m ? dy / m : 0;
      puck.style.transform = `translate(${ux * mm * R * 0.72}px, ${uy * mm * R * 0.72}px)`;
      const out = shape(mm) * (speed / 100);
      // Within a few degrees of an axis is a request for a pure pan or a pure
      // tilt; a thumb is never perfectly level, and a slow drift in the other
      // axis spoils exactly the moves that are meant to be clean.
      const pan = Math.abs(ux) < 0.2 ? 0 : floorSpeed(out * ux);
      const tilt = Math.abs(uy) < 0.2 ? 0 : floorSpeed(-out * uy);
      hold?.set({ pan: out ? pan : 0, tilt: out ? tilt : 0 });
    };

    pad.addEventListener('pointerdown', (e) => {
      if (pointer !== null || !isLive(camId)) return;
      e.preventDefault();
      pointer = e.pointerId;
      try { pad.setPointerCapture(e.pointerId); } catch { /* still works within the pad */ }
      pad.classList.add('active');
      hold = new Hold(camId, ['pan', 'tilt']);
      track(e);
    });
    pad.addEventListener('pointermove', (e) => { if (e.pointerId === pointer) track(e); });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      pad.addEventListener(t, (e) => { if (e.pointerId === pointer) finish(); });
    }
    // Arrow keys for a Mac: a press is a short nudge, held keys keep moving.
    const keys = new Map();
    let keyHold = null;
    const keyVector = () => {
      const s = (speed / 100) * 0.5;
      const pan = (keys.has('ArrowRight') ? s : 0) - (keys.has('ArrowLeft') ? s : 0);
      const tilt = (keys.has('ArrowUp') ? s : 0) - (keys.has('ArrowDown') ? s : 0);
      return { pan: floorSpeed(pan), tilt: floorSpeed(tilt) };
    };
    pad.addEventListener('keydown', (e) => {
      if (!e.key.startsWith('Arrow') || !isLive(camId)) return;
      e.preventDefault();
      keys.set(e.key, true);
      keyHold ??= new Hold(camId, ['pan', 'tilt']);
      keyHold.set(keyVector());
    });
    const keyUp = (e) => {
      if (e && !e.key?.startsWith('Arrow')) return;
      if (e) keys.delete(e.key); else keys.clear();
      if (!keys.size) { keyHold?.end(); keyHold = null; } else keyHold?.set(keyVector());
    };
    pad.addEventListener('keyup', keyUp);
    pad.addEventListener('blur', () => keyUp(null));
    return pad;
  }

  /**
   * A press-and-hold rail for zoom or focus. Pressing further from the centre
   * goes faster, like a rocker; the middle is a dead zone that shows the
   * current position, so a careless touch on the readout does nothing.
   */
  function rail(camId, axis, { minus, plus, name }) {
    const thumb = el('div', { class: 'thumb' });
    const mid = el('span', { class: 'mid', text: name });
    const node = el('div', {
      class: 'ptz-rail', role: 'application', tabindex: '0',
      'aria-label': `${name}: hold toward ${minus} or ${plus}; arrow keys work too`,
    }, thumb, el('span', { class: 'end', text: `◀ ${minus}` }), mid, el('span', { class: 'end', text: `${plus} ▶` }));
    let pointer = null;
    let hold = null;
    const finish = () => {
      if (pointer === null) return;
      pointer = null;
      hold?.end();
      hold = null;
      node.classList.remove('active');
    };
    const track = (e) => {
      const r = node.getBoundingClientRect();
      const half = r.width / 2;
      const d = clamp((e.clientX - (r.left + half)) / half, -1, 1);
      thumb.style.left = `${((d + 1) / 2) * 100}%`;
      const v = Math.sign(d) * shape(Math.abs(d), 0.16) * (speed / 100);
      hold?.set({ [axis]: floorSpeed(v) });
    };
    node.addEventListener('pointerdown', (e) => {
      if (pointer !== null || !isLive(camId)) return;
      e.preventDefault();
      pointer = e.pointerId;
      try { node.setPointerCapture(e.pointerId); } catch { /* fine */ }
      node.classList.add('active');
      hold = new Hold(camId, [axis]);
      track(e);
    });
    node.addEventListener('pointermove', (e) => { if (e.pointerId === pointer) track(e); });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      node.addEventListener(t, (e) => { if (e.pointerId === pointer) finish(); });
    }
    let keyHold = null;
    node.addEventListener('keydown', (e) => {
      if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || !isLive(camId)) return;
      e.preventDefault();
      keyHold ??= new Hold(camId, [axis]);
      keyHold.set({ [axis]: floorSpeed((e.key === 'ArrowRight' ? 1 : -1) * (speed / 100) * 0.5) });
    });
    const keyEnd = () => { keyHold?.end(); keyHold = null; };
    node.addEventListener('keyup', keyEnd);
    node.addEventListener('blur', keyEnd);
    return { node, setReadout: (t) => { if (mid.textContent !== t) mid.textContent = t; } };
  }

  function speedRow() {
    const value = el('span', { class: 'value', text: `${speed}%` });
    const input = el('input', {
      type: 'range', min: 5, max: 100, step: 5, value: speed,
      'aria-label': 'Motion speed',
    });
    input.addEventListener('input', () => { value.textContent = `${input.value}%`; });
    input.addEventListener('change', () => { setSpeed(Number(input.value)); input.blur(); });
    const sync = () => { if (document.activeElement !== input) { input.value = speed; value.textContent = `${speed}%`; } };
    speedListeners.add(sync);
    const row = el('div', { class: 'row', title: 'Top speed for the joystick, zoom and focus on this panel' },
      el('label', { text: 'Speed' }),
      el('div', { class: 'slide' }, input, value));
    // Forget the listener with the row, so rebuilt cards do not accumulate them.
    const check = setInterval(() => {
      if (!row.isConnected) { speedListeners.delete(sync); clearInterval(check); }
    }, 5000);
    return row;
  }

  // --- presets --------------------------------------------------------------

  /** cameraId -> { base, count, presets: [{n, name, thumb, savedAt}] } */
  const presetData = new Map();

  async function loadPresets(camId) {
    const r = await api('GET', camPath(camId, 'ptz/presets'), undefined, { quiet: true });
    if (r.httpOk) presetData.set(camId, { base: r.base ?? 1, count: r.count ?? 0, presets: r.presets ?? [] });
    refreshCam(camId);
    ctx.presetsChanged?.(camId);
  }

  function renderPresets(c, cam) {
    const sec = c.parts.presetSec;
    const d = presetData.get(cam.id);
    const caps = cam.capabilities ?? {};
    const sig = JSON.stringify([d, cam.ptz?.preset, c.presetMode, c.presetsExpanded, cam.state]);
    if (sec.dataset.sig === sig) return;
    sec.dataset.sig = sig;
    sec.textContent = '';

    const base = d?.base ?? caps.presetBase ?? 1;
    const count = d?.count ?? caps.presets ?? 0;
    const byN = new Map((d?.presets ?? []).map((p) => [p.n, p]));
    // A dozen slots is a shoot's worth; a head with a hundred shows them on
    // request. Anything stored beyond the dozen is always shown.
    const SHOWN = 12;
    const ns = new Set();
    const limit = c.presetsExpanded ? Math.min(count, 256) : Math.min(count, SHOWN);
    for (let i = 0; i < limit; i++) ns.add(base + i);
    for (const n of byN.keys()) ns.add(n);
    const slots = [...ns].sort((a, b) => a - b);

    const setMode = (m) => { c.presetMode = c.presetMode === m ? 'recall' : m; renderPresets(c, c.cam); };
    const head = el('div', { class: 'ptz-sechead' },
      el('span', { text: 'Presets' }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: c.presetMode === 'store' ? 'small primary' : 'small',
        'aria-pressed': c.presetMode === 'store' ? 'true' : 'false',
        onclick: () => setMode('store'),
      }, document.createTextNode(c.presetMode === 'store' ? 'Cancel store' : 'Store')),
      el('button', {
        class: c.presetMode === 'edit' ? 'small primary' : 'small ghost',
        'aria-pressed': c.presetMode === 'edit' ? 'true' : 'false',
        onclick: () => setMode('edit'),
      }, document.createTextNode(c.presetMode === 'edit' ? 'Done' : 'Edit')));
    sec.append(head);
    if (c.presetMode === 'store') {
      sec.append(el('div', { class: 'note warnnote', text:
        `Tap a slot to store where ${cam.label} is pointing now. This replaces what is in that slot on the camera.` }));
    } else if (c.presetMode === 'edit') {
      sec.append(el('div', { class: 'note', text: 'Tap a preset to rename or clear it.' }));
    }

    const grid = el('div', { class: `ptz-presets${c.presetMode === 'store' ? ' storing' : ''}${c.presetMode === 'edit' ? ' editing' : ''}` });
    for (const n of slots) {
      const rec = byN.get(n);
      const current = cam.ptz?.preset === n;
      const tile = el('button', {
        class: `ptz-preset${current ? ' current' : ''}${rec ? '' : ' empty'}`,
        disabled: cam.state !== 'connected',
        title: rec?.name ? `${n}: ${rec.name}` : `Preset ${n}`,
        onclick: () => presetTap(c, cam.id, n, rec),
      });
      if (rec?.thumb) {
        tile.append(el('img', {
          src: camPath(cam.id, `ptz/presets/${n}/thumb?v=${encodeURIComponent(rec.savedAt ?? '')}`),
          alt: '', loading: 'lazy', draggable: 'false',
        }));
      } else {
        tile.append(el('span', { class: 'num', text: String(n) }));
      }
      tile.append(el('span', { class: 'name', text: rec?.name ? `${n} · ${rec.name}` : `Preset ${n}` }));
      grid.append(tile);
    }
    sec.append(grid);
    if (count > SHOWN) {
      sec.append(el('button', {
        class: 'small ghost',
        onclick: () => { c.presetsExpanded = !c.presetsExpanded; renderPresets(c, c.cam); },
      }, document.createTextNode(c.presetsExpanded ? 'Fewer slots' : `All ${count} slots`)));
    }
  }

  async function presetTap(c, camId, n, rec) {
    const cam = camById(camId);
    if (!cam) return;
    if (c.presetMode === 'store') {
      const name = await askText({
        title: `Store preset ${n} on ${cam.label}`,
        sub: 'Stores where the head is pointing now. A picture of the shot is kept with it.',
        value: rec?.name ?? '', placeholder: `e.g. Lectern, Wide two-shot`, ok: 'Store',
      });
      if (name === null) return;
      const r = await api('POST', camPath(camId, `ptz/presets/${n}/store`), { name: name.trim() });
      if (r.httpOk) {
        toast(`Stored ${name.trim() ? `"${name.trim()}"` : `preset ${n}`} on ${cam.label}`);
        c.presetMode = 'recall';
        loadPresets(camId);
      }
      return;
    }
    if (c.presetMode === 'edit') {
      presetEditor(camId, n, rec);
      return;
    }
    const r = await api('POST', camPath(camId, `ptz/presets/${n}/recall`), {}, { quiet: true });
    if (!r.httpOk) toast(r.error ?? `Preset ${n} did not recall`, 'bad', 7000);
  }

  function presetEditor(camId, n, rec) {
    const cam = camById(camId);
    const input = el('input', { type: 'text', value: rec?.name ?? '', placeholder: 'Name', 'aria-label': 'Preset name' });
    const msg = el('div', { class: 'note' });
    const dlg = sheetDialog(`Preset ${n} on ${cam?.label ?? camId}`, [
      el('div', { class: 'formgrid', style: 'margin-top:12px' }, el('label', { text: 'Name' }), input),
      msg,
    ], [
      el('button', {
        class: 'danger', onclick: async () => {
          if (!confirm(`Clear preset ${n} on ${cam?.label ?? camId}? The camera forgets that position.`)) return;
          const r = await api('DELETE', camPath(camId, `ptz/presets/${n}`), undefined, { quiet: true });
          if (r.httpOk) { dlg.close(); toast(`Cleared preset ${n}`); loadPresets(camId); } else msg.textContent = r.error ?? 'Could not clear it';
        },
      }, document.createTextNode('Clear preset')),
      el('span', { class: 'spacer' }),
      el('button', { class: 'ghost', onclick: () => dlg.close() }, document.createTextNode('Cancel')),
      el('button', {
        class: 'primary', onclick: async () => {
          const r = await api('PUT', camPath(camId, `ptz/presets/${n}`), { name: input.value.trim() }, { quiet: true });
          if (r.httpOk) { dlg.close(); loadPresets(camId); } else msg.textContent = r.error ?? 'Could not rename it';
        },
      }, document.createTextNode('Save name')),
    ]);
    dlg.showModal();
    input.focus();
  }

  // --- small dialogs --------------------------------------------------------

  /** A throwaway <dialog>: built, shown, and removed when it closes. */
  function sheetDialog(title, content, buttons, { sub } = {}) {
    const dlg = el('dialog', { class: 'ptz-dialog' });
    add(dlg, el('h3', { text: title }), sub ? el('div', { class: 'sub note', text: sub }) : null);
    for (const n of content) add(dlg, n);
    const row = el('div', { class: 'line', style: 'margin-top:14px;justify-content:flex-end' });
    for (const b of buttons) add(row, b);
    dlg.append(row);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    return dlg;
  }

  function askText({ title, sub, value = '', placeholder = '', ok = 'OK' }) {
    return new Promise((resolve) => {
      let result = null;
      const input = el('input', { type: 'text', value, placeholder, 'aria-label': title });
      const okBtn = el('button', { class: 'primary', onclick: () => { result = input.value; dlg.close(); } },
        document.createTextNode(ok));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); } });
      const dlg = sheetDialog(title, [el('div', { style: 'margin-top:12px' }, input)], [
        el('button', { class: 'ghost', onclick: () => dlg.close() }, document.createTextNode('Cancel')),
        okBtn,
      ], { sub });
      input.style.width = '100%';
      dlg.addEventListener('close', () => resolve(result));
      dlg.showModal();
      input.focus();
    });
  }

  function askNumber({ title, min, max, step, unit, value }) {
    return new Promise((resolve) => {
      let result = null;
      const num = el('input', { type: 'number', min, max, step, value, 'aria-label': title });
      const slide = el('input', { type: 'range', min, max, step, value, 'aria-label': title });
      slide.addEventListener('input', () => { num.value = slide.value; });
      num.addEventListener('input', () => { slide.value = num.value; });
      const okBtn = el('button', {
        class: 'primary', onclick: () => {
          const v = Number(num.value);
          if (!Number.isFinite(v) || v < min || v > max) { num.focus(); return; }
          result = v; dlg.close();
        },
      }, document.createTextNode('Set'));
      num.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); } });
      const dlg = sheetDialog(title, [
        el('div', { class: 'note', text: `${min}${unit} to ${max}${unit}, in steps of ${step}` }),
        el('div', { class: 'ptz-numrow' }, slide, num),
      ], [el('button', { class: 'ghost', onclick: () => dlg.close() }, document.createTextNode('Cancel')), okBtn]);
      dlg.addEventListener('close', () => resolve(result));
      dlg.showModal();
    });
  }

  /**
   * Admin changes: the operator types the camera's name back. The wrong camera
   * is the classic mistake with network and password settings, and a name is
   * something you have to look at to type. The server checks it too; this is
   * the part a person sees. Its refusal is shown word for word.
   */
  function confirmTyped(cam, { title, detail, ok, run }) {
    const input = el('input', {
      type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
      placeholder: cam.label, 'aria-label': `Type ${cam.label} to confirm`,
    });
    input.style.width = '100%';
    const err = el('div', { class: 'note warnnote ptz-err', role: 'alert' });
    const go = el('button', { class: 'danger', disabled: true }, document.createTextNode(ok));
    const matches = () => input.value.trim().toLowerCase() === String(cam.label).trim().toLowerCase();
    input.addEventListener('input', () => { go.disabled = !matches(); err.textContent = ''; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && matches()) go.click(); });
    const dlg = sheetDialog(title, [
      el('p', { class: 'note', text: detail }),
      el('label', { class: 'note', text: `Type the camera’s name, ${cam.label}, to confirm:` }),
      input, err,
    ], [el('button', { class: 'ghost', onclick: () => dlg.close() }, document.createTextNode('Cancel')), go]);
    go.addEventListener('click', async () => {
      go.disabled = true;
      const r = await run(input.value.trim());
      if (r.httpOk) {
        dlg.close();
        toast(r.detail ?? `${title} — done`, 'ok', 8000);
      } else {
        err.textContent = r.error ?? `Refused (${r.httpStatus})`;
        go.disabled = !matches();
      }
    });
    dlg.showModal();
    input.focus();
    return dlg;
  }

  function adminWrite(cam, entry) {
    return (value) => {
      const action = entry.type === 'action';
      const shown = entry.secret || entry.writeOnly ? 'a new value'
        : entry.type === 'enum' ? (entry.options?.find((o) => same(o.value, value))?.label ?? String(value))
          : entry.type === 'bool' ? (value ? 'On' : 'Off')
            : entry.type === 'range' ? rangeLabel(entry, null, Number(value)) : `“${value}”`;
      const why = entry.danger === 'reconnect'
        ? 'This changes how CamBridge reaches the camera. It will reconnect on its own once the camera answers.'
        : 'This outlasts the shoot.';
      const dlg = confirmTyped(cam, {
        title: action ? `${entry.label} — ${cam.label}` : `Change ${entry.label} on ${cam.label}`,
        detail: action ? `${entry.help ? `${entry.help} ` : ''}${why}` : `Set ${entry.label} to ${shown}. ${why}`,
        ok: action ? entry.label : 'Change it',
        run: (confirm) => (action
          ? api('POST', camPath(cam.id, `admin-actions/${encodeURIComponent(entry.id)}`), { confirm }, { quiet: true })
          : api('PUT', camPath(cam.id, `admin-settings/${encodeURIComponent(entry.id)}`), { value, confirm }, { quiet: true })),
      });
      // Whatever the dialog decided, the row goes back to showing the camera.
      dlg.addEventListener('close', () => { if (sheet?.open) renderSheet(true); });
    };
  }

  // --- settings sheet -------------------------------------------------------

  let sheet = null;

  function buildSheet() {
    const dlg = el('dialog', { class: 'ptz-sheet', 'aria-label': 'Camera settings' });
    const title = el('h3');
    const sub = el('div', { class: 'note' });
    const search = el('input', { type: 'search', placeholder: 'Search settings', 'aria-label': 'Search settings' });
    const content = el('div', { class: 'ptz-sheet-body' });
    const close = el('button', { class: 'ghost', onclick: () => dlg.close() }, document.createTextNode('Done'));
    dlg.append(
      el('div', { class: 'ptz-sheet-head' }, el('div', {}, title, sub), el('span', { class: 'spacer' }), close),
      search, content);
    search.addEventListener('input', () => applyFilter());
    dlg.addEventListener('close', () => { sheet.open = false; });
    document.body.append(dlg);
    sheet = { dlg, title, sub, search, content, camId: null, open: false, built: null, groups: new Map() };
  }

  function openSettings(camId) {
    if (!sheet) buildSheet();
    if (sheet.camId !== camId) {
      sheet.search.value = '';
      sheet.built = null;
    }
    sheet.camId = camId;
    sheet.open = true;
    renderSheet();
    sheet.dlg.showModal();
    const cam = camById(camId);
    if (cam && !schemas.get(camId)?.data) ensureSchema(cam);
  }

  function renderSheet(force = false) {
    const cam = camById(sheet.camId);
    if (!cam) return;
    const sch = schemas.get(cam.id);
    sheet.title.textContent = `${cam.label} — settings`;
    const d = sch?.data;
    sheet.sub.textContent = [d?.model || cam.model, d?.firmware ? `firmware ${d.firmware}` : null, cam.ip,
      cam.state === 'connected' ? null : cam.state].filter(Boolean).join(' · ');

    if (!d) {
      sheet.content.textContent = '';
      sheet.content.append(el('div', { class: 'note', text: 'Reading this camera’s settings…' }));
      sheet.built = null;
      return;
    }

    // Groups in GROUPS order, then any group this panel has not heard of; the
    // admin section last, apart, so nothing in it is changed by accident.
    const buildKey = `${cam.id}|${sch.version}`;
    if (force || sheet.built !== buildKey) {
      sheet.content.textContent = '';
      sheet.groups = new Map();
      const groupIds = [...new Set(d.entries.map((e) => e.group))]
        .sort((a, b) => (GROUP_ORDER[a] ?? 99) - (GROUP_ORDER[b] ?? 99));
      for (const g of [...groupIds.map((x) => ['g', x]), ['admin', 'admin']]) {
        const [kind, gid] = g;
        const label = kind === 'admin' ? 'Admin' : (GROUP_LABEL[gid] ?? gid);
        const box = el('div', { class: 'ptz-srows' });
        const sec = el('section', { class: `ptz-sgroup${kind === 'admin' ? ' admin' : ''}` },
          el('h4', { text: label }));
        if (kind === 'admin') {
          sec.append(el('p', { class: 'note', text:
            'Network, accounts, firmware and restarts. Each change asks for the camera’s name, '
            + 'needs the admin PIN when one is set, and is refused while the camera is on air.' }));
        }
        sec.append(box);
        sheet.content.append(sec);
        sheet.groups.set(kind === 'admin' ? 'admin' : gid, { sec, box, label });
      }
      sheet.built = buildKey;
    }

    for (const [gid, g] of sheet.groups) {
      const list = gid === 'admin'
        ? d.entries.filter(isDanger)
        : d.entries.filter((e) => e.group === gid && !isDanger(e));
      keyedRows(g.box, list.map((e) => ({
        key: e.id,
        sig: rowSig(cam, e) + sch.version,
        build: () => settingRow(cam, e, gid === 'admin'),
      })));
    }
    applyFilter();
  }

  function settingRow(cam, entry, admin) {
    const groupLabel = GROUP_LABEL[entry.group] ?? entry.group;
    const label = el('div', { class: 'ptz-slabel' },
      el('div', { class: 'name' }, document.createTextNode(entry.label),
        admin ? el('span', { class: 'note', text: ` · ${groupLabel}` }) : null));
    add(label,
      entry.verify ? el('span', { class: 'pill warn', text: 'not yet confirmed on this model',
        title: 'This setting is in the table from the vendor’s documentation and has not been tried on this exact model yet.' }) : null,
      entry.readOnly ? el('span', { class: 'pill', text: 'read-only' }) : null,
      entry.help ? el('div', { class: 'note', text: entry.help }) : null);
    const row = el('div', { class: 'ptz-srow', 'data-search':
      `${entry.label} ${groupLabel} ${entry.help ?? ''} ${admin ? 'admin' : ''}`.toLowerCase() });
    row.append(label, el('div', { class: 'ptz-sctl' },
      entryControl(cam, entry, admin ? { write: adminWrite(cam, entry), admin: true } : {}),
      admin ? null : gateNote(cam, entry)));
    return row;
  }

  function applyFilter() {
    const q = sheet.search.value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    let any = false;
    for (const g of sheet.groups.values()) {
      let shown = 0;
      for (const row of g.box.children) {
        const hit = words.every((w) => row.dataset.search?.includes(w));
        row.style.display = hit ? '' : 'none';
        if (hit) shown += 1;
      }
      g.sec.style.display = shown ? '' : 'none';
      if (shown) any = true;
    }
    let none = sheet.content.querySelector('.ptz-nohits');
    if (!any && !none) {
      none = el('div', { class: 'note ptz-nohits', text: 'No setting matches that.' });
      sheet.content.append(none);
    } else if (any && none) none.remove();
  }

  // --- watch lease ----------------------------------------------------------

  function leaseNow(c) {
    if (!ctx.controlActive() || document.visibilityState !== 'visible') return;
    if (c.cam?.state !== 'connected' || !c.node.isConnected) return;
    post(camPath(c.cam.id, 'ptz/watch'), { ms: WATCH_LEASE_MS }).catch(() => {});
  }
  setInterval(() => { for (const c of cards.values()) if (c.visible) leaseNow(c); }, WATCH_EVERY_MS);

  // --- gamepad --------------------------------------------------------------

  let padHolds = null;   // { camId, pt: Hold, zf: Hold }

  /** Sticks to motion for a PTZ target. Returns nothing; release with padRelease(). */
  function padSticks(cam, axes) {
    if (padHolds && padHolds.camId !== cam.id) {
      padRelease();
      // The target changed under a stick that may still be deflected (a bus
      // tap, a number key). The new camera must not start on that stale
      // deflection: both sticks come back to centre first.
      padHolds = { camId: cam.id, pt: null, zf: null, ptBlocked: true, zfBlocked: true };
    }
    const dz = 0.15;
    const read = (i, invert = false) => {
      const raw = Number(axes[i] ?? 0) * (invert ? -1 : 1);
      return floorSpeed(Math.sign(raw) * shape(Math.abs(raw), dz) * (speed / 100));
    };
    const pan = read(0);
    const tilt = read(1, true);      // browsers report stick-up as negative
    const zoom = read(3, true);      // right stick up = tele
    const focus = read(2);           // right stick right = far
    const caps = cam.capabilities ?? {};
    const wantPt = caps.panTilt && (pan || tilt);
    const wantZf = (caps.zoom && zoom) || (caps.focus && focus);
    padHolds ??= { camId: cam.id, pt: null, zf: null };
    // A hold ended from elsewhere (tab hidden, window blurred, STOP ALL) stays
    // ended until that stick has been let go: STOP ALL must not be undone by a
    // thumb that happened to still be on the stick.
    if (padHolds.pt?.ended) { padHolds.pt = null; padHolds.ptBlocked = true; }
    if (padHolds.zf?.ended) { padHolds.zf = null; padHolds.zfBlocked = true; }
    if (!wantPt) padHolds.ptBlocked = false;
    if (!wantZf) padHolds.zfBlocked = false;
    if (wantPt && padHolds.ptBlocked) { /* waiting for the stick to centre */ } else if (wantPt) {
      padHolds.pt ??= new Hold(cam.id, ['pan', 'tilt']);
      padHolds.pt.set({ pan, tilt });
    } else if (padHolds.pt) { padHolds.pt.end(); padHolds.pt = null; }
    if (wantZf && padHolds.zfBlocked) { /* waiting for the stick to centre */ } else if (wantZf) {
      const axesZf = [caps.zoom ? 'zoom' : null, caps.focus ? 'focus' : null].filter(Boolean);
      padHolds.zf ??= new Hold(cam.id, axesZf);
      padHolds.zf.set({ zoom: caps.zoom ? zoom : 0, focus: caps.focus ? focus : 0 });
    } else if (padHolds.zf) { padHolds.zf.end(); padHolds.zf = null; }
  }

  function padRelease() {
    if (!padHolds) return;
    padHolds.pt?.end();
    padHolds.zf?.end();
    padHolds = null;
  }

  /** B button on a PTZ target: the table's one-push AF, if it has one. */
  async function padAutofocus(cam) {
    // The table is read only for cameras on screen; a gamepad can drive one
    // that is not, so read it now rather than claim there is no AF.
    if (!schemas.get(cam.id)?.data) await ensureSchema(cam);
    const af = roleOf(cam.id, 'onePushAf');
    if (af) api('POST', camPath(cam.id, `actions/${encodeURIComponent(af.id)}`));
    else toast(`${cam.label} has no one-push autofocus`, 'warn');
  }

  // --- setup ----------------------------------------------------------------

  let found = null;

  function wireSetup($) {
    const msg = $('#ptz-detect-msg');
    const foundBox = $('#ptz-found');
    $('#ptz-detect')?.addEventListener('click', async () => {
      const ip = $('#ptz-ip').value.trim();
      if (!ip) { msg.textContent = 'Enter the camera’s IP address first.'; return; }
      msg.textContent = 'Asking the camera what it is…';
      foundBox.hidden = true;
      found = null;
      const vendor = $('#ptz-vendor').value || undefined;
      const r = await api('POST', '/api/ptz/detect', {
        ip, username: $('#ptz-user').value.trim(), password: $('#ptz-pass').value, vendor,
      }, { quiet: true });
      if (!r.ok) {
        msg.textContent = r.error ?? `Nothing recognised at ${ip} (${r.httpStatus}).`;
        return;
      }
      found = { ip, vendor: r.vendor, model: r.identity?.model ?? '', label: r.label };
      msg.textContent = '';
      $('#ptz-found-text').textContent = [`Found ${r.label ?? r.vendor} ${r.identity?.model ?? ''}`.trim(),
        r.identity?.firmware ? `firmware ${r.identity.firmware}` : null,
        r.identity?.serial ? `serial ${r.identity.serial}` : null].filter(Boolean).join(' · ');
      $('#ptz-name').value = r.identity?.name && r.identity.name !== r.identity.model ? r.identity.name : '';
      $('#ptz-name').placeholder = r.identity?.model || 'e.g. Wide, Centre, Lectern';
      foundBox.hidden = false;
      $('#ptz-name').focus();
    });
    $('#ptz-add')?.addEventListener('click', async () => {
      if (!found) return;
      const r = await api('POST', '/api/ptz/cameras', {
        ip: found.ip, vendor: found.vendor, model: found.model,
        label: $('#ptz-name').value.trim() || found.model,
        username: $('#ptz-user').value.trim(), password: $('#ptz-pass').value,
        group: $('#ptz-group')?.value.trim() || undefined,
      }, { quiet: true });
      if (!r.ok) { $('#ptz-detect-msg').textContent = r.error ?? `Not added (${r.httpStatus}).`; return; }
      toast(`Added ${r.camera?.label ?? found.model}`);
      found = null;
      foundBox.hidden = true;
      for (const s of ['#ptz-ip', '#ptz-user', '#ptz-pass', '#ptz-name', '#ptz-group']) if ($(s)) $(s).value = '';
      ctx.refreshSetup();
    });
    loadVendors($);
    wireSkaarhoj($);
  }

  /** The make pickers: single add-by-IP and bulk add offer the same list. */
  async function loadVendors($) {
    const sels = ['#ptz-vendor', '#bulk-vendor'].map((s) => $(s)).filter(Boolean);
    if (!sels.length) return;
    const r = await api('GET', '/api/ptz/supported', undefined, { quiet: true });
    for (const sel of sels) {
      for (const v of r.vendors ?? []) {
        sel.append(el('option', { value: v.vendor, title: (v.models ?? []).join(', ') },
          document.createTextNode(`${v.label}${v.models?.length ? ` (${v.models.join(', ')})` : ''}`)));
      }
    }
  }

  // --- SKAARHOJ -------------------------------------------------------------

  let skMode = 'reactor';
  let skDirty = false;

  function wireSkaarhoj($) {
    for (const b of document.querySelectorAll('#sk-mode button')) {
      b.addEventListener('click', () => { skMode = b.dataset.mode; skDirty = true; paintSkMode(); });
    }
    for (const s of ['#sk-host', '#sk-port']) $(s)?.addEventListener('input', () => { skDirty = true; });
    $('#sk-save')?.addEventListener('click', async () => {
      const r = await api('PUT', '/api/skaarhoj', {
        mode: skMode, host: $('#sk-host').value.trim(), port: Number($('#sk-port').value) || undefined,
      }, { quiet: true });
      $('#sk-msg').textContent = r.httpOk ? 'Saved.' : (r.error ?? `Not saved (${r.httpStatus}).`);
      if (r.httpOk) { skDirty = false; refreshSkaarhoj($); }
    });
  }

  function paintSkMode() {
    for (const b of document.querySelectorAll('#sk-mode button')) {
      const on = b.dataset.mode === skMode;
      b.classList.toggle('primary', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  async function refreshSkaarhoj($) {
    const card = $('#skaarhoj-card');
    if (!card) return;
    const r = await api('GET', '/api/skaarhoj', undefined, { quiet: true });
    // Not built yet on this server, or switched off: no card rather than a
    // card that can only say it does not work.
    if (r.httpStatus === 404 || !r.httpOk) { card.hidden = true; return; }
    card.hidden = false;
    const editing = card.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
    if (!skDirty && !editing) {
      skMode = r.mode === 'drive' ? 'drive' : 'reactor';
      $('#sk-host').value = r.host ?? '';
      $('#sk-port').value = r.port ?? '';
      paintSkMode();
    }
    const st = $('#sk-status');
    st.textContent = '';
    const driving = r.selectedCameraId ? (camById(r.selectedCameraId)?.label ?? r.selectedCameraId) : null;
    add(st,
      el('span', { class: `pill ${r.connected ? 'ok' : 'warn'}`, text: r.connected ? 'connected' : 'not connected' }),
      r.panel ? el('span', { text: `${r.panel.model ?? 'panel'}${r.panel.serial ? ` · ${r.panel.serial}` : ''}` }) : null,
      r.mode === 'drive' && driving ? el('span', { text: `driving ${driving}` }) : null,
      r.detail ? el('span', { class: 'note', text: r.detail }) : null);
  }

  return {
    card,
    onView,
    openSettings,
    aim,
    stopAll,
    endAllHolds,
    endHoldsFor,
    keepOnly,
    holding,
    presetName,
    padSticks,
    padRelease,
    padAutofocus,
    wireSetup,
    refreshSkaarhoj,
  };
}
