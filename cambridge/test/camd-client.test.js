// camd client reconnection.
//
// One test here matters most: the reconnect loop has to survive an attempt that
// fails to connect at all. camd restarting under launchd is the scenario this
// client was written for, and a retry against a port that is not listening yet
// is exactly what that looks like from here.
//
// Every test cleans up in a `finally`. Without it a failed assertion leaves a
// live socket and a pending timer, the runner never drains, and the whole file
// hangs with no output — which reports a real bug as "the tests stopped",
// the least useful signal there is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { CamdClient } from '../src/camd-client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A port with nothing on it, so connections are refused rather than hanging. */
const DEAD_PORT = 59_997;

function deadClient(port = DEAD_PORT) {
  return new CamdClient({
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    log: () => {},
  });
}

test('Node WebSocket emits error but not close when a connect is refused', async () => {
  // The assumption the reconnect logic used to rest on, written down so a future
  // Node release changing it shows up here rather than as a panel that silently
  // stops reconnecting.
  const ws = new WebSocket(`ws://127.0.0.1:${DEAD_PORT}/ws`);
  const seen = [];
  ws.addEventListener('open', () => seen.push('open'));
  ws.addEventListener('error', () => seen.push('error'));
  ws.addEventListener('close', () => seen.push('close'));
  try {
    await sleep(600);
    assert.ok(seen.includes('error'), 'a refused connect must report an error');
    assert.ok(!seen.includes('open'));
  } finally {
    try { ws.close(); } catch { /* already dead */ }
  }
});

test('a refused connection still schedules another attempt', async () => {
  // The bug this pins: rescheduling only from 'close' meant a refused connect
  // left nothing scheduled, and cambridge stayed disconnected until someone
  // restarted it by hand — while HTTP kept working, so health checks reported
  // camd reachable and the panel showed every camera offline.
  const client = deadClient();
  client.start();
  try {
    // Long enough for the first attempt to be refused and the next to be queued.
    await sleep(700);
    assert.equal(client.connected, false);
    assert.ok(client.reconnectTimer, 'a further attempt must be scheduled');

    // And it must keep trying, not stop after one more.
    const firstTimer = client.reconnectTimer;
    await sleep(1500);
    assert.ok(client.reconnectTimer, 'the loop must still be alive');
    assert.notEqual(client.reconnectTimer, firstTimer, 'and must have retried since');
  } finally {
    client.stop();
  }
  assert.equal(client.reconnectTimer, null, 'stop() must end the loop');
});

test('stop() prevents any further attempts', async () => {
  const client = deadClient();
  client.start();
  try {
    await sleep(200);
    client.stop();
    await sleep(900);
    assert.equal(client.reconnectTimer, null);
    assert.equal(client.connected, false);
  } finally {
    client.stop();
  }
});

test('the client survives a server that accepts TCP but never upgrades', async () => {
  // A half-started camd — listening, not yet serving /ws — must not wedge the
  // loop either. This path does emit close, so it is the one that always
  // worked; it is here so a fix for the other path cannot break it.
  const server = createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = deadClient(server.address().port);
  client.start();
  try {
    await sleep(700);
    assert.equal(client.connected, false);
    assert.ok(client.reconnectTimer, 'a rejected upgrade must also reschedule');
  } finally {
    client.stop();
    await new Promise((r) => server.close(r));
  }
});
