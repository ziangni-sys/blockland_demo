/**
 * Moving one entity body through the world and around structures (steps b–d of the entity
 * pipeline). Every collision query goes through the voxel query module (voxel/shape.ts) with
 * the one body box (Entity.box()); see constants.ts for the probe definitions.
 *
 * Priorities (docs/DESIGN.md 对象模型): hard blocks > structures > entities.
 *  - The entity's OWN motion is swept exactly against the world: it can never walk into a
 *    world block, whatever its carrier does (LESSONS 在船上贴墙走被判挤伤). A body on the
 *    ground steps up onto a world ledge of at most STEP_HEIGHT (a deck floating a little below
 *    a pier).
 *  - Structures then push the body out of their solid cells, one axis at a time; an axis that
 *    would put the body NEWLY into the world or into ANOTHER structure is not applied
 *    (LESSONS 被风车沿船舷推时误判挤伤) — except that dipping into another structure's FLOOR
 *    (a deck that rolls a little) lifts the body onto it instead.
 *  - If a structure still overlaps the body and the body did not overlap it before its own
 *    motion, the body walked into it by itself: that motion is taken back axis by axis.
 *    Only an overlap that remains although the body did not move into it is a crush.
 *
 * All scratch state lives on the instance (no module-level temporaries).
 */
import { SOLID } from '../blocks/registry';
import { ID_MASK } from '../blocks/cell';
import { aabb, qrotateInv, vec3, type AABB, type Vec3 } from '../core/math';
import { boxOverlapsSolid, CONTACT_EPS, deepestPenetration, hasSupportBelow, sweepAxis, type PushOptions } from '../voxel/shape';
import type { World } from '../voxel/world';
import {
  ATTACH_INSET,
  ATTACH_INSET_MAX_FRACTION,
  GROUND_NORMAL_Y,
  MAX_PUSH_ITERATIONS,
  MAX_PUSH_LIFT,
  MAX_SUBSTEP,
  MAX_SUBSTEPS,
  MIN_PUSH_PROJECTION_SQ,
  PREFER_MIN_DEPTH,
  PREFER_MIN_SPEED,
  PREFER_WEIGHT,
  PUSH_SKIN,
  SNEAK_DISK_MARGIN,
  SNEAK_LADDER_STEP,
  SNEAK_PROBE_DEPTH,
  SNEAK_STEP,
  STEP_HEIGHT,
} from './constants';
import type { Entity } from './entity';
import { boxNearRec, curToLocal, pointVelocity, type StructRec } from './structs';

/** Footprint inset of the attach / column probes for this body (always > 0, < half width). */
export function attachInset(e: Entity): number {
  const cap = e.halfWidth * ATTACH_INSET_MAX_FRACTION;
  return ATTACH_INSET < cap ? ATTACH_INSET : cap;
}

/** Body box of `e` if its feet were at (x, y, z). */
export function boxAt(e: Entity, x: number, y: number, z: number, out: AABB): AABB {
  const hw = e.halfWidth;
  out.minX = x - hw;
  out.minY = y;
  out.minZ = z - hw;
  out.maxX = x + hw;
  out.maxY = y + e.height;
  out.maxZ = z + hw;
  return out;
}

function translateAxis(b: AABB, axis: number, d: number): void {
  if (axis === 0) {
    b.minX += d;
    b.maxX += d;
  } else if (axis === 1) {
    b.minY += d;
    b.maxY += d;
  } else {
    b.minZ += d;
    b.maxZ += d;
  }
}

function copyBox(src: AABB, out: AABB): AABB {
  out.minX = src.minX;
  out.minY = src.minY;
  out.minZ = src.minZ;
  out.maxX = src.maxX;
  out.maxY = src.maxY;
  out.maxZ = src.maxZ;
  return out;
}

const AXIS_BIT = [1, 2, 4] as const;

/**
 * Sneak-guard disk: point probes as fractions of the disk radius, interleaved (x, z) pairs.
 * The centre first, then the rim (where an edge is found first), then two inner rings so a
 * thin support (a one-cell rail) inside the disk is not missed. Immutable lookup table.
 */
const DISK_PATTERN: readonly number[] = Object.freeze(
  (() => {
    const out: number[] = [0, 0];
    const rings: Array<[number, number, number]> = [
      [1, 16, 0],
      [2 / 3, 12, 0.5],
      [1 / 3, 6, 0.25],
    ];
    for (const [f, n, phase] of rings) {
      for (let i = 0; i < n; i++) {
        const a = ((i + phase) * 2 * Math.PI) / n;
        out.push(f * Math.cos(a), f * Math.sin(a));
      }
    }
    return out;
  })(),
);
/** Vertical sample spacing of a point probe through a structure's cells. */
const POINT_PROBE_STEP = 0.1;

export class Mover {
  /** Structures near the current entity, innermost first. Filled by the manager before move(). */
  readonly near: StructRec[] = [];

  // ---- results of the last move()
  /** A downward world sweep was stopped (or a step-up landed): standing on a world block. */
  onWorldGround = false;
  /** Innermost structure that gave ground support (a push with normal.y > GROUND_NORMAL_Y), or null. */
  groundRec: StructRec | null = null;
  /** A horizontal move was stopped by the world. */
  collidedH = false;
  /** Horizontal contact normal of the WORLD walls that stopped the body (0,0 = none). */
  contactNx = 0;
  contactNz = 0;
  /** The structure pushes of this move were blocked somewhere (diagnostics / tests). */
  pushBlocked = false;

  private readonly world: World;
  // per sub-step
  private blockedX = false;
  private blockedY = false;
  private blockedZ = false;
  private movedX = 0;
  private movedY = 0;
  private movedZ = 0;
  private groundStep = false;
  private ceilingStep = false;
  /** The body may step up onto world ledges in this move (it walks and stood on something). */
  private canStep = false;
  /** overlapRec holds the overlap state of the body as it is now (set by revertOwnMotion). */
  private overlapValid = false;
  private overlapRec: StructRec | null = null;
  /** Structure whose floor the last applyPush() lifted the body onto, or null. */
  private liftRec: StructRec | null = null;
  // sneak guard output
  private clipX = 0;
  private clipZ = 0;
  // scratch
  private readonly box: AABB = aabb();
  private readonly box0: AABB = aabb();
  private readonly tb: AABB = aabb();
  private readonly sb: AABB = aabb();
  private readonly cand: AABB = aabb();
  private readonly startBox: AABB = aabb();
  private readonly v: Vec3 = vec3();
  private readonly c: Vec3 = vec3();
  private readonly lp: Vec3 = vec3();
  private readonly ld: Vec3 = vec3();
  private readonly prefer: Vec3 = vec3();
  private readonly opts: PushOptions = { prefer: this.prefer, preferWeight: PREFER_WEIGHT };
  /** Per near index: did the body overlap it before the current push / at the sub-step start? -1 unknown. */
  private beforeOverlap = new Int8Array(16);
  private startOverlap = new Int8Array(16);

  constructor(world: World) {
    this.world = world;
  }

  /**
   * Move `e` by its own displacement (dx, dy, dz) this tick. `rel` is its velocity relative to
   * its carrier (world axes); blocked components are cancelled in it. With `sneakGuard` the
   * horizontal displacement is first shortened so the body keeps standing. With `walker` a body
   * that stands on something steps up onto world ledges of at most STEP_HEIGHT.
   */
  move(e: Entity, rel: Vec3, dx: number, dy: number, dz: number, sneakGuard: boolean, walker: boolean): void {
    this.onWorldGround = false;
    this.groundRec = null;
    this.collidedH = false;
    this.contactNx = 0;
    this.contactNz = 0;
    this.pushBlocked = false;
    this.overlapValid = false;
    const n = this.near.length;
    if (this.beforeOverlap.length < n) {
      this.beforeOverlap = new Int8Array(n * 2);
      this.startOverlap = new Int8Array(n * 2);
    }
    if (sneakGuard && (dx !== 0 || dz !== 0)) {
      this.clipSneak(e, dx, dz);
      dx = this.clipX;
      dz = this.clipZ;
    }
    const wasOnGround = e.onGround;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let steps = len > MAX_SUBSTEP ? Math.ceil(len / MAX_SUBSTEP) : 1;
    if (steps > MAX_SUBSTEPS) steps = MAX_SUBSTEPS;
    let sx = dx / steps;
    let sy = dy / steps;
    let sz = dz / steps;
    for (let i = 0; i < steps; i++) {
      if (n === 0 && sx === 0 && sy === 0 && sz === 0) break;
      const ax = e.pos.x;
      const ay = e.pos.y;
      const az = e.pos.z;
      this.groundStep = false;
      this.ceilingStep = false;
      this.overlapValid = false;
      this.sweepWorldY(e, rel, sy);
      // Structure support BEFORE the horizontal sweeps: the vertical step may have sunk the
      // feet a little into a deck, and a world block level with that deck (a pier) must not
      // turn into a wall for those few hundredths of a block.
      const resolvedY = n !== 0 && this.movedY !== 0;
      if (resolvedY) this.resolveStructures(e, rel);
      // Only a body that stands on something steps up (never a falling or rising one).
      this.canStep = walker && (wasOnGround || this.onWorldGround || this.groundStep) && rel.y <= 0;
      this.sweepWorldXZ(e, rel, sx, sz);
      if (this.blockedX) sx = 0;
      if (this.blockedY) sy = 0;
      if (this.blockedZ) sz = 0;
      if (n === 0) continue;
      // A second pass only when something can have changed since the first (it is the
      // structure queries that cost, so none is issued without a reason).
      if (!resolvedY || this.movedX !== 0 || this.movedZ !== 0) this.resolveStructures(e, rel);
      if (this.groundStep && sy < 0) sy = 0;
      if (this.ceilingStep && sy > 0) sy = 0;
      const reverted = this.revertOwnMotion(e, rel, ax, ay, az);
      if (reverted & 1) sx = 0;
      if (reverted & 2) sy = 0;
      if (reverted & 4) sz = 0;
    }
  }

  /**
   * First near structure whose solid cells still overlap the body, or null. Right after
   * move() this reuses the overlap scan of its last sub-step.
   */
  findOverlap(e: Entity): StructRec | null {
    if (this.overlapValid) return this.overlapRec;
    const b = e.box(this.box);
    const near = this.near;
    for (let k = 0; k < near.length; k++) {
      const r = near[k]!;
      if (boxNearRec(b, r, 0) && boxOverlapsSolid(r.grid, b)) return r;
    }
    return null;
  }

  /** Does the body overlap a solid world block? */
  inWorldBlock(e: Entity): boolean {
    return boxOverlapsSolid(this.world, e.box(this.box));
  }

  /** Is the box (with feet probe of `depth`, footprint inset) supported by the world or a near structure? */
  supported(b: AABB, depth: number, inset: number): boolean {
    if (hasSupportBelow(this.world, b, depth, inset)) return true;
    const near = this.near;
    for (let k = 0; k < near.length; k++) {
      const r = near[k]!;
      if (b.minX < r.maxX && b.maxX > r.minX && b.minZ < r.maxZ && b.maxZ > r.minZ && b.minY - depth < r.maxY && b.minY > r.minY) {
        if (hasSupportBelow(r.grid, b, depth, inset)) return true;
      }
    }
    return false;
  }

  /** Is the box supported (probe of `depth`, `inset`) by a near STRUCTURE (the world is not asked)? */
  supportedByStructure(b: AABB, depth: number, inset: number): boolean {
    const near = this.near;
    for (let k = 0; k < near.length; k++) {
      const r = near[k]!;
      if (b.minX < r.maxX && b.maxX > r.minX && b.minZ < r.maxZ && b.maxZ > r.minZ && b.minY - depth < r.maxY && b.minY > r.minY) {
        if (hasSupportBelow(r.grid, b, depth, inset)) return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------ b. world

  private sweepWorldY(e: Entity, rel: Vec3, dy: number): void {
    this.blockedY = false;
    this.movedY = 0;
    if (dy === 0) return;
    const b = e.box(this.box);
    const m = sweepAxis(this.world, b, 1, dy);
    if (m !== dy) {
      this.blockedY = true;
      if (dy < 0) this.onWorldGround = true;
      // World blocks are static: the WORLD velocity along the blocked axis becomes 0.
      rel.y = -e.carrierVel.y;
    }
    e.pos.y += m;
    this.movedY = m;
  }

  /** Horizontal world sweeps of `b` (larger component first). Returns a bit mask of the blocked axes (1 x, 4 z). */
  private sweepXZ(b: AABB, dx: number, dz: number): number {
    const world = this.world;
    let blocked = 0;
    this.movedX = 0;
    this.movedZ = 0;
    // Larger horizontal component first: moving the minor axis first is what snags corners.
    const xFirst = Math.abs(dx) >= Math.abs(dz);
    for (let k = 0; k < 2; k++) {
      const axis = (k === 0) === xFirst ? 0 : 2;
      const d = axis === 0 ? dx : dz;
      if (d === 0) continue;
      const m = sweepAxis(world, b, axis as 0 | 2, d);
      if (m !== d) blocked |= AXIS_BIT[axis as 0 | 2];
      translateAxis(b, axis, m);
      if (axis === 0) this.movedX = m;
      else this.movedZ = m;
    }
    return blocked;
  }

  private sweepWorldXZ(e: Entity, rel: Vec3, dx: number, dz: number): void {
    this.blockedX = false;
    this.blockedZ = false;
    if (dx === 0 && dz === 0) {
      this.movedX = 0;
      this.movedZ = 0;
      return;
    }
    const b = e.box(this.box);
    let blocked = this.sweepXZ(b, dx, dz);
    if (blocked !== 0 && this.canStep) blocked = this.tryStepUp(e, rel, dx, dz, blocked);
    else {
      e.pos.x += this.movedX;
      e.pos.z += this.movedZ;
    }
    if (blocked & 1) {
      this.collidedH = true;
      this.blockedX = true;
      this.contactNx = dx > 0 ? -1 : 1;
      rel.x = -e.carrierVel.x;
    }
    if (blocked & 4) {
      this.collidedH = true;
      this.blockedZ = true;
      this.contactNz = dz > 0 ? -1 : 1;
      rel.z = -e.carrierVel.z;
    }
  }

  /**
   * The plain horizontal sweep (movedX / movedZ, `blocked`) was stopped: retry it lifted by up
   * to STEP_HEIGHT and settle back down. The stepped move wins when it gets farther; landing on
   * a world block then counts as standing on the world (a deck walked off onto a pier detaches).
   * Applies the chosen move to e.pos and returns its blocked axes.
   */
  private tryStepUp(e: Entity, rel: Vec3, dx: number, dz: number, blocked: number): number {
    const plainX = this.movedX;
    const plainZ = this.movedZ;
    const world = this.world;
    const tb = e.box(this.tb);
    const up = sweepAxis(world, tb, 1, STEP_HEIGHT);
    if (up > 1e-6) {
      translateAxis(tb, 1, up);
      const stepBlocked = this.sweepXZ(tb, dx, dz);
      const sx = this.movedX;
      const sz = this.movedZ;
      if (sx * sx + sz * sz > plainX * plainX + plainZ * plainZ + 1e-12) {
        const down = sweepAxis(world, tb, 1, -up);
        translateAxis(tb, 1, down);
        e.pos.x += sx;
        e.pos.z += sz;
        // The box's own minY: exactly the ledge top when it landed (no accumulated rounding).
        const dyStep = tb.minY - e.pos.y;
        e.pos.y = tb.minY;
        this.movedY += dyStep;
        if (down !== -up) {
          this.onWorldGround = true;
          rel.y = -e.carrierVel.y;
        }
        return stepBlocked;
      }
    }
    this.movedX = plainX;
    this.movedZ = plainZ;
    e.pos.x += plainX;
    e.pos.z += plainZ;
    return blocked;
  }

  // ------------------------------------------------------------ c. structures

  private resolveStructures(e: Entity, rel: Vec3): void {
    const near = this.near;
    // A second pass settles pushes that moved the body into ANOTHER structure's reach.
    const passes = near.length > 1 ? 2 : 1;
    for (let pass = 0; pass < passes; pass++) {
      let moved = false;
      for (let k = 0; k < near.length; k++) {
        const r = near[k]!;
        for (let it = 0; it < MAX_PUSH_ITERATIONS; it++) {
          const b = e.box(this.box);
          if (!boxNearRec(b, r, 0)) break;
          let pen = deepestPenetration(r.grid, b);
          if (pen === null || !(pen.depth > 0)) break;
          if (pen.depth >= PREFER_MIN_DEPTH) {
            // Deep intrusion: lean toward the structure's motion so the body ends up in front
            // of a fast blade, not behind it.
            const opts = this.preferFor(e, rel, r, b);
            if (opts !== undefined) pen = deepestPenetration(r.grid, b, opts) ?? pen;
          }
          const nx = pen.nx;
          const ny = pen.ny;
          const nz = pen.nz;
          let kind: 0 | 1 | 2 = 0;
          let mask: number;
          if (ny > GROUND_NORMAL_Y) {
            // Ground: a pure vertical correction (depth / ny), so a tilted or rotated deck
            // never slides the body sideways.
            kind = 1;
            mask = 2;
          } else if (ny < -GROUND_NORMAL_Y) {
            kind = 2;
            mask = 2;
          } else {
            mask = (Math.abs(nx) > 1e-9 ? 1 : 0) | (Math.abs(ny) > 1e-9 ? 2 : 0) | (Math.abs(nz) > 1e-9 ? 4 : 0);
          }
          if (!this.applyPush(e, r, nx, ny, nz, pen.depth, mask)) {
            this.pushBlocked = true;
            break;
          }
          moved = true;
          if (kind === 1) {
            this.cancelInto(e, rel, r, 0, 1, 0);
            this.groundStep = true;
            if (this.groundRec === null) this.groundRec = r;
          } else if (kind === 2) {
            this.cancelInto(e, rel, r, 0, -1, 0);
            this.ceilingStep = true;
          } else {
            this.cancelInto(e, rel, r, nx, ny, nz);
          }
          const lr = this.liftRec;
          if (lr !== null) {
            // The push lifted the body onto another structure's floor: it stands on it.
            this.cancelInto(e, rel, lr, 0, 1, 0);
            this.groundStep = true;
            if (this.groundRec === null) this.groundRec = lr;
          }
        }
      }
      if (!moved) break;
    }
  }

  /**
   * Push along normal n by `depth`, using only the axes in `mask`. The allowed part of n is
   * rescaled so the face is still cleared (an axis that is refused does not shrink the push
   * into an endless series of ever smaller steps). Axes are tried largest first; one that
   * would put the body newly into the world or another structure is dropped and the push is
   * recomputed without it. Returns false when no admissible push remains. Sets liftRec when the
   * push also lifted the body onto another structure's floor (see admitOthers).
   */
  private applyPush(e: Entity, r: StructRec, nx: number, ny: number, nz: number, depth: number, mask: number): boolean {
    this.liftRec = null;
    const b0 = e.box(this.box0);
    this.beforeOverlap.fill(-1, 0, this.near.length);
    const world = this.world;
    const tb = this.tb;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ax = mask & 1 ? nx : 0;
      const ay = mask & 2 ? ny : 0;
      const az = mask & 4 ? nz : 0;
      const nA2 = ax * ax + ay * ay + az * az;
      if (nA2 < MIN_PUSH_PROJECTION_SQ) return false;
      const s = (depth + PUSH_SKIN) / nA2;
      const tx = ax * s;
      const ty = ay * s;
      const tz = az * s;
      copyBox(b0, tb);
      // Largest component first.
      const mx = Math.abs(tx);
      const my = Math.abs(ty);
      const mz = Math.abs(tz);
      let a0: number;
      let a1: number;
      let a2: number;
      if (mx >= my && mx >= mz) {
        a0 = 0;
        if (my >= mz) {
          a1 = 1;
          a2 = 2;
        } else {
          a1 = 2;
          a2 = 1;
        }
      } else if (my >= mz) {
        a0 = 1;
        if (mx >= mz) {
          a1 = 0;
          a2 = 2;
        } else {
          a1 = 2;
          a2 = 0;
        }
      } else {
        a0 = 2;
        if (mx >= my) {
          a1 = 0;
          a2 = 1;
        } else {
          a1 = 1;
          a2 = 0;
        }
      }
      let failed = -1;
      let lift = 0;
      this.liftRec = null;
      for (let i = 0; i < 3; i++) {
        const a = i === 0 ? a0 : i === 1 ? a1 : a2;
        const t = a === 0 ? tx : a === 1 ? ty : tz;
        if (t === 0) continue;
        const m = sweepAxis(world, tb, a as 0 | 1 | 2, t);
        if (m !== t) {
          failed = a;
          break;
        }
        translateAxis(tb, a, t);
        const l = this.admitOthers(tb, b0, r);
        if (l < 0) {
          failed = a;
          break;
        }
        lift += l;
      }
      if (failed < 0) {
        e.pos.x += tx;
        e.pos.y += ty + lift;
        e.pos.z += tz;
        return true;
      }
      mask &= ~AXIS_BIT[failed as 0 | 1 | 2];
      if (mask === 0) break;
    }
    this.liftRec = null;
    return false;
  }

  /**
   * The trial box `tb` of a push by structure r: does it newly overlap ANOTHER structure
   * (overlaps that existed before the push, in b0, do not count)? A shallow dip into another
   * structure's floor — the push slides the body along a deck that rolls or pitches a little —
   * is not a wall: tb is lifted onto that floor (a ground push, at most MAX_PUSH_LIFT, never into
   * the world). Returns the lift applied to tb (>= 0), or -1 when the box would newly enter
   * another structure. Without this a blade pushing a rider uphill along a gently rolling deck
   * was refused and judged a crush (review finding; DESIGN 实体被挤: only 推不动 is a crush).
   */
  private admitOthers(tb: AABB, b0: AABB, r: StructRec): number {
    let lift = 0;
    for (let guard = 0; guard < 3; guard++) {
      const o = this.newOverlap(tb, b0, r);
      if (o === null) return lift;
      const pen = deepestPenetration(o.grid, tb);
      if (pen === null || !(pen.ny > GROUND_NORMAL_Y)) return -1;
      const l = pen.depth / pen.ny + PUSH_SKIN;
      if (!(lift + l <= MAX_PUSH_LIFT)) return -1;
      if (sweepAxis(this.world, tb, 1, l) !== l) return -1;
      translateAxis(tb, 1, l);
      lift += l;
      if (this.liftRec === null) this.liftRec = o;
    }
    return this.newOverlap(tb, b0, r) === null ? lift : -1;
  }

  /** First structure other than r that tb overlaps although b0 did not, or null. */
  private newOverlap(tb: AABB, b0: AABB, r: StructRec): StructRec | null {
    const near = this.near;
    for (let j = 0; j < near.length; j++) {
      const o = near[j]!;
      if (o === r || !boxNearRec(tb, o, 0)) continue;
      if (!boxOverlapsSolid(o.grid, tb)) continue;
      let before = this.beforeOverlap[j]!;
      if (before < 0) {
        before = boxNearRec(b0, o, 0) && boxOverlapsSolid(o.grid, b0) ? 1 : 0;
        this.beforeOverlap[j] = before;
      }
      // An overlap that already existed before the push does not count.
      if (before === 0) return o;
    }
    return null;
  }

  /** Remove the part of the velocity relative to structure r that points into the surface (normal n). */
  private cancelInto(e: Entity, rel: Vec3, r: StructRec, nx: number, ny: number, nz: number): void {
    let vx: number;
    let vy: number;
    let vz: number;
    if (r.id === e.carrierId) {
      vx = rel.x;
      vy = rel.y;
      vz = rel.z;
    } else {
      const c = this.c;
      c.x = e.pos.x;
      c.y = e.pos.y + e.height * 0.5;
      c.z = e.pos.z;
      const sv = pointVelocity(r, c, this.v);
      vx = rel.x + e.carrierVel.x - sv.x;
      vy = rel.y + e.carrierVel.y - sv.y;
      vz = rel.z + e.carrierVel.z - sv.z;
    }
    const vn = vx * nx + vy * ny + vz * nz;
    if (vn < 0) {
      rel.x -= vn * nx;
      rel.y -= vn * ny;
      rel.z -= vn * nz;
    }
  }

  /** Push bias toward a structure's motion relative to the body (a blade sweeping into it). */
  private preferFor(e: Entity, rel: Vec3, r: StructRec, b: AABB): PushOptions | undefined {
    if (!r.moved || r.id === e.carrierId) return undefined;
    const c = this.c;
    c.x = (b.minX + b.maxX) * 0.5;
    c.y = (b.minY + b.maxY) * 0.5;
    c.z = (b.minZ + b.maxZ) * 0.5;
    const sv = pointVelocity(r, c, this.v);
    const vx = sv.x - rel.x - e.carrierVel.x;
    const vy = sv.y - rel.y - e.carrierVel.y;
    const vz = sv.z - rel.z - e.carrierVel.z;
    const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (!(sp >= PREFER_MIN_SPEED)) return undefined;
    this.prefer.x = vx / sp;
    this.prefer.y = vy / sp;
    this.prefer.z = vz / sp;
    return this.opts;
  }

  // ------------------------------------------------------------ own motion taken back

  /**
   * LESSONS 在船上贴墙走被判挤伤: "自己走进去的，就逐轴退回这一步". When a structure still
   * overlaps the body after the pushes but did NOT overlap it at the sub-step start (ax, ay, az),
   * the body's own motion caused the overlap: undo that motion axis by axis (x, then z, then
   * both, then all). Returns the reverted axes as a bit mask (1 x, 2 y, 4 z).
   */
  private revertOwnMotion(e: Entity, rel: Vec3, ax: number, ay: number, az: number): number {
    const mx = this.movedX;
    const my = this.movedY;
    const mz = this.movedZ;
    if (mx === 0 && my === 0 && mz === 0) return 0; // no own motion: any overlap is the structure's doing
    const near = this.near;
    this.startOverlap.fill(-1, 0, near.length);
    const b = e.box(this.box);
    let own = false;
    let first: StructRec | null = null;
    for (let k = 0; k < near.length; k++) {
      const r = near[k]!;
      if (!boxNearRec(b, r, 0) || !boxOverlapsSolid(r.grid, b)) continue;
      if (this.overlapAtStart(e, k, ax, ay, az) === 0) {
        own = true;
        break;
      }
      if (first === null) first = r;
    }
    if (!own) {
      // Every remaining overlap was there before the own motion: the structure's doing.
      this.overlapValid = true;
      this.overlapRec = first;
      return 0;
    }
    const px = e.pos.x;
    const py = e.pos.y;
    const pz = e.pos.z;
    if (mx !== 0 && this.validRevert(e, px - mx, py, pz, ax, ay, az)) {
      e.pos.x = px - mx;
      rel.x = 0;
      return 1;
    }
    if (mz !== 0 && this.validRevert(e, px, py, pz - mz, ax, ay, az)) {
      e.pos.z = pz - mz;
      rel.z = 0;
      return 4;
    }
    if (mx !== 0 && mz !== 0 && this.validRevert(e, px - mx, py, pz - mz, ax, ay, az)) {
      e.pos.x = px - mx;
      e.pos.z = pz - mz;
      rel.x = 0;
      rel.z = 0;
      return 5;
    }
    // Back to the sub-step start: overlaps there (if any) were made by the structure.
    e.pos.x = ax;
    e.pos.y = ay;
    e.pos.z = az;
    let mask = 0;
    if (mx !== 0) {
      rel.x = 0;
      mask |= 1;
    }
    if (my !== 0) {
      rel.y = 0;
      mask |= 2;
    }
    if (mz !== 0) {
      rel.z = 0;
      mask |= 4;
    }
    return mask;
  }

  private overlapAtStart(e: Entity, k: number, ax: number, ay: number, az: number): number {
    let v = this.startOverlap[k]!;
    if (v < 0) {
      const r = this.near[k]!;
      const sb = boxAt(e, ax, ay, az, this.startBox);
      v = boxNearRec(sb, r, 0) && boxOverlapsSolid(r.grid, sb) ? 1 : 0;
      this.startOverlap[k] = v;
    }
    return v;
  }

  private validRevert(e: Entity, x: number, y: number, z: number, ax: number, ay: number, az: number): boolean {
    const c = boxAt(e, x, y, z, this.cand);
    if (boxOverlapsSolid(this.world, c)) return false;
    const near = this.near;
    for (let k = 0; k < near.length; k++) {
      const r = near[k]!;
      if (!boxNearRec(c, r, 0) || !boxOverlapsSolid(r.grid, c)) continue;
      if (this.overlapAtStart(e, k, ax, ay, az) === 0) return false;
    }
    return true;
  }

  // ------------------------------------------------------------ sneak guard

  /**
   * Shorten a horizontal step so a sneaking body keeps standing (LESSONS 潜行走到甲板边缘掉
   * 下去, ACCEPTANCE 19). Engaged whenever the body sneaks on the ground — it never switches
   * itself off.
   *
   * The probe is the guard disk (radius half width - SNEAK_DISK_MARGIN, see constants.ts),
   * sampled in every support's own heading, so its verdict does not change while a deck yaws
   * under the body. A step is accepted when the disk stays supported after it. A body that
   * already stands outside its guard disk (it walked to the edge, then started sneaking) may
   * still move, but never farther from its support: its disk radius is the smallest of a
   * ladder of larger disks that is supported now, and its box must keep standing.
   */
  private clipSneak(e: Entity, dx: number, dz: number): void {
    this.clipX = dx;
    this.clipZ = dz;
    const cx = e.pos.x;
    const cy = e.pos.y;
    const cz = e.pos.z;
    let rad = e.halfWidth - SNEAK_DISK_MARGIN;
    if (!(rad > 0)) rad = e.halfWidth * 0.5;
    let band = false;
    if (!this.diskSupported(cx, cy, cz, rad)) {
      band = true;
      const maxR = e.halfWidth * Math.SQRT2 + SNEAK_LADDER_STEP;
      let found = -1;
      for (let k = 1; rad + k * SNEAK_LADDER_STEP <= maxR + 1e-9; k++) {
        const r2 = rad + k * SNEAK_LADDER_STEP;
        if (this.diskSupported(cx, cy, cz, r2)) {
          found = r2;
          break;
        }
      }
      if (found < 0) return; // nothing under the body within the probe: nothing to keep it on
      rad = found;
    }
    const step = SNEAK_STEP;
    let guard = 0;
    while (dx !== 0 && guard++ < 200) {
      if (this.stepKeepsSupport(e, dx, 0, rad, band)) break;
      dx = Math.abs(dx) <= step ? 0 : dx - Math.sign(dx) * step;
    }
    while (dz !== 0 && guard++ < 400) {
      if (this.stepKeepsSupport(e, 0, dz, rad, band)) break;
      dz = Math.abs(dz) <= step ? 0 : dz - Math.sign(dz) * step;
    }
    while (dx !== 0 && dz !== 0 && guard++ < 600) {
      if (this.stepKeepsSupport(e, dx, dz, rad, band)) break;
      dx = Math.abs(dx) <= step ? 0 : dx - Math.sign(dx) * step;
      dz = Math.abs(dz) <= step ? 0 : dz - Math.sign(dz) * step;
    }
    this.clipX = dx;
    this.clipZ = dz;
  }

  private stepKeepsSupport(e: Entity, dx: number, dz: number, rad: number, band: boolean): boolean {
    const x = e.pos.x + dx;
    const z = e.pos.z + dz;
    if (!this.diskSupported(x, e.pos.y, z, rad)) return false;
    // Outside the guard disk the ladder disk can reach past the footprint: the box itself must
    // keep standing too.
    return !band || this.supported(boxAt(e, x, e.pos.y, z, this.sb), SNEAK_PROBE_DEPTH, 0);
  }

  /**
   * Does any point of the disk of radius `rad` centred at the feet (x, y, z) have a solid cell
   * of the world or of a near structure within SNEAK_PROBE_DEPTH below it? The disk points are
   * laid out in each grid's own heading (see DISK_PATTERN), so the answer does not depend on
   * how far a yawing structure has turned.
   */
  private diskSupported(x: number, y: number, z: number, rad: number): boolean {
    const depth = SNEAK_PROBE_DEPTH;
    const pat = DISK_PATTERN;
    const world = this.world;
    // World: the point probe is a column of cells.
    const kTop = Math.ceil(y - CONTACT_EPS) - 1;
    const kBot = Math.floor(y - depth + CONTACT_EPS);
    for (let i = 0; i < pat.length; i += 2) {
      const ix = Math.floor(x + pat[i]! * rad);
      const iz = Math.floor(z + pat[i + 1]! * rad);
      for (let k = kTop; k >= kBot; k--) if (SOLID[world.getCell(ix, k, iz) & ID_MASK] === 1) return true;
    }
    const near = this.near;
    for (let j = 0; j < near.length; j++) {
      const r = near[j]!;
      if (x - rad >= r.maxX || x + rad <= r.minX || z - rad >= r.maxZ || z + rad <= r.minZ || y - depth >= r.maxY || y <= r.minY) continue;
      // World down in the structure's local frame.
      const ld = this.ld;
      ld.x = 0;
      ld.y = -1;
      ld.z = 0;
      qrotateInv(r.q1, ld, ld);
      const ux = r.headX;
      const uz = r.headZ;
      const grid = r.grid;
      const lp = this.lp;
      for (let i = 0; i < pat.length; i += 2) {
        const fx = pat[i]! * rad;
        const fz = pat[i + 1]! * rad;
        lp.x = x + fx * ux - fz * uz;
        lp.y = y;
        lp.z = z + fx * uz + fz * ux;
        curToLocal(r, lp, lp);
        for (let t = 0; ; t += POINT_PROBE_STEP) {
          if (t > depth) t = depth;
          const cell = grid.getCell(Math.floor(lp.x + ld.x * t), Math.floor(lp.y + ld.y * t), Math.floor(lp.z + ld.z * t));
          if (SOLID[cell & ID_MASK] === 1) return true;
          if (t >= depth) break;
        }
      }
    }
    return false;
  }
}
