import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraCatalog, modelSupport, cameraCapabilities } from '../src/camera-support.js';

test('all 32 catalog models and their aliases resolve without making hardware claims', () => {
  const c = cameraCatalog();
  assert.equal(c.models.length, 32);
  assert.equal(new Set(c.models.map(p => p.model)).size, 32);
  for (const p of c.models) for (const alias of [p.model, p.name, ...p.aliases]) {
    assert.equal(modelSupport(alias).model, p.model, alias);
    assert.ok(['historical-rig-use', 'awaiting-hardware'].includes(p.verification));
  }
  c.models.pop();
  assert.equal(cameraCatalog().models.length, 32);
});
test('future SDK models remain eligible without claiming catalog validation', () => {
  assert.equal(modelSupport('ILCE-FUTURE').listedBySdk, false);
  assert.equal(modelSupport('ILCE-FUTURE').verification, 'awaiting-hardware');
});
test('capabilities reflect live properties and exact recording states, never model names', () => {
  const cam = { model: 'ILME-FX6', state: 'connected', properties: {
    fNumber: { writable: true }, isoSensitivity: { writable: false },
  }, status: { recordingState: -1 } };
  let c = cameraCapabilities(cam);
  assert.deepEqual(c.writableProperties, ['fNumber']);
  assert.equal(c.record.available, false);
  assert.equal(c.panTilt.available, false);
  for (const state of [-1, 2, 3, undefined]) {
    cam.status.recordingState = state;
    assert.equal(cameraCapabilities(cam).record.available, false);
  }
  for (const state of [0, 1]) {
    cam.status.recordingState = state;
    assert.equal(cameraCapabilities(cam).record.available, true);
  }
  cam.state = 'disconnected';
  c = cameraCapabilities(cam);
  assert.equal(c.record.available, false);
  assert.deepEqual(c.availableProperties, []);
});
