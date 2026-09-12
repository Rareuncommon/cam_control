import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Adoption, cameraIdentity, normaliseMac } from '../src/adopt.js';
import { requiredRole } from '../src/auth.js';
const usb = n => ({ model: 'ILCE-7M4', mac: '', ip: '', deviceId: `sony-sdk:1:0${n}`, transport: 'USB' });
function rig(t, discovered = [usb(1), usb(2)], post) {
  const dir = mkdtempSync(join(tmpdir(), 'cambridge-adopt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const adoption = new Adoption(join(dir, 'config.json'), { request: async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET') return { ok: true, body: { discovered } };
    if (method === 'POST' && post) await post();
    return { ok: true, body: {} };
  } }, { info() {}, error() {} });
  return { adoption, calls };
}
test('USB identity survives absent and placeholder network addresses', () => {
  for (const mac of ['', '00:00:00:00:00:00', 'FF:FF:FF:FF:FF:FF']) {
    assert.equal(normaliseMac(mac), null);
    assert.equal(cameraIdentity({ ...usb(1), mac }), 'device:sony-sdk:1:01');
  }
  assert.equal(cameraIdentity({ deviceId: 'Sony A7 IV' }), null);
});
test('two same-model USB adoptions serialize, retain both bodies, and reject a repeat', async t => {
  const { adoption } = rig(t);
  const results = await Promise.all([adoption.adopt(usb(1)), adoption.adopt(usb(2))]);
  assert.ok(results.every(r => r.ok));
  const saved = adoption.adopted();
  assert.equal(saved.length, 2);
  assert.equal(new Set(saved.map(c => c.id)).size, 2);
  assert.deepEqual(saved.map(c => c.deviceId), ['sony-sdk:1:01', 'sony-sdk:1:02']);
  assert.equal((await adoption.adopt(usb(1))).ok, false);
});
test('adoption trusts discovery metadata and refuses missing or ambiguous identities', async t => {
  const { adoption } = rig(t);
  const result = await adoption.adopt({ ...usb(1), model: 'Forged', ip: '192.0.2.5' });
  assert.equal(result.camera.model, 'ILCE-7M4');
  assert.equal(result.camera.ip, '');
  assert.equal((await adoption.adopt(usb(3))).ok, false);
  const ambiguous = rig(t, [usb(1), usb(1)]).adoption;
  assert.equal((await ambiguous.adopt(usb(1))).ok, false);
});
test('required body credentials are enforced from discovery', async t => {
  const { adoption } = rig(t, [{ ...usb(1), accessAuthRequired: true }]);
  assert.equal((await adoption.adopt(usb(1))).ok, false);
  assert.equal((await adoption.adopt({ ...usb(1), username: 'user', password: 'test-only' })).ok, true);
});
test('a PIN saved during runtime adoption is preserved in the resulting config', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const block = new Promise(resolve => { release = resolve; });
  const { adoption } = rig(t, [usb(1)], async () => { entered(); await block; });
  const pending = adoption.adopt(usb(1));
  await waiting;
  const auth = { adminPin: { salt: 'test-salt', hash: 'test-hash' } };
  assert.equal(adoption.saveAuth(auth).ok, true);
  release();
  assert.equal((await pending).ok, true);
  assert.deepEqual(adoption.readConfig().auth, auth);
});
test('editing the actual adoption route requires admin, while live controls remain operator', () => {
  assert.equal(requiredRole('PATCH', '/api/cameras/usb/adoption'), 'admin');
  assert.equal(requiredRole('DELETE', '/api/cameras/usb/adoption'), 'admin');
  assert.equal(requiredRole('POST', '/api/cameras/usb/actions/recordStart'), 'operator');
});
