import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { GphotoCamera, runGphoto, parseDiscovery } from './gphoto.js';
import { BlackmagicCamera } from './blackmagic.js';
const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url)));
export const externalCatalog = () => structuredClone(catalog);
export function validateExternal(input) {
  if (!input || !/^ext-[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.id)) throw new Error('Invalid external camera id');
  if (!['gphoto2', 'blackmagic-rest'].includes(input.provider)) throw new Error('Unknown camera provider');
  for (const key of ['label', 'model', 'username', 'password', 'serial', 'productName']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 256)) throw new Error(`Invalid ${key}`);
  const c = { id: input.id, provider: input.provider, label: input.label?.trim() || input.model || 'Camera', model: input.model || 'Camera' };
  if (c.provider === 'gphoto2') {
    if (!/^usb:\d{1,3},\d{1,3}$/.test(input.port) || !input.model?.trim() || /^Sony\b/i.test(input.model)) throw new Error('Select a discovered non-Sony USB camera; Sony uses the SDK adapter');
    return { ...c, port: input.port, ...(input.serial ? { serial: input.serial } : {}) };
  }
  if (isIP(input.host) !== 4 || /^(0|22[4-9]|23\d|24\d|25[0-5])\./.test(input.host)) throw new Error('Enter a unicast IPv4 address');
  const port = input.port ?? (input.https ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  return { ...c, host: input.host, port, https: input.https === true, username: input.username || '', password: input.password || '', ...(input.productName ? { productName: input.productName } : {}) };
}
export class ExternalManager extends EventEmitter {
  constructor({ adoption, factory, discover = async () => parseDiscovery(await runGphoto(['--auto-detect'])) }) {
    super(); this.adoption = adoption; this.cameras = new Map(); this.discover = discover; this.closing = false; this.mutating = false;
    this.factory = factory || (c => c.provider === 'gphoto2' ? new GphotoCamera(c) : new BlackmagicCamera(c));
    for (const c of adoption.readConfig().external?.cameras ?? []) this.install(validateExternal(c));
  }
  install(config, snapshot) { const c = { config, adapter: this.factory(config), snapshot, state: snapshot ? 'connected' : 'offline', busy: false, tasks: new Set(), revision: 0 }; this.cameras.set(config.id, c); return c; }
  has(id) { return this.cameras.has(id); }
  add(input) {
    if (this.mutating || this.closing) return Promise.reject(new Error('Camera configuration is busy'));
    return this.addTask = this.addCamera(input);
  }
  async addCamera(input) {
    if (this.closing || this.mutating) throw new Error('Camera configuration is busy');
    this.mutating = true;
    try {
      const config = validateExternal(input), saved = this.adoption.readConfig();
      if (this.has(config.id) || (saved.cameras ?? []).some(c => c.id === config.id) || [...this.cameras.values()].some(c => c.config.provider === config.provider && (config.provider === 'gphoto2' ? c.config.port === config.port : c.config.host === config.host && c.config.port === config.port))) throw new Error('Camera already added');
      // Ignore caller-supplied identity on initial adoption. Establish it from this connection.
      delete config.serial; delete config.productName;
      const snapshot = await this.factory(config).snapshot();
      if (config.provider === 'gphoto2') { config.serial = snapshot.serial; if ([...this.cameras.values()].some(c => c.config.serial === config.serial)) throw new Error('USB camera serial already added'); }
      else { config.productName = snapshot.productName; config.model = snapshot.productName; }
      const latest = this.adoption.readConfig(); latest.external ??= {}; latest.external.cameras ??= []; latest.external.cameras.push(config);
      this.adoption.writeConfig(latest); this.install(config, snapshot); this.emit('change'); return this.view().find(c => c.id === config.id);
    } finally { this.mutating = false; }
  }
  remove(id) {
    const c = this.cameras.get(id); if (!c) throw new Error('No such camera');
    if (this.closing || this.mutating || c.busy) throw new Error('Wait for the current command before removing');
    const saved = this.adoption.readConfig(); saved.external.cameras = saved.external.cameras.filter(c => c.id !== id); this.adoption.writeConfig(saved); this.cameras.delete(id); this.emit('change');
  }
  view() { return [...this.cameras.values()].map(c => ({ id: c.config.id, label: c.config.label, model: c.config.model, provider: c.config.provider, transport: c.config.provider === 'gphoto2' ? 'USB' : 'HTTP', ip: c.config.host ?? c.config.port,
    state: c.state, detail: c.error, properties: {}, status: { recording: c.snapshot?.recording ?? null, recordingState: c.snapshot?.recording === true ? 1 : c.snapshot?.recording === false ? 0 : -1, battery: -1, mediaSlot1Sec: -1, mediaSlot2Sec: -1 },
    capabilities: { schemaVersion: 1, provider: c.config.provider, record: { available: c.state === 'connected' && c.snapshot?.canRecord === true }, capture: { available: c.state === 'connected' && c.snapshot?.canCapture === true }, liveView: { available: false } },
    external: { controls: c.snapshot?.controls ?? [], busy: c.busy, verification: 'hardware-validation-pending' } })); }
  async action(id, action, body = {}) {
    const c = this.cameras.get(id); if (!c) throw new Error('No such external camera');
    if (this.closing) throw new Error('Camera service is stopping');
    if (!['refresh', 'status', 'set', 'capture', 'recordStart', 'recordStop'].includes(action)) throw new RangeError('Action is unavailable for this camera');
    if (action === 'recordStop' && c.stopTask) return c.stopTask;
    if (c.busy && action !== 'recordStop') {
      if (action === 'recordStart' && c.polling) { const queuedRevision = c.revision; await Promise.allSettled([...c.tasks]); if (c.revision !== queuedRevision) throw new Error('Queued Start superseded by a newer command'); return this.action(id, action, body); }
      throw new Error('Camera is busy; wait for the current command');
    }
    const rev = ++c.revision; c.busy = true; c.polling = action === 'status'; this.emit('change');
    const task = Promise.resolve().then(async () => {
      try {
        let snapshot;
        if (action === 'capture') { if (!c.adapter.capture) throw new RangeError('Still capture is unavailable'); snapshot = await c.adapter.capture(); }
        else if (action === 'set') snapshot = await c.adapter.set(body.key, body.value);
        else if (action.startsWith('record')) { if (!c.adapter.record) throw new RangeError('Recording is not implemented for this provider'); snapshot = await c.adapter.record(action === 'recordStart', () => c.revision === rev && !this.closing); }
        else snapshot = await c.adapter.snapshot(action !== 'status');
        if (c.revision !== rev) return { ok: true, confirmed: false, superseded: true };
        // Short transport checks preserve the last exposure metadata.
        if (action === 'status' || action.startsWith('record')) snapshot.controls = c.snapshot?.controls ?? snapshot.controls;
        c.snapshot = snapshot; c.state = 'connected'; c.error = null; return { ok: true, confirmed: true };
      } catch (e) { if (c.revision === rev && !(e instanceof RangeError)) { c.state = 'offline'; c.snapshot = null; c.error = e.message; } throw e; }
      finally { c.tasks.delete(task); if (c.stopTask === task) c.stopTask = null; c.busy = c.tasks.size > 0; this.emit('change'); }
    });
    c.tasks.add(task); if (action === 'recordStop') c.stopTask = task;
    return task;
  }
  start() {
    // USB is refreshed explicitly so background polling cannot monopolize tethering.
    for (const c of this.cameras.values()) this.action(c.config.id, 'refresh').catch(() => {});
    this.timer = setInterval(() => { for (const c of this.cameras.values()) if (c.config.provider === 'blackmagic-rest' && !c.busy) this.action(c.config.id, 'status').catch(() => {}); }, 5000); this.timer.unref?.();
  }
  async stop() { this.closing = true; clearInterval(this.timer); await Promise.allSettled([this.addTask]); await Promise.allSettled([...this.cameras.values()].flatMap(c => [...c.tasks])); }
}
