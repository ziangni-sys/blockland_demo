/**
 * StructureGrid: the voxel storage + rigid pose of a structure (ship or rotor).
 * It is the second implementation of VoxelGrid (the first is World).
 *
 * POSE. A structure has a `pivot` (a point in its own local space), a `position` (where
 * that pivot currently is, expressed in the PARENT grid's local space) and a `rotation`
 * (local -> parent). So:
 *
 *     parentPoint = position + rotate(rotation, localPoint - pivot)
 *     worldPoint  = parent.toWorld(parentPoint)
 *
 * For a top-level structure the parent is the world, so parent space == world space.
 * For a rotor mounted on a ship the parent is the ship's grid.
 *  - ships: pivot = centre of mass (the physics module moves it when blocks change, via
 *    setPivotKeepingPose so nothing jumps).
 *  - rotors: pivot = a point on the bearing axis; rotation = base orientation * spin.
 *
 * `prevPosition` / `prevRotation` hold the pose at the start of the current tick; the
 * renderer interpolates between prev and current. Call snapshotPose() once per tick
 * BEFORE moving the structure.
 *
 * Velocities are expressed in parent space, relative to the parent.
 *
 * STORAGE. A dense box in three layers (docs/SHAPES.md section 4.1): the base layer (id + state
 * of the first part), and the holes and second-part layers, allocated the first time a cell
 * needs them. The storage is private: cells are read with getCell / getPart2 (or getPacked in
 * voxel/parts.ts), written with setCell, and handed out whole by copyBox, loadBox and storage().
 * A layer is only dropped when the whole storage is reallocated (resize, grow, loadBox) and its
 * count of non-zero entries is 0 then; storage() and copyBox() hand out a layer with no
 * non-zero entry as null.
 */
import {
  qcopy,
  qmul,
  qrotate,
  qrotateInv,
  qslerp,
  quat,
  vclone,
  vcopy,
  vec3,
  type Quat,
  type Vec3,
} from '../core/math';
import { AIR, CELL_MULTI_BIT, FULL_LIMIT, HOLES_MASK, HOLES_SHIFT, PACK_SCALE, type CellLayers } from '../blocks/cell';
import { SET_DEFAULT, type CellBounds, type VoxelGrid } from './grid';
import { checkCanonical } from './parts';

/** Called after a structure cell changed; oldCell and newCell are packed cells (blocks/cell.ts). */
export type StructureCellListener = (
  x: number,
  y: number,
  z: number,
  oldCell: number,
  newCell: number,
  flags: number,
) => void;

/** What StructureGrid.storage() hands out. */
export interface GridStorage {
  ox: number;
  oy: number;
  oz: number;
  sx: number;
  sy: number;
  sz: number;
  /** Index = (x-ox) + (z-oz)*sx + (y-oy)*sx*sz. A layer with no non-zero entry is null. */
  layers: CellLayers;
}

const GROW_MARGIN = 2;
/** grow() re-bases on the tight bounds when the storage is more than this many times the tight box. */
const STORAGE_SLACK = 4;

export class StructureGrid implements VoxelGrid {
  readonly gridId: number;
  parent: VoxelGrid;
  readonly isWorld = false;

  // ---- storage: dense box [ox, ox+sx) x [oy, oy+sy) x [oz, oz+sz) in local cell coords
  private ox = 0;
  private oy = 0;
  private oz = 0;
  private sx = 0;
  private sy = 0;
  private sz = 0;
  /** Base layer, index = (x-ox) + (z-oz)*sx + (y-oy)*sx*sz. */
  private cells: Uint16Array = new Uint16Array(0);
  /** Holes of the first part, same index; null until needed. */
  private holes: Uint8Array | null = null;
  /** Second part's value, same index (0 = none); null until needed. */
  private part2: Uint32Array | null = null;
  /** Non-zero entries of `holes` / `part2`. */
  private holesCount = 0;
  private part2Count = 0;
  /** Number of non-air cells (a two-part cell counts once). */
  count = 0;
  /** Incremented on every cell change; caches (mesh, mass, surface) key off it. */
  version = 0;

  // ---- pose (parent space)
  readonly pivot: Vec3 = vec3();
  readonly position: Vec3 = vec3();
  readonly rotation: Quat = quat();
  readonly prevPosition: Vec3 = vec3();
  readonly prevRotation: Quat = quat();
  /** Linear velocity of the pivot, parent space, units/second. */
  readonly linearVelocity: Vec3 = vec3();
  /** Angular velocity about the pivot, parent space, rad/second. */
  readonly angularVelocity: Vec3 = vec3();

  private listeners: StructureCellListener[] = [];
  private boundsCache: CellBounds | null = null;
  private boundsVersion = -1;

  constructor(gridId: number, parent: VoxelGrid) {
    if (gridId <= 0) throw new Error('structure gridId must be positive');
    this.gridId = gridId;
    this.parent = parent;
  }

  // ------------------------------------------------------------ cells

  /** Cell value (first part + CELL_MULTI_BIT, < 2^25) at local coordinates; AIR outside the storage. */
  getCell(x: number, y: number, z: number): number {
    const lx = x - this.ox;
    const ly = y - this.oy;
    const lz = z - this.oz;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= this.sx || ly >= this.sy || lz >= this.sz) return AIR;
    const i = lx + lz * this.sx + ly * this.sx * this.sz;
    const h = this.holes;
    const q = this.part2;
    if (h === null && q === null) return this.cells[i]!;
    return this.cells[i]! | (h !== null ? h[i]! << HOLES_SHIFT : 0) | (q !== null && q[i] !== 0 ? CELL_MULTI_BIT : 0);
  }

  /** Second part's value at local coordinates; 0 when there is none or outside the storage. */
  getPart2(x: number, y: number, z: number): number {
    const q = this.part2;
    if (q === null) return 0;
    const lx = x - this.ox;
    const ly = y - this.oy;
    const lz = z - this.oz;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= this.sx || ly >= this.sy || lz >= this.sz) return 0;
    return q[lx + lz * this.sx + ly * this.sx * this.sz]!;
  }

  /**
   * Write a packed cell (blocks/cell.ts) and notify listeners once. Grows the storage to reach a
   * non-air cell outside it. Returns false when nothing changed (or AIR outside the storage).
   * Throws RangeError, before anything changes, for a value >= FULL_LIMIT that is not in canonical
   * form (invariants I1-I6 of docs/SHAPES.md 1.3). A value below FULL_LIMIT (a full block) is never
   * checked, whatever layers the storage has (docs/SHAPES.md 1.3, 3.4): without layers it takes the
   * M1 path, with layers it also clears the cell's entries there.
   */
  setCell(x: number, y: number, z: number, packed: number, flags: number = SET_DEFAULT): boolean {
    const full = packed < FULL_LIMIT;
    // Checked before the storage can grow for it.
    if (!full) checkCanonical(packed);
    let lx = x - this.ox;
    let ly = y - this.oy;
    let lz = z - this.oz;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= this.sx || ly >= this.sy || lz >= this.sz) {
      if (packed === AIR) return false;
      this.grow(x, y, z);
      lx = x - this.ox;
      ly = y - this.oy;
      lz = z - this.oz;
    }
    const i = lx + lz * this.sx + ly * this.sx * this.sz;
    let old: number;
    if (full && this.holes === null && this.part2 === null) {
      old = this.cells[i]!;
      if (old === packed) return false;
      this.cells[i] = packed;
    } else {
      old = this.packedAt(i);
      if (old === packed) return false;
      // A full block stores like the M1 path (16 bits), clearing the holes and second part.
      this.writeLayers(i, full ? packed & 0xffff : packed);
    }
    if (old === AIR) this.count++;
    else if (packed === AIR) this.count--;
    this.version++;
    const ls = this.listeners;
    for (let k = 0; k < ls.length; k++) ls[k]!(x, y, z, old, packed, flags);
    return true;
  }

  /** Packed cell at storage index i. */
  private packedAt(i: number): number {
    const h = this.holes;
    const q = this.part2;
    const p2 = q !== null ? q[i]! : 0;
    return (this.cells[i]! | (h !== null ? h[i]! << HOLES_SHIFT : 0) | (p2 !== 0 ? CELL_MULTI_BIT : 0)) + p2 * PACK_SCALE;
  }

  /** Store a (validated) packed cell at storage index i, allocating a layer on its first non-zero entry. */
  private writeLayers(i: number, packed: number): void {
    const cell = packed < PACK_SCALE ? packed : packed % PACK_SCALE;
    const p2 = packed < PACK_SCALE ? 0 : Math.floor(packed / PACK_SCALE);
    const n = this.cells.length;
    this.cells[i] = cell & 0xffff;
    const hv = (cell >>> HOLES_SHIFT) & HOLES_MASK;
    let h = this.holes;
    if (h === null && hv !== 0) h = this.holes = new Uint8Array(n);
    if (h !== null) {
      const was = h[i]!;
      if (was !== hv) {
        h[i] = hv;
        this.holesCount += was === 0 ? 1 : hv === 0 ? -1 : 0;
      }
    }
    let q = this.part2;
    if (q === null && p2 !== 0) q = this.part2 = new Uint32Array(n);
    if (q !== null) {
      const was = q[i]!;
      if (was !== p2) {
        q[i] = p2;
        this.part2Count += was === 0 ? 1 : p2 === 0 ? -1 : 0;
      }
    }
  }

  onCellChange(fn: StructureCellListener): () => void {
    // Copy-on-write so (un)subscribing from inside a listener never skips or repeats one.
    this.listeners = [...this.listeners, fn];
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  /** Visit every non-air cell with its packed value. Do not mutate the grid during iteration. */
  forEachCell(fn: (x: number, y: number, z: number, packed: number) => void): void {
    const { sx, sy, sz, ox, oy, oz, cells } = this;
    const layered = this.holes !== null || this.part2 !== null;
    let i = 0;
    for (let y = 0; y < sy; y++) {
      for (let z = 0; z < sz; z++) {
        for (let x = 0; x < sx; x++, i++) {
          const c = cells[i]!;
          if (c !== AIR) fn(x + ox, y + oy, z + oz, layered ? this.packedAt(i) : c);
        }
      }
    }
  }

  /** True when the storage has a holes or second-part layer allocated (it may be all 0, see the file comment). */
  get layered(): boolean {
    return this.holes !== null || this.part2 !== null;
  }

  /**
   * Dense copy of the three layers over the box [minX, minX+sx) x ... (cells outside the storage
   * are AIR), index (x-minX) + (z-minZ)*sx + (y-minY)*sx*sz. A layer with no non-zero entry in the
   * box is null. Structure records and mesh snapshots use it.
   */
  copyBox(minX: number, minY: number, minZ: number, sx: number, sy: number, sz: number): CellLayers {
    const base = new Uint16Array(sx * sy * sz);
    let holes: Uint8Array | null = null;
    let part2: Uint32Array | null = null;
    const srcH = this.holesCount > 0 ? this.holes : null;
    const srcQ = this.part2Count > 0 ? this.part2 : null;
    // Intersection of the box with the storage, in local cell coordinates.
    const x0 = Math.max(minX, this.ox);
    const x1 = Math.min(minX + sx, this.ox + this.sx);
    const y0 = Math.max(minY, this.oy);
    const y1 = Math.min(minY + sy, this.oy + this.sy);
    const z0 = Math.max(minZ, this.oz);
    const z1 = Math.min(minZ + sz, this.oz + this.sz);
    if (x0 >= x1 || y0 >= y1 || z0 >= z1) return { base, holes, part2 };
    const n = x1 - x0;
    for (let y = y0; y < y1; y++) {
      for (let z = z0; z < z1; z++) {
        const from = x0 - this.ox + (z - this.oz) * this.sx + (y - this.oy) * this.sx * this.sz;
        const to = x0 - minX + (z - minZ) * sx + (y - minY) * sx * sz;
        base.set(this.cells.subarray(from, from + n), to);
        if (srcH !== null && anyNonZero(srcH, from, from + n)) {
          if (holes === null) holes = new Uint8Array(base.length);
          holes.set(srcH.subarray(from, from + n), to);
        }
        if (srcQ !== null && anyNonZero(srcQ, from, from + n)) {
          if (part2 === null) part2 = new Uint32Array(base.length);
          part2.set(srcQ.subarray(from, from + n), to);
        }
      }
    }
    return { base, holes, part2 };
  }

  /**
   * Replace the whole content with this box: the storage becomes exactly the box, the layers are
   * copied in (a layer whose entries are all 0 is not allocated), count is recounted and version
   * incremented. No change events. The network client loads structure records with it.
   * Throws RangeError when a layer's length is not sx*sy*sz.
   */
  loadBox(minX: number, minY: number, minZ: number, sx: number, sy: number, sz: number, layers: CellLayers): void {
    const n = sx * sy * sz;
    if (
      !(Number.isInteger(n) && n >= 0) ||
      layers.base.length !== n ||
      (layers.holes !== null && layers.holes.length !== n) ||
      (layers.part2 !== null && layers.part2.length !== n)
    ) {
      throw new RangeError(`loadBox: layers do not match a ${sx}x${sy}x${sz} box`);
    }
    const holesCount = layers.holes !== null ? countNonZero(layers.holes) : 0;
    const part2Count = layers.part2 !== null ? countNonZero(layers.part2) : 0;
    this.cells = layers.base.slice();
    this.holes = holesCount > 0 ? layers.holes!.slice() : null;
    this.part2 = part2Count > 0 ? layers.part2!.slice() : null;
    this.holesCount = holesCount;
    this.part2Count = part2Count;
    this.ox = minX;
    this.oy = minY;
    this.oz = minZ;
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    this.count = countNonZero(this.cells);
    this.version++;
  }

  /**
   * The storage box and its layers by reference (a layer with no non-zero entry is null), for
   * per-cell scans such as the ship physics. Valid until the next write to this grid.
   */
  storage(): GridStorage {
    return {
      ox: this.ox,
      oy: this.oy,
      oz: this.oz,
      sx: this.sx,
      sy: this.sy,
      sz: this.sz,
      layers: {
        base: this.cells,
        holes: this.holesCount > 0 ? this.holes : null,
        part2: this.part2Count > 0 ? this.part2 : null,
      },
    };
  }

  /**
   * TESTS ONLY: share `other`'s storage (layers by reference, box, count, version), so a test
   * client can read the server's cells as they are now (tests/drive/client.ts).
   */
  adoptStorage(other: StructureGrid): void {
    this.cells = other.cells;
    this.holes = other.holes;
    this.part2 = other.part2;
    this.holesCount = other.holesCount;
    this.part2Count = other.part2Count;
    this.ox = other.ox;
    this.oy = other.oy;
    this.oz = other.oz;
    this.sx = other.sx;
    this.sy = other.sy;
    this.sz = other.sz;
    this.count = other.count;
    this.version = other.version;
  }

  cellBounds(): CellBounds | null {
    if (this.boundsVersion === this.version) return this.boundsCache;
    this.boundsVersion = this.version;
    if (this.count === 0) {
      this.boundsCache = null;
      return null;
    }
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    this.forEachCell((x, y, z) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    });
    this.boundsCache = { minX, minY, minZ, maxX: maxX + 1, maxY: maxY + 1, maxZ: maxZ + 1 };
    return this.boundsCache;
  }

  /**
   * Reallocate storage so that cell (x,y,z) is inside it. The box grows geometrically
   * (by half its size, at least GROW_MARGIN) on each side that has to move, so building a
   * structure cell by cell costs amortised O(1) per cell instead of a full copy each time.
   *
   * When the old storage is more than STORAGE_SLACK times the tight box that will hold the cells
   * (cells were removed since it grew), the new storage starts from the tight bounds instead of
   * the old storage. Without that, a grid built out along x, cleared and built out along z, then
   * along y, would keep every old extent and multiply them (a 1000-cell arm per axis: 10^9 cells),
   * although its tight box is small. So the storage stays within a small factor of the tight box,
   * which is limited (docs/DESIGN.md 组装与方块化), and building normally never re-bases.
   */
  private grow(x: number, y: number, z: number): void {
    const b = this.count > 0 ? this.cellBounds() : null;
    if (b === null) {
      this.resize(
        x - GROW_MARGIN,
        y - GROW_MARGIN,
        z - GROW_MARGIN,
        1 + 2 * GROW_MARGIN,
        1 + 2 * GROW_MARGIN,
        1 + 2 * GROW_MARGIN,
      );
      return;
    }
    let x0 = this.ox;
    let y0 = this.oy;
    let z0 = this.oz;
    let x1 = this.ox + this.sx;
    let y1 = this.oy + this.sy;
    let z1 = this.oz + this.sz;
    const tight =
      (Math.max(b.maxX, x + 1) - Math.min(b.minX, x)) *
      (Math.max(b.maxY, y + 1) - Math.min(b.minY, y)) *
      (Math.max(b.maxZ, z + 1) - Math.min(b.minZ, z));
    if (this.cells.length > STORAGE_SLACK * tight) {
      x0 = b.minX;
      y0 = b.minY;
      z0 = b.minZ;
      x1 = b.maxX;
      y1 = b.maxY;
      z1 = b.maxZ;
    }
    const padX = Math.max(GROW_MARGIN, (x1 - x0) >> 1);
    const padY = Math.max(GROW_MARGIN, (y1 - y0) >> 1);
    const padZ = Math.max(GROW_MARGIN, (z1 - z0) >> 1);
    if (x < x0) x0 = Math.min(x - GROW_MARGIN, x0 - padX);
    else if (x >= x1) x1 = Math.max(x + 1 + GROW_MARGIN, x1 + padX);
    if (y < y0) y0 = Math.min(y - GROW_MARGIN, y0 - padY);
    else if (y >= y1) y1 = Math.max(y + 1 + GROW_MARGIN, y1 + padY);
    if (z < z0) z0 = Math.min(z - GROW_MARGIN, z0 - padZ);
    else if (z >= z1) z1 = Math.max(z + 1 + GROW_MARGIN, z1 + padZ);
    this.resize(x0, y0, z0, x1 - x0, y1 - y0, z1 - z0);
  }

  /**
   * Reallocate storage to the given box, keeping existing cells that fit. Every layer with a
   * non-zero entry is moved the same way; a layer whose count is 0 now is not carried over.
   */
  resize(ox: number, oy: number, oz: number, sx: number, sy: number, sz: number): void {
    const n = sx * sy * sz;
    const next = new Uint16Array(n);
    const old = this.cells;
    const oldH = this.holesCount > 0 ? this.holes : null;
    const oldQ = this.part2Count > 0 ? this.part2 : null;
    const nextH = oldH !== null ? new Uint8Array(n) : null;
    const nextQ = oldQ !== null ? new Uint32Array(n) : null;
    const { sx: osx, sy: osy, sz: osz, ox: oox, oy: ooy, oz: ooz } = this;
    let count = 0;
    let holesCount = 0;
    let part2Count = 0;
    for (let y = 0; y < osy; y++) {
      const ny = y + ooy - oy;
      if (ny < 0 || ny >= sy) continue;
      for (let z = 0; z < osz; z++) {
        const nz = z + ooz - oz;
        if (nz < 0 || nz >= sz) continue;
        for (let x = 0; x < osx; x++) {
          const nx = x + oox - ox;
          if (nx < 0 || nx >= sx) continue;
          const from = x + z * osx + y * osx * osz;
          const c = old[from]!;
          if (c !== AIR) {
            const to = nx + nz * sx + ny * sx * sz;
            next[to] = c;
            count++;
            if (oldH !== null) {
              const h = oldH[from]!;
              if (h !== 0) {
                nextH![to] = h;
                holesCount++;
              }
            }
            if (oldQ !== null) {
              const q = oldQ[from]!;
              if (q !== 0) {
                nextQ![to] = q;
                part2Count++;
              }
            }
          }
        }
      }
    }
    this.cells = next;
    this.holes = holesCount > 0 ? nextH : null;
    this.part2 = part2Count > 0 ? nextQ : null;
    this.holesCount = holesCount;
    this.part2Count = part2Count;
    this.ox = ox;
    this.oy = oy;
    this.oz = oz;
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    this.count = count;
    this.version++;
  }

  // ------------------------------------------------------------ pose

  /** Copy the current pose into prevPosition / prevRotation. Call once per tick before moving. */
  snapshotPose(): void {
    vcopy(this.prevPosition, this.position);
    qcopy(this.prevRotation, this.rotation);
  }

  /** Set the pose and make prev == current (teleport: no interpolation streak). */
  setPoseImmediate(position: Vec3, rotation: Quat): void {
    vcopy(this.position, position);
    qcopy(this.rotation, rotation);
    this.snapshotPose();
  }

  /**
   * Move the pivot to a new local point without changing where any cell is in the parent
   * space (used when a ship's centre of mass changes). Updates position and prevPosition.
   */
  setPivotKeepingPose(newPivot: Vec3): void {
    const d = vec3(newPivot.x - this.pivot.x, newPivot.y - this.pivot.y, newPivot.z - this.pivot.z);
    const cur = qrotate(this.rotation, d);
    const prev = qrotate(this.prevRotation, d);
    this.position.x += cur.x;
    this.position.y += cur.y;
    this.position.z += cur.z;
    this.prevPosition.x += prev.x;
    this.prevPosition.y += prev.y;
    this.prevPosition.z += prev.z;
    vcopy(this.pivot, newPivot);
  }

  /** Local point -> parent-space point. */
  toParent(p: Vec3, out: Vec3 = vec3()): Vec3 {
    out.x = p.x - this.pivot.x;
    out.y = p.y - this.pivot.y;
    out.z = p.z - this.pivot.z;
    qrotate(this.rotation, out, out);
    out.x += this.position.x;
    out.y += this.position.y;
    out.z += this.position.z;
    return out;
  }
  /** Parent-space point -> local point. */
  fromParent(p: Vec3, out: Vec3 = vec3()): Vec3 {
    out.x = p.x - this.position.x;
    out.y = p.y - this.position.y;
    out.z = p.z - this.position.z;
    qrotateInv(this.rotation, out, out);
    out.x += this.pivot.x;
    out.y += this.pivot.y;
    out.z += this.pivot.z;
    return out;
  }

  toWorld(p: Vec3, out: Vec3 = vec3()): Vec3 {
    this.toParent(p, out);
    return this.parent.isWorld ? out : this.parent.toWorld(out, out);
  }
  toLocal(p: Vec3, out: Vec3 = vec3()): Vec3 {
    if (this.parent.isWorld) {
      return this.fromParent(p, out);
    }
    this.parent.toLocal(p, out);
    return this.fromParent(out, out);
  }
  dirToWorld(d: Vec3, out: Vec3 = vec3()): Vec3 {
    qrotate(this.rotation, d, out);
    return this.parent.isWorld ? out : this.parent.dirToWorld(out, out);
  }
  dirToLocal(d: Vec3, out: Vec3 = vec3()): Vec3 {
    if (this.parent.isWorld) return qrotateInv(this.rotation, d, out);
    this.parent.dirToLocal(d, out);
    return qrotateInv(this.rotation, out, out);
  }
  worldRotation(out: Quat = quat()): Quat {
    if (this.parent.isWorld) return qcopy(out, this.rotation);
    this.parent.worldRotation(out);
    return qmul(out, this.rotation, out);
  }

  /**
   * World-space velocity of the structure's material at a world point:
   * own motion relative to the parent (rotated to world) plus the parent's velocity there.
   */
  velocityAt(worldPoint: Vec3, out: Vec3 = vec3()): Vec3 {
    const pp = this.parent.isWorld ? vclone(worldPoint) : this.parent.toLocal(worldPoint);
    const rx = pp.x - this.position.x;
    const ry = pp.y - this.position.y;
    const rz = pp.z - this.position.z;
    const w = this.angularVelocity;
    const v = this.linearVelocity;
    const rel = vec3(v.x + (w.y * rz - w.z * ry), v.y + (w.z * rx - w.x * rz), v.z + (w.x * ry - w.y * rx));
    if (this.parent.isWorld) {
      return vcopy(out, rel);
    }
    const relWorld = this.parent.dirToWorld(rel);
    const pv = this.parent.velocityAt(worldPoint);
    out.x = relWorld.x + pv.x;
    out.y = relWorld.y + pv.y;
    out.z = relWorld.z + pv.z;
    return out;
  }

  /**
   * Interpolated local->world transform for rendering: position of the pivot and rotation,
   * both in WORLD space, at blend factor alpha (0 = previous tick, 1 = current tick).
   * Parents are interpolated with the same alpha.
   */
  renderPose(alpha: number, outPos: Vec3 = vec3(), outRot: Quat = quat()): { position: Vec3; rotation: Quat } {
    const p = vec3(
      this.prevPosition.x + (this.position.x - this.prevPosition.x) * alpha,
      this.prevPosition.y + (this.position.y - this.prevPosition.y) * alpha,
      this.prevPosition.z + (this.position.z - this.prevPosition.z) * alpha,
    );
    const r = qslerp(this.prevRotation, this.rotation, alpha);
    const par = this.parent;
    if (par.isWorld || !(par instanceof StructureGrid)) {
      vcopy(outPos, p);
      qcopy(outRot, r);
    } else {
      const pp = par.renderPose(alpha);
      // world = pp.position + pp.rotation * (p - par.pivot)
      const rel = vec3(p.x - par.pivot.x, p.y - par.pivot.y, p.z - par.pivot.z);
      qrotate(pp.rotation, rel, rel);
      outPos.x = pp.position.x + rel.x;
      outPos.y = pp.position.y + rel.y;
      outPos.z = pp.position.z + rel.z;
      qmul(pp.rotation, r, outRot);
    }
    return { position: outPos, rotation: outRot };
  }
}

function countNonZero(a: Uint16Array | Uint8Array | Uint32Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== 0) n++;
  return n;
}

function anyNonZero(a: Uint8Array | Uint32Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (a[i] !== 0) return true;
  return false;
}
