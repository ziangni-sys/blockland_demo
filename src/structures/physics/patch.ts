/**
 * WorldPatch: a dense copy of the world's collision / water flags around one ship, taken once
 * per tick. All sub-steps of the tick then read flat arrays instead of chunk maps. The patch
 * covers the ship's box at the start of the tick plus PATCH_MARGIN blocks: a hull point moves
 * at most substeps * maxSubstepTravel (1.6 by default) per tick, and contact generation looks
 * one cell further for exposed faces. Lookups outside the patch fall back to the world.
 *
 * Water model (buoyancy): a WATER cell with water directly above is full; the top water cell
 * of a run is filled up to WATER_SURFACE_DROP below its top. Filling is continuous in y, so a
 * cube crossing a cell boundary sees no force jump.
 *
 * Candidate world corners (contacts "world corner inside hull"): lattice points touched by
 * exposed faces of hard world cells along at least TWO axes — edges and corners of terrain.
 * Points inside flat terrain faces are left to the hull-point contacts.
 */
import { CHUNK_MASK, CHUNK_SHIFT, WORLD_HEIGHT } from '../../core/constants';
import { AIR, ID_MASK } from '../../blocks/cell';
import { B, CELL_BELOW_WORLD, CELL_UNLOADED } from '../../blocks/defs';
import { SOLID } from '../../blocks/registry';
import type { World } from '../../voxel/world';
import type { ProbeTarget } from './shape';

export const PF_SOLID = 1;
export const PF_WATER = 2;
/** The water surface of a column lies this far below the top of its highest water cell. */
export const WATER_SURFACE_DROP = 2 / 16;
const TOP_FILL = 1 - WATER_SURFACE_DROP;

export function cellFlags(cell: number): number {
  const id = cell & ID_MASK;
  return (SOLID[id] === 1 ? PF_SOLID : 0) | (id === B.WATER ? PF_WATER : 0);
}

const EMPTY_U8 = new Uint8Array(0);
const EMPTY_I32 = new Int32Array(0);

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
  /** Any hard cell inside the patch (false in open water: terrain contacts are skipped). */
  hasSolid = false;
  /** Inclusive cell bounds of the hard cells in the patch (valid when hasSolid). */
  solidMinX = 0;
  solidMinY = 0;
  solidMinZ = 0;
  solidMaxX = 0;
  solidMaxY = 0;
  solidMaxZ = 0;
  /** One above the highest water cell in the patch (-Infinity when there is none). */
  waterTop = -Infinity;

  /** Candidate world corners (integer lattice points) and their open-face masks (bit = Dir). */
  cornerCount = 0;
  cornerX: Int32Array = EMPTY_I32;
  cornerY: Int32Array = EMPTY_I32;
  cornerZ: Int32Array = EMPTY_I32;
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
    const f = this.flags;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let waterTop = -Infinity;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const chunk = world.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
        const col = (x & CHUNK_MASK) | ((z & CHUNK_MASK) << 4);
        let i = ((z - z0) * sx + (x - x0)) * sy;
        let colSolid = false;
        for (let y = y0; y <= y1; y++, i++) {
          let cell: number;
          if (y < 0) cell = CELL_BELOW_WORLD;
          else if (y >= WORLD_HEIGHT) cell = AIR;
          else if (chunk === undefined) cell = CELL_UNLOADED;
          else cell = chunk.cells[col | (y << 8)]!;
          const fl = cellFlags(cell);
          f[i] = fl;
          if (fl === PF_SOLID) {
            colSolid = true;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          } else if (fl === PF_WATER && y + 1 > waterTop) {
            waterTop = y + 1;
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

  flagsAt(x: number, y: number, z: number): number {
    const lx = x - this.ox;
    const ly = y - this.oy;
    const lz = z - this.oz;
    if (lx >= 0 && ly >= 0 && lz >= 0 && lx < this.sx && ly < this.sy && lz < this.sz) {
      return this.flags[(lz * this.sx + lx) * this.sy + ly]!;
    }
    return this.world !== null ? cellFlags(this.world.getCell(x, y, z)) : 0;
  }
  isSolid(x: number, y: number, z: number): boolean {
    return (this.flagsAt(x, y, z) & PF_SOLID) !== 0;
  }
  isOpen(x: number, y: number, z: number): boolean {
    return (this.flagsAt(x, y, z) & PF_SOLID) === 0;
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
    // Cells visited are [l0-1, l1]; with this clip they and their 6-neighbours stay inside.
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
    // Visit hard cells touching the lattice range that have a non-hard 6-neighbour; their
    // corners are the only lattice points that can sit on a terrain edge.
    for (let z = lz0 - 1; z <= lz1; z++) {
      for (let x = lx0 - 1; x <= lx1; x++) {
        const colBase = ((z - oz) * sx + (x - ox)) * sy - oy;
        for (let y = ly0 - 1; y <= ly1; y++) {
          const i = colBase + y;
          if ((f[i]! & PF_SOLID) === 0) continue;
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
    const s000 = f[base]! & 1;
    const s010 = f[base + 1]! & 1;
    const s100 = f[base + sy]! & 1;
    const s110 = f[base + sy + 1]! & 1;
    const s001 = f[base + sxy]! & 1;
    const s011 = f[base + sxy + 1]! & 1;
    const s101 = f[base + sxy + sy]! & 1;
    const s111 = f[base + sxy + sy + 1]! & 1;
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

  private pushCorner(x: number, y: number, z: number, mask: number): void {
    const n = this.cornerCount;
    if (n >= this.cornerX.length) {
      const cap = Math.max(64, n * 2);
      const gx = new Int32Array(cap);
      const gy = new Int32Array(cap);
      const gz = new Int32Array(cap);
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
