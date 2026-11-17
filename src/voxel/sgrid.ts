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
import { AIR } from '../blocks/cell';
import { SET_DEFAULT, type CellBounds, type VoxelGrid } from './grid';

export type StructureCellListener = (
  x: number,
  y: number,
  z: number,
  oldCell: number,
  newCell: number,
  flags: number,
) => void;

const GROW_MARGIN = 2;

export class StructureGrid implements VoxelGrid {
  readonly gridId: number;
  parent: VoxelGrid;
  readonly isWorld = false;

  // ---- storage: dense box [ox, ox+sx) x [oy, oy+sy) x [oz, oz+sz) in local cell coords
  ox = 0;
  oy = 0;
  oz = 0;
  sx = 0;
  sy = 0;
  sz = 0;
  /** index = (x-ox) + (z-oz)*sx + (y-oy)*sx*sz */
  cells: Uint16Array = new Uint16Array(0);
  /** Number of non-air cells. */
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

  getCell(x: number, y: number, z: number): number {
    const lx = x - this.ox;
    const ly = y - this.oy;
    const lz = z - this.oz;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= this.sx || ly >= this.sy || lz >= this.sz) return AIR;
    return this.cells[lx + lz * this.sx + ly * this.sx * this.sz]!;
  }

  setCell(x: number, y: number, z: number, cell: number, flags: number = SET_DEFAULT): boolean {
    let lx = x - this.ox;
    let ly = y - this.oy;
    let lz = z - this.oz;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= this.sx || ly >= this.sy || lz >= this.sz) {
      if (cell === AIR) return false;
      this.grow(x, y, z);
      lx = x - this.ox;
      ly = y - this.oy;
      lz = z - this.oz;
    }
    const i = lx + lz * this.sx + ly * this.sx * this.sz;
    const old = this.cells[i]!;
    if (old === cell) return false;
    this.cells[i] = cell;
    if (old === AIR) this.count++;
    else if (cell === AIR) this.count--;
    this.version++;
    const ls = this.listeners;
    for (let k = 0; k < ls.length; k++) ls[k]!(x, y, z, old, cell, flags);
    return true;
  }

  onCellChange(fn: StructureCellListener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Visit every non-air cell. Do not mutate the grid during iteration. */
  forEachCell(fn: (x: number, y: number, z: number, cell: number) => void): void {
    const { sx, sy, sz, ox, oy, oz, cells } = this;
    let i = 0;
    for (let y = 0; y < sy; y++) {
      for (let z = 0; z < sz; z++) {
        for (let x = 0; x < sx; x++, i++) {
          const c = cells[i]!;
          if (c !== AIR) fn(x + ox, y + oy, z + oz, c);
        }
      }
    }
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

  /** Reallocate storage so that cell (x,y,z) is inside it (with a small margin). */
  private grow(x: number, y: number, z: number): void {
    let nx0: number;
    let ny0: number;
    let nz0: number;
    let nx1: number;
    let ny1: number;
    let nz1: number;
    if (this.cells.length === 0) {
      nx0 = x - GROW_MARGIN;
      ny0 = y - GROW_MARGIN;
      nz0 = z - GROW_MARGIN;
      nx1 = x + 1 + GROW_MARGIN;
      ny1 = y + 1 + GROW_MARGIN;
      nz1 = z + 1 + GROW_MARGIN;
    } else {
      nx0 = Math.min(this.ox, x - GROW_MARGIN);
      ny0 = Math.min(this.oy, y - GROW_MARGIN);
      nz0 = Math.min(this.oz, z - GROW_MARGIN);
      nx1 = Math.max(this.ox + this.sx, x + 1 + GROW_MARGIN);
      ny1 = Math.max(this.oy + this.sy, y + 1 + GROW_MARGIN);
      nz1 = Math.max(this.oz + this.sz, z + 1 + GROW_MARGIN);
    }
    this.resize(nx0, ny0, nz0, nx1 - nx0, ny1 - ny0, nz1 - nz0);
  }

  /** Reallocate storage to the given box, keeping existing cells that fit. */
  resize(ox: number, oy: number, oz: number, sx: number, sy: number, sz: number): void {
    const next = new Uint16Array(sx * sy * sz);
    const old = this.cells;
    const { sx: osx, sy: osy, sz: osz, ox: oox, oy: ooy, oz: ooz } = this;
    let count = 0;
    for (let y = 0; y < osy; y++) {
      const ny = y + ooy - oy;
      if (ny < 0 || ny >= sy) continue;
      for (let z = 0; z < osz; z++) {
        const nz = z + ooz - oz;
        if (nz < 0 || nz >= sz) continue;
        for (let x = 0; x < osx; x++) {
          const nx = x + oox - ox;
          if (nx < 0 || nx >= sx) continue;
          const c = old[x + z * osx + y * osx * osz]!;
          if (c !== AIR) {
            next[nx + nz * sx + ny * sx * sz] = c;
            count++;
          }
        }
      }
    }
    this.cells = next;
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
    const pr = this.parent.worldRotation();
    return qmul(pr, this.rotation, out);
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
