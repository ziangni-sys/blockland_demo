/**
 * Per-tick view of the structures as the entities see them: world bounds, the pose at the
 * start of the tick (prev) and now (cur), and the heading change in between.
 *
 * Built once per tick after the structures moved (syncCarried / update), so every entity
 * reads the same poses and nothing is recomputed per entity.
 *
 * Pose convention (StructureGrid.renderPose): world = p + rotate(q, local - pivot), with p / q
 * the composed WORLD pose (parents included). prev = renderPose(0), cur = renderPose(1).
 */
import { TICK_DT } from '../core/constants';
import { qconj, qmul, qrotate, qrotateInv, quat, vec3, wrapAngle, type AABB, type Quat, type Vec3 } from '../core/math';
import type { Ship, Structure } from '../structures/structure';
import type { StructureGrid } from '../voxel/sgrid';

export class StructRec {
  structure!: Structure;
  grid!: StructureGrid;
  id = 0;
  /** Nesting depth: 0 = mounted on the world, 1 = mounted on a ship ... */
  depth = 0;
  /** The structure as a Ship (it has a hull), else null. */
  ship: Ship | null = null;
  /** Record of the structure it is mounted on. */
  parent: StructRec | null = null;
  /** World AABB of all its cells at the current pose. */
  minX = 0;
  minY = 0;
  minZ = 0;
  maxX = 0;
  maxY = 0;
  maxZ = 0;
  /** World pose at the start of the tick / now. */
  readonly p0: Vec3 = vec3();
  readonly q0: Quat = quat();
  readonly p1: Vec3 = vec3();
  readonly q1: Quat = quat();
  readonly pivot: Vec3 = vec3();
  /** The pose changed this tick. */
  moved = false;
  /** Heading change this tick about world +Y (twist of q1 * q0^-1), radians, CCW from above. */
  dyaw = 0;
}

/** World point -> local point at the previous pose. `out` may alias `p`. */
export function prevToLocal(r: StructRec, p: Vec3, out: Vec3): Vec3 {
  out.x = p.x - r.p0.x;
  out.y = p.y - r.p0.y;
  out.z = p.z - r.p0.z;
  qrotateInv(r.q0, out, out);
  out.x += r.pivot.x;
  out.y += r.pivot.y;
  out.z += r.pivot.z;
  return out;
}
/** Local point -> world point at the previous pose. */
export function prevToWorld(r: StructRec, l: Vec3, out: Vec3): Vec3 {
  out.x = l.x - r.pivot.x;
  out.y = l.y - r.pivot.y;
  out.z = l.z - r.pivot.z;
  qrotate(r.q0, out, out);
  out.x += r.p0.x;
  out.y += r.p0.y;
  out.z += r.p0.z;
  return out;
}
/** World point -> local point at the current pose. */
export function curToLocal(r: StructRec, p: Vec3, out: Vec3): Vec3 {
  out.x = p.x - r.p1.x;
  out.y = p.y - r.p1.y;
  out.z = p.z - r.p1.z;
  qrotateInv(r.q1, out, out);
  out.x += r.pivot.x;
  out.y += r.pivot.y;
  out.z += r.pivot.z;
  return out;
}
/** Local point -> world point at the current pose. */
export function curToWorld(r: StructRec, l: Vec3, out: Vec3): Vec3 {
  out.x = l.x - r.pivot.x;
  out.y = l.y - r.pivot.y;
  out.z = l.z - r.pivot.z;
  qrotate(r.q1, out, out);
  out.x += r.p1.x;
  out.y += r.p1.y;
  out.z += r.p1.z;
  return out;
}
/** Where this tick's motion of the structure takes a world point that moved with it. */
export function carryPoint(r: StructRec, p: Vec3, out: Vec3): Vec3 {
  return curToWorld(r, prevToLocal(r, p, out), out);
}
/** World velocity (blocks/s) over this tick of the structure's material now at world point p. */
export function pointVelocity(r: StructRec, p: Vec3, out: Vec3): Vec3 {
  if (!r.moved) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  prevToWorld(r, curToLocal(r, p, out), out);
  out.x = (p.x - out.x) / TICK_DT;
  out.y = (p.y - out.y) / TICK_DT;
  out.z = (p.z - out.z) / TICK_DT;
  return out;
}

/** Strict AABB overlap of a box (grown by `margin`) with a record's world bounds. */
export function boxNearRec(b: AABB, r: StructRec, margin: number): boolean {
  return (
    b.minX - margin < r.maxX &&
    b.maxX + margin > r.minX &&
    b.minY - margin < r.maxY &&
    b.maxY + margin > r.minY &&
    b.minZ - margin < r.maxZ &&
    b.maxZ + margin > r.minZ
  );
}

export class StructureCache {
  /** Live, non-empty structures, innermost first (depth descending, then id ascending). */
  readonly recs: StructRec[] = [];
  private readonly byId = new Map<number, StructRec>();
  private readonly pool: StructRec[] = [];
  private readonly tmp: Vec3 = vec3();
  private readonly tmpQ: Quat = quat();

  get(id: number): StructRec | undefined {
    return this.byId.get(id);
  }

  rebuild(structures: readonly Structure[]): void {
    const recs = this.recs;
    recs.length = 0;
    this.byId.clear();
    let used = 0;
    for (let i = 0; i < structures.length; i++) {
      const s = structures[i]!;
      if (s.removed) continue;
      const b = s.grid.cellBounds();
      if (b === null) continue;
      let r = this.pool[used];
      if (r === undefined) {
        r = new StructRec();
        this.pool.push(r);
      }
      used++;
      r.structure = s;
      r.grid = s.grid;
      r.id = s.id;
      r.ship = s.kind === 'ship' ? (s as Ship) : null;
      r.parent = null;
      let depth = 0;
      for (let p = s.parent; p !== null && depth < 8; p = p.parent) depth++;
      r.depth = depth;
      s.grid.renderPose(0, r.p0, r.q0);
      s.grid.renderPose(1, r.p1, r.q1);
      r.pivot.x = s.grid.pivot.x;
      r.pivot.y = s.grid.pivot.y;
      r.pivot.z = s.grid.pivot.z;
      r.moved =
        r.p0.x !== r.p1.x ||
        r.p0.y !== r.p1.y ||
        r.p0.z !== r.p1.z ||
        r.q0.x !== r.q1.x ||
        r.q0.y !== r.q1.y ||
        r.q0.z !== r.q1.z ||
        r.q0.w !== r.q1.w;
      // Twist about world Y of the rotation delta (swing-twist decomposition). Unlike the
      // heading of local -Z it stays ~0 for a windmill turning about a horizontal axis.
      const dq = qmul(r.q1, qconj(r.q0, this.tmpQ), this.tmpQ);
      r.dyaw = r.moved ? wrapAngle(2 * Math.atan2(dq.y, dq.w)) : 0;
      this.bounds(r, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
      recs.push(r);
      this.byId.set(r.id, r);
    }
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i]!;
      const p = r.structure.parent;
      if (p !== null) r.parent = this.byId.get(p.id) ?? null;
    }
    recs.sort((a, b) => b.depth - a.depth || a.id - b.id);
  }

  private bounds(r: StructRec, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    const t = this.tmp;
    for (let c = 0; c < 8; c++) {
      t.x = c & 1 ? x1 : x0;
      t.y = c & 2 ? y1 : y0;
      t.z = c & 4 ? z1 : z0;
      curToWorld(r, t, t);
      if (t.x < minX) minX = t.x;
      if (t.y < minY) minY = t.y;
      if (t.z < minZ) minZ = t.z;
      if (t.x > maxX) maxX = t.x;
      if (t.y > maxY) maxY = t.y;
      if (t.z > maxZ) maxZ = t.z;
    }
    // A hair of slack: the transformed corners carry rounding error.
    const e = 1e-6;
    r.minX = minX - e;
    r.minY = minY - e;
    r.minZ = minZ - e;
    r.maxX = maxX + e;
    r.maxY = maxY + e;
    r.maxZ = maxZ + e;
  }

  /** Records whose bounds come within `margin` of the box, innermost first. Reuses `out`. */
  near(b: AABB, margin: number, out: StructRec[]): StructRec[] {
    out.length = 0;
    const recs = this.recs;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i]!;
      if (boxNearRec(b, r, margin)) out.push(r);
    }
    return out;
  }
}
