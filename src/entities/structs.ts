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
 * nudged with setPoseImmediate(). A structure seen for the first time during a tick uses its pose
 * at the start of the tick (renderPose(0)); one first seen BETWEEN ticks (rebuild(.., 'now'): a
 * correction raised before the first tick after a load) uses its pose now, the end of the last
 * tick: renderPose(0) is then the start of a tick that already ended, and the next tick would
 * measure two ticks of motion as one (twice the carrier's velocity).
 *
 * Pose convention (StructureGrid.renderPose): world = p + rotate(q, local - pivot), with p / q
 * the composed WORLD pose (parents included). The current pose is renderPose(1). The cache reads
 * both with readWorldPose(), the same arithmetic without allocating.
 */
import { TICK_DT } from '../core/constants';
import { qconj, qmul, qrotate, qrotateInv, qslerp, quat, vec3, wrapAngle, type AABB, type Quat, type Vec3 } from '../core/math';
import type { HullInfo } from '../structures/hull';
import type { CellBounds } from '../voxel/grid';
import { solidFillAt } from '../voxel/parts';
import { StructureGrid } from '../voxel/sgrid';

/**
 * A structure as moving bodies see it: its cells and pose (the grid), what it is mounted on, and
 * for a ship its dry-volume analysis. The simulation's Ship and Rotor are BodyStructures; so is a
 * client's replica of them.
 */
export interface BodyStructure {
  readonly id: number;
  readonly grid: StructureGrid;
  readonly parent: BodyStructure | null;
  /** Structures mounted on it. */
  readonly children: readonly BodyStructure[];
  readonly removed: boolean;
  /** A ship's hull analysis (water inside its dry cells does not wet a body); absent or null otherwise. */
  readonly hull?: HullInfo | null;
}

export class StructRec {
  structure!: BodyStructure;
  grid!: StructureGrid;
  id = 0;
  /** StructureCache generation that filled the record (a record of an older one is stale). */
  gen = 0;
  /** Nesting depth: 0 = mounted on the world, 1 = mounted on a ship ... */
  depth = 0;
  /** The structure's hull analysis (ships), else null. */
  hull: HullInfo | null = null;
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

/** Heading of a world rotation: its twist about world +Y (radians, CCW from above). */
export function headingOf(q: Quat): number {
  return wrapAngle(2 * Math.atan2(q.y, q.w));
}

/**
 * The composed WORLD pose of a grid at blend `alpha` (0 = start of the tick, 1 = now) into outP /
 * outQ: exactly the arithmetic of StructureGrid.renderPose (same operations in the same order, so
 * the same bits), without allocating. `chain` is caller-owned scratch.
 */
function readWorldPose(grid: StructureGrid, alpha: number, outP: Vec3, outQ: Quat, chain: StructureGrid[], rel: Vec3, r: Quat): void {
  // `chain` is written by index, never emptied: V8 releases an array's storage on length = 0.
  let n = 0;
  let g: StructureGrid = grid;
  chain[n++] = g;
  for (let guard = 0; guard < 8; guard++) {
    const par = g.parent;
    if (par.isWorld || !(par instanceof StructureGrid)) break;
    g = par;
    chain[n++] = g;
  }
  let top = chain[n - 1]!;
  outP.x = top.prevPosition.x + (top.position.x - top.prevPosition.x) * alpha;
  outP.y = top.prevPosition.y + (top.position.y - top.prevPosition.y) * alpha;
  outP.z = top.prevPosition.z + (top.position.z - top.prevPosition.z) * alpha;
  qslerp(top.prevRotation, top.rotation, alpha, outQ);
  for (let i = n - 2; i >= 0; i--) {
    const c = chain[i]!;
    rel.x = c.prevPosition.x + (c.position.x - c.prevPosition.x) * alpha - top.pivot.x;
    rel.y = c.prevPosition.y + (c.position.y - c.prevPosition.y) * alpha - top.pivot.y;
    rel.z = c.prevPosition.z + (c.position.z - c.prevPosition.z) * alpha - top.pivot.z;
    qslerp(c.prevRotation, c.rotation, alpha, r);
    qrotate(outQ, rel, rel);
    outP.x += rel.x;
    outP.y += rel.y;
    outP.z += rel.z;
    qmul(outQ, r, outQ);
    top = c;
  }
}

/**
 * Innermost first: depth descending, then id ascending. An insertion sort (no comparator closure,
 * no work array; the list is short and keeps its order from tick to tick, so it is nearly sorted).
 */
function sortInnermostFirst(recs: StructRec[]): void {
  for (let i = 1; i < recs.length; i++) {
    const r = recs[i]!;
    let j = i - 1;
    while (j >= 0 && (recs[j]!.depth < r.depth || (recs[j]!.depth === r.depth && recs[j]!.id > r.id))) {
      recs[j + 1] = recs[j]!;
      j--;
    }
    recs[j + 1] = r;
  }
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
  /** trimOf(): the grid and grid version it was computed for, and the result (boundsTrim bits). */
  trimGrid: StructureGrid | null = null;
  trimVersion = -1;
  trim = 0;
}

/**
 * Faces of a structure's cell bounds whose outer half holds nothing (trimOf). Bit order follows
 * the faces -X, +X, -Y, +Y, -Z, +Z; the octants of a cell on each face's outer half are HALF_OF.
 */
const HALF_OF = Uint8Array.of(0x55, 0xaa, 0x33, 0xcc, 0x0f, 0xf0);

/**
 * Which faces of the cell bounds `b` of `grid` can be pulled in half a cell: every cell on that
 * face's boundary layer is air or a solid cell whose outer half is empty (a deck of lower half
 * slabs: its top is at y + 0.5, not y + 1). A soft cell (a torch) keeps the face where it is. Only
 * a grid with holes or second parts can have such faces. Bits as HALF_OF.
 */
function boundsTrim(grid: StructureGrid, b: CellBounds): number {
  let trim = 0;
  for (let f = 0; f < 6; f++) {
    const a = f >> 1;
    // The boundary layer of face f, and the ranges of the other two axes.
    const layer = (f & 1) === 0 ? (a === 0 ? b.minX : a === 1 ? b.minY : b.minZ) : (a === 0 ? b.maxX : a === 1 ? b.maxY : b.maxZ) - 1;
    const u0 = a === 0 ? b.minY : b.minX;
    const u1 = a === 0 ? b.maxY : b.maxX;
    const v0 = a === 2 ? b.minY : b.minZ;
    const v1 = a === 2 ? b.maxY : b.maxZ;
    const half = HALF_OF[f]!;
    let open = true;
    for (let u = u0; u < u1 && open; u++) {
      for (let v = v0; v < v1; v++) {
        const x = a === 0 ? layer : u;
        const y = a === 1 ? layer : a === 0 ? u : v;
        const z = a === 2 ? layer : v;
        if (grid.getCell(x, y, z) === 0) continue;
        const fill = solidFillAt(grid, x, y, z);
        if (fill === 0 || (fill & half) !== 0) {
          open = false;
          break;
        }
      }
    }
    if (open) trim |= 1 << f;
  }
  return trim;
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
  private readonly poseChain: StructureGrid[] = [];
  private readonly poseRel: Vec3 = vec3();
  private readonly poseQ: Quat = quat();

  get(id: number): StructRec | undefined {
    const r = this.byId.get(id);
    return r !== undefined && r.gen === this.generation && r.id === id ? r : undefined;
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
    this.generation++;
  }

  /**
   * Read every structure's current pose. The carry base becomes the pose of the previous
   * rebuild; the velocity base stays at the last commit().
   *
   * Allocates nothing in the steady state: records are pooled, the id map keeps its entries
   * (get() checks the generation), arrays are written by index (V8 releases an array's storage
   * on length = 0, and the next push allocates a new one).
   */
  rebuild(structures: readonly BodyStructure[], firstSeen: 'tickStart' | 'now' = 'tickStart'): void {
    const recs = this.recs;
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
      r.gen = gen;
      r.hull = s.hull ?? null;
      r.parent = null;
      let depth = 0;
      for (let p = s.parent; p !== null && depth < 8; p = p.parent) depth++;
      r.depth = depth;
      readWorldPose(s.grid, 1, r.p1, r.q1, this.poseChain, this.poseRel, this.poseQ);
      copy3(r.pivot, s.grid.pivot);
      let snap = this.last.get(r.id);
      if (snap === undefined) {
        snap = new PoseSnap();
        readWorldPose(s.grid, firstSeen === 'now' ? 1 : 0, snap.carry.p, snap.carry.q, this.poseChain, this.poseRel, this.poseQ);
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
      this.bounds(r, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, this.trimOf(snap, s.grid, b));
      if (used - 1 < recs.length) recs[used - 1] = r;
      else recs.push(r);
      if (this.byId.get(r.id) !== r) this.byId.set(r.id, r);
    }
    if (recs.length !== used) recs.length = used;
    for (let i = 0; i < used; i++) {
      const r = recs[i]!;
      const p = r.structure.parent;
      if (p !== null) r.parent = this.get(p.id) ?? null;
    }
    sortInnermostFirst(recs);
    // Drop poses (and id entries) of structures that are gone (ids are never reused within a world).
    if (this.last.size > used) {
      for (const [id, snap] of this.last) {
        if (snap.seen === gen) continue;
        this.last.delete(id);
        if (this.get(id) === undefined) this.byId.delete(id);
      }
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

  /**
   * boundsTrim() of a structure, recomputed only when its grid changed (the faces of its cell
   * bounds scanned once per edit; a grid without holes or second-part layers has none to trim).
   */
  private trimOf(snap: PoseSnap, grid: StructureGrid, b: CellBounds): number {
    if (!grid.layered) return 0;
    if (snap.trimGrid !== grid || snap.trimVersion !== grid.version) {
      snap.trimGrid = grid;
      snap.trimVersion = grid.version;
      snap.trim = boundsTrim(grid, b);
    }
    return snap.trim;
  }

  /**
   * The world box of a structure's local cell bounds at its current pose. `trim` (boundsTrim bits)
   * pulls faces in half a cell: the box bounds the structure's solid octants on the half-cell
   * lattice, so a body standing on a deck of lower half slabs is not inside it (as a body on a
   * deck of whole blocks is not), and the queries a body inside it asks every tick are skipped.
   */
  private bounds(r: StructRec, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, trim: number): void {
    // (Integers in, fractions made here: a fraction passed to a call that is not inlined is boxed.)
    const lx = (trim & 1) !== 0 ? x0 + 0.5 : x0;
    const hx = (trim & 2) !== 0 ? x1 - 0.5 : x1;
    const ly = (trim & 4) !== 0 ? y0 + 0.5 : y0;
    const hy = (trim & 8) !== 0 ? y1 - 0.5 : y1;
    const lz = (trim & 16) !== 0 ? z0 + 0.5 : z0;
    const hz = (trim & 32) !== 0 ? z1 - 0.5 : z1;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    const t = this.tmp;
    for (let c = 0; c < 8; c++) {
      t.x = c & 1 ? hx : lx;
      t.y = c & 2 ? hy : ly;
      t.z = c & 4 ? hz : lz;
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

  /** Records whose bounds come within `margin` of the box, innermost first. Reuses `out` (written by index, see rebuild()). */
  near(b: AABB, margin: number, out: StructRec[]): StructRec[] {
    const recs = this.recs;
    let n = 0;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i]!;
      if (!boxNearRec(b, r, margin)) continue;
      if (n < out.length) out[n] = r;
      else out.push(r);
      n++;
    }
    if (out.length !== n) out.length = n;
    return out;
  }
}
