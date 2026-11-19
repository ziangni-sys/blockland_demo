/**
 * Rays hit octants (docs/SHAPES.md 6.1, package P8a): the ray passes through the empty octants of
 * partial cells and through the octants of parts its predicate rejects; GridHit.octant is the
 * octant hit and GridHit.part the part containing it; faces can be inner faces; full blocks keep
 * the M1 path and get their octant from the rule of 6.1. Checked against hand-computed cases and
 * against the brute-force octant-box reference (tests/voxel/ray-helpers.ts).
 */
import { describe, expect, it } from 'vitest';
import { ID_MASK, PACK_SCALE, liquidState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell, partAt } from '../../src/blocks/shapes';
import { NX, NY, PX, PY, PZ, nearestDir, opposite } from '../../src/core/dirs';
import { qidentity, vec3, type Vec3 } from '../../src/core/math';
import { Rng } from '../../src/core/rng';
import type { VoxelGrid } from '../../src/voxel/grid';
import { getPacked } from '../../src/voxel/parts';
import { placementCell, raycastGrid, raycastGrids, targetable, targetableOrLiquidSource, type CellPredicate, type GridHit } from '../../src/voxel/raycast';
import { StructureGrid } from '../../src/voxel/sgrid';
import { LOWER, UPPER, slab, stairFill } from '../shapes';
import { STONE, emptyWorld, randomQuat, structure, unit } from './helpers';
import { fullCellOctant, octantEntry, referenceRay } from './ray-helpers';

const PLANKS = makeCell(B.PLANKS_OAK);
const Y = 40;
/** Stone below, glass above: a two-part cell; stone is the first part (it holds octant 0). */
const STONE_GLASS = canonCell(slab(B.STONE, LOWER), slab(B.GLASS, UPPER));
const noGlass: CellPredicate = (p) => targetable(p) && (p & ID_MASK) !== B.GLASS;
const noStone: CellPredicate = (p) => targetable(p) && (p & ID_MASK) !== B.STONE;
const onlyPlanks: CellPredicate = (p) => (p & ID_MASK) === B.PLANKS_OAK;

/** Counts reads of both layers. */
class CountingGrid extends StructureGrid {
  cellReads = 0;
  part2Reads = 0;
  override getCell(x: number, y: number, z: number): number {
    this.cellReads++;
    return super.getCell(x, y, z);
  }
  override getPart2(x: number, y: number, z: number): number {
    this.part2Reads++;
    return super.getPart2(x, y, z);
  }
}

function summary(h: GridHit | null): unknown {
  return h === null ? null : { x: h.x, y: h.y, z: h.z, face: h.face, octant: h.octant, part: h.part, dist: h.dist };
}

describe('partial cells: the ray passes through empty octants', () => {
  it('over a lower slab to the block behind; into its side below the mid-plane; on its top (an inner face)', () => {
    const w = emptyWorld();
    const s = slab(B.STONE, LOWER);
    w.setCell(0, Y, 0, s);
    w.setCell(1, Y, 0, PLANKS);
    const east = vec3(1, 0, 0);
    // Through the empty upper half: the planks behind, face -X, octant (x0, y1, z1) = 6.
    expect(summary(raycastGrid(w, vec3(-2, Y + 0.75, 0.5), east, 10))).toEqual({ x: 1, y: Y, z: 0, face: NX, octant: 6, part: PLANKS, dist: 3 });
    // Exactly in the mid-plane: half-open octants, the plane belongs to the upper half.
    expect(summary(raycastGrid(w, vec3(-2, Y + 0.5, 0.5), east, 10))).toEqual({ x: 1, y: Y, z: 0, face: NX, octant: 6, part: PLANKS, dist: 3 });
    // Below it: the slab's own -X face, octant (x0, y0, z1) = 4.
    const side = raycastGrid(w, vec3(-2, Y + 0.25, 0.5), east, 10)!;
    expect(summary(side)).toEqual({ x: 0, y: Y, z: 0, face: NX, octant: 4, part: s, dist: 2 });
    expect(side.cell).toBe(s);
    // From above at (0.25, 0.25): the upper octant is empty, the top of the lower one is an inner
    // face PY at y + 0.5; the cell across it (placement) is the cell above.
    const top = raycastGrid(w, vec3(0.25, Y + 5, 0.25), vec3(0, -1, 0), 10)!;
    expect(summary(top)).toEqual({ x: 0, y: Y, z: 0, face: PY, octant: 0, part: s, dist: 4.5 });
    expect(top.point).toEqual(vec3(0.25, Y + 0.5, 0.25));
    expect(placementCell(top)).toEqual({ x: 0, y: Y + 1, z: 0 });
  });

  it('into a stair: the right octant and face from every side', () => {
    const w = emptyWorld();
    const stair = slab(B.BRICKS, stairFill(PX)); // lower half + the two upper +X octants (3, 7)
    w.setCell(0, Y, 0, stair);
    // From -X at the upper level: through the empty octant 2, the inner face -X of octant 3.
    const a = raycastGrid(w, vec3(-2, Y + 0.75, 0.25), vec3(1, 0, 0), 10)!;
    expect(summary(a)).toEqual({ x: 0, y: Y, z: 0, face: NX, octant: 3, part: stair, dist: 2.5 });
    expect(a.point.x).toBe(0.5);
    // From +X at the upper level: the cell face +X of octant 7.
    expect(summary(raycastGrid(w, vec3(3, Y + 0.75, 0.75), vec3(-1, 0, 0), 10))).toEqual({ x: 0, y: Y, z: 0, face: PX, octant: 7, part: stair, dist: 2 });
    // From above on the low side: the tread, an inner face at y + 0.5 (z = 0.5 exactly: upper half).
    expect(summary(raycastGrid(w, vec3(0.25, Y + 5, 0.5), vec3(0, -1, 0), 10))).toEqual({ x: 0, y: Y, z: 0, face: PY, octant: 4, part: stair, dist: 4.5 });
    // From above on the high side: the top of the cell.
    expect(summary(raycastGrid(w, vec3(0.75, Y + 5, 0.25), vec3(0, -1, 0), 10))).toEqual({ x: 0, y: Y, z: 0, face: PY, octant: 3, part: stair, dist: 4 });
    // A diagonal ray down the steps from the low side meets the riser (inner face -X at x + 0.5).
    const d = unit(1, -0.25, 0);
    const r = raycastGrid(w, vec3(-1, Y + 1, 0.25), d, 10)!;
    expect([r.face, r.octant]).toEqual([NX, 3]);
    expect(r.point.x).toBeCloseTo(0.5, 12);
  });

  it('a two-part cell: the part whose octant the ray meets first; the predicate is applied per part', () => {
    const w = emptyWorld();
    w.setCell(0, Y, 0, STONE_GLASS);
    w.setCell(0, Y - 2, 0, PLANKS);
    const from = vec3(0.5, Y + 5, 0.5);
    const down = vec3(0, -1, 0);
    const glass = slab(B.GLASS, UPPER);
    const stone = slab(B.STONE, LOWER);
    const h = raycastGrid(w, from, down, 10)!;
    expect(summary(h)).toEqual({ x: 0, y: Y, z: 0, face: PY, octant: 7, part: glass, dist: 4 });
    // GridHit.cell is the whole packed cell (both parts), the value Target.cell carries.
    expect(h.cell).toBe(getPacked(w, 0, Y, 0));
    expect(h.cell).toBe(STONE_GLASS);
    expect(h.cell).toBeGreaterThanOrEqual(PACK_SCALE);
    // The glass rejected: the ray goes on through its octants to the stone's inner face.
    expect(summary(raycastGrid(w, from, down, 10, noGlass))).toEqual({ x: 0, y: Y, z: 0, face: PY, octant: 5, part: stone, dist: 4.5 });
    // Both rejected: through the whole cell to the planks below.
    expect(summary(raycastGrid(w, from, down, 10, onlyPlanks))).toEqual({ x: 0, y: Y - 2, z: 0, face: PY, octant: 7, part: PLANKS, dist: 6 });
    // From the side below the mid-plane: the stone; above it: the glass (the second part).
    expect(raycastGrid(w, vec3(-2, Y + 0.25, 0.25), vec3(1, 0, 0), 10)!.part).toBe(stone);
    expect(raycastGrid(w, vec3(-2, Y + 0.75, 0.25), vec3(1, 0, 0), 10)!.part).toBe(glass);
  });

  it('starting inside the cell: in an empty octant the hit is where the ray enters a filled one; inside a filled one dist is 0', () => {
    const w = emptyWorld();
    const s = slab(B.STONE, LOWER);
    w.setCell(0, Y, 0, s);
    const a = raycastGrid(w, vec3(0.25, Y + 0.75, 0.25), vec3(0, -1, 0), 10)!;
    expect(summary(a)).toEqual({ x: 0, y: Y, z: 0, face: PY, octant: 0, part: s, dist: 0.25 });
    for (const d of [unit(1, 0.2, 0.1), unit(-0.3, -1, 0.2), unit(0.1, 0.3, -1)]) {
      const b = raycastGrid(w, vec3(0.25, Y + 0.3, 0.2), d, 10)!;
      expect(summary(b)).toEqual({ x: 0, y: Y, z: 0, face: opposite(nearestDir(d.x, d.y, d.z)), octant: 0, part: s, dist: 0 });
    }
    // Inside the two-part cell: in the stone (octant 5); the stone rejected, the glass above.
    const up = vec3(0, 1, 0);
    w.setCell(3, Y, 0, STONE_GLASS);
    expect(summary(raycastGrid(w, vec3(3.5, Y + 0.25, 0.5), up, 10))).toEqual({ x: 3, y: Y, z: 0, face: NY, octant: 5, part: slab(B.STONE, LOWER), dist: 0 });
    expect(summary(raycastGrid(w, vec3(3.5, Y + 0.25, 0.5), up, 10, noStone))).toEqual({ x: 3, y: Y, z: 0, face: NY, octant: 7, part: slab(B.GLASS, UPPER), dist: 0.25 });
  });

  it('an octant the ray only touches along an edge is never hit (two mid-planes crossed at once)', () => {
    const w = emptyWorld();
    const o = vec3(0.25, Y + 0.25, 0.25); // in octant 0, which stays empty
    const d = unit(1, 1, 0); // through the cell's mid-edge (0.5, 0.5) at z = 0.25
    w.setCell(0, Y, 0, slab(B.STONE, 0x06)); // octants 1 and 2: edge-only
    expect(raycastGrid(w, o, d, 3)).toBeNull();
    w.setCell(0, Y, 0, slab(B.STONE, 0x0e)); // and octant 3, entered through the edge
    const h = raycastGrid(w, o, d, 3)!;
    expect([h.octant, h.face]).toEqual([3, NX]); // x before y on equal slopes
    expect(h.dist).toBeCloseTo(0.25 * Math.SQRT2, 15);
    // Mirror image (-x, -y): the same, entered through +X.
    const w2 = emptyWorld();
    w2.setCell(0, Y, 0, slab(B.STONE, 0x06));
    expect(raycastGrid(w2, vec3(0.75, Y + 0.75, 0.25), unit(-1, -1, 0), 3)).toBeNull();
    w2.setCell(0, Y, 0, slab(B.STONE, 0x07));
    const m = raycastGrid(w2, vec3(0.75, Y + 0.75, 0.25), unit(-1, -1, 0), 3)!;
    expect([m.octant, m.face]).toEqual([0, PX]);
    // Unequal slopes: direction (1, 2) from (0.25, 0) crosses both mid-planes at once; the inner
    // face entered is the steeper axis's, -Y.
    const w3 = emptyWorld();
    w3.setCell(0, Y, 0, slab(B.STONE, 0x08)); // octant 3 only
    const s = raycastGrid(w3, vec3(0.25, Y, 0.25), unit(1, 2, 0), 3)!;
    expect([s.octant, s.face]).toEqual([3, NY]);
    expect(s.point.x).toBeCloseTo(0.5, 14);
    expect(s.point.y).toBeCloseTo(Y + 0.5, 14);
  });

  it('a body diagonal through the cell centre skips the six corner/edge-only octants', () => {
    const w = emptyWorld();
    const o = vec3(0.25, Y + 0.25, 0.25);
    const d = unit(1, 1, 1);
    w.setCell(0, Y, 0, slab(B.STONE, 0x7e));
    expect(raycastGrid(w, o, d, 3)).toBeNull();
    w.setCell(0, Y, 0, slab(B.STONE, 0xfe));
    const h = raycastGrid(w, o, d, 3)!;
    expect([h.octant, h.face]).toEqual([7, NX]);
    expect(h.dist).toBeCloseTo(Math.sqrt(3) / 4, 15);
  });

  it('a mid-plane crossed together with a cell boundary: the octant just past both; the first octant keeps the cell entry face', () => {
    // Direction (1, 2) from (0.25, 0.5): the x mid-plane and the cell's top y = 1 at the same t.
    const w = emptyWorld();
    const o = vec3(0.25, Y + 0.5, 0.25);
    const d = unit(1, 2, 0);
    w.setCell(0, Y, 0, slab(B.STONE, 0x08)); // octant 3 of the lower cell: only its corner is touched
    w.setCell(0, Y + 1, 0, slab(B.STONE, 0x01)); // octant 0 of the upper cell: likewise
    expect(raycastGrid(w, o, d, 2)).toBeNull();
    w.setCell(0, Y + 1, 0, slab(B.STONE, 0x03)); // octant 1 of the upper cell: entered there
    const h = raycastGrid(w, o, d, 2)!;
    expect([h.x, h.y, h.z, h.octant, h.face]).toEqual([0, Y + 1, 0, 1, NY]);
    expect(h.dist).toBeCloseTo(0.25 * Math.sqrt(5), 14);
    // The steeper axis crosses the mid-plane while x crosses the cell boundary: the face is still
    // the cell's entry face NX (docs/SHAPES.md 6.1: the first octant keeps the outer entry face).
    const w2 = emptyWorld();
    w2.setCell(1, Y, 0, slab(B.STONE, 0x04)); // octant 2 (x0, y1, z0)
    const h2 = raycastGrid(w2, vec3(0.75, Y, 0.25), unit(1, 2, 0), 2)!;
    expect([h2.x, h2.y, h2.octant, h2.face]).toEqual([1, Y, 2, NX]);
    expect(h2.point.y).toBeCloseTo(Y + 0.5, 14);
  });

  it('a range ending inside a partial cell: an octant entered exactly at maxDist counts, one beyond does not', () => {
    const w = emptyWorld();
    w.setCell(0, Y, 0, slab(B.STONE, LOWER));
    const from = vec3(0.5, Y + 3, 0.5);
    expect(raycastGrid(w, from, vec3(0, -1, 0), 2.5)!.dist).toBe(2.5);
    expect(raycastGrid(w, from, vec3(0, -1, 0), 2.4999)).toBeNull();
  });

  it('one read per cell; the second part is read only for a cell that has one', () => {
    const world = emptyWorld();
    const g = new CountingGrid(1, world);
    g.setPoseImmediate(vec3(0, 50, 0), qidentity());
    g.setCell(0, 0, 0, STONE);
    g.setCell(0, 0, 2, slab(B.STONE, LOWER));
    g.setCell(0, 0, 4, STONE_GLASS);
    const at = (z: number): GridHit | null => {
      g.cellReads = 0;
      g.part2Reads = 0;
      return raycastGrid(g, g.toWorld(vec3(0.5, 5, z + 0.5)), vec3(0, -1, 0), 10);
    };
    expect(at(0)!.part).toBe(STONE);
    expect([g.cellReads, g.part2Reads]).toEqual([1, 0]);
    expect(at(2)!.face).toBe(PY);
    expect([g.cellReads, g.part2Reads]).toEqual([1, 0]);
    expect(at(4)!.cell).toBe(STONE_GLASS);
    expect([g.cellReads, g.part2Reads]).toEqual([1, 1]);
  });

  it('raycastGrids: the nearest octant over grids (a structure slab does not hide the world block behind its empty half)', () => {
    const world = emptyWorld();
    world.setCell(6, Y, 0, STONE);
    const ship = structure(world, 1, vec3(0, 0, 0), qidentity());
    ship.setCell(4, Y, 0, slab(B.PLANKS_OAK, LOWER));
    const grids: VoxelGrid[] = [world, ship];
    const high = raycastGrids(grids, vec3(0.5, Y + 0.75, 0.5), vec3(1, 0, 0), 20)!;
    expect([high.grid, high.x]).toEqual([world, 6]);
    const low = raycastGrids(grids, vec3(0.5, Y + 0.25, 0.5), vec3(1, 0, 0), 20)!;
    expect([low.grid, low.x, low.octant]).toEqual([ship, 4, 4]);
  });

  it('liquid next to a partial cell: the bucket predicate stops at the source in front, not at the slab', () => {
    const w = emptyWorld();
    w.setCell(0, Y, 0, makeCell(B.WATER, liquidState(0, false)));
    w.setCell(1, Y, 0, slab(B.STONE, LOWER));
    const h = raycastGrid(w, vec3(-1, Y + 0.75, 0.5), vec3(1, 0, 0), 10, targetableOrLiquidSource)!;
    expect([h.x, h.octant, h.part]).toEqual([0, 6, makeCell(B.WATER, liquidState(0, false))]);
  });
});

describe('full blocks: the M1 hit plus the octant rule', () => {
  it('axis-parallel rays at face centres: the entry axis by direction, the others exactly at 0.5 by "not moving: 1"', () => {
    const w = emptyWorld();
    w.setCell(3, 10, -5, STONE);
    const centre = vec3(3.5, 10.5, -4.5);
    const cases: Array<[Vec3, number]> = [
      [vec3(6.5, 10.5, -4.5), 7], // moving -x: x 1
      [vec3(0.25, 10.5, -4.5), 6], // moving +x: x 0
      [vec3(3.5, 14, -4.5), 7],
      [vec3(3.5, 7.75, -4.5), 5],
      [vec3(3.5, 10.5, -1), 7],
      [vec3(3.5, 10.5, -9.5), 3],
    ];
    for (const [from, oct] of cases) {
      const h = raycastGrid(w, from, unit(centre.x - from.x, centre.y - from.y, centre.z - from.z), 10)!;
      expect(h.octant).toBe(oct);
      expect(h.part).toBe(STONE);
      expect(h.cell).toBe(STONE);
    }
  });

  it('an entry point exactly on a mid-plane while moving across it: the half the ray moves into', () => {
    const w = emptyWorld();
    w.setCell(5, Y, 0, STONE);
    // Crossing x = 5 at y = 40.5 moving +y: y 1; z = 0.5 not moving: 1 -> octant 6.
    const up = raycastGrid(w, vec3(4.5, Y, 0.5), unit(1, 1, 0), 3)!;
    expect([up.x, up.face, up.octant]).toEqual([5, NX, 6]);
    expect(up.point.y).toBe(Y + 0.5);
    // The same point moving -y: y 0 -> octant 4.
    const down = raycastGrid(w, vec3(4.5, Y + 1, 0.5), unit(1, -1, 0), 3)!;
    expect([down.x, down.face, down.octant]).toEqual([5, NX, 4]);
  });

  it('starting inside: all three axes by the origin (exactly 0.5: moving + 1, moving - 0, not moving 1)', () => {
    const w = emptyWorld();
    w.setCell(0, Y, 0, STONE);
    expect(raycastGrid(w, vec3(0.5, Y + 0.5, 0.5), unit(1, -1, 0), 3)!.octant).toBe(5);
    expect(raycastGrid(w, vec3(0.5, Y + 0.5, 0.5), unit(-1, 1, 0), 3)!.octant).toBe(6);
    expect(raycastGrid(w, vec3(0.3, Y + 0.7, 0.2), unit(1, 1, 1), 3)!.octant).toBe(2);
    expect(raycastGrid(w, vec3(0.9, Y + 0.1, 0.6), unit(-1, 0, 0), 3)!.octant).toBe(5);
  });

  it('soft blocks (never cut) are hit as full cells', () => {
    const w = emptyWorld();
    const torch = makeCell(B.TORCH);
    w.setCell(0, Y, 0, torch);
    const h = raycastGrid(w, vec3(0.25, Y + 3, 0.75), vec3(0, -1, 0), 5)!;
    expect(summary(h)).toEqual({ x: 0, y: Y, z: 0, face: PY, octant: 6, part: torch, dist: 2 });
  });

  it('random rays: the octant follows the rule of 6.1 written from the entry point (tests/voxel/ray-helpers.ts)', () => {
    const rng = new Rng(61);
    const w = emptyWorld();
    for (let i = 0; i < 300; i++) w.setCell(rng.int(-10, 9), rng.int(40, 52), rng.int(-10, 9), STONE);
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const o = vec3(rng.range(-12, 12), rng.range(38, 54), rng.range(-12, 12));
      const d = unit(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      if (i % 5 === 0) d.y = 0;
      const dd = unit(d.x, d.y, d.z);
      const h = raycastGrid(w, o, dd, 20);
      if (h === null) continue;
      const p = h.point;
      const frac = [p.x - h.x, p.y - h.y, p.z - h.z];
      // Points within rounding of a mid-plane are decided by ray parameters, not by the point.
      if (frac.some((f, a) => a !== h.face >> 1 && Math.abs(f - 0.5) < 1e-9)) continue;
      expect(h.octant).toBe(fullCellOctant(h.x, h.y, h.z, p, h.dist > 0 ? h.face : null, dd));
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

// ------------------------------------------------------------------ against the reference

/** Cuttable materials for random parts. */
const MATERIALS = [B.STONE, B.PLANKS_OAK, B.GLASS, B.WOOL_WHITE, B.BRICKS, B.IRON_BLOCK];

/** A random cell: a full block, a torch, one part with holes, or two parts (disjoint, both with holes). */
function randomCell(rng: Rng): number {
  const r = rng.next();
  const mat = (): number => MATERIALS[rng.int(0, MATERIALS.length - 1)]!;
  if (r < 0.25) return makeCell(mat());
  if (r < 0.3) return makeCell(B.TORCH);
  const fill = rng.int(1, 254);
  if (r < 0.65) return slab(mat(), fill);
  // Split a fill of at least two octants into two non-empty disjoint parts.
  let a = 0;
  let b = 0;
  while (a === 0 || b === 0) {
    a = 0;
    b = 0;
    const f = rng.int(3, 255);
    for (let o = 0; o < 8; o++) {
      if (((f >> o) & 1) === 0) continue;
      if (rng.next() < 0.5) a |= 1 << o;
      else b |= 1 << o;
    }
  }
  return canonCell(slab(mat(), a), slab(mat(), b));
}

/**
 * Compare one ray with the reference: same miss / hit, same entry distance, the reported octant's
 * box is entered at that distance, part = partAt(cell, octant) and accepted by the predicate,
 * cell = the packed cell, the hit point on the plane of the reported face of that octant; where
 * no other box is entered within 1e-9 of it, the same cell, octant and face.
 */
function compare(g: VoxelGrid, cells: Array<[number, number, number]>, o: Vec3, d: Vec3, maxDist: number, pred: CellPredicate, digits: number): 'hit' | 'miss' {
  const h = raycastGrid(g, o, d, maxDist, pred);
  const ref = referenceRay(g, cells, o, d, maxDist, pred);
  expect(h === null).toBe(ref === null);
  if (h === null || ref === null) return 'miss';
  expect(h.dist).toBeCloseTo(ref.t, digits);
  expect(h.grid).toBe(g);
  const own = octantEntry(g, h.x, h.y, h.z, h.octant, o, d, maxDist);
  expect(own).not.toBeNull();
  expect(own!).toBeCloseTo(ref.t, digits);
  expect(h.cell).toBe(getPacked(g, h.x, h.y, h.z));
  expect(h.part).toBe(partAt(h.cell, h.octant));
  expect(h.part).not.toBe(0);
  expect(pred(h.part)).toBe(true);
  if (h.dist > 0) {
    const lp = g.toLocal(h.point);
    const a = h.face >> 1;
    const lo = [h.x, h.y, h.z][a]! + ((h.octant >> a) & 1) * 0.5;
    const plane = (h.face & 1) === 0 ? lo + 0.5 : lo;
    expect(Math.abs([lp.x, lp.y, lp.z][a]! - plane)).toBeLessThan(1e-9);
  }
  if (ref.runnerUp - ref.t > 1e-9) {
    expect([h.x, h.y, h.z, h.octant]).toEqual([ref.x, ref.y, ref.z, ref.octant]);
    // On an exact edge / corner entry the reference takes the steepest of all crossed planes;
    // raycast.ts keeps the cell's entry face for a cell's first octant (6.1). The plane check
    // above covers those.
    if (h.dist > 0 && !ref.faceTie) expect(h.face).toBe(ref.face);
  }
  return 'hit';
}

describe('against the octant-box reference', () => {
  it('random rays through a world of partial cells, two-part cells, full blocks and torches, for three predicates', () => {
    const rng = new Rng(808);
    const w = emptyWorld();
    const cells: Array<[number, number, number]> = [];
    for (let i = 0; i < 500; i++) {
      const x = rng.int(-10, 9);
      const y = rng.int(40, 52);
      const z = rng.int(-10, 9);
      if (getPacked(w, x, y, z) !== 0) continue;
      w.setCell(x, y, z, randomCell(rng));
      cells.push([x, y, z]);
    }
    const counts = { hit: 0, miss: 0 };
    const partial = { hits: 0 };
    for (const pred of [targetable, noGlass, onlyPlanks]) {
      for (let i = 0; i < 1500; i++) {
        const o = vec3(rng.range(-12, 12), rng.range(38, 54), rng.range(-12, 12));
        const d = unit(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
        if (i % 7 === 0) d.y = 0;
        if (i % 11 === 0) d.x = 0;
        const dd = unit(d.x, d.y, d.z);
        if (!Number.isFinite(dd.x)) continue;
        counts[compare(w, cells, o, dd, 20, pred, 9)]++;
        const h = raycastGrid(w, o, dd, 20, pred);
        if (h !== null && getPacked(w, h.x, h.y, h.z) >= 1 << 16) partial.hits++;
      }
    }
    expect(counts.hit).toBeGreaterThan(1000);
    expect(counts.miss).toBeGreaterThan(300);
    expect(partial.hits).toBeGreaterThan(500);
  });

  it('lattice-aligned rays with exact ties on the half grid', () => {
    // Origins on an eighth lattice and directions with components in {-2..2}: crossings of
    // cell boundaries and mid-planes on different axes coincide exactly (bit for bit).
    const rng = new Rng(4343);
    const w = emptyWorld();
    const cells: Array<[number, number, number]> = [];
    for (let i = 0; i < 400; i++) {
      const x = rng.int(-6, 5);
      const y = rng.int(40, 49);
      const z = rng.int(-6, 5);
      if (getPacked(w, x, y, z) !== 0) continue;
      w.setCell(x, y, z, randomCell(rng));
      cells.push([x, y, z]);
    }
    const counts = { hit: 0, miss: 0 };
    for (let i = 0; i < 3000; i++) {
      const o = vec3(rng.int(-64, 64) / 8, rng.int(320, 400) / 8, rng.int(-64, 64) / 8);
      let a = 0;
      let b = 0;
      let c = 0;
      while (a === 0 && b === 0 && c === 0) {
        a = rng.int(-2, 2);
        b = rng.int(-2, 2);
        c = rng.int(-2, 2);
      }
      counts[compare(w, cells, o, unit(a, b, c), 10, targetable, 12)]++;
    }
    expect(counts.hit).toBeGreaterThan(800);
    expect(counts.miss).toBeGreaterThan(200);
  });

  it('rotated and nested structures', () => {
    const rng = new Rng(99);
    const world = emptyWorld();
    for (let trial = 0; trial < 10; trial++) {
      const ship = structure(world, 1, vec3(rng.range(-5, 5), rng.range(40, 60), rng.range(-5, 5)), randomQuat(rng), vec3(rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2)));
      ship.setCell(-6, -1, -6, STONE); // bounds anchor
      let g: StructureGrid = ship;
      if (trial % 2 === 1) {
        g = new StructureGrid(2, ship);
        g.pivot.x = 0.5;
        g.pivot.y = 0.5;
        g.setPoseImmediate(vec3(1, 3, -2), randomQuat(rng));
      }
      const cells: Array<[number, number, number]> = [];
      for (let i = 0; i < 80; i++) {
        const x = rng.int(-4, 4);
        const y = rng.int(0, 5);
        const z = rng.int(-4, 4);
        if (getPacked(g, x, y, z) !== 0) continue;
        g.setCell(x, y, z, randomCell(rng));
        cells.push([x, y, z]);
      }
      if (g === ship) cells.push([-6, -1, -6]);
      const centre = g.toWorld(vec3(0, 3, 0));
      for (let i = 0; i < 150; i++) {
        const o = vec3(centre.x + rng.range(-9, 9), centre.y + rng.range(-9, 9), centre.z + rng.range(-9, 9));
        const tgt = vec3(centre.x + rng.range(-4, 4), centre.y + rng.range(-4, 4), centre.z + rng.range(-4, 4));
        const pred = i % 3 === 0 ? noGlass : targetable;
        compare(g, cells, o, unit(tgt.x - o.x, tgt.y - o.y, tgt.z - o.z), 25, pred, 9);
      }
    }
  });
});
