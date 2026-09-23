// DC-1 (audit 2026-09-23): the Node service must present camd's per-launch
// token on every REST call, on the event WebSocket and on the live view proxy,
// and must never send an Origin header (camd refuses any request with one).
//
// A plain HTTP server stands in for camd and records what it receives. No
// daemon, camera or network beyond loopback is involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { CamdClient, resolveCamdToken } from '../src/camd-client.js';

const TOKEN = 'a'.repeat(64);

async function recorder() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, origin: req.headers.origin });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ method: 'UPGRADE', url: req.url, auth: req.headers.authorization, origin: req.headers.origin });
    socket.destroy();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, server, port: server.address().port };
}

test('every camd REST call and the event socket carry the bearer token and no Origin', async () => {
  const { seen, server, port } = await recorder();
  const client = new CamdClient({
    baseUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws`, token: TOKEN, log: () => {},
  });
  try {
    await client.health();
    await client.action('cam1', 'recordStart');
    await client.setProperty('cam1', 'iso', 800);
    const lv = await client.fetchLiveview('cam1', true);
    await lv.arrayBuffer();
    client.start();
    for (let i = 0; i < 50 && !seen.some((s) => s.method === 'UPGRADE'); i++) await new Promise((r) => setTimeout(r, 20));
  } finally {
    client.stop();
    server.close();
  }
  assert.deepEqual(seen.map((s) => s.method), ['GET', 'POST', 'PUT', 'GET', 'UPGRADE'].slice(0, seen.length));
  assert.ok(seen.some((s) => s.method === 'UPGRADE'), 'the event socket was opened');
  for (const s of seen) {
    assert.equal(s.auth, `Bearer ${TOKEN}`, `${s.method} ${s.url} carried the token`);
    assert.equal(s.origin, undefined, `${s.method} ${s.url} sent no Origin`);
  }
});

test('the token comes from CAMD_AUTH_TOKEN first, then camd.authToken', () => {
  assert.equal(resolveCamdToken({ authToken: 'b'.repeat(40) }, {}), 'b'.repeat(40));
  assert.equal(resolveCamdToken({ authToken: 'b'.repeat(40) }, { CAMD_AUTH_TOKEN: 'c'.repeat(40) }), 'c'.repeat(40));
  assert.equal(resolveCamdToken({}, {}), null);
});
