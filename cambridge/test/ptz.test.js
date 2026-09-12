import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { ViscaClient, viscaCommand, frameVisca } from '../src/ptz/visca-client.js';
import { PanasonicClient, panasonicCommand } from '../src/ptz/panasonic-client.js';
import { PtzManager, ptzCatalog, validateCamera } from '../src/ptz/manager.js';
import { requiredRole } from '../src/auth.js';
import { rollState } from '../src/takelog.js';
import { viscaSimulator, panasonicSimulator } from './ptz-simulator.js';
const move = (sequence, extra = {}) => ({ controlId: 'test-session', sequence, leaseMs: 700, pan: 0.5, tilt: 0, zoom: 0, ...extra });
function rig(t, send = async () => ({ acknowledged: true }), now) {
  let cfg = { cameras: [], ptz: { cameras: [] }, auth: { preserved: true } };
  const calls = [];
  const manager = new PtzManager({ adoption: { readConfig: () => structuredClone(cfg), writeConfig: value => { cfg = structuredClone(value); } }, now,
    adapterFactory: () => ({ send: async (action, body, opts) => { calls.push({ action, body: { ...body }, opts }); return send(action, body, opts); } }) });
  manager.add({ id: 'ptz-a', profile: 'visca-udp', host: '127.0.0.1' });
  t.after(() => manager.stop());
  return { manager, camera: manager.get('ptz-a'), calls, config: () => cfg };
}
test('VISCA encodes directions, diagonal movement, both stops and inquiry framing exactly', () => {
  assert.equal(viscaCommand('panTilt', { pan: -1, tilt: 1 }, { panMax: 24, tiltMax: 23 }).toString('hex'), '8101060118170101ff');
  assert.equal(viscaCommand('panTilt').toString('hex'), '8101060101010303ff');
  assert.equal(viscaCommand('zoom', { zoom: -1 }).toString('hex'), '8101040737ff');
  assert.equal(viscaCommand('zoom').toString('hex'), '8101040700ff');
  assert.equal(frameVisca(viscaCommand('probe'), 7).toString('hex'), '011000050000000781090400ff');
  assert.throws(() => viscaCommand('panTilt', { pan: NaN }));
  assert.throws(() => viscaCommand('zoom', { zoom: '1' }));
  assert.throws(() => viscaCommand('presetRecall', { slot: 256 }));
});
for (const protocol of ['visca-udp', 'visca-tcp', 'visca-raw-udp']) test(`${protocol} sends real network commands and distinguishes ACK from completion`, async t => {
  const sim = await viscaSimulator(protocol, { fragment: true, wrongSequence: true });
  const client = new ViscaClient({ host: '127.0.0.1', port: sim.port, protocol });
  t.after(async () => { client.close(); await sim.close(); });
  assert.equal((await client.send('probe')).power, 'on');
  assert.equal((await client.send('panTilt', { pan: 0.5, tilt: -0.5 })).acknowledged, true);
  assert.equal((await client.send('panTilt', {}, { completion: true })).completed, true);
  assert.equal(sim.events.length, 3);
  if (protocol === 'visca-udp') assert.equal(new Set(sim.events.map(e => e.peer.port)).size, 1);
});
test('wrong sequence alone cannot acknowledge movement', async t => {
  const sim = await viscaSimulator('visca-udp', { wrongSequence: true, wrongSequenceOnly: true });
  const client = new ViscaClient({ host: '127.0.0.1', port: sim.port, protocol: 'visca-udp', timeoutMs: 80 });
  t.after(async () => { client.close(); await sim.close(); });
  await assert.rejects(client.send('panTilt', { pan: 1 }), /did not acknowledge/);
});
test('camera refusal and ACK-only stop do not become confirmed success', async t => {
  for (const options of [{ refuse: true }, { ackOnly: true }]) {
    const sim = await viscaSimulator('visca-raw-udp', options);
    const client = new ViscaClient({ host: '127.0.0.1', port: sim.port, protocol: 'visca-raw-udp', timeoutMs: 80 });
    try { await assert.rejects(client.send('panTilt', {}, { completion: true })); } finally { client.close(); await sim.close(); }
  }
});
test('two framed cameras share a fixed reply port without mixing replies', async t => {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const replyPort = probe.address().port; await new Promise(r => probe.close(r));
  const sims = await Promise.all([viscaSimulator('visca-udp', { replyPort }), viscaSimulator('visca-udp', { replyPort })]);
  const clients = sims.map(sim => new ViscaClient({ host: '127.0.0.1', port: sim.port, replyPort, protocol: 'visca-udp' }));
  t.after(async () => { clients.forEach(c => c.close()); await Promise.all(sims.map(s => s.close())); });
  assert.ok((await Promise.all(clients.map(c => c.send('probe')))).every(r => r.power === 'on'));
});
test('expired raw TCP motion is rejected at connection, before writing', async t => {
  const sim = await viscaSimulator('visca-tcp');
  const client = new ViscaClient({ host: '127.0.0.1', port: sim.port, protocol: 'visca-tcp' });
  t.after(() => sim.close());
  let checks = 0;
  await assert.rejects(client.send('panTilt', { pan: 1 }, { valid: () => ++checks === 1 }), /expired/);
  assert.equal(sim.events.length, 0);
});
test('Panasonic translates movement, zoom and preset slots', () => {
  assert.deepEqual(panasonicCommand('panTilt', { pan: -1, tilt: 1 }), ['#PTS0199', 'pTS0199']);
  assert.deepEqual(panasonicCommand('panTilt'), ['#PTS5050', 'pTS5050']);
  assert.deepEqual(panasonicCommand('zoom'), ['#Z50', 'zS50']);
  assert.deepEqual(panasonicCommand('presetRecall', { slot: 7 }), ['#R07', 's07']);
});
test('Panasonic HTTP validates command echoes and spaces authenticated requests', async t => {
  const hash = s => createHash('md5').update(s).digest('hex');
  const sim = await panasonicSimulator((req, res) => {
    if (!req.headers.authorization) { res.writeHead(401, { 'www-authenticate': 'Digest realm="camera", nonce="testnonce", qop="auth", algorithm=MD5' }); res.end(); return true; }
    const fields = Object.fromEntries([...req.headers.authorization.matchAll(/(\w+)=(?:"([^"]*)"|([^, ]+))/g)].map(m => [m[1], m[2] ?? m[3]]));
    assert.equal(fields.response, hash(`${hash('u:camera:p')}:testnonce:${fields.nc}:${fields.cnonce}:auth:${hash('GET:' + req.url)}`));
  });
  t.after(() => sim.close());
  const client = new PanasonicClient({ host: '127.0.0.1', port: sim.port, username: 'u', password: 'p' });
  assert.equal((await client.send('panTilt', {})).acknowledged, true);
  assert.equal(sim.events[0].command, '#PTS5050');
  assert.ok(sim.events[1].at - sim.events[0].at >= 120);
});
test('HTTP 200 with an error body is refused', async t => {
  const sim = await panasonicSimulator((req, res) => { res.end('ER3'); return true; }); t.after(() => sim.close());
  await assert.rejects(new PanasonicClient({ host: '127.0.0.1', port: sim.port }).send('zoom', { zoom: 1 }), /refused/);
});
test('motion lease expires and stops both pan/tilt and zoom, closing the old session', async t => {
  let now = 1000; const { manager, camera, calls } = rig(t, undefined, () => now);
  manager.action('ptz-a', 'ptzMove', move(1, { zoom: 0.5 })); await manager.drain(camera);
  now += 701; manager.tick(); await manager.drain(camera);
  assert.deepEqual(calls.slice(-2).map(c => [c.action, c.body]), [['panTilt', { pan: 0, tilt: 0, zoom: 0 }], ['zoom', { pan: 0, tilt: 0, zoom: 0 }]]);
  assert.equal(camera.stopState, 'acknowledged');
  assert.throws(() => manager.action('ptz-a', 'ptzMove', move(2)), /Stale/);
});
test('Stop received before the first movement rejects delayed packets from that session', async t => {
  const { manager, camera, calls } = rig(t);
  manager.action('ptz-a', 'ptzStop', { controlId: 'test-session', sequence: 2 }); await manager.drain(camera);
  assert.throws(() => manager.action('ptz-a', 'ptzMove', move(1)), /Stale/);
  assert.ok(calls.every(c => !c.body.pan && !c.body.zoom));
});
test('ownership and monotonic sequence prevent another controller and stale changes', async t => {
  const { manager, camera } = rig(t);
  manager.action('ptz-a', 'ptzMove', move(4), 'operator-a'); await manager.drain(camera);
  assert.throws(() => manager.action('ptz-a', 'ptzMove', move(5), 'operator-b'), /Another controller/);
  assert.throws(() => manager.action('ptz-a', 'ptzMove', move(3), 'operator-a'), /Stale/);
});
test('superseded in-flight direction does not leave a stale applied vector', async t => {
  let release;
  const blocked = new Promise(r => { release = r; }); let first = true;
  const { manager, camera, calls } = rig(t, async () => { if (first) { first = false; await blocked; } return { acknowledged: true }; });
  t.after(() => release());
  camera.desired = { pan: 0, tilt: 0, zoom: 1 }; camera.applied = { ...camera.desired };
  manager.action('ptz-a', 'ptzMove', move(1, { pan: 1, zoom: 1 }));
  manager.action('ptz-a', 'ptzMove', move(2, { pan: 0, zoom: 1 }));
  release(); await manager.drain(camera);
  assert.ok(calls.some(c => c.action === 'panTilt' && c.body.pan === 0), 'Must transmit pan Stop after superseded pan command');
  assert.deepEqual(camera.applied, { pan: 0, tilt: 0, zoom: 1 });
});
test('failed movement triggers bounded Stop attempts and never claims stopped', async t => {
  const { manager, camera, calls } = rig(t, async () => { throw new Error('simulated missing response'); });
  manager.action('ptz-a', 'ptzMove', move(1)); await manager.drain(camera); await manager.stop();
  assert.equal(camera.stopState, 'unconfirmed');
  assert.equal(calls.filter(c => c.body.pan > 0).length, 1);
  assert.equal(camera.stopAttempts, 3);
});
test('catalog targets six brands, validates endpoints and preserves unrelated configuration', t => {
  const profiles = ptzCatalog().profiles;
  for (const brand of ['Sony', 'Canon', 'Panasonic', 'BirdDog', 'PTZOptics', 'AVer']) assert.ok(profiles.some(p => p.brand === brand));
  assert.equal(new Set(profiles.map(p => p.id)).size, profiles.length);
  assert.throws(() => validateCamera({ id: 'ptz-a', profile: 'visca-udp', host: '239.1.1.1' }));
  assert.throws(() => validateCamera({ id: '../bad', profile: 'visca-udp', host: '127.0.0.1' }));
  const { config } = rig(t); assert.equal(config().auth.preserved, true);
});
test('encoded preset save still requires admin; PTZ does not pollute recording status', () => {
  for (const action of ['ptzPresetSave', '%70tzPresetSave']) assert.equal(requiredRole('POST', `/api/cameras/ptz-a/actions/${action}`), 'admin');
  assert.equal(requiredRole('POST', '/api/ptz/cameras'), 'admin');
  assert.equal(requiredRole('POST', '/api/cameras/ptz-a/actions/ptzMove'), 'operator');
  const roll = rollState([{ id: 'sdk', state: 'connected', status: { recording: true } }, { id: 'ptz', state: 'connected', capabilities: { record: { available: false } } }]);
  assert.equal(roll.total, 1); assert.equal(roll.all, true);
});

test('fixed camera reply ports cannot collide with the inbound VISCA listener', () => {
  const saved = { cameras: [], visca: { enabled: true, port: 52381 }, ptz: { cameras: [] } };
  const adoption = { readConfig: () => structuredClone(saved), writeConfig: () => assert.fail('must reject before persisting') };
  const manager = new PtzManager({ adoption });
  assert.throws(() => manager.add({ id: 'ptz-a', profile: 'aver-ptz310', host: '127.0.0.1' }), /conflicts/);
  saved.ptz.cameras.push({ id: 'ptz-a', profile: 'aver-ptz310', host: '127.0.0.1' });
  assert.throws(() => new PtzManager({ adoption }), /conflicts/);
});
