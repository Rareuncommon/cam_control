// Selecting a PTZ head, and banks of select keys.
//
// A hardware PTZ controller has one joystick and a row of camera buttons; press
// a button and the stick drives that head. With dozens of heads that is the only
// layout that fits on a Stream Deck, so the module keeps a selection of its own.
// It is deliberately local to this module instance: another Companion surface,
// the web panel or a second Stream Deck has its own selection.
//
// The state lives on the instance (selectedPtz, ptzBank); this file holds the
// pure helpers and the definitions that read it. Nothing here changes when a
// head pans, so none of it forces a definition rebuild.

import { combineRgb } from '@companion-module/base';
import {
  SELECTED, DIRECTIONS, PTZ_VARIABLES, ptzVariableValues, holdButton, padStyle,
} from './ptz.js';

const WHITE = combineRgb(255, 255, 255);
const BLACK = combineRgb(0, 0, 0);
const RED = combineRgb(200, 20, 30);
const AMBER = combineRgb(240, 160, 20);
const GREEN = combineRgb(40, 170, 80);
const BLUE = combineRgb(30, 90, 190);
const GREY = combineRgb(70, 70, 70);

export const DEFAULT_BANK_SIZE = 8;
export const MAX_BANK_SIZE = 32;

export const CONTROLLER_CATEGORY = 'PTZ controller';

// --- pure helpers ---------------------------------------------------------

/** Bank size from module config, kept to something a Stream Deck page can hold. */
export function bankSizeOf(config) {
  const n = Math.round(Number(config?.bankSize));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BANK_SIZE;
  return Math.min(MAX_BANK_SIZE, n);
}

export const bankCount = (total, size) => Math.max(1, Math.ceil(total / size));

/** The bank (0-based) a camera sits in, or 0 if it is not in the list. */
export function bankOf(list, id, size) {
  const i = list.findIndex((c) => c.id === id);
  return i < 0 ? 0 : Math.floor(i / size);
}

/** `size` entries for one bank: the camera in each slot, or null for an empty one. */
export function bankSlots(list, bank, size) {
  return Array.from({ length: size }, (_, i) => list[bank * size + i] ?? null);
}

/**
 * The camera after/before `currentId` in `list`, wrapping round. If the current
 * one is not in the list (a different group, or nothing selected) next is the
 * first and previous the last.
 */
export function stepSelection(list, currentId, direction) {
  if (!list.length) return null;
  const i = list.findIndex((c) => c.id === currentId);
  if (i < 0) return (direction < 0 ? list.at(-1) : list[0]).id;
  return list[(i + direction + list.length) % list.length].id;
}

/** Distinct group names, in the order the cameras first mention them. */
export function groupNames(cams) {
  return [...new Set(cams.map((c) => c.group).filter(Boolean))];
}

// --- variables ------------------------------------------------------------

export function selectionVariableDefs(bankSize) {
  const defs = [
    { variableId: 'ptz_selected', name: 'Selected PTZ camera (id)' },
    { variableId: 'ptz_selected_label', name: 'Selected PTZ camera: name' },
    { variableId: 'ptz_selected_group', name: 'Selected PTZ camera: group' },
    { variableId: 'ptz_selected_state', name: 'Selected PTZ camera: connection state' },
    { variableId: 'ptz_selected_tally', name: 'Selected PTZ camera: tally (PGM / PVW / off)' },
    ...PTZ_VARIABLES.map(([suffix, name]) => ({
      variableId: `ptz_selected_${suffix}`, name: `Selected PTZ camera: ${name}`,
    })),
    { variableId: 'ptz_bank', name: 'Camera bank shown (1-based)' },
    { variableId: 'ptz_bank_count', name: 'Number of camera banks' },
  ];
  for (let n = 1; n <= bankSize; n += 1) {
    defs.push({ variableId: `ptz_bank_slot_${n}_label`, name: `Camera bank slot ${n}: name` });
  }
  return defs;
}

/**
 * Selected-camera and bank values. Cheap on purpose (one camera and one bank
 * of labels), so it can be recomputed on every state frame.
 */
export function selectionVariableValues({ selected, list, bank, bankSize }) {
  const values = {
    ptz_selected: selected?.id ?? '',
    ptz_selected_label: selected ? (selected.label || selected.id) : '',
    ptz_selected_group: selected?.group ?? '',
    ptz_selected_state: selected?.state ?? '',
    ptz_selected_tally: !selected ? '' : selected.tally?.program ? 'PGM' : selected.tally?.preview ? 'PVW' : 'off',
    ptz_bank: bank + 1,
    ptz_bank_count: bankCount(list.length, bankSize),
  };
  if (selected) {
    for (const [k, v] of Object.entries(ptzVariableValues(selected, 'ptz_selected'))) values[k] = v;
  } else {
    for (const [suffix] of PTZ_VARIABLES) values[`ptz_selected_${suffix}`] = '';
  }
  bankSlots(list, bank, bankSize).forEach((cam, i) => {
    values[`ptz_bank_slot_${i + 1}_label`] = cam ? (cam.label || cam.id) : '';
  });
  return values;
}

// --- actions --------------------------------------------------------------

export function buildSelectionActions(self) {
  const cams = self.ptzCams;
  if (!cams.length) return {};
  // Not the "(selected camera)" entry: a select action names a real head.
  const realChoices = self.ptzCameraChoices().filter((c) => c.id !== SELECTED);
  const groups = [{ id: '', label: '(any group)' }, ...groupNames(cams).map((g) => ({ id: g, label: g }))];
  const when = (...modes) => `${modes.map((m) => `$(options:mode) == "${m}"`).join(' || ')}`;

  return {
    ptzSelect: {
      name: 'PTZ: select camera',
      description: 'Makes this the camera every "(selected camera)" PTZ action drives. A key held on the old camera is stopped first.',
      options: [
        {
          type: 'dropdown', id: 'mode', label: 'Select', default: 'camera',
          choices: [
            { id: 'camera', label: 'A camera' },
            { id: 'slot', label: 'Slot in the camera bank' },
            { id: 'next', label: 'Next camera' },
            { id: 'previous', label: 'Previous camera' },
          ],
        },
        {
          type: 'dropdown', id: 'camera', label: 'Camera', default: realChoices[0]?.id ?? '',
          choices: realChoices, isVisibleExpression: when('camera'),
        },
        {
          type: 'number', id: 'slot', label: 'Bank slot', default: 1, min: 1, max: MAX_BANK_SIZE,
          isVisibleExpression: when('slot'),
        },
        {
          type: 'dropdown', id: 'group', label: 'Only within group', default: '',
          choices: groups, isVisibleExpression: when('next', 'previous'),
        },
      ],
      callback: (ev) => {
        const { mode } = ev.options;
        if (mode === 'slot') return self.selectBankSlot(Number(ev.options.slot));
        if (mode === 'next' || mode === 'previous') {
          return self.stepPtz(mode === 'next' ? 1 : -1, ev.options.group || '');
        }
        return self.selectPtz(ev.options.camera);
      },
    },

    ptzBank: {
      name: 'PTZ: camera bank next / previous / go to',
      description: 'Changes which cameras the bank slot buttons show. It does not change the selected camera.',
      options: [
        {
          type: 'dropdown', id: 'mode', label: 'Action', default: 'next',
          choices: [
            { id: 'next', label: 'Next bank' },
            { id: 'previous', label: 'Previous bank' },
            { id: 'goto', label: 'Go to bank' },
          ],
        },
        {
          type: 'number', id: 'bank', label: 'Bank number', default: 1, min: 1, max: 99,
          isVisibleExpression: when('goto'),
        },
      ],
      callback: (ev) => self.moveBank(ev.options.mode, Number(ev.options.bank)),
    },
  };
}

// --- feedbacks ------------------------------------------------------------

export function buildSelectionFeedbacks(self) {
  const cams = self.ptzCams;
  if (!cams.length) return {};
  const realChoices = self.ptzCameraChoices().filter((c) => c.id !== SELECTED);
  const slotField = { type: 'number', id: 'slot', label: 'Bank slot', default: 1, min: 1, max: MAX_BANK_SIZE };
  const slotCam = (fb) => self.bankCamera(Number(fb.options.slot));

  return {
    ptzSelected: {
      name: 'PTZ: camera is selected',
      type: 'boolean',
      defaultStyle: { bgcolor: BLUE, color: WHITE },
      options: [{
        type: 'dropdown', id: 'camera', label: 'Camera', default: realChoices[0]?.id ?? '', choices: realChoices,
      }],
      callback: (fb) => fb.options.camera === self.selectedPtz,
    },

    ptzSlotSelected: {
      name: 'PTZ: camera in bank slot is selected',
      type: 'boolean',
      defaultStyle: { bgcolor: BLUE, color: WHITE },
      options: [slotField],
      callback: (fb) => !!slotCam(fb) && slotCam(fb).id === self.selectedPtz,
    },

    ptzSlotTally: {
      name: 'PTZ: camera in bank slot is on the switcher (tally)',
      type: 'boolean',
      defaultStyle: { bgcolor: RED, color: WHITE },
      options: [slotField, {
        type: 'dropdown', id: 'bus', label: 'Bus', default: 'program',
        choices: [
          { id: 'program', label: 'Program (live)' },
          { id: 'preview', label: 'Preview' },
          { id: 'either', label: 'Either' },
        ],
      }],
      callback: (fb) => {
        const t = slotCam(fb)?.tally;
        if (!t) return false;
        if (fb.options.bus === 'program') return !!t.program;
        if (fb.options.bus === 'preview') return !!t.preview;
        return !!(t.program || t.preview);
      },
    },

    ptzSlotOffline: {
      name: 'PTZ: camera in bank slot is not connected',
      type: 'boolean',
      defaultStyle: { bgcolor: GREY, color: combineRgb(150, 150, 150) },
      options: [slotField],
      callback: (fb) => {
        const cam = slotCam(fb);
        return !!cam && cam.state !== 'connected';
      },
    },
  };
}

// --- the "PTZ controller" button page --------------------------------------

/**
 * One page that drives every head: a row of select keys for the current bank,
 * bank next/previous, then pad, zoom, focus, presets 1-8 and STOP ALL, all on
 * the selected camera. Always present when there is a PTZ head, whether or not
 * the per-camera categories are turned off.
 */
export function buildControllerPresets(self) {
  const cams = self.ptzCams;
  if (!cams.length) return {};
  const presets = {};
  const category = CONTROLLER_CATEGORY;
  const sel = { camera: SELECTED };
  const release = { actionId: 'ptzRelease', options: sel };
  const tap = (text, name, actionId, options = sel, size = '18') => ({
    type: 'button', category, name, style: padStyle(text, size),
    steps: [{ down: [{ actionId, options }], up: [] }], feedbacks: [],
  });

  // Tally goes after "selected" so that being on air is never hidden behind blue.
  for (let n = 1; n <= self.bankSize; n += 1) {
    presets[`ctl_slot_${n}`] = {
      type: 'button',
      category,
      name: `Camera bank slot ${n}`,
      style: padStyle(`$(cambridge:ptz_bank_slot_${n}_label)`, '14'),
      steps: [{ down: [{ actionId: 'ptzSelect', options: { mode: 'slot', slot: n, camera: '', group: '' } }], up: [] }],
      feedbacks: [
        { feedbackId: 'ptzSlotOffline', options: { slot: n }, style: { bgcolor: GREY, color: combineRgb(150, 150, 150) } },
        { feedbackId: 'ptzSlotSelected', options: { slot: n }, style: { bgcolor: BLUE, color: WHITE } },
        { feedbackId: 'ptzSlotTally', options: { slot: n, bus: 'preview' }, style: { bgcolor: GREEN, color: WHITE } },
        { feedbackId: 'ptzSlotTally', options: { slot: n, bus: 'program' }, style: { bgcolor: RED, color: WHITE } },
      ],
    };
  }

  presets.ctl_bank_previous = tap('BANK\\n◀', 'Camera bank previous', 'ptzBank', { mode: 'previous', bank: 1 });
  presets.ctl_bank_next = tap('BANK\\n▶', 'Camera bank next', 'ptzBank', { mode: 'next', bank: 1 });
  presets.ctl_camera_previous = tap('CAM\\n◀', 'Select previous camera', 'ptzSelect',
    { mode: 'previous', slot: 1, camera: '', group: '' });
  presets.ctl_camera_next = tap('CAM\\n▶', 'Select next camera', 'ptzSelect',
    { mode: 'next', slot: 1, camera: '', group: '' });
  presets.ctl_selected = {
    type: 'button',
    category,
    name: 'Selected camera and bank',
    style: padStyle('$(cambridge:ptz_selected_label)\\nbank $(cambridge:ptz_bank)/$(cambridge:ptz_bank_count)', '14'),
    steps: [{ down: [], up: [] }],
    feedbacks: [],
  };
  presets.ctl_position = {
    type: 'button',
    category,
    name: 'Selected camera position',
    style: padStyle(
      'P $(cambridge:ptz_selected_pan) T $(cambridge:ptz_selected_tilt)\\nZ $(cambridge:ptz_selected_zoom)', '14'),
    steps: [{ down: [], up: [] }],
    feedbacks: [
      { feedbackId: 'ptzMoving', options: sel, style: { bgcolor: AMBER, color: BLACK } },
    ],
  };

  for (const d of DIRECTIONS) {
    presets[`ctl_${d.id}`] = holdButton(category, `Selected camera: ${d.label}`, d.glyph, '28',
      { actionId: 'ptzPanTilt', options: { ...sel, direction: d.id, speed: 50 } }, release);
  }
  presets.ctl_zoom_in = holdButton(category, 'Selected camera: zoom in', 'ZOOM\\n+', '18',
    { actionId: 'ptzZoom', options: { ...sel, direction: 'in', speed: 50 } }, release);
  presets.ctl_zoom_out = holdButton(category, 'Selected camera: zoom out', 'ZOOM\\n−', '18',
    { actionId: 'ptzZoom', options: { ...sel, direction: 'out', speed: 50 } }, release);
  presets.ctl_focus_near = holdButton(category, 'Selected camera: focus near', 'FOCUS\\nNEAR', '14',
    { actionId: 'ptzFocus', options: { ...sel, direction: 'near', speed: 50 } }, release);
  presets.ctl_focus_far = holdButton(category, 'Selected camera: focus far', 'FOCUS\\nFAR', '14',
    { actionId: 'ptzFocus', options: { ...sel, direction: 'far', speed: 50 } }, release);

  presets.ctl_home = tap('HOME', 'Selected camera: home', 'ptzHome');
  presets.ctl_af = tap('AF', 'Selected camera: one-push AF', 'ptzOnePushAf');
  if (cams.some((c) => c.capabilities?.tracking)) {
    presets.ctl_tracking = {
      ...tap('TRACK\\n$(cambridge:ptz_selected_tracking)', 'Selected camera: tracking', 'ptzTracking',
        { ...sel, mode: 'toggle' }, '14'),
      feedbacks: [{ feedbackId: 'ptzTracking', options: sel, style: { bgcolor: GREEN, color: WHITE } }],
    };
  }

  // Presets 1-8 numbered from the first head's base (they are 1 on every supported vendor).
  const base = cams.find((c) => c.capabilities?.presetBase !== undefined)?.capabilities.presetBase ?? 1;
  for (let i = 0; i < 8; i += 1) {
    const n = base + i;
    presets[`ctl_preset_${n}`] = {
      type: 'button',
      category,
      name: `Selected camera: preset ${n}`,
      style: padStyle(`PRESET\\n${n}`, '18'),
      steps: [{ down: [{ actionId: 'ptzPresetRecall', options: { ...sel, preset: n, byName: '' } }], up: [] }],
      feedbacks: [
        { feedbackId: 'ptzPresetCurrent', options: { ...sel, preset: n }, style: { bgcolor: BLUE, color: WHITE } },
      ],
    };
  }

  presets.ctl_stop_all = {
    type: 'button',
    category,
    name: 'STOP ALL',
    style: { text: 'STOP\\nALL', size: '18', color: WHITE, bgcolor: RED },
    steps: [{ down: [{ actionId: 'ptzStopAll', options: {} }], up: [] }],
    feedbacks: [{ feedbackId: 'ptzMoving', options: sel, style: { bgcolor: AMBER, color: BLACK } }],
  };

  return presets;
}
