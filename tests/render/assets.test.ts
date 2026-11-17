import { describe, expect, it } from 'vitest';
import { prepareTilePixels, mipLevelCount } from '../../src/render/three/tiles';
import { makeCloudNoise } from '../../src/render/three/noise';
import { buildBox, buildQuad, boxEdges } from '../../src/render/three/boxgeom';
import { blastCrateVisual, crackLayer, crackStage, cubeTilesForCell, itemVisual, tileLayer } from '../../src/render/three/blocktiles';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { axisState, makeCell } from '../../src/blocks/cell';
import { BLOCKS, TILE_NAMES } from '../../src/blocks/registry';
import { facingState } from '../../src/blocks/cell';
import { NZ, PY } from '../../src/core/dirs';

describe('tile preparation', () => {
  it('flips rows of every layer so v = 0 is the bottom row', () => {
    const size = 4;
    const count = 2;
    const pixels = new Uint8Array(size * size * 4 * count);
    for (let l = 0; l < count; l++) {
      for (let row = 0; row < size; row++) {
        for (let x = 0; x < size; x++) {
          const o = (l * size * size + row * size + x) * 4;
          pixels[o] = row * 10 + l; // encode source row
          pixels[o + 3] = 255;
        }
      }
    }
    const out = prepareTilePixels({ size, count, pixels });
    for (let l = 0; l < count; l++) {
      for (let row = 0; row < size; row++) {
        const o = (l * size * size + row * size) * 4;
        expect(out[o]).toBe((size - 1 - row) * 10 + l);
      }
    }
    // Input untouched.
    expect(pixels[0]).toBe(0);
  });

  it('dilates colour into transparent texels without changing alpha', () => {
    const size = 8;
    const pixels = new Uint8Array(size * size * 4);
    // One opaque red texel in the middle, the rest transparent black.
    const c = (3 + 3 * size) * 4;
    pixels[c] = 200;
    pixels[c + 1] = 40;
    pixels[c + 2] = 10;
    pixels[c + 3] = 255;
    const out = prepareTilePixels({ size, count: 1, pixels });
    let opaque = 0;
    for (let i = 0; i < size * size; i++) {
      if (out[i * 4 + 3] !== 0) opaque++;
    }
    expect(opaque).toBe(1);
    // A neighbour of the (flipped) opaque texel now carries its colour.
    const fy = size - 1 - 3;
    const n = (4 + fy * size) * 4;
    expect(out[n]).toBe(200);
    expect(out[n + 1]).toBe(40);
    expect(out[n + 3]).toBe(0);
  });

  it('leaves fully opaque and fully transparent layers as they are', () => {
    const size = 4;
    const pixels = new Uint8Array(size * size * 4 * 2);
    for (let i = 0; i < size * size; i++) {
      pixels[i * 4] = 50;
      pixels[i * 4 + 3] = 255;
    }
    const out = prepareTilePixels({ size, count: 2, pixels });
    for (let i = 0; i < size * size; i++) {
      expect(out[i * 4]).toBe(50);
      expect(out[(size * size + i) * 4]).toBe(0);
    }
  });

  it('rejects short buffers and counts mips', () => {
    expect(() => prepareTilePixels({ size: 16, count: 2, pixels: new Uint8Array(10) })).toThrow();
    expect(mipLevelCount(16)).toBe(5);
    expect(mipLevelCount(1)).toBe(1);
  });
});

describe('cloud noise', () => {
  const size = 64;
  const a = makeCloudNoise(size, 7);

  it('is deterministic and seed dependent', () => {
    expect(makeCloudNoise(size, 7)).toEqual(a);
    expect(makeCloudNoise(size, 8)).not.toEqual(a);
  });

  it('uses the full range and tiles seamlessly', () => {
    let lo = 255;
    let hi = 0;
    let maxStep = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = a[(x + y * size) * 4]!;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
        const r = a[(((x + 1) % size) + y * size) * 4]!;
        const d = a[(x + ((y + 1) % size) * size) * 4]!;
        maxStep = Math.max(maxStep, Math.abs(v - r), Math.abs(v - d));
      }
    }
    expect(lo).toBe(0);
    expect(hi).toBe(255);
    // Neighbour differences across the wrap are no larger than inside: no seam.
    let wrapStep = 0;
    for (let y = 0; y < size; y++) {
      wrapStep = Math.max(wrapStep, Math.abs(a[(size - 1 + y * size) * 4]! - a[(y * size) * 4]!));
    }
    expect(wrapStep).toBeLessThanOrEqual(maxStep);
    expect(maxStep).toBeLessThan(64);
  });
});

describe('render-side block visuals', () => {
  it('plain cubes keep their 6 tiles in Dir order', () => {
    const v = cubeTilesForCell(B.TURF)!;
    const def = BLOCKS[B.TURF]!;
    expect(v.kind).toBe('cube');
    expect(v.tiles).toEqual(def.tileIds);
    expect(v.layer).toBe('opaque');
  });

  it('logs put the end tile on the faces of their axis', () => {
    const def = BLOCKS[B.LOG_OAK]!;
    const [side, end] = def.tileIds;
    const upright = cubeTilesForCell(makeCell(B.LOG_OAK, axisState(1)))!;
    expect(upright.tiles).toEqual([side, side, end, end, side, side]);
    const eastWest = cubeTilesForCell(makeCell(B.LOG_OAK, axisState(0)))!;
    expect(eastWest.tiles).toEqual([end, end, side, side, side, side]);
  });

  it('bearings show the front on their facing', () => {
    const [front, back, side] = BLOCKS[B.BEARING]!.tileIds;
    const v = cubeTilesForCell(makeCell(B.BEARING, facingState(PY)))!;
    expect(v.tiles[PY]).toBe(front);
    expect(v.tiles[PY ^ 1]).toBe(back);
    expect(v.tiles[NZ]).toBe(side);
  });

  it('non-cube blocks have no cube; plants become icons', () => {
    expect(cubeTilesForCell(B.FLOWER_RED)).toBeNull();
    expect(cubeTilesForCell(B.AIR)).toBeNull();
    const flower = itemVisual(B.FLOWER_RED);
    expect(flower).toEqual({ kind: 'icon', tile: BLOCKS[B.FLOWER_RED]!.tileIds[0] });
    const helm = itemVisual(B.HELM);
    expect(helm).toEqual({ kind: 'icon', tile: BLOCKS[B.HELM]!.tileIds[1] });
  });

  it('dropped logs stand upright; lamps glow; leaves are cutout', () => {
    const log = itemVisual(B.LOG_PINE);
    expect(log.kind).toBe('cube');
    if (log.kind === 'cube') expect(log.tiles[2]).toBe(BLOCKS[B.LOG_PINE]!.tileIds[1]);
    const lamp = itemVisual(B.LAMP);
    expect(lamp.kind === 'cube' && lamp.emissive).toBe(true);
    const leaves = itemVisual(B.LEAVES_OAK);
    expect(leaves.kind === 'cube' && leaves.layer).toBe('cutout');
  });

  it('non-block items use their icon tile; unknown ids draw nothing', () => {
    expect(itemVisual(I.GLUE)).toEqual({ kind: 'icon', tile: TILE_NAMES.indexOf('item_glue') });
    expect(itemVisual(I.BUCKET_WATER)).toEqual({ kind: 'icon', tile: TILE_NAMES.indexOf('item_bucket_water') });
    expect(itemVisual(99999).kind).toBe('none');
    expect(itemVisual(B.WATER).kind).toBe('none');
  });

  it('blast crate and crack stages', () => {
    const tnt = blastCrateVisual();
    expect(tnt.tiles[2]).toBe(tileLayer('tnt_top'));
    expect(tnt.tiles[0]).toBe(tileLayer('tnt_side'));
    expect(crackStage(0)).toBe(-1);
    expect(crackStage(0.01)).toBe(0);
    expect(crackStage(0.99)).toBe(7);
    expect(crackStage(1)).toBe(7);
    expect(crackLayer(0)).toBe(TILE_NAMES.indexOf('crack_0'));
    expect(crackLayer(7)).toBe(TILE_NAMES.indexOf('crack_7'));
    expect(crackLayer(12)).toBe(TILE_NAMES.indexOf('crack_7'));
  });
});

describe('box geometry', () => {
  it('builds 6 quads with outward CCW winding and mesher light layout', () => {
    const g = buildBox({ x0: 0, y0: 0, z0: 0, x1: 1, y1: 2, z1: 1, tiles: [1, 2, 3, 4, 5, 6], flags: 1 });
    expect(g.vertexCount).toBe(24);
    expect(g.indexCount).toBe(36);
    for (let f = 0; f < 6; f++) {
      const i0 = g.indices[f * 6]!;
      const i1 = g.indices[f * 6 + 1]!;
      const i2 = g.indices[f * 6 + 2]!;
      const p = (i: number) => [g.positions[i * 3]!, g.positions[i * 3 + 1]!, g.positions[i * 3 + 2]!];
      const a = p(i0);
      const b = p(i1);
      const c = p(i2);
      const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const sn = [g.normals[i0 * 3]!, g.normals[i0 * 3 + 1]!, g.normals[i0 * 3 + 2]!];
      expect(n[0]! * sn[0]! + n[1]! * sn[1]! + n[2]! * sn[2]!).toBeGreaterThan(0);
      expect(g.layers[i0]).toBe(f + 1);
    }
    for (let v = 0; v < 24; v++) {
      expect(Array.from(g.light.subarray(v * 4, v * 4 + 4))).toEqual([255, 0, 255, 1]);
      expect(g.positions[v * 3 + 1]! === 0 || g.positions[v * 3 + 1]! === 2).toBe(true);
    }
  });

  it('side faces have v = 0 at the bottom', () => {
    const g = buildBox({ x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1, tiles: [0, 0, 0, 0, 0, 0] });
    for (const f of [0, 1, 4, 5]) {
      for (let k = 0; k < 4; k++) {
        const v = f * 4 + k;
        expect(g.uvs[v * 2 + 1]).toBe(g.positions[v * 3 + 1]);
      }
    }
  });

  it('quad and edges', () => {
    const q = buildQuad(0.5, 9);
    expect(q.vertexCount).toBe(4);
    expect(Math.max(...q.positions)).toBeCloseTo(0.25, 6);
    expect(q.layers[3]).toBe(9);
    // Two-sided icon: a back copy with opposite normal and opposite (CCW from behind) winding.
    const d = buildQuad(0.5, 9, 0, true);
    expect(d.vertexCount).toBe(8);
    expect(d.indexCount).toBe(12);
    const windingZ = (g: typeof d, quad: number): number => {
      const i = (k: number) => g.indices[quad * 6 + k]!;
      const p = (v: number) => [g.positions[v * 3]!, g.positions[v * 3 + 1]!];
      const [a, b, c] = [p(i(0)), p(i(1)), p(i(2))];
      return (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
    };
    expect(windingZ(d, 0)).toBeGreaterThan(0);
    expect(windingZ(d, 1)).toBeLessThan(0);
    expect(d.normals[4 * 3 + 2]).toBe(-127);
    const e = boxEdges(0, 0, 0, 1, 1, 1);
    expect(e.length).toBe(72);
  });
});
