// One word for the state of a camera: what a status key on the Stream Deck shows.
//
// Green, red, yellow — standby, recording, error. Three states and no more,
// because a key read in a glance mid-song has room for three. Everything that
// needs someone to go and look at the camera is an error: it is not connected,
// it says recording failed, or CamBridge has a critical alarm for it (card full
// or nearly, battery critical, a recording that stopped on its own). Warnings
// — a card getting low — stay off the colour; they have their own alarm keys.
//
// An error wins over recording, so the colour always says "look", but the
// text keeps saying REC: a yellow key must never hide that a camera is rolling.

const STATE_REASON = {
  offline: 'offline',
  connecting: 'connecting',
  reconnecting: 'reconnecting',
  unauthorized: 'wrong password',
  identityChanged: 'identity changed — re-pair',
  unknown: 'state unknown',
};

/** Sony's recordingState value for "Recording Failed". */
const RECORDING_FAILED = 2;

/**
 * @param {object} cam   a camera as CamBridge sends it
 * @param {{linkUp?: boolean, alarms?: Array<{level: string, message: string}>}} [o]
 *   `alarms` is this camera's entry in alarmsByCamera
 * @returns {{status: 'standby'|'recording'|'error', reason: string, text: string}}
 */
export function cameraStatus(cam, { linkUp = true, alarms = [] } = {}) {
  const rolling = cam?.status?.recording === true;
  const error = (reason) => ({ status: 'error', reason, text: rolling ? 'REC !' : 'ERROR' });

  if (!cam) return error('no such camera');
  if (!linkUp) return error('no link to CamBridge');
  if (cam.state !== 'connected') return error(STATE_REASON[cam.state] ?? String(cam.state ?? 'state unknown'));
  if (cam.status?.recordingFailed || cam.status?.recordingState === RECORDING_FAILED) {
    return error('recording failed');
  }
  const critical = (alarms ?? []).find((a) => a.level === 'critical');
  if (critical) return error(critical.message);

  return rolling
    ? { status: 'recording', reason: '', text: 'REC' }
    : { status: 'standby', reason: '', text: 'STANDBY' };
}
