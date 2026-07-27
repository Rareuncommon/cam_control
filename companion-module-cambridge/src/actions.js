// Companion actions.
//
// Built as a function of current state rather than defined once at init, because
// the camera list is discovered at runtime — a camera adopted in the CamBridge
// web panel should appear in Companion's dropdowns without anyone restarting
// anything.

import { STEPPABLE, nextValue, snap } from './step.js';

const RAMP_CHOICES = [
  { id: 0, label: 'Instant' },
  { id: 1000, label: '1 second' },
  { id: 2000, label: '2 seconds' },
  { id: 4000, label: '4 seconds' },
  { id: 8000, label: '8 seconds' },
];

const GROUP_CHOICES = [
  { id: 'exposure', label: 'Exposure' },
  { id: 'colour', label: 'White balance' },
  { id: 'look', label: 'Look (contrast/saturation/sharpness)' },
];

const MENU_KEYS = ['menu', 'up', 'down', 'left', 'right', 'set', 'back', 'display', 'capture']
  .map((k) => ({ id: k, label: k.toUpperCase() }));

export function buildActions(self) {
  const cameraChoices = self.cameraChoices();
  const cameraWithAll = [{ id: '__all__', label: 'All cameras' }, ...cameraChoices];
  const presetChoices = self.presetChoices();
  const sceneChoices = self.sceneChoices();

  const cameraField = (extra = {}) => ({
    type: 'dropdown',
    id: 'camera',
    label: 'Camera',
    default: cameraChoices[0]?.id ?? '',
    choices: cameraChoices,
    ...extra,
  });

  return {
    record: {
      name: 'Record: start / stop / toggle',
      options: [
        {
          type: 'dropdown', id: 'camera', label: 'Camera',
          default: '__all__', choices: cameraWithAll,
        },
        {
          type: 'dropdown', id: 'mode', label: 'Action', default: 'toggle',
          choices: [
            { id: 'toggle', label: 'Toggle' },
            { id: 'start', label: 'Start' },
            { id: 'stop', label: 'Stop' },
          ],
        },
      ],
      callback: async (ev) => {
        const { camera, mode } = ev.options;
        if (camera === '__all__') {
          // "Toggle all" is ambiguous when cameras disagree. Treat any camera
          // already rolling as "we are recording", so the button stops
          // everything rather than starting the stragglers — on a shoot that
          // is the safer reading of a single press.
          const anyRolling = self.cameras.some((c) => c.status?.recording);
          const start = mode === 'start' ? true : mode === 'stop' ? false : !anyRolling;
          return self.api.request('POST', '/api/record-all', { start });
        }
        const cam = self.camera(camera);
        if (!cam) return;
        const start = mode === 'start' ? true
          : mode === 'stop' ? false
            : !cam.status?.recording;
        return self.api.request(
          'POST', `/api/cameras/${encodeURIComponent(camera)}/actions/${start ? 'recordStart' : 'recordStop'}`);
      },
    },

    propStep: {
      name: 'Exposure: step a value up or down',
      options: [
        cameraField(),
        {
          type: 'dropdown', id: 'prop', label: 'Control', default: 'fNumber',
          choices: STEPPABLE.map((p) => ({ id: p.id, label: p.label })),
        },
        {
          type: 'dropdown', id: 'direction', label: 'Direction', default: '1',
          choices: [
            { id: '1', label: 'Up  (for Iris: more light)' },
            { id: '-1', label: 'Down  (for Iris: less light)' },
          ],
        },
        {
          type: 'number', id: 'steps', label: 'Steps', default: 1, min: 1, max: 20,
        },
      ],
      callback: async (ev) => {
        const { camera, prop, direction, steps } = ev.options;
        const cam = self.camera(camera);
        const property = cam?.properties?.[prop];
        const next = nextValue(property, prop, Number(direction), Number(steps) || 1);
        if (next === null) {
          // Silence here would look like a dead button. Say why nothing moved.
          self.log('debug', `${camera} ${prop}: already at the end of its range, or not adjustable now`);
          return;
        }
        return self.setProp(camera, prop, next);
      },
    },

    propSet: {
      name: 'Exposure: set an exact value',
      options: [
        cameraField(),
        {
          type: 'dropdown', id: 'prop', label: 'Control', default: 'colorTemp',
          choices: STEPPABLE.map((p) => ({ id: p.id, label: p.label })),
        },
        {
          type: 'textinput', id: 'value', label: 'Raw value (supports variables)',
          default: '5600', useVariables: true,
        },
        {
          type: 'checkbox', id: 'nearest', label: 'Snap to the nearest legal value', default: true,
        },
      ],
      callback: async (ev) => {
        const { camera, prop, nearest } = ev.options;
        const text = await self.parseVariablesInString(String(ev.options.value ?? ''));
        const wanted = Number(text);
        if (!Number.isFinite(wanted)) {
          self.log('warn', `"${text}" is not a number, ignoring`);
          return;
        }
        const property = self.camera(camera)?.properties?.[prop];
        return self.setProp(camera, prop, nearest ? snap(property, wanted) : wanted);
      },
    },

    autoManual: {
      name: 'Exposure: switch a parameter between Auto and Manual',
      options: [
        cameraField(),
        {
          type: 'dropdown', id: 'which', label: 'Parameter', default: 'irisMode',
          choices: [
            { id: 'irisMode', label: 'Iris' },
            { id: 'gainMode', label: 'ISO / gain' },
            { id: 'shutterMode', label: 'Shutter' },
          ],
        },
        {
          type: 'dropdown', id: 'mode', label: 'Mode', default: '2',
          choices: [
            { id: '2', label: 'Manual' },
            { id: '1', label: 'Auto' },
            { id: 'toggle', label: 'Toggle' },
          ],
        },
      ],
      callback: async (ev) => {
        const { camera, which, mode } = ev.options;
        let value;
        if (mode === 'toggle') {
          const current = self.camera(camera)?.properties?.[which]?.raw;
          value = current === 1 ? 2 : 1;
        } else {
          value = Number(mode);
        }
        return self.setProp(camera, which, value);
      },
    },

    autofocus: {
      name: 'Focus: trigger autofocus',
      options: [cameraField()],
      callback: (ev) =>
        self.api.request('POST', `/api/cameras/${encodeURIComponent(ev.options.camera)}/actions/autofocus`),
    },

    focusNudge: {
      name: 'Focus: nudge nearer or further',
      options: [
        cameraField(),
        { type: 'number', id: 'steps', label: 'Steps (negative = nearer)', default: 10, min: -100, max: 100 },
      ],
      callback: (ev) =>
        self.api.request('POST', `/api/cameras/${encodeURIComponent(ev.options.camera)}/actions/focusNudge`,
          { steps: Number(ev.options.steps) || 0 }),
    },

    presetRecall: {
      name: 'Preset: recall on one camera',
      options: [
        cameraField(),
        {
          type: 'dropdown', id: 'preset', label: 'Preset', default: presetChoices[0]?.id ?? '',
          choices: presetChoices, allowCustom: true,
        },
        { type: 'dropdown', id: 'ramp', label: 'Transition', default: 0, choices: RAMP_CHOICES },
        {
          type: 'multidropdown', id: 'groups', label: 'Recall only (leave empty for everything)',
          default: [], choices: GROUP_CHOICES,
        },
      ],
      callback: async (ev) => {
        const { camera, preset, ramp, groups } = ev.options;
        if (!preset) return;
        return self.api.request(
          'POST', `/api/cameras/${encodeURIComponent(camera)}/presets/${encodeURIComponent(preset)}`,
          { transitionMs: Number(ramp) || 0, only: self.groupProps(groups) });
      },
    },

    presetSave: {
      name: 'Preset: save the camera as it is now',
      options: [
        cameraField(),
        { type: 'textinput', id: 'preset', label: 'Preset name', default: '', useVariables: true },
      ],
      callback: async (ev) => {
        const name = (await self.parseVariablesInString(String(ev.options.preset ?? ''))).trim();
        if (!name) return;
        const r = await self.api.request(
          'PUT', `/api/cameras/${encodeURIComponent(ev.options.camera)}/presets/${encodeURIComponent(name)}`);
        await self.refreshPresetLists();
        return r;
      },
    },

    sceneRecall: {
      name: 'Scene: recall every camera at once',
      options: [
        {
          type: 'dropdown', id: 'scene', label: 'Scene', default: sceneChoices[0]?.id ?? '',
          choices: sceneChoices, allowCustom: true,
        },
        { type: 'dropdown', id: 'ramp', label: 'Transition', default: 0, choices: RAMP_CHOICES },
        {
          type: 'multidropdown', id: 'groups', label: 'Recall only (leave empty for everything)',
          default: [], choices: GROUP_CHOICES,
        },
      ],
      callback: async (ev) => {
        const { scene, ramp, groups } = ev.options;
        if (!scene) return;
        return self.api.request('POST', `/api/scenes/${encodeURIComponent(scene)}`,
          { transitionMs: Number(ramp) || 0, only: self.groupProps(groups) });
      },
    },

    sceneSave: {
      name: 'Scene: save every camera as they are now',
      options: [
        { type: 'textinput', id: 'scene', label: 'Scene name', default: '', useVariables: true },
      ],
      callback: async (ev) => {
        const name = (await self.parseVariablesInString(String(ev.options.scene ?? ''))).trim();
        if (!name) return;
        const r = await self.api.request('PUT', `/api/scenes/${encodeURIComponent(name)}`);
        await self.refreshPresetLists();
        return r;
      },
    },

    match: {
      name: 'Match: copy exposure and colour from one camera to the others',
      options: [cameraField({ label: 'Reference camera' })],
      callback: (ev) => self.api.request('POST', '/api/match', { reference: ev.options.camera }),
    },

    gang: {
      name: 'Link: enable or disable ganged cameras',
      options: [
        { type: 'textinput', id: 'gang', label: 'Link name', default: 'main' },
        {
          type: 'dropdown', id: 'mode', label: 'Action', default: 'toggle',
          choices: [
            { id: 'toggle', label: 'Toggle' },
            { id: 'on', label: 'Enable' },
            { id: 'off', label: 'Disable' },
          ],
        },
      ],
      callback: async (ev) => {
        const name = ev.options.gang || 'main';
        const current = self.gangs?.[name]?.enabled ?? false;
        const enabled = ev.options.mode === 'on' ? true
          : ev.options.mode === 'off' ? false
            : !current;
        const r = await self.api.request('POST', `/api/gangs/${encodeURIComponent(name)}`, { enabled });
        await self.refreshPresetLists();
        return r;
      },
    },

    menuKey: {
      name: 'Camera menu: press a key on the body',
      options: [
        cameraField(),
        { type: 'dropdown', id: 'key', label: 'Key', default: 'menu', choices: MENU_KEYS },
      ],
      callback: (ev) =>
        self.api.request('POST', `/api/cameras/${encodeURIComponent(ev.options.camera)}/actions/key`,
          { key: ev.options.key }),
    },

    reconnect: {
      name: 'Camera: reconnect',
      options: [cameraField()],
      callback: (ev) =>
        self.api.request('POST', `/api/cameras/${encodeURIComponent(ev.options.camera)}/actions/reconnect`),
    },
  };
}
