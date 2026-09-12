// Scopes and framing overlays for the multiview.
//
// Everything here runs on frames the panel already has. The feeds are polled a
// JPEG at a time and decoded in the browser, so exposure analysis costs one
// canvas read and no extra traffic — the camera is not asked for anything it is
// not already sending.
//
// The maths is split from the drawing on purpose. The functions above the
// divider take and return plain arrays and are unit-tested in Node; only the
// ones below touch a canvas, and those are checked by eye against the fake
// backend's colour-bar feed, which is a known input.

// --- pure ------------------------------------------------------------------

/**
 * Rec.709 luma.
 *
 * The weights matter: a plain (r+g+b)/3 average calls saturated blue mid-grey
 * and would put a blue-lit stage in the wrong false-colour band entirely.
 */
export function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Luma histogram.
 *
 * `step` samples every Nth pixel. At 4 the result is visually identical to a
 * full pass and costs a quarter as much, which is what keeps this affordable
 * inside a 100 ms feed loop with three cameras on screen.
 */
export function histogram(rgba, { bins = 64, step = 4 } = {}) {
  const out = new Uint32Array(bins);
  const scale = bins / 256;
  for (let i = 0; i < rgba.length; i += 4 * step) {
    const y = luma(rgba[i], rgba[i + 1], rgba[i + 2]);
    let bin = Math.floor(y * scale);
    if (bin >= bins) bin = bins - 1;
    if (bin < 0) bin = 0;
    out[bin] += 1;
  }
  return out;
}

/**
 * False-colour bands, as IRE percentages.
 *
 * Chosen to answer the three questions actually asked while lighting: is
 * anything clipped, is anything crushed, and is the skin sitting where it
 * should. The skin band is the wide pink one — 52–77% is where a correctly
 * exposed face lands on these bodies, so "make the face pink" is a usable
 * instruction to give someone at a tripod.
 */
export const FALSE_COLOUR_BANDS = [
  { max: 2, colour: [90, 0, 140], label: 'crushed black' },
  { max: 10, colour: [0, 70, 220], label: 'deep shadow' },
  { max: 42, colour: [40, 40, 40], label: 'shadow' },
  { max: 48, colour: [0, 190, 90], label: '18% grey' },
  { max: 52, colour: [140, 140, 140], label: 'mid' },
  { max: 77, colour: [235, 130, 190], label: 'skin' },
  { max: 94, colour: [235, 210, 40], label: 'highlight' },
  { max: 100, colour: [235, 30, 30], label: 'clipped' },
];

/** 256-entry lookup, built once — a per-pixel band search would be far slower. */
export function buildFalseColourLut(bands = FALSE_COLOUR_BANDS) {
  const lut = new Uint8Array(256 * 3);
  for (let v = 0; v < 256; v++) {
    const ire = (v / 255) * 100;
    const band = bands.find((b) => ire <= b.max) ?? bands[bands.length - 1];
    lut[v * 3] = band.colour[0];
    lut[v * 3 + 1] = band.colour[1];
    lut[v * 3 + 2] = band.colour[2];
  }
  return lut;
}

/** Replaces every pixel with its band colour. Mutates `rgba` in place. */
export function applyFalseColour(rgba, lut) {
  for (let i = 0; i < rgba.length; i += 4) {
    const y = luma(rgba[i], rgba[i + 1], rgba[i + 2]);
    const v = y < 0 ? 0 : y > 255 ? 255 : y | 0;
    rgba[i] = lut[v * 3];
    rgba[i + 1] = lut[v * 3 + 1];
    rgba[i + 2] = lut[v * 3 + 2];
  }
  return rgba;
}

/**
 * Fraction of the frame that is clipped or crushed, 0–1.
 *
 * Reported as a proportion rather than a count so a number from a 640×480 feed
 * and one from a 1024×768 feed mean the same thing.
 */
export function clipStats(rgba, { overAt = 250, underAt = 4, step = 4 } = {}) {
  let over = 0;
  let under = 0;
  let total = 0;
  for (let i = 0; i < rgba.length; i += 4 * step) {
    const y = luma(rgba[i], rgba[i + 1], rgba[i + 2]);
    if (y >= overAt) over += 1;
    else if (y <= underAt) under += 1;
    total += 1;
  }
  if (total === 0) return { over: 0, under: 0 };
  return { over: over / total, under: under / total };
}

/**
 * Marks clipped and crushed pixels without recolouring the rest.
 *
 * Unlike false colour this leaves the picture recognisable, which is what makes
 * it usable as a permanent overlay during a take rather than something switched
 * on to check and off again.
 */
export function markClipping(rgba, { overAt = 250, underAt = 4 } = {}) {
  for (let i = 0; i < rgba.length; i += 4) {
    const y = luma(rgba[i], rgba[i + 1], rgba[i + 2]);
    if (y >= overAt) { rgba[i] = 255; rgba[i + 1] = 0; rgba[i + 2] = 0; }
    else if (y <= underAt) { rgba[i] = 0; rgba[i + 1] = 90; rgba[i + 2] = 255; }
  }
  return rgba;
}

/**
 * Average colour of a region, for picture-based white balance comparison.
 *
 * `region` is normalised (0–1) so the caller does not need the frame size.
 */
export function averageColour(rgba, width, height, region = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }) {
  const x0 = Math.max(0, Math.floor(region.x * width));
  const y0 = Math.max(0, Math.floor(region.y * height));
  const x1 = Math.min(width, Math.ceil((region.x + region.w) * width));
  const y1 = Math.min(height, Math.ceil((region.y + region.h) * height));
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2];
      n += 1;
    }
  }
  if (n === 0) return { r: 0, g: 0, b: 0, n: 0 };
  return { r: r / n, g: g / n, b: b / n, n };
}

/**
 * Where the picture actually sits inside a `object-fit: contain` element.
 *
 * The feed canvas is stretched to fill its tile, but `contain` scales the
 * *bitmap* to fit while preserving aspect ratio, so unless the two ratios match
 * exactly there are bars down the sides or along the top and bottom. The
 * element's bounding rect covers the bars; the picture does not.
 *
 * Getting this wrong is invisible rather than loud, which is how it survived:
 * the fake backend's test card is 160x90, exactly the 16:9 of the tile, and
 * that is the one ratio where the element rect and the image rect are the same
 * thing. A real 4:3 live view is pillarboxed and every tap is offset and
 * scaled.
 *
 * @returns {{x:number,y:number,w:number,h:number,scale:number}} in element space
 */
export function containRect(elementW, elementH, imageW, imageH) {
  if (!(elementW > 0 && elementH > 0 && imageW > 0 && imageH > 0)) {
    return { x: 0, y: 0, w: 0, h: 0, scale: 0 };
  }
  const scale = Math.min(elementW / imageW, elementH / imageH);
  const w = imageW * scale;
  const h = imageH * scale;
  return { x: (elementW - w) / 2, y: (elementH - h) / 2, w, h, scale };
}

/**
 * A click in element space to normalised image coordinates.
 *
 * Returns null for a click that landed on a letterbox bar. That is deliberate
 * and is not the same as clamping to the edge: tapping the black band beside
 * the picture is not a request to focus at the extreme edge of frame, and
 * silently treating it as one puts focus somewhere nobody pointed at.
 *
 * @returns {{x:number,y:number}|null} each 0..1 within the picture
 */
export function pointToImage(offsetX, offsetY, elementW, elementH, imageW, imageH) {
  const r = containRect(elementW, elementH, imageW, imageH);
  if (r.w <= 0 || r.h <= 0) return null;
  const x = (offsetX - r.x) / r.w;
  const y = (offsetY - r.y) / r.h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

// --- drawing ---------------------------------------------------------------

/** Histogram in a corner of the tile: small, unlabelled, read at a glance. */
export function drawHistogram(ctx, hist, { x, y, w, h }) {
  const peak = Math.max(1, ...hist);
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x, y, w, h);

  const barW = w / hist.length;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (let i = 0; i < hist.length; i++) {
    const barH = (hist[i] / peak) * (h - 2);
    ctx.fillRect(x + i * barW, y + h - barH - 1, Math.max(1, barW - 0.5), barH);
  }

  // Clipping edges marked in the colours they mean elsewhere in the panel, so
  // the histogram and the false-colour view agree with each other.
  ctx.fillStyle = 'rgba(235,30,30,0.9)';
  ctx.fillRect(x + w - 2, y, 2, h);
  ctx.fillStyle = 'rgba(0,110,255,0.9)';
  ctx.fillRect(x, y, 2, h);
  ctx.restore();
}

/**
 * Framing guides.
 *
 * Drawn as vector over the picture rather than baked into it, so switching one
 * on costs nothing per pixel and the underlying frame is never altered.
 */
export function drawGuides(ctx, w, h, guides = {}) {
  ctx.save();
  ctx.lineWidth = 1;

  if (guides.thirds) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      ctx.moveTo((w * i) / 3, 0); ctx.lineTo((w * i) / 3, h);
      ctx.moveTo(0, (h * i) / 3); ctx.lineTo(w, (h * i) / 3);
    }
    ctx.stroke();
  }

  if (guides.centre) {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    const s = Math.min(w, h) * 0.03;
    ctx.beginPath();
    ctx.moveTo(w / 2 - s, h / 2); ctx.lineTo(w / 2 + s, h / 2);
    ctx.moveTo(w / 2, h / 2 - s); ctx.lineTo(w / 2, h / 2 + s);
    ctx.stroke();
  }

  if (guides.safe) {
    // 90% action safe — the region that survives any sane delivery crop.
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(w * 0.05, h * 0.05, w * 0.9, h * 0.9);
    ctx.setLineDash([]);
  }

  // Mattes are drawn as solid bars rather than lines: the point is to see the
  // frame as it will be delivered, and a thin line does not tell you what is
  // being lost.
  if (guides.matte && guides.matte !== 'off') {
    const target = guides.matte === '2.39' ? 2.39 : 16 / 9;
    const current = w / h;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    if (current < target) {
      const keep = w / target;
      const bar = (h - keep) / 2;
      ctx.fillRect(0, 0, w, bar);
      ctx.fillRect(0, h - bar, w, bar);
    } else if (current > target) {
      const keep = h * target;
      const bar = (w - keep) / 2;
      ctx.fillRect(0, 0, bar, h);
      ctx.fillRect(w - bar, 0, bar, h);
    }
  }
  ctx.restore();
}

/** Clip readout, shown only when there is something to report. */
export function drawClipReadout(ctx, stats, { x, y }) {
  const parts = [];
  if (stats.over > 0.002) parts.push(`${(stats.over * 100).toFixed(1)}% clipped`);
  if (stats.under > 0.002) parts.push(`${(stats.under * 100).toFixed(1)}% crushed`);
  if (!parts.length) return;

  const text = parts.join('   ');
  ctx.save();
  ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  const wide = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x, y, wide + 10, 17);
  ctx.fillStyle = stats.over > 0.002 ? '#ff5a5a' : '#6aa8ff';
  ctx.fillText(text, x + 5, y + 12);
  ctx.restore();
}
