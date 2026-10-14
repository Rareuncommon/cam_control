// What kind of venue this config describes.
//
// Its own module, with no side effects, because the launch scripts ask it too:
// importing server.js to ask a question would start a server.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A config entry is a PTZ camera when it says so. Everything else is camd's. */
export function isPtzEntry(entry) {
  return entry?.kind === 'ptz';
}

/**
 * Whether this installation needs camd: 'yes', 'no' or 'optional'.
 *
 * camd wraps Sony's SDK and exists for the Sony bodies. Stills and cinema
 * cameras (`external.cameras`) and PTZ heads are driven from Node and need
 * neither the SDK nor the daemon, so a venue without Sony bodies must not
 * spend its life reporting one missing.
 *
 * - An explicit `camd.enabled` wins.
 * - Any Sony body in `cameras`: 'yes'.
 * - Cameras, all of them PTZ heads: 'no'.
 * - No cameras yet: 'optional'. A fresh install with camd built starts it,
 *   because that is how its Sony bodies are discovered; one without it —
 *   a Mac set up for PTZ heads alone — starts without, rather than refusing
 *   to start until someone builds a daemon it does not need.
 */
export function camdMode(cfg) {
  if (typeof cfg?.camd?.enabled === 'boolean') return cfg.camd.enabled ? 'yes' : 'no';
  const cams = cfg?.cameras ?? [];
  if (cams.some((c) => !isPtzEntry(c))) return 'yes';
  return cams.length > 0 ? 'no' : 'optional';
}

/**
 * Whether the server should expect camd. 'optional' counts as yes here: the
 * launchers resolve it (they know whether camd is built) and tell the server
 * with CAMBRIDGE_CAMD=off when they did not start it.
 */
export function camdNeeded(cfg, env = {}) {
  if (env.CAMBRIDGE_CAMD === 'off') return false;
  return camdMode(cfg) !== 'no';
}

/**
 * A first config, made from the example: its settings, none of its cameras.
 * The example's cameras are placeholders, and copying them would start a
 * fresh install with cards for bodies that do not exist — and, being Sony
 * entries, would make camd required at a venue that may have none.
 */
export function starterConfig(exampleText) {
  const cfg = JSON.parse(exampleText);
  for (const key of Object.keys(cfg)) if (key.startsWith('$')) delete cfg[key];
  cfg.cameras = [];
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

/**
 * Whether the module at `metaUrl` is the script node was asked to run.
 *
 * Compared as real paths: `file://${argv[1]}` misses a path with a space (the
 * URL has %20) and one reached through a symlink, and either way the script
 * did nothing and exited 0 — the worst way for a launcher step to fail.
 */
export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

// For the launchers:
//   node cambridge/src/venue.js <config>                    prints yes, no or optional
//   node cambridge/src/venue.js --init <config> <example>   writes a starter config
if (isMainModule(import.meta.url)) {
  const fs = await import('node:fs');
  if (process.argv[2] === '--init') {
    const [, , , target, example] = process.argv;
    // 0600 from the first byte: this file is where camera passwords will go.
    fs.writeFileSync(target, starterConfig(fs.readFileSync(example, 'utf8')), { mode: 0o600, flag: 'wx' });
  } else {
    let answer = 'yes';
    try {
      answer = camdMode(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
    } catch { /* unreadable config: start camd, as before */ }
    process.stdout.write(answer);
  }
}
