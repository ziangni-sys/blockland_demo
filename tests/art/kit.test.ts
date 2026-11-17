import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { bleedTransparent, Canvas, Field, paintField, wrap, wrapDelta } from '../../src/art/canvas';
import { hex, HIGHLIGHT_HUE, lightness, mix, oklabToRgb, ramp, rgbToOklab, shadeColor, SHADOW_HUE, toHex } from '../../src/art/color';
import { fbm, scatter, vnoise, worley, worleyResult } from '../../src/art/noise';

function hueOf(c: readonly [number, number, number]): number {
  const [, a, b] = rgbToOklab(c);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}
function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

describe('art/color', () => {
  it('parses and formats hex colours', () => {
    expect(hex('#ff8000')).toEqual([255, 128, 0]);
    expect(hex('0a0B0c')).toEqual([10, 11, 12]);
    expect(toHex([255, 128, 0])).toBe('#ff8000');
    expect(() => hex('#fff')).toThrow();
    expect(() => hex('red')).toThrow();
  });

  it('round-trips through OKLab within one byte', () => {
    for (const c of [
      [0, 0, 0],
      [255, 255, 255],
      [12, 200, 90],
      [180, 40, 220],
      [128, 128, 128],
    ] as const) {
      const [L, a, b] = rgbToOklab(c);
      const back = oklabToRgb(L, a, b);
      for (let i = 0; i < 3; i++) expect(Math.abs(back[i]! - c[i]!)).toBeLessThanOrEqual(1);
    }
  });

  it('keeps out-of-gamut colours in range', () => {
    const c = oklabToRgb(0.7, 0.4, 0.4);
    for (const v of c) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });

  it('builds hue-shifted ramps: darker toward blue-violet, lighter toward yellow', () => {
    const r = ramp('#6a8e42', { n: 5 });
    expect(r).toHaveLength(5);
    for (let i = 1; i < r.length; i++) expect(lightness(r[i]!)).toBeGreaterThan(lightness(r[i - 1]!));
    const base = hueOf(r[2]!);
    expect(hueDist(hueOf(r[0]!), SHADOW_HUE)).toBeLessThan(hueDist(base, SHADOW_HUE));
    expect(hueDist(hueOf(r[4]!), HIGHLIGHT_HUE)).toBeLessThan(hueDist(base, HIGHLIGHT_HUE));
    // The base colour sits at its index unchanged.
    expect(r[2]).toEqual(hex('#6a8e42'));
    // Neutral greys still pick up a cool shadow / warm highlight.
    const g = ramp('#808080');
    expect(g[0]![2]).toBeGreaterThan(g[0]![0]);
    expect(g[4]![0]).toBeGreaterThan(g[4]![2]);
  });

  it('shades toward blue-violet', () => {
    const c = hex('#c08040');
    const s = shadeColor(c, 0.6);
    expect(lightness(s)).toBeLessThan(lightness(c));
    expect(hueDist(hueOf(s), SHADOW_HUE)).toBeLessThan(hueDist(hueOf(c), SHADOW_HUE));
    expect(shadeColor(c, 1)).toEqual(c);
    expect(mix([0, 0, 0], [200, 100, 50], 0.5)).toEqual([100, 50, 25]);
  });
});

describe('art/noise', () => {
  it('value noise and fbm are periodic in 16 px and stay in [0,1)', () => {
    for (const [cx, cy] of [
      [2, 2],
      [4, 1],
      [8, 16],
    ] as const) {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const v = vnoise(x, y, cx, cy, 99);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(1);
          expect(vnoise(x + 16, y, cx, cy, 99)).toBeCloseTo(v, 12);
          expect(vnoise(x, y - 16, cx, cy, 99)).toBeCloseTo(v, 12);
        }
      }
    }
    expect(fbm(3, 5, 2, 3, 7)).toBeCloseTo(fbm(19, -11, 2, 3, 7), 12);
  });

  it('scatter respects the toroidal minimum distance and count', () => {
    const pts = scatter(new Rng(5), 8, 4.5);
    expect(pts).toHaveLength(8);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = wrapDelta(pts[i]!.x - pts[j]!.x);
        const dy = wrapDelta(pts[i]!.y - pts[j]!.y);
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(4.5 * 0.9 ** 20);
      }
    }
    // Crowded requests still terminate with the requested count.
    expect(scatter(new Rng(1), 40, 8)).toHaveLength(40);
  });

  it('worley distances wrap around the tile', () => {
    const pts = [{ x: 0.5, y: 0.5 }];
    const w = worleyResult();
    worley(pts, 15, 15, w);
    expect(w.f1).toBeCloseTo(Math.SQRT2, 6);
    expect(w.ox).toBeCloseTo(-1, 6);
  });
});

describe('art/canvas', () => {
  it('wraps coordinates', () => {
    expect(wrap(-1)).toBe(15);
    expect(wrap(16)).toBe(0);
    expect(wrapDelta(15)).toBe(-1);
    const c = new Canvas();
    c.set(-1, -1, [1, 2, 3]);
    expect(c.rgb(15, 15)).toEqual([1, 2, 3]);
    expect(c.alpha(15, 15)).toBe(255);
  });

  it('quantizes fields through a ramp and marks NaN transparent', () => {
    const f = new Field(16, 1);
    f.set(0, 0, Number.NaN);
    f.set(1, 0, 99);
    const c = new Canvas();
    const r = [hex('#000000'), hex('#808080'), hex('#ffffff')] as const;
    paintField(c, f, r);
    expect(c.alpha(0, 0)).toBe(0);
    expect(c.rgb(1, 0)).toEqual([255, 255, 255]);
    expect(c.rgb(2, 0)).toEqual([128, 128, 128]);
  });

  it('bleeds colour into transparent pixels without touching alpha', () => {
    const c = new Canvas();
    c.set(4, 4, [200, 100, 50]);
    bleedTransparent(c);
    expect(c.alpha(10, 10)).toBe(0);
    expect(c.rgb(10, 10)).toEqual([200, 100, 50]);
    expect(c.alpha(4, 4)).toBe(255);
  });
});
