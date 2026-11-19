/**
 * BodyMover: how a body moves. Carrying (riders follow their carrier, helmsmen their seat), the
 * body's own motion from input and gravity, collision with the world and with structures, push-out,
 * unsticking and relocation, attaching to and detaching from carriers.
 *
 * It knows nothing about damage, items, AI, fuses or events, and is usable outside the simulation:
 * on a client, against a local copy of the world and the structures, to move the client's own
 * player. It depends only on a BodyHost (the world's cells and the structures with their poses;
 * ships carry their hull analysis, which fluid sampling needs), uses no random numbers, emits
 * nothing and creates no objects per tick: all scratch is on the instance, the structure cache
 * reuses its records and arrays (tests/drive/alloc.test.ts; V8 still boxes some computed numbers
 * passed to the voxel queries, and those queries allocate their local box against a structure).
 *
 * What the server's rules need to know about a step is left in `facts` (StepFacts): squeezed by a
 * structure, inside world blocks, moved to a free spot, entered liquid at some speed, landed after
 * falling this far, pushed off the seat. The rules (entities/manager.ts) act on them; a client
 * ignores them or shows them.
 *
 * TICK ORDER (docs/LESSONS.md 携带与实体: the order matters). A tick of bodies is
 *     [structures moved]  ->  beginCarry()  ->  carryRider() / followSeat() per carried body
 *                         ->  beginStep() + step*() per body  ->  endTick()
 * beginCarry() re-reads every structure pose; carrying moves riders by the structure motion since
 * the previous carry only (structs.ts), so a repeated carry moves nobody twice. endTick() makes the
 * current poses the velocity base of the next tick.
 *
 * Per body, a step runs (step*):
 *   a. controller: input / gravity (or a velocity chosen by the caller, stepWalker) -> own velocity
 *      relative to the carrier and the displacement it wants
 *   b. world collision: exact axis sweeps of the own displacement (never into world blocks)
 *   c. structure collision: SAT push-out, axis by axis, sub-stepped against tunnelling
 *   d. squeeze: a structure still overlaps the body -> nearest free spot + facts.crushedBy (when
 *      this mover relocates; a client's does not: the server decides, and the body stays where
 *      the carry left it until then)
 *   e. attach / detach: carried only while a carrier cell is under the feet
 */
import { aabb, vec3, type AABB, type Vec3 } from '../core/math';
import type { VoxelGrid } from '../voxel/grid';
import type { World } from '../voxel/world';
import { boxOverlapsSolid, columnHasSolidBelow, hasSupportBelow, nearestFreeOffset, sweepAxis } from '../voxel/shape';
import {
  BURIED_RISE_LIMIT,
  COLUMN_DEPTH,
  CRUSH_SEARCH_RADIUS,
  FLY_TOGGLE_TICKS,
  MAX_INHERITED_SPEED,
  NO_ATTACH_TICKS,
  SEAT_LEAVE_DISTANCE,
  STEP_HEIGHT,
  SUPPORT_GAP,
  SWIMMING_WET,
  UNSTUCK_MAX_BACKOFF_TICKS,
  UNSTUCK_SEARCH_RADIUS,
} from './constants';
import { Player, type Entity } from './entity';
import { FluidSampler } from './fluids';
import { axisValue, finiteAngle } from './input';
import { passiveMotion, playerMotion } from './motion';
import { Collider, attachInset, boxAt } from './physics';
import { StructureCache, boxNearRec, carryPoint, curToWorld, pointVelocity, type BodyStructure, type StructRec } from './structs';

export type { BodyStructure } from './structs';

/** What a BodyMover needs from whoever owns the world and the structures (a simulation, a client). */
export interface BodyHost {
  /** The world's cells. Bodies over chunks that are not loaded are frozen by the caller. */
  readonly world: World;
  /** Every live structure with its current pose, nested ones included. */
  structures(): readonly BodyStructure[];
}

export interface BodyMoverOptions {
  /**
   * Squeezed bodies and bodies inside world blocks are moved to the nearest free spot (default
   * true). False on a client: there the server decides about squeezes and relocations, and the
   * client body stays where the carry left it (facts still report the squeeze).
   */
  relocate?: boolean;
}

/** Facts about the last step of one body, for the rules (see the file comment). */
export class StepFacts {
  /** Id of the structure that squeezed the body (an overlap the pushes could not clear and the body's own motion did not cause), 0 = none. */
  crushedBy = 0;
  /** The body was moved to a free spot (out of a squeeze or out of world blocks): a teleport, not motion. */
  relocated = false;
  /** Vertical part of that teleport. */
  relocatedDy = 0;
  /** The body is inside world blocks and was not moved out (no free spot, or this mover does not relocate). */
  stuckInWorld = false;
  /** Some structure push of this step was blocked (pushed and blocked). */
  pushBlocked = false;
  /** Downward speed (blocks/s) at which a dry body entered liquid at this step's start; 0 = it did not. */
  liquidEntrySpeed = 0;
  /** Players: came down on the ground this step after falling this far (blocks); -1 = did not land. */
  landedFall = -1;
  /** ... and was airborne before the step (not merely standing on). */
  landedFromAir = false;
  /** A seated player was pushed farther than SEAT_LEAVE_DISTANCE from its seat. */
  pushedOffSeat = false;
  /** Id of the innermost structure whose floor the body landed on / stands on this step, 0 = none. */
  groundStructureId = 0;

  reset(): void {
    this.crushedBy = 0;
    this.relocated = false;
    this.relocatedDy = 0;
    this.stuckInWorld = false;
    this.pushBlocked = false;
    this.liquidEntrySpeed = 0;
    this.landedFall = -1;
    this.landedFromAir = false;
    this.pushedOffSeat = false;
    this.groundStructureId = 0;
  }
}

/** Result of followSeat(). */
export type SeatResult = 'seated' | 'lost' | 'blocked';

/** Margin around a body when collecting the structures it may touch this tick. */
const NEAR_MARGIN = 0.5;
/** ... for a walker, which may step up STEP_HEIGHT: structures that high above must be seen too. */
const NEAR_MARGIN_WALKER = NEAR_MARGIN + STEP_HEIGHT;
/** No displacement. Immutable. */
const STILL: Readonly<Vec3> = Object.freeze(vec3(0, 0, 0));
/** A carrier that moves a rider farther than this in one tick was re-gridded / teleported: let go. */
const MAX_CARRY_STEP = 4;

// ====================================================================== player input

/**
 * Make the held input usable: stick axes clamped to [-1, 1]; a garbage look keeps the current
 * one (if that is poisoned too, the last finite one, else straight ahead). Written back into the
 * input. Server and client alike call it before using the input.
 */
export function sanitizeInput(p: Player): void {
  const inp = p.input;
  inp.forward = axisValue(inp.forward);
  inp.strafe = axisValue(inp.strafe);
  inp.yaw = finiteAngle(inp.yaw, finiteAngle(p.yaw, finiteAngle(p.prevYaw, 0)));
  inp.pitch = finiteAngle(inp.pitch, finiteAngle(p.pitch, finiteAngle(p.prevPitch, 0)));
}

/** Consume the jump presses counted since the last tick (at most 8). */
export function takeJumpPresses(p: Player): number {
  const n = p.input.jumpPresses > 0 ? Math.min(8, Math.floor(p.input.jumpPresses)) : 0;
  p.input.jumpPresses = 0;
  return n;
}

/**
 * Fall bookkeeping of a player after a step that moved its feet down by `fell` blocks (its own
 * motion; carrying and teleports excluded). A body in liquid, flying or seated falls no distance.
 * Returns the total fall when it lands now (on the ground after not being supported), else -1.
 * The server applies it to client-driven players too, on the track they report.
 */
export function trackFall(p: Player, fell: number, seated: boolean): number {
  if (p.wet > 0 || p.inLava || p.flying || seated) {
    p.fallDistance = 0;
    return -1;
  }
  if (p.onGround) {
    const total = p.fallDistance + fell;
    p.fallDistance = 0;
    return total;
  }
  p.fallDistance += fell;
  return -1;
}

// ====================================================================== the mover

export class BodyMover {
  /** Facts about the last step (reset by beginStep()). */
  readonly facts = new StepFacts();

  private readonly host: BodyHost;
  private readonly cache = new StructureCache();
  private readonly collide: Collider;
  private readonly fluids: FluidSampler;
  private readonly relocates: boolean;

  // ---- releasing riders (beginRelease / handOff)
  private readonly releasing = new Set<number>();
  private heirId = 0;
  private heirRec: StructRec | undefined = undefined;

  // ---- scratch (instance-owned, never shared across modules)
  /** Own velocity relative to the carrier of the body being stepped. */
  private readonly rel: Vec3 = vec3();
  private readonly disp: Vec3 = vec3();
  private readonly wish: Vec3 = vec3();
  private readonly t1: Vec3 = vec3();
  private readonly t2: Vec3 = vec3();
  private readonly box1: AABB = aabb();
  private readonly box2: AABB = aabb();
  private readonly box3: AABB = aabb();
  private readonly grids: VoxelGrid[] = [];
  /** Structures a free-spot search can reach (wider than collide.near). */
  private readonly relocNear: StructRec[] = [];

  constructor(host: BodyHost, opts: BodyMoverOptions = {}) {
    this.host = host;
    this.collide = new Collider(host.world);
    this.fluids = new FluidSampler(host.world);
    this.relocates = opts.relocate ?? true;
  }

  // ================================================================== structures

  /** The structure record (poses of the current tick) by id, or undefined. */
  record(id: number): StructRec | undefined {
    return this.cache.get(id);
  }

  /** Forget every remembered pose (a new world / a loaded save). */
  reset(): void {
    this.cache.reset();
  }

  /**
   * Tick step 4 begins: re-read every structure pose (the carry base becomes the previous carry).
   * `firstSeen` 'now': called between ticks, a structure the cache has not seen yet takes its pose
   * now as the base (structs.ts).
   */
  beginCarry(firstSeen: 'tickStart' | 'now' = 'tickStart'): void {
    this.cache.rebuild(this.host.structures(), firstSeen);
  }

  /** End of the tick: the current poses become the velocity base of the next tick. */
  endTick(): void {
    this.cache.commit();
  }

  // ================================================================== carrying

  /**
   * A carried body follows its carrier: position transformed from the carrier's previous pose to
   * its current one, yaw turned by the carrier's heading change, moved with world sweeps so a
   * passing wall scrapes it off instead of dragging it inside.
   */
  carryRider(e: Entity): void {
    let r = this.cache.get(e.carrierId);
    if (r === undefined) {
      this.detach(e, e.vel);
      return;
    }
    // Own velocity in the carrier's frame, which turns with the carrier: standing still on a
    // yawing deck or turntable stays standing still (no fictitious slide).
    let relx = e.vel.x - e.carrierVel.x;
    const rely = e.vel.y - e.carrierVel.y;
    let relz = e.vel.z - e.carrierVel.z;
    let target = carryPoint(r, e.pos, this.t1);
    // LESSONS 转盘在船上: a rider swept by a rotor into a cell of the rotor's PARENT lets go of
    // the rotor and stays with the parent; it may not re-attach to the rotor for a while.
    const parent = r.parent;
    if (parent !== null && r.carryMoved) {
      const bt = boxAt(e, target.x, target.y, target.z, this.box1);
      if (boxNearRec(bt, parent, 0) && boxOverlapsSolid(parent.grid, bt)) {
        const pt = carryPoint(parent, e.pos, this.t2);
        const bp = boxAt(e, pt.x, pt.y, pt.z, this.box2);
        if (!(boxNearRec(bp, parent, 0) && boxOverlapsSolid(parent.grid, bp))) {
          e.noAttachTicks = NO_ATTACH_TICKS;
          e.noAttachStructureId = r.id;
          e.carrierId = parent.id;
          r = parent;
          target = pt;
        }
      }
    }
    const dx = target.x - e.pos.x;
    const dy = target.y - e.pos.y;
    const dz = target.z - e.pos.z;
    if (dx * dx + dy * dy + dz * dz > MAX_CARRY_STEP * MAX_CARRY_STEP) {
      this.detach(e, e.vel);
      return;
    }
    const a = r.carryDyaw;
    if (a !== 0) {
      const c = Math.cos(a);
      const s = Math.sin(a);
      const x = relx * c + relz * s;
      relz = -relx * s + relz * c;
      relx = x;
      this.turn(e, a);
    }
    // The carrier's velocity at the feet over this tick. Not the carry delta: a repeated
    // carry moves nothing more but must not zero the carrier velocity.
    pointVelocity(r, target, e.carrierVel);
    this.carryMove(e, dx, dy, dz);
    e.vel.x = relx + e.carrierVel.x;
    e.vel.y = rely + e.carrierVel.y;
    e.vel.z = relz + e.carrierVel.z;
  }

  /**
   * A seated player (steeringShipId != 0, seat in that ship's local space) follows its seat.
   * 'lost': the ship has no record this tick (nothing moved). 'blocked': the seat lies in a world
   * block (LESSONS 舵手穿过方块); the body is not moved, and the caller decides (the server lets
   * go of the wheel, then carries it as a rider). Whether the player may sit there at all (the
   * ship exists, nobody else holds the wheel) is the caller's business.
   */
  followSeat(p: Player): SeatResult {
    const r = this.cache.get(p.steeringShipId);
    if (r === undefined) return 'lost';
    p.carrierId = r.id;
    const target = curToWorld(r, p.seat, this.t1);
    if (boxOverlapsSolid(this.host.world, boxAt(p, target.x, target.y, target.z, this.box1))) return 'blocked';
    pointVelocity(r, target, p.carrierVel);
    p.pos.x = target.x;
    p.pos.y = target.y;
    p.pos.z = target.z;
    if (r.carryDyaw !== 0) this.turn(p, r.carryDyaw);
    p.vel.x = p.carrierVel.x;
    p.vel.y = p.carrierVel.y;
    p.vel.z = p.carrierVel.z;
    p.onGround = true;
    return 'seated';
  }

  /**
   * Sit down now at p.seat of `ship` (the caller set steeringShipId and the seat): feet at the
   * seat, moving with the ship (its velocity over its latest tick), no fall. The seat then
   * follows the ship from the next carry on.
   */
  sit(p: Player, ship: BodyStructure): void {
    const w = ship.grid.toWorld(p.seat, this.t1);
    p.pos.x = w.x;
    p.pos.y = w.y;
    p.pos.z = w.z;
    const r = this.cache.get(ship.id);
    if (r !== undefined) pointVelocity(r, p.pos, p.carrierVel);
    else p.carrierVel.x = p.carrierVel.y = p.carrierVel.z = 0;
    p.vel.x = p.carrierVel.x;
    p.vel.y = p.carrierVel.y;
    p.vel.z = p.carrierVel.z;
    p.carrierId = ship.id;
    p.fallDistance = 0;
  }

  /**
   * Prepare to release everything carried by `structure` or by a structure mounted on it (it is
   * about to blockify / dock / die / be re-gridded): then call handOff() for every body. The
   * blocks of a structure mounted on a surviving one (a turntable on a ship whose bearing was
   * mined) end up in, or above, that parent and keep moving with it: its riders are handed to the
   * parent with the parent's velocity under their feet (stripping the whole carrier velocity made
   * them skid ~0.5 block across a sailing deck; the LESSONS 停靠时站在转盘上的人被瞬移 class).
   * Only what becomes WORLD blocks stops dead.
   */
  beginRelease(structure: BodyStructure): void {
    const ids = this.releasing;
    ids.clear();
    const collect = (s: BodyStructure): void => {
      ids.add(s.id);
      for (const c of s.children) collect(c);
    };
    collect(structure);
    let heir: BodyStructure | null = structure.parent;
    while (heir !== null && (heir.removed || ids.has(heir.id))) heir = heir.parent;
    this.heirId = heir !== null ? heir.id : 0;
    // Last tick's motion of the heir (the cache is not rebuilt mid-tick): its current velocity.
    this.heirRec = heir !== null ? this.cache.get(heir.id) : undefined;
    // Its frame is about to jump: never carry anything across that.
    for (const id of ids) this.cache.forget(id);
  }

  /** Is structure `id` among those beginRelease() is releasing? */
  isReleasing(id: number): boolean {
    return this.releasing.has(id);
  }

  /** Release one body if its carrier is being released (see beginRelease). Returns true when it was. */
  handOff(e: Entity): boolean {
    if (e.carrierId === 0 || !this.releasing.has(e.carrierId)) return false;
    // Keep the own motion (relative to the old carrier).
    e.vel.x -= e.carrierVel.x;
    e.vel.y -= e.carrierVel.y;
    e.vel.z -= e.carrierVel.z;
    if (this.heirId !== 0) {
      if (this.heirRec !== undefined) pointVelocity(this.heirRec, e.pos, e.carrierVel);
      // (without a record of the heir the old carrier velocity is the best estimate)
      e.carrierId = this.heirId;
    } else {
      e.carrierVel.x = 0;
      e.carrierVel.y = 0;
      e.carrierVel.z = 0;
      e.carrierId = 0;
    }
    e.vel.x += e.carrierVel.x;
    e.vel.y += e.carrierVel.y;
    e.vel.z += e.carrierVel.z;
    return true;
  }

  /** Let go of the carrier, keeping the world velocity `v` (at most MAX_INHERITED_SPEED). */
  detach(e: Entity, v: Vec3): void {
    if (e.carrierId === 0) return;
    let vx = v.x;
    let vy = v.y;
    let vz = v.z;
    const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (sp > MAX_INHERITED_SPEED) {
      const k = MAX_INHERITED_SPEED / sp;
      vx *= k;
      vy *= k;
      vz *= k;
    }
    e.vel.x = vx;
    e.vel.y = vy;
    e.vel.z = vz;
    e.carrierVel.x = 0;
    e.carrierVel.y = 0;
    e.carrierVel.z = 0;
    e.carrierId = 0;
  }

  /** Turn a body's heading with its carrier (the player's look too). */
  private turn(e: Entity, a: number): void {
    e.yaw += a;
    if (e instanceof Player) {
      e.input.yaw += a;
      e.carriedYaw += a;
    }
  }

  /** Carrier motion applied with world sweeps: a wall scrapes the rider off instead of swallowing it. */
  private carryMove(e: Entity, dx: number, dy: number, dz: number): void {
    const world = this.host.world;
    const b = e.box(this.box1);
    if (dy !== 0) {
      const m = sweepAxis(world, b, 1, dy);
      if (m !== dy) e.carryBlocked = true;
      e.pos.y += m;
      b.minY += m;
      b.maxY += m;
    }
    const xFirst = Math.abs(dx) >= Math.abs(dz);
    for (let k = 0; k < 2; k++) {
      const axis = (k === 0) === xFirst ? 0 : 2;
      const d = axis === 0 ? dx : dz;
      if (d === 0) continue;
      const m = sweepAxis(world, b, axis, d);
      if (m !== d) e.carryBlocked = true;
      if (axis === 0) {
        e.pos.x += m;
        b.minX += m;
        b.maxX += m;
      } else {
        e.pos.z += m;
        b.minZ += m;
        b.maxZ += m;
      }
    }
  }

  // ================================================================== own motion

  /** Start one body's step (tick step 5): clears the facts, ages it, counts down its attach lock. */
  beginStep(e: Entity): void {
    this.facts.reset();
    e.age++;
    if (e.noAttachTicks > 0 && --e.noAttachTicks === 0) e.noAttachStructureId = 0;
  }

  /**
   * Fill e.wet / headWet / inLava where the body is now; returns the share of the body in any
   * liquid (water + lava). Records facts.liquidEntrySpeed when a dry body just got wet.
   */
  sampleFluids(e: Entity): number {
    const wasWet = e.wet;
    this.gatherNear(e, STILL, NEAR_MARGIN);
    this.fluids.sample(e, this.collide.near);
    if (wasWet === 0 && e.wet > 0) this.facts.liquidEntrySpeed = -e.vel.y;
    return e.wet + this.fluids.lavaShare;
  }

  /** Sample the fluids again right after a step, around the structures that step saw (the landing spot of a fall). */
  resampleFluids(e: Entity): void {
    this.fluids.sample(e, this.collide.near);
  }

  /**
   * A player's step from its input (sanitizeInput first; the caller consumed the jump presses):
   * look, flight toggle (double-tap jump, when `mayFly` and not seated), sneak / sprint, fluids,
   * motion, collision, attach / detach, the seat check and the fall bookkeeping (facts.landedFall).
   * A seated player does not move by itself; structures may still push it.
   */
  stepPlayer(p: Player, jumpPresses: number, mayFly: boolean): void {
    const inp = p.input;
    p.yaw = inp.yaw;
    p.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, inp.pitch));
    const seated = p.steeringShipId !== 0;
    // Double-tap jump toggles flight.
    if (!seated && mayFly) {
      for (let i = 0; i < jumpPresses; i++) {
        if (p.age - p.lastJumpPressAge <= FLY_TOGGLE_TICKS) {
          p.flying = !p.flying;
          p.lastJumpPressAge = -1000;
          if (p.flying) p.vel.y = p.carrierVel.y;
        } else {
          p.lastJumpPressAge = p.age;
        }
      }
    }
    p.sneaking = inp.sneak && !p.flying && !seated;
    p.sprinting = inp.sprint && inp.forward > 0 && !p.sneaking && !seated;

    const wasOnGround = p.onGround;
    const fluid = this.sampleFluids(p);
    const rel = this.loadRel(p);
    const d = this.disp;
    let guard = false;
    if (seated) {
      rel.x = rel.y = rel.z = 0;
      d.x = d.y = d.z = 0;
    } else {
      guard = playerMotion(p, rel, fluid, p.inLava, this.wish, d);
    }
    const y0 = p.pos.y;
    this.moveBody(p, guard && !p.flying, !seated && !p.flying);
    let seatedAfter = seated;
    if (seated) {
      p.onGround = true;
      // Pushed far off the seat (a blade swept through the helm): it no longer sits there.
      const r = this.cache.get(p.steeringShipId);
      if (r !== undefined) {
        const s = curToWorld(r, p.seat, this.t1);
        const dx = s.x - p.pos.x;
        const dy = s.y - p.pos.y;
        const dz = s.z - p.pos.z;
        if (dx * dx + dy * dy + dz * dz > SEAT_LEAVE_DISTANCE * SEAT_LEAVE_DISTANCE) {
          this.facts.pushedOffSeat = true;
          seatedAfter = false;
        }
      }
    }
    // Falls and landing. A crush / unstuck relocation is a teleport, not a fall.
    const y1 = p.pos.y - this.facts.relocatedDy;
    const landed = trackFall(p, y1 < y0 ? y0 - y1 : 0, seatedAfter);
    if (landed >= 0) {
      this.facts.landedFall = landed;
      this.facts.landedFromAir = !wasOnGround;
    }
  }

  /**
   * A passive body (item drop, blast crate, falling block): gravity, drag, ground friction and
   * buoyancy (`buoyancy` = upward acceleration when fully submerged), from the liquid share
   * sampleFluids() returned. `verticalOnly` keeps it from moving sideways (a falling block).
   */
  stepPassive(e: Entity, fluid: number, gravity: number, buoyancy: number, verticalOnly: boolean): void {
    const rel = this.loadRel(e);
    passiveMotion(e, rel, fluid, gravity, buoyancy, this.disp);
    if (verticalOnly) {
      rel.x = 0;
      rel.z = 0;
      this.disp.x = 0;
      this.disp.z = 0;
    }
    this.moveBody(e, false);
  }

  /**
   * A body whose velocity the caller chose (creature AI): `rel` is its new velocity relative to
   * its carrier (world axes), (dx, dy, dz) the displacement it wants this tick. It walks (steps up
   * world ledges, onto low structure sides).
   */
  stepWalker(e: Entity, rel: Vec3, dx: number, dy: number, dz: number): void {
    const r = this.rel;
    r.x = rel.x;
    r.y = rel.y;
    r.z = rel.z;
    this.disp.x = dx;
    this.disp.y = dy;
    this.disp.z = dz;
    this.moveBody(e, false, true);
  }

  // ================================================================== queries for the rules

  /**
   * Is a box `depth` below its feet (footprint inset `inset`) supported by a structure near the
   * body's sweep by (dx, dy, dz)? (A creature looking before it hops.)
   */
  structureSupports(e: Entity, d: Readonly<Vec3>, b: AABB, depth: number, inset: number): boolean {
    this.gatherNear(e, d, NEAR_MARGIN);
    return this.collide.supportedByStructure(b, depth, inset);
  }

  /** Records of the structures whose bounds come within `margin` of a box (present poses), innermost first. Reuses `out`. */
  structuresNear(b: AABB, margin: number, out: StructRec[]): StructRec[] {
    return this.cache.near(b, margin, out);
  }

  /**
   * Push a body out of the structures at their present poses without moving it by itself (how
   * the server judges a body it did not move). With `lean` (a world unit vector), deep pushes by
   * structures other than its carrier lean toward it with `leanWeight` (blocks of depth per unit
   * of alignment) instead of toward each structure's motion. Returns the id of a structure that
   * still overlaps the body afterwards — the pushes were blocked — or 0 when it came free (or
   * touched nothing).
   */
  pushOut(e: Entity, lean: Vec3 | null = null, leanWeight = 0): number {
    this.gatherNear(e, STILL, NEAR_MARGIN);
    if (this.collide.near.length === 0) return 0;
    const rel = this.loadRel(e);
    const collide = this.collide;
    collide.setLean(lean, leanWeight);
    try {
      collide.move(e, rel, STILL, false, false);
    } finally {
      collide.setLean(null, 0);
    }
    const r = collide.findOverlap(e);
    return r === null ? 0 : r.id;
  }

  /** Does a hard cell of a structure the last step saw overlap the world cell (x, y, z) (inset by 0.02)? */
  structureInCell(x: number, y: number, z: number): boolean {
    const cb = this.box1;
    cb.minX = x + 0.02;
    cb.minY = y + 0.02;
    cb.minZ = z + 0.02;
    cb.maxX = x + 0.98;
    cb.maxY = y + 0.98;
    cb.maxZ = z + 0.98;
    const near = this.collide.near;
    for (let k = 0; k < near.length; k++) {
      const r = near[k]!;
      if (boxNearRec(cb, r, 0) && boxOverlapsSolid(r.grid, cb)) return true;
    }
    return false;
  }

  // ================================================================== steps b–e

  /** rel := own velocity relative to the carrier. */
  private loadRel(e: Entity): Vec3 {
    const rel = this.rel;
    rel.x = e.vel.x - e.carrierVel.x;
    rel.y = e.vel.y - e.carrierVel.y;
    rel.z = e.vel.z - e.carrierVel.z;
    return rel;
  }

  /** Collect the structures within `margin` of the body (and of its displacement `d` this tick). */
  private gatherNear(e: Entity, d: Readonly<Vec3>, margin: number): void {
    const b = e.box(this.box2);
    if (d.x < 0) b.minX += d.x;
    else b.maxX += d.x;
    if (d.y < 0) b.minY += d.y;
    else b.maxY += d.y;
    if (d.z < 0) b.minZ += d.z;
    else b.maxZ += d.z;
    this.cache.near(b, margin, this.collide.near);
  }

  /** Steps b–e for the displacement already chosen (this.rel / this.disp). */
  private moveBody(e: Entity, sneakGuard: boolean, walker = false): void {
    const d = this.disp;
    const rel = this.rel;
    const facts = this.facts;
    // A walker may step up STEP_HEIGHT: structures that high above must be seen too.
    if (walker) this.gatherNear(e, d, NEAR_MARGIN_WALKER);
    else if (Math.abs(d.x) + Math.abs(d.y) + Math.abs(d.z) > NEAR_MARGIN * 0.5) this.gatherNear(e, d, NEAR_MARGIN);
    const collide = this.collide;
    const x0 = e.pos.x;
    const y0 = e.pos.y;
    const z0 = e.pos.z;
    const wasOnGround = e.onGround;
    const wasOnWorldGround = e.onWorldGround;
    collide.move(e, rel, d, sneakGuard, walker);
    e.onWorldGround = collide.onWorldGround;
    e.onGround = collide.onWorldGround || collide.groundRec !== null;
    e.contactNx = collide.contactNx;
    e.contactNz = collide.contactNz;
    facts.pushBlocked = collide.pushBlocked;
    facts.groundStructureId = collide.groundRec !== null ? collide.groundRec.id : 0;
    // d. squeeze: whatever overlap remains was made by a structure (own motion was taken back).
    let crushed: StructRec | null = null;
    let relocated = false;
    if (collide.near.length > 0) {
      crushed = collide.findOverlap(e);
      if (crushed !== null) {
        facts.crushedBy = crushed.id;
        if (this.relocates) relocated = this.unstick(e, CRUSH_SEARCH_RADIUS);
        else {
          // Not relocating (a client): the body is held where the carry left it, standing as it
          // stood, until the server decides. Letting the rest of this step act on it would drop
          // it through the floor of the very structure that squeezes it: a refused push ends
          // the resolution of that structure, its floor included.
          e.pos.x = x0;
          e.pos.y = y0;
          e.pos.z = z0;
          e.onGround = wasOnGround;
          e.onWorldGround = wasOnWorldGround;
          rel.x = 0;
          rel.y = 0;
          rel.z = 0;
        }
      }
    }
    if (crushed === null) {
      if (collide.inWorldBlock(e)) {
        // Something put a world block into the body (placed, landed, blockified): step aside.
        if (this.relocates) relocated = this.unstick(e, UNSTUCK_SEARCH_RADIUS);
        if (!relocated) facts.stuckInWorld = true;
      } else {
        e.unstuckFails = 0;
        e.unstuckWait = 0;
      }
    }
    facts.relocated = relocated;
    // The attach step looks at the structures around the body where it is NOW.
    if (relocated) this.gatherNear(e, STILL, NEAR_MARGIN);
    // e. attach / detach
    this.updateCarrier(e);
    e.vel.x = rel.x + e.carrierVel.x;
    e.vel.y = rel.y + e.carrierVel.y;
    e.vel.z = rel.z + e.carrierVel.z;
  }

  /**
   * Free a body that overlaps the world or a structure: nearest free spot within `radius`; a
   * buried passive body (no free spot nearby) rises to the first free spot above it. A failed
   * attempt backs off (2^failures ticks, at most UNSTUCK_MAX_BACKOFF_TICKS): a body deep in rock
   * must not run a full lattice search every tick (review finding: ~0.26 ms per buried drop).
   */
  unstick(e: Entity, radius: number): boolean {
    if (e.unstuckWait > 0) {
      e.unstuckWait--;
      return false;
    }
    if (this.relocate(e, radius) || (!(e instanceof Player) && this.riseOut(e))) {
      e.unstuckFails = 0;
      return true;
    }
    const f = e.unstuckFails < 16 ? e.unstuckFails : 16;
    e.unstuckFails = f + 1;
    const wait = 1 << f;
    e.unstuckWait = wait < UNSTUCK_MAX_BACKOFF_TICKS ? wait : UNSTUCK_MAX_BACKOFF_TICKS;
    return false;
  }

  /**
   * Move the body to the nearest spot free of the world and of EVERY structure the search can
   * reach — the same overlap test as pushing (LESSONS 挪到空位后立刻又被挤). The structures are
   * gathered over the whole search radius: collide.near only covers NEAR_MARGIN, and a spot
   * inside a structure 1–3 blocks away would be crushed again at once (review finding).
   */
  private relocate(e: Entity, radius: number): boolean {
    const b = e.box(this.box1);
    const reach = this.cache.near(b, radius, this.relocNear);
    const grids = this.grids;
    grids.length = 0;
    grids.push(this.host.world);
    for (let k = 0; k < reach.length; k++) grids.push(reach[k]!.grid);
    const off = nearestFreeOffset(grids, b, radius);
    if (off === null) return false;
    this.teleportBy(e, off.x, off.y, off.z);
    return true;
  }

  /**
   * A buried passive body rises straight up to the first spot on the half-cell lattice free of
   * the world and of every structure, at most BURIED_RISE_LIMIT blocks (drops of a windmill
   * blockified inside a hill pop out on top of it, ACCEPTANCE 12; on top of a half slab, not half
   * a block above it: docs/SHAPES.md 5.9). Cheap: one world range test per half layer.
   */
  private riseOut(e: Entity): boolean {
    const col = e.box(this.box1);
    col.maxY += BURIED_RISE_LIMIT;
    const reach = this.cache.near(col, 0, this.relocNear);
    const world = this.host.world;
    const y0 = e.pos.y;
    const base = Math.floor(y0 * 2);
    const b = this.box3;
    for (let k = 1; k <= 2 * BURIED_RISE_LIMIT; k++) {
      const fy = (base + k) / 2;
      boxAt(e, e.pos.x, fy, e.pos.z, b);
      if (boxOverlapsSolid(world, b)) continue;
      let free = true;
      for (let j = 0; j < reach.length && free; j++) {
        const r = reach[j]!;
        if (boxNearRec(b, r, 0) && boxOverlapsSolid(r.grid, b)) free = false;
      }
      if (!free) continue;
      this.teleportBy(e, 0, fy - y0, 0);
      return true;
    }
    return false;
  }

  /** Displace a body that was squeezed / dug out: a teleport, not a fall, and no velocity survives. */
  private teleportBy(e: Entity, dx: number, dy: number, dz: number): void {
    e.pos.x += dx;
    e.pos.y += dy;
    e.pos.z += dz;
    this.facts.relocatedDy += dy;
    // Stand still relative to the carrier.
    this.rel.x = 0;
    this.rel.y = 0;
    this.rel.z = 0;
  }

  /**
   * Step e (DESIGN 携带): carried only while a cell of the structure is under the feet.
   *  - landed on a world block -> detach;
   *  - standing on a structure (attach probe, innermost first) -> that structure;
   *  - airborne with a carrier -> keep it while its column under the footprint holds a cell
   *    (jumping on a deck keeps you with the ship), else its parent's, else detach.
   *    Swimmers are never kept (ACCEPTANCE 19: a swimmer next to a hull is never picked up).
   * Attaching needs the inset probe (strictly inside the push range); KEEPING an existing
   * carrier — standing or airborne over its column — uses the plain footprint (inset 0), so a
   * rider who stands at the very edge and jumps comes down with the ship.
   */
  private updateCarrier(e: Entity): void {
    const flying = e instanceof Player && e.flying;
    if (e.onWorldGround || (flying && !e.onGround)) {
      this.detachRel(e);
      return;
    }
    const b = e.box(this.box1);
    const inset = attachInset(e);
    const near = this.collide.near;
    let stand: StructRec | null = null;
    for (let k = 0; k < near.length; k++) {
      const r = near[k]!;
      if (this.attachBlocked(e, r)) continue;
      if (b.minY - SUPPORT_GAP >= r.maxY || b.minY <= r.minY) continue;
      if (hasSupportBelow(r.grid, b, SUPPORT_GAP, inset)) {
        stand = r;
        break;
      }
    }
    const cur = e.carrierId !== 0 ? this.cache.get(e.carrierId) : undefined;
    // Hysteresis: once attached, plain standing (inset 0) keeps the carrier.
    if (stand === null && cur !== undefined && e.onGround && !this.attachBlocked(e, cur) && hasSupportBelow(cur.grid, b, SUPPORT_GAP, 0)) {
      stand = cur;
    }
    if (stand !== null) {
      this.setCarrier(e, stand);
      return;
    }
    const swimming = e.wet >= SWIMMING_WET && !e.onGround;
    if (cur !== undefined && !flying && !swimming) {
      for (let r: StructRec | null = cur; r !== null; r = r.parent) {
        if (columnHasSolidBelow(r.grid, b, COLUMN_DEPTH, 0)) {
          this.setCarrier(e, r);
          return;
        }
      }
    }
    this.detachRel(e);
  }

  private attachBlocked(e: Entity, r: StructRec): boolean {
    return e.noAttachTicks > 0 && (e.noAttachStructureId === 0 || e.noAttachStructureId === r.id);
  }

  /** Switch carrier keeping the world velocity continuous. */
  private setCarrier(e: Entity, r: StructRec): void {
    if (e.carrierId === r.id) return;
    const rel = this.rel;
    const vx = rel.x + e.carrierVel.x;
    const vy = rel.y + e.carrierVel.y;
    const vz = rel.z + e.carrierVel.z;
    pointVelocity(r, e.pos, e.carrierVel);
    rel.x = vx - e.carrierVel.x;
    rel.y = vy - e.carrierVel.y;
    rel.z = vz - e.carrierVel.z;
    e.carrierId = r.id;
  }

  /** Detach during a step: the working relative velocity becomes the world velocity. */
  private detachRel(e: Entity): void {
    if (e.carrierId === 0) return;
    const rel = this.rel;
    const v = this.t2;
    v.x = rel.x + e.carrierVel.x;
    v.y = rel.y + e.carrierVel.y;
    v.z = rel.z + e.carrierVel.z;
    this.detach(e, v);
    rel.x = e.vel.x;
    rel.y = e.vel.y;
    rel.z = e.vel.z;
  }
}
