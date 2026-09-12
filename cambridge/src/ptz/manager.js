import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { ViscaClient, velocity } from './visca-client.js';
import { PanasonicClient } from './panasonic-client.js';

const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url)));
export const ptzCatalog = () => structuredClone(catalog);
export function validateCamera(input) {
  const profile = catalog.profiles.find(p => p.id === input?.profile);
  if (!profile) throw new Error('Choose a supported PTZ profile');
  if (!/^ptz-[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.id ?? '')) throw new Error('PTZ id must start with ptz- and use letters, digits, underscores or hyphens');
  if (isIP(input.host) !== 4 || /^(0|127|22[4-9]|23\d|24\d|25[0-5])\./.test(input.host)) {
    // Loopback is allowed for explicit simulator/API tests, never implicitly scanned.
    if (isIP(input.host) !== 4 || !input.host.startsWith('127.')) throw new Error('Enter a unicast IPv4 camera address');
  }
  const port = input.port ?? profile.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid camera port');
  const replyPort = input.replyPort ?? profile.replyPort ?? 0;
  if (!Number.isInteger(replyPort) || replyPort < 0 || replyPort > 65535 || (profile.protocol !== 'visca-udp' && replyPort !== 0)) throw new Error('Reply port applies only to framed VISCA UDP');
  const address = input.address ?? 1;
  if (!Number.isInteger(address) || address < 1 || address > 7 || (profile.protocol === 'visca-udp' && address !== 1)) throw new Error('Invalid VISCA address');
  for (const field of ['username', 'password', 'label']) if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > 256)) throw new Error(`Invalid ${field}`);
  return { id: input.id, label: input.label?.trim() || `${profile.brand} ${profile.model}`, profile: profile.id,
    model: profile.model, brand: profile.brand, protocol: profile.protocol, host: input.host, port, replyPort, address,
    panMax: profile.panMax, tiltMax: profile.tiltMax, presetMax: profile.presetMax,
    https: input.https === true, username: input.username ?? '', password: input.password ?? '' };
}
const stopped = () => ({ pan: 0, tilt: 0, zoom: 0 });
const moving = m => m.pan !== 0 || m.tilt !== 0 || m.zoom !== 0;
export class PtzManager extends EventEmitter {
  constructor({ adoption, adapterFactory, now = () => Date.now() }) {
    super(); this.adoption = adoption; this.now = now; this.cameras = new Map(); this.closing = false;
    this.factory = adapterFactory ?? (c => c.protocol === 'panasonic-http' ? new PanasonicClient(c) : new ViscaClient(c));
    const saved = adoption.readConfig();
    for (const config of saved.ptz?.cameras ?? []) { const validated = validateCamera(config); this.checkPorts(validated, saved); this.install(validated); }
  }
  install(config) {
    const camera = { config, adapter: this.factory(config), state: 'offline', detail: 'Not checked yet',
      desired: stopped(), applied: null, revision: 0, pending: false, expires: 0, owner: null,
      sequences: new Map(), lastResult: null, busy: false, stopAttempts: 0, stopDue: 0, discrete: null };
    this.cameras.set(config.id, camera); return camera;
  }
  has(id) { return this.cameras.has(id); }
  view() {
    return [...this.cameras.values()].map(c => ({ id: c.config.id, label: c.config.label, model: c.config.model,
      provider: 'network-ptz', ip: c.config.host, transport: c.config.protocol, state: c.state, detail: c.detail,
      properties: {}, status: { recordingState: -1, battery: -1, mediaSlot1Sec: -1, mediaSlot2Sec: -1 },
      capabilities: { schemaVersion: 1, provider: 'network-ptz', panTilt: { available: true }, zoom: { available: true },
        record: { available: false, reason: 'This PTZ adapter does not control recording' }, liveView: { available: false },
        presets: { available: true, min: 0, max: c.config.presetMax } },
      ptz: { profile: c.config.profile, brand: c.config.brand, port: c.config.port,
        requested: { ...c.desired }, commandPending: c.pending || c.busy, lastResult: c.lastResult,
        stopState: c.stopState ?? 'not-requested', verification: 'hardware-validation-pending' } }));
  }
  checkPorts(config, saved) {
    if (config.replyPort && saved.visca?.enabled && config.replyPort === (saved.visca.port ?? 52381)) throw new Error(`PTZ reply port ${config.replyPort} conflicts with the inbound VISCA bridge; disable that bridge or change its port first`);
  }
  add(input) {
    const config = validateCamera(input);
    const cfg = this.adoption.readConfig();
    this.checkPorts(config, cfg);
    if (this.has(config.id) || (cfg.cameras ?? []).some(c => c.id === config.id)) throw new Error('Camera id already exists');
    if ([...this.cameras.values()].some(c => c.config.host === config.host && c.config.port === config.port)) throw new Error('Camera endpoint already added');
    cfg.ptz ??= {}; cfg.ptz.cameras ??= []; cfg.ptz.cameras.push(config);
    this.adoption.writeConfig(cfg); this.install(config); this.emit('change');
    return this.view().find(c => c.id === config.id);
  }
  async remove(id) {
    const camera = this.get(id); camera.removing = true;
    this.requestStop(camera, true);
    await this.drain(camera);
    if (camera.stopState !== 'acknowledged') { camera.removing = false; throw new Error('Stop was not acknowledged; keep the camera configured and check it physically before retrying removal'); }
    const cfg = this.adoption.readConfig(); cfg.ptz.cameras = cfg.ptz.cameras.filter(c => c.id !== id);
    this.adoption.writeConfig(cfg); camera.adapter.close?.(); this.cameras.delete(id); this.emit('change');
  }
  get(id) { const camera = this.cameras.get(id); if (!camera) throw new Error('No such PTZ camera'); return camera; }
  start() {
    this.timer = setInterval(() => this.tick(), 50);
    this.timer.unref?.();
    for (const c of this.cameras.values()) { c.discrete = { action: 'probe', body: {} }; c.pending = true; this.pump(c); }
  }
  tick() {
    for (const c of this.cameras.values()) {
      if (moving(c.desired) && this.now() >= c.expires) this.requestStop(c, true);
      if (c.stopDue && this.now() >= c.stopDue) { c.stopDue = 0; c.pending = true; }
      this.pump(c);
    }
  }
  requestStop(c, closeOwner = false) {
    if (closeOwner && c.owner) { const entry = c.sequences.get(c.owner); if (entry) entry.closed = true; }
    c.owner = null; c.expires = 0; c.desired = stopped(); c.discrete = null;
    c.revision++; c.pending = true; c.applied = null; c.stopState = 'pending'; c.stopAttempts = 0; c.stopDue = 0;
    this.pump(c); this.emit('change');
  }
  action(id, action, body = {}, actor = 'local') {
    const c = this.get(id);
    if (this.closing || c.removing) throw new Error('PTZ service is stopping');
    if (action === 'ptzStop') {
      if (/^[a-zA-Z0-9_-]{1,96}$/.test(body.controlId ?? '') && (c.sequences.size < 10000 || c.sequences.has(`${actor}:${body.controlId}`))) c.sequences.set(`${actor}:${body.controlId}`, { sequence: body.sequence ?? 0, closed: true });
      this.requestStop(c, true); return { ok: true, accepted: true, confirmed: false }; }
    if (action === 'ptzMove') {
      if (c.discrete || c.discreteBusy) throw new Error('PTZ camera is executing a one-shot command; press Stop first');
      const desired = { pan: velocity(body.pan ?? 0, 'pan'), tilt: velocity(body.tilt ?? 0, 'tilt'), zoom: velocity(body.zoom ?? 0, 'zoom') };
      if (!/^[a-zA-Z0-9_-]{1,96}$/.test(body.controlId ?? '') || !Number.isSafeInteger(body.sequence) || body.sequence < 0) throw new Error('Movement requires a controlId and increasing sequence');
      const owner = `${actor}:${body.controlId}`;
      const prior = c.sequences.get(owner);
      if (prior?.closed || (prior && body.sequence <= prior.sequence)) throw new Error('Stale or stopped movement session');
      if (c.owner && c.owner !== owner && this.now() < c.expires) throw new Error('Another controller is moving this camera');
      if (c.stopState === 'pending' || c.stopState === 'unconfirmed') throw new Error('Awaiting an acknowledged Stop before starting another movement');
      const duration = body.leaseMs ?? 700;
      if (!Number.isInteger(duration) || duration < 150 || duration > 1500) throw new Error('leaseMs must be 150–1500');
      c.sequences.set(owner, { sequence: body.sequence, closed: false });
      // Keep closed session tombstones for the lifetime of this camera. Reject
      // new session creation at the cap instead of evicting a Stop tombstone.
      if (c.sequences.size > 10000) { c.sequences.delete(owner); throw new Error('Movement session limit reached; restart after stopping cameras'); }
      c.owner = owner; c.expires = this.now() + duration;
      const changed = JSON.stringify(c.desired) !== JSON.stringify(desired);
      c.desired = desired;
      if (changed || (!c.applied && !c.busy && !c.pending)) { c.revision++; c.pending = true; this.pump(c); }
      return { ok: true, accepted: true, confirmed: false, leaseMs: duration };
    }
    const names = { ptzProbe: 'probe', ptzHome: 'home', ptzPresetRecall: 'presetRecall', ptzPresetSave: 'presetSave' };
    if (!names[action]) throw new Error('Unsupported PTZ action');
    if (c.busy || c.pending || moving(c.desired) || c.stopState === 'unconfirmed') throw new Error('Stop movement and wait before this command');
    if (action.includes('Preset') && (!Number.isInteger(body.slot) || body.slot < 0 || body.slot > c.config.presetMax)) throw new Error(`Preset slot must be 0–${c.config.presetMax}`);
    c.discrete = { action: names[action], body }; c.pending = true; c.revision++; this.pump(c);
    return { ok: true, accepted: true, confirmed: false };
  }
  pump(c) {
    if (c.busy || !c.pending) return;
    c.busy = true; c.pending = false;
    c.task = (async () => {
      const rev = c.revision, discrete = c.discrete; c.discrete = null;
      const intent = { ...c.desired };
      const valid = () => c.revision === rev && (!moving(intent) || this.now() < c.expires);
      try {
        if (discrete) {
          c.discreteBusy = true;
          const result = await c.adapter.send(discrete.action, discrete.body, { valid });
          if (c.revision === rev) { c.lastResult = { action: discrete.action, ...result }; c.state = 'connected'; c.detail = result.power === 'standby' ? 'Camera reports standby' : null; }
        } else {
          let allAcknowledged = true;
          const previous = c.applied; c.applied = null;
          for (const axis of ['panTilt', 'zoom']) {
            if (moving(intent) && (!valid() || !allAcknowledged)) { allAcknowledged = false; break; }
            const same = previous && (axis === 'zoom' ? previous.zoom === intent.zoom : previous.pan === intent.pan && previous.tilt === intent.tilt);
            if (same && moving(intent)) continue;
            try {
              const result = await c.adapter.send(axis, intent, { completion: !moving(intent), valid: moving(intent) ? valid : () => true });
              if (!result.acknowledged) allAcknowledged = false;
            } catch (error) { allAcknowledged = false; c.detail = error.message; }
          }
          if (c.revision === rev) {
            c.applied = allAcknowledged ? intent : null;
            c.lastResult = { action: moving(intent) ? 'move' : 'stop', acknowledged: allAcknowledged, physicalPositionVerified: false };
            c.state = allAcknowledged ? 'connected' : 'offline';
            if (allAcknowledged) c.detail = null;
            if (!moving(intent)) {
              c.stopState = allAcknowledged ? 'acknowledged' : 'unconfirmed';
              if (!allAcknowledged && ++c.stopAttempts < 3) c.stopDue = this.now() + 150;
            } else if (!allAcknowledged || !valid()) this.requestStop(c, true);
          }
        }
      } catch (error) {
        if (c.revision === rev) { c.state = 'offline'; c.detail = error.message; c.lastResult = { action: discrete?.action, acknowledged: false }; }
        if (discrete && ['home', 'presetRecall'].includes(discrete.action)) this.requestStop(c, true);
      } finally {
        c.busy = false; c.discreteBusy = false; this.emit('change');
        if (c.pending) this.pump(c);
      }
    })();
  }
  async drain(c) { while (c.busy || c.pending) { this.pump(c); await c.task; } }
  stop() { return this.stopTask ??= this.shutdown(); }
  async shutdown() {
    this.closing = true; clearInterval(this.timer);
    for (const c of this.cameras.values()) this.requestStop(c, true);
    await Promise.all([...this.cameras.values()].map(async c => {
      await this.drain(c);
      // Bounded additional Stop attempts on graceful shutdown, never movement retries.
      while (c.stopState !== 'acknowledged' && c.stopAttempts < 3) { c.pending = true; await this.drain(c); }
      c.adapter.close?.();
    }));
  }
}
