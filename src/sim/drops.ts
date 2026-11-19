/**
 * Item drops of blocks, shared by mining, block updates and explosions.
 *
 * ONE PART, ONE DROP (docs/SHAPES.md section 9.5; docs/DESIGN.md "一个部件对应一个物品"). The value
 * these functions take is a PART value (blocks/cell.ts: id, state, holes): what a part drops
 * depends on its material only, never on how many octants it still has; chiselled-off octants
 * drop nothing. A full block is a part with no holes, so it drops exactly as before.
 *
 * The three functions read only the bits they need and never throw on what they are given: a
 * cell value with CELL_MULTI_BIT, or the packed content of a two-part cell, reads as its first
 * part (bitwise operations see the low 32 bits). The callers in other packages can therefore pass
 * what they have, before and after their own package changes (section 16.3, rule 3).
 *
 * BlockDef.drop: undefined = the block drops itself (block ids double as item ids),
 * null = nothing. Block state (axis, facing, layers) is never part of the item: a sideways
 * log drops the same log item as an upright one (LESSONS 爆炸掉落朝向变体).
 */
import { ID_MASK, partHoles } from '../blocks/cell';
import { isItem } from '../blocks/items';
import { BLOCKS } from '../blocks/registry';
import { DROP_POINT } from '../blocks/shapes';
import { vec3, type Vec3 } from '../core/math';
import type { VoxelGrid } from '../voxel/grid';
import type { Simulation } from './simulation';

/** Item id a part drops, or -1 for nothing. Reads only the id bits. */
export function dropItemOf(part: number): number {
  const def = BLOCKS[part & ID_MASK];
  if (def === undefined || def.drop === null) return -1;
  const item = def.drop === undefined ? def.id : def.drop.item;
  return isItem(item) ? item : -1;
}

/** Number of items a part drops (0 for nothing). Reads only the id bits. */
export function dropCountOf(part: number): number {
  const def = BLOCKS[part & ID_MASK];
  if (def === undefined || def.drop === null) return 0;
  return def.drop === undefined ? 1 : Math.max(0, Math.floor(def.drop.count));
}

/**
 * Spawn what `part` drops in local cell (x,y,z) of `grid`, in world space. The item's feet are at
 * the cell's minimum corner plus DROP_POINT of the part's fill (blocks/shapes.ts): the centre of a
 * full block, else the centre of the part's lowest-numbered octant, which the removed part leaves
 * empty, so the item never starts inside the other part of the cell.
 *
 * Unconditional: the caller decides whether this drop happens at all (sim/rules.ts — the mining
 * player's mode, or the world's dropsEnabled). `tmp` is caller-owned scratch. Returns true when
 * an item entity was spawned.
 */
export function spawnBlockDrop(sim: Simulation, grid: VoxelGrid, x: number, y: number, z: number, part: number, tmp: Vec3 = vec3()): boolean {
  const item = dropItemOf(part);
  const count = dropCountOf(part);
  if (item < 0 || count <= 0) return false;
  const at = (~partHoles(part) & 0xff) * 3;
  tmp.x = x + DROP_POINT[at]!;
  tmp.y = y + DROP_POINT[at + 1]!;
  tmp.z = z + DROP_POINT[at + 2]!;
  grid.toWorld(tmp, tmp);
  sim.entities.spawnItem(tmp.x, tmp.y, tmp.z, item, count);
  return true;
}
