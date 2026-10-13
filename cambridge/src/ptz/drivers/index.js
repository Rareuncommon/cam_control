// Every PTZ driver CamBridge knows, by vendor id.
//
// The vendor id is what a camera's config entry names (`"vendor": "panasonic"`),
// and the order here is the order add-by-IP tries them in. Probes are read-only
// and cheap, but a camera that half-answers another vendor's probe should not
// be misidentified, so the most specific probes go first.

import { CanonXcPtz } from './canon-xc.js';
import { PanasonicAw } from './panasonic-aw.js';
import { FakePtz } from './fake.js';
import { SonyBrc } from './sony-brc.js';
import { PtzOptics } from './ptzoptics.js';

export const DRIVERS = new Map([
  // Most specific first. Sony: one CGI inquiry with a Param=value reply
  // nobody else sends. Canon: a path only an XC camera serves.
  [SonyBrc.vendor, SonyBrc],
  [CanonXcPtz.vendor, CanonXcPtz],
  // PTZOptics: JSON get_device_conf, or raw VISCA on TCP 5678.
  [PtzOptics.vendor, PtzOptics],
  // Panasonic treats a 401 on its CGI path as "Panasonic, wrong password",
  // so it goes after the probes that can tell a camera apart for certain.
  [PanasonicAw.vendor, PanasonicAw],
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
