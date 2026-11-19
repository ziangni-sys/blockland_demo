/**
 * Ray queries against any VoxelGrid (the world, ships, rotors — nested or not).
 *
 * The ray is given in WORLD space and transformed into the grid's LOCAL space once; there
 * the grid is a plain integer lattice and an Amanatides–Woo DDA walks the cells the ray
 * passes through, in order. Transforms are rigid, so distances measured along the local ray
 * equal distances along the world ray and hit points can be computed in world space directly.
 *
 * Rays hit OCTANTS (docs/SHAPES.md 6.1). The result is defined as the same DDA run on the half
 * grid (spacing 0.5), with every occupied octant taken as a cell and the predicate applied to
 * the PART that octant belongs to. The walk itself still goes cell by cell: a cell value below
 * FULL_LIMIT (full block, model block, soft block, liquid, air) is one part filling all eight
 * octants and takes the M1 path (one read; the hit is at the cell's entry, in the octant the ray
 * enters first); a cell with holes or a second part is walked as a 2x2x2 DDA from where the ray
 * entered it, so the ray passes through its empty octants (and through the octants of a part
 * the predicate rejects) to whatever lies behind.
 *
 * Predicates are expected to reject AIR: cells outside a structure's cellBounds() and world
 * cells at y >= WORLD_HEIGHT are never visited (that is what makes the bounds clip a valid
 * prefilter when many structures exist).
 *
 * Which cells (octants) count as "on the ray": those containing a POSITIVE length of it (or
 * the origin itself). Cells and octants are half-open, which settles rays lying exactly in a
 * face plane or a mid-plane (they see the cells / octants on the + side) and origins exactly on
 * a boundary (moving in -axis direction they start in the lower cell / octant). A cell or
 * octant the ray only touches along an edge or at a corner is never reported, whatever the axis
 * order: on an exact edge/corner crossing the DDA steps every tied axis at once.
 */
import { WORLD_HEIGHT } from '../core/constants';
import { DIR_X, DIR_Y, DIR_Z, NX, NY, NZ, PX, PY, PZ, nearestDir, opposite, type Dir } from '../core/dirs';
import { vec3, type Vec3 } from '../core/math';
import { AIR, CELL_MULTI_BIT, FULL_LIMIT, HOLES_SHIFT, ID_MASK, PACK_SCALE, PART_MASK, cellState, isLiquidSource } from '../blocks/cell';
import { B } from '../blocks/defs';
import { LIQUID } from '../blocks/registry';
import type { VoxelGrid } from './grid';

export interface GridHit {
  grid: VoxelGrid;
  /** Local integer cell that was hit. */
  x: number;
  y: number;
  z: number;
  /**
   * Face the ray entered the hit OCTANT through, in the grid's LOCAL axes. It can be an inner
   * face: the top of a lower slab is at y + 0.5 and is still PY (the cell across it, for
   * placementCell, is the cell above). When the ray enters exactly through an edge or corner,
   * the crossed face whose normal is most aligned with the ray. When the ray starts strictly
   * inside the hit octant, the face opposite to the ray's dominant local direction (an origin
   * exactly on a face of the cell, moving in, reports that face). The first octant the ray is in
   * within a cell always reports this cell-level face, as a full block in its place would: also
   * when the ray enters the cell exactly where it crosses a mid-plane, and when it starts inside
   * the cell exactly on a mid-plane (docs/SHAPES.md 19.9).
   */
  face: Dir;
  /**
   * The octant hit, 0..7 (o = ox | oy << 1 | oz << 2). For a cell below FULL_LIMIT (filling all
   * eight): the octant the ray is in just after entering the cell, by the rule of
   * docs/SHAPES.md 6.1 (on the entry axis 0 moving +, 1 moving −; on the others the half of the
   * entry point, a point exactly on the mid-plane counting as the half the ray moves into, or
   * the upper half when it does not move along that axis).
   */
  octant: number;
  /** The whole content of the cell hit: its PACKED cell (both parts, blocks/cell.ts); Target.cell carries it. */
  cell: number;
  /** The part hit, partAt(cell, octant): the material that mining, drops, pick block and dispatch by id read. */
  part: number;
  /** Distance along the world ray to the entry point of the hit octant (0 when starting inside it). */
  dist: number;
  /** World-space hit point (origin + dir * dist). */
  point: Vec3;
}

/**
 * Which parts stop a ray. It receives a PART value (< 2^24: id, state, holes; a full block is its
 * cell value) and must reject AIR. The predicates here read the id and state bits only, so a
 * cell value with CELL_MULTI_BIT (the server's checks read getCell) gives the answer for its
 * first part.
 */
export type CellPredicate = (part: number) => boolean;

/**
 * Anything the player can point at: every non-air, non-liquid part. Soft blocks (torches,
 * plants, snow cover) count; they are never cut, so they are always hit as full cells. The
 * UNLOADED sentinel is not a block (it is invisible and cannot be interacted with), so rays pass
 * through it.
 */
export const targetable: CellPredicate = (part) => {
  const id = part & ID_MASK;
  return id !== AIR && id !== B.UNLOADED && LIQUID[id] === 0;
};

/** Buckets: a targetable part or a liquid SOURCE cell (flowing liquid cannot be scooped). */
export const targetableOrLiquidSource: CellPredicate = (part) => {
  const id = part & ID_MASK;
  if (id === AIR || id === B.UNLOADED) return false;
  return LIQUID[id] === 0 || isLiquidSource(cellState(part));
};

/**
 * Rays are clipped to this length. It keeps the DDA provably finite when a caller passes
 * Infinity; nothing in the game looks further than a few hundred cells.
 */
export const RAY_HARD_LIMIT = 4096;

/**
 * Direction components smaller than this are treated as exactly zero. Rotating an
 * axis-parallel ray into a grid's local frame leaves ~1e-16 residue in the other
 * components; treating that as a real slope would make the ray step sideways after 1e16
 * units (harmless) but also makes boundary maths divide by near-zero (not harmless).
 * Over RAY_HARD_LIMIT this changes the path by < 1e-10 cells.
 */
const DIR_ZERO = 1e-14;

/**
 * Nearest occupied octant of `grid` along the ray whose part satisfies `pred` (default:
 * targetable), or null. `origin` and `dir` are in WORLD space; `dir` must be unit length
 * (distances are measured in units of |dir|). An octant entered exactly at `maxDist` counts.
 * Bounded grids are first clipped against their cellBounds() box; non-finite input returns null.
 */
export function raycastGrid(
  grid: VoxelGrid,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  pred: CellPredicate = targetable,
): GridHit | null {
  if (!(maxDist >= 0)) return null; // also rejects NaN
  // Clip box: the structure's cell bounds, or for the world the half-space below the build
  // limit (everything at or above it is AIR, which predicates reject).
  let bx0 = -Infinity;
  let by0 = -Infinity;
  let bz0 = -Infinity;
  let bx1 = Infinity;
  let by1 = Infinity;
  let bz1 = Infinity;
  // The ray in the grid's local frame. The world's transform is the identity (VoxelGrid.isWorld),
  // so its local ray is read straight from origin and dir: the world ray then allocates nothing
  // but its hit whether or not V8 inlines toLocal / dirToLocal here (when raycastGrid is called
  // for the world and for structures from one call site, it often does not).
  let ox: number;
  let oy: number;
  let oz: number;
  let dx: number;
  let dy: number;
  let dz: number;
  if (grid.isWorld) {
    by1 = WORLD_HEIGHT;
    ox = origin.x;
    oy = origin.y;
    oz = origin.z;
    dx = dir.x;
    dy = dir.y;
    dz = dir.z;
  } else {
    const b = grid.cellBounds();
    if (b === null) return null; // empty structure (only the world is unbounded)
    bx0 = b.minX;
    by0 = b.minY;
    bz0 = b.minZ;
    bx1 = b.maxX;
    by1 = b.maxY;
    bz1 = b.maxZ;
    const lo = grid.toLocal(origin, vec3());
    const ld = grid.dirToLocal(dir, vec3());
    ox = lo.x;
    oy = lo.y;
    oz = lo.z;
    dx = ld.x;
    dy = ld.y;
    dz = ld.z;
  }
  if (!(Number.isFinite(ox) && Number.isFinite(oy) && Number.isFinite(oz))) return null;
  if (!(Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dz))) return null;
  if (Math.abs(dx) < DIR_ZERO) dx = 0;
  if (Math.abs(dy) < DIR_ZERO) dy = 0;
  if (Math.abs(dz) < DIR_ZERO) dz = 0;

  // ---- slab test. t0 = entry parameter, tExit = exit parameter of the clip box.
  let t0 = 0;
  let tExit = Infinity;
  // Axis whose slab is entered last (-1: the origin is already inside). When the box is
  // entered exactly through an edge or corner, the steepest of the tied axes, like the DDA.
  let enterAxis = -1;
  let enterSlope = 0;
  {
    // X
    if (dx === 0) {
      if (ox < bx0 || ox >= bx1) return null;
    } else {
      const inv = 1 / dx;
      let tn = (bx0 - ox) * inv;
      let tf = (bx1 - ox) * inv;
      if (tn > tf) {
        const s = tn;
        tn = tf;
        tf = s;
      }
      if (tn > t0 || (tn === t0 && enterAxis >= 0 && Math.abs(dx) > enterSlope)) {
        t0 = tn;
        enterAxis = 0;
        enterSlope = Math.abs(dx);
      }
      if (tf < tExit) tExit = tf;
    }
    // Y
    if (dy === 0) {
      if (oy < by0 || oy >= by1) return null;
    } else {
      const inv = 1 / dy;
      let tn = (by0 - oy) * inv;
      let tf = (by1 - oy) * inv;
      if (tn > tf) {
        const s = tn;
        tn = tf;
        tf = s;
      }
      if (tn > t0 || (tn === t0 && enterAxis >= 0 && Math.abs(dy) > enterSlope)) {
        t0 = tn;
        enterAxis = 1;
        enterSlope = Math.abs(dy);
      }
      if (tf < tExit) tExit = tf;
    }
    // Z
    if (dz === 0) {
      if (oz < bz0 || oz >= bz1) return null;
    } else {
      const inv = 1 / dz;
      let tn = (bz0 - oz) * inv;
      let tf = (bz1 - oz) * inv;
      if (tn > tf) {
        const s = tn;
        tn = tf;
        tf = s;
      }
      if (tn > t0 || (tn === t0 && enterAxis >= 0 && Math.abs(dz) > enterSlope)) {
        t0 = tn;
        enterAxis = 2;
        enterSlope = Math.abs(dz);
      }
      if (tf < tExit) tExit = tf;
    }
  }
  // The ray must run a positive length inside the box (one that only touches an edge or a
  // face of the box touches no cell along a positive length) and enter it within range.
  const range = maxDist < RAY_HARD_LIMIT ? maxDist : RAY_HARD_LIMIT;
  if (!(t0 < tExit) || t0 > range) return null;
  const t1 = tExit < range ? tExit : range;

  // ---- starting cell. On the entry axis the cell is known exactly (the boundary layer of
  // the box); recomputing it with floor() could land one cell outside because of rounding.
  // On other axes: the cell containing the ray just AFTER t0 (an origin exactly on a cell
  // boundary while moving in -axis direction belongs to the lower cell). For an entering ray
  // that cell is clamped into the box (rounding when entering close to an edge of the box);
  // for an origin on the box's surface moving out, the positive-length test above already
  // returned, so the remaining check is only a guard against rounding.
  let cx: number;
  let cy: number;
  let cz: number;
  let onFaceX = false;
  let onFaceY = false;
  let onFaceZ = false;
  if (enterAxis === 0) {
    cx = dx > 0 ? bx0 : bx1 - 1;
  } else {
    const p = ox + dx * t0;
    cx = Math.floor(p) + 0; // + 0 turns -0 into 0
    if (cx === p && dx !== 0) {
      onFaceX = true;
      if (dx < 0) cx -= 1;
    }
    if (cx < bx0 || cx > bx1 - 1) {
      if (enterAxis < 0) return null; // origin on the box's outer face, moving away
      cx = cx < bx0 ? bx0 : bx1 - 1; // entry point rounding at an edge
    }
  }
  if (enterAxis === 1) {
    cy = dy > 0 ? by0 : by1 - 1;
  } else {
    const p = oy + dy * t0;
    cy = Math.floor(p) + 0; // + 0 turns -0 into 0
    if (cy === p && dy !== 0) {
      onFaceY = true;
      if (dy < 0) cy -= 1;
    }
    if (cy < by0 || cy > by1 - 1) {
      if (enterAxis < 0) return null; // origin on the box's outer face, moving away
      cy = cy < by0 ? by0 : by1 - 1; // entry point rounding at an edge
    }
  }
  if (enterAxis === 2) {
    cz = dz > 0 ? bz0 : bz1 - 1;
  } else {
    const p = oz + dz * t0;
    cz = Math.floor(p) + 0; // + 0 turns -0 into 0
    if (cz === p && dz !== 0) {
      onFaceZ = true;
      if (dz < 0) cz -= 1;
    }
    if (cz < bz0 || cz > bz1 - 1) {
      if (enterAxis < 0) return null; // origin on the box's outer face, moving away
      cz = cz < bz0 ? bz0 : bz1 - 1; // entry point rounding at an edge
    }
  }

  // Face through which the ray is in the starting cell.
  let face: Dir;
  if (enterAxis === 0) face = dx > 0 ? NX : PX;
  else if (enterAxis === 1) face = dy > 0 ? NY : PY;
  else if (enterAxis === 2) face = dz > 0 ? NZ : PZ;
  else {
    // The origin is inside the start cell, or exactly on one of its faces and moving in
    // (then that face really is the entry face; pick the steepest such axis).
    const ax = onFaceX ? Math.abs(dx) : -1;
    const ay = onFaceY ? Math.abs(dy) : -1;
    const az = onFaceZ ? Math.abs(dz) : -1;
    if (ax > 0 && ax >= ay && ax >= az) face = dx > 0 ? NX : PX;
    else if (ay > 0 && ay >= az) face = dy > 0 ? NY : PY;
    else if (az > 0) face = dz > 0 ? NZ : PZ;
    else face = opposite(nearestDir(dx, dy, dz));
  }

  // ---- DDA. tMax* = ray parameter of the next boundary crossing on each axis, always
  // recomputed from the local origin (no accumulated error over long rays).
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const invX = dx !== 0 ? 1 / dx : 0;
  const invY = dy !== 0 ? 1 / dy : 0;
  const invZ = dz !== 0 ? 1 / dz : 0;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const adz = Math.abs(dz);
  let tMaxX = stepX === 0 ? Infinity : (cx + (stepX > 0 ? 1 : 0) - ox) * invX;
  let tMaxY = stepY === 0 ? Infinity : (cy + (stepY > 0 ? 1 : 0) - oy) * invY;
  let tMaxZ = stepZ === 0 ? Infinity : (cz + (stepZ > 0 ? 1 : 0) - oz) * invZ;
  let t = t0;
  // Upper bound on boundary crossings inside [t0, t1]: guarantees termination even if
  // rounding ever made the comparisons below misbehave.
  let budget = Math.ceil((adx + ady + adz) * (t1 - t0)) + 8;

  // Which octant of a cell the ray is in just after parameter t (the octant a full cell is hit
  // in, the first octant of a partial cell's walk). Per axis, with hm the parameter at which the
  // ray crosses the cell's mid-plane: moving +, the upper half once the mid-plane is behind or
  // exactly at t; moving −, the upper half while it is still ahead (octants are half-open, like
  // cells). So the bit is (hm <= t) XOR (moving −). On an axis the ray does not move along, the
  // cell never changes, so the bit is fixed for the whole ray: the upper half when the origin is
  // at or above the mid-plane. At a cell's entry this is the octant rule of docs/SHAPES.md 6.1
  // (0 moving + and 1 moving − on the entry axis; on the others the half of the entry point,
  // exactly 0.5 counting as the half the ray moves into, or the upper one when it does not move).
  const negX = stepX < 0 ? 1 : 0;
  const negY = stepY < 0 ? 1 : 0;
  const negZ = stepZ < 0 ? 1 : 0;
  const fixedMask = (stepX === 0 ? 1 : 0) | (stepY === 0 ? 2 : 0) | (stepZ === 0 ? 4 : 0);
  const fixedBits = (stepX === 0 && ox >= cx + 0.5 ? 1 : 0) | (stepY === 0 && oy >= cy + 0.5 ? 2 : 0) | (stepZ === 0 && oz >= cz + 0.5 ? 4 : 0);
  for (;;) {
    const cell = grid.getCell(cx, cy, cz);
    if (cell < FULL_LIMIT) {
      // The M1 path: one part filling all eight octants, hit at the cell's entry.
      if (pred(cell)) {
        // Hit at its entry, in the octant the ray is in just after t (see negX above).
        const octant =
          (((((cx + 0.5 - ox) * invX <= t ? 1 : 0) ^ negX) |
            ((((cy + 0.5 - oy) * invY <= t ? 1 : 0) ^ negY) << 1) |
            ((((cz + 0.5 - oz) * invZ <= t ? 1 : 0) ^ negZ) << 2)) &
            ~fixedMask) |
          fixedBits;
        return {
          grid,
          x: cx,
          y: cy,
          z: cz,
          face,
          octant,
          cell,
          part: cell,
          dist: t,
          point: vec3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t),
        };
      }
    } else {
      // A partial cell (holes or a second part): a 2x2x2 DDA on the half grid from where the ray
      // entered it. The octants that can stop the ray are those of the parts pred accepts; the
      // second part is read only when bit 24 says there is one (docs/SHAPES.md 19.9). The walk
      // lives in this function's locals, so passing partial cells allocates nothing and a hit
      // costs what a full block's does (plus one heap number for a two-part cell's packed value):
      // in a function V8 did not inline, its fractional numbers would be boxed (4.4), and a
      // per-ray state object costs about 400 bytes. tests/voxel/ray-alloc.test.ts pins this.
      const p1 = cell & PART_MASK;
      const f1 = ~(p1 >>> HOLES_SHIFT) & 0xff;
      let mask = pred(p1) ? f1 : 0;
      let p2 = 0;
      if (cell >= CELL_MULTI_BIT) {
        p2 = grid.getPart2(cx, cy, cz);
        if (pred(p2)) mask |= ~(p2 >>> HOLES_SHIFT) & 0xff;
      }
      if (mask !== 0) {
        // hm* = ray parameter of the cell's mid-plane on each axis (unused on fixed axes).
        const hmX = (cx + 0.5 - ox) * invX;
        const hmY = (cy + 0.5 - oy) * invY;
        const hmZ = (cz + 0.5 - oz) * invZ;
        // The first octant: the one the ray is in just after it entered the cell (see negX above);
        // it keeps the cell's entry face (6.1, 19.9). Later ones are entered through inner faces.
        let oct = ((((hmX <= t ? 1 : 0) ^ negX) | (((hmY <= t ? 1 : 0) ^ negY) << 1) | (((hmZ <= t ? 1 : 0) ^ negZ) << 2)) & ~fixedMask) | fixedBits;
        let tw = t;
        let fw = face;
        // At most four octants: each axis crosses the mid-plane at most once.
        for (;;) {
          if (((mask >> oct) & 1) !== 0) {
            return {
              grid,
              x: cx,
              y: cy,
              z: cz,
              face: fw,
              octant: oct,
              // The packed cell (6.1). For a two-part cell it is a double above 2^31: it is formed
              // only here, in the hit object (one heap number), never passed to a function (4.4).
              cell: cell < CELL_MULTI_BIT ? cell : cell + p2 * PACK_SCALE,
              part: ((f1 >> oct) & 1) !== 0 ? p1 : p2,
              dist: tw,
              point: vec3(origin.x + dir.x * tw, origin.y + dir.y * tw, origin.z + dir.z * tw),
            };
          }
          // Next crossing on each axis: the mid-plane while the ray is still in the half it
          // entered, else the cell boundary (exit).
          const nxMid = stepX > 0 ? (oct & 1) === 0 : (oct & 1) !== 0;
          const nyMid = stepY > 0 ? (oct & 2) === 0 : (oct & 2) !== 0;
          const nzMid = stepZ > 0 ? (oct & 4) === 0 : (oct & 4) !== 0;
          const nx = stepX === 0 ? Infinity : nxMid ? hmX : tMaxX;
          const ny = stepY === 0 ? Infinity : nyMid ? hmY : tMaxY;
          const nz = stepZ === 0 ? Infinity : nzMid ? hmZ : tMaxZ;
          let tn = nx < ny ? nx : ny;
          if (nz < tn) tn = nz;
          // The range ends before the next octant. Each crossing above is at or before the cell
          // boundary on its axis (the same arithmetic, rounding is monotonic), so the cell walk
          // below finds the next cell boundary beyond the range too and ends the ray.
          if (tn > t1) break;
          // The ray leaves the cell (on an exact tie with a mid-plane crossing too): the cell walk
          // below steps the axes whose cell boundary is at tn.
          if ((nx === tn && !nxMid) || (ny === tn && !nyMid) || (nz === tn && !nzMid)) break;
          // Only mid-planes at tn: every tied axis flips at once (an octant the ray only touches
          // along an edge or at a corner is never entered), and the entered inner face is the
          // steepest of them (x, y, z order on equal slopes), as for cells.
          let fa = -1;
          let fs = -1;
          if (nx === tn) {
            oct ^= 1;
            fa = 0;
            fs = adx;
          }
          if (ny === tn) {
            oct ^= 2;
            if (ady > fs) {
              fa = 1;
              fs = ady;
            }
          }
          if (nz === tn) {
            oct ^= 4;
            if (adz > fs) fa = 2;
          }
          fw = fa === 0 ? (stepX > 0 ? NX : PX) : fa === 1 ? (stepY > 0 ? NY : PY) : stepZ > 0 ? NZ : PZ;
          if (tn > tw) tw = tn;
        }
      }
    }
    if (--budget < 0) return null;
    let tn = tMaxX < tMaxY ? tMaxX : tMaxY;
    if (tMaxZ < tn) tn = tMaxZ;
    if (tn > t1) return null; // also the all-Infinity case (zero direction)
    if (tn > t) t = tn;
    // Every axis crossing at exactly tn steps now: on an edge (corner) crossing the cells
    // that share only that edge (corner) with the ray hold none of its length. The entry face
    // is the steepest of the crossed ones (x, y, z order on equal slopes).
    let fa = -1;
    let fs = -1;
    if (tMaxX === tn) {
      cx += stepX;
      tMaxX = (cx + (stepX > 0 ? 1 : 0) - ox) * invX;
      fa = 0;
      fs = adx;
    }
    if (tMaxY === tn) {
      cy += stepY;
      tMaxY = (cy + (stepY > 0 ? 1 : 0) - oy) * invY;
      if (ady > fs) {
        fa = 1;
        fs = ady;
      }
    }
    if (tMaxZ === tn) {
      cz += stepZ;
      tMaxZ = (cz + (stepZ > 0 ? 1 : 0) - oz) * invZ;
      if (adz > fs) fa = 2;
    }
    face = fa === 0 ? (stepX > 0 ? NX : PX) : fa === 1 ? (stepY > 0 ? NY : PY) : stepZ > 0 ? NZ : PZ;
  }
}

/**
 * Nearest hit over several grids (world + structures). On an exact distance tie the grid
 * that comes first in iteration order wins, so callers can order grids by priority.
 */
export function raycastGrids(
  grids: Iterable<VoxelGrid>,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  pred: CellPredicate = targetable,
): GridHit | null {
  let best: GridHit | null = null;
  let limit = maxDist;
  for (const g of grids) {
    const h = raycastGrid(g, origin, dir, limit, pred);
    if (h !== null && (best === null || h.dist < best.dist)) {
      best = h;
      limit = h.dist; // later grids only need to search up to the current best
    }
  }
  return best;
}

/** The neighbouring local cell across the entered face: where a placed block would go. */
export function placementCell(hit: GridHit): { x: number; y: number; z: number } {
  return { x: hit.x + DIR_X[hit.face]!, y: hit.y + DIR_Y[hit.face]!, z: hit.z + DIR_Z[hit.face]! };
}
