/**
 * Pixel canvas and tone fields for tile painting.
 *
 * All coordinates WRAP (torus topology): painting at x = -1 lands on the last column, a disc
 * centred near an edge continues on the opposite edge. That single rule is what makes every
 * pattern tile seamlessly at 16 px without each painter having to think about it.
 */
import { TILE_SIZE } from '../core/constants';
import type { Ramp, RGB } from './color';
import { clampByte } from './color';

/** Wrap an integer coordinate into 0..n-1. */
export function wrap(v: number, n: number = TILE_SIZE): number {
  const r = v % n;
  return r < 0 ? r + n : r;
}

/** Shortest signed toroidal offset for a period of n (result in [-n/2, n/2)). */
export function wrapDelta(d: number, n: number = TILE_SIZE): number {
  return d - n * Math.floor(d / n + 0.5);
}

/** RGBA8 square canvas with wrapping coordinates. Row 0 is the top row. */
export class Canvas {
  readonly size: number;
  readonly data: Uint8Array;

  constructor(size: number = TILE_SIZE) {
    this.size = size;
    this.data = new Uint8Array(size * size * 4);
  }

  /** Byte offset of a (wrapped) pixel. */
  offset(x: number, y: number): number {
    const s = this.size;
    return (wrap(y | 0, s) * s + wrap(x | 0, s)) * 4;
  }

  set(x: number, y: number, c: RGB, a = 255): void {
    const o = this.offset(x, y);
    const d = this.data;
    d[o] = c[0];
    d[o + 1] = c[1];
    d[o + 2] = c[2];
    d[o + 3] = a;
  }

  /** Overwrites only the colour, keeping alpha. */
  setRGB(x: number, y: number, c: RGB): void {
    const o = this.offset(x, y);
    const d = this.data;
    d[o] = c[0];
    d[o + 1] = c[1];
    d[o + 2] = c[2];
  }

  setAlpha(x: number, y: number, a: number): void {
    this.data[this.offset(x, y) + 3] = a;
  }

  alpha(x: number, y: number): number {
    return this.data[this.offset(x, y) + 3]!;
  }

  /** Fresh copy of a pixel's colour. */
  rgb(x: number, y: number): RGB {
    const o = this.offset(x, y);
    const d = this.data;
    return [d[o]!, d[o + 1]!, d[o + 2]!];
  }

  /** Mixes the pixel's colour toward `c` by t (0..1); alpha is unchanged. */
  tint(x: number, y: number, c: RGB, t: number): void {
    const o = this.offset(x, y);
    const d = this.data;
    d[o] = clampByte(d[o]! + (c[0] - d[o]!) * t);
    d[o + 1] = clampByte(d[o + 1]! + (c[1] - d[o + 1]!) * t);
    d[o + 2] = clampByte(d[o + 2]! + (c[2] - d[o + 2]!) * t);
  }

  fill(c: RGB, a = 255): void {
    const n = this.size * this.size;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      this.data[o] = c[0];
      this.data[o + 1] = c[1];
      this.data[o + 2] = c[2];
      this.data[o + 3] = a;
    }
  }

  clear(): void {
    this.data.fill(0);
  }
}

/**
 * A scalar field over the tile, in "tone units" (ramp indices, fractional allowed).
 * Painters build up a field and quantize it through a ramp once at the end; that keeps the
 * palette strictly limited (crisp pixel-art look) while composing effects additively.
 * A value of NaN marks a transparent pixel.
 */
export class Field {
  readonly size: number;
  readonly v: Float32Array;

  constructor(size: number = TILE_SIZE, init = 0) {
    this.size = size;
    this.v = new Float32Array(size * size).fill(init);
  }
  index(x: number, y: number): number {
    return wrap(y | 0, this.size) * this.size + wrap(x | 0, this.size);
  }
  get(x: number, y: number): number {
    return this.v[this.index(x, y)]!;
  }
  set(x: number, y: number, t: number): void {
    this.v[this.index(x, y)] = t;
  }
  add(x: number, y: number, t: number): void {
    this.v[this.index(x, y)]! += t;
  }
  /** Sets every pixel from f(x, y). */
  each(f: (x: number, y: number, cur: number) => number): void {
    const s = this.size;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) this.v[y * s + x] = f(x, y, this.v[y * s + x]!);
  }
}

/** 4x4 Bayer matrix, thresholds in [-0.5, 0.5). Period 4 divides the tile size, so it wraps. */
const BAYER4: readonly number[] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);

export function bayer(x: number, y: number): number {
  return BAYER4[(wrap(y, 4) << 2) | wrap(x, 4)]!;
}

/** Quantized ramp index of a tone value (with optional ordered dither strength 0..1). */
export function toneIndex(t: number, n: number, x = 0, y = 0, dither = 0): number {
  const v = Math.round(t + (dither ? bayer(x, y) * dither : 0));
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

/**
 * Writes a field into the canvas through a ramp. NaN pixels become fully transparent.
 * `alpha` is the alpha written for every painted pixel.
 */
export function paintField(c: Canvas, f: Field, r: Ramp, opts: { dither?: number; alpha?: number } = {}): void {
  const s = c.size;
  const dither = opts.dither ?? 0;
  const a = opts.alpha ?? 255;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const t = f.v[y * s + x]!;
      if (Number.isNaN(t)) {
        c.set(x, y, r[0]!, 0);
        continue;
      }
      c.set(x, y, r[toneIndex(t, r.length, x, y, dither)]!, a);
    }
  }
}

// ---------------------------------------------------------------- shapes (wrapping)

/** Calls fn for every integer pixel on the segment (Bresenham; endpoints included). */
export function forLine(x0: number, y0: number, x1: number, y1: number, fn: (x: number, y: number, i: number) => void): void {
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let i = 0;
  for (;;) {
    fn(x0, y0, i++);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/**
 * Calls fn for every pixel whose centre lies inside the ellipse centred at (cx, cy) with
 * radii (rx, ry). `d` is the normalized distance (0 centre .. 1 rim), (ox, oy) the offset of
 * the pixel centre from the ellipse centre. Pixel coordinates are NOT wrapped (the canvas
 * and field wrap on write), so shapes continue across tile edges.
 */
export function forEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fn: (x: number, y: number, d: number, ox: number, oy: number) => void,
): void {
  const x0 = Math.floor(cx - rx - 1);
  const x1 = Math.ceil(cx + rx + 1);
  const y0 = Math.floor(cy - ry - 1);
  const y1 = Math.ceil(cy + ry + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const ox = x + 0.5 - cx;
      const oy = y + 0.5 - cy;
      const d = Math.sqrt((ox * ox) / (rx * rx) + (oy * oy) / (ry * ry));
      if (d <= 1) fn(x, y, d, ox, oy);
    }
  }
}

/**
 * Alpha bleeding: gives fully transparent pixels the colour of their nearest opaque
 * neighbours. Invisible at full resolution, but it stops linear filtering / mipmapping
 * from pulling dark fringes into cutout edges. Alpha is untouched.
 */
export function bleedTransparent(c: Canvas): void {
  const s = c.size;
  const n = s * s;
  const known = new Uint8Array(n);
  let remaining = 0;
  for (let i = 0; i < n; i++) {
    if (c.data[i * 4 + 3]! > 0) known[i] = 1;
    else remaining++;
  }
  if (remaining === n || remaining === 0) return;
  const next = new Uint8Array(n);
  while (remaining > 0) {
    next.set(known);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const i = y * s + x;
        if (known[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const j = wrap(y + dy, s) * s + wrap(x + dx, s);
            if (!known[j]) continue;
            r += c.data[j * 4]!;
            g += c.data[j * 4 + 1]!;
            b += c.data[j * 4 + 2]!;
            k++;
          }
        }
        if (k) {
          c.data[i * 4] = Math.round(r / k);
          c.data[i * 4 + 1] = Math.round(g / k);
          c.data[i * 4 + 2] = Math.round(b / k);
          next[i] = 1;
          remaining--;
        }
      }
    }
    known.set(next);
  }
}
