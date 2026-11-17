/**
 * Item drops of blocks, shared by mining, block updates and explosions.
 *
 * BlockDef.drop: undefined = the block drops itself (block ids double as item ids),
 * null = nothing. Block state (axis, facing, layers) is never part of the item: a sideways
 * log drops the same log item as an upright one (LESSONS 爆炸掉落朝向变体).
 */
import { ID_MASK } from '../blocks/cell';
import { isItem } from '../blocks/items';
import { BLOCKS } from '../blocks/registry';
import { vec3, type Vec3 } from '../core/math';
import type { VoxelGrid } from '../voxel/grid';
import type { Simulation } from './simulation';

/** Item id a cell drops, or -1 for nothing. */
export function dropItemOf(cell: number): number {
  const def = BLOCKS[cell & ID_MASK];
  if (def === undefined || def.drop === null) return -1;
  const item = def.drop === undefined ? def.id : def.drop.item;
  return isItem(item) ? item : -1;
}

/** Number of items a cell drops (0 for nothing). */
export function dropCountOf(cell: number): number {
  const def = BLOCKS[cell & ID_MASK];
  if (def === undefined || def.drop === null) return 0;
  return def.drop === undefined ? 1 : Math.max(0, Math.floor(def.drop.count));
}

/**
 * Spawn what `cell` drops at the centre of local cell (x,y,z) of `grid`, in world space.
 * Creative mode never drops anything (the same rule the structures module applies to
 * blockify). `tmp` is caller-owned scratch. Returns true when an item entity was spawned.
 */
export function spawnBlockDrop(sim: Simulation, grid: VoxelGrid, x: number, y: number, z: number, cell: number, tmp: Vec3 = vec3()): boolean {
  if (sim.creative) return false;
  const item = dropItemOf(cell);
  const count = dropCountOf(cell);
  if (item < 0 || count <= 0) return false;
  tmp.x = x + 0.5;
  tmp.y = y + 0.5;
  tmp.z = z + 0.5;
  grid.toWorld(tmp, tmp);
  sim.entities.spawnItem(tmp.x, tmp.y, tmp.z, item, count);
  return true;
}
