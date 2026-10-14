// The shared VISCA transport: Sony VISCA over IP (UDP, header, sequence
// numbers, retransmission) and raw VISCA over TCP (PTZOptics), against
// small scripted servers and the Sony protocol fake.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';

import { ViscaClient, ViscaRestop, FRAMING, nibbles, toNibbles, signed, viscaError } from '../src/ptz/visca-client.js';
import { startFakeSony } from './fakes/sony-brc.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A UDP server whose replies a test scripts: handler(type, seq, payload) -> [[type, payload], ...]. */
async function udpScript(handler) {
  const s = dgram.createSocket('udp4');
  const seen = [];
  s.on('message', (msg, rinfo) => {
    const type = msg.readUInt16BE(0);
    const seq = msg.readUInt32BE(4);
    const payload = [...msg.subarray(8, 8 + msg.readUInt16BE(2))];
    seen.push({ type, seq, payload, raw: [...msg] });
    for (const [t, p, sq = seq] of handler(type, seq, payload, seen) ?? []) {
      const b = Buffer.alloc(8 + p.length);
      b.writeUInt16BE(t, 0); b.writeUInt16BE(p.length, 2); b.writeUInt32BE(sq, 4);
      Buffer.from(p).copy(b, 8);
      s.send(b, rinfo.port, rinfo.address);
    }
  });
  await new Promise((r) => s.bind(0, '127.0.0.1', r));
  return { port: s.address().port, seen, close: () => s.close() };
}

/** A TCP server whose replies a test scripts: handler(bytes, sock) is called per VISCA message. */
async function tcpScript(handler) {
  const socks = new Set();
  const seen = [];
  const srv = net.createServer((sock) => {
    socks.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => socks.delete(sock));
    let rx = Buffer.alloc(0);
    sock.on('data', (d) => {
      rx = Buffer.concat([rx, d]);
      for (let i; (i = rx.indexOf(0xff)) >= 0;) {
        const m = [...rx.subarray(0, i + 1)];
        rx = rx.subarray(i + 1);
        seen.push(m);
        handler(m, sock, seen);
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: srv.address().port, seen, socks,
    close: async () => { for (const s of socks) s.destroy(); await new Promise((r) => srv.close(r)); },
  };
}

const RESET_ACK = [[0x0201, [0x01]]];

test('nibble helpers and error mapping', () => {
  assert.equal(nibbles([0x90, 0x50, 0x01, 0x02, 0x03, 0x04], 2, 4), 0x1234);
  assert.deepEqual(toNibbles(0x7ffe, 4), [0x07, 0x0f, 0x0f, 0x0e]);
  assert.equal(signed(0xd5468, 20), -175000);
  const e = viscaError(0x41);
  assert.equal(e.kind, 'refused');
  assert.equal(e.code, 'notExecutable');
  assert.equal(viscaError(0x02).code, 'syntax');
  assert.equal(viscaError(0x03).code, 'bufferFull');
});

test('Sony: RESET first, then an 8-byte header with sequence numbers from 1', async () => {
  const srv = await udpScript((type, seq, p) => {
    if (type === 0x0200) return RESET_ACK;
    if (type === 0x0100) return [[0x0111, [0x90, 0x41, 0xff]], [0x0111, [0x90, 0x51, 0xff]]];
    if (type === 0x0110) return [[0x0111, [0x90, 0x50, 0x02, 0xff]]];
    return [];
  });
  const c = new ViscaClient({ host: '127.0.0.1', port: srv.port, framing: FRAMING.SONY_IP, timeoutMs: 600 });
  try {
    assert.deepEqual(await c.command([0x81, 0x01, 0x04, 0x07, 0x00, 0xff]), { socket: 1 });
    const r = await c.inquiry([0x81, 0x09, 0x04, 0x00, 0xff]);
    assert.deepEqual([...r], [0x90, 0x50, 0x02, 0xff]);
    // V-EN p.11: RESET is 02 00 00 01 00 00 00 00 01.
    assert.deepEqual(srv.seen[0].raw, [0x02, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01]);
    assert.deepEqual(srv.seen[1].raw, [0x01, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x81, 0x01, 0x04, 0x07, 0x00, 0xff]);
    assert.equal(srv.seen[2].type, 0x0110);
    assert.equal(srv.seen[2].seq, 2);
    await sleep(20);
    assert.equal(c.occupied, 0, 'the completion freed the buffer');
  } finally { c.close(); srv.close(); }
});

test('Sony: a lost command is retransmitted with the same sequence number', async () => {
  let dropped = false;
  const srv = await udpScript((type) => {
    if (type === 0x0200) return RESET_ACK;
    if (!dropped) { dropped = true; return []; }
    return [[0x0111, [0x90, 0x42, 0xff]], [0x0111, [0x90, 0x52, 0xff]]];
  });
  const c = new ViscaClient({ host: '127.0.0.1', port: srv.port, framing: FRAMING.SONY_IP, timeoutMs: 600 });
  try {
    assert.deepEqual(await c.command([0x81, 0x01, 0x06, 0x04, 0xff]), { socket: 2 });
    const cmds = srv.seen.filter((m) => m.type === 0x0100);
    assert.equal(cmds.length, 2);
    assert.equal(cmds[0].seq, cmds[1].seq);
  } finally { c.close(); srv.close(); }
});

test('Sony: a lost ACK does not run the command twice (sequence abnormality means it already ran)', async () => {
  const fake = await startFakeSony({});
  const c = new ViscaClient({ host: '127.0.0.1', port: fake.viscaPort, framing: FRAMING.SONY_IP, timeoutMs: 600 });
  try {
    await c.inquiry([0x81, 0x09, 0x04, 0x00, 0xff]);
    fake.state.dropReplies = 2;          // the ACK and the Completion
    const r = await c.command([0x81, 0x01, 0x06, 0x04, 0xff]);
    assert.equal(r.assumed, true);
    assert.equal(fake.state.viscaLog.filter((l) => l === '81 01 06 04 ff').length, 1, 'executed once');
  } finally { c.close(); await fake.close(); }
});

test('Sony: a lost inquiry reply is asked again with a new sequence number', async () => {
  const fake = await startFakeSony({});
  const c = new ViscaClient({ host: '127.0.0.1', port: fake.viscaPort, framing: FRAMING.SONY_IP, timeoutMs: 900 });
  try {
    await c.inquiry([0x81, 0x09, 0x04, 0x00, 0xff]);
    fake.state.dropReplies = 1;
    const r = await c.inquiry([0x81, 0x09, 0x00, 0x02, 0xff]);
    assert.equal((r[4] << 8) | r[5], 0x051f);
  } finally { c.close(); await fake.close(); }
});

test('Sony: errors are refusals with codes; buffer full is retried once', async () => {
  const fake = await startFakeSony({});
  const c = new ViscaClient({ host: '127.0.0.1', port: fake.viscaPort, framing: FRAMING.SONY_IP, timeoutMs: 800, socketWaitMs: 50 });
  try {
    await assert.rejects(c.command([0x81, 0x01, 0x04, 0x99, 0xff]), (e) => e.kind === 'refused' && e.code === 'syntax');
    // Focus drive in auto focus: 90 6z 41 FF (V-EN p.8).
    await assert.rejects(c.command([0x81, 0x01, 0x04, 0x08, 0x02, 0xff]), (e) => e.kind === 'refused' && e.code === 'notExecutable');
    fake.state.busy = true;
    const before = fake.state.viscaLog.length;
    await assert.rejects(c.command([0x81, 0x01, 0x06, 0x04, 0xff]), (e) => e.code === 'bufferFull');
    assert.equal(fake.state.viscaLog.length - before, 2, 'sent, then retried once');
  } finally { c.close(); await fake.close(); }
});

test('Sony: silence is a timeout, never a refusal', async () => {
  const srv = await udpScript(() => []);
  const c = new ViscaClient({ host: '127.0.0.1', port: srv.port, framing: FRAMING.SONY_IP, timeoutMs: 300 });
  try {
    await assert.rejects(c.inquiry([0x81, 0x09, 0x04, 0x00, 0xff]), (e) => e.kind === 'timeout');
  } finally { c.close(); srv.close(); }
});

test('raw TCP: no header; replies split across packets; a0 reply address accepted; network change ignored', async () => {
  const srv = await tcpScript((m, sock) => {
    if (m[1] === 0x09) {
      // Reply in two pieces, after a stray network-change message.
      sock.write(Buffer.from([0x90, 0x38, 0xff, 0xa0, 0x50]));
      setTimeout(() => sock.write(Buffer.from([0x02, 0xff])), 10);
    } else {
      sock.write(Buffer.from([0xa0, 0x41, 0xff, 0xa0, 0x51, 0xff]));
    }
  });
  const c = new ViscaClient({ host: '127.0.0.1', port: srv.port, framing: FRAMING.RAW_TCP, timeoutMs: 500 });
  try {
    const r = await c.inquiry([0x81, 0x09, 0x04, 0x00, 0xff]);
    assert.deepEqual([...r], [0xa0, 0x50, 0x02, 0xff]);
    assert.deepEqual(await c.command([0x81, 0x01, 0x06, 0x04, 0xff]), { socket: 1 });
    assert.deepEqual(srv.seen[0], [0x81, 0x09, 0x04, 0x00, 0xff], 'raw bytes, no header');
  } finally { c.close(); await srv.close(); }
});

test('raw TCP: two buffers; a third command waits for a Completion', async () => {
  let n = 0;
  let release;
  const srv = await tcpScript((m, sock) => {
    n += 1;
    if (n === 1) sock.write(Buffer.from([0x90, 0x41, 0xff]));       // ACK, completion later
    else if (n === 2) {
      sock.write(Buffer.from([0x90, 0x42, 0xff]));
      release = () => sock.write(Buffer.from([0x90, 0x51, 0xff]));
    } else sock.write(Buffer.from([0x90, 0x41, 0xff, 0x90, 0x51, 0xff]));
  });
  const c = new ViscaClient({ host: '127.0.0.1', port: srv.port, framing: FRAMING.RAW_TCP, timeoutMs: 1000, socketWaitMs: 400 });
  try {
    await c.command([0x81, 0x01, 0x06, 0x04, 0xff]);
    await c.command([0x81, 0x01, 0x06, 0x04, 0xff]);
    assert.equal(c.occupied, 2);
    const third = c.command([0x81, 0x01, 0x06, 0x04, 0xff]);
    await sleep(80);
    assert.equal(srv.seen.length, 2, 'held back while both buffers are busy');
    release();
    await third;
    assert.equal(srv.seen.length, 3);
  } finally { c.close(); await srv.close(); }
});

test('raw TCP: a timeout drops the socket, and the next call reconnects', async () => {
  let answer = false;
  const srv = await tcpScript((m, sock) => { if (answer) sock.write(Buffer.from([0x90, 0x50, 0x02, 0xff])); });
  const c = new ViscaClient({ host: '127.0.0.1', port: srv.port, framing: FRAMING.RAW_TCP, timeoutMs: 200 });
  try {
    await assert.rejects(c.inquiry([0x81, 0x09, 0x04, 0x00, 0xff]), (e) => e.kind === 'timeout');
    answer = true;
    await sleep(30);
    const r = await c.inquiry([0x81, 0x09, 0x04, 0x00, 0xff]);
    assert.equal(r[2], 0x02);
    // The camera drops the connection: in-flight work fails as network, then it reconnects.
    for (const s of srv.socks) s.destroy();
    await sleep(30);
    assert.equal((await c.inquiry([0x81, 0x09, 0x04, 0x00, 0xff]))[2], 0x02);
  } finally { c.close(); await srv.close(); }
});

test('raw TCP: an unreachable port is a network failure; close() rejects what is queued and never throws', async () => {
  const c = new ViscaClient({ host: '127.0.0.1', port: 9, framing: FRAMING.RAW_TCP, timeoutMs: 500 });
  await assert.rejects(c.inquiry([0x81, 0x09, 0x04, 0x00, 0xff]), (e) => ['network', 'timeout'].includes(e.kind));
  const srv = await tcpScript(() => {});
  const c2 = new ViscaClient({ host: '127.0.0.1', port: srv.port, framing: FRAMING.RAW_TCP, timeoutMs: 2000 });
  const a = c2.inquiry([0x81, 0x09, 0x04, 0x00, 0xff]);
  const b = c2.inquiry([0x81, 0x09, 0x04, 0x47, 0xff]);
  await sleep(30);
  c2.close();
  c2.close();
  await assert.rejects(a, (e) => e.kind === 'network');
  await assert.rejects(b, (e) => e.kind === 'network');
  await assert.rejects(c2.inquiry([0x81, 0x09, 0x04, 0x00, 0xff]), (e) => e.kind === 'network');
  c.close();
  await srv.close();
});

test('urgent commands (motion) go ahead of queued inquiries, in their own order, one message at a time', async () => {
  const srv = await tcpScript((m, sock) => {
    // Inquiries answer slowly; commands at once.
    if (m[1] === 0x09) setTimeout(() => sock.write(Buffer.from([0x90, 0x50, 0x02, 0xff])), 60);
    else sock.write(Buffer.from([0x90, 0x41, 0xff, 0x90, 0x51, 0xff]));
  });
  const c = new ViscaClient({ host: '127.0.0.1', port: srv.port, framing: FRAMING.RAW_TCP, timeoutMs: 2000 });
  try {
    const inq = [0x81, 0x09, 0x04, 0x47, 0xff];
    const jobs = [c.inquiry(inq), c.inquiry(inq), c.inquiry(inq), c.command([0x81, 0x01, 0x06, 0x01, 0x05, 0x05, 0x02, 0x03, 0xff])];
    await sleep(20);
    jobs.push(c.command([0x81, 0x01, 0x06, 0x01, 0x01, 0x01, 0x03, 0x03, 0xff], { urgent: true }));
    jobs.push(c.command([0x81, 0x01, 0x04, 0x07, 0x00, 0xff], { urgent: true }));
    await Promise.all(jobs);
    const name = (m) => (m[1] === 0x09 ? 'inq' : m[3] === 0x07 ? 'zoomStop' : m[6] === 0x03 ? 'ptStop' : 'move');
    // The first inquiry was already on the wire; the stops go next, in the
    // order asked, ahead of the waiting inquiries and the plain command.
    assert.deepEqual(srv.seen.map(name), ['inq', 'ptStop', 'zoomStop', 'inq', 'inq', 'move']);
  } finally { c.close(); await srv.close(); }
});

test('stillWanted: a message no longer wanted is not sent (nor resent), and says superseded', async () => {
  const srv = await tcpScript((m, sock) => {
    if (m[1] === 0x09) setTimeout(() => sock.write(Buffer.from([0x90, 0x50, 0x02, 0xff])), 60);
    else sock.write(Buffer.from([0x90, 0x41, 0xff, 0x90, 0x51, 0xff]));
  });
  const c = new ViscaClient({ host: '127.0.0.1', port: srv.port, framing: FRAMING.RAW_TCP, timeoutMs: 1000 });
  try {
    let wanted = true;
    const slow = c.inquiry([0x81, 0x09, 0x04, 0x47, 0xff]);
    const stop = c.command([0x81, 0x01, 0x04, 0x07, 0x00, 0xff], { urgent: true, stillWanted: () => wanted });
    await sleep(10);
    wanted = false;                 // the axis was moved again while the stop waited
    await assert.rejects(stop, (e) => e.code === 'superseded');
    await slow;
    assert.ok(!srv.seen.some((m) => m[1] === 0x01), 'the unwanted stop never went out');
  } finally { c.close(); await srv.close(); }
  // Sony: a lost transmission is not retransmitted once unwanted.
  const udp = await udpScript((type) => (type === 0x0200 ? [[0x0201, [0x01]]] : []));
  const s = new ViscaClient({ host: '127.0.0.1', port: udp.port, framing: FRAMING.SONY_IP, timeoutMs: 900 });
  try {
    let wanted = true;
    const p = s.command([0x81, 0x01, 0x04, 0x07, 0x00, 0xff], { stillWanted: () => wanted });
    await sleep(100);
    wanted = false;
    await assert.rejects(p, (e) => e.code === 'superseded');
    assert.equal(udp.seen.filter((x) => x.type === 0x0100).length, 1, 'sent once, not retransmitted');
  } finally { s.close(); udp.close(); }
});

test('a buffer-full retry that cannot happen still settles the call', async () => {
  const srv = await tcpScript((m, sock) => sock.write(Buffer.from([0x90, 0x60, 0x03, 0xff])));
  const c = new ViscaClient({ host: '127.0.0.1', port: srv.port, framing: FRAMING.RAW_TCP, timeoutMs: 1000, socketWaitMs: 200 });
  try {
    let wanted = true;
    const p = c.command([0x81, 0x01, 0x04, 0x07, 0x00, 0xff], { stillWanted: () => wanted });
    await sleep(30);
    wanted = false;                 // during the wait before the retry
    await assert.rejects(p, (e) => e.code === 'superseded');
    assert.equal(srv.seen.length, 1);
  } finally { c.close(); await srv.close(); }
});

test('ViscaRestop: retries until the stop is taken, stands down when cancelled or closed', async () => {
  const r = new ViscaRestop({ delaysMs: [0, 20] });
  let calls = 0;
  let delivered = 0;
  r.arm('panTilt', async () => { calls += 1; if (calls < 3) throw new Error('no answer'); }, () => { delivered += 1; });
  for (let i = 0; i < 50 && r.has('panTilt'); i++) await sleep(10);
  assert.equal(calls, 3);
  assert.equal(delivered, 1);
  assert.equal(r.has('panTilt'), false);
  // Cancelled (the axis moved again): nothing more is sent.
  let sends = 0;
  r.arm('zoom', async () => { sends += 1; throw new Error('no answer'); });
  await sleep(5);
  r.cancel('zoom');
  const after = sends;
  await sleep(80);
  assert.equal(sends, after);
  r.arm('focus', async () => { throw new Error('no answer'); });
  r.close();
  assert.equal(r.has('focus'), false);
});
