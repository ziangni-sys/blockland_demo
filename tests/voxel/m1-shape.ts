/**
 * TEST ORACLE, not product code: the box queries of src/voxel/shape.ts exactly as they were
 * before Milestone 2.3 (commit c20ea8e), frozen. docs/SHAPES.md 5.1 requires that in a world of
 * full blocks every query answers bit for bit what M1 answered; tests/voxel/shape-parts.test.ts
 * compares the current module with this copy on random full-block scenes (world, axis-aligned
 * and rotated structures). Only the import paths differ from the original; do not edit it.
 *
 * The original file comment follows.
 */
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
 * Invalid boxes (a coordinate that is NaN, infinite or beyond ±MAX_BOX_COORD, or min > max on
 * some axis) are treated as EMPTY by every query: they overlap nothing, have no penetration
 * or support, are never moved by sweepAxis and have no free offset. This is what guarantees
 * that every query terminates: a loop counter starting at -Infinity (or at any magnitude
 * >= 2^53) can never advance, and World.getCell aliases such coordinates onto loaded chunks.
 *
 * "Solid" always means SOLID[id] === 1 (HARD blocks).
 */
import { CHUNK_MASK, WORLD_HEIGHT } from '../../src/core/constants';
import { DIR_X, DIR_Y, DIR_Z } from '../../src/core/dirs';
import { EPS, aabb, vec3, type AABB, type Quat, type Vec3 } from '../../src/core/math';
import { ID_MASK } from '../../src/blocks/cell';
// Importing defs also registers the block table, which is what fills SOLID (including the
// deeprock / unloaded sentinels the world returns), so queries never see an empty table.
import { CELL_BELOW_WORLD, CELL_UNLOADED } from '../../src/blocks/defs';
import { SOLID } from '../../src/blocks/registry';
import { cellIndex } from '../../src/voxel/chunk';
import type { CellBounds, VoxelGrid } from '../../src/voxel/grid';
import { World } from '../../src/voxel/world';

/** Overlap tolerance: separation within this distance counts as touching, not overlapping. */
export const CONTACT_EPS = EPS;

/** Default bias strength for PushOptions.prefer when preferWeight is not given. */
export const DEFAULT_PREFER_WEIGHT = 0.25;

/**
 * Largest |coordinate| a query box may have; boxes reaching beyond are invalid (empty).
 * Far outside anything the world can store (World.posKey supports |x|,|z| < 2^22), yet small
 * enough that integer cell loops advance exactly and `x >> 4` chunk maths stays in int32.
 */
export const MAX_BOX_COORD = 2 ** 24;

/** resolvePenetration never applies more pushes than this, whatever maxIterations says. */
export const MAX_RESOLVE_ITERATIONS = 64;

/** nearestFreeOffset clamps maxRadius to this (the worst case grows with radius^3). */
export const MAX_FREE_RADIUS = 8;

/** Rotation-matrix entries this close to 0 / ±1 are snapped: the rotation is axis-aligned. */
const ALIGN_TOL = 1e-12;
/** Edge-edge SAT axes shorter than this (near-parallel edges) are redundant and skipped. */
const SAT_MIN_AXIS = 1e-12;

function isSolid(cell: number): boolean {
  return SOLID[cell & ID_MASK] === 1;
}

/**
 * Valid query box: every coordinate within ±MAX_BOX_COORD (which also rejects NaN and
 * ±Infinity, since every comparison with NaN is false) and min <= max on every axis.
 * Takes the coordinates rather than an AABB so probe boxes need not be materialised.
 */
function validBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
  return (
    minX >= -MAX_BOX_COORD &&
    minX <= maxX &&
    maxX <= MAX_BOX_COORD &&
    minY >= -MAX_BOX_COORD &&
    minY <= maxY &&
    maxY <= MAX_BOX_COORD &&
    minZ >= -MAX_BOX_COORD &&
    minZ <= maxZ &&
    maxZ <= MAX_BOX_COORD
  );
}

// ====================================================================== local OBB

/**
 * A world AABB expressed in a structure grid's local space. Built once per query (and then
 * translated cheaply for iterative queries) so the rotation is only fetched once.
 *
 * Cost model: building is a handful of multiplies and one small allocation; the SAT axes are
 * only derived when a SOLID candidate cell actually needs the exact test, so queries that
 * miss the structure (the common case: every entity against every nearby structure) stay
 * cheap. Plain arrays rather than typed arrays: allocating an ArrayBuffer per query costs
 * more than the whole early-out.
 */
class LocalObb {
  /**
   * Row-major local->world rotation. Row i is world axis i expressed in local coordinates
   * (the box's own axes, seen from the grid); column j is local axis j in world coordinates.
   */
  readonly m: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  /** SAT axes beyond the cell axes, per axis [Lx, Ly, Lz, rA + rB]; built lazily. */
  private sat: number[] | null = null;
  private satCount = 0;
  /** True when the rotation is a signed axis permutation: the box is an AABB in local space. */
  aligned = true;
  /** The structure's cell bounds (non-null: empty structures never get an OBB). */
  bounds: CellBounds;
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
  private readonly q: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly p: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(bounds: CellBounds) {
    this.bounds = bounds;
  }

  build(grid: VoxelGrid, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void {
    const m = this.m;
    const q = grid.worldRotation(this.q);
    // Same formula as core/math qtoMat3, written into a plain array.
    const { x, y, z, w } = q;
    m[0] = 1 - 2 * (y * y + z * z);
    m[1] = 2 * (x * y - w * z);
    m[2] = 2 * (x * z + w * y);
    m[3] = 2 * (x * y + w * z);
    m[4] = 1 - 2 * (x * x + z * z);
    m[5] = 2 * (y * z - w * x);
    m[6] = 2 * (x * z - w * y);
    m[7] = 2 * (y * z + w * x);
    m[8] = 1 - 2 * (x * x + y * y);
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
    this.satCount = -1; // not built yet
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
    const sat = (this.sat ??= new Array<number>(12 * 4).fill(0));
    const { hx, hy, hz } = this;
    let n = 0;
    for (let i = 0; i < 3; i++) {
      const ax = m[i * 3]!;
      const ay = m[i * 3 + 1]!;
      const az = m[i * 3 + 2]!;
      const h = i === 0 ? hx : i === 1 ? hy : hz;
      const o = n * 4;
      sat[o] = ax;
      sat[o + 1] = ay;
      sat[o + 2] = az;
      sat[o + 3] = h + 0.5 * (Math.abs(ax) + Math.abs(ay) + Math.abs(az));
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
        const o = n * 4;
        sat[o] = lx;
        sat[o + 1] = ly;
        sat[o + 2] = lz;
        sat[o + 3] = rA + rB;
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
  range(margin = 0): boolean {
    const b = this.bounds;
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
    if (this.aligned) return true;
    if (this.satCount < 0) this.buildSatAxes();
    const n = this.satCount;
    const sat = this.sat!;
    // Relative position first: keeps the dot products small and accurate.
    const tx = x + 0.5 - this.cx;
    const ty = y + 0.5 - this.cy;
    const tz = z + 0.5 - this.cz;
    for (let k = 0, o = 0; k < n; k++, o += 4) {
      const d = tx * sat[o]! + ty * sat[o + 1]! + tz * sat[o + 2]!;
      if ((d < 0 ? -d : d) >= sat[o + 3]! - CONTACT_EPS) return false;
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
): LocalObb | null {
  const bounds = grid.cellBounds();
  if (bounds === null) return null; // empty structure (only the world is unbounded)
  const obb = new LocalObb(bounds);
  obb.build(grid, minX, minY, minZ, maxX, maxY, maxZ);
  return obb;
}

// ====================================================================== world fast path
// The world has an identity transform: the box is already an AABB in local space, every cell
// of the candidate range truly overlaps, and nothing above WORLD_HEIGHT is solid.
//
// ALLOCATION NOTE: V8 passes numbers between non-inlined functions as tagged values, so a
// freshly computed non-integer double handed to another function is boxed into a new heap
// number. The world paths therefore only pass integer cell coordinates (small integers are
// never boxed) or objects across function boundaries; box coordinates are read where used.
//
// CACHE NOTE: World keeps a single-entry chunk cache, and a miss costs a Map lookup with a
// heap-allocated numeric key. Boolean world scans therefore walk column-major (y innermost)
// and fetch each column's chunk once, so a box straddling a chunk border switches chunks
// once per column, not once per cell.

/**
 * Any solid world cell in the inclusive cell range (integer arguments only, see above)?
 *
 * For World instances this reads each column's chunk ONCE and indexes its cell array
 * directly, reproducing World.getCell's rules (below 0: CELL_BELOW_WORLD; at or above
 * WORLD_HEIGHT: air; unloaded column: CELL_UNLOADED). Calling getCell per cell instead was
 * measured (node 22) to allocate ~30 bytes per call whenever the scan ran to completion, i.e.
 * on every query for a FREE box (the common case): TurboFan's loop peeling boxes heap numbers
 * when getCell is inlined into a y-innermost loop. The direct scan is allocation-free and
 * about twice as fast. Any other world implementation goes through getCell.
 */
function worldRangeHasSolid(grid: VoxelGrid, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): boolean {
  if (y1 >= WORLD_HEIGHT) y1 = WORLD_HEIGHT - 1;
  if (x0 > x1 || y0 > y1 || z0 > z1) return false;
  if (!(grid instanceof World)) return genericRangeHasSolid(grid, x0, x1, y0, y1, z0, z1);
  if (y0 < 0) {
    if (SOLID[CELL_BELOW_WORLD & ID_MASK] === 1) return true;
    y0 = 0;
    if (y0 > y1) return false;
  }
  for (let x = x0; x <= x1; x++) {
    const lx = x & CHUNK_MASK;
    for (let z = z0; z <= z1; z++) {
      const chunk = grid.chunkAt(x, z);
      if (chunk === undefined) {
        if (SOLID[CELL_UNLOADED & ID_MASK] === 1) return true;
        continue;
      }
      const cells = chunk.cells;
      const lz = z & CHUNK_MASK;
      for (let y = y0; y <= y1; y++) {
        if (SOLID[cells[cellIndex(lx, y, lz)]! & ID_MASK] === 1) return true;
      }
    }
  }
  return false;
}

/** worldRangeHasSolid through the VoxelGrid interface (non-World world grids). */
function genericRangeHasSolid(grid: VoxelGrid, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): boolean {
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        if (SOLID[grid.getCell(x, y, z) & ID_MASK] === 1) return true;
      }
    }
  }
  return false;
}

/** Structure-path overlap test on box coordinates (allocates the local OBB). */
function structureHasSolid(
  grid: VoxelGrid,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): boolean {
  const obb = structureObb(grid, minX, minY, minZ, maxX, maxY, maxZ);
  return obb !== null && obb.range() && obb.hasSolid(grid);
}

// ====================================================================== overlap

/**
 * Visit every solid cell whose unit cube truly overlaps `box` (touching within CONTACT_EPS
 * does not count), in y, z, x order. `fn` returning true stops the iteration.
 * Do not modify the grid from inside `fn`. Visits nothing for an invalid box.
 */
export function forEachSolidCellOverlapping(
  grid: VoxelGrid,
  box: AABB,
  fn: (x: number, y: number, z: number, cell: number) => boolean | void,
): void {
  const { minX, minY, minZ, maxX, maxY, maxZ } = box;
  if (!validBox(minX, minY, minZ, maxX, maxY, maxZ)) return;
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
  const obb = structureObb(grid, minX, minY, minZ, maxX, maxY, maxZ);
  if (obb === null || !obb.range()) return;
  for (let y = obb.y0; y <= obb.y1; y++) {
    for (let z = obb.z0; z <= obb.z1; z++) {
      for (let x = obb.x0; x <= obb.x1; x++) {
        const cell = grid.getCell(x, y, z);
        if (isSolid(cell) && obb.overlapsCell(x, y, z) && fn(x, y, z, cell) === true) return;
      }
    }
  }
}

/**
 * True when `box` truly overlaps any solid cell of `grid` (false for an invalid box).
 * Allocation-free for the world.
 */
export function boxOverlapsSolid(grid: VoxelGrid, box: AABB): boolean {
  const { minX, minY, minZ, maxX, maxY, maxZ } = box;
  if (!validBox(minX, minY, minZ, maxX, maxY, maxZ)) return false;
  if (grid.isWorld) {
    return worldRangeHasSolid(
      grid,
      Math.floor(minX + CONTACT_EPS),
      Math.ceil(maxX - CONTACT_EPS) - 1,
      Math.floor(minY + CONTACT_EPS),
      Math.ceil(maxY - CONTACT_EPS) - 1,
      Math.floor(minZ + CONTACT_EPS),
      Math.ceil(maxZ - CONTACT_EPS) - 1,
    );
  }
  return structureHasSolid(grid, minX, minY, minZ, maxX, maxY, maxZ);
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

/** Normalised push bias: world-space vector and weight. */
interface Prefer {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** The bias to apply, or null for none. A non-finite vector or weight is ignored, not trusted:
 * a NaN score would make every candidate face lose and report "no push" for an overlap. */
function preferParams(opts: PushOptions | undefined): Prefer | null {
  const p = opts?.prefer;
  if (p === undefined) return null;
  const w = opts!.preferWeight ?? DEFAULT_PREFER_WEIGHT;
  if (w === 0 || !Number.isFinite(w)) return null;
  if (!(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) return null;
  return { x: p.x, y: p.y, z: p.z, w };
}

/**
 * Core of deepestPenetration over the inclusive candidate range x0..z1 (integers). The box's
 * local bounds come from `obb` (its local AABB, i.e. its projections on the local axes) or,
 * for the world (identity rotation, obb null), from the world box `wb`. Writes into `out`.
 */
function findPenetration(
  grid: VoxelGrid,
  obb: LocalObb | null,
  wb: AABB | null,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  pref: Prefer | null,
  out: Penetration,
): boolean {
  const m = obb !== null ? obb.m : null;
  const lminX = obb !== null ? obb.cx - obb.ex : wb!.minX;
  const lminY = obb !== null ? obb.cy - obb.ey : wb!.minY;
  const lminZ = obb !== null ? obb.cz - obb.ez : wb!.minZ;
  const lmaxX = obb !== null ? obb.cx + obb.ex : wb!.maxX;
  const lmaxY = obb !== null ? obb.cy + obb.ey : wb!.maxY;
  const lmaxZ = obb !== null ? obb.cz + obb.ez : wb!.maxZ;
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
          if (pref !== null) {
            // World normal of local face d = ±(column (d>>1) of the rotation matrix).
            const a = d >> 1;
            const s = (d & 1) === 0 ? pref.w : -pref.w;
            const dot =
              m !== null ? m[a]! * pref.x + m[3 + a]! * pref.y + m[6 + a]! * pref.z : a === 0 ? pref.x : a === 1 ? pref.y : pref.z;
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
            // + 0 normalises -0 (from snapped zero entries) so results compare cleanly.
            out.nx = s * m[a]! + 0;
            out.ny = s * m[3 + a]! + 0;
            out.nz = s * m[6 + a]! + 0;
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

/** World-path penetration for box `b` (identity transform). */
function worldPenetration(grid: VoxelGrid, b: AABB, pref: Prefer | null, out: Penetration): boolean {
  return findPenetration(
    grid,
    null,
    b,
    Math.floor(b.minX + CONTACT_EPS),
    Math.ceil(b.maxX - CONTACT_EPS) - 1,
    Math.floor(b.minY + CONTACT_EPS),
    Math.min(Math.ceil(b.maxY - CONTACT_EPS) - 1, WORLD_HEIGHT - 1),
    Math.floor(b.minZ + CONTACT_EPS),
    Math.ceil(b.maxZ - CONTACT_EPS) - 1,
    pref,
    out,
  );
}

/** Structure-path penetration for an OBB at its current centre. */
function obbPenetration(grid: VoxelGrid, obb: LocalObb, pref: Prefer | null, out: Penetration): boolean {
  if (!obb.range()) return false;
  return findPenetration(grid, obb, null, obb.x0, obb.x1, obb.y0, obb.y1, obb.z0, obb.z1, pref, out);
}

function newPenetration(): Penetration {
  return { nx: 0, ny: 0, nz: 0, depth: 0, cx: 0, cy: 0, cz: 0 };
}

/**
 * The push that resolves the worst overlapping solid cell.
 *
 * Per cell: the candidate directions are the cell's EXPOSED local face normals (faces whose
 * neighbour is not solid); the cell picks the one with the smallest depth, biased by
 * `opts.prefer` (minimises depth - preferWeight * dot(n_world, prefer)). The depth along n is
 * the distance the box must travel along n to clear that face (for rotated grids measured
 * with the box's extent along the local axis). The REPORTED depth is always the true
 * geometric depth along the chosen normal, never the biased score.
 *
 * Across cells: the cell whose TRUE overlap (its smallest depth over all six faces, exposed
 * or not) is largest wins; on an exact tie the smaller exposed push wins. Ranking by exposed
 * depth instead would let a cell that is only grazed through a solid neighbour (the deck cell
 * under a hull wall, whose only exposed faces point out of the hull) decide the push, and
 * shove the box out through the wall.
 *
 * Null when the box is invalid, overlaps nothing, or no overlapping cell has an exposed face
 * (check boxOverlapsSolid to tell "free" from "fully embedded").
 */
export function deepestPenetration(grid: VoxelGrid, box: AABB, opts?: PushOptions): Penetration | null {
  const { minX, minY, minZ, maxX, maxY, maxZ } = box;
  if (!validBox(minX, minY, minZ, maxX, maxY, maxZ)) return null;
  const pref = preferParams(opts);
  const out = newPenetration();
  if (grid.isWorld) return worldPenetration(grid, box, pref, out) ? out : null;
  const obb = structureObb(grid, minX, minY, minZ, maxX, maxY, maxZ);
  if (obb === null) return null;
  return obbPenetration(grid, obb, pref, out) ? out : null;
}

export interface PenetrationResolution {
  /**
   * Accumulated world-space displacement. Apply it only when `resolved` is true; otherwise it
   * is a partial result (the pushes applied before giving up).
   */
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
 * Repeatedly applies deepestPenetration to a copy of `box` until it is free, then reports the
 * accumulated displacement. Never mutates `box`.
 *
 * `resolved` is false (and callers fall back to nearestFreeOffset / crush handling) when:
 *  - the cap was hit: min(maxIterations, MAX_RESOLVE_ITERATIONS) pushes were applied
 *    (a NaN or negative maxIterations means 0);
 *  - the remaining overlap has no exposed face (the box is embedded);
 *  - the next push would return the box to where the previous push started: it is wedged
 *    between cells that undo each other's push (e.g. a tall box between two staggered
 *    cells), which would only repeat until the cap.
 * An invalid box is reported resolved with zero displacement (it overlaps nothing).
 */
export function resolvePenetration(
  grid: VoxelGrid,
  box: AABB,
  maxIterations = 6,
  opts?: PushOptions,
): PenetrationResolution {
  const res: PenetrationResolution = { dx: 0, dy: 0, dz: 0, resolved: true, iterations: 0, nx: 0, ny: 0, nz: 0 };
  const { minX, minY, minZ, maxX, maxY, maxZ } = box;
  if (!validBox(minX, minY, minZ, maxX, maxY, maxZ)) return res;
  const cap = maxIterations >= 0 ? Math.min(Math.floor(maxIterations), MAX_RESOLVE_ITERATIONS) : 0;
  const isWorld = grid.isWorld;
  // World: a translated copy of the box. Structure: its local OBB, built once and translated.
  const cur: AABB | null = isWorld ? { minX, minY, minZ, maxX, maxY, maxZ } : null;
  const obb = isWorld ? null : structureObb(grid, minX, minY, minZ, maxX, maxY, maxZ);
  if (cur === null && obb === null) return res; // empty structure: nothing to resolve
  const pref = preferParams(opts);
  const pen = newPenetration();
  let dx = 0;
  let dy = 0;
  let dz = 0;
  // Displacement before the latest push (NaN until one was applied).
  let px = NaN;
  let py = NaN;
  let pz = NaN;
  let it = 0;
  for (;;) {
    let found: boolean;
    if (cur !== null) {
      cur.minX = minX + dx;
      cur.minY = minY + dy;
      cur.minZ = minZ + dz;
      cur.maxX = maxX + dx;
      cur.maxY = maxY + dy;
      cur.maxZ = maxZ + dz;
      found = worldPenetration(grid, cur, pref, pen);
    } else {
      obb!.setWorldOffset(dx, dy, dz);
      found = obbPenetration(grid, obb!, pref, pen);
    }
    if (!found) {
      res.resolved = cur !== null ? !boxOverlapsSolid(grid, cur) : !(obb!.range() && obb!.hasSolid(grid));
      break;
    }
    if (it >= cap) {
      res.resolved = false;
      break;
    }
    const ndx = dx + pen.nx * pen.depth;
    const ndy = dy + pen.ny * pen.depth;
    const ndz = dz + pen.nz * pen.depth;
    if (Math.abs(ndx - px) <= CONTACT_EPS && Math.abs(ndy - py) <= CONTACT_EPS && Math.abs(ndz - pz) <= CONTACT_EPS) {
      res.resolved = false; // two-cycle: the state would repeat until the cap
      break;
    }
    px = dx;
    py = dy;
    pz = dz;
    dx = ndx;
    dy = ndy;
    dz = ndz;
    res.nx = pen.nx;
    res.ny = pen.ny;
    res.nz = pen.nz;
    it++;
  }
  res.dx = dx;
  res.dy = dy;
  res.dz = dz;
  res.iterations = it;
  return res;
}

// ====================================================================== sweep
// Like worldRangeHasSolid, the column scans read World chunks directly: a getCell call inlined
// into these loops was measured to allocate on some axes (z sweeps: ~16 bytes per call).

/**
 * Lowest solid layer k in [k0, k1) of world column (x, z), or k1 when there is none.
 * Integer arguments only. Same cell rules as World.getCell.
 */
function columnFirstSolidUp(grid: VoxelGrid, x: number, z: number, k0: number, k1: number): number {
  if (!(grid instanceof World)) {
    for (let k = k0; k < k1; k++) if (isSolid(grid.getCell(x, k, z))) return k;
    return k1;
  }
  let k = k0;
  if (k < 0 && k < k1) {
    if (SOLID[CELL_BELOW_WORLD & ID_MASK] === 1) return k;
    k = 0;
  }
  const top = k1 < WORLD_HEIGHT ? k1 : WORLD_HEIGHT; // air at and above the build limit
  if (k >= top) return k1;
  const chunk = grid.chunkAt(x, z);
  if (chunk === undefined) return SOLID[CELL_UNLOADED & ID_MASK] === 1 ? k : k1;
  const cells = chunk.cells;
  const lx = x & CHUNK_MASK;
  const lz = z & CHUNK_MASK;
  for (; k < top; k++) if (SOLID[cells[cellIndex(lx, k, lz)]! & ID_MASK] === 1) return k;
  return k1;
}

/**
 * Highest solid layer k with k1 < k <= k0 of world column (x, z), scanning down from k0, or
 * k1 when there is none. Integer arguments only. Same cell rules as World.getCell.
 */
function columnFirstSolidDown(grid: VoxelGrid, x: number, z: number, k0: number, k1: number): number {
  if (!(grid instanceof World)) {
    for (let k = k0; k > k1; k--) if (isSolid(grid.getCell(x, k, z))) return k;
    return k1;
  }
  let k = k0 < WORLD_HEIGHT ? k0 : WORLD_HEIGHT - 1; // air at and above the build limit
  if (k <= k1) return k1;
  if (k >= 0) {
    const chunk = grid.chunkAt(x, z);
    if (chunk === undefined) {
      if (SOLID[CELL_UNLOADED & ID_MASK] === 1) return k;
      k = -1;
    } else {
      const cells = chunk.cells;
      const lx = x & CHUNK_MASK;
      const lz = z & CHUNK_MASK;
      const bottom = k1 >= 0 ? k1 + 1 : 0;
      for (; k >= bottom; k--) if (SOLID[cells[cellIndex(lx, k, lz)]! & ID_MASK] === 1) return k;
    }
    if (k <= k1) return k1;
  }
  return SOLID[CELL_BELOW_WORLD & ID_MASK] === 1 ? k : k1; // k < 0: deeprock
}

/**
 * Classic voxel sweep against the WORLD only (throws for structures: use the SAT push-out
 * there). Returns the largest displacement with the sign of `delta` and magnitude <= |delta|
 * the box can move along world `axis` without newly entering a solid cell. Cells the box
 * already overlaps are ignored, so a box can always move out of an overlap. A blocked result
 * leaves the box touching the obstacle (within CONTACT_EPS), never overlapping it.
 * Every crossed cell layer is scanned, so large deltas cannot tunnel; an infinite delta is
 * fine (the scan stops at deeprock, the build limit or the first unloaded chunk).
 * Returns 0 for a NaN delta and for an invalid box (a corrupt box is never moved further).
 * Allocation-free except for the returned number itself when the move is blocked short of a
 * whole cell (any JS function returning a fresh fractional double boxes it).
 */
export function sweepAxis(grid: VoxelGrid, box: AABB, axis: 0 | 1 | 2, delta: number): number {
  if (!grid.isWorld) throw new Error('sweepAxis: only the world grid can be swept; use resolvePenetration for structures');
  if (delta === 0 || delta !== delta) return 0;
  const { minX, minY, minZ, maxX, maxY, maxZ } = box;
  if (!validBox(minX, minY, minZ, maxX, maxY, maxZ)) return 0;
  // Cross-section cells: those the box overlaps strictly on the two other axes.
  const x0 = Math.floor(minX + CONTACT_EPS);
  const x1 = Math.ceil(maxX - CONTACT_EPS) - 1;
  const y0 = Math.floor(minY + CONTACT_EPS);
  const y1 = Math.ceil(maxY - CONTACT_EPS) - 1;
  const z0 = Math.floor(minZ + CONTACT_EPS);
  const z1 = Math.ceil(maxZ - CONTACT_EPS) - 1;

  if (axis === 1) {
    if (x0 > x1 || z0 > z1) return delta;
    // Vertical: column-major. Each column is scanned only up to the best blocking layer
    // found so far, so the total work is bounded by (columns x crossed layers).
    if (delta > 0) {
      const kStart = Math.ceil(maxY - CONTACT_EPS); // first layer not already overlapped
      // Layers k < maxY + delta - CONTACT_EPS would be entered; nothing at or above the build
      // limit is solid, which also bounds an infinite delta.
      let kEnd = Math.ceil(maxY + delta - CONTACT_EPS);
      if (kEnd > WORLD_HEIGHT) kEnd = WORLD_HEIGHT;
      let kStop = kEnd;
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) kStop = columnFirstSolidUp(grid, x, z, kStart, kStop);
      }
      if (kStop >= kEnd) return delta;
      const d = kStop - maxY;
      return d > 0 ? d : 0;
    }
    const kStart = Math.floor(minY + CONTACT_EPS) - 1; // highest layer not already overlapped
    // Layers k >= floor(minY + delta + CONTACT_EPS) would be entered. Nothing below
    // -MAX_BOX_COORD needs a scan (the world stops a fall at deeprock long before; this only
    // bounds an infinite delta on other world grids).
    let kLow = Math.floor(minY + delta + CONTACT_EPS);
    if (kLow < -MAX_BOX_COORD) kLow = -MAX_BOX_COORD;
    let kStop = kLow - 1; // highest blocking layer found so far (exclusive lower scan bound)
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) kStop = columnFirstSolidDown(grid, x, z, kStart, kStop);
    }
    if (kStop < kLow) return delta;
    const d = kStop + 1 - minY;
    return d < 0 ? d : 0;
  }

  // Horizontal: layer by layer along the axis (worldRangeHasSolid clips at the build limit).
  if (y0 > y1 || y0 >= WORLD_HEIGHT || x0 > x1 || z0 > z1) return delta;
  const lo = axis === 0 ? minX : minZ;
  const hi = axis === 0 ? maxX : maxZ;
  // Layers are integers k; the scan never needs to pass ±MAX_BOX_COORD: the world's unloaded
  // chunks stop it long before, and the clamp keeps an infinite delta finite on other grids.
  if (delta > 0) {
    let kEnd = Math.ceil(hi + delta - CONTACT_EPS); // layers k < kEnd would be entered
    if (kEnd > MAX_BOX_COORD) kEnd = MAX_BOX_COORD;
    for (let k = Math.ceil(hi - CONTACT_EPS); k < kEnd; k++) {
      const hit = axis === 0 ? worldRangeHasSolid(grid, k, k, y0, y1, z0, z1) : worldRangeHasSolid(grid, x0, x1, y0, y1, k, k);
      if (hit) {
        const d = k - hi;
        return d > 0 ? d : 0;
      }
    }
    return delta;
  }
  let kLow = Math.floor(lo + delta + CONTACT_EPS); // layers k >= kLow would be entered
  if (kLow < -MAX_BOX_COORD) kLow = -MAX_BOX_COORD;
  for (let k = Math.floor(lo + CONTACT_EPS) - 1; k >= kLow; k--) {
    const hit = axis === 0 ? worldRangeHasSolid(grid, k, k, y0, y1, z0, z1) : worldRangeHasSolid(grid, x0, x1, y0, y1, k, k);
    if (hit) {
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
  const maxY = box.minY;
  const minY = maxY - depth;
  if (!validBox(minX, minY, minZ, maxX, maxY, maxZ)) return false;
  if (grid.isWorld) {
    return worldRangeHasSolid(
      grid,
      Math.floor(minX + CONTACT_EPS),
      Math.ceil(maxX - CONTACT_EPS) - 1,
      Math.floor(minY + CONTACT_EPS),
      Math.ceil(maxY - CONTACT_EPS) - 1,
      Math.floor(minZ + CONTACT_EPS),
      Math.ceil(maxZ - CONTACT_EPS) - 1,
    );
  }
  return structureHasSolid(grid, minX, minY, minZ, maxX, maxY, maxZ);
}

/**
 * boxOverlapsSolid(grid, supportProbe(box, maxGap, inset)). inset 0: "standing on" test;
 * inset > 0: the stricter "attach to this structure" test (attach range must be strictly
 * inside the push range, docs/LESSONS.md). False when the probe is invalid (non-finite
 * input, NaN or negative maxGap).
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
 * when no candidate qualifies or the box is invalid.
 *
 * Candidates are enumerated in exact order of increasing length, shell by shell (integer
 * squared length), with a fixed order inside a shell: higher y first, then x ascending, then
 * z ascending — fully deterministic and allocation-free per candidate. The AABB passed to
 * `extraTest` is reused between calls; do not keep it.
 * maxRadius is clamped to [0, MAX_FREE_RADIUS] (NaN means 0). Worst case (nothing free)
 * tests every lattice point of the ball: ~270 * maxRadius^3 candidates per grid.
 */
export function nearestFreeOffset(
  grids: readonly VoxelGrid[],
  box: AABB,
  maxRadius: number,
  extraTest?: (candidate: AABB) => boolean,
): Vec3 | null {
  const { minX, minY, minZ, maxX, maxY, maxZ } = box;
  if (!validBox(minX, minY, minZ, maxX, maxY, maxZ)) return null;
  const n = grids.length;
  // Per structure: the local OBB is built once and only translated per candidate. Structures
  // the box cannot reach within maxRadius are dropped up front.
  const obbs: Array<LocalObb | null> = [];
  const list: VoxelGrid[] = [];
  const radius = maxRadius > 0 ? (maxRadius < MAX_FREE_RADIUS ? maxRadius : MAX_FREE_RADIUS) : 0;
  for (let i = 0; i < n; i++) {
    const g = grids[i]!;
    if (g.isWorld) {
      list.push(g);
      obbs.push(null);
      continue;
    }
    const obb = structureObb(g, minX, minY, minZ, maxX, maxY, maxZ);
    if (obb === null || !obb.range(radius)) continue;
    list.push(g);
    obbs.push(obb);
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
        const hit = worldRangeHasSolid(
          list[i]!,
          Math.floor(x0 + CONTACT_EPS),
          Math.ceil(x1 - CONTACT_EPS) - 1,
          Math.floor(y0 + CONTACT_EPS),
          Math.ceil(y1 - CONTACT_EPS) - 1,
          Math.floor(z0 + CONTACT_EPS),
          Math.ceil(z1 - CONTACT_EPS) - 1,
        );
        if (hit) return false;
      } else {
        obb.setWorldOffset(ox, oy, oz);
        if (obb.range() && obb.hasSolid(list[i]!)) return false;
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
