// Alarm evaluation.
//
// The whole point of these being pure functions is that the interesting cases
// are literals rather than a rig, so the ones that matter — an unreported value
// misread as a bad one, a stale value from a dead camera — are cheap to pin.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluate, evaluateCamera, resolveThresholds, summarise, byCamera,
  humanDuration, DEFAULT_THRESHOLDS,
} from '../src/alarms.js';
import { StateModel } from '../src/state.js';

function camera(over = {}) {
  return {
    id: 'cam1',
    label: 'Wide',
    state: 'connected',
    detail: null,
    status: {
      battery: 90,
      media: '',
      mediaPresent: true,
      mediaSlot1Sec: 3600,
      mediaSlot2Sec: -1,
      recordingState: 0,
      recording: false,
      recordingFailed: false,
      recordDropped: false,
      ...(over.status ?? {}),
    },
    ...over,
  };
}

const codes = (alarms) => alarms.map((a) => a.code).sort();

test('a healthy camera raises nothing', () => {
  assert.deepEqual(evaluateCamera(camera()), []);
});

test('an unreported battery is not a flat battery', () => {
  // -1 means the camera did not say. Treating that as 0% would put every body
  // on mains power into permanent critical alarm.
  const alarms = evaluateCamera(camera({ status: { battery: -1 } }));
  assert.equal(alarms.length, 0);
});

test('an unreported card time is not a full card', () => {
  const alarms = evaluateCamera(camera({ status: { mediaSlot1Sec: -1 } }));
  assert.deepEqual(codes(alarms), []);
});

test('a card with no time left is critical, and says so differently while rolling', () => {
  const idle = evaluateCamera(camera({ status: { mediaSlot1Sec: 60 } }));
  assert.equal(idle[0].level, 'critical');
  assert.match(idle[0].message, /swap it before the next take/);

  const rolling = evaluateCamera(camera({ status: { mediaSlot1Sec: 60, recording: true } }));
  assert.equal(rolling[0].level, 'critical');
  assert.match(rolling[0].message, /recording now/);
});

test('a card between the thresholds warns rather than alarms', () => {
  const alarms = evaluateCamera(camera({ status: { mediaSlot1Sec: 10 * 60 } }));
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].level, 'warn');
  assert.equal(alarms[0].code, 'media');
});

test('battery crosses warn then critical', () => {
  assert.equal(evaluateCamera(camera({ status: { battery: 25 } }))[0].level, 'warn');
  assert.equal(evaluateCamera(camera({ status: { battery: 10 } }))[0].level, 'critical');
});

test('a disconnected camera reports only that, never its stale readings', () => {
  // The mirror keeps status across an outage. A body that dropped an hour ago
  // still carries the 8% battery it had then; reporting that as live invents a
  // present tense for a camera nobody can see.
  const alarms = evaluateCamera(camera({
    state: 'offline',
    detail: 'no route to host',
    status: { battery: 8, mediaSlot1Sec: 30 },
  }));
  assert.deepEqual(codes(alarms), ['offline']);
  assert.match(alarms[0].message, /no route to host/);
});

test('a camera with zero recording time left is critical', () => {
  const alarms = evaluateCamera(camera({ status: { mediaSlot1Sec: 0 } }));
  assert.deepEqual(codes(alarms), ['media']);
  assert.equal(alarms[0].level, 'critical');
  // Full card and empty slot are indistinguishable from here, so the message
  // offers both rather than asserting one.
  assert.match(alarms[0].message, /card full, or no card/);
});

test('mediaPresent=false alone never raises an alarm', () => {
  // It is a plain boolean: a camera that never reported media sends false, and
  // is not a camera with no card. Only the number is trusted.
  const alarms = evaluateCamera(camera({
    status: { mediaSlot1Sec: -1, mediaPresent: false },
  }));
  assert.deepEqual(codes(alarms), []);
});

test('an unexplained record stop is critical', () => {
  const alarms = evaluateCamera(camera({ status: { recordDropped: true } }));
  assert.deepEqual(codes(alarms), ['recordDropped']);
  assert.equal(alarms[0].level, 'critical');
});

test('a critical threshold above its warning threshold is clamped, not obeyed', () => {
  // Obeying it would mean the warning never fires and the first notice the
  // operator gets is the critical one — losing exactly the head start the
  // warning exists to give.
  const t = resolveThresholds({ batteryCriticalPct: 80, batteryWarnPct: 30 });
  assert.equal(t.batteryCriticalPct, 30);

  const alarms = evaluateCamera(camera({ status: { battery: 50 } }), t);
  assert.deepEqual(alarms, []);
});

test('alarms sort most severe first, and stably within a level', () => {
  const alarms = evaluate([
    camera({ id: 'c2', label: 'Tight', status: { battery: 25 } }),
    camera({ id: 'c1', label: 'Centre', status: { mediaSlot1Sec: 30 } }),
    camera({ id: 'c3', label: 'Aerial', status: { battery: 26 } }),
  ]);
  assert.equal(alarms[0].level, 'critical');
  assert.equal(alarms[0].cameraId, 'c1');
  // Two warnings, ordered by label so the list does not shuffle between pushes.
  assert.deepEqual(alarms.slice(1).map((a) => a.label), ['Aerial', 'Tight']);
});

test('the banner names the worst alarm and counts the rest', () => {
  const alarms = evaluate([
    camera({ id: 'c1', label: 'Centre', status: { mediaSlot1Sec: 30 } }),
    camera({ id: 'c2', label: 'Tight', status: { battery: 25 } }),
  ]);
  const s = summarise(alarms);
  assert.equal(s.level, 'critical');
  assert.equal(s.count, 2);
  assert.match(s.text, /^Centre card has/);
  assert.match(s.text, /1 other alarm$/);
});

test('nothing wrong means no banner at all', () => {
  // Not "all clear" — a permanent green bar trains people to stop looking.
  assert.equal(summarise([]), null);
  assert.equal(summarise(null), null);
});

test('alarms group by camera for per-card badges', () => {
  const grouped = byCamera(evaluate([
    camera({ id: 'c1', status: { battery: 10, mediaSlot1Sec: 30 } }),
  ]));
  assert.deepEqual(codes(grouped.c1), ['battery', 'media']);
});

test('durations read as a human would say them', () => {
  assert.equal(humanDuration(38), '38 s');
  assert.equal(humanDuration(240), '4 min');
  assert.equal(humanDuration(4320), '1 h 12 min');
  assert.equal(humanDuration(-1), '—');
});

// --- record intent, through the real state model ----------------------------

function connect(state, id = 'cam1') {
  state.applyConnectionState({ cameraId: id, state: 'connected' });
  return state;
}

test('a stop that was asked for is not a fault', () => {
  const state = connect(new StateModel());
  state.applyStatus({ cameraId: 'cam1', recording: true, recordingState: 1 });
  state.markRecordIntent('cam1', 'stop');
  state.applyStatus({ cameraId: 'cam1', recording: false, recordingState: 0 });

  assert.equal(state.get('cam1').status.recordDropped, false);
  assert.deepEqual(evaluateCamera(state.view().cameras[0]), []);
});

test('a stop nobody asked for is a fault', () => {
  const state = connect(new StateModel());
  state.applyStatus({ cameraId: 'cam1', recording: true, recordingState: 1 });
  state.applyStatus({ cameraId: 'cam1', recording: false, recordingState: 0 });

  assert.equal(state.get('cam1').status.recordDropped, true);
  assert.deepEqual(codes(evaluateCamera(state.view().cameras[0])), ['recordDropped']);
});

test('a stale stop intent does not excuse a much later drop', () => {
  const state = connect(new StateModel());
  state.applyStatus({ cameraId: 'cam1', recording: true, recordingState: 1 });
  // Asked to stop an hour ago, started again since, and now stopped on its own.
  state.markRecordIntent('cam1', 'stop', Date.now() - 3600_000);
  state.applyStatus({ cameraId: 'cam1', recording: false, recordingState: 0 });

  assert.equal(state.get('cam1').status.recordDropped, true);
});

test('a drop can be acknowledged, and stays acknowledged', () => {
  const state = connect(new StateModel());
  state.applyStatus({ cameraId: 'cam1', recording: true, recordingState: 1 });
  state.applyStatus({ cameraId: 'cam1', recording: false, recordingState: 0 });
  assert.equal(state.acknowledgeRecordDrop('cam1'), true);
  assert.equal(state.get('cam1').status.recordDropped, false);

  // A later status poll must not resurrect it.
  state.applyStatus({ cameraId: 'cam1', recording: false, recordingState: 0 });
  assert.equal(state.get('cam1').status.recordDropped, false);
  assert.equal(state.acknowledgeRecordDrop('cam1'), false);
});

test('a camera that vanishes mid-take is not accused of dropping the record', () => {
  // We cannot see whether it kept rolling on its own card. Guessing either way
  // is worse than saying so — and the reconnect must not raise a second alarm.
  const state = connect(new StateModel());
  state.applyStatus({ cameraId: 'cam1', recording: true, recordingState: 1 });
  state.applyConnectionState({ cameraId: 'cam1', state: 'offline', detail: 'link lost' });

  assert.equal(state.get('cam1').status.recordDropped, false);
  assert.equal(state.takes.at(-1).dropped, null);

  connect(state);
  state.applyStatus({ cameraId: 'cam1', recording: false, recordingState: 0 });
  assert.equal(state.get('cam1').status.recordDropped, false);
});

test('thresholds are the documented defaults unless configured', () => {
  assert.deepEqual(resolveThresholds(undefined), DEFAULT_THRESHOLDS);
  assert.equal(resolveThresholds({ mediaWarnSec: 1200 }).mediaWarnSec, 1200);
});
