// The lighting state, and the clock that turns it into frames.
//
// One state, in physical units: each fixture's intensity in percent and colour
// temperature in kelvin. Everything that changes the lights — a fader, a
// Companion button, a scene — changes this, and frames are only ever built
// from it, through each fixture's profile. Nothing else holds a copy of "what
// the lights are doing".
//
// Fades are by time, per fixture and per parameter: a 1 s fade takes 1 s
// whatever the frame rate, and a new command for the same parameter starts
// from wherever the old fade had got to rather than jumping. A dimmer fade
// and a colour fade on the same light run independently.
//
// Output never blacks the studio out on its own:
//   - until a state is known (restored from disk, or the first command), no
//     frame is sent at all — not a frame of zeros;
//   - while idle the current state is re-sent at a low rate so receivers do
//     not time out; during a fade, frames go at a steady rate (40 Hz).

import { EventEmitter } from 'node:events';
import { encode, kelvinRange, hasCct, hasIntensity } from './profiles.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const PARAMS = ['intensity', 'cct'];

export class LightingEngine extends EventEmitter {
  /**
   * @param {object} o
   * @param {{send: Function}} o.output
   * @param {number} [o.fadeHz=40]       frame rate while anything is fading
   * @param {number} [o.idleMs=500]      re-send interval while nothing changes
   * @param {() => number} [o.now]       injectable clock
   * @param {{setTimeout: Function, clearTimeout: Function}} [o.timers]
   * @param {(level: string, msg: string) => void} [o.log]
   */
  constructor({ output, fadeHz = 40, idleMs = 500, now = Date.now, timers = globalThis, log = () => {} }) {
    super();
    this.output = output;
    this.fadeMs = Math.round(1000 / fadeHz);
    this.idleMs = idleMs;
    this.now = now;
    this.timers = timers;
    this.log = log;
    this.fixtures = [];
    this.profiles = new Map();
    /** id -> { intensity, cct }: where each fixture is now (mid-fade values included). */
    this.current = new Map();
    /** `${id}:${param}` -> { from, to, start, duration } */
    this.fades = new Map();
    /** id -> end time of an Identify flash */
    this.identifying = new Map();
    /** False until a state is restored or set: nothing is sent before that. */
    this.known = false;
    this.timer = null;
    this.running = false;
  }

  /**
   * Takes a new patch. Fixtures that stay keep their state; new ones start at
   * 0 % at the warm end of their range; removed ones are forgotten.
   */
  configure(fixtures, profiles) {
    this.fixtures = fixtures.filter((f) => profiles.has(f.profile));
    this.profiles = profiles;
    const ids = new Set(this.fixtures.map((f) => f.id));
    for (const id of [...this.current.keys()]) if (!ids.has(id)) this.current.delete(id);
    for (const key of [...this.fades.keys()]) if (!ids.has(key.split(':')[0])) this.fades.delete(key);
    for (const f of this.fixtures) {
      if (!this.current.has(f.id)) this.current.set(f.id, this.#defaultState(f));
      else this.current.set(f.id, this.#clampToFixture(f, this.current.get(f.id)));
    }
    this.#poke();
  }

  /**
   * Puts the lights in a known state without a fade — the state restored at
   * start-up. From here on frames are sent.
   *
   * @param {Record<string, {intensity?: number, cct?: number}>} state
   */
  restore(state) {
    for (const f of this.fixtures) {
      const s = state?.[f.id];
      if (s) this.current.set(f.id, this.#clampToFixture(f, { ...this.current.get(f.id), ...s }));
    }
    this.fades.clear();
    this.known = true;
    this.#poke();
  }

  /**
   * Sets intensity and/or CCT on some fixtures.
   *
   * @param {object[]} targets   fixtures from resolveTarget()
   * @param {{intensity?: number, cct?: number}} values  percent, kelvin
   * @param {{relative?: boolean, fadeMs?: number}} [o]
   *   relative: add to where each fixture is heading, so repeated nudges add up
   *   even while the last one is still fading
   */
  set(targets, values, { relative = false, fadeMs = 0 } = {}) {
    const now = this.now();
    for (const f of targets) {
      const cur = this.current.get(f.id);
      if (!cur) continue;
      const dest = {};
      for (const p of PARAMS) {
        if (!Number.isFinite(values[p])) continue;
        if (p === 'cct' && !hasCct(this.profiles.get(f.profile))) continue;
        if (p === 'intensity' && !hasIntensity(this.profiles.get(f.profile))) continue;
        dest[p] = relative ? this.#heading(f.id, p) + values[p] : values[p];
      }
      this.#fadeTo(f, this.#clampToFixture(f, dest), fadeMs, now);
    }
    this.known = true;
    this.emit('change');
    this.#poke();
  }

  /**
   * Fades every fixture named in `state` to it — a scene or a look.
   *
   * @param {Record<string, {intensity?: number, cct?: number}>} state
   */
  apply(state, { fadeMs = 0 } = {}) {
    const now = this.now();
    for (const f of this.fixtures) {
      const s = state?.[f.id];
      if (s) this.#fadeTo(f, this.#clampToFixture(f, s), fadeMs, now);
    }
    this.known = true;
    this.emit('change');
    this.#poke();
  }

  /** Flashes one fixture for `ms`, then shows its state again. The state itself is never touched. */
  identify(id, ms = 3000) {
    if (!this.fixtures.some((f) => f.id === id)) return false;
    this.identifying.set(id, this.now() + ms);
    this.#poke();
    return true;
  }

  /** Where every fixture is right now, mid-fade values included. */
  snapshot() {
    this.#advance(this.now());
    return Object.fromEntries([...this.current].map(([id, s]) => [id, { ...s }]));
  }

  /** Where every fixture is heading: the state worth saving. */
  targets() {
    const out = {};
    for (const [id, s] of this.current) {
      out[id] = { ...s };
      for (const p of PARAMS) {
        const fade = this.fades.get(`${id}:${p}`);
        if (fade) out[id][p] = fade.to;
      }
    }
    return out;
  }

  get fading() { return this.fades.size > 0; }

  /** Each universe's 512 slots, as the next frame would carry them. */
  frames() {
    const now = this.now();
    const universes = new Map();
    for (const f of this.fixtures) {
      const profile = this.profiles.get(f.profile);
      let state = this.current.get(f.id);
      const until = this.identifying.get(f.id);
      if (until !== undefined) {
        // Full, then off, twice a second: unmistakable on a panel among five.
        const on = Math.floor((until - now) / 250) % 2 === 0;
        state = { ...state, intensity: on ? 100 : 0 };
      }
      if (!universes.has(f.universe)) universes.set(f.universe, { slots: new Uint8Array(512), to: new Set() });
      const u = universes.get(f.universe);
      encode(profile, state).forEach((v, i) => { u.slots[f.address - 1 + i] = v; });
      u.to.add(f.ip);
    }
    return universes;
  }

  start() {
    this.running = true;
    this.#poke();
  }

  stop() {
    this.running = false;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Sends a frame now and reschedules. Safe to call at any time. */
  tick() {
    // Called by the timer, or directly: either way there is one timer chain.
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (!this.running) return;
    const now = this.now();
    this.#advance(now);
    for (const [id, until] of [...this.identifying]) if (now >= until) this.identifying.delete(id);
    if (this.known) {
      try {
        for (const [universe, u] of this.frames()) this.output.send(universe, u.slots, [...u.to]);
      } catch (err) {
        // Output must never take the engine down; the output reports its own state.
        this.log('error', `lighting frame: ${err.message}`);
      }
    }
    const busy = this.fades.size > 0 || this.identifying.size > 0;
    this.timer = this.timers.setTimeout(() => this.tick(), busy ? this.fadeMs : this.idleMs);
    this.timer?.unref?.();
  }

  #poke() {
    if (!this.running) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.tick();
  }

  #advance(now) {
    let finished = false;
    for (const [key, fade] of [...this.fades]) {
      const [id, p] = key.split(':');
      const cur = this.current.get(id);
      if (!cur) { this.fades.delete(key); continue; }
      const t = fade.duration <= 0 ? 1 : Math.min(1, (now - fade.start) / fade.duration);
      cur[p] = fade.from + (fade.to - fade.from) * t;
      if (t >= 1) { this.fades.delete(key); finished = true; }
    }
    if (finished && this.fades.size === 0) this.emit('settled');
  }

  #heading(id, p) {
    return this.fades.get(`${id}:${p}`)?.to ?? this.current.get(id)?.[p] ?? 0;
  }

  #fadeTo(f, dest, fadeMs, now) {
    this.#advance(now);
    const cur = this.current.get(f.id);
    for (const p of PARAMS) {
      if (dest[p] === undefined) continue;
      const key = `${f.id}:${p}`;
      if (fadeMs > 0 && cur[p] !== dest[p]) {
        this.fades.set(key, { from: cur[p], to: dest[p], start: now, duration: fadeMs });
      } else {
        this.fades.delete(key);
        cur[p] = dest[p];
      }
    }
  }

  #defaultState(f) {
    const range = kelvinRange(this.profiles.get(f.profile));
    return { intensity: 0, ...(range ? { cct: range.min } : {}) };
  }

  #clampToFixture(f, s) {
    const out = {};
    if (Number.isFinite(s.intensity)) out.intensity = clamp(s.intensity, 0, 100);
    const range = kelvinRange(this.profiles.get(f.profile));
    if (range && Number.isFinite(s.cct)) out.cct = clamp(s.cct, range.min, range.max);
    return out;
  }
}
