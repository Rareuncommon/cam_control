// The pairing QR: the vendored encoder is wired the way the code expects.
// (Decoding is checked on the app side, with ZXing, against the same
// matrix in protocol/vectors/qr-pairing.json.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix, qrSvg } from '../src/qr.js';

const URI = 'cambridge://pair?v=1&sid=0123456789abcdef&sn=Studio&h=192.168.1.20%2C192.168.220.66&p=8088&id=ph-0123456789ab&k=' + 'A'.repeat(43) + '&exp=1800000600';

test('a pairing code is a well-formed QR', () => {
  const m = qrMatrix(URI);
  assert.equal((m.length - 17) % 4, 0, 'a valid QR size');
  const finder = (r0, c0) => [0, 1, 2, 3, 4, 5, 6].every((r) => [0, 1, 2, 3, 4, 5, 6].every((c) => {
    const edge = r === 0 || r === 6 || c === 0 || c === 6;
    const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
    return m[r0 + r][c0 + c] === (edge || core);
  }));
  const n = m.length;
  assert.ok(finder(0, 0) && finder(0, n - 7) && finder(n - 7, 0), 'three finder patterns');
  for (let i = 8; i < n - 8; i++) assert.equal(m[6][i], i % 2 === 0, 'timing pattern');
});

test('the SVG has a quiet zone, black on white, and refuses non-ASCII', () => {
  const svg = qrSvg(URI);
  const n = qrMatrix(URI).length;
  assert.match(svg, new RegExp(`viewBox="0 0 ${n + 8} ${n + 8}"`));
  assert.match(svg, /fill="#fff"/);
  assert.match(svg, /<path d="M4 4h7v1h-7z/);
  assert.ok(!/<script|href/i.test(svg));
  assert.throws(() => qrMatrix('café'));
});
