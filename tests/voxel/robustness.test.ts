/**
 * Garbage-in robustness of the box queries (shape.ts) and rays (raycast.ts).
 *
 * A box with a coordinate at -Infinity used to freeze the World-path queries for good: the
 * candidate range started at Math.floor(-Infinity), `x++` never advanced it, and
 * World.getCell(-Infinity, ...) aliased onto loaded chunk 0, whose air never ended the scan.
 * Any magnitude >= 2^53 stalls a loop counter the same way. Invalid boxes are now EMPTY for
 * every query (documented in shape.ts).
 *
 * The world below throws once a query has read more cells or chunks than any player-sized
 * query could need, so a regression FAILS FAST here instead of hanging the test run.
 */
import { describe, expect, it } from 'vitest';
import { aabb, qfromYaw, vec3, type AABB } from '../../src/core/math';
import { Chunk } from '../../src/voxel/chunk';
import type { VoxelGrid } from '../../src/voxel/grid';
import { World } from '../../src/voxel/world';
import { raycastGrid } from '../../src/voxel/raycast';
import {
  FREE_OFFSET_STEP,
  MAX_BOX_COORD,
  MAX_FREE_RADIUS,
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
import { STONE, box, emptyWorld, fill, structure } from './helpers';

const READ_BUDGET = 200_000;

/** A world that refuses to be scanned forever (cell reads and chunk lookups both count). */
class BudgetWorld extends World {
  reads = 0;
  override getCell(x: number, y: number, z: number): number {
    if (++this.reads > READ_BUDGET) throw new Error('cell read budget exceeded (query does not terminate)');
    return super.getCell(x, y, z);
  }
  override getChunk(cx: number, cz: number): Chunk | undefined {
    if (++this.reads > READ_BUDGET) throw new Error('chunk read budget exceeded (query does not terminate)');
    return super.getChunk(cx, cz);
  }
}

function airWorld(): BudgetWorld {
  const w = new BudgetWorld(1);
  for (let cx = -2; cx <= 1; cx++) for (let cz = -2; cz <= 1; cz++) w.addChunk(new Chunk(cx, cz));
  w.takeDirtySections();
  w.reads = 0;
  return w;
}

/** Player-sized boxes floating in air, each broken in one way. */
const BAD: Array<[string, AABB]> = [
  ['minX = -Infinity', aabb(-Infinity, 10, 0.2, 0.5, 11.8, 0.8)],
  ['minZ = -Infinity', aabb(0.2, 10, -Infinity, 0.8, 11.8, 0.5)],
  ['minX = -Infinity, maxX = +Infinity', aabb(-Infinity, 10, 0.2, Infinity, 11.8, 0.8)],
  ['maxY = +Infinity', aabb(0.2, 10, 0.2, 0.8, Infinity, 0.8)],
  ['maxX = +Infinity', aabb(0.2, 10, 0.2, Infinity, 11.8, 0.8)],
  ['maxZ = 1e20', aabb(0.2, 10, 0.2, 0.8, 11.8, 1e20)],
  ['minY = -Infinity', aabb(0.2, -Infinity, 0.2, 0.8, 11.8, 0.8)],
  ['NaN', aabb(0.2, NaN, 0.2, 0.8, 11.8, 0.8)],
  ['position 1e20 (x++ cannot advance)', aabb(1e20 - 0.3, 10, 0.2, 1e20 + 0.3, 11.8, 0.8)],
  ['minX = -1e300', aabb(-1e300, 10, 0.2, 0.5, 11.8, 0.8)],
  ['minY = -2^53', aabb(0.2, -(2 ** 53), 0.2, 0.8, 11.8, 0.8)],
  ['just beyond MAX_BOX_COORD', aabb(MAX_BOX_COORD - 0.3, 10, 0.2, MAX_BOX_COORD + 0.3, 11.8, 0.8)],
  ['inverted', aabb(0.8, 10, 0.2, 0.2, 11.8, 0.8)],
];

describe('invalid boxes are empty for every query, and every query terminates', () => {
  for (const [label, b] of BAD) {
    it(`world (${label})`, () => {
      const w = airWorld();
      fill(w, -30, 0, -30, 30, 9, 30); // ground under the boxes: a valid box at y 10 would stand on it
      w.reads = 0;
      expect(boxOverlapsSolid(w, b)).toBe(false);
      let visits = 0;
      forEachSolidCellOverlapping(w, b, () => {
        visits++;
      });
      expect(visits).toBe(0);
      expect(deepestPenetration(w, b)).toBeNull();
      expect(resolvePenetration(w, b)).toEqual({ dx: 0, dy: 0, dz: 0, resolved: true, iterations: 0, nx: 0, ny: 0, nz: 0 });
      for (const axis of [0, 1, 2] as const) {
        for (const d of [-0.5, 0.5, -Infinity, Infinity]) expect(sweepAxis(w, b, axis, d)).toBe(0);
      }
      expect(nearestFreeOffset([w], b, 2)).toBeNull();
      // Support probes are built from the box's footprint and feet only, so they stay exactly
      // boxOverlapsSolid(supportProbe(...)): invalid whenever those parts are broken.
      expect(hasSupportBelow(w, b, 1.5)).toBe(boxOverlapsSolid(w, supportProbe(b, 1.5, 0)));
      expect(columnHasSolidBelow(w, b, 5, 0.1)).toBe(boxOverlapsSolid(w, supportProbe(b, 5, 0.1)));
      if (!['maxY = +Infinity', 'inverted'].includes(label)) expect(hasSupportBelow(w, b, 1.5)).toBe(false);
      expect(w.reads).toBeLessThan(100); // at most a few valid probe cells were read
    });
  }

  it('structures: invalid boxes are empty too', () => {
    const world = new World();
    const s = structure(world, 1, vec3(0.5, 10.5, 0.5), qfromYaw(0.4), vec3(0.5, 0.5, 0.5));
    fill(s, -3, -3, -3, 3, 3, 3);
    for (const [, b] of BAD) {
      expect(boxOverlapsSolid(s, b)).toBe(false);
      expect(deepestPenetration(s, b)).toBeNull();
      expect(resolvePenetration(s, b).resolved).toBe(true);
      expect(nearestFreeOffset([s], b, 2)).toBeNull();
    }
  });

  it('valid boxes far from the origin still work (up to MAX_BOX_COORD)', () => {
    const w = new World();
    const x = 2 ** 21 + 0.5; // inside World's storable range (posKey: |x| < 2^22)
    w.addChunk(new Chunk(x >> 4, 0));
    w.setCell(Math.floor(x), 20, 3, STONE);
    expect(boxOverlapsSolid(w, box(x - 0.3, 20.5, 3.2, x + 0.3, 22, 3.8))).toBe(true);
    expect(sweepAxis(w, box(x - 0.3, 22, 3.2, x + 0.3, 24, 3.8), 1, -10)).toBe(-1);
    expect(boxOverlapsSolid(w, box(MAX_BOX_COORD - 1, 20, 0, MAX_BOX_COORD, 21, 1))).toBe(true); // unloaded: solid
  });
});

describe('non-finite and out-of-range parameters', () => {
  it('sweepAxis: infinite deltas stop at deeprock, unloaded chunks and the build limit', () => {
    const w = airWorld(); // chunks -2..1: x and z in [-32, 32)
    const b = box(0.2, 10, 0.2, 0.8, 11.8, 0.8);
    expect(sweepAxis(w, b, 0, Infinity)).toBeCloseTo(32 - 0.8, 12);
    expect(sweepAxis(w, b, 0, -Infinity)).toBeCloseTo(-32 - 0.2, 12);
    expect(sweepAxis(w, b, 2, Infinity)).toBeCloseTo(32 - 0.8, 12);
    expect(sweepAxis(w, b, 2, -Infinity)).toBeCloseTo(-32 - 0.2, 12);
    expect(sweepAxis(w, b, 1, -Infinity)).toBeCloseTo(-10, 12); // lands on deeprock at y = 0
    expect(sweepAxis(w, b, 1, Infinity)).toBe(Infinity); // nothing solid above
    expect(sweepAxis(w, box(0.2, 200, 0.2, 0.8, 201, 0.8), 0, Infinity)).toBe(Infinity); // above the world
    expect(sweepAxis(w, b, 1, NaN)).toBe(0);
    expect(w.reads).toBeLessThan(1000);
  });

  it('sweepAxis on a non-World world grid that is air forever: an infinite delta still terminates', () => {
    const air: VoxelGrid = {
      gridId: 0,
      parent: null,
      isWorld: true,
      getCell: () => 0,
      getPart2: () => 0,
      setCell: () => false,
      toWorld: (p, out = vec3()) => Object.assign(out, p),
      toLocal: (p, out = vec3()) => Object.assign(out, p),
      dirToWorld: (d, out = vec3()) => Object.assign(out, d),
      dirToLocal: (d, out = vec3()) => Object.assign(out, d),
      velocityAt: (_p, out = vec3()) => Object.assign(out, { x: 0, y: 0, z: 0 }),
      worldRotation: (out = { x: 0, y: 0, z: 0, w: 1 }) => Object.assign(out, { x: 0, y: 0, z: 0, w: 1 }),
      cellBounds: () => null,
    };
    // The scans stop at ±MAX_BOX_COORD: ~40 layers along +x, and 2 columns of 2^24 layers
    // downward (a bounded scan, well under a second).
    const b = box(MAX_BOX_COORD - 40.5, 10.2, 0.2, MAX_BOX_COORD - 39.9, 10.8, 0.8);
    expect(sweepAxis(air, b, 0, Infinity)).toBe(Infinity);
    expect(sweepAxis(air, b, 1, -Infinity)).toBe(-Infinity);
  });

  it('resolvePenetration / deepestPenetration ignore a non-finite prefer vector or weight', () => {
    const w = airWorld();
    w.setCell(0, 50, 0, STONE); // isolated block
    const b = box(0.6, 50.7, 0.1, 1.4, 52.5, 0.9); // shallowest face: +Y 0.3
    for (const opts of [
      { prefer: vec3(NaN, 0, 0) },
      { prefer: vec3(Infinity, 0, 0), preferWeight: 1 },
      { prefer: vec3(1, 0, 0), preferWeight: NaN },
      { prefer: vec3(1, 0, 0), preferWeight: Infinity },
    ]) {
      const p = deepestPenetration(w, b, opts)!;
      expect([p.nx, p.ny, p.nz]).toEqual([0, 1, 0]);
      expect(p.depth).toBeCloseTo(0.3, 12);
      expect(resolvePenetration(w, b, 6, opts).resolved).toBe(true);
    }
  });

  it('nearestFreeOffset clamps maxRadius to MAX_FREE_RADIUS; NaN or negative radius tests only the box itself', () => {
    const w = emptyWorld(); // not budgeted: the clamped ball has ~137k candidates
    const b = box(0.2, 60, 0.2, 0.8, 61.8, 0.8);
    let calls = 0;
    expect(nearestFreeOffset([w], b, 1e9, () => (calls++, false))).toBeNull();
    const n = MAX_FREE_RADIUS / FREE_OFFSET_STEP;
    let expected = 0;
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) for (let k = -n; k <= n; k++) if (i * i + j * j + k * k <= n * n) expected++;
    expect(calls).toBe(expected);
    for (const r of [NaN, -3, 0]) {
      calls = 0;
      expect(nearestFreeOffset([w], b, r, () => (calls++, false))).toBeNull();
      expect(calls).toBe(1);
      expect(nearestFreeOffset([w], b, r)).toEqual(vec3(0, 0, 0));
    }
  });

  it('raycastGrid rejects non-finite input without reading cells', () => {
    const w = airWorld();
    w.reads = 0;
    expect(raycastGrid(w, vec3(-Infinity, 10, 0), vec3(1, 0, 0), 10)).toBeNull();
    expect(raycastGrid(w, vec3(0, 10, 0), vec3(NaN, 0, 0), 10)).toBeNull();
    expect(raycastGrid(w, vec3(0, 10, 0), vec3(1, 0, 0), NaN)).toBeNull();
    expect(w.reads).toBe(0);
    // An infinite range is clipped: an all-air horizontal ray through loaded and unloaded
    // chunks (rays pass through UNLOADED) terminates.
    expect(raycastGrid(w, vec3(0.5, 10.5, 0.5), vec3(1, 0, 0), Infinity)).toBeNull();
  });
});
