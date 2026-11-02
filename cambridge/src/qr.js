// QR codes for pairing phones, drawn as SVG on the server.
//
// The encoder is the vendored qrcode-generator (src/vendor/qrcode.mjs, MIT).
// The pairing URI is plain ASCII (URLSearchParams percent-encodes anything
// else), so byte mode with the library's default byte conversion is exact.

import qrcode from './vendor/qrcode.mjs';

/** Rows of dark (true) / light (false) modules. */
export function qrMatrix(text, ecc = 'M') {
  if (!/^[\x20-\x7e]*$/.test(text)) throw new Error('QR text must be printable ASCII');
  const q = qrcode(0, ecc);
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
}

/**
 * An SVG of the code, with a quiet zone, black on white whatever the page's
 * theme (phone cameras read dark-on-light best), scaling to its container.
 */
export function qrSvg(text, { ecc = 'M', margin = 4 } = {}) {
  const m = qrMatrix(text, ecc);
  const size = m.length + margin * 2;
  let d = '';
  m.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      if (!row[c]) { c++; continue; }
      let run = 1;
      while (row[c + run]) run++;
      d += `M${c + margin} ${r + margin}h${run}v1h-${run}z`;
      c += run;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Pairing code">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
