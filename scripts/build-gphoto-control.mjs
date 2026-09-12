import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../cambridge/native/gphoto-control.c', import.meta.url));
const output = fileURLToPath(new URL('../cambridge/native/gphoto-control', import.meta.url));
let flags;
try { flags = execFileSync('pkg-config', ['--cflags', '--libs', 'libgphoto2'], { encoding: 'utf8' }).trim().split(/\s+/); }
catch { const prefix = execFileSync('brew', ['--prefix'], { encoding: 'utf8' }).trim(); flags = [`-I${prefix}/include`, `-L${prefix}/lib`, '-lgphoto2', '-lgphoto2_port']; }
execFileSync(process.env.CC || 'cc', ['-D_GNU_SOURCE', '-Wall', '-Wextra', source, ...flags, '-lm', '-o', output], { stdio: 'inherit' });
console.log('Built optional USB camera helper:', output);
