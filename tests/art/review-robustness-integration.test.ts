/**
 * Adversarial review (robustness / integration lens) of the art module. These tests encode
 * defects found in review: they failed against the reviewed implementation and now guard
 * the fixes (see also regressions.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { TILE_SIZE } from '../../src/core/constants';
import { lightness, type RGB } from '../../src/art/color';
import { renderItemIcon } from '../../src/art/icons';
import { FLAME } from '../../src/art/materials';
import { tileAverageColor } from '../../src/art/palette';
import { paintTile } from '../../src/art/tiles';

const T = TILE_SIZE;

function rgbAt(px: Uint8Array, x: number, y: number): RGB {
  const o = (y * T + x) * 4;
  return [px[o]!, px[o + 1]!, px[o + 2]!];
}
function alphaAt(px: Uint8Array, x: number, y: number): number {
  return px[(y * T + x) * 4 + 3]!;
}
function isFlame(px: Uint8Array, x: number, y: number): boolean {
  if (alphaAt(px, x, y) === 0) return false;
  const c = rgbAt(px, x, y);
  return FLAME.some((f) => f[0] === c[0] && f[1] === c[1] && f[2] === c[2]);
}

/** Mean OKLab lightness of the visible pixels of an RGBA image. */
function meanL(img: Uint8Array | Uint8ClampedArray): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < img.length; i += 4) {
    if (img[i + 3] === 0) continue;
    sum += lightness([img[i]!, img[i + 1]!, img[i + 2]!]);
    n++;
  }
  return sum / n;
}

describe('review: torch tile vs the mesher post (src/mesh/mesher.ts tile-art table)', () => {
  // The mesher draws the torch as a 2/16 x 10/16 post: its sides sample columns 7..8 of the
  // bottom 10 rows (image rows 6..15) and its top cap samples rows 6..7 ("the head").
  // Everything above row 6 is never shown in the world.
  it('puts the flame where the in-world post samples it', () => {
    const t = paintTile('torch');
    let inPost = 0;
    let total = 0;
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        if (!isFlame(t, x, y)) continue;
        total++;
        if ((x === 7 || x === 8) && y >= 6) inPost++;
      }
    }
    // Reviewed implementation: 14 flame texels, only 2 of them (row 6) visible on the post.
    expect(inPost, `flame texels on the post: ${inPost} of ${total}`).toBeGreaterThanOrEqual(4);
  });

  it('makes the post head (top cap, rows 6..7 of columns 7..8) glow', () => {
    const t = paintTile('torch');
    const head = [
      [7, 6],
      [8, 6],
      [7, 7],
      [8, 7],
    ] as const;
    // Reviewed implementation: row 7 is the charred stick colour, so half the cap is dark.
    for (const [x, y] of head) expect(isFlame(t, x, y), `torch head texel ${x},${y}`).toBe(true);
  });
});

describe('review: see-through block icons', () => {
  it('keeps the glass frame light (the outline must not darken every frame pixel)', () => {
    // Opaque cubes keep most of their tile lightness in the icon (face shading + a 1-px rim).
    // For glass every frame pixel borders a transparent pixel, so outlineSilhouette darkens
    // the whole frame to shade 0.5 and the light frame becomes a dark slate wireframe.
    const s = 64;
    const stoneRatio = meanL(renderItemIcon(B.STONE, s)) / meanL(paintTile('stone'));
    const glassRatio = meanL(renderItemIcon(B.GLASS, s)) / meanL(paintTile('glass'));
    // Reviewed implementation: stone keeps ~0.82 of its lightness, glass only ~0.56.
    expect(glassRatio, `glass ${glassRatio.toFixed(3)} vs stone ${stoneRatio.toFixed(3)}`).toBeGreaterThan(stoneRatio - 0.1);
  });
});

describe('review: snow tone ramp', () => {
  it('snow uses a 3+ tone ramp with some shading below the base tone (not a flat fill)', () => {
    // Art direction: 3-5 tone ramps per material, hue-shifted shading. paintSnow's
    // "soft drift shadows" pass never pushes a pixel below the base tone: the reviewed tile
    // is 234 px of #e3eaf1 plus 22 sparkle px, nothing darker.
    const px = paintTile('snow');
    const count = new Map<number, number>();
    for (let i = 0; i < px.length; i += 4) {
      const k = (px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
    const [dominant] = [...count.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const domL = lightness([dominant >> 16, (dominant >> 8) & 255, dominant & 255]);
    let darker = 0;
    for (const [k, n] of count) if (lightness([k >> 16, (k >> 8) & 255, k & 255]) < domL) darker += n;
    expect(count.size, 'distinct snow tones').toBeGreaterThanOrEqual(3);
    expect(darker / (T * T), 'fraction of snow pixels shaded below the base tone').toBeGreaterThanOrEqual(0.05);
  });
});

describe('review: mining cracks on dark blocks', () => {
  it('crack_7 is readable on obsidian (the slowest block to mine)', () => {
    const crack = paintTile('crack_7');
    /** Mean |lightness change| a crack pixel makes when composited over the block's mean colour. */
    const lightnessChange = (tile: string): number => {
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
    };
    // Stone: ~0.30. Reviewed implementation on obsidian: ~0.03 (a 10 s dig with no visible
    // progress), wool_black ~0.05.
    expect(lightnessChange('obsidian'), 'obsidian').toBeGreaterThan(0.08);
    expect(lightnessChange('wool_black'), 'wool_black').toBeGreaterThan(0.08);
  });
});
