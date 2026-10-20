// The camera status a Stream Deck key shows: green standby, red recording,
// yellow error. Pure rule here; the feedback, variables and presets that use it
// are exercised through the real module in module.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cameraStatus } from '../src/status.js';

const cam = (over = {}) => ({
  id: 'fx3', label: 'Wide', state: 'connected',
  status: { recording: false, recordingFailed: false, recordingState: 0 },
  ...over,
});

test('connected and idle is standby; rolling is recording', () => {
  assert.deepEqual(cameraStatus(cam()), { status: 'standby', reason: '', text: 'STANDBY' });
  assert.deepEqual(cameraStatus(cam({ status: { recording: true, recordingState: 1 } })),
    { status: 'recording', reason: '', text: 'REC' });
});

test('a camera that is not connected is an error, with the reason in words', () => {
  const cases = {
    offline: 'offline',
    connecting: 'connecting',
    reconnecting: 'reconnecting',
    unauthorized: 'wrong password',
    identityChanged: 'identity changed — re-pair',
    unknown: 'state unknown',
  };
  for (const [state, reason] of Object.entries(cases)) {
    assert.deepEqual(cameraStatus(cam({ state })), { status: 'error', reason, text: 'ERROR' }, state);
  }
});

test('no link to CamBridge is an error: nothing about the camera is known', () => {
  assert.equal(cameraStatus(cam(), { linkUp: false }).status, 'error');
  assert.equal(cameraStatus(cam(), { linkUp: false }).reason, 'no link to CamBridge');
});

test('recording failed is an error, however the camera reports it', () => {
  assert.equal(cameraStatus(cam({ status: { recording: false, recordingFailed: true } })).reason, 'recording failed');
  assert.equal(cameraStatus(cam({ status: { recording: false, recordingState: 2 } })).reason, 'recording failed');
});

test('a critical alarm is an error; a warning is not', () => {
  const critical = [{ level: 'critical', code: 'media', message: 'card has 1m 30s left — swap it before the next take' }];
  const warn = [{ level: 'warn', code: 'battery', message: 'battery is at 25%' }];
  assert.deepEqual(cameraStatus(cam(), { alarms: critical }),
    { status: 'error', reason: critical[0].message, text: 'ERROR' });
  assert.equal(cameraStatus(cam(), { alarms: warn }).status, 'standby');
  // "Stopped recording on its own" is critical, so it is yellow too.
  assert.equal(cameraStatus(cam(), { alarms: [{ level: 'critical', code: 'recordDropped', message: 'stopped recording on its own' }] }).status, 'error');
});

test('a fault while rolling is yellow, but the text still says it is rolling', () => {
  const rolling = cam({ status: { recording: true, recordingState: 1 } });
  const alarms = [{ level: 'critical', code: 'media', message: 'card has 1m 30s left and is recording now' }];
  assert.deepEqual(cameraStatus(rolling, { alarms }), { status: 'error', reason: alarms[0].message, text: 'REC !' });
});

test('a stills body that cannot record is standby when connected', () => {
  const stills = cam({ kind: 'external', provider: 'gphoto2', status: { recording: null, recordingState: -1 } });
  assert.equal(cameraStatus(stills).status, 'standby');
  assert.equal(cameraStatus({ ...stills, state: 'offline' }).status, 'error');
});
