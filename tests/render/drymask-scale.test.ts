/**
 * The dry region at half-cell resolution (docs/SHAPES.md 12.8): a hull with mixed cells uploads
 * one texel per octant (DryVolume.scale 2). The CPU mirror of the shader's sampling (drymask.ts)
 * on real hull masks: a ship side of upright slabs cuts the water only on its inner half; and the
 * backend's bookkeeping of a scale-2 volume (texture size, layer count, the same box matrix).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { qfromAxisAngle, vec3 } from '../../src/core/math';
import type { DryVolume, StructurePose } from '../../src/render/backend';
import { ThreeBackend } from '../../src/render/three/backend';
import { DRY_THRESHOLD, sampleDryMask } from '../../src/render/three/drymask';
import { analyzeHull, dryMask, type HullInfo } from '../../src/structures/hull';
import { Ship } from '../../src/structures/structure';
import { World } from '../../src/voxel/world';
import { EAST, LOWER, slab, WEST } from '../shapes';

/**
 * A 6 x 6 boat (x, z 0..5), floor of planks at y 0, walls y 1..2; the west wall (x = 0) is made of
 * upright slabs of the given half, the other walls of planks.
 */
function boat(westWall: number, rimLower = false): { h: HullInfo; dry: { scale: 1 | 2; mask: Uint8Array } } {
  const s = new Ship(1, new World(0));
  for (let y = 0; y <= 2; y++) {
    for (let z = 0; z <= 5; z++) {
      for (let x = 0; x <= 5; x++) {
        const wall = x === 0 || z === 0 || x === 5 || z === 5;
        if (y > 0 && !wall) continue;
        let c = makeCell(B.PLANKS_OAK);
        if (y > 0 && x === 0 && z > 0 && z < 5) c = slab(B.PLANKS_OAK, westWall);
        if (y === 2 && rimLower && wall) c = slab(B.PLANKS_OAK, LOWER);
        s.grid.setCell(x, y, z, c);
      }
    }
  }
  const h = analyzeHull(s.grid)!;
  return { h, dry: dryMask(h)! };
}

/** The shader's value at local point (lx, ly, lz) (sampleDryMask with texel counts). */
function sample(h: HullInfo, dry: { scale: 1 | 2; mask: Uint8Array }, lx: number, ly: number, lz: number): number {
  const k = dry.scale;
  return sampleDryMask(dry.mask, h.sx * k, h.sy * k, h.sz * k, (lx - h.ox) / h.sx, (lz - h.oz) / h.sz, (ly - h.oy) / h.sy);
}

describe('dry volume at octant resolution', () => {
  it('a ship side of upright slabs on its inner half: the water is cut inside the hold, not in the outer half of the side', () => {
    const { h, dry } = boat(EAST);
    expect(dry.scale).toBe(2);
    for (const ly of [1.1, 1.5, 2.4]) {
      for (const lz of [1.2, 2.5, 4.8]) {
        // the outer (west) half of the wall cell x = 0 is outside the hull: water stays
        for (const lx of [0.05, 0.25, 0.45]) expect(sample(h, dry, lx, ly, lz)).toBeLessThan(DRY_THRESHOLD);
        // the hold, right up to the slab
        for (const lx of [1.01, 1.5, 2.5, 4.9]) expect(sample(h, dry, lx, ly, lz)).toBeGreaterThan(DRY_THRESHOLD);
      }
    }
  });

  it('a ship side of upright slabs on its outer half: the inner half of the side cell is part of the dry hold', () => {
    const { h, dry } = boat(WEST);
    expect(dry.scale).toBe(2);
    for (const lx of [0.55, 0.75, 0.99]) expect(sample(h, dry, lx, 1.5, 2.5)).toBeGreaterThan(DRY_THRESHOLD);
    // outside the hull, west of the slab
    expect(sample(h, dry, -0.3, 1.5, 2.5)).toBeLessThan(DRY_THRESHOLD);
  });

  it('a rim of lower slabs: the hold at the rim layer is cut below the half height only', () => {
    const { h, dry } = boat(EAST, true);
    expect(sample(h, dry, 2.5, 2.2, 2.5)).toBeGreaterThan(DRY_THRESHOLD);
    expect(sample(h, dry, 2.5, 2.45, 2.5)).toBeGreaterThan(DRY_THRESHOLD);
    expect(sample(h, dry, 2.5, 2.55, 2.5)).toBeLessThan(DRY_THRESHOLD);
    expect(sample(h, dry, 2.5, 2.9, 2.5)).toBeLessThan(DRY_THRESHOLD);
  });

  it('a hull of full blocks keeps one texel per cell', () => {
    const { h, dry } = boat(0xff);
    expect(dry.scale).toBe(1);
    expect(dry.mask.length).toBe(h.sx * h.sy * h.sz);
  });
});

describe('backend bookkeeping of a scale-2 dry volume', () => {
  interface Internals {
    buildPipelines(): void;
    flushPending(): void;
    ready: boolean;
    assignDrySlots(): void;
    structures: Map<number, { dry: DryVolume | null; dryTex: THREE.Data3DTexture | null }>;
    u: { dryLayers: { value: THREE.Vector4 }; dryCount: { value: number }; dryMatrices: { value: THREE.Matrix4 }[] };
  }
  function ready(): { be: ThreeBackend; i: Internals } {
    const be = new ThreeBackend({ forceWebGL: true });
    const i = be as unknown as Internals;
    i.buildPipelines();
    i.ready = true;
    i.flushPending();
    return { be, i };
  }
  const pose = (): StructurePose => {
    const q = qfromAxisAngle(vec3(0, 1, 0), 0);
    return { px: 10, py: 40, pz: -5, qx: q.x, qy: q.y, qz: q.z, qw: q.w, pivotX: 0, pivotY: 0, pivotZ: 0, sky: 15, block: 0 };
  };

  it('the texture has 2 texels per cell on every axis, the slot 2 layers per cell; the box matrix is the same as at scale 1', () => {
    const { be, i } = ready();
    const { h, dry } = boat(EAST);
    be.setStructurePose(4, pose());
    be.setStructureDryVolume(4, { ox: h.ox, oy: h.oy, oz: h.oz, sx: h.sx, sy: h.sy, sz: h.sz, scale: dry.scale, mask: dry.mask });
    be.setCamera({ x: 0, y: 50, z: 0, yaw: 0, pitch: 0, fov: 70 });
    const rec = i.structures.get(4)!;
    const img = rec.dryTex!.image as { width: number; height: number; depth: number; data: Uint8Array };
    expect([img.width, img.height, img.depth]).toEqual([h.sx * 2, h.sz * 2, h.sy * 2]);
    expect(img.data.length).toBe(h.sx * h.sy * h.sz * 8);
    for (let k = 0; k < dry.mask.length; k++) expect(img.data[k]).toBe(dry.mask[k] ? 255 : 0);
    i.assignDrySlots();
    expect(i.u.dryCount.value).toBe(1);
    expect(i.u.dryLayers.value.x).toBe(h.sy * 2);
    const m2 = i.u.dryMatrices[0]!.value.clone();
    // the same box at scale 1: a new texture, the same matrix, sy layers
    be.setStructureDryVolume(4, { ox: h.ox, oy: h.oy, oz: h.oz, sx: h.sx, sy: h.sy, sz: h.sz, scale: 1, mask: new Uint8Array(h.sx * h.sy * h.sz).fill(1) });
    const img1 = rec.dryTex!.image as { width: number; height: number; depth: number };
    expect([img1.width, img1.height, img1.depth]).toEqual([h.sx, h.sz, h.sy]);
    i.assignDrySlots();
    expect(i.u.dryLayers.value.x).toBe(h.sy);
    expect(i.u.dryMatrices[0]!.value.elements).toEqual(m2.elements);
  });
});
