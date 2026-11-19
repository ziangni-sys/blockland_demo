/**
 * ShipDynamics implementation: the tick driver.
 *
 * Per step():
 *   1. refresh derived data of every ship and read its start-of-tick pose. Ships with no hard
 *      cell are held motionless (they can neither collide nor float).
 *   2. rotor views: shape, spin over the tick, swept box.
 *   3. sub-step count: `substeps`, more while a rotor whose blades travel farther than
 *      maxSubstepTravel per sub-step can reach a ship (up to maxSubsteps).
 *   4. classify: frozen ships and ships whose surroundings are not loaded become immovable
 *      obstacles (LESSONS 船被弹飞); sleeping ships stay asleep unless disturbed.
 *   5. sleepers near something that moves (a rotor's sweep, a moving or rotor-driven ship, a ship
 *      whose cells just changed) wake; a sleeper next to a quiet awake ship joins its solve as an
 *      immovable obstacle instead.
 *   6. per awake ship: copy the world around it into its WorldPatch, list rotors in reach.
 *   7. n sub-steps, all ships in lock-step:
 *        forces (gravity, buoyancy, drag, keel, thrust, rudder) -> velocities, clamped
 *        contacts at the start-of-sub-step poses (rotors interpolated to alpha = k/n)
 *        rotor contacts driving a ship into its own supports: redirected or blocked; terrain /
 *        ships the blades press a ship into: frictionless; ships held behind it: immovable
 *        sequential impulses (rotor / ship contacts first, terrain last)
 *        pinning check -> pinned (ship, rotor) pairs drop out; jammed contacts of the other pairs
 *        too (pinning.ts); re-solve
 *        split-impulse penetration recovery, then integrate the poses
 *   8. write back, destroy at most one pinned hull part per ship, refresh, sleep bookkeeping.
 *
 * Nothing here reads a clock or a random source: identical inputs give identical results.
 * Iteration orders are those of the input arrays and of the cell storage.
 */
import { TICK_DT } from '../../core/constants';
import { qnormalize, qtoMat3, quat, vec3, type Vec3 } from '../../core/math';
import { HOLES_SHIFT, ID_MASK } from '../../blocks/cell';
import { BLOCKS } from '../../blocks/registry';
import { DROP_POINT } from '../../blocks/shapes';
import { removePartAt } from '../../voxel/parts';
import type { Rotor, Ship, ShipDynamics, StructureHost } from '../structure';
import { Body, MODE_ACTIVE, MODE_NONE, type ShipPhysicsStats } from './body';
import { applyBuoyancy } from './buoyancy';
import { ContactGenerator, ContactSet } from './contacts';
import * as CR from './contacts';
import { applyHydrodynamics } from './hydro';
import { mat3Congruence } from './mat3';
import { refreshShip } from './massprops';
import { resolveOptions, type DynamicsOptions, type ResolvedOptions } from './options';
import { bladePresses, PinDetector, SupportQuery } from './pinning';
import { RotorView } from './rotorview';
import { Islands, isQuiet, putToSleep, updateRest, wakeShip } from './sleep';
import { prepareContacts, solvePositionPass, solveVelocityPass } from './solver';

// Contact record offsets as module constants (hot loops; see solver.ts).
const F_A = CR.F_A;
const F_B = CR.F_B;
const F_DEPTH = CR.F_DEPTH;
const F_FIX = CR.F_FIX;
const FIX_A = CR.FIX_A;
const FIX_B = CR.FIX_B;
const FIX_CONFLICT = CR.FIX_CONFLICT;
const FIX_NONE = CR.FIX_NONE;
const F_LN = CR.F_LN;
const F_MU = CR.F_MU;
const F_NX = CR.F_NX;
const F_PIN = CR.F_PIN;
const PIN_PINNED = CR.PIN_PINNED;
const PIN_BLOCKED = CR.PIN_BLOCKED;
const PIN_REDIRECTED = CR.PIN_REDIRECTED;
const PIN_STALE = CR.PIN_STALE;
const PIN_CUTTING = CR.PIN_CUTTING;
const F_SRC = CR.F_SRC;
const F_VO = CR.F_VO;
const STRIDE = CR.STRIDE;

/** World cells copied around a ship beyond its box: its travel this tick plus this many. */
const PATCH_EXTRA = 3;
/** Unloaded columns this close to a ship's box freeze it (at least; more when it can travel farther). */
const LOADED_MARGIN = 3;
/** A sleeping ship wakes when a moving rotor's swept box comes this close (blocks). */
const ROTOR_WAKE_MARGIN = 0.25;
/**
 * Terrain contacts whose normal opposes a pressing blade's motion by more than this (cosine)
 * are frictionless for the sub-step. Against an infinitely strong blade, Coulomb friction from
 * the terrain the blade presses the ship into grows without bound: with the default 0.6 it would
 * jam a ship pushed up to 31 degrees off the wall's normal, up to 48 together with the blade's own
 * friction, so the ship could neither slide away (as LESSONS 能动的船被误判压坏 demands for
 * anything outside the 25-degree pin cone) nor be pinned, and the blade would cut into its hull.
 * Without that friction — the supports' and, on that ship, the blade's own — the pin cone alone
 * decides: inside it the ship is held and pinned, outside it the blade slides the ship along the
 * terrain. Ground under a ship pushed sideways (normal across the push) keeps its friction. The
 * same goes for the pushed ship's contacts with other ships.
 */
const FRICTION_RELEASE = 0.2;
/**
 * A rotor contact counts as driving the ship straight into its supports (blocked / redirected,
 * see prepareDriven) only within this cone (cosine, ~11.5 degrees) of exactly opposing them.
 * Anything wider can still be met — the ship slides along the support, fast near the pin cone —
 * and is left to the pin test. A cone as wide as the pin cone would block the face contacts of
 * a blade whose own motion lies just outside it (face normal and point velocity differ by a few
 * degrees), so the blade would dig in without pinning or pushing.
 */
const BLOCK_COS = 0.98;

export class ShipDynamicsImpl implements ShipDynamics {
  readonly options: ResolvedOptions;
  private readonly host: StructureHost;
  private readonly bodyMap = new WeakMap<Ship, Body>();
  private readonly viewMap = new WeakMap<Rotor, RotorView>();
  /** Ships with hard cells seen this step, in input order. */
  private readonly considered: Body[] = [];
  /** Ships whose cells or rotors changed since the previous step (incl. ones left without hard cells). */
  private readonly changedBodies: Body[] = [];
  /** Bodies taking part in this tick's solve (active + static), indexed by body.index. */
  private readonly bodies: Body[] = [];
  private readonly active: Body[] = [];
  private readonly sleeping: Body[] = [];
  /** Sleepers next to quiet awake ships: immovable obstacles in this tick's solve. */
  private readonly sleepersInSolve: Body[] = [];
  private readonly islands = new Islands();
  private islandMin = new Int32Array(16);
  private readonly views: RotorView[] = [];
  private readonly pairs: number[] = [];
  private readonly kin = new ContactSet();
  private readonly ter = new ContactSet();
  private readonly gen = new ContactGenerator();
  private readonly pins = new PinDetector();
  private readonly supports = new SupportQuery();
  private readonly blockQuery = new SupportQuery();
  private readonly mR = new Float64Array(9);
  private readonly mI = new Float64Array(9);
  private readonly mT = new Float64Array(9);
  private readonly cellCentre: Vec3 = vec3();
  /** Incremented every step; a body's mode is only meaningful when its stamp matches. */
  private stamp = 0;
  private substepCount = 0;

  constructor(host: StructureHost, opts?: DynamicsOptions) {
    this.host = host;
    this.options = resolveOptions(opts);
    this.substepCount = this.options.substeps;
  }

  /** Sub-steps the last step() used (more than options.substeps while a fast rotor was in reach). */
  get lastSubsteps(): number {
    return this.substepCount;
  }

  // ------------------------------------------------------------------ ShipDynamics

  refresh(ship: Ship): void {
    const b = this.bodyOf(ship);
    if (refreshShip(ship, b, this.options)) {
      b.changed = true;
      wakeShip(ship);
    }
  }

  wake(ship: Ship): void {
    wakeShip(ship);
  }

  applyImpulse(ship: Ship, worldPoint: Vec3, impulse: Vec3): void {
    if (ship.removed) return;
    this.refresh(ship);
    const b = this.bodyOf(ship);
    if (b.mass <= 0 || b.shape.solidCount === 0) return;
    const g = ship.grid;
    const im = b.invMass;
    g.linearVelocity.x += impulse.x * im;
    g.linearVelocity.y += impulse.y * im;
    g.linearVelocity.z += impulse.z * im;
    const rx = worldPoint.x - g.position.x;
    const ry = worldPoint.y - g.position.y;
    const rz = worldPoint.z - g.position.z;
    const tx = ry * impulse.z - rz * impulse.y;
    const ty = rz * impulse.x - rx * impulse.z;
    const tz = rx * impulse.y - ry * impulse.x;
    const q = qnormalize(g.rotation, quat());
    qtoMat3(q, this.mR);
    mat3Congruence(this.mR, b.invIl, this.mT, this.mI);
    const I = this.mI;
    g.angularVelocity.x += I[0]! * tx + I[1]! * ty + I[2]! * tz;
    g.angularVelocity.y += I[3]! * tx + I[4]! * ty + I[5]! * tz;
    g.angularVelocity.z += I[6]! * tx + I[7]! * ty + I[8]! * tz;
    wakeShip(ship);
  }

  step(ships: readonly Ship[], rotors: readonly Rotor[]): void {
    const o = this.options;
    const bodies = this.bodies;
    const active = this.active;
    const sleeping = this.sleeping;
    const cands = this.considered;
    const changed = this.changedBodies;
    bodies.length = 0;
    active.length = 0;
    sleeping.length = 0;
    cands.length = 0;
    changed.length = 0;
    const stamp = ++this.stamp;

    // ---- 1. refresh, start-of-tick poses
    for (let i = 0; i < ships.length; i++) {
      const ship = ships[i]!;
      if (ship.removed) continue;
      const b = this.bodyOf(ship);
      if (refreshShip(ship, b, o)) {
        wakeShip(ship);
        b.changed = true;
      }
      b.resetTickStats();
      b.stamp = stamp;
      b.mode = MODE_NONE;
      b.index = -1;
      // A changed ship wakes sleepers near where it was and where it is now (the old box covers
      // cells that just disappeared, e.g. a deck mined under a resting boat).
      if (b.changed) {
        b.beginChangedBox();
        changed.push(b);
      }
      if (b.mass <= 0 || b.shape.solidCount === 0) {
        holdInert(b);
        continue;
      }
      b.loadPose();
      if (b.changed) b.extendChangedBox();
      cands.push(b);
    }

    // ---- 2. rotor views
    const views = this.views;
    views.length = 0;
    for (let i = 0; i < rotors.length; i++) {
      const r = rotors[i]!;
      if (r.removed || r.grid.count === 0) continue;
      let view = this.viewMap.get(r);
      if (view === undefined) {
        view = new RotorView(r);
        this.viewMap.set(r, view);
      }
      view.beginTick();
      views.push(view);
    }

    // ---- 3. sub-steps for this tick
    const n = this.chooseSubsteps(cands);
    this.substepCount = n;
    const dt = TICK_DT / n;
    const invDt = 1 / dt;
    const travel = n * o.maxSubstepTravel; // farthest any hull point can move this tick

    // ---- 4. classify
    for (let i = 0; i < cands.length; i++) {
      const b = cands[i]!;
      const ship = b.ship;
      if (ship.frozen || !this.surroundingsLoaded(b, travel)) {
        b.stats.frozen = true;
        b.makeStatic();
        b.index = bodies.length;
        bodies.push(b);
        continue;
      }
      // Helm input, or game code that moved / pushed the ship since we put it to sleep.
      if (ship.asleep && (ship.throttle !== 0 || ship.rudder !== 0 || b.disturbedSinceWrite())) wakeShip(ship);
      if (ship.asleep) sleeping.push(b);
      else this.activate(b);
    }
    for (let k = 0; k < views.length; k++) views[k]!.attachParent(this.activeParent(views[k]!.rotor));
    for (let i = 0; i < active.length; i++) active[i]!.rotorNear = this.rotorInReach(active[i]!, travel);

    // ---- 5. wake sleepers disturbed by something that moves; a sleeper next to a quiet awake
    // ship joins the solve as an immovable obstacle instead
    const inSolve = this.sleepersInSolve;
    inSolve.length = 0;
    for (let i = 0; i < sleeping.length; i++) {
      const sb = sleeping[i]!;
      let disturb = false;
      let near = false;
      for (let k = 0; k < views.length && !disturb; k++) {
        const v = views[k]!;
        if (v.rotor.parent === sb.ship || !v.moving || v.shape.solidCount === 0) continue;
        const m = ROTOR_WAKE_MARGIN + (v.parentBody !== null ? travel : 0);
        if (v.sweptNear(sb.minX, sb.minY, sb.minZ, sb.maxX, sb.maxY, sb.maxZ, m)) disturb = true;
      }
      for (let k = 0; k < changed.length && !disturb; k++) {
        const cb = changed[k]!;
        if (cb !== sb && cb.changedBoxNear(sb, 1 + travel)) disturb = true;
      }
      for (let k = 0; k < active.length && !disturb; k++) {
        const ab = active[k]!;
        if (!boxesOverlap(ab, sb, 1 + travel)) continue;
        near = true;
        if (!isQuiet(ab, o) || ab.rotorNear) disturb = true;
      }
      if (disturb) {
        wakeShip(sb.ship);
        this.activate(sb);
        sb.rotorNear = this.rotorInReach(sb, travel);
      } else if (near) {
        sb.makeStatic();
        sb.index = bodies.length;
        bodies.push(sb);
        inSolve.push(sb);
      }
    }
    for (let k = 0; k < changed.length; k++) changed[k]!.changed = false;
    // rotors riding on a ship woken just now move with it this tick
    for (let k = 0; k < views.length; k++) {
      const v = views[k]!;
      if (v.parentBody === null) v.attachParent(this.activeParent(v.rotor));
    }

    // ---- 6. per-tick setup of awake ships
    const world = this.host.world;
    const margin = Math.ceil(travel) + PATCH_EXTRA;
    for (let i = 0; i < active.length; i++) {
      const b = active[i]!;
      b.stats.simulated = true;
      b.patch.fill(
        world,
        Math.floor(b.minX) - margin,
        Math.floor(b.minY) - margin,
        Math.floor(b.minZ) - margin,
        Math.floor(b.maxX) + margin,
        Math.floor(b.maxY) + margin,
        Math.floor(b.maxZ) + margin,
      );
      // terrain edge corners the hull can reach this tick
      const reach = travel + 0.5;
      b.patch.collectCorners(
        Math.floor(b.minX - reach),
        Math.floor(b.minY - reach),
        Math.floor(b.minZ - reach),
        Math.ceil(b.maxX + reach),
        Math.ceil(b.maxY + reach),
        Math.ceil(b.maxZ + reach),
      );
      b.selectTerrainCandidates(travel);
      const cand = b.rotorCandidates;
      cand.length = 0;
      for (let k = 0; k < views.length; k++) {
        const v = views[k]!;
        if (v.rotor.parent === b.ship || v.shape.solidCount === 0) continue;
        const m = travel + 0.5 + (v.parentBody !== null ? travel : 0);
        if (!v.sweptNear(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, m)) continue;
        cand.push(k);
        v.used = true;
      }
    }
    const pairs = this.pairs;
    pairs.length = 0;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i]!;
        const c = bodies[j]!;
        if (a.mode !== MODE_ACTIVE && c.mode !== MODE_ACTIVE) continue;
        if (boxesOverlap(a, c, travel * 2 + 1)) pairs.push(i, j);
      }
    }

    // ---- 7. sub-steps
    this.islands.reset(bodies.length);
    if (active.length > 0) {
      for (let k = 0; k < n; k++) this.substep(k / n, (k + 1) / n, dt, invDt);
    }

    // ---- 8. finish
    for (let i = 0; i < active.length; i++) active[i]!.writeBack();
    for (let i = 0; i < active.length; i++) {
      const b = active[i]!;
      if (b.pinHas) this.destroyPinnedCell(b);
    }
    for (let i = 0; i < active.length; i++) {
      const b = active[i]!;
      b.stats.submerged = b.submerged;
      if (refreshShip(b.ship, b, o)) {
        wakeShip(b.ship);
        b.changed = true; // its neighbours hear about it next tick
      }
      updateRest(b, o);
    }
    // a sleeper pushed hard enough to leave the sleep band wakes for the next tick
    for (let i = 0; i < inSolve.length; i++) {
      const sb = inSolve[i]!;
      if (sb.shipImpulseThisTick * sb.invMass > o.sleepLinearSpeed) wakeShip(sb.ship);
    }
    // islands fall asleep together, once every member has rested long enough
    this.sleepIslands(o.sleepTicks);
    for (let i = 0; i < active.length; i++) active[i]!.rememberPose();
  }

  private sleepIslands(sleepTicks: number): void {
    const active = this.active;
    const isl = this.islands;
    const n = this.bodies.length;
    if (this.islandMin.length < n) this.islandMin = new Int32Array(n * 2);
    const min = this.islandMin;
    min.fill(0x7fffffff, 0, n);
    for (let i = 0; i < active.length; i++) {
      const b = active[i]!;
      const r = isl.find(b.index);
      if (b.ship.restTicks < min[r]!) min[r] = b.ship.restTicks;
    }
    for (let i = 0; i < active.length; i++) {
      const b = active[i]!;
      if (min[isl.find(b.index)]! >= sleepTicks) putToSleep(b);
    }
  }

  // ------------------------------------------------------------------ extras

  /** What happened to `ship` during the last step, or null if the dynamics never saw it. */
  getStats(ship: Ship): Readonly<ShipPhysicsStats> | null {
    const b = this.bodyMap.get(ship);
    return b !== undefined ? b.stats : null;
  }

  // ------------------------------------------------------------------ internals

  private bodyOf(ship: Ship): Body {
    let b = this.bodyMap.get(ship);
    if (b === undefined) {
      b = new Body(ship);
      this.bodyMap.set(ship, b);
    }
    return b;
  }

  /** Body of the ship a rotor rides on, when that ship is simulated in this step. */
  private activeParent(r: Rotor): Body | null {
    const p = r.parent;
    if (p === null) return null;
    const pb = this.bodyMap.get(p as Ship);
    return pb !== undefined && pb.stamp === this.stamp && pb.mode === MODE_ACTIVE ? pb : null;
  }

  private activate(b: Body): void {
    b.mode = MODE_ACTIVE;
    b.index = this.bodies.length;
    this.bodies.push(b);
    this.active.push(b);
  }

  /**
   * Sub-steps for this tick: options.substeps, raised while a spinning rotor that could reach a
   * (not frozen) ship moves its blades farther than maxSubstepTravel per sub-step — a long
   * windmill's tips outrun both the contact generation and the hull's speed clamp otherwise.
   */
  private chooseSubsteps(cands: readonly Body[]): number {
    const o = this.options;
    let n = o.substeps;
    if (o.maxSubsteps <= n) return n;
    const reachMax = o.maxSubsteps * o.maxSubstepTravel + 1;
    const views = this.views;
    for (let k = 0; k < views.length; k++) {
      const v = views[k]!;
      if (!v.spinning || v.shape.solidCount === 0) continue;
      const need = Math.ceil(v.travel / o.maxSubstepTravel - 1e-9);
      if (need <= n) continue;
      const pm = v.rotor.parent !== null ? reachMax : 0; // the carrier ship moves too
      for (let i = 0; i < cands.length; i++) {
        const b = cands[i]!;
        if (b.ship.frozen || v.rotor.parent === b.ship) continue;
        // a sleeping ship is only touched if the sweep itself comes this close (it stays put)
        const m = (b.ship.asleep ? ROTOR_WAKE_MARGIN + 1 : reachMax) + pm;
        if (v.sweptNear(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, m)) {
          n = need;
          break;
        }
      }
    }
    return n < o.maxSubsteps ? n : o.maxSubsteps;
  }

  /** Can a moving rotor (not mounted on this ship) reach the body this tick? */
  private rotorInReach(b: Body, travel: number): boolean {
    const views = this.views;
    for (let k = 0; k < views.length; k++) {
      const v = views[k]!;
      if (v.rotor.parent === b.ship || !v.moving || v.shape.solidCount === 0) continue;
      const m = travel + 0.5 + (v.parentBody !== null ? travel : 0);
      if (v.sweptNear(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, m)) return true;
    }
    return false;
  }

  private surroundingsLoaded(b: Body, travel: number): boolean {
    const m = Math.max(LOADED_MARGIN, Math.ceil(travel) + 1);
    return this.host.world.isAreaLoaded(b.minX - m, b.minZ - m, b.maxX + m, b.maxZ + m);
  }

  private substep(a0: number, a1: number, dt: number, invDt: number): void {
    const o = this.options;
    const active = this.active;
    const bodies = this.bodies;
    const views = this.views;
    const kin = this.kin;
    const ter = this.ter;
    const gen = this.gen;
    const rhoG = o.waterDensity * o.gravity;

    // forces -> velocities
    for (let i = 0; i < active.length; i++) {
      const b = active[i]!;
      b.updateFrame();
      applyBuoyancy(b, rhoG, dt);
      b.vy -= o.gravity * dt;
      applyHydrodynamics(b, o, dt);
      b.clampVelocity(o.maxSubstepTravel, dt);
    }
    for (let i = 0; i < views.length; i++) {
      const v = views[i]!;
      if (v.used) v.updateFrames(a0, a1);
    }

    // contacts
    kin.clear();
    ter.clear();
    for (let i = 0; i < active.length; i++) {
      const b = active[i]!;
      b.terStart = ter.count;
      gen.terrain(b, ter, o.terrainFriction);
      gen.reduce(ter, b.terStart, o.maxContactsPerNormal);
      b.terEnd = ter.count;
      b.kinStart = kin.count;
      const cand = b.rotorCandidates;
      for (let k = 0; k < cand.length; k++) {
        const vi = cand[k]!;
        const start = kin.count;
        gen.rotor(b, views[vi]!, vi, kin, o.rotorFriction, invDt);
        gen.reduce(kin, start, o.maxContactsPerNormal); // per rotor: each keeps its own manifold
        if (kin.count > start && views[vi]!.moving) b.rotorTouchThisTick = true;
      }
      b.kinEnd = kin.count;
      const st = b.stats;
      st.terrainContacts = b.terEnd - b.terStart;
      st.rotorContacts = b.kinEnd - b.kinStart;
      st.shipContacts = 0;
    }
    // kin holds every body's rotor contacts first (grouped by ship, then rotor), then ship/ship
    // contacts from here on.
    const shipStart = kin.count;
    const pairs = this.pairs;
    for (let p = 0; p < pairs.length; p += 2) {
      const start = kin.count;
      gen.ships(bodies[pairs[p]!]!, bodies[pairs[p + 1]!]!, kin, o.shipFriction);
      gen.reduce(kin, start, o.maxContactsPerNormal);
    }
    this.contactStats(shipStart);

    const anyContacts = kin.count + ter.count > 0;
    if (anyContacts) {
      if (shipStart > 0) this.prepareDriven(shipStart);
      prepareContacts(kin, bodies, invDt, o.slop, o.correctionRate, o.maxCorrectionSpeed);
      prepareContacts(ter, bodies, invDt, o.slop, o.correctionRate, o.maxCorrectionSpeed);
      for (let i = 0; i < active.length; i++) active[i]!.snapshotVelocity();
      this.solveVelocities();
      if (shipStart > 0) {
        // there are rotor contacts: check them for pinning, then for jams in the other pairs
        const pinned = this.pins.detect(kin, ter, shipStart, bodies, o);
        if (pinned > 0) this.countPinned(shipStart);
        const jammed = this.pins.jam(kin, ter, shipStart, bodies, o);
        if (pinned > 0 || jammed > 0) {
          for (let i = 0; i < active.length; i++) active[i]!.restoreVelocity();
          // A pinned or jammed blade drives nothing: friction and two-sided ship contacts come back
          // unless another blade still drives the ship (a hull hitting the wall must not keep
          // sliding along it).
          const tf = ter.f;
          for (let i = 0; i < ter.count; i++) tf[i * STRIDE + F_MU] = o.terrainFriction;
          const kf = kin.f;
          for (let i = shipStart; i < kin.count; i++) {
            kf[i * STRIDE + F_MU] = o.shipFriction;
            kf[i * STRIDE + F_FIX] = FIX_NONE;
          }
          this.prepareDriven(shipStart);
          prepareContacts(kin, bodies, invDt, o.slop, o.correctionRate, o.maxCorrectionSpeed);
          prepareContacts(ter, bodies, invDt, o.slop, o.correctionRate, o.maxCorrectionSpeed);
          this.solveVelocities();
        }
      }
      this.supportStats(shipStart);
    }
    for (let i = 0; i < active.length; i++) active[i]!.clampVelocity(o.maxSubstepTravel, dt);
    if (anyContacts) {
      for (let it = 0; it < o.positionIterations; it++) {
        solvePositionPass(kin, bodies);
        solvePositionPass(ter, bodies);
      }
    }
    for (let i = 0; i < active.length; i++) active[i]!.integrate(o.maxSubstepTravel, dt);
  }

  private solveVelocities(): void {
    const its = this.options.velocityIterations;
    for (let it = 0; it < its; it++) {
      solveVelocityPass(this.kin, this.bodies);
      solveVelocityPass(this.ter, this.bodies);
    }
  }

  /**
   * Before a solve, for every ship with rotor contacts:
   *  - a (ship, rotor) pair with a stale contact is CUTTING: the blade is more than half a cell
   *    inside the hull (it cut in while the ship was pinned), so it is passing through, not
   *    pushing — none of the pair's contacts transfers anything. The few that are still shallow
   *    sit on trailing faces or deep inside a half-destroyed hull, and alone they only fling it
   *    about. The pin test still sees them: while the ship stays held, cells keep breaking.
   *  - a rotor contact whose blade drives into it (vo . n > 0) along a normal that the ship's own
   *    supports oppose almost exactly (the pin test's support rule, BLOCK_COS) cannot be met:
   *    typically a blade edge or
   *    corner pressing a hull face whose other side lies against a wall, while the blade itself
   *    moves obliquely. Handed to the solver as is, it only jams the ship and spins it about the
   *    contact. It is REDIRECTED instead: its normal becomes the blade's velocity without the
   *    blocked component, vo - (vo . n) n, and acts on the linear velocity only (through the
   *    centre of mass, no positional correction, no friction): the blade drags the ship along
   *    the wall at its own speed along it, which is the escape LESSONS 能动的船被误判压坏 describes,
   *    without spinning it about a point on its far side. When nothing usable is left (the blade moves straight into the support, or the
   *    remaining direction is blocked too, as in a corner) it is BLOCKED: it transfers nothing,
   *    and the pin test, in which it still takes part, pins the pair.
   * Then, for every ship that a driving blade contact (active or redirected) presses (pinning
   * condition 1a), with d the blades' direction of motion,
   *  - its contacts that oppose d, with terrain and with other ships, become frictionless (see
   *    FRICTION_RELEASE): outside the pin cone the blade slides the ship along them; so do its
   *    driving rotor contacts then (the ship slides along the blade face as well);
   *  - its contacts with another ship it presses that way are one-sided (F_FIX, see solver.ts):
   *    if that ship cannot give way along the contact's normal (held by terrain, a frozen ship
   *    ... — the pin test's support rule) it is the immovable side and the driven hull slides
   *    along it instead of being squeezed into it; if it can, the DRIVEN ship is the immovable
   *    side — a blade drives it with unlimited force, so the other ship has to make way rather
   *    than shove it back into the blade. Both sides asking (two driven ships) leaves the contact
   *    two-sided.
   * The held ships keep their own friction: they are held, not driven, and a frictionless wedge
   * between an infinitely strong blade and a wall would squeeze them out at any speed.
   */
  private prepareDriven(shipStart: number): void {
    const active = this.active;
    const bodies = this.bodies;
    const kin = this.kin;
    const kf = kin.f;
    const tf = this.ter.f;
    const ratio = this.options.pinPressRatio;
    const sup = this.supports;
    sup.configure(this.options.pinOpposeCos);
    const blk = this.blockQuery;
    blk.configure(Math.max(BLOCK_COS, this.options.pinOpposeCos));
    const ter = this.ter;
    for (let i = 0; i < active.length; i++) {
      const b = active[i]!;
      if (b.kinEnd <= b.kinStart) continue;
      // cutting pairs: contacts of one (ship, rotor) pair are contiguous
      let k0 = b.kinStart;
      while (k0 < b.kinEnd) {
        const src = kf[k0 * STRIDE + F_SRC];
        let k1 = k0;
        let stale = false;
        while (k1 < b.kinEnd && kf[k1 * STRIDE + F_SRC] === src) {
          if (kf[k1 * STRIDE + F_PIN] === PIN_STALE) stale = true;
          k1++;
        }
        if (stale) for (let k = k0; k < k1; k++) if (kf[k * STRIDE + F_PIN] === 0) kf[k * STRIDE + F_PIN] = PIN_CUTTING;
        k0 = k1;
      }
      for (let k = b.kinStart; k < b.kinEnd; k++) {
        const c = k * STRIDE;
        if (kf[c + F_PIN] !== 0) continue;
        const nx = kf[c + F_NX]!;
        const ny = kf[c + F_NX + 1]!;
        const nz = kf[c + F_NX + 2]!;
        const vox = kf[c + F_VO]!;
        const voy = kf[c + F_VO + 1]!;
        const voz = kf[c + F_VO + 2]!;
        const von = vox * nx + voy * ny + voz * nz;
        if (von <= 0) continue;
        const src = kf[c + F_SRC]!;
        if (!blk.blocked(b, kin, ter, shipStart, bodies, nx, ny, nz, src, 0)) continue;
        const tx = vox - von * nx;
        const ty = voy - von * ny;
        const tz = voz - von * nz;
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
        const vb = Math.sqrt(vox * vox + voy * voy + voz * voz);
        if (tl > ratio * vb && !blk.blocked(b, kin, ter, shipStart, bodies, tx / tl, ty / tl, tz / tl, src, 0)) {
          kf[c + F_NX] = tx / tl;
          kf[c + F_NX + 1] = ty / tl;
          kf[c + F_NX + 2] = tz / tl;
          kf[c + F_PIN] = PIN_REDIRECTED;
          // its tangent plane now holds the blocked normal: friction would drag the ship into
          // the very support it cannot enter
          kf[c + F_MU] = 0;
        } else {
          kf[c + F_PIN] = PIN_BLOCKED;
        }
      }
    }
    for (let i = 0; i < active.length; i++) {
      const b = active[i]!;
      if (b.kinEnd <= b.kinStart) continue;
      let dx = 0;
      let dy = 0;
      let dz = 0;
      for (let k = b.kinStart; k < b.kinEnd; k++) {
        const c = k * STRIDE;
        // only contacts that actually drive the ship define its push direction
        const pinState = kf[c + F_PIN];
        if ((pinState !== 0 && pinState !== PIN_REDIRECTED) || !bladePresses(kf, c, ratio)) continue;
        const vx = kf[c + F_VO]!;
        const vy = kf[c + F_VO + 1]!;
        const vz = kf[c + F_VO + 2]!;
        const l = Math.sqrt(vx * vx + vy * vy + vz * vz);
        dx += vx / l;
        dy += vy / l;
        dz += vz / l;
      }
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dl < 1e-9) continue;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      let released = false;
      for (let k = b.terStart; k < b.terEnd; k++) {
        const c = k * STRIDE;
        if (tf[c + F_NX]! * dx + tf[c + F_NX + 1]! * dy + tf[c + F_NX + 2]! * dz < -FRICTION_RELEASE) {
          tf[c + F_MU] = 0;
          released = true;
        }
      }
      for (let k = shipStart; k < kin.count; k++) {
        const c = k * STRIDE;
        // b's normal is +n when it is the contact's body A, -n when it is body B
        const isA = kf[c + F_A] === b.index;
        if (!isA && kf[c + F_B] !== b.index) continue;
        const sgn = isA ? 1 : -1;
        const nx = kf[c + F_NX]! * sgn;
        const ny = kf[c + F_NX + 1]! * sgn;
        const nz = kf[c + F_NX + 2]! * sgn;
        if (nx * dx + ny * dy + nz * dz >= -FRICTION_RELEASE) continue;
        kf[c + F_MU] = 0;
        released = true;
        const other = bodies[(isA ? kf[c + F_B] : kf[c + F_A])!]!;
        // a frozen ship or a sleeper taking part as an obstacle is immovable in the solver anyway
        // (fixing b as well would leave the contact with no side that moves)
        if (other.mode !== MODE_ACTIVE) continue;
        // The other ship is pushed along -n_b. Held that way: it is the immovable side, b slides
        // along it. Free: b is, since an infinitely strong blade drives it — the other ship
        // must give way entirely instead of shoving b back into the blade.
        const held = sup.blocked(other, kin, ter, shipStart, bodies, -nx, -ny, -nz, -1, 0);
        const want = held === isA ? FIX_B : FIX_A;
        const cur = kf[c + F_FIX]!;
        kf[c + F_FIX] = cur === FIX_NONE || cur === want ? want : FIX_CONFLICT;
      }
      // Pressed into its supports, the ship escapes by sliding along them, and so slides along
      // the blade's face too: the blade's own friction would jam it just like the supports'.
      if (released) {
        for (let k = b.kinStart; k < b.kinEnd; k++) if (kf[k * STRIDE + F_PIN] === 0) kf[k * STRIDE + F_MU] = 0;
      }
    }
  }

  /** After the solve: support (sleep, islands) and pushes on sleepers from load-carrying contacts. */
  private supportStats(shipStart: number): void {
    const active = this.active;
    const bodies = this.bodies;
    const views = this.views;
    // terrain that carried load supports the ship
    const tf = this.ter.f;
    for (let i = 0; i < active.length; i++) {
      const b = active[i]!;
      if (b.supportedThisTick) continue;
      for (let c = b.terStart; c < b.terEnd; c++) {
        if (tf[c * STRIDE + F_LN]! > 0) {
          b.supportedThisTick = true;
          break;
        }
      }
    }
    const kf = this.kin.f;
    // a stopped rotor is something to rest on, like terrain
    for (let i = 0; i < shipStart; i++) {
      const c = i * STRIDE;
      if (!(kf[c + F_LN]! > 0) || views[kf[c + F_SRC]!]!.moving) continue;
      bodies[kf[c + F_A]!]!.supportedThisTick = true;
    }
    // ship/ship contacts that carried load: support, sleep islands, pushes on sleepers
    for (let i = shipStart; i < this.kin.count; i++) {
      const c = i * STRIDE;
      const l = kf[c + F_LN]!;
      if (!(l > 0)) continue;
      const A = bodies[kf[c + F_A]!]!;
      const B = bodies[kf[c + F_B]!]!;
      A.supportedThisTick = true;
      B.supportedThisTick = true;
      A.shipImpulseThisTick += l;
      B.shipImpulseThisTick += l;
      if (A.mode === MODE_ACTIVE && B.mode === MODE_ACTIVE) this.islands.union(A.index, B.index);
    }
  }

  /** Ship-contact counts and deepest penetration per body for the stats. */
  private contactStats(shipStart: number): void {
    const bodies = this.bodies;
    const kf = this.kin.f;
    for (let i = shipStart; i < this.kin.count; i++) {
      const c = i * STRIDE;
      const A = bodies[kf[c + F_A]!]!;
      A.stats.shipContacts++;
      const bi = kf[c + F_B]!;
      if (bi >= 0) bodies[bi]!.stats.shipContacts++;
    }
    for (let s = 0; s < 2; s++) {
      const set = s === 0 ? this.kin : this.ter;
      const f = set.f;
      for (let i = 0; i < set.count; i++) {
        const c = i * STRIDE;
        const d = f[c + F_DEPTH]!;
        const A = bodies[f[c + F_A]!]!;
        if (d > A.stats.maxDepth) A.stats.maxDepth = d;
        const bi = f[c + F_B]!;
        if (bi >= 0 && d > bodies[bi]!.stats.maxDepth) bodies[bi]!.stats.maxDepth = d;
      }
    }
  }

  private countPinned(shipStart: number): void {
    const kf = this.kin.f;
    const bodies = this.bodies;
    for (let i = 0; i < shipStart; i++) {
      const c = i * STRIDE;
      if (kf[c + F_PIN] === PIN_PINNED) bodies[kf[c + F_A]!]!.stats.pinned++;
    }
  }

  /**
   * Destroy the deepest pinned hull part of this tick (docs/SHAPES.md 12.7): the part holding the
   * pinned octant of the pinned cell is removed (a two-part cell takes two ticks) and drops its
   * item once (BlockDef.drop: undefined = the block itself, null = nothing) when the world's drops
   * are on, its feet at the cell corner + DROP_POINT of the part's fill (the cell centre for a full
   * block, as in M1; docs/SHAPES.md 9.5).
   */
  private destroyPinnedCell(b: Body): void {
    const ship = b.ship;
    const g = ship.grid;
    const x = b.pinX;
    const y = b.pinY;
    const z = b.pinZ;
    const part = removePartAt(g, x, y, z, b.pinOctant);
    if (part === 0) return;
    b.stats.destroyed++;
    if (!this.host.dropsEnabled) return;
    const fill = ~(part >>> HOLES_SHIFT) & 0xff;
    const c = this.cellCentre;
    c.x = x + DROP_POINT[fill * 3]!;
    c.y = y + DROP_POINT[fill * 3 + 1]!;
    c.z = z + DROP_POINT[fill * 3 + 2]!;
    g.toWorld(c, c);
    const id = part & ID_MASK;
    const def = BLOCKS[id];
    const drop = def !== undefined ? def.drop : undefined;
    if (drop === null) return;
    const item = drop === undefined ? id : drop.item;
    const count = drop === undefined ? 1 : drop.count;
    if (count > 0) this.host.spawnDrop(c.x, c.y, c.z, item, count);
  }
}

/**
 * A ship with no hard cell (or no cell) cannot collide or float: hold it motionless with zero
 * velocity, asleep, so nothing reads a speed it does not have. Adding cells wakes it (refresh).
 */
function holdInert(b: Body): void {
  b.stats.inert = true;
  const ship = b.ship;
  const g = ship.grid;
  g.linearVelocity.x = g.linearVelocity.y = g.linearVelocity.z = 0;
  g.angularVelocity.x = g.angularVelocity.y = g.angularVelocity.z = 0;
  ship.asleep = true;
  ship.restTicks = 0;
}

function boxesOverlap(a: Body, b: Body, margin: number): boolean {
  return (
    a.minX - margin < b.maxX &&
    a.maxX + margin > b.minX &&
    a.minY - margin < b.maxY &&
    a.maxY + margin > b.minY &&
    a.minZ - margin < b.maxZ &&
    a.maxZ + margin > b.minZ
  );
}
