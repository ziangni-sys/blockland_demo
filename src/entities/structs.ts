/**
 * Per-tick view of the structures as the entities see them: world bounds, the current pose,
 * and two earlier poses:
 *
 *  - the VELOCITY base (p0 / q0 / pivot0): the pose at the end of the previous entity tick
 *    (committed by EntityManager.update()). pointVelocity(), `moved` and `dyaw` measure the
 *    motion from it, so every query in a tick sees the structure's real velocity over that tick.
 *  - the CARRY base (c0 / cq0 / cpivot0): the pose at the previous carry (the previous
 *    syncCarried()). carryPoint() and `carryDyaw` move riders from it to the current pose, so a
 *    second syncCarried() in the same tick, or one between two ticks (LESSONS 打开界面：把被携带
 *    的玩家同步到结构体当前位置), carries only motion that really happened since the last carry:
 *    nothing is carried twice and nothing is lost.
 *
 * Both bases are poses THIS CACHE remembered, not the grid's own prevPosition / prevRotation:
 * riders then follow exactly the motion that happened between two entity ticks even if some
 * structure skipped snapshotPose() (a sleeping ship), entity ticks were skipped, or a pose was
 * nudged with setPoseImmediate(). A structure seen for the first time uses renderPose(0).
 *
 * Pose convention (StructureGrid.renderPose): world = p + rotate(q, local - pivot), with p / q
 * the composed WORLD pose (parents included). The current pose is renderPose(1).
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
  /** Velocity base: world pose (with its pivot) at the end of the previous entity tick. */
  readonly p0: Vec3 = vec3();
  readonly q0: Quat = quat();
  readonly pivot0: Vec3 = vec3();
  /** Carry base: world pose (with its pivot) at the previous carry. */
  readonly c0: Vec3 = vec3();
  readonly cq0: Quat = quat();
  readonly cpivot0: Vec3 = vec3();
  /** Current world pose. */
  readonly p1: Vec3 = vec3();
  readonly q1: Quat = quat();
  readonly pivot: Vec3 = vec3();
  /** The pose changed since the velocity base (it moves this tick). */
  moved = false;
  /** Heading change since the velocity base, about world +Y, radians, CCW from above. */
  dyaw = 0;
  /** The pose changed since the carry base (riders must be carried). */
  carryMoved = false;
  /** Heading change since the carry base (riders turn by it). */
  carryDyaw = 0;
  /** World direction of the structure's local +X projected on the horizontal plane, normalised
   *  (its heading; falls back to world +X for a structure standing on its side). */
  headX = 1;
  headZ = 0;
}

/** World point -> local point at the carry base. `out` may alias `p`. */
function carryBaseToLocal(r: StructRec, p: Vec3, out: Vec3): Vec3 {
  out.x = p.x - r.c0.x;
  out.y = p.y - r.c0.y;
  out.z = p.z - r.c0.z;
  qrotateInv(r.cq0, out, out);
  out.x += r.cpivot0.x;
  out.y += r.cpivot0.y;
  out.z += r.cpivot0.z;
  return out;
}
/** Local point -> world point at the velocity base. `out` may alias `l`. */
function velBaseToWorld(r: StructRec, l: Vec3, out: Vec3): Vec3 {
  out.x = l.x - r.pivot0.x;
  out.y = l.y - r.pivot0.y;
  out.z = l.z - r.pivot0.z;
  qrotate(r.q0, out, out);
  out.x += r.p0.x;
  out.y += r.p0.y;
  out.z += r.p0.z;
  return out;
}
/** World point -> local point at the current pose. `out` may alias `p`. */
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
/** Local point -> world point at the current pose. `out` may alias `l`. */
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
/** Where the structure's motion since the last carry takes a world point that moved with it. */
export function carryPoint(r: StructRec, p: Vec3, out: Vec3): Vec3 {
  return curToWorld(r, carryBaseToLocal(r, p, out), out);
}
/** World velocity (blocks/s) over this tick of the structure's material now at world point p. */
export function pointVelocity(r: StructRec, p: Vec3, out: Vec3): Vec3 {
  if (!r.moved) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  velBaseToWorld(r, curToLocal(r, p, out), out);
  out.x = (p.x - out.x) / TICK_DT;
  out.y = (p.y - out.y) / TICK_DT;
  out.z = (p.z - out.z) / TICK_DT;
  return out;
}

function copy3(out: Vec3, v: Vec3): void {
  out.x = v.x;
  out.y = v.y;
  out.z = v.z;
}
function copy4(out: Quat, q: Quat): void {
  out.x = q.x;
  out.y = q.y;
  out.z = q.z;
  out.w = q.w;
}
function samePose(pa: Vec3, qa: Quat, va: Vec3, pb: Vec3, qb: Quat, vb: Vec3): boolean {
  return (
    qa.x === qb.x &&
    qa.y === qb.y &&
    qa.z === qb.z &&
    qa.w === qb.w &&
    pa.x === pb.x &&
    pa.y === pb.y &&
    pa.z === pb.z &&
    va.x === vb.x &&
    va.y === vb.y &&
    va.z === vb.z
  );
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

/** A remembered world pose. */
class Pose {
  readonly p: Vec3 = vec3();
  readonly q: Quat = quat();
  readonly pivot: Vec3 = vec3();
}

/** What the cache remembers about one structure between rebuilds. */
class PoseSnap {
  /** Pose at the last carry (rebuild). */
  readonly carry = new Pose();
  /** Pose at the last commit (end of an entity tick). */
  readonly vel = new Pose();
  /** rebuild() generation that last saw the structure. */
  seen = 0;
}

export class StructureCache {
  /** Live, non-empty structures, innermost first (depth descending, then id ascending). */
  readonly recs: StructRec[] = [];
  private readonly byId = new Map<number, StructRec>();
  private readonly pool: StructRec[] = [];
  /** Remembered poses of every structure (see the file comment). */
  private readonly last = new Map<number, PoseSnap>();
  private generation = 0;
  private readonly tmp: Vec3 = vec3();
  private readonly tmpQ: Quat = quat();

  get(id: number): StructRec | undefined {
    return this.byId.get(id);
  }

  /** Forget the remembered poses of a structure (it was re-gridded: its riders were released). */
  forget(id: number): void {
    this.last.delete(id);
  }

  /** Forget everything (a new world / a loaded save). */
  reset(): void {
    this.last.clear();
    this.recs.length = 0;
    this.byId.clear();
  }

  /**
   * Read every structure's current pose. The carry base becomes the pose of the previous
   * rebuild; the velocity base stays at the last commit().
   */
  rebuild(structures: readonly Structure[]): void {
    const recs = this.recs;
    recs.length = 0;
    this.byId.clear();
    const gen = ++this.generation;
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
      s.grid.renderPose(1, r.p1, r.q1);
      copy3(r.pivot, s.grid.pivot);
      let snap = this.last.get(r.id);
      if (snap === undefined) {
        snap = new PoseSnap();
        s.grid.renderPose(0, snap.carry.p, snap.carry.q);
        copy3(snap.carry.pivot, r.pivot);
        copy3(snap.vel.p, snap.carry.p);
        copy4(snap.vel.q, snap.carry.q);
        copy3(snap.vel.pivot, r.pivot);
        this.last.set(r.id, snap);
      }
      copy3(r.p0, snap.vel.p);
      copy4(r.q0, snap.vel.q);
      copy3(r.pivot0, snap.vel.pivot);
      copy3(r.c0, snap.carry.p);
      copy4(r.cq0, snap.carry.q);
      copy3(r.cpivot0, snap.carry.pivot);
      copy3(snap.carry.p, r.p1);
      copy4(snap.carry.q, r.q1);
      copy3(snap.carry.pivot, r.pivot);
      snap.seen = gen;
      // Conservative: a pivot move (centre of mass changed) also counts, although no cell moved;
      // the transforms themselves are exact either way.
      r.moved = !samePose(r.p0, r.q0, r.pivot0, r.p1, r.q1, r.pivot);
      r.carryMoved = !samePose(r.c0, r.cq0, r.cpivot0, r.p1, r.q1, r.pivot);
      r.dyaw = r.moved ? this.twist(r.q1, r.q0) : 0;
      r.carryDyaw = r.carryMoved ? this.twist(r.q1, r.cq0) : 0;
      const hx = this.tmp;
      hx.x = 1;
      hx.y = 0;
      hx.z = 0;
      qrotate(r.q1, hx, hx);
      const hl = Math.sqrt(hx.x * hx.x + hx.z * hx.z);
      if (hl > 1e-6) {
        r.headX = hx.x / hl;
        r.headZ = hx.z / hl;
      } else {
        r.headX = 1;
        r.headZ = 0;
      }
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
    // Drop poses of structures that are gone (ids are never reused within a world).
    if (this.last.size > recs.length) {
      for (const [id, snap] of this.last) if (snap.seen !== gen) this.last.delete(id);
    }
  }

  /** End of an entity tick: the current poses become the velocity base of the next tick. */
  commit(): void {
    const recs = this.recs;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i]!;
      const snap = this.last.get(r.id);
      if (snap === undefined) continue; // forgotten (released) during the tick
      copy3(snap.vel.p, r.p1);
      copy4(snap.vel.q, r.q1);
      copy3(snap.vel.pivot, r.pivot);
    }
  }

  /** Twist about world Y of q1 * q0^-1 (swing-twist decomposition). Unlike the heading of local
   *  -Z it stays ~0 for a windmill turning about a horizontal axis. */
  private twist(q1: Quat, q0: Quat): number {
    const dq = qmul(q1, qconj(q0, this.tmpQ), this.tmpQ);
    return wrapAngle(2 * Math.atan2(dq.y, dq.w));
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
