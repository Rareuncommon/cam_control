// CamBridge with many PTZ heads: bulk add, groups and order, and an event
// stream that stays small when dozens of cameras are connected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseAddresses, BulkAdd, MAX_ADDRESSES } from '../src/ptz/bulk.js';
import { resetFakeHeads, fakeHead } from '../src/ptz/drivers/fake.js';
import { createApp } from '../src/server.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  throw new Error('condition not met in time');
}

const FAST = {
  heartbeatIntervalMs: 200, heartbeatTimeoutMs: 2000,
  reconnectBackoffMs: [50, 100], reconnectBackoffMaxMs: 100,
  positionFastMs: 100, positionIdleMs: 400, statusMs: 400, settingsMs: 200, fastSettingsMs: 400,
  deadmanMs: 400,
};

// --- addresses --------------------------------------------------------------

test('address lists expand ranges, blocks and names, and refuse nonsense', () => {
  const r = parseAddresses('192.0.2.10-12, 192.0.2.20\ncam-wide.local 192.0.2.30-192.0.2.31 192.0.2.10');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.addresses, ['192.0.2.10', '192.0.2.11', '192.0.2.12', '192.0.2.20',
    'cam-wide.local', '192.0.2.30', '192.0.2.31']);
  const block = parseAddresses('198.51.100.0/29');
  assert.deepEqual(block.addresses, ['198.51.100.1', '198.51.100.2', '198.51.100.3',
    '198.51.100.4', '198.51.100.5', '198.51.100.6']);
  assert.equal(parseAddresses('10.0.0.0/16').errors.length, 1, 'too big a block');
  assert.equal(parseAddresses('192.0.2.20-10').errors.length, 1, 'backwards range');
  assert.equal(parseAddresses('not an address!').errors.length, 1);
  const huge = parseAddresses('10.0.0.1-10.0.3.255');
  assert.ok(huge.errors.length && huge.addresses.length === 0, `over ${MAX_ADDRESSES} refused`);
});

test('bulk add finds the cameras in a list, skips ones already added, and names them', async () => {
  const added = [];
  const adopted = [{ id: 'old', kind: 'ptz', ip: '192.0.2.1', label: 'Old' }];
  const bulk = new BulkAdd({
    adopted: () => [...adopted, ...added],
    add: async (input) => {
      const camera = { id: `cam${added.length}`, label: input.label, kind: 'ptz', ip: input.ip };
      added.push(camera);
      return { ok: true, camera };
    },
    detectFn: async ({ host, password }) => {
      if (host === '192.0.2.3') return { ok: false, error: 'A camera answered but refused the username or password.' };
      if (host === '192.0.2.4') return { ok: false, error: 'No supported camera answered at that address.' };
      assert.equal(password, 'shared', 'the shared credentials reach the probe');
      return { ok: true, vendor: 'panasonic', identity: { model: 'AW-UE160', name: host === '192.0.2.5' ? 'Lectern' : null } };
    },
  });
  const r = bulk.start({ addresses: '192.0.2.1-6', username: 'admin', password: 'shared', group: 'Stage' });
  assert.equal(r.ok, true);
  await until(() => bulk.status(r.jobId).state === 'done');
  const st = bulk.status(r.jobId);
  assert.ok(!JSON.stringify(st).includes('shared'), 'progress never carries the password');
  const by = Object.fromEntries(st.results.map((x) => [x.address, x]));
  assert.equal(by['192.0.2.1'].status, 'skipped');
  assert.equal(by['192.0.2.2'].status, 'added');
  assert.equal(by['192.0.2.2'].added.label, 'AW-UE160 2');
  assert.equal(by['192.0.2.3'].status, 'refused');
  assert.equal(by['192.0.2.4'].status, 'nothing');
  assert.equal(by['192.0.2.5'].added.label, 'Lectern', "the camera's own name wins");
  assert.equal(added.length, 3);
  assert.equal(bulk.start({ addresses: 'bad!' }).ok, false);
});

// --- the server at scale ------------------------------------------------------

function cameras(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `ptz${String(i + 1).padStart(2, '0')}`, kind: 'ptz', vendor: 'fake',
    label: `PTZ ${i + 1}`, ip: `fake-scale-${i + 1}`, group: i < n / 2 ? 'Stage' : 'Balcony',
    options: { tracking: i % 3 === 0 },
  }));
}

async function bigApp(n) {
  resetFakeHeads();
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-scale-'));
  const configPath = join(dir, 'cambridge.json');
  writeFileSync(configPath, JSON.stringify({
    cambridge: { bind: '127.0.0.1', port: 0 },
    logging: { dir: join(dir, 'logs'), level: 'error' },
    ptz: FAST,
    cameras: cameras(n),
  }));
  const app = createApp({ configPath });
  const addr = await app.start();
  const base = `http://127.0.0.1:${addr.port}`;
  const call = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  return { app, call, base, configPath };
}

/** Reads an SSE stream, collecting frames and their sizes. */
function listen(url) {
  const ctrl = new AbortController();
  const frames = [];
  const done = (async () => {
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const f = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (f.startsWith('data: ')) frames.push({ bytes: f.length, msg: JSON.parse(f.slice(6)) });
        }
      }
    } catch { /* aborted */ }
  })();
  return { frames, stop: async () => { ctrl.abort(); await done; } };
}

test('48 heads: groups and order come from the config, and a pan is a small patch', async () => {
  const { app, call, base } = await bigApp(48);
  try {
    await until(async () => (await call('GET', '/api/state')).body.view.cameras.every((c) => c.state === 'connected'),
      { timeoutMs: 15000 });
    const { view } = (await call('GET', '/api/state')).body;
    assert.equal(view.cameras.length, 48);
    assert.deepEqual(view.cameras.slice(0, 3).map((c) => c.id), ['ptz01', 'ptz02', 'ptz03']);
    assert.equal(view.cameras[0].group, 'Stage');
    assert.equal(view.cameras[47].group, 'Balcony');

    const patchClient = listen(`${base}/api/events?patch=1`);
    const fullClient = listen(`${base}/api/events`);
    await until(() => patchClient.frames.length && fullClient.frames.length);
    const fullBytes = patchClient.frames[0].bytes;
    assert.equal(patchClient.frames[0].msg.type, 'state', 'a patch client still starts from the full state');
    await sleep(600);   // let the start-up reads settle
    patchClient.frames.length = 1;
    fullClient.frames.length = 1;

    // Pan one head for a second.
    const end = Date.now() + 1000;
    while (Date.now() < end) {
      await call('POST', '/api/cameras/ptz07/ptz/move', { pan: 0.6 });
      await sleep(150);
    }
    await call('POST', '/api/cameras/ptz07/ptz/stop');
    await sleep(400);

    const patches = patchClient.frames.slice(1).map((f) => f.msg);
    assert.ok(patches.length > 0, 'position updates were pushed');
    assert.ok(patches.every((p) => p.type === 'patch'));
    const moved = patches.filter((p) => p.cameras.ptz07?.ptz);
    assert.ok(moved.length > 0, 'the moving head reported its position');
    assert.ok(patches.every((p) => Object.keys(p.cameras).every((id) => id === 'ptz07' || !p.cameras[id].ptz?.moving)),
      'no other head reported motion');
    const biggestPatch = Math.max(...patchClient.frames.slice(1).map((f) => f.bytes));
    // The point of patches: a pan costs a few kilobytes, not the whole state.
    assert.ok(biggestPatch * 10 < fullBytes, `patch ${biggestPatch} B vs full ${fullBytes} B`);
    // An old client keeps getting full frames, and they are still correct.
    const lastFull = fullClient.frames.at(-1).msg;
    assert.equal(lastFull.type, 'state');
    assert.equal(lastFull.view.cameras.length, 48);

    // Reorder and regroup, from the API.
    const ord = await call('PUT', '/api/cameras/order', { ids: ['ptz48', 'ptz47'] });
    assert.equal(ord.status, 200);
    const reg = await call('PATCH', '/api/cameras/ptz01/adoption', { group: 'Lobby' });
    assert.equal(reg.status, 200);
    const after = (await call('GET', '/api/state')).body.view.cameras;
    assert.deepEqual(after.slice(0, 3).map((c) => c.id), ['ptz48', 'ptz47', 'ptz01']);
    assert.equal(after[2].group, 'Lobby');

    await patchClient.stop();
    await fullClient.stop();
    // The panic button reaches every head.
    for (const id of ['ptz02', 'ptz30']) await call('POST', `/api/cameras/${id}/ptz/move`, { pan: 1 });
    await call('POST', '/api/ptz/stop-all');
    assert.equal(fakeHead('fake-scale-2').v.pan, 0);
    assert.equal(fakeHead('fake-scale-30').v.pan, 0);
  } finally {
    await app.stop();
  }
});

test('bulk add over the API adds simulated heads with a group', async () => {
  const { app, call, configPath } = await bigApp(1);
  try {
    const r = await call('POST', '/api/ptz/bulk', { addresses: 'fake-bulk-1 fake-bulk-2', vendor: 'fake', group: 'Overflow' });
    assert.equal(r.status, 202);
    const st = await until(async () => {
      const s = (await call('GET', `/api/ptz/bulk/${r.body.jobId}`)).body;
      return s.state === 'done' ? s : null;
    });
    assert.deepEqual(st.results.map((x) => x.status), ['added', 'added']);
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(cfg.cameras.filter((c) => c.group === 'Overflow').length, 2);
    await until(async () => (await call('GET', '/api/state')).body.view.cameras.filter((c) => c.group === 'Overflow' && c.state === 'connected').length === 2);
  } finally {
    await app.stop();
  }
});
