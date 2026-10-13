// Add-by-IP: which camera is at this address?
//
// Asks each driver's probe in turn. Probes only read — none of them moves the
// head or changes a setting — so pointing this at the wrong address is
// harmless. The first driver that recognises the camera wins.

import { DRIVERS } from './drivers/index.js';
import { request } from './http.js';

/**
 * @param {{host: string, port?: number, username?: string, password?: string, vendor?: string}} input
 * @param {{timeoutMs?: number, log?: Function, drivers?: Map}} [o]
 * @returns {Promise<{ok: true, vendor: string, label: string, identity: object} | {ok: false, error: string, tried: object[]}>}
 */
export async function detect(input, { timeoutMs = 2500, log = () => {}, drivers = DRIVERS, scan = false } = {}) {
  const host = String(input.host ?? '').trim();
  if (!host) return { ok: false, error: 'an IP address is required', tried: [] };
  const auth = { username: input.username ?? '', password: input.password ?? '' };
  const candidates = input.vendor
    ? [drivers.get(input.vendor)].filter(Boolean)
    : [...drivers.values()];

  const tried = [];
  let authRefused = false;
  for (const D of candidates) {
    try {
      // In a scan, Basic is never sent: it would hand the password to every
      // device in the range that asks for it.
      const http = scan ? (o) => request({ ...o, noBasic: true }) : request;
      const identity = await D.probe({ host, port: input.port, auth, http, timeoutMs, log });
      if (identity) return { ok: true, vendor: D.vendor, label: D.label, identity };
      tried.push({ vendor: D.vendor, result: 'not this vendor' });
    } catch (err) {
      if (err?.kind === 'auth') authRefused = true;
      tried.push({ vendor: D.vendor, result: err?.message ?? String(err) });
    }
  }
  return {
    ok: false,
    error: authRefused
      ? 'A camera answered but refused the username or password.'
      : 'No supported camera answered at that address. Check the IP, and that the camera is powered and on this network.',
    tried,
  };
}
