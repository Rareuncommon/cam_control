// Stills and cinema cameras in the same state model as everything else.
//
// They arrived from the Codex branch appended to every state frame, outside the
// model — so outside the change-only stream, the camera order and Record all's
// rules for PTZ heads. These pin down how they behave now they are inside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StateModel } from '../src/state.js';
import { createApp } from '../src/server.js';
import { resetFakeHeads } from '../src/ptz/drivers/fake.js';
import { blackmagicSimulator } from './external-simulator.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeoutMs = 5000 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await fn()) return; await sleep(25); }
  throw new Error('timed out');
}

function cinema(over = {}) {
  return {
    id: 'ext-a', label: 'Cinema A', model: 'Blackmagic PYXIS 6K', provider: 'blackmagic-rest',
    transport: 'HTTP', ip: '192.0.2.9', state: 'connected', detail: null, properties: {},
    status: { recording: false, recordingState: 0, battery: -1 },
    capabilities: { record: { available: true } },
    external: { controls: [], busy: false },
    ...over,
  };
}

test('a stills/cinema camera is re-sent only when its view changed', () => {
  const state = new StateModel();
  const events = [];
  state.on('change', (c) => events.push(c));

  state.applyExternal([cinema()]);
  assert.deepEqual(events.map((e) => e.type), ['all'], 'a new camera reshapes the list');

  // A Blackmagic body is polled every five seconds; most polls change nothing.
  state.applyExternal([cinema()]);
  assert.equal(events.length, 1, 'an unchanged poll sends nothing');

  state.applyExternal([cinema({ status: { recording: true, recordingState: 1, battery: -1 } })]);
  assert.deepEqual(events.at(-1), { type: 'connectionState', cameraId: 'ext-a' },
    'a change resends that one camera');

  const v = state.cameraView('ext-a');
  assert.equal(v.kind, 'external');
  assert.equal(v.provider, 'blackmagic-rest');
  assert.equal(v.status.recording, true);
  assert.deepEqual(v.capabilities, { record: { available: true } });
  assert.ok(v.external);

  state.applyExternal([]);
  assert.equal(events.at(-1).type, 'all');
  assert.equal(state.get('ext-a'), null);
});

test('a stills/cinema camera never replaces a camera from another source', () => {
  const state = new StateModel();
  state.replaceAll([{ id: 'ext-a', label: 'Head', state: 'connected' }], null, 'ptz');
  state.applyExternal([cinema()]);
  assert.equal(state.get('ext-a').kind, 'ptz');
});

test('with PTZ heads and a Blackmagic body: patches carry only the changed camera, and Record all skips the heads', async (t) => {
  resetFakeHeads();
  const sim = await blackmagicSimulator();
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-external-state-'));
  const configPath = join(dir, 'cambridge.json');
  writeFileSync(configPath, JSON.stringify({
    cambridge: { bind: '127.0.0.1', port: 0 },
    logging: { dir: join(dir, 'logs'), level: 'error' },
    cameras: [
      { id: 'wide', kind: 'ptz', vendor: 'fake', label: 'Wide', ip: 'fake-ext-wide' },
      { id: 'tight', kind: 'ptz', vendor: 'fake', label: 'Tight', ip: 'fake-ext-tight' },
    ],
  }));
  const app = createApp({ configPath });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  const ctrl = new AbortController();
  t.after(async () => { ctrl.abort(); await app.stop(); await sim.close(); rmSync(dir, { recursive: true, force: true }); });

  const secret = 'test-only-cinema-secret';
  const added = await call('POST', '/api/external/cameras', {
    id: 'ext-cinema', provider: 'blackmagic-rest', host: '127.0.0.1', port: sim.port,
    username: 'test-user', password: secret,
  });
  assert.equal(added.status, 201);
  await until(async () => (await call('GET', '/api/state')).body.view.cameras
    .filter((c) => c.kind === 'ptz').every((c) => c.state === 'connected'));

  // The stream, change-only.
  const frames = [];
  (async () => {
    try {
      const res = await fetch(`${base}/api/events?patch=1`, { signal: ctrl.signal });
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const f = buf.slice(0, i); buf = buf.slice(i + 2);
          if (f.startsWith('data: ')) frames.push(f.slice(6));
        }
      }
    } catch { /* aborted */ }
  })();
  await until(() => frames.length > 0);
  const first = JSON.parse(frames[0]);
  assert.equal(first.type, 'state');
  assert.ok(first.view.cameras.some((c) => c.id === 'ext-cinema' && c.external), 'the cinema camera is in the state');
  await sleep(300);
  frames.length = 0;

  // Record all: the Blackmagic body rolls; the PTZ heads are not recorders.
  const rec = await call('POST', '/api/record-all', { start: true });
  assert.equal(rec.body.ok, true);
  assert.deepEqual(rec.body.results.map((r) => r.cameraId), ['ext-cinema']);
  assert.equal(sim.state.recording, true);

  await until(() => frames.some((f) => JSON.parse(f).cameras?.['ext-cinema']));
  const patches = frames.map((f) => JSON.parse(f));
  assert.ok(patches.every((p) => p.type === 'patch'), 'a recording change is a patch, not a full frame');
  const touched = new Set(patches.flatMap((p) => Object.keys(p.cameras)));
  assert.ok(!touched.has('wide') && !touched.has('tight'), `only the cinema camera changed (${[...touched]})`);
  assert.ok(frames.every((f) => !f.includes(secret)), 'its password never reaches the stream');
  assert.ok(!JSON.stringify((await call('GET', '/api/state')).body).includes(secret));

  await call('POST', '/api/record-all', { start: false });
  assert.equal(sim.state.recording, false);
});

test('an unusable stills/cinema entry is refused on add, and skipped (not fatal) at start-up', async (t) => {
  resetFakeHeads();
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { readFileSync } = await import('node:fs');
  // Something at the camera's address that reports a 300-character product name.
  const longName = `Blackmagic ${'X'.repeat(300)}`;
  const sim = createServer((req, res) => {
    const path = req.url.replace('/control/api/v1', '');
    const data = { '/system/product': { productName: longName }, '/transports/0/record': { recording: false } }[path];
    if (!data) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data));
  });
  sim.listen(0, '127.0.0.1'); await once(sim, 'listening');
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-external-bad-'));
  const configPath = join(dir, 'cambridge.json');
  const head = { id: 'wide', kind: 'ptz', vendor: 'fake', label: 'Wide', ip: 'fake-ext-bad' };
  writeFileSync(configPath, JSON.stringify({
    cambridge: { bind: '127.0.0.1', port: 0 }, logging: { dir: join(dir, 'logs'), level: 'error' }, cameras: [head],
  }));
  let app = createApp({ configPath });
  const { port } = await app.start();
  t.after(async () => { await app?.stop(); sim.close(); rmSync(dir, { recursive: true, force: true }); });
  const r = await fetch(`http://127.0.0.1:${port}/api/external/cameras`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'ext-bm', provider: 'blackmagic-rest', host: '127.0.0.1', port: sim.address().port }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /identity CamBridge cannot store/);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).external?.cameras?.length ?? 0, 0, 'nothing saved');
  await app.stop(); app = null;

  // A hand-edited entry that does not validate: the rest still starts.
  writeFileSync(configPath, JSON.stringify({
    cambridge: { bind: '127.0.0.1', port: 0 }, logging: { dir: join(dir, 'logs'), level: 'error' }, cameras: [head],
    external: { cameras: [{ id: 'ext-typo', provider: 'blackmagic-rest', host: '127.0.0.1', port: '80' }] },
  }));
  app = createApp({ configPath });
  await app.start();
  assert.equal(app.external.has('ext-typo'), false);
  await until(() => app.state.get('wide')?.state === 'connected');
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).external.cameras.length, 1, 'the entry is left for someone to correct');
});

test('a Sony body whose recording failed still counts against "all rolling"', async () => {
  const { rollState } = await import('../src/takelog.js');
  const roll = rollState([
    { id: 'a', kind: 'cine', state: 'connected', status: { recording: true }, capabilities: { record: { available: true } } },
    // Recording FAILED: the Sony record capability goes false, but this is
    // the camera "all rolling" must not forget.
    { id: 'b', kind: 'cine', state: 'connected', status: { recording: false, recordingState: 2 }, capabilities: { record: { available: false } } },
    { id: 'c', kind: 'external', state: 'connected', status: { recording: null }, capabilities: { record: { available: false } } },
  ]);
  assert.equal(roll.total, 2, 'the stills body that cannot record is left out; the failed Sony body is not');
  assert.equal(roll.all, false);
});

test('a stills/cinema camera keeps its tally, logs its takes and raises a dropped recording', () => {
  const state = new StateModel();
  state.applyExternal([cinema()]);
  state.get('ext-a').tally = { program: true, preview: false };

  state.applyExternal([cinema({ status: { recording: true, recordingState: 1, battery: -1 } })]);
  const cam = state.get('ext-a');
  assert.deepEqual(cam.tally, { program: true, preview: false }, 'an update keeps the switcher tally');
  assert.ok(cam.recordStartedAt, 'the record timer starts');
  assert.equal(state.takes.length, 1);

  // It stops without anyone asking: a full card, a camera that gave up.
  state.applyExternal([cinema({ status: { recording: false, recordingState: 0, battery: -1 } })]);
  assert.equal(state.get('ext-a').status.recordDropped, true);
  assert.equal(state.takes[0].dropped, true);

  // Started again, then stopped from CamBridge: not a drop.
  state.applyExternal([cinema({ status: { recording: true, recordingState: 1, battery: -1 } })]);
  state.markRecordIntent('ext-a', 'stop');
  state.applyExternal([cinema({ status: { recording: false, recordingState: 0, battery: -1 } })]);
  assert.equal(state.get('ext-a').status.recordDropped, false);
  assert.equal(state.takes.at(-1).dropped, false);
});

test('a background status poll that changes nothing sends nothing', async () => {
  const { ExternalManager } = await import('../src/external/manager.js');
  let saved = { cameras: [], external: { cameras: [{ id: 'ext-a', provider: 'blackmagic-rest', host: '127.0.0.1', port: 80 }] } };
  const snap = { productName: 'Blackmagic PYXIS 6K', recording: false, canRecord: true, controls: [] };
  const adapter = { snapshot: async () => { await sleep(30); return structuredClone(snap); } };
  const manager = new ExternalManager({ adoption: { readConfig: () => structuredClone(saved), writeConfig: (c) => { saved = c; } }, factory: () => adapter });
  const state = new StateModel();
  manager.on('change', () => state.applyExternal(manager.view()));
  state.applyExternal(manager.view());
  await manager.action('ext-a', 'status');           // first contact: offline -> connected
  const events = [];
  state.on('change', (c) => events.push(c));
  for (let i = 0; i < 3; i++) await manager.action('ext-a', 'status');
  assert.deepEqual(events, [], 'three unchanged polls, no updates');
  // And a command arriving during a poll waits for it rather than failing.
  const poll = manager.action('ext-a', 'status');
  await assert.doesNotReject(manager.action('ext-a', 'refresh'));
  await poll;
});
