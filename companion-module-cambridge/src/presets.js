// Ready-made buttons, so a new Stream Deck page is drag-and-drop rather than a
// build-it-yourself exercise. Each one already carries the feedback that makes
// it readable — a record button that does not go red is only half a button.

import { combineRgb } from '@companion-module/base';
import { varId } from './variables.js';
import { buildPtzPresets } from './ptz.js';
import { buildControllerPresets } from './select.js';
import { STATUS_STYLE } from './feedbacks.js';

const WHITE = combineRgb(255, 255, 255);
const BLACK = combineRgb(0, 0, 0);
const DARK = combineRgb(20, 22, 26);
const RED = combineRgb(200, 20, 30);
const AMBER = combineRgb(240, 160, 20);

const base = (text, size = '14') => ({
  text, size, color: WHITE, bgcolor: DARK,
});

/** Green standby, red recording, yellow error — the same on every key that shows a camera's status. */
const statusFeedbacks = (camera) => ['standby', 'recording', 'error'].map((status) => ({
  feedbackId: 'cameraStatus', options: { camera, status }, style: STATUS_STYLE[status],
}));

export function buildPresets(self) {
  const presets = {};

  presets.record_all = {
    type: 'button',
    category: 'Record',
    name: 'Record all / stop all',
    style: base('REC\\nALL', '18'),
    steps: [{ down: [{ actionId: 'record', options: { camera: '__all__', mode: 'toggle' } }], up: [] }],
    feedbacks: [
      { feedbackId: 'anyRecording', options: {}, style: { bgcolor: RED, color: WHITE } },
    ],
  };

  presets.daemon_health = {
    type: 'button',
    category: 'Status',
    name: 'CamBridge health',
    style: base('$(cambridge:connected_count)/$(cambridge:camera_count)\\nup', '14'),
    steps: [{ down: [], up: [] }],
    feedbacks: [
      { feedbackId: 'anyCameraDown', options: {}, style: { bgcolor: AMBER, color: BLACK } },
      { feedbackId: 'camdDown', options: {}, style: { bgcolor: RED, color: WHITE } },
    ],
  };
  // Status, record, exposure and focus buttons are for cinema bodies; PTZ heads get tally here and their own set in ptz.js.
  for (const cam of self.cameras) {
    const v = varId(cam.id);
    const name = cam.label || cam.id;
    const opts = { camera: cam.id };
    if (cam.kind !== 'ptz') {
      // Shows the camera's state and does nothing when pressed, so it can sit
      // anywhere on a page without a stray press starting or stopping a take.
      presets[`camstatus_${v}`] = {
        type: 'button',
        category: 'Camera status',
        name: `${name}: status (green standby / red recording / yellow error)`,
        style: base(`$(cambridge:${v}_label)\\n$(cambridge:${v}_status)`, '14'),
        steps: [{ down: [], up: [] }],
        feedbacks: statusFeedbacks(cam.id),
      };

      presets[`record_${v}`] = {
        type: 'button',
        category: 'Record',
        name: `${name}: record toggle`,
        style: base(`$(cambridge:${v}_label)\\n$(cambridge:${v}_status)`),
        steps: [{ down: [{ actionId: 'record', options: { ...opts, mode: 'toggle' } }], up: [] }],
        feedbacks: statusFeedbacks(cam.id),
      };
    }

    // At a big venue the PTZ heads' own categories are off; tally lives on the controller page's keys.
    if (cam.kind === 'ptz' && !self.ptzPerCameraPresets) continue;

    presets[`tally_${v}`] = {
      type: 'button',
      category: 'Tally',
      name: `${name}: tally`,
      style: base(`$(cambridge:${v}_label)\\n$(cambridge:${v}_tally)`),
      steps: [{ down: [], up: [] }],
      feedbacks: [
        { feedbackId: 'tally', options: { ...opts, bus: 'program' }, style: { bgcolor: RED, color: WHITE } },
        { feedbackId: 'tally', options: { ...opts, bus: 'preview' },
          style: { bgcolor: combineRgb(40, 140, 60), color: WHITE } },
      ],
    };

    if (cam.kind === 'ptz') continue;

    presets[`iris_open_${v}`] = {
      type: 'button',
      category: `${name} — exposure`,
      name: `${name}: iris open`,
      style: base(`${name}\\nIRIS +\\n$(cambridge:${v}_iris)`, '14'),
      steps: [{
        down: [{ actionId: 'propStep', options: { ...opts, prop: 'fNumber', direction: '1', steps: 1 } }],
        up: [],
      }],
      feedbacks: [
        { feedbackId: 'autoMode', options: { ...opts, which: 'irisMode' },
          style: { bgcolor: AMBER, color: BLACK } },
      ],
    };

    presets[`iris_close_${v}`] = {
      type: 'button',
      category: `${name} — exposure`,
      name: `${name}: iris close`,
      style: base(`${name}\\nIRIS −\\n$(cambridge:${v}_iris)`, '14'),
      steps: [{
        down: [{ actionId: 'propStep', options: { ...opts, prop: 'fNumber', direction: '-1', steps: 1 } }],
        up: [],
      }],
      feedbacks: [
        { feedbackId: 'autoMode', options: { ...opts, which: 'irisMode' },
          style: { bgcolor: AMBER, color: BLACK } },
      ],
    };

    presets[`iso_up_${v}`] = {
      type: 'button',
      category: `${name} — exposure`,
      name: `${name}: ISO up`,
      style: base(`${name}\\nISO +\\n$(cambridge:${v}_iso)`, '14'),
      steps: [{
        down: [{ actionId: 'propStep', options: { ...opts, prop: 'isoSensitivity', direction: '1', steps: 1 } }],
        up: [],
      }],
      feedbacks: [],
    };

    presets[`iso_down_${v}`] = {
      type: 'button',
      category: `${name} — exposure`,
      name: `${name}: ISO down`,
      style: base(`${name}\\nISO −\\n$(cambridge:${v}_iso)`, '14'),
      steps: [{
        down: [{ actionId: 'propStep', options: { ...opts, prop: 'isoSensitivity', direction: '-1', steps: 1 } }],
        up: [],
      }],
      feedbacks: [],
    };

    presets[`af_${v}`] = {
      type: 'button',
      category: `${name} — focus`,
      name: `${name}: autofocus`,
      style: base(`${name}\\nAF`, '18'),
      steps: [{ down: [{ actionId: 'autofocus', options: opts }], up: [] }],
      feedbacks: [],
    };

    presets[`status_${v}`] = {
      type: 'button',
      category: 'Status',
      name: `${name}: at a glance`,
      style: base(
        `$(cambridge:${v}_label)\\n$(cambridge:${v}_iris) $(cambridge:${v}_iso)\\n` +
        `$(cambridge:${v}_battery)`, '14'),
      steps: [{ down: [], up: [] }],
      feedbacks: statusFeedbacks(cam.id),
    };
  }

  for (const scene of self.scenes) {
    presets[`scene_${varId(scene)}`] = {
      type: 'button',
      category: 'Scenes',
      name: `Scene: ${scene}`,
      style: base(scene, '14'),
      steps: [{
        down: [{ actionId: 'sceneRecall', options: { scene, ramp: 0, groups: [] } }],
        up: [],
      }],
      feedbacks: [],
    };
  }

  return { ...presets, ...buildPtzPresets(self), ...buildControllerPresets(self) };
}
