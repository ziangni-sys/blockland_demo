/**
 * What P2 changes at the ray's hit (docs/SHAPES.md 6.1, 16.3): GridHit.cell is the whole packed cell
 * (Target.cell copies it, so it is valid everywhere it flows), and the fields octant and part exist
 * with their interim values (octant 0, part = the first part without CELL_MULTI_BIT) until the
 * octant-level ray fills them. The ray still reads one cell per step: a full block costs one read.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { vec3 } from '../../src/core/math';
import { Chunk } from '../../src/voxel/chunk';
import { raycastGrid, targetable } from '../../src/voxel/raycast';
import { World } from '../../src/voxel/world';
import { LOWER, slab, UPPER } from '../shapes';

function world(): World {
  const w = new World();
  w.addChunk(new Chunk(0, 0));
  return w;
}

describe('GridHit on cells with parts', () => {
  it('cell is the packed cell; part is the first part; octant is 0', () => {
    const w = world();
    const two = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER));
    w.setCell(5, 40, 5, two);
    w.setCell(8, 40, 5, slab(B.GLASS, 0x0f));
    w.setCell(11, 40, 5, makeCell(B.STONE));
    const hit = (x: number) => raycastGrid(w, vec3(x + 0.5, 45, 5.5), vec3(0, -1, 0), 10, targetable)!;
    expect(hit(5)).toMatchObject({ x: 5, y: 40, z: 5, cell: two, part: slab(B.STONE, LOWER), octant: 0 });
    expect(hit(8)).toMatchObject({ cell: slab(B.GLASS, 0x0f), part: slab(B.GLASS, 0x0f), octant: 0 });
    expect(hit(11)).toMatchObject({ cell: makeCell(B.STONE), part: makeCell(B.STONE), octant: 0 });
  });

  it('the predicate still reads the cell value (ids only): parts with the right first id are hit', () => {
    const w = world();
    w.setCell(5, 40, 5, canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER)));
    const onlyPlanks = (c: number): boolean => (c & 0x3ff) === B.PLANKS_OAK;
    expect(raycastGrid(w, vec3(5.5, 45, 5.5), vec3(0, -1, 0), 10, onlyPlanks)).toBeNull(); // the first part is stone
  });
});
