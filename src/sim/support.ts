/**
 * Support rules (docs/SHAPES.md section 9.2; docs/DESIGN.md 放置与挖掘 "支撑": the top face of the
 * cell below must be fully covered by hard material): may a block with BlockDef.support stand on
 * the cell below it?
 *
 *  - 'none'       always.
 *  - 'solid'      (torch, flowers, grass tuft, snow cover) the TOP FACE of the cell below is fully
 *                 covered by hard material: a full hard block, an upper slab, two parts that
 *                 together cover the top face. Not a lower slab, not a stair's low side.
 *  - 'sandOrSelf' (cactus) the cell below is sand or cactus. Neither can be cut, so only the id
 *                 matters.
 *
 * Two entry points that always agree:
 *  - supportOk(def, below) takes the PACKED content of the cell below (blocks/cell.ts). For one-off
 *    work: placement (sim/interact.ts) reads the cell with getPacked.
 *  - supportOkAt(def, grid, x, y, z) reads the cell below (x, y - 1, z) from the grid's layers and
 *    never forms the packed value of a two-part cell (section 4.4): block updates run it from the
 *    change hooks of every write.
 * Below an unloaded chunk border or the world floor, the grid answers a full hard sentinel, so
 * nothing pops into the unknown.
 */
import { ID_MASK } from '../blocks/cell';
import { B } from '../blocks/defs';
import type { BlockDef } from '../blocks/registry';
import { faceCover, topCovered } from '../blocks/shapes';
import { PY } from '../core/dirs';
import type { VoxelGrid } from '../voxel/grid';
import { solidFillAt } from '../voxel/parts';

/** Is the support rule of `def` met by the cell below, whose packed content is `below`? */
export function supportOk(def: BlockDef, below: number): boolean {
  const support = def.support;
  if (support === 'none') return true;
  if (support === 'solid') return topCovered(below);
  const id = below & ID_MASK;
  return id === B.SAND || id === B.CACTUS;
}

/**
 * Is the support rule of `def` met for a block at (x, y, z) of `grid`? Same answer as
 * supportOk(def, getPacked(grid, x, y - 1, z)), from the layer values (solidFillAt).
 */
export function supportOkAt(def: BlockDef, grid: VoxelGrid, x: number, y: number, z: number): boolean {
  const support = def.support;
  if (support === 'none') return true;
  if (support === 'solid') return faceCover(solidFillAt(grid, x, y - 1, z), PY) === 15;
  const id = grid.getCell(x, y - 1, z) & ID_MASK;
  return id === B.SAND || id === B.CACTUS;
}
