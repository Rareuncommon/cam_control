// One-time migration: the lighting scenes Companion keeps in custom variables.
//
// Companion's lighting pages store each scene as a custom variable, sceneN,
// holding the DMX values of channels 1–10 separated by spaces ("175 12 178 12
// …"), and sceneN_saved, when it was saved. They are read over Companion's
// HTTP API — GET /api/custom-variable/<name>/value, which answers the value as
// text, 404 if there is no such variable, and 403 if the HTTP API is switched
// off in Companion (checked against Companion v5.0.2's HttpApi.ts). Only GETs:
// nothing in Companion is changed.
//
// Each value lines up with the patch by DMX address in the universe the
// Companion connection sent on, and is decoded through the fixture's profile,
// so a scene recalled from CamBridge puts out exactly the DMX it held.

import { parseDmxString } from './looks.js';
import { decode, footprint } from './profiles.js';

export const DEFAULT_COMPANION_URL = 'http://127.0.0.1:8000';

/**
 * Reads the scenes and works out what each would become. Changes nothing.
 *
 * @param {object} o
 * @param {string} o.url            Companion's base URL
 * @param {number} o.count          scene slots to read (scene1 … sceneN)
 * @param {object[]} o.fixtures     the patch (working fixtures only)
 * @param {Map<string, object>} o.profiles
 * @param {number} [o.universe=1]   the universe Companion's sACN connection used
 * @param {Function} [o.fetch]
 * @param {number} [o.timeoutMs=3000]
 * @returns {Promise<{ok: true, scenes: object[]} | {ok: false, error: string}>}
 */
export async function readCompanionScenes({ url, count, fixtures, profiles, universe = 1, fetch: get = globalThis.fetch, timeoutMs = 3000 }) {
  let base;
  try {
    base = new URL(url);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('not http');
  } catch {
    return { ok: false, error: `"${url}" is not an http:// address` };
  }
  const read = async (name) => {
    const target = new URL(`/api/custom-variable/${encodeURIComponent(name)}/value`, base);
    let res;
    try {
      res = await get(target, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw Object.assign(new Error(`Companion is not answering at ${base.origin} (${err.cause?.code ?? err.name ?? err.message}) — is it running?`), { fatal: true });
    }
    if (res.status === 403) {
      throw Object.assign(new Error('Companion refused the request (403): its HTTP API is switched off in Companion’s settings'), { fatal: true });
    }
    if (res.status === 404) return null;
    if (!res.ok) throw Object.assign(new Error(`Companion answered ${res.status} for ${name}`), { fatal: true });
    return (await res.text()).trim();
  };

  const inUniverse = fixtures.filter((f) => f.universe === universe && profiles.has(f.profile));
  const scenes = [];
  try {
    for (let slot = 1; slot <= count; slot++) {
      const raw = await read(`scene${slot}`);
      const saved = await read(`scene${slot}_saved`);
      scenes.push(interpret(slot, raw, saved, inUniverse, profiles));
    }
  } catch (err) {
    if (err.fatal) return { ok: false, error: err.message };
    throw err;
  }
  return { ok: true, source: base.origin, universe, scenes };
}

/** One Companion scene, matched to the patch. */
export function interpret(slot, raw, saved, fixtures, profiles) {
  const out = { slot, found: raw !== null && raw !== '', raw: raw ?? null, saved: saved || null, values: null, dmx: {}, state: null, problems: [] };
  if (!out.found) {
    out.problems.push(raw === null ? `scene${slot} is not set in Companion` : `scene${slot} is empty`);
    return out;
  }
  const values = parseDmxString(raw);
  if (!values) {
    out.problems.push(`scene${slot} is not a list of DMX values 0–255: "${String(raw).slice(0, 60)}"`);
    return out;
  }
  out.values = values;
  const state = {};
  const missing = [];
  let highest = 0;
  for (const f of fixtures) {
    const profile = profiles.get(f.profile);
    const size = footprint(profile);
    highest = Math.max(highest, f.address - 1 + size);
    const slice = values.slice(f.address - 1, f.address - 1 + size);
    if (slice.length < size) { missing.push(f.name); continue; }
    state[f.id] = decode(profile, slice);
    out.dmx[f.name] = slice;
  }
  if (missing.length) out.problems.push(`no values for ${missing.join(', ')}: those lights would be left as they are`);
  if (values.length > highest) out.problems.push(`${values.length - highest} value(s) past the last patched channel are ignored`);
  if (!Object.keys(state).length) {
    out.problems.push('none of its values land on a patched light');
    return out;
  }
  out.state = state;
  return out;
}

/** A Companion "saved" value as a timestamp, if it reads as one. */
export function savedAt(text) {
  if (!text) return null;
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
