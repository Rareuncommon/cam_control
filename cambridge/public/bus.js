// The camera bus, the selected-camera layout, and the group filter.
//
// A full Operate card per head is right for a room with four: every stick in
// reach, every picture in view. At forty-eight it is forty-eight joysticks and
// forty-eight previews on one page, the camera you want is a long scroll away,
// and the server is asked for forty-eight pictures it then has to fetch. So
// past a handful of heads the panel changes shape: a bus — one small tile per
// head, enough to find it and see its state at a glance, like the row of
// source buttons on a switcher — and the full Operate card only for the head
// being ridden (or two, or four, for an operator on more than one).
//
// The selection moves only from here, and every move stops whatever the
// previous head was being driven by before the new one is shown: a selection
// change mid-drag must never leave the old head panning with nobody looking.
//
// Groups ("Stage", "Balcony") come from Setup and filter the bus, the cards
// and Multiview alike — one choice, remembered per browser.

/** At or under this many PTZ heads, Auto shows every card; above it, the bus. */
export const AUTO_CARDS_MAX = 4;
const UPS = [1, 2, 4];
const LAYOUTS = ['auto', 'cards', 'select'];
/** The chip for cameras with no group. Not a string anyone could type as a group. */
const NO_GROUP = '\u0000none';
const SLOT_NAMES = ['A', 'B', 'C', 'D'];

// Storage can throw (private mode, blocked site data). A preference that
// cannot be remembered resets; it does not break the panel.
function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* not remembered */ }
}

/** Sets an attribute only when it changes, so an unchanged render writes nothing. */
function setAttr(node, name, value) {
  if (value === null || value === undefined || value === false) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else if (node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
}

const isTextField = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/**
 * @param {object} ctx
 * @param {Function} ctx.el / ctx.add      app.js DOM helpers
 * @param {(why: string) => void} ctx.onChange   re-render after a preference or selection change
 * @param {() => boolean} ctx.keysActive  whether bus keys apply (Control view, selected layout)
 * @param {(id: string) => void} ctx.endHoldsFor  stop every press on a head
 * @param {(id: string, n: number) => string|null} ctx.presetName
 */
export function createBus(ctx) {
  const { el, onChange } = ctx;

  let layoutPref = LAYOUTS.includes(load('cb.ptzLayout', 'auto')) ? load('cb.ptzLayout', 'auto') : 'auto';
  let up = UPS.includes(Number(load('cb.ptzUp', '1'))) ? Number(load('cb.ptzUp', '1')) : 1;
  let slots = (() => {
    try {
      const v = JSON.parse(load('cb.ptzSlots', '[]'));
      return Array.isArray(v) ? v.slice(0, 4).map((x) => (typeof x === 'string' ? x : null)) : [];
    } catch { return []; }
  })();
  let active = 0;
  let group = load('cb.group', '') ?? '';
  /** The heads the bus shows, in bus order, as last rendered: what 1–9 and ←/→ walk. */
  let shownPtz = [];
  let presetVersion = 0;

  // --- groups ---------------------------------------------------------------

  /** Groups present, in the operator's camera order, with a count each. */
  function groupsOf(cams) {
    const counts = new Map();
    let none = 0;
    for (const c of cams) {
      if (c.group) counts.set(c.group, (counts.get(c.group) ?? 0) + 1); else none += 1;
    }
    const list = [...counts].map(([name, n]) => ({ value: name, label: name, n }));
    if (list.length && none) list.push({ value: NO_GROUP, label: 'No group', n: none });
    return list;
  }

  /**
   * The group in force: the remembered one if it still exists, otherwise all.
   * Not forgotten when it disappears — a camera list that is momentarily empty
   * while the panel reconnects should not reset the operator's choice.
   */
  function currentGroup(cams) {
    if (!group) return '';
    return groupsOf(cams).some((g) => g.value === group) ? group : '';
  }

  function filter(cams) {
    const g = currentGroup(cams);
    if (!g) return cams;
    return cams.filter((c) => (g === NO_GROUP ? !c.group : c.group === g));
  }

  function setGroup(g) {
    group = g;
    save('cb.group', g);
    onChange('group');
  }

  /** All + one chip per group. Rebuilt only when the groups, counts or choice change. */
  function renderChips(box, cams) {
    if (!box) return;
    const groups = groupsOf(cams);
    const g = currentGroup(cams);
    const sig = JSON.stringify([groups, g, cams.length]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    box.hidden = !groups.length;
    for (const it of [{ value: '', label: 'All', n: cams.length }, ...groups]) {
      const on = it.value === g;
      box.append(el('button', {
        class: `chip${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false',
        title: it.value ? `Show only ${it.label}` : 'Show every camera',
        onclick: () => setGroup(it.value),
      }, document.createTextNode(it.label), el('span', { class: 'count', text: String(it.n) })));
    }
  }

  // --- layout ---------------------------------------------------------------

  function layoutFor(ptzCount) {
    if (layoutPref === 'cards' || layoutPref === 'select') return layoutPref;
    return ptzCount <= AUTO_CARDS_MAX ? 'cards' : 'select';
  }

  function setLayout(v) {
    layoutPref = v;
    save('cb.ptzLayout', v);
    onChange('layout');
  }

  function setUp(n) {
    up = n;
    active = Math.min(active, n - 1);
    save('cb.ptzUp', String(n));
    onChange('layout');
  }

  /** Layout and panel-count switches, and the group chips, above the control view. */
  function renderBar(bar, ptzCams, allCams, layout) {
    if (!bar) return;
    bar.hidden = !ptzCams.length;
    if (!ptzCams.length) return;
    const sig = JSON.stringify([layoutPref, layout, up, ptzCams.length]);
    let head = bar.querySelector('.ctlbar-head');
    if (!head) {
      head = el('div', { class: 'ctlbar-head' });
      bar.prepend(head);
    }
    if (head.dataset.sig !== sig) {
      head.dataset.sig = sig;
      head.textContent = '';
      const seg = (label, options, current, pick) => el('span', { class: 'field' },
        el('span', { class: 'note', text: label }),
        el('div', { class: 'seg', role: 'group', 'aria-label': label },
          ...options.map(([value, text, title]) => el('button', {
            class: value === current ? 'small primary' : 'small',
            'aria-pressed': value === current ? 'true' : 'false', title,
            onclick: () => { if (value !== current) pick(value); },
          }, document.createTextNode(text)))));
      const autoText = `Auto (${layout === 'cards' ? 'cards' : 'bus'})`;
      head.append(seg('Layout', [
        ['auto', autoText, `Every card for up to ${AUTO_CARDS_MAX} heads, the camera bus above that`],
        ['cards', 'All cards', 'A full Operate card for every head'],
        ['select', 'Bus', 'One small tile per head; the full card only for the selected one'],
      ], layoutPref, setLayout));
      if (layout === 'select') {
        head.append(seg('Panels', UPS.map((n) => [n, String(n),
          n === 1 ? 'One selected camera' : `Ride ${n} cameras at once`]), up, setUp));
      }
      if (layout === 'select' && ptzCams.length) {
        head.append(el('span', { class: 'note bushint', text: '1–9, 0 and ← → select' }));
      }
    }
    let chips = bar.querySelector('.chips');
    if (!chips) {
      chips = el('div', { class: 'chips groupchips', role: 'group', 'aria-label': 'Camera group' });
      bar.append(chips);
    }
    renderChips(chips, allCams);
  }

  // --- selection --------------------------------------------------------------

  /**
   * The heads given an Operate panel, one per slot. A slot holding a camera
   * that has gone is refilled from what the bus shows, then from every head.
   */
  function resolve(ptzCams, shown) {
    if (!ptzCams.length) return [];
    const ids = new Set(ptzCams.map((c) => c.id));
    const out = [];
    for (let i = 0; i < up; i++) {
      const id = slots[i];
      out.push(id && ids.has(id) && !out.includes(id) ? id : null);
    }
    for (let i = 0; i < out.length; i++) {
      if (out[i]) continue;
      out[i] = [...shown, ...ptzCams].find((c) => !out.includes(c.id))?.id ?? null;
    }
    const next = [...out, ...slots.slice(up)].slice(0, 4);
    if (JSON.stringify(next) !== JSON.stringify(slots)) {
      slots = next;
      save('cb.ptzSlots', JSON.stringify(slots));
    }
    active = Math.min(active, Math.max(0, out.filter(Boolean).length - 1));
    return out.filter(Boolean);
  }

  /**
   * Puts a head in the active panel. A head already in a panel just makes
   * that panel the active one. Whatever the replaced head was being driven by
   * is stopped first, before anything is redrawn.
   */
  function select(id) {
    const at = slots.slice(0, up).indexOf(id);
    if (at >= 0) {
      if (at !== active) { active = at; onChange('active'); }
      return;
    }
    const prev = slots[active];
    if (prev) ctx.endHoldsFor(prev);
    slots[active] = id;
    save('cb.ptzSlots', JSON.stringify(slots));
    onChange('select');
    scrollToTile(id);
  }

  /** Makes a panel the one the bus, the keys and the next tap act on. */
  function setActive(i) {
    if (i === active || i < 0 || i >= up) return;
    active = i;
    onChange('active');
  }

  /** ←/→: the next head on the bus, skipping heads already in another panel. */
  function step(dir) {
    if (!shownPtz.length) return;
    const others = new Set(slots.slice(0, up).filter((_, i) => i !== active));
    const cur = shownPtz.findIndex((c) => c.id === slots[active]);
    for (let k = 1; k <= shownPtz.length; k++) {
      const i = cur < 0
        ? (dir > 0 ? k - 1 : shownPtz.length - k)
        : (cur + dir * k + shownPtz.length * k) % shownPtz.length;
      const cam = shownPtz[i];
      if (!others.has(cam.id)) { select(cam.id); return; }
    }
  }

  window.addEventListener('keydown', (e) => {
    if (!ctx.keysActive()) return;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    if (isTextField(e.target) || document.querySelector('dialog[open]')) return;
    if (/^[0-9]$/.test(e.key)) {
      const cam = shownPtz[e.key === '0' ? 9 : Number(e.key) - 1];
      if (cam) { e.preventDefault(); select(cam.id); }
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // The stick and the rails take arrows themselves while focused.
      if (e.target?.closest?.('[role="application"]')) return;
      e.preventDefault();
      step(e.key === 'ArrowRight' ? 1 : -1);
    }
  });

  // --- the bus ----------------------------------------------------------------

  /** id -> { node, cam, key, sig } */
  const tiles = new Map();
  let busBox = null;

  function scrollToTile(id) {
    const t = tiles.get(id);
    // Only inside the bus's own scroller; never scroll the page out from
    // under an operator's hand.
    if (!t || !busBox) return;
    const b = busBox.getBoundingClientRect();
    const r = t.node.getBoundingClientRect();
    if (r.left < b.left) busBox.scrollLeft -= b.left - r.left + 8;
    else if (r.right > b.right) busBox.scrollLeft += r.right - b.right + 8;
    if (r.top < b.top) busBox.scrollTop -= b.top - r.top + 8;
    else if (r.bottom > b.bottom) busBox.scrollTop += r.bottom - b.bottom + 8;
  }

  const STATE_TEXT = {
    connecting: 'connecting…', reconnecting: 'reconnecting', unauthorized: 'wrong password', offline: 'offline',
  };

  /** What a tile shows, as one string: the tile is redrawn when, and only when, this changes. */
  function tileSig(cam, index, slot) {
    const preset = cam.ptz?.preset ?? null;
    return JSON.stringify([cam.label, cam.group, cam.state, !!cam.tally?.program, !!cam.tally?.preview,
      !!cam.ptz?.moving, cam.capabilities?.tracking ? !!cam.ptz?.tracking : null, preset,
      preset !== null ? ctx.presetName(cam.id, preset) : null, index, slot, slot === active, up > 1]);
  }

  function fillTile(node, cam, index, slot) {
    const pgm = !!cam.tally?.program;
    const pvw = !pgm && !!cam.tally?.preview;
    const live = cam.state === 'connected';
    const moving = !!cam.ptz?.moving;
    const tracking = !!(cam.capabilities?.tracking && cam.ptz?.tracking);
    const preset = cam.ptz?.preset ?? null;
    const pname = preset !== null ? ctx.presetName(cam.id, preset) : null;
    const selected = slot >= 0;
    node.className = `bt${pgm ? ' pgm' : pvw ? ' pvw' : ''}${live ? '' : ' off'}${selected ? ' sel' : ''}`
      + `${selected && slot === active && up > 1 ? ' act' : ''}`;
    setAttr(node, 'aria-pressed', selected ? 'true' : 'false');
    const key = index < 10 ? String((index + 1) % 10) : null;
    const status = !live ? (STATE_TEXT[cam.state] ?? cam.state)
      : preset !== null ? `P${preset}${pname ? ` ${pname}` : ''}` : '';
    setAttr(node, 'aria-label', [cam.label, cam.group, pgm ? 'on air' : pvw ? 'preview' : null,
      live ? null : status, moving ? 'moving' : null, tracking ? 'tracking' : null,
      live && preset !== null ? `preset ${preset}` : null].filter(Boolean).join(', '));
    setAttr(node, 'title', key ? `${cam.label} — press ${key}` : cam.label);
    node.textContent = '';
    node.append(
      el('span', { class: 'bt-top' },
        el('span', { class: `bt-dot${moving ? ' moving' : ''}`, title: moving ? 'Moving' : '' }),
        el('span', { class: 'bt-name', text: cam.label || cam.id }),
        up > 1 && selected ? el('span', { class: 'bt-slot', text: SLOT_NAMES[slot] })
          : key ? el('span', { class: 'bt-key', text: key }) : document.createTextNode('')),
      el('span', { class: 'bt-sub' },
        cam.group ? el('span', { class: 'bt-grp', text: cam.group }) : document.createTextNode(''),
        status ? el('span', { class: `bt-st${live ? '' : ' bad'}`, text: status }) : document.createTextNode(''),
        tracking ? el('span', { class: 'bt-tag', text: 'TRK', title: 'Tracking' }) : document.createTextNode(''),
        pgm ? el('span', { class: 'bt-tag pgm', text: 'PGM' })
          : pvw ? el('span', { class: 'bt-tag pvw', text: 'PVW' }) : document.createTextNode('')));
  }

  /**
   * One tile per head the filter shows. A tile is touched only when its own
   * camera changed in a way it shows: a head panning across the room changes
   * its position many times a second, and its tile — which shows only that it
   * is moving — not at all.
   */
  function renderBus(box, shown, slotIds) {
    busBox = box;
    shownPtz = shown;
    if (!box) return;
    const want = new Set(shown.map((c) => c.id));
    for (const [id, t] of tiles) if (!want.has(id)) { t.node.remove(); tiles.delete(id); }
    shown.forEach((cam, i) => {
      let t = tiles.get(cam.id);
      if (!t) {
        const node = el('button', { class: 'bt', 'data-id': cam.id, onclick: () => select(cam.id) });
        t = { node, cam: null, key: null, sig: null };
        tiles.set(cam.id, t);
      }
      const slot = slotIds.indexOf(cam.id);
      const key = `${i}|${slot}|${active}|${up}|${presetVersion}`;
      if (t.cam !== cam || t.key !== key) {
        t.cam = cam;
        t.key = key;
        const sig = tileSig(cam, i, slot);
        if (sig !== t.sig) { t.sig = sig; fillTile(t.node, cam, i, slot); }
      }
      if (box.children[i] !== t.node) box.insertBefore(t.node, box.children[i] ?? null);
    });
    while (box.children.length > shown.length) box.lastElementChild.remove();
    const empty = !shown.length;
    setAttr(box, 'data-empty', empty ? '1' : null);
  }

  /** A camera's presets were read: its tile may now name the current one. */
  function presetsChanged() { presetVersion += 1; }

  return {
    layoutFor, filter, renderBar, renderChips, resolve, renderBus, select, setActive,
    presetsChanged, setAttr,
    get active() { return active; },
    get up() { return up; },
    get layoutPref() { return layoutPref; },
  };
}
