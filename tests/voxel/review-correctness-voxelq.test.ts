/**
 * Adversarial review of voxelq (src/voxel/raycast.ts, src/voxel/shape.ts) — correctness lens.
 *
 * Two kinds of tests live here:
 *  - "BUG:" tests FAIL on the reviewed code and document a defect.
 *  - "GUARD:" tests PASS on the reviewed code. They exist because the module's own suite
 *    still passes when the rule they check is deleted (verified by mutation testing); each
 *    names the mutant it kills. Keep them when fixing.
 */
import { describe, expect, it } from 'vitest';
import { qfromYaw, qidentity, vec3, type AABB } from '../../src/core/math';
import type { VoxelGrid } from '../../src/voxel/grid';
import { raycastGrid } from '../../src/voxel/raycast';
import { boxOverlapsSolid, deepestPenetration, nearestFreeOffset, resolvePenetration } from '../../src/voxel/shape';
import { STONE, box, boxAround, emptyWorld, fill, structure, unit } from './helpers';

/** World box of half extents h whose LOCAL bounding box (in grid g) has the given min corner. */
function boxWithLocalMin(g: VoxelGrid, lminX: number, lminY: number, lminZ: number, hx: number, hy: number, hz: number): AABB {
  const ax = g.dirToLocal(vec3(1, 0, 0));
  const ay = g.dirToLocal(vec3(0, 1, 0));
  const az = g.dirToLocal(vec3(0, 0, 1));
  const ex = hx * Math.abs(ax.x) + hy * Math.abs(ay.x) + hz * Math.abs(az.x);
  const ey = hx * Math.abs(ax.y) + hy * Math.abs(ay.y) + hz * Math.abs(az.y);
  const ez = hx * Math.abs(ax.z) + hy * Math.abs(ay.z) + hz * Math.abs(az.z);
  return boxAround(g.toWorld(vec3(lminX + ex, lminY + ey, lminZ + ez)), hx, hy, hz);
}

// ---------------------------------------------------------------------------------------------
// The brief's central anti-snagging rule ("candidate directions are only the cell's EXPOSED
// faces") is not protected by tests/voxel/shape.test.ts: deleting the line
//   if (isSolid(grid.getCell(x + DIR_X[d]!, y + DIR_Y[d]!, z + DIR_Z[d]!))) continue;
// in findPenetration leaves every "internal edges" / corner / hull test green (only the
// "fully embedded" test fails). Reason: the internal-edge fixtures sink the box 0.05 and
// overlap the neighbour cell by only 0.01, so the "largest true overlap" ranking already
// picks the main cell, whose shallowest face (+Y) is exposed anyway. The rule only matters
// when the box is sunk deeper than its horizontal overlap with every cell it touches.
// ---------------------------------------------------------------------------------------------
describe('GUARD: exposed-face filter (kills mutant "exposed check removed")', () => {
  it('world: player box straddling two floor cells 0.3/0.3 and sunk 0.4 is pushed UP', () => {
    const w = emptyWorld();
    fill(w, 0, 0, 0, 5, 1, 5); // floor top y = 1
    const b = box(1.7, 0.6, 2.2, 2.3, 2.4, 2.8);
    const p = deepestPenetration(w, b)!;
    expect([p.nx, p.ny, p.nz]).toEqual([0, 1, 0]);
    expect(p.depth).toBeCloseTo(0.4, 12);
    const r = resolvePenetration(w, b);
    expect(r.resolved).toBe(true);
    expect([r.dx, r.dz]).toEqual([0, 0]);
    expect(r.dy).toBeCloseTo(0.4, 12);
  });

  it('world: item-sized box (0.25 wide) over an internal edge, sunk 0.2, is pushed UP', () => {
    const w = emptyWorld();
    fill(w, 0, 0, 0, 5, 1, 5);
    const b = box(1.9, 0.8, 2.4, 2.15, 1.05, 2.65); // overlaps cell 1 by 0.1, cell 2 by 0.15
    const p = deepestPenetration(w, b)!;
    expect([p.nx, p.ny, p.nz]).toEqual([0, 1, 0]);
    expect(p.depth).toBeCloseTo(0.2, 12);
  });

  it('yaw-rotated deck: box straddling an internal edge and sunk deeper than its overlap is pushed along deck +Y', () => {
    const world = emptyWorld();
    const s = structure(world, 1, vec3(20.3, 64.1, -11.7), qfromYaw(0.65), vec3(2.5, 0.5, 2.5));
    fill(s, 0, 0, 0, 5, 1, 5);
    const ax = s.dirToLocal(vec3(1, 0, 0));
    const az = s.dirToLocal(vec3(0, 0, 1));
    const ex = 0.3 * Math.abs(ax.x) + 0.3 * Math.abs(az.x); // local half extent along x (~0.42)
    const b = boxWithLocalMin(s, 2 - ex, 0.5, 2.0, 0.3, 0.9, 0.3); // centred on the edge x = 2, sunk 0.5
    const up = s.dirToWorld(vec3(0, 1, 0));
    const p = deepestPenetration(s, b)!;
    expect(p.nx).toBeCloseTo(up.x, 9);
    expect(p.ny).toBeCloseTo(up.y, 9);
    expect(p.nz).toBeCloseTo(up.z, 9);
    expect(p.depth).toBeCloseTo(0.5, 9);
  });
});

describe('GUARD: structure-path fallbacks (kill mutants that survive shape.test.ts)', () => {
  // Mutant: resolvePenetration structure branch sets `res.resolved = true` when no push is found.
  it('resolvePenetration on a structure reports failure for a fully embedded box', () => {
    const world = emptyWorld();
    const s = structure(world, 1, vec3(10.2, 40, -3.7), qfromYaw(0.4), vec3(1.5, 1.5, 1.5));
    fill(s, 0, 0, 0, 3, 3, 3);
    const inner = boxAround(s.toWorld(vec3(1.5, 1.5, 1.5)), 0.15, 0.15, 0.15);
    expect(boxOverlapsSolid(s, inner)).toBe(true);
    expect(deepestPenetration(s, inner)).toBeNull();
    const r = resolvePenetration(s, inner);
    expect(r.resolved).toBe(false);
  });

  // Mutant: nearestFreeOffset drops structures with obb.range(0) instead of obb.range(radius),
  // i.e. ignores every structure the box does not ALREADY overlap.
  it('nearestFreeOffset avoids a structure the box only touches before the move', () => {
    const world = emptyWorld();
    fill(world, -5, 0, -5, 5, 1, 5); // floor top y = 1
    const lid = structure(world, 1, vec3(0, 0, 0), qidentity());
    fill(lid, -1, 2, -1, 1, 3, 1); // slab directly above the box, occupying y in [2, 3)
    const b = box(-0.3, 0.7, -0.3, 0.3, 2.0, 0.3); // sunk 0.3 into the floor, head touching the slab
    expect(boxOverlapsSolid(lid, b)).toBe(false);
    const r = nearestFreeOffset([world, lid], b, 3)!;
    const moved = { minX: b.minX + r.x, minY: b.minY + r.y, minZ: b.minZ + r.z, maxX: b.maxX + r.x, maxY: b.maxY + r.y, maxZ: b.maxZ + r.z };
    expect(boxOverlapsSolid(world, moved)).toBe(false);
    expect(boxOverlapsSolid(lid, moved)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// raycast: on an exact edge/corner crossing the DDA steps the LATER axis first and tests the
// intermediate cell, which the ray only touches along an edge (zero length inside it). With
// half-open cells (the module's stated convention) that cell is never entered. The result is
// also asymmetric: mirror-image scenes give different answers depending on axis order.
// ---------------------------------------------------------------------------------------------
describe('BUG: raycast edge crossing', () => {
  it('a 45-degree ray through the lattice edge (1,1) treats mirror-image cells the same', () => {
    const d = unit(1, 1, 0);
    const a = emptyWorld();
    a.setCell(0, 1, 0, STONE); // touched only along the edge x = 1, y = 1
    const b = emptyWorld();
    b.setCell(1, 0, 0, STONE); // mirror image across the ray: touched only along the same edge
    const ha = raycastGrid(a, vec3(0.5, 0.5, 0.5), d, 5);
    const hb = raycastGrid(b, vec3(0.5, 0.5, 0.5), d, 5);
    // Today: ha = cell (0,1,0) at dist 0.7071 (face -Y), hb = null.
    expect(ha === null).toBe(hb === null);
  });
});
