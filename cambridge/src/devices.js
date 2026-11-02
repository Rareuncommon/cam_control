// Paired phones: the CamBridge app's credentials, and the checks on them.
//
// A phone is paired once by scanning a QR code from Setup. The code carries a
// per-device secret (256 random bits). The device is *pending* until the
// phone first uses it — over Wi-Fi or Bluetooth — and a pending device that
// is not used within ten minutes is forgotten. Revoking a device deletes it;
// its open streams and Bluetooth sessions are closed by whoever listens for
// 'revoked'.
//
// The secret never travels again after the QR. Over Wi-Fi every request is
// signed with it (HMAC-SHA256 over the method, path, a timestamp, a nonce and
// the body's hash), so a request sniffed on the studio network cannot be
// replayed or altered; over Bluetooth it answers a challenge (see
// src/ble/protocol.js). It is stored in cambridge.json under auth.devices,
// beside the camera credentials (mode 0600, atomic writes, git-ignored).
//
// Devices are an addition to the PIN and token system, not a replacement:
// a request without a device signature is handled exactly as before. A
// request *with* one must carry a good one — even on a panel with no PIN —
// so a revoked phone's app is refused, not quietly let in.

import { EventEmitter } from 'node:events';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SCHEME = 'CamBridge-HMAC';
export const SIGNING_VERSION = 'CAMBRIDGE-HMAC-V1';
const PENDING_MS = 10 * 60_000;
const SKEW_MS = 120_000;
const FAILURES_PER_MINUTE = 30;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** The exact bytes a request signature covers. Shared with the app (see protocol/vectors). */
export function canonicalRequest({ method, target, ts, nonce, body }) {
  const bodyHash = createHash('sha256').update(body ?? Buffer.alloc(0)).digest('hex');
  return [SIGNING_VERSION, String(method).toUpperCase(), target, String(ts), nonce, bodyHash].join('\n');
}

export function signRequest(secret, parts) {
  return b64url(createHmac('sha256', secret).update(canonicalRequest(parts)).digest());
}

/** `CamBridge-HMAC id=…, ts=…, nonce=…, sig=…` → fields, or null. */
export function parseAuthorization(header) {
  const m = /^CamBridge-HMAC\s+(.+)$/i.exec(String(header ?? '').trim());
  if (!m) return null;
  const fields = {};
  for (const part of m[1].split(',')) {
    const at = part.indexOf('=');
    if (at < 0) return null;
    fields[part.slice(0, at).trim()] = part.slice(at + 1).trim().replace(/^"|"$/g, '');
  }
  return fields.id && fields.ts && fields.nonce && fields.sig ? fields : null;
}

export class DeviceRegistry extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => object} o.readConfig
   * @param {(auth: object) => {ok: boolean, error?: string}} o.saveAuth  merges into cfg.auth
   * @param {(level: string, msg: string) => void} [o.log]
   * @param {() => number} [o.now]
   */
  constructor({ readConfig, saveAuth, log = () => {}, now = Date.now }) {
    super();
    this.readConfig = readConfig;
    this.saveAuth = saveAuth;
    this.log = log;
    this.now = now;
    /** id -> { lastSeenAt, via } — in memory: "last seen since CamBridge started". */
    this.seen = new Map();
    /** id -> Map(nonce -> expiry) */
    this.nonces = new Map();
    /** remote address -> [failure times] */
    this.failures = new Map();
    this.#load();
  }

  #load() {
    let auth = {};
    try { auth = this.readConfig()?.auth ?? {}; } catch (err) { this.log('error', `devices: cannot read config (${err.message})`); }
    this.devices = new Map(Object.entries(auth.devices ?? {})
      .filter(([, d]) => d && typeof d.secret === 'string'));
    this.serverId = typeof auth.serverId === 'string' && /^[0-9a-f]{16}$/.test(auth.serverId) ? auth.serverId : null;
  }

  #save() {
    const devices = Object.fromEntries(this.devices);
    const r = this.saveAuth({ devices, ...(this.serverId ? { serverId: this.serverId } : {}) });
    if (!r?.ok) this.log('error', `devices: cannot save (${r?.error ?? 'unknown error'})`);
    return r?.ok !== false;
  }

  /** A random id for this CamBridge, made once: the app matches its pairing to it on any transport. */
  ensureServerId() {
    if (!this.serverId) {
      this.serverId = randomBytes(8).toString('hex');
      this.#save();
    }
    return this.serverId;
  }

  /** Forgets pending devices whose QR was never used. */
  #purge() {
    let changed = false;
    for (const [id, d] of this.devices) {
      if (!d.activatedAt && d.expiresAt && Date.parse(d.expiresAt) <= this.now()) {
        this.devices.delete(id);
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  list() {
    this.#purge();
    return [...this.devices].map(([id, d]) => this.#view(id, d));
  }

  get(id) {
    const d = this.devices.get(id);
    return d ? this.#view(id, d) : null;
  }

  #view(id, d) {
    const seen = this.seen.get(id);
    return {
      id,
      name: d.name ?? null,
      model: d.model ?? null,
      status: d.activatedAt ? 'active' : 'pending',
      createdAt: d.createdAt ?? null,
      activatedAt: d.activatedAt ?? null,
      expiresAt: d.activatedAt ? null : d.expiresAt ?? null,
      lastSeenAt: seen?.lastSeenAt ?? null,
      lastVia: seen?.via ?? null,
    };
  }

  /**
   * A new pending device and its one-time secret. The secret is returned
   * here, for the QR, and never again.
   */
  create({ label } = {}) {
    this.#purge();
    this.ensureServerId();
    const id = `ph-${randomBytes(6).toString('hex')}`;
    const secret = b64url(randomBytes(32));
    const now = this.now();
    this.devices.set(id, {
      name: typeof label === 'string' && label.trim() ? label.trim().slice(0, 40) : null,
      model: null,
      secret,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PENDING_MS).toISOString(),
      activatedAt: null,
    });
    if (!this.#save()) {
      this.devices.delete(id);
      return { ok: false, error: 'could not save the new device' };
    }
    this.log('info', `devices: pairing code made for ${id} (valid 10 min)`);
    return { ok: true, device: this.get(id), secret };
  }

  revoke(id) {
    if (!this.devices.has(id)) return { ok: false, status: 404, error: `no paired device "${id}"` };
    const d = this.devices.get(id);
    this.devices.delete(id);
    this.seen.delete(id);
    this.nonces.delete(id);
    if (!this.#save()) {
      this.devices.set(id, d);
      return { ok: false, status: 500, error: 'could not save the change' };
    }
    this.log('info', `devices: ${id}${d.name ? ` (${d.name})` : ''} revoked`);
    this.emit('revoked', id);
    return { ok: true };
  }

  /** The first use of a pending device: it becomes active and records what the phone calls itself. */
  activate(id, { name, model } = {}) {
    const d = this.devices.get(id);
    if (!d) return { ok: false, status: 404, error: 'not paired' };
    const clean = (s, n) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : null);
    const changed = !d.activatedAt || (clean(name, 40) && clean(name, 40) !== d.name) || (clean(model, 60) && clean(model, 60) !== d.model);
    if (!d.activatedAt) d.activatedAt = new Date(this.now()).toISOString();
    d.expiresAt = null;
    d.name = clean(name, 40) ?? d.name;
    d.model = clean(model, 60) ?? d.model;
    if (changed && !this.#save()) return { ok: false, status: 500, error: 'could not save the pairing' };
    if (changed) this.log('info', `devices: ${id} paired as "${d.name ?? 'unnamed'}"${d.model ? ` (${d.model})` : ''}`);
    this.emit('changed', id);
    return { ok: true, device: this.get(id) };
  }

  touch(id, via) {
    if (this.devices.has(id)) this.seen.set(id, { lastSeenAt: new Date(this.now()).toISOString(), via });
  }

  /**
   * The secret of a device, for the Bluetooth challenge. A pending device
   * counts only until its QR expires.
   *
   * @returns {{ok: true, key: Buffer, device: object} | {ok: false, reason: string}}
   */
  keyFor(id) {
    const d = this.devices.get(id);
    if (!d) return { ok: false, reason: 'unknown-device' };
    if (!d.activatedAt && Date.parse(d.expiresAt) <= this.now()) return { ok: false, reason: 'pairing-expired' };
    return { ok: true, key: Buffer.from(d.secret, 'base64url'), device: this.get(id) };
  }

  /**
   * Checks a signed HTTP request.
   *
   * @param {object} o
   * @param {string} o.method
   * @param {string} o.target      path and query exactly as sent (req.url)
   * @param {string} o.authorization
   * @param {Buffer} o.body
   * @param {string} [o.remote]   for the failure rate limit
   * @param {boolean} [o.allowPending]  only for POST /api/devices/activate
   * @returns {{ok: true, device: object} | {ok: false, status: number, reason: string, error: string, serverTime?: number}}
   */
  verifyRequest({ method, target, authorization, body, remote = '?', allowPending = false }) {
    if (this.#tooManyFailures(remote)) {
      return { ok: false, status: 429, reason: 'rate-limited', error: 'too many failed attempts from this address; wait a minute' };
    }
    const fail = (reason, error, extra = {}) => {
      this.#recordFailure(remote);
      return { ok: false, status: 401, reason, error, ...extra };
    };
    const f = parseAuthorization(authorization);
    if (!f) return fail('malformed', 'the device signature is malformed');
    const d = this.devices.get(f.id);
    if (!d) return fail('unknown-device', 'this phone is not paired with CamBridge, or was revoked');
    if (!d.activatedAt) {
      if (Date.parse(d.expiresAt) <= this.now()) return fail('pairing-expired', 'the pairing code expired; pair again from Setup');
      if (!allowPending) return fail('not-activated', 'finish pairing first');
    }
    const ts = Number(f.ts);
    const now = this.now();
    if (!Number.isFinite(ts) || Math.abs(now - ts) > SKEW_MS) {
      return fail('clock-skew', 'the request time is too far from CamBridge’s clock', { serverTime: now });
    }
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(f.nonce)) return fail('malformed', 'the nonce is malformed');
    const expected = createHmac('sha256', Buffer.from(d.secret, 'base64url'))
      .update(canonicalRequest({ method, target, ts: f.ts, nonce: f.nonce, body })).digest();
    let given;
    try { given = Buffer.from(f.sig, 'base64url'); } catch { given = Buffer.alloc(0); }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return fail('bad-signature', 'the device signature does not match');
    // Checked after the signature, so a forged request cannot burn a real nonce.
    const seen = this.nonces.get(f.id) ?? new Map();
    for (const [n, exp] of seen) if (exp <= now) seen.delete(n);
    if (seen.has(f.nonce)) return fail('replay', 'this request was already used');
    seen.set(f.nonce, now + 2 * SKEW_MS);
    this.nonces.set(f.id, seen);
    this.touch(f.id, 'wifi');
    return { ok: true, device: this.get(f.id) };
  }

  #recordFailure(remote) {
    const now = this.now();
    const list = (this.failures.get(remote) ?? []).filter((t) => t > now - 60_000);
    list.push(now);
    this.failures.set(remote, list);
  }

  #tooManyFailures(remote) {
    const now = this.now();
    const list = (this.failures.get(remote) ?? []).filter((t) => t > now - 60_000);
    this.failures.set(remote, list);
    return list.length >= FAILURES_PER_MINUTE;
  }
}

/**
 * The QR's content. A URI so a phone's own camera app recognises it as
 * CamBridge's, with everything the app needs to find and trust this server
 * on either transport.
 */
export function pairingUri({ serverId, serverName, hosts, port, deviceId, secret, expiresAt }) {
  const q = new URLSearchParams({
    v: '1', sid: serverId, sn: serverName, h: hosts.join(','), p: String(port), id: deviceId, k: secret,
    exp: String(Math.floor(Date.parse(expiresAt) / 1000)),
  });
  return `cambridge://pair?${q}`;
}
