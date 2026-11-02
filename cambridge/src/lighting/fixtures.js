// The patch: which fixture is where, and with which profile.
//
// Kept apart from profiles on purpose. A profile says what a kind of light's
// channels mean; the patch says that "L3" is one of those, at 192.168.220.53,
// universe 1, address 5. Five identical panels are one profile and five
// patch entries.
//
// Validation reports problems and never repairs them. Two fixtures on the
// same addresses, or one running off the end of a universe, would put one
// light's values on another — an error someone must see, in the API and in
// the Lighting tab, rather than something quietly nudged into place.

import { isIPv4 } from 'node:net';
import { footprint, validateProfile } from './profiles.js';
import { MIN_UNIVERSE, MAX_UNIVERSE } from './sacn.js';

/** The studio's five Lyras, as verified on the lighting network in October 2026. */
export const SEED_FIXTURES = Object.freeze([1, 2, 3, 4, 5].map((n) => Object.freeze({
  id: `l${n}`,
  name: `L${n}`,
  profile: 'ikan-lyra-lbx8-poe-2ch',
  ip: `192.168.220.${50 + n}`,
  universe: 1,
  address: 2 * n - 1,
  groups: Object.freeze([]),
})));

/** Every fixture is in "All"; it is not a group anyone has to add. */
export const ALL_GROUP = 'All';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Checks the whole patch against the profiles it uses.
 *
 * @param {object[]} fixtures
 * @param {Map<string, object>} profiles  id -> profile
 * @returns {Array<{fixture: string|null, field: string, message: string}>}
 */
export function validatePatch(fixtures, profiles) {
  const errors = [];
  const add = (fixture, field, message) => errors.push({ fixture, field, message });
  if (!Array.isArray(fixtures)) return [{ fixture: null, field: 'fixtures', message: 'the patch must be a list' }];

  const ids = new Map();
  const names = new Map();
  const spans = [];   // { universe, from, to, id, name }
  for (const f of fixtures) {
    const id = typeof f?.id === 'string' ? f.id : null;
    const who = id ?? '(no id)';
    if (!id || !ID_RE.test(id)) add(id, 'id', `${who}: an id is 1–32 lower-case letters, digits, "-" or "_"`);
    else if (ids.has(id)) add(id, 'id', `id "${id}" is used twice`);
    else ids.set(id, f);

    const name = typeof f?.name === 'string' ? f.name.trim() : '';
    if (!name) add(id, 'name', `${who}: a name is required`);
    else if (name.length > 40) add(id, 'name', `${who}: a name is at most 40 characters`);
    else {
      const key = name.toLowerCase();
      if (names.has(key)) add(id, 'name', `the name "${name}" is already ${names.get(key)}`);
      else names.set(key, who);
    }

    const profile = profiles.get(f?.profile);
    if (!profile) add(id, 'profile', `${who}: no profile "${f?.profile}"`);

    if (typeof f?.ip !== 'string' || !isIPv4(f.ip)) add(id, 'ip', `${who}: "${f?.ip ?? ''}" is not an IPv4 address`);
    else if (isUnusableUnicast(f.ip)) add(id, 'ip', `${who}: ${f.ip} is not a single device's address`);

    if (!Number.isInteger(f?.universe) || f.universe < MIN_UNIVERSE || f.universe > MAX_UNIVERSE) {
      add(id, 'universe', `${who}: universe must be a whole number ${MIN_UNIVERSE}–${MAX_UNIVERSE}`);
    }
    if (!Number.isInteger(f?.address) || f.address < 1 || f.address > 512) {
      add(id, 'address', `${who}: start address must be a whole number 1–512`);
    } else if (profile) {
      const to = f.address + footprint(profile) - 1;
      if (to > 512) add(id, 'address', `${who}: ${footprint(profile)} channels from ${f.address} run past 512 (to ${to})`);
      else if (Number.isInteger(f.universe)) spans.push({ universe: f.universe, from: f.address, to, id: who, name: name || who });
    }

    if (f?.groups !== undefined) {
      if (!Array.isArray(f.groups)) add(id, 'groups', `${who}: groups must be a list`);
      else {
        for (const g of f.groups) {
          if (typeof g !== 'string' || !g.trim() || g.trim().length > 40) add(id, 'groups', `${who}: a group name is 1–40 characters`);
          else if (g.trim().toLowerCase() === ALL_GROUP.toLowerCase()) add(id, 'groups', `${who}: every fixture is already in "${ALL_GROUP}"`);
        }
      }
    }
  }

  // Overlaps, per universe, reported once per pair and against both fixtures.
  spans.sort((a, b) => a.universe - b.universe || a.from - b.from);
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length && spans[j].universe === spans[i].universe && spans[j].from <= spans[i].to; j++) {
      const a = spans[i];
      const b = spans[j];
      const msg = `${a.name} (${a.from}–${a.to}) and ${b.name} (${b.from}–${b.to}) overlap in universe ${a.universe}`;
      add(a.id, 'address', msg);
      add(b.id, 'address', msg);
    }
  }
  return errors;
}

function isUnusableUnicast(ip) {
  const [a, , , d] = ip.split('.').map(Number);
  return a === 0 || a === 127 || a >= 224 || d === 255;
}

/** Profiles by id: built-ins first; a custom profile may not reuse a built-in id. */
export function profileMap(builtIns, custom = []) {
  const map = new Map(builtIns.map((p) => [p.id, p]));
  for (const p of custom) if (!map.has(p.id)) map.set(p.id, { ...p, builtIn: false });
  return map;
}

/** Problems with the custom profiles, as patch-style errors. */
export function validateCustomProfiles(custom, builtIns) {
  const errors = [];
  const seen = new Set(builtIns.map((p) => p.id));
  for (const p of custom ?? []) {
    const who = typeof p?.id === 'string' ? p.id : '(no id)';
    if (seen.has(p?.id)) {
      errors.push({ profile: who, field: 'id', message: `profile id "${who}" is already ${builtIns.some((b) => b.id === p.id) ? 'a built-in profile' : 'used'}` });
      continue;
    }
    seen.add(p?.id);
    for (const message of validateProfile(p)) errors.push({ profile: who, field: 'profile', message: `${who}: ${message}` });
  }
  return errors;
}

/** Every group name in the patch, "All" first, in first-seen order. */
export function groupNames(fixtures) {
  const seen = new Map([[ALL_GROUP.toLowerCase(), ALL_GROUP]]);
  for (const f of fixtures) for (const g of f.groups ?? []) {
    const key = g.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, g.trim());
  }
  return [...seen.values()];
}

/**
 * The fixtures a command is aimed at.
 *
 * @param {object[]} fixtures
 * @param {{all?: true, group?: string, fixture?: string}} target
 * @returns {object[]|null} null when the target names nothing that exists
 */
export function resolveTarget(fixtures, target = {}) {
  if (target.fixture !== undefined) {
    const f = fixtures.find((x) => x.id === target.fixture || x.name.toLowerCase() === String(target.fixture).toLowerCase());
    return f ? [f] : null;
  }
  if (target.group !== undefined && String(target.group).toLowerCase() !== ALL_GROUP.toLowerCase()) {
    const key = String(target.group).trim().toLowerCase();
    const list = fixtures.filter((f) => (f.groups ?? []).some((g) => g.trim().toLowerCase() === key));
    return list.length ? list : null;
  }
  return fixtures;
}
