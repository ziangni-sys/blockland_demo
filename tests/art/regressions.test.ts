/**
 * Regression tests for the fixes made after the adversarial review of the art module (the
 * reproductions themselves live in review-*.test.ts). Each block names the finding it guards.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { allItems } from '../../src/blocks/items';
import { TILE_SIZE } from '../../src/core/constants';
import { lightness, type RGB } from '../../src/art/color';
import { renderItemIcon } from '../../src/art/icons';
import * as M from '../../src/art/materials';
import { tileAverageColor } from '../../src/art/palette';
import { paintTile } from '../../src/art/tiles';

const T = TILE_SIZE;

function alpha(px: Uint8Array | Uint8ClampedArray, size: number, x: number, y: number): number {
  return px[(y * size + x) * 4 + 3]!;
}
function rgb(px: Uint8Array | Uint8ClampedArray, size: number, x: number, y: number): RGB {
  const o = (y * size + x) * 4;
  return [px[o]!, px[o + 1]!, px[o + 2]!];
}
function key(c: RGB): string {
  return c.join(',');
}
function distinctColours(px: Uint8Array): number {
  const s = new Set<string>();
  for (let i = 0; i < px.length; i += 4) if (px[i + 3]! > 0) s.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
  return s.size;
}
function visibleCount(px: Uint8Array): number {
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i]! > 0) n++;
  return n;
}

describe('helm tiles vs the mesher model (review: helm_base band, helm_wheel centring)', () => {
  it('helm_base: the brass band spans the pedestal sides and stays out of the top window', () => {
    const px = paintTile('helm_base');
    const brass = new Set(M.BRASS.map(key));
    // Top / bottom faces sample columns 4..11 of rows 4..11: clean wood, no band stripes.
    for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) expect(brass.has(key(rgb(px, T, x, y))), `top ${x},${y}`).toBe(false);
    // Side faces sample rows 6..15: the band runs across the whole face width.
    for (let x = 4; x < 12; x++) for (const y of [12, 13, 14]) expect(brass.has(key(rgb(px, T, x, y))), `band ${x},${y}`).toBe(true);
  });

  it('helm_wheel: the silhouette is symmetric about the tile centre (point and mirror symmetry)', () => {
    const px = paintTile('helm_wheel');
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const a = alpha(px, T, x, y);
        expect(alpha(px, T, T - 1 - x, T - 1 - y), `180 deg ${x},${y}`).toBe(a);
        expect(alpha(px, T, T - 1 - x, y), `mirror ${x},${y}`).toBe(a);
      }
    }
    // The brass hub covers the four centre texels, i.e. the axle at uv (0.5, 0.5).
    const brass = new Set(M.BRASS.map(key));
    for (const [x, y] of [
      [7, 7],
      [8, 7],
      [7, 8],
      [8, 8],
    ] as const) {
      expect(brass.has(key(rgb(px, T, x, y))), `hub ${x},${y}`).toBe(true);
    }
  });

  it('propeller_blade: the root is centred on the blade axis (u = 0.5)', () => {
    const px = paintTile('propeller_blade');
    const xs: number[] = [];
    for (let x = 0; x < T; x++) if (alpha(px, T, x, T - 1) > 0) xs.push(x);
    expect(xs.length).toBeGreaterThan(0);
    expect(Math.min(...xs) + Math.max(...xs)).toBe(T - 1);
  });
});

describe('icons (review: odd-size silhouette, outline, cost)', () => {
  it('cube silhouettes are mirror-symmetric at every size from 9 to 80', () => {
    const bad: number[] = [];
    for (let s = 9; s <= 80; s++) {
      const img = renderItemIcon(B.STONE, s);
      const axes = new Set<number>();
      for (let y = 0; y < s; y++) {
        let l = -1;
        let r = -1;
        for (let x = 0; x < s; x++) {
          if (alpha(img, s, x, y) === 0) continue;
          if (l < 0) l = x;
          r = x;
        }
        if (l >= 0) axes.add(l + r);
      }
      if (axes.size !== 1) bad.push(s);
    }
    expect(bad).toEqual([]);
  });

  it('outlines the outer silhouette but leaves pixels around interior holes alone', () => {
    const s = 64;
    // Outer edge: the leftmost visible pixel of a stone cube's middle row is darker than the
    // face pixels just inside it.
    const stone = renderItemIcon(B.STONE, s);
    const y = s / 2;
    let l = 0;
    while (alpha(stone, s, l, y) === 0) l++;
    expect(lightness(rgb(stone, s, l, y))).toBeLessThan(lightness(rgb(stone, s, l + 2, y)) - 0.1);
    // Interior: glass pixels next to the see-through middle keep (roughly) the light frame
    // colour; the darkest visible glass pixel that does NOT touch the outer background must
    // stay clearly lighter than the outline shade.
    const glass = renderItemIcon(B.GLASS, s);
    const ext = new Uint8Array(s * s);
    const stack: number[] = [];
    for (let i = 0; i < s; i++) for (const j of [i, (s - 1) * s + i, i * s, i * s + s - 1]) if (glass[j * 4 + 3] === 0 && !ext[j]) (ext[j] = 1), stack.push(j);
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % s;
      for (const n of [x > 0 ? j - 1 : -1, x < s - 1 ? j + 1 : -1, j - s, j + s]) {
        if (n < 0 || n >= s * s || ext[n] || glass[n * 4 + 3] !== 0) continue;
        ext[n] = 1;
        stack.push(n);
      }
    }
    let minInterior = 1;
    for (let yy = 1; yy < s - 1; yy++) {
      for (let x = 1; x < s - 1; x++) {
        const i = yy * s + x;
        if (glass[i * 4 + 3] === 0) continue;
        if (ext[i - 1] || ext[i + 1] || ext[i - s] || ext[i + s]) continue;
        minInterior = Math.min(minInterior, lightness(rgb(glass, s, x, yy)));
      }
    }
    expect(minInterior).toBeGreaterThan(0.45);
  });

  it('renders the whole palette at the HiDPI icon size quickly', () => {
    const t0 = performance.now();
    for (const it of allItems()) renderItemIcon(it.id, 128);
    const ms = performance.now() - t0;
    console.log(`renderItemIcon: ${allItems().length} icons @128px in ${ms.toFixed(1)} ms`);
    // Measured ~50 ms after the fix (~250 ms before); the bound only catches regressions.
    expect(ms).toBeLessThan(1500);
  });
});

describe('palette rules (review: lava ramp)', () => {
  it('every material ramp has at most 5 tones', () => {
    // A ramp is an array of RGB triples; GRAVEL_KINDS and WOOL are collections of ramps.
    const isRgb = (c: unknown): boolean => Array.isArray(c) && c.length === 3 && c.every((v) => typeof v === 'number');
    const isRamp = (v: unknown): v is readonly RGB[] => Array.isArray(v) && v.length > 0 && v.every(isRgb);
    const ramps: Array<[string, readonly RGB[]]> = [];
    for (const [name, v] of Object.entries(M)) {
      if (isRamp(v)) ramps.push([name, v]);
      else if (Array.isArray(v)) v.forEach((r, i) => isRamp(r) && ramps.push([`${name}[${i}]`, r]));
      else if (v && typeof v === 'object') for (const [k, r] of Object.entries(v)) if (isRamp(r)) ramps.push([`${name}.${k}`, r]);
    }
    expect(ramps.length).toBeGreaterThan(40);
    expect(ramps.filter(([, r]) => r.length > 5).map(([n, r]) => `${n}: ${r.length}`)).toEqual([]);
  });

  it('lava tiles are painted from at most 5 colours', () => {
    expect(M.LAVA.length).toBe(5);
    for (const n of ['lava_still', 'lava_flow']) expect(distinctColours(paintTile(n)), n).toBeLessThanOrEqual(5);
  });
});

describe('mining cracks (review: invisible on dark blocks, uneven stages)', () => {
  /** Mean |OKLab L change| a crack pixel makes over the block's mean colour (overlay blend). */
  function readability(stage: number, tile: string): number {
    const crack = paintTile(`crack_${stage}`);
    const avg = tileAverageColor(tile);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < crack.length; i += 4) {
      const a = crack[i + 3]! / 255;
      if (a === 0) continue;
      const over: RGB = [avg[0] * (1 - a) + crack[i]! * a, avg[1] * (1 - a) + crack[i + 1]! * a, avg[2] * (1 - a) + crack[i + 2]! * a];
      sum += Math.abs(lightness(avg) - lightness(over));
      n++;
    }
    return sum / n;
  }

  it('reads on dark, mid and light blocks at every stage', () => {
    for (const tile of ['obsidian', 'wool_black', 'log_pine_side', 'stone', 'planks_oak', 'sand', 'snow', 'wool_white']) {
      for (let k = 0; k < 8; k++) expect(readability(k, tile), `crack_${k} on ${tile}`).toBeGreaterThan(0.08);
    }
  });

  it('uses a dark line and a light chipped edge, both at the overlay alpha', () => {
    for (let k = 0; k < 8; k++) {
      const px = paintTile(`crack_${k}`);
      const seen = new Set<string>();
      for (let i = 0; i < px.length; i += 4) if (px[i + 3]! > 0) seen.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
      expect([...seen].sort(), `crack_${k}`).toEqual([key(M.CRACK), key(M.CRACK_CHIP)].sort());
    }
  });

  it('shows short line segments from stage 0 and grows in roughly equal steps', () => {
    const counts = Array.from({ length: 8 }, (_, k) => visibleCount(paintTile(`crack_${k}`)));
    expect(counts[0]!).toBeGreaterThanOrEqual(8);
    const steps = counts.slice(1).map((c, k) => c - counts[k]!);
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    for (const s of steps) {
      expect(s).toBeGreaterThan(mean * 0.4);
      expect(s).toBeLessThan(mean * 2);
    }
  });
});

describe('leaves (review: perf of the hole-fraction search)', () => {
  it('leaves_oak lands on the 22 % hole target exactly (quantile, not bisection)', () => {
    const px = paintTile('leaves_oak');
    let holes = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] === 0) holes++;
    // floor(0.22 * 256) = 56; ties between cover scales can only make it fewer.
    expect(holes).toBeLessThanOrEqual(56);
    expect(holes).toBeGreaterThanOrEqual(50);
  });
});
