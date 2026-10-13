// Every PTZ driver CamBridge knows, by vendor id.
//
// The vendor id is what a camera's config entry names (`"vendor": "panasonic"`),
// and the order here is the order add-by-IP tries them in. Probes are read-only
// and cheap, but a camera that half-answers another vendor's probe should not
// be misidentified, so the most specific probes go first.

import { FakePtz } from './fake.js';
import { SonyBrc } from './sony-brc.js';
import { PtzOptics } from './ptzoptics.js';

export const DRIVERS = new Map([
  // Sony first: one CGI inquiry with a Param=value reply nobody else sends.
  [SonyBrc.vendor, SonyBrc],
  // PTZOptics: JSON get_device_conf, or raw VISCA on TCP 5678.
  [PtzOptics.vendor, PtzOptics],
  [FakePtz.vendor, FakePtz],
]);

export function driverFor(vendor) {
  return DRIVERS.get(String(vendor ?? '').toLowerCase()) ?? null;
}

/** For Setup: which vendors and models can be added. */
export function supported() {
  return [...DRIVERS.values()]
    .filter((D) => D.vendor !== 'fake')
    .map((D) => ({ vendor: D.vendor, label: D.label, models: D.models }));
}
