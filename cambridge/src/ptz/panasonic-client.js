import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { velocity } from './visca-client.js';

export function panasonicCommand(action, body = {}) {
  const rate = (n, name) => String(50 + Math.sign(velocity(n, name)) * Math.max(1, Math.round(Math.abs(n) * 49))).padStart(2, '0');
  if (action === 'panTilt') { const v = `PTS${rate(body.pan ?? 0, 'pan')}${rate(body.tilt ?? 0, 'tilt')}`; return [`#${v}`, `p${v.slice(1)}`]; }
  if (action === 'zoom') return [`#Z${rate(body.zoom ?? 0, 'zoom')}`, `zS${rate(body.zoom ?? 0, 'zoom')}`];
  if (action === 'probe') return ['#O', /^p[013]$/];
  if (action === 'home') return ['#APC7FFF7FFF', 'aPC7FFF7FFF'];
  if (['presetSave', 'presetRecall'].includes(action)) {
    if (!Number.isInteger(body.slot) || body.slot < 0 || body.slot > 99) throw new Error('preset slot must be 0–99');
    const slot = String(body.slot).padStart(2, '0');
    return [action === 'presetSave' ? `#M${slot}` : `#R${slot}`, `s${slot}`];
  }
  throw new Error('Unsupported Panasonic action');
}
export function digestHeader(challenge, username, password, uri) {
  if (!challenge.startsWith('Digest ')) throw new Error('Camera authentication scheme is unsupported');
  const fields = Object.fromEntries([...challenge.slice(7).matchAll(/(\w+)=(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g)]
    .map(m => [m[1].toLowerCase(), (m[2] ?? m[3]).replace(/\\(.)/g, '$1')]));
  const algorithm = (fields.algorithm ?? 'MD5').toUpperCase();
  if (!['MD5', 'SHA-256', 'MD5-SESS', 'SHA-256-SESS'].includes(algorithm) || !fields.realm || !fields.nonce)
    throw new Error('Camera sent an unsupported Digest challenge');
  const hash = s => createHash(algorithm.startsWith('MD5') ? 'md5' : 'sha256').update(s).digest('hex');
  const quote = s => `"${String(s).replace(/[\\"]/g, '\\$&')}"`;
  const cnonce = randomBytes(16).toString('hex'), nc = '00000001';
  let ha1 = hash(`${username}:${fields.realm}:${password}`);
  if (algorithm.endsWith('-SESS')) ha1 = hash(`${ha1}:${fields.nonce}:${cnonce}`);
  const ha2 = hash(`GET:${uri}`);
  const qop = fields.qop ? fields.qop.split(',').map(s => s.trim()).includes('auth') ? 'auth' : null : '';
  if (qop === null) throw new Error('Camera Digest requires unsupported qop');
  const response = hash(qop ? `${ha1}:${fields.nonce}:${nc}:${cnonce}:${qop}:${ha2}` : `${ha1}:${fields.nonce}:${ha2}`);
  return 'Digest ' + [`username=${quote(username)}`, `realm=${quote(fields.realm)}`, `nonce=${quote(fields.nonce)}`,
    `uri=${quote(uri)}`, `response=${quote(response)}`, `algorithm=${algorithm}`,
    ...(fields.opaque ? [`opaque=${quote(fields.opaque)}`] : []),
    ...(qop ? [`qop=auth`, `nc=${nc}`, `cnonce=${quote(cnonce)}`] : algorithm.endsWith('-SESS') ? [`cnonce=${quote(cnonce)}`] : [])].join(', ');
}
export class PanasonicClient {
  constructor(config) { this.config = config; this.lastSent = 0; }
  async send(action, body, { valid = () => true } = {}) {
    const [command, expected] = panasonicCommand(action, body);
    await delay(Math.max(0, 130 - (Date.now() - this.lastSent)));
    if (!valid()) throw new Error('PTZ command superseded before dispatch');
    const cfg = this.config;
    const url = new URL(`${cfg.https ? 'https' : 'http'}://${cfg.host}:${cfg.port}/cgi-bin/aw_ptz`);
    url.searchParams.set('cmd', command); url.searchParams.set('res', '1');
    const options = { redirect: 'error', signal: AbortSignal.timeout(cfg.timeoutMs ?? 700), headers: { Connection: 'close' } };
    this.lastSent = Date.now();
    let res = await fetch(url, options);
    this.lastSent = Date.now();
    if (res.status === 401 && cfg.username) {
      const challenge = res.headers.get('www-authenticate') ?? '';
      await res.body?.cancel();
      if (!valid()) throw new Error('PTZ command superseded during authentication');
      if (challenge.startsWith('Basic ')) options.headers.Authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.password ?? ''}`).toString('base64')}`;
      else options.headers.Authorization = digestHeader(challenge, cfg.username, cfg.password ?? '', url.pathname + url.search);
      await delay(Math.max(0, 130 - (Date.now() - this.lastSent)));
      if (!valid()) throw new Error('PTZ command superseded before authenticated dispatch');
      this.lastSent = Date.now();
      res = await fetch(url, options);
      this.lastSent = Date.now();
    }
    if (!res.ok) { await res.body?.cancel(); throw new Error(`Panasonic returned HTTP ${res.status}`); }
    let text = '';
    for await (const chunk of res.body) { text += Buffer.from(chunk).toString(); if (text.length > 4096) throw new Error('Oversized Panasonic response'); }
    text = text.trim();
    if (typeof expected === 'string' ? text !== expected : !expected.test(text))
      throw new Error('Camera refused command or returned an unexpected Panasonic response');
    return { acknowledged: true, completed: false, ...(action === 'probe' ? { power: text === 'p1' ? 'on' : 'standby' } : {}) };
  }
}
