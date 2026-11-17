/**
 * The client's copy of the world (docs/NETCODE.md sections 5 to 9): ClientReplica, on top of
 * package 4's ReplicaState (apply.ts), adds what a client needs to show and predict it:
 *
 *  - the subscribed columns with pristine generation (chunks.ts) and a LightEngine on them: every
 *    inserted column is lit (initChunk), cell changes queue light updates (updateLight);
 *  - a sample ring per ship (pose) and per entity (carrier, position, yaw, look), fed by the poses
 *    of the batches (spawn records, rests, final states: samples of the batch's tick, section 5)
 *    and by the Samples messages; samples of ids the replica does not know yet wait up to
 *    SAMPLE_BUFFER_TICKS for their spawn, which drops the ones not later than its tick (section 7);
 *  - the pivot conversion of a ship's ring (samples older than the batch carrying the new pivot,
 *    or a resend with another pivot, are moved to it; older ones arriving later are dropped; a
 *    sample later than the newest applied batch is never an end of the interpolation, since its
 *    pivot may not have arrived yet);
 *  - removal of a carrier: the samples of the entities it carried move into its parent's frame at
 *    its pose at each sample's tick (ship: its ring, rotor: its extrapolation), yaw included
 *    (section 18), before the structure goes;
 *  - rotors extrapolated from their last state with advanceRotor, one tick at a time, to any tick,
 *    the fraction between two ticks interpolated (frozen: held); the result is the server's angle
 *    at that tick to the last bit;
 *  - the derived data of section 7: hulls (when grid.version changed), the helm readings.
 *
 * DISPLAY POSE. setPoses(renderTick, rotorTick) writes every structure's grid pose: ships from
 * their ring at renderTick, rotors at rotorTick (nested rotors compose through grid.parent). The
 * prediction (package 6) calls it at every client step, the frame before rendering. structures()
 * are the Ship / Rotor data objects with those grids; entities(renderTick) are interpolated in
 * their carrier's frame and placed with the carrier's display pose (section 8).
 *
 * Batches are applied in order with applyBatch, samples with applySamples (NetClient decides
 * when, section 5). A ReplicaError from a batch ends the connection; the replica is then dropped.
 */
import { DAY_TICKS, TICK_DT } from '../../core/constants';
import { mod, qconj, qcopy, qmul, qrotate, qslerp, quat, vcopy, vec3, wrapAngle, type Quat, type Vec3 } from '../../core/math';
import { headingOf } from '../../entities/structs';
import { LightEngine } from '../../light/engine';
import type { HelmView } from '../../sim/view';
import type { GlueStore } from '../../structures/glue';
import { analyzeHull } from '../../structures/hull';
import { advanceRotor, applyRotorPose, holdRotor } from '../../structures/rotor';
import { Rotor, Ship } from '../../structures/structure';
import type { World } from '../../voxel/world';
import {
  READY_CHUNK_RADIUS,
  ROTOR_RESYNC_TICKS,
  SAMPLE_BUFFER_TICKS,
  type EntityKind,
  type EntityMotion,
  type PlayerFlags,
  type PlayerHeld,
  type PlayerLook,
  type SamplesMsg,
  type TickBatchMsg,
  type WelcomeMsg,
} from '../protocol';
import { applyBatch, applySamples, applyWelcome, ReplicaState, type ReplicaPrivate, type ReplicaStructure } from './apply';
import { ClientChunks, type ChunkSource } from './chunks';

/** Light work per updateLight() call when no budget is given (visits; the server used the same). */
export const LIGHT_BUDGET = 60_000;
/**
 * A rotor is extrapolated at most this many ticks past its state, then held (a guard: its state is
 * resent every ROTOR_RESYNC_TICKS while it is in interest).
 */
const MAX_ROTOR_STEPS = 4 * ROTOR_RESYNC_TICKS;

/** A pose sample of a ship: pivot position in the parent (world) and rotation. */
interface ShipSample {
  tick: number;
  readonly pos: Vec3;
  readonly rot: Quat;
  /** The final pose of a structureRests entry (the ship stopped: its speed reads 0). */
  readonly rest: boolean;
}

/** A motion sample of an entity: position local to the carrier (world when 0), yaw relative to its heading. */
interface EntitySample {
  tick: number;
  carrierId: number;
  readonly pos: Vec3;
  yaw: number;
  look: PlayerLook | null;
}

interface ShipRing {
  /** By tick ascending, one per tick. */
  readonly samples: ShipSample[];
  /** Samples older than this arrive with an old pivot: dropped. */
  pivotTick: number;
}

/** What one entity looks like at renderTick (entities()). */
export interface EntityView {
  readonly id: number;
  readonly kind: EntityKind;
  /** World position and yaw at renderTick, carried entities placed with their carrier's display pose. */
  readonly pos: Vec3;
  readonly yaw: number;
  /** The carrier of the sample at or before renderTick (0 = none). */
  readonly carrierId: number;
  /** Players: pitch and the flags of the motion; the name from the player table. */
  readonly pitch: number;
  readonly look: PlayerLook | null;
  readonly player: PlayerHeld | null;
  readonly name: string | null;
  /** Items. */
  readonly item: number;
  readonly count: number;
  /** Falling blocks. */
  readonly cell: number;
  /** Blast crates: fuse ticks left at renderTick (counted down by the client). */
  readonly fuse: number;
}

/** Extrapolates one rotor from its last state, one advanceRotor per tick (section 7). */
class RotorClock {
  /** Advanced by advanceRotor from the state. */
  private readonly stepper: Rotor;
  /** Shows a display angle (applyRotorPose). */
  readonly shown: Rotor;
  // The state stepped from.
  private stateTick = NaN;
  private stateAngle = NaN;
  private stateSpeed = NaN;
  private stateSails = NaN;
  private stateFrozen = false;
  /** Ticks stepped so far (the stepper holds the state at stateTick + steps). */
  private steps = 0;
  /** Angle and speed at stateTick + steps and the tick after. */
  private a0 = 0;
  private a1 = 0;
  private w0 = 0;
  private w1 = 0;

  constructor(id: number, world: World) {
    this.stepper = new Rotor(id, world);
    this.shown = new Rotor(id, world);
  }

  /** Angle (and speed into `speed[0]`) of `r` at `tick`, from its state at `stateTick`. */
  angleAt(r: Rotor, stateTick: number, tick: number, speed: number[]): number {
    if (stateTick !== this.stateTick || r.angle !== this.stateAngle || r.angularSpeed !== this.stateSpeed || r.sails !== this.stateSails || r.frozen !== this.stateFrozen) {
      this.stateTick = stateTick;
      this.stateAngle = r.angle;
      this.stateSpeed = r.angularSpeed;
      this.stateSails = r.sails;
      this.stateFrozen = r.frozen;
      this.restart(r);
    }
    const t = Math.min(tick - stateTick, MAX_ROTOR_STEPS);
    if (r.frozen || !(t > 0)) {
      speed[0] = r.frozen ? 0 : r.angularSpeed;
      return r.angle;
    }
    const n = Math.floor(t);
    if (n < this.steps) this.restart(r);
    while (this.steps < n) this.step();
    const f = t - n;
    speed[0] = this.w0 + (this.w1 - this.w0) * f;
    return f === 0 ? this.a0 : wrapAngle(this.a0 + wrapAngle(this.a1 - this.a0) * f);
  }

  private restart(r: Rotor): void {
    const s = this.stepper;
    s.axis = r.axis;
    s.sails = r.sails;
    s.angle = r.angle;
    s.angularSpeed = r.angularSpeed;
    qcopy(s.baseRotation, r.baseRotation);
    this.steps = 0;
    this.a0 = r.angle;
    this.w0 = r.angularSpeed;
    advanceRotor(s, TICK_DT);
    this.a1 = s.angle;
    this.w1 = s.angularSpeed;
  }

  private step(): void {
    this.steps++;
    this.a0 = this.a1;
    this.w0 = this.w1;
    advanceRotor(this.stepper, TICK_DT);
    this.a1 = this.stepper.angle;
    this.w1 = this.stepper.angularSpeed;
  }
}

export class ClientReplica {
  readonly state: ReplicaState;
  readonly chunks: ClientChunks;
  readonly light: LightEngine;

  private readonly shipRings = new Map<number, ShipRing>();
  private readonly entityRings = new Map<number, EntitySample[]>();
  /** Samples of ids the replica does not know (yet, or any more). */
  private readonly pendingShips = new Map<number, ShipSample[]>();
  private readonly pendingEntities = new Map<number, EntitySample[]>();
  private readonly rotorClocks = new Map<number, RotorClock>();
  private readonly hullVersions = new Map<number, number>();
  private list: Array<Ship | Rotor> = [];
  private listDirty = true;
  /** Newest tick of any batch or sample (bounds the pending samples). */
  private newestTick = -1;
  /** The ticks of the last setPoses(). */
  private shownRender = -Infinity;
  private shownRotor = -Infinity;

  // Scratch (per instance, ARCHITECTURE rule 5).
  private readonly speed = [0];
  private readonly tmpP = vec3();
  private readonly tmpQ = quat();
  private readonly tmpP2 = vec3();
  private readonly tmpQ2 = quat();
  private readonly tmpV = vec3();
  private readonly tmpW = vec3();

  constructor(source: ChunkSource) {
    let light: LightEngine | null = null;
    this.chunks = new ClientChunks(source, (chunk) => light!.initChunk(chunk));
    this.state = new ReplicaState(this.chunks);
    light = new LightEngine(this.chunks.world);
    light.attach();
    this.light = light;
  }

  // ------------------------------------------------------------------ the interface of section 15

  get world(): World {
    return this.state.world;
  }

  get worldGlue(): GlueStore {
    return this.state.worldGlue;
  }

  /** Every structure (parents before children); their grids hold the pose of the last setPoses(). */
  structures(): ReadonlyArray<Ship | Rotor> {
    if (this.listDirty) {
      this.listDirty = false;
      this.list = [...this.state.structures.values()].map((rs) => rs.structure).sort((a, b) => depth(a) - depth(b) || a.id - b.id);
    }
    return this.list;
  }

  /** Every entity of the replica at `renderTick`, carriers at their display pose (section 8). */
  entities(renderTick: number): EntityView[] {
    const out: EntityView[] = [];
    for (const e of this.state.entities.values()) {
      const ring = this.entityRings.get(e.id);
      if (ring === undefined || ring.length === 0) continue;
      const pos = vec3();
      const placed = this.placeEntity(ring, renderTick, pos);
      const fuse = e.kind === 'tnt' ? Math.max(0, e.fuse - Math.max(0, Math.floor(renderTick) - e.fuseTick)) : 0;
      out.push({
        id: e.id,
        kind: e.kind,
        pos,
        yaw: placed.yaw,
        carrierId: placed.carrierId,
        pitch: placed.look?.pitch ?? 0,
        look: placed.look,
        player: e.player,
        name: e.kind === 'player' ? (this.state.players.get(e.id)?.name ?? null) : null,
        item: e.item,
        count: e.count,
        cell: e.cell,
        fuse,
      });
    }
    return out;
  }

  /** The private state (section 9): correction, inventory, vitals, view, events, ack, moveAck. */
  get ownState(): Readonly<ReplicaPrivate> {
    return this.state.private;
  }

  /** The client's own entity id (Welcome). */
  get ownEntityId(): number {
    return this.state.ownEntityId;
  }

  /** Time of day 0..1 at the renderTick of the last setPoses() (section 4). */
  get dayTime(): number {
    const t = Number.isFinite(this.shownRender) ? this.shownRender : Math.max(this.state.tick, this.state.worldTime);
    return mod(t + this.state.dayOffset, DAY_TICKS) / DAY_TICKS;
  }

  // ------------------------------------------------------------------ applying

  applyWelcome(m: WelcomeMsg): void {
    applyWelcome(this.state, m);
  }

  /** Apply one TickBatch (section 5) and feed its poses into the rings. */
  applyBatch(b: TickBatchMsg): void {
    const st = this.state;
    const T = b.tick;
    // Before the batch: carried entities leave the structures it removes (section 7 "移除").
    for (const id of b.structureRemoves) this.reframeRiders(id, T);
    const knownBefore = new Set<number>();
    const oldPivots = new Map<number, Vec3>();
    for (const rec of b.structureSpawns) {
      const rs = st.structures.get(rec.id);
      if (rs === undefined) continue;
      knownBefore.add(rec.id);
      oldPivots.set(rec.id, { ...rs.structure.grid.pivot });
    }
    for (const d of b.structureDeltas) {
      if (d.pivot === undefined) continue;
      const rs = st.structures.get(d.id);
      if (rs !== undefined) oldPivots.set(d.id, { ...rs.structure.grid.pivot });
    }

    applyBatch(st, b);

    if (b.structureRemoves.length > 0 || b.structureSpawns.length > 0) this.listDirty = true;
    for (const id of b.structureRemoves) {
      this.shipRings.delete(id);
      this.rotorClocks.delete(id);
      this.hullVersions.delete(id);
    }
    for (const rec of b.structureSpawns) {
      if (rec.kind !== 'ship') continue;
      let ring = this.shipRings.get(rec.id);
      if (ring === undefined || !knownBefore.has(rec.id)) {
        // A new id: samples that arrived before the spawn and are not older than it are kept.
        ring = { samples: [], pivotTick: T };
        this.shipRings.set(rec.id, ring);
        this.adoptPending(this.pendingShips, rec.id, T, (s) => pushRing(ring!.samples, s, T));
      } else {
        this.repivot(ring, oldPivots.get(rec.id)!, rec.pivot, T);
      }
      pushRing(ring.samples, { tick: T, pos: { ...rec.position }, rot: { ...rec.rotation }, rest: false }, T);
    }
    for (const d of b.structureDeltas) {
      if (d.pivot === undefined) continue;
      const ring = this.shipRings.get(d.id);
      if (ring !== undefined) this.repivot(ring, oldPivots.get(d.id)!, d.pivot, T);
    }
    for (const r of b.structureRests) {
      pushRing(this.shipRings.get(r.id)!.samples, { tick: T, pos: { ...r.pose.pos }, rot: { ...r.pose.rot }, rest: true }, T);
    }
    for (const id of b.entityDespawns) this.entityRings.delete(id);
    for (const rec of b.entitySpawns) {
      const ring: EntitySample[] = [];
      this.entityRings.set(rec.id, ring);
      this.adoptPending(this.pendingEntities, rec.id, T, (s) => {
        if (s.carrierId === 0 || st.structures.has(s.carrierId)) pushRing(ring, s, T);
      });
      const look = rec.kind === 'player' ? { pitch: rec.pitch, flags: { ...rec.flags } } : null;
      pushRing(ring, { tick: T, carrierId: rec.carrierId, pos: { ...rec.pos }, yaw: rec.yaw, look }, T);
    }
    for (const u of b.entityUpdates) {
      if (u.final !== undefined) pushRing(this.entityRings.get(u.id)!, entitySample(T, u.final), T);
    }
    this.noteTick(T);
  }

  /** Insert a Samples message (section 7, 8). */
  applySamples(m: SamplesMsg): void {
    const st = this.state;
    applySamples(st, m);
    const T = m.tick;
    for (const s of m.ships) {
      const sample: ShipSample = { tick: T, pos: { ...s.pose.pos }, rot: { ...s.pose.rot }, rest: false };
      const ring = this.shipRings.get(s.id);
      if (ring === undefined) pushPending(this.pendingShips, s.id, sample);
      else if (T >= ring.pivotTick) pushRing(ring.samples, sample, st.tick);
    }
    for (const s of m.entities) {
      const sample = entitySample(T, s);
      const ring = this.entityRings.get(s.id);
      if (ring === undefined) pushPending(this.pendingEntities, s.id, sample);
      else if (s.carrierId === 0 || st.structures.has(s.carrierId)) pushRing(ring, sample, st.tick);
    }
    this.noteTick(T);
  }

  // ------------------------------------------------------------------ poses

  /**
   * Pose every structure's grid for display or a prediction step: ships at `renderTick` (their
   * ring), rotors at `rotorTick` (extrapolated). Velocities follow (ships: between the bracketing
   * samples; rotors: their spin).
   */
  setPoses(renderTick: number, rotorTick: number): void {
    this.shownRender = renderTick;
    this.shownRotor = rotorTick;
    for (const rs of this.state.structures.values()) {
      const s = rs.structure;
      const g = s.grid;
      if (s instanceof Ship) {
        const ring = this.shipRings.get(s.id)!;
        this.shipPose(ring, renderTick, this.tmpP, this.tmpQ, this.tmpV, this.tmpW);
        g.setPoseImmediate(this.tmpP, this.tmpQ);
        vcopy(g.linearVelocity, this.tmpV);
        vcopy(g.angularVelocity, this.tmpW);
      } else {
        const shown = this.rotorShown(rs, s, rotorTick);
        g.setPoseImmediate(rs.pose.pos, shown.grid.rotation);
        vcopy(g.linearVelocity, shown.grid.linearVelocity);
        vcopy(g.angularVelocity, shown.grid.angularVelocity);
      }
    }
  }

  /** A ship's pose (pivot position in the world, rotation) at `tick` from its ring; false when unknown. */
  shipPoseAt(id: number, tick: number, outPos: Vec3, outRot: Quat): boolean {
    const ring = this.shipRings.get(id);
    if (ring === undefined || ring.samples.length === 0) return false;
    this.shipPose(ring, tick, outPos, outRot, this.tmpV, this.tmpW);
    return true;
  }

  /**
   * A point local to structure `carrierId` (0: the world) in the world, the carrier posed at
   * (shipTick, rotorTick), into `out`. False when the replica does not hold the carrier.
   */
  toWorldAt(carrierId: number, local: Vec3, shipTick: number, rotorTick: number, out: Vec3): boolean {
    if (carrierId === 0) {
      vcopy(out, local);
      return true;
    }
    const p = vec3();
    const q = quat();
    if (!this.worldPose(carrierId, shipTick, rotorTick, p, q)) return false;
    this.placeLocal(carrierId, { p, q }, local, out);
    return true;
  }

  /**
   * Every column of the ready zone around column (cx, cz) is in the world: the 7x7 columns
   * (READY_CHUNK_RADIUS) that lie in the subscription circle of `viewRadius` (section 3).
   */
  readyZoneLoaded(cx: number, cz: number, viewRadius: number): boolean {
    const lim = viewRadius * viewRadius + viewRadius;
    for (let dx = -READY_CHUNK_RADIUS; dx <= READY_CHUNK_RADIUS; dx++) {
      for (let dz = -READY_CHUNK_RADIUS; dz <= READY_CHUNK_RADIUS; dz++) {
        if (dx * dx + dz * dz <= lim && !this.chunks.present(cx + dx, cz + dz)) return false;
      }
    }
    return true;
  }

  /** A rotor's angle at `tick`, extrapolated from its last state (section 7); NaN when unknown. */
  rotorAngleAt(id: number, tick: number): number {
    const rs = this.state.structures.get(id);
    if (rs === undefined || !(rs.structure instanceof Rotor)) return NaN;
    return this.rotorClock(id).angleAt(rs.structure, rs.rotorTick, tick, this.speed);
  }

  // ------------------------------------------------------------------ derived data

  /** Light work queued by cell changes (budget in visits). Returns true when none is left. */
  updateLight(budget = LIGHT_BUDGET): boolean {
    return this.light.update(budget);
  }

  /** Bring every ship's hull up to date with its cells (analyzeHull when grid.version changed). */
  refreshHulls(): void {
    for (const rs of this.state.structures.values()) {
      const s = rs.structure;
      if (!(s instanceof Ship) || this.hullVersions.get(s.id) === s.grid.version) continue;
      this.hullVersions.set(s.id, s.grid.version);
      s.hull = analyzeHull(s.grid);
    }
  }

  /**
   * The helm readings of a ship (section 7): throttle and rudder from its fields, the sails of its
   * rotors, the horizontal speed between its two newest samples (0 when the newest is the final
   * pose of a rest: a sample lost just before it would otherwise leave a speed). Null for an
   * unknown id or a rotor.
   */
  helm(shipId: number): HelmView | null {
    const rs = this.state.structures.get(shipId);
    if (rs === undefined || !(rs.structure instanceof Ship)) return null;
    const ship = rs.structure;
    let sails = 0;
    for (const r of ship.children) sails += r.sails;
    const samples = this.shipRings.get(shipId)!.samples;
    let speed = 0;
    const n = samples.length;
    if (n >= 2 && !samples[n - 1]!.rest) {
      const a = samples[n - 2]!;
      const b = samples[n - 1]!;
      speed = Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z) / ((b.tick - a.tick) * TICK_DT);
    }
    return { throttle: ship.throttle, rudder: ship.rudder, speed, sails };
  }

  /** Samples held (rings and pending), for tests and the debug panel. */
  sampleCounts(): { ships: number; entities: number; pendingShips: number; pendingEntities: number } {
    let ships = 0;
    let entities = 0;
    let pendingShips = 0;
    let pendingEntities = 0;
    for (const r of this.shipRings.values()) ships += r.samples.length;
    for (const r of this.entityRings.values()) entities += r.length;
    for (const p of this.pendingShips.values()) pendingShips += p.length;
    for (const p of this.pendingEntities.values()) pendingEntities += p.length;
    return { ships, entities, pendingShips, pendingEntities };
  }

  // ------------------------------------------------------------------ internals

  private rotorClock(id: number): RotorClock {
    let c = this.rotorClocks.get(id);
    if (c === undefined) {
      c = new RotorClock(id, this.state.world);
      this.rotorClocks.set(id, c);
    }
    return c;
  }

  /** The rotor posed at `tick` (its `shown` scratch: rotation and velocities in the parent frame). */
  private rotorShown(rs: ReplicaStructure, r: Rotor, tick: number): Rotor {
    const c = this.rotorClock(r.id);
    const angle = c.angleAt(r, rs.rotorTick, tick, this.speed);
    const shown = c.shown;
    shown.axis = r.axis;
    qcopy(shown.baseRotation, r.baseRotation);
    shown.angle = angle;
    shown.angularSpeed = this.speed[0]!;
    if (r.frozen) holdRotor(shown);
    else applyRotorPose(shown, true);
    return shown;
  }

  /**
   * A ship's ring at `tick`: lerp / slerp between the bracketing samples, held at the ends. Only
   * samples not later than the newest applied batch are used, as either end: a later one may
   * already carry a new pivot whose delta has not been applied yet (it arrived while the sample
   * before it was lost, or while the reliable channel stalls behind a retransmission). When the
   * right end would be such a sample, the pose holds at the left end, as past the newest sample.
   */
  private shipPose(ring: ShipRing, tick: number, outPos: Vec3, outRot: Quat, outVel: Vec3, outAng: Vec3): void {
    const s = ring.samples;
    const applied = this.state.tick;
    const i = bracket(s, Math.min(tick, applied));
    outVel.x = outVel.y = outVel.z = 0;
    outAng.x = outAng.y = outAng.z = 0;
    if (i < 0) {
      vcopy(outPos, s[0]!.pos);
      qcopy(outRot, s[0]!.rot);
      return;
    }
    const a = s[i]!;
    const b = s[i + 1];
    if (b === undefined || b.tick > applied || tick <= a.tick) {
      vcopy(outPos, a.pos);
      qcopy(outRot, a.rot);
      return;
    }
    const f = (tick - a.tick) / (b.tick - a.tick);
    outPos.x = a.pos.x + (b.pos.x - a.pos.x) * f;
    outPos.y = a.pos.y + (b.pos.y - a.pos.y) * f;
    outPos.z = a.pos.z + (b.pos.z - a.pos.z) * f;
    qslerp(a.rot, b.rot, f, outRot);
    const dt = (b.tick - a.tick) * TICK_DT;
    outVel.x = (b.pos.x - a.pos.x) / dt;
    outVel.y = (b.pos.y - a.pos.y) / dt;
    outVel.z = (b.pos.z - a.pos.z) / dt;
    angularVelocity(a.rot, b.rot, dt, outAng);
  }

  /**
   * The world pose (pivot position, rotation, pivot) of structure `id`: ships at `shipTick`, rotors
   * spinning at `rotorTick` on a parent ship at `shipTick`. False when the replica does not hold it.
   */
  private worldPose(id: number, shipTick: number, rotorTick: number, outPos: Vec3, outRot: Quat): boolean {
    const rs = this.state.structures.get(id);
    if (rs === undefined) return false;
    const s = rs.structure;
    if (s instanceof Ship) {
      this.shipPose(this.shipRings.get(id)!, shipTick, outPos, outRot, this.tmpV, this.tmpW);
      return true;
    }
    const shown = this.rotorShown(rs, s, rotorTick);
    vcopy(outPos, rs.pose.pos);
    qcopy(outRot, shown.grid.rotation);
    const parent = s.parent;
    if (parent === null) return true;
    const pp = this.tmpP2;
    const pq = this.tmpQ2;
    this.shipPose(this.shipRings.get(parent.id)!, shipTick, pp, pq, this.tmpV, this.tmpW);
    // world = pp + pq * (rotorPos - parentPivot); rotation pq * rot.
    const rel = qrotate(pq, vec3(outPos.x - parent.grid.pivot.x, outPos.y - parent.grid.pivot.y, outPos.z - parent.grid.pivot.z));
    outPos.x = pp.x + rel.x;
    outPos.y = pp.y + rel.y;
    outPos.z = pp.z + rel.z;
    qmul(pq, outRot, outRot);
    return true;
  }

  /** Local point of structure `id` (posed outPos / outRot, world) -> world, in place. */
  private placeLocal(id: number, pose: { p: Vec3; q: Quat }, local: Vec3, out: Vec3): void {
    const pivot = this.state.structures.get(id)!.structure.grid.pivot;
    const rel = qrotate(pose.q, vec3(local.x - pivot.x, local.y - pivot.y, local.z - pivot.z));
    out.x = pose.p.x + rel.x;
    out.y = pose.p.y + rel.y;
    out.z = pose.p.z + rel.z;
  }

  /** One sample's world position (into `out`) and yaw, its carrier posed at (shipTick, rotorTick). */
  private sampleToWorld(s: EntitySample, shipTick: number, rotorTick: number, out: Vec3): number {
    if (s.carrierId === 0) {
      vcopy(out, s.pos);
      return s.yaw;
    }
    const p = vec3();
    const q = quat();
    if (!this.worldPose(s.carrierId, shipTick, rotorTick, p, q)) {
      vcopy(out, s.pos);
      return s.yaw;
    }
    this.placeLocal(s.carrierId, { p, q }, s.pos, out);
    return wrapAngle(s.yaw + headingOf(q));
  }

  /** An entity at `tick` from its ring (section 8), into `out`. */
  private placeEntity(ring: EntitySample[], tick: number, out: Vec3): { yaw: number; carrierId: number; look: PlayerLook | null } {
    const i = bracket(ring, tick);
    const a = ring[Math.max(0, i)]!;
    const b = i >= 0 ? ring[i + 1] : undefined;
    const rotorTick = this.shownRotor;
    if (b === undefined || tick <= a.tick) {
      const yaw = this.sampleToWorld(a, tick, rotorTick, out);
      return { yaw, carrierId: a.carrierId, look: a.look };
    }
    const f = (tick - a.tick) / (b.tick - a.tick);
    const look = a.look !== null && b.look !== null ? { pitch: a.look.pitch + (b.look.pitch - a.look.pitch) * f, flags: a.look.flags } : a.look;
    if (a.carrierId === b.carrierId) {
      const local = vec3(a.pos.x + (b.pos.x - a.pos.x) * f, a.pos.y + (b.pos.y - a.pos.y) * f, a.pos.z + (b.pos.z - a.pos.z) * f);
      const yaw = lerpAngle(a.yaw, b.yaw, f);
      const yawWorld = this.sampleToWorld({ tick, carrierId: a.carrierId, pos: local, yaw, look }, tick, rotorTick, out);
      return { yaw: yawWorld, carrierId: a.carrierId, look };
    }
    const wb = vec3();
    const ya = this.sampleToWorld(a, a.tick, a.tick, out);
    const yb = this.sampleToWorld(b, b.tick, b.tick, wb);
    out.x += (wb.x - out.x) * f;
    out.y += (wb.y - out.y) * f;
    out.z += (wb.z - out.z) * f;
    return { yaw: lerpAngle(ya, yb, f), carrierId: a.carrierId, look };
  }

  /**
   * Before structure `id` is removed in the batch of `tick`: every entity sample carried by it
   * moves into its parent's frame at its pose at the sample's tick, yaw from the removed carrier's
   * world heading to the parent's (sections 7, 18). A sample holds until the next one (the entity
   * did not move on its carrier), and the carrier moved meanwhile: so a carried sample is also
   * converted at every tick up to the next sample (the last one: up to `tick`, when the carrier was
   * removed), within SAMPLE_BUFFER_TICKS. Otherwise the converted ring would cut straight from the
   * carrier's old pose to the entity's first sample in the parent's frame.
   */
  private reframeRiders(id: number, tick: number): void {
    const rs = this.state.structures.get(id);
    if (rs === undefined) return; // applyBatch reports it
    const parentId = rs.structure.parent?.id ?? 0;
    for (const [eid, ring] of this.entityRings) {
      if (!ring.some((smp) => smp.carrierId === id)) continue;
      const out: EntitySample[] = [];
      for (let i = 0; i < ring.length; i++) {
        const smp = ring[i]!;
        if (smp.carrierId !== id) {
          out.push(smp);
          continue;
        }
        const end = i + 1 < ring.length ? ring[i + 1]!.tick : tick + 1;
        out.push(this.reframed(smp, smp.tick, id, parentId));
        for (let t = Math.max(smp.tick + 1, tick - SAMPLE_BUFFER_TICKS); t < end; t++) out.push(this.reframed(smp, t, id, parentId));
      }
      const kept: EntitySample[] = [];
      for (const smp of out) pushRing(kept, smp, this.state.tick);
      this.entityRings.set(eid, kept);
    }
  }

  /** A sample carried by `id` as a sample of `tick` in the frame of `parentId`, the carrier posed at `tick`. */
  private reframed(smp: EntitySample, tick: number, id: number, parentId: number): EntitySample {
    const p = vec3();
    const q = quat();
    this.worldPose(id, tick, tick, p, q);
    const pos = vec3();
    this.placeLocal(id, { p, q }, smp.pos, pos);
    let yaw = smp.yaw + headingOf(q);
    if (parentId !== 0) {
      this.worldPose(parentId, tick, tick, p, q);
      const pivot = this.state.structures.get(parentId)!.structure.grid.pivot;
      const rel = qrotate(qconj(q), vec3(pos.x - p.x, pos.y - p.y, pos.z - p.z));
      pos.x = rel.x + pivot.x;
      pos.y = rel.y + pivot.y;
      pos.z = rel.z + pivot.z;
      yaw -= headingOf(q);
    }
    return { tick, carrierId: parentId, pos, yaw: wrapAngle(yaw), look: smp.look };
  }

  /** Move a ship's ring samples older than `tick` from `oldPivot` to `newPivot` (section 7). */
  private repivot(ring: ShipRing, oldPivot: Vec3, newPivot: Vec3, tick: number): void {
    const dx = newPivot.x - oldPivot.x;
    const dy = newPivot.y - oldPivot.y;
    const dz = newPivot.z - oldPivot.z;
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      const d = vec3();
      for (const s of ring.samples) {
        if (s.tick >= tick) continue;
        d.x = dx;
        d.y = dy;
        d.z = dz;
        qrotate(s.rot, d, d);
        s.pos.x += d.x;
        s.pos.y += d.y;
        s.pos.z += d.z;
      }
    }
    if (tick > ring.pivotTick) ring.pivotTick = tick;
  }

  /** A spawn of `id` at `tick`: its waiting samples later than the tick go to `take`, the rest are dropped. */
  private adoptPending<S extends { tick: number }>(pending: Map<number, S[]>, id: number, tick: number, take: (s: S) => void): void {
    const list = pending.get(id);
    if (list === undefined) return;
    pending.delete(id);
    for (const s of list) if (s.tick > tick) take(s);
  }

  private noteTick(tick: number): void {
    if (tick <= this.newestTick) return;
    this.newestTick = tick;
    const oldest = tick - SAMPLE_BUFFER_TICKS;
    prunePending(this.pendingShips, oldest);
    prunePending(this.pendingEntities, oldest);
  }

}

// ====================================================================== helpers

function depth(s: Ship | Rotor): number {
  return s.parent === null ? 0 : 1;
}

function entitySample(tick: number, m: EntityMotion): EntitySample {
  return { tick, carrierId: m.carrierId, pos: { ...m.pos }, yaw: m.yaw, look: m.look === null ? null : { pitch: m.look.pitch, flags: { ...m.look.flags } as PlayerFlags } };
}

/** Insert by tick (ascending); a sample of a tick already held replaces it. */
function insertSample<S extends { tick: number }>(ring: S[], s: S): void {
  let i = ring.length;
  while (i > 0 && ring[i - 1]!.tick > s.tick) i--;
  if (i > 0 && ring[i - 1]!.tick === s.tick) ring[i - 1] = s;
  else ring.splice(i, 0, s);
}

/** Index of the last sample with tick <= `tick`, -1 when all are later. */
function bracket<S extends { tick: number }>(ring: readonly S[], tick: number): number {
  let i = ring.length - 1;
  while (i >= 0 && ring[i]!.tick > tick) i--;
  return i;
}

/**
 * Insert into a ring and keep SAMPLE_BUFFER_TICKS behind its newest sample, plus the newest sample
 * at or before that (the left end of an interpolation at the window's start), plus the newest
 * sample not later than `applied` (the newest applied batch's tick): renderTick never passes it,
 * so while the reliable channel stalls and samples keep arriving that one is what is shown.
 */
function pushRing<S extends { tick: number }>(ring: S[], s: S, applied: number): void {
  insertSample(ring, s);
  const n = ring.length;
  const oldest = ring[n - 1]!.tick - SAMPLE_BUFFER_TICKS;
  let cut = 0;
  while (cut < n - 1 && ring[cut + 1]!.tick <= oldest) cut++;
  if (cut === 0) return;
  let anchor = cut;
  while (anchor > 0 && ring[anchor]!.tick > applied) anchor--;
  if (anchor < cut - 1) ring.splice(anchor + 1, cut - anchor - 1);
  if (anchor > 0) ring.splice(0, anchor);
}

function pushPending<S extends { tick: number }>(pending: Map<number, S[]>, id: number, s: S): void {
  let list = pending.get(id);
  if (list === undefined) {
    list = [];
    pending.set(id, list);
  }
  insertSample(list, s);
}

function prunePending<S extends { tick: number }>(pending: Map<number, S[]>, oldest: number): void {
  for (const [id, list] of pending) {
    let cut = 0;
    while (cut < list.length && list[cut]!.tick < oldest) cut++;
    if (cut === list.length) pending.delete(id);
    else if (cut > 0) list.splice(0, cut);
  }
}

function lerpAngle(a: number, b: number, f: number): number {
  return wrapAngle(a + wrapAngle(b - a) * f);
}

/** World angular velocity turning `a` into `b` over `dt` seconds (axis * angle / dt). */
function angularVelocity(a: Quat, b: Quat, dt: number, out: Vec3): void {
  const d = qmul(b, qconj(a));
  if (d.w < 0) {
    d.x = -d.x;
    d.y = -d.y;
    d.z = -d.z;
    d.w = -d.w;
  }
  const s = Math.hypot(d.x, d.y, d.z);
  if (s < 1e-12) {
    out.x = out.y = out.z = 0;
    return;
  }
  const angle = 2 * Math.atan2(s, d.w);
  const k = angle / (s * dt);
  out.x = d.x * k;
  out.y = d.y * k;
  out.z = d.z * k;
}
