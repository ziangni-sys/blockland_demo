/**
 * Liquids and partial cells (docs/SHAPES.md section 9.1): liquid never flows into a cell with
 * parts. src/liquid/fluids.ts has no code for it: every decision there reads IS_SOLID of the base
 * layer's id, and a cell with any part has a hard first part (invariant I7). These tests guard the
 * invariant and its consequences: a random property run, water around slabs, water flowing in once
 * the last part is gone, carving (hard to hard) not waking slope searches, infinite sources over
 * slabs, and a part placed into a liquid cell.
 */
import { describe, expect, it } from 'vitest';
import { AIR, CELL_MULTI_BIT, HOLES_SHIFT, ID_MASK, cellPrimary, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { CUTTABLE, LIQUID, SOLID } from '../../src/blocks/registry';
import { canonCell, cellProblem, partAt } from '../../src/blocks/shapes';
import { PX } from '../../src/core/dirs';
import { Rng } from '../../src/core/rng';
import type { World } from '../../src/voxel/world';
import { addPartAt, getPacked, removeOctantAt, removePartAt } from '../../src/voxel/parts';
import { pumpTicks } from '../../src/liquid/fluids';
import { EAST, LOWER, NORTH, SOUTH, UPPER, WEST, slab, stairFill } from '../shapes';
import {
  FLOOR_Y,
  STONE,
  SURFACE,
  amountAt,
  buildWorld,
  isSourceAt,
  lava,
  liquidCells,
  pumpUntilQuiet,
  water,
  type CellFn,
} from './helpers';

/** Partial cells of every kind (one part with holes, two parts, a filled two-part cell, a stair, single octants). */
const PARTIAL: readonly number[] = [
  slab(B.STONE, LOWER),
  slab(B.GLASS, UPPER),
  slab(B.PLANKS_OAK, WEST),
  slab(B.PLANKS_OAK, EAST),
  slab(B.BRICKS, stairFill(PX)),
  slab(B.IRON_BLOCK, 0x01),
  slab(B.WOOL_WHITE, 0x7f),
  canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER)),
  canonCell(slab(B.PLANKS_OAK, NORTH), slab(B.PLANKS_OAK, SOUTH)),
  canonCell(slab(B.STONE, 0x01), slab(B.GLASS, 0x80)),
];

/**
 * I7 over a box of the world, read twice: through getCell / getPart2 and straight from the chunk
 * layers that the liquid engine reads. Also: every cell is canonical and no partial cell holds liquid.
 */
function checkI7(world: World, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  let partial = 0;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const c = world.getCell(x, y, z);
        const holes = (c >>> HOLES_SHIFT) & 0xff;
        expect(cellProblem(getPacked(world, x, y, z))).toBeNull();
        if (holes === 0 && c < CELL_MULTI_BIT) continue;
        partial++;
        // The base layer, as fluids.ts reads it (scanColumns, slopeDirections, peek).
        const chunk = world.getChunk(x >> 4, z >> 4)!;
        const base = chunk.cells[(x & 15) | ((z & 15) << 4) | (y << 8)]!;
        expect(base).toBe(c & 0xffff);
        expect(SOLID[base & ID_MASK], `I7 at ${x},${y},${z}: ${c}`).toBe(1);
        expect(LIQUID[base & ID_MASK]).toBe(0);
        if (c >= CELL_MULTI_BIT) expect(SOLID[world.getPart2(x, y, z) & ID_MASK]).toBe(1);
      }
    }
  }
  return partial;
}

describe('invariant I7: a cell with parts has a hard id in the base layer', () => {
  it('holds after random placing, carving and mining among flowing water and lava', () => {
    const fw = buildWorld();
    const { world } = fw;
    const rng = new Rng(707);
    const cuttable: number[] = [];
    for (let id = 1; id < 1024; id++) if (CUTTABLE[id] === 1) cuttable.push(id);
    const full = [STONE, makeCell(B.SAND), makeCell(B.TORCH), makeCell(B.FLOWER_RED), water(), lava(), water(3), AIR];
    // A box of 8 x 4 x 8 on the platform, with water and lava sources around it.
    const X0 = 4, Z0 = 4, X1 = 11, Z1 = 11, Y0 = SURFACE, Y1 = SURFACE + 3;
    world.setCell(3, SURFACE + 3, 7, water());
    world.setCell(12, SURFACE + 3, 7, lava());
    let partial = 0;
    for (let step = 0; step < 3000; step++) {
      const x = rng.int(X0, X1);
      const y = rng.int(Y0, Y1);
      const z = rng.int(Z0, Z1);
      const o = rng.int(0, 7);
      const op = rng.int(0, 9);
      if (op <= 3) {
        const id = cuttable[rng.int(0, cuttable.length - 1)]!;
        addPartAt(world, x, y, z, slab(id, rng.int(1, 255)));
      } else if (op <= 5) {
        const p = partAt(getPacked(world, x, y, z), o);
        if (p !== 0 && CUTTABLE[p & ID_MASK] === 1) removeOctantAt(world, x, y, z, o);
      } else if (op <= 7) {
        removePartAt(world, x, y, z, o);
      } else if (op === 8) {
        world.setCell(x, y, z, full[rng.int(0, full.length - 1)]!);
      } else {
        pumpTicks(world, fw.fluids, rng.int(1, 12));
      }
      if (step % 50 === 0) partial += checkI7(world, X0 - 1, Y0, Z0 - 1, X1 + 1, Y1, Z1 + 1);
    }
    pumpUntilQuiet(fw, 20_000);
    partial += checkI7(world, X0 - 2, Y0 - 1, Z0 - 2, X1 + 2, Y1 + 1, Z1 + 2);
    expect(partial).toBeGreaterThan(1000); // the run did build many partial cells
  });
});

describe('scenario 46 in the liquid engine: water does not flow into a cell with parts', () => {
  it('water flowing past a row of partial cells never enters one; over a lower slab it rests in the cell above', () => {
    const fw = buildWorld();
    const { world } = fw;
    PARTIAL.forEach((c, i) => world.setCell(4 + i, SURFACE, 9, c));
    world.setCell(9, SURFACE, 7, water());
    pumpUntilQuiet(fw);
    PARTIAL.forEach((c, i) => expect(getPacked(world, 4 + i, SURFACE, 9), `cell ${i}`).toBe(c));
    // The water reached all around them (the row is within the diamond of the source).
    for (let i = 0; i < PARTIAL.length; i++) expect(amountAt(world, 4 + i, SURFACE, 8)).toBeGreaterThan(0);
    // A source over a lower slab: it stays one cell up, a floor for the flow.
    world.setCell(20, SURFACE, 20, slab(B.STONE, LOWER));
    world.setCell(20, SURFACE + 1, 20, water());
    pumpUntilQuiet(fw);
    expect(getPacked(world, 20, SURFACE, 20)).toBe(slab(B.STONE, LOWER));
    expect(isSourceAt(world, 20, SURFACE + 1, 20, B.WATER)).toBe(true);
    // Beside it, the flow reaches the floor (SURFACE) as usual.
    expect(amountAt(world, 21, SURFACE, 20)).toBeGreaterThan(0);
  });

  it('a pool walled in by partial cells keeps its shape: the walls hold it like full blocks', () => {
    const ring: CellFn = (x, y, z) => {
      if (y === FLOOR_Y) return STONE;
      if (y !== SURFACE) return AIR;
      const edge = (x === 6 || x === 10) && z >= 6 && z <= 10 ? true : (z === 6 || z === 10) && x >= 6 && x <= 10;
      return edge ? PARTIAL[(x + z) % PARTIAL.length]! : AIR;
    };
    const fw = buildWorld(ring);
    fw.world.setCell(8, SURFACE, 8, water());
    pumpUntilQuiet(fw);
    const wet = liquidCells(fw.world).map((c) => `${c.x},${c.y},${c.z}`);
    expect(wet).toHaveLength(9); // the 3 x 3 inside, nothing outside
    for (const c of liquidCells(fw.world)) {
      expect(c.x >= 7 && c.x <= 9 && c.z >= 7 && c.z <= 9).toBe(true);
    }
  });

  it('once the last part of a cell is gone, water flows in; carving it down octant by octant lets nothing in before that', () => {
    const fw = buildWorld();
    const { world } = fw;
    const two = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER));
    world.setCell(9, SURFACE, 8, two);
    world.setCell(8, SURFACE, 8, water());
    pumpUntilQuiet(fw);
    expect(getPacked(world, 9, SURFACE, 8)).toBe(two);
    // Mine one part: the other one still keeps the water out.
    expect(removePartAt(world, 9, SURFACE, 8, 7)).not.toBe(0);
    pumpUntilQuiet(fw);
    expect(getPacked(world, 9, SURFACE, 8)).toBe(slab(B.STONE, LOWER));
    // Carve the rest away, one octant at a time.
    for (const o of [0, 1, 4]) {
      expect(removeOctantAt(world, 9, SURFACE, 8, o)).toBe(true);
      pumpUntilQuiet(fw);
      expect(world.getCell(9, SURFACE, 8) & ID_MASK).toBe(B.STONE);
    }
    expect(removeOctantAt(world, 9, SURFACE, 8, 5)).toBe(true); // the last octant: the cell is empty
    expect(world.getCell(9, SURFACE, 8)).toBe(AIR);
    pumpUntilQuiet(fw);
    expect(amountAt(world, 9, SURFACE, 8)).toBe(7);
  });

  it('carving (hard to hard) does not wake the slope search; removing the cell does', () => {
    // Source at (8, S, 8) running north to the only hole at (8, FLOOR_Y, 4); a floor cell 3 east of it.
    const floor: CellFn = (x, y, z) => (y === 4 ? STONE : y === FLOOR_Y ? (x === 8 && z === 4 ? AIR : STONE) : AIR);
    const fw = buildWorld(floor);
    const { world } = fw;
    world.setCell(8, SURFACE, 8, water());
    pumpUntilQuiet(fw);
    // Carve an upper octant out of the floor cell: still hard, so no search can see a difference.
    expect(removeOctantAt(world, 11, FLOOR_Y, 8, 7)).toBe(true);
    expect(world.ticks.size).toBe(0);
    pumpUntilQuiet(fw);
    expect(amountAt(world, 11, FLOOR_Y, 8)).toBe(0);
    expect(world.getCell(11, FLOOR_Y, 8) & ID_MASK).toBe(B.STONE);
    // Removing the cell opens a hole within slope reach: the source wakes and pours east too.
    world.setCell(11, FLOOR_Y, 8, AIR);
    expect(world.ticks.has(8, SURFACE, 8, B.WATER)).toBe(true);
    pumpUntilQuiet(fw);
    expect(world.getCell(11, FLOOR_Y, 8) & ID_MASK).toBe(B.WATER);
  });

  it('an infinite source forms over a lower slab (a cell with parts is hard ground), not over air', () => {
    const gap = (below: number): boolean => {
      const fw = buildWorld((x, y, z) => (y === 4 ? STONE : y === FLOOR_Y ? (x === 9 && z === 8 ? below : STONE) : AIR));
      fw.world.setCell(8, SURFACE, 8, water());
      fw.world.setCell(10, SURFACE, 8, water());
      pumpUntilQuiet(fw);
      return isSourceAt(fw.world, 9, SURFACE, 8, B.WATER);
    };
    expect(gap(slab(B.STONE, LOWER))).toBe(true);
    expect(gap(slab(B.IRON_BLOCK, 0x01))).toBe(true);
    expect(gap(AIR)).toBe(false);
  });

  it('a part put into a water cell replaces the water; its empty half stays dry and nothing flows back in', () => {
    const fw = buildWorld();
    const { world } = fw;
    for (let x = 6; x <= 10; x++) for (let z = 6; z <= 10; z++) world.setCell(x, SURFACE, z, water());
    pumpUntilQuiet(fw);
    expect(addPartAt(world, 8, SURFACE, 8, slab(B.STONE, LOWER))).toBe(0);
    pumpUntilQuiet(fw);
    expect(getPacked(world, 8, SURFACE, 8)).toBe(slab(B.STONE, LOWER));
    expect(cellPrimary(getPacked(world, 8, SURFACE, 8)) & ID_MASK).toBe(B.STONE);
    expect(isSourceAt(world, 7, SURFACE, 8, B.WATER)).toBe(true);
  });
});
