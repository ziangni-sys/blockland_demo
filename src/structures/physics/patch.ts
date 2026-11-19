/**
 * WorldPatch: a dense copy of the world's collision / water flags around one ship, taken once
 * per tick. All sub-steps of the tick then read flat arrays instead of chunk maps. The patch
 * covers the ship's box at the start of the tick plus PATCH_MARGIN blocks: a hull point moves
 * at most substeps * maxSubstepTravel (1.6 by default) per tick, and contact generation looks
 * one cell further for exposed faces. Lookups outside the patch fall back to the world.
 *
 * Flags per cell: PF_SOLID (all 8 octants hard), PF_PARTIAL (some octants hard: `partial` holds
 * the hard-octant mask, allocated the first time a patch has such a cell) and PF_WATER. A chunk
 * without holes / second-part layers is copied by the M1 loop. Water never shares a cell with a
 * part (docs/DESIGN.md: liquids do not flow into cells with parts), so the water rules are
 * unchanged.
 *
 * Water model (buoyancy): a WATER cell with water directly above is full; the top water cell
 * of a run is filled up to WATER_SURFACE_DROP below its top. Filling is continuous in y, so a
 * cube crossing a cell boundary sees no force jump.
 *
 * Candidate world corners (contacts "world corner inside hull"): lattice points touched by
 * exposed faces of hard world cells along at least TWO axes — edges and corners of terrain.
 * Points inside flat terrain faces are left to the hull-point contacts. Next to partial cells the
 * same rule runs on the half-cell lattice (every half-lattice point of a partial cell's closure,
 * its exposed-face mask from the 2 x 2 x 2 octants around it, docs/SHAPES.md 12.6); elsewhere
 * nothing changed.
 */
import { CHUNK_MASK, CHUNK_SHIFT, WORLD_HEIGHT } from '../../core/constants';
import { AIR, HOLES_SHIFT, ID_MASK } from '../../blocks/cell';
import { B, CELL_BELOW_WORLD, CELL_UNLOADED } from '../../blocks/defs';
import { SOLID } from '../../blocks/registry';
import { solidAtHalf, solidFillAt } from '../../voxel/parts';
import type { World } from '../../voxel/world';
import type { ProbeTarget } from './shape';

export const PF_SOLID = 1;
export const PF_WATER = 2;
export const PF_PARTIAL = 4;
/** The water surface of a column lies this far below the top of its highest water cell. */
export const WATER_SURFACE_DROP = 2 / 16;
const TOP_FILL = 1 - WATER_SURFACE_DROP;

// Module constants (not imported bindings) for the per-cell fill loop; see solver.ts.
const SOLID_TABLE: Uint8Array = SOLID;
const WATER_ID: number = B.WATER;
const ID_BITS_MASK: number = ID_MASK;
const HOLES_BITS: number = HOLES_SHIFT;
const SHIFT: number = CHUNK_SHIFT;
const MASK: number = CHUNK_MASK;
const HEIGHT: number = WORLD_HEIGHT;
const BELOW: number = CELL_BELOW_WORLD;
const UNLOADED: number = CELL_UNLOADED;

const EMPTY_U8 = new Uint8Array(0);
const EMPTY_I32 = new Int32Array(0);
const EMPTY_F64 = new Float64Array(0);

export class WorldPatch implements ProbeTarget {
  private world: World | null = null;
  ox = 0;
  oy = 0;
  oz = 0;
  sx = 0;
  sy = 0;
  sz = 0;
  /** PF_* flags; y runs fastest: index = ((z-oz)*sx + (x-ox))*sy + (y-oy). */
  flags: Uint8Array = EMPTY_U8;
  /** The last fill met a partial cell (`partial` is valid for its PF_PARTIAL cells). */
  hasPartial = false;
  /** Hard-octant mask per patch index, read only where the flag is PF_PARTIAL. */
  partial: Uint8Array = EMPTY_U8;
  /** Any hard cell (full or partial) inside the patch (false in open water: terrain contacts are skipped). */
  hasSolid = false;
  /** Inclusive cell bounds of the hard cells, partial ones included (valid when hasSolid). */
  solidMinX = 0;
  solidMinY = 0;
  solidMinZ = 0;
  solidMaxX = 0;
  solidMaxY = 0;
  solidMaxZ = 0;
  /** One above the highest water cell in the patch (-Infinity when there is none). */
  waterTop = -Infinity;

  /** Candidate world corners (lattice points, multiples of 0.5 next to partial cells) and their open-face masks (bit = Dir). */
  cornerCount = 0;
  cornerX: Float64Array = EMPTY_F64;
  cornerY: Float64Array = EMPTY_F64;
  cornerZ: Float64Array = EMPTY_F64;
  cornerMask: Uint8Array = EMPTY_U8;
  private stamp: Int32Array = EMPTY_I32;
  private stampValue = 0;

  /** Copy flags of the inclusive cell box [x0,x1] x [y0,y1] x [z0,z1]. */
  fill(world: World, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    this.world = world;
    const sx = x1 - x0 + 1;
    const sy = y1 - y0 + 1;
    const sz = z1 - z0 + 1;
    const n = sx * sy * sz;
    if (this.flags.length < n) this.flags = new Uint8Array(Math.ceil(n * 1.25));
    this.ox = x0;
    this.oy = y0;
    this.oz = z0;
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    this.hasPartial = false;
    const f = this.flags;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let waterTop = -Infinity;
    let ccx = 0;
    let ccz = 0;
    let cells: Uint16Array | null = null;
    let holes: Uint8Array | null = null;
    let part2: Uint32Array | null = null;
    let haveChunk = false;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        // one chunk lookup per run of 16 columns, not per column
        if (!haveChunk || x >> SHIFT !== ccx || z >> SHIFT !== ccz) {
          ccx = x >> SHIFT;
          ccz = z >> SHIFT;
          const chunk = world.getChunk(ccx, ccz);
          cells = chunk !== undefined ? chunk.cells : null;
          holes = chunk !== undefined ? chunk.holes : null;
          part2 = chunk !== undefined ? chunk.part2 : null;
          haveChunk = true;
        }
        const col = (x & MASK) | ((z & MASK) << 4);
        let i = ((z - z0) * sx + (x - x0)) * sy;
        let colSolid = false;
        if (holes === null && part2 === null) {
          for (let y = y0; y <= y1; y++, i++) {
            let cell: number;
            if (y < 0) cell = BELOW;
            else if (y >= HEIGHT) cell = AIR;
            else if (cells === null) cell = UNLOADED;
            else cell = cells[col | (y << 8)]!;
            const id = cell & ID_BITS_MASK;
            const fl = (SOLID_TABLE[id] === 1 ? PF_SOLID : 0) | (id === WATER_ID ? PF_WATER : 0);
            f[i] = fl;
            if (fl === PF_SOLID) {
              colSolid = true;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            } else if (fl === PF_WATER && y + 1 > waterTop) {
              waterTop = y + 1;
            }
          }
        } else {
          // a chunk with holes / second-part layers (cells is not null: the layers belong to it)
          for (let y = y0; y <= y1; y++, i++) {
            let fl: number;
            if (y < 0 || y >= HEIGHT) {
              fl = y < 0 && SOLID_TABLE[BELOW & ID_BITS_MASK] === 1 ? PF_SOLID : 0;
            } else {
              const ci = col | (y << 8);
              const id = cells![ci]! & ID_BITS_MASK;
              if (SOLID_TABLE[id] === 1) {
                let hard = holes !== null ? ~holes[ci]! & 0xff : 0xff;
                if (part2 !== null) {
                  const p2 = part2[ci]!;
                  if (p2 !== 0 && SOLID_TABLE[p2 & ID_BITS_MASK] === 1) hard |= ~(p2 >>> HOLES_BITS) & 0xff;
                }
                if (hard === 0xff) {
                  fl = PF_SOLID;
                } else {
                  fl = PF_PARTIAL;
                  this.setPartial(i, hard, n);
                }
              } else {
                fl = id === WATER_ID ? PF_WATER : 0;
              }
            }
            f[i] = fl;
            if (fl === PF_SOLID || fl === PF_PARTIAL) {
              colSolid = true;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            } else if (fl === PF_WATER && y + 1 > waterTop) {
              waterTop = y + 1;
            }
          }
        }
        if (colSolid) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
      }
    }
    this.hasSolid = minX !== Infinity;
    this.solidMinX = minX;
    this.solidMinY = minY;
    this.solidMinZ = minZ;
    this.solidMaxX = maxX;
    this.solidMaxY = maxY;
    this.solidMaxZ = maxZ;
    this.waterTop = waterTop;
    this.cornerCount = 0;
  }

  /** Record the hard-octant mask of a partial cell at patch index i (patch size n). */
  private setPartial(i: number, hard: number, n: number): void {
    if (!this.hasPartial) {
      this.hasPartial = true;
      if (this.partial.length < n) this.partial = new Uint8Array(Math.max(n, this.flags.length));
    }
    this.partial[i] = hard;
  }

  flagsAt(x: number, y: number, z: number): number {
    const lx = x - this.ox;
    const ly = y - this.oy;
    const lz = z - this.oz;
    if (lx >= 0 && ly >= 0 && lz >= 0 && lx < this.sx && ly < this.sy && lz < this.sz) {
      return this.flags[(lz * this.sx + lx) * this.sy + ly]!;
    }
    const w = this.world;
    if (w === null) return 0;
    const hard = solidFillAt(w, x, y, z);
    if (hard === 0xff) return PF_SOLID;
    if (hard !== 0) return PF_PARTIAL;
    return (w.getCell(x, y, z) & ID_BITS_MASK) === WATER_ID ? PF_WATER : 0;
  }
  isSolid(x: number, y: number, z: number): boolean {
    return (this.flagsAt(x, y, z) & PF_SOLID) !== 0;
  }
  isOpen(x: number, y: number, z: number): boolean {
    return (this.flagsAt(x, y, z) & (PF_SOLID | PF_PARTIAL)) === 0;
  }
  isPartial(x: number, y: number, z: number): boolean {
    return (this.flagsAt(x, y, z) & PF_PARTIAL) !== 0;
  }
  isSolidHalf(hx: number, hy: number, hz: number): boolean {
    const lx = (hx >> 1) - this.ox;
    const ly = (hy >> 1) - this.oy;
    const lz = (hz >> 1) - this.oz;
    if (lx >= 0 && ly >= 0 && lz >= 0 && lx < this.sx && ly < this.sy && lz < this.sz) {
      const i = (lz * this.sx + lx) * this.sy + ly;
      const fl = this.flags[i]!;
      if ((fl & PF_PARTIAL) === 0) return (fl & PF_SOLID) !== 0;
      return ((this.partial[i]! >> ((hx & 1) | ((hy & 1) << 1) | ((hz & 1) << 2))) & 1) !== 0;
    }
    return this.world !== null && solidAtHalf(this.world, hx, hy, hz);
  }
  /** The world has no sealed cavities: an octant is open when it is not hard. */
  isOpenHalf(hx: number, hy: number, hz: number): boolean {
    return !this.isSolidHalf(hx, hy, hz);
  }
  /** Water height inside cell (x,y,z), measured from its bottom: 0, 1 - WATER_SURFACE_DROP or 1. */
  waterFill(x: number, y: number, z: number): number {
    if ((this.flagsAt(x, y, z) & PF_WATER) === 0) return 0;
    return (this.flagsAt(x, y + 1, z) & PF_WATER) !== 0 ? 1 : TOP_FILL;
  }

  /**
   * Collect candidate world corners whose lattice coordinates lie in the inclusive range
   * [lx0,lx1] x [ly0,ly1] x [lz0,lz1] (clipped to two cells inside the patch). Call after fill().
   */
  collectCorners(lx0: number, ly0: number, lz0: number, lx1: number, ly1: number, lz1: number): void {
    this.cornerCount = 0;
    if (!this.hasSolid) return;
    const { ox, oy, oz, sx, sy, sz } = this;
    // Cells visited are [l0-1, l1]; with this clip they and their 26-neighbours stay inside.
    if (lx0 < ox + 2) lx0 = ox + 2;
    if (ly0 < oy + 2) ly0 = oy + 2;
    if (lz0 < oz + 2) lz0 = oz + 2;
    if (lx1 > ox + sx - 2) lx1 = ox + sx - 2;
    if (ly1 > oy + sy - 2) ly1 = oy + sy - 2;
    if (lz1 > oz + sz - 2) lz1 = oz + sz - 2;
    if (lx0 > lx1 || ly0 > ly1 || lz0 > lz1) return;
    const lsx = sx + 1;
    const lsy = sy + 1;
    const nLat = lsx * lsy * (sz + 1);
    if (this.stamp.length < nLat) {
      this.stamp = new Int32Array(Math.ceil(nLat * 1.25));
      this.stampValue = 0;
    }
    if (++this.stampValue === 0x7fffffff) {
      this.stamp.fill(0);
      this.stampValue = 1;
    }
    const stamp = this.stamp;
    const sv = this.stampValue;
    const f = this.flags;
    const partial = this.hasPartial;
    // Visit hard cells touching the lattice range that have a non-hard 6-neighbour; their
    // corners are the only lattice points that can sit on a terrain edge.
    for (let z = lz0 - 1; z <= lz1; z++) {
      for (let x = lx0 - 1; x <= lx1; x++) {
        const colBase = ((z - oz) * sx + (x - ox)) * sy - oy;
        for (let y = ly0 - 1; y <= ly1; y++) {
          const i = colBase + y;
          if ((f[i]! & PF_SOLID) === 0) {
            if (partial && (f[i]! & PF_PARTIAL) !== 0) this.partialCorners(x, y, z, lx0, ly0, lz0, lx1, ly1, lz1);
            continue;
          }
          // neighbours are inside the patch: the cell range is one inside the lattice clip
          if (
            (f[i + 1]! & PF_SOLID) !== 0 &&
            (f[i - 1]! & PF_SOLID) !== 0 &&
            (f[i + sy]! & PF_SOLID) !== 0 &&
            (f[i - sy]! & PF_SOLID) !== 0 &&
            (f[i + sx * sy]! & PF_SOLID) !== 0 &&
            (f[i - sx * sy]! & PF_SOLID) !== 0
          ) {
            continue;
          }
          for (let k = 0; k < 8; k++) {
            const cx = x + (k & 1);
            const cy = y + ((k >> 1) & 1);
            const cz = z + (k >> 2);
            if (cx < lx0 || cx > lx1 || cy < ly0 || cy > ly1 || cz < lz0 || cz > lz1) continue;
            // a corner of a partial cell is taken on the half lattice (partialCorners)
            if (partial && this.partialAround(cx, cy, cz)) continue;
            const li = (cz - oz) * lsx * lsy + (cx - ox) * lsy + (cy - oy);
            if (stamp[li] === sv) continue;
            stamp[li] = sv;
            const mask = this.cornerOpenMask(cx, cy, cz);
            const axes = ((mask & 3) !== 0 ? 1 : 0) + ((mask & 12) !== 0 ? 1 : 0) + ((mask & 48) !== 0 ? 1 : 0);
            if (axes < 2) continue;
            this.pushCorner(cx, cy, cz, mask);
          }
        }
      }
    }
  }

  /** Is one of the 8 cells around lattice point (X,Y,Z) partial? */
  private partialAround(X: number, Y: number, Z: number): boolean {
    const { ox, oy, oz, sx, sy } = this;
    const f = this.flags;
    const base = ((Z - 1 - oz) * sx + (X - 1 - ox)) * sy + (Y - 1 - oy);
    const sxy = sx * sy;
    return (
      ((f[base]! | f[base + 1]! | f[base + sy]! | f[base + sy + 1]! | f[base + sxy]! | f[base + sxy + 1]! | f[base + sxy + sy]! | f[base + sxy + sy + 1]!) &
        PF_PARTIAL) !==
      0
    );
  }

  /**
   * The 27 half-lattice points of partial cell (x, y, z) that lie in the lattice range: integer
   * ones deduplicated through the stamp, the others emitted by the first partial cell (in the
   * visiting order z, x, y, within the visited range) whose closure contains them.
   */
  private partialCorners(x: number, y: number, z: number, lx0: number, ly0: number, lz0: number, lx1: number, ly1: number, lz1: number): void {
    const { ox, oy, oz, sx, sy } = this;
    const lsy = sy + 1;
    const lsx = sx + 1;
    for (let k = 0; k < 27; k++) {
      const hx = 2 * x + (k % 3);
      const hy = 2 * y + (Math.floor(k / 3) % 3);
      const hz = 2 * z + Math.floor(k / 9);
      if (hx < 2 * lx0 || hx > 2 * lx1 || hy < 2 * ly0 || hy > 2 * ly1 || hz < 2 * lz0 || hz > 2 * lz1) continue;
      if (((hx | hy | hz) & 1) === 0) {
        const li = ((hz >> 1) - oz) * lsx * lsy + ((hx >> 1) - ox) * lsy + ((hy >> 1) - oy);
        if (this.stamp[li] === this.stampValue) continue;
        this.stamp[li] = this.stampValue;
      } else if (!this.ownsHalfPoint(x, y, z, hx, hy, hz, lx0, ly0, lz0, lx1, ly1, lz1)) {
        continue;
      }
      const mask = this.halfOpenMask(hx, hy, hz);
      const axes = ((mask & 3) !== 0 ? 1 : 0) + ((mask & 12) !== 0 ? 1 : 0) + ((mask & 48) !== 0 ? 1 : 0);
      if (axes < 2) continue;
      this.pushCorner(hx * 0.5, hy * 0.5, hz * 0.5, mask);
    }
  }

  /** Is partial cell (x, y, z) the first visited partial cell whose closure holds half point (hx, hy, hz)? */
  private ownsHalfPoint(x: number, y: number, z: number, hx: number, hy: number, hz: number, lx0: number, ly0: number, lz0: number, lx1: number, ly1: number, lz1: number): boolean {
    // cells holding the point: one per odd coordinate, two (h/2 - 1 and h/2) per even one
    const xa = (hx & 1) !== 0 ? hx >> 1 : (hx >> 1) - 1;
    const ya = (hy & 1) !== 0 ? hy >> 1 : (hy >> 1) - 1;
    const za = (hz & 1) !== 0 ? hz >> 1 : (hz >> 1) - 1;
    for (let cz = Math.max(za, lz0 - 1); cz <= Math.min(hz >> 1, lz1); cz++) {
      for (let cx = Math.max(xa, lx0 - 1); cx <= Math.min(hx >> 1, lx1); cx++) {
        for (let cy = Math.max(ya, ly0 - 1); cy <= Math.min(hy >> 1, ly1); cy++) {
          if (cz === z && cx === x && cy === y) return true;
          if ((this.flags[((cz - this.oz) * this.sx + (cx - this.ox)) * this.sy + (cy - this.oy)]! & PF_PARTIAL) !== 0) return false;
        }
      }
    }
    return true;
  }

  /**
   * Directions of the exposed world faces that touch lattice point (X,Y,Z): bit d is set when a
   * hard cell around the corner has a non-hard neighbour in direction d (also around the corner).
   */
  private cornerOpenMask(X: number, Y: number, Z: number): number {
    const { ox, oy, oz, sx, sy } = this;
    const f = this.flags;
    // s(dx,dy,dz) = hard cell (X-1+dx, Y-1+dy, Z-1+dz)
    const base = ((Z - 1 - oz) * sx + (X - 1 - ox)) * sy + (Y - 1 - oy);
    const sxy = sx * sy;
    return openMask(
      f[base]! & 1,
      f[base + 1]! & 1,
      f[base + sy]! & 1,
      f[base + sy + 1]! & 1,
      f[base + sxy]! & 1,
      f[base + sxy + 1]! & 1,
      f[base + sxy + sy]! & 1,
      f[base + sxy + sy + 1]! & 1,
    );
  }

  /** cornerOpenMask on the half lattice: the 2 x 2 x 2 octants around half point (HX, HY, HZ). */
  private halfOpenMask(HX: number, HY: number, HZ: number): number {
    const x = HX - 1;
    const y = HY - 1;
    const z = HZ - 1;
    return openMask(
      this.isSolidHalf(x, y, z) ? 1 : 0,
      this.isSolidHalf(x, y + 1, z) ? 1 : 0,
      this.isSolidHalf(x + 1, y, z) ? 1 : 0,
      this.isSolidHalf(x + 1, y + 1, z) ? 1 : 0,
      this.isSolidHalf(x, y, z + 1) ? 1 : 0,
      this.isSolidHalf(x, y + 1, z + 1) ? 1 : 0,
      this.isSolidHalf(x + 1, y, z + 1) ? 1 : 0,
      this.isSolidHalf(x + 1, y + 1, z + 1) ? 1 : 0,
    );
  }

  private pushCorner(x: number, y: number, z: number, mask: number): void {
    const n = this.cornerCount;
    if (n >= this.cornerX.length) {
      const cap = Math.max(64, n * 2);
      const gx = new Float64Array(cap);
      const gy = new Float64Array(cap);
      const gz = new Float64Array(cap);
      const gm = new Uint8Array(cap);
      gx.set(this.cornerX);
      gy.set(this.cornerY);
      gz.set(this.cornerZ);
      gm.set(this.cornerMask);
      this.cornerX = gx;
      this.cornerY = gy;
      this.cornerZ = gz;
      this.cornerMask = gm;
    }
    this.cornerX[n] = x;
    this.cornerY[n] = y;
    this.cornerZ[n] = z;
    this.cornerMask[n] = mask;
    this.cornerCount = n + 1;
  }
}

/**
 * Exposed-face mask of a lattice point from the hardness (0 / 1) of the 8 unit cubes around it,
 * s(dx,dy,dz) for the cube at (-1+dx, -1+dy, -1+dz) from the point: bit d is set when a hard cube
 * has a non-hard neighbour in direction d, both around the point.
 */
function openMask(s000: number, s010: number, s100: number, s110: number, s001: number, s011: number, s101: number, s111: number): number {
  let m = 0;
  // +X / -X: pairs along x
  if ((s000 & ~s100) | (s010 & ~s110) | (s001 & ~s101) | (s011 & ~s111)) m |= 1;
  if ((s100 & ~s000) | (s110 & ~s010) | (s101 & ~s001) | (s111 & ~s011)) m |= 2;
  // +Y / -Y: pairs along y
  if ((s000 & ~s010) | (s100 & ~s110) | (s001 & ~s011) | (s101 & ~s111)) m |= 4;
  if ((s010 & ~s000) | (s110 & ~s100) | (s011 & ~s001) | (s111 & ~s101)) m |= 8;
  // +Z / -Z: pairs along z
  if ((s000 & ~s001) | (s100 & ~s101) | (s010 & ~s011) | (s110 & ~s111)) m |= 16;
  if ((s001 & ~s000) | (s101 & ~s100) | (s011 & ~s010) | (s111 & ~s110)) m |= 32;
  return m;
}
