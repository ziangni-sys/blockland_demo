/**
 * Collider: moving one body through the world and around structures (steps b–d of the body
 * pipeline in body.ts). Every collision query goes through the voxel query module (voxel/shape.ts) with
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
 *    (a deck that rolls a little) lifts the body onto it instead. A structure that moved into the
 *    body pushes it out on the side it came from, never through a thin (half-cell) wall: see
 *    preferFor (docs/SHAPES.md 5.10).
 *  - If a structure still overlaps the body and the body did not overlap it before its own
 *    motion, the body walked into it by itself: that motion is taken back axis by axis.
 *    Only an overlap that remains although the body did not move into it is a crush.
 *
 * All scratch state lives on the instance (no module-level temporaries).
 */
import { SOLID } from '../blocks/registry';
import { ID_MASK } from '../blocks/cell';
import { TICK_DT } from '../core/constants';
import { aabb, qrotateInv, vec3, type AABB, type Vec3 } from '../core/math';
import { solidAtHalf } from '../voxel/parts';
import { boxOverlapsSolid, CONTACT_EPS, deepestPenetration, hasSupportBelow, sweepAxis, type Penetration, type PushOptions } from '../voxel/shape';
import type { World } from '../voxel/world';
import {
  ATTACH_INSET,
  ATTACH_INSET_MAX_FRACTION,
  GRAZE_MIN,
  GRAZE_RATIO,
  GROUND_NORMAL_Y,
  LAND_BIAS_SLACK,
  MAX_PUSH_ITERATIONS,
  MAX_PUSH_LIFT,
  MAX_SUBSTEP,
  MAX_SUBSTEPS,
  MIN_PUSH_PROJECTION_SQ,
  PREFER_MIN_DEPTH,
  PREFER_MIN_SPEED,
  PREFER_WEIGHT,
  PUSH_SKIN,
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

export class Collider {
  /** Structures near the current body, innermost first. Filled by the BodyMover before move(). */
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
  /** Adjustments admitOthers() made to the current trial push (floor lifts, graze nudges). */
  private adjX = 0;
  private adjY = 0;
  private adjZ = 0;
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
  /** Push options leaning toward a structure's displacement relative to the body this tick (preferFor). */
  private readonly motionPrefer: Vec3 = vec3();
  private readonly motionOpts: PushOptions = { prefer: this.motionPrefer, preferWeight: PREFER_WEIGHT };
  /** Where the body was when move() began (preferFor measures the body's own displacement this tick from it). */
  private p0x = 0;
  private p0y = 0;
  private p0z = 0;
  /** deepestPenetration results (written in place: no allocation per query). */
  private readonly penA: Penetration = { nx: 0, ny: 0, nz: 0, depth: 0, cx: 0, cy: 0, cz: 0, octant: -1 };
  private readonly penB: Penetration = { nx: 0, ny: 0, nz: 0, depth: 0, cx: 0, cy: 0, cz: 0, octant: -1 };
  private readonly penC: Penetration = { nx: 0, ny: 0, nz: 0, depth: 0, cx: 0, cy: 0, cz: 0, octant: -1 };
  /** Push options that pick a cell's top face whenever it is exposed (structure step-up). */
  private readonly upOpts: PushOptions = { prefer: vec3(0, 1, 0), preferWeight: 4 };
  /** Push options leaning toward the top face by the distance the body came down (see groundBias). */
  private readonly landOpts: PushOptions = { prefer: vec3(0, 1, 0), preferWeight: 0 };
  /**
   * A fixed direction (world, unit) that deep pushes by structures other than the carrier lean
   * toward, with weight `w`, instead of each structure's motion relative to the body; null = the
   * motion, with PREFER_WEIGHT. Only for judging a body nobody moves (BodyMover.pushOut).
   */
  setLean(dir: Vec3 | null, w: number): void {
    this.leanDir = dir;
    this.opts.preferWeight = dir === null ? PREFER_WEIGHT : w;
  }
  private leanDir: Vec3 | null = null;
  /** Per near index: did the body overlap it before the current push / at the sub-step start? -1 unknown. */
  private beforeOverlap = new Int8Array(16);
  private startOverlap = new Int8Array(16);

  constructor(world: World) {
    this.world = world;
  }

  /**
   * Move `e` by its own displacement `d` this tick. `rel` is its velocity relative to
   * its carrier (world axes); blocked components are cancelled in it. With `sneakGuard` the
   * horizontal displacement is first shortened so the body keeps standing. With `walker` a body
   * that stands on something steps up onto world ledges of at most STEP_HEIGHT.
   */
  move(e: Entity, rel: Vec3, d: Readonly<Vec3>, sneakGuard: boolean, walker: boolean): void {
    // (The displacement comes as an object: doubles passed to a call that is not inlined are boxed.)
    let dx = d.x;
    const dy = d.y;
    let dz = d.z;
    this.p0x = e.pos.x;
    this.p0y = e.pos.y;
    this.p0z = e.pos.z;
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
      // The edge stops the velocity it refused, like a wall: otherwise the stored push toward
      // the edge carries a player who then jumps right over it.
      if (dx !== 0) rel.x *= this.clipX / dx;
      if (dz !== 0) rel.z *= this.clipZ / dz;
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
      this.canStep = false;
      this.movedX = 0;
      this.movedZ = 0;
      this.sweepWorldY(e, rel, sy);
      // Structure support BEFORE the horizontal sweeps: the vertical step may have sunk the
      // feet a little into a deck, and a world block level with that deck (a pier) must not
      // turn into a wall for those few hundredths of a block.
      const resolvedY = n !== 0 && this.movedY !== 0;
      if (resolvedY) this.resolveStructures(e, rel);
      // Only a body that stands on something steps up (never a falling, jumping or swimming one).
      this.canStep = walker && (wasOnGround || this.onWorldGround || this.groundStep) && rel.y < 1;
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
          let pen = deepestPenetration(r.grid, b, this.groundBias(e, r), this.penA);
          if (pen === null || !(pen.depth > 0)) break;
          // Lean toward the structure's motion so the body ends up in front of a fast blade or
          // wall, not behind it: for a deep intrusion, and (motion only, not a fixed lean) whenever
          // the shallowest push points back against that motion, out through the far side of a
          // wall thinner than the distance it moved into the body (docs/SHAPES.md 5.10). A graze
          // (push across the motion) keeps the shallowest push (LESSONS 叶片侧面擦过船时船被猛踢).
          const opts = this.preferFor(e, r, b);
          if (
            opts !== undefined &&
            (pen.depth >= PREFER_MIN_DEPTH || (opts === this.motionOpts && pen.nx * this.motionPrefer.x + pen.ny * this.motionPrefer.y + pen.nz * this.motionPrefer.z < -0.5))
          ) {
            pen = deepestPenetration(r.grid, b, opts, this.penB) ?? pen;
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
            // A walker that walked into a low structure side (a deck floating a little above the
            // pier it boards from) steps up onto it, like onto a world ledge.
            if (this.canStep && nx * this.movedX + nz * this.movedZ < 0 && this.stepOntoStructure(e, rel, r)) {
              moved = true;
              continue;
            }
          }
          let pushed = this.applyPush(e, r, nx, ny, nz, pen.depth, mask);
          if (!pushed && kind !== 0) {
            // The vertical (ground / ceiling) correction is blocked, e.g. a rising blade's tip
            // presses a free-standing body into the ground. That is not yet a crush: the face can
            // still be cleared along its horizontal part (the body goes out sideways). Only when
            // that is refused too is the body truly stuck (DESIGN 实体被挤: only 推不动 is a crush).
            const side = (Math.abs(nx) > 1e-9 ? 1 : 0) | (Math.abs(nz) > 1e-9 ? 4 : 0);
            if (side !== 0 && this.applyPush(e, r, nx, ny, nz, pen.depth, side | 2)) {
              pushed = true;
              kind = 0;
            }
          }
          if (!pushed) {
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
      this.adjX = 0;
      this.adjY = 0;
      this.adjZ = 0;
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
        if (!this.admitOthers(tb, b0, r, t)) {
          failed = a;
          break;
        }
      }
      if (failed < 0 && ty < 0 && this.adjY > 0) {
        // The push's downward part dipped the box into another structure's floor and the
        // floor-lift took it back: that axis is effectively refused. Without it the move would
        // clear only the horizontal share of the depth (nx² of it), leaving a sliver of overlap
        // after the iteration cap that was then judged a crush (a blade pushing a rider on a
        // ship's deck). Drop the axis and rescale the rest so the face is actually cleared.
        failed = 1;
      }
      if (failed < 0) {
        e.pos.x += tx + this.adjX;
        e.pos.y += ty + this.adjY;
        e.pos.z += tz + this.adjZ;
        return true;
      }
      mask &= ~AXIS_BIT[failed as 0 | 1 | 2];
      if (mask === 0) break;
    }
    this.liftRec = null;
    return false;
  }

  /**
   * The trial box `tb` of a push by structure r has just moved by `t` along one axis: does it
   * newly overlap ANOTHER structure (overlaps that existed before the push, in b0, do not count)?
   * Two kinds of new overlap are not walls and are resolved on tb instead of refusing the axis:
   *  - a dip into another structure's FLOOR (the push slides the body along a deck that rolls or
   *    pitches): tb is lifted onto it (a ground push, at most MAX_PUSH_LIFT in all);
   *  - a GRAZE: the overlap is at most GRAZE_RATIO of the axis move (the surface is tilted to the
   *    move, e.g. lifting a rider out of a rolling deck beside a turntable whose side leans by
   *    the same roll): tb is nudged off that surface along its normal.
   * Neither may enter the world. The adjustments accumulate in adjX / adjY / adjZ (liftRec = the
   * floor). Returns false when the box would newly enter another structure for real. Without
   * this a blade pushing a rider uphill along a gently rolling deck, or the deck itself holding
   * up a rider next to its own turntable, was refused and judged a crush (review finding;
   * DESIGN 实体被挤: only 推不动 is a crush).
   */
  private admitOthers(tb: AABB, b0: AABB, r: StructRec, t: number): boolean {
    const grazeMax = GRAZE_RATIO * Math.abs(t) + GRAZE_MIN;
    for (let guard = 0; guard < 4; guard++) {
      const o = this.newOverlap(tb, b0, r);
      if (o === null) return true;
      const pen = deepestPenetration(o.grid, tb, undefined, this.penC);
      if (pen === null) return false; // embedded without an exposed face
      if (pen.ny > GROUND_NORMAL_Y) {
        const l = pen.depth / pen.ny + PUSH_SKIN;
        if (!(this.adjY + l <= MAX_PUSH_LIFT)) return false;
        if (sweepAxis(this.world, tb, 1, l) !== l) return false;
        translateAxis(tb, 1, l);
        this.adjY += l;
        if (this.liftRec === null) this.liftRec = o;
        continue;
      }
      if (!(pen.depth <= grazeMax)) return false;
      const s = pen.depth + PUSH_SKIN;
      const gx = pen.nx * s;
      const gy = pen.ny * s;
      const gz = pen.nz * s;
      translateAxis(tb, 0, gx);
      translateAxis(tb, 1, gy);
      translateAxis(tb, 2, gz);
      if (boxOverlapsSolid(this.world, tb)) return false;
      this.adjX += gx;
      this.adjY += gy;
      this.adjZ += gz;
    }
    return this.newOverlap(tb, b0, r) === null;
  }

  /**
   * Structure step-up: lift the body onto the top of structure r's cells it walked into, when
   * that takes at most STEP_HEIGHT, the world above is free and no other structure is newly
   * entered. Applied as a ground push (the body then stands on r). False: nothing changed, the
   * normal side push follows.
   */
  private stepOntoStructure(e: Entity, rel: Vec3, r: StructRec): boolean {
    const b0 = e.box(this.box0);
    const tb = copyBox(b0, this.sb);
    let lift = 0;
    for (let k = 0; k < 2; k++) {
      // The top face of the worst cell whenever it is exposed (a wall cell under another cell
      // has none: no stepping up walls).
      const pen = deepestPenetration(r.grid, tb, k === 0 ? this.upOpts : undefined, this.penC);
      if (pen === null) break;
      if (!(pen.ny > GROUND_NORMAL_Y)) return false;
      const l = pen.depth / pen.ny + PUSH_SKIN;
      if (!(lift + l <= STEP_HEIGHT)) return false;
      if (sweepAxis(this.world, tb, 1, l) !== l) return false;
      translateAxis(tb, 1, l);
      lift += l;
      if (!boxOverlapsSolid(r.grid, tb)) break;
      if (k === 1) return false;
    }
    if (lift === 0) return false;
    this.beforeOverlap.fill(-1, 0, this.near.length);
    if (this.newOverlap(tb, b0, r) !== null) return false;
    e.pos.y += lift;
    this.cancelInto(e, rel, r, 0, 1, 0);
    this.groundStep = true;
    if (this.groundRec === null) this.groundRec = r;
    return true;
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

  /**
   * Landing bias: a body that came DOWN onto a structure by `s` this sub-step (its own fall, or
   * the structure rising under it) may be inside a top face by up to `s`; when its footprint
   * only overlaps the edge cell by less than that, the smallest push would be sideways and would
   * shove it off the edge (landing on a deck's rim after a jump, a sneaking rider at the edge).
   * So the push leans toward the top face by exactly the downward approach (+ a little slack):
   * top wins when depth_top < depth_side + s. A body really beside a hull has its feet far below
   * the top (depth_top large) and keeps its side push. Undefined when the body is not coming down.
   */
  private groundBias(e: Entity, r: StructRec): PushOptions | undefined {
    let down = -this.movedY;
    if (r.id !== e.carrierId && r.moved) {
      const c = this.c;
      c.x = e.pos.x;
      c.y = e.pos.y;
      c.z = e.pos.z;
      // The structure rose relative to the body's carrier frame this tick.
      down += (pointVelocity(r, c, this.v).y - e.carrierVel.y) * TICK_DT;
    }
    if (!(down > 0)) return undefined;
    this.landOpts.preferWeight = down + LAND_BIAS_SLACK;
    return this.landOpts;
  }

  /**
   * Push bias toward a structure's motion relative to the body (a blade or a wall sweeping into
   * it). A fixed lean (setLean) applies to every structure but the carrier. Otherwise, for a
   * structure that moved this tick and is not the carrier: its displacement this tick relative to
   * the body, Δ = (its velocity at the body - the carrier's) * TICK_DT - (the body's own
   * displacement so far in this move); none when |Δ| < PREFER_MIN_SPEED * TICK_DT; else toward
   * Δ / |Δ| with weight max(PREFER_WEIGHT, |Δ|) (docs/SHAPES.md 5.10).
   *
   * Why the displacement and not the velocity difference: a body pushed once already carries the
   * structure's horizontal velocity, so the velocity difference is only its own fall or jump and
   * the lean pointed up or down; but the intrusion comes from positions (in the air the body's
   * structure pass comes before its own horizontal move in the sub-step). With weight |Δ| the push
   * out through the face the body was in front of scores at most 0, so it beats the far face of a
   * wall of any thickness at any speed.
   */
  private preferFor(e: Entity, r: StructRec, b: AABB): PushOptions | undefined {
    const lean = this.leanDir;
    if (lean !== null) {
      if (r.id === e.carrierId) return undefined;
      this.prefer.x = lean.x;
      this.prefer.y = lean.y;
      this.prefer.z = lean.z;
      return this.opts;
    }
    if (!r.moved || r.id === e.carrierId) return undefined;
    const c = this.c;
    c.x = (b.minX + b.maxX) * 0.5;
    c.y = (b.minY + b.maxY) * 0.5;
    c.z = (b.minZ + b.maxZ) * 0.5;
    const sv = pointVelocity(r, c, this.v);
    const dx = (sv.x - e.carrierVel.x) * TICK_DT - (e.pos.x - this.p0x);
    const dy = (sv.y - e.carrierVel.y) * TICK_DT - (e.pos.y - this.p0y);
    const dz = (sv.z - e.carrierVel.z) * TICK_DT - (e.pos.z - this.p0z);
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len >= PREFER_MIN_SPEED * TICK_DT)) return undefined;
    this.motionPrefer.x = dx / len;
    this.motionPrefer.y = dy / len;
    this.motionPrefer.z = dz / len;
    this.motionOpts.preferWeight = len > PREFER_WEIGHT ? len : PREFER_WEIGHT;
    return this.motionOpts;
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
   * The probe is the guard disk — the attach probe's inscribed circle, radius half width -
   * attach inset (see constants.ts) — sampled in every support's own heading, so its verdict
   * does not change while a deck yaws under the body. A step is accepted when the disk stays
   * supported after it. A body that already stands outside its guard disk (it walked to the
   * edge, then started sneaking) may still move, but never farther from its support: its disk
   * radius is the smallest of a ladder of larger disks that is supported now, and its box must
   * keep standing.
   */
  private clipSneak(e: Entity, dx: number, dz: number): void {
    this.clipX = dx;
    this.clipZ = dz;
    const cx = e.pos.x;
    const cy = e.pos.y;
    const cz = e.pos.z;
    let rad = e.halfWidth - attachInset(e);
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
   * Does any point of the disk of radius `rad` centred at the feet (x, y, z) have solid material
   * of the world or of a near structure within SNEAK_PROBE_DEPTH below it? The disk points are
   * laid out in each grid's own heading (see DISK_PATTERN), so the answer does not depend on
   * how far a yawing structure has turned.
   *
   * A point probes the column of half cells under it (docs/SHAPES.md 5.9): the octants whose
   * horizontal quarter contains the point, from the half layer under the feet down to
   * SNEAK_PROBE_DEPTH below them, with voxel/parts.ts solidAtHalf (integer half-cell coordinates
   * only: it runs hundreds of times per tick per structure). Where there can be no partial cell
   * (a world column whose chunk has no holes / second-part layers, a structure without them) the
   * probe reads whole cells, as it always did. A half cell contains the point (Math.floor of
   * twice the coordinate) and lies strictly below the feet, as a cell did, so "guard-supported"
   * still implies "attach-supported" for the disk inscribed in the attach probe (constants.ts).
   */
  private diskSupported(x: number, y: number, z: number, rad: number): boolean {
    const depth = SNEAK_PROBE_DEPTH;
    const pat = DISK_PATTERN;
    const world = this.world;
    // World: the point probe is a column of cells (half cells where the chunk has partial cells).
    const kTop = Math.ceil(y - CONTACT_EPS) - 1;
    const kBot = Math.floor(y - depth + CONTACT_EPS);
    const hTop = Math.ceil((y - CONTACT_EPS) * 2) - 1;
    const hBot = Math.floor((y - depth + CONTACT_EPS) * 2);
    for (let i = 0; i < pat.length; i += 2) {
      const px = x + pat[i]! * rad;
      const pz = z + pat[i + 1]! * rad;
      const ix = Math.floor(px);
      const iz = Math.floor(pz);
      const chunk = world.chunkAt(ix, iz);
      if (chunk === undefined || (chunk.holes === null && chunk.part2 === null)) {
        for (let k = kTop; k >= kBot; k--) if (SOLID[world.getCell(ix, k, iz) & ID_MASK] === 1) return true;
      } else {
        const hx = Math.floor(px * 2);
        const hz = Math.floor(pz * 2);
        for (let h = hTop; h >= hBot; h--) if (solidAtHalf(world, hx, h, hz)) return true;
      }
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
      const layered = grid.layered;
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
          if (layered) {
            if (solidAtHalf(grid, Math.floor((lp.x + ld.x * t) * 2), Math.floor((lp.y + ld.y * t) * 2), Math.floor((lp.z + ld.z * t) * 2))) return true;
          } else {
            const cell = grid.getCell(Math.floor(lp.x + ld.x * t), Math.floor(lp.y + ld.y * t), Math.floor(lp.z + ld.z * t));
            if (SOLID[cell & ID_MASK] === 1) return true;
          }
          if (t >= depth) break;
        }
      }
    }
    return false;
  }
}
