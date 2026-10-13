// Names and pictures for camera-native presets.
//
// The positions themselves live on the camera — that is what lets Reactor, the
// vendor's web page and CamBridge all recall the same "Lectern". What the
// cameras mostly cannot store is a name worth reading or a picture of the
// shot, so those live here, keyed by camera and preset number.
//
// A preset stored from somewhere else simply has no name here. It still
// recalls; it just shows as its number until someone names it.

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Camera ids become directory names; anything else is refused rather than escaped. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class PtzPresetBook {
  /**
   * @param {object} o
   * @param {import('../store.js').JsonStore} o.store
   * @param {string} o.dir   where thumbnails are written
   * @param {(level: string, msg: string) => void} [o.log]
   */
  constructor({ store, dir, log = () => {} }) {
    this.store = store;
    this.dir = dir;
    this.log = log;
    this.store.data.ptzPresets ??= {};
  }

  #book(cameraId) {
    this.store.data.ptzPresets[cameraId] ??= {};
    return this.store.data.ptzPresets[cameraId];
  }

  list(cameraId) {
    const book = this.store.data.ptzPresets[cameraId] ?? {};
    return Object.entries(book)
      .map(([n, p]) => ({ n: Number(n), name: p.name, thumb: !!p.thumb, savedAt: p.savedAt ?? null }))
      .sort((a, b) => a.n - b.n);
  }

  name(cameraId, n) {
    return this.store.data.ptzPresets[cameraId]?.[n]?.name ?? null;
  }

  /** Records a store made from CamBridge, with a picture when one is to hand. */
  stored(cameraId, n, name, frame) {
    const book = this.#book(cameraId);
    const entry = {
      name: String(name ?? '').trim().slice(0, 40) || book[n]?.name || `Preset ${n}`,
      savedAt: Date.now(),
      thumb: null,
    };
    if (frame?.body && SAFE_ID.test(cameraId)) {
      const ext = /png/.test(frame.contentType ?? '') ? 'png' : 'jpg';
      try {
        mkdirSync(join(this.dir, cameraId), { recursive: true });
        // One file per preset; an old picture in the other format would be stale.
        for (const e of ['png', 'jpg']) rmSync(join(this.dir, cameraId, `${n}.${e}`), { force: true });
        writeFileSync(join(this.dir, cameraId, `${n}.${ext}`), frame.body);
        entry.thumb = ext;
      } catch (err) {
        this.log('warn', `${cameraId} preset ${n}: picture not saved (${err.message})`);
      }
    }
    book[n] = entry;
    this.store.save();
    return entry;
  }

  rename(cameraId, n, name) {
    const book = this.#book(cameraId);
    const clean = String(name ?? '').trim().slice(0, 40);
    if (!clean) return { ok: false, error: 'a name is required' };
    book[n] = { ...(book[n] ?? { savedAt: null, thumb: null }), name: clean };
    this.store.save();
    return { ok: true, n, name: clean };
  }

  forget(cameraId, n) {
    const book = this.#book(cameraId);
    const had = book[n];
    delete book[n];
    if (had?.thumb && SAFE_ID.test(cameraId)) {
      rmSync(join(this.dir, cameraId, `${n}.${had.thumb}`), { force: true });
    }
    this.store.save();
  }

  /** @returns {{contentType: string, body: Buffer} | null} */
  thumb(cameraId, n) {
    const p = this.store.data.ptzPresets[cameraId]?.[n];
    if (!p?.thumb || !SAFE_ID.test(cameraId)) return null;
    const file = join(this.dir, cameraId, `${n}.${p.thumb}`);
    if (!existsSync(file)) return null;
    return { contentType: p.thumb === 'png' ? 'image/png' : 'image/jpeg', body: readFileSync(file) };
  }
}
