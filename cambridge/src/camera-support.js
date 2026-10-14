// Versioned provider/model metadata for the panel and future Wordtandem clients.
// The model list describes SDK compatibility. Live capabilities come from the
// connected device, never from a marketing name or the catalog's family.
import { readFileSync } from 'node:fs';
const catalog = JSON.parse(readFileSync(new URL('./camera-catalog.json', import.meta.url), 'utf8'));
const key = (s) => String(s ?? '').replace(/α/g, 'alpha').replace(/^sony\s*/i, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');
const models = new Map();
for (const profile of catalog.models) {
  for (const name of [profile.model, profile.name, ...profile.aliases]) models.set(key(name), profile);
}
export function cameraCatalog() { return structuredClone(catalog); }
export function modelSupport(model) {
  const p = models.get(key(model));
  return p ? { ...structuredClone(p), provider: catalog.provider, listedBySdk: true }
    : { model, name: model || 'Unknown Sony camera', provider: catalog.provider,
        family: 'Other', listedBySdk: false, verification: 'awaiting-hardware' };
}
export function cameraCapabilities(camera) {
  const connected = camera?.state === 'connected';
  const properties = connected ? camera.properties ?? {} : {};
  const writable = Object.keys(properties).filter((name) => properties[name]?.writable);
  const recordingState = camera?.status?.recordingState;
  return {
    schemaVersion: 1,
    provider: catalog.provider,
    availableProperties: Object.keys(properties), writableProperties: writable,
    record: { available: connected && [0, 1].includes(recordingState),
      reason: !connected ? 'Camera is offline' : ![0, 1].includes(recordingState)
        ? 'Camera has not reported a usable recording state' : null,
      verification: 'read-before-write-and-confirm' },
    pointFocus: { available: connected && ['afAreaPositionAFC', 'afAreaPositionAFS'].some((p) => writable.includes(p)),
      verification: 'property-reported; coordinate mapping requires hardware validation' },
    // These are command APIs, not properties; absence of a property cannot prove
    // their presence. Clients must use actual command/frame results.
    autofocus: { available: null, verification: 'probe-required' },
    liveView: { available: null, verification: 'frame-required' },
    panTilt: { available: false, reason: 'PTZ motion commands are not implemented' },
  };
}
