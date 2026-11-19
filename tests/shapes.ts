/**
 * Shared test helpers for partial blocks (docs/SHAPES.md section 14.1): the VALUE part (package
 * P1: fills, slab, stairFill) and the GRID part (package P2: putPart, partsAt, partLabels), which
 * work on any VoxelGrid through voxel/parts.ts.
 */
import type { Dir } from '../src/core/dirs';
import { cellPrimary, cellSecond, ID_MASK, makePart, PART_MASK, partHoles, STATE_MASK, STATE_SHIFT } from '../src/blocks/cell';
import { BLOCKS } from '../src/blocks/registry';
import { HALF_FILL, MERGE_OK } from '../src/blocks/shapes';
import type { CellBounds, VoxelGrid } from '../src/voxel/grid';
import { addPartAt, getPacked } from '../src/voxel/parts';

/** Common fills: lower, upper, west (-X), east (+X), north (-Z), south (+Z) half. */
export const LOWER = 0x33, UPPER = 0xcc, WEST = 0x55, EAST = 0xaa, NORTH = 0x0f, SOUTH = 0xf0;

/** The part value of block `id` filling the octants `fill` (1..0xff; 0xff is the full block). */
export function slab(id: number, fill: number, state = 0): number {
  if (!Number.isInteger(fill) || fill <= 0 || fill > 0xff) throw new RangeError(`not a part fill: ${fill}`);
  return makePart(id, state, ~fill & 0xff);
}

/** A stair: the lower half plus the two upper octants on side `high` (a horizontal direction). */
export function stairFill(high: Dir): number {
  if (high >> 1 === 1) throw new RangeError(`a stair rises toward a horizontal direction, not ${high}`);
  return LOWER | (HALF_FILL[high]! & UPPER);
}

/** Merge a part into the cell (voxel/parts.ts addPartAt); throws when it does not fit (overlap or a third part). */
export function putPart(grid: VoxelGrid, x: number, y: number, z: number, part: number): void {
  const problem = addPartAt(grid, x, y, z, part);
  if (problem !== MERGE_OK) throw new Error(`putPart: part ${part} does not fit cell ${x},${y},${z} (mergeProblem ${problem})`);
}

/** The parts of a cell in storage order (first part first): id, state and occupied octants. */
export function partsAt(grid: VoxelGrid, x: number, y: number, z: number): Array<{ id: number; state: number; fill: number }> {
  const packed = getPacked(grid, x, y, z);
  const out: Array<{ id: number; state: number; fill: number }> = [];
  for (const p of [cellPrimary(packed) & PART_MASK, cellSecond(packed)]) {
    if ((p & ID_MASK) === 0) continue;
    out.push({ id: p & ID_MASK, state: (p >>> STATE_SHIFT) & STATE_MASK, fill: ~partHoles(p) & 0xff });
  }
  return out;
}

/**
 * Every non-empty cell of the box as "x,y,z:key[ff]+key[ff]" (block key, then the fill in hex;
 * a state other than 0 as "key/state[ff]"), sorted: e.g. "1,2,3:planks_oak[33]+stone[cc]".
 */
export function partLabels(grid: VoxelGrid, box: CellBounds): string[] {
  const out: string[] = [];
  for (let y = box.minY; y < box.maxY; y++) {
    for (let z = box.minZ; z < box.maxZ; z++) {
      for (let x = box.minX; x < box.maxX; x++) {
        const parts = partsAt(grid, x, y, z);
        if (parts.length === 0) continue;
        const names = parts.map((p) => `${BLOCKS[p.id]?.key ?? `#${p.id}`}${p.state !== 0 ? `/${p.state}` : ''}[${p.fill.toString(16).padStart(2, '0')}]`);
        out.push(`${x},${y},${z}:${names.join('+')}`);
      }
    }
  }
  return out.sort();
}
