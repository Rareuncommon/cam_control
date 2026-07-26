// Small JSON-file store for presets, scenes and gang definitions.
//
// Writes are atomic (temp file + rename) so a crash mid-save cannot leave an
// unreadable file where the Sunday scene list used to be. A corrupt or missing
// file degrades to empty rather than refusing to start.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export class JsonStore {
  constructor(path, defaults = {}, log = () => {}) {
    this.path = path;
    this.log = log;
    this.data = { ...defaults };
    this.#load(defaults);
  }

  #load(defaults) {
    if (!existsSync(this.path)) {
      this.log('info', `no store at ${this.path}, starting empty`);
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      this.data = { ...defaults, ...parsed };
    } catch (err) {
      // Keep going with defaults and say so loudly. Losing presets is bad; failing
      // to start a service because of it is worse.
      this.log('error', `store ${this.path} is unreadable (${err.message}) — starting empty`);
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      renameSync(tmp, this.path);
      return true;
    } catch (err) {
      this.log('error', `cannot save ${this.path}: ${err.message}`);
      return false;
    }
  }
}
