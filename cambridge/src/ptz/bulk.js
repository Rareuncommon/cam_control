// Adding many PTZ heads at once.
//
// One camera at a time is fine for four. For a venue with thirty, the operator
// has a list — or a range — of addresses and one set of credentials the
// integrator set on all of them. This takes that list, finds out what answers
// at each address (the same read-only probe as single add-by-IP), and adds
// every camera it recognises.
//
// Credentials go only to addresses the operator typed, never to a whole
// subnet scanned on spec: Basic auth sends the password itself, and a scan
// would send it to every host that happened to challenge.

import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { detect } from './detect.js';
import { isHostAddress } from '../adopt.js';

/** A list longer than this is almost certainly a typo in a range. */
export const MAX_ADDRESSES = 256;

const ipToInt = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const intToIp = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');

/**
 * Expands what an operator types into a list of addresses.
 *
 * Accepts, separated by commas, spaces or new lines:
 *   192.0.2.10                  one address
 *   192.0.2.10-29               a range in the last octet
 *   192.0.2.10-192.0.2.29       a range written out in full
 *   192.0.2.0/27                a block (/24 or smaller); network and broadcast left out
 *   cam-wide.local              a host name
 *
 * @returns {{addresses: string[], errors: string[]}}
 */
export function parseAddresses(text) {
  const addresses = [];
  const errors = [];
  const seen = new Set();
  const push = (a) => { if (!seen.has(a)) { seen.add(a); addresses.push(a); } };
  for (const token of String(text ?? '').split(/[\s,;]+/).filter(Boolean)) {
    let m;
    if ((m = /^(\d+\.\d+\.\d+\.)(\d+)-(\d+)$/.exec(token))) {
      const [, prefix, a, b] = m;
      if (!isIP(`${prefix}${a}`) || !isIP(`${prefix}${b}`) || Number(a) > Number(b)) { errors.push(`"${token}" is not a range`); continue; }
      for (let i = Number(a); i <= Number(b); i++) push(`${prefix}${i}`);
    } else if ((m = /^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+)$/.exec(token))) {
      const [, a, b] = m;
      if (!isIP(a) || !isIP(b) || ipToInt(a) > ipToInt(b)) { errors.push(`"${token}" is not a range`); continue; }
      if (ipToInt(b) - ipToInt(a) >= MAX_ADDRESSES) { errors.push(`"${token}" is more than ${MAX_ADDRESSES} addresses`); continue; }
      for (let n = ipToInt(a); n <= ipToInt(b); n++) push(intToIp(n));
    } else if ((m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(token))) {
      const [, base, bits] = m;
      const prefix = Number(bits);
      if (!isIP(base) || prefix < 24 || prefix > 32) { errors.push(`"${token}": use a /24 or smaller block`); continue; }
      const size = 2 ** (32 - prefix);
      const start = Math.floor(ipToInt(base) / size) * size;
      // A /31 or /32 has no network or broadcast address to leave out.
      const [from, to] = size <= 2 ? [start, start + size - 1] : [start + 1, start + size - 2];
      for (let n = from; n <= to; n++) push(intToIp(n));
    } else if (isHostAddress(token)) {
      push(token);
    } else {
      errors.push(`"${token}" is not an address, range or host name`);
    }
    if (addresses.length > MAX_ADDRESSES) {
      errors.push(`that is more than ${MAX_ADDRESSES} addresses — add them in smaller groups`);
      return { addresses: [], errors };
    }
  }
  return { addresses, errors };
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/**
 * Bulk add jobs. A job runs in the background and is polled: probing a /24
 * where most addresses are empty takes a while, and an HTTP request that
 * waits a minute for its answer is one a browser gives up on.
 */
export class BulkAdd {
  /**
   * @param {object} o
   * @param {() => object[]} o.adopted               configured camera entries
   * @param {(input: object) => Promise<object>} o.add  adoption.addPtz
   * @param {Function} [o.detectFn]                   injected for tests
   * @param {(level: string, msg: string) => void} [o.log]
   */
  constructor({ adopted, add, detectFn = detect, log = () => {}, concurrency = 16, probeTimeoutMs = 1500 }) {
    this.adopted = adopted;
    this.add = add;
    this.detect = detectFn;
    this.log = log;
    this.concurrency = concurrency;
    this.probeTimeoutMs = probeTimeoutMs;
    /** @type {Map<string, object>} */
    this.jobs = new Map();
  }

  /**
   * @param {{addresses: string, username?: string, password?: string, vendor?: string,
   *          group?: string, dryRun?: boolean}} input
   * @returns {{ok: boolean, jobId?: string, total?: number, error?: string, errors?: string[]}}
   */
  start(input) {
    const { addresses, errors } = parseAddresses(input.addresses);
    if (errors.length) return { ok: false, error: errors[0], errors };
    if (!addresses.length) return { ok: false, error: 'no addresses given' };
    // Old jobs go; a handful is plenty to keep for the page that started them.
    for (const [id, j] of this.jobs) if (j.state === 'done' && Date.now() - j.finishedAt > 3_600_000) this.jobs.delete(id);
    if ([...this.jobs.values()].some((j) => j.state === 'running')) {
      return { ok: false, error: 'a bulk add is already running — wait for it to finish' };
    }
    const id = randomBytes(6).toString('hex');
    const job = {
      id, state: 'running', total: addresses.length, done: 0,
      dryRun: !!input.dryRun, startedAt: Date.now(), finishedAt: null,
      results: addresses.map((address) => ({ address, status: 'waiting' })),
    };
    this.jobs.set(id, job);
    this.#run(job, addresses, {
      username: input.username ?? '', password: input.password ?? '',
      vendor: input.vendor || undefined, group: input.group,
    }).catch((err) => this.log('error', `bulk add failed: ${err.message}`));
    return { ok: true, jobId: id, total: addresses.length };
  }

  /** What the page polls. Never includes credentials. */
  status(id) {
    const j = this.jobs.get(id);
    if (!j) return null;
    const { results, ...rest } = j;
    return { ...rest, results };
  }

  async #run(job, addresses, creds) {
    const known = new Map(this.adopted().filter((c) => c.kind === 'ptz').map((c) => [c.ip, c]));
    const labels = new Set(this.adopted().map((c) => c.label));
    // Detection in parallel; adding one at a time, so the config file is
    // written by one hand and the labels chosen against what is already there.
    const found = [];
    await pool(addresses, this.concurrency, async (address, i) => {
      const r = job.results[i];
      const existing = known.get(address);
      if (existing) {
        Object.assign(r, { status: 'skipped', detail: `already added as "${existing.label}"` });
      } else {
        r.status = 'probing';
        const d = await this.detect({ host: address, ...creds }, { timeoutMs: this.probeTimeoutMs, scan: true });
        if (d.ok) {
          Object.assign(r, { status: 'found', vendor: d.vendor, model: d.identity.model, name: d.identity.name ?? null });
          found.push({ i, d });
        } else {
          // Most of a range is empty; "nothing there" is the common answer.
          const authRefused = /refused the username or password/.test(d.error);
          Object.assign(r, { status: authRefused ? 'refused' : 'nothing', detail: authRefused ? d.error : null });
        }
      }
      job.done += 1;
    });

    if (!job.dryRun) {
      found.sort((a, b) => a.i - b.i);
      for (const { i, d } of found) {
        const r = job.results[i];
        const tail = /^\d+\.\d+\.\d+\.(\d+)$/.exec(r.address)?.[1] ?? r.address;
        let label = (d.identity.name && String(d.identity.name).trim()) || `${d.identity.model} ${tail}`;
        if (labels.has(label)) label = `${label} (${tail})`;
        labels.add(label);
        const a = await this.add({
          ip: r.address, vendor: d.vendor, model: d.identity.model, label,
          username: creds.username, password: creds.password, group: creds.group,
        });
        if (a.ok) Object.assign(r, { status: 'added', added: { id: a.camera.id, label: a.camera.label } });
        else Object.assign(r, { status: 'failed', detail: a.error });
      }
    }
    job.state = 'done';
    job.finishedAt = Date.now();
    const n = job.results.filter((r) => r.status === 'added').length;
    this.log('info', `bulk add: ${job.total} address(es), ${found.length} camera(s) found, ${n} added`);
  }
}
