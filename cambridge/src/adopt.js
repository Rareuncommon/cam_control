// Camera adoption: discover a body over USB or a supported network connection, give it credentials, and make
// it a permanent part of the system — all without touching a terminal.
//
// Two things have to happen together and stay consistent: camd has to be told
// about the camera so it starts controlling it now, and the config file has to
// record it so it comes back after a restart. This module owns both, and rolls
// back the runtime change if the file write fails — a camera that works today and
// vanishes on Monday is worse than one that never adopted.

import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { isIP } from 'node:net';

/**
 * An address a PTZ head can be reached at: an IP, or a host name. Host names
 * are allowed because some venues name their cameras in DNS, and because a
 * name that resolves only on the venue's network is still the right thing to
 * store — it is the venue's network the camera lives on.
 */
export function isHostAddress(s) {
  const v = String(s ?? '').trim();
  if (isIP(v)) return true;
  return v.length <= 253
    && /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(v);
}

/** Turns a model and MAC into a stable, readable, filesystem-safe id. */
export function suggestId(model, mac, taken = new Set()) {
  const base = (model || 'camera')
    .toLowerCase()
    .replace(/^ilme-/, '')
    .replace(/[^a-z0-9]+/g, '')
    || 'camera';
  if (!taken.has(base)) return base;
  // Disambiguate with the MAC's last octet rather than a counter, so an id stays
  // attached to a body even if cameras are adopted in a different order.
  // Separated, because "fx30" + "03" reads as the model number "fx3003".
  const tail = (mac || '').replace(/[^0-9A-Fa-f]/g, '').slice(-2).toLowerCase();
  const withTail = tail ? `${base}-${tail}` : base;
  if (!taken.has(withTail)) return withTail;
  for (let i = 2; i < 100; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

export function normaliseMac(input) {
  const hex = String(input || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (hex.length !== 12 || /^(0{12}|F{12})$/.test(hex)) return null;
  return hex.match(/../g).join(':');
}

export function cameraIdentity(camera) {
  const mac = normaliseMac(camera?.mac);
  if (mac) return `mac:${mac}`;
  const id = camera?.deviceId;
  return typeof id === 'string' && id.length <= 16384 && /^sony-sdk:[0-9]+:(?:[0-9a-f]{2})+$/.test(id)
    ? `device:${id}` : null;
}

export class Adoption {
  #pending = Promise.resolve();
  #mutate(operation) {
    const next = this.#pending.then(operation);
    this.#pending = next.catch(() => {});
    return next;
  }
  adopt(input) { return this.#mutate(() => this.#adopt(input)); }
  forget(id) { return this.#mutate(() => this.#forget(id)); }
  update(id, changes) { return this.#mutate(() => this.#update(id, changes)); }
  pinFingerprint(id, fingerprint) { return this.#mutate(() => this.#pinFingerprint(id, fingerprint)); }
  repin(id, fingerprint) { return this.#mutate(() => this.#repin(id, fingerprint)); }

  /**
   * @param {string} configPath
   * @param {import('./camd-client.js').CamdClient} camd
   * @param {import('./log.js').Logger} log
   */
  constructor(configPath, camd, log, ptz = null) {
    this.configPath = configPath;
    this.camd = camd;
    this.log = log;
    /** @type {import('./ptz/source.js').PtzSource | null} */
    this.ptz = ptz;
  }

  readConfig() {
    try {
      return JSON.parse(readFileSync(this.configPath, 'utf8'));
    } catch (err) {
      if (!existsSync(this.configPath)) return { cameras: [] };
      throw new Error(`config at ${this.configPath} is unreadable: ${err.message}`);
    }
  }

  /**
   * Atomic write with a one-generation backup.
   *
   * This file holds every camera's credentials. A half-written config would mean
   * re-reading three Access Authen. Info screens before a shoot, so: write a
   * temp file, keep the previous version as .bak, then rename into place.
   */
  writeConfig(cfg) {
    mkdirSync(dirname(this.configPath), { recursive: true });
    const tmp = `${this.configPath}.tmp`;
    // `mode` only applies when the file is created, so a stale .tmp left by a
    // crash (or made 0644 by hand) would keep its old mode. Remove it, create
    // exclusively, and chmod after the write as well.
    rmSync(tmp, { force: true });
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    if (existsSync(this.configPath)) {
      const bak = `${this.configPath}.bak`;
      try {
        copyFileSync(this.configPath, bak);
        chmodSync(bak, 0o600);
      } catch { /* best effort */ }
    }
    renameSync(tmp, this.configPath);
  }

  /** Cameras already in the config file. */
  adopted() {
    const cfg = this.readConfig();
    return Array.isArray(cfg.cameras) ? cfg.cameras : [];
  }

  /**
   * Persists the auth block, re-reading first.
   *
   * Deliberately re-reads rather than writing a remembered copy: setting a PIN
   * must not roll back a camera adopted a moment earlier from another browser.
   * Goes through the same atomic write as everything else here, which also
   * means the PIN hash lands in a file that is already mode 0600.
   */
  saveAuth(authBlock) {
    try {
      const cfg = this.readConfig();
      cfg.auth = authBlock;
      this.writeConfig(cfg);
      return { ok: true };
    } catch (err) {
      this.log?.error('auth', `could not save the PIN: ${err.message}`);
      return { ok: false, error: `could not save the PIN: ${err.message}` };
    }
  }

  /**
   * Merges `patch` into one top-level block of the config file, re-reading
   * first for the same reason saveAuth does: a setting changed here must not
   * roll back a camera adopted a moment earlier from another browser. Keys
   * not in the patch — a hand-edited SKAARHOJ mapping, say — are kept.
   *
   * @returns {{ok: true, block: object} | {ok: false, error: string}}
   */
  saveSection(name, patch) {
    try {
      const cfg = this.readConfig();
      const block = { ...(cfg[name] && typeof cfg[name] === 'object' ? cfg[name] : {}), ...patch };
      cfg[name] = block;
      this.writeConfig(cfg);
      return { ok: true, block };
    } catch (err) {
      this.log?.error('config', `could not save ${name}: ${err.message}`);
      return { ok: false, error: `could not save ${name}: ${err.message}` };
    }
  }

  /**
   * Adopt a discovered camera.
   * @param {{mac?:string,deviceId?:string,model?:string,ip?:string,label?:string,username?:string,password?:string,id?:string}} input
   */
  async #adopt(input) {
    const identity = cameraIdentity(input);
    if (!identity) return { ok: false, error: 'a discovered MAC or SDK device ID is required' };
    // Names, addresses and authentication requirements come from SDK discovery,
    // not a model typed into an API request. Unknown SDK models remain usable.
    const scan = await this.camd.request('GET', '/discovered');
    if (!scan.ok) return { ok: false, error: 'cannot verify camera discovery' };
    const matches = (scan.body?.discovered ?? []).filter((c) => cameraIdentity(c) === identity);
    if (matches.length !== 1) return { ok: false, error: 'camera identity is missing or ambiguous; refresh discovery' };
    const discovered = matches[0];
    const mac = normaliseMac(discovered.mac);
    const deviceId = mac ? '' : discovered.deviceId;
    input = { ...input, model: discovered.model, ip: discovered.ip };
    if (discovered.accessAuthRequired && (!input.username?.trim() || !input.password)) {
      return { ok: false, error: 'this camera requires its access-authentication username and password' };
    }

    const cfg = this.readConfig();
    cfg.cameras ??= [];

    if (cfg.cameras.some((c) => cameraIdentity(c) === identity)) {
      return { ok: false, error: 'that camera is already adopted' };
    }

    const taken = new Set(cfg.cameras.map((c) => c.id));
    const id = input.id?.trim() || suggestId(input.model, mac || deviceId, taken);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)) return { ok: false, error: 'invalid camera id' };
    if (taken.has(id)) return { ok: false, error: `camera id "${id}" is already in use` };

    const entry = {
      id,
      label: input.label?.trim() || input.model || id,
      model: input.model || '',
      ip: input.ip || '',
      mac: mac || '',
      deviceId,
      transport: discovered.transport || '',
      auth: {
        username: input.username?.trim() ?? '',
        password: input.password ?? '',
      },
    };

    // Tell camd first. If the camera is rejected — wrong credentials, already
    // known — nothing has been written, so there is no stale entry to clean up.
    const res = await this.camd.request('POST', '/cameras', entry);
    if (!res.ok) {
      return { ok: false, error: res.body?.error ?? 'camd refused the camera' };
    }

    try {
      // Auth may have changed while camd was answering. Merge into the latest
      // file rather than overwrite a newly saved PIN with our older snapshot.
      const latest = this.readConfig();
      latest.cameras ??= [];
      if (latest.cameras.some((c) => c.id === id || cameraIdentity(c) === identity)) {
        throw new Error('camera configuration changed during adoption; refresh and retry');
      }
      latest.cameras.push(entry);
      this.writeConfig(latest);
    } catch (err) {
      // Roll the runtime change back rather than leaving a camera that works now
      // and disappears at the next restart.
      await this.camd.request('DELETE', `/cameras/${encodeURIComponent(id)}`);
      this.log.error('adopt', `config write failed, rolled back ${id}: ${err.message}`);
      return { ok: false, error: `could not save config: ${err.message}` };
    }

    this.log.info('adopt', `adopted ${entry.model} ${mac} as "${entry.label}" (${id})`);
    return { ok: true, camera: { ...entry, auth: undefined } };
  }

  async #forget(id) {
    const cfg = this.readConfig();
    const before = (cfg.cameras ?? []).length;
    const gone = (cfg.cameras ?? []).find((c) => c.id === id);
    cfg.cameras = (cfg.cameras ?? []).filter((c) => c.id !== id);
    if (cfg.cameras.length === before) return { ok: false, error: `no camera "${id}" in config` };

    if (gone?.kind === 'ptz') {
      await this.ptz?.remove(id);
    } else {
      // A camera camd refuses to let go of is still connected; forgetting it
      // here would leave it controlled with no entry to manage it. A daemon
      // that is not running, or does not know the camera, holds nothing.
      const removed = await this.camd.request('DELETE', `/cameras/${encodeURIComponent(id)}`);
      if (!removed.ok && removed.status && removed.status !== 404) {
        return { ok: false, error: removed.body?.error ?? 'camd refused removal' };
      }
    }
    try {
      const latest = this.readConfig();
      latest.cameras = (latest.cameras ?? []).filter((c) => c.id !== id);
      this.writeConfig(latest);
    } catch (err) {
      return { ok: false, error: `could not save config: ${err.message}` };
    }
    this.log.info('adopt', `forgot camera ${id}`);
    return { ok: true, id };
  }

  /** Rename, or replace credentials, on an already-adopted camera. */
  async #update(id, changes) {
    const cfg = this.readConfig();
    const entry = (cfg.cameras ?? []).find((c) => c.id === id);
    if (!entry) return { ok: false, error: `no camera "${id}" in config` };

    let labelChanged = false;
    if (typeof changes.label === 'string' && changes.label.trim() && changes.label.trim() !== entry.label) {
      entry.label = changes.label.trim();
      labelChanged = true;
    }
    // Only an actual change of connection identity needs a fresh SDK session.
    // Re-submitting the credentials a camera already has is not a change.
    let credentialsChanged = false;
    if (typeof changes.username === 'string' && changes.username.trim() &&
        changes.username.trim() !== entry.auth?.username) {
      entry.auth = { ...(entry.auth ?? {}), username: changes.username.trim() };
      credentialsChanged = true;
    }
    if (typeof changes.password === 'string' && changes.password &&
        changes.password !== entry.auth?.password) {
      entry.auth = { ...(entry.auth ?? {}), password: changes.password };
      credentialsChanged = true;
    }
    // A PTZ head is reached by address, not discovered by MAC, so its address
    // is something an operator edits. A Sony body's is whatever camd finds.
    // Groups are the operator's way of finding one camera among thirty:
    // "Stage", "Balcony". An empty string takes a camera out of its group.
    let otherChanged = false;
    if (typeof changes.group === 'string') {
      const g = changes.group.trim().slice(0, 40);
      if (g !== (entry.group ?? '')) otherChanged = true;
      if (g) entry.group = g; else delete entry.group;
    }
    if (entry.kind === 'ptz' && typeof changes.ip === 'string' && changes.ip.trim()) {
      if (!isHostAddress(changes.ip)) return { ok: false, error: `"${changes.ip}" is not an IP address or host name` };
      // Two entries at one address would be two sets of controls on one head.
      const clash = cfg.cameras.find((c) => c.id !== id && c.kind === 'ptz' && c.ip === changes.ip.trim());
      if (clash) return { ok: false, status: 409, error: `${changes.ip.trim()} is already "${clash.label}"` };
      if (entry.ip !== changes.ip.trim()) otherChanged = true;
      entry.ip = changes.ip.trim();
    }
    if (!labelChanged && !credentialsChanged && !otherChanged) {
      return { ok: true, unchanged: true, camera: { ...entry, auth: undefined } };
    }

    try {
      this.writeConfig(cfg);
    } catch (err) {
      return { ok: false, error: `could not save config: ${err.message}` };
    }

    if (entry.kind === 'ptz') {
      await this.ptz?.update(id, entry);
      this.log.info('adopt',
        `updated ${id}${credentialsChanged ? ' (new credentials)' : ''}: ${entry.label}`);
      return { ok: true, camera: { ...entry, auth: undefined } };
    }

    // A label is cosmetic and is applied live (audit DC-4: renaming used to
    // drop and re-adopt the camera, interrupting live view and control during
    // a shoot). New credentials only take effect on a fresh connection, so
    // only then is the camera re-adopted in place — still far better than
    // restarting the daemon and dropping the rest.
    if (credentialsChanged) {
      await this.camd.request('DELETE', `/cameras/${encodeURIComponent(id)}`);
      const res = await this.camd.request('POST', '/cameras', entry);
      if (!res.ok) {
        return { ok: false, error: res.body?.error ?? 'camd refused the updated camera' };
      }
    } else {
      const res = await this.camd.request('PUT', `/cameras/${encodeURIComponent(id)}/label`, { label: entry.label });
      if (!res.ok) {
        // Saved, and shown from config on the next daemon start; the live
        // connection is deliberately left alone rather than reconnected.
        this.log.warn?.('adopt', `label for ${id} saved; camd did not apply it live: ${res.body?.error ?? res.status}`);
        return { ok: true, camera: { ...entry, auth: undefined }, liveLabel: false };
      }
    }

    this.log.info('adopt',
      `updated ${id}${credentialsChanged ? ' (new credentials)' : ''}: ${entry.label}`);
    return { ok: true, camera: { ...entry, auth: undefined } };
  }

  /**
   * Adds a PTZ camera found by add-by-IP.
   *
   * Same shape of guarantee as adopt(): the camera starts being controlled and
   * the config records it, or neither happens.
   *
   * @param {{ip: string, vendor: string, model?: string, label?: string, id?: string,
   *          username?: string, password?: string, port?: number, options?: object}} input
   */
  async addPtz(input) {
    const ip = String(input.ip ?? '').trim();
    if (!isHostAddress(ip)) return { ok: false, error: 'an IP address or host name is required' };
    if (!input.vendor) return { ok: false, error: 'which kind of camera is it?' };
    if (!this.ptz) return { ok: false, error: 'PTZ control is not running' };

    const cfg = this.readConfig();
    cfg.cameras ??= [];
    if (cfg.cameras.some((c) => c.kind === 'ptz' && c.ip === ip)) {
      return { ok: false, error: `a camera at ${ip} is already added` };
    }
    const taken = new Set(cfg.cameras.map((c) => c.id));
    const id = input.id?.trim() || suggestId(input.model || input.vendor, ip.replace(/[^0-9A-Fa-f]/g, ''), taken);
    if (taken.has(id)) return { ok: false, error: `camera id "${id}" is already in use` };

    const entry = {
      id,
      kind: 'ptz',
      vendor: String(input.vendor).toLowerCase(),
      label: input.label?.trim() || input.model || id,
      model: input.model || '',
      ip,
      ...(Number.isInteger(input.port) ? { port: input.port } : {}),
      auth: {
        username: input.username?.trim() ?? '',
        password: input.password ?? '',
      },
      ...(input.options && typeof input.options === 'object' ? { options: input.options } : {}),
      ...(typeof input.group === 'string' && input.group.trim() ? { group: input.group.trim().slice(0, 40) } : {}),
    };

    try {
      cfg.cameras.push(entry);
      this.writeConfig(cfg);
    } catch (err) {
      this.log.error('adopt', `config write failed, ${id} not added: ${err.message}`);
      return { ok: false, error: `could not save config: ${err.message}` };
    }
    try {
      this.ptz.add(entry);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    this.log.info('adopt', `added ${entry.vendor} ${entry.model || 'PTZ'} at ${ip} as "${entry.label}" (${id})`);
    return { ok: true, camera: { ...entry, auth: undefined } };
  }

  /**
   * The order cameras appear in, everywhere: panel, multiview, Companion,
   * the SKAARHOJ camera buttons. Ids given come first, in that order; any
   * camera not named keeps its place after them.
   */
  reorder(ids) {
    if (!Array.isArray(ids)) return { ok: false, error: 'ids must be a list' };
    const cfg = this.readConfig();
    const cams = cfg.cameras ?? [];
    const byId = new Map(cams.map((c) => [c.id, c]));
    const first = ids.map((id) => byId.get(id)).filter(Boolean);
    const named = new Set(first.map((c) => c.id));
    cfg.cameras = [...first, ...cams.filter((c) => !named.has(c.id))];
    try {
      this.writeConfig(cfg);
    } catch (err) {
      return { ok: false, error: `could not save config: ${err.message}` };
    }
    this.log.info('adopt', `camera order: ${cfg.cameras.map((c) => c.id).join(', ')}`);
    return { ok: true, order: cfg.cameras.map((c) => c.id) };
  }

  /**
   * Persists the SSH host key camd pinned on this camera's first connection
   * (trust on first use). Only fills an empty pin: an existing pin is never
   * replaced from an event, because that is exactly what an impostor would
   * produce. Changing a pin is repin(), a deliberate operator action.
   */
  async #pinFingerprint(id, fingerprint) {
    if (typeof fingerprint !== 'string' || !fingerprint || fingerprint.length > 512) {
      return { ok: false, error: 'invalid fingerprint' };
    }
    const cfg = this.readConfig();
    const entry = (cfg.cameras ?? []).find((c) => c.id === id);
    if (!entry) return { ok: false, error: `no camera "${id}" in config` };
    if (entry.fingerprint) {
      return entry.fingerprint === fingerprint
        ? { ok: true, unchanged: true }
        : { ok: false, error: 'a different host key is already pinned; re-pair deliberately to change it' };
    }
    entry.fingerprint = fingerprint;
    try { this.writeConfig(cfg); } catch (err) { return { ok: false, error: `could not save config: ${err.message}` }; }
    this.log.info('adopt', `pinned SSH host key for ${id}: ${fingerprint}`);
    return { ok: true, pinned: fingerprint };
  }

  /**
   * Deliberate re-pair after "camera identity changed". camd accepts only the
   * exact fingerprint the camera presented, and only while the camera is in
   * that state; the stored pin changes only after camd agreed.
   */
  async #repin(id, fingerprint) {
    if (typeof fingerprint !== 'string' || fingerprint.length > 512) return { ok: false, error: 'invalid fingerprint' };
    const cfg = this.readConfig();
    const entry = (cfg.cameras ?? []).find((c) => c.id === id);
    if (!entry) return { ok: false, error: `no camera "${id}" in config` };
    const res = await this.camd.request('POST', `/cameras/${encodeURIComponent(id)}/repin`, { fingerprint });
    if (!res.ok) return { ok: false, error: res.body?.error ?? 'camd refused the re-pair' };
    const latest = this.readConfig();
    const current = (latest.cameras ?? []).find((c) => c.id === id);
    if (!current) return { ok: false, error: `no camera "${id}" in config` };
    if (fingerprint) current.fingerprint = fingerprint; else delete current.fingerprint;
    try { this.writeConfig(latest); } catch (err) { return { ok: false, error: `could not save config: ${err.message}` }; }
    this.log.warn?.('adopt', `re-paired ${id}: host key ${fingerprint || '(none)'} pinned by operator`);
    return { ok: true, id, fingerprint };
  }
}
