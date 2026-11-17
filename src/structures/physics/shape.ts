/**
 * Collision / buoyancy view of a structure grid, rebuilt only when grid.version changes
 * (or, for ships, when the bilge flips between dry and flooded).
 *
 *  - occupancy: HARD cells (SOLID[id]) collide; sealed hull cavities are neither solid nor
 *    "open": a face towards a sealed cavity is not an exposed face (nothing from outside can
 *    reach it without first breaking the hull), so it never yields a contact normal.
 *  - sample points: corners and centres of every exposed face of every hard cell, deduplicated.
 *    Each carries the bit mask of the local outward normals of the faces it lies on — the side
 *    the hull "came from" when that point penetrates something (LESSONS 船被推穿薄墙).
 *  - displacing cells (ships): centres of cells that displace water (hull.ts displacesWater,
 *    with our own notion of whether the ship floats — see refresh in massprops.ts).
 */
import { DIR_X, DIR_Y, DIR_Z } from '../../core/dirs';
import { ID_MASK } from '../../blocks/cell';
import { SOLID } from '../../blocks/registry';
import type { StructureGrid } from '../../voxel/sgrid';
import { HULL_BILGE, HULL_SEALED, HULL_SOLID, hullKindAt, type HullInfo } from '../hull';

export const OCC_OPEN = 0;
export const OCC_SOLID = 1;
export const OCC_SEALED = 2;

/** Lookup used by the contact prober: the world (via WorldPatch) and GridShape implement it. */
export interface ProbeTarget {
  /** Hard (colliding) cell. */
  isSolid(x: number, y: number, z: number): boolean;
  /** A face of a hard cell towards this cell is exposed. */
  isOpen(x: number, y: number, z: number): boolean;
}

/** For each Dir, the 4 face corners as offsets from the cell's min corner (x,y,z triples). */
const FACE_CORNERS: readonly number[] = (() => {
  const out: number[] = [];
  for (let d = 0; d < 6; d++) {
    const a = d >> 1;
    const plane = (d & 1) === 0 ? 1 : 0;
    const u = (a + 1) % 3;
    const v = (a + 2) % 3;
    for (let k = 0; k < 4; k++) {
      const o = [0, 0, 0];
      o[a] = plane;
      o[u] = k & 1;
      o[v] = k >> 1;
      out.push(o[0]!, o[1]!, o[2]!);
    }
  }
  return out;
})();
/** For each Dir, the face centre as an offset from the cell's min corner. */
const FACE_CENTRES: readonly number[] = [
  1, 0.5, 0.5, 0, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0,
];

const EMPTY_F64 = new Float64Array(0);
const EMPTY_U8 = new Uint8Array(0);

export class GridShape implements ProbeTarget {
  /** grid.version this was built from (-1 = never built). */
  version = -1;
  /** Bilge cells counted as displacing when built. */
  bilgeDry = false;

  /** Occupancy box: tight cell bounds grown by one (same box as HullInfo). */
  ox = 0;
  oy = 0;
  oz = 0;
  sx = 0;
  sy = 0;
  sz = 0;
  /** OCC_* per cell; index = (x-ox) + (z-oz)*sx + (y-oy)*sx*sz. */
  occ: Uint8Array = EMPTY_U8;
  solidCount = 0;
  /** Tight bounds of the HARD cells (max exclusive). Valid when solidCount > 0. */
  minX = 0;
  minY = 0;
  minZ = 0;
  maxX = 0;
  maxY = 0;
  maxZ = 0;

  /** Surface sample points in local coordinates, with their local normal masks (bit = Dir). */
  pointCount = 0;
  px: Float64Array = EMPTY_F64;
  py: Float64Array = EMPTY_F64;
  pz: Float64Array = EMPTY_F64;
  pmask: Uint8Array = EMPTY_U8;

  /** Centres of water-displacing cells (ships only). */
  dispCount = 0;
  dx: Float64Array = EMPTY_F64;
  dy: Float64Array = EMPTY_F64;
  dz: Float64Array = EMPTY_F64;

  occAt(x: number, y: number, z: number): number {
    const lx = x - this.ox;
    const ly = y - this.oy;
    const lz = z - this.oz;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= this.sx || ly >= this.sy || lz >= this.sz) return OCC_OPEN;
    return this.occ[lx + lz * this.sx + ly * this.sx * this.sz]!;
  }
  isSolid(x: number, y: number, z: number): boolean {
    return this.occAt(x, y, z) === OCC_SOLID;
  }
  isOpen(x: number, y: number, z: number): boolean {
    return this.occAt(x, y, z) === OCC_OPEN;
  }

  /**
   * Rebuild from the grid. `hull` (ships) marks sealed cavities and provides the displacing
   * cells; `bilgeDry` says whether bilge cells displace water. O(cells in the bounding box).
   */
  build(grid: StructureGrid, hull: HullInfo | null, bilgeDry: boolean): void {
    this.version = grid.version;
    this.bilgeDry = bilgeDry;
    const b = grid.cellBounds();
    if (b === null) {
      this.clear();
      return;
    }
    const ox = b.minX - 1;
    const oy = b.minY - 1;
    const oz = b.minZ - 1;
    const sx = b.maxX - b.minX + 2;
    const sy = b.maxY - b.minY + 2;
    const sz = b.maxZ - b.minZ + 2;
    const layer = sx * sz;
    const occ = new Uint8Array(layer * sy);
    this.ox = ox;
    this.oy = oy;
    this.oz = oz;
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    this.occ = occ;

    let solid = 0;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let y = b.minY; y < b.maxY; y++) {
      for (let z = b.minZ; z < b.maxZ; z++) {
        for (let x = b.minX; x < b.maxX; x++) {
          const cell = grid.getCell(x, y, z);
          if (cell === 0 || SOLID[cell & ID_MASK] !== 1) continue;
          occ[x - ox + (z - oz) * sx + (y - oy) * layer] = OCC_SOLID;
          solid++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (z < minZ) minZ = z;
          if (x + 1 > maxX) maxX = x + 1;
          if (y + 1 > maxY) maxY = y + 1;
          if (z + 1 > maxZ) maxZ = z + 1;
        }
      }
    }
    this.solidCount = solid;
    if (solid > 0) {
      this.minX = minX;
      this.minY = minY;
      this.minZ = minZ;
      this.maxX = maxX;
      this.maxY = maxY;
      this.maxZ = maxZ;
    }

    const sameBox =
      hull !== null && hull.ox === ox && hull.oy === oy && hull.oz === oz && hull.sx === sx && hull.sy === sy && hull.sz === sz;
    if (hull !== null) {
      for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
          for (let x = 0; x < sx; x++) {
            const i = x + z * sx + y * layer;
            const k = sameBox ? hull.kind[i]! : hullKindAt(hull, x + ox, y + oy, z + oz);
            if (k === HULL_SEALED && occ[i] === OCC_OPEN) occ[i] = OCC_SEALED;
          }
        }
      }
    }

    this.buildPoints(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
    this.buildDisplacement(hull, bilgeDry);
  }

  private clear(): void {
    this.ox = this.oy = this.oz = 0;
    this.sx = this.sy = this.sz = 0;
    this.occ = EMPTY_U8;
    this.solidCount = 0;
    this.pointCount = 0;
    this.px = this.py = this.pz = EMPTY_F64;
    this.pmask = EMPTY_U8;
    this.dispCount = 0;
    this.dx = this.dy = this.dz = EMPTY_F64;
  }

  private buildPoints(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const { ox, oy, oz, sx, sz, occ } = this;
    const layer = sx * sz;
    // Corner dedupe: lattice points of the occupancy box.
    const lsx = sx + 1;
    const lsz = sz + 1;
    const lat = new Int32Array(lsx * lsz * (this.sy + 1)).fill(-1);
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    const ms: number[] = [];
    for (let y = y0; y < y1; y++) {
      for (let z = z0; z < z1; z++) {
        for (let x = x0; x < x1; x++) {
          if (occ[x - ox + (z - oz) * sx + (y - oy) * layer] !== OCC_SOLID) continue;
          for (let d = 0; d < 6; d++) {
            if (this.occAt(x + DIR_X[d]!, y + DIR_Y[d]!, z + DIR_Z[d]!) !== OCC_OPEN) continue;
            const bit = 1 << d;
            xs.push(x + FACE_CENTRES[d * 3]!);
            ys.push(y + FACE_CENTRES[d * 3 + 1]!);
            zs.push(z + FACE_CENTRES[d * 3 + 2]!);
            ms.push(bit);
            for (let k = 0; k < 4; k++) {
              const o = (d * 4 + k) * 3;
              const cx = x + FACE_CORNERS[o]!;
              const cy = y + FACE_CORNERS[o + 1]!;
              const cz = z + FACE_CORNERS[o + 2]!;
              const li = cx - ox + (cz - oz) * lsx + (cy - oy) * lsx * lsz;
              const idx = lat[li]!;
              if (idx < 0) {
                lat[li] = xs.length;
                xs.push(cx);
                ys.push(cy);
                zs.push(cz);
                ms.push(bit);
              } else {
                ms[idx] = ms[idx]! | bit;
              }
            }
          }
        }
      }
    }
    this.pointCount = xs.length;
    this.px = Float64Array.from(xs);
    this.py = Float64Array.from(ys);
    this.pz = Float64Array.from(zs);
    this.pmask = Uint8Array.from(ms);
  }

  private buildDisplacement(hull: HullInfo | null, bilgeDry: boolean): void {
    if (hull === null) {
      this.dispCount = 0;
      this.dx = this.dy = this.dz = EMPTY_F64;
      return;
    }
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    const { sx: hx, sy: hy, sz: hz } = hull;
    for (let y = 0; y < hy; y++) {
      for (let z = 0; z < hz; z++) {
        for (let x = 0; x < hx; x++) {
          const k = hull.kind[x + z * hx + y * hx * hz]!;
          if (k === HULL_SOLID || k === HULL_SEALED || (k === HULL_BILGE && bilgeDry)) {
            xs.push(x + hull.ox + 0.5);
            ys.push(y + hull.oy + 0.5);
            zs.push(z + hull.oz + 0.5);
          }
        }
      }
    }
    this.dispCount = xs.length;
    this.dx = Float64Array.from(xs);
    this.dy = Float64Array.from(ys);
    this.dz = Float64Array.from(zs);
  }
}

/**
 * Among the hard cells whose closure contains local point (x,y,z), the one whose centre is
 * nearest to (tx,ty,tz). Used to name the hull cell a pinned contact point belongs to.
 * Returns false when none is hard.
 */
export function nearestOwnerCell(
  shape: GridShape,
  x: number,
  y: number,
  z: number,
  tx: number,
  ty: number,
  tz: number,
  out: { x: number; y: number; z: number },
): boolean {
  const e = 1e-6;
  const xa = Math.floor(x - e);
  const xb = Math.floor(x + e);
  const ya = Math.floor(y - e);
  const yb = Math.floor(y + e);
  const za = Math.floor(z - e);
  const zb = Math.floor(z + e);
  let best = Infinity;
  for (let cy = ya; cy <= yb; cy++) {
    for (let cz = za; cz <= zb; cz++) {
      for (let cx = xa; cx <= xb; cx++) {
        if (!shape.isSolid(cx, cy, cz)) continue;
        const dx = cx + 0.5 - tx;
        const dy = cy + 0.5 - ty;
        const dz = cz + 0.5 - tz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) {
          best = d;
          out.x = cx;
          out.y = cy;
          out.z = cz;
        }
      }
    }
  }
  return best < Infinity;
}
