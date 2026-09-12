import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GphotoCamera, parseDiscovery, parseWidgets } from '../src/external/gphoto.js';
import { BlackmagicCamera } from '../src/external/blackmagic.js';
import { ExternalManager, externalCatalog, validateExternal } from '../src/external/manager.js';
import { blackmagicSimulator, usbConfig } from './external-simulator.js';
const usb = { id: 'ext-usb', provider: 'gphoto2', model: 'Canon EOS R5', port: 'usb:001,002', serial: 'SERIAL-A' };
function rig(adapter) {
  let saved = { cameras: [], ptz: { cameras: [] }, external: { cameras: [] }, untouched: true };
  const manager = new ExternalManager({ adoption: { readConfig: () => structuredClone(saved), writeConfig: c => { saved = c; } }, factory: () => adapter });
  return { manager, config: () => saved };
}
test('USB discovery keeps same-model ports separate and leaves Sony to SDK', () => {
  assert.deepEqual(parseDiscovery('Model Port\nCanon EOS R5 usb:001,002\nCanon EOS R5 usb:001,003\nSony ILCE-7M4 usb:001,004'), [{ model: 'Canon EOS R5', port: 'usb:001,002' }, { model: 'Canon EOS R5', port: 'usb:001,003' }]);
});
test('USB metadata exposes only writable exposure controls, not format or read-only shutter', () => {
  assert.deepEqual(parseWidgets(usbConfig()).map(c => c.key), ['/main/imgsettings/iso']);
});
test('USB writes use serial-bound helper, validate fresh choices and confirm readback', async () => {
  let iso = '100'; const calls = [];
  const run = async args => args.includes('--get-config') ? 'Current: SERIAL-A\n' : usbConfig({ iso });
  const camera = new GphotoCamera(usb, run, async (config, action, key, value) => { calls.push({ config, action, key, value }); iso = '400'; });
  await camera.set('/main/imgsettings/iso', 1); assert.equal(calls[0].config.serial, 'SERIAL-A'); assert.equal(calls[0].action, 'set');
  await assert.rejects(camera.set('/main/settings/format', 1), RangeError);
  await assert.rejects(camera.set('/main/imgsettings/iso', 99), RangeError); assert.equal(calls.length, 1);
});
test('USB serial mismatch stops before helper mutation', async () => {
  const camera = new GphotoCamera(usb, async () => 'Current: SERIAL-B\n', () => assert.fail('must not write'));
  await assert.rejects(camera.set('/main/imgsettings/iso', 1), /identity changed/);
});
test('USB capture rejects read-only Bulb and RAM targets', async () => {
  for (const config of [usbConfig({ bulb: true }), usbConfig().replace('Current: Memory card', 'Current: Internal RAM')]) {
    const camera = new GphotoCamera(usb, async args => args.includes('--get-config') ? 'Current: SERIAL-A' : config, () => assert.fail('must not capture'));
    assert.equal((await camera.snapshot()).canCapture, false); await assert.rejects(camera.capture(), RangeError);
  }
});
test('Blackmagic reads capabilities, sets native ISO and controls recording with readback', async t => {
  const sim = await blackmagicSimulator(); t.after(() => sim.close());
  const camera = new BlackmagicCamera({ host: '127.0.0.1', port: sim.port });
  assert.equal((await camera.snapshot()).controls.length, 1);
  assert.equal((await camera.set('iso', 800)).controls[0].current, 800);
  assert.equal((await camera.record(true)).recording, true);
  assert.equal((await camera.record(false)).recording, false);
  await camera.record(false); assert.equal(sim.state.writes.at(-1).path, '/transports/0/stop', 'Stop is sent even after an idle reading');
  await assert.rejects(camera.set('iso', 799), RangeError);
});
test('Blackmagic refuses HTTP errors, invalid JSON, and unconfirmed writes', async t => {
  const sim = await blackmagicSimulator(); t.after(() => sim.close()); const camera = new BlackmagicCamera({ host: '127.0.0.1', port: sim.port });
  sim.state.ignore = true; await assert.rejects(camera.record(true), /did not confirm/);
  sim.state.refuse = true; await assert.rejects(camera.set('iso', 800), /HTTP 403/);
  sim.state.invalid = true; await assert.rejects(camera.snapshot(), /invalid JSON/);
});
test('priority Stop runs during background poll; stale poll cannot restore recording', async t => {
  let release; const poll = new Promise(r => { release = r; });
  const { manager } = rig({ snapshot: () => poll, record: async () => ({ recording: false, canRecord: true, controls: [] }) });
  manager.install({ id: 'ext-bmd', provider: 'blackmagic-rest' }, { recording: true, canRecord: true, controls: [] });
  t.after(() => manager.stop());
  const pending = manager.action('ext-bmd', 'status');
  await manager.action('ext-bmd', 'recordStop');
  release({ recording: true, canRecord: true, controls: [] }); await pending;
  assert.equal(manager.view()[0].status.recording, false);
});
test('invalid control value preserves known connected state', async t => {
  const { manager } = rig({ set: async () => { throw new RangeError('Value is outside the camera range'); } });
  manager.install(usb, { recording: null, controls: [] }); t.after(() => manager.stop());
  await assert.rejects(manager.action(usb.id, 'set', {}), RangeError); assert.equal(manager.view()[0].state, 'connected');
});
test('external adoption persists verified identity, redacts credentials, preserves other config', async t => {
  const { manager, config } = rig({ snapshot: async () => ({ serial: 'SERIAL-A', controls: [], recording: null, canRecord: false }) }); t.after(() => manager.stop());
  await manager.add({ ...usb, serial: 'caller-forged' }); assert.equal(config().external.cameras[0].serial, 'SERIAL-A'); assert.equal(config().untouched, true);
  assert.ok(!JSON.stringify(manager.view()).includes('SERIAL-A'));
  await assert.rejects(manager.add({ ...usb, id: 'ext-second', port: 'usb:001,003' }), /serial already/);
  manager.remove(usb.id); assert.equal(config().external.cameras.length, 0);
});
test('catalog contains new stills and cinema brands and validation rejects dangerous endpoints', () => {
  const models = externalCatalog().models;
  for (const brand of ['Canon', 'Nikon', 'Fujifilm', 'Olympus', 'Leica', 'Pentax', 'Sigma', 'Panasonic', 'Blackmagic Design']) assert.ok(models.some(m => m.brand === brand));
  assert.equal(new Set(models.map(m => m.id)).size, models.length);
  assert.throws(() => validateExternal({ ...usb, port: '--shell' }));
  assert.throws(() => validateExternal({ id: 'ext-bmd', provider: 'blackmagic-rest', host: '239.1.1.1' }));
});

test('Stop overtakes delayed Start preflight and prevents its later hardware mutation', async () => {
  const camera = new BlackmagicCamera({}); const writes = []; let release, first = true;
  const blocked = new Promise(r => { release = r; }); let recording = false, valid = true;
  camera.request = async (path, method = 'GET') => {
    if (method !== 'GET') { writes.push(path); recording = path.endsWith('/record'); return; }
    if (path === '/system/product') return { productName: 'Blackmagic PYXIS 6K' };
    if (first) { first = false; await blocked; }
    return { recording };
  };
  const start = camera.record(true, () => valid); await Promise.resolve(); await Promise.resolve();
  valid = false; await camera.record(false); release(); await assert.rejects(start, /superseded/);
  assert.deepEqual(writes, ['/transports/0/stop']); assert.equal(recording, false);
});

test('already-dispatched recording mutation settles before priority Stop is transmitted', async () => {
  const camera = new BlackmagicCamera({}); let release; const blocked = new Promise(r => { release = r; }), writes = []; let recording = false;
  camera.request = async (path, method = 'GET') => {
    if (method !== 'GET') { writes.push(path); if (path.endsWith('/record')) await blocked; recording = path.endsWith('/record'); return; }
    return path === '/system/product' ? { productName: 'Blackmagic PYXIS 6K' } : { recording };
  };
  const start = camera.record(true); while (!writes.length) await Promise.resolve();
  const stop = camera.record(false); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(writes, ['/transports/0/record']); release(); await Promise.allSettled([start, stop]);
  assert.deepEqual(writes, ['/transports/0/record', '/transports/0/stop']); assert.equal(recording, false);
});

test('Start queued behind polling is cancelled when a newer Stop arrives', async t => {
  let release; const blocked = new Promise(r => { release = r; }); const writes = [];
  const { manager } = rig({ snapshot: () => blocked, record: async start => { writes.push(start); return { recording: start, canRecord: true, controls: [] }; } });
  manager.install({ id: 'ext-bmd', provider: 'blackmagic-rest' }, { recording: false, canRecord: true, controls: [] }); t.after(() => manager.stop());
  const poll = manager.action('ext-bmd', 'status'); const start = manager.action('ext-bmd', 'recordStart');
  const rejection = assert.rejects(start, /superseded/); await manager.action('ext-bmd', 'recordStop'); release({ recording: false, canRecord: true, controls: [] });
  await poll; await rejection; assert.deepEqual(writes, [false]);
});
