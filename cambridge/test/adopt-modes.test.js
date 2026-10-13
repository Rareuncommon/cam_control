// writeConfig must leave the config, its .bak and the temp file at 0600 even
// when stale 0644 copies already exist (`mode` is ignored on existing files).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, statSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Adoption } from '../src/adopt.js';

const mode = (p) => statSync(p).mode & 0o777;

test('writeConfig ends with config, .bak and .tmp at 0600 from 0644 starts', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-modes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'cambridge.json');

  writeFileSync(path, '{"old":true}\n');
  chmodSync(path, 0o644);
  writeFileSync(`${path}.tmp`, 'stale');
  chmodSync(`${path}.tmp`, 0o644);

  new Adoption(path, null, null).writeConfig({ cameras: [], auth: { tokens: { abc: 'operator' } } });

  assert.equal(mode(path), 0o600);
  assert.equal(mode(`${path}.bak`), 0o600);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).cameras.length, 0);
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), '{"old":true}\n');
  // The temp file is renamed into place; if one remains it must still be private.
  if (existsSync(`${path}.tmp`)) assert.equal(mode(`${path}.tmp`), 0o600);
});
