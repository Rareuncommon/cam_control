// The protected looks, and scenes.
//
// The Studio look is the studio's on-air state, verified by eye on the five
// Lyras and written down in DMX: 175 12 178 12 20 12 30 12 6 12. It is kept in
// DMX, not percent and kelvin, so it means exactly the same output even after
// the CCT curve is measured and changed. Off is the matching all-off look.
// Both are read-only: no scene operation can overwrite them, and they are not
// scene slots at all.

import { encode, decode } from './profiles.js';

export const LOOKS = Object.freeze({
  studio: Object.freeze({
    id: 'studio',
    name: 'Studio look',
    dmx: Object.freeze({ l1: [175, 12], l2: [178, 12], l3: [20, 12], l4: [30, 12], l5: [6, 12] }),
  }),
  off: Object.freeze({
    id: 'off',
    name: 'Studio off',
    dmx: Object.freeze({ l1: [0, 12], l2: [0, 12], l3: [0, 12], l4: [0, 12], l5: [0, 12] }),
  }),
});

/** A look as state, through each fixture's profile. Fixtures not in the patch are left out. */
export function lookState(look, fixtures, profiles) {
  const out = {};
  for (const f of fixtures) {
    const dmx = look.dmx[f.id];
    const profile = profiles.get(f.profile);
    if (dmx && profile) out[f.id] = decode(profile, dmx);
  }
  return out;
}

/**
 * Whether the lights are in a scene or look: every fixture it names would put
 * out the same DMX as it does now. Compared in DMX so that a scene recalled
 * from percent and kelvin matches despite rounding.
 */
export function matches(state, current, fixtures, profiles) {
  const ids = Object.keys(state ?? {});
  if (!ids.length) return false;
  for (const id of ids) {
    const f = fixtures.find((x) => x.id === id);
    const profile = f && profiles.get(f.profile);
    if (!profile || !current[id]) return false;
    const a = encode(profile, state[id]);
    const b = encode(profile, current[id]);
    if (a.some((v, i) => v !== b[i])) return false;
  }
  return true;
}

/** A scene slot as the API shows it. */
export function sceneView(slot, scene) {
  return scene
    ? { slot, name: scene.name, savedAt: scene.savedAt ?? null, note: scene.note ?? null, empty: false }
    : { slot, name: `Scene ${slot}`, savedAt: null, note: null, empty: true };
}

/** Parses "175 12 178 12 …" (Companion's scene format) into numbers, or null. */
export function parseDmxString(text) {
  const parts = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const values = parts.map(Number);
  if (!values.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return null;
  return values;
}
