/**
 * Moving one entity body through the world and around structures (steps b–d of the entity
 * pipeline). Every query goes through the voxel query module (voxel/shape.ts) with the one
 * body box (Entity.box()); see constants.ts for the probe definitions.
 *
 * Priorities (docs/DESIGN.md 对象模型): hard blocks > structures > entities.
 *  - The entity's OWN motion is swept exactly against the world: it can never walk into a
 *    world block, whatever its carrier does (LESSONS 在船上贴墙走被判挤伤).
 *  - Structures then push the body out of their solid cells, one axis at a time; an axis that
 *    would put the body NEWLY into the world or into ANOTHER structure is not applied
 *    (LESSONS 被风车沿船舷推时误判挤伤).
 *  - If a structure still overlaps the body and the body did not overlap it before its own
 *    motion, the body walked into it by itself: that motion is taken back axis by axis.
 *    Only an overlap that remains although the body did not move into it is a crush.
 *
 * All scratch state lives on the instance (no module-level temporaries).
 */
import { aabb, vec3, type AABB, type Vec3 } from '../core/math';
import { boxOverlapsSolid, deepestPenetration, hasSupportBelow, sweepAxis, type PushOptions } from '../voxel/shape';
import type { World } from '../voxel/world';
import {
  ATTACH_INSET,
  ATTACH_INSET_MAX_FRACTION,
  GROUND_NORMAL_Y,
  MAX_PUSH_ITERATIONS,
  MAX_SUBSTEP,
  MAX_SUBSTEPS,
  MIN_PUSH_PROJECTION_SQ,
  PREFER_MIN_SPEED,
  PREFER_WEIGHT,
  PUSH_SKIN,
  SNEAK_PROBE_DEPTH,
  SNEAK_STEP,
} from './constants';
import type { Entity } from './entity';
import { boxNearRec, pointVelocity, type StructRec } from './structs';

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

export class Mover {
  /** Structures near the current entity, innermost first. Filled by the manager before move(). */
  readonly near: StructRec[] = [];

  // ---- results of the last move()
  /** A downward world sweep was stopped: standing on a world block. */
  onWorldGround = false;
  /** Innermost structure that gave ground support (a push with normal.y > GROUND_NORMAL_Y), or null. */
  groundRec: StructRec | null = null;
  /** A horizontal move was stopped by the world. */
  collidedH = false;
  /** Horizontal contact normal (world walls and structure sides), 0,0 = none. */
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
  // sneak guard output
  private clipX = 0;
  private clipZ = 0;
  // scratch
  private readonly box: AABB = aabb();
  private readonly box0: AABB = aabb();
  private readonly tb: AABB = aabb();
  private readonly cand: AABB = aabb();
  private readonly startBox: AABB = aabb();
  private readonly v: Vec3 = vec3();
  private readonly c: Vec3 = vec3();
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
   * horizontal displacement is first shortened so the body keeps support below.
   */
  move(e: Entity, rel: Vec3, dx: number, dy: number, dz: number, sneakGuard: boolean): void {
    this.onWorldGround = false;
    this.groundRec = null;
    this.collidedH = false;
    this.contactNx = 0;
    this.contactNz = 0;
    this.pushBlocked = false;
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
      this.sweepWorld(e, rel, sx, sy, sz);
      if (this.blockedX) sx = 0;
      if (this.blockedY) sy = 0;
      if (this.blockedZ) sz = 0;
      if (n === 0) continue;
      this.groundStep = false;
      this.ceilingStep = false;
      this.resolveStructures(e, rel);
      if (this.groundStep && sy < 0) sy = 0;
      if (this.ceilingStep && sy > 0) sy = 0;
      const reverted = this.revertOwnMotion(e, rel, ax, ay, az);
      if (reverted & 1) sx = 0;
      if (reverted & 2) sy = 0;
      if (reverted & 4) sz = 0;
    }
  }

  /** First near structure whose solid cells still overlap the body, or null. */
  findOverlap(e: Entity): StructRec | null {
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

  // ------------------------------------------------------------ b. world

  private sweepWorld(e: Entity, rel: Vec3, dx: number, dy: number, dz: number): void {
    const world = this.world;
    const b = e.box(this.box);
    this.blockedX = false;
    this.blockedY = false;
    this.blockedZ = false;
    this.movedX = 0;
    this.movedY = 0;
    this.movedZ = 0;
    if (dy !== 0) {
      const m = sweepAxis(world, b, 1, dy);
      if (m !== dy) {
        this.blockedY = true;
        if (dy < 0) this.onWorldGround = true;
        // World blocks are static: the WORLD velocity along the blocked axis becomes 0.
        rel.y = -e.carrierVel.y;
      }
      e.pos.y += m;
      translateAxis(b, 1, m);
      this.movedY = m;
    }
    // Larger horizontal component first: moving the minor axis first is what snags corners.
    const xFirst = Math.abs(dx) >= Math.abs(dz);
    for (let k = 0; k < 2; k++) {
      const axis = (k === 0) === xFirst ? 0 : 2;
      const d = axis === 0 ? dx : dz;
      if (d === 0) continue;
      const m = sweepAxis(world, b, axis as 0 | 2, d);
      if (m !== d) {
        this.collidedH = true;
        if (axis === 0) {
          this.blockedX = true;
          this.contactNx = d > 0 ? -1 : 1;
          rel.x = -e.carrierVel.x;
        } else {
          this.blockedZ = true;
          this.contactNz = d > 0 ? -1 : 1;
          rel.z = -e.carrierVel.z;
        }
      }
      translateAxis(b, axis, m);
      if (axis === 0) {
        e.pos.x += m;
        this.movedX = m;
      } else {
        e.pos.z += m;
        this.movedZ = m;
      }
    }
  }

  // ------------------------------------------------------------ c. structures

  private resolveStructures(e: Entity, rel: Vec3): void {
    const near = this.near;
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (let k = 0; k < near.length; k++) {
        const r = near[k]!;
        for (let it = 0; it < MAX_PUSH_ITERATIONS; it++) {
          const b = e.box(this.box);
          if (!boxNearRec(b, r, 0)) break;
          const pen = deepestPenetration(r.grid, b, this.preferFor(e, rel, r, b));
          if (pen === null || !(pen.depth > 0)) break;
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
            const h = Math.sqrt(nx * nx + nz * nz);
            if (h > 0.5) {
              this.contactNx = nx / h;
              this.contactNz = nz / h;
            }
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
   * recomputed without it. Returns false when no admissible push remains.
   */
  private applyPush(e: Entity, r: StructRec, nx: number, ny: number, nz: number, depth: number, mask: number): boolean {
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
        if (this.newlyOverlapsOther(tb, b0, r)) {
          failed = a;
          break;
        }
      }
      if (failed < 0) {
        e.pos.x += tx;
        e.pos.y += ty;
        e.pos.z += tz;
        return true;
      }
      mask &= ~AXIS_BIT[failed as 0 | 1 | 2];
      if (mask === 0) return false;
    }
    return false;
  }

  private newlyOverlapsOther(tb: AABB, b0: AABB, r: StructRec): boolean {
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
      if (before === 0) return true;
    }
    return false;
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
    for (let k = 0; k < near.length; k++) {
      const r = near[k]!;
      if (!boxNearRec(b, r, 0) || !boxOverlapsSolid(r.grid, b)) continue;
      if (this.overlapAtStart(e, k, ax, ay, az) === 0) {
        own = true;
        break;
      }
    }
    if (!own) return 0;
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
   * Shorten a horizontal step so the body keeps support (world or any structure) within
   * SNEAK_PROBE_DEPTH under its inset footprint. Uses the ATTACH inset on purpose: a sneaking
   * player stopped at a deck edge is always still attachable to that deck (LESSONS 潜行走到
   * 甲板边缘掉下去). Only engages when the body is supported now.
   */
  private clipSneak(e: Entity, dx: number, dz: number): void {
    this.clipX = dx;
    this.clipZ = dz;
    const inset = attachInset(e);
    const b = e.box(this.box);
    if (!this.supported(b, SNEAK_PROBE_DEPTH, inset)) return;
    const tb = this.tb;
    const step = SNEAK_STEP;
    let guard = 0;
    while (dx !== 0 && guard++ < 200) {
      copyBox(b, tb);
      translateAxis(tb, 0, dx);
      if (this.supported(tb, SNEAK_PROBE_DEPTH, inset)) break;
      dx = Math.abs(dx) <= step ? 0 : dx - Math.sign(dx) * step;
    }
    while (dz !== 0 && guard++ < 400) {
      copyBox(b, tb);
      translateAxis(tb, 2, dz);
      if (this.supported(tb, SNEAK_PROBE_DEPTH, inset)) break;
      dz = Math.abs(dz) <= step ? 0 : dz - Math.sign(dz) * step;
    }
    while (dx !== 0 && dz !== 0 && guard++ < 600) {
      copyBox(b, tb);
      translateAxis(tb, 0, dx);
      translateAxis(tb, 2, dz);
      if (this.supported(tb, SNEAK_PROBE_DEPTH, inset)) break;
      dx = Math.abs(dx) <= step ? 0 : dx - Math.sign(dx) * step;
      dz = Math.abs(dz) <= step ? 0 : dz - Math.sign(dz) * step;
    }
    this.clipX = dx;
    this.clipZ = dz;
  }
}
