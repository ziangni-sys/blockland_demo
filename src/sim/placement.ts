/**
 * Where a placed block goes and what the target cell holds afterwards (docs/SHAPES.md 6.2, 14.2).
 * Pure functions of a grid and a ray hit: the server carries out exactly what planPlacement plans
 * (sim/interact.ts place()), and from M2.4 on the client calls the same function on its replica
 * for the slab preview, so preview and result cannot disagree.
 *
 * A WHOLE BLOCK (slabMode -1) goes into placementCell(hit), the cell across the face the ray
 * entered the hit octant by, whether that face is a cell face or an inner face (the top of a lower
 * slab is at y + 0.5: the block goes into the cell above, half a block above the slab; DESIGN
 * "贴着半砖的顶面放整块方块"). When the part clicked is replaceable soft cover (a grass tuft, snow
 * cover) the block takes its place instead. The target must be REPLACEABLE (air, liquid, soft
 * cover): a cell with parts is hard (its first part is a cuttable, hence hard, material), so a
 * whole block never goes into a cell that has parts, and a torch or a flower in the target refuses
 * it as before. Snow cover put onto snow cover stacks (eight layers make a snow block).
 *
 * A SLAB (slabMode 0..6, M2.4: a chisel in the off-hand) is half a cell of the block's material:
 *  1. the target and its default side: an inner face clicked puts it into the clicked cell, on the
 *     side of that face (the empty half in front of it); a cell face clicked puts it into
 *     placementCell(hit), against the clicked face; replaceable soft cover clicked is replaced as
 *     for a whole block, the slab on the lower half;
 *  2. slabMode 1 + Dir puts it on that side of the same target instead;
 *  3. the target as it is now: replaceable (air, liquid, soft cover) is overwritten; with hard
 *     material the slab is merged in (blocks/shapes.ts mergeProblem: overlapping is 'occupied',
 *     a third part is 'twoParts'); a soft block that is not replaceable (a torch, a flower) is
 *     'occupied' (mergeProblem would call it MERGE_OK: no hard material to overlap, yet merging
 *     would silently overwrite it).
 *
 * What only the server decides stays in place(): the world's bounds and loaded columns, a soft
 * block into liquid, structure limits, structure membership, support, overlap with bodies and other
 * grids, the item used up.
 */
import { ID_MASK, cellState, layersState, makeCell, makePart, stateLayers } from '../blocks/cell';
import { B } from '../blocks/defs';
import { CUTTABLE, LIQUID, REPLACEABLE } from '../blocks/registry';
import { HALF_FILL, MERGE_LIMIT, MERGE_OK, isCellFace, mergeCells, mergeProblem, solidFill } from '../blocks/shapes';
import { DIR_X, DIR_Y, DIR_Z, NY, opposite, type Dir } from '../core/dirs';
import type { VoxelGrid } from '../voxel/grid';
import { getPacked } from '../voxel/parts';
import type { GridHit } from '../voxel/raycast';
import type { MessageKey } from './messages';

export interface PlacePlan {
  /** The target cell (grid-local). */
  x: number;
  y: number;
  z: number;
  /** The packed content written into the target cell (merged with the parts already there). */
  cell: number;
  /** The part value newly placed (blockPlaced carries it). */
  part: number;
  /** The target is the clicked cell: the block replaces the soft cover that was clicked (no face to glue). */
  replaces: boolean;
}

/** Why a block cannot go there: 'occupied' (toast.place.occupied) or 'twoParts' (no overlap, but the cell holds two parts already: toast.place.twoParts). */
export type PlaceRefusal = 'occupied' | 'twoParts';

/** The toast of each refusal. */
export const REFUSAL_TOAST: Readonly<Record<PlaceRefusal, MessageKey>> = Object.freeze({
  occupied: 'toast.place.occupied',
  twoParts: 'toast.place.twoParts',
});

/** Is the part hit replaceable soft cover that a placed block takes the place of (a grass tuft, snow cover; never liquid)? */
function replacesHit(hit: GridHit): boolean {
  const id = hit.part & ID_MASK;
  return REPLACEABLE[id] === 1 && LIQUID[id] === 0;
}

function checkMode(slabMode: number): void {
  if (!Number.isInteger(slabMode) || slabMode < -1 || slabMode > 6) throw new RangeError(`slabMode ${slabMode} is not -1..6`);
}

/**
 * The target cell of a placement (see the file comment): the clicked cell when the soft cover
 * clicked is replaced, or when a slab goes in front of an inner face; else the cell across the
 * entered face. Throws RangeError for a slabMode outside -1..6.
 */
export function placementTarget(hit: GridHit, slabMode: number): { x: number; y: number; z: number } {
  checkMode(slabMode);
  if (replacesHit(hit) || (slabMode >= 0 && !isCellFace(hit.octant, hit.face))) return { x: hit.x, y: hit.y, z: hit.z };
  return { x: hit.x + DIR_X[hit.face]!, y: hit.y + DIR_Y[hit.face]!, z: hit.z + DIR_Z[hit.face]! };
}

/**
 * Plan putting block `blockId` with state bits `state` (in the grid's frame) against `hit`
 * (see the file comment). slabMode: -1 a whole block; 0 a slab against the clicked face; 1 + Dir
 * a slab on that side of the target cell. Throws RangeError for a slabMode outside -1..6, and for
 * a slab of a block that cannot be cut (registry CUTTABLE: the caller places those whole).
 */
export function planPlacement(grid: VoxelGrid, hit: GridHit, blockId: number, state: number, slabMode: number): PlacePlan | PlaceRefusal {
  checkMode(slabMode);
  const replaces = replacesHit(hit);
  const t = placementTarget(hit, slabMode);
  if (slabMode < 0) {
    const cur = grid.getCell(t.x, t.y, t.z);
    const curId = cur & ID_MASK;
    if (REPLACEABLE[curId] !== 1) return 'occupied';
    let cell: number;
    if (blockId === B.SNOW_LAYER && curId === B.SNOW_LAYER) {
      const layers = stateLayers(cellState(cur)) + 1;
      cell = layers >= 8 ? makeCell(B.SNOW_BLOCK) : makeCell(B.SNOW_LAYER, layersState(layers));
    } else {
      cell = makeCell(blockId, state);
    }
    return { x: t.x, y: t.y, z: t.z, cell, part: cell, replaces };
  }
  if (CUTTABLE[blockId & ID_MASK] !== 1) throw new RangeError(`block ${blockId} cannot be cut into a slab`);
  let side: Dir;
  if (slabMode >= 1) side = (slabMode - 1) as Dir;
  else if (replaces) side = NY;
  else if (!isCellFace(hit.octant, hit.face)) side = hit.face;
  else side = opposite(hit.face);
  const part = makePart(blockId, state, ~HALF_FILL[side]! & 0xff);
  const cur = getPacked(grid, t.x, t.y, t.z);
  if (REPLACEABLE[cur & ID_MASK] === 1) return { x: t.x, y: t.y, z: t.z, cell: part, part, replaces };
  if (solidFill(cur) === 0) return 'occupied';
  const problem = mergeProblem(cur, part);
  if (problem === MERGE_OK) return { x: t.x, y: t.y, z: t.z, cell: mergeCells(cur, part), part, replaces };
  return problem === MERGE_LIMIT ? 'twoParts' : 'occupied';
}
