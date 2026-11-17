/**
 * Pure, deterministic, seamlessly tiling noise for the cloud layer (no three.js; tested).
 * Generated once at init on the CPU so the sky shader only does two texture fetches
 * instead of evaluating fractal noise per pixel.
 */
import { hash3 } from '../../core/rng';

/** Periodic value noise at integer lattice period `period`, sampled at (x, y) in lattice units. */
function periodicValueNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  // Quintic fade: C2-continuous, no grid creases in the clouds.
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const v00 = hash3(x0, y0, period, seed) / 4294967296;
  const v10 = hash3(x1, y0, period, seed) / 4294967296;
  const v01 = hash3(x0, y1, period, seed) / 4294967296;
  const v11 = hash3(x1, y1, period, seed) / 4294967296;
  const a = v00 + (v10 - v00) * ux;
  const b = v01 + (v11 - v01) * ux;
  return a + (b - a) * uy;
}

/**
 * RGBA8 tileable noise, `size` x `size` (size must be divisible by 2^(octaves-1) * baseFreq).
 * R: soft fractal noise (cloud shapes), G: higher-frequency fractal noise (detail / erosion),
 * B: R shifted by a quarter tile (cheap self-shadow lookup), A: 255.
 * Each channel is normalized to the full 0..255 range.
 */
export function makeCloudNoise(size: number, seed: number): Uint8Array {
  const r = fbm(size, seed, 4, 5, 0.52);
  const g = fbm(size, seed ^ 0x5f3759df, 8, 4, 0.55);
  normalize(r);
  normalize(g);
  const out = new Uint8Array(size * size * 4);
  const shift = size >> 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = x + y * size;
      const j = ((x + shift) % size) + ((y + shift) % size) * size;
      out[i * 4] = Math.round(r[i]! * 255);
      out[i * 4 + 1] = Math.round(g[i]! * 255);
      out[i * 4 + 2] = Math.round(r[j]! * 255);
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}

function fbm(size: number, seed: number, baseFreq: number, octaves: number, gain: number): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1;
  let freq = baseFreq;
  for (let o = 0; o < octaves; o++) {
    const scale = freq / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        out[x + y * size]! += amp * periodicValueNoise(x * scale, y * scale, freq, seed + o * 1013);
      }
    }
    amp *= gain;
    freq *= 2;
  }
  return out;
}

function normalize(a: Float32Array): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const k = hi > lo ? 1 / (hi - lo) : 0;
  for (let i = 0; i < a.length; i++) a[i] = (a[i]! - lo) * k;
}
