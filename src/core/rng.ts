/**
 * Deterministic random numbers. The simulation must never call Math.random():
 * world generation and gameplay are reproducible from the world seed.
 */

/** 32-bit integer hash (lowbias32). */
export function hash32(x: number): number {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Hash of integer coordinates + seed to a 32-bit unsigned integer. */
export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = hash32(seed ^ 0x9e3779b9);
  h = hash32(h ^ Math.imul(x | 0, 0x85ebca6b));
  h = hash32(h ^ Math.imul(y | 0, 0xc2b2ae35));
  h = hash32(h ^ Math.imul(z | 0, 0x27d4eb2f));
  return h;
}
export function hash2(x: number, z: number, seed: number): number {
  return hash3(x, 0x5bd1e995, z, seed);
}
/** Uniform float in [0,1) from integer coordinates. */
export function rand3(x: number, y: number, z: number, seed: number): number {
  return hash3(x, y, z, seed) / 4294967296;
}
export function rand2(x: number, z: number, seed: number): number {
  return hash2(x, z, seed) / 4294967296;
}

/** Hash an arbitrary string seed to a 32-bit unsigned integer (FNV-1a). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return hash32(h);
}

/** Small fast seeded PRNG (mulberry32). State is one uint32, so it serializes trivially. */
export class Rng {
  state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  /** Uniform uint32. */
  nextU32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  /** Uniform float in [0,1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }
  /** Uniform float in [lo,hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  /** Uniform integer in [lo,hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}
