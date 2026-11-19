/**
 * Independent reference implementations for the ray tests (docs/SHAPES.md 6.1, package P8a).
 *
 * referenceRay: brute force over the BOXES of the occupied octants. For every listed cell it
 * reads the grid's packed content (voxel/parts.ts getPacked) and, for every octant whose part
 * (blocks/shapes.ts partAt) the predicate accepts, intersects the local ray with that octant's
 * half-cell box (slab method), keeping the earliest entry. A cell value below FULL_LIMIT is one
 * part filling all eight octants (partAt returns the cell itself), so for a world of full blocks
 * this is the unit-cube reference of M1 cut into eight. It shares no code with raycast.ts's DDA,
 * but follows the same documented conventions: a box is on the ray only if the ray runs a
 * POSITIVE length through it (touching an edge or a corner is not a hit), boxes are half-open
 * along axes the ray does not move on, and a box entered at exactly maxDist counts.
 *
 * fullCellOctant: the octant rule of 6.1 for a cell below FULL_LIMIT, written from the entry POINT
 * as the specification states it (raycast.ts decides it from ray parameters instead).
 */
import { partAt } from '../../src/blocks/shapes';
import { NX, NY, NZ, PX, PY, PZ, nearestDir, opposite, type Dir } from '../../src/core/dirs';
import type { Vec3 } from '../../src/core/math';
import type { VoxelGrid } from '../../src/voxel/grid';
import { getPacked } from '../../src/voxel/parts';
import { targetable, type CellPredicate } from '../../src/voxel/raycast';

export interface RefHit {
  /** The cell. */
  x: number;
  y: number;
  z: number;
  /** Entry distance (0 when the origin is inside the box). */
  t: number;
  /** The octant whose box is entered first (lowest octant number among exact ties). */
  octant: number;
  /** partAt(packed cell, octant). */
  part: number;
  /** The packed cell. */
  cell: number;
  /**
   * The face the ray enters that box through: the axis whose slab is entered last, the steepest
   * among exact ties (x, y, z order on equal slopes); when the origin is inside the box, the face
   * opposite to the dominant direction. Only meaningful when no other box ties at `t`.
   */
  face: Dir;
  /** The box is entered exactly through an edge or corner (another axis's slab is entered at `t` too). */
  faceTie: boolean;
  /** Entry distance of the next box along the ray (another octant or cell); Infinity when none. */
  runnerUp: number;
}

const FACE_IN: readonly (readonly [Dir, Dir])[] = [
  [NX, PX],
  [NY, PY],
  [NZ, PZ],
];

/** Entry of the local ray o + s·d into the box [lo, lo + size)^3, or null (positive length only). */
function boxEntry(
  o: readonly number[],
  d: readonly number[],
  lo: readonly number[],
  size: number,
  maxDist: number,
): { t: number; axis: number; tied: boolean } | null {
  let t0 = 0;
  let t1 = Infinity;
  let axis = -1;
  let slope = -1;
  let tied = false;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]!) < 1e-14) {
      if (o[a]! < lo[a]! || o[a]! >= lo[a]! + size) return null;
      continue;
    }
    let tn = (lo[a]! - o[a]!) / d[a]!;
    let tf = (lo[a]! + size - o[a]!) / d[a]!;
    if (tn > tf) [tn, tf] = [tf, tn];
    if (tn > t0) tied = false;
    else if (tn === t0 && axis >= 0) tied = true;
    if (tn > t0 || (tn === t0 && axis >= 0 && Math.abs(d[a]!) > slope)) {
      t0 = tn;
      axis = a;
      slope = Math.abs(d[a]!);
    }
    if (tf < t1) t1 = tf;
  }
  if (!(t0 < t1) || t0 > maxDist) return null;
  return { t: t0, axis, tied };
}

/**
 * Brute-force octant ray cast against the listed cells of `grid` (see the file comment).
 * `origin` and `dir` are in world space, `dir` unit length.
 */
export function referenceRay(
  grid: VoxelGrid,
  cells: ReadonlyArray<readonly [number, number, number]>,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  pred: CellPredicate = targetable,
): RefHit | null {
  const lo = grid.toLocal(origin);
  const ld = grid.dirToLocal(dir);
  const o = [lo.x, lo.y, lo.z];
  const d = [ld.x, ld.y, ld.z];
  let best: RefHit | null = null;
  let runnerUp = Infinity;
  for (const [x, y, z] of cells) {
    const packed = getPacked(grid, x, y, z);
    for (let oct = 0; oct < 8; oct++) {
      const part = partAt(packed, oct);
      if (part === 0 || !pred(part)) continue;
      const box = [x + (oct & 1) * 0.5, y + ((oct >> 1) & 1) * 0.5, z + ((oct >> 2) & 1) * 0.5];
      const e = boxEntry(o, d, box, 0.5, maxDist);
      if (e === null) continue;
      if (best !== null && e.t >= best.t) {
        if (e.t < runnerUp) runnerUp = e.t;
        continue;
      }
      if (best !== null) runnerUp = best.t;
      const face = e.axis < 0 ? opposite(nearestDir(d[0]!, d[1]!, d[2]!)) : FACE_IN[e.axis]![d[e.axis]! > 0 ? 0 : 1]!;
      best = { x, y, z, t: e.t, octant: oct, part, cell: packed, face, faceTie: e.tied, runnerUp: Infinity };
    }
  }
  if (best !== null) best.runnerUp = runnerUp;
  return best;
}

/**
 * Entry distance of the ray into ONE octant box of cell (x, y, z), whatever the cell holds, or
 * null when the ray does not run a positive length through it within maxDist.
 */
export function octantEntry(
  grid: VoxelGrid,
  x: number,
  y: number,
  z: number,
  octant: number,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
): number | null {
  const lo = grid.toLocal(origin);
  const ld = grid.dirToLocal(dir);
  const box = [x + (octant & 1) * 0.5, y + ((octant >> 1) & 1) * 0.5, z + ((octant >> 2) & 1) * 0.5];
  const e = boxEntry([lo.x, lo.y, lo.z], [ld.x, ld.y, ld.z], box, 0.5, maxDist);
  return e === null ? null : e.t;
}

/**
 * The octant rule of docs/SHAPES.md 6.1 for a cell below FULL_LIMIT, from the LOCAL entry point
 * `p` of cell (x, y, z), the entry face (null when the origin is inside the cell) and the local
 * direction `d`:
 *  - on the entry face's axis: 0 when the ray moves +, 1 when it moves −;
 *  - on the other axes: 1 when the fractional part of the point is ≥ 0.5; exactly 0.5 gives 1
 *    moving +, 0 moving −, 1 not moving along that axis.
 * With the origin inside the cell all three axes follow the second rule.
 */
export function fullCellOctant(x: number, y: number, z: number, p: Vec3, face: Dir | null, d: Vec3): number {
  const c = [x, y, z];
  const pp = [p.x, p.y, p.z];
  const dd = [d.x, d.y, d.z];
  let oct = 0;
  for (let a = 0; a < 3; a++) {
    let bit: number;
    if (face !== null && face >> 1 === a) bit = dd[a]! > 0 ? 0 : 1;
    else {
      const f = pp[a]! - c[a]!;
      if (f > 0.5) bit = 1;
      else if (f < 0.5) bit = 0;
      else bit = dd[a]! < 0 ? 0 : 1;
    }
    oct |= bit << a;
  }
  return oct;
}
