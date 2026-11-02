// Studio lighting from a Stream Deck, through CamBridge.
//
// CamBridge owns the lights (sACN to the panels); these are thin buttons over
// /api/lighting, as the camera buttons are over the camera API. The live state
// arrives with every frame in `lighting`, so readouts and feedbacks need no
// polling.
//
// The presets rebuild the lighting pages that used to drive the panels through
// Companion's generic sACN connection — page 5 (lights on/off, Studio look),
// page 12 (dimmers, colour presets, scenes) and page 13 (warmer/cooler) — in
// percent and kelvin rather than raw DMX. Scene keys keep the old behaviour:
// tap to recall over 1 s, hold for 5 s to save.

import { combineRgb } from '@companion-module/base';
import { varId } from './variables.js';

const WHITE = combineRgb(255, 255, 255);
const BLACK = combineRgb(0, 0, 0);
const DARK = combineRgb(20, 22, 26);
const DIM = combineRgb(110, 116, 124);
const WARM = combineRgb(120, 60, 10);
const COOL = combineRgb(20, 60, 120);
const ACTIVE = combineRgb(240, 200, 0);
const RED = combineRgb(200, 20, 30);
const AMBER = combineRgb(240, 160, 20);

// Companion's old keys moved the dimmer by 26 of 255 and the colour by 32 of
// 255. In percent that is 10.2 % exactly; in kelvin, on the 3200–5600 K curve,
// about 300 K (32 × 2400 / 255 = 301).
export const NUDGE_PCT = 10.2;
export const NUDGE_K = 300;
export const CCT_PRESETS = [3200, 4400, 5600];
const DEFAULT_SCENES = 5;
const HOLD_TO_SAVE_MS = 5000;

const style = (text, size = '14', extra = {}) => ({ text, size, color: WHITE, bgcolor: DARK, ...extra });

/** 'all', 'group:Key' or 'fixture:l1' → the target CamBridge expects. */
export function parseTarget(value) {
  const v = String(value ?? 'all');
  if (v.startsWith('group:')) return { group: v.slice(6) };
  if (v.startsWith('fixture:')) return { fixture: v.slice(8) };
  return { all: true };
}

const fadeField = (def) => ({
  type: 'number', id: 'fadeMs', label: 'Fade (ms)', default: def, min: 0, max: 60000, step: 100,
});

function targetChoices(l) {
  return [
    { id: 'all', label: 'All lights' },
    ...(l?.groups ?? []).filter((g) => g !== 'All').map((g) => ({ id: `group:${g}`, label: `Group: ${g}` })),
    ...(l?.fixtures ?? []).map((f) => ({ id: `fixture:${f.id}`, label: f.name })),
  ];
}

function sceneChoices(l) {
  const scenes = l?.scenes?.length ? l.scenes : Array.from({ length: DEFAULT_SCENES }, (_, i) => ({ slot: i + 1, name: `Scene ${i + 1}` }));
  return scenes.map((s) => ({ id: s.slot, label: `${s.slot} — ${s.name}` }));
}

function lookChoices(l) {
  const looks = l?.looks?.length ? l.looks : [{ id: 'studio', name: 'Studio look' }, { id: 'off', name: 'Studio off' }];
  return looks.map((x) => ({ id: x.id, label: x.name }));
}

/** What changes Companion's dropdowns: lights, groups and scene names. Not levels. */
export function lightingSignature(l) {
  if (!l || l.unavailable) return 'none';
  return JSON.stringify([
    (l.fixtures ?? []).map((f) => [f.id, f.name, !!f.kelvin]),
    l.groups ?? [],
    (l.scenes ?? []).map((s) => [s.slot, s.name]),
    (l.looks ?? []).map((x) => x.id),
  ]);
}

// --- actions -------------------------------------------------------------------

export function buildLightingActions(self) {
  const l = self.lighting;
  const targets = targetChoices(l);
  const scenes = sceneChoices(l);
  const looks = lookChoices(l);
  const req = (method, path, body) => self.api?.request(method, path, body);
  const targetField = { type: 'dropdown', id: 'target', label: 'Lights', default: 'all', choices: targets };

  return {
    lightSet: {
      name: 'Lighting: set dimmer and/or colour',
      options: [
        targetField,
        { type: 'dropdown', id: 'what', label: 'Set', default: 'intensity', choices: [
          { id: 'intensity', label: 'Dimmer (%)' }, { id: 'cct', label: 'Colour (K)' }, { id: 'both', label: 'Both' },
        ] },
        { type: 'number', id: 'intensity', label: 'Dimmer (%)', default: 100, min: 0, max: 100, step: 1,
          isVisibleExpression: `$(options:what) != 'cct'` },
        { type: 'number', id: 'cct', label: 'Colour (K)', default: 4400, min: 1000, max: 20000, step: 50,
          isVisibleExpression: `$(options:what) != 'intensity'` },
        fadeField(1000),
      ],
      callback: (ev) => {
        const o = ev.options;
        const body = { target: parseTarget(o.target), fadeMs: Number(o.fadeMs) || 0 };
        if (o.what !== 'cct') body.intensity = Number(o.intensity);
        if (o.what !== 'intensity') body.cct = Number(o.cct);
        return req('POST', '/api/lighting/set', body);
      },
    },

    lightNudge: {
      name: 'Lighting: nudge dimmer or colour (up/down from where each light is)',
      options: [
        targetField,
        { type: 'dropdown', id: 'param', label: 'What', default: 'intensity', choices: [
          { id: 'intensity', label: 'Dimmer (%)' }, { id: 'cct', label: 'Colour (K): + is cooler, − is warmer' },
        ] },
        { type: 'number', id: 'amount', label: 'By (%, or K)', default: NUDGE_PCT, min: -10000, max: 10000, step: 0.1 },
        fadeField(0),
      ],
      callback: (ev) => {
        const o = ev.options;
        return req('POST', '/api/lighting/set', {
          target: parseTarget(o.target), [o.param === 'cct' ? 'cct' : 'intensity']: Number(o.amount), relative: true, fadeMs: Number(o.fadeMs) || 0,
        });
      },
    },

    lightSceneRecall: {
      name: 'Lighting: recall scene',
      options: [{ type: 'dropdown', id: 'slot', label: 'Scene', default: scenes[0]?.id ?? 1, choices: scenes }, fadeField(1000)],
      callback: (ev) => req('POST', `/api/lighting/scenes/${Number(ev.options.slot)}/recall`, { fadeMs: Number(ev.options.fadeMs) || 0 }),
    },

    lightSceneSave: {
      name: 'Lighting: save scene (where the lights are now)',
      options: [{ type: 'dropdown', id: 'slot', label: 'Scene', default: scenes[0]?.id ?? 1, choices: scenes }],
      callback: async (ev) => {
        const r = await req('PUT', `/api/lighting/scenes/${Number(ev.options.slot)}`, {});
        if (r?.ok) self.log('info', `lighting scene ${ev.options.slot} saved`);
        return r;
      },
    },

    lightLook: {
      name: 'Lighting: recall Studio look / Studio off',
      options: [{ type: 'dropdown', id: 'look', label: 'Look', default: 'studio', choices: looks }, fadeField(1000)],
      callback: (ev) => req('POST', `/api/lighting/looks/${encodeURIComponent(ev.options.look)}/recall`, { fadeMs: Number(ev.options.fadeMs) || 0 }),
    },

    lightOutput: {
      name: 'Lighting: CamBridge output on / off',
      options: [
        { type: 'dropdown', id: 'mode', label: 'Output', default: 'toggle', choices: [
          { id: 'on', label: 'On' }, { id: 'off', label: 'Off' }, { id: 'toggle', label: 'Toggle' },
        ] },
        { type: 'static-text', id: 'warn', label: '', width: 12,
          value: 'Only one source may drive the lights: turn Companion’s own sACN connection off before turning CamBridge’s output on.' },
      ],
      callback: (ev) => {
        const mode = ev.options.mode;
        const enabled = mode === 'toggle' ? !self.lighting?.output?.enabled : mode === 'on';
        return req('PUT', '/api/lighting/output', { enabled });
      },
    },

    lightIdentify: {
      name: 'Lighting: identify a light (flash it for 3 s)',
      options: [{ type: 'dropdown', id: 'fixture', label: 'Light', default: l?.fixtures?.[0]?.id ?? '',
        choices: (l?.fixtures ?? []).map((f) => ({ id: f.id, label: f.name })) }],
      callback: (ev) => req('POST', `/api/lighting/fixtures/${encodeURIComponent(ev.options.fixture)}/identify`, { ms: 3000 }),
    },
  };
}

// --- feedbacks -------------------------------------------------------------------

/** The output states a key can light up for. 'problem' covers no network and send errors. */
export function outputIs(l, which) {
  const o = l?.output;
  if (!o) return false;
  switch (which) {
    case 'off': return o.state === 'off';
    case 'dry-run': return o.state === 'dry-run';
    case 'problem': return o.state === 'error' || o.state === 'degraded' || !!l.unavailable;
    case 'waiting': return o.state === 'sending' && (o.waitingForState || l.known === false);
    case 'sending': return o.state === 'sending' && !o.waitingForState && l.known !== false;
    default: return false;
  }
}

export function buildLightingFeedbacks(self) {
  const scenes = sceneChoices(self.lighting);
  const looks = lookChoices(self.lighting);
  return {
    lightSceneActive: {
      name: 'Lighting: scene is what the lights are showing',
      type: 'boolean',
      defaultStyle: { bgcolor: ACTIVE, color: BLACK },
      options: [{ type: 'dropdown', id: 'slot', label: 'Scene', default: scenes[0]?.id ?? 1, choices: scenes }],
      callback: (fb) => self.lighting?.active?.type === 'scene' && self.lighting.active.slot === Number(fb.options.slot),
    },
    lightSceneEmpty: {
      name: 'Lighting: scene slot is empty',
      type: 'boolean',
      defaultStyle: { color: DIM },
      options: [{ type: 'dropdown', id: 'slot', label: 'Scene', default: scenes[0]?.id ?? 1, choices: scenes }],
      callback: (fb) => !!self.lighting?.scenes?.find((s) => s.slot === Number(fb.options.slot))?.empty,
    },
    lightLookActive: {
      name: 'Lighting: Studio look / Studio off is what the lights are showing',
      type: 'boolean',
      defaultStyle: { bgcolor: ACTIVE, color: BLACK },
      options: [{ type: 'dropdown', id: 'look', label: 'Look', default: 'studio', choices: looks }],
      callback: (fb) => self.lighting?.active?.type === 'look' && self.lighting.active.id === fb.options.look,
    },
    lightOutput: {
      name: 'Lighting: CamBridge output is …',
      type: 'boolean',
      defaultStyle: { bgcolor: AMBER, color: BLACK },
      options: [{ type: 'dropdown', id: 'state', label: 'State', default: 'dry-run', choices: [
        { id: 'off', label: 'Off (not sending)' },
        { id: 'dry-run', label: 'Dry run (worked out, not sent)' },
        { id: 'waiting', label: 'On, waiting for a first command' },
        { id: 'sending', label: 'Sending' },
        { id: 'problem', label: 'A problem (no lighting network, or send errors)' },
      ] }],
      callback: (fb) => outputIs(self.lighting, fb.options.state),
    },
  };
}

// --- variables ----------------------------------------------------------------------

export function lightingVariableDefs(l) {
  const defs = [
    { variableId: 'light_output', name: 'Lighting: output (off, dry run, sending, waiting, no network, send errors)' },
    { variableId: 'light_active', name: 'Lighting: the scene or look the lights are showing, or empty' },
    { variableId: 'light_all_pct', name: 'Lighting: average dimmer of all lights (%)' },
    { variableId: 'light_all_k', name: 'Lighting: average colour of all lights (K)' },
  ];
  for (const f of l?.fixtures ?? []) {
    const v = varId(f.id);
    defs.push(
      { variableId: `light_${v}_name`, name: `Lighting ${f.name}: name` },
      { variableId: `light_${v}_pct`, name: `Lighting ${f.name}: dimmer (%)` },
      { variableId: `light_${v}_k`, name: `Lighting ${f.name}: colour (K)` },
      { variableId: `light_${v}_dmx`, name: `Lighting ${f.name}: DMX values` },
    );
  }
  const slots = l?.scenes?.length ? l.scenes.map((s) => s.slot) : Array.from({ length: DEFAULT_SCENES }, (_, i) => i + 1);
  for (const n of slots) {
    defs.push(
      { variableId: `light_scene${n}_name`, name: `Lighting scene ${n}: name` },
      { variableId: `light_scene${n}_saved`, name: `Lighting scene ${n}: when it was saved, or "empty"` },
    );
  }
  return defs;
}

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14:32" today, "28 Oct" before. */
export function savedText(scene, now = new Date()) {
  if (!scene || scene.empty) return 'empty';
  const t = scene.savedAt ? new Date(scene.savedAt) : null;
  if (!t || Number.isNaN(t.getTime())) return 'saved';
  return t.toDateString() === now.toDateString() ? `${pad(t.getHours())}:${pad(t.getMinutes())}` : `${t.getDate()} ${MONTHS[t.getMonth()]}`;
}

export function outputText(l) {
  if (!l) return 'unknown';
  if (l.unavailable) return 'down';
  if (outputIs(l, 'problem')) return l.output.state === 'degraded' ? 'send errors' : 'no network';
  if (outputIs(l, 'waiting')) return 'waiting';
  return { off: 'off', 'dry-run': 'dry run', sending: 'sending' }[l.output?.state] ?? 'unknown';
}

export function lightingVariableValues(l) {
  const values = { light_output: outputText(l) };
  if (!l || l.unavailable) return values;
  const a = l.active;
  values.light_active = a?.type === 'look' ? (l.looks?.find((x) => x.id === a.id)?.name ?? a.id)
    : a?.type === 'scene' ? (l.scenes?.find((s) => s.slot === a.slot)?.name ?? `Scene ${a.slot}`) : '';
  const live = (l.fixtures ?? []).filter((f) => f.live);
  const avg = (p) => {
    const v = live.map((f) => f[p]).filter(Number.isFinite);
    return v.length ? Math.round(v.reduce((x, y) => x + y, 0) / v.length) : '';
  };
  values.light_all_pct = avg('intensity');
  values.light_all_k = avg('cct');
  for (const f of l.fixtures ?? []) {
    const v = varId(f.id);
    values[`light_${v}_name`] = f.name;
    values[`light_${v}_pct`] = Number.isFinite(f.intensity) ? Math.round(f.intensity) : '';
    values[`light_${v}_k`] = Number.isFinite(f.cct) ? Math.round(f.cct) : '';
    values[`light_${v}_dmx`] = f.dmx ? f.dmx.join(' ') : '';
  }
  for (const s of l.scenes ?? []) {
    values[`light_scene${s.slot}_name`] = s.name;
    values[`light_scene${s.slot}_saved`] = savedText(s);
  }
  return values;
}

// --- presets -------------------------------------------------------------------------

const press = (actionId, options) => [{ down: [{ actionId, options }], up: [] }];
const lookFeedback = (look) => [{ feedbackId: 'lightLookActive', options: { look }, style: { bgcolor: ACTIVE, color: BLACK } }];

export function buildLightingPresets(self) {
  const l = self.lighting;
  // A CamBridge without lighting (an older one, or lighting failed to start)
  // gets no lighting buttons to drag onto a page.
  if (!l || l.unavailable) return {};
  const fixtures = (l?.fixtures ?? []).filter((f) => f.live !== false);
  const slots = l?.scenes?.length ? l.scenes.map((s) => s.slot) : Array.from({ length: DEFAULT_SCENES }, (_, i) => i + 1);
  const p = {};
  const P5 = 'Lighting — page 5: on/off and Studio look';
  const P12 = 'Lighting — page 12: dimmers, colour and scenes';
  const P13 = 'Lighting — page 13: warmer / cooler';
  const STATUS = 'Lighting — output';

  // Page 5 (LIGHTS ON/OFF also sit on page 7).
  p.light_on = {
    type: 'button', category: P5, name: 'LIGHTS ON: every dimmer to 100 % over 1 s',
    style: style('LIGHTS\\nON', '18'),
    steps: press('lightSet', { target: 'all', what: 'intensity', intensity: 100, cct: 4400, fadeMs: 1000 }),
    feedbacks: [],
  };
  p.light_off = {
    type: 'button', category: P5, name: 'LIGHTS OFF: every dimmer to 0 over 1 s (colour unchanged)',
    style: style('LIGHTS\\nOFF', '18'),
    steps: press('lightSet', { target: 'all', what: 'intensity', intensity: 0, cct: 4400, fadeMs: 1000 }),
    feedbacks: [],
  };
  p.light_studio = {
    type: 'button', category: P5, name: 'STUDIO LOOK (protected) over 1 s',
    style: style('STUDIO\\nLOOK', '18'),
    steps: press('lightLook', { look: 'studio', fadeMs: 1000 }),
    feedbacks: lookFeedback('studio'),
  };
  p.light_studio_off = {
    type: 'button', category: P5, name: 'STUDIO OFF (protected) over 1 s',
    style: style('STUDIO\\nOFF', '18'),
    steps: press('lightLook', { look: 'off', fadeMs: 1000 }),
    feedbacks: lookFeedback('off'),
  };

  // Page 12.
  p.light_all_down = {
    type: 'button', category: P12, name: 'ALL − (every dimmer down 10 %)',
    style: style('ALL\\n−', '18'),
    steps: press('lightNudge', { target: 'all', param: 'intensity', amount: -NUDGE_PCT, fadeMs: 0 }),
    feedbacks: [],
  };
  p.light_all_up = {
    type: 'button', category: P12, name: 'ALL + (every dimmer up 10 %), shows the average',
    style: style('ALL +\\n$(cambridge:light_all_pct)%', '14'),
    steps: press('lightNudge', { target: 'all', param: 'intensity', amount: NUDGE_PCT, fadeMs: 0 }),
    feedbacks: [],
  };
  const cctPresets = (category, prefix) => {
    for (const k of CCT_PRESETS) {
      p[`${prefix}_${k}`] = {
        type: 'button', category, name: `Every light to ${k} K over 1 s`,
        style: style(`${k}K`, '18', { bgcolor: k <= 3200 ? WARM : k >= 5600 ? COOL : DARK }),
        steps: press('lightSet', { target: 'all', what: 'cct', intensity: 100, cct: k, fadeMs: 1000 }),
        feedbacks: [],
      };
    }
  };
  cctPresets(P12, 'light_cct');
  for (const f of fixtures) {
    const v = varId(f.id);
    const target = `fixture:${f.id}`;
    p[`light_${v}_down`] = {
      type: 'button', category: P12, name: `${f.name} − (dimmer down 10 %)`,
      style: style(`${f.name}\\n−`, '18'),
      steps: press('lightNudge', { target, param: 'intensity', amount: -NUDGE_PCT, fadeMs: 0 }),
      feedbacks: [],
    };
    p[`light_${v}_up`] = {
      type: 'button', category: P12, name: `${f.name} + (dimmer up 10 %), shows its level`,
      style: style(`${f.name} +\\n$(cambridge:light_${v}_pct)%`, '14'),
      steps: press('lightNudge', { target, param: 'intensity', amount: NUDGE_PCT, fadeMs: 0 }),
      feedbacks: [],
    };
    if (f.kelvin) {
      p[`light_${v}_k`] = {
        type: 'button', category: P12, name: `${f.name}: colour readout (does nothing when pressed)`,
        style: style(`${f.name}\\n$(cambridge:light_${v}_k)K`, '14'),
        steps: [{ down: [], up: [] }],
        feedbacks: [],
      };
    }
  }
  for (const n of slots) {
    // Tap: recall over 1 s, on release. Hold 5 s: save. Companion runs the
    // release actions only for a press shorter than the hold group, and runs
    // the 5 s group while the key is still held, so a save never also recalls.
    p[`light_scene${n}`] = {
      type: 'button', category: P12, name: `Scene ${n}: tap to recall (1 s), hold 5 s to save`,
      style: style(`$(cambridge:light_scene${n}_name)\\n$(cambridge:light_scene${n}_saved)`, '14'),
      steps: [{
        down: [],
        up: [{ actionId: 'lightSceneRecall', options: { slot: n, fadeMs: 1000 } }],
        [HOLD_TO_SAVE_MS]: { options: { runWhileHeld: true }, actions: [{ actionId: 'lightSceneSave', options: { slot: n } }] },
      }],
      feedbacks: [
        { feedbackId: 'lightSceneEmpty', options: { slot: n }, style: { color: DIM } },
        { feedbackId: 'lightSceneActive', options: { slot: n }, style: { bgcolor: ACTIVE, color: BLACK } },
      ],
    };
  }

  // Page 13.
  p.light_all_warmer = {
    type: 'button', category: P13, name: 'ALL WARMER (every light −300 K)',
    style: style('ALL\\nWARMER', '14', { bgcolor: WARM }),
    steps: press('lightNudge', { target: 'all', param: 'cct', amount: -NUDGE_K, fadeMs: 0 }),
    feedbacks: [],
  };
  p.light_all_cooler = {
    type: 'button', category: P13, name: 'ALL COOLER (every light +300 K)',
    style: style('ALL\\nCOOLER', '14', { bgcolor: COOL }),
    steps: press('lightNudge', { target: 'all', param: 'cct', amount: NUDGE_K, fadeMs: 0 }),
    feedbacks: [],
  };
  for (const f of fixtures.filter((x) => x.kelvin)) {
    const v = varId(f.id);
    const target = `fixture:${f.id}`;
    p[`light_${v}_warmer`] = {
      type: 'button', category: P13, name: `${f.name} warmer (−300 K), shows its colour`,
      style: style(`${f.name} WARM\\n$(cambridge:light_${v}_k)K`, '14', { bgcolor: WARM }),
      steps: press('lightNudge', { target, param: 'cct', amount: -NUDGE_K, fadeMs: 0 }),
      feedbacks: [],
    };
    p[`light_${v}_cooler`] = {
      type: 'button', category: P13, name: `${f.name} cooler (+300 K), shows its colour`,
      style: style(`${f.name} COOL\\n$(cambridge:light_${v}_k)K`, '14', { bgcolor: COOL }),
      steps: press('lightNudge', { target, param: 'cct', amount: NUDGE_K, fadeMs: 0 }),
      feedbacks: [],
    };
  }
  cctPresets(P13, 'light_cct13');

  // Output. The status key only shows: switching output is its own key, so a
  // stray press can never start CamBridge sending while Companion still is.
  p.light_output = {
    type: 'button', category: STATUS, name: 'Lighting output: state (does nothing when pressed)',
    style: style('LIGHTS\\n$(cambridge:light_output)', '14'),
    steps: [{ down: [], up: [] }],
    feedbacks: [
      { feedbackId: 'lightOutput', options: { state: 'sending' }, style: { bgcolor: combineRgb(40, 170, 80), color: WHITE } },
      { feedbackId: 'lightOutput', options: { state: 'dry-run' }, style: { bgcolor: AMBER, color: BLACK } },
      { feedbackId: 'lightOutput', options: { state: 'waiting' }, style: { bgcolor: AMBER, color: BLACK } },
      { feedbackId: 'lightOutput', options: { state: 'problem' }, style: { bgcolor: RED, color: WHITE } },
    ],
  };
  p.light_output_on = {
    type: 'button', category: STATUS, name: 'Lighting output ON — only once Companion\u2019s own sACN connection is off',
    style: style('LIGHT OUT\\nON', '14'),
    steps: press('lightOutput', { mode: 'on' }),
    feedbacks: [{ feedbackId: 'lightOutput', options: { state: 'sending' }, style: { bgcolor: combineRgb(40, 170, 80), color: WHITE } }],
  };
  p.light_output_off = {
    type: 'button', category: STATUS, name: 'Lighting output OFF (the lights keep their last state or do what they do when sACN stops)',
    style: style('LIGHT OUT\\nOFF', '14'),
    steps: press('lightOutput', { mode: 'off' }),
    feedbacks: [{ feedbackId: 'lightOutput', options: { state: 'off' }, style: { bgcolor: AMBER, color: BLACK } }],
  };
  return p;
}
