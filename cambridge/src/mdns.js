// Bonjour advertisement, so the phone app finds CamBridge on the studio
// network without anyone typing an address.
//
// It uses the operating system's own responder rather than an npm package:
// on macOS `dns-sd -R` registers the service with mDNSResponder for as long
// as it runs; on Linux `avahi-publish-service` does the same if Avahi is
// installed. If neither is there, CamBridge says so once and carries on —
// the app can always be pointed at an address by hand.
//
// The service is `_cambridge._tcp` on the HTTP port, with TXT records the app
// uses to tell CamBridges apart: `api` (the API version) and `id` (the server
// id the pairing QR also carries).

import { spawn as nodeSpawn } from 'node:child_process';

export const SERVICE_TYPE = '_cambridge._tcp';

/** The command that advertises the service on this platform, or null. */
export function advertiseCommand(platform, { name, port, txt }) {
  const pairs = Object.entries(txt).map(([k, v]) => `${k}=${v}`);
  if (platform === 'darwin') return ['/usr/bin/dns-sd', ['-R', name, SERVICE_TYPE, 'local', String(port), ...pairs]];
  if (platform === 'linux') return ['avahi-publish-service', [name, SERVICE_TYPE, String(port), ...pairs]];
  return null;
}

export class MdnsAdvertiser {
  /**
   * @param {object} o
   * @param {string} o.name
   * @param {number} o.port
   * @param {Record<string, string>} o.txt
   * @param {Function} [o.spawn]
   * @param {string} [o.platform]
   * @param {(level: string, msg: string) => void} [o.log]
   * @param {number} [o.retryMs]  first retry delay; doubles to a minute
   */
  constructor({ name, port, txt = {}, spawn = nodeSpawn, platform = process.platform, log = () => {}, retryMs = 5000 }) {
    this.cmd = advertiseCommand(platform, { name, port, txt });
    this.spawn = spawn;
    this.log = log;
    this.retryMs = retryMs;
    this.delay = retryMs;
    this.child = null;
    this.timer = null;
    this.stopped = true;
    this.name = name;
    this.port = port;
  }

  start() {
    if (!this.cmd) {
      this.log('info', `mDNS: not available on ${process.platform}; the app can connect by address`);
      return;
    }
    this.stopped = false;
    this.#run();
  }

  #run() {
    if (this.stopped) return;
    const [bin, args] = this.cmd;
    let child;
    try {
      child = this.spawn(bin, args, { stdio: 'ignore' });
    } catch (err) {
      this.#failed(err);
      return;
    }
    this.child = child;
    const startedAt = Date.now();
    child.on('error', (err) => {
      // ENOENT: the tool is not installed. Nothing to retry.
      if (err.code === 'ENOENT') {
        this.log('info', `mDNS: ${bin} is not installed; the app can connect by address`);
        this.stopped = true;
        return;
      }
      this.#failed(err);
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      // A registration that ran a while was working: start backing off again from the bottom.
      if (Date.now() - startedAt > 60_000) this.delay = this.retryMs;
      this.log('warn', `mDNS: ${bin} stopped (${signal ?? `exit ${code}`}); retrying in ${Math.round(this.delay / 1000)} s`);
      this.#retry();
    });
    this.log('info', `mDNS: advertising "${this.name}" as ${SERVICE_TYPE} on port ${this.port}`);
  }

  #failed(err) {
    this.log('warn', `mDNS: ${err.message}; retrying in ${Math.round(this.delay / 1000)} s`);
    this.#retry();
  }

  #retry() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.#run(); }, this.delay);
    this.timer.unref?.();
    this.delay = Math.min(this.delay * 2, 60_000);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.child) { try { this.child.kill(); } catch { /* gone */ } }
    this.child = null;
  }
}
