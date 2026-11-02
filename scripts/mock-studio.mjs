// A simulated studio for the phone app: CamBridge with three simulated Sony
// bodies (camd's in-memory backend), lighting in dry run, its own ports, its
// own Bluetooth socket, and a temporary config. Nothing here can reach a real
// camera or light, and it runs beside the real CamBridge without touching it.
//
//   node scripts/mock-studio.mjs                 on 127.0.0.1:8089
//   node scripts/mock-studio.mjs --lan           reachable from the phone on the studio network
//   node scripts/mock-studio.mjs --lan --pair    …and print a pairing link for the app
//   node scripts/mock-studio.mjs --advertise     announce it over Bonjour as "CamBridge (simulated)"
//
// For the app's automated tests: --json prints one line of JSON first
// ({base, socket, uri}); --relay then carries one phone's Bluetooth chunks
// over stdin/stdout as newline JSON ({t:"connect",mtu} / {t:"write",d} in,
// {t:"notify",d} / {t:"block"} out), in place of the Swift bridge.
//
// Without camd built (camd/build/camd, or --camd PATH) it runs with no
// cameras, lighting only.

import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';

const root = new URL('../', import.meta.url);
const has = (f) => process.argv.includes(`--${f}`);
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };
const json = has('json');
const say = (s) => { if (!json) process.stdout.write(`${s}\n`); else process.stderr.write(`${s}\n`); };

const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const dir = mkdtempSync(join(tmpdir(), 'cambridge-mock-'));
const configPath = join(dir, 'cambridge.json');
const camdBin = arg('camd', new URL('camd/build/camd', root).pathname);
const withCamd = existsSync(camdBin);
const camdPort = await freePort();
const port = Number(arg('port', '8089'));
const socket = join(dir, 'ble.sock');

writeFileSync(configPath, JSON.stringify({
  cambridge: {
    bind: has('lan') ? '0.0.0.0' : '127.0.0.1', port, name: 'CamBridge (simulated)',
    mdns: has('advertise'), ble: { socket },
  },
  camd: { bind: '127.0.0.1', restPort: camdPort, wsPath: '/ws' },
  logging: { dir: join(dir, 'logs'), level: 'warn' },
  cameras: withCamd ? [
    { id: 'fx3', label: 'FX3 — Wide', model: 'ILME-FX3', mac: 'AA:BB:CC:00:00:01', ip: '127.0.0.1', auth: { username: 'simulated', password: 'simulated' } },
    { id: 'fx30-a', label: 'FX30 — Centre', model: 'ILME-FX30', mac: 'AA:BB:CC:00:00:02', ip: '127.0.0.1', auth: { username: 'simulated', password: 'simulated' } },
    { id: 'fx30-b', label: 'FX30 — Tight', model: 'ILME-FX30', mac: 'AA:BB:CC:00:00:03', ip: '127.0.0.1', auth: { username: 'simulated', password: 'simulated' } },
  ] : [],
  lighting: { output: { enabled: true, dryRun: true } },
}, null, 2), { mode: 0o600 });

let camd = null;
const cleanup = async (app) => {
  try { await app?.stop(); } catch { /* stopping */ }
  camd?.kill();
  rmSync(dir, { recursive: true, force: true });
};

if (withCamd) {
  process.env.CAMD_AUTH_TOKEN = randomBytes(32).toString('hex');
  camd = spawn(camdBin, ['--config', configPath, '--fake'], { stdio: ['ignore', 'ignore', 'inherit'], env: process.env });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${camdPort}/health`, { headers: { Authorization: `Bearer ${process.env.CAMD_AUTH_TOKEN}` } });
      if (r.ok) break;
    } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
} else {
  process.env.CAMBRIDGE_CAMD = 'off';
  say(`(no camd at ${camdBin}: running without cameras)`);
}

const { createApp } = await import(new URL('cambridge/src/server.js', root).href);
const app = createApp({ configPath, advertise: has('advertise') });
const address = await app.start();
const base = `http://127.0.0.1:${address.port}`;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await cleanup(app); process.exit(0); });

// Wait for the simulated bodies to connect.
if (withCamd) {
  for (let i = 0; i < 50; i++) {
    const s = await (await fetch(`${base}/api/state`)).json();
    if (s.view.cameras.filter((c) => c.state === 'connected').length === 3) break;
    await new Promise((r) => setTimeout(r, 200));
  }
}

let uri = null;
if (has('pair') || json) {
  const made = await (await fetch(`${base}/api/devices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'test' }) })).json();
  uri = made.pairing.uri;
}

if (json) process.stdout.write(`${JSON.stringify({ base, socket, uri, cameras: withCamd ? 3 : 0 })}\n`);
say(`Simulated CamBridge on ${address.urls?.join('  ') ?? base}`);
if (uri && !json) say(`Pairing link (valid 10 min): ${uri}`);

if (has('relay')) {
  const { FakeBridge } = await import(new URL('cambridge/src/ble/test-client.js', root).href);
  const bridge = new FakeBridge(socket);
  await bridge.open();
  const central = 'stdio-phone';
  bridge.phones.set(central, { receiveChunk: (c) => process.stdout.write(`${JSON.stringify({ t: 'notify', d: c.toString('base64') })}\n`) });
  bridge.on('block', (b) => { if (b.c === central) process.stdout.write(`${JSON.stringify({ t: 'block' })}\n`); });
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const m = JSON.parse(line);
    if (m.t === 'connect') bridge.send({ t: 'connect', c: central, mtu: m.mtu });
    else if (m.t === 'write') bridge.send({ t: 'write', c: central, d: m.d });
    else if (m.t === 'disconnect') bridge.send({ t: 'disconnect', c: central });
  });
  rl.on('close', async () => { bridge.close(); await cleanup(app); process.exit(0); });
} else if (json) {
  createInterface({ input: process.stdin }).on('close', async () => { await cleanup(app); process.exit(0); });
}
