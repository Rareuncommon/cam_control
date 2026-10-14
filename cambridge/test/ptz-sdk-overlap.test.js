// A BRC-AM7 (or FR7) is both a Sony SDK camera and a PTZ head. Added as a
// head, it must not be adopted through the SDK as well: two sets of controls
// on one camera, each undoing the other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.js';
import { resetFakeHeads } from '../src/ptz/drivers/fake.js';

test('a camera already added as a PTZ head is refused for SDK adoption', async (t) => {
  resetFakeHeads();
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-overlap-'));
  const configPath = join(dir, 'cambridge.json');
  writeFileSync(configPath, JSON.stringify({
    cambridge: { bind: '127.0.0.1', port: 0, camdUrl: 'ws://127.0.0.1:1/ws' },
    logging: { dir: join(dir, 'logs'), level: 'error' },
    cameras: [{ id: 'stage', kind: 'ptz', vendor: 'fake', label: 'Stage', ip: '192.0.2.50' }],
  }));
  const app = createApp({ configPath });
  const { port } = await app.start();
  t.after(async () => { await app.stop(); rmSync(dir, { recursive: true, force: true }); });

  const r = await fetch(`http://127.0.0.1:${port}/api/adopt`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mac: '00:11:22:33:44:55', model: 'BRC-AM7', ip: '192.0.2.50', label: 'Stage SDK' }),
  });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /already added as the PTZ head "Stage"/);
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(cfg.cameras.length, 1, 'nothing was added');
});
