/**
 * A structure's broadphase box (entities/structs.ts StructRec bounds) bounds its solid octants on
 * the half-cell lattice: a face of its cell bounds whose boundary layer holds only cells with an
 * empty outer half (a deck of lower half slabs) is pulled in half a cell, so a body standing on
 * that deck is outside the box, as a body on a deck of whole blocks is (the queries a body inside
 * the box asks every tick are skipped: tests/drive/alloc.test.ts 'sneak on a slab deck'). A soft
 * cell or one solid octant in the outer half keeps the face; whole-block grids are never trimmed.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { qfromAxisAngle, quat, vec3 } from '../../src/core/math';
import { StructureCache, type BodyStructure, type StructRec } from '../../src/entities/structs';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';
import { LOWER, slab, UPPER } from '../shapes';

/** A deck of `cell` (x 0..3, z 0..3, y 10), at rest where it was built (local == world), and its record. */
function deckRec(cell: number, extra?: (g: StructureGrid) => void, turn?: number): { rec: StructRec; cache: StructureCache; g: StructureGrid; list: BodyStructure[] } {
  const world = new World(1);
  const g = new StructureGrid(1, world);
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) g.setCell(x, 10, z, cell);
  extra?.(g);
  g.pivot.x = 2;
  g.pivot.y = 10.5;
  g.pivot.z = 2;
  g.setPoseImmediate(vec3(2, 10.5, 2), turn === undefined ? quat() : qfromAxisAngle(vec3(1, 0, 0), turn));
  const list: BodyStructure[] = [{ id: 1, grid: g, parent: null, children: [], removed: false, hull: null }];
  const cache = new StructureCache();
  cache.rebuild(list);
  return { rec: cache.get(1)!, cache, g, list };
}

describe('structure broadphase box on the half-cell lattice', () => {
  it('whole blocks: the cell bounds', () => {
    const { rec } = deckRec(makeCell(B.PLANKS_OAK));
    expect(rec.minY).toBeCloseTo(10, 5);
    expect(rec.maxY).toBeCloseTo(11, 5);
    expect(rec.minX).toBeCloseTo(0, 5);
    expect(rec.maxX).toBeCloseTo(4, 5);
  });

  it('lower half slabs: the top is pulled down to y + 0.5; upper half slabs: the bottom up', () => {
    const lo = deckRec(slab(B.PLANKS_OAK, LOWER)).rec;
    expect(lo.maxY).toBeCloseTo(10.5, 5);
    expect(lo.minY).toBeCloseTo(10, 5);
    expect(lo.maxX).toBeCloseTo(4, 5);
    const up = deckRec(slab(B.PLANKS_OAK, UPPER)).rec;
    expect(up.minY).toBeCloseTo(10.5, 5);
    expect(up.maxY).toBeCloseTo(11, 5);
  });

  it('one whole block, or a soft cell, on the boundary layer keeps the face', () => {
    const full = deckRec(slab(B.PLANKS_OAK, LOWER), (g) => g.setCell(1, 10, 1, makeCell(B.PLANKS_OAK))).rec;
    expect(full.maxY).toBeCloseTo(11, 5);
    const torch = deckRec(slab(B.PLANKS_OAK, LOWER), (g) => g.setCell(1, 11, 1, makeCell(B.TORCH))).rec;
    expect(torch.maxY).toBeCloseTo(12, 5);
  });

  it('follows edits (the grid version) and the pose (a deck turned upside down has its trimmed face below)', () => {
    const d = deckRec(slab(B.PLANKS_OAK, LOWER));
    expect(d.rec.maxY).toBeCloseTo(10.5, 5);
    d.g.setCell(2, 10, 2, makeCell(B.PLANKS_OAK));
    d.cache.rebuild(d.list);
    expect(d.cache.get(1)!.maxY).toBeCloseTo(11, 5);
    const flipped = deckRec(slab(B.PLANKS_OAK, LOWER), undefined, Math.PI).rec;
    // Local y 10..10.5 about the pivot at 10.5 turned over: world 10.5..11.
    expect(flipped.minY).toBeCloseTo(10.5, 5);
    expect(flipped.maxY).toBeCloseTo(11, 5);
  });
});
