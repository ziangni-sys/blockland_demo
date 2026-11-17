/**
 * Seeded gradient noise for world generation: 2D and 3D simplex noise plus fractal helpers.
 *
 * Every function here is a PURE function of (seed, coordinates). There are no permutation
 * tables or other per-seed state: lattice gradients are picked by an integer hash of the
 * lattice point and the seed, so any seed works instantly and two callers can never disturb
 * each other.
 *
 * Determinism across JS engines: only IEEE-754 exact operations are used (+ - * /, floor,
 * abs, imul). No Math.sin / Math.pow / Math.exp, whose last bit may differ between
 * engines; constants that would need them are written out as literals. This keeps chunks
 * generated in a browser Worker bit-identical to chunks generated in Node tests.
 */

// ---------------------------------------------------------------- hashing

/** Hash of a 2D lattice point + seed to a uint32. Cheaper than core/rng's hash3. */
export function latticeHash2(seed: number, ix: number, iy: number): number {
  let h = (seed ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash of a 3D lattice point + seed to a uint32. */
export function latticeHash3(seed: number, ix: number, iy: number, iz: number): number {
  let h = (seed ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(iz, 0x1b873593)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Derive an independent sub-seed (e.g. one per noise layer or octave) from a base seed and a
 * small integer salt. Using different salts for different fields keeps them uncorrelated.
 */
export function deriveSeed(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt + 0x632be5ab, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

// ---------------------------------------------------------------- gradients

/**
 * 2D gradients: 32 unit vectors evenly spread around the circle (offset by half a step so
 * none is axis aligned). Many directions avoid the "diamond" artefacts of the classic
 * 8-gradient set. Values are cos/sin of (k + 0.5) * 2pi / 32, written out as literals.
 */
const G2X = new Float64Array([
  0.9951847266721969, 0.9569403357322088, 0.881921264348355, 0.773010453362737, 0.6343932841636455,
  0.4713967368259978, 0.29028467725446233, 0.09801714032956077, -0.09801714032956065, -0.29028467725446216,
  -0.4713967368259977, -0.6343932841636454, -0.773010453362737, -0.8819212643483549, -0.9569403357322088,
  -0.9951847266721968, -0.9951847266721969, -0.9569403357322089, -0.881921264348355, -0.7730104533627371,
  -0.6343932841636459, -0.47139673682599786, -0.29028467725446244, -0.09801714032956045, 0.09801714032956009,
  0.29028467725446205, 0.4713967368259976, 0.6343932841636456, 0.7730104533627367, 0.8819212643483548,
  0.9569403357322088, 0.9951847266721969,
]);
const G2Y = new Float64Array([
  0.0980171403295606, 0.29028467725446233, 0.47139673682599764, 0.6343932841636455, 0.773010453362737,
  0.8819212643483549, 0.9569403357322089, 0.9951847266721968, 0.9951847266721969, 0.9569403357322089,
  0.881921264348355, 0.7730104533627371, 0.6343932841636455, 0.47139673682599786, 0.2902846772544624,
  0.09801714032956083, -0.09801714032956059, -0.2902846772544621, -0.47139673682599764, -0.6343932841636453,
  -0.7730104533627367, -0.8819212643483549, -0.9569403357322088, -0.9951847266721969, -0.9951847266721969,
  -0.9569403357322089, -0.881921264348355, -0.7730104533627369, -0.6343932841636459, -0.4713967368259979,
  -0.2902846772544625, -0.0980171403295605,
]);

/** 3D gradients: the 12 cube-edge directions, padded to 16 (classic improved-noise trick). */
const G3X = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0, 1, -1, 0, 0]);
const G3Y = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, 1, -1, -1]);
const G3Z = new Float64Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1, 0, 0, 1, -1]);

// ---------------------------------------------------------------- simplex 2D

const F2 = 0.36602540378443865; // (sqrt(3) - 1) / 2
const G2 = 0.21132486540518713; // (3 - sqrt(3)) / 6
/** 1 / (worst-case raw sum with every gradient aligned to its offset), so |result| <= 1. */
const NORM2 = 99.2;

/** 2D simplex noise, approximately in [-1, 1], zero at lattice points, continuous (C2). */
export function simplex2(seed: number, x: number, y: number): number {
  const s = (x + y) * F2;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  let i1: number;
  let j1: number;
  if (x0 > y0) {
    i1 = 1;
    j1 = 0;
  } else {
    i1 = 0;
    j1 = 1;
  }
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;

  let n = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) {
    const g = latticeHash2(seed, i, j) & 31;
    t0 *= t0;
    n += t0 * t0 * (G2X[g]! * x0 + G2Y[g]! * y0);
  }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) {
    const g = latticeHash2(seed, i + i1, j + j1) & 31;
    t1 *= t1;
    n += t1 * t1 * (G2X[g]! * x1 + G2Y[g]! * y1);
  }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) {
    const g = latticeHash2(seed, i + 1, j + 1) & 31;
    t2 *= t2;
    n += t2 * t2 * (G2X[g]! * x2 + G2Y[g]! * y2);
  }
  return n * NORM2;
}

// ---------------------------------------------------------------- simplex 3D

const F3 = 1 / 3;
const G3 = 1 / 6;
/**
 * Kernel radius^2 is 0.5 (not the 0.6 of many reference implementations): with 0.6 a
 * vertex outside the current simplex can still contribute, which makes the noise
 * discontinuous along simplex faces — visible as seams in caves.
 */
const NORM3 = 76.8;

/** 3D simplex noise, approximately in [-1, 1], continuous. */
export function simplex3(seed: number, x: number, y: number, z: number): number {
  const s = (x + y + z) * F3;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const k = Math.floor(z + s);
  const t = (i + j + k) * G3;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const z0 = z - (k - t);

  let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
  if (x0 >= y0) {
    if (y0 >= z0) {
      i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
    } else if (x0 >= z0) {
      i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
    } else {
      i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
    }
  } else if (y0 < z0) {
    i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
  } else if (x0 < z0) {
    i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
  } else {
    i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
  }

  const x1 = x0 - i1 + G3;
  const y1 = y0 - j1 + G3;
  const z1 = z0 - k1 + G3;
  const x2 = x0 - i2 + 2 * G3;
  const y2 = y0 - j2 + 2 * G3;
  const z2 = z0 - k2 + 2 * G3;
  const x3 = x0 - 1 + 3 * G3;
  const y3 = y0 - 1 + 3 * G3;
  const z3 = z0 - 1 + 3 * G3;

  let n = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0 - z0 * z0;
  if (t0 > 0) {
    const g = latticeHash3(seed, i, j, k) & 15;
    t0 *= t0;
    n += t0 * t0 * (G3X[g]! * x0 + G3Y[g]! * y0 + G3Z[g]! * z0);
  }
  let t1 = 0.5 - x1 * x1 - y1 * y1 - z1 * z1;
  if (t1 > 0) {
    const g = latticeHash3(seed, i + i1, j + j1, k + k1) & 15;
    t1 *= t1;
    n += t1 * t1 * (G3X[g]! * x1 + G3Y[g]! * y1 + G3Z[g]! * z1);
  }
  let t2 = 0.5 - x2 * x2 - y2 * y2 - z2 * z2;
  if (t2 > 0) {
    const g = latticeHash3(seed, i + i2, j + j2, k + k2) & 15;
    t2 *= t2;
    n += t2 * t2 * (G3X[g]! * x2 + G3Y[g]! * y2 + G3Z[g]! * z2);
  }
  let t3 = 0.5 - x3 * x3 - y3 * y3 - z3 * z3;
  if (t3 > 0) {
    const g = latticeHash3(seed, i + 1, j + 1, k + 1) & 15;
    t3 *= t3;
    n += t3 * t3 * (G3X[g]! * x3 + G3Y[g]! * y3 + G3Z[g]! * z3);
  }
  return n * NORM3;
}

// ---------------------------------------------------------------- fractal sums

/**
 * Per-octave rotation of the sample plane (cos, sin of ~0.62 rad). Rotating every octave
 * keeps the lattice directions of successive octaves from lining up, which otherwise shows
 * as faint grid-aligned streaks in fractal terrain.
 */
const ROT_C = 0.8138784566625339;
const ROT_S = 0.5810351605373051;

/**
 * Fractal Brownian motion of 2D simplex noise, normalised so the result stays roughly in
 * [-1, 1] whatever the octave count. `x, y` are in noise units (divide world coordinates
 * by the feature size before calling).
 */
export function fbm2(seed: number, x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let px = x;
  let py = y;
  for (let o = 0; o < octaves; o++) {
    sum += amp * simplex2((seed + Math.imul(o, 0x3c6ef372)) | 0, px, py);
    norm += amp;
    amp *= gain;
    const rx = (px * ROT_C - py * ROT_S) * lacunarity;
    py = (px * ROT_S + py * ROT_C) * lacunarity;
    px = rx;
  }
  return sum / norm;
}

/** 3D fBm of simplex noise, normalised to roughly [-1, 1]. */
export function fbm3(
  seed: number,
  x: number,
  y: number,
  z: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let px = x;
  let py = y;
  let pz = z;
  for (let o = 0; o < octaves; o++) {
    sum += amp * simplex3((seed + Math.imul(o, 0x3c6ef372)) | 0, px, py, pz);
    norm += amp;
    amp *= gain;
    // Rotate about Y between octaves (same reason as fbm2), then scale.
    const rx = (px * ROT_C - pz * ROT_S) * lacunarity;
    pz = (px * ROT_S + pz * ROT_C) * lacunarity;
    px = rx;
    py *= lacunarity;
  }
  return sum / norm;
}

/**
 * Ridged multifractal (Musgrave): sharp crests where the underlying noise crosses zero,
 * each octave weighted by the previous one so detail concentrates on the ridges.
 * Result is in [0, 1]; 1 on a ridge line.
 */
export function ridged2(seed: number, x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let weight = 1;
  let px = x;
  let py = y;
  for (let o = 0; o < octaves; o++) {
    let v = 1 - Math.abs(simplex2((seed + Math.imul(o, 0x3c6ef372)) | 0, px, py));
    v *= v;
    v *= weight;
    weight = v * 1.5;
    if (weight > 1) weight = 1;
    sum += v * amp;
    norm += amp;
    amp *= gain;
    const rx = (px * ROT_C - py * ROT_S) * lacunarity;
    py = (px * ROT_S + py * ROT_C) * lacunarity;
    px = rx;
  }
  return sum / norm;
}

// ---------------------------------------------------------------- shaping helpers

/** Hermite smoothstep: 0 at e0, 1 at e1, clamped. Works for e0 > e1 too (falls instead). */
export function smoothstep(e0: number, e1: number, v: number): number {
  let t = (v - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** Clamp to [0, 1]. */
export function saturate(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
