import { describe, expect, it } from 'vitest';
import { aabbClone, aabbTranslate, qfromYaw, qidentity, qmul, vec3, type AABB, type Quat, type Vec3 } from '../../src/core/math';
import { Rng } from '../../src/core/rng';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import type { VoxelGrid } from '../../src/voxel/grid';
import { StructureGrid } from '../../src/voxel/sgrid';
import {
  CONTACT_EPS,
  DEFAULT_PREFER_WEIGHT,
  FREE_OFFSET_STEP,
  MAX_RESOLVE_ITERATIONS,
  boxOverlapsSolid,
  columnHasSolidBelow,
  deepestPenetration,
  forEachSolidCellOverlapping,
  hasSupportBelow,
  nearestFreeOffset,
  resolvePenetration,
  supportProbe,
  sweepAxis,
} from '../../src/voxel/shape';
import { World } from '../../src/voxel/world';
import { STONE, axisAngle, box, boxAround, emptyWorld, fill, overlapMargin, randomQuat, structure } from './helpers';

function visited(g: VoxelGrid, b: AABB): Set<string> {
  const s = new Set<string>();
  forEachSolidCellOverlapping(g, b, (x, y, z) => {
    s.add(`${x},${y},${z}`);
  });
  return s;
}

/** World-space box of half extents h whose LOCAL bounding box (in grid g) has the given min corner. */
function boxWithLocalMin(g: VoxelGrid, lminX: number, lminY: number, lminZ: number, hx: number, hy: number, hz: number): AABB {
  // local AABB half extents of the world box
  const ax = g.dirToLocal(vec3(1, 0, 0));
  const ay = g.dirToLocal(vec3(0, 1, 0));
  const az = g.dirToLocal(vec3(0, 0, 1));
  const ex = hx * Math.abs(ax.x) + hy * Math.abs(ay.x) + hz * Math.abs(az.x);
  const ey = hx * Math.abs(ax.y) + hy * Math.abs(ay.y) + hz * Math.abs(az.y);
  const ez = hx * Math.abs(ax.z) + hy * Math.abs(ay.z) + hz * Math.abs(az.z);
  const c = g.toWorld(vec3(lminX + ex, lminY + ey, lminZ + ez));
  return boxAround(c, hx, hy, hz);
}

function expectVec(v: { x: number; y: number; z: number } | { nx: number; ny: number; nz: number }, e: Vec3, digits = 9): void {
  const a = 'nx' in v ? { x: v.nx, y: v.ny, z: v.nz } : v;
  expect(a.x).toBeCloseTo(e.x, digits);
  expect(a.y).toBeCloseTo(e.y, digits);
  expect(a.z).toBeCloseTo(e.z, digits);
}

// ====================================================================== overlap

describe('overlap — world fast path', () => {
  const w = emptyWorld();
  w.setCell(0, 10, 0, STONE);
  w.setCell(-1, 10, -1, STONE);

  it('touching within CONTACT_EPS is not overlapping; beyond it is', () => {
    expect(boxOverlapsSolid(w, box(0.2, 11, 0.2, 0.8, 12.8, 0.8))).toBe(false); // standing on top
    expect(boxOverlapsSolid(w, box(0.2, 11 - 0.5e-9, 0.2, 0.8, 12.8, 0.8))).toBe(false);
    expect(boxOverlapsSolid(w, box(0.2, 11 - 2e-9, 0.2, 0.8, 12.8, 0.8))).toBe(true);
    expect(boxOverlapsSolid(w, box(1, 10, 0, 2, 11, 1))).toBe(false); // face contact
    expect(boxOverlapsSolid(w, box(1 - 2e-9, 10, 0, 2, 11, 1))).toBe(true);
    expect(boxOverlapsSolid(w, box(1, 11, 1, 2, 12, 2))).toBe(false); // edge/corner contact
    expect(CONTACT_EPS).toBe(1e-9);
  });

  it('negative coordinates and chunk borders', () => {
    expect([...visited(w, box(-1.5, 10.2, -1.5, 0.5, 10.8, 0.5))].sort()).toEqual(['-1,10,-1', '0,10,0']);
    expect(boxOverlapsSolid(w, box(-0.999, 10.1, -0.999, -0.001, 10.9, -0.001))).toBe(true); // inside (-1,10,-1)
    expect(boxOverlapsSolid(w, box(-0.999, 10.1, 0.001, -0.001, 10.9, 0.999))).toBe(false); // inside empty (-1,10,0)
    expect(boxOverlapsSolid(w, box(-2, 10.1, -1, -1, 10.9, 0))).toBe(false); // face contact from -X
  });

  it('a zero-size box inside a solid cell overlaps it; inverted boxes overlap nothing', () => {
    expect(boxOverlapsSolid(w, box(0.5, 10.5, 0.5, 0.5, 10.5, 0.5))).toBe(true);
    expect(boxOverlapsSolid(w, box(0.8, 10.5, 0.5, 0.2, 10.6, 0.6))).toBe(false);
    expect(boxOverlapsSolid(w, box(NaN, 10.5, 0.5, 0.6, 10.6, 0.6))).toBe(false);
  });

  it('unloaded chunks and below-world are solid; above the build limit is air', () => {
    expect(boxOverlapsSolid(w, box(1000.2, 50, 0.2, 1000.8, 51, 0.8))).toBe(true);
    expect(boxOverlapsSolid(w, box(0.2, -2, 0.2, 0.8, -1.5, 0.8))).toBe(true);
    expect(boxOverlapsSolid(w, box(1000.2, 200, 0.2, 1000.8, 201, 0.8))).toBe(false);
    expect(boxOverlapsSolid(w, box(0.2, 127.5, 0.2, 0.8, 129, 0.8))).toBe(false);
  });

  it('forEachSolidCellOverlapping visits y,z,x order, passes the cell, and stops on true', () => {
    const g = emptyWorld();
    fill(g, 0, 20, 0, 2, 22, 2);
    g.setCell(1, 21, 1, makeCell(B.PLANKS_OAK));
    g.setCell(0, 20, 1, makeCell(B.TORCH)); // soft: not visited
    const order: string[] = [];
    forEachSolidCellOverlapping(g, box(0.5, 20.5, 0.5, 1.5, 21.5, 1.5), (x, y, z, c) => {
      order.push(`${x},${y},${z}:${c & 0x3ff}`);
    });
    expect(order).toEqual(['0,20,0:1', '1,20,0:1', '1,20,1:1', '0,21,0:1', '1,21,0:1', '0,21,1:1', '1,21,1:10']);
    let n = 0;
    forEachSolidCellOverlapping(g, box(0.5, 20.5, 0.5, 1.5, 21.5, 1.5), () => ++n === 2);
    expect(n).toBe(2);
  });
});

describe('overlap — exact OBB/cell SAT on rotated structures', () => {
  it('matches an exact LP reference and brute-force point sampling for random rotations', () => {
    const rng = new Rng(2024);
    const world = new World();
    let decided = 0;
    let positives = 0;
    let sampledHits = 0;
    for (let trial = 0; trial < 45; trial++) {
      const ship = structure(
        world,
        1,
        vec3(rng.range(-500, 500), rng.range(0, 100), rng.range(-500, 500)),
        randomQuat(rng),
        vec3(rng.range(-3, 3), rng.range(-3, 3), rng.range(-3, 3)),
      );
      let g: StructureGrid = ship;
      if (trial % 3 === 2) {
        ship.setCell(10, 10, 10, STONE); // give the parent some content of its own
        g = new StructureGrid(2, ship);
        g.pivot.x = rng.range(-1, 1);
        g.setPoseImmediate(vec3(rng.range(-4, 4), rng.range(-4, 4), rng.range(-4, 4)), randomQuat(rng));
      }
      fill(g, -2, -2, -2, 2, 2, 2);
      for (let k = 0; k < 6; k++) {
        const lc = vec3(rng.range(-3.2, 3.2), rng.range(-3.2, 3.2), rng.range(-3.2, 3.2));
        const c = g.toWorld(lc);
        const b = boxAround(c, rng.range(0.02, 1.3), rng.range(0.02, 1.3), rng.range(0.02, 1.3));
        const got = visited(g, b);
        expect(boxOverlapsSolid(g, b)).toBe(got.size > 0);
        const halfDiag = Math.hypot(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) / 2;
        for (let x = -2; x < 2; x++)
          for (let y = -2; y < 2; y++)
            for (let z = -2; z < 2; z++) {
              const key = `${x},${y},${z}`;
              const dist = Math.hypot(x + 0.5 - lc.x, y + 0.5 - lc.y, z + 0.5 - lc.z);
              if (dist > halfDiag + 0.8661) {
                expect(got.has(key)).toBe(false); // bounding spheres apart
                continue;
              }
              const m = overlapMargin(g, b, x, y, z);
              if (m > 1e-7) {
                expect(got.has(key)).toBe(true);
                positives++;
                decided++;
              } else if (m < -1e-7) {
                expect(got.has(key)).toBe(false);
                decided++;
              }
            }
        // Point sampling: any sample strictly inside a solid cell proves that cell overlaps.
        for (let i = 0; i < 200; i++) {
          const p = vec3(rng.range(b.minX, b.maxX), rng.range(b.minY, b.maxY), rng.range(b.minZ, b.maxZ));
          const l = g.toLocal(p);
          const cx = Math.floor(l.x);
          const cy = Math.floor(l.y);
          const cz = Math.floor(l.z);
          if (cx < -2 || cx > 1 || cy < -2 || cy > 1 || cz < -2 || cz > 1) continue;
          const inner = Math.min(l.x - cx, cx + 1 - l.x, l.y - cy, cy + 1 - l.y, l.z - cz, cz + 1 - l.z);
          if (inner < 1e-6) continue;
          sampledHits++;
          expect(got.has(`${cx},${cy},${cz}`)).toBe(true);
        }
      }
    }
    expect(decided).toBeGreaterThan(1000);
    expect(positives).toBeGreaterThan(300);
    expect(sampledHits).toBeGreaterThan(1000);
  });

  it('axis-aligned rotations keep exact contact semantics', () => {
    const world = new World();
    for (const q of [qfromYaw(Math.PI / 2), qfromYaw(Math.PI), qfromYaw(-Math.PI / 2), axisAngle(1, 0, 0, Math.PI / 2), qmul(qfromYaw(Math.PI / 2), axisAngle(0, 0, 1, -Math.PI / 2))]) {
      const s = structure(world, 1, vec3(100.25, 40, -7.75), q, vec3(0.5, 0.5, 0.5));
      s.setCell(0, 0, 0, STONE);
      // The cell occupies the unit cube centred at the position, whatever the rotation.
      const c = s.position;
      expect(boxOverlapsSolid(s, box(c.x - 0.3, c.y + 0.5, c.z - 0.3, c.x + 0.3, c.y + 2, c.z + 0.3))).toBe(false);
      expect(boxOverlapsSolid(s, box(c.x - 0.3, c.y + 0.5 - 1e-6, c.z - 0.3, c.x + 0.3, c.y + 2, c.z + 0.3))).toBe(true);
      expect(boxOverlapsSolid(s, box(c.x + 0.5, c.y - 0.5, c.z - 0.5, c.x + 1.5, c.y + 0.5, c.z + 0.5))).toBe(false);
      expect(boxOverlapsSolid(s, box(c.x + 0.5 - 1e-6, c.y - 0.5, c.z - 0.5, c.x + 1.5, c.y + 0.5, c.z + 0.5))).toBe(true);
    }
  });

  it('empty structures and far-away boxes overlap nothing', () => {
    const world = new World();
    const s = structure(world, 1, vec3(0, 0, 0), axisAngle(1, 1, 0, 0.3));
    expect(boxOverlapsSolid(s, box(-1, -1, -1, 1, 1, 1))).toBe(false);
    s.setCell(0, 0, 0, STONE);
    expect(boxOverlapsSolid(s, box(-1, -1, -1, 1, 1, 1))).toBe(true);
    expect(boxOverlapsSolid(s, box(50, 50, 50, 51, 51, 51))).toBe(false);
    expect(deepestPenetration(s, box(50, 50, 50, 51, 51, 51))).toBeNull();
  });
});

// ====================================================================== penetration

describe('deepestPenetration — internal edges', () => {
  it('world: a box sunk 0.05 into a flat floor and overlapping the next cell by 0.01 is pushed UP', () => {
    const w = emptyWorld();
    fill(w, 0, 0, 0, 5, 1, 5); // one-layer floor, top at y = 1
    for (const b of [box(0.41, 0.95, 2.2, 1.01, 2.75, 2.8), box(3.99, 0.95, 2.2, 4.59, 2.75, 2.8), box(1.99, 0.95, 0.99, 2.59, 2.75, 1.59)]) {
      expect(visited(w, b).size).toBeGreaterThan(1); // really straddles two floor cells
      const p = deepestPenetration(w, b)!;
      expect([p.nx, p.ny, p.nz]).toEqual([0, 1, 0]);
      expect(p.depth).toBeCloseTo(0.05, 12);
      const r = resolvePenetration(w, b);
      expect(r.resolved).toBe(true);
      expect(r.iterations).toBe(1);
      expect([r.dx, r.dz, r.nx, r.ny, r.nz]).toEqual([0, 0, 0, 1, 0]);
      expect(r.dy).toBeCloseTo(0.05, 12);
      expect(boxOverlapsSolid(w, aabbTranslate(b, r.dx, r.dy, r.dz))).toBe(false);
    }
  });

  it('yaw-rotated structure: pushed along the deck normal, not sideways', () => {
    const world = new World();
    const s = structure(world, 1, vec3(20.3, 64.1, -11.7), qfromYaw(0.65), vec3(2.5, 0.5, 2.5));
    fill(s, 0, 0, 0, 5, 1, 5);
    // Yaw keeps the box upright in local space: it sinks exactly 0.05. Its local AABB is
    // placed so that a vertical edge pokes 0.01 into the neighbouring deck cell.
    const ax = s.dirToLocal(vec3(1, 0, 0));
    const az = s.dirToLocal(vec3(0, 0, 1));
    const ex = 0.3 * Math.abs(ax.x) + 0.3 * Math.abs(az.x);
    const b = boxWithLocalMin(s, 1.01 - 2 * ex, 0.95, 2.1, 0.3, 0.9, 0.3); // max x = 1.01
    const b2 = boxWithLocalMin(s, 2.99, 0.95, 2.1, 0.3, 0.9, 0.3); // min x = 2.99
    expect([...visited(s, b)].some((k) => k.startsWith('1,0,'))).toBe(true);
    expect([...visited(s, b2)].some((k) => k.startsWith('2,0,'))).toBe(true);
    for (const bb of [b, b2]) {
      expect(visited(s, bb).size).toBeGreaterThan(1);
      const p = deepestPenetration(s, bb)!;
      expectVec(p, vec3(0, 1, 0), 12);
      expect(p.depth).toBeCloseTo(0.05, 9);
      const r = resolvePenetration(s, bb);
      expect(r.resolved).toBe(true);
      expect(r.dy).toBeCloseTo(0.05, 9);
      expect(Math.abs(r.dx) + Math.abs(r.dz)).toBeLessThan(1e-12);
    }
  });

  it('tilted structure: up is the grid\'s local +Y in world space', () => {
    const world = new World();
    const q = qmul(qfromYaw(0.5), axisAngle(1, 0, 0.3, 0.35));
    const s = structure(world, 1, vec3(-40.5, 70, 33), q, vec3(2.5, 0.5, 2.5));
    fill(s, 0, 0, 0, 5, 1, 5);
    const up = s.dirToWorld(vec3(0, 1, 0));
    // In local space the world box is tilted; its lowest corner is what sinks into the deck.
    // Put that corner 0.05 below the deck top, exactly over the shared corner of four cells.
    const h = [0.3, 0.9, 0.3];
    let ox = 0;
    let oy = 0;
    let oz = 0;
    for (let i = 0; i < 3; i++) {
      const a = s.dirToLocal(vec3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0));
      const sign = a.y > 0 ? -1 : 1;
      ox += sign * h[i]! * a.x;
      oy += sign * h[i]! * a.y;
      oz += sign * h[i]! * a.z;
    }
    const b = boxAround(s.toWorld(vec3(2 - ox, 0.95 - oy, 2 - oz)), h[0]!, h[1]!, h[2]!);
    const v = visited(s, b);
    expect(v.size).toBeGreaterThan(1);
    const p = deepestPenetration(s, b)!;
    expectVec(p, up, 9);
    expect(p.depth).toBeCloseTo(0.05, 9);
    const r = resolvePenetration(s, b);
    expect(r.resolved).toBe(true);
    expectVec({ x: r.dx, y: r.dy, z: r.dz }, vec3(up.x * 0.05, up.y * 0.05, up.z * 0.05), 9);
  });
});

// The exposed-face rule only decides the push when the box is sunk DEEPER than its
// horizontal overlap with every cell it touches (otherwise the cell ranking alone already
// picks a cell whose shallowest face is the exposed top). These cases fail if the rule is
// removed: the push would go sideways along an internal face.
describe('deepestPenetration — exposed faces only (sunk deeper than the horizontal overlap)', () => {
  it('world: player box straddling two floor cells 0.3/0.3 and sunk 0.4 is pushed UP', () => {
    const w = emptyWorld();
    fill(w, 0, 0, 0, 5, 1, 5); // floor top y = 1
    const b = box(1.7, 0.6, 2.2, 2.3, 2.4, 2.8);
    const p = deepestPenetration(w, b)!;
    expect([p.nx, p.ny, p.nz]).toEqual([0, 1, 0]);
    expect(p.depth).toBeCloseTo(0.4, 12);
    const r = resolvePenetration(w, b);
    expect(r.resolved).toBe(true);
    expect([r.dx, r.dz, r.iterations]).toEqual([0, 0, 1]);
    expect(r.dy).toBeCloseTo(0.4, 12);
  });

  it('world: item-sized box (0.25 wide) over an internal edge, sunk 0.2, is pushed UP', () => {
    const w = emptyWorld();
    fill(w, 0, 0, 0, 5, 1, 5);
    const b = box(1.9, 0.8, 2.4, 2.15, 1.05, 2.65); // overlaps cell 1 by 0.1, cell 2 by 0.15
    const p = deepestPenetration(w, b)!;
    expect([p.nx, p.ny, p.nz]).toEqual([0, 1, 0]);
    expect(p.depth).toBeCloseTo(0.2, 12);
    // Same along z, across a chunk border at negative coordinates (cells -17 | -16).
    fill(w, -20, 0, -20, -12, 1, -12);
    const bz = box(-14.3, 0.75, -16.1, -14.05, 1.0, -15.85);
    const pz = deepestPenetration(w, bz)!;
    expect([pz.nx, pz.ny, pz.nz]).toEqual([0, 1, 0]);
    expect(pz.depth).toBeCloseTo(0.25, 12);
  });

  it('yaw-rotated deck: box straddling an internal edge, sunk deeper than its overlap, is pushed along deck +Y', () => {
    const world = new World();
    const s = structure(world, 1, vec3(20.3, 64.1, -11.7), qfromYaw(0.65), vec3(2.5, 0.5, 2.5));
    fill(s, 0, 0, 0, 5, 1, 5);
    const ax = s.dirToLocal(vec3(1, 0, 0));
    const az = s.dirToLocal(vec3(0, 0, 1));
    const ex = 0.3 * Math.abs(ax.x) + 0.3 * Math.abs(az.x); // local half extent along x (~0.42)
    const b = boxWithLocalMin(s, 2 - ex, 0.5, 2.0, 0.3, 0.9, 0.3); // centred on the edge x = 2, sunk 0.5
    const up = s.dirToWorld(vec3(0, 1, 0));
    const p = deepestPenetration(s, b)!;
    expectVec(p, up, 9);
    expect(p.depth).toBeCloseTo(0.5, 9);
    const r = resolvePenetration(s, b);
    expect(r.resolved).toBe(true);
    expectVec({ x: r.dx, y: r.dy, z: r.dz }, vec3(up.x * 0.5, up.y * 0.5, up.z * 0.5), 9);
  });
});

describe('deepestPenetration — cell ranking', () => {
  it('largest TRUE overlap wins; an exact tie goes to the smaller exposed push', () => {
    // B = (5,10,0) has solid neighbours at +X (N) and +Z (A); A = (5,10,1) has B at -Z.
    // The thin box overlaps both by exactly 0.25 (dyadic: an exact tie). B's 0.25 faces are
    // internal, so its exposed push is +Y 0.75; A's +X face (0.25) is exposed.
    const w = emptyWorld();
    w.setCell(5, 10, 0, STONE); // B
    w.setCell(6, 10, 0, STONE); // N (the box does not reach it: maxX 5.875 < 6)
    w.setCell(5, 10, 1, STONE); // A
    const b = box(5.75, 10.25, 0.25, 5.875, 10.75, 1.25);
    expect(visited(w, b)).toEqual(new Set(['5,10,0', '5,10,1']));
    const p = deepestPenetration(w, b)!;
    expect([p.cx, p.cy, p.cz, p.nx, p.ny, p.nz, p.depth]).toEqual([5, 10, 1, 1, 0, 0, 0.25]);
    // Visit order must not matter: the mirrored layout (A first in y,z,x order) agrees.
    const m = emptyWorld();
    m.setCell(5, 10, 1, STONE); // B'
    m.setCell(6, 10, 1, STONE); // N'
    m.setCell(5, 10, 0, STONE); // A'
    const bm = box(5.75, 10.25, 0.75, 5.875, 10.75, 1.75); // b mirrored about z = 1
    expect(visited(m, bm)).toEqual(new Set(['5,10,0', '5,10,1']));
    const pm = deepestPenetration(m, bm)!;
    expect([pm.cx, pm.cy, pm.cz, pm.nx, pm.ny, pm.nz, pm.depth]).toEqual([5, 10, 0, 1, 0, 0, 0.25]);
  });
});

describe('deepestPenetration — corners', () => {
  it('wall + floor corner on solid ground: wall first (+X 0.05), then floor (+Y 0.03)', () => {
    const w = emptyWorld();
    fill(w, -3, -2, -3, 6, 1, 6); // ground, top at y = 1
    fill(w, 0, 1, 0, 1, 4, 5); // wall at x = 0
    const b = box(0.95, 0.97, 2.2, 1.55, 2.77, 2.8);
    const p = deepestPenetration(w, b)!;
    expect([p.nx, p.ny, p.nz]).toEqual([1, 0, 0]);
    expect(p.depth).toBeCloseTo(0.05, 12);
    const r = resolvePenetration(w, b);
    expect(r.resolved).toBe(true);
    expect(r.iterations).toBe(2);
    expect(r.dx).toBeCloseTo(0.05, 12);
    expect(r.dy).toBeCloseTo(0.03, 12);
    expect(r.dz).toBe(0);
    expect([r.nx, r.ny, r.nz]).toEqual([0, 1, 0]);
  });

  // A one-cell deck with a one-cell hull wall standing on its edge: exactly a ship's shape.
  // The deck cell under the wall is only grazed at the inner corner but its only exposed
  // faces point OUT of the hull; it must not be the cell that decides the push.
  function thinCorner(g: VoxelGrid, ox: number, oy: number, oz: number): void {
    fill(g, ox, oy, oz, ox + 6, oy + 1, oz + 6); // deck
    fill(g, ox, oy + 1, oz, ox + 1, oy + 4, oz + 6); // wall at the deck's -X edge
  }

  it('thin deck + hull wall (world): never pushed out through the hull', () => {
    const w = emptyWorld();
    thinCorner(w, 0, 50, 0);
    const b = box(0.95, 50.7, 2.2, 1.55, 52.5, 2.8); // sunk 0.3 into the deck, 0.05 into the wall
    const p = deepestPenetration(w, b)!;
    expect([p.nx, p.ny, p.nz]).toEqual([0, 1, 0]);
    expect(p.depth).toBeCloseTo(0.3, 12);
    const r = resolvePenetration(w, b);
    expect(r.resolved).toBe(true);
    expect(r.dx).toBeCloseTo(0.05, 12);
    expect(r.dy).toBeCloseTo(0.3, 12);
    // Shallow sink: the wall overlap is the larger one and goes first, still inward.
    const b2 = box(0.9, 50.98, 2.2, 1.5, 52.78, 2.8);
    const p2 = deepestPenetration(w, b2)!;
    expect([p2.nx, p2.ny, p2.nz]).toEqual([1, 0, 0]);
    expect(p2.depth).toBeCloseTo(0.1, 12);
    const r2 = resolvePenetration(w, b2);
    expect(r2.dx).toBeCloseTo(0.1, 12);
    expect(r2.dy).toBeCloseTo(0.02, 12);
  });

  it('thin deck + hull wall (rotated structure): same result in local axes', () => {
    const world = new World();
    const q = qfromYaw(2.2);
    const s = structure(world, 1, vec3(5, 60, 5), q, vec3(3, 0.5, 3));
    thinCorner(s, 0, 0, 0);
    // Local box x in [0.95, 1.55] etc.: construct the world box from its local AABB via an
    // axis-aligned check: use a yaw of exactly 90 degrees multiples for a world-aligned box.
    const s90 = structure(world, 2, vec3(5, 60, 5), qfromYaw(Math.PI / 2), vec3(3, 0.5, 3));
    thinCorner(s90, 0, 0, 0);
    const lb = { minX: 0.95, minY: 0.7, minZ: 2.2, maxX: 1.55, maxY: 2.5, maxZ: 2.8 };
    const c = s90.toWorld(vec3((lb.minX + lb.maxX) / 2, (lb.minY + lb.maxY) / 2, (lb.minZ + lb.maxZ) / 2));
    // yaw 90: local x -> world -z, local z -> world x
    const b = boxAround(c, (lb.maxZ - lb.minZ) / 2, (lb.maxY - lb.minY) / 2, (lb.maxX - lb.minX) / 2);
    const r = resolvePenetration(s90, b);
    expect(r.resolved).toBe(true);
    const local = s90.dirToLocal(vec3(r.dx, r.dy, r.dz));
    expect(local.x).toBeCloseTo(0.05, 12);
    expect(local.y).toBeCloseTo(0.3, 12);
    expect(local.z).toBeCloseTo(0, 12);
    // Arbitrary yaw: whatever the push, it never moves the box out through the wall (local -X).
    const b3 = boxWithLocalMin(s, 0.95, 0.7, 2.1, 0.3, 0.9, 0.3);
    const r3 = resolvePenetration(s, b3);
    expect(r3.resolved).toBe(true);
    expect(s.dirToLocal(vec3(r3.dx, r3.dy, r3.dz)).x).toBeGreaterThan(-1e-9);
  });
});

describe('deepestPenetration — prefer bias, embedding, iteration cap', () => {
  const w = emptyWorld();
  w.setCell(0, 50, 0, STONE); // isolated block: every face exposed
  // depths: +X 0.4, -X 1.4, +Y 0.3, -Y 2.5, +Z 0.9, -Z 0.9
  const b = box(0.6, 50.7, 0.1, 1.4, 52.5, 0.9);

  it('without bias picks the shallowest face', () => {
    const p = deepestPenetration(w, b)!;
    expect([p.nx, p.ny, p.nz, p.cx, p.cy, p.cz]).toEqual([0, 1, 0, 0, 50, 0]);
    expect(p.depth).toBeCloseTo(0.3, 12);
  });

  it('bias changes the direction but the TRUE depth is reported', () => {
    const p = deepestPenetration(w, b, { prefer: vec3(1, 0, 0), preferWeight: 0.5 })!;
    expect([p.nx, p.ny, p.nz]).toEqual([1, 0, 0]);
    expect(p.depth).toBeCloseTo(0.4, 12);
    const weak = deepestPenetration(w, b, { prefer: vec3(1, 0, 0), preferWeight: 0.05 })!;
    expect([weak.nx, weak.ny, weak.nz]).toEqual([0, 1, 0]);
    expect(DEFAULT_PREFER_WEIGHT).toBeGreaterThan(0.1);
    const def = deepestPenetration(w, b, { prefer: vec3(1, 0, 0) })!;
    expect([def.nx, def.depth]).toEqual([1, def.depth]);
    expect(def.depth).toBeCloseTo(0.4, 12);
    const r = resolvePenetration(w, b, 6, { prefer: vec3(1, 0, 0), preferWeight: 0.5 });
    expect(r.resolved).toBe(true);
    expect(r.dx).toBeCloseTo(0.4, 12);
    expect(r.dy).toBe(0);
  });

  it('bias works in world space on a rotated structure', () => {
    const world = new World();
    const s = structure(world, 1, vec3(0, 50, 0), qfromYaw(Math.PI / 2), vec3(0.5, 0.5, 0.5));
    s.setCell(0, 0, 0, STONE);
    // Cell occupies world [-0.5,0.5]^3 + (0,50,0). Box overlaps its +X world side by 0.4.
    const bb = box(0.1, 49.8, -0.3, 0.9, 51.4, 0.3);
    // World depths: +X 0.4, -X 1.4, +Y 0.7, -Y 1.9, +Z 0.8, -Z 0.8.
    const plain = deepestPenetration(s, bb)!;
    expectVec(plain, vec3(1, 0, 0), 12);
    expect(plain.depth).toBeCloseTo(0.4, 9);
    const pZ = deepestPenetration(s, bb, { prefer: vec3(0, 0, 1), preferWeight: 1 })!;
    expectVec(pZ, vec3(0, 0, 1), 12);
    expect(pZ.depth).toBeCloseTo(0.8, 9); // must travel from z=-0.3 to the face at z=0.5
  });

  it('fully embedded: null push, still overlapping, resolve reports failure', () => {
    const g = emptyWorld();
    fill(g, 0, 50, 0, 3, 53, 3);
    const inner = box(1.3, 51.3, 1.3, 1.7, 51.7, 1.7);
    expect(boxOverlapsSolid(g, inner)).toBe(true);
    expect(deepestPenetration(g, inner)).toBeNull();
    const r = resolvePenetration(g, inner);
    expect([r.resolved, r.iterations, r.dx, r.dy, r.dz]).toEqual([false, 0, 0, 0, 0]);
  });

  it('fully embedded in a rotated structure: null push, resolve reports failure', () => {
    const world = new World();
    const s = structure(world, 1, vec3(10.2, 40, -3.7), qfromYaw(0.4), vec3(1.5, 1.5, 1.5));
    fill(s, 0, 0, 0, 3, 3, 3);
    const inner = boxAround(s.toWorld(vec3(1.5, 1.5, 1.5)), 0.15, 0.15, 0.15);
    expect(boxOverlapsSolid(s, inner)).toBe(true);
    expect(deepestPenetration(s, inner)).toBeNull();
    const r = resolvePenetration(s, inner);
    expect([r.resolved, r.iterations, r.dx, r.dy, r.dz]).toEqual([false, 0, 0, 0, 0]);
  });

  it('free box: null push, resolved without moving', () => {
    const r = resolvePenetration(w, box(3, 3, 3, 4, 4, 4));
    expect([r.resolved, r.iterations, r.dx, r.dy, r.dz, r.nx, r.ny, r.nz]).toEqual([true, 0, 0, 0, 0, 0, 0, 0]);
    expect(deepestPenetration(w, box(3, 3, 3, 4, 4, 4))).toBeNull();
  });

  it('squeezed between floor and ceiling: the push cycle is detected and reported unresolved', () => {
    const g = emptyWorld();
    fill(g, -5, 49, -5, 5, 50, 5); // floor top 50
    fill(g, -5, 51, -5, 5, 52, 5); // ceiling bottom 51
    const tall = box(0.2, 49.9, 0.2, 0.8, 51.7, 0.8);
    // Ceiling first (overlap 0.7): down 0.7; then the floor (0.8): up 0.8. The next push (down
    // 0.8) would return the box to where the previous push started: stop instead of looping.
    const r = resolvePenetration(g, tall);
    expect([r.resolved, r.iterations, r.nx, r.ny, r.nz]).toEqual([false, 2, 0, 1, 0]);
    expect(r.dy).toBeCloseTo(0.1, 12);
    // The cap applies first when it is smaller.
    const r1 = resolvePenetration(g, tall, 1);
    expect([r1.resolved, r1.iterations]).toEqual([false, 1]);
    expect(r1.dy).toBeCloseTo(-0.7, 12);
    const r0 = resolvePenetration(g, tall, 0);
    expect([r0.resolved, r0.iterations, r0.dx, r0.dy, r0.dz]).toEqual([false, 0, 0, 0, 0]);
  });

  it('a tall box wedged between two staggered cells stops after one back-and-forth (world and rotated structure)', () => {
    // A = (0,10,0) and B = (0,11,1) touch along an edge; the box overlaps both by 0.25 in z.
    // Clearing either pushes the box into the other: +Z 0.25, -Z 0.5, then +Z 0.5 would
    // repeat the state after the first push.
    const g = emptyWorld();
    g.setCell(0, 10, 0, STONE);
    g.setCell(0, 11, 1, STONE);
    const b = box(0.25, 10.25, 0.75, 0.75, 12, 1.25);
    const r = resolvePenetration(g, b, 50);
    expect([r.resolved, r.iterations, r.dx, r.dy, r.dz, r.nz]).toEqual([false, 2, 0, 0, -0.25, -1]);
    // The fallback finds the nearest free spot.
    const off = nearestFreeOffset([g], b, 2)!;
    expect(boxOverlapsSolid(g, aabbTranslate(b, off.x, off.y, off.z))).toBe(false);

    const world = new World();
    const s = structure(world, 1, vec3(4.2, 30, -8.6), qfromYaw(0.3), vec3(0.5, 0.5, 0.5));
    s.setCell(0, 10, 0, STONE);
    s.setCell(0, 11, 1, STONE);
    const sb = boxWithLocalMin(s, 0.1, 10.2, 0.6, 0.15, 0.85, 0.15);
    const rs = resolvePenetration(s, sb, 50);
    expect(rs.resolved).toBe(false);
    expect(rs.iterations).toBe(2);
    const local = s.dirToLocal(vec3(rs.nx, rs.ny, rs.nz));
    expect(Math.abs(local.z)).toBeCloseTo(1, 9); // the pushes alternate along local z
  });

  it('maxIterations: honoured, NaN or negative means 0, huge values are capped', () => {
    const g = emptyWorld();
    fill(g, -3, -2, -3, 6, 1, 6); // ground, top at y = 1
    fill(g, 0, 1, 0, 1, 4, 5); // wall at x = 0
    const b = box(0.95, 0.97, 2.2, 1.55, 2.77, 2.8); // needs two pushes: wall, then floor
    expect([resolvePenetration(g, b, 1).resolved, resolvePenetration(g, b, 1).iterations]).toEqual([false, 1]);
    expect([resolvePenetration(g, b, 2).resolved, resolvePenetration(g, b, 2).iterations]).toEqual([true, 2]);
    expect([resolvePenetration(g, b, 2.9).resolved, resolvePenetration(g, b, 2.9).iterations]).toEqual([true, 2]);
    for (const cap of [NaN, -1, -Infinity]) {
      const r = resolvePenetration(g, b, cap);
      expect([r.resolved, r.iterations, r.dx, r.dy, r.dz]).toEqual([false, 0, 0, 0, 0]);
    }
    const inf = resolvePenetration(g, b, Infinity);
    expect([inf.resolved, inf.iterations]).toEqual([true, 2]);
    expect(MAX_RESOLVE_ITERATIONS).toBeGreaterThanOrEqual(6);
  });

  it('never mutates the input box', () => {
    const g = emptyWorld();
    fill(g, 0, 0, 0, 5, 1, 5);
    const b0 = box(0.41, 0.95, 2.2, 1.01, 2.75, 2.8);
    const copy = aabbClone(b0);
    resolvePenetration(g, b0);
    deepestPenetration(g, b0);
    expect(b0).toEqual(copy);
  });
});

// ====================================================================== sweep

describe('sweepAxis', () => {
  it('throws for structures', () => {
    const world = new World();
    const s = structure(world, 1, vec3(0, 0, 0), qidentity());
    expect(() => sweepAxis(s, box(0, 0, 0, 1, 1, 1), 1, -1)).toThrow();
  });

  it('fast fall lands exactly on the floor without tunnelling', () => {
    const w = emptyWorld();
    fill(w, -3, 4, -3, 3, 5, 3); // floor top at y = 5
    const b = box(-0.3, 30.3, -0.3, 0.3, 32.1, 0.3);
    const d = sweepAxis(w, b, 1, -100);
    expect(d).toBeCloseTo(-25.3, 12);
    const moved = aabbTranslate(b, 0, d, 0);
    expect(Math.abs(moved.minY - 5)).toBeLessThan(1e-9);
    expect(boxOverlapsSolid(w, moved)).toBe(false);
    expect(boxOverlapsSolid(w, aabbTranslate(moved, 0, -1e-7, 0))).toBe(true);
    // A thin wall stops a fast horizontal move too.
    w.setCell(20, 10, 0, STONE);
    const hb = box(0.2, 10.1, 0.1, 0.8, 10.9, 0.9);
    expect(sweepAxis(w, hb, 0, 50)).toBeCloseTo(19.2, 12);
  });

  it('negative coordinates in every direction', () => {
    const w = emptyWorld();
    w.setCell(-20, 10, -5, STONE);
    w.setCell(-9, 10, -5, STONE);
    w.setCell(-14, 3, -5, STONE);
    w.setCell(-14, 15, -5, STONE);
    w.setCell(-14, 10, -17, STONE);
    w.setCell(-14, 10, 6, STONE);
    const b = box(-14.4, 10.2, -4.7, -13.6, 10.8, -4.1);
    expect(sweepAxis(w, b, 0, -30)).toBeCloseTo(-19 + 14.4, 12); // face at x = -19
    expect(sweepAxis(w, b, 0, 30)).toBeCloseTo(-9 + 13.6, 12);
    // The x columns do not line up with the obstacles in y/z: those are at x = -14.
    const c = box(-13.9, 10.2, -4.7, -13.1, 10.8, -4.1);
    expect(sweepAxis(w, c, 1, -30)).toBeCloseTo(4 - 10.2, 12);
    expect(sweepAxis(w, c, 1, 30)).toBeCloseTo(15 - 10.8, 12);
    expect(sweepAxis(w, c, 2, -30)).toBeCloseTo(-16 + 4.7, 12);
    expect(sweepAxis(w, c, 2, 30)).toBeCloseTo(6 + 4.1, 12);
  });

  it('cells already overlapped are ignored: a box can always move out', () => {
    const w = emptyWorld();
    w.setCell(0, 10, 0, STONE);
    w.setCell(1, 10, 0, STONE);
    const b = box(0.2, 10.2, 0.2, 0.8, 10.8, 0.8); // inside (0,10,0)
    expect(sweepAxis(w, b, 0, -3)).toBe(-3);
    expect(sweepAxis(w, b, 1, 3)).toBe(3);
    // ... but not into a NEW solid cell.
    expect(sweepAxis(w, b, 0, 3)).toBeCloseTo(0.2, 12);
    // Touching ahead: zero.
    expect(sweepAxis(w, box(-1, 10.2, 0.2, 0, 10.8, 0.8), 0, 1)).toBe(0);
    // Sliding along a wall it touches is not blocked by that wall.
    expect(sweepAxis(w, box(-1, 10.2, 1, 0.9, 10.8, 1.6), 2, -5)).toBeCloseTo(-0, 12);
    expect(sweepAxis(w, box(-1, 10.2, 1, 0.9, 10.8, 1.6), 1, 5)).toBe(5);
  });

  it('wide boxes are blocked by any cell of their cross-section', () => {
    const w = emptyWorld();
    w.setCell(4, 20, 2, STONE);
    const b = box(-1.5, 22.5, -0.5, 4.2, 23.5, 2.1); // spans 7 x 4 columns
    expect(sweepAxis(w, b, 1, -10)).toBeCloseTo(21 - 22.5, 12);
    expect(sweepAxis(w, box(-1.5, 22.5, -0.5, 4.0, 23.5, 2.1), 1, -10)).toBeCloseTo(-10, 12); // touching column x=4 only
  });

  it('world limits: deeprock below, air above, unloaded chunks block', () => {
    const w = emptyWorld(0, 0);
    const b = box(2.2, 3.5, 2.2, 2.8, 5.3, 2.8);
    expect(sweepAxis(w, b, 1, -50)).toBeCloseTo(-3.5, 12);
    expect(sweepAxis(w, b, 1, 500)).toBe(500);
    expect(sweepAxis(w, b, 0, 100)).toBeCloseTo(16 - 2.8, 12);
    expect(sweepAxis(w, b, 2, -100)).toBeCloseTo(-2.2, 12);
    expect(sweepAxis(w, box(2.2, 300, 2.2, 2.8, 301, 2.8), 0, 1e6)).toBe(1e6); // above the world: free
    expect(sweepAxis(w, box(2.2, 300, 2.2, 2.8, 301, 2.8), 1, -400)).toBeCloseTo(-300, 12);
    expect(sweepAxis(w, b, 1, 0)).toBe(0);
    expect(sweepAxis(w, b, 1, NaN)).toBe(0);
  });

  it('matches a brute-force swept-volume check on random fields', () => {
    const rng = new Rng(31337);
    const w = emptyWorld();
    for (let i = 0; i < 900; i++) w.setCell(rng.int(-14, 13), rng.int(30, 45), rng.int(-14, 13), STONE);
    let blocked = 0;
    for (let i = 0; i < 1200; i++) {
      const hx = rng.range(0.1, 1.6);
      const hy = rng.range(0.1, 1.6);
      const hz = rng.range(0.1, 1.6);
      const c = vec3(rng.range(-10, 10), rng.range(33, 42), rng.range(-10, 10));
      const b = boxAround(c, hx, hy, hz);
      const axis = rng.int(0, 2) as 0 | 1 | 2;
      const delta = rng.range(-7, 7);
      const r = sweepAxis(w, b, axis, delta);
      expect(r * delta).toBeGreaterThanOrEqual(0);
      expect(Math.abs(r)).toBeLessThanOrEqual(Math.abs(delta));
      const before = visited(w, b);
      const off = (v: number): [number, number, number] => (axis === 0 ? [v, 0, 0] : axis === 1 ? [0, v, 0] : [0, 0, v]);
      // Swept volume between start and end must not contain any NEW solid cell (no tunnelling).
      const end = aabbTranslate(b, ...off(r));
      const swept = box(
        Math.min(b.minX, end.minX),
        Math.min(b.minY, end.minY),
        Math.min(b.minZ, end.minZ),
        Math.max(b.maxX, end.maxX),
        Math.max(b.maxY, end.maxY),
        Math.max(b.maxZ, end.maxZ),
      );
      for (const k of visited(w, swept)) expect(before.has(k)).toBe(true);
      if (Math.abs(r) < Math.abs(delta)) {
        blocked++;
        const further = aabbTranslate(b, ...off(r + Math.sign(delta) * 1e-7));
        const after = visited(w, further);
        expect([...after].some((k) => !before.has(k))).toBe(true);
      }
    }
    expect(blocked).toBeGreaterThan(300);
  });
});

// ====================================================================== support

describe('supportProbe / hasSupportBelow / columnHasSolidBelow', () => {
  it('probe geometry, inset clamping and aliasing', () => {
    const b = box(1, 5, 2, 2, 6.8, 3);
    expect(supportProbe(b, 0.1, 0)).toEqual(box(1, 4.9, 2, 2, 5, 3));
    expect(supportProbe(b, 0.1, 0.2)).toEqual(box(1.2, 4.9, 2.2, 1.8, 5, 2.8));
    expect(supportProbe(b, 0.1, 0.7)).toEqual(box(1.5, 4.9, 2.5, 1.5, 5, 2.5));
    const out = box(0, 0, 0, 0, 0, 0);
    expect(supportProbe(b, 0.1, 0.2, out)).toBe(out);
    const alias = aabbClone(b);
    supportProbe(alias, 0.1, 0.2, alias);
    expect(alias).toEqual(box(1.2, 4.9, 2.2, 1.8, 5, 2.8));
  });

  it('standing on the world, gaps, ledges, inset', () => {
    const w = emptyWorld();
    fill(w, 0, 0, 0, 5, 1, 5); // top at y = 1
    expect(hasSupportBelow(w, box(2, 1, 2, 2.6, 2.8, 2.6), 0.05)).toBe(true);
    expect(hasSupportBelow(w, box(2, 1.04, 2, 2.6, 2.84, 2.6), 0.05)).toBe(true);
    expect(hasSupportBelow(w, box(2, 1.06, 2, 2.6, 2.86, 2.6), 0.05)).toBe(false);
    expect(hasSupportBelow(w, box(2, 1, 2, 2.6, 2.8, 2.6), 0)).toBe(false); // zero-height probe only touches
    // Overhanging the floor edge by all but 0.1: standing yes, attaching (inset 0.15) no.
    const ledge = box(4.9, 1, 2, 5.5, 2.8, 2.6);
    expect(hasSupportBelow(w, ledge, 0.05)).toBe(true);
    expect(hasSupportBelow(w, ledge, 0.05, 0.15)).toBe(false);
    expect(hasSupportBelow(w, ledge, 0.05, 0.09)).toBe(true);
    // Equivalence with the explicit probe.
    expect(boxOverlapsSolid(w, supportProbe(ledge, 0.05, 0.09))).toBe(true);
  });

  it('attach (inset > 0) is strictly inside stand (inset 0), on world and rotated decks', () => {
    const rng = new Rng(5);
    const world = emptyWorld();
    fill(world, -4, 20, -4, 4, 21, 4);
    const deck = structure(world, 1, vec3(30, 40, 30), axisAngle(0.2, 1, -0.1, 0.8), vec3(0, 0.5, 0));
    fill(deck, -4, 0, -4, 4, 1, 4);
    let stand = 0;
    let attach = 0;
    for (const g of [world as VoxelGrid, deck]) {
      const centre = g.isWorld ? vec3(0, 21, 0) : deck.toWorld(vec3(0, 1, 0));
      for (let i = 0; i < 1500; i++) {
        const c = vec3(centre.x + rng.range(-5.5, 5.5), centre.y + rng.range(-0.3, 1.2), centre.z + rng.range(-5.5, 5.5));
        const b = box(c.x - 0.3, c.y, c.z - 0.3, c.x + 0.3, c.y + 1.8, c.z + 0.3);
        const s0 = hasSupportBelow(g, b, 0.1);
        const s1 = hasSupportBelow(g, b, 0.1, 0.1);
        if (s1) expect(s0).toBe(true);
        expect(s0).toBe(boxOverlapsSolid(g, supportProbe(b, 0.1, 0)));
        expect(s1).toBe(boxOverlapsSolid(g, supportProbe(b, 0.1, 0.1)));
        if (s0) stand++;
        if (s1) attach++;
      }
    }
    expect(stand).toBeGreaterThan(attach);
    expect(attach).toBeGreaterThan(100);
  });

  it('rotated deck: standing over the deck vs over the corner cut-off', () => {
    const world = new World();
    const deck = structure(world, 1, vec3(0, 60, 0), qfromYaw(Math.PI / 4), vec3(0, 0.5, 0));
    fill(deck, -2, 0, -2, 2, 1, 2); // 4x4 deck rotated 45 degrees: a diamond in world xz
    const top = deck.toWorld(vec3(0, 1, 0)).y; // 60.5
    expect(hasSupportBelow(deck, box(-0.3, top, -0.3, 0.3, top + 1.8, 0.3), 0.05)).toBe(true);
    // World point (2.5, z=0) is inside the diamond (half-diagonal 2.83); (2.2, 2.2) is outside.
    expect(hasSupportBelow(deck, box(2.2, top, -0.3, 2.6, top + 1.8, 0.3), 0.05)).toBe(true);
    expect(hasSupportBelow(deck, box(2.0, top, 2.0, 2.4, top + 1.8, 2.4), 0.05)).toBe(false);
  });

  it('columnHasSolidBelow: the whole column under the footprint, along world down', () => {
    const world = new World();
    const ship = structure(world, 1, vec3(0, 60, 0), axisAngle(1, 0, 0, 0.2), vec3(0, 0.5, 0));
    fill(ship, -3, 0, -3, 3, 1, 3);
    const deckTop = ship.toWorld(vec3(0, 1, 0)).y;
    const jumper = box(-0.3, deckTop + 2.5, -0.3, 0.3, deckTop + 4.3, 0.3);
    expect(hasSupportBelow(ship, jumper, 0.05)).toBe(false);
    expect(columnHasSolidBelow(ship, jumper, 4)).toBe(true);
    expect(columnHasSolidBelow(ship, jumper, 2)).toBe(false);
    const overboard = aabbTranslate(jumper, 4.5, 0, 0);
    expect(columnHasSolidBelow(ship, overboard, 10)).toBe(false);
    // Inset shrinks the footprint like the attach test.
    const edge = aabbTranslate(jumper, 3.2, 0, 0); // footprint overlaps the deck edge (x = 3) by 0.1
    expect(columnHasSolidBelow(ship, edge, 10)).toBe(true);
    expect(columnHasSolidBelow(ship, edge, 10, 0.3)).toBe(false);
    // World grid works too.
    const w = emptyWorld();
    fill(w, 0, 10, 0, 1, 11, 1);
    expect(columnHasSolidBelow(w, box(0.2, 15, 0.2, 0.8, 16.8, 0.8), 5)).toBe(true);
    expect(columnHasSolidBelow(w, box(0.2, 15, 0.2, 0.8, 16.8, 0.8), 3.9)).toBe(false);
  });
});

// ====================================================================== free spot

describe('nearestFreeOffset', () => {
  it('already free: (0,0,0), extraTest sees the untranslated box', () => {
    const w = emptyWorld();
    const b = box(0.2, 10, 0.2, 0.8, 11.8, 0.8);
    const seen: AABB[] = [];
    const r = nearestFreeOffset([w], b, 2, (c) => (seen.push(aabbClone(c)), true))!;
    expect([r.x, r.y, r.z]).toEqual([0, 0, 0]);
    expect(seen).toEqual([b]);
  });

  it('sunk 0.3 into the floor: lifted by the smallest lattice step that clears it', () => {
    const w = emptyWorld();
    fill(w, -5, 0, -5, 5, 1, 5);
    const r = nearestFreeOffset([w], box(0.2, 0.7, 0.2, 0.8, 2.5, 0.8), 2)!;
    expect([r.x, r.y, r.z]).toEqual([0, 0.5, 0]);
  });

  it('enumerates candidates in non-decreasing 3D length, each lattice point exactly once', () => {
    const w = emptyWorld();
    const b = box(0.2, 10, 0.2, 0.8, 11.8, 0.8);
    const lens: number[] = [];
    const keys = new Set<string>();
    const order: Array<[number, number, number]> = [];
    expect(
      nearestFreeOffset([w], b, 1, (c) => {
        const o: [number, number, number] = [c.minX - b.minX, c.minY - b.minY, c.minZ - b.minZ];
        order.push(o);
        lens.push(Math.hypot(...o));
        keys.add(o.map((v) => Math.round(v / FREE_OFFSET_STEP)).join(','));
        return false;
      }),
    ).toBeNull();
    let expected = 0;
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) for (let k = -4; k <= 4; k++) if (i * i + j * j + k * k <= 16) expected++;
    expect(lens.length).toBe(expected);
    expect(keys.size).toBe(expected);
    for (let i = 1; i < lens.length; i++) expect(lens[i]!).toBeGreaterThanOrEqual(lens[i - 1]! - 1e-12);
    // Ties: up before sideways before down.
    expect(order.slice(1, 7).map((o) => o.map((v) => Math.round(v * 4)).join(','))).toEqual(['0,1,0', '-1,0,0', '0,0,-1', '0,0,1', '1,0,0', '0,-1,0']);
  });

  it('prefers the shortest 3D offset and is deterministic', () => {
    const w = emptyWorld();
    fill(w, -6, 30, -6, 6, 36, 6); // big solid block, top at y = 36
    fill(w, 0, 30, -6, 6, 36, 6, makeCell(B.AIR)); // carve: free half-space x >= 0 below 36
    // Box straddles the wall plane x = 0, inside the block at x < 0 by 0.35.
    const b = box(-0.35, 32, 0.2, 0.25, 33.8, 0.8);
    const r1 = nearestFreeOffset([w], b, 3)!;
    const r2 = nearestFreeOffset([w], b, 3)!;
    expect(r1).toEqual(r2);
    expect([r1.x, r1.y, r1.z]).toEqual([0.5, 0, 0]);
  });

  it('a structure the box only touches before the move is still avoided', () => {
    // Structures out of reach are skipped up front; "in reach" must mean within maxRadius of
    // the box, not "already overlapping".
    const world = emptyWorld();
    fill(world, -5, 0, -5, 5, 1, 5); // floor top y = 1
    const lid = structure(world, 1, vec3(0, 0, 0), qidentity());
    fill(lid, -1, 2, -1, 1, 3, 1); // slab directly above the box, occupying y in [2, 3)
    const b = box(-0.3, 0.7, -0.3, 0.3, 2.0, 0.3); // sunk 0.3 into the floor, head touching the slab
    expect(boxOverlapsSolid(lid, b)).toBe(false);
    const r = nearestFreeOffset([world, lid], b, 3)!;
    const moved = aabbTranslate(b, r.x, r.y, r.z);
    expect(boxOverlapsSolid(world, moved)).toBe(false);
    expect(boxOverlapsSolid(lid, moved)).toBe(false);
    // Lifting 0.5 clears the floor but would hit the slab, so the box must also leave the
    // slab's footprint (|x| or |z| >= 1.3): the nearest lattice answer is 1.5 sideways.
    expect(r.y).toBe(0.5);
    expect(Math.max(Math.abs(r.x), Math.abs(r.z))).toBe(1.5);
  });

  it('considers every grid and the extra test; null when nothing within reach', () => {
    const world = emptyWorld();
    fill(world, -5, 0, -5, 5, 1, 5); // floor
    const ship = structure(world, 1, vec3(0, 0, 0), qidentity());
    fill(ship, -5, 1, -5, 5, 4, 0); // a block of structure occupying z < 0 above the floor
    const b = box(-0.3, 0.9, -0.2, 0.3, 2.7, 0.4); // sunk into the floor and the ship
    const grids: VoxelGrid[] = [world, ship];
    const r = nearestFreeOffset(grids, b, 3)!;
    const moved = aabbTranslate(b, r.x, r.y, r.z);
    expect(boxOverlapsSolid(world, moved)).toBe(false);
    expect(boxOverlapsSolid(ship, moved)).toBe(false);
    expect(Math.hypot(r.x, r.y, r.z)).toBeLessThanOrEqual(3);
    expect([r.x, r.y, r.z]).toEqual([0, 0.25, 0.25]); // clears the floor (0.1) and the ship (0.2)
    // The extra test is honoured: reject the best answer and the next best is returned.
    const r2 = nearestFreeOffset(grids, b, 3, (c) => !(c.minY === b.minY + 0.25 && c.minZ === b.minZ + 0.25 && c.minX === b.minX))!;
    expect([r2.x, r2.y, r2.z]).toEqual([-0.25, 0.25, 0.25]);
    expect(boxOverlapsSolid(ship, aabbTranslate(b, r2.x, r2.y, r2.z))).toBe(false);
    // Enclosed deep inside solid: nothing within radius 1.
    const g = emptyWorld();
    fill(g, -6, 40, -6, 6, 52, 6);
    expect(nearestFreeOffset([g], box(-0.3, 45, -0.3, 0.3, 46.8, 0.3), 1)).toBeNull();
    // A structure far away is ignored entirely; rotated structures are handled.
    const s2 = structure(world, 2, vec3(2, 2, 2), axisAngle(1, 1, 1, 0.7));
    fill(s2, -1, -1, -1, 1, 1, 1);
    const b3 = boxAround(vec3(2, 2, 2), 0.3, 0.9, 0.3);
    const r3 = nearestFreeOffset([s2], b3, 3)!;
    expect(boxOverlapsSolid(s2, aabbTranslate(b3, r3.x, r3.y, r3.z))).toBe(false);
    expect(boxOverlapsSolid(s2, aabbTranslate(b3, r3.x * 0.5, r3.y * 0.5, r3.z * 0.5))).toBe(true);
  });
});

// ====================================================================== cross-path consistency

describe('world fast path, aligned structure path and SAT path agree', () => {
  it('same voxels in the world, an identity-pose structure and a near-identity (SAT) structure', () => {
    const rng = new Rng(77);
    const w = emptyWorld();
    const world = new World();
    const ident = structure(world, 1, vec3(0, 0, 0), qidentity());
    // A rotation of 1e-9 rad is far from axis-aligned for ALIGN_TOL (1e-12), so this grid
    // goes through the full 15-axis SAT, yet geometrically matches the others to ~1e-8.
    const tilt = structure(world, 2, vec3(0, 0, 0), axisAngle(0.3, 1, -0.2, 1e-9));
    for (let i = 0; i < 500; i++) {
      const x = rng.int(-6, 5);
      const y = rng.int(60, 67);
      const z = rng.int(-6, 5);
      for (const g of [w, ident, tilt] as VoxelGrid[]) g.setCell(x, y, z, STONE);
    }
    const near = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-6;
    let compared = 0;
    for (let i = 0; i < 600; i++) {
      const c = vec3(rng.range(-6, 6), rng.range(59, 69), rng.range(-6, 6));
      const b = boxAround(c, rng.range(0.1, 1.2), rng.range(0.1, 1.2), rng.range(0.1, 1.2));
      if ([b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ].some(near)) continue;
      compared++;
      const ref = visited(w, b);
      expect(visited(ident, b)).toEqual(ref);
      expect(visited(tilt, b)).toEqual(ref);
      expect(boxOverlapsSolid(ident, b)).toBe(ref.size > 0);
      expect(boxOverlapsSolid(tilt, b)).toBe(ref.size > 0);
      const pw = deepestPenetration(w, b);
      const pi = deepestPenetration(ident, b);
      const pt = deepestPenetration(tilt, b);
      // The structure path works from centre +- half extents, so depths may differ in the
      // last bits from the world path's direct min/max.
      if (pw === null) {
        expect(pi).toBeNull();
        expect(pt).toBeNull();
      } else {
        for (const p of [pi!, pt!]) {
          expect([p.cx, p.cy, p.cz]).toEqual([pw.cx, pw.cy, pw.cz]);
          expectVec(p, vec3(pw.nx, pw.ny, pw.nz), 6);
          expect(p.depth).toBeCloseTo(pw.depth, 6);
        }
        expect([pi!.nx, pi!.ny, pi!.nz]).toEqual([pw.nx, pw.ny, pw.nz]); // snapped: exact
      }
      expect(hasSupportBelow(ident, b, 0.3, 0.1)).toBe(hasSupportBelow(w, b, 0.3, 0.1));
      const rw = resolvePenetration(w, b);
      const ri = resolvePenetration(ident, b);
      expect([ri.resolved, ri.iterations, ri.nx, ri.ny, ri.nz]).toEqual([rw.resolved, rw.iterations, rw.nx, rw.ny, rw.nz]);
      expectVec({ x: ri.dx, y: ri.dy, z: ri.dz }, vec3(rw.dx, rw.dy, rw.dz), 9);
    }
    expect(compared).toBeGreaterThan(500);
  });
});

// ====================================================================== world scans vs getCell

/**
 * A world grid that is not a World instance: shape.ts can then only read it through getCell,
 * which makes it an independent reference for the World fast paths (they index chunk arrays
 * directly and re-implement getCell's rules for deeprock, unloaded chunks and the build limit).
 */
class ProxyWorld implements VoxelGrid {
  readonly gridId = 0;
  readonly parent = null;
  readonly isWorld = true;
  constructor(private readonly w: World) {}
  getCell(x: number, y: number, z: number): number {
    return this.w.getCell(x, y, z);
  }
  getPart2(x: number, y: number, z: number): number {
    return this.w.getPart2(x, y, z);
  }
  setCell(x: number, y: number, z: number, cell: number, flags?: number): boolean {
    return this.w.setCell(x, y, z, cell, flags);
  }
  toWorld(p: Vec3, out?: Vec3): Vec3 {
    return this.w.toWorld(p, out);
  }
  toLocal(p: Vec3, out?: Vec3): Vec3 {
    return this.w.toLocal(p, out);
  }
  dirToWorld(d: Vec3, out?: Vec3): Vec3 {
    return this.w.dirToWorld(d, out);
  }
  dirToLocal(d: Vec3, out?: Vec3): Vec3 {
    return this.w.dirToLocal(d, out);
  }
  velocityAt(p: Vec3, out?: Vec3): Vec3 {
    return this.w.velocityAt(p, out);
  }
  worldRotation(out?: Quat): Quat {
    return this.w.worldRotation(out);
  }
  cellBounds(): null {
    return null;
  }
}

describe('World direct chunk scans agree with getCell semantics', () => {
  it('random boxes and sweeps across chunk borders, into unloaded chunks, deeprock and the build limit', () => {
    const rng = new Rng(9001);
    const w = emptyWorld(-1, 0); // x, z in [-16, 16); every other column is unloaded (solid)
    for (let i = 0; i < 1500; i++) w.setCell(rng.int(-16, 15), rng.int(0, 127), rng.int(-16, 15), STONE);
    for (let i = 0; i < 700; i++) w.setCell(rng.int(-16, 15), rng.int(0, 4), rng.int(-16, 15), STONE);
    for (let i = 0; i < 700; i++) w.setCell(rng.int(-16, 15), rng.int(123, 127), rng.int(-16, 15), STONE);
    const p = new ProxyWorld(w);
    let overlaps = 0;
    let blocked = 0;
    for (let i = 0; i < 2500; i++) {
      const band = i % 3;
      const cy = band === 0 ? rng.range(-2, 7) : band === 1 ? rng.range(121, 131) : rng.range(0, 128);
      const c = vec3(rng.range(-19, 19), cy, rng.range(-19, 19));
      const b = boxAround(c, rng.range(0.05, 1.4), rng.range(0.05, 1.4), rng.range(0.05, 1.4));
      const o = boxOverlapsSolid(w, b);
      expect(o).toBe(boxOverlapsSolid(p, b));
      expect(o).toBe(visited(w, b).size > 0); // forEachSolidCellOverlapping reads via getCell
      if (o) overlaps++;
      const gap = rng.range(0.01, 3);
      const inset = rng.range(0, 0.4);
      expect(hasSupportBelow(w, b, gap, inset)).toBe(hasSupportBelow(p, b, gap, inset));
      expect(columnHasSolidBelow(w, b, gap * 3, inset)).toBe(columnHasSolidBelow(p, b, gap * 3, inset));
      const axis = rng.int(0, 2) as 0 | 1 | 2;
      const delta = rng.range(-40, 40);
      const r = sweepAxis(w, b, axis, delta);
      expect(r).toBe(sweepAxis(p, b, axis, delta));
      // Independent swept-volume check through getCell: no NEW solid cell is entered.
      const off = (v: number): [number, number, number] => (axis === 0 ? [v, 0, 0] : axis === 1 ? [0, v, 0] : [0, 0, v]);
      const before = visited(w, b);
      const end = aabbTranslate(b, ...off(r));
      const swept = box(
        Math.min(b.minX, end.minX),
        Math.min(b.minY, end.minY),
        Math.min(b.minZ, end.minZ),
        Math.max(b.maxX, end.maxX),
        Math.max(b.maxY, end.maxY),
        Math.max(b.maxZ, end.maxZ),
      );
      for (const k of visited(w, swept)) expect(before.has(k)).toBe(true);
      if (Math.abs(r) < Math.abs(delta)) {
        blocked++;
        const further = visited(w, aabbTranslate(b, ...off(r + Math.sign(delta) * 1e-7)));
        expect([...further].some((k) => !before.has(k))).toBe(true);
      }
    }
    expect(overlaps).toBeGreaterThan(300);
    expect(blocked).toBeGreaterThan(1000);
  });
});
