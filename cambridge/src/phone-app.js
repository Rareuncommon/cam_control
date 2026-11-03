// The phone app's updates, served by CamBridge to its paired phones.
//
// scripts/publish-phone-app.sh builds a signed release APK on this Mac and
// puts it in a `phone-app` folder beside the config, with a latest.json that
// says which version it is:
//
//   { "versionCode": 412, "versionName": "1.1.0 (412)", "file": "CamBridge-412.apk" }
//
// The app asks GET /api/phone-app over its signed connection, and when the
// version is newer than its own it downloads GET /api/phone-app/apk, checks
// the SHA-256 given here and the signing key, and hands it to Android's
// installer, which asks the person to confirm. Nothing here signs or changes
// an APK: it only serves the one the script put there.

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export const PHONE_APP_DIR = 'phone-app';

/**
 * @param {object} o
 * @param {string} o.dir  the folder the publish script writes to
 */
export function createPhoneApp({ dir }) {
  /** sha256 by file path, size and modification time: an APK is hashed once. */
  let cached = null;

  /**
   * The published version, or null with a reason when there is none to offer.
   * @returns {{ ok: true, versionCode: number, versionName: string, size: number, sha256: string, path: string } | { ok: false, reason: string }}
   */
  function latest() {
    let meta;
    try {
      meta = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
    } catch (e) {
      return { ok: false, reason: e.code === 'ENOENT' ? 'nothing published' : `latest.json unreadable: ${e.message}` };
    }
    const code = meta?.versionCode;
    const file = meta?.file;
    if (!Number.isSafeInteger(code) || code < 1) return { ok: false, reason: 'latest.json has no whole-number versionCode' };
    // Only a file in this folder: latest.json never points anywhere else.
    if (typeof file !== 'string' || file !== basename(file) || !file.endsWith('.apk')) {
      return { ok: false, reason: 'latest.json must name an .apk in the same folder' };
    }
    const path = join(dir, file);
    let st;
    try {
      st = statSync(path);
    } catch {
      return { ok: false, reason: `${file} is missing` };
    }
    if (!st.isFile() || st.size === 0) return { ok: false, reason: `${file} is not a file` };
    if (!cached || cached.path !== path || cached.size !== st.size || cached.mtimeMs !== st.mtimeMs) {
      cached = { path, size: st.size, mtimeMs: st.mtimeMs, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
    }
    return {
      ok: true,
      versionCode: code,
      versionName: typeof meta.versionName === 'string' ? meta.versionName : String(code),
      size: st.size,
      sha256: cached.sha256,
      path,
    };
  }

  /** What GET /api/phone-app answers: no paths, just what the phone needs. */
  function describe() {
    const l = latest();
    if (!l.ok) return { available: false, reason: l.reason };
    return { available: true, versionCode: l.versionCode, versionName: l.versionName, size: l.size, sha256: l.sha256 };
  }

  /** Streams the APK, or answers 404. */
  function send(res) {
    const l = latest();
    if (!l.ok) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: l.reason }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': String(l.size),
      'Content-Disposition': `attachment; filename="CamBridge-${l.versionCode}.apk"`,
      'X-CamBridge-Sha256': l.sha256,
      'Cache-Control': 'no-store',
    });
    createReadStream(l.path).on('error', () => res.destroy()).pipe(res);
  }

  return { latest, describe, send, dir };
}
