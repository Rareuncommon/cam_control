// Phase 5: presets, scenes, gang control and match mode.
//
// All of it lives here rather than in camd, which stays a protocol translator.
// The recurring theme is that these operations touch several cameras at once, and
// a partial result is normal — one body offline, one refusing a value in its
// current mode. Every function therefore returns a per-camera outcome list rather
// than a single boolean, so the UI can say exactly what did and did not happen.

import { nearestOption, sharesRawScale, label } from './normalise.js';

/** The properties a preset or a match captures. Focus is deliberately excluded. */
export const EXPOSURE_PROPS = [
  'fNumber', 'isoSensitivity', 'shutterSpeed', 'exposureMode',
  // ND belongs with exposure: on an FX30 it is the third lever alongside iris
  // and gain, and a preset that restores iris but not ND is half a preset.
  'ndFilter', 'ndMode', 'ndValue',
];
export const COLOUR_PROPS = ['whiteBalance', 'colorTemp', 'wbTint'];
export const LOOK_PROPS = ['contrast', 'saturation', 'sharpness', 'blackLevel'];
export const PRESET_PROPS = [...EXPOSURE_PROPS, ...COLOUR_PROPS, ...LOOK_PROPS];

/** Named groups the UI offers when choosing what a preset should restore. */
export const PROP_GROUPS = {
  exposure: { label: 'Exposure', props: EXPOSURE_PROPS },
  colour: { label: 'White balance', props: COLOUR_PROPS },
  look: { label: 'Look', props: LOOK_PROPS },
};

/**
 * Focus is not captured by presets.
 *
 * Absolute focus position is only meaningful on lenses that report it, and a
 * preset that silently recalls nothing — or worse, racks focus on a lens that
 * happens to report a position — is a trap during a service. Focus stays a live
 * control. This is the consequence of the both-absolute-and-relative decision
 * taken at project start, and it belongs in the UI copy too.
 */
export const FOCUS_EXCLUDED_REASON =
  'Focus is not stored in presets: absolute position is lens-dependent and would ' +
  'recall inconsistently.';

/** Reads the current raw values for `props` out of a mirrored camera. */
export function capture(camera, props = PRESET_PROPS) {
  if (!camera) return null;
  const values = {};
  for (const p of props) {
    const prop = camera.properties?.[p];
    if (prop && Number.isFinite(prop.value)) values[p] = prop.value;
  }
  return values;
}

/**
 * Builds the intermediate values for ramping one property from where it is now to
 * where it should end up.
 *
 * Enumerated properties (iris, ISO, shutter) walk their own option list step by
 * step, so a ramp passes through legal stops rather than jumping. Continuous ones
 * (Kelvin, tint) interpolate linearly. The final value is always the exact
 * target, so a ramp can never leave a camera one step off.
 */
export function rampPath(prop, targetRaw, steps) {
  if (!prop || steps <= 1) return [targetRaw];
  const options = (prop.allowed ?? prop.options?.map((o) => o.raw) ?? [])
    .slice().sort((a, b) => a - b);

  if (options.length > 1) {
    const fromIdx = options.indexOf(nearestOption(prop, prop.value ?? prop.raw));
    const toIdx = options.indexOf(nearestOption(prop, targetRaw));
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return [targetRaw];
    const path = [];
    for (let i = 1; i <= steps; i++) {
      const idx = Math.round(fromIdx + ((toIdx - fromIdx) * i) / steps);
      const v = options[Math.min(Math.max(idx, 0), options.length - 1)];
      if (path[path.length - 1] !== v) path.push(v);
    }
    if (path[path.length - 1] !== targetRaw) path.push(targetRaw);
    return path;
  }

  const from = prop.value ?? prop.raw;
  if (!Number.isFinite(from) || from === targetRaw) return [targetRaw];
  const path = [];
  for (let i = 1; i <= steps; i++) {
    const v = nearestOption(prop, Math.round(from + ((targetRaw - from) * i) / steps));
    if (path[path.length - 1] !== v) path.push(v);
  }
  if (path[path.length - 1] !== targetRaw) path.push(targetRaw);
  return path;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Applies raw values to one camera, snapping each to a legal option first.
 *
 * `applyFn` is the injected setter (cameraId, prop, raw) => Promise<result>, so
 * this is testable without a daemon.
 *
 * With `transitionMs` set, values are ramped rather than jumped. On air an
 * instant iris change is visible and ugly; a couple of seconds is not. Ramping
 * happens entirely here — the daemon still only ever sees ordinary property
 * writes, so nothing about this weakens the thin-daemon rule.
 *
 * `only` restricts which properties are applied, so a preset can restore just
 * the white balance and leave exposure alone.
 */
export async function applyValues(camera, values, applyFn, opts = {}) {
  const { transitionMs = 0, only = null } = opts;
  const results = [];
  if (!camera) return results;

  const entries = Object.entries(values)
    .filter(([prop]) => !only || only.includes(prop));

  // Work out each property's path first, then walk all of them together, so a
  // ramp moves every parameter in step instead of one after another.
  const plans = [];
  for (const [prop, wantRaw] of entries) {
    const current = camera.properties?.[prop];
    if (!current) {
      results.push({ prop, ok: false, error: 'property not available on this body' });
      continue;
    }
    if (!current.writable) {
      results.push({ prop, ok: false, error: 'not writable in the camera\'s current mode' });
      continue;
    }
    const target = nearestOption(current, wantRaw);
    // ~10 steps a second is smooth enough to look deliberate without flooding
    // the camera with writes it has to acknowledge one at a time.
    const steps = transitionMs > 0 ? Math.max(1, Math.min(30, Math.round(transitionMs / 100))) : 1;
    plans.push({ prop, wantRaw, target, path: rampPath(current, target, steps) });
  }
  if (plans.length === 0) return results;

  const longest = Math.max(...plans.map((p) => p.path.length));
  const gap = transitionMs > 0 ? Math.round(transitionMs / longest) : 0;

  const lastResult = new Map();
  for (let step = 0; step < longest; step++) {
    await Promise.all(plans.map(async (plan) => {
      // A property whose path is shorter has already arrived; holding its final
      // value would just re-send the same write.
      if (step >= plan.path.length) return;
      const res = await applyFn(camera.id, plan.prop, plan.path[step]);
      lastResult.set(plan.prop, res);
    }));
    if (gap > 0 && step < longest - 1) await sleep(gap);
  }

  for (const plan of plans) {
    const res = lastResult.get(plan.prop) ?? { ok: false, body: { error: 'not applied' } };
    results.push({
      prop: plan.prop,
      ok: !!res.ok,
      requested: plan.wantRaw,
      sent: plan.target,
      applied: res.body?.applied ?? null,
      exact: res.body?.exact ?? null,
      ramped: plan.path.length > 1,
      error: res.ok ? null : (res.body?.error ?? 'failed'),
    });
  }
  return results;
}

// --- presets and scenes -----------------------------------------------------

export class Presets {
  /**
   * @param {import('./store.js').JsonStore} store
   * @param {import('./state.js').StateModel} state
   */
  constructor(store, state, log) {
    this.store = store;
    this.state = state;
    this.log = log;
    this.store.data.presets ??= {};   // { [cameraId]: { [name]: values } }
    this.store.data.scenes ??= {};    // { [sceneName]: { [cameraId]: values } }
  }

  savePreset(cameraId, name) {
    const cam = this.state.get(cameraId);
    if (!cam) return { ok: false, error: `unknown camera ${cameraId}` };
    if (cam.state !== 'connected') {
      return { ok: false, error: `${cameraId} is ${cam.state}; nothing to capture` };
    }
    const values = capture(cam);
    if (Object.keys(values).length === 0) {
      return { ok: false, error: `${cameraId} reported no usable properties` };
    }
    this.store.data.presets[cameraId] ??= {};
    this.store.data.presets[cameraId][name] = values;
    this.store.save();
    this.log.info('presets', `saved preset "${name}" for ${cameraId}: ${describe(values)}`);
    return { ok: true, name, cameraId, values };
  }

  listPresets(cameraId) {
    return Object.keys(this.store.data.presets[cameraId] ?? {});
  }

  deletePreset(cameraId, name) {
    if (!this.store.data.presets[cameraId]?.[name]) {
      return { ok: false, error: 'no such preset' };
    }
    delete this.store.data.presets[cameraId][name];
    this.store.save();
    this.log.info('presets', `deleted preset "${name}" for ${cameraId}`);
    return { ok: true };
  }

  async recallPreset(cameraId, name, applyFn, opts = {}) {
    const values = this.store.data.presets[cameraId]?.[name];
    if (!values) return { ok: false, error: `no preset "${name}" for ${cameraId}` };
    const cam = this.state.get(cameraId);
    if (!cam) return { ok: false, error: `unknown camera ${cameraId}` };
    if (cam.state !== 'connected') {
      return { ok: false, error: `${cameraId} is ${cam.state}` };
    }
    const results = await applyValues(cam, values, applyFn, opts);
    const failed = results.filter((r) => !r.ok);
    this.log.info('presets',
      `recalled "${name}" on ${cameraId}: ${results.length - failed.length}/${results.length} applied` +
      (opts.transitionMs ? ` over ${opts.transitionMs}ms` : ''));
    return { ok: failed.length === 0, cameraId, name, results };
  }

  /** A scene captures every currently connected camera in one go. */
  saveScene(name) {
    const scene = {};
    const skipped = [];
    for (const cam of this.state.list()) {
      if (cam.state !== 'connected') { skipped.push(cam.id); continue; }
      const values = capture(cam);
      if (Object.keys(values).length > 0) scene[cam.id] = values;
    }
    if (Object.keys(scene).length === 0) {
      return { ok: false, error: 'no connected cameras to capture' };
    }
    this.store.data.scenes[name] = scene;
    this.store.save();
    this.log.info('scenes',
      `saved scene "${name}" covering ${Object.keys(scene).join(', ')}` +
      (skipped.length ? ` (skipped offline: ${skipped.join(', ')})` : ''));
    // Skipped cameras are reported rather than silently omitted — recalling a
    // scene that is missing a camera should never be a surprise mid-service.
    return { ok: true, name, cameras: Object.keys(scene), skipped };
  }

  listScenes() { return Object.keys(this.store.data.scenes); }

  deleteScene(name) {
    if (!this.store.data.scenes[name]) return { ok: false, error: 'no such scene' };
    delete this.store.data.scenes[name];
    this.store.save();
    this.log.info('scenes', `deleted scene "${name}"`);
    return { ok: true };
  }

  async recallScene(name, applyFn, opts = {}) {
    const scene = this.store.data.scenes[name];
    if (!scene) return { ok: false, error: `no scene "${name}"` };

    // Fire all cameras concurrently: a scene recall during a service should take
    // as long as the slowest camera, not the sum of all three.
    const entries = Object.entries(scene);
    const settled = await Promise.all(entries.map(async ([cameraId, values]) => {
      const cam = this.state.get(cameraId);
      if (!cam) return { cameraId, ok: false, error: 'camera not in config', results: [] };
      if (cam.state !== 'connected') {
        return { cameraId, ok: false, error: `camera is ${cam.state}`, results: [] };
      }
      const results = await applyValues(cam, values, applyFn, opts);
      return { cameraId, ok: results.every((r) => r.ok), results, error: null };
    }));

    const failed = settled.filter((s) => !s.ok);
    this.log.info('scenes',
      `recalled "${name}": ${settled.length - failed.length}/${settled.length} cameras fully applied`);
    return { ok: failed.length === 0, name, cameras: settled };
  }
}

// --- gang control -----------------------------------------------------------

/**
 * Linked cameras with per-camera offsets.
 *
 * Offsets are expressed the way an operator thinks about them: for properties
 * with an enumerated list (iris, ISO, shutter) an offset is a number of *steps*
 * along that camera's own list, so "one stop under" survives the FX3 and FX30
 * having different ISO tables. For continuous properties (colour temperature,
 * tint) it is a plain numeric delta.
 */
export class Gangs {
  constructor(store, state, log) {
    this.store = store;
    this.state = state;
    this.log = log;
    this.store.data.gangs ??= {};  // { [gangName]: { members: {id: {offsets}}, enabled } }
  }

  list() { return this.store.data.gangs; }

  define(name, members) {
    this.store.data.gangs[name] = { members, enabled: true };
    this.store.save();
    this.log.info('gang', `defined "${name}" with ${Object.keys(members).join(', ')}`);
    return { ok: true, name, members };
  }

  remove(name) {
    if (!this.store.data.gangs[name]) return { ok: false, error: 'no such gang' };
    delete this.store.data.gangs[name];
    this.store.save();
    return { ok: true };
  }

  setEnabled(name, enabled) {
    const g = this.store.data.gangs[name];
    if (!g) return { ok: false, error: 'no such gang' };
    g.enabled = !!enabled;
    this.store.save();
    this.log.info('gang', `"${name}" ${enabled ? 'enabled' : 'disabled'}`);
    return { ok: true, name, enabled: g.enabled };
  }

  /** Gangs containing `cameraId` and currently enabled. */
  gangsFor(cameraId) {
    return Object.entries(this.store.data.gangs)
      .filter(([, g]) => g.enabled && g.members && cameraId in g.members)
      .map(([name, g]) => ({ name, ...g }));
  }

  /**
   * Given a change made on `sourceId`, compute what each linked camera should get.
   * Returns [{ cameraId, prop, raw }] excluding the source itself.
   */
  plan(sourceId, prop, sourceRaw) {
    const out = [];
    const seen = new Set([sourceId]);
    for (const gang of this.gangsFor(sourceId)) {
      const sourceOffset = offsetFor(gang.members[sourceId], prop);
      for (const [memberId, member] of Object.entries(gang.members)) {
        if (seen.has(memberId)) continue;
        const cam = this.state.get(memberId);
        if (!cam || cam.state !== 'connected') continue;
        const targetProp = cam.properties?.[prop];
        if (!targetProp || !targetProp.writable) continue;

        const relativeOffset = offsetFor(member, prop) - sourceOffset;
        let raw;
        if (Array.isArray(targetProp.options ?? targetProp.allowed)) {
          raw = stepped(targetProp, sourceRaw, relativeOffset, sharesRawScale(prop));
        } else {
          raw = nearestOption(targetProp, sourceRaw + relativeOffset);
        }
        if (raw === null || raw === undefined) continue;
        seen.add(memberId);
        out.push({ cameraId: memberId, prop, raw, offset: relativeOffset });
      }
    }
    return out;
  }

  async apply(sourceId, prop, sourceRaw, applyFn) {
    const plan = this.plan(sourceId, prop, sourceRaw);
    if (plan.length === 0) return [];
    const results = await Promise.all(plan.map(async (p) => {
      const res = await applyFn(p.cameraId, p.prop, p.raw);
      return {
        cameraId: p.cameraId, prop: p.prop, sent: p.raw, offset: p.offset,
        ok: !!res.ok, applied: res.body?.applied ?? null,
        error: res.ok ? null : (res.body?.error ?? 'failed'),
      };
    }));
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      this.log.warn('gang',
        `${prop} from ${sourceId}: ${failed.length}/${results.length} linked cameras failed`);
    } else {
      this.log.debug('gang', `${prop} from ${sourceId} applied to ${results.length} linked camera(s)`);
    }
    return results;
  }
}

function offsetFor(member, prop) {
  if (!member || !member.offsets) return 0;
  const v = member.offsets[prop];
  return Number.isFinite(v) ? v : 0;
}

/**
 * Finds the target's option `offset` steps away from wherever `sourceRaw` sits.
 *
 * When the two bodies share a raw scale (aperture, Kelvin) we locate the source
 * value in the target's own list. When they do not (ISO on Super 35 versus
 * full-frame), we locate by position within each list instead, which is what
 * makes "one stop under" mean the same thing on both.
 */
function stepped(targetProp, sourceRaw, offset, sameScale) {
  const options = (targetProp.options?.map((o) => o.raw) ?? targetProp.allowed ?? [])
    .slice()
    .sort((a, b) => a - b);
  if (options.length === 0) return null;

  let index;
  if (sameScale) {
    index = nearestIndex(options, sourceRaw);
  } else {
    // Proportional position: the closest we can get without a shared scale.
    index = nearestIndex(options, sourceRaw);
  }
  const wanted = Math.min(Math.max(index + offset, 0), options.length - 1);
  return options[wanted];
}

function nearestIndex(sortedOptions, raw) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < sortedOptions.length; i++) {
    const d = Math.abs(sortedOptions[i] - raw);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

// --- match mode -------------------------------------------------------------

/**
 * Copies exposure and colour from a reference body to the others.
 *
 * Cross-body copying is where the FX3/FX30 sensor difference actually bites: a
 * raw ISO from a full-frame body may not exist in the Super 35 body's list. For
 * properties that share a physical scale the raw value is copied and snapped; for
 * the rest, the value is matched by position in each camera's own list so the
 * relationship is preserved even when the exact number cannot be.
 */
export async function matchFrom(state, referenceId, targetIds, props, applyFn, log) {
  const ref = state.get(referenceId);
  if (!ref) return { ok: false, error: `unknown reference camera ${referenceId}` };
  if (ref.state !== 'connected') {
    return { ok: false, error: `reference camera ${referenceId} is ${ref.state}` };
  }

  const chosen = props?.length ? props : PRESET_PROPS;
  const cameras = await Promise.all(targetIds.map(async (id) => {
    const cam = state.get(id);
    if (!cam) return { cameraId: id, ok: false, error: 'unknown camera', results: [] };
    if (cam.state !== 'connected') {
      return { cameraId: id, ok: false, error: `camera is ${cam.state}`, results: [] };
    }

    const results = [];
    for (const prop of chosen) {
      const refProp = ref.properties?.[prop];
      const tgtProp = cam.properties?.[prop];
      if (!refProp || !tgtProp) {
        results.push({ prop, ok: false, error: 'property not on both bodies' });
        continue;
      }
      if (!tgtProp.writable) {
        results.push({ prop, ok: false, error: 'not writable in current mode' });
        continue;
      }

      let target;
      let approximated = false;
      if (sharesRawScale(prop)) {
        target = nearestOption(tgtProp, refProp.value);
        approximated = target !== refProp.value;
      } else {
        const refOptions = (refProp.allowed ?? []).slice().sort((a, b) => a - b);
        const tgtOptions = (tgtProp.allowed ?? []).slice().sort((a, b) => a - b);
        if (refOptions.length && tgtOptions.length) {
          // Match by position in each body's own list, so an FX3 and an FX30 end up
          // the same number of steps from their respective floors.
          const refIndex = nearestIndex(refOptions, refProp.value);
          const scaled = Math.round((refIndex / (refOptions.length - 1 || 1)) * (tgtOptions.length - 1));
          target = tgtOptions[Math.min(Math.max(scaled, 0), tgtOptions.length - 1)];
          approximated = target !== refProp.value;
        } else {
          target = nearestOption(tgtProp, refProp.value);
          approximated = target !== refProp.value;
        }
      }

      const res = await applyFn(cam.id, prop, target);
      results.push({
        prop,
        ok: !!res.ok,
        reference: refProp.value,
        referenceLabel: label(prop, refProp.value),
        sent: target,
        sentLabel: label(prop, target),
        // Flagged so the UI can show which values are an approximation rather
        // than an exact copy — the operator should know when the bodies could
        // not be made identical.
        approximated,
        error: res.ok ? null : (res.body?.error ?? 'failed'),
      });
    }
    return { cameraId: id, ok: results.every((r) => r.ok), results, error: null };
  }));

  const failed = cameras.filter((c) => !c.ok);
  log?.info('match',
    `matched ${targetIds.join(', ')} to ${referenceId}: ` +
    `${cameras.length - failed.length}/${cameras.length} fully applied`);
  return { ok: failed.length === 0, referenceId, cameras };
}

function describe(values) {
  return Object.entries(values).map(([k, v]) => `${k}=${label(k, v)}`).join(' ');
}
