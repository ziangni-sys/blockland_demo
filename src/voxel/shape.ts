/**
 * Box-vs-grid queries: overlap, penetration / push-out, axis sweeps, support probes and
 * free-spot search. Written ONCE against VoxelGrid so the world, ships and rotors (nested or
 * not) behave identically (docs/ARCHITECTURE.md "统一的体素网格").
 *
 * Entities are WORLD-axis-aligned boxes. In a grid's LOCAL space such a box is an oriented
 * box (OBB) while cells are unit AABBs, so the general test is a separating-axis test with
 * the 15 OBB/AABB axes. The world (identity transform) and structures whose rotation is a
 * signed axis permutation skip the SAT entirely: there the box is an AABB in local space too.
 *
 * Overlap convention used everywhere: boxes that merely touch (overlap <= CONTACT_EPS along
 * some separating axis) do NOT overlap. A box pushed out or swept up to a face is therefore
 * "free", which is what keeps standing, pushing and sliding stable.
 *
 * "Solid" always means SOLID[id] === 1 (HARD blocks).
 */
import { WORLD_HEIGHT } from '../core/constants';
import { DIR_X, DIR_Y, DIR_Z } from '../core/dirs';
import { EPS, aabb, qtoMat3, quat, vec3, type AABB, type Quat, type Vec3 } from '../core/math';
import { ID_MASK } from '../blocks/cell';
// Side-effect import: registering the block table is what fills SOLID (including the
// deeprock / unloaded sentinels the world returns), so queries never see an empty table.
import '../blocks/defs';
import { SOLID } from '../blocks/registry';
import type { CellBounds, VoxelGrid } from './grid';

/** Overlap tolerance: separation within this distance counts as touching, not overlapping. */
export const CONTACT_EPS = EPS;

/** Default bias strength for PushOptions.prefer when preferWeight is not given. */
export const DEFAULT_PREFER_WEIGHT = 0.25;

/** Rotation-matrix entries this close to 0 / ±1 are snapped: the rotation is axis-aligned. */
const ALIGN_TOL = 1e-12;
/** Edge-edge SAT axes shorter than this (near-parallel edges) are redundant and skipped. */
const SAT_MIN_AXIS = 1e-12;

function isSolid(cell: number): boolean {
  return SOLID[cell & ID_MASK] === 1;
}

// ====================================================================== local OBB

/**
 * A world AABB expressed in a structure grid's local space. Built once per query (and then
 * translated cheaply for iterative queries) so the rotation is only fetched once.
 */
class LocalObb {
  /**
   * Row-major local->world rotation. Row i is world axis i expressed in local coordinates
   * (the box's own axes, seen from the grid); column j is local axis j in world coordinates.
   * Entries 9.. hold the SAT axes: per axis [Lx, Ly, Lz, rA + rB].
   */
  readonly m = new Float64Array(9 + 12 * 4);
  satCount = 0;
  /** True when the rotation is a signed axis permutation: the box is an AABB in local space. */
  aligned = true;
  /** Box centre in local space. */
  cx = 0;
  cy = 0;
  cz = 0;
  /** Centre as built, before translate(). */
  bx = 0;
  by = 0;
  bz = 0;
  /** Half extents along the world axes. */
  hx = 0;
  hy = 0;
  hz = 0;
  /** Half extents of the box's local AABB (its projection radius on each local axis). */
  ex = 0;
  ey = 0;
  ez = 0;
  /** Inclusive candidate cell range, filled by range(). */
  x0 = 0;
  x1 = -1;
  y0 = 0;
  y1 = -1;
  z0 = 0;
  z1 = -1;
  private readonly q: Quat = quat();
  private readonly p: Vec3 = vec3();

  build(grid: VoxelGrid, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void {
    const m = this.m;
    qtoMat3(grid.worldRotation(this.q), m);
    let aligned = true;
    for (let i = 0; i < 9; i++) {
      const a = Math.abs(m[i]!);
      if (a > ALIGN_TOL && a < 1 - ALIGN_TOL) {
        aligned = false;
        break;
      }
    }
    if (aligned) {
      // Snap so that e.g. a 90 degree yaw gives exact extents and exact push normals.
      for (let i = 0; i < 9; i++) {
        const v = m[i]!;
        m[i] = v > 0.5 ? 1 : v < -0.5 ? -1 : 0;
      }
    }
    this.aligned = aligned;
    const p = this.p;
    p.x = (minX + maxX) * 0.5;
    p.y = (minY + maxY) * 0.5;
    p.z = (minZ + maxZ) * 0.5;
    grid.toLocal(p, p);
    this.cx = this.bx = p.x;
    this.cy = this.by = p.y;
    this.cz = this.bz = p.z;
    const hx = (this.hx = (maxX - minX) * 0.5);
    const hy = (this.hy = (maxY - minY) * 0.5);
    const hz = (this.hz = (maxZ - minZ) * 0.5);
    this.ex = hx * Math.abs(m[0]!) + hy * Math.abs(m[3]!) + hz * Math.abs(m[6]!);
    this.ey = hx * Math.abs(m[1]!) + hy * Math.abs(m[4]!) + hz * Math.abs(m[7]!);
    this.ez = hx * Math.abs(m[2]!) + hy * Math.abs(m[5]!) + hz * Math.abs(m[8]!);
    this.satCount = 0;
    if (!aligned) this.buildSatAxes();
  }

  /**
   * SAT axes beyond the three cell axes (those are covered by range()): the 3 box axes and
   * the 9 edge-edge cross products. They depend only on the rotation, so they are computed
   * once per query and every cell test is just a dot product per axis.
   *
   * Any unit axis is a VALID separating-axis candidate, so normalising a short cross
   * product cannot produce a wrong answer, only a redundant test; truly degenerate ones
   * (parallel edges) are skipped because a face axis already covers them.
   */
  private buildSatAxes(): void {
    const m = this.m;
    const { hx, hy, hz } = this;
    let n = 0;
    for (let i = 0; i < 3; i++) {
      const ax = m[i * 3]!;
      const ay = m[i * 3 + 1]!;
      const az = m[i * 3 + 2]!;
      const h = i === 0 ? hx : i === 1 ? hy : hz;
      const o = 9 + n * 4;
      m[o] = ax;
      m[o + 1] = ay;
      m[o + 2] = az;
      m[o + 3] = h + 0.5 * (Math.abs(ax) + Math.abs(ay) + Math.abs(az));
      n++;
    }
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        const ax = m[i * 3]!;
        const ay = m[i * 3 + 1]!;
        const az = m[i * 3 + 2]!;
        // L = e_j x A_i
        let lx: number;
        let ly: number;
        let lz: number;
        if (j === 0) {
          lx = 0;
          ly = -az;
          lz = ay;
        } else if (j === 1) {
          lx = az;
          ly = 0;
          lz = -ax;
        } else {
          lx = -ay;
          ly = ax;
          lz = 0;
        }
        const len = Math.sqrt(lx * lx + ly * ly + lz * lz);
        if (len < SAT_MIN_AXIS) continue;
        const inv = 1 / len;
        lx *= inv;
        ly *= inv;
        lz *= inv;
        const rA =
          hx * Math.abs(m[0]! * lx + m[1]! * ly + m[2]! * lz) +
          hy * Math.abs(m[3]! * lx + m[4]! * ly + m[5]! * lz) +
          hz * Math.abs(m[6]! * lx + m[7]! * ly + m[8]! * lz);
        const rB = 0.5 * (Math.abs(lx) + Math.abs(ly) + Math.abs(lz));
        const o = 9 + n * 4;
        m[o] = lx;
        m[o + 1] = ly;
        m[o + 2] = lz;
        m[o + 3] = rA + rB;
        n++;
      }
    }
    this.satCount = n;
  }

  /** Move the box by a WORLD-space offset from where it was built (not cumulative). */
  setWorldOffset(dx: number, dy: number, dz: number): void {
    const m = this.m;
    this.cx = this.bx + m[0]! * dx + m[3]! * dy + m[6]! * dz;
    this.cy = this.by + m[1]! * dx + m[4]! * dy + m[7]! * dz;
    this.cz = this.bz + m[2]! * dx + m[5]! * dy + m[8]! * dz;
  }

  /**
   * Candidate cells: those overlapping the box's local AABB by more than CONTACT_EPS on
   * every local axis (this IS the SAT test on the three cell axes), clipped to `b` and
   * grown by `margin` on every side. Returns false when the range is empty.
   */
  range(b: CellBounds, margin = 0): boolean {
    let x0 = Math.floor(this.cx - this.ex - margin + CONTACT_EPS);
    let x1 = Math.ceil(this.cx + this.ex + margin - CONTACT_EPS) - 1;
    let y0 = Math.floor(this.cy - this.ey - margin + CONTACT_EPS);
    let y1 = Math.ceil(this.cy + this.ey + margin - CONTACT_EPS) - 1;
    let z0 = Math.floor(this.cz - this.ez - margin + CONTACT_EPS);
    let z1 = Math.ceil(this.cz + this.ez + margin - CONTACT_EPS) - 1;
    if (x0 < b.minX) x0 = b.minX;
    if (y0 < b.minY) y0 = b.minY;
    if (z0 < b.minZ) z0 = b.minZ;
    if (x1 > b.maxX - 1) x1 = b.maxX - 1;
    if (y1 > b.maxY - 1) y1 = b.maxY - 1;
    if (z1 > b.maxZ - 1) z1 = b.maxZ - 1;
    this.x0 = x0;
    this.x1 = x1;
    this.y0 = y0;
    this.y1 = y1;
    this.z0 = z0;
    this.z1 = z1;
    return x0 <= x1 && y0 <= y1 && z0 <= z1;
  }

  /**
   * Exact overlap of the box with unit cell (x,y,z), assuming the cell is inside range()
   * (so the three cell axes already overlap). Strict: touching is not overlapping.
   */
  overlapsCell(x: number, y: number, z: number): boolean {
    const n = this.satCount;
    if (n === 0) return true;
    const m = this.m;
    // Relative position first: keeps the dot products small and accurate.
    const tx = x + 0.5 - this.cx;
    const ty = y + 0.5 - this.cy;
    const tz = z + 0.5 - this.cz;
    for (let k = 0, o = 9; k < n; k++, o += 4) {
      const d = tx * m[o]! + ty * m[o + 1]! + tz * m[o + 2]!;
      if ((d < 0 ? -d : d) >= m[o + 3]! - CONTACT_EPS) return false;
    }
    return true;
  }

  /** True when any solid cell in the current range() overlaps the box. */
  hasSolid(grid: VoxelGrid): boolean {
    const { x0, x1, y0, y1, z0, z1 } = this;
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (SOLID[grid.getCell(x, y, z) & ID_MASK] === 1 && this.overlapsCell(x, y, z)) return true;
        }
      }
    }
    return false;
  }
}

/** Builds the local OBB of a world box for a structure grid; null when nothing can overlap. */
function structureObb(
  grid: VoxelGrid,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): { obb: LocalObb; bounds: CellBounds } | null {
  const bounds = grid.cellBounds();
  if (bounds === null) return null; // empty structure (only the world is unbounded)
  const obb = new LocalObb();
  obb.build(grid, minX, minY, minZ, maxX, maxY, maxZ);
  return { obb, bounds };
}

// ====================================================================== world fast path
// The world has an identity transform: the box is already an AABB in local space, every cell
// of the candidate range truly overlaps, and nothing above WORLD_HEIGHT is solid.

function worldHasSolid(
  grid: VoxelGrid,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): boolean {
  const x0 = Math.floor(minX + CONTACT_EPS);
  const x1 = Math.ceil(maxX - CONTACT_EPS) - 1;
  const y0 = Math.floor(minY + CONTACT_EPS);
  let y1 = Math.ceil(maxY - CONTACT_EPS) - 1;
  const z0 = Math.floor(minZ + CONTACT_EPS);
  const z1 = Math.ceil(maxZ - CONTACT_EPS) - 1;
  if (y1 >= WORLD_HEIGHT) y1 = WORLD_HEIGHT - 1;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (SOLID[grid.getCell(x, y, z) & ID_MASK] === 1) return true;
      }
    }
  }
  return false;
}

/** Shared overlap test on box coordinates (no allocation for the world). */
function overlapsSolid(
  grid: VoxelGrid,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): boolean {
  // Inverted (or NaN) boxes overlap nothing.
  if (!(maxX >= minX && maxY >= minY && maxZ >= minZ)) return false;
  if (grid.isWorld) return worldHasSolid(grid, minX, minY, minZ, maxX, maxY, maxZ);
  const s = structureObb(grid, minX, minY, minZ, maxX, maxY, maxZ);
  if (s === null || !s.obb.range(s.bounds)) return false;
  return s.obb.hasSolid(grid);
}

// ====================================================================== overlap

/**
 * Visit every solid cell whose unit cube truly overlaps `box` (touching within CONTACT_EPS
 * does not count), in y, z, x order. `fn` returning true stops the iteration.
 * Do not modify the grid from inside `fn`.
 */
export function forEachSolidCellOverlapping(
  grid: VoxelGrid,
  box: AABB,
  fn: (x: number, y: number, z: number, cell: number) => boolean | void,
): void {
  const { minX, minY, minZ, maxX, maxY, maxZ } = box;
  if (!(maxX >= minX && maxY >= minY && maxZ >= minZ)) return;
  if (grid.isWorld) {
    const x0 = Math.floor(minX + CONTACT_EPS);
    const x1 = Math.ceil(maxX - CONTACT_EPS) - 1;
    const y0 = Math.floor(minY + CONTACT_EPS);
    let y1 = Math.ceil(maxY - CONTACT_EPS) - 1;
    const z0 = Math.floor(minZ + CONTACT_EPS);
    const z1 = Math.ceil(maxZ - CONTACT_EPS) - 1;
    if (y1 >= WORLD_HEIGHT) y1 = WORLD_HEIGHT - 1;
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const cell = grid.getCell(x, y, z);
          if (isSolid(cell) && fn(x, y, z, cell) === true) return;
        }
      }
    }
    return;
  }
  const s = structureObb(grid, minX, minY, minZ, maxX, maxY, maxZ);
  if (s === null) return;
  const obb = s.obb;
  if (!obb.range(s.bounds)) return;
  for (let y = obb.y0; y <= obb.y1; y++) {
    for (let z = obb.z0; z <= obb.z1; z++) {
      for (let x = obb.x0; x <= obb.x1; x++) {
        const cell = grid.getCell(x, y, z);
        if (isSolid(cell) && obb.overlapsCell(x, y, z) && fn(x, y, z, cell) === true) return;
      }
    }
  }
}

/** True when `box` truly overlaps any solid cell of `grid`. Allocation-free for the world. */
export function boxOverlapsSolid(grid: VoxelGrid, box: AABB): boolean {
  return overlapsSolid(grid, box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ);
}

// ====================================================================== penetration

export interface Penetration {
  /** Unit push direction in WORLD space. */
  nx: number;
  ny: number;
  nz: number;
  /** > 0: distance the box must move along the normal to clear the cell's face. */
  depth: number;
  /** Local cell that produced this push. */
  cx: number;
  cy: number;
  cz: number;
}

export interface PushOptions {
  /** World-space unit vector the push should lean toward (e.g. a blade's sweep direction). */
  prefer?: Vec3;
  /** Strength of the lean, in blocks of depth per unit of alignment. Default DEFAULT_PREFER_WEIGHT. */
  preferWeight?: number;
}

/**
 * Core of deepestPenetration over an explicit candidate range. Local box bounds are
 * [lminX, lmaxX] etc. (for a rotated grid: the OBB's local AABB, i.e. its projections on the
 * local axes). `obb` null means identity rotation. Writes the result into `out`.
 */
function findPenetration(
  grid: VoxelGrid,
  obb: LocalObb | null,
  lminX: number,
  lminY: number,
  lminZ: number,
  lmaxX: number,
  lmaxY: number,
  lmaxZ: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  px: number,
  py: number,
  pz: number,
  weight: number,
  out: Penetration,
): boolean {
  const m = obb !== null ? obb.m : null;
  let found = false;
  let bestOverlap = 0;
  let bestDepth = 0;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (!isSolid(grid.getCell(x, y, z))) continue;
        if (obb !== null && !obb.overlapsCell(x, y, z)) continue;
        // Candidate push directions: only the cell's EXPOSED faces. A face shared with
        // another solid cell can never be a contact face; considering it is what makes boxes
        // snag on the internal edges of floors and walls built from many cells.
        let cellScore = Infinity;
        let cellDepth = 0;
        let cellDir = -1;
        // How deeply the box really overlaps this cell: the smallest push over ALL six faces.
        let overlap = Infinity;
        for (let d = 0; d < 6; d++) {
          // Distance the box must travel along local face normal d so that its projection
          // on d starts at the face plane.
          let depth: number;
          switch (d) {
            case 0:
              depth = x + 1 - lminX;
              break;
            case 1:
              depth = lmaxX - x;
              break;
            case 2:
              depth = y + 1 - lminY;
              break;
            case 3:
              depth = lmaxY - y;
              break;
            case 4:
              depth = z + 1 - lminZ;
              break;
            default:
              depth = lmaxZ - z;
              break;
          }
          if (depth < overlap) overlap = depth;
          if (isSolid(grid.getCell(x + DIR_X[d]!, y + DIR_Y[d]!, z + DIR_Z[d]!))) continue;
          let score = depth;
          if (weight !== 0) {
            // World normal of local face d = ±(column (d>>1) of the rotation matrix).
            const a = d >> 1;
            const s = (d & 1) === 0 ? weight : -weight;
            const dot = m !== null ? m[a]! * px + m[3 + a]! * py + m[6 + a]! * pz : a === 0 ? px : a === 1 ? py : pz;
            score -= s * dot;
          }
          if (score < cellScore) {
            cellScore = score;
            cellDepth = depth; // report the TRUE depth, never the biased score (LESSONS)
            cellDir = d;
          }
        }
        if (cellDir < 0) continue; // fully enclosed cell: no way out through it
        // Worst cell first, where "worst" is the TRUE overlap, not the exposed-face depth.
        // A cell the box only grazes through a solid neighbour (the deck cell under a hull
        // wall, overlapped by a sliver at the inner corner) can have only far-away exposed
        // faces; ranking by exposed depth would pick it and shove the box through the wall.
        // Ties (common on the grid) go to the smaller exposed push.
        if (!found || overlap > bestOverlap || (overlap === bestOverlap && cellDepth < bestDepth)) {
          found = true;
          bestOverlap = overlap;
          bestDepth = cellDepth;
          const a = cellDir >> 1;
          const s = (cellDir & 1) === 0 ? 1 : -1;
          if (m !== null) {
            out.nx = s * m[a]!;
            out.ny = s * m[3 + a]!;
            out.nz = s * m[6 + a]!;
          } else {
            out.nx = a === 0 ? s : 0;
            out.ny = a === 1 ? s : 0;
            out.nz = a === 2 ? s : 0;
          }
          out.depth = cellDepth;
          out.cx = x;
          out.cy = y;
          out.cz = z;
        }
      }
    }
  }
  return found;
}

function preferParams(opts: PushOptions | undefined): { px: number; py: number; pz: number; w: number } | null {
  const p = opts?.prefer;
  if (p === undefined) return null;
  const w = opts!.preferWeight ?? DEFAULT_PREFER_WEIGHT;
  if (w === 0 || !Number.isFinite(w)) return null;
  return { px: p.x, py: p.y, pz: p.z, w };
}

/** World-path penetration on box coordinates. */
function worldPenetration(
  grid: VoxelGrid,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  px: number,
  py: number,
  pz: number,
  w: number,
  out: Penetration,
): boolean {
  const x0 = Math.floor(minX + CONTACT_EPS);
  const x1 = Math.ceil(maxX - CONTACT_EPS) - 1;
  const y0 = Math.floor(minY + CONTACT_EPS);
  let y1 = Math.ceil(maxY - CONTACT_EPS) - 1;
  const z0 = Math.floor(minZ + CONTACT_EPS);
  const z1 = Math.ceil(maxZ - CONTACT_EPS) - 1;
  if (y1 >= WORLD_HEIGHT) y1 = WORLD_HEIGHT - 1;
  return findPenetration(grid, null, minX, minY, minZ, maxX, maxY, maxZ, x0, x1, y0, y1, z0, z1, px, py, pz, w, out);
}

/** Structure-path penetration for an OBB at its current centre. */
function obbPenetration(
  grid: VoxelGrid,
  obb: LocalObb,
  bounds: CellBounds,
  px: number,
  py: number,
  pz: number,
  w: number,
  out: Penetration,
): boolean {
  if (!obb.range(bounds)) return false;
  return findPenetration(
    grid,
    obb,
    obb.cx - obb.ex,
    obb.cy - obb.ey,
    obb.cz - obb.ez,
    obb.cx + obb.ex,
    obb.cy + obb.ey,
    obb.cz + obb.ez,
    obb.x0,
    obb.x1,
    obb.y0,
    obb.y1,
    obb.z0,
    obb.z1,
    px,
    py,
    pz,
    w,
    out,
  );
}

function newPenetration(): Penetration {
  return { nx: 0, ny: 0, nz: 0, depth: 0, cx: 0, cy: 0, cz: 0 };
}

/**
 * The push that resolves the worst overlapping solid cell. For every truly overlapping solid
 * cell the candidate directions are its exposed local face normals (faces whose neighbour is
 * not solid); the cell picks the shallowest one, biased by `opts.prefer` (minimises
 * depth - preferWeight * dot(normal, prefer)). The cell whose true overlap (smallest push
 * over all six faces) is LARGEST wins; ties go to the smaller exposed push. The reported
 * depth is always the true geometric depth along the chosen normal. Null when no overlapping
 * cell has an exposed face (check boxOverlapsSolid to tell "free" from "fully embedded").
 */
export function deepestPenetration(grid: VoxelGrid, box: AABB, opts?: PushOptions): Penetration | null {
  const { minX, minY, minZ, maxX, maxY, maxZ } = box;
  if (!(maxX >= minX && maxY >= minY && maxZ >= minZ)) return null;
  const pref = preferParams(opts);
  const px = pref?.px ?? 0;
  const py = pref?.py ?? 0;
  const pz = pref?.pz ?? 0;
  const w = pref?.w ?? 0;
  const out = newPenetration();
  if (grid.isWorld) {
    return worldPenetration(grid, minX, minY, minZ, maxX, maxY, maxZ, px, py, pz, w, out) ? out : null;
  }
  const s = structureObb(grid, minX, minY, minZ, maxX, maxY, maxZ);
  if (s === null) return null;
  return obbPenetration(grid, s.obb, s.bounds, px, py, pz, w, out) ? out : null;
}

export interface PenetrationResolution {
  /** Accumulated world-space displacement to apply to the box. */
  dx: number;
  dy: number;
  dz: number;
  /** True when the displaced box overlaps no solid cell of the grid. */
  resolved: boolean;
  /** Number of pushes applied. */
  iterations: number;
  /** World normal of the last push (0,0,0 if none). */
  nx: number;
  ny: number;
  nz: number;
}

/**
 * Repeatedly applies deepestPenetration to a copy of `box` until it is free or
 * `maxIterations` pushes were applied. Never mutates `box`. `resolved` is false when the cap
 * was hit or the remaining overlap has no exposed face (the box is embedded: callers then
 * fall back to nearestFreeOffset / crush handling).
 */
export function resolvePenetration(
  grid: VoxelGrid,
  box: AABB,
  maxIterations = 6,
  opts?: PushOptions,
): PenetrationResolution {
  const res: PenetrationResolution = { dx: 0, dy: 0, dz: 0, resolved: true, iterations: 0, nx: 0, ny: 0, nz: 0 };
  const { minX, minY, minZ, maxX, maxY, maxZ } = box;
  if (!(maxX >= minX && maxY >= minY && maxZ >= minZ)) return res;
  const pref = preferParams(opts);
  const px = pref?.px ?? 0;
  const py = pref?.py ?? 0;
  const pz = pref?.pz ?? 0;
  const w = pref?.w ?? 0;
  const pen = newPenetration();
  let dx = 0;
  let dy = 0;
  let dz = 0;
  let it = 0;
  if (grid.isWorld) {
    for (;;) {
      if (!worldPenetration(grid, minX + dx, minY + dy, minZ + dz, maxX + dx, maxY + dy, maxZ + dz, px, py, pz, w, pen)) {
        res.resolved = !worldHasSolid(grid, minX + dx, minY + dy, minZ + dz, maxX + dx, maxY + dy, maxZ + dz);
        break;
      }
      if (it >= maxIterations) {
        res.resolved = false;
        break;
      }
      dx += pen.nx * pen.depth;
      dy += pen.ny * pen.depth;
      dz += pen.nz * pen.depth;
      res.nx = pen.nx;
      res.ny = pen.ny;
      res.nz = pen.nz;
      it++;
    }
  } else {
    const s = structureObb(grid, minX, minY, minZ, maxX, maxY, maxZ);
    if (s !== null) {
      const { obb, bounds } = s;
      for (;;) {
        obb.setWorldOffset(dx, dy, dz);
        if (!obbPenetration(grid, obb, bounds, px, py, pz, w, pen)) {
          res.resolved = !(obb.range(bounds) && obb.hasSolid(grid));
          break;
        }
        if (it >= maxIterations) {
          res.resolved = false;
          break;
        }
        dx += pen.nx * pen.depth;
        dy += pen.ny * pen.depth;
        dz += pen.nz * pen.depth;
        res.nx = pen.nx;
        res.ny = pen.ny;
        res.nz = pen.nz;
        it++;
      }
    }
  }
  res.dx = dx;
  res.dy = dy;
  res.dz = dz;
  res.iterations = it;
  return res;
}

// ====================================================================== sweep

/** Does layer `k` along `axis` contain a solid cell inside the given cross-section ranges? */
function worldLayerHasSolid(
  grid: VoxelGrid,
  axis: 0 | 1 | 2,
  k: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): boolean {
  if (axis === 0) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) if (isSolid(grid.getCell(k, y, z))) return true;
  } else if (axis === 1) {
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (isSolid(grid.getCell(x, k, z))) return true;
  } else {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (isSolid(grid.getCell(x, y, k))) return true;
  }
  return false;
}

/**
 * Classic voxel sweep against the WORLD only (throws for structures: use the SAT push-out
 * there). Returns the largest displacement with the sign of `delta` and magnitude <= |delta|
 * the box can move along world `axis` without newly entering a solid cell. Cells the box
 * already overlaps are ignored, so a box can always move out of an overlap. A blocked result
 * leaves the box touching the obstacle (within CONTACT_EPS), never overlapping it.
 * Cost is one layer scan per crossed cell, so large deltas cannot tunnel.
 */
export function sweepAxis(grid: VoxelGrid, box: AABB, axis: 0 | 1 | 2, delta: number): number {
  if (!grid.isWorld) throw new Error('sweepAxis: only the world grid can be swept; use resolvePenetration for structures');
  if (delta === 0 || delta !== delta) return 0;
  const { minX, minY, minZ, maxX, maxY, maxZ } = box;
  if (!(maxX >= minX && maxY >= minY && maxZ >= minZ)) return delta;
  // Cross-section cells: those the box overlaps strictly on the two other axes.
  const x0 = Math.floor(minX + CONTACT_EPS);
  const x1 = Math.ceil(maxX - CONTACT_EPS) - 1;
  const y0 = Math.floor(minY + CONTACT_EPS);
  let y1 = Math.ceil(maxY - CONTACT_EPS) - 1;
  const z0 = Math.floor(minZ + CONTACT_EPS);
  const z1 = Math.ceil(maxZ - CONTACT_EPS) - 1;
  if (axis !== 1) {
    // Nothing at or above the build limit is solid.
    if (y1 >= WORLD_HEIGHT) y1 = WORLD_HEIGHT - 1;
    if (y0 > y1 || x0 > x1 || z0 > z1) return delta;
  } else if (x0 > x1 || z0 > z1) {
    return delta;
  }
  const lo = axis === 0 ? minX : axis === 1 ? minY : minZ;
  const hi = axis === 0 ? maxX : axis === 1 ? maxY : maxZ;
  if (delta > 0) {
    // First layer not already overlapped, then every layer the moved box would overlap.
    const end = hi + delta - CONTACT_EPS;
    for (let k = Math.ceil(hi - CONTACT_EPS); k < end; k++) {
      if (axis === 1 && k >= WORLD_HEIGHT) break;
      if (worldLayerHasSolid(grid, axis, k, x0, x1, y0, y1, z0, z1)) {
        const d = k - hi;
        return d > 0 ? d : 0;
      }
    }
    return delta;
  }
  const end = lo + delta + CONTACT_EPS;
  let k = Math.floor(lo + CONTACT_EPS) - 1;
  if (axis === 1 && k > WORLD_HEIGHT - 1) k = WORLD_HEIGHT - 1; // air above the build limit
  for (; k + 1 > end; k--) {
    if (worldLayerHasSolid(grid, axis, k, x0, x1, y0, y1, z0, z1)) {
      const d = k + 1 - lo;
      return d < 0 ? d : 0;
    }
  }
  return delta;
}

// ====================================================================== support

/**
 * The probe used by the standing / attach / column tests: `box` shrunk horizontally by
 * `inset` on all four sides (collapsed to its centre line if the inset exceeds the half
 * width), spanning vertically from box.minY - maxGap to box.minY. `out` may alias `box`.
 * Use maxGap > CONTACT_EPS: a zero-height probe touches but never overlaps.
 */
export function supportProbe(box: AABB, maxGap: number, inset: number, out: AABB = aabb()): AABB {
  let minX = box.minX + inset;
  let maxX = box.maxX - inset;
  let minZ = box.minZ + inset;
  let maxZ = box.maxZ - inset;
  if (minX > maxX) minX = maxX = (box.minX + box.maxX) * 0.5;
  if (minZ > maxZ) minZ = maxZ = (box.minZ + box.maxZ) * 0.5;
  const feet = box.minY;
  out.minX = minX;
  out.maxX = maxX;
  out.minZ = minZ;
  out.maxZ = maxZ;
  out.minY = feet - maxGap;
  out.maxY = feet;
  return out;
}

/** Overlap test of the support probe, computed without allocating the probe box. */
function probeOverlapsSolid(grid: VoxelGrid, box: AABB, depth: number, inset: number): boolean {
  let minX = box.minX + inset;
  let maxX = box.maxX - inset;
  let minZ = box.minZ + inset;
  let maxZ = box.maxZ - inset;
  if (minX > maxX) minX = maxX = (box.minX + box.maxX) * 0.5;
  if (minZ > maxZ) minZ = maxZ = (box.minZ + box.maxZ) * 0.5;
  return overlapsSolid(grid, minX, box.minY - depth, minZ, maxX, box.minY, maxZ);
}

/**
 * boxOverlapsSolid(grid, supportProbe(box, maxGap, inset)). inset 0: "standing on" test;
 * inset > 0: the stricter "attach to this structure" test (attach range must be strictly
 * inside the push range, docs/LESSONS.md).
 */
export function hasSupportBelow(grid: VoxelGrid, box: AABB, maxGap: number, inset = 0): boolean {
  return probeOverlapsSolid(grid, box, maxGap, inset);
}

/**
 * Any solid cell of `grid` under the (inset) footprint of `box` within `maxDepth` below its
 * feet, measured along WORLD down. Keeps a jumping rider attached to a ship ("脚下整列").
 */
export function columnHasSolidBelow(grid: VoxelGrid, box: AABB, maxDepth: number, inset = 0): boolean {
  return probeOverlapsSolid(grid, box, maxDepth, inset);
}

// ====================================================================== free spot

/** Integer square root for small non-negative integers. */
function isqrt(n: number): number {
  return Math.floor(Math.sqrt(n));
}

/** Lattice spacing of nearestFreeOffset candidates, in blocks. */
export const FREE_OFFSET_STEP = 0.25;

/**
 * Smallest-3D-length offset (lattice step FREE_OFFSET_STEP, length <= maxRadius) such that
 * the translated box overlaps no solid cell of ANY grid (the same boxOverlapsSolid test the
 * push-out uses) and passes `extraTest`. Returns (0,0,0) when the box is already free, null
 * when no candidate qualifies.
 *
 * Candidates are enumerated in exact order of increasing length, shell by shell (integer
 * squared length), with a fixed order inside a shell: higher y first, then x ascending, then
 * z ascending — fully deterministic and allocation-free per candidate. The AABB passed to
 * `extraTest` is reused between calls; do not keep it.
 * Worst case (nothing free) tests every lattice point of the ball: ~270 * maxRadius^3.
 */
export function nearestFreeOffset(
  grids: readonly VoxelGrid[],
  box: AABB,
  maxRadius: number,
  extraTest?: (candidate: AABB) => boolean,
): Vec3 | null {
  const { minX, minY, minZ, maxX, maxY, maxZ } = box;
  if (!(maxX >= minX && maxY >= minY && maxZ >= minZ)) return null;
  const n = grids.length;
  // Per structure: the local OBB is built once and only translated per candidate. Structures
  // the box cannot reach within maxRadius are dropped up front.
  const obbs: Array<LocalObb | null> = [];
  const bounds: Array<CellBounds | null> = [];
  const list: VoxelGrid[] = [];
  const radius = maxRadius > 0 ? maxRadius : 0;
  for (let i = 0; i < n; i++) {
    const g = grids[i]!;
    if (g.isWorld) {
      list.push(g);
      obbs.push(null);
      bounds.push(null);
      continue;
    }
    const s = structureObb(g, minX, minY, minZ, maxX, maxY, maxZ);
    if (s === null || !s.obb.range(s.bounds, radius)) continue;
    list.push(g);
    obbs.push(s.obb);
    bounds.push(s.bounds);
  }
  const cand = aabb();
  const isFree = (ox: number, oy: number, oz: number): boolean => {
    const x0 = minX + ox;
    const y0 = minY + oy;
    const z0 = minZ + oz;
    const x1 = maxX + ox;
    const y1 = maxY + oy;
    const z1 = maxZ + oz;
    for (let i = 0; i < list.length; i++) {
      const obb = obbs[i]!;
      if (obb === null) {
        if (worldHasSolid(list[i]!, x0, y0, z0, x1, y1, z1)) return false;
      } else {
        obb.setWorldOffset(ox, oy, oz);
        if (obb.range(bounds[i]!) && obb.hasSolid(list[i]!)) return false;
      }
    }
    if (extraTest !== undefined) {
      cand.minX = x0;
      cand.minY = y0;
      cand.minZ = z0;
      cand.maxX = x1;
      cand.maxY = y1;
      cand.maxZ = z1;
      if (!extraTest(cand)) return false;
    }
    return true;
  };
  const step = FREE_OFFSET_STEP;
  const lattice = radius / step;
  const sMax = Math.floor(lattice * lattice + 1e-9);
  for (let s = 0; s <= sMax; s++) {
    const jm = isqrt(s);
    for (let j = jm; j >= -jm; j--) {
      const rem = s - j * j;
      const im = isqrt(rem);
      for (let i = -im; i <= im; i++) {
        const r = rem - i * i;
        const k = isqrt(r);
        if (k * k !== r) continue;
        if (isFree(i * step, j * step, -k * step)) return vec3(i * step + 0, j * step + 0, -k * step + 0);
        if (k !== 0 && isFree(i * step, j * step, k * step)) return vec3(i * step + 0, j * step + 0, k * step);
      }
    }
  }
  return null;
}
