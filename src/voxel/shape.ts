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
 * SHAPES (docs/SHAPES.md section 5). Collision looks at a cell only through its solid fill f:
 * the octants occupied by hard material, the union over both parts (blocks/shapes.ts solidFill;
 * read here from the storage layers without forming a packed value, voxel/parts.ts solidFillAt).
 *  - f === 0: empty.
 *  - f === 0xff: a WHOLE-CELL unit, handled by the M1 algorithm bit for bit (a two-part cell
 *    that fills its cell too). The one exception is the push-out: a full cell with a partial
 *    face neighbour is pushed out of octant by octant (section 5.3).
 *  - anything else: OCTANT units. Each occupied octant is a cube of side 0.5 and the same
 *    algorithm runs on the half-cell lattice.
 * So in a world of full blocks every query answers exactly what M1 answered; the existing
 * tests pin that. Octant o = ox | oy << 1 | oz << 2 occupies [x + ox/2, x + ox/2 + 0.5) and so on.
 *
 * HALF RANGES. A box touches the half layers h0..h1 of an axis, h0 = floor((min + eps) * 2),
 * h1 = ceil((max - eps) * 2) - 1; the cell range is h0 >> 1 .. h1 >> 1, identical to M1's
 * floor(min + eps) .. ceil(max - eps) - 1 (doubling is exact in binary floating point). Within
 * cell c the box touches the lower half when h0 <= 2c and the upper one when h1 >= 2c + 1; the
 * per-axis tables SUB_X/Y/Z turn that into octant masks, and their AND is `sub`, the octants of
 * the cell the box touches. A partial cell overlaps the box when f & sub !== 0. The cell range
 * is never narrowed by the half range: a box of zero width lying exactly on a 0.5 plane counts
 * as touching a full cell (as in M1) and touches no octant of a partial one.
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
 * "Solid" always means hard material (SOLID[id] === 1) in the cell's solid fill.
 */
import { CHUNK_MASK, CHUNK_SHIFT, WORLD_HEIGHT } from '../core/constants';
import { DIR_X, DIR_Y, DIR_Z } from '../core/dirs';
import { EPS, aabb, vec3, type AABB, type Quat, type Vec3 } from '../core/math';
import { HOLES_SHIFT, ID_MASK } from '../blocks/cell';
// Importing defs also registers the block table, which is what fills SOLID (including the
// deeprock / unloaded sentinels the world returns), so queries never see an empty table.
import { CELL_BELOW_WORLD, CELL_UNLOADED } from '../blocks/defs';
import { SOLID } from '../blocks/registry';
import { cellIndex, type Chunk } from './chunk';
import type { CellBounds, VoxelGrid } from './grid';
import { getPacked, solidFillAt } from './parts';
import { StructureGrid } from './sgrid';
import { World } from './world';

/** Overlap tolerance: separation within this distance counts as touching, not overlapping. */
export const CONTACT_EPS = EPS;

/** Default bias strength for PushOptions.prefer when preferWeight is not given. */
export const DEFAULT_PREFER_WEIGHT = 0.25;

/**
 * Largest |coordinate| a query box may have; boxes reaching beyond are invalid (empty).
 * Far outside anything the world can store (World.posKey supports |x|,|z| < 2^22), yet small
 * enough that integer cell loops advance exactly and `x >> 4` chunk maths stays in int32
 * (half-cell coordinates, twice as large, too).
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
/** Floats per SAT axis: the axis (3), the unit-cell threshold rA + rB, and rB / 2 (see LocalObb.buildSatAxes). */
const SAT_STRIDE = 5;

/**
 * Octants of a cell that a box touches along one axis, indexed by subIndex(): 0 the lower half
 * only, 1 both halves, 2 neither (a zero-width box on the cell's middle plane), 3 the upper half
 * only. Immutable lookup tables (filled at module load).
 */
const SUB_X = Uint8Array.of(0x55, 0xff, 0x00, 0xaa);
const SUB_Y = Uint8Array.of(0x33, 0xff, 0x00, 0xcc);
const SUB_Z = Uint8Array.of(0x0f, 0xff, 0x00, 0xf0);
/** Octants of a cell's lower (index 0) and upper (1) half layer along y. */
const HALF_Y = Uint8Array.of(0x33, 0xcc);

/**
 * Index into SUB_X / SUB_Y / SUB_Z for cell coordinate c and the half range [h0, h1] of a box
 * on that axis: bit 1 = the box does not reach the lower half (h0 > 2c), bit 0 = it reaches the
 * upper half (h1 >= 2c + 1). Works on integers and on integral doubles alike.
 */
function subIndex(h0: number, h1: number, c: number): number {
  return (h0 > 2 * c ? 2 : 0) | (h1 > 2 * c ? 1 : 0);
}

/**
 * Solid fill of cell i of a chunk's layers (World fast paths). Same answer as
 * voxel/parts.ts solidFillAt: canonical cells with holes or a second part have a hard first
 * part (docs/SHAPES.md I7), so a soft first part means an empty fill.
 */
function layerFill(cells: Uint16Array, holes: Uint8Array | null, part2: Uint32Array | null, i: number): number {
  if (SOLID[cells[i]! & ID_MASK] !== 1) return 0;
  let f = holes !== null ? ~holes[i]! & 0xff : 0xff;
  if (part2 !== null) {
    const p = part2[i]!;
    if (p !== 0 && SOLID[p & ID_MASK] === 1) f |= ~(p >>> HOLES_SHIFT) & 0xff;
  }
  return f;
}

/**
 * Valid query box: every coordinate within ±MAX_BOX_COORD (which also rejects NaN and
 * ±Infinity, since every comparison with NaN is false) and min <= max on every axis. Takes the
 * box object: passing its six coordinates to a call that V8 does not inline would box them.
 */
function validBox(b: AABB): boolean {
  return (
    b.minX >= -MAX_BOX_COORD &&
    b.minX <= b.maxX &&
    b.maxX <= MAX_BOX_COORD &&
    b.minY >= -MAX_BOX_COORD &&
    b.minY <= b.maxY &&
    b.maxY <= MAX_BOX_COORD &&
    b.minZ >= -MAX_BOX_COORD &&
    b.minZ <= b.maxZ &&
    b.maxZ <= MAX_BOX_COORD
  );
}

/** A structure grid whose storage has no holes / second-part layers: every cell is empty or a full block (M1 code paths). */
function plainStructure(grid: VoxelGrid): boolean {
  return grid instanceof StructureGrid && !grid.layered;
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
  /** SAT axes beyond the cell axes, per axis [Lx, Ly, Lz, rA + rB, rB / 2] (SAT_STRIDE); built lazily. */
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
   * Per axis two thresholds: rA + rB for a unit cell (rA the box's projection radius, rB the
   * cell's), and rB / 2: an octant is the unit cell scaled by 1/2, so its threshold is
   * (rA + rB) - rB / 2 (docs/SHAPES.md 5.2).
   *
   * Any unit axis is a VALID separating-axis candidate, so normalising a short cross
   * product cannot produce a wrong answer, only a redundant test; truly degenerate ones
   * (parallel edges) are skipped because a face axis already covers them.
   */
  private buildSatAxes(): void {
    const m = this.m;
    const sat = (this.sat ??= new Array<number>(12 * SAT_STRIDE).fill(0));
    const { hx, hy, hz } = this;
    let n = 0;
    for (let i = 0; i < 3; i++) {
      const ax = m[i * 3]!;
      const ay = m[i * 3 + 1]!;
      const az = m[i * 3 + 2]!;
      const h = i === 0 ? hx : i === 1 ? hy : hz;
      const o = n * SAT_STRIDE;
      const rB = 0.5 * (Math.abs(ax) + Math.abs(ay) + Math.abs(az));
      sat[o] = ax;
      sat[o + 1] = ay;
      sat[o + 2] = az;
      sat[o + 3] = h + rB;
      sat[o + 4] = rB * 0.5;
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
        const o = n * SAT_STRIDE;
        sat[o] = lx;
        sat[o + 1] = ly;
        sat[o + 2] = lz;
        sat[o + 3] = rA + rB;
        sat[o + 4] = rB * 0.5;
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
   * Octants of cell (x, y, z) inside the local AABB's half range: the three cell axes of the
   * octant SAT (see the file comment). Computed per call: only partial cells ask.
   */
  sub(x: number, y: number, z: number): number {
    const sx = subIndex(Math.floor((this.cx - this.ex + CONTACT_EPS) * 2), Math.ceil((this.cx + this.ex - CONTACT_EPS) * 2) - 1, x);
    const sy = subIndex(Math.floor((this.cy - this.ey + CONTACT_EPS) * 2), Math.ceil((this.cy + this.ey - CONTACT_EPS) * 2) - 1, y);
    const sz = subIndex(Math.floor((this.cz - this.ez + CONTACT_EPS) * 2), Math.ceil((this.cz + this.ez - CONTACT_EPS) * 2) - 1, z);
    return SUB_X[sx]! & SUB_Y[sy]! & SUB_Z[sz]!;
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
    for (let k = 0, o = 0; k < n; k++, o += SAT_STRIDE) {
      const d = tx * sat[o]! + ty * sat[o + 1]! + tz * sat[o + 2]!;
      if ((d < 0 ? -d : d) >= sat[o + 3]! - CONTACT_EPS) return false;
    }
    return true;
  }

  /**
   * Exact overlap of the box with octant `o` of cell (x,y,z), assuming the octant is in sub()
   * (the three cell axes overlap) and the rotation is not axis-aligned (aligned boxes need no
   * more than sub()). Strict, like overlapsCell.
   */
  overlapsOctant(x: number, y: number, z: number, o: number): boolean {
    if (this.satCount < 0) this.buildSatAxes();
    const n = this.satCount;
    const sat = this.sat!;
    const tx = x + 0.25 + 0.5 * (o & 1) - this.cx;
    const ty = y + 0.25 + 0.5 * ((o >> 1) & 1) - this.cy;
    const tz = z + 0.25 + 0.5 * ((o >> 2) & 1) - this.cz;
    for (let k = 0, i = 0; k < n; k++, i += SAT_STRIDE) {
      const d = tx * sat[i]! + ty * sat[i + 1]! + tz * sat[i + 2]!;
      if ((d < 0 ? -d : d) >= sat[i + 3]! - sat[i + 4]! - CONTACT_EPS) return false;
    }
    return true;
  }

  /** The octants of `octants` (a subset of sub() for cell x, y, z) that truly overlap the box. */
  overlappingOctants(x: number, y: number, z: number, octants: number): number {
    if (this.aligned || octants === 0) return octants;
    let out = 0;
    for (let o = 0; o < 8; o++) if (((octants >> o) & 1) !== 0 && this.overlapsOctant(x, y, z, o)) out |= 1 << o;
    return out;
  }

  /** True when any solid cell in the current range() overlaps the box. */
  hasSolid(grid: VoxelGrid): boolean {
    if (!plainStructure(grid)) return this.hasSolidShaped(grid);
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

  /** hasSolid() for a grid that may hold partial cells: full cells as units, partial ones octant by octant. */
  private hasSolidShaped(grid: VoxelGrid): boolean {
    const { x0, x1, y0, y1, z0, z1 } = this;
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const f = solidFillAt(grid, x, y, z);
          if (f === 0) continue;
          if (f === 0xff) {
            if (this.overlapsCell(x, y, z)) return true;
            continue;
          }
          if (this.overlappingOctants(x, y, z, f & this.sub(x, y, z)) !== 0) return true;
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
// number. The world paths therefore only pass integer cell / half-cell coordinates (small
// integers are never boxed) or objects across function boundaries; box coordinates are read
// where used.
//
// CACHE NOTE: World keeps a single-entry chunk cache, and a miss costs a Map lookup with a
// heap-allocated numeric key. Boolean world scans therefore walk column-major (y innermost)
// and fetch each column's chunk once, so a box straddling a chunk border switches chunks
// once per column, not once per cell.

/**
 * Any solid world cell in the inclusive HALF range hx0..hx1, hy0..hy1, hz0..hz1 (integer
 * half-cell coordinates, see the file comment)? A full cell (f === 0xff; deeprock and unloaded
 * columns included) counts when it is in the cell range; a partial cell when it has an occupied
 * octant inside the half range.
 *
 * For World instances this reads each column's chunk ONCE and indexes its layers directly,
 * reproducing World.getCell's rules (below 0: CELL_BELOW_WORLD; at or above WORLD_HEIGHT: air;
 * unloaded column: CELL_UNLOADED). A column whose chunk has no holes / second-part layers runs
 * the M1 loop over its cells. Calling getCell per cell instead was measured (node 22) to allocate
 * ~30 bytes per call whenever the scan ran to completion, i.e. on every query for a FREE box (the
 * common case): TurboFan's loop peeling boxes heap numbers when getCell is inlined into a
 * y-innermost loop. The direct scan is allocation-free and about twice as fast. Any other world
 * implementation goes through getCell / getPart2.
 */
function worldRangeHasSolid(grid: VoxelGrid, hx0: number, hx1: number, hy0: number, hy1: number, hz0: number, hz1: number): boolean {
  if (hy1 >= 2 * WORLD_HEIGHT) hy1 = 2 * WORLD_HEIGHT - 1;
  const x0 = hx0 >> 1;
  const x1 = hx1 >> 1;
  let y0 = hy0 >> 1;
  const y1 = hy1 >> 1;
  const z0 = hz0 >> 1;
  const z1 = hz1 >> 1;
  if (x0 > x1 || y0 > y1 || z0 > z1) return false;
  if (!(grid instanceof World)) return genericRangeHasSolid(grid, hx0, hx1, hy0, hy1, hz0, hz1);
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
      if (chunk.holes === null && chunk.part2 === null) {
        for (let y = y0; y <= y1; y++) {
          if (SOLID[cells[cellIndex(lx, y, lz)]! & ID_MASK] === 1) return true;
        }
        continue;
      }
      const sxz = SUB_X[subIndex(hx0, hx1, x)]! & SUB_Z[subIndex(hz0, hz1, z)]!;
      if (layeredColumnHasSolid(cells, chunk.holes, chunk.part2, lx, lz, y0, y1, hy0, hy1, sxz)) return true;
    }
  }
  return false;
}

/**
 * The cells y0..y1 of one column of a chunk with holes / second-part layers (worldRangeHasSolid):
 * a full cell counts, a partial one when it has an occupied octant among `sxz` (the column's x
 * and z halves inside the range) and the y halves of hy0..hy1.
 */
function layeredColumnHasSolid(
  cells: Uint16Array,
  holes: Uint8Array | null,
  part2: Uint32Array | null,
  lx: number,
  lz: number,
  y0: number,
  y1: number,
  hy0: number,
  hy1: number,
  sxz: number,
): boolean {
  for (let y = y0; y <= y1; y++) {
    const f = layerFill(cells, holes, part2, cellIndex(lx, y, lz));
    if (f === 0) continue;
    if (f === 0xff || (f & sxz & SUB_Y[subIndex(hy0, hy1, y)]!) !== 0) return true;
  }
  return false;
}

/** worldRangeHasSolid through the VoxelGrid interface (non-World world grids). */
function genericRangeHasSolid(grid: VoxelGrid, hx0: number, hx1: number, hy0: number, hy1: number, hz0: number, hz1: number): boolean {
  const x1 = hx1 >> 1;
  const y1 = hy1 >> 1;
  const z1 = hz1 >> 1;
  for (let x = hx0 >> 1; x <= x1; x++) {
    for (let z = hz0 >> 1; z <= z1; z++) {
      for (let y = hy0 >> 1; y <= y1; y++) {
        const f = solidFillAt(grid, x, y, z);
        if (f === 0) continue;
        if (f === 0xff) return true;
        if ((f & SUB_X[subIndex(hx0, hx1, x)]! & SUB_Y[subIndex(hy0, hy1, y)]! & SUB_Z[subIndex(hz0, hz1, z)]!) !== 0) return true;
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
 * Visit every cell with solid material that truly overlaps `box` (touching within CONTACT_EPS
 * does not count), in y, z, x order. `packed` is the cell's packed value (both parts), `octants`
 * the solid octants of the cell that overlap the box. A full cell (solid fill 0xff) is visited
 * when its unit cube overlaps (M1); its `octants` are then the octants of that cube the box
 * reaches, 0 only for a box of zero width lying exactly on the cell's middle plane. A partial
 * cell is visited when `octants` is not 0. `fn` returning true stops the iteration.
 * Do not modify the grid from inside `fn`. Visits nothing for an invalid box. Not for per-tick
 * code: it forms packed values.
 */
export function forEachSolidCellOverlapping(
  grid: VoxelGrid,
  box: AABB,
  fn: (x: number, y: number, z: number, packed: number, octants: number) => boolean | void,
): void {
  const { minX, minY, minZ, maxX, maxY, maxZ } = box;
  if (!validBox(box)) return;
  if (grid.isWorld) {
    const h0x = Math.floor((minX + CONTACT_EPS) * 2);
    const h1x = Math.ceil((maxX - CONTACT_EPS) * 2) - 1;
    const h0y = Math.floor((minY + CONTACT_EPS) * 2);
    let h1y = Math.ceil((maxY - CONTACT_EPS) * 2) - 1;
    const h0z = Math.floor((minZ + CONTACT_EPS) * 2);
    const h1z = Math.ceil((maxZ - CONTACT_EPS) * 2) - 1;
    if (h1y >= 2 * WORLD_HEIGHT) h1y = 2 * WORLD_HEIGHT - 1;
    for (let y = h0y >> 1; y <= h1y >> 1; y++) {
      for (let z = h0z >> 1; z <= h1z >> 1; z++) {
        for (let x = h0x >> 1; x <= h1x >> 1; x++) {
          const f = solidFillAt(grid, x, y, z);
          if (f === 0) continue;
          const s = f & SUB_X[subIndex(h0x, h1x, x)]! & SUB_Y[subIndex(h0y, h1y, y)]! & SUB_Z[subIndex(h0z, h1z, z)]!;
          if (f !== 0xff && s === 0) continue;
          if (fn(x, y, z, getPacked(grid, x, y, z), s) === true) return;
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
        const f = solidFillAt(grid, x, y, z);
        if (f === 0) continue;
        if (f === 0xff && !obb.overlapsCell(x, y, z)) continue;
        const s = obb.overlappingOctants(x, y, z, f & obb.sub(x, y, z));
        if (f !== 0xff && s === 0) continue;
        if (fn(x, y, z, getPacked(grid, x, y, z), s) === true) return;
      }
    }
  }
}

/**
 * True when `box` truly overlaps any solid octant of `grid` (false for an invalid box).
 * Allocation-free for the world.
 */
export function boxOverlapsSolid(grid: VoxelGrid, box: AABB): boolean {
  const { minX, minY, minZ, maxX, maxY, maxZ } = box;
  if (!validBox(box)) return false;
  if (grid.isWorld) {
    return worldRangeHasSolid(
      grid,
      Math.floor((minX + CONTACT_EPS) * 2),
      Math.ceil((maxX - CONTACT_EPS) * 2) - 1,
      Math.floor((minY + CONTACT_EPS) * 2),
      Math.ceil((maxY - CONTACT_EPS) * 2) - 1,
      Math.floor((minZ + CONTACT_EPS) * 2),
      Math.ceil((maxZ - CONTACT_EPS) * 2) - 1,
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
  /** > 0: distance the box must move along the normal to clear the unit's face. */
  depth: number;
  /** Local cell that produced this push. */
  cx: number;
  cy: number;
  cz: number;
  /** The octant (0..7) of that cell that produced this push; -1 when it was the whole cell (a whole-cell unit). */
  octant: number;
}

export interface PushOptions {
  /** World-space unit vector the push should lean toward (e.g. a blade's sweep direction). */
  prefer?: Vec3;
  /** Strength of the lean, in blocks of depth per unit of alignment. Default DEFAULT_PREFER_WEIGHT. */
  preferWeight?: number;
}

/**
 * The lean's weight for `opts`, or 0 for none. A non-finite vector or weight is ignored, not
 * trusted: a NaN score would make every candidate face lose and report "no push" for an overlap.
 * (Read where used rather than copied into an object: findPenetration must not allocate.)
 */
function preferWeightOf(opts: PushOptions | undefined): number {
  if (opts === undefined) return 0;
  const p = opts.prefer;
  if (p === undefined) return 0;
  const w = opts.preferWeight ?? DEFAULT_PREFER_WEIGHT;
  if (w === 0 || !Number.isFinite(w)) return 0;
  if (!(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) return 0;
  return w;
}

/**
 * Core of deepestPenetration over the inclusive candidate cell range x0..z1 (integers). The
 * box's local bounds come from `obb` (its local AABB, i.e. its projections on the local axes)
 * or, for the world (identity rotation, obb null), from the world box `wb`. Writes into `out`
 * only when it finds a push (then returns true).
 *
 * Units (docs/SHAPES.md 5.3): a full cell whose six face neighbours are all empty or full is
 * one unit with the M1 rules (its faces, exposed when the neighbour is empty). Any other cell
 * with solid material (partial, or full with a partial face neighbour) contributes each of its
 * solid octants that overlaps the box as a unit: faces at the octant's planes, a face exposed
 * when the octant next to it (in the same cell or the neighbour) is not solid. Units are ranked
 * alike: largest true overlap, then smaller exposed push, then the first scanned (cells in y, z,
 * x order, octants by index).
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
  opts: PushOptions | undefined,
  out: Penetration,
): boolean {
  const m = obb !== null ? obb.m : null;
  const lminX = obb !== null ? obb.cx - obb.ex : wb!.minX;
  const lminY = obb !== null ? obb.cy - obb.ey : wb!.minY;
  const lminZ = obb !== null ? obb.cz - obb.ez : wb!.minZ;
  const lmaxX = obb !== null ? obb.cx + obb.ex : wb!.maxX;
  const lmaxY = obb !== null ? obb.cy + obb.ey : wb!.maxY;
  const lmaxZ = obb !== null ? obb.cz + obb.ez : wb!.maxZ;
  // Half range of the local AABB (only partial units use it).
  const h0x = Math.floor((lminX + CONTACT_EPS) * 2);
  const h1x = Math.ceil((lmaxX - CONTACT_EPS) * 2) - 1;
  const h0y = Math.floor((lminY + CONTACT_EPS) * 2);
  const h1y = Math.ceil((lmaxY - CONTACT_EPS) * 2) - 1;
  const h0z = Math.floor((lminZ + CONTACT_EPS) * 2);
  const h1z = Math.ceil((lmaxZ - CONTACT_EPS) * 2) - 1;
  const pw = preferWeightOf(opts);
  const pref = pw !== 0 ? opts!.prefer! : null;
  const rotated = obb !== null && !obb.aligned;
  let found = false;
  let bestOverlap = 0;
  let bestDepth = 0;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const f = solidFillAt(grid, x, y, z);
        if (f === 0) continue;
        if (f === 0xff && obb !== null && !obb.overlapsCell(x, y, z)) continue;
        // Face neighbours' solid fills, in Dir order (+X, -X, +Y, -Y, +Z, -Z).
        const n0 = solidFillAt(grid, x + 1, y, z);
        const n1 = solidFillAt(grid, x - 1, y, z);
        const n2 = solidFillAt(grid, x, y + 1, z);
        const n3 = solidFillAt(grid, x, y - 1, z);
        const n4 = solidFillAt(grid, x, y, z + 1);
        const n5 = solidFillAt(grid, x, y, z - 1);
        const whole =
          f === 0xff &&
          (n0 === 0 || n0 === 0xff) &&
          (n1 === 0 || n1 === 0xff) &&
          (n2 === 0 || n2 === 0xff) &&
          (n3 === 0 || n3 === 0xff) &&
          (n4 === 0 || n4 === 0xff) &&
          (n5 === 0 || n5 === 0xff);
        // Octants of this cell that are units: one pseudo-octant (bit 8) for a whole cell.
        let units: number;
        if (whole) units = 0x100;
        else {
          units = f & SUB_X[subIndex(h0x, h1x, x)]! & SUB_Y[subIndex(h0y, h1y, y)]! & SUB_Z[subIndex(h0z, h1z, z)]!;
          if (rotated && units !== 0) units = obb!.overlappingOctants(x, y, z, units);
        }
        for (let o = whole ? 8 : 0; o <= 8; o++) {
          if (((units >> o) & 1) === 0) continue;
          // The unit's min corner and size: the cell (o = 8 = 0b1000, whose low three bits are 0),
          // or octant o of it. Written as arithmetic, not as a choice between an integer and a
          // fraction: TurboFan gives such a choice a tagged representation and boxes the fraction.
          const size = 0.5 + 0.5 * (o >> 3);
          const ux = x + 0.5 * (o & 1);
          const uy = y + 0.5 * ((o >> 1) & 1);
          const uz = z + 0.5 * ((o >> 2) & 1);
          // Candidate push directions: only the unit's EXPOSED faces. A face shared with
          // solid material can never be a contact face; considering it is what makes boxes
          // snag on the internal edges of floors and walls built from many cells.
          let cellScore = Infinity;
          let cellDepth = 0;
          let cellDir = -1;
          // How deeply the box really overlaps this unit: the smallest push over ALL six faces.
          let overlap = Infinity;
          for (let d = 0; d < 6; d++) {
            // Distance the box must travel along local face normal d so that its projection
            // on d starts at the face plane.
            let depth: number;
            switch (d) {
              case 0:
                depth = ux + size - lminX;
                break;
              case 1:
                depth = lmaxX - ux;
                break;
              case 2:
                depth = uy + size - lminY;
                break;
              case 3:
                depth = lmaxY - uy;
                break;
              case 4:
                depth = uz + size - lminZ;
                break;
              default:
                depth = lmaxZ - uz;
                break;
            }
            if (depth < overlap) overlap = depth;
            // What lies across face d: the neighbour cell's fill, or for an octant whose face d
            // is inside the cell, this cell's own; and the octant there (a whole cell: any).
            const a = d >> 1;
            const nb = d === 0 ? n0 : d === 1 ? n1 : d === 2 ? n2 : d === 3 ? n3 : d === 4 ? n4 : n5;
            if (o === 8) {
              if (nb === 0xff) continue;
            } else {
              const inner = ((o >> a) & 1) === (d & 1); // positive face of a low octant, or negative face of a high one
              if ((((inner ? f : nb) >> (o ^ (1 << a))) & 1) !== 0) continue;
            }
            let score = depth;
            if (pref !== null) {
              // World normal of local face d = ±(column (d>>1) of the rotation matrix).
              const s = (d & 1) === 0 ? pw : -pw;
              const dot = m !== null ? m[a]! * pref.x + m[3 + a]! * pref.y + m[6 + a]! * pref.z : a === 0 ? pref.x : a === 1 ? pref.y : pref.z;
              score -= s * dot;
            }
            if (score < cellScore) {
              cellScore = score;
              cellDepth = depth; // report the TRUE depth, never the biased score (LESSONS)
              cellDir = d;
            }
          }
          if (cellDir < 0) continue; // fully enclosed unit: no way out through it
          // Worst unit first, where "worst" is the TRUE overlap, not the exposed-face depth.
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
            out.octant = o === 8 ? -1 : o;
          }
        }
      }
    }
  }
  return found;
}

/**
 * findPenetration where no cell of the candidate range or its face neighbours is partial: the M1
 * algorithm as it was (whole-cell units only). Same arguments and results as findPenetration.
 */
function findPenetrationPlain(
  grid: VoxelGrid,
  obb: LocalObb | null,
  wb: AABB | null,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  opts: PushOptions | undefined,
  out: Penetration,
): boolean {
  const m = obb !== null ? obb.m : null;
  const lminX = obb !== null ? obb.cx - obb.ex : wb!.minX;
  const lminY = obb !== null ? obb.cy - obb.ey : wb!.minY;
  const lminZ = obb !== null ? obb.cz - obb.ez : wb!.minZ;
  const lmaxX = obb !== null ? obb.cx + obb.ex : wb!.maxX;
  const lmaxY = obb !== null ? obb.cy + obb.ey : wb!.maxY;
  const lmaxZ = obb !== null ? obb.cz + obb.ez : wb!.maxZ;
  const pw = preferWeightOf(opts);
  const pref = pw !== 0 ? opts!.prefer! : null;
  let found = false;
  let bestOverlap = 0;
  let bestDepth = 0;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (SOLID[grid.getCell(x, y, z) & ID_MASK] !== 1) continue;
        if (obb !== null && !obb.overlapsCell(x, y, z)) continue;
        let cellScore = Infinity;
        let cellDepth = 0;
        let cellDir = -1;
        let overlap = Infinity;
        for (let d = 0; d < 6; d++) {
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
          if (SOLID[grid.getCell(x + DIR_X[d]!, y + DIR_Y[d]!, z + DIR_Z[d]!) & ID_MASK] === 1) continue;
          let score = depth;
          if (pref !== null) {
            const a = d >> 1;
            const s = (d & 1) === 0 ? pw : -pw;
            const dot = m !== null ? m[a]! * pref.x + m[3 + a]! * pref.y + m[6 + a]! * pref.z : a === 0 ? pref.x : a === 1 ? pref.y : pref.z;
            score -= s * dot;
          }
          if (score < cellScore) {
            cellScore = score;
            cellDepth = depth;
            cellDir = d;
          }
        }
        if (cellDir < 0) continue;
        if (!found || overlap > bestOverlap || (overlap === bestOverlap && cellDepth < bestDepth)) {
          found = true;
          bestOverlap = overlap;
          bestDepth = cellDepth;
          const a = cellDir >> 1;
          const s = (cellDir & 1) === 0 ? 1 : -1;
          if (m !== null) {
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
          out.octant = -1;
        }
      }
    }
  }
  return found;
}

/**
 * No chunk under the world columns x0..x1, z0..z1 has holes / second-part layers, so every cell
 * there is empty or full (a missing chunk reads as full CELL_UNLOADED cells). Only asked of
 * columns within 2 x 2 chunks; a larger area (or a world grid that is not a World) answers false.
 */
function worldPlainIn(grid: VoxelGrid, x0: number, x1: number, z0: number, z1: number): boolean {
  if (!(grid instanceof World)) return false;
  const cx0 = x0 >> CHUNK_SHIFT;
  const cx1 = x1 >> CHUNK_SHIFT;
  const cz0 = z0 >> CHUNK_SHIFT;
  const cz1 = z1 >> CHUNK_SHIFT;
  if (cx1 - cx0 > 1 || cz1 - cz0 > 1) return false;
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const c = grid.getChunk(cx, cz);
      if (c !== undefined && (c.holes !== null || c.part2 !== null)) return false;
    }
  }
  return true;
}

/**
 * Every world cell x0..x1, z0..z1 and its face neighbours is empty or full: worldPlainIn over the
 * range grown by one cell (the push-out reads the face neighbours).
 */
function worldPlainAround(grid: VoxelGrid, x0: number, x1: number, z0: number, z1: number): boolean {
  return worldPlainIn(grid, x0 - 1, x1 + 1, z0 - 1, z1 + 1);
}

/** World-path penetration for box `b` (identity transform). */
function worldPenetration(grid: VoxelGrid, b: AABB, opts: PushOptions | undefined, out: Penetration): boolean {
  const x0 = Math.floor(b.minX + CONTACT_EPS);
  const x1 = Math.ceil(b.maxX - CONTACT_EPS) - 1;
  const y0 = Math.floor(b.minY + CONTACT_EPS);
  const y1 = Math.min(Math.ceil(b.maxY - CONTACT_EPS) - 1, WORLD_HEIGHT - 1);
  const z0 = Math.floor(b.minZ + CONTACT_EPS);
  const z1 = Math.ceil(b.maxZ - CONTACT_EPS) - 1;
  return worldPlainAround(grid, x0, x1, z0, z1)
    ? findPenetrationPlain(grid, null, b, x0, x1, y0, y1, z0, z1, opts, out)
    : findPenetration(grid, null, b, x0, x1, y0, y1, z0, z1, opts, out);
}

/** Structure-path penetration for an OBB at its current centre. */
function obbPenetration(grid: VoxelGrid, obb: LocalObb, opts: PushOptions | undefined, out: Penetration): boolean {
  if (!obb.range()) return false;
  return plainStructure(grid)
    ? findPenetrationPlain(grid, obb, null, obb.x0, obb.x1, obb.y0, obb.y1, obb.z0, obb.z1, opts, out)
    : findPenetration(grid, obb, null, obb.x0, obb.x1, obb.y0, obb.y1, obb.z0, obb.z1, opts, out);
}

function newPenetration(): Penetration {
  return { nx: 0, ny: 0, nz: 0, depth: 0, cx: 0, cy: 0, cz: 0, octant: -1 };
}

/**
 * The push that resolves the worst overlapping solid unit (a whole cell, or an octant of a
 * partial cell or of a full cell next to one: see findPenetration).
 *
 * Per unit: the candidate directions are the unit's EXPOSED local face normals; the unit picks
 * the one with the smallest depth, biased by `opts.prefer` (minimises
 * depth - preferWeight * dot(n_world, prefer)). The depth along n is the distance the box must
 * travel along n to clear that face (for rotated grids measured with the box's extent along the
 * local axis). The REPORTED depth is always the true geometric depth along the chosen normal,
 * never the biased score.
 *
 * Across units: the unit whose TRUE overlap (its smallest depth over all six faces, exposed or
 * not) is largest wins; on an exact tie the smaller exposed push wins. Ranking by exposed depth
 * instead would let a cell that is only grazed through a solid neighbour (the deck cell under a
 * hull wall, whose only exposed faces point out of the hull) decide the push, and shove the box
 * out through the wall.
 *
 * With `out` the result is written there (and `out` returned) and the world path allocates
 * nothing; `out` is left unchanged when the result is null. Null when the box is invalid,
 * overlaps nothing, or no overlapping unit has an exposed face (check boxOverlapsSolid to tell
 * "free" from "fully embedded").
 */
export function deepestPenetration(grid: VoxelGrid, box: AABB, opts?: PushOptions, out?: Penetration): Penetration | null {
  const { minX, minY, minZ, maxX, maxY, maxZ } = box;
  if (!validBox(box)) return null;
  const res = out ?? newPenetration();
  if (grid.isWorld) return worldPenetration(grid, box, opts, res) ? res : null;
  const obb = structureObb(grid, minX, minY, minZ, maxX, maxY, maxZ);
  if (obb === null) return null;
  return obbPenetration(grid, obb, opts, res) ? res : null;
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
  if (!validBox(box)) return res;
  const cap = maxIterations >= 0 ? Math.min(Math.floor(maxIterations), MAX_RESOLVE_ITERATIONS) : 0;
  const isWorld = grid.isWorld;
  // World: a translated copy of the box. Structure: its local OBB, built once and translated.
  const cur: AABB | null = isWorld ? { minX, minY, minZ, maxX, maxY, maxZ } : null;
  const obb = isWorld ? null : structureObb(grid, minX, minY, minZ, maxX, maxY, maxZ);
  if (cur === null && obb === null) return res; // empty structure: nothing to resolve
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
      found = worldPenetration(grid, cur, opts, pen);
    } else {
      obb!.setWorldOffset(dx, dy, dz);
      found = obbPenetration(grid, obb!, opts, pen);
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
//
// A sweep runs on HALF layers k (half-cell coordinates along the swept axis). A partial cell
// blocks at every half layer where it has an occupied octant inside the box's cross-section; a
// full cell blocks only at its ENTRY half layer: the lower one (2y) going up, the upper one
// (2y + 1) going down. That is M1's "cells the box already overlaps are ignored", so for full
// blocks the result is M1's bit for bit (docs/SHAPES.md 5.4). Where there are no partial cells
// the scans step cell by cell, as M1 did, and do no more work than M1 did.

/** Octants of the cells of column (x, z) inside the cross-section of box `b` (its x and z halves). */
function columnMask(b: AABB, x: number, z: number): number {
  const sx = subIndex(Math.floor((b.minX + CONTACT_EPS) * 2), Math.ceil((b.maxX - CONTACT_EPS) * 2) - 1, x);
  const sz = subIndex(Math.floor((b.minZ + CONTACT_EPS) * 2), Math.ceil((b.maxZ - CONTACT_EPS) * 2) - 1, z);
  return SUB_X[sx]! & SUB_Z[sz]!;
}

/**
 * Lowest blocking half layer k in [k0, k1) of world column (x, z) for box `b` going UP, or k1
 * when there is none. Integer arguments only (and the box, whose cross-section matters only to
 * partial cells). Same cell rules as World.getCell.
 */
function columnFirstSolidUp(grid: VoxelGrid, x: number, z: number, k0: number, k1: number, b: AABB): number {
  if (!(grid instanceof World)) return genericColumnUp(grid, x, z, k0, k1, columnMask(b, x, z));
  let k = k0;
  if (k < 0 && k < k1) {
    // Deeprock (full cells): its first entry layer at or above k0.
    const e = 2 * ((k + 1) >> 1);
    if (e < 0 && SOLID[CELL_BELOW_WORLD & ID_MASK] === 1) return e < k1 ? e : k1;
    k = 0;
  }
  const top = k1 < 2 * WORLD_HEIGHT ? k1 : 2 * WORLD_HEIGHT; // air at and above the build limit
  if (k >= top) return k1;
  const chunk = grid.chunkAt(x, z);
  if (chunk === undefined) {
    const e = 2 * ((k + 1) >> 1); // unloaded: full cells
    return SOLID[CELL_UNLOADED & ID_MASK] === 1 && e < top ? e : k1;
  }
  const cells = chunk.cells;
  const lx = x & CHUNK_MASK;
  const lz = z & CHUNK_MASK;
  if (chunk.holes !== null || chunk.part2 !== null) return layeredColumnUp(cells, chunk.holes, chunk.part2, lx, lz, k, top, k1, columnMask(b, x, z));
  // Full cells only: their entry layers, cell by cell.
  for (let y = (k + 1) >> 1; 2 * y < top; y++) if (SOLID[cells[cellIndex(lx, y, lz)]! & ID_MASK] === 1) return 2 * y;
  return k1;
}

/** columnFirstSolidUp's scan of half layers k0..top-1 of a chunk column with holes / second-part layers; `m` = columnMask. */
function layeredColumnUp(
  cells: Uint16Array,
  holes: Uint8Array | null,
  part2: Uint32Array | null,
  lx: number,
  lz: number,
  k0: number,
  top: number,
  k1: number,
  m: number,
): number {
  for (let k = k0; k < top; k++) {
    const f = layerFill(cells, holes, part2, cellIndex(lx, k >> 1, lz));
    if (f === 0) continue;
    if (f === 0xff ? (k & 1) === 0 : (f & m & HALF_Y[k & 1]!) !== 0) return k;
  }
  return k1;
}

/** columnFirstSolidUp through the VoxelGrid interface (non-World world grids): one read per cell, like M1. */
function genericColumnUp(grid: VoxelGrid, x: number, z: number, k0: number, k1: number, m: number): number {
  for (let y = k0 >> 1; 2 * y < k1; y++) {
    const f = solidFillAt(grid, x, y, z);
    if (f === 0) continue;
    const lo = 2 * y;
    if (f === 0xff) {
      if (lo >= k0) return lo;
      continue;
    }
    if (lo >= k0 && (f & m & HALF_Y[0]!) !== 0) return lo;
    if (lo + 1 < k1 && (f & m & HALF_Y[1]!) !== 0) return lo + 1;
  }
  return k1;
}

/**
 * Highest blocking half layer k with k1 < k <= k0 of world column (x, z) for box `b` going
 * DOWN, scanning down from k0, or k1 when there is none. Arguments as in columnFirstSolidUp.
 */
function columnFirstSolidDown(grid: VoxelGrid, x: number, z: number, k0: number, k1: number, b: AABB): number {
  if (!(grid instanceof World)) return genericColumnDown(grid, x, z, k0, k1, columnMask(b, x, z));
  let k = k0 < 2 * WORLD_HEIGHT ? k0 : 2 * WORLD_HEIGHT - 1; // air at and above the build limit
  if (k <= k1) return k1;
  if (k >= 0) {
    const chunk = grid.chunkAt(x, z);
    if (chunk === undefined) {
      // Unloaded: full cells down to y = 0 (deeprock below). Their first entry layer at or below k.
      if (SOLID[CELL_UNLOADED & ID_MASK] === 1 && k >= 1) {
        const e = (k & 1) === 1 ? k : k - 1;
        return e > k1 ? e : k1;
      }
      k = -1;
    } else {
      const cells = chunk.cells;
      const lx = x & CHUNK_MASK;
      const lz = z & CHUNK_MASK;
      const bottom = k1 >= 0 ? k1 + 1 : 0;
      if (chunk.holes !== null || chunk.part2 !== null) {
        const hit = layeredColumnDown(cells, chunk.holes, chunk.part2, lx, lz, k, bottom, columnMask(b, x, z));
        if (hit >= bottom) return hit;
      } else {
        // Full cells only: their entry layers, cell by cell.
        for (let y = (k - 1) >> 1; 2 * y + 1 >= bottom; y--) if (SOLID[cells[cellIndex(lx, y, lz)]! & ID_MASK] === 1) return 2 * y + 1;
      }
      k = bottom - 1;
    }
    if (k <= k1) return k1;
  }
  // k < 0: deeprock (full cells), the first entry layer at or below k.
  const e = (k & 1) === 1 ? k : k - 1;
  return SOLID[CELL_BELOW_WORLD & ID_MASK] === 1 && e > k1 ? e : k1;
}

/** columnFirstSolidDown's scan of half layers k0 down to bottom of a chunk column with layers; bottom - 1 when none blocks. */
function layeredColumnDown(
  cells: Uint16Array,
  holes: Uint8Array | null,
  part2: Uint32Array | null,
  lx: number,
  lz: number,
  k0: number,
  bottom: number,
  m: number,
): number {
  for (let k = k0; k >= bottom; k--) {
    const f = layerFill(cells, holes, part2, cellIndex(lx, k >> 1, lz));
    if (f === 0) continue;
    if (f === 0xff ? (k & 1) === 1 : (f & m & HALF_Y[k & 1]!) !== 0) return k;
  }
  return bottom - 1;
}

/** columnFirstSolidDown through the VoxelGrid interface (non-World world grids): one read per cell, like M1. */
function genericColumnDown(grid: VoxelGrid, x: number, z: number, k0: number, k1: number, m: number): number {
  for (let y = k0 >> 1; 2 * y + 1 > k1; y--) {
    const f = solidFillAt(grid, x, y, z);
    if (f === 0) continue;
    const hi = 2 * y + 1;
    if (f === 0xff) {
      if (hi <= k0) return hi;
      continue;
    }
    if (hi <= k0 && (f & m & HALF_Y[1]!) !== 0) return hi;
    if (hi - 1 > k1 && (f & m & HALF_Y[0]!) !== 0) return hi - 1;
  }
  return k1;
}

/** "No half layer blocks": sweepAcrossFirst's answer when nothing blocks (a small integer far outside any layer). */
const NO_HIT = 0x3fffffff;
/** Octants of a cell's lower (index 0) and upper (1) half along x, and along z. */
const HALF_X = Uint8Array.of(0x55, 0xaa);
const HALF_Z = Uint8Array.of(0x0f, 0xf0);

/**
 * The first half layer, in the order of a horizontal sweep along `axis` (0 x, 2 z) in direction
 * `positive`, among kLo..kHi (inclusive, kLo <= kHi) that blocks box `b` (its cross-section: the
 * half ranges of y and of the other horizontal axis); NO_HIT when none does. A
 * full cell blocks at its entry half layer (the first of its two the sweep meets), when that lies
 * in kLo..kHi; a partial cell at each half layer in kLo..kHi where it has an occupied octant
 * inside the cross-section. Cell layers along the axis are visited in sweep order, each in M1's
 * order (columns of the other axis, then y), so where there are no partial cells this is M1's
 * scan, one cell layer after the other, in one call.
 */
function sweepAcrossFirst(grid: VoxelGrid, b: AABB, axis: number, positive: boolean, kLo: number, kHi: number): number {
  const h0y = Math.floor((b.minY + CONTACT_EPS) * 2);
  let h1y = Math.ceil((b.maxY - CONTACT_EPS) * 2) - 1;
  const h0o = Math.floor(((axis === 0 ? b.minZ : b.minX) + CONTACT_EPS) * 2);
  const h1o = Math.ceil(((axis === 0 ? b.maxZ : b.maxX) - CONTACT_EPS) * 2) - 1;
  if (h1y >= 2 * WORLD_HEIGHT) h1y = 2 * WORLD_HEIGHT - 1;
  const y1 = h1y >> 1;
  const o0 = h0o >> 1;
  const o1 = h1o >> 1;
  const cFirst = (positive ? kLo : kHi) >> 1;
  const cLast = (positive ? kHi : kLo) >> 1;
  const step = positive ? 1 : -1;
  // Octants of the half of a cell the sweep meets first / second, along the swept axis.
  const firstMask = axis === 0 ? HALF_X[positive ? 0 : 1]! : HALF_Z[positive ? 0 : 1]!;
  const secondMask = axis === 0 ? HALF_X[positive ? 1 : 0]! : HALF_Z[positive ? 1 : 0]!;
  const world = grid instanceof World ? grid : null;
  for (let c = cFirst; positive ? c <= cLast : c >= cLast; c += step) {
    const hf = positive ? 2 * c : 2 * c + 1; // the half layer of cell layer c the sweep meets first
    const hs = positive ? 2 * c + 1 : 2 * c;
    const inFirst = hf >= kLo && hf <= kHi;
    const inSecond = hs >= kLo && hs <= kHi;
    let y0 = h0y >> 1;
    if (world !== null && y0 < 0) {
      if (inFirst && SOLID[CELL_BELOW_WORLD & ID_MASK] === 1) return hf; // deeprock: full cells
      y0 = 0;
      if (y0 > y1) continue;
    }
    let second = false;
    for (let o = o0; o <= o1; o++) {
      const x = axis === 0 ? c : o;
      const z = axis === 0 ? o : c;
      if (world === null) {
        const so = axis === 0 ? SUB_Z[subIndex(h0o, h1o, o)]! : SUB_X[subIndex(h0o, h1o, o)]!;
        const r = genericSlabColumn(grid, x, z, y0, y1, h0y, h1y, so & firstMask, so & secondMask, inFirst, inSecond);
        if (r === 1) return hf;
        if (r === 2) second = true;
        continue;
      }
      const chunk = world.chunkAt(x, z);
      if (chunk === undefined) {
        if (inFirst && SOLID[CELL_UNLOADED & ID_MASK] === 1) return hf; // unloaded: full cells
        continue;
      }
      const cells = chunk.cells;
      const lx = x & CHUNK_MASK;
      const lz = z & CHUNK_MASK;
      if (chunk.holes === null && chunk.part2 === null) {
        if (!inFirst) continue; // full cells only: they block at their entry half alone
        for (let y = y0; y <= y1; y++) if (SOLID[cells[cellIndex(lx, y, lz)]! & ID_MASK] === 1) return hf;
        continue;
      }
      const so = axis === 0 ? SUB_Z[subIndex(h0o, h1o, o)]! : SUB_X[subIndex(h0o, h1o, o)]!;
      const r = layeredSlabColumn(cells, chunk.holes, chunk.part2, lx, lz, y0, y1, h0y, h1y, so & firstMask, so & secondMask, inFirst, inSecond);
      if (r === 1) return hf;
      if (r === 2) second = true;
    }
    if (second) return hs;
  }
  return NO_HIT;
}

/**
 * One column of a chunk with layers in sweepAcrossFirst: 1 when a cell blocks at the cell
 * layer's first half (a full cell when inFirst; a partial one with an octant among `first` and
 * the cross-section's y halves), else 2 when one blocks at its second half (`second`, inSecond),
 * else 0.
 */
function layeredSlabColumn(
  cells: Uint16Array,
  holes: Uint8Array | null,
  part2: Uint32Array | null,
  lx: number,
  lz: number,
  y0: number,
  y1: number,
  h0y: number,
  h1y: number,
  first: number,
  second: number,
  inFirst: boolean,
  inSecond: boolean,
): number {
  let r = 0;
  for (let y = y0; y <= y1; y++) {
    const f = layerFill(cells, holes, part2, cellIndex(lx, y, lz));
    if (f === 0) continue;
    if (f === 0xff) {
      if (inFirst) return 1;
      continue;
    }
    const s = f & SUB_Y[subIndex(h0y, h1y, y)]!;
    if (inFirst && (s & first) !== 0) return 1;
    if (inSecond && (s & second) !== 0) r = 2;
  }
  return r;
}

/** layeredSlabColumn through the VoxelGrid interface (non-World world grids). */
function genericSlabColumn(
  grid: VoxelGrid,
  x: number,
  z: number,
  y0: number,
  y1: number,
  h0y: number,
  h1y: number,
  first: number,
  second: number,
  inFirst: boolean,
  inSecond: boolean,
): number {
  let r = 0;
  for (let y = y0; y <= y1; y++) {
    const f = solidFillAt(grid, x, y, z);
    if (f === 0) continue;
    if (f === 0xff) {
      if (inFirst) return 1;
      continue;
    }
    const s = f & SUB_Y[subIndex(h0y, h1y, y)]!;
    if (inFirst && (s & first) !== 0) return 1;
    if (inSecond && (s & second) !== 0) r = 2;
  }
  return r;
}

/**
 * Classic voxel sweep against the WORLD only (throws for structures: use the SAT push-out
 * there). Returns the largest displacement with the sign of `delta` and magnitude <= |delta|
 * the box can move along world `axis` without newly entering a solid octant. Octants the box
 * already overlaps are ignored (a full cell counts as entered at its entry half layer), so a box
 * can always move out of an overlap. A blocked result leaves the box touching the obstacle
 * (within CONTACT_EPS), never overlapping it; it lies on the half-cell lattice, so feet on a half
 * slab end exactly at y + 0.5. Every crossed half layer is scanned, so large deltas cannot
 * tunnel; an infinite delta is fine (the scan stops at deeprock, the build limit or the first
 * unloaded chunk). Returns 0 for a NaN delta and for an invalid box (a corrupt box is never moved
 * further). Allocation-free except for the returned number itself when the move is blocked short
 * of a whole cell (any JS function returning a fresh fractional double boxes it).
 */
export function sweepAxis(grid: VoxelGrid, box: AABB, axis: 0 | 1 | 2, delta: number): number {
  if (!grid.isWorld) throw new Error('sweepAxis: only the world grid can be swept; use resolvePenetration for structures');
  if (delta === 0 || delta !== delta) return 0;
  const { minX, minY, minZ, maxX, maxY, maxZ } = box;
  if (!validBox(box)) return 0;
  // Cross-section cells: those the box overlaps strictly on the two other axes.
  const x0 = Math.floor(minX + CONTACT_EPS);
  const x1 = Math.ceil(maxX - CONTACT_EPS) - 1;
  const y0 = Math.floor(minY + CONTACT_EPS);
  const y1 = Math.ceil(maxY - CONTACT_EPS) - 1;
  const z0 = Math.floor(minZ + CONTACT_EPS);
  const z1 = Math.ceil(maxZ - CONTACT_EPS) - 1;

  if (axis === 1) {
    if (x0 > x1 || z0 > z1) return delta;
    // Vertical: column-major. Each column is scanned only up to the best blocking half layer
    // found so far, so the total work is bounded by (columns x crossed layers).
    if (delta > 0) {
      const kStart = Math.ceil((maxY - CONTACT_EPS) * 2); // first half layer not already overlapped
      // Half layers k < 2 (maxY + delta - CONTACT_EPS) would be entered; nothing at or above the
      // build limit is solid, which also bounds an infinite delta.
      let kEnd = Math.ceil((maxY + delta - CONTACT_EPS) * 2);
      if (kEnd > 2 * WORLD_HEIGHT) kEnd = 2 * WORLD_HEIGHT;
      let kStop = kEnd;
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) kStop = columnFirstSolidUp(grid, x, z, kStart, kStop, box);
      }
      if (kStop >= kEnd) return delta;
      const d = kStop / 2 - maxY;
      return d > 0 ? d : 0;
    }
    const kStart = Math.floor((minY + CONTACT_EPS) * 2) - 1; // highest half layer not already overlapped
    // Half layers k >= 2 (minY + delta + CONTACT_EPS) would be entered. Nothing below
    // -MAX_BOX_COORD needs a scan (the world stops a fall at deeprock long before; this only
    // bounds an infinite delta on other world grids).
    let kLow = Math.floor((minY + delta + CONTACT_EPS) * 2);
    if (kLow < -2 * MAX_BOX_COORD) kLow = -2 * MAX_BOX_COORD;
    let kStop = kLow - 1; // highest blocking half layer found so far (exclusive lower scan bound)
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) kStop = columnFirstSolidDown(grid, x, z, kStart, kStop, box);
    }
    if (kStop < kLow) return delta;
    const d = (kStop + 1) / 2 - minY;
    return d < 0 ? d : 0;
  }

  // Horizontal. Where the box's own columns and every column the sweep meets hold only empty and
  // full cells, M1's scan: cell layer by cell layer, a full cell blocking at its near face.
  // Otherwise half layers along the axis in sweep order, one pass (sweepAcrossFirst): a full cell
  // blocks at its entry half layer (the even one going +, the odd one going -), a partial cell at
  // every half layer where it has an occupied octant in the cross-section, the far half of the
  // cell layer the box reaches into included.
  if (y0 > y1 || y0 >= WORLD_HEIGHT || x0 > x1 || z0 > z1) return delta;
  // Layers are integers k (cells) or 2k, 2k + 1 (halves); the scan never needs to pass
  // ±MAX_BOX_COORD: the world's unloaded chunks stop it long before, and the clamp keeps an
  // infinite delta finite on other grids.
  if (delta > 0) {
    const hi = axis === 0 ? maxX : maxZ;
    const kStart = Math.ceil((hi - CONTACT_EPS) * 2); // first half layer not already overlapped
    let kEnd = Math.ceil((hi + delta - CONTACT_EPS) * 2); // half layers k < kEnd would be entered
    if (kEnd > 2 * MAX_BOX_COORD) kEnd = 2 * MAX_BOX_COORD;
    // No half layer entered (most walking sweeps), so no cell layer either: nothing to read.
    if (kStart >= kEnd) return delta;
    // The cell layer the box reaches into (cFirst - 1), whose far half the sweep may enter: when
    // its columns under the box are plain (no partial cells), M1's scan of the cell layers ahead.
    let cEnd = Math.ceil(hi + delta - CONTACT_EPS); // cell layers c < cEnd would be entered
    if (cEnd > MAX_BOX_COORD) cEnd = MAX_BOX_COORD;
    const cFirst = Math.ceil(hi - CONTACT_EPS);
    if (grid instanceof World && (leadingLayerSeen(cFirst, cFirst < cEnd, y0) || (axis === 0 ? plainBoxColumns(grid, cFirst - 1, cFirst - 1, z0, z1) : plainBoxColumns(grid, x0, x1, cFirst - 1, cFirst - 1)))) {
      let c = cFirst;
      for (; c < cEnd; c++) {
        const r = axis === 0 ? plainScan(grid, c, c, y0, y1, z0, z1) : plainScan(grid, x0, x1, y0, y1, c, c);
        if (r === PLAIN_FREE) continue;
        if (r === PLAIN_HIT) {
          const d = c - hi;
          return d > 0 ? d : 0;
        }
        break; // a column with partial cells: the half-layer scan below
      }
      if (c >= cEnd) return delta;
    }
    const k = sweepAcrossFirst(grid, box, axis, true, kStart, kEnd - 1);
    if (k === NO_HIT) return delta;
    const d = k / 2 - hi;
    return d > 0 ? d : 0;
  }
  const lo = axis === 0 ? minX : minZ;
  const kStart = Math.floor((lo + CONTACT_EPS) * 2) - 1; // highest half layer not already overlapped
  let kLow = Math.floor((lo + delta + CONTACT_EPS) * 2); // half layers k >= kLow would be entered
  if (kLow < -2 * MAX_BOX_COORD) kLow = -2 * MAX_BOX_COORD;
  if (kStart < kLow) return delta; // (as above)
  let cLow = Math.floor(lo + delta + CONTACT_EPS); // cell layers c >= cLow would be entered
  if (cLow < -MAX_BOX_COORD) cLow = -MAX_BOX_COORD;
  const cFirst = Math.floor(lo + CONTACT_EPS) - 1;
  if (grid instanceof World && (leadingLayerSeen(cFirst + 1, cFirst >= cLow, y0) || (axis === 0 ? plainBoxColumns(grid, cFirst + 1, cFirst + 1, z0, z1) : plainBoxColumns(grid, x0, x1, cFirst + 1, cFirst + 1)))) {
    let c = cFirst;
    for (; c >= cLow; c--) {
      const r = axis === 0 ? plainScan(grid, c, c, y0, y1, z0, z1) : plainScan(grid, x0, x1, y0, y1, c, c);
      if (r === PLAIN_FREE) continue;
      if (r === PLAIN_HIT) {
        const d = c + 1 - lo;
        return d < 0 ? d : 0;
      }
      break;
    }
    if (c < cLow) return delta;
  }
  const k = sweepAcrossFirst(grid, box, axis, false, kLow, kStart);
  if (k === NO_HIT) return delta;
  const d = (k + 1) / 2 - lo;
  return d < 0 ? d : 0;
}

/**
 * True when the cell layer a horizontal sweep's box reaches into (whose far half the sweep may
 * enter, where only a partial cell can block) needs no check of its own before M1's scan: the scan
 * reads at least one cell layer (`scans`), no chunk border runs between the two layers (`border`
 * is the coordinate of the plane between them), so the box's columns lie in the chunks of the
 * first layer the scan reads, and plainScan checks every one of those chunks for layers before it
 * answers (it would not below the world: y0 < 0).
 */
function leadingLayerSeen(border: number, scans: boolean, y0: number): boolean {
  return scans && y0 >= 0 && (border & CHUNK_MASK) !== 0;
}

/**
 * No chunk under the world columns x0..x1, z0..z1 (the columns of the cell layer a sweep's box
 * reaches into, under the box: within 2 chunks)
 * has holes / second-part layers: every cell there is empty or full (a missing chunk reads as full
 * CELL_UNLOADED cells). A larger area answers false.
 */
function plainBoxColumns(grid: World, x0: number, x1: number, z0: number, z1: number): boolean {
  const cx0 = x0 >> CHUNK_SHIFT;
  const cx1 = x1 >> CHUNK_SHIFT;
  const cz0 = z0 >> CHUNK_SHIFT;
  const cz1 = z1 >> CHUNK_SHIFT;
  if (cx1 - cx0 > 1 || cz1 - cz0 > 1) return false;
  // Each chunk once, the one at (x0, z0) last: the scan that follows starts there, and the
  // World's one-entry chunk cache then answers its first lookup.
  if (cz0 !== cz1 && (!plainChunk(grid.chunkAt(x0, z1)) || (cx0 !== cx1 && !plainChunk(grid.chunkAt(x1, z1))))) return false;
  if (cx0 !== cx1 && !plainChunk(grid.chunkAt(x1, z0))) return false;
  return plainChunk(grid.chunkAt(x0, z0));
}

/** A chunk without holes / second-part layers, or none (unloaded: full CELL_UNLOADED cells). */
function plainChunk(c: Chunk | undefined): boolean {
  return c === undefined || (c.holes === null && c.part2 === null);
}

/** plainScan's answers: nothing solid; a solid cell; a column whose chunk has holes / second-part layers. */
const PLAIN_FREE = 0;
const PLAIN_HIT = 1;
const PLAIN_LAYERED = 2;

/**
 * M1's scan of the inclusive CELL range of a World (one chunk lookup per column, y innermost), as
 * long as every column's chunk has no holes / second-part layers: PLAIN_LAYERED at the first column
 * whose chunk has layers (the caller then takes the half-layer path), else PLAIN_HIT when a cell is
 * solid, else PLAIN_FREE. After the first solid cell only the remaining columns' chunks are checked
 * (no cells): a hit is answered once every chunk under the range is known to have no layers, so
 * the answer also vouches for those chunks (leadingLayerSeen).
 */
function plainScan(grid: World, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number {
  if (y1 >= WORLD_HEIGHT) y1 = WORLD_HEIGHT - 1;
  if (x0 > x1 || y0 > y1 || z0 > z1) return PLAIN_FREE;
  if (y0 < 0) {
    if (SOLID[CELL_BELOW_WORLD & ID_MASK] === 1) return PLAIN_HIT;
    y0 = 0;
    if (y0 > y1) return PLAIN_FREE;
  }
  let hit = false;
  for (let x = x0; x <= x1; x++) {
    const lx = x & CHUNK_MASK;
    for (let z = z0; z <= z1; z++) {
      const chunk = grid.chunkAt(x, z);
      if (chunk === undefined) {
        if (SOLID[CELL_UNLOADED & ID_MASK] === 1) hit = true;
        continue;
      }
      if (chunk.holes !== null || chunk.part2 !== null) return PLAIN_LAYERED;
      if (hit) continue;
      const cells = chunk.cells;
      const lz = z & CHUNK_MASK;
      for (let y = y0; y <= y1; y++) {
        if (SOLID[cells[cellIndex(lx, y, lz)]! & ID_MASK] === 1) {
          hit = true;
          break;
        }
      }
    }
  }
  return hit ? PLAIN_HIT : PLAIN_FREE;
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
  // (validBox written out: the probe's coordinates are fresh doubles, boxed if passed on.)
  const valid =
    minX >= -MAX_BOX_COORD &&
    minX <= maxX &&
    maxX <= MAX_BOX_COORD &&
    minY >= -MAX_BOX_COORD &&
    minY <= maxY &&
    maxY <= MAX_BOX_COORD &&
    minZ >= -MAX_BOX_COORD &&
    minZ <= maxZ &&
    maxZ <= MAX_BOX_COORD;
  if (!valid) return false;
  if (grid.isWorld) {
    return worldRangeHasSolid(
      grid,
      Math.floor((minX + CONTACT_EPS) * 2),
      Math.ceil((maxX - CONTACT_EPS) * 2) - 1,
      Math.floor((minY + CONTACT_EPS) * 2),
      Math.ceil((maxY - CONTACT_EPS) * 2) - 1,
      Math.floor((minZ + CONTACT_EPS) * 2),
      Math.ceil((maxZ - CONTACT_EPS) * 2) - 1,
    );
  }
  return structureHasSolid(grid, minX, minY, minZ, maxX, maxY, maxZ);
}

/**
 * boxOverlapsSolid(grid, supportProbe(box, maxGap, inset)). inset 0: "standing on" test;
 * inset > 0: the stricter "attach to this structure" test (attach range must be strictly
 * inside the push range, docs/LESSONS.md). False when the probe is invalid (non-finite
 * input, NaN or negative maxGap). Over the empty half of a partial cell there is no support.
 */
export function hasSupportBelow(grid: VoxelGrid, box: AABB, maxGap: number, inset = 0): boolean {
  return probeOverlapsSolid(grid, box, maxGap, inset);
}

/**
 * Any solid octant of `grid` under the (inset) footprint of `box` within `maxDepth` below its
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

/** Lattice spacing of nearestFreeOffset candidates, in blocks (fine enough for half cells). */
export const FREE_OFFSET_STEP = 0.25;

/**
 * Smallest-3D-length offset (lattice step FREE_OFFSET_STEP, length <= maxRadius) such that
 * the translated box overlaps no solid octant of ANY grid (the same boxOverlapsSolid test the
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
  if (!validBox(box)) return null;
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
          Math.floor((x0 + CONTACT_EPS) * 2),
          Math.ceil((x1 - CONTACT_EPS) * 2) - 1,
          Math.floor((y0 + CONTACT_EPS) * 2),
          Math.ceil((y1 - CONTACT_EPS) * 2) - 1,
          Math.floor((z0 + CONTACT_EPS) * 2),
          Math.ceil((z1 - CONTACT_EPS) * 2) - 1,
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
