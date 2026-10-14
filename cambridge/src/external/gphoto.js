// gphoto2 is an optional local executable, never a shell command supplied by HTTP.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync } from 'node:fs';
const exec = promisify(execFile);
// Shown to operators, so it names what works and what to do, not a build step.
export const HELPER_MISSING = "USB camera settings and photo capture need Wordtandem's USB helper, which is not included for this computer. Discovery still works; change settings on the camera itself.";
export const helperPath = () => process.env.CAMBRIDGE_GPHOTO_HELPER || fileURLToPath(new URL('../../native/gphoto-control', import.meta.url));
const helperCache = new Map();
/**
 * Whether the mutation helper is present AND loads (audit DC-6). Discovery only
 * needs the gphoto2 command, so a working discovery used to make settings and
 * capture look available on installs that ship no helper. Run with no
 * arguments, a helper whose libraries load prints its usage and exits 1; a
 * missing file or a dynamic-library failure means unavailable. Cached per path
 * and re-probed only when the file changes.
 */
export async function helperStatus(path = helperPath()) {
  let stamp = null;
  try { stamp = statSync(path).mtimeMs; } catch { /* missing */ }
  const cached = helperCache.get(path);
  if (cached && cached.stamp === stamp) return cached.status;
  let status = { available: false, reason: HELPER_MISSING };
  if (stamp !== null) {
    try { await exec(path, [], { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536 }); }
    catch (e) { if (e.code === 1 && /Expected port, model/.test(String(e.stderr) + String(e.stdout))) status = { available: true, reason: null }; }
  }
  helperCache.set(path, { stamp, status });
  return status;
}
export const executable = () => process.env.CAMBRIDGE_GPHOTO2 || ['/opt/homebrew/bin/gphoto2', '/usr/local/bin/gphoto2', '/usr/bin/gphoto2'].find(existsSync) || 'gphoto2';
export async function runGphoto(args) {
  try { const r = await exec(executable(), args, { timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }); return r.stdout; }
  catch (e) { throw new Error(e.code === 'ENOENT' ? 'Install gphoto2 to use USB cameras (brew install gphoto2 on macOS)' : `USB command failed${e.killed ? ' or timed out; result is unknown' : ''}. Close other tethering apps and check the camera.`); }
}
export async function runGphotoHelper(config, action, key = '', value = '', expected = '') {
  const path = helperPath();
  try { await exec(path, [config.port, config.model, config.serial, action, key, String(value), expected], { timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 65536 }); }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'EACCES') throw new RangeError(HELPER_MISSING); throw new Error('USB operation refused or timed out; check the camera before retrying'); }
}
export function parseDiscovery(text) {
  return text.split('\n').flatMap(line => { const m = line.match(/^(.+?)\s+(usb:\d+,\d+)\s*$/); return m && !/^Sony\b/i.test(m[1]) ? [{ model: m[1].trim(), port: m[2] }] : []; });
}
const fields = new Set(['iso', 'aperture', 'f-number', 'shutterspeed', 'exposurecompensation', 'whitebalance']);
export function parseWidgets(text) {
  const widgets = []; let w;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('/main/')) { w = { key: line.trim(), choices: [] }; widgets.push(w); continue; }
    if (!w) continue;
    const pair = line.match(/^(Label|Readonly|Type|Current|Bottom|Top|Step):\s*(.*)$/);
    if (pair) w[pair[1].toLowerCase()] = pair[2];
    const choice = line.match(/^Choice:\s+(\d+) (.*)$/); if (choice) w.choices.push({ index: Number(choice[1]), label: choice[2] });
  }
  return widgets.filter(w => fields.has(w.key.split('/').at(-1)) && w.readonly === '0' && ['RADIO', 'MENU', 'RANGE'].includes(w.type)).map(w => ({ key: w.key, label: w.label, current: w.current,
    choices: w.choices, ...(w.type === 'RANGE' ? { min: Number(w.bottom), max: Number(w.top), step: Number(w.step) } : {}) }));
}
export class GphotoCamera {
  constructor(config, run = runGphoto, mutate = runGphotoHelper, helper = helperStatus) { this.config = config; this.run = run; this.mutate = mutate; this.helper = helper; }
  async requireHelper() { const h = await this.helper(); if (!h.available) throw new RangeError(h.reason ?? HELPER_MISSING); }
  args(...args) { return ['--port', this.config.port, '--camera', this.config.model, ...args]; }
  async identity() {
    const text = await this.run(this.args('--get-config', 'serialnumber'));
    const serial = text.match(/^Current: (.+)$/m)?.[1]?.trim();
    if (!serial || /^(0+|unknown|none|n\/a)$/i.test(serial)) throw new Error('This camera does not expose a reliable USB serial number; cannot safely bind it');
    if (this.config.serial && serial !== this.config.serial) throw new Error('USB identity changed; remove and rediscover this camera before controlling it');
    return serial;
  }
  async snapshot() {
    const serial = await this.identity();
    const text = await this.run(this.args('--list-all-config'));
    const controls = parseWidgets(text);
    const target = text.split(/(?=^\/main\/)/m).find(section => /^\/main\/[^\n]*\/capturetarget\r?\n/.test(section));
    const canCapture = /^Current: (?:Memory card|SD card|CF card|Card)\s*$/im.test(target ?? '') && /\/shutterspeed\r?\n/.test(text) && !/^Current:.*bulb/im.test(text);
    return { serial, controls, recording: null, canRecord: false, canCapture, helper: await this.helper() };
  }
  async capture() {
    await this.requireHelper();
    const before = await this.snapshot();
    if (!before.canCapture) throw new RangeError('Set capture target to the camera memory card and leave Bulb mode before capture');
    await this.mutate(this.config, 'capture');
    return this.snapshot();
  }
  async set(key, value) {
    await this.requireHelper();
    // Refresh metadata and identity immediately before a write; USB addresses can be reused.
    const snap = await this.snapshot(), w = snap.controls.find(w => w.key === key);
    if (!w) throw new RangeError('Control is unavailable in the current camera mode');

    if (w.choices.length) {
      if (!Number.isInteger(value) || !w.choices.some(c => c.index === value)) throw new RangeError('Choose a currently supported value');

    } else {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < w.min || value > w.max || !(w.step > 0) || Math.abs((value - w.min) / w.step - Math.round((value - w.min) / w.step)) > 1e-6) throw new RangeError('Value is outside the camera range');

    }
    await this.mutate(this.config, 'set', key, value, w.choices.length ? w.choices.find(c => c.index === value).label : '');
    const after = await this.snapshot(), actual = after.controls.find(c => c.key === key)?.current;
    const expected = w.choices.length ? w.choices.find(c => c.index === value).label : String(value);
    if (actual !== expected && !(typeof value === 'number' && !w.choices.length && Number(actual) === value)) throw new Error('Camera did not confirm the requested value');
    return after;
  }
}
