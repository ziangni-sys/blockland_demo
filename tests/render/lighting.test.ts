import { describe, expect, it } from 'vitest';
import {
  AMBIENT_FLOOR,
  aoFactor,
  computeFog,
  computeSkyState,
  createFogParams,
  createSkyState,
  dayLightFactor,
  faceShade,
  hexToLinear,
  lightCurve,
  NIGHT_LIGHT,
  nightFactor,
  shadedBrightness,
  srgbToLinear,
  sunDirection,
  twilightFactor,
} from '../../src/render/three/lighting';

describe('light curve', () => {
  it('maps 0 -> 0 and 1 -> 1, clamps outside', () => {
    expect(lightCurve(0)).toBe(0);
    expect(lightCurve(1)).toBeCloseTo(1, 12);
    expect(lightCurve(-3)).toBe(0);
    expect(lightCurve(7)).toBeCloseTo(1, 12);
  });

  it('is strictly increasing and stays below linear (dark falls off fast)', () => {
    let prev = -1;
    for (let i = 0; i <= 15; i++) {
      const v = lightCurve(i / 15);
      expect(v).toBeGreaterThan(prev);
      if (i > 0 && i < 15) expect(v).toBeLessThan(i / 15);
      prev = v;
    }
  });

  it('half light is clearly dimmer than half brightness but not black', () => {
    const v = lightCurve(0.5);
    expect(v).toBeGreaterThan(0.18);
    expect(v).toBeLessThan(0.35);
  });

  it('shaded brightness has an ambient floor and takes the max of sky and block', () => {
    expect(shadedBrightness(0, 0, 1)).toBeCloseTo(AMBIENT_FLOOR, 12);
    expect(shadedBrightness(1, 0, 1)).toBeCloseTo(1, 12);
    // At night a torch beats the moonlight.
    const moon = shadedBrightness(1, 0, NIGHT_LIGHT);
    const torch = shadedBrightness(1, 14 / 15, NIGHT_LIGHT);
    expect(torch).toBeGreaterThan(moon);
    expect(shadedBrightness(0.3, 0.9, 1)).toBeCloseTo(shadedBrightness(0, 0.9, 1), 12);
  });

  it('ambient occlusion is soft: fully occluded keeps 45 %', () => {
    expect(aoFactor(0)).toBeCloseTo(0.45, 12);
    expect(aoFactor(1)).toBeCloseTo(1, 12);
    expect(aoFactor(0.5)).toBeCloseTo(0.725, 12);
  });

  it('face shade: top brightest, bottom darkest, horizontal axes differ', () => {
    const top = faceShade(0, 1, 0);
    const bottom = faceShade(0, -1, 0);
    const x = faceShade(1, 0, 0);
    const z = faceShade(0, 0, -1);
    expect(top).toBeGreaterThan(z);
    expect(z).toBeGreaterThan(x);
    expect(x).toBeGreaterThan(bottom);
    expect(faceShade(-1, 0, 0)).toBe(x);
    // A 45-degree normal blends smoothly.
    const s = Math.SQRT1_2;
    expect(faceShade(s, 0, s)).toBeCloseTo((x + z) / 2, 12);
  });
});

describe('day / night', () => {
  const sun = { x: 0, y: 0, z: 0 };

  it('sun rises in the east, peaks at noon, sets in the west', () => {
    sunDirection(0, sun);
    expect(sun.x).toBeCloseTo(1, 9);
    expect(sun.y).toBeCloseTo(0, 9);
    sunDirection(0.25, sun);
    expect(sun.y).toBeGreaterThan(0.9);
    sunDirection(0.5, sun);
    expect(sun.x).toBeCloseTo(-1, 9);
    sunDirection(0.75, sun);
    expect(sun.y).toBeLessThan(-0.9);
    expect(Math.hypot(sun.x, sun.y, sun.z)).toBeCloseTo(1, 12);
  });

  it('daylight is full at noon, moonlight at midnight, continuous across the wrap', () => {
    expect(dayLightFactor(0.25)).toBeCloseTo(1, 6);
    expect(dayLightFactor(0.75)).toBeCloseTo(NIGHT_LIGHT, 6);
    expect(Math.abs(dayLightFactor(0) - dayLightFactor(1))).toBeLessThan(1e-9);
    const dawn = dayLightFactor(0);
    expect(dawn).toBeGreaterThan(NIGHT_LIGHT);
    expect(dawn).toBeLessThan(1);
    // Smooth: no jumps between neighbouring samples.
    for (let i = 0; i < 1000; i++) {
      expect(Math.abs(dayLightFactor(i / 1000) - dayLightFactor((i + 1) / 1000))).toBeLessThan(0.02);
    }
  });

  it('twilight peaks at sunrise and sunset, night only at night', () => {
    expect(twilightFactor(0)).toBeGreaterThan(0.8);
    expect(twilightFactor(0.5)).toBeGreaterThan(0.8);
    expect(twilightFactor(0.25)).toBeLessThan(0.05);
    expect(nightFactor(0.75)).toBeCloseTo(1, 6);
    expect(nightFactor(0.25)).toBeCloseTo(0, 6);
  });

  it('sky colours: blue noon, warm dusk horizon, dark starry night', () => {
    const s = createSkyState();
    computeSkyState(0.25, s);
    expect(s.zenith.b).toBeGreaterThan(s.zenith.r * 2);
    expect(s.horizon.b).toBeGreaterThan(s.horizon.r);
    expect(s.stars).toBe(0);
    expect(s.glowStrength).toBeLessThan(0.05);
    expect(s.dayLight).toBeCloseTo(1, 6);

    computeSkyState(0.5, s);
    expect(s.horizon.r).toBeGreaterThan(s.horizon.b);
    expect(s.glowStrength).toBeGreaterThan(0.8);
    expect(s.sunGlow.r).toBeGreaterThan(s.sunGlow.b);

    computeSkyState(0.75, s);
    const lum = 0.2126 * s.zenith.r + 0.7152 * s.zenith.g + 0.0722 * s.zenith.b;
    expect(lum).toBeLessThan(0.01);
    expect(s.stars).toBeGreaterThan(0.9);
    // Moonlight is cool, torch light warm.
    expect(s.skyTint.b).toBeGreaterThan(s.skyTint.r);
    expect(s.blockTint.r).toBeGreaterThan(s.blockTint.b);
    // Moon opposite the sun.
    expect(s.moonDir.y).toBeCloseTo(-s.sunDir.y, 12);
  });

  it('computeSkyState wraps dayTime outside [0,1)', () => {
    const a = computeSkyState(0.3, createSkyState());
    const b = computeSkyState(2.3, createSkyState());
    expect(b.zenith.r).toBeCloseTo(a.zenith.r, 9);
    expect(b.dayLight).toBeCloseTo(a.dayLight, 9);
  });

  it('srgb conversion matches the standard curve', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 9);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214, 3);
    const c = hexToLinear(0xff8000);
    expect(c.r).toBeCloseTo(1, 9);
    expect(c.g).toBeCloseTo(srgbToLinear(128 / 255), 9);
    expect(c.b).toBe(0);
  });
});

describe('fog', () => {
  it('fits the view distance in air', () => {
    const f = computeFog(128, 'none', 1, createFogParams());
    expect(f.fixedColor).toBe(0);
    expect(f.start).toBeGreaterThan(40);
    expect(f.end).toBeLessThanOrEqual(128);
    expect(f.end).toBeGreaterThan(f.start);
  });

  it('is short and tinted under water and very short in lava', () => {
    const w = computeFog(128, 'water', 1, createFogParams());
    expect(w.fixedColor).toBe(1);
    expect(w.end).toBeLessThan(40);
    expect(w.color.g).toBeGreaterThan(w.color.r);
    const night = computeFog(128, 'water', NIGHT_LIGHT, createFogParams());
    expect(night.color.g).toBeLessThan(w.color.g);
    const l = computeFog(128, 'lava', 1, createFogParams());
    expect(l.end).toBeLessThan(5);
    expect(l.color.r).toBeGreaterThan(l.color.b * 4);
  });
});
