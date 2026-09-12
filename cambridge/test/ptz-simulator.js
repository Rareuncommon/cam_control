import { createSocket } from 'node:dgram';
import { createServer as tcpServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
export async function viscaSimulator(protocol, options = {}) {
  const events = [], sockets = new Set();
  let server;
  const handle = (packet, reply, peer) => {
    const framed = protocol === 'visca-udp';
    if (framed && packet.readUInt16BE(0) === 0x0200) {
      const reset = Buffer.from(packet); reset.writeUInt16BE(0x0201, 0); reply(reset); return;
    }
    const payload = framed ? packet.subarray(8) : packet;
    events.push({ packet: Buffer.from(packet), payload: Buffer.from(payload), peer, at: Date.now() });
    if (options.silent) return;
    const frame = bytes => {
      const p = Buffer.from(bytes);
      if (!framed) return p;
      const h = Buffer.from(packet.subarray(0, 8)); h.writeUInt16BE(0x0111); h.writeUInt16BE(p.length, 2);
      return Buffer.concat([h, p]);
    };
    const response = payload[1] === 9 ? [0x90, 0x50, 2, 0xff] : options.refuse ? [0x90, 0x61, 0x41, 0xff] : [0x90, 0x41, 0xff];
    if (options.wrongSequence && framed) { const wrong = frame(response); wrong.writeUInt32BE((packet.readUInt32BE(4) + 1) >>> 0, 4); reply(wrong); }
    if (options.wrongSequenceOnly) return;
    reply(frame(response));
    if (payload[1] !== 9 && !options.refuse && !options.ackOnly) reply(frame([0x90, 0x51, 0xff]));
  };
  if (protocol === 'visca-tcp') {
    server = tcpServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
      let buffer = Buffer.alloc(0);
      socket.on('data', data => {
        buffer = Buffer.concat([buffer, data]); let end;
        while ((end = buffer.indexOf(255)) >= 0) {
          const p = buffer.subarray(0, end + 1); buffer = buffer.subarray(end + 1);
          handle(p, reply => {
            socket.replyQueue = (socket.replyQueue ?? Promise.resolve()).then(async () => {
              if (options.fragment) { socket.write(reply.subarray(0, 1)); await new Promise(r => setImmediate(r)); socket.write(reply.subarray(1)); }
              else socket.write(reply);
            });
          });
        }
      });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
  } else {
    server = createSocket('udp4');
    server.on('message', (p, peer) => handle(p, reply => server.send(reply, options.replyPort || peer.port, peer.address), peer));
    server.bind(0, '127.0.0.1'); await once(server, 'listening');
  }
  return { port: server.address().port, events, async close() { for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
export async function panasonicSimulator(handler) {
  const events = [];
  const server = httpServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const command = url.searchParams.get('cmd'); events.push({ command, at: Date.now(), headers: req.headers, url: req.url });
    if (handler && await handler(req, res, command, events)) return;
    let reply;
    if (command === '#O') reply = 'p1';
    else if (command.startsWith('#PTS')) reply = 'pTS' + command.slice(4);
    else if (command.startsWith('#Z')) reply = 'zS' + command.slice(2);
    else if (command.startsWith('#APC')) reply = 'aPC' + command.slice(4);
    else if (/^#[MR]/.test(command)) reply = 's' + command.slice(2);
    else reply = 'ER1';
    res.end(reply);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { port: server.address().port, events, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
