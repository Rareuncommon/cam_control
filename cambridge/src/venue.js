// What kind of venue this config describes.
//
// Its own module, with no side effects, because the launch scripts ask it too:
// importing server.js to ask a question would start a server.

/** A config entry is a PTZ camera when it says so. Everything else is camd's. */
export function isPtzEntry(entry) {
  return entry?.kind === 'ptz';
}

/**
 * Whether this installation needs camd at all.
 *
 * camd wraps Sony's SDK and exists for the FX3/FX30 bodies. A venue with only
 * PTZ heads has no SDK and no daemon, and must not spend its life reporting
 * one missing. An explicit `camd.enabled` wins; otherwise camd is used unless
 * every configured camera is a PTZ head. An empty config still starts camd,
 * because that is how a fresh studio install discovers its Sony bodies.
 */
export function camdNeeded(cfg) {
  if (typeof cfg.camd?.enabled === 'boolean') return cfg.camd.enabled;
  const cams = cfg.cameras ?? [];
  return !(cams.length > 0 && cams.every(isPtzEntry));
}

// `node cambridge/src/venue.js <config>` prints yes or no, for the launchers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs');
  let answer = 'yes';
  try {
    const c = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    answer = camdNeeded({ camd: c.camd ?? {}, cameras: c.cameras ?? [] }) ? 'yes' : 'no';
  } catch { /* unreadable config: start camd, as before */ }
  process.stdout.write(answer);
}
