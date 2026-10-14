#!/usr/bin/env node
// Rehearse the PTZ side of CamBridge with no cameras: the real drivers against
// protocol fakes.
//
// The simulated heads in config/ptz-sim.example.json sit behind the driver
// contract directly — good for the panel, but none of the vendor code runs.
// This starts protocol fakes for all four makes (the same ones the tests use,
// built from the vendors' documents), writes a config pointing CamBridge's
// real Panasonic, Sony, Canon and PTZOptics drivers at them, and starts
// CamBridge. Every byte between CamBridge and a "camera" is the real wire
// format as we read it.
//
// What it cannot tell you is whether a real camera agrees with that reading;
// that is what scripts/ptz-report.sh is for, on site.
//
// Usage:
//   node scripts/ptz-rehearse.mjs                 four cameras, one of each make
//   node scripts/ptz-rehearse.mjs --cameras 24    twenty-four, the makes in turn
//   node scripts/ptz-rehearse.mjs --port 8090     CamBridge on another port

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(join(ROOT, p)).href);
const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };

const count = Math.max(1, Math.min(96, Number(arg('cameras', 4)) || 4));
const port = Number(arg('port', 8088));
// Made-up credentials for fakes on this machine's loopback; nothing real.
const username = 'admin';
const password = 'rehearsal';

const { startFakePanasonic } = await load('cambridge/test/fakes/panasonic-aw.js');
const { startFakeSony } = await load('cambridge/test/fakes/sony-brc.js');
const { startFakeCanon } = await load('cambridge/test/fakes/canon-xc.js');
const { startFakePtzoptics } = await load('cambridge/test/fakes/ptzoptics.js');
const { createApp } = await load('cambridge/src/server.js');

const MAKES = [
  { vendor: 'panasonic', model: 'AW-UE160', start: () => startFakePanasonic({ username, password }) },
  { vendor: 'sony', model: 'BRC-AM7', start: () => startFakeSony({ port: 0, viscaPort: 0, username, password }) },
  { vendor: 'canon', model: 'CR-N500', start: () => startFakeCanon({ username, password }) },
  { vendor: 'ptzoptics', model: 'Move SE', start: () => startFakePtzoptics({ port: 0, viscaPort: 0, username, password }) },
];

// All fakes share 127.0.0.1. Panasonic's change notifications are routed by
// the camera's address, so with more than one Panasonic on one address they
// would cross; those cameras are polled only. A real venue has one address
// per camera and keeps push.
const panasonicCount = Array.from({ length: count }, (_, i) => MAKES[i % 4]).filter((m) => m.vendor === 'panasonic').length;

const fakes = [];
const cameras = [];
for (let i = 0; i < count; i++) {
  const make = MAKES[i % MAKES.length];
  const fake = await make.start();
  fakes.push(fake);
  const n = i + 1;
  cameras.push({
    id: `${make.vendor}-${n}`,
    kind: 'ptz',
    vendor: make.vendor,
    label: `${make.model} ${n}`,
    model: make.model,
    ip: '127.0.0.1',
    port: fake.port,
    group: i < count / 2 ? 'Stage' : 'House',
    auth: { username, password },
    options: {
      ...(fake.viscaPort ? { viscaPort: fake.viscaPort } : {}),
      ...(make.vendor === 'panasonic' && panasonicCount > 1 ? { push: false } : {}),
    },
  });
}

const dir = mkdtempSync(join(tmpdir(), 'cambridge-rehearse-'));
const configPath = join(dir, 'cambridge.json');
writeFileSync(configPath, JSON.stringify({
  cambridge: { bind: '0.0.0.0', port },
  logging: { dir: join(dir, 'logs'), level: 'info' },
  cameras,
}, null, 2), { mode: 0o600 });

const app = createApp({ configPath });
const { urls } = await app.start();
process.stdout.write(`\nRehearsal: ${count} fake PTZ camera(s) — ${MAKES.map((m) => m.model).join(', ')} in turn\n`);
process.stdout.write(`  Open:    ${urls[0]}\n  Config:  ${configPath}\n  Logs:    ${join(dir, 'logs')}\n\nCtrl-C stops it.\n`);

const stop = async () => {
  await app.stop();
  await Promise.all(fakes.map((f) => f.close?.()));
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
