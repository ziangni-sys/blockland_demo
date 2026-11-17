/**
 * ShipDynamics implementation: the tick driver.
 *
 * Per step():
 *   1. classify ships: refresh derived data; skip removed / empty ones; frozen ships and ships
 *      whose surroundings are not loaded become immovable obstacles (LESSONS 船被弹飞);
 *      sleeping ships stay asleep unless disturbed.
 *   2. per awake ship: copy the world around it into its WorldPatch, list rotors in reach.
 *   3. n sub-steps, all ships in lock-step:
 *        forces (gravity, buoyancy, drag, keel, thrust, rudder) -> velocities, clamped
 *        contacts at the start-of-sub-step poses (rotors interpolated to alpha = k/n)
 *        sequential impulses (rotor / ship contacts first, terrain last)
 *        pinning check -> if any blade is pinned, re-solve without its contacts
 *        split-impulse penetration recovery, then integrate the poses
 *   4. write back, destroy at most one pinned hull cell per ship, refresh, sleep bookkeeping.
 *
 * Nothing here reads a clock or a random source: identical inputs give identical results.
 * Iteration orders are those of the input arrays and of the cell storage.
 */
import { TICK_DT } from '../../core/constants';
import { qnormalize, qtoMat3, quat, vec3, type Vec3 } from '../../core/math';
import { AIR, ID_MASK } from '../../blocks/cell';
import { BLOCKS } from '../../blocks/registry';
import type { Rotor, Ship, ShipDynamics, StructureHost } from '../structure';
import { Body, MODE_ACTIVE, MODE_NONE, type ShipPhysicsStats } from './body';
import { applyBuoyancy } from './buoyancy';
import { ContactGenerator, ContactSet, F_A, F_B, F_DEPTH, F_LN, F_PIN, STRIDE } from './contacts';
import { applyHydrodynamics } from './hydro';
import { mat3Congruence } from './mat3';
import { refreshShip } from './massprops';
import { resolveOptions, type DynamicsOptions, type ResolvedOptions } from './options';
import { PinDetector } from './pinning';
import { RotorView } from './rotorview';
import { updateSleep, wakeShip } from './sleep';
import { prepareContacts, resetImpulses, solvePositionPass, solveVelocityPass } from './solver';

/** World cells copied around a ship beyond its box (>= max travel per tick + neighbour lookups). */
const PATCH_MARGIN = 3;
/** Unloaded columns this close to a ship's box freeze it (a stricter version of "box + 2"). */
const LOADED_MARGIN = 3;

export class ShipDynamicsImpl implements ShipDynamics {
  readonly options: ResolvedOptions;
  private readonly host: StructureHost;
  private readonly bodyMap = new WeakMap<Ship, Body>();
  private readonly viewMap = new WeakMap<Rotor, RotorView>();
  /** Bodies taking part in this tick's solve (active + static), indexed by body.index. */
  private readonly bodies: Body[] = [];
  private readonly active: Body[] = [];
  private readonly sleeping: Body[] = [];
  private readonly views: RotorView[] = [];
  private readonly pairs: number[] = [];
  private readonly kin = new ContactSet();
  private readonly ter = new ContactSet();
  private readonly gen = new ContactGenerator();
  private readonly pins = new PinDetector();
  private readonly mR = new Float64Array(9);
  private readonly mI = new Float64Array(9);
  private readonly mT = new Float64Array(9);
  private readonly cellCentre: Vec3 = vec3();

  constructor(host: StructureHost, opts?: DynamicsOptions) {
    this.host = host;
    this.options = resolveOptions(opts);
  }

  // ------------------------------------------------------------------ ShipDynamics

  refresh(ship: Ship): void {
    if (refreshShip(ship, this.bodyOf(ship), this.options)) wakeShip(ship);
  }

  wake(ship: Ship): void {
    wakeShip(ship);
  }

  applyImpulse(ship: Ship, worldPoint: Vec3, impulse: Vec3): void {
    if (ship.removed) return;
    this.refresh(ship);
    const b = this.bodyOf(ship);
    if (b.mass <= 0) return;
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
    const n = o.substeps;
    const dt = TICK_DT / n;
    const invDt = 1 / dt;
    const bodies = this.bodies;
    const active = this.active;
    const sleeping = this.sleeping;
    bodies.length = 0;
    active.length = 0;
    sleeping.length = 0;

    // ---- 1. classify
    for (let i = 0; i < ships.length; i++) {
      const ship = ships[i]!;
      if (ship.removed) continue;
      const b = this.bodyOf(ship);
      if (refreshShip(ship, b, o)) wakeShip(ship);
      b.resetTickStats();
      b.mode = MODE_NONE;
      b.index = -1;
      if (b.mass <= 0 || b.shape.solidCount === 0) continue;
      b.loadPose();
      if (ship.frozen || !this.surroundingsLoaded(b)) {
        b.stats.frozen = true;
        b.makeStatic();
        b.index = bodies.length;
        bodies.push(b);
        continue;
      }
      // Helm input, or game code that moved / pushed the ship since we put it to sleep.
      if (ship.asleep && (ship.throttle !== 0 || ship.rudder !== 0 || b.disturbedSinceWrite())) wakeShip(ship);
      if (ship.asleep) {
        sleeping.push(b);
        continue;
      }
      this.activate(b);
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
      const pb = r.parent !== null ? this.bodyMap.get(r.parent as Ship) : undefined;
      view.beginTick(pb !== undefined && pb.mode === MODE_ACTIVE ? pb : null);
      views.push(view);
    }

    // ---- 3. wake sleepers disturbed by a moving rotor or an awake ship in reach
    const travel = o.substeps * o.maxSubstepTravel;
    for (let i = 0; i < sleeping.length; i++) {
      const sb = sleeping[i]!;
      let disturb = false;
      for (let k = 0; k < views.length && !disturb; k++) {
        const v = views[k]!;
        if (v.rotor.parent === sb.ship || !v.moving || v.shape.solidCount === 0) continue;
        if (sphereNearBox(v, sb, 1 + (v.parentBody !== null ? travel : 0))) disturb = true;
      }
      for (let k = 0; k < active.length && !disturb; k++) {
        if (boxesOverlap(active[k]!, sb, 1 + travel)) disturb = true;
      }
      if (disturb) {
        wakeShip(sb.ship);
        this.activate(sb);
      }
    }

    // ---- 4. per-tick setup of awake ships
    const world = this.host.world;
    for (let i = 0; i < active.length; i++) {
      const b = active[i]!;
      b.stats.simulated = true;
      const x0 = Math.floor(b.minX) - PATCH_MARGIN;
      const y0 = Math.floor(b.minY) - PATCH_MARGIN;
      const z0 = Math.floor(b.minZ) - PATCH_MARGIN;
      const x1 = Math.floor(b.maxX) + PATCH_MARGIN;
      const y1 = Math.floor(b.maxY) + PATCH_MARGIN;
      const z1 = Math.floor(b.maxZ) + PATCH_MARGIN;
      b.patch.fill(world, x0, y0, z0, x1, y1, z1);
      b.patch.collectCorners(x0 + 1, y0 + 1, z0 + 1, x1, y1, z1);
      const cand = b.rotorCandidates;
      cand.length = 0;
      for (let k = 0; k < views.length; k++) {
        const v = views[k]!;
        if (v.rotor.parent === b.ship || v.shape.solidCount === 0) continue;
        if (!sphereNearBox(v, b, travel * 2 + 1)) continue;
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

    // ---- 5. sub-steps
    if (active.length > 0) {
      for (let k = 0; k < n; k++) this.substep(k / n, (k + 1) / n, dt, invDt);
    }

    // ---- 6. finish
    for (let i = 0; i < active.length; i++) active[i]!.writeBack();
    for (let i = 0; i < active.length; i++) {
      const b = active[i]!;
      if (b.pinHas) this.destroyPinnedCell(b);
    }
    for (let i = 0; i < active.length; i++) {
      const b = active[i]!;
      b.stats.submerged = b.submerged;
      if (refreshShip(b.ship, b, o)) wakeShip(b.ship);
      updateSleep(b, o);
      b.rememberPose();
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

  private activate(b: Body): void {
    b.mode = MODE_ACTIVE;
    b.index = this.bodies.length;
    this.bodies.push(b);
    this.active.push(b);
  }

  private surroundingsLoaded(b: Body): boolean {
    return this.host.world.isAreaLoaded(
      b.minX - LOADED_MARGIN,
      b.minZ - LOADED_MARGIN,
      b.maxX + LOADED_MARGIN,
      b.maxZ + LOADED_MARGIN,
    );
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
        gen.rotor(b, views[vi]!, vi, kin, o.rotorFriction, invDt);
      }
      b.kinEnd = kin.count;
      const st = b.stats;
      st.terrainContacts = b.terEnd - b.terStart;
      st.rotorContacts = b.kinEnd - b.kinStart;
      st.shipContacts = 0;
      if (b.kinEnd > b.kinStart) b.rotorTouchThisTick = true;
    }
    // kin holds every body's rotor contacts first, then ship/ship contacts from here on.
    const shipStart = kin.count;
    const pairs = this.pairs;
    for (let p = 0; p < pairs.length; p += 2) {
      gen.ships(bodies[pairs[p]!]!, bodies[pairs[p + 1]!]!, kin, o.shipFriction);
    }
    this.contactStats(shipStart);

    const anyContacts = kin.count + ter.count > 0;
    if (anyContacts) {
      prepareContacts(kin, bodies, invDt, o.slop, o.correctionRate, o.maxCorrectionSpeed);
      prepareContacts(ter, bodies, invDt, o.slop, o.correctionRate, o.maxCorrectionSpeed);
      for (let i = 0; i < active.length; i++) active[i]!.snapshotVelocity();
      this.solveVelocities();
      if (shipStart > 0) {
        // there are rotor contacts: check them for pinning
        const pinned = this.pins.detect(kin, ter, bodies, o);
        if (pinned > 0) {
          for (let i = 0; i < active.length; i++) {
            const b = active[i]!;
            b.restoreVelocity();
          }
          this.countPinned();
          resetImpulses(kin);
          resetImpulses(ter);
          this.solveVelocities();
        }
      }
      // terrain that carried load supports the ship (sleep, pinning statistics)
      const tf = ter.f;
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

  private countPinned(): void {
    const kf = this.kin.f;
    const bodies = this.bodies;
    for (let i = 0; i < this.kin.count; i++) {
      const c = i * STRIDE;
      if (kf[c + F_PIN] !== 0) bodies[kf[c + F_A]!]!.stats.pinned++;
    }
  }

  /**
   * Destroy the deepest pinned hull cell of this tick: it becomes air and drops its item
   * (BlockDef.drop: undefined = the block itself, null = nothing) unless in creative mode.
   */
  private destroyPinnedCell(b: Body): void {
    const ship = b.ship;
    const g = ship.grid;
    const x = b.pinX;
    const y = b.pinY;
    const z = b.pinZ;
    const cell = g.getCell(x, y, z);
    if (cell === AIR) return;
    const c = this.cellCentre;
    c.x = x + 0.5;
    c.y = y + 0.5;
    c.z = z + 0.5;
    g.toWorld(c, c);
    if (!g.setCell(x, y, z, AIR)) return;
    b.stats.destroyed++;
    if (this.host.creative) return;
    const id = cell & ID_MASK;
    const def = BLOCKS[id];
    const drop = def !== undefined ? def.drop : undefined;
    if (drop === null) return;
    const item = drop === undefined ? id : drop.item;
    const count = drop === undefined ? 1 : drop.count;
    if (count > 0) this.host.spawnDrop(c.x, c.y, c.z, item, count);
  }
}

/** Does the rotor's bounding sphere come within `margin` of the body's world box? */
function sphereNearBox(v: RotorView, b: Body, margin: number): boolean {
  const qx = v.cx < b.minX ? b.minX : v.cx > b.maxX ? b.maxX : v.cx;
  const qy = v.cy < b.minY ? b.minY : v.cy > b.maxY ? b.maxY : v.cy;
  const qz = v.cz < b.minZ ? b.minZ : v.cz > b.maxZ ? b.maxZ : v.cz;
  const dx = v.cx - qx;
  const dy = v.cy - qy;
  const dz = v.cz - qz;
  const r = v.radius + margin;
  return dx * dx + dy * dy + dz * dz <= r * r;
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
