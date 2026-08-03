// Camera adoption: discover a body on the network, give it credentials, and make
// it a permanent part of the system — all without touching a terminal.
//
// Two things have to happen together and stay consistent: camd has to be told
// about the camera so it starts controlling it now, and the config file has to
// record it so it comes back after a restart. This module owns both, and rolls
// back the runtime change if the file write fails — a camera that works today and
// vanishes on Monday is worse than one that never adopted.

import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
  if (hex.length !== 12) return null;
  return hex.match(/../g).join(':');
}

export class Adoption {
  /**
   * @param {string} configPath
   * @param {import('./camd-client.js').CamdClient} camd
   * @param {import('./log.js').Logger} log
   */
  constructor(configPath, camd, log) {
    this.configPath = configPath;
    this.camd = camd;
    this.log = log;
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
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    if (existsSync(this.configPath)) {
      try { copyFileSync(this.configPath, `${this.configPath}.bak`); } catch { /* best effort */ }
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
   * Adopt a discovered camera.
   * @param {{mac:string,model?:string,ip?:string,label?:string,username?:string,password?:string,id?:string}} input
   */
  async adopt(input) {
    const mac = normaliseMac(input.mac);
    if (!mac) return { ok: false, error: 'a valid MAC address is required' };

    const cfg = this.readConfig();
    cfg.cameras ??= [];

    if (cfg.cameras.some((c) => normaliseMac(c.mac) === mac)) {
      return { ok: false, error: `that camera is already adopted (${mac})` };
    }

    const taken = new Set(cfg.cameras.map((c) => c.id));
    const id = input.id?.trim() || suggestId(input.model, mac, taken);
    if (taken.has(id)) return { ok: false, error: `camera id "${id}" is already in use` };

    const entry = {
      id,
      label: input.label?.trim() || input.model || id,
      model: input.model || '',
      ip: input.ip || '',
      mac,
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
      cfg.cameras.push(entry);
      this.writeConfig(cfg);
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

  async forget(id) {
    const cfg = this.readConfig();
    const before = (cfg.cameras ?? []).length;
    cfg.cameras = (cfg.cameras ?? []).filter((c) => c.id !== id);
    if (cfg.cameras.length === before) return { ok: false, error: `no camera "${id}" in config` };

    await this.camd.request('DELETE', `/cameras/${encodeURIComponent(id)}`);
    try {
      this.writeConfig(cfg);
    } catch (err) {
      return { ok: false, error: `could not save config: ${err.message}` };
    }
    this.log.info('adopt', `forgot camera ${id}`);
    return { ok: true, id };
  }

  /** Rename, or replace credentials, on an already-adopted camera. */
  async update(id, changes) {
    const cfg = this.readConfig();
    const entry = (cfg.cameras ?? []).find((c) => c.id === id);
    if (!entry) return { ok: false, error: `no camera "${id}" in config` };

    if (typeof changes.label === 'string' && changes.label.trim()) {
      entry.label = changes.label.trim();
    }
    let credentialsChanged = false;
    if (typeof changes.username === 'string' && changes.username.trim()) {
      entry.auth = { ...(entry.auth ?? {}), username: changes.username.trim() };
      credentialsChanged = true;
    }
    if (typeof changes.password === 'string' && changes.password) {
      entry.auth = { ...(entry.auth ?? {}), password: changes.password };
      credentialsChanged = true;
    }

    try {
      this.writeConfig(cfg);
    } catch (err) {
      return { ok: false, error: `could not save config: ${err.message}` };
    }

    // A label change is cosmetic and can be applied live. New credentials only
    // take effect on a fresh connection, so the camera is re-adopted in place —
    // which is still far better than restarting the daemon and dropping the rest.
    await this.camd.request('DELETE', `/cameras/${encodeURIComponent(id)}`);
    const res = await this.camd.request('POST', '/cameras', entry);
    if (!res.ok) {
      return { ok: false, error: res.body?.error ?? 'camd refused the updated camera' };
    }

    this.log.info('adopt',
      `updated ${id}${credentialsChanged ? ' (new credentials)' : ''}: ${entry.label}`);
    return { ok: true, camera: { ...entry, auth: undefined } };
  }
}
