/**
 * Child-process probe for tests/voxel/parts-alloc.test.ts (not a test file itself): heap bytes
 * per call of the per-tick point queries of voxel/parts.ts (solidAtHalf, solidFillAt) on full
 * blocks, single parts with holes and two-part cells, in the World and in a StructureGrid.
 * docs/SHAPES.md 4.4 and 15: sneaking on a deck calls solidAtHalf hundreds of times per tick per
 * structure, so these must not allocate whether V8 inlines them or not.
 *
 * getPacked is deliberately absent: it returns the packed value, which for a two-part cell is a
 * double above 2^31 that any non-inlined call must box; per-tick code reads the layers instead.
 */
import { makeCell, makePart } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { Chunk } from '../../src/voxel/chunk';
import { solidAtHalf, solidFillAt } from '../../src/voxel/parts';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';
import { measureCases } from '../heap-probe';

const world = new World();
world.addChunk(new Chunk(0, 0));
const ship = new StructureGrid(1, world);
const SLAB = makePart(B.PLANKS_OAK, 0, 0xcc);
const TWO = canonCell(makePart(B.PLANKS_OAK, 0, 0xcc), makePart(B.STONE, 0, 0x33));
for (const g of [world, ship]) {
  for (let x = 0; x < 8; x++) {
    g.setCell(x, 10, 1, makeCell(B.PLANKS_OAK)); // a row of full blocks
    g.setCell(x, 10, 2, SLAB); // a row of half slabs
    g.setCell(x, 10, 3, TWO); // a row of two-part cells
  }
}

// One function per case so each gets its own optimised code and feedback.
const half = (g: World | StructureGrid, z: number) => (n: number): number => {
  let s = 0;
  for (let i = 0; i < n; i++) if (solidAtHalf(g, i & 15, 20 + (i & 1), z * 2 + ((i >> 1) & 1))) s++;
  return s;
};
const fill = (g: World | StructureGrid, z: number) => (n: number): number => {
  let s = 0;
  for (let i = 0; i < n; i++) s += solidFillAt(g, i & 7, 10, z);
  return s;
};

await measureCases({
  'solidAtHalf world, full blocks': half(world, 1),
  'solidAtHalf world, half slabs': half(world, 2),
  'solidAtHalf world, two-part cells': half(world, 3),
  'solidAtHalf ship, full blocks': half(ship, 1),
  'solidAtHalf ship, half slabs': half(ship, 2),
  'solidAtHalf ship, two-part cells': half(ship, 3),
  'solidFillAt world, half slabs': fill(world, 2),
  'solidFillAt world, two-part cells': fill(world, 3),
  'solidFillAt ship, half slabs': fill(ship, 2),
  'solidFillAt ship, two-part cells': fill(ship, 3),
});
