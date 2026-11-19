/**
 * Collision / buoyancy view of a structure grid, rebuilt only when grid.version changes
 * (or, for ships, when the bilge flips between dry and flooded). docs/SHAPES.md 12.4, 12.5.
 *
 *  - occupancy, one code per cell: OCC_SOLID (all 8 octants hard), OCC_PARTIAL (some hard
 *    octants: the per-cell masks `solidMask` and `sealedMask` say which, allocated only when the
 *    grid has a partial cell), OCC_SEALED (an empty cell of a sealed hull cavity) and OCC_OPEN.
 *    A sealed cavity is neither hard nor "open": a face towards it is not an exposed face (nothing
 *    from outside can reach it without first breaking the hull), so it never yields a contact
 *    normal. Hot loops test `occ[i] !== OCC_SOLID` first and look at a mask only for OCC_PARTIAL.
 *  - sample points: pass 1 (M1, unchanged) takes the 4 corners and the centre of every unit face
 *    of an OCC_SOLID cell towards an OCC_OPEN cell, corners deduplicated on the integer lattice.
 *    Pass 2 handles the faces that involve partial cells: every face of a hard octant whose own
 *    cell or whose opposite cell is OCC_PARTIAL, when the octant across it is neither hard nor
 *    sealed, is an exposed quarter face; its 4 corners (no centre) are added, deduplicated on the
 *    half-cell lattice (points with three even half coordinates share pass 1's dense table, the
 *    others go through a hash keyed on their half-lattice index; the hash only finds duplicates,
 *    the output order is the scan order). A pass-2 point on an edge of a unit face that pass 1
 *    emitted also takes that face's normal. A ship of full blocks therefore keeps exactly its M1
 *    points in their M1 order. Each point carries the bit mask of the local outward normals of
 *    all the exposed faces it lies on (unit faces and quarter faces alike): the side the hull "came from" when that point penetrates something
 *    (LESSONS 船被推穿薄墙).
 *  - displacement (ships): a cell whose 8 octants all displace water (hard, or a dry cavity: see
 *    hull.ts and the bilgeDry flag) is a unit cube at its centre (dx, dy, dz: the M1 arrays and
 *    order); in every other cell each displacing octant is a half cube at the octant centre
 *    (hcx, hcy, hcz). dispVolume = unit cubes + half cubes / 8.
 */
import { DIR_X, DIR_Y, DIR_Z, type Dir } from '../../core/dirs';
import { HOLES_SHIFT, ID_MASK } from '../../blocks/cell';
import { SOLID } from '../../blocks/registry';
import { quadrantOctant } from '../../blocks/shapes';
import type { StructureGrid } from '../../voxel/sgrid';
import { HULL_BILGE, HULL_MIXED, HULL_SEALED, HULL_SOLID, hullOctantKind, type HullInfo } from '../hull';

export const OCC_OPEN = 0;
export const OCC_SOLID = 1;
export const OCC_SEALED = 2;
export const OCC_PARTIAL = 3;

/**
 * Lookup used by the contact prober: the world (via WorldPatch) and GridShape implement it.
 * Cell queries serve the M1 integer algorithm; the half-cell queries (integer half-cell
 * coordinates: local coordinates times 2, floored) serve the half-grid one near partial cells.
 */
export interface ProbeTarget {
  /** Some cell of the target is partial (false: the half-cell queries are never needed). */
  readonly hasPartial: boolean;
  /** Cell whose 8 octants are all hard. */
  isSolid(x: number, y: number, z: number): boolean;
  /** Cell without hard octants whose faces count as exposed (not a sealed cavity). */
  isOpen(x: number, y: number, z: number): boolean;
  /** Cell with some, but not all, octants hard. */
  isPartial(x: number, y: number, z: number): boolean;
  /** Hard octant. */
  isSolidHalf(hx: number, hy: number, hz: number): boolean;
  /** Octant that is neither hard nor sealed: a face of a hard octant towards it is exposed. */
  isOpenHalf(hx: number, hy: number, hz: number): boolean;
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
/**
 * For each Dir, the midpoints of the 4 edges of the unit face, in half-cell units from twice the
 * cell's min corner (x,y,z triples). Pass 2 of the sample points can create a point there; it
 * then lies on that unit face too.
 */
const FACE_EDGE_MIDS: readonly number[] = (() => {
  const out: number[] = [];
  const uv = [1, 0, 1, 2, 0, 1, 2, 1];
  for (let d = 0; d < 6; d++) {
    const a = d >> 1;
    const u = (a + 1) % 3;
    const v = (a + 2) % 3;
    for (let k = 0; k < 4; k++) {
      const o = [0, 0, 0];
      o[a] = (d & 1) === 0 ? 2 : 0;
      o[u] = uv[k * 2]!;
      o[v] = uv[k * 2 + 1]!;
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
  /** Some cell is OCC_PARTIAL (solidMask and sealedMask are allocated). */
  hasPartial = false;
  /** Per cell of the box (read only where occ is OCC_PARTIAL): hard octants. */
  solidMask: Uint8Array = EMPTY_U8;
  /** Per cell of the box (read only where occ is OCC_PARTIAL): empty octants of a sealed cavity. */
  sealedMask: Uint8Array = EMPTY_U8;
  /** Cells with at least one hard octant (a ship of slabs only is not empty). */
  solidCount = 0;
  /** Tight cell bounds of the cells with a hard octant (max exclusive). Valid when solidCount > 0. */
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

  /** Centres of water-displacing unit cubes (ships only). */
  dispCount = 0;
  dx: Float64Array = EMPTY_F64;
  dy: Float64Array = EMPTY_F64;
  dz: Float64Array = EMPTY_F64;
  /** Centres of water-displacing half cubes (octants of cells that do not displace as a whole). */
  halfCount = 0;
  hcx: Float64Array = EMPTY_F64;
  hcy: Float64Array = EMPTY_F64;
  hcz: Float64Array = EMPTY_F64;
  /** Displacing volume in cells: dispCount + halfCount / 8. */
  dispVolume = 0;

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
  isPartial(x: number, y: number, z: number): boolean {
    return this.occAt(x, y, z) === OCC_PARTIAL;
  }
  isSolidHalf(hx: number, hy: number, hz: number): boolean {
    const lx = (hx >> 1) - this.ox;
    const ly = (hy >> 1) - this.oy;
    const lz = (hz >> 1) - this.oz;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= this.sx || ly >= this.sy || lz >= this.sz) return false;
    const i = lx + lz * this.sx + ly * this.sx * this.sz;
    const c = this.occ[i]!;
    if (c !== OCC_PARTIAL) return c === OCC_SOLID;
    return ((this.solidMask[i]! >> ((hx & 1) | ((hy & 1) << 1) | ((hz & 1) << 2))) & 1) !== 0;
  }
  isOpenHalf(hx: number, hy: number, hz: number): boolean {
    const lx = (hx >> 1) - this.ox;
    const ly = (hy >> 1) - this.oy;
    const lz = (hz >> 1) - this.oz;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= this.sx || ly >= this.sy || lz >= this.sz) return true;
    const i = lx + lz * this.sx + ly * this.sx * this.sz;
    const c = this.occ[i]!;
    if (c !== OCC_PARTIAL) return c === OCC_OPEN;
    return (((this.solidMask[i]! | this.sealedMask[i]!) >> ((hx & 1) | ((hy & 1) << 1) | ((hz & 1) << 2))) & 1) === 0;
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
    this.hasPartial = false;
    this.solidMask = EMPTY_U8;
    this.sealedMask = EMPTY_U8;

    // The three storage layers, read directly (getCell would show only the first part).
    const st = grid.storage();
    const base = st.layers.base;
    const holes = st.layers.holes;
    const part2 = st.layers.part2;
    const ssx = st.sx;
    const slayer = st.sx * st.sz;
    let solid = 0;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let y = b.minY; y < b.maxY; y++) {
      for (let z = b.minZ; z < b.maxZ; z++) {
        const row = (z - st.oz) * ssx + (y - st.oy) * slayer - st.ox;
        for (let x = b.minX; x < b.maxX; x++) {
          const si = row + x;
          const v = base[si]!;
          if (v === 0) continue;
          let hard = SOLID[v & ID_MASK] === 1 ? 0xff : 0;
          if (holes !== null || part2 !== null) {
            if (hard !== 0 && holes !== null) hard = ~holes[si]! & 0xff;
            const p2 = part2 !== null ? part2[si]! : 0;
            if (p2 !== 0 && SOLID[p2 & ID_MASK] === 1) hard |= ~(p2 >>> HOLES_SHIFT) & 0xff;
          }
          if (hard === 0) continue;
          const i = x - ox + (z - oz) * sx + (y - oy) * layer;
          if (hard === 0xff) {
            occ[i] = OCC_SOLID;
          } else {
            if (!this.hasPartial) {
              this.hasPartial = true;
              this.solidMask = new Uint8Array(occ.length);
              this.sealedMask = new Uint8Array(occ.length);
            }
            occ[i] = OCC_PARTIAL;
            this.solidMask[i] = hard;
          }
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
            const c = occ[i]!;
            if (c === OCC_PARTIAL) {
              // the empty octants of a partial cell that are sealed cavity
              let m = 0;
              for (let o = 0; o < 8; o++) {
                if (hullOctantKind(hull, x + ox, y + oy, z + oz, o) === HULL_SEALED) m |= 1 << o;
              }
              this.sealedMask[i] = m;
              continue;
            }
            const k = sameBox ? hull.kind[i]! : hullOctantKind(hull, x + ox, y + oy, z + oz, 0);
            if (k === HULL_SEALED && c === OCC_OPEN) occ[i] = OCC_SEALED;
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
    this.hasPartial = false;
    this.solidMask = this.sealedMask = EMPTY_U8;
    this.solidCount = 0;
    this.pointCount = 0;
    this.px = this.py = this.pz = EMPTY_F64;
    this.pmask = EMPTY_U8;
    this.dispCount = 0;
    this.dx = this.dy = this.dz = EMPTY_F64;
    this.halfCount = 0;
    this.hcx = this.hcy = this.hcz = EMPTY_F64;
    this.dispVolume = 0;
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
    if (this.hasPartial) this.buildPartialPoints(x0, y0, z0, x1, y1, z1, lat, xs, ys, zs, ms);
    this.pointCount = xs.length;
    this.px = Float64Array.from(xs);
    this.py = Float64Array.from(ys);
    this.pz = Float64Array.from(zs);
    this.pmask = Uint8Array.from(ms);
  }

  /**
   * Pass 2 of the sample points: exposed quarter faces of hard octants next to partial cells.
   * Scan order: cells by y, z, x; directions 0..5; quadrants 0..3 (blocks/shapes.ts
   * quadrantOctant); in each quadrant first the inner octant (its face d lies inside the cell) and
   * then the outer one (its face d is the cell face); corners in FACE_CORNERS order. Afterwards
   * the points on edges of pass 1's unit faces take those faces' normals (no point is added).
   */
  private buildPartialPoints(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    lat: Int32Array,
    xs: number[],
    ys: number[],
    zs: number[],
    ms: number[],
  ): void {
    const { ox, oy, oz, sx, sz, occ, solidMask, sealedMask } = this;
    const layer = sx * sz;
    const lsx = sx + 1;
    const lsz = sz + 1;
    const hsx = 2 * sx + 1;
    const hsz = 2 * sz + 1;
    const half = new Map<number, number>();
    const emit = (hx: number, hy: number, hz: number, bit: number): void => {
      let idx: number;
      if (((hx | hy | hz) & 1) === 0) {
        const li = (hx >> 1) - ox + ((hz >> 1) - oz) * lsx + ((hy >> 1) - oy) * lsx * lsz;
        idx = lat[li]!;
        if (idx < 0) lat[li] = xs.length;
      } else {
        const key = hx - 2 * ox + (hz - 2 * oz) * hsx + (hy - 2 * oy) * hsx * hsz;
        const found = half.get(key);
        idx = found === undefined ? -1 : found;
        if (idx < 0) half.set(key, xs.length);
      }
      if (idx < 0) {
        xs.push(hx * 0.5);
        ys.push(hy * 0.5);
        zs.push(hz * 0.5);
        ms.push(bit);
      } else {
        ms[idx] = ms[idx]! | bit;
      }
    };
    /**
     * The 4 corners of the face in direction d of octant o of cell (x, y, z): on the half lattice
     * the octant is a unit cube, so FACE_CORNERS' 0/1 offsets apply as they are.
     */
    const quad = (x: number, y: number, z: number, o: number, d: number): void => {
      const h0 = 2 * x + (o & 1);
      const h1 = 2 * y + ((o >> 1) & 1);
      const h2 = 2 * z + ((o >> 2) & 1);
      const bit = 1 << d;
      for (let k = 0; k < 4; k++) {
        const c = (d * 4 + k) * 3;
        emit(h0 + FACE_CORNERS[c]!, h1 + FACE_CORNERS[c + 1]!, h2 + FACE_CORNERS[c + 2]!, bit);
      }
    };
    for (let y = y0; y < y1; y++) {
      for (let z = z0; z < z1; z++) {
        for (let x = x0; x < x1; x++) {
          const i = x - ox + (z - oz) * sx + (y - oy) * layer;
          const c = occ[i]!;
          if (c !== OCC_SOLID && c !== OCC_PARTIAL) continue;
          const partial = c === OCC_PARTIAL;
          if (!partial) {
            let near = false;
            for (let d = 0; d < 6 && !near; d++) near = this.occAt(x + DIR_X[d]!, y + DIR_Y[d]!, z + DIR_Z[d]!) === OCC_PARTIAL;
            if (!near) continue;
          }
          const hard = partial ? solidMask[i]! : 0xff;
          const sealed = partial ? sealedMask[i]! : 0;
          for (let d = 0; d < 6; d++) {
            const a = d >> 1;
            const nx = x + DIR_X[d]!;
            const ny = y + DIR_Y[d]!;
            const nz = z + DIR_Z[d]!;
            const nc = this.occAt(nx, ny, nz);
            if (!partial && nc !== OCC_PARTIAL) continue;
            // octants of the neighbour that block a face: hard, or sealed cavity
            let nBlock: number;
            if (nc === OCC_PARTIAL) {
              const ni = nx - ox + (nz - oz) * sx + (ny - oy) * layer;
              nBlock = solidMask[ni]! | sealedMask[ni]!;
            } else {
              nBlock = nc === OCC_OPEN ? 0 : 0xff;
            }
            for (let q = 0; q < 4; q++) {
              const oOut = quadrantOctant(d as Dir, q);
              const oIn = oOut ^ (1 << a);
              // inner octant: its face d looks into oOut of the same cell
              if (partial && ((hard >> oIn) & 1) !== 0 && (((hard | sealed) >> oOut) & 1) === 0) quad(x, y, z, oIn, d);
              // outer octant: its face d is the cell face; across it lies oIn of the neighbour
              if (((hard >> oOut) & 1) !== 0 && ((nBlock >> oIn) & 1) === 0) quad(x, y, z, oOut, d);
            }
          }
        }
      }
    }
    // A point of this pass can be the midpoint of an edge of a unit face that pass 1 emitted (a
    // full cell's face towards an open cell, next to a partial cell): it lies on that face too, so
    // it takes the face's normal. Without it the point (1, 0, 0.5) of [full block | upper slab]
    // carried +X only and could be pushed out of the ground only sideways. The midpoints have one
    // odd half coordinate, so they live in the hash; this only ORs bits into points that exist.
    if (half.size === 0) return;
    for (let y = y0; y < y1; y++) {
      for (let z = z0; z < z1; z++) {
        for (let x = x0; x < x1; x++) {
          if (occ[x - ox + (z - oz) * sx + (y - oy) * layer] !== OCC_SOLID) continue;
          for (let d = 0; d < 6; d++) {
            if (this.occAt(x + DIR_X[d]!, y + DIR_Y[d]!, z + DIR_Z[d]!) !== OCC_OPEN) continue;
            for (let k = 0; k < 4; k++) {
              const c = (d * 4 + k) * 3;
              const hx = 2 * x + FACE_EDGE_MIDS[c]!;
              const hy = 2 * y + FACE_EDGE_MIDS[c + 1]!;
              const hz = 2 * z + FACE_EDGE_MIDS[c + 2]!;
              const idx = half.get(hx - 2 * ox + (hz - 2 * oz) * hsx + (hy - 2 * oy) * hsx * hsz);
              if (idx !== undefined) ms[idx] = ms[idx]! | (1 << d);
            }
          }
        }
      }
    }
  }

  private buildDisplacement(hull: HullInfo | null, bilgeDry: boolean): void {
    if (hull === null) {
      this.dispCount = 0;
      this.dx = this.dy = this.dz = EMPTY_F64;
      this.halfCount = 0;
      this.hcx = this.hcy = this.hcz = EMPTY_F64;
      this.dispVolume = 0;
      return;
    }
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    const hxs: number[] = [];
    const hys: number[] = [];
    const hzs: number[] = [];
    const { sx: hx, sy: hy, sz: hz } = hull;
    let m = 0;
    for (let y = 0; y < hy; y++) {
      for (let z = 0; z < hz; z++) {
        for (let x = 0; x < hx; x++) {
          const k = hull.kind[x + z * hx + y * hx * hz]!;
          if (k === HULL_MIXED) {
            const kinds = hull.mixedKinds[m++]!;
            let bits = 0;
            for (let o = 0; o < 8; o++) {
              const ko = (kinds >> (o * 2)) & 3;
              if (ko === HULL_SOLID || ko === HULL_SEALED || (ko === HULL_BILGE && bilgeDry)) bits |= 1 << o;
            }
            if (bits === 0xff) {
              xs.push(x + hull.ox + 0.5);
              ys.push(y + hull.oy + 0.5);
              zs.push(z + hull.oz + 0.5);
              continue;
            }
            for (let o = 0; o < 8; o++) {
              if (((bits >> o) & 1) === 0) continue;
              hxs.push(x + hull.ox + 0.25 + 0.5 * (o & 1));
              hys.push(y + hull.oy + 0.25 + 0.5 * ((o >> 1) & 1));
              hzs.push(z + hull.oz + 0.25 + 0.5 * ((o >> 2) & 1));
            }
            continue;
          }
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
    this.halfCount = hxs.length;
    this.hcx = Float64Array.from(hxs);
    this.hcy = Float64Array.from(hys);
    this.hcz = Float64Array.from(hzs);
    this.dispVolume = this.dispCount + this.halfCount / 8;
  }
}

/**
 * Among the hard cells whose closure contains local point (x,y,z), the one nearest to
 * (tx,ty,tz), and the octant of it to name its part: names the hull part a pinned contact point
 * belongs to (docs/SHAPES.md 12.7). A cell whose 8 octants are hard competes with its centre (as
 * in M1) and answers its octant on the side of the point (towards the target on a tie); in a
 * partial cell every hard octant whose closure contains the point competes with its own centre.
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
  out: { x: number; y: number; z: number; octant: number },
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
        const c = shape.occAt(cx, cy, cz);
        if (c === OCC_SOLID) {
          const dx = cx + 0.5 - tx;
          const dy = cy + 0.5 - ty;
          const dz = cz + 0.5 - tz;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < best) {
            best = d;
            out.x = cx;
            out.y = cy;
            out.z = cz;
            out.octant = sideBit(x, cx, tx) | (sideBit(y, cy, ty) << 1) | (sideBit(z, cz, tz) << 2);
          }
          continue;
        }
        if (c !== OCC_PARTIAL) continue;
        // hard octants of this partial cell whose closure contains the point
        const hx0 = Math.floor((x - e) * 2);
        const hx1 = Math.floor((x + e) * 2);
        const hy0 = Math.floor((y - e) * 2);
        const hy1 = Math.floor((y + e) * 2);
        const hz0 = Math.floor((z - e) * 2);
        const hz1 = Math.floor((z + e) * 2);
        for (let hy = hy0; hy <= hy1; hy++) {
          if (hy >> 1 !== cy) continue;
          for (let hz = hz0; hz <= hz1; hz++) {
            if (hz >> 1 !== cz) continue;
            for (let hx = hx0; hx <= hx1; hx++) {
              if (hx >> 1 !== cx || !shape.isSolidHalf(hx, hy, hz)) continue;
              const dx = hx * 0.5 + 0.25 - tx;
              const dy = hy * 0.5 + 0.25 - ty;
              const dz = hz * 0.5 + 0.25 - tz;
              const d = dx * dx + dy * dy + dz * dz;
              if (d < best) {
                best = d;
                out.x = cx;
                out.y = cy;
                out.z = cz;
                out.octant = (hx & 1) | ((hy & 1) << 1) | ((hz & 1) << 2);
              }
            }
          }
        }
      }
    }
  }
  return best < Infinity;
}

/** The half (0 low, 1 high) of cell coordinate c that coordinate p lies in; on the middle plane, the half towards t. */
function sideBit(p: number, c: number, t: number): number {
  const m = c + 0.5;
  if (p > m) return 1;
  if (p < m) return 0;
  return t > m ? 1 : 0;
}
