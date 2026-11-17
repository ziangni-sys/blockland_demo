/**
 * Dry-volume cut sampling (mirror of shading.ts dryVolumeFactor). Review finding: with
 * trilinear filtering the cut leaked world water into the inner corners of a hold whenever
 * the waterline came within ~0.3 cells of the hold floor (the normal floating position of a
 * small boat), because the non-dry floor layer attenuated the corner value below 0.2.
 */
import { describe, expect, it } from 'vitest';
import { DRY_THRESHOLD, sampleDryMask } from '../../src/render/three/drymask';

/**
 * The reviewer's hold, laid out like src/structures/hull.ts: a 7 x 5 planks floor at local
 * y 0, 2-high walls at y 1..2, analysed box = tight bounds grown by 1 (ox = oy = oz = -1,
 * 9 x 5 x 7 cells in x, y, z). Interior air at y 1..2 is dry (bilge while floating).
 */
function hold(): { mask: Uint8Array; sx: number; sy: number; sz: number; o: number } {
  const sx = 9;
  const sy = 5;
  const sz = 7;
  const mask = new Uint8Array(sx * sy * sz);
  for (let y = 1; y <= 2; y++) {
    for (let z = 1; z <= 3; z++) {
      for (let x = 1; x <= 5; x++) {
        // local cell (x, y, z) -> box index with the -1 origin
        mask[x + 1 + (z + 1) * sx + (y + 1) * sx * sz] = 1;
      }
    }
  }
  return { mask, sx, sy, sz, o: -1 };
}

/** Trilinear sampling (the old shader) for comparison. */
function trilinear(h: ReturnType<typeof hold>, lx: number, ly: number, lz: number): number {
  const at = (x: number, y: number, z: number): number => {
    const xi = Math.min(h.sx - 1, Math.max(0, x));
    const yi = Math.min(h.sy - 1, Math.max(0, y));
    const zi = Math.min(h.sz - 1, Math.max(0, z));
    return h.mask[xi + zi * h.sx + yi * h.sx * h.sz]! ? 1 : 0;
  };
  const fx = lx - h.o - 0.5;
  const fy = ly - h.o - 0.5;
  const fz = lz - h.o - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const z0 = Math.floor(fz);
  let v = 0;
  for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
    const w = (dx ? fx - x0 : 1 - (fx - x0)) * (dy ? fy - y0 : 1 - (fy - y0)) * (dz ? fz - z0 : 1 - (fz - z0));
    v += w * at(x0 + dx, y0 + dy, z0 + dz);
  }
  return v;
}

const sample = (h: ReturnType<typeof hold>, lx: number, ly: number, lz: number): number =>
  sampleDryMask(h.mask, h.sx, h.sy, h.sz, (lx - h.o) / h.sx, (lz - h.o) / h.sz, (ly - h.o) / h.sy);

describe('dry volume cut sampling', () => {
  it('cuts every point of every dry cell, at any height in the cell (inner corners included)', () => {
    const h = hold();
    for (let y = 1; y <= 2; y++) {
      for (const fy of [0.02, 0.15, 0.29, 0.5, 0.98]) {
        for (let z = 1; z <= 3; z++) {
          for (let x = 1; x <= 5; x++) {
            for (const fx of [0.001, 0.25, 0.5, 0.999]) {
              for (const fz of [0.001, 0.5, 0.999]) {
                expect(sample(h, x + fx, y + fy, z + fz)).toBeGreaterThan(DRY_THRESHOLD);
              }
            }
          }
        }
      }
    }
  });

  it('the old trilinear sampling leaked at the inner corners near the floor (the reported bug)', () => {
    const h = hold();
    // Waterline 0.15 above the floor top (local y 1.15), inner corner of the hold.
    expect(trilinear(h, 1.01, 1.15, 1.01)).toBeLessThan(DRY_THRESHOLD);
    expect(sample(h, 1.01, 1.15, 1.01)).toBeGreaterThan(DRY_THRESHOLD);
  });

  it('never cuts open cells outside the walls, nor above the top dry layer', () => {
    const h = hold();
    // Outside the walls (wall cells are local x 0 / 6, z 0 / 4): the cell beyond a wall.
    for (const fy of [0.1, 0.5, 0.9]) {
      for (let z = -1; z <= 5; z++) {
        for (const fz of [0.1, 0.5, 0.9]) {
          expect(sample(h, -0.5, 1 + fy, z + fz)).toBeLessThanOrEqual(DRY_THRESHOLD);
          expect(sample(h, 7.5, 1 + fy, z + fz)).toBeLessThanOrEqual(DRY_THRESHOLD);
        }
      }
    }
    // Directly above the top dry layer (open air over the hold, local y 3): no cut at all.
    expect(sample(h, 3.5, 3.05, 2.5)).toBe(0);
    // The cut overlaps the walls by at most ~0.3 cells.
    expect(sample(h, 0.75, 1.5, 2.5)).toBeGreaterThan(DRY_THRESHOLD);
    expect(sample(h, 0.68, 1.5, 2.5)).toBeLessThanOrEqual(DRY_THRESHOLD);
  });
});
