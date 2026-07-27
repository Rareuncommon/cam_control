// Rotating, timestamped state-change log for the Node layer.
//
// Separate from camd's log on purpose: this one records operator intent — who
// pressed what, which scene was recalled, which gang applied — while camd's
// records what the cameras did. Reading them side by side is how a Monday
// postmortem reconstructs a shoot.

import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

export class Logger {
  constructor({ dir = './logs', level = 'info', maxSizeBytes = 20 * 1024 * 1024, maxFiles = 30 } = {}) {
    this.dir = dir;
    this.level = LEVELS[level] ?? LEVELS.info;
    this.maxSizeBytes = maxSizeBytes;
    this.maxFiles = maxFiles;
    this.path = join(dir, 'cambridge.log');
    this.broken = false;
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      this.broken = true;
      process.stderr.write(`cambridge: cannot create log dir ${dir}: ${err.message}\n`);
    }
  }

  #rotateIfNeeded(incoming) {
    if (this.broken || !existsSync(this.path)) return;
    let size = 0;
    try { size = statSync(this.path).size; } catch { return; }
    if (size + incoming <= this.maxSizeBytes) return;
    try {
      rmSync(`${this.path}.${this.maxFiles}`, { force: true });
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const from = `${this.path}.${i}`;
        if (existsSync(from)) renameSync(from, `${this.path}.${i + 1}`);
      }
      renameSync(this.path, `${this.path}.1`);
    } catch (err) {
      process.stderr.write(`cambridge: log rotation failed: ${err.message}\n`);
    }
  }

  write(level, subject, message) {
    if ((LEVELS[level] ?? 2) < this.level) return;
    const stamp = new Date().toISOString();
    const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${subject}] ${message}\n`;
    this.#rotateIfNeeded(line.length);
    if (!this.broken) {
      try { appendFileSync(this.path, line); } catch { this.broken = true; }
    }
    if (this.broken || level === 'error' || level === 'warn') {
      process.stderr.write(line);
    }
  }

  trace(subject, msg) { this.write('trace', subject, msg); }
  debug(subject, msg) { this.write('debug', subject, msg); }
  info(subject, msg)  { this.write('info', subject, msg); }
  warn(subject, msg)  { this.write('warn', subject, msg); }
  error(subject, msg) { this.write('error', subject, msg); }
}
