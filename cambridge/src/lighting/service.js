// Lighting, as the rest of CamBridge sees it: one object with commands that
// answer { ok, status, body }, like the camera side's, and a 'view' event when
// anything worth showing changes.
//
// Where things live:
//   cambridge.json  "lighting": { output, fixtures, profiles, sceneCount }
//                   — settings someone chose: the patch, custom profiles, the
//                   network. Written through the same atomic config writer as
//                   cameras. Absent, the studio's five Lyras are the patch and
//                   output is off.
//   cambridge-lighting.json, beside it — what changes while working: the
//                   current state, the scenes, and the sACN CID (made once).
//                   Written atomically (temp file + rename).

import { EventEmitter } from 'node:events';
import { isIPv4 } from 'node:net';

import { JsonStore } from '../store.js';
import { builtInProfiles, footprint, kelvinRange, encode, validateProfile } from './profiles.js';
import {
  SEED_FIXTURES, validatePatch, profileMap, validateCustomProfiles, groupNames, resolveTarget, ALL_GROUP,
} from './fixtures.js';
import { LightingEngine } from './engine.js';
import { SacnOutput } from './output.js';
import { LOOKS, lookState, matches, sceneView } from './looks.js';
import { newCid, cidBytes, MAX_PRIORITY } from './sacn.js';

const MAX_FADE_MS = 60_000;
const OUTPUT_DEFAULTS = Object.freeze({
  enabled: false, dryRun: false, interface: 'en14', address: '192.168.220.66', mode: 'unicast', priority: 100, sourceName: 'CamBridge',
});
const DEFAULT_SCENE_COUNT = 5;
const ok = (body = { ok: true }) => ({ ok: true, status: 200, body });
const fail = (status, error, extra = {}) => ({ ok: false, status, body: { ok: false, error, ...extra } });

export class Lighting extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => object} o.readConfig    the whole cambridge.json
   * @param {(cfg: object) => void} o.writeConfig  atomic
   * @param {string} o.storePath           cambridge-lighting.json
   * @param {(level: string, msg: string) => void} [o.log]
   * @param {object} [o.outputOptions]     passed to SacnOutput (tests inject a fake network)
   * @param {object} [o.engineOptions]     passed to LightingEngine (tests inject a clock)
   */
  constructor({ readConfig, writeConfig, storePath, log = () => {}, outputOptions = {}, engineOptions = {} }) {
    super();
    this.readConfig = readConfig;
    this.writeConfig = writeConfig;
    this.log = log;
    this.store = new JsonStore(storePath, { cid: null, state: null, scenes: {} }, log);
    if (!this.store.data.cid) {
      // The CID identifies this sender to every receiver; made once and kept.
      this.store.data.cid = newCid();
      this.store.save();
    }
    this.builtIns = builtInProfiles();
    this.#loadSettings();
    this.output = new SacnOutput({ settings: this.#outputSettings(), log: (l, m) => this.log(l, m), ...outputOptions });
    this.engine = new LightingEngine({ output: this.output, log: (l, m) => this.log(l, m), ...engineOptions });
    this.engine.configure(this.fixtures, this.profiles);
    this.restored = this.#restorable(this.store.data.state);
    if (this.restored) {
      // Back where it was. Never a frame of zeros: with nothing saved yet, the
      // engine sends nothing until the first command.
      this.engine.restore(this.store.data.state);
    }
    this.engine.on('change', () => this.#stateChanged());
    this.engine.on('settled', () => this.#emitView());
    this.output.on('status', () => this.#emitView());
    this.saveTimer = null;
    this.viewTimer = null;
    this.viewPending = false;
  }

  start() {
    this.output.open();
    this.engine.start();
    const s = this.output.status();
    this.log('info', `lighting: ${this.fixtures.length} fixture(s), output ${s.state}`
      + `${this.restored ? ', state restored' : ', no saved state yet — waiting for the first command'}`);
  }

  stop() {
    clearTimeout(this.saveTimer);
    clearInterval(this.viewTimer);
    this.#saveState();
    this.engine.stop();
    this.output.close();
  }

  // --- reading -----------------------------------------------------------------

  /**
   * Everything the Lighting tab and Companion show. `full` adds profile
   * definitions, which change rarely and are left out of the live stream.
   */
  view({ full = false } = {}) {
    const now = this.engine.snapshot();
    const heading = this.engine.targets();
    const out = this.output.status();
    return {
      output: { ...out, waitingForState: out.enabled && !this.engine.known },
      known: this.engine.known,
      fading: this.engine.fading,
      fixtures: this.patch.map((f) => {
        const profile = this.profiles.get(f.profile);
        const live = this.fixtures.includes(f);
        return {
          id: f.id, name: f.name, profile: f.profile, ip: f.ip, universe: f.universe, address: f.address,
          groups: f.groups ?? [],
          footprint: profile ? footprint(profile) : null,
          kelvin: profile ? kelvinRange(profile) : null,
          live,
          intensity: live ? now[f.id]?.intensity ?? null : null,
          cct: live ? now[f.id]?.cct ?? null : null,
          target: live ? heading[f.id] ?? null : null,
          dmx: live && profile && now[f.id] ? encode(profile, now[f.id]) : null,
          errors: this.patchErrors.filter((e) => e.fixture === f.id).map((e) => e.message),
        };
      }),
      groups: groupNames(this.patch),
      scenes: this.#sceneSlots().map((n) => sceneView(n, this.store.data.scenes[n])),
      looks: Object.values(LOOKS).map((l) => ({ id: l.id, name: l.name, protected: true })),
      active: this.#active(heading),
      errors: [...this.configErrors, ...this.patchErrors.filter((e) => !e.fixture), ...this.profileErrors],
      profiles: full
        ? [...this.profiles.values()].map((p) => ({ ...p, footprint: footprint(p), kelvin: kelvinRange(p) }))
        : [...this.profiles.values()].map((p) => ({ id: p.id, name: p.name, builtIn: !!p.builtIn })),
    };
  }

  // --- commands ------------------------------------------------------------------

  /**
   * @param {{target?: {all?: true, group?: string, fixture?: string}, intensity?: number,
   *          cct?: number, relative?: boolean, fadeMs?: number}} body
   */
  set(body = {}) {
    const t = body.target ?? {};
    // No target is a mistake, not "everything": all lights is asked for by name.
    if (t.all !== true && t.group === undefined && t.fixture === undefined) {
      return fail(400, 'give a target: {"all": true}, {"group": "…"} or {"fixture": "…"}');
    }
    const targets = resolveTarget(this.fixtures, t);
    if (!targets) return fail(404, `no fixture or group "${body.target?.fixture ?? body.target?.group}"`);
    const values = {};
    for (const p of ['intensity', 'cct']) {
      if (body[p] === undefined || body[p] === null) continue;
      if (!Number.isFinite(Number(body[p]))) return fail(400, `${p} must be a number`);
      values[p] = Number(body[p]);
    }
    if (!Object.keys(values).length) return fail(400, 'give intensity (%) and/or cct (K)');
    const fadeMs = fade(body.fadeMs);
    if (fadeMs === null) return fail(400, `fadeMs must be 0–${MAX_FADE_MS}`);
    this.engine.set(targets, values, { relative: !!body.relative, fadeMs });
    return ok({ ok: true, fixtures: targets.map((f) => f.id) });
  }

  recallScene(slot, { fadeMs } = {}) {
    const n = this.#slot(slot);
    if (!n) return fail(404, `no scene ${slot}`);
    const scene = this.store.data.scenes[n];
    if (!scene) return fail(409, `scene ${n} is empty`);
    const ms = fade(fadeMs);
    if (ms === null) return fail(400, `fadeMs must be 0–${MAX_FADE_MS}`);
    this.engine.apply(scene.state, { fadeMs: ms });
    return ok({ ok: true, scene: sceneView(n, scene) });
  }

  /** Saves where the lights are heading (not a mid-fade value) into a scene slot. Never a look. */
  saveScene(slot, { name } = {}) {
    const n = this.#slot(slot);
    if (!n) return fail(404, `no scene ${slot} — scenes are numbered 1–${this.sceneCount}; the looks cannot be saved over`);
    if (!this.engine.known) return fail(409, 'there is no lighting state to save yet');
    if (name !== undefined && name !== null && !cleanName(name)) return fail(400, 'a name is 1–40 characters');
    const existing = this.store.data.scenes[n];
    const label = cleanName(name) ?? existing?.name ?? `Scene ${n}`;
    this.store.data.scenes[n] = { name: label, savedAt: new Date().toISOString(), state: this.engine.targets() };
    if (!this.store.save()) return fail(500, 'could not save the scene to disk');
    this.#emitView();
    return ok({ ok: true, scene: sceneView(n, this.store.data.scenes[n]) });
  }

  renameScene(slot, name) {
    const n = this.#slot(slot);
    if (!n) return fail(404, `no scene ${slot}`);
    const scene = this.store.data.scenes[n];
    if (!scene) return fail(409, `scene ${n} is empty`);
    const label = cleanName(name);
    if (!label) return fail(400, 'a name is 1–40 characters');
    scene.name = label;
    if (!this.store.save()) return fail(500, 'could not save the scene to disk');
    this.#emitView();
    return ok({ ok: true, scene: sceneView(n, scene) });
  }

  clearScene(slot) {
    const n = this.#slot(slot);
    if (!n) return fail(404, `no scene ${slot}`);
    delete this.store.data.scenes[n];
    if (!this.store.save()) return fail(500, 'could not save to disk');
    this.#emitView();
    return ok({ ok: true, scene: sceneView(n, null) });
  }

  recallLook(id, { fadeMs } = {}) {
    const look = LOOKS[id];
    if (!look) return fail(404, `no look "${id}"`);
    const ms = fade(fadeMs);
    if (ms === null) return fail(400, `fadeMs must be 0–${MAX_FADE_MS}`);
    this.engine.apply(lookState(look, this.fixtures, this.profiles), { fadeMs: ms });
    return ok({ ok: true, look: { id: look.id, name: look.name } });
  }

  identify(id, ms = 3000) {
    const f = resolveTarget(this.fixtures, { fixture: id });
    if (!f) return fail(404, `no fixture "${id}"`);
    this.engine.identify(f[0].id, Math.min(Math.max(Number(ms) || 3000, 500), 10_000));
    this.#startViewTicker();
    const live = this.output.status();
    return ok({ ok: true, fixture: f[0].id, visible: live.state === 'sending' || live.state === 'degraded' });
  }

  /**
   * Output settings. `enabled` and `dryRun` are operator controls; the network
   * (interface, address, mode, priority, source name, CID, port) is admin.
   */
  setOutput(changes = {}, { admin = false } = {}) {
    const network = ['interface', 'address', 'mode', 'priority', 'sourceName', 'cid', 'port'];
    if (!admin && network.some((k) => k in changes)) {
      return fail(403, 'changing the lighting network settings needs the admin PIN');
    }
    const { values, errors } = checkOutput(changes);
    if (errors.length) return fail(400, errors.map((e) => e.message).join('; '), { errors: errors.map((e) => e.message) });
    const next = { ...this.settings.output, ...values };
    const saved = this.#writeLighting({ output: next });
    if (!saved.ok) return saved;
    this.output.configure(this.#outputSettings());
    // Output just switched on: the current state goes out now, not at the next refresh.
    this.engine.tick();
    this.log('info', `lighting output: ${describe(this.output.status())}`);
    this.#emitView();
    return ok({ ok: true, output: this.output.status() });
  }

  // --- patch and profiles (admin) ------------------------------------------------

  addFixture(input) {
    const fixture = normaliseFixture(input, this.patch);
    return this.#replacePatch([...this.patch, fixture], `added fixture ${fixture.name}`, fixture.id);
  }

  updateFixture(id, changes) {
    const at = this.patch.findIndex((f) => f.id === id);
    if (at < 0) return fail(404, `no fixture "${id}"`);
    const next = [...this.patch];
    next[at] = normaliseFixture({ ...this.patch[at], ...changes, id }, []);
    return this.#replacePatch(next, `updated fixture ${next[at].name}`, id);
  }

  removeFixture(id) {
    if (!this.patch.some((f) => f.id === id)) return fail(404, `no fixture "${id}"`);
    return this.#replacePatch(this.patch.filter((f) => f.id !== id), `removed fixture ${id}`);
  }

  addProfile(profile) {
    return this.#replaceProfiles([...this.customProfiles, { ...profile, builtIn: undefined }], `added profile ${profile?.id}`);
  }

  updateProfile(id, profile) {
    if (this.builtIns.some((p) => p.id === id)) return fail(409, `"${id}" is built in; duplicate it to change it`);
    const at = this.customProfiles.findIndex((p) => p.id === id);
    if (at < 0) return fail(404, `no custom profile "${id}"`);
    const next = [...this.customProfiles];
    next[at] = { ...profile, id, builtIn: undefined };
    return this.#replaceProfiles(next, `updated profile ${id}`);
  }

  removeProfile(id) {
    if (this.builtIns.some((p) => p.id === id)) return fail(409, `"${id}" is built in and cannot be removed`);
    if (!this.customProfiles.some((p) => p.id === id)) return fail(404, `no custom profile "${id}"`);
    const users = this.patch.filter((f) => f.profile === id).map((f) => f.name);
    if (users.length) return fail(409, `profile "${id}" is used by ${users.join(', ')}`);
    return this.#replaceProfiles(this.customProfiles.filter((p) => p.id !== id), `removed profile ${id}`);
  }

  // --- import / export -----------------------------------------------------------

  /** The fixture and scene config as one JSON document. */
  exportConfig() {
    return {
      type: 'cambridge-lighting',
      version: 1,
      exportedAt: new Date().toISOString(),
      fixtures: this.patch,
      profiles: this.customProfiles,
      sceneCount: this.sceneCount,
      scenes: this.store.data.scenes,
    };
  }

  /**
   * Replaces the patch, custom profiles and (optionally) the scenes from an
   * export. Everything is validated first; nothing is written unless all of it
   * is good. `dryRun` (the default) only reports what would change.
   */
  importConfig(doc, { dryRun = true, scenes = true } = {}) {
    if (doc?.type !== 'cambridge-lighting' || doc.version !== 1) return fail(400, 'not a CamBridge lighting export (type/version)');
    const fixtures = Array.isArray(doc.fixtures) ? doc.fixtures.map((f) => normaliseFixture(f, [])) : null;
    if (!fixtures) return fail(400, 'the export has no fixtures list');
    const custom = Array.isArray(doc.profiles) ? doc.profiles : [];
    const profileErrors = validateCustomProfiles(custom, this.builtIns);
    const profiles = profileMap(this.builtIns, custom);
    const patchErrors = validatePatch(fixtures, profiles);
    const sceneErrors = [];
    const importedScenes = {};
    // An export without scenes leaves the scenes alone rather than clearing them.
    const replaceScenes = scenes && !!doc.scenes && typeof doc.scenes === 'object';
    if (replaceScenes) {
      for (const [slot, s] of Object.entries(doc.scenes)) {
        if (!/^\d+$/.test(slot) || !s || typeof s.state !== 'object') { sceneErrors.push(`scene ${slot} is not a scene`); continue; }
        importedScenes[slot] = { name: cleanName(s.name) ?? `Scene ${slot}`, savedAt: s.savedAt ?? null, state: s.state, note: s.note ?? null };
      }
    }
    const errors = [...profileErrors.map((e) => e.message), ...patchErrors.map((e) => e.message), ...sceneErrors];
    const summary = { fixtures: fixtures.length, profiles: custom.length, scenes: replaceScenes ? Object.keys(importedScenes).length : null, errors };
    if (errors.length) return fail(400, 'the import has problems; nothing was changed', summary);
    if (dryRun) return ok({ ok: true, dryRun: true, ...summary });
    const saved = this.#writeLighting({
      fixtures, profiles: custom,
      ...(Number.isInteger(doc.sceneCount) ? { sceneCount: doc.sceneCount } : {}),
    });
    if (!saved.ok) return saved;
    if (replaceScenes) {
      this.store.data.scenes = importedScenes;
      if (!this.store.save()) return fail(500, 'the patch was imported, but the scenes could not be saved to disk');
    }
    this.#reloadPatch();
    this.log('info', `lighting import: ${fixtures.length} fixture(s), ${custom.length} profile(s)${replaceScenes ? `, ${Object.keys(importedScenes).length} scene(s)` : ''}`);
    return ok({ ok: true, ...summary });
  }

  /** Writes imported scenes (Companion migration), after the caller has shown them. */
  writeScenes(scenes) {
    for (const [slot, s] of Object.entries(scenes)) {
      const n = this.#slot(slot);
      if (n) this.store.data.scenes[n] = s;
    }
    if (!this.store.save()) return fail(500, 'could not save the scenes to disk');
    this.#emitView();
    return ok({ ok: true, scenes: this.#sceneSlots().map((n) => sceneView(n, this.store.data.scenes[n])) });
  }

  // --- internals -----------------------------------------------------------------

  #loadSettings() {
    let cfg = {};
    try { cfg = this.readConfig() ?? {}; } catch (err) { this.log('error', `lighting: cannot read config (${err.message}) — using defaults`); }
    const l = cfg.lighting && typeof cfg.lighting === 'object' ? cfg.lighting : {};
    // A hand-edited config with a bad value is reported, not guessed at: the
    // setting falls back to its default (output off, if `enabled` is the bad
    // one) and the Lighting tab shows what was wrong.
    this.configErrors = [];
    const bad = (message) => { this.configErrors.push({ message }); this.log('error', `lighting config: ${message}`); };
    const { values, errors } = checkOutput(l.output && typeof l.output === 'object' ? l.output : {});
    for (const e of errors) bad(`output.${e.field}: ${e.message} — using the default`);
    this.settings = {
      output: { ...OUTPUT_DEFAULTS, ...values },
    };
    if (l.sceneCount !== undefined && !(Number.isInteger(l.sceneCount) && l.sceneCount >= 1 && l.sceneCount <= 99)) {
      bad(`sceneCount must be 1–99 — using ${DEFAULT_SCENE_COUNT}`);
    }
    this.sceneCount = Number.isInteger(l.sceneCount) && l.sceneCount >= 1 && l.sceneCount <= 99 ? l.sceneCount : DEFAULT_SCENE_COUNT;
    if (l.profiles !== undefined && !Array.isArray(l.profiles)) bad('profiles is not a list — ignoring it');
    this.customProfiles = Array.isArray(l.profiles) ? l.profiles : [];
    if (l.fixtures === undefined) {
      // First run: the studio's five Lyras.
      this.patch = SEED_FIXTURES.map((f) => ({ ...f, groups: [] }));
    } else if (!Array.isArray(l.fixtures)) {
      // Not the seed: sending the built-in patch to a rig that was set up
      // differently would be a guess. Nothing is sent until it is fixed.
      bad('fixtures is not a list — no fixtures are patched until it is fixed');
      this.patch = [];
    } else {
      this.patch = l.fixtures.filter((f) => f && typeof f === 'object').map((f) => ({ ...f, groups: Array.isArray(f.groups) ? [...f.groups] : [] }));
    }
    this.#validate();
  }

  #validate() {
    this.profileErrors = validateCustomProfiles(this.customProfiles, this.builtIns);
    const badProfiles = new Set(this.profileErrors.map((e) => e.profile));
    this.profiles = profileMap(this.builtIns, this.customProfiles.filter((p) => !badProfiles.has(p.id)));
    this.patchErrors = validatePatch(this.patch, this.profiles);
    // A fixture with a problem is left out of the output rather than guessed
    // at: two fixtures on one address would drive each other's lights.
    const bad = new Set(this.patchErrors.map((e) => e.fixture));
    this.fixtures = this.patch.filter((f) => !bad.has(f.id));
    for (const e of [...this.profileErrors, ...this.patchErrors]) this.log('error', `lighting config: ${e.message}`);
  }

  #reloadPatch() {
    this.#loadSettings();
    this.engine.configure(this.fixtures, this.profiles);
    this.output.configure(this.#outputSettings());
    this.#emitView();
  }

  /** A saved state is only worth restoring if it describes a fixture still in the patch. */
  #restorable(state) {
    return !!state && typeof state === 'object' && this.fixtures.some((f) => state[f.id]);
  }

  #outputSettings() {
    return { ...this.settings.output, cid: this.settings.output.cid ?? this.store.data.cid };
  }

  #replacePatch(next, what, id) {
    const errors = validatePatch(next, this.profiles);
    if (errors.length) {
      // `fixture` says which one this change was about, so a form can put its
      // errors by its fields and show the rest (the other half of an overlap) apart.
      return fail(400, 'the patch has problems; nothing was changed', { errors, ...(id ? { fixture: id } : {}) });
    }
    const saved = this.#writeLighting({ fixtures: next });
    if (!saved.ok) return saved;
    this.#reloadPatch();
    this.log('info', `lighting: ${what}`);
    return ok({ ok: true, ...(id ? { fixture: this.view().fixtures.find((f) => f.id === id) } : {}) });
  }

  #replaceProfiles(next, what) {
    const errors = validateCustomProfiles(next, this.builtIns);
    if (errors.length) return fail(400, 'the profile has problems; nothing was changed', { errors });
    const saved = this.#writeLighting({ profiles: next.map(({ builtIn, ...p }) => p) });
    if (!saved.ok) return saved;
    this.#reloadPatch();
    this.log('info', `lighting: ${what}`);
    return ok({ ok: true });
  }

  #writeLighting(changes) {
    try {
      const cfg = this.readConfig() ?? {};
      const current = cfg.lighting ?? {};
      cfg.lighting = {
        output: current.output ?? this.settings.output,
        fixtures: current.fixtures ?? this.patch,
        profiles: current.profiles ?? this.customProfiles,
        sceneCount: current.sceneCount ?? this.sceneCount,
        ...changes,
      };
      this.writeConfig(cfg);
      if (changes.output) this.settings.output = changes.output;
      return { ok: true };
    } catch (err) {
      this.log('error', `lighting: cannot save config: ${err.message}`);
      return fail(500, `could not save the config: ${err.message}`);
    }
  }

  #sceneSlots() {
    return Array.from({ length: this.sceneCount }, (_, i) => i + 1);
  }

  #slot(slot) {
    const n = Number(slot);
    return Number.isInteger(n) && n >= 1 && n <= this.sceneCount ? n : null;
  }

  #active(heading) {
    for (const look of Object.values(LOOKS)) {
      if (matches(lookState(look, this.fixtures, this.profiles), heading, this.fixtures, this.profiles)) return { type: 'look', id: look.id };
    }
    for (const n of this.#sceneSlots()) {
      const s = this.store.data.scenes[n];
      if (s && matches(s.state, heading, this.fixtures, this.profiles)) return { type: 'scene', slot: n };
    }
    return null;
  }

  #stateChanged() {
    this.#emitView();
    this.#startViewTicker();
    // Saved shortly after it stops changing: a fader drag is many commands.
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.#saveState(), 500);
    this.saveTimer.unref?.();
  }

  #saveState() {
    if (!this.engine.known) return;
    this.store.data.state = this.engine.targets();
    this.store.save();
  }

  /** While something fades or flashes, the live view is pushed ten times a second. */
  #startViewTicker() {
    if (this.viewTimer) return;
    this.viewTimer = setInterval(() => {
      this.#emitView();
      if (!this.engine.fading && this.engine.identifying.size === 0) {
        clearInterval(this.viewTimer);
        this.viewTimer = null;
      }
    }, 100);
    this.viewTimer.unref?.();
  }

  /**
   * Tells listeners the view changed. Coalesced to one event per turn of the
   * event loop, and never emitted from inside a command, so a listener that
   * reads view() always sees the command finished.
   */
  #emitView() {
    if (this.viewPending) return;
    this.viewPending = true;
    setImmediate(() => {
      this.viewPending = false;
      this.emit('view');
    });
  }
}

/**
 * Checks output settings, from the API or the config file.
 *
 * @returns {{values: object, errors: {field: string, message: string}[]}}
 *   `values` holds only the fields that were given and are good.
 */
function checkOutput(o) {
  const values = {};
  const errors = [];
  const check = (field, good, value, message) => {
    if (!(field in o)) return;
    if (good) values[field] = value; else errors.push({ field, message });
  };
  check('enabled', typeof o.enabled === 'boolean', o.enabled, 'enabled is true or false');
  check('dryRun', typeof o.dryRun === 'boolean', o.dryRun, 'dryRun is true or false');
  check('interface', typeof o.interface === 'string' && /^[A-Za-z0-9._-]{0,32}$/.test(o.interface.trim()), String(o.interface).trim(),
    'interface must be a name like en14');
  check('address', o.address === '' || (typeof o.address === 'string' && isIPv4(o.address)), o.address,
    'address must be an IPv4 address, or empty to use the interface\'s');
  check('mode', ['unicast', 'multicast'].includes(o.mode), o.mode, 'mode is unicast or multicast');
  check('priority', Number.isInteger(o.priority) && o.priority >= 0 && o.priority <= MAX_PRIORITY, o.priority,
    `priority is a whole number 0–${MAX_PRIORITY}`);
  check('sourceName', typeof o.sourceName === 'string' && !!o.sourceName.trim() && Buffer.byteLength(o.sourceName.trim()) <= 63,
    String(o.sourceName).trim(), 'source name is 1–63 bytes');
  let cidOk = false;
  try { cidBytes(o.cid); cidOk = true; } catch { /* reported below */ }
  check('cid', cidOk, o.cid, 'CID must be a UUID');
  check('port', Number.isInteger(o.port) && o.port >= 1 && o.port <= 65535, o.port, 'port must be 1–65535');
  return { values, errors };
}

function fade(ms) {
  if (ms === undefined || ms === null || ms === '') return 0;
  const n = Number(ms);
  return Number.isFinite(n) && n >= 0 && n <= MAX_FADE_MS ? Math.round(n) : null;
}

function cleanName(name) {
  if (typeof name !== 'string') return null;
  const t = name.trim();
  return t && t.length <= 40 ? t : null;
}

/** A fixture from the API or an import, with its fields in shape for validation. */
function normaliseFixture(input, existing) {
  const f = input ?? {};
  const name = typeof f.name === 'string' ? f.name.trim() : '';
  let id = typeof f.id === 'string' && f.id ? f.id : name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!id) id = 'fixture';
  const taken = new Set(existing.map((x) => x.id));
  if (taken.has(id)) { let n = 2; while (taken.has(`${id}-${n}`)) n++; id = `${id}-${n}`; }
  return {
    id,
    name,
    profile: f.profile,
    ip: typeof f.ip === 'string' ? f.ip.trim() : f.ip,
    universe: toInt(f.universe),
    address: toInt(f.address),
    groups: Array.isArray(f.groups) ? f.groups.map((g) => String(g).trim()).filter(Boolean) : [],
  };
}

function toInt(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isInteger(n) ? n : v;
}

function describe(s) {
  return `${s.enabled ? 'on' : 'off'}${s.dryRun ? ' (dry run)' : ''}, ${s.mode}, priority ${s.priority}, `
    + `${s.address || s.interface}${s.error ? ` — ${s.error}` : ''}`;
}

export { ALL_GROUP, validateProfile };
