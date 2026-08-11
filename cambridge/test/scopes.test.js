// Scope maths.
//
// The drawing half of scopes.js needs a canvas and is checked by eye against the
// fake backend's colour bars. Everything here is arithmetic over pixel arrays,
// and gets pinned properly — a false-colour band that is off by a few percent is
// invisible in a screenshot and wrong on set.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  luma, histogram, clipStats, markClipping, applyFalseColour,
  buildFalseColourLut, averageColour, FALSE_COLOUR_BANDS,
  containRect, pointToImage,
} from '../public/scopes.js';

/** A flat frame of one colour, `n` pixels. */
function flat(r, g, b, n = 64) {
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n * 4; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return data;
}

test('luma is Rec.709 weighted, not a flat average', () => {
  // The reason this matters: a plain average calls saturated blue mid-grey and
  // would put a blue-lit stage in entirely the wrong false-colour band.
  assert.ok(luma(0, 0, 255) < 30, 'pure blue is dark');
  assert.ok(luma(0, 255, 0) > 180, 'pure green is bright');
  assert.equal(Math.round(luma(255, 255, 255)), 255);
  assert.equal(luma(0, 0, 0), 0);
});

test('a histogram of a flat frame is a single spike', () => {
  const hist = histogram(flat(128, 128, 128), { bins: 64, step: 1 });
  const nonZero = [...hist].filter((n) => n > 0);
  assert.equal(nonZero.length, 1);
  assert.equal(nonZero[0], 64, 'every sampled pixel lands in the one bin');
});

test('white and black land in the end bins, not off the end', () => {
  const white = histogram(flat(255, 255, 255), { bins: 64, step: 1 });
  const black = histogram(flat(0, 0, 0), { bins: 64, step: 1 });
  assert.equal(white[63], 64, 'pure white must not overflow past the last bin');
  assert.equal(black[0], 64);
});

test('sampling every Nth pixel gives the same shape, not the same counts', () => {
  const data = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    data[i * 4] = i; data[i * 4 + 1] = i; data[i * 4 + 2] = i; data[i * 4 + 3] = 255;
  }
  const full = histogram(data, { bins: 8, step: 1 });
  const sampled = histogram(data, { bins: 8, step: 4 });
  assert.equal([...full].reduce((a, b) => a + b), 256);
  assert.equal([...sampled].reduce((a, b) => a + b), 64);

  // A ramp fills every bin about equally either way. "About" is load-bearing:
  // the Rec.709 weights sum to 1.0 only in exact arithmetic, so a grey pixel's
  // luma can come back a hair under its own value and fall into the bin below
  // at an exact boundary. That is a one-pixel difference in a synthetic ramp
  // and invisible in a picture — asserting exact equality here would be
  // asserting something floating point does not promise.
  for (const count of sampled) {
    assert.ok(Math.abs(count - 8) <= 1, `bin count ${count} is not within 1 of 8`);
  }
});

test('clip stats are proportions, so frame size does not change the number', () => {
  // A count would mean a 640x480 feed and a 1024x768 feed reporting different
  // numbers for the same picture.
  const small = clipStats(flat(255, 255, 255, 64), { step: 1 });
  const large = clipStats(flat(255, 255, 255, 4096), { step: 1 });
  assert.equal(small.over, 1);
  assert.equal(large.over, 1);
  assert.equal(small.under, 0);
});

test('a correctly exposed frame reports no clipping at all', () => {
  const stats = clipStats(flat(128, 128, 128), { step: 1 });
  assert.equal(stats.over, 0);
  assert.equal(stats.under, 0);
});

test('crushed blacks are counted separately from clipped highlights', () => {
  const data = new Uint8ClampedArray(4 * 4);
  // one white, one black, two mid
  const px = [[255, 255, 255], [0, 0, 0], [128, 128, 128], [128, 128, 128]];
  px.forEach(([r, g, b], i) => {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  });
  const stats = clipStats(data, { step: 1 });
  assert.equal(stats.over, 0.25);
  assert.equal(stats.under, 0.25);
});

test('marking clipping leaves everything else recognisable', () => {
  // This is the difference between it and false colour: it can stay on during a
  // take because the picture survives.
  const data = new Uint8ClampedArray(3 * 4);
  const px = [[255, 255, 255], [0, 0, 0], [120, 130, 140]];
  px.forEach(([r, g, b], i) => {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  });
  markClipping(data);
  assert.deepEqual([...data.slice(0, 3)], [255, 0, 0], 'clipped goes red');
  assert.deepEqual([...data.slice(4, 7)], [0, 90, 255], 'crushed goes blue');
  assert.deepEqual([...data.slice(8, 11)], [120, 130, 140], 'the rest is untouched');
});

test('false colour puts an 18% grey card in the grey band', () => {
  // 18% reflectance sits near 46 IRE, which is the band the panel labels
  // "18% grey" — if this drifts, the key in the UI is lying.
  const lut = buildFalseColourLut();
  const v = Math.round(0.46 * 255);
  const band = FALSE_COLOUR_BANDS.find((b) => b.label === '18% grey');
  assert.deepEqual([lut[v * 3], lut[v * 3 + 1], lut[v * 3 + 2]], band.colour);
});

test('false colour puts a correctly exposed face in the skin band', () => {
  const lut = buildFalseColourLut();
  const band = FALSE_COLOUR_BANDS.find((b) => b.label === 'skin');
  for (const ire of [55, 65, 75]) {
    const v = Math.round((ire / 100) * 255);
    assert.deepEqual([lut[v * 3], lut[v * 3 + 1], lut[v * 3 + 2]], band.colour,
      `${ire} IRE should read as skin`);
  }
});

test('false colour flags clipping and crushing at the extremes', () => {
  const lut = buildFalseColourLut();
  const clipped = FALSE_COLOUR_BANDS.find((b) => b.label === 'clipped');
  const crushed = FALSE_COLOUR_BANDS.find((b) => b.label === 'crushed black');
  assert.deepEqual([lut[255 * 3], lut[255 * 3 + 1], lut[255 * 3 + 2]], clipped.colour);
  assert.deepEqual([lut[0], lut[1], lut[2]], crushed.colour);
});

test('the false-colour bands cover 0-100 with no gap and no overlap', () => {
  // A gap would leave pixels unmapped and fall through to the last band, which
  // reads as "clipped" — the most alarming possible wrong answer.
  let previous = 0;
  for (const band of FALSE_COLOUR_BANDS) {
    assert.ok(band.max > previous, `band ${band.label} does not advance`);
    previous = band.max;
  }
  assert.equal(previous, 100, 'the bands must reach 100%');
});

test('applying false colour preserves alpha', () => {
  const data = flat(200, 100, 50, 4);
  applyFalseColour(data, buildFalseColourLut());
  for (let i = 3; i < data.length; i += 4) assert.equal(data[i], 255);
});

test('average colour reads only the region asked for', () => {
  // 4x1 strip: two red pixels then two blue. Sampling the left half must not
  // see the blue, or a white-balance comparison would average the whole frame
  // and report grey for everything.
  const data = new Uint8ClampedArray(4 * 4);
  const px = [[255, 0, 0], [255, 0, 0], [0, 0, 255], [0, 0, 255]];
  px.forEach(([r, g, b], i) => {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  });
  const left = averageColour(data, 4, 1, { x: 0, y: 0, w: 0.5, h: 1 });
  assert.deepEqual([left.r, left.g, left.b], [255, 0, 0]);
  assert.equal(left.n, 2);

  const all = averageColour(data, 4, 1, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual([all.r, all.g, all.b], [127.5, 0, 127.5]);
});

test('a region outside the frame returns nothing rather than reading garbage', () => {
  const data = flat(128, 128, 128, 4);
  const out = averageColour(data, 4, 1, { x: 2, y: 2, w: 0.5, h: 0.5 });
  assert.equal(out.n, 0);
});

// --- tap-to-focus coordinate mapping ----------------------------------------
//
// The bug these pin: the click handler measured the canvas *element* rect while
// `object-fit: contain` letterboxes the picture inside it. It went unnoticed
// because the fake backend's test card is 160x90 — exactly the tile's 16:9, the
// single ratio where element and image rects coincide. Every case below is one
// the fake feed cannot produce.

test('a 16:9 image in a 16:9 tile fills it with no bars', () => {
  const r = containRect(1600, 900, 160, 90);
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
  assert.equal(r.w, 1600);
  assert.equal(r.h, 900);
});

test('a 4:3 image in a 16:9 tile is pillarboxed', () => {
  // The real case: Sony live view is not 16:9.
  const r = containRect(1600, 900, 640, 480);
  assert.equal(r.h, 900, 'height fills');
  assert.equal(r.w, 1200, 'width is short of the tile');
  assert.equal(r.x, 200, 'bars of 200px each side');
  assert.equal(r.y, 0);
});

test('a wider-than-tile image is letterboxed top and bottom', () => {
  const r = containRect(1600, 900, 2390, 1000);
  assert.equal(r.w, 1600);
  assert.ok(r.h < 900);
  assert.equal(r.x, 0);
  assert.ok(r.y > 0);
});

test('the centre of a pillarboxed picture maps to the centre of frame', () => {
  const p = pointToImage(800, 450, 1600, 900, 640, 480);
  assert.equal(p.x, 0.5);
  assert.equal(p.y, 0.5);
});

test('the picture edges map to 0 and 1, not the tile edges', () => {
  // With 200px bars, image x=0 is at element x=200. Measuring against the
  // element would have called that 0.125 and put focus an eighth of the way in.
  assert.equal(pointToImage(200, 0, 1600, 900, 640, 480).x, 0);
  assert.equal(pointToImage(1400, 900, 1600, 900, 640, 480).x, 1);
});

test('a tap on a letterbox bar is refused, not clamped to the edge', () => {
  // Clamping would focus at the extreme edge of frame — somewhere nobody
  // pointed at — and look like the tap worked.
  assert.equal(pointToImage(100, 450, 1600, 900, 640, 480), null, 'left bar');
  assert.equal(pointToImage(1500, 450, 1600, 900, 640, 480), null, 'right bar');
  assert.equal(pointToImage(800, 10, 1600, 900, 2390, 1000), null, 'top bar');
});

test('the old element-rect maths really did disagree, and by how much', () => {
  // Guards the fix by pinning the size of the error: a tap a quarter across a
  // pillarboxed tile is a third of the way into the picture, not a quarter.
  const naive = 400 / 1600;
  const correct = pointToImage(400, 450, 1600, 900, 640, 480).x;
  assert.equal(naive, 0.25);
  assert.ok(Math.abs(correct - naive) > 0.08, 'the two must not agree');
  assert.ok(Math.abs(correct - 1 / 6) < 1e-9);
});

test('a canvas with no frame yet yields nothing rather than dividing by zero', () => {
  assert.equal(pointToImage(10, 10, 1600, 900, 0, 0), null);
  assert.deepEqual(containRect(0, 0, 640, 480), { x: 0, y: 0, w: 0, h: 0, scale: 0 });
});
