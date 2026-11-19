/**
 * Drops per part (docs/SHAPES.md section 9.5): one drop per part whatever its volume, and where
 * it appears: the centre of a full block, else in the part's lowest-numbered octant, clear of the
 * other part of the cell. The three functions read only the bits they need and never throw.
 */
import { describe, expect, it } from 'vitest';
import { CELL_MULTI_BIT, cellPrimary, cellSecond, makeCell, makePart, PART_MASK, partHoles } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { CUTTABLE } from '../../src/blocks/registry';
import { canonCell, DROP_POINT } from '../../src/blocks/shapes';
import { Rng } from '../../src/core/rng';
import type { ItemEntity } from '../../src/entities/entity';
import { dropCountOf, dropItemOf, spawnBlockDrop } from '../../src/sim/drops';
import type { Simulation } from '../../src/sim/simulation';
import type { VoxelGrid } from '../../src/voxel/grid';
import { LOWER, UPPER, slab } from '../shapes';
import { SEA_TOP, fill, flatSim, seaSim } from './helpers';

/** Spawn the drop of `part` in cell (x, y, z) of `grid`; returns the new item entity. */
function dropOne(sim: Simulation, grid: VoxelGrid, x: number, y: number, z: number, part: number): ItemEntity {
  const before = new Set(sim.entities.all().map((e) => e.id));
  expect(spawnBlockDrop(sim, grid, x, y, z, part)).toBe(true);
  const fresh = sim.entities.all().filter((e) => !before.has(e.id));
  expect(fresh).toHaveLength(1);
  return fresh[0] as ItemEntity;
}

describe('what a part drops', () => {
  it('one item of its material, whatever is left of it: a slab, a single octant and a full block drop the same', () => {
    for (const id of [B.STONE, B.TURF, B.PLANKS_OAK, B.LOG_OAK, B.GLASS, B.LEAVES_OAK, B.WOOL_RED]) {
      const full = makeCell(id);
      for (const fill of [0x33, 0xcc, 0x01, 0x80, 0x7f, 0x96]) {
        const part = slab(id, fill);
        expect(dropItemOf(part)).toBe(dropItemOf(full));
        expect(dropCountOf(part)).toBe(dropCountOf(full));
      }
    }
    expect(dropItemOf(slab(B.TURF, LOWER))).toBe(B.DIRT); // a turf slab drops dirt, like turf
    expect(dropItemOf(slab(B.STONE, UPPER))).toBe(B.COBBLE);
  });

  it('never throws: a cell value with CELL_MULTI_BIT, or the packed content of a two-part cell, reads as its first part', () => {
    const packed = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER));
    const cell = cellPrimary(packed);
    expect(cell >= CELL_MULTI_BIT).toBe(true);
    expect(packed >= 2 ** 32).toBe(true);
    for (const v of [cell, packed, cell & PART_MASK]) {
      expect(dropItemOf(v)).toBe(dropItemOf(makeCell(B.STONE)));
      expect(dropCountOf(v)).toBe(1);
    }
    const sim = flatSim();
    const e = dropOne(sim, sim.world, 0, 40, 0, packed);
    expect(e.stack.item).toBe(B.COBBLE);
    expect(e.pos.x).toBeCloseTo(0.25, 9); // the first (lower) part's lowest octant
  });

  it('a block that drops nothing still drops nothing as a part value', () => {
    expect(dropItemOf(makeCell(B.TALL_GRASS))).toBe(-1);
    expect(dropCountOf(makeCell(B.TALL_GRASS))).toBe(0);
  });
});

describe('where a part drops (DROP_POINT)', () => {
  it('a full block: the centre of its cell, exactly as before; a part with holes: the centre of its lowest octant', () => {
    const sim = flatSim();
    const w = sim.world;
    const cases: Array<[number, [number, number, number]]> = [
      [makeCell(B.STONE), [0.5, 0.5, 0.5]],
      [slab(B.STONE, LOWER), [0.25, 0.25, 0.25]],
      [slab(B.STONE, UPPER), [0.25, 0.75, 0.25]],
      [slab(B.IRON_BLOCK, 0x80), [0.75, 0.75, 0.75]],
      [slab(B.IRON_BLOCK, 0x02), [0.75, 0.25, 0.25]],
    ];
    for (const [part, [ox, oy, oz]] of cases) {
      const e = dropOne(sim, w, 3, 40, -7, part);
      // spawnItem centres the item's box on the point (feet half its height lower), as it always did.
      const c = e.box();
      expect((c.minX + c.maxX) / 2).toBeCloseTo(3 + ox, 9);
      expect((c.minY + c.maxY) / 2).toBeCloseTo(40 + oy, 9);
      expect((c.minZ + c.maxZ) / 2).toBeCloseTo(-7 + oz, 9);
    }
  });

  it('every part of every two-part cell drops inside its own octants, clear of the other part', () => {
    const sim = flatSim();
    const rng = new Rng(95);
    const cuttable = [B.STONE, B.PLANKS_OAK, B.GLASS, B.WOOL_WHITE, B.IRON_BLOCK, B.BRICKS];
    let checked = 0;
    for (let fillA = 1; fillA < 255; fillA++) {
      const rest = ~fillA & 0xff;
      // a random non-empty subset of the octants fillA leaves free
      let fillB = rng.int(1, 255) & rest;
      if (fillB === 0) fillB = rest & -rest;
      const packed = canonCell(slab(cuttable[fillA % 6]!, fillA), slab(cuttable[(fillA + 1) % 6]!, fillB));
      for (const part of [cellPrimary(packed) & PART_MASK, cellSecond(packed)]) {
        expect(CUTTABLE[part & 0x3ff]).toBe(1);
        const own = ~partHoles(part) & 0xff;
        const other = (fillA | fillB) & ~own;
        const e = dropOne(sim, sim.world, 0, 50, 0, part);
        const b = e.box();
        // The box lies in one octant of this part ...
        const o = (b.minX >= 0.5 ? 1 : 0) | (b.minY - 50 >= 0.5 ? 2 : 0) | (b.minZ >= 0.5 ? 4 : 0);
        expect(own & (1 << o)).not.toBe(0);
        expect(Math.floor(b.maxX * 2 - 1e-9)).toBe(Math.floor(b.minX * 2));
        expect(Math.floor((b.maxY - 50) * 2 - 1e-9)).toBe(Math.floor((b.minY - 50) * 2));
        expect(Math.floor(b.maxZ * 2 - 1e-9)).toBe(Math.floor(b.minZ * 2));
        // ... and so overlaps no octant of the other part.
        expect(other & (1 << o)).toBe(0);
        sim.entities.remove(e);
        checked++;
      }
    }
    expect(checked).toBe(2 * 254);
  });

  it('in a structure: the point is in the structure grid, turned into world space', () => {
    const sim = seaSim({ spawn: { x: 2.5, y: SEA_TOP, z: 7.5 } });
    const w = sim.world;
    fill(w, 0, SEA_TOP - 1, 0, 3, SEA_TOP - 1, 3, B.PLANKS_OAK);
    w.setCell(1, SEA_TOP, 1, makeCell(B.HELM, 5));
    const res = sim.structures.assembleShip(1, SEA_TOP, 1);
    if (!res.ok) throw new Error('assembly failed');
    const g = res.structure.grid;
    sim.advance(3);
    const part = makePart(B.PLANKS_OAK, 0, ~0x80 & 0xff);
    const e = dropOne(sim, g, 2, SEA_TOP - 1, 2, part);
    const at = g.toWorld({ x: 2 + DROP_POINT[0x80 * 3]!, y: SEA_TOP - 1 + DROP_POINT[0x80 * 3 + 1]!, z: 2 + DROP_POINT[0x80 * 3 + 2]! });
    const b = e.box();
    expect((b.minX + b.maxX) / 2).toBeCloseTo(at.x, 9);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(at.y, 9);
    expect((b.minZ + b.maxZ) / 2).toBeCloseTo(at.z, 9);
  });
});
