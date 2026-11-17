import { describe, expect, it } from 'vitest';
import { TILE_NAMES } from '../../src/blocks/registry';
import { rgbToOklab } from '../../src/art/color';
import { tileAverageColor } from '../../src/art/palette';
import { paintTile } from '../../src/art/tiles';

function hue(c: readonly [number, number, number]): number {
  const [, a, b] = rgbToOklab(c);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}

describe('art/palette', () => {
  it('returns the alpha-weighted mean colour as bytes for every tile', () => {
    for (const n of TILE_NAMES) {
      const c = tileAverageColor(n);
      expect(c).toHaveLength(3);
      for (const v of c) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(255);
      }
      const px = paintTile(n);
      let r = 0;
      let g = 0;
      let b = 0;
      let w = 0;
      for (let i = 0; i < px.length; i += 4) {
        r += px[i]! * px[i + 3]!;
        g += px[i + 1]! * px[i + 3]!;
        b += px[i + 2]! * px[i + 3]!;
        w += px[i + 3]!;
      }
      expect(c).toEqual([Math.round(r / w), Math.round(g / w), Math.round(b / w)]);
    }
  });

  it('hands out copies (the memo is not observable)', () => {
    const a = tileAverageColor('stone');
    a[0] = -1;
    expect(tileAverageColor('stone')[0]).not.toBe(-1);
  });

  it('throws on unknown tiles', () => {
    expect(() => tileAverageColor('nope')).toThrow();
  });

  it('matches the art direction for key materials', () => {
    const turf = tileAverageColor('turf_top');
    expect(turf[1]).toBeGreaterThan(turf[0]);
    expect(turf[1]).toBeGreaterThan(turf[2]);
    // Teal-leaning water: hue between green and blue.
    const water = tileAverageColor('water_still');
    expect(hue(water)).toBeGreaterThan(180);
    expect(hue(water)).toBeLessThan(240);
    const lava = tileAverageColor('lava_still');
    expect(lava[0]).toBeGreaterThan(lava[1]);
    expect(lava[1]).toBeGreaterThan(lava[2]);
    // Warm amber woods.
    const oak = tileAverageColor('planks_oak');
    expect(hue(oak)).toBeGreaterThan(45);
    expect(hue(oak)).toBeLessThan(85);
    // Pine bark is darker than oak bark.
    const lum = (c: number[]): number => c[0]! * 0.3 + c[1]! * 0.59 + c[2]! * 0.11;
    expect(lum(tileAverageColor('log_pine_side'))).toBeLessThan(lum(tileAverageColor('log_oak_side')));
  });
});
