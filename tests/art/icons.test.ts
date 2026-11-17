import { afterEach, describe, expect, it, vi } from 'vitest';
import { B } from '../../src/blocks/defs';
import { allItems, I, itemDef } from '../../src/blocks/items';
import { blockDef } from '../../src/blocks/registry';
import { lightness } from '../../src/art/color';
import { renderItemIcon } from '../../src/art/icons';
import { paintTile } from '../../src/art/tiles';

function alphaAt(img: Uint8ClampedArray, size: number, x: number, y: number): number {
  return img[(y * size + x) * 4 + 3]!;
}

/** Mean OKLab lightness of opaque pixels inside a rectangle. */
function meanLightness(img: Uint8ClampedArray, size: number, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * size + x) * 4;
      if (img[o + 3]! < 255) continue;
      sum += lightness([img[o]!, img[o + 1]!, img[o + 2]!]);
      n++;
    }
  }
  return sum / n;
}

describe('art/icons', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders every item at several sizes, deterministically, without Math.random', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random used');
    });
    for (const it of allItems()) {
      for (const size of [16, 32, 48]) {
        const a = renderItemIcon(it.id, size);
        expect(a).toBeInstanceOf(Uint8ClampedArray);
        expect(a.length).toBe(size * size * 4);
        let visible = 0;
        for (let i = 3; i < a.length; i += 4) if (a[i]! > 0) visible++;
        expect(visible / (size * size), `${it.key}@${size}`).toBeGreaterThan(0.08);
        const b = renderItemIcon(it.id, size);
        expect(Buffer.from(b).equals(Buffer.from(a)), it.key).toBe(true);
      }
    }
  });

  it('draws cube blocks as an isometric cube on a transparent background', () => {
    const s = 32;
    const img = renderItemIcon(B.STONE, s);
    // Corners outside the hexagonal silhouette stay transparent; the centre is covered.
    expect(alphaAt(img, s, 0, 0)).toBe(0);
    expect(alphaAt(img, s, s - 1, 0)).toBe(0);
    expect(alphaAt(img, s, 0, s - 1)).toBe(0);
    expect(alphaAt(img, s, s - 1, s - 1)).toBe(0);
    expect(alphaAt(img, s, s / 2, s / 2)).toBe(255);
    // Silhouette is left/right symmetric (same alpha pattern), 2:1 top edges.
    for (let y = 0; y < s; y++) for (let x = 0; x < s / 2; x++) expect(alphaAt(img, s, x, y) > 0).toBe(alphaAt(img, s, s - 1 - x, y) > 0);
  });

  it('shades the top brighter than the left face, the left brighter than the right', () => {
    const s = 64;
    for (const id of [B.STONE, B.SAND, B.WOOL_RED, B.PLANKS_OAK]) {
      const img = renderItemIcon(id, s);
      const top = meanLightness(img, s, 24, 8, 40, 20);
      const left = meanLightness(img, s, 10, 32, 24, 48);
      const right = meanLightness(img, s, 40, 32, 54, 48);
      expect(top, blockDef(id).key).toBeGreaterThan(left);
      expect(left, blockDef(id).key).toBeGreaterThan(right);
    }
  });

  it('draws non-block items as their icon tile, nearest-neighbour scaled', () => {
    for (const id of [I.GLUE, I.BUCKET, I.BUCKET_WATER, I.BUCKET_LAVA]) {
      const tile = paintTile(itemDef(id).icon!);
      const one = renderItemIcon(id, 16);
      const two = renderItemIcon(id, 32);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const t = (y * 16 + x) * 4;
          const a = tile[t + 3]!;
          expect(one[t + 3]).toBe(a);
          for (const [dx, dy] of [
            [0, 0],
            [1, 1],
          ]) {
            const o = ((y * 2 + dy!) * 32 + x * 2 + dx!) * 4;
            expect(two[o + 3]).toBe(a);
            if (a > 0) expect([two[o], two[o + 1], two[o + 2]]).toEqual([tile[t], tile[t + 1], tile[t + 2]]);
          }
        }
      }
    }
  });

  it('draws plants and torches as their flat sprite', () => {
    for (const id of [B.FLOWER_RED, B.FLOWER_YELLOW, B.TALL_GRASS, B.TORCH]) {
      const tile = paintTile(blockDef(id).tiles[0]!);
      const img = renderItemIcon(id, 16);
      for (let i = 3; i < tile.length; i += 4) expect(img[i]).toBe(tile[i]);
    }
  });

  it('renders compound shapes with their recognisable parts', () => {
    const s = 48;
    // Helm: the brass hub of the wheel is visible.
    const helm = renderItemIcon(B.HELM, s);
    let brass = 0;
    for (let i = 0; i < helm.length; i += 4) if (helm[i + 3] === 255 && helm[i]! > 170 && helm[i + 1]! > 120 && helm[i + 2]! < 110) brass++;
    expect(brass).toBeGreaterThan(2);
    // Snow cover is a low slab: the top third of the icon is empty.
    const snow = renderItemIcon(B.SNOW_LAYER, s);
    for (let y = 0; y < s / 3; y++) for (let x = 0; x < s; x++) expect(alphaAt(snow, s, x, y)).toBe(0);
    // Glass is see-through: the middle of the cube shows the background.
    const glass = renderItemIcon(B.GLASS, s);
    let clear = 0;
    for (let y = 18; y < 30; y++) for (let x = 18; x < 30; x++) if (alphaAt(glass, s, x, y) === 0) clear++;
    expect(clear).toBeGreaterThan(40);
  });

  it('rejects bad sizes and unknown items', () => {
    expect(() => renderItemIcon(B.STONE, 0)).toThrow(RangeError);
    expect(() => renderItemIcon(B.STONE, 2.5)).toThrow(RangeError);
    expect(() => renderItemIcon(B.STONE, 4096)).toThrow(RangeError);
    expect(() => renderItemIcon(B.WATER, 32)).toThrow();
    expect(() => renderItemIcon(9999, 32)).toThrow();
  });

  it('works at odd and tiny sizes', () => {
    for (const s of [1, 7, 13, 24, 40, 100]) {
      expect(renderItemIcon(B.TURF, s).length).toBe(s * s * 4);
      expect(renderItemIcon(B.HELM, s).length).toBe(s * s * 4);
    }
  });

  it('is cheap enough for building a whole palette', () => {
    const t0 = performance.now();
    for (const it of allItems()) renderItemIcon(it.id, 64);
    const ms = performance.now() - t0;
    console.log(`renderItemIcon: ${allItems().length} icons @64px in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(2000);
  });
});
