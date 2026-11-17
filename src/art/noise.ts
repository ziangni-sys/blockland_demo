/**
 * Periodic noise for seamless tiles. Every function here is periodic in TILE_SIZE (16 px) in
 * both axes, so anything built from it tiles without seams. Randomness comes only from the
 * integer hashes of core/rng.ts (deterministic, no Math.random).
 */
import { TILE_SIZE } from '../core/constants';
import { hash3, Rng } from '../core/rng';
import { wrap, wrapDelta } from './canvas';

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Value noise in [0,1) sampled at pixel centre (x, y), with `cx` x `cy` lattice cells across
 * the tile. Anisotropic lattices (cx != cy) give streaks: few cells along an axis = long
 * features along it. Periodic in TILE_SIZE because lattice indices wrap modulo the cell count.
 */
export function vnoise(x: number, y: number, cx: number, cy: number, seed: number): number {
  const u = ((x + 0.5) * cx) / TILE_SIZE;
  const v = ((y + 0.5) * cy) / TILE_SIZE;
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  const fu = smooth(u - iu);
  const fv = smooth(v - iv);
  const u0 = wrap(iu, cx);
  const u1 = wrap(iu + 1, cx);
  const v0 = wrap(iv, cy);
  const v1 = wrap(iv + 1, cy);
  const a = hash3(u0, v0, cx * 131 + cy, seed) / 4294967296;
  const b = hash3(u1, v0, cx * 131 + cy, seed) / 4294967296;
  const c = hash3(u0, v1, cx * 131 + cy, seed) / 4294967296;
  const d = hash3(u1, v1, cx * 131 + cy, seed) / 4294967296;
  return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv;
}

/**
 * Fractal sum of value noise, normalized to [0,1). The lattice doubles per octave (it stays
 * a divisor-friendly integer, so every octave remains periodic).
 */
export function fbm(x: number, y: number, cells: number, octaves: number, seed: number, gain = 0.5, cellsY = cells): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let cx = cells;
  let cy = cellsY;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(x, y, cx, cy, seed + o * 7919) * amp;
    norm += amp;
    amp *= gain;
    cx *= 2;
    cy *= 2;
  }
  return sum / norm;
}

/** Signed variant of fbm in [-1, 1). */
export function sfbm(x: number, y: number, cells: number, octaves: number, seed: number, gain = 0.5, cellsY = cells): number {
  return fbm(x, y, cells, octaves, seed, gain, cellsY) * 2 - 1;
}

/** Uniform hash in [0,1) of integer coordinates, for per-pixel decisions. */
export function hrand(x: number, y: number, seed: number): number {
  return hash3(wrap(x | 0), wrap(y | 0), 0x51ed, seed) / 4294967296;
}

// ---------------------------------------------------------------- feature points

/** A feature point on the tile torus. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Dart-throwing scatter of `count` points with a toroidal minimum distance. The minimum
 * distance relaxes if the tile gets crowded, so it always returns exactly `count` points.
 */
export function scatter(rng: Rng, count: number, minDist: number, size: number = TILE_SIZE): Point[] {
  const pts: Point[] = [];
  let md = minDist;
  let tries = 0;
  while (pts.length < count) {
    const p = { x: rng.next() * size, y: rng.next() * size };
    let ok = true;
    for (const q of pts) {
      const dx = wrapDelta(p.x - q.x, size);
      const dy = wrapDelta(p.y - q.y, size);
      if (dx * dx + dy * dy < md * md) {
        ok = false;
        break;
      }
    }
    if (ok) pts.push(p);
    if (++tries > 60) {
      md *= 0.9;
      tries = 0;
    }
  }
  return pts;
}

/** Result of a cellular (Worley) query. Distances in pixels. */
export interface Worley {
  /** Nearest, second and third nearest feature distances. */
  f1: number;
  f2: number;
  f3: number;
  /** Index of the nearest / second nearest point. */
  id: number;
  id2: number;
  /** Offset from the nearest point to the sample (toroidal). */
  ox: number;
  oy: number;
}

export function worleyResult(): Worley {
  return { f1: 0, f2: 0, f3: 0, id: 0, id2: 0, ox: 0, oy: 0 };
}

/**
 * Toroidal Worley query at the centre of pixel (x, y). `sy` scales vertical distances
 * (sy < 1 stretches cells vertically). Writes into and returns `out`.
 */
export function worley(pts: readonly Point[], x: number, y: number, out: Worley, sy = 1): Worley {
  const px = x + 0.5;
  const py = y + 0.5;
  let f1 = Infinity;
  let f2 = Infinity;
  let f3 = Infinity;
  let id = 0;
  let id2 = 0;
  let ox = 0;
  let oy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const dx = wrapDelta(px - p.x);
    const dy = wrapDelta(py - p.y);
    const d = Math.sqrt(dx * dx + dy * dy * sy * sy);
    if (d < f1) {
      f3 = f2;
      f2 = f1;
      id2 = id;
      f1 = d;
      id = i;
      ox = dx;
      oy = dy;
    } else if (d < f2) {
      f3 = f2;
      f2 = d;
      id2 = i;
    } else if (d < f3) {
      f3 = d;
    }
  }
  out.f1 = f1;
  out.f2 = f2;
  out.f3 = f3;
  out.id = id;
  out.id2 = id2;
  out.ox = ox;
  out.oy = oy;
  return out;
}
