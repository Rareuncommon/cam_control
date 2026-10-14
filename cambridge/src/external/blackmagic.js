// Native REST values: never reinterpret these using Sony SDK property encodings.
const specs = [
  ['iso', 'ISO', '/video/iso', 'iso', '/video/supportedISOs', 'supportedISOs'],
  ['gain', 'Gain (dB)', '/video/gain', 'gain', '/video/supportedGains', 'supportedGains'],
  ['whiteBalance', 'White balance (K)', '/video/whiteBalance', 'whiteBalance', '/video/whiteBalance/description', 'whiteBalance'],
  ['whiteBalanceTint', 'White balance tint', '/video/whiteBalanceTint', 'whiteBalanceTint', '/video/whiteBalanceTint/description', 'whiteBalanceTint'],
  ['shutterSpeed', 'Shutter speed (1/s)', '/video/shutter', 'shutterSpeed', '/video/supportedShutters', 'shutterSpeeds'],
  ['shutterAngle', 'Shutter angle', '/video/shutter', 'shutterAngle', '/video/supportedShutters', 'shutterAngles'],
];
export class BlackmagicCamera {
  constructor(config) { this.config = config; this.recordWrites = Promise.resolve(); }
  async request(path, method = 'GET', body) {
    const c = this.config;
    const r = await fetch(`${c.https ? 'https' : 'http'}://${c.host}:${c.port}/control/api/v1${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(2500),
      headers: { 'Content-Type': 'application/json', ...(c.username ? { Authorization: `Basic ${Buffer.from(`${c.username}:${c.password ?? ''}`).toString('base64')}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) { await r.body?.cancel(); const error = new Error(`Blackmagic returned HTTP ${r.status}`); error.status = r.status; throw error; }
    if (method !== 'GET') { await r.body?.cancel(); return; }
    let text = ''; for await (const chunk of r.body) { text += Buffer.from(chunk).toString(); if (text.length > 262144) throw new Error('Oversized camera response'); }
    try { return JSON.parse(text); } catch { throw new Error('Camera returned invalid JSON'); }
  }
  async optional(path) { try { return await this.request(path); } catch (e) { if ([403, 404, 405, 501].includes(e.status)) return null; throw e; } }
  async snapshot(includeControls = true) {
    const product = await this.request('/system/product');
    if (typeof product.productName !== 'string' || !product.productName.trim()) throw new Error('Not a recognized Blackmagic camera response');
    if (this.config.productName && product.productName !== this.config.productName) throw new Error('Camera model at this address changed; remove and add it again');
    const transport = await this.optional('/transports/0/record');
    if (transport !== null && typeof transport.recording !== 'boolean') throw new Error('Invalid camera recording state');
    const controls = [];
    for (const [key, label, path, field, metaPath, metaField] of includeControls ? specs : []) {
      const value = await this.optional(path), metadata = await this.optional(metaPath);
      if (!Number.isFinite(value?.[field]) || !metadata) continue;
      const meta = metadata[metaField];
      if (Array.isArray(meta) && meta.length && meta.every(Number.isFinite)) controls.push({ key, label, current: value[field], choices: meta.map(n => ({ index: n, label: String(n) })) });
      else if (Number.isFinite(meta?.min) && Number.isFinite(meta?.max)) controls.push({ key, label, current: value[field], min: meta.min, max: meta.max, step: 1, choices: [] });
    }
    return { productName: product.productName, controls, recording: transport?.recording ?? null, canRecord: transport !== null };
  }
  async set(key, value) {
    const snap = await this.snapshot(), control = snap.controls.find(c => c.key === key), spec = specs.find(s => s[0] === key);
    if (!control || !spec || typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError('Control is unavailable');
    if (control.choices.length ? !control.choices.some(c => c.index === value) : (!Number.isInteger(value) || value < control.min || value > control.max)) throw new RangeError('Value is outside the camera range');
    await this.request(spec[2], 'PUT', { [spec[3]]: value });
    const after = await this.snapshot();
    if (after.controls.find(c => c.key === key)?.current !== value) throw new Error('Camera did not confirm the requested value');
    return after;
  }
  async record(start, valid = () => true) {
    // Stop is never suppressed by an earlier idle reading or exposure polling.
    const before = start ? await this.snapshot(false) : { canRecord: true, recording: null };
    if (!start) {
      const product = await this.request('/system/product');
      if (!product.productName || (this.config.productName && product.productName !== this.config.productName)) throw new Error('Camera identity changed');
    }
    if (!before.canRecord) throw new RangeError('Recording is unavailable');
    if (!start || before.recording !== true) {
      const write = this.recordWrites.then(() => {
        if (start && !valid()) throw new Error('Recording start superseded by Stop');
        return this.request(start ? '/transports/0/record' : '/transports/0/stop', 'POST', start ? {} : undefined);
      });
      this.recordWrites = write.catch(() => {});
      await write;
    }
    const after = await this.snapshot(false);
    if (after.recording !== start) throw new Error('Camera did not confirm recording state; inspect the camera before retrying');
    return after;
  }
}
