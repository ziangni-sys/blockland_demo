/**
 * Ray queries against any VoxelGrid (the world, ships, rotors — nested or not).
 *
 * The ray is given in WORLD space and transformed into the grid's LOCAL space once; there
 * the grid is a plain integer lattice and an Amanatides–Woo DDA walks the cells the ray
 * passes through, in order. Transforms are rigid, so distances measured along the local ray
 * equal distances along the world ray and hit points can be computed in world space directly.
 *
 * Predicates are expected to reject AIR: cells outside a structure's cellBounds() and world
 * cells at y >= WORLD_HEIGHT are never visited (that is what makes the bounds clip a valid
 * prefilter when many structures exist).
 */
import { WORLD_HEIGHT } from '../core/constants';
import { DIR_X, DIR_Y, DIR_Z, NX, NY, NZ, PX, PY, PZ, nearestDir, opposite, type Dir } from '../core/dirs';
import { vec3, type Vec3 } from '../core/math';
import { AIR, ID_MASK, cellState, isLiquidSource } from '../blocks/cell';
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
   * Face of the cell the ray entered through, in the grid's LOCAL axes. When the ray starts
   * inside a matching cell this is the face opposite to the ray's dominant local direction.
   */
  face: Dir;
  /** The cell value that matched. */
  cell: number;
  /** Distance along the world ray to the entry point (0 when starting inside the cell). */
  dist: number;
  /** World-space hit point (origin + dir * dist). */
  point: Vec3;
}

export type CellPredicate = (cell: number) => boolean;

/**
 * Anything the player can point at: every non-air, non-liquid cell. Soft blocks (torches,
 * plants, snow cover) count and are treated as full cells. The UNLOADED sentinel is not a
 * block (it is invisible and cannot be interacted with), so rays pass through it.
 */
export const targetable: CellPredicate = (cell) => {
  const id = cell & ID_MASK;
  return id !== AIR && id !== B.UNLOADED && LIQUID[id] === 0;
};

/** Buckets: a targetable cell or a liquid SOURCE cell (flowing liquid cannot be scooped). */
export const targetableOrLiquidSource: CellPredicate = (cell) => {
  const id = cell & ID_MASK;
  if (id === AIR || id === B.UNLOADED) return false;
  return LIQUID[id] === 0 || isLiquidSource(cellState(cell));
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
 * Nearest cell of `grid` along the ray that satisfies `pred` (default: targetable), or null.
 * `origin` and `dir` are in WORLD space; `dir` must be unit length. A hit exactly at
 * `maxDist` counts. Bounded grids are first clipped against their cellBounds() box.
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
  if (grid.isWorld) {
    by1 = WORLD_HEIGHT;
  } else {
    const b = grid.cellBounds();
    if (b === null) return null; // empty structure (only the world is unbounded)
    bx0 = b.minX;
    by0 = b.minY;
    bz0 = b.minZ;
    bx1 = b.maxX;
    by1 = b.maxY;
    bz1 = b.maxZ;
  }

  const lo = grid.toLocal(origin, vec3());
  const ld = grid.dirToLocal(dir, vec3());
  const ox = lo.x;
  const oy = lo.y;
  const oz = lo.z;
  let dx = ld.x;
  let dy = ld.y;
  let dz = ld.z;
  if (!(Number.isFinite(ox) && Number.isFinite(oy) && Number.isFinite(oz))) return null;
  if (!(Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dz))) return null;
  if (Math.abs(dx) < DIR_ZERO) dx = 0;
  if (Math.abs(dy) < DIR_ZERO) dy = 0;
  if (Math.abs(dz) < DIR_ZERO) dz = 0;

  // ---- slab test. t0 = entry parameter, t1 = exit parameter (already capped by maxDist).
  let t0 = 0;
  let t1 = maxDist < RAY_HARD_LIMIT ? maxDist : RAY_HARD_LIMIT;
  let enterAxis = -1;
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
      if (tn > t0) {
        t0 = tn;
        enterAxis = 0;
      }
      if (tf < t1) t1 = tf;
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
      if (tn > t0) {
        t0 = tn;
        enterAxis = 1;
      }
      if (tf < t1) t1 = tf;
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
      if (tn > t0) {
        t0 = tn;
        enterAxis = 2;
      }
      if (tf < t1) t1 = tf;
    }
  }
  if (!(t0 <= t1)) return null;

  // ---- starting cell. On the entry axis the cell is known exactly (the boundary layer of
  // the box); recomputing it with floor() could land one cell outside because of rounding.
  // On other axes: the cell containing the ray just AFTER t0 (an origin exactly on a cell
  // boundary while moving in -axis direction belongs to the lower cell). For an entering ray
  // that cell is clamped into the box (rounding when entering exactly at an edge); for an
  // origin inside the box it can only be outside when the origin sits on the box's surface
  // and the ray leaves immediately.
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
  let tMaxX = stepX === 0 ? Infinity : (cx + (stepX > 0 ? 1 : 0) - ox) * invX;
  let tMaxY = stepY === 0 ? Infinity : (cy + (stepY > 0 ? 1 : 0) - oy) * invY;
  let tMaxZ = stepZ === 0 ? Infinity : (cz + (stepZ > 0 ? 1 : 0) - oz) * invZ;
  let t = t0;
  // Upper bound on boundary crossings inside [t0, t1]: guarantees termination even if
  // rounding ever made the comparisons below misbehave.
  let budget = Math.ceil((Math.abs(dx) + Math.abs(dy) + Math.abs(dz)) * (t1 - t0)) + 8;

  for (;;) {
    const cell = grid.getCell(cx, cy, cz);
    if (pred(cell)) {
      return {
        grid,
        x: cx,
        y: cy,
        z: cz,
        face,
        cell,
        dist: t,
        point: vec3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t),
      };
    }
    if (--budget < 0) return null;
    // Ties step the later axis first; either order is a valid traversal of an edge/corner.
    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) {
        if (tMaxX > t1) return null;
        if (tMaxX > t) t = tMaxX;
        cx += stepX;
        tMaxX = (cx + (stepX > 0 ? 1 : 0) - ox) * invX;
        face = stepX > 0 ? NX : PX;
        continue;
      }
    } else if (tMaxY < tMaxZ) {
      if (tMaxY > t1) return null;
      if (tMaxY > t) t = tMaxY;
      cy += stepY;
      tMaxY = (cy + (stepY > 0 ? 1 : 0) - oy) * invY;
      face = stepY > 0 ? NY : PY;
      continue;
    }
    if (tMaxZ > t1) return null; // also the all-Infinity case (zero direction)
    if (tMaxZ > t) t = tMaxZ;
    cz += stepZ;
    tMaxZ = (cz + (stepZ > 0 ? 1 : 0) - oz) * invZ;
    face = stepZ > 0 ? NZ : PZ;
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
