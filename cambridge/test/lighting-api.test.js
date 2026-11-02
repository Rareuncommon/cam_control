// The lighting API through the real HTTP server: roles, the routes, the live
// stream, a restart, and that the camera side carries on regardless. Output
// is in dry-run throughout, so the frames are checked without sending any.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.js';
import { hashPin } from '../src/auth.js';
import { handleLighting } from '../src/lighting/routes.js';

const STUDIO = [175, 12, 178, 12, 20, 12, 30, 12, 6, 12];
const LYRA = 'ikan-lyra-lbx8-poe-2ch';

function setup(t, lighting = { output: { enabled: true, dryRun: true } }) {
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-lighting-'));
  const configPath = join(dir, 'cambridge.json');
  writeFileSync(configPath, JSON.stringify({
    cameras: [],
    cambridge: { bind: '127.0.0.1', port: 0, camdUrl: 'ws://127.0.0.1:1/ws' },
    logging: { dir: join(dir, 'logs'), level: 'info' },
    auth: { adminPin: hashPin('test-only'), tokens: { 'test-admin': 'admin', 'test-operator': 'operator' } },
    lighting,
  }));
  const ctx = { dir, configPath, app: null, base: null };
  ctx.start = async () => {
    ctx.app = createApp({ configPath });
    const address = await ctx.app.start();
    ctx.base = `http://127.0.0.1:${address.port}`;
  };
  ctx.req = async (path, method = 'GET', body, role = 'operator') => {
    const r = await fetch(ctx.base + path, {
      method,
      headers: { Authorization: `Bearer test-${role}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: r.status, headers: r.headers, body: await r.json() };
  };
  ctx.config = () => JSON.parse(readFileSync(configPath, 'utf8'));
  t.after(async () => { await ctx.app?.stop(); rmSync(dir, { recursive: true, force: true }); });
  return ctx;
}

/** Reads server-sent events into an array until stopped. */
async function stream(url, token) {
  const ac = new AbortController();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, at);
          buf = buf.slice(at + 2);
          if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
        }
      }
    } catch { /* aborted */ }
  })();
  const until = async (pred, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no matching event');
  };
  return { events, until, close: () => ac.abort() };
}

test('lighting API: operator controls, admin patch, scenes, output and export', async (t) => {
  const c = setup(t);
  await c.start();

  const first = await c.req('/api/lighting');
  assert.equal(first.status, 200);
  assert.equal(first.body.fixtures.length, 5);
  assert.equal(first.body.output.state, 'dry-run');
  assert.equal(first.body.known, false);
  assert.equal(first.body.profiles[0].channels.length, 2, 'the full view carries profile definitions');
  assert.deepEqual((await c.req('/api/lighting/frames')).body.frames, {}, 'nothing yet');

  assert.equal((await c.req('/api/lighting/looks/studio/recall', 'POST', {})).status, 200);
  assert.deepEqual((await c.req('/api/lighting/frames')).body.frames['1'].slice(0, 10), STUDIO);

  assert.equal((await c.req('/api/lighting/set', 'POST', { intensity: 50 })).status, 400, 'a target is required');
  assert.equal((await c.req('/api/lighting/set', 'POST', '{"target":')).status, 400, 'bad JSON is a 400');
  assert.equal((await c.req('/api/lighting/set', 'POST', { target: { fixture: 'L3' }, intensity: 10, relative: true })).status, 200);
  assert.equal((await c.req('/api/lighting')).body.fixtures[2].dmx[0], 46, 'L3 20 → 46 (+10 %)');

  // Scenes are operator-level: Companion's hold-to-save is an operator press.
  assert.equal((await c.req('/api/lighting/scenes/1', 'PUT', { name: 'Interview' })).status, 200);
  assert.equal((await c.req('/api/lighting/scenes/1', 'PATCH', { name: 'Panel' })).status, 200);
  assert.equal((await c.req('/api/lighting/looks/off/recall', 'POST', { fadeMs: 0 })).status, 200);
  assert.equal((await c.req('/api/lighting/scenes/1/recall', 'POST', { fadeMs: 0 })).status, 200);
  const v = (await c.req('/api/lighting')).body;
  assert.deepEqual(v.active, { type: 'scene', slot: 1 });
  assert.equal(v.scenes[0].name, 'Panel');
  assert.equal((await c.req('/api/lighting/scenes/studio', 'PUT', {})).status, 404, 'the looks are not scene slots');
  assert.equal((await c.req('/api/lighting/scenes/2/recall', 'POST', {})).status, 409);
  assert.equal((await c.req('/api/lighting/fixtures/l2/identify', 'POST', { ms: 1000 })).status, 200);

  // Output: on/off and dry-run for operators, the network for admin.
  assert.equal((await c.req('/api/lighting/output', 'PUT', { enabled: false })).body.output.state, 'off');
  const refused = await c.req('/api/lighting/output', 'PUT', { priority: 150 });
  assert.equal(refused.status, 403);
  assert.equal((await c.req('/api/lighting/output', 'PUT', { priority: 150 }, 'admin')).status, 200);
  assert.equal(c.config().lighting.output.priority, 150);
  assert.equal((await c.req('/api/lighting/output', 'PUT', { enabled: true }, 'admin')).status, 200);

  // The patch is admin.
  const l6 = { name: 'L6', profile: LYRA, ip: '192.168.220.56', universe: 1, address: 11 };
  assert.equal((await c.req('/api/lighting/fixtures', 'POST', l6)).status, 403);
  const clash = await c.req('/api/lighting/fixtures', 'POST', { ...l6, address: 10 }, 'admin');
  assert.equal(clash.status, 400);
  assert.ok(clash.body.errors.some((e) => e.fixture === 'l6' && e.field === 'address'));
  assert.equal((await c.req('/api/lighting/fixtures', 'POST', l6, 'admin')).status, 200);
  assert.equal((await c.req('/api/lighting/fixtures/l6', 'PUT', { address: 20 })).status, 403);
  assert.equal((await c.req('/api/lighting/fixtures/l6', 'PUT', { address: 20 }, 'admin')).body.fixture.address, 20);
  assert.equal((await c.req('/api/lighting/fixtures/l6', 'DELETE', undefined, 'admin')).status, 200);
  assert.equal((await c.req('/api/lighting/profiles', 'POST', { id: 'x', name: 'x', channels: [{ type: 'intensity' }] })).status, 403);

  assert.equal((await c.req('/api/lighting/export')).status, 403);
  const exp = await c.req('/api/lighting/export', 'GET', undefined, 'admin');
  assert.match(exp.headers.get('content-disposition'), /cambridge-lighting\.json/);
  assert.equal(exp.body.type, 'cambridge-lighting');
  const preview = await c.req('/api/lighting/import', 'POST', { doc: exp.body }, 'admin');
  assert.deepEqual([preview.status, preview.body.dryRun], [200, true]);
  assert.equal((await c.req('/api/lighting/import', 'POST', { doc: exp.body })).status, 403);

  assert.equal((await c.req('/api/lighting/nope')).status, 404);
  assert.equal((await c.req('/api/state')).status, 200, 'the camera API is unaffected');

  const log = readFileSync(join(c.dir, 'logs', 'cambridge.log'), 'utf8');
  assert.match(log, /lighting.*scene 1 saved as "Interview"/);
  assert.match(log, /lighting.*output change REFUSED \(admin\)/);
});

test('lighting rides the live stream, as a change-only patch', async (t) => {
  const c = setup(t);
  await c.start();
  const s = await stream(`${c.base}/api/events?patch=1`, 'test-operator');
  t.after(() => s.close());
  const first = await s.until((e) => e.type === 'state');
  assert.equal(first.lighting.fixtures.length, 5);
  assert.equal(first.lighting.known, false);

  await c.req('/api/lighting/looks/studio/recall', 'POST', {});
  const patch = await s.until((e) => e.type === 'patch' && e.lighting?.known);
  assert.deepEqual(patch.lighting.fixtures.map((f) => f.dmx), [[175, 12], [178, 12], [20, 12], [30, 12], [6, 12]]);
  assert.deepEqual(patch.lighting.active, { type: 'look', id: 'studio' });
  assert.equal(patch.lighting.profiles[0].channels, undefined, 'the stream leaves profile definitions out');

  // A patch with no lighting change leaves lighting out.
  const n = s.events.length;
  await c.req('/api/lighting/scenes/3', 'PUT', {});
  await s.until((e, i) => i >= n && e.type === 'patch');
  const state = (await c.req('/api/state')).body;
  assert.equal(state.lighting.scenes[2].empty, false, '/api/state carries lighting too');
});

test('a restart restores the lights and sends them at once', async (t) => {
  const c = setup(t);
  await c.start();
  await c.req('/api/lighting/set', 'POST', { target: { all: true }, intensity: 40, cct: 5600 });
  await c.app.stop();
  await c.start();
  const v = (await c.req('/api/lighting')).body;
  assert.equal(v.known, true);
  assert.deepEqual(v.fixtures.map((f) => f.dmx), Array(5).fill([102, 255]));
  assert.deepEqual((await c.req('/api/lighting/frames')).body.frames['1'].slice(0, 10), [102, 255, 102, 255, 102, 255, 102, 255, 102, 255]);
});

test('a lighting config that is wrong does not stop CamBridge', async (t) => {
  const c = setup(t, { output: { enabled: true, interface: 'en99', address: '' }, fixtures: [
    { id: 'l1', name: 'L1', profile: 'no-such-profile', ip: '192.168.220.51', universe: 1, address: 1 },
  ] });
  await c.start();
  const v = (await c.req('/api/lighting')).body;
  assert.equal(v.output.state, 'error');
  assert.match(v.output.error, /en99 is not up/);
  assert.match(v.fixtures[0].errors[0], /profile/);
  assert.equal((await c.req('/api/state')).status, 200);
  assert.equal((await c.req('/api/health')).status, 200);
});

test('if lighting could not be built, its routes say why and nothing else is affected', async () => {
  const sent = [];
  const handled = await handleLighting({
    req: { method: 'GET' }, res: {}, path: '/api/lighting', lighting: null, unavailable: 'profiles folder missing',
    admin: true, actor: '', readBody: async () => ({}), sendJson: (res, status, body) => sent.push({ status, body }),
    log: { info() {} }, logGesture() {},
  });
  assert.equal(handled, true);
  assert.deepEqual(sent, [{ status: 503, body: { ok: false, error: 'lighting is not running: profiles folder missing' } }]);
  assert.equal(await handleLighting({ req: { method: 'GET' }, res: {}, path: '/api/state', lighting: null }), false);
});
