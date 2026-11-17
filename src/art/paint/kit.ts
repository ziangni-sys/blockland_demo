/**
 * Shared helpers for the tile painters: painter type, region bevels, blob growth.
 */
import { TILE_SIZE } from '../../core/constants';
import { hashString, Rng } from '../../core/rng';
import { Canvas, wrap } from '../canvas';

/** Paints one tile into a cleared canvas. `seed` is derived from the tile name. */
export type Painter = (c: Canvas, seed: number) => void;

export const S = TILE_SIZE;

/** Stable per-name seed. Painters that reuse another material's base pass that name's seed. */
export function seedOf(name: string): number {
  return hashString(`blocklands-art:${name}`);
}

export function rngOf(seed: number, salt = 0): Rng {
  return new Rng((seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0);
}

/**
 * Bevel term for a pixel of a region map (`-1` = no region, e.g. mortar / gap): the light
 * comes from the top-left, so a pixel whose up / left neighbour lies outside its region is
 * a lit rim (+1), one whose down / right neighbour lies outside is a shadow rim (-1).
 * Corners get both; the sum is returned (range -2..2).
 */
export function bevel(region: Int16Array, x: number, y: number, size: number = S): number {
  const id = region[wrap(y, size) * size + wrap(x, size)]!;
  if (id < 0) return 0;
  const at = (dx: number, dy: number): boolean => region[wrap(y + dy, size) * size + wrap(x + dx, size)] === id;
  let b = 0;
  if (!at(0, -1)) b += 1;
  if (!at(-1, 0)) b += 1;
  if (!at(0, 1)) b -= 1;
  if (!at(1, 0)) b -= 1;
  return b;
}

/** True when the pixel lies on the boundary of its region (any 4-neighbour differs). */
export function isRim(region: Int16Array, x: number, y: number, size: number = S): boolean {
  const id = region[wrap(y, size) * size + wrap(x, size)];
  return (
    region[wrap(y - 1, size) * size + wrap(x, size)] !== id ||
    region[wrap(y + 1, size) * size + wrap(x, size)] !== id ||
    region[wrap(y, size) * size + wrap(x - 1, size)] !== id ||
    region[wrap(y, size) * size + wrap(x + 1, size)] !== id
  );
}

/**
 * Grows a connected blob of `cells` pixels from the origin by random 4-neighbour accretion.
 * `compact` in 0..1 biases growth toward the blob's centre (1 = round, 0 = stringy).
 * Returns pixel offsets relative to the origin.
 */
export function growBlob(rng: Rng, cells: number, compact: number, stretchX = 1): Array<[number, number]> {
  const out: Array<[number, number]> = [[0, 0]];
  const has = (x: number, y: number): boolean => out.some((p) => p[0] === x && p[1] === y);
  while (out.length < cells) {
    let cx = 0;
    let cy = 0;
    for (const p of out) {
      cx += p[0];
      cy += p[1];
    }
    cx /= out.length;
    cy /= out.length;
    // Candidate frontier cells, scored by distance to the centroid plus noise.
    let best: [number, number] | null = null;
    let bestScore = Infinity;
    for (const p of out) {
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = p[0] + dx;
        const ny = p[1] + dy;
        if (has(nx, ny)) continue;
        const ddx = (nx - cx) / stretchX;
        const ddy = ny - cy;
        const score = Math.sqrt(ddx * ddx + ddy * ddy) * compact + rng.next() * 2.2;
        if (score < bestScore) {
          bestScore = score;
          best = [nx, ny];
        }
      }
    }
    out.push(best!);
  }
  return out;
}

/** Region map (Int16Array, -1 everywhere) sized for a tile. */
export function regionMap(size: number = S): Int16Array {
  return new Int16Array(size * size).fill(-1);
}

/** Copies a painted tile into another canvas (both same size). */
export function copyCanvas(dst: Canvas, src: Canvas): void {
  dst.data.set(src.data);
}
