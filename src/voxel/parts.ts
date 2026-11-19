/**
 * Whole-cell reads and writes on any VoxelGrid (docs/SHAPES.md section 4.4).
 *
 * A grid stores a cell in three layers; getCell returns the CELL value (first part plus
 * CELL_MULTI_BIT, < 2^25) and getPart2 the second part. Everything that treats a cell as one
 * number uses the PACKED cell (blocks/cell.ts): read it with getPacked, copy it with copyCell,
 * never `dst.setCell(..., src.getCell(...))` (that throws on the first two-part cell, by design).
 *
 * Every change of a cell is "read the packed cell, compute the new one with the functions of
 * blocks/shapes.ts section 3.3, one setCell": so one change is one event, and listeners never
 * see a cell half merged.
 *
 * Point queries take INTEGER half-cell coordinates only (h = floor(local * 2)), never
 * fractional coordinates: V8 boxes a freshly computed non-integer passed to a function that is
 * not inlined (section 4.4), and these run hundreds of times per tick.
 */
import {
  CELL_MULTI_BIT,
  HOLES_SHIFT,
  ID_MASK,
  PACK_SCALE,
  PART_LIMIT,
  PART_MASK,
} from '../blocks/cell';
import { SOLID } from '../blocks/registry';
import {
  canonCell,
  MERGE_OK,
  mergeCells,
  mergeProblem,
  partAt,
  withOctant,
  withoutOctant,
  withoutPartAt,
} from '../blocks/shapes';
import type { VoxelGrid } from './grid';

/**
 * RangeError unless `packed` is a packed cell in canonical form: a non-negative integer below
 * 2^49 that satisfies the invariants I1-I6 of section 1.3 (id 0 only for the value 0;
 * CELL_MULTI_BIT exactly when there is a second part; no part without octants; holes only on
 * cuttable materials; two parts both holed, disjoint and in order). Ids need not be registered
 * (that is cellProblem's job at the untrusted boundaries). World.setCell and StructureGrid.setCell
 * call it for every value >= FULL_LIMIT; full-block values below it are never checked (1.3, 3.4).
 */
export function checkCanonical(packed: number): void {
  if (!Number.isInteger(packed) || packed < 0 || packed >= PACK_SCALE * PART_LIMIT) {
    throw new RangeError(`not a packed cell: ${packed}`);
  }
  const cell = packed % PACK_SCALE;
  const p2 = Math.floor(packed / PACK_SCALE);
  if ((cell >= CELL_MULTI_BIT) !== (p2 !== 0)) {
    throw new RangeError(
      p2 === 0
        ? `cell ${packed} has CELL_MULTI_BIT but no second part (copy cells with getPacked / copyCell, not getCell)`
        : `second part without CELL_MULTI_BIT in ${packed}`,
    );
  }
  if (cell !== 0 && (cell & ID_MASK) === 0) throw new RangeError(`id 0 in a non-empty cell value ${packed}`);
  // canonCell checks each part (id, holes not 0xff, holes only when cuttable) and the overlap,
  // and returns the canonical order; a different result means the parts are out of order.
  if (canonCell(cell & PART_MASK, p2) !== packed) throw new RangeError(`cell ${packed} is not in canonical form (parts out of order)`);
}

function checkOctant(octant: number): void {
  if (!(octant >= 0 && octant < 8) || !Number.isInteger(octant)) throw new RangeError(`not an octant: ${octant}`);
}

/** The packed cell (both parts) at integer local coordinates. */
export function getPacked(grid: VoxelGrid, x: number, y: number, z: number): number {
  const c = grid.getCell(x, y, z);
  return c < CELL_MULTI_BIT ? c : c + grid.getPart2(x, y, z) * PACK_SCALE;
}

/** Copy the whole cell (both parts) from src to dst with one setCell. Returns setCell's result. */
export function copyCell(
  src: VoxelGrid,
  sx: number,
  sy: number,
  sz: number,
  dst: VoxelGrid,
  dx: number,
  dy: number,
  dz: number,
  flags?: number,
): boolean {
  return dst.setCell(dx, dy, dz, getPacked(src, sx, sy, sz), flags);
}

/**
 * Octants of the cell occupied by hard material: solidFill(getPacked(grid, x, y, z)), computed
 * from the two layer values as 32-bit integers. The packed value of a two-part cell is a double
 * above 2^31; forming it and passing it on would box it (16 bytes) on every call that V8 does not
 * inline, and this runs hundreds of times per tick (section 4.4, section 15).
 */
export function solidFillAt(grid: VoxelGrid, x: number, y: number, z: number): number {
  const c = grid.getCell(x, y, z);
  // ~holes of the cell value is the first part's fill (a full block has holes 0: 0xff).
  let fill = SOLID[c & ID_MASK] !== 0 ? ~(c >>> HOLES_SHIFT) & 0xff : 0;
  if (c >= CELL_MULTI_BIT) {
    const p2 = grid.getPart2(x, y, z);
    if (SOLID[p2 & ID_MASK] !== 0) fill |= ~(p2 >>> HOLES_SHIFT) & 0xff;
  }
  return fill;
}

/**
 * Is the octant at half-cell coordinates (hx, hy, hz) (integers) occupied by hard material? The
 * cell is (hx >> 1, hy >> 1, hz >> 1), the octant (hx & 1) | (hy & 1) << 1 | (hz & 1) << 2.
 * Allocation free whether inlined or not (it never forms a packed value, see solidFillAt).
 */
export function solidAtHalf(grid: VoxelGrid, hx: number, hy: number, hz: number): boolean {
  const fill = solidFillAt(grid, hx >> 1, hy >> 1, hz >> 1);
  return ((fill >> ((hx & 1) | ((hy & 1) << 1) | ((hz & 1) << 2))) & 1) !== 0;
}

/**
 * Remove the part containing this octant (mining, explosions, crushing). Returns the removed
 * part value, or 0 when the octant is empty or the grid refused the write (an unloaded chunk).
 * Throws RangeError for an octant outside 0..7.
 */
export function removePartAt(grid: VoxelGrid, x: number, y: number, z: number, octant: number, flags?: number): number {
  checkOctant(octant);
  const c = getPacked(grid, x, y, z);
  const p = partAt(c, octant);
  if (p === 0) return 0;
  return grid.setCell(x, y, z, withoutPartAt(c, octant), flags) ? p : 0;
}

/**
 * Merge a part into this cell. Returns mergeProblem(cell, part) and writes only on MERGE_OK. A
 * target without hard material (air, liquid, soft block) is simply overwritten with the part;
 * whether an overwritten soft block drops is the caller's business, decided before the call.
 */
export function addPartAt(grid: VoxelGrid, x: number, y: number, z: number, part: number, flags?: number): 0 | 1 | 2 {
  const c = getPacked(grid, x, y, z);
  const problem = mergeProblem(c, part);
  if (problem !== MERGE_OK) return problem;
  grid.setCell(x, y, z, mergeCells(c, part), flags);
  return MERGE_OK;
}

/**
 * Carve one octant out of the cell (the M2.4 chisel); a part losing its last octant is removed.
 * Returns false when the octant is empty (nothing changed) or the grid refused the write.
 * Throws RangeError when the octant belongs to a block that cannot be cut (check CUTTABLE first)
 * and for an octant outside 0..7.
 */
export function removeOctantAt(grid: VoxelGrid, x: number, y: number, z: number, octant: number, flags?: number): boolean {
  const c = getPacked(grid, x, y, z);
  const next = withoutOctant(c, octant);
  if (next === c) return false;
  return grid.setCell(x, y, z, next, flags);
}

/**
 * Give the part containing partOctant the octant `octant` back (the M2.4 chisel's restore); a
 * part filled back to 8 octants becomes a full block. Returns false, changing nothing, when
 * `octant` is not empty or partOctant holds no part, or when the grid refused the write.
 * Throws RangeError for an octant outside 0..7.
 */
export function restoreOctantAt(
  grid: VoxelGrid,
  x: number,
  y: number,
  z: number,
  partOctant: number,
  octant: number,
  flags?: number,
): boolean {
  checkOctant(partOctant);
  checkOctant(octant);
  const c = getPacked(grid, x, y, z);
  if (partAt(c, octant) !== 0 || partAt(c, partOctant) === 0) return false;
  return grid.setCell(x, y, z, withOctant(c, partOctant, octant), flags);
}
