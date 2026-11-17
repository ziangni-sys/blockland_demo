import { describe, expect, it } from 'vitest';
import { animOrigin, BOB_OFFSET, BOB_WAVES, bobHeight, RIPPLE_WAVES, SWAY_PHASES, WAVE_PERIOD } from '../../src/render/three/waves';

/** Cycles per WAVE_PERIOD of a wavenumber. */
const cycles = (k: number): number => (k * WAVE_PERIOD) / (2 * Math.PI);
const isWhole = (x: number): boolean => Math.abs(x - Math.round(x)) < 1e-9;

// Review finding (precision far from the origin): the shaders evaluate every animation field
// relative to an origin that snaps with the camera; this is only seamless if every field is
// exactly WAVE_PERIOD-periodic.
describe('animation fields', () => {
  it('every wave vector component is a whole number of cycles per period', () => {
    for (const w of [...BOB_WAVES, ...RIPPLE_WAVES]) {
      expect(isWhole(cycles(w.kx))).toBe(true);
      expect(isWhole(cycles(w.kz))).toBe(true);
    }
    for (const s of SWAY_PHASES) {
      expect(isWhole(cycles(s.kx))).toBe(true);
      expect(isWhole(cycles(s.kz))).toBe(true);
    }
    // The shimmer uses the first two ripple waves at half their wavenumber.
    for (const w of RIPPLE_WAVES.slice(0, 2)) {
      expect(isWhole(cycles(w.kx) / 2)).toBe(true);
      expect(isWhole(cycles(w.kz) / 2)).toBe(true);
    }
  });

  it('rebasing the origin by a period changes nothing', () => {
    for (const [x, z, t] of [
      [0.3, 7.9, 1.2],
      [15.875, 3.5, 40.25],
      [200.1, 255.9, 7],
    ] as const) {
      const h = bobHeight(x, z, t);
      expect(bobHeight(x + WAVE_PERIOD, z, t)).toBeCloseTo(h, 9);
      expect(bobHeight(x, z - WAVE_PERIOD, t)).toBeCloseTo(h, 9);
      expect(bobHeight(x - 3 * WAVE_PERIOD, z + 2 * WAVE_PERIOD, t)).toBeCloseTo(h, 9);
    }
  });

  it('the origin snaps to the period and stays within one period of the camera', () => {
    for (const c of [-1e6 - 0.3, -300, -0.5, 0, 0.5, 255.99, 256, 1048576.7, 4194304.25]) {
      const o = animOrigin(c);
      expect(o % WAVE_PERIOD === 0 || Object.is(o % WAVE_PERIOD, -0)).toBe(true);
      expect(c - o).toBeGreaterThanOrEqual(0);
      expect(c - o).toBeLessThan(WAVE_PERIOD);
    }
  });

  it('the bobbing surface never rises more than 0.014 above its resting height', () => {
    const amp = BOB_WAVES.reduce((s, w) => s + w.a, 0);
    expect(amp + BOB_OFFSET).toBeLessThanOrEqual(0.0141);
    let hi = -Infinity;
    for (let i = 0; i < 2000; i++) hi = Math.max(hi, bobHeight(i * 0.37, i * 0.61, i * 0.05));
    expect(hi).toBeLessThanOrEqual(0.0141);
  });
});
