/**
 * Adversarial review (correctness lens) of the art module. Each `it` reproduces one finding;
 * the failing ones are left in place on purpose for the fixer.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { TILE_SIZE } from '../../src/core/constants';
import { lightness } from '../../src/art/color';
import * as M from '../../src/art/materials';
import { renderItemIcon } from '../../src/art/icons';
import { paintTile } from '../../src/art/tiles';

const T = TILE_SIZE;

function opaquePixels(px: Uint8Array): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) if (px[(y * T + x) * 4 + 3]! > 0) out.push([x, y]);
  return out;
}

describe('review-correctness: art', () => {
  it('torch: the whole torch (stick AND flame) lies on the 2-px post columns 7..8', () => {
    // The brief: "the stick 2 px wide in the centre columns (the mesher maps it onto a thin
    // post ...)". A 2x2-section post can only ever show columns 7..8; flame pixels in
    // columns 6 and 9 are lost in the world (5 of the 14 flame pixels today).
    const off = opaquePixels(paintTile('torch'))
      .filter(([x]) => x !== 7 && x !== 8)
      .map(([x, y]) => `${x},${y}`);
    expect(off).toEqual([]);
  });

  it('torch: the flame sits inside the rows the real post samples (mesher post is 10/16 tall = rows 6..15)', () => {
    // src/mesh/shapes/models.ts emitTorch: TORCH_TOP = 10/16; the sides sample the bottom
    // 10 rows, the top cap rows 6..7. Everything above row 6 is never shown in the world,
    // so today only the 2 flame pixels of row 6 appear on a placed torch.
    const above = opaquePixels(paintTile('torch'))
      .filter(([, y]) => y < 6)
      .map(([x, y]) => `${x},${y}`);
    expect(above).toEqual([]);
  });

  it('icons: the cube silhouette is mirror-symmetric at odd sizes as well', () => {
    // projection() centres on size / 2, a half pixel for odd sizes, while the rhombus width
    // is a multiple of 4: the corners land on pixel centres and the half-open edge test
    // keeps one side and drops the other (e.g. size 13: rows span 2..9 but the tips sit at 6).
    const bad: string[] = [];
    for (const s of [13, 15, 17, 31, 33, 45]) {
      const img = renderItemIcon(B.STONE, s);
      const axes = new Set<number>();
      for (let y = 0; y < s; y++) {
        let l = -1;
        let r = -1;
        for (let x = 0; x < s; x++) {
          if (img[(y * s + x) * 4 + 3]! === 0) continue;
          if (l < 0) l = x;
          r = x;
        }
        if (l >= 0) axes.add(l + r);
      }
      if (axes.size !== 1) bad.push(`${s}: row axes ${[...axes].join('/')}`);
    }
    expect(bad).toEqual([]);
  });

  it('icons: the glass icon keeps its light frame (outline only on the outer silhouette)', () => {
    // outlineSilhouette() darkens every opaque pixel with a transparent 4-neighbour,
    // including the see-through interior, so every frame line of glass is darkened on both
    // sides. Glass tile frame mean OKLab L = 0.93; at size 11 (no outline) the icon is 0.67,
    // at 12 (outline on) 0.41. An exterior-only outline gives 0.62 @32 and 0.66 @64.
    for (const s of [32, 64]) {
      const img = renderItemIcon(B.GLASS, s);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < img.length; i += 4) {
        if (img[i + 3]! === 0) continue;
        sum += lightness([img[i]!, img[i + 1]!, img[i + 2]!]);
        n++;
      }
      expect(sum / n, `glass icon @${s}`).toBeGreaterThan(0.58);
    }
  });

  it('helm_base: the brass band lies on the part of the tile the pedestal sides actually show', () => {
    // models.ts emitHelm: pedestal box x,z in [4/16, 12/16], height 10/16, uvs derived from
    // position (mesher.ts "Partial boxes use the matching sub-rectangle of the tile"), so the
    // sides sample columns 4..11 of rows 6..15. The band is painted in rows 2..4 (shadow in
    // row 5): invisible on the placed helm, while the top face (rows 4..11) shows the band's
    // lower edge and shadow as two stripes.
    const px = paintTile('helm_base');
    const brass = new Set(M.BRASS.map((c) => c.join(',')));
    let shown = 0;
    for (let y = 6; y < T; y++) {
      for (let x = 4; x < 12; x++) {
        const o = (y * T + x) * 4;
        if (brass.has(`${px[o]},${px[o + 1]},${px[o + 2]}`)) shown++;
      }
    }
    expect(shown).toBeGreaterThan(0);
  });

  it('helm_wheel is drawn centred in the tile (the mesher maps the tile symmetrically about the axle)', () => {
    // models.ts emitHelm spans the wheel quad +-7/16 around the wheel centre, i.e. the axle is
    // at u = v = 0.5. The painted wheel is centred on texel (7, 7) -> axle at 7.5/16, and
    // column 15 / row 15 stay empty, so the placed wheel sits half a texel up-left of its axle.
    const pts = opaquePixels(paintTile('helm_wheel'));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    expect(Math.min(...xs) + Math.max(...xs)).toBe(T - 1);
    expect(Math.min(...ys) + Math.max(...ys)).toBe(T - 1);
  });
});
