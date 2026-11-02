// The one-time import of Companion's lighting scenes, against a stand-in for
// Companion's HTTP API on 127.0.0.1 that answers as v5.0.2 does: the value as
// text, 404 "Not found" for no such variable, 403 with the API switched off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Lighting } from '../src/lighting/service.js';
import { interpret, savedAt } from '../src/lighting/companion-import.js';
import { builtInProfiles, encode } from '../src/lighting/profiles.js';
import { profileMap, SEED_FIXTURES } from '../src/lighting/fixtures.js';
import { createApp } from '../src/server.js';
import { hashPin } from '../src/auth.js';

const STUDIO = '175 12 178 12 20 12 30 12 6 12';

async function fakeCompanion(vars, { apiOff = false } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (apiOff) { res.writeHead(403); res.end(); return; }
    const m = req.url.match(/^\/api\/custom-variable\/([^/]+)\/value$/);
    const name = m && decodeURIComponent(m[1]);
    if (req.method !== 'GET' || !m || !(name in vars)) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(String(vars[name]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) };
}

const NICS = { en14: [{ family: 'IPv4', address: '192.168.220.66' }] };

function lighting(dir, companionUrl) {
  let cfg = { lighting: { output: { enabled: true, dryRun: true }, companionUrl } };
  return new Lighting({
    readConfig: () => structuredClone(cfg),
    writeConfig: (c) => { cfg = structuredClone(c); },
    storePath: join(dir, 'cambridge-lighting.json'),
    outputOptions: { networkInterfaces: () => NICS, createSocket: () => { throw new Error('no network in this test'); } },
  });
}

const VARS = {
  scene1: STUDIO, scene1_saved: '2026-10-28T14:32:00Z',
  scene2: '0 12 0 12 0 12 0 12 0 12', scene2_saved: '28/10 09:15',
  // scene3 was never saved in Companion
  scene4: 'lights up please',
  scene5: '255 255 255 255', scene5_saved: '',
};

test('the preview reads Companion, shows what each scene becomes, and writes nothing', async (t) => {
  const companion = await fakeCompanion(VARS);
  const dir = mkdtempSync(join(tmpdir(), 'cb-import-'));
  const L = lighting(dir, companion.url);
  t.after(async () => { L.stop(); await companion.close(); rmSync(dir, { recursive: true, force: true }); });

  const r = await L.importFromCompanion();
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true);
  assert.equal(r.body.importable, 3);
  const [s1, s2, s3, s4, s5] = r.body.scenes;
  assert.deepEqual(s1.dmx, { L1: [175, 12], L2: [178, 12], L3: [20, 12], L4: [30, 12], L5: [6, 12] });
  assert.equal(s1.saved, '2026-10-28T14:32:00Z');
  assert.deepEqual(s1.problems, []);
  assert.equal(s2.importable, true);
  assert.deepEqual([s3.found, s3.importable, s3.problems], [false, false, ['scene3 is not set in Companion']]);
  assert.equal(s4.importable, false);
  assert.match(s4.problems[0], /not a list of DMX values/);
  assert.deepEqual(Object.keys(s5.dmx), ['L1', 'L2']);
  assert.match(s5.problems[0], /no values for L3, L4, L5/);

  assert.ok(companion.requests.every((x) => x.startsWith('GET /api/custom-variable/')), 'only reads');
  assert.equal(companion.requests.length, 10, 'scene1–5 and scene1_saved–scene5_saved');
  assert.ok(L.view().scenes.every((s) => s.empty), 'nothing written');
});

test('confirming writes what can be imported, and a recalled scene is the same DMX Companion sent', async (t) => {
  const companion = await fakeCompanion(VARS);
  const dir = mkdtempSync(join(tmpdir(), 'cb-import-'));
  const L = lighting(dir, companion.url);
  t.after(async () => { L.stop(); await companion.close(); rmSync(dir, { recursive: true, force: true }); });
  L.start();

  const r = await L.importFromCompanion({ confirm: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.imported, [1, 2, 5]);
  const store = JSON.parse(readFileSync(join(dir, 'cambridge-lighting.json'), 'utf8'));
  assert.equal(store.scenes['1'].savedAt, '2026-10-28T14:32:00.000Z');
  assert.equal(store.scenes['2'].savedAt, null, 'a time that is not a date is kept in the note, not guessed');
  assert.match(store.scenes['2'].note, /saved 28\/10 09:15/);
  assert.equal(store.scenes['3'], undefined);

  L.recallScene(1);
  assert.deepEqual(L.output.frames()[1].slice(0, 10), STUDIO.split(' ').map(Number));
  assert.deepEqual(L.view().active, { type: 'look', id: 'studio' }, 'scene 1 is the Studio look, and is recognised as it');
  L.recallScene(5);
  assert.deepEqual(L.output.frames()[1].slice(0, 10), [255, 255, 255, 255, 20, 12, 30, 12, 6, 12], 'L3–L5 left as they were');

  const only = await L.importFromCompanion({ confirm: true, slots: [2] });
  assert.deepEqual(only.body.imported, [2]);
});

test('every DMX value survives the trip into a scene and back out', () => {
  const profiles = profileMap(builtInProfiles());
  const lyra = profiles.get('ikan-lyra-lbx8-poe-2ch');
  const fixtures = SEED_FIXTURES.slice(0, 1);
  for (let v = 0; v <= 255; v++) {
    const s = interpret(1, `${v} ${255 - v}`, null, fixtures, profiles);
    assert.deepEqual(encode(lyra, s.state.l1), [v, 255 - v], `DMX ${v} ${255 - v}`);
  }
  assert.equal(savedAt('not a date'), null);
});

test('Companion not running, or its HTTP API off: a plain error, nothing written', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-import-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const down = await fakeCompanion({});
  const url = down.url;
  await down.close();
  const L = lighting(dir, url);
  const r = await L.importFromCompanion();
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Companion is not answering at http:\/\/127\.0\.0\.1:\d+ .*is it running\?/);

  const off = await fakeCompanion(VARS, { apiOff: true });
  const r2 = await L.importFromCompanion({ url: off.url, confirm: true });
  assert.equal(r2.status, 502);
  assert.match(r2.body.error, /HTTP API is switched off/);
  await off.close();

  assert.equal((await L.importFromCompanion({ url: 'file:///etc/passwd' })).status, 502);
  assert.equal((await L.importFromCompanion({ universe: 0 })).status, 400);
  assert.ok(L.view().scenes.every((s) => s.empty));
  L.stop();
});

test('the import route is admin, and previews unless confirmed', async (t) => {
  const companion = await fakeCompanion(VARS);
  const dir = mkdtempSync(join(tmpdir(), 'cb-import-'));
  const configPath = join(dir, 'cambridge.json');
  writeFileSync(configPath, JSON.stringify({
    cameras: [], cambridge: { bind: '127.0.0.1', port: 0, camdUrl: 'ws://127.0.0.1:1/ws' },
    logging: { dir: join(dir, 'logs'), level: 'error' },
    auth: { adminPin: hashPin('test-only'), tokens: { 'test-admin': 'admin', 'test-operator': 'operator' } },
    lighting: { output: { enabled: true, dryRun: true }, companionUrl: companion.url },
  }));
  const app = createApp({ configPath });
  const { port } = await app.start();
  t.after(async () => { await app.stop(); await companion.close(); rmSync(dir, { recursive: true, force: true }); });
  const post = async (body, role) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/lighting/import/companion`, {
      method: 'POST', headers: { Authorization: `Bearer test-${role}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await post({}, 'operator')).status, 403);
  const preview = await post({}, 'admin');
  assert.deepEqual([preview.status, preview.body.dryRun, preview.body.importable], [200, true, 3]);
  assert.ok(app.lighting.view().scenes.every((s) => s.empty));
  const done = await post({ confirm: true }, 'admin');
  assert.deepEqual(done.body.imported, [1, 2, 5]);
  assert.equal(app.lighting.view().scenes[0].empty, false);
});
