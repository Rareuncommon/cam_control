// Companion feedbacks — what the buttons *show*.
//
// This is the half that matters during a shoot. Pressing record is easy; the
// question an operator actually has, mid-song, glancing down, is "is that camera
// rolling, and is it still alive". A button that answers that without being
// pressed is worth more than any action here.

import { combineRgb } from '@companion-module/base';

const WHITE = combineRgb(255, 255, 255);
const BLACK = combineRgb(0, 0, 0);
const RED = combineRgb(200, 20, 30);
const AMBER = combineRgb(240, 160, 20);
const GREEN = combineRgb(40, 170, 80);
const GREY = combineRgb(70, 70, 70);

export function buildFeedbacks(self) {
  const cameraChoices = self.cameraChoices();
  const cameraField = (extra = {}) => ({
    type: 'dropdown',
    id: 'camera',
    label: 'Camera',
    default: cameraChoices[0]?.id ?? '',
    choices: cameraChoices,
    ...extra,
  });

  return {
    recording: {
      name: 'Camera is recording',
      type: 'boolean',
      defaultStyle: { bgcolor: RED, color: WHITE },
      options: [cameraField()],
      callback: (fb) => !!self.camera(fb.options.camera)?.status?.recording,
    },

    anyRecording: {
      name: 'Any camera is recording',
      type: 'boolean',
      defaultStyle: { bgcolor: RED, color: WHITE },
      options: [],
      callback: () => self.cameras.some((c) => c.status?.recording),
    },

    allRecording: {
      name: 'Every connected camera is recording',
      type: 'boolean',
      defaultStyle: { bgcolor: RED, color: WHITE },
      options: [],
      callback: () => {
        const live = self.cameras.filter((c) => c.state === 'connected');
        return live.length > 0 && live.every((c) => c.status?.recording);
      },
    },

    recordingFailed: {
      name: 'Camera reports RECORDING FAILED',
      type: 'boolean',
      // Amber, not red: red already means "rolling", and this must not be
      // mistaken for it. This is the one that means go and look at the camera.
      defaultStyle: { bgcolor: AMBER, color: BLACK },
      options: [cameraField()],
      callback: (fb) => !!self.camera(fb.options.camera)?.status?.recordingFailed,
    },

    cameraState: {
      name: 'Camera connection state',
      type: 'boolean',
      defaultStyle: { bgcolor: GREY, color: WHITE },
      options: [
        cameraField(),
        {
          type: 'dropdown', id: 'state', label: 'Is in state', default: 'connected',
          choices: [
            { id: 'connected', label: 'Connected' },
            { id: 'connecting', label: 'Connecting' },
            { id: 'reconnecting', label: 'Reconnecting' },
            { id: 'unauthorized', label: 'Wrong password' },
            { id: 'offline', label: 'Offline' },
            { id: '__notok__', label: 'Anything other than connected' },
          ],
        },
      ],
      callback: (fb) => {
        const cam = self.camera(fb.options.camera);
        if (!cam) return false;
        if (fb.options.state === '__notok__') return cam.state !== 'connected';
        return cam.state === fb.options.state;
      },
    },

    anyCameraDown: {
      name: 'Any camera is not connected',
      type: 'boolean',
      defaultStyle: { bgcolor: AMBER, color: BLACK },
      options: [],
      callback: () => self.cameras.some((c) => c.state !== 'connected'),
    },

    camdDown: {
      name: 'CamBridge daemon is unreachable',
      type: 'boolean',
      defaultStyle: { bgcolor: AMBER, color: BLACK },
      options: [],
      callback: () => !self.camdConnected,
    },

    // --- shoot alarms ---
    // Evaluated by CamBridge and shipped with the state, so a Stream Deck key
    // and the panel banner cannot disagree about whether a card is nearly full.

    cameraAlarm: {
      name: 'Camera has an alarm (card, battery, dropped record)',
      type: 'boolean',
      defaultStyle: { bgcolor: RED, color: WHITE },
      options: [
        cameraField(),
        {
          type: 'dropdown', id: 'level', label: 'At least', default: 'warn',
          choices: [
            { id: 'warn', label: 'Warning or worse' },
            { id: 'critical', label: 'Critical only' },
          ],
        },
        {
          type: 'dropdown', id: 'code', label: 'Of kind', default: 'any',
          choices: [
            { id: 'any', label: 'Any alarm' },
            { id: 'media', label: 'Card running out' },
            { id: 'battery', label: 'Battery low' },
            { id: 'recordDropped', label: 'Stopped recording on its own' },
            { id: 'recordFailed', label: 'Recording failed' },
            { id: 'offline', label: 'Offline' },
          ],
        },
      ],
      callback: (fb) => {
        const list = self.alarmsByCamera?.[fb.options.camera] ?? [];
        return list.some((a) =>
          (fb.options.code === 'any' || a.code === fb.options.code)
          && (fb.options.level !== 'critical' || a.level === 'critical'));
      },
    },

    anyAlarm: {
      name: 'Any camera has an alarm',
      type: 'boolean',
      defaultStyle: { bgcolor: RED, color: WHITE },
      options: [
        {
          type: 'dropdown', id: 'level', label: 'At least', default: 'critical',
          choices: [
            { id: 'warn', label: 'Warning or worse' },
            { id: 'critical', label: 'Critical only' },
          ],
        },
      ],
      callback: (fb) => (self.alarms ?? []).some(
        (a) => fb.options.level !== 'critical' || a.level === 'critical'),
    },

    partiallyRolling: {
      name: 'Some but not all cameras are rolling',
      // The state nobody wants and everybody has been in: two cameras rolling,
      // one not, and no way to see it without checking each button. Amber
      // because red already means recording.
      type: 'boolean',
      defaultStyle: { bgcolor: AMBER, color: BLACK },
      options: [],
      callback: () => !!self.roll?.some,
    },

    propValue: {
      name: 'Exposure value is / above / below',
      type: 'boolean',
      defaultStyle: { bgcolor: GREEN, color: WHITE },
      options: [
        cameraField(),
        {
          type: 'dropdown', id: 'prop', label: 'Control', default: 'colorTemp',
          choices: self.propChoices(),
        },
        {
          type: 'dropdown', id: 'op', label: 'Comparison', default: 'eq',
          choices: [
            { id: 'eq', label: 'is exactly' },
            { id: 'gte', label: 'is at or above' },
            { id: 'lte', label: 'is at or below' },
          ],
        },
        { type: 'textinput', id: 'value', label: 'Raw value', default: '5600', useVariables: false },
      ],
      callback: (fb) => {
        const raw = self.camera(fb.options.camera)?.properties?.[fb.options.prop]?.raw;
        const want = Number(fb.options.value);
        if (!Number.isFinite(raw) || !Number.isFinite(want)) return false;
        if (fb.options.op === 'gte') return raw >= want;
        if (fb.options.op === 'lte') return raw <= want;
        return raw === want;
      },
    },

    autoMode: {
      name: 'Exposure parameter is on Auto',
      type: 'boolean',
      defaultStyle: { bgcolor: AMBER, color: BLACK },
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
      ],
      callback: (fb) => self.camera(fb.options.camera)?.properties?.[fb.options.which]?.raw === 1,
    },

    tally: {
      name: 'Camera is on the switcher (tally)',
      type: 'boolean',
      defaultStyle: { bgcolor: RED, color: WHITE },
      options: [
        cameraField(),
        {
          type: 'dropdown', id: 'bus', label: 'Bus', default: 'program',
          choices: [
            { id: 'program', label: 'Program (live)' },
            { id: 'preview', label: 'Preview' },
            { id: 'either', label: 'Either' },
          ],
        },
      ],
      callback: (fb) => {
        const t = self.camera(fb.options.camera)?.tally;
        if (!t) return false;
        if (fb.options.bus === 'program') return !!t.program;
        if (fb.options.bus === 'preview') return !!t.preview;
        return !!(t.program || t.preview);
      },
    },

    gangEnabled: {
      name: 'Cameras are linked',
      type: 'boolean',
      defaultStyle: { bgcolor: GREEN, color: WHITE },
      options: [{ type: 'textinput', id: 'gang', label: 'Link name', default: 'main' }],
      callback: (fb) => !!self.gangs?.[fb.options.gang || 'main']?.enabled,
    },
  };
}
