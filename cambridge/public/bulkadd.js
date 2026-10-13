// Bulk add: many PTZ heads from a list or range of addresses.
//
// The server does the work as a job (POST /api/ptz/bulk) because probing a
// range where most addresses are empty takes longer than a browser will wait
// on one request; this page starts the job and polls it. "Find cameras" is a
// dry run — it only asks each address what it is — so the operator sees what
// will be added before anything is. "Add all found" then adds exactly the
// addresses that answered, rather than probing the whole range again.
//
// Polling runs only while Setup is on screen. Leaving Setup stops it; coming
// back picks the job up where it is.

const POLL_MS = 700;

const STATUS = {
  waiting: ['', 'waiting'],
  probing: ['warn', 'asking…'],
  found: ['ok', 'found'],
  added: ['ok', 'added'],
  skipped: ['', 'already added'],
  refused: ['bad', 'wrong login'],
  nothing: ['', 'nothing there'],
  failed: ['bad', 'not added'],
};

/**
 * @param {object} ctx
 * @param {Function} ctx.el / ctx.api / ctx.toast
 * @param {() => boolean} ctx.isActive     whether Setup is the view on screen
 * @param {() => void} ctx.refreshSetup     re-read the camera list after adding
 */
export function createBulkAdd(ctx) {
  const { el, api, toast } = ctx;
  let $ = null;
  /** { id, dryRun, key, status } for the job this page started. */
  let job = null;
  let timer = null;
  let inFlight = false;
  /** The last finished dry run: what it was asked, and which addresses answered. */
  let lastScan = null;
  let showEmpty = false;

  function inputs() {
    return {
      addresses: $('#bulk-addr').value,
      username: $('#bulk-user').value.trim(),
      password: $('#bulk-pass').value,
      vendor: $('#bulk-vendor').value || undefined,
      group: $('#bulk-group').value.trim() || undefined,
    };
  }
  // What a scan's results depend on. The group does not change what answers.
  const keyOf = (i) => JSON.stringify([i.addresses.trim(), i.username, i.password, i.vendor ?? '']);

  const running = () => !!job && job.status?.state !== 'done';

  function setMsg(text, kind = '') {
    const m = $('#bulk-msg');
    m.textContent = text;
    m.className = `note${kind ? ` ${kind}` : ''}`;
  }

  function paintButtons() {
    const busy = running();
    $('#bulk-find').disabled = busy;
    $('#bulk-add').disabled = busy;
    const inp = inputs();
    const fresh = lastScan && lastScan.key === keyOf(inp);
    $('#bulk-add').textContent = fresh
      ? `Add ${lastScan.found.length === 1 ? 'the camera' : `all ${lastScan.found.length}`} found`
      : 'Add all found';
  }

  async function start(dryRun) {
    if (running()) return;
    const inp = inputs();
    if (!inp.addresses.trim()) { setMsg('List the addresses first.', 'warnnote'); return; }
    let addresses = inp.addresses;
    const key = keyOf(inp);
    if (!dryRun && lastScan?.key === key) {
      if (!lastScan.found.length) { setMsg('The last search found nothing to add.', 'warnnote'); return; }
      addresses = lastScan.found.join('\n');
    }
    setMsg(dryRun ? 'Asking each address what it is…' : 'Adding…');
    const r = await api('POST', '/api/ptz/bulk', { ...inp, addresses, dryRun }, { quiet: true });
    if (!r.httpOk) {
      setMsg(r.error ?? `Not started (${r.httpStatus}).`, 'warnnote');
      return;
    }
    job = { id: r.jobId, dryRun, key, status: { state: 'running', total: r.total, done: 0, results: [] } };
    $('#bulk-progress').hidden = false;
    paint();
    paintButtons();
    poll();
  }

  async function poll() {
    clearTimeout(timer);
    timer = null;
    if (!job || !ctx.isActive() || inFlight) return;
    inFlight = true;
    let st;
    try {
      st = await api('GET', `/api/ptz/bulk/${encodeURIComponent(job.id)}`, undefined, { quiet: true });
    } catch {
      st = {};   // the network blinked; ask again on the next tick
    } finally {
      inFlight = false;
    }
    if (!job) return;
    if (st.httpOk) {
      job.status = st;
      paint();
      if (st.state === 'done') { finish(); return; }
    } else if (st.httpStatus === 404) {
      job = null;
      setMsg('CamBridge no longer knows that job — it may have restarted. Start it again.', 'warnnote');
      paintButtons();
      return;
    }
    if (ctx.isActive()) timer = setTimeout(poll, POLL_MS);
  }

  /** Setup is on screen again: carry on polling a job that was still running. */
  function resume() {
    if (running() && !timer && !inFlight) poll();
  }

  function finish() {
    const st = job.status;
    const n = (s) => st.results.filter((r) => r.status === s).length;
    if (job.dryRun) {
      lastScan = { key: job.key, found: st.results.filter((r) => r.status === 'found').map((r) => r.address) };
      const found = lastScan.found.length;
      setMsg(found
        ? `Found ${found} camera${found === 1 ? '' : 's'} at ${st.total} address${st.total === 1 ? '' : 'es'}. Nothing has been added yet.`
        : `No camera answered at ${st.total === 1 ? 'that address' : `any of ${st.total} addresses`}.`,
      found ? '' : 'warnnote');
    } else {
      const added = n('added');
      lastScan = null;
      setMsg(`Added ${added} camera${added === 1 ? '' : 's'}.${n('failed') ? ` ${n('failed')} could not be added.` : ''}`,
        added ? '' : 'warnnote');
      if (added) {
        toast(`Added ${added} PTZ camera${added === 1 ? '' : 's'}`);
        $('#bulk-pass').value = '';
      }
      ctx.refreshSetup();
    }
    paintButtons();
  }

  /** Summary, progress bar and the per-address table, updated row by row. */
  function paint() {
    const st = job?.status;
    if (!st) return;
    const counts = {};
    for (const r of st.results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const parts = ['found', 'added', 'skipped', 'refused', 'failed', 'nothing']
      .filter((s) => counts[s]).map((s) => `${counts[s]} ${STATUS[s][1]}`);
    const sum = $('#bulk-summary');
    sum.textContent = `${st.state === 'done' ? 'Done' : 'Working'} — ${st.done} of ${st.total} checked`
      + `${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
    const bar = $('#bulk-bar');
    bar.max = st.total || 1;
    bar.value = st.done;

    const empty = counts.nothing ?? 0;
    const toggle = $('#bulk-empty');
    toggle.hidden = !empty;
    toggle.textContent = showEmpty ? `Hide ${empty} empty` : `Show ${empty} empty`;

    const table = $('#bulk-table');
    if (!table.tHead) {
      table.createTHead().append(el('tr', {},
        el('th', { text: 'Address' }), el('th', { text: 'Result' }),
        el('th', { text: 'Camera' }), el('th', { text: '' })));
    }
    const body = table.tBodies[0] ?? table.createTBody();
    const rows = st.results.filter((r) => showEmpty || r.status !== 'nothing');
    const existing = new Map([...body.rows].map((tr) => [tr.dataset.k, tr]));
    rows.forEach((r, i) => {
      const sig = JSON.stringify([r.status, r.vendor, r.model, r.name, r.added, r.detail]);
      let tr = existing.get(r.address);
      existing.delete(r.address);
      if (!tr || tr.dataset.sig !== sig) {
        const [kind, text] = STATUS[r.status] ?? ['', r.status];
        const fresh = el('tr', { 'data-k': r.address, 'data-sig': sig },
          el('td', { class: 'mono', text: r.address }),
          el('td', {}, el('span', { class: `pill ${kind}`, text })),
          el('td', { class: 'note', text: [r.model || r.vendor, r.name && r.name !== r.model ? `“${r.name}”` : null]
            .filter(Boolean).join(' ') }),
          el('td', { class: 'note', text: r.added ? `as ${r.added.label}` : (r.detail ?? '') }));
        if (tr) tr.replaceWith(fresh);
        tr = fresh;
      }
      if (body.rows[i] !== tr) body.insertBefore(tr, body.rows[i] ?? null);
    });
    for (const tr of existing.values()) tr.remove();
  }

  function wire(query) {
    $ = query;
    if (!$('#bulk-find')) return;
    $('#bulk-find').addEventListener('click', () => start(true));
    $('#bulk-add').addEventListener('click', () => start(false));
    $('#bulk-empty').addEventListener('click', () => { showEmpty = !showEmpty; paint(); });
    for (const s of ['#bulk-addr', '#bulk-user', '#bulk-pass', '#bulk-vendor']) {
      $(s).addEventListener('input', paintButtons);
      $(s).addEventListener('change', paintButtons);
    }
  }

  return { wire, resume };
}
