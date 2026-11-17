import { describe, expect, it } from 'vitest';
import { NX, NY, NZ, PX, PY, PZ, opposite, nearestDir, type Dir } from '../../src/core/dirs';
import { qfromYaw, qidentity, vec3, type Vec3 } from '../../src/core/math';
import { Rng } from '../../src/core/rng';
import { liquidState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { isSolidCell } from '../../src/blocks/registry';
import type { VoxelGrid } from '../../src/voxel/grid';
import {
  RAY_HARD_LIMIT,
  placementCell,
  raycastGrid,
  raycastGrids,
  targetable,
  targetableOrLiquidSource,
} from '../../src/voxel/raycast';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';
import {
  STONE,
  axisAngle,
  emptyWorld,
  fill,
  randomQuat,
  referenceRay,
  solidCells,
  structure,
  unit,
} from './helpers';

const WATER_SOURCE = makeCell(B.WATER, liquidState(0, false));
const WATER_FLOW = makeCell(B.WATER, liquidState(3, false));
const WATER_FALLING = makeCell(B.WATER, liquidState(0, true));

/** Counts getCell calls so the bounds prefilter can be observed. */
class CountingGrid extends StructureGrid {
  calls = 0;
  override getCell(x: number, y: number, z: number): number {
    this.calls++;
    return super.getCell(x, y, z);
  }
}

describe('predicates', () => {
  it('targetable: non-air, non-liquid; soft blocks count; unloaded does not', () => {
    expect(targetable(makeCell(B.AIR))).toBe(false);
    expect(targetable(STONE)).toBe(true);
    expect(targetable(makeCell(B.TORCH))).toBe(true);
    expect(targetable(makeCell(B.TALL_GRASS))).toBe(true);
    expect(targetable(makeCell(B.SNOW_LAYER, 3))).toBe(true);
    expect(targetable(WATER_SOURCE)).toBe(false);
    expect(targetable(makeCell(B.LAVA))).toBe(false);
    expect(targetable(makeCell(B.UNLOADED))).toBe(false);
    expect(targetable(makeCell(B.DEEPROCK))).toBe(true);
  });
  it('targetableOrLiquidSource: adds liquid sources only', () => {
    expect(targetableOrLiquidSource(WATER_SOURCE)).toBe(true);
    expect(targetableOrLiquidSource(makeCell(B.LAVA, liquidState(0, false)))).toBe(true);
    expect(targetableOrLiquidSource(WATER_FLOW)).toBe(false);
    expect(targetableOrLiquidSource(WATER_FALLING)).toBe(false);
    expect(targetableOrLiquidSource(STONE)).toBe(true);
    expect(targetableOrLiquidSource(makeCell(B.AIR))).toBe(false);
    expect(targetableOrLiquidSource(makeCell(B.UNLOADED))).toBe(false);
  });
});

describe('raycastGrid — world', () => {
  // Single block at (3, 10, -5): negative z, so the chunk index and in-chunk masks are exercised.
  const world = emptyWorld();
  world.setCell(3, 10, -5, STONE);
  const centre = vec3(3.5, 10.5, -4.5);
  const cases: Array<{ face: Dir; from: Vec3 }> = [
    { face: PX, from: vec3(6.5, 10.5, -4.5) },
    { face: NX, from: vec3(0.25, 10.5, -4.5) },
    { face: PY, from: vec3(3.5, 14, -4.5) },
    { face: NY, from: vec3(3.5, 7.75, -4.5) },
    { face: PZ, from: vec3(3.5, 10.5, -1) },
    { face: NZ, from: vec3(3.5, 10.5, -9.5) },
  ];
  for (const { face, from } of cases) {
    it(`axis-parallel ray hits face ${face} exactly`, () => {
      const dir = unit(centre.x - from.x, centre.y - from.y, centre.z - from.z);
      const h = raycastGrid(world, from, dir, 10)!;
      expect(h).not.toBeNull();
      expect([h.x, h.y, h.z]).toEqual([3, 10, -5]);
      expect(h.face).toBe(face);
      expect(h.cell).toBe(STONE);
      expect(h.grid).toBe(world);
      // Exact entry distance: centre distance minus half a block.
      const dCentre = Math.hypot(centre.x - from.x, centre.y - from.y, centre.z - from.z);
      expect(h.dist).toBe(dCentre - 0.5);
      expect(h.point.x).toBeCloseTo(from.x + dir.x * h.dist, 12);
      const p = placementCell(h);
      expect(p).toEqual({ x: 3 + [1, -1, 0, 0, 0, 0][face]!, y: 10 + [0, 0, 1, -1, 0, 0][face]!, z: -5 + [0, 0, 0, 0, 1, -1][face]! });
    });
  }

  it('diagonal rays from every octant report the true entry face and point', () => {
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        for (const sz of [-1, 1]) {
          const from = vec3(centre.x + sx * 2.3, centre.y + sy * 1.7, centre.z + sz * 3.1);
          const dir = unit(centre.x - from.x, centre.y - from.y, centre.z - from.z);
          const h = raycastGrid(world, from, dir, 10)!;
          const ref = referenceRay(world, [[3, 10, -5]], from, dir, 10)!;
          expect(h.dist).toBeCloseTo(ref.t, 12);
          // The entry face is the one whose plane contains the hit point.
          const p = h.point;
          const onFace: Record<number, number> = { [PX]: p.x - 4, [NX]: p.x - 3, [PY]: p.y - 11, [NY]: p.y - 10, [PZ]: p.z + 4, [NZ]: p.z + 5 };
          expect(Math.abs(onFace[h.face]!)).toBeLessThan(1e-9);
        }
  });

  it('works for negative coordinates across chunk borders', () => {
    const w2 = emptyWorld(-3, 0); // chunks -3..0: the ray crosses several chunk borders
    w2.setCell(-17, 5, -33, STONE);
    const from = vec3(-1.2, 7.3, -20.4);
    const target = vec3(-16.5, 5.5, -32.5);
    const dir = unit(target.x - from.x, target.y - from.y, target.z - from.z);
    const h = raycastGrid(w2, from, dir, 40)!;
    expect([h.x, h.y, h.z]).toEqual([-17, 5, -33]);
    const ref = referenceRay(w2, [[-17, 5, -33]], from, dir, 40)!;
    expect(h.dist).toBeCloseTo(ref.t, 12);
  });

  it('a ray running exactly along a cell boundary plane uses the half-open cell convention', () => {
    const w = emptyWorld();
    w.setCell(5, 9, 0, STONE); // below the plane y = 10
    const from = vec3(0.5, 10, 0.5);
    expect(raycastGrid(w, from, vec3(1, 0, 0), 10)).toBeNull();
    w.setCell(6, 10, 0, STONE); // above / on the plane
    const h = raycastGrid(w, from, vec3(1, 0, 0), 10)!;
    expect([h.x, h.y, h.z, h.face, h.dist]).toEqual([6, 10, 0, NX, 5.5]);
  });

  it('an origin exactly on a boundary moving in -axis direction starts in the lower cell', () => {
    const w = emptyWorld();
    w.setCell(3, 0, 0, STONE);
    // Origin on the plane x = 4 (shared by cells 3 and 4), moving -x: cell 3 is entered at t=0
    // through its +X face.
    const h = raycastGrid(w, vec3(4, 0.5, 0.5), vec3(-1, 0, 0), 5)!;
    expect([h.x, h.dist, h.face]).toEqual([3, 0, PX]);
    // Moving +x from the plane x = 3: cell 3 is entered through its -X face at t = 0.
    const h2 = raycastGrid(w, vec3(3, 0.5, 0.5), vec3(1, 0, 0), 5)!;
    expect([h2.x, h2.dist, h2.face]).toEqual([3, 0, NX]);
    // Moving +x from x = 4: cell 3 is behind the ray.
    expect(raycastGrid(w, vec3(4, 0.5, 0.5), vec3(1, 0, 0), 5)).toBeNull();
  });

  it('starting inside a matching cell: dist 0, face opposite to the dominant direction', () => {
    const w = emptyWorld();
    w.setCell(0, 0, 0, STONE);
    const o = vec3(0.3, 0.6, 0.45);
    for (const d of [unit(1, 0.2, 0.1), unit(-0.3, -1, 0.2), unit(0.1, 0.3, -1), unit(-1, 0.5, 0.5)]) {
      const h = raycastGrid(w, o, d, 5)!;
      expect(h.dist).toBe(0);
      expect([h.x, h.y, h.z]).toEqual([0, 0, 0]);
      expect(h.face).toBe(opposite(nearestDir(d.x, d.y, d.z)));
      expect(h.point).toEqual(o);
    }
  });

  it('max distance cut-off is inclusive', () => {
    const w = emptyWorld();
    w.setCell(0, 5, 0, STONE);
    const from = vec3(0.5, 2, 0.5);
    expect(raycastGrid(w, from, vec3(0, 1, 0), 3)!.dist).toBe(3);
    expect(raycastGrid(w, from, vec3(0, 1, 0), 2.999999)).toBeNull();
    expect(raycastGrid(w, from, vec3(0, 1, 0), 0)).toBeNull();
    expect(raycastGrid(w, from, vec3(0, 1, 0), -1)).toBeNull();
    expect(raycastGrid(w, from, vec3(0, 1, 0), NaN)).toBeNull();
  });

  it('skips liquids by default; the bucket predicate stops at sources only', () => {
    const w = emptyWorld();
    w.setCell(2, 0, 0, WATER_FLOW);
    w.setCell(4, 0, 0, WATER_SOURCE);
    w.setCell(6, 0, 0, STONE);
    const from = vec3(0.5, 0.5, 0.5);
    expect(raycastGrid(w, from, vec3(1, 0, 0), 10)!.x).toBe(6);
    const b = raycastGrid(w, from, vec3(1, 0, 0), 10, targetableOrLiquidSource)!;
    expect([b.x, b.cell]).toEqual([4, WATER_SOURCE]);
  });

  it('passes through unloaded chunks and finds nothing there', () => {
    const w = emptyWorld(0, 0); // only chunk (0,0)
    const h = raycastGrid(w, vec3(8, 50, 8), vec3(1, 0, 0), 40);
    expect(h).toBeNull();
  });

  it('rays entering the world from above the build limit start at the top layer', () => {
    const w = emptyWorld();
    w.setCell(1, 60, 1, STONE);
    const h = raycastGrid(w, vec3(1.5, 300, 1.5), vec3(0, -1, 0), 1000)!;
    expect([h.y, h.face, h.dist]).toEqual([60, PY, 239]);
    // Upward rays leave the world quickly and report nothing even with a huge range.
    expect(raycastGrid(w, vec3(1.5, 61.5, 1.5), vec3(0, 1, 0), 1e9)).toBeNull();
    expect(raycastGrid(w, vec3(1.5, 200, 1.5), vec3(1, 0, 0), 1e9)).toBeNull();
  });

  it('infinite range terminates (clipped to RAY_HARD_LIMIT) and hits deeprock below the world', () => {
    const w = emptyWorld();
    const h = raycastGrid(w, vec3(0.5, 3.5, 0.5), vec3(0, -1, 0), Infinity)!;
    expect([h.y, h.cell, h.dist]).toEqual([-1, makeCell(B.DEEPROCK), 3.5]);
    // A horizontal ray far below the world with a predicate that never matches stops at the limit.
    expect(raycastGrid(w, vec3(0.5, -10.5, 0.5), vec3(1, 0, 0), Infinity, () => false)).toBeNull();
    expect(RAY_HARD_LIMIT).toBeGreaterThan(1000);
  });

  it('rejects non-finite input and zero directions only report a start-inside hit', () => {
    const w = emptyWorld();
    w.setCell(0, 0, 0, STONE);
    expect(raycastGrid(w, vec3(NaN, 0, 0), vec3(1, 0, 0), 5)).toBeNull();
    expect(raycastGrid(w, vec3(0.5, 0.5, 0.5), vec3(Infinity, 0, 0), 5)).toBeNull();
    expect(raycastGrid(w, vec3(1.5, 0.5, 0.5), vec3(0, 0, 0), 5)).toBeNull();
    expect(raycastGrid(w, vec3(0.5, 0.5, 0.5), vec3(0, 0, 0), 5)!.dist).toBe(0);
  });

  it('matches a brute-force slab reference on random rays through a random voxel field', () => {
    const rng = new Rng(7);
    const w = emptyWorld();
    const cells: Array<[number, number, number]> = [];
    for (let i = 0; i < 400; i++) {
      const x = rng.int(-12, 11);
      const y = rng.int(40, 55); // high enough that 20-block rays never reach deeprock
      const z = rng.int(-12, 11);
      if (w.getCell(x, y, z) === STONE) continue;
      w.setCell(x, y, z, STONE);
      cells.push([x, y, z]);
    }
    let hits = 0;
    for (let i = 0; i < 1500; i++) {
      const o = vec3(rng.range(-14, 14), rng.range(38, 58), rng.range(-14, 14));
      const d = unit(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      // Every few rays use an axis-parallel or 2D direction (zero components).
      if (i % 7 === 0) d.y = 0;
      if (i % 11 === 0) d.x = 0;
      const dd = unit(d.x, d.y, d.z);
      if (!Number.isFinite(dd.x)) continue;
      const h = raycastGrid(w, o, dd, 20);
      const ref = referenceRay(w, cells, o, dd, 20);
      expect(h === null).toBe(ref === null);
      if (h && ref) {
        hits++;
        expect(h.dist).toBeCloseTo(ref.t, 9);
        // The cell must be one the reference also enters at that distance (ties at edges).
        const r2 = referenceRay(w, [[h.x, h.y, h.z]], o, dd, 20)!;
        expect(r2.t).toBeCloseTo(ref.t, 9);
      }
    }
    expect(hits).toBeGreaterThan(300);
  });
});

describe('raycastGrid — structures', () => {
  it('translated and rotated structure: local cell, local face, world point', () => {
    const world = emptyWorld();
    // Yaw 90 deg: local +X points to world -Z, local -Z points to world -X.
    const s = structure(world, 1, vec3(10, 20, 30), qfromYaw(Math.PI / 2), vec3(0.5, 0.5, 0.5));
    s.setCell(0, 0, 0, STONE);
    s.setCell(1, 0, 0, STONE);
    // Local cell (1,0,0) centre is at world (10, 20, 29).
    const from = vec3(10, 20, 25);
    const h = raycastGrid(s, from, vec3(0, 0, 1), 10)!;
    expect([h.x, h.y, h.z]).toEqual([1, 0, 0]);
    // Ray travels world +Z = local -X, so it enters the local +X face.
    expect(h.face).toBe(PX);
    expect(h.dist).toBeCloseTo(3.5, 12);
    expect(h.point.z).toBeCloseTo(28.5, 12);
    expect(placementCell(h)).toEqual({ x: 2, y: 0, z: 0 });
    // Placement cell centre in world is one block further toward the viewer.
    const pc = s.toWorld(vec3(2.5, 0.5, 0.5));
    expect(pc.z).toBeCloseTo(28, 12);
  });

  it('bounds prefilter: a ray missing the bounds box never reads a cell', () => {
    const world = emptyWorld();
    const s = new CountingGrid(1, world);
    s.setPoseImmediate(vec3(0, 50, 0), qidentity());
    fill(s, 0, 0, 0, 3, 3, 3);
    s.calls = 0;
    expect(raycastGrid(s, vec3(-5, 60, 0), vec3(1, 0, 0), 100)).toBeNull();
    expect(s.calls).toBe(0);
    // A hit starts at the entry layer: the first cell read is already the hit.
    const h = raycastGrid(s, vec3(-50, 51.5, 1.5), vec3(1, 0, 0), 100)!;
    expect([h.x, h.face, h.dist]).toEqual([0, NX, 50]);
    expect(s.calls).toBe(1);
    // Empty structure: no reads, no hit.
    const e = new CountingGrid(2, world);
    expect(raycastGrid(e, vec3(0, 0, 0), vec3(1, 0, 0), 100)).toBeNull();
    expect(e.calls).toBe(0);
  });

  it('entering the bounds through the max face lands on the boundary layer exactly', () => {
    const world = emptyWorld();
    const s = structure(world, 1, vec3(0, 0, 0), qidentity());
    fill(s, -3, -3, -3, 0, 0, 0);
    const h = raycastGrid(s, vec3(-1.5, -1.5, 40), vec3(0, 0, -1), 100)!;
    expect([h.x, h.y, h.z, h.face, h.dist]).toEqual([-2, -2, -1, PZ, 40]);
  });

  it('random rotations + nested parent match the brute-force reference', () => {
    const rng = new Rng(99);
    const world = emptyWorld();
    for (let trial = 0; trial < 12; trial++) {
      const ship = structure(world, 1, vec3(rng.range(-5, 5), rng.range(40, 60), rng.range(-5, 5)), randomQuat(rng), vec3(rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2)));
      fill(ship, -6, -1, -6, 6, 0, 6, STONE); // deck so the ship has some bounds
      const nested = trial % 2 === 1;
      let g: StructureGrid = ship;
      if (nested) {
        g = new StructureGrid(2, ship);
        g.pivot.x = 0.5;
        g.pivot.y = 0.5;
        g.setPoseImmediate(vec3(1, 3, -2), randomQuat(rng));
      }
      for (let i = 0; i < 60; i++) {
        const x = rng.int(-4, 4);
        const y = rng.int(1, 5);
        const z = rng.int(-4, 4);
        g.setCell(x, y, z, i % 9 === 0 ? makeCell(B.TORCH) : STONE);
      }
      const cells = solidCells(g);
      // torches are targetable too: add them to the reference list
      g.forEachCell((x, y, z, c) => {
        if (!isSolidCell(c)) cells.push([x, y, z]);
      });
      const centre = g.toWorld(vec3(0, 3, 0));
      for (let i = 0; i < 150; i++) {
        const o = vec3(centre.x + rng.range(-9, 9), centre.y + rng.range(-9, 9), centre.z + rng.range(-9, 9));
        const tgt = vec3(centre.x + rng.range(-4, 4), centre.y + rng.range(-4, 4), centre.z + rng.range(-4, 4));
        const d = unit(tgt.x - o.x, tgt.y - o.y, tgt.z - o.z);
        const h = raycastGrid(g, o, d, 25);
        const ref = referenceRay(g, cells, o, d, 25);
        expect(h === null).toBe(ref === null);
        if (h && ref) {
          expect(h.dist).toBeCloseTo(ref.t, 9);
          expect(h.grid).toBe(g);
          // world point lies on the reported local face of the reported cell
          const lp = g.toLocal(h.point);
          const coord = [lp.x, lp.y, lp.z][h.face >> 1]!;
          const cellC = [h.x, h.y, h.z][h.face >> 1]!;
          const plane = (h.face & 1) === 0 ? cellC + 1 : cellC;
          if (h.dist > 0) expect(Math.abs(coord - plane)).toBeLessThan(1e-9);
        }
      }
    }
  });
});

describe('raycastGrids', () => {
  it('returns the nearest hit over the world and structures; structures occlude world water', () => {
    const world = emptyWorld();
    world.setCell(8, 50, 0, STONE);
    world.setCell(4, 50, 0, WATER_SOURCE);
    const ship = structure(world, 1, vec3(0, 0, 0), qidentity());
    ship.setCell(6, 50, 0, STONE);
    const grids: VoxelGrid[] = [world, ship];
    const from = vec3(0.5, 50.5, 0.5);
    const h = raycastGrids(grids, from, vec3(1, 0, 0), 20)!;
    expect([h.grid, h.x]).toEqual([ship, 6]);
    const b = raycastGrids(grids, from, vec3(1, 0, 0), 20, targetableOrLiquidSource)!;
    expect([b.grid, b.x]).toEqual([world, 4]);
    // Behind the ship the bucket ray cannot reach world water.
    const bb = raycastGrids(grids, vec3(10.5, 50.5, 0.5), vec3(-1, 0, 0), 20, targetableOrLiquidSource)!;
    expect([bb.grid, bb.x]).toEqual([world, 8]);
    ship.setCell(9, 50, 0, STONE);
    const bc = raycastGrids(grids, vec3(10.5, 50.5, 0.5), vec3(-1, 0, 0), 20, targetableOrLiquidSource)!;
    expect([bc.grid, bc.x]).toEqual([ship, 9]);
    expect(raycastGrids([], from, vec3(1, 0, 0), 20)).toBeNull();
  });

  it('on an exact tie the first grid wins', () => {
    const world = emptyWorld();
    world.setCell(5, 50, 0, STONE);
    const ship = structure(world, 1, vec3(0, 0, 0), qidentity());
    ship.setCell(5, 50, 0, STONE);
    const from = vec3(0.5, 50.5, 0.5);
    expect(raycastGrids([world, ship], from, vec3(1, 0, 0), 20)!.grid).toBe(world);
    expect(raycastGrids([ship, world], from, vec3(1, 0, 0), 20)!.grid).toBe(ship);
  });

  it('accepts any iterable (e.g. a Set)', () => {
    const world = new World();
    const ship = structure(world, 3, vec3(0, 0, 0), axisAngle(1, 2, 3, 0.4));
    ship.setCell(0, 0, 0, STONE);
    const c = ship.toWorld(vec3(0.5, 0.5, 0.5));
    const h = raycastGrids(new Set<VoxelGrid>([ship]), vec3(c.x, c.y + 5, c.z), vec3(0, -1, 0), 10)!;
    expect(h.grid).toBe(ship);
  });
});

describe('raycastGrid — box surface edge cases', () => {
  it('an origin on the bounds max face moving outward misses; moving inward hits', () => {
    const world = new World();
    const s = structure(world, 1, vec3(0, 0, 0), qidentity());
    fill(s, 0, 0, 0, 2, 2, 2);
    // Origin exactly on the plane x = 2 (the bounds max face), cell (1,0,0) behind it.
    expect(raycastGrid(s, vec3(2, 0.5, 0.5), vec3(1, 0, 0), 10)).toBeNull();
    const h = raycastGrid(s, vec3(2, 0.5, 0.5), vec3(-1, 0, 0), 10)!;
    expect([h.x, h.dist, h.face]).toEqual([1, 0, PX]);
    // Origin on the min face moving outward.
    expect(raycastGrid(s, vec3(0, 0.5, 0.5), vec3(-1, 0, 0), 10)).toBeNull();
    // World build limit: origin exactly at y = WORLD_HEIGHT moving up.
    const w = emptyWorld();
    expect(raycastGrid(w, vec3(0.5, 128, 0.5), vec3(0, 1, 0), 10)).toBeNull();
  });

  it('a ray grazing exactly along an edge of the bounds still terminates sensibly', () => {
    const world = new World();
    const s = structure(world, 1, vec3(0, 0, 0), qidentity());
    fill(s, 0, 0, 0, 2, 2, 2);
    const h = raycastGrid(s, vec3(-3, 2, 0.5), vec3(1, 0, 0), 10);
    expect(h).toBeNull(); // y = 2 is the top boundary plane: half-open cells, nothing above it
    const d = unit(1, -1, 0);
    const h2 = raycastGrid(s, vec3(-1, 3, 0.5), d, 10)!; // passes exactly through the corner (0,2)
    expect(h2.dist).toBeCloseTo(Math.SQRT2, 12);
  });
});
