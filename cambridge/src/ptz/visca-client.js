// Outbound VISCA. Separate from visca.js, which accepts controller commands.
import { createSocket } from 'node:dgram';
import { createConnection, isIP } from 'node:net';

export function velocity(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1)
    throw new Error(`${name} must be a number between -1 and 1`);
  return value;
}
export function viscaCommand(action, body = {}, profile = {}) {
  const a = 0x80 | (profile.address ?? 1);
  const speed = (n, maximum) => Math.max(1, Math.round(Math.abs(n) * maximum));
  if (action === 'panTilt') {
    const pan = velocity(body.pan ?? 0, 'pan'), tilt = velocity(body.tilt ?? 0, 'tilt');
    return Buffer.from([a, 1, 6, 1, speed(pan, profile.panMax ?? 24), speed(tilt, profile.tiltMax ?? 20),
      pan < 0 ? 1 : pan > 0 ? 2 : 3, tilt > 0 ? 1 : tilt < 0 ? 2 : 3, 0xff]);
  }
  if (action === 'zoom') {
    const zoom = velocity(body.zoom ?? 0, 'zoom');
    const value = zoom === 0 ? 0 : (zoom > 0 ? 0x20 : 0x30) | Math.round(Math.abs(zoom) * 7);
    return Buffer.from([a, 1, 4, 7, value, 0xff]);
  }
  if (action === 'probe') return Buffer.from([a, 9, 4, 0, 0xff]); // power inquiry; never moves
  if (action === 'home') return Buffer.from([a, 1, 6, 4, 0xff]);
  if (action === 'presetRecall' || action === 'presetSave') {
    if (!Number.isInteger(body.slot) || body.slot < 0 || body.slot > (profile.presetMax ?? 15))
      throw new Error(`preset slot must be 0–${profile.presetMax ?? 15}`);
    return Buffer.from([a, 1, 4, 0x3f, action === 'presetSave' ? 1 : 2, body.slot, 0xff]);
  }
  throw new Error('Unsupported VISCA action');
}
export function frameVisca(payload, sequence) {
  const header = Buffer.alloc(8);
  header.writeUInt16BE(payload[1] === 9 ? 0x0110 : 0x0100, 0);
  header.writeUInt16BE(payload.length, 2);
  header.writeUInt32BE(sequence >>> 0, 4);
  return Buffer.concat([header, payload]);
}
const sharedUdp = new Map();
export class ViscaClient {
  constructor(config) { this.config = config; this.sequence = 0; this.initialized = false; }
  async udpSocket() {
    if (!this.udpReady) {
      const port = this.config.replyPort ?? 0;
      let group = port ? sharedUdp.get(port) : null;
      if (!group) {
        group = { socket: createSocket('udp4'), clients: new Set() };
        const g = group;
        g.ready = new Promise((resolve, reject) => {
          g.socket.on('message', (data, peer) => {
            for (const client of g.clients) if (peer.address === client.config.host && peer.port === client.config.port) client.receive?.(data);
          });
          g.socket.on('error', error => { for (const client of g.clients) client.fail?.(error); reject(error); });
          g.socket.bind(port, '0.0.0.0', () => resolve(g.socket));
        });
        if (port) sharedUdp.set(port, group);
      }
      group.clients.add(this); this.group = group; this.udp = group.socket; this.udpReady = group.ready;
    }
    return this.udpReady;
  }
  async resetSequence() {
    const socket = await this.udpSocket();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('No VISCA reset reply; enable IP control and source-port replies on the camera')), this.config.timeoutMs ?? 700);
      const finish = error => { clearTimeout(timer); this.receive = null; this.fail = null; error ? reject(error) : resolve(); };
      this.fail = finish;
      this.receive = data => {
        if (data.length === 9 && data.readUInt16BE(0) === 0x0201 && data.readUInt16BE(2) === 1 && data[8] === 1) finish();
      };
      socket.send(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0, 1]), this.config.port, this.config.host, error => { if (error) finish(error); });
    });
    this.sequence = 0; this.initialized = true;
  }
  close() {
    this.fail?.(new Error('PTZ adapter closed'));
    this.group?.clients.delete(this);
    if (this.group && !this.group.clients.size) {
      try { this.group.socket.close(); } catch {}
      if (this.config.replyPort) sharedUdp.delete(this.config.replyPort);
    }
    this.group = null; this.udpReady = null; this.initialized = false;
  }
  async send(action, body, { completion = false, valid = () => true } = {}) {
    const payload = viscaCommand(action, body, this.config);
    const { host, port, protocol, timeoutMs = 700, address = 1 } = this.config;
    if (isIP(host) !== 4) throw new Error('VISCA requires an IPv4 camera address');
    const framed = protocol === 'visca-udp';
    if (framed && !this.initialized) await this.resetSequence();
    if (!valid()) throw new Error('PTZ command superseded before dispatch');
    const sequence = this.sequence;
    this.sequence = (this.sequence + 1) >>> 0;
    const packet = framed ? frameVisca(payload, sequence) : payload;
    return new Promise((resolve, reject) => {
      let socket, timer, finished = false, buffer = Buffer.alloc(0), ackSocket = null;
      const done = (error, result) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (framed) { this.receive = null; this.fail = null; }
        else if (protocol === 'visca-tcp') socket?.destroy();
        else { try { socket?.close(); } catch {} }
        error ? reject(error) : resolve(result);
      };
      const receive = (data) => {
        if (framed) {
          if (data.length < 9 || data.readUInt32BE(4) !== sequence || data.readUInt16BE(2) !== data.length - 8) return;
          if (data.readUInt16BE(0) === 0x0201) return done(new Error('VISCA sequence/protocol error; check camera control settings'));
          if (data.readUInt16BE(0) !== 0x0111) return;
          data = data.subarray(8);
        }
        if (data.length < 3 || data[0] !== ((address + 8) << 4) || data.at(-1) !== 0xff) return;
        const kind = data[1] & 0xf0, channel = data[1] & 0x0f;
        if (kind === 0x60) return done(new Error(`Camera refused VISCA command (0x${data[2].toString(16)})`));
        if (kind === 0x40 && data.length === 3 && action !== 'probe') {
          ackSocket = channel;
          if (!completion) done(null, { acknowledged: true, completed: false });
        }
        if (kind === 0x50 && (action === 'probe' || data.length === 3) && (ackSocket === null || ackSocket === channel)) {
          if (action === 'probe' && (data.length !== 4 || ![2, 3].includes(data[2]))) return;
          done(null, { acknowledged: true, completed: true,
            ...(action === 'probe' ? { power: data[2] === 2 ? 'on' : 'standby' } : {}) });
        }
      };
      timer = setTimeout(() => done(new Error('Camera did not acknowledge PTZ command; movement state is unknown')), timeoutMs);
      if (framed) {
        socket = this.udp;
        this.receive = receive; this.fail = error => done(error);
        socket.send(packet, port, host, error => { if (error) done(error); });
      } else if (protocol === 'visca-tcp') {
        socket = createConnection({ host, port });
        socket.on('connect', () => valid() ? socket.write(packet) : done(new Error('PTZ command expired before connection')));
        socket.on('data', data => {
          buffer = Buffer.concat([buffer, data]);
          if (buffer.length > 4096) return done(new Error('Oversized VISCA response'));
          let end;
          while ((end = buffer.indexOf(0xff)) >= 0 && !finished) {
            const reply = buffer.subarray(0, end + 1); buffer = buffer.subarray(end + 1); receive(reply);
          }
        });
        socket.on('end', () => done(new Error('Camera closed before acknowledging PTZ command')));
      } else {
        socket = createSocket('udp4');
        socket.on('message', (data, remote) => {
          if (remote.address === host && remote.port === port) receive(data);
        });
        socket.bind(0, '0.0.0.0', () => valid() ? socket.send(packet, port, host, error => { if (error) done(error); }) : done(new Error('PTZ command expired before dispatch')));
      }
      if (!framed) socket.on('error', error => done(error));
    });
  }
}
