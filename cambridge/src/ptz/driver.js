// The driver contract: what each vendor module has to provide.
//
// Drivers are protocol only. They turn "pan left at half speed" or "set the
// knee point" into the bytes one camera model expects, and turn its replies
// back into values. They hold no timers, decide nothing about retries,
// heartbeats or reconnection, and never talk to the rest of CamBridge — the
// lifecycle (lifecycle.js) does all of that, the same way for every vendor.
//
// That split is the same one camd and cambridge have: the part that knows the
// wire stays dumb, and policy lives in one place.
//
// The lifecycle calls a driver one command at a time, through the camera's
// queue, so a driver may assume nothing else is talking to the camera on its
// behalf while a method runs.

/**
 * Thrown by a driver when the camera answered and said no.
 *
 * Distinct from a timeout or a dropped connection: a refusal is information
 * ("not in this mode", "out of range") and must not count against the
 * camera's health. Only a failed heartbeat marks a camera offline.
 */
export class DriverError extends Error {
  /**
   * @param {string} message  in words an operator can act on
   * @param {{code?: string, kind?: 'refused'|'auth'|'timeout'|'network'|'unsupported'}} [o]
   */
  constructor(message, { code, kind = 'refused' } = {}) {
    super(message);
    this.code = code;
    this.kind = kind;
  }
}

/**
 * Base class with the defaults most drivers want. Vendor drivers extend this
 * and override what their camera supports.
 *
 * Static members (on the class, not the instance):
 *   vendor          'panasonic' | 'sony' | 'ptzoptics' | 'canon' | 'fake'
 *   label           shown in Setup: 'Panasonic'
 *   models          model names this driver has a table for
 *   minIntervalMs   the gap the vendor asks for between commands
 *   probe(ctx)      async; identify a camera at ctx.host or return null.
 *                   Must be cheap, must not move anything, must not change
 *                   any setting. Used by add-by-IP to pick the driver.
 *
 * ctx (constructor and probe):
 *   host, port?, auth: { username, password }, http (./http.js request),
 *   log(level, msg), timeoutMs, options (from the camera's config entry)
 */
export class PtzDriver {
  static vendor = 'unknown';
  static label = 'Unknown';
  static models = [];
  static minIntervalMs = 0;

  // eslint-disable-next-line no-unused-vars
  static async probe(ctx) { return null; }

  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
    this.auth = ctx.auth ?? {};
    this.http = ctx.http;
    this.log = ctx.log ?? (() => {});
  }

  /** @returns {Promise<{vendor: string, model: string, firmware?: string, serial?: string, mac?: string, name?: string}>} */
  async identify() { throw new DriverError('identify not implemented', { kind: 'unsupported' }); }

  /** Cheapest possible query. Throws when the camera is not answering. */
  async heartbeat() { await this.identify(); }

  /**
   * The parameter table for the identified model and firmware.
   * @param {object} identity  what identify() returned
   * @returns {object[]} entries — see schema.js
   */
  // eslint-disable-next-line no-unused-vars
  schema(identity) { return []; }

  /**
   * What this camera can physically do. Drives which parts of the Operate card
   * exist at all, so a camera never shows a control it does not have.
   *
   * @returns {{panTilt: boolean, zoom: boolean, focus: boolean,
   *   presets: number, presetBase: number, tracking: null | {kind: string, label: string},
   *   tally: boolean, snapshot: boolean, pointToCentre: boolean, power: boolean}}
   */
  // eslint-disable-next-line no-unused-vars
  capabilities(identity) {
    return {
      panTilt: true, zoom: true, focus: true,
      presets: 0, presetBase: 1,
      tracking: null, tally: false, snapshot: false, pointToCentre: false, power: false,
    };
  }

  /**
   * Reads values. The lifecycle passes small batches; drivers whose protocol
   * returns many values per request may answer more than was asked, and the
   * extra values are used.
   *
   * @param {object[]} entries
   * @returns {Promise<Object<string, {value: any, writable?: boolean, allowed?: any[]} | {error: string}>>}
   */
  // eslint-disable-next-line no-unused-vars
  async read(entries) { return {}; }

  /**
   * Writes one value, already validated against the entry by schema.coerce.
   * @returns {Promise<{applied?: any}>}  `applied` when the camera snapped the value
   */
  // eslint-disable-next-line no-unused-vars
  async write(entry, value) { throw new DriverError('this camera cannot be changed from here', { kind: 'unsupported' }); }

  /** Pan and tilt velocity, each -1..1. (0, 0) stops both. Positive pan is right, positive tilt is up. */
  // eslint-disable-next-line no-unused-vars
  async panTilt(pan, tilt) { throw new DriverError('no pan/tilt', { kind: 'unsupported' }); }

  /** Zoom velocity, -1..1. Positive is tele (in). 0 stops. */
  // eslint-disable-next-line no-unused-vars
  async zoom(speed) { throw new DriverError('no zoom', { kind: 'unsupported' }); }

  /** Focus velocity, -1..1. Positive is far. 0 stops. */
  // eslint-disable-next-line no-unused-vars
  async focus(speed) { throw new DriverError('no focus control', { kind: 'unsupported' }); }

  /** Stops every axis. Must be safe at any moment, including when nothing moves. */
  async stop() {
    await this.panTilt(0, 0);
    await this.zoom(0).catch(() => {});
    await this.focus(0).catch(() => {});
  }

  /**
   * Where the head is. Each axis normalised 0..1 across its travel, or null when
   * the camera does not report it.
   * @returns {Promise<{pan: number|null, tilt: number|null, zoom: number|null, focus: number|null}>}
   */
  async position() { return { pan: null, tilt: null, zoom: null, focus: null }; }

  /**
   * Fast-changing status worth polling often: tracking active, preset reached,
   * power state. Optional.
   * @returns {Promise<object>}
   */
  async status() { return {}; }

  // eslint-disable-next-line no-unused-vars
  async presetRecall(n, o) { throw new DriverError('no presets', { kind: 'unsupported' }); }
  // eslint-disable-next-line no-unused-vars
  async presetStore(n) { throw new DriverError('no presets', { kind: 'unsupported' }); }
  // eslint-disable-next-line no-unused-vars
  async presetDelete(n) { throw new DriverError('this camera cannot delete presets', { kind: 'unsupported' }); }

  /**
   * Table entries of type 'action' land here (one-push AF, home, tracking
   * start, reboot), by entry id.
   */
  // eslint-disable-next-line no-unused-vars
  async action(entry, payload) { throw new DriverError(`${entry?.label ?? 'that'} is not supported`, { kind: 'unsupported' }); }

  /** @returns {Promise<{contentType: string, body: Buffer}>} one still frame */
  async snapshot() { throw new DriverError('no snapshot', { kind: 'unsupported' }); }

  /** Re-aim so a point in the picture (x, y in 0..1) becomes the centre. */
  // eslint-disable-next-line no-unused-vars
  async pointToCentre(point) { throw new DriverError('this camera cannot aim at a point', { kind: 'unsupported' }); }

  /** Tally lamp. state: { program: bool, preview: bool } */
  // eslint-disable-next-line no-unused-vars
  async setTally(state) { throw new DriverError('no tally lamp', { kind: 'unsupported' }); }

  /**
   * Optional: change notifications, for protocols that push (an event stream,
   * a long-poll, a notification socket). Called once after connect; deliver
   * values in the same shape read() returns, and position/status through
   * onPtz. Must not throw for a dropped stream — reconnect it quietly or let
   * it go; polling continues either way. close() ends it.
   *
   * subscribe({ onValues, onPtz }) {}
   */

  /** Release sockets. Called when a camera is removed or CamBridge stops. */
  close() {}
}
