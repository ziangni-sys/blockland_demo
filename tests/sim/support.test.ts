/**
 * Support rules on partial cells (docs/SHAPES.md section 9.2): sim/support.ts supportOk on packed
 * values, and supportOkAt, which block updates use, reading the same cell from a grid's layers.
 */
import { describe, expect, it } from 'vitest';
import { CELL_MULTI_BIT, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { BLOCKS, CUTTABLE, type BlockDef } from '../../src/blocks/registry';
import { canonCell } from '../../src/blocks/shapes';
import { PX } from '../../src/core/dirs';
import { Rng } from '../../src/core/rng';
import { supportOk, supportOkAt } from '../../src/sim/support';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';
import { Chunk } from '../../src/voxel/chunk';
import type { VoxelGrid } from '../../src/voxel/grid';
import { EAST, LOWER, NORTH, SOUTH, UPPER, WEST, slab, stairFill } from '../shapes';

const TORCH = BLOCKS[B.TORCH]!;
const CACTUS = BLOCKS[B.CACTUS]!;
const STONE_DEF = BLOCKS[B.STONE]!;
/** Every block with a 'solid' support rule. */
const SOLID_SUPPORT = [B.TORCH, B.FLOWER_RED, B.FLOWER_YELLOW, B.TALL_GRASS, B.SNOW_LAYER].map((id) => BLOCKS[id]!);

/** Cells below a torch, and whether the torch stands. */
const CASES: Array<[string, number, boolean]> = [
  ['a full stone block', makeCell(B.STONE), true],
  ['a lower stone slab', slab(B.STONE, LOWER), false],
  ['an upper stone slab', slab(B.STONE, UPPER), true],
  ['an upper glass slab (hard, not opaque)', slab(B.GLASS, UPPER), true],
  ['a west half (half the top face)', slab(B.PLANKS_OAK, WEST), false],
  ['a west planks half and an east stone half (together the whole top face)', canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST)), true],
  ['a north and a south planks half (two parts of one material)', canonCell(slab(B.PLANKS_OAK, NORTH), slab(B.PLANKS_OAK, SOUTH)), true],
  ['a lower stone slab under an upper planks slab', canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER)), true],
  ['a lower planks slab beside an upper octant (top face not covered)', canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.STONE, 0x80)), false],
  ['a stair (only half the top face)', slab(B.BRICKS, stairFill(PX)), false],
  ['a full block with one upper octant carved out', slab(B.WOOL_WHITE, 0x7f), false],
  ['a full block with one lower octant carved out', slab(B.WOOL_WHITE, 0xfe), true],
  ['a single lower octant', slab(B.IRON_BLOCK, 0x01), false],
  ['air', makeCell(B.AIR), false],
  ['water', makeCell(B.WATER), false],
  ['a torch', makeCell(B.TORCH), false],
  ['sand', makeCell(B.SAND), true],
];

describe('supportOk (packed value of the cell below)', () => {
  it.each(CASES)("a torch on %s: %s", (_name, below, stands) => {
    expect(supportOk(TORCH, below)).toBe(stands);
  });

  it("every 'solid' support (torch, flowers, grass tuft, snow cover) follows the same top-face rule", () => {
    for (const def of SOLID_SUPPORT) for (const [, below, stands] of CASES) expect(supportOk(def, below), `${def.key}`).toBe(stands);
  });

  it("'none' stands on anything; 'sandOrSelf' (cactus) needs sand or cactus, never a part", () => {
    for (const [, below] of CASES) expect(supportOk(STONE_DEF, below)).toBe(true);
    expect(supportOk(CACTUS, makeCell(B.SAND))).toBe(true);
    expect(supportOk(CACTUS, makeCell(B.CACTUS))).toBe(true);
    expect(supportOk(CACTUS, makeCell(B.STONE))).toBe(false);
    expect(supportOk(CACTUS, slab(B.STONE, UPPER))).toBe(false);
    expect(supportOk(CACTUS, makeCell(B.AIR))).toBe(false);
  });

  it('a cell value with CELL_MULTI_BIT but no second part is refused (the tripwire of section 1.2)', () => {
    const cell = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER)) % 2 ** 25;
    expect(cell >= CELL_MULTI_BIT).toBe(true);
    expect(() => supportOk(TORCH, cell)).toThrow(RangeError);
  });
});

/** A one-chunk world (cells from the chunk's constructor: all air) and a structure grid on it. */
function grids(): VoxelGrid[] {
  const world = new World(1);
  world.addChunk(new Chunk(0, 0));
  return [world, new StructureGrid(7, world)];
}

/** Random cells: full blocks of every registered id, single parts and two-part cells of cuttable blocks. */
function randomCells(n: number): number[] {
  const rng = new Rng(46);
  const ids = BLOCKS.filter((d): d is BlockDef => d !== undefined && d.id !== B.UNLOADED).map((d) => d.id);
  const cuttable = ids.filter((id) => CUTTABLE[id] === 1);
  const out: number[] = ids.map((id) => makeCell(id));
  while (out.length < n) {
    const a = cuttable[rng.int(0, cuttable.length - 1)]!;
    const fill = rng.int(1, 254);
    if (rng.chance(0.5)) {
      out.push(slab(a, fill));
      continue;
    }
    const rest = ~fill & 0xff;
    let fill2 = rng.int(1, 255) & rest;
    if (fill2 === 0) fill2 = rest & -rest;
    out.push(canonCell(slab(a, fill), slab(cuttable[rng.int(0, cuttable.length - 1)]!, fill2)));
  }
  return out;
}

describe('supportOkAt (the cell below read from a grid)', () => {
  it('agrees with supportOk(getPacked(cell below)) on the world and on a structure grid, for every support kind', () => {
    const defs = [TORCH, CACTUS, STONE_DEF, ...SOLID_SUPPORT];
    const cells = randomCells(600);
    for (const g of grids()) {
      cells.forEach((below, i) => {
        const x = i & 15;
        const z = (i >> 4) & 15;
        const y = 10 + 2 * (i >> 8);
        g.setCell(x, y, z, below);
        for (const def of defs) expect(supportOkAt(def, g, x, y + 1, z), `${def.key} on ${below} (grid ${g.gridId})`).toBe(supportOk(def, below));
      });
    }
  });

  it('below the world floor (deeprock) a torch stands', () => {
    const [world] = grids();
    expect(supportOkAt(TORCH, world!, 3, 0, 3)).toBe(true);
  });
});
