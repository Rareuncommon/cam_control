// Checks a running CamBridge's Bluetooth gateway from the Mac itself, with no
// phone and no radio: it connects to the gateway's Unix socket in place of
// the Swift bridge and plays a paired phone. Stop the real bridge first (the
// gateway takes one bridge at a time).
//
// It only reads unless told otherwise: authenticate, receive the full state,
// fetch /api/capabilities, show a few deltas, resync, and leave.
//
//   node scripts/ble-test-client.mjs --uri 'cambridge://pair?...'
//   node scripts/ble-test-client.mjs --uri '…' --socket /path/to/blebridge.sock --watch 10
//
// The pairing URI comes from Setup → Phones → Pair a phone (copy the link
// under the code with the browser's developer tools, or POST /api/devices).

import { homedir } from 'node:os';
import { join } from 'node:path';

const { FakeBridge, TestPhone, fromPairingUri } = await import(new URL('../cambridge/src/ble/test-client.js', import.meta.url).href);

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const uri = arg('uri');
if (!uri) { console.error('usage: node scripts/ble-test-client.mjs --uri <pairing uri> [--socket <path>] [--watch <seconds>]'); process.exit(2); }
const socketPath = arg('socket', join(homedir(), 'Library', 'Application Support', 'CamBridge', 'blebridge.sock'));
const watchSeconds = Number(arg('watch', '5'));

const say = (s) => process.stdout.write(`${s}\n`);
const bridge = new FakeBridge(socketPath);
try {
  const info = await bridge.open();
  say(`connected to the gateway: ${info.name} (server ${info.id})`);
} catch (err) {
  say(`cannot connect to ${socketPath}: ${err.message}`);
  process.exit(1);
}

const phone = new TestPhone(bridge, { mtu: 185 });
const dev = fromPairingUri(uri);
const auth = await phone.connect(dev);
if (!auth.ok) { say(`refused: ${auth.message} (code ${auth.code})`); process.exit(1); }
say(`authenticated as ${dev.deviceId}; the server proved it holds the same key`);

const me = await phone.request('GET', '/api/devices/me');
if (me.status === 401 && me.body?.reason === 'not-activated') {
  const act = await phone.request('POST', '/api/devices/activate', { name: 'BLE test client', model: 'scripts/ble-test-client.mjs' });
  say(`pairing finished: ${act.status}`);
}
const full = await phone.waitState((s) => s.frame.type === 'state', 5000);
const cams = full.frame.view?.cameras ?? [];
say(`full state (seq ${full.seq}): ${cams.length} camera(s)${cams.length ? `: ${cams.map((c) => `${c.label} ${c.state}`).join(', ')}` : ''}; lighting ${full.frame.lighting?.unavailable ? 'unavailable' : 'present'}`);

const caps = await phone.request('GET', '/api/capabilities');
say(`capabilities: ${caps.status} ${JSON.stringify(caps.body?.features ?? caps.body)}`);
const t0 = Date.now();
await phone.ping();
say(`round trip: ${Date.now() - t0} ms`);

say(`watching deltas for ${watchSeconds} s…`);
let deltas = 0;
phone.on('state', (s) => { if (s.frame.type === 'patch') deltas += 1; });
await new Promise((r) => setTimeout(r, watchSeconds * 1000));
phone.resync();
const again = await phone.waitState((s) => s.frame.type === 'state' && s.seq > full.seq, 5000);
say(`${deltas} delta(s); resync ok (seq ${again.seq})`);
phone.disconnect();
bridge.close();
