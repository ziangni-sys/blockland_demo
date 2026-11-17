/**
 * Land/sea balance: a slowly varying offset added to continentalness so that every
 * player-sized window of the world is roughly half sea.
 *
 * Why: the island features (180-330 blocks) are only two or three times smaller than a
 * 512-block window, so by chance alone a window of the raw field can come out 30 % or
 * 70 % sea. The fix measures the raw field instead of hoping: at every node of a coarse
 * lattice (spacing CELL) the offset is minus a target quantile of the raw field over a
 * WINDOW x WINDOW square around the node (sampled every STRIDE blocks), so the sea fraction
 * of that square lands on the target. Between nodes the offset is blended with C1
 * (smoothstep-weighted) bilinear weights; it changes by a few hundredths over hundreds of
 * blocks, far too slowly to crease the terrain.
 *
 * A node's value is a pure function of (seed, node), so the cache only saves work: what
 * was cached before never changes a result, and chunks stay order-independent.
 */
import { fbm2 } from './noise';

/** What the balance needs from the terrain model: the uncorrected land/sea field. */
export interface RawContSource {
  rawContAt(x: number, z: number): number;
}

/** Lattice spacing of the correction (blocks). */
const CELL = 128;
/** Side of the square each node measures (blocks); twice CELL, so node squares overlap. */
const WINDOW = 512;
/** Sample spacing inside a node's square (blocks). */
const STRIDE = 16;
const PER_SIDE = WINDOW / STRIDE;
const SAMPLES = PER_SIDE * PER_SIDE;
/**
 * Target share of raw-sea columns per window. Slightly below one half because inland
 * lakes add about one percent more water on top.
 */
const SEA_TARGET = 0.49;
/** Regions drift around the target by up to about this much (very low-frequency noise). */
const SEA_SWING = 0.05;
/** Nodes kept in the cache (each covers CELL x CELL blocks: 4096 nodes = 16k x 16k blocks). */
const MAX_NODES = 4096;
const KEY_BIAS = 1 << 16;
const KEY_MUL = 1 << 17;

export class LandBalance {
  private readonly src: RawContSource;
  private readonly seed: number;
  private readonly cache = new Map<number, number>();
  private readonly samples = new Float64Array(SAMPLES);
  // The four nodes of the last lattice cell queried (columns arrive in runs).
  private memoIx = Number.NaN;
  private memoIz = Number.NaN;
  private o00 = 0;
  private o10 = 0;
  private o01 = 0;
  private o11 = 0;

  constructor(src: RawContSource, seed: number) {
    this.src = src;
    this.seed = seed;
  }

  /** Offset to add to the raw continentalness of column (x, z). */
  offset(x: number, z: number): number {
    const ix = Math.floor(x / CELL);
    const iz = Math.floor(z / CELL);
    if (ix !== this.memoIx || iz !== this.memoIz) {
      this.o00 = this.node(ix, iz);
      this.o10 = this.node(ix + 1, iz);
      this.o01 = this.node(ix, iz + 1);
      this.o11 = this.node(ix + 1, iz + 1);
      this.memoIx = ix;
      this.memoIz = iz;
    }
    let fx = (x - ix * CELL) / CELL;
    let fz = (z - iz * CELL) / CELL;
    fx = fx * fx * (3 - 2 * fx);
    fz = fz * fz * (3 - 2 * fz);
    const a = this.o00 + (this.o10 - this.o00) * fx;
    const b = this.o01 + (this.o11 - this.o01) * fx;
    return a + (b - a) * fz;
  }

  private node(ix: number, iz: number): number {
    const key = (ix + KEY_BIAS) * KEY_MUL + (iz + KEY_BIAS);
    let v = this.cache.get(key);
    if (v === undefined) {
      v = this.measure(ix, iz);
      if (this.cache.size >= MAX_NODES) {
        // Drop the oldest entry (Map iterates in insertion order). Recomputing a dropped
        // node later yields the identical value.
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(key, v);
    }
    return v;
  }

  /** Minus the target quantile of the raw field over the node's square. */
  private measure(ix: number, iz: number): number {
    const cx = ix * CELL;
    const cz = iz * CELL;
    const first = -WINDOW / 2 + STRIDE / 2;
    const s = this.samples;
    let k = 0;
    for (let j = 0; j < PER_SIDE; j++) {
      for (let i = 0; i < PER_SIDE; i++) s[k++] = this.src.rawContAt(cx + first + i * STRIDE, cz + first + j * STRIDE);
    }
    s.sort();
    const target = SEA_TARGET + SEA_SWING * fbm2(this.seed, cx / 3000, cz / 3000, 2);
    const pos = target * (SAMPLES - 1);
    const lo = Math.floor(pos);
    const q = s[lo]! + (s[lo + 1]! - s[lo]!) * (pos - lo);
    return -q;
  }
}
