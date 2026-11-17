import { describe, expect, it } from 'vitest';
import {
  deriveSeed,
  fbm2,
  fbm3,
  latticeHash2,
  ridged2,
  simplex2,
  simplex3,
  smoothstep,
} from '../../src/worldgen/noise';
import { Rng } from '../../src/core/rng';

describe('noise', () => {
  it('simplex2 / simplex3 stay within [-1, 1] and use most of the range', () => {
    const rng = new Rng(7);
    let lo2 = 0;
    let hi2 = 0;
    let lo3 = 0;
    let hi3 = 0;
    for (let i = 0; i < 200_000; i++) {
      const x = rng.range(-1000, 1000);
      const y = rng.range(-1000, 1000);
      const z = rng.range(-1000, 1000);
      const a = simplex2(12345, x, y);
      const b = simplex3(12345, x, y, z);
      lo2 = Math.min(lo2, a);
      hi2 = Math.max(hi2, a);
      lo3 = Math.min(lo3, b);
      hi3 = Math.max(hi3, b);
    }
    expect(lo2).toBeGreaterThanOrEqual(-1);
    expect(hi2).toBeLessThanOrEqual(1);
    expect(lo3).toBeGreaterThanOrEqual(-1);
    expect(hi3).toBeLessThanOrEqual(1);
    expect(hi2 - lo2).toBeGreaterThan(1.4);
    expect(hi3 - lo3).toBeGreaterThan(1.2);
  });

  it('is a pure function of seed and coordinates', () => {
    for (const [x, y, z] of [
      [0.5, 0.25, 3.75],
      [-123.4, 56.7, -8.9],
      [1e5 + 0.1, -1e5 + 0.2, 7],
    ] as const) {
      expect(simplex2(99, x, y)).toBe(simplex2(99, x, y));
      expect(simplex3(99, x, y, z)).toBe(simplex3(99, x, y, z));
      expect(fbm2(99, x, y, 4)).toBe(fbm2(99, x, y, 4));
    }
    // Different seeds give different fields.
    let diff = 0;
    for (let i = 0; i < 100; i++) if (simplex2(1, i * 0.37, i * 0.21) !== simplex2(2, i * 0.37, i * 0.21)) diff++;
    expect(diff).toBeGreaterThan(90);
  });

  it('is continuous (no seams between simplex cells)', () => {
    const rng = new Rng(3);
    let worst2 = 0;
    let worst3 = 0;
    const h = 1e-4;
    for (let i = 0; i < 50_000; i++) {
      const x = rng.range(-50, 50);
      const y = rng.range(-50, 50);
      const z = rng.range(-50, 50);
      worst2 = Math.max(worst2, Math.abs(simplex2(5, x + h, y) - simplex2(5, x, y)));
      worst3 = Math.max(worst3, Math.abs(simplex3(5, x, y + h, z) - simplex3(5, x, y, z)));
    }
    // The gradient is bounded (a few units per noise unit), so a 1e-4 step moves < 1e-3.
    expect(worst2).toBeLessThan(1e-3);
    expect(worst3).toBeLessThan(1e-3);
  });

  it('has a roughly zero mean', () => {
    let s2 = 0;
    let s3 = 0;
    const n = 40_000;
    for (let i = 0; i < n; i++) {
      s2 += simplex2(77, (i % 200) * 0.71, Math.floor(i / 200) * 0.63);
      s3 += simplex3(77, (i % 200) * 0.71, Math.floor(i / 200) * 0.63, 0.5);
    }
    expect(Math.abs(s2 / n)).toBeLessThan(0.05);
    expect(Math.abs(s3 / n)).toBeLessThan(0.05);
  });

  it('fractal helpers stay in range', () => {
    const rng = new Rng(11);
    for (let i = 0; i < 20_000; i++) {
      const x = rng.range(-500, 500);
      const y = rng.range(-500, 500);
      const f = fbm2(4, x, y, 5);
      const g = fbm3(4, x, y, x - y, 3);
      const r = ridged2(4, x, y, 5);
      expect(Math.abs(f)).toBeLessThanOrEqual(1);
      expect(Math.abs(g)).toBeLessThanOrEqual(1);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
    }
  });

  it('derived seeds and lattice hashes are well spread', () => {
    const seen = new Set<number>();
    for (let salt = 0; salt < 1000; salt++) seen.add(deriveSeed(42, salt));
    expect(seen.size).toBe(1000);
    // Low 5 bits (used to pick 2D gradients) are close to uniform.
    const buckets = new Array<number>(32).fill(0);
    for (let x = -100; x < 100; x++) for (let y = -100; y < 100; y++) buckets[latticeHash2(9, x, y) & 31]!++;
    for (const b of buckets) expect(Math.abs(b - 40_000 / 32) / (40_000 / 32)).toBeLessThan(0.1);
  });

  it('smoothstep clamps and works in both directions', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5);
    expect(smoothstep(1, 0, 0)).toBe(1);
    expect(smoothstep(1, 0, 1)).toBe(0);
  });
});
