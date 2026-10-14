// Whether a venue needs camd, and the first config a fresh install gets.
//
// A Mac set up for PTZ heads (or stills and cinema cameras) alone has no Sony
// SDK and no daemon. It used to refuse to start on first run — an empty config
// meant "expect camd" — until someone edited the config by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { camdMode, camdNeeded, starterConfig } from '../src/venue.js';
import { createApp } from '../src/server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENUE = join(ROOT, 'cambridge', 'src', 'venue.js');
const EXAMPLE = join(ROOT, 'config', 'cambridge.example.json');

test('camd is required by Sony bodies, not by PTZ heads or stills/cinema cameras', () => {
  assert.equal(camdMode({ cameras: [] }), 'optional', 'nothing added yet');
  assert.equal(camdMode({}), 'optional');
  assert.equal(camdMode({ cameras: [], external: { cameras: [{ id: 'ext-a' }] } }), 'optional',
    'stills/cinema cameras alone do not need camd, but a built one may still discover Sony bodies');
  assert.equal(camdMode({ cameras: [{ kind: 'ptz' }, { kind: 'ptz' }] }), 'no');
  assert.equal(camdMode({ cameras: [{ kind: 'ptz' }, { model: 'ILME-FX3' }] }), 'yes');
  assert.equal(camdMode({ camd: { enabled: false }, cameras: [{ model: 'ILME-FX3' }] }), 'no');
  assert.equal(camdMode({ camd: { enabled: true }, cameras: [{ kind: 'ptz' }] }), 'yes');
});

test('the server expects camd unless the launcher says it did not start it', () => {
  assert.equal(camdNeeded({ cameras: [] }), true);
  assert.equal(camdNeeded({ cameras: [] }, { CAMBRIDGE_CAMD: 'off' }), false);
  assert.equal(camdNeeded({ cameras: [{ kind: 'ptz' }] }), false);
});

test('a starter config keeps the example settings and none of its cameras', () => {
  const example = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  assert.ok(example.cameras.length > 0, 'the example has placeholder cameras to leave out');
  const cfg = JSON.parse(starterConfig(readFileSync(EXAMPLE, 'utf8')));
  assert.deepEqual(cfg.cameras, []);
  assert.deepEqual(cfg.cambridge, example.cambridge);
  assert.ok(!Object.keys(cfg).some((k) => k.startsWith('$')));
  assert.equal(camdMode(cfg), 'optional');
});

test('the launcher helper writes the starter config at 0600 and never over an existing one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-venue-'));
  try {
    const target = join(dir, 'cambridge.json');
    execFileSync(process.execPath, [VENUE, '--init', target, EXAMPLE]);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.equal(execFileSync(process.execPath, [VENUE, target]).toString(), 'optional');
    writeFileSync(target, JSON.stringify({ cameras: [{ kind: 'ptz' }] }));
    assert.throws(() => execFileSync(process.execPath, [VENUE, '--init', target, EXAMPLE], { stdio: 'pipe' }));
    assert.equal(execFileSync(process.execPath, [VENUE, target]).toString(), 'no');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('started without camd on a fresh config, the panel is told camd is not in use', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-venue-app-'));
  const configPath = join(dir, 'cambridge.json');
  const cfg = JSON.parse(starterConfig(readFileSync(EXAMPLE, 'utf8')));
  cfg.cambridge = { ...cfg.cambridge, bind: '127.0.0.1', port: 0 };
  cfg.logging = { dir: join(dir, 'logs'), level: 'error' };
  writeFileSync(configPath, JSON.stringify(cfg));
  const before = process.env.CAMBRIDGE_CAMD;
  process.env.CAMBRIDGE_CAMD = 'off';
  const app = createApp({ configPath });
  if (before === undefined) delete process.env.CAMBRIDGE_CAMD; else process.env.CAMBRIDGE_CAMD = before;
  const { port } = await app.start();
  t.after(async () => { await app.stop(); rmSync(dir, { recursive: true, force: true }); });
  const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(state.view.camdUsed, false, 'no "daemon unreachable" for a daemon nobody started');
});
