// Setup → Phones: pair the CamBridge app by QR, see paired phones, revoke one.
//
// The QR holds the phone's secret, so it is shown once, in a dialog, and
// dropped from the page when the dialog closes. The phone confirms by using
// it; the dialog watches the device list and says so when it does.

export function createPhones({ root, el, api, toast }) {
  const list = el('table', { class: 'list' });
  const pairBtn = el('button', { class: 'small primary', text: 'Pair a phone' });
  const msg = el('span', { class: 'note', role: 'status' });
  root.append(
    el('h3', { text: 'Phones' }),
    el('div', { class: 'sub', text: 'The CamBridge app on a phone pairs once by scanning a code shown here. Each phone has its own key; revoking one stops it at once, on Wi-Fi and Bluetooth.' }),
    el('div', { class: 'line' }, pairBtn, msg),
    el('div', { class: 'tablescroll', style: 'margin-top:10px' }, list),
    el('p', { class: 'note', style: 'margin:10px 0 0', text: 'Without a PIN, CamBridge stays open to anything on the network, as before; the app still signs every request, and a revoked phone’s app is refused. Over Bluetooth only paired phones can do anything.' }));

  const dialog = el('dialog', { class: 'phones-dialog' });
  document.body.append(dialog);
  let watching = null;
  let timer = null;

  const fmt = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');

  async function refresh() {
    const r = await api('GET', '/api/devices', undefined, { quiet: true });
    if (!r.httpOk) {
      list.textContent = '';
      list.append(el('tr', {}, el('td', { class: 'note', text: r.httpStatus === 403 ? 'Pairing phones needs the admin PIN.' : (r.error ?? 'Could not load paired phones.') })));
      return [];
    }
    render(r.devices);
    return r.devices;
  }

  function render(devices) {
    list.textContent = '';
    list.append(el('tr', {}, ...['Phone', 'Status', 'Paired', 'Last seen', ''].map((t) => el('th', { text: t }))));
    if (!devices.length) {
      list.append(el('tr', {}, el('td', { colspan: 5, class: 'note', text: 'No phones paired.' })));
      return;
    }
    for (const d of devices) {
      const name = d.name ?? (d.status === 'pending' ? 'Waiting for a phone…' : d.id);
      list.append(el('tr', {},
        el('td', {}, el('div', { text: name }), el('div', { class: 'note mono', text: [d.model, d.id].filter(Boolean).join(' · ') })),
        el('td', { class: d.status === 'pending' ? 'note' : '', text: d.status === 'pending' ? `pending until ${new Date(d.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'paired' }),
        el('td', { class: 'note', text: fmt(d.activatedAt ?? d.createdAt) }),
        el('td', { class: 'note', text: d.lastSeenAt ? `${fmt(d.lastSeenAt)} (${d.lastVia === 'ble' ? 'Bluetooth' : 'Wi-Fi'})` : 'not since CamBridge started' }),
        el('td', {}, el('button', { class: 'small ghost', text: d.status === 'pending' ? 'Cancel' : 'Revoke', onclick: () => revoke(d) }))));
    }
  }

  async function revoke(d) {
    const name = d.name ?? d.id;
    if (d.status !== 'pending' && !confirm(`Revoke ${name}?\n\nIts app stops working at once, on Wi-Fi and Bluetooth. Pair it again to bring it back.`)) return;
    const r = await api('DELETE', `/api/devices/${encodeURIComponent(d.id)}`);
    if (r.httpOk) toast(d.status === 'pending' ? 'Pairing code cancelled' : `${name} revoked`);
    refresh();
  }

  pairBtn.addEventListener('click', async () => {
    pairBtn.disabled = true;
    try {
      const r = await api('POST', '/api/devices', {}, { quiet: true });
      if (!r.httpOk) { setMsg(r.httpStatus === 403 ? 'Pairing a phone needs the admin PIN.' : (r.error ?? 'Could not make a pairing code.')); return; }
      showCode(r.device, r.pairing);
    } finally { pairBtn.disabled = false; }
  });

  function setMsg(t) { msg.textContent = t; }

  function showCode(device, pairing) {
    watching = device.id;
    const status = el('div', { class: 'note', role: 'status' });
    const qr = el('div', { class: 'phones-qr' });
    // Server-made SVG of the code: paths only, no script or links.
    qr.innerHTML = pairing.svg;
    dialog.textContent = '';
    dialog.append(
      el('h3', { text: 'Pair a phone' }),
      el('div', { class: 'sub note', text: 'In the CamBridge app, tap Pair and scan this code. It works once, for ten minutes; closing this cancels it.' }),
      qr, status,
      el('div', { class: 'line', style: 'justify-content:flex-end;margin-top:12px' },
        el('button', { class: 'ghost', text: 'Close', onclick: () => dialog.close() })));
    let paired = false;
    dialog.addEventListener('close', async () => {
      // Drop the code (and the key in it) from the page, and cancel it if no
      // phone used it: a photographed code is then worth nothing.
      qr.textContent = '';
      watching = null;
      clearInterval(timer);
      if (!paired) await api('DELETE', `/api/devices/${encodeURIComponent(device.id)}`, undefined, { quiet: true });
      refresh();
    }, { once: true });
    const until = Date.parse(pairing.expiresAt);
    const tick = async () => {
      const left = Math.max(0, until - Date.now());
      const devices = await refresh();
      const d = devices.find((x) => x.id === device.id);
      if (watching !== device.id) return;
      if (d?.status === 'active') {
        paired = true;
        status.textContent = `Paired: ${d.name ?? 'phone'}${d.model ? ` (${d.model})` : ''}.`;
        toast(`${d.name ?? 'Phone'} paired`);
        qr.textContent = '';
        clearInterval(timer);
        setTimeout(() => dialog.open && dialog.close(), 1500);
        return;
      }
      if (!d || left === 0) {
        status.textContent = 'This code has expired. Close and make a new one.';
        qr.textContent = '';
        clearInterval(timer);
        return;
      }
      status.textContent = `Waiting for the phone… ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')} left`;
    };
    dialog.showModal();
    tick();
    timer = setInterval(tick, 2000);
  }

  return { refresh };
}
