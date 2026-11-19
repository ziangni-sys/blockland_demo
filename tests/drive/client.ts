/**
 * A test harness that plays the client of a client-driven player (src/entities/drive.ts).
 *
 * The client runs its own BodyMover (relocate: false: squeezes and relocations are the server's)
 * for its own copy of the player, against the SAME world as the server and a LAGGED copy of the
 * server's structures: every structure is mirrored by a replica whose cells are the server's
 * (shared storage) and whose pose — and whether it exists at all — is the server's of `lag`
 * ticks before. It reports every tick in the carrier frame (viewTick = the tick its copies show;
 * the landings of its body counted as OwnPlayer counts them) and adopts the server's corrections.
 * The end-to-end tests use the real client instead (tests/net/e2e-own-*.test.ts); this harness
 * stays for the server's judgements with an exact, fixed lag (lag.test.ts).
 *
 * Timing (one server tick = one client tick):
 *  - The client step for server tick M runs inside tick M, after the structures moved (phase 3)
 *    and before the server's entity phases (4, 5), against the server poses of tick M - lag. Its
 *    report is applied by the server in phase 5 of the same tick, so the server's present poses
 *    lead the client's copies by exactly `lag` ticks when it judges the report. lag = 0: the client
 *    sees exactly what the server sees.
 *  - A correction settled at the end of server tick N reaches the client at its step for tick
 *    N + lag + 1 (it travels like a pose: the pose of tick N + 1 arrives then too). Until then the
 *    client's reports carry the old epoch and are dropped by the server.
 *  - `uplink` (optional) delays reports on their way up: the report of client tick M is handed to
 *    the server at tick M + uplink(M) at the earliest, and never before an earlier report (a
 *    stream transport keeps the order: when the delay drops, several arrive in one tick). The
 *    server's poses then lead the client's copies by lag + the delay.
 *
 * Scripted input: tests keep writing the SERVER player's input (control.player.input, lookAt ...);
 * the client mirrors it at its step (held keys and the jump presses, which it consumes). The look
 * is mirrored only when the script changed it since the server last applied a report: the server
 * writes the reported look back into its input.
 */
import { qrotate, qrotateInv, vec3, type Quat, type Vec3 } from '../../src/core/math';
import { BodyMover, sanitizeInput, takeJumpPresses, type BodyHost } from '../../src/entities/body';
import { copyReport, emptyReport, type Correction, type MoveReport } from '../../src/entities/drive';
import { Player } from '../../src/entities/entity';
import { curToLocal, curToWorld, headingOf, pointVelocity, type BodyStructure } from '../../src/entities/structs';
import type { HullInfo } from '../../src/structures/hull';
import type { Structure } from '../../src/structures/structure';
import type { PlayerControl } from '../../src/sim/players';
import type { Simulation } from '../../src/sim/simulation';
import { StructureGrid } from '../../src/voxel/sgrid';
import type { World } from '../../src/voxel/world';

/** A client's copy of a server structure. */
export class ReplicaStructure implements BodyStructure {
  readonly id: number;
  readonly grid: StructureGrid;
  parent: ReplicaStructure | null = null;
  readonly children: ReplicaStructure[] = [];
  removed = false;
  hull: HullInfo | null = null;
  constructor(id: number, parentGrid: StructureGrid | World) {
    this.id = id;
    this.grid = new StructureGrid(id, parentGrid);
  }
}

/** A server structure's pose (parent space, with its pivot) at the end of a tick's structure phase. */
interface PoseRecord {
  readonly s: Structure;
  readonly parentId: number;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly pivot: Vec3;
}

interface PendingCorrection {
  /** Client step (server tick) at which it arrives. */
  due: number;
  c: Correction;
}

export interface ClientStats {
  reports: number;
  corrections: Correction[];
}

export class LaggedClient implements BodyHost {
  readonly world: World;
  /** The client's own copy of its player. */
  readonly player: Player;
  readonly body: BodyMover;
  readonly stats: ClientStats = { reports: 0, corrections: [] };
  /** Called after each client step with the report it sent (tests' traces). */
  onReport: ((r: MoveReport) => void) | null = null;
  /** A cheating client: may change each report before it is sent. */
  tamper: ((r: MoveReport) => void) | null = null;

  private readonly replicas = new Map<number, ReplicaStructure>();
  private list: ReplicaStructure[] = [];
  /** history[tick] = every server structure's pose after that tick's structure phase. */
  private readonly history = new Map<number, PoseRecord[]>();
  private readonly incoming: PendingCorrection[] = [];
  /** Reports on their way up (in order). */
  private readonly outgoing: Array<{ due: number; r: MoveReport }> = [];
  private lastDue = -Infinity;
  private epoch = 0;
  private seq = 0;
  private landings = 0;
  private readonly report: MoveReport = emptyReport();
  /** The server input's look right after the server applied our last report (see the file comment). */
  private seenYaw = NaN;
  private seenPitch = NaN;
  private adoptNow: Correction | null = null;

  constructor(
    readonly sim: Simulation,
    readonly control: PlayerControl,
    readonly lag: number,
    /** Extra ticks the report of a client tick spends on its way up (default none). */
    readonly uplink: ((clientTick: number) => number) | null = null,
  ) {
    this.world = sim.world;
    this.body = new BodyMover(this, { relocate: false });
    const sp = control.player;
    this.player = new Player(sp.id, sp.mode);
    control.setDrive('client');
    // The switch is a correction: adopt it at the first step, wherever the poses are then.
    const c = control.takeCorrection();
    if (c === null) throw new Error('setDrive(client) raised no correction');
    this.adoptNow = c;
    this.epoch = c.epoch;
    this.player.setPosition(sp.pos.x, sp.pos.y, sp.pos.z);
    this.player.yaw = sp.yaw;
    this.player.pitch = sp.pitch;
    this.player.input.yaw = sp.input.yaw;
    this.player.input.pitch = sp.input.pitch;
    this.seenYaw = sp.input.yaw;
    this.seenPitch = sp.input.pitch;
    this.install();
  }

  structures(): readonly BodyStructure[] {
    return this.list;
  }

  /** Corrections received so far, by cause. */
  causes(): string[] {
    return this.stats.corrections.map((c) => c.cause);
  }

  private install(): void {
    const sim = this.sim;
    const entities = sim.entities;
    const carry = entities.syncCarried.bind(entities);
    entities.syncCarried = () => {
      this.step();
      carry();
    };
    const tick = sim.tick.bind(sim);
    sim.tick = () => {
      tick();
      this.afterServerTick();
    };
  }

  /** After a server tick: take its correction (it travels `lag` ticks) and remember the look the server applied. */
  private afterServerTick(): void {
    const c = this.control.takeCorrection();
    if (c !== null) this.incoming.push({ due: this.sim.ticks + this.lag + 1, c });
    const inp = this.control.player.input;
    this.seenYaw = inp.yaw;
    this.seenPitch = inp.pitch;
  }

  // ------------------------------------------------------------------ the client's tick

  private step(): void {
    const sim = this.sim;
    const now = sim.ticks;
    this.record(now);
    this.updateReplicas(now - this.lag);
    // Corrections that arrived.
    for (let i = 0; i < this.incoming.length; ) {
      const pc = this.incoming[i]!;
      if (pc.due <= now) {
        this.incoming.splice(i, 1);
        this.adoptNow = pc.c;
        this.stats.corrections.push(pc.c);
      } else i++;
    }
    const p = this.player;
    const sp = this.control.player;
    // Private state the server tells its client.
    p.mode = sp.mode;
    p.dead = sp.dead;
    const body = this.body;
    body.beginCarry();
    const adopt = this.adoptNow;
    this.adoptNow = null;
    if (adopt !== null) this.adopt(adopt);
    // Mirror the script's input (after a correction: what the script wrote since is newer).
    const si = sp.input;
    const ci = p.input;
    ci.forward = si.forward;
    ci.strafe = si.strafe;
    ci.jump = si.jump;
    ci.sneak = si.sneak;
    ci.sprint = si.sprint;
    ci.jumpPresses += si.jumpPresses;
    si.jumpPresses = 0;
    if (si.yaw !== this.seenYaw) ci.yaw = si.yaw;
    if (si.pitch !== this.seenPitch) ci.pitch = si.pitch;
    if (p.dead) {
      body.endTick();
      this.deliver(now);
      return;
    }
    p.carryBlocked = false;
    if (adopt === null) {
      if (p.steeringShipId !== 0) {
        if (body.followSeat(p) !== 'seated' && p.carrierId !== 0) body.carryRider(p);
      } else if (p.carrierId !== 0) body.carryRider(p);
    }
    body.beginStep(p);
    sanitizeInput(p);
    const presses = takeJumpPresses(p);
    if (p.mode !== 'creative') p.flying = false;
    const wasOnGround = p.onGround;
    body.stepPlayer(p, presses, p.mode === 'creative');
    if (p.onGround && !wasOnGround) this.landings = (this.landings + 1) & 255;
    body.endTick();
    this.sendReport();
  }

  /** Hand the reports that arrived by server tick `now` to the server (oldest first). */
  private deliver(now: number): void {
    const out = this.outgoing;
    let k = 0;
    while (k < out.length && out[k]!.due <= now) this.control.submitReport(out[k++]!.r);
    out.splice(0, k);
  }

  /** Adopt the server's authoritative state (at the client's present copy of the carrier). */
  private adopt(c: Correction): void {
    const p = this.player;
    this.epoch = c.epoch;
    p.steeringShipId = c.seatShipId;
    p.seat.x = c.seat.x;
    p.seat.y = c.seat.y;
    p.seat.z = c.seat.z;
    p.flying = c.flying;
    p.onGround = c.onGround;
    p.fallDistance = 0;
    const r = c.carrierId !== 0 ? this.body.record(c.carrierId) : undefined;
    if (r === undefined) {
      p.carrierId = 0;
      p.pos.x = c.pos.x;
      p.pos.y = c.pos.y;
      p.pos.z = c.pos.z;
      p.carrierVel.x = p.carrierVel.y = p.carrierVel.z = 0;
      p.vel.x = c.vel.x;
      p.vel.y = c.vel.y;
      p.vel.z = c.vel.z;
      p.yaw = c.yaw;
    } else {
      p.carrierId = r.id;
      curToWorld(r, c.pos, p.pos);
      // The carrier's velocity at the feet: the replica's motion over the last client tick.
      pointVelocity(r, p.pos, p.carrierVel);
      const v = qrotate(r.q1, c.vel, vec3());
      p.vel.x = p.carrierVel.x + v.x;
      p.vel.y = p.carrierVel.y + v.y;
      p.vel.z = p.carrierVel.z + v.z;
      p.yaw = c.yaw + headingOf(r.q1);
    }
    p.pitch = c.pitch;
    p.input.yaw = p.yaw;
    p.input.pitch = p.pitch;
  }

  private sendReport(): void {
    const p = this.player;
    const rep = this.report;
    rep.seq = ++this.seq;
    rep.epoch = this.epoch;
    rep.viewTick = Math.max(0, this.sim.ticks - this.lag);
    rep.landings = this.landings;
    const r = p.carrierId !== 0 ? this.body.record(p.carrierId) : undefined;
    if (r !== undefined) {
      rep.carrierId = r.id;
      curToLocal(r, p.pos, rep.pos);
      const v = vec3(p.vel.x - p.carrierVel.x, p.vel.y - p.carrierVel.y, p.vel.z - p.carrierVel.z);
      qrotateInv(r.q1, v, rep.vel);
      rep.yaw = p.yaw - headingOf(r.q1);
    } else {
      rep.carrierId = 0;
      rep.pos.x = p.pos.x;
      rep.pos.y = p.pos.y;
      rep.pos.z = p.pos.z;
      rep.vel.x = p.vel.x;
      rep.vel.y = p.vel.y;
      rep.vel.z = p.vel.z;
      rep.yaw = p.yaw;
    }
    rep.pitch = p.pitch;
    rep.onGround = p.onGround;
    rep.sneaking = p.sneaking;
    rep.sprinting = p.sprinting;
    rep.flying = p.flying;
    rep.forward = p.input.forward;
    rep.strafe = p.input.strafe;
    rep.sneak = p.input.sneak;
    this.tamper?.(rep);
    this.stats.reports++;
    const now = this.sim.ticks;
    if (this.uplink === null) this.control.submitReport(rep);
    else {
      const due = Math.max(now + this.uplink(now), this.lastDue);
      this.lastDue = due;
      this.outgoing.push({ due, r: copyReport(rep, emptyReport()) });
      this.deliver(now);
    }
    this.onReport?.(rep);
  }

  // ------------------------------------------------------------------ lagged replicas

  private record(tick: number): void {
    const recs: PoseRecord[] = [];
    for (const s of this.sim.structures.all()) {
      if (s.removed) continue;
      const g = s.grid;
      recs.push({
        s,
        parentId: s.parent?.id ?? 0,
        position: vec3(g.position.x, g.position.y, g.position.z),
        rotation: { x: g.rotation.x, y: g.rotation.y, z: g.rotation.z, w: g.rotation.w },
        pivot: vec3(g.pivot.x, g.pivot.y, g.pivot.z),
      });
    }
    this.history.set(tick, recs);
    this.history.delete(tick - this.lag - 4);
  }

  private recordAt(tick: number): PoseRecord[] {
    for (let t = tick; t <= tick + this.lag + 2; t++) {
      const h = this.history.get(t);
      if (h !== undefined) return h;
    }
    return [];
  }

  /** The replicas show the server's structures as they were after tick `tick`'s structure phase. */
  private updateReplicas(tick: number): void {
    const cur = this.recordAt(tick);
    const prev = this.history.get(tick - 1) ?? cur;
    const seen = new Set<number>();
    // Parents before children (records are in the manager's order; create on demand).
    const byId = new Map<number, PoseRecord>();
    for (const r of cur) byId.set(r.s.id, r);
    const ensure = (rec: PoseRecord): ReplicaStructure => {
      let rep = this.replicas.get(rec.s.id);
      const parentRec = rec.parentId !== 0 ? byId.get(rec.parentId) : undefined;
      const parent = parentRec !== undefined ? ensure(parentRec) : null;
      if (rep === undefined || rep.parent !== parent) {
        rep = new ReplicaStructure(rec.s.id, parent !== null ? parent.grid : this.world);
        rep.parent = parent;
        this.replicas.set(rec.s.id, rep);
      }
      return rep;
    };
    const list: ReplicaStructure[] = [];
    for (const rec of cur) {
      const rep = ensure(rec);
      if (seen.has(rep.id)) continue;
      seen.add(rep.id);
      list.push(rep);
      const sg = rec.s.grid;
      const g = rep.grid;
      // Shared cells: the server's storage as it is now (all three layers).
      g.adoptStorage(sg);
      rep.hull = (rec.s as { hull?: HullInfo | null }).hull ?? null;
      // Lagged pose.
      const pr = prev.find((r) => r.s.id === rec.s.id) ?? rec;
      g.pivot.x = rec.pivot.x;
      g.pivot.y = rec.pivot.y;
      g.pivot.z = rec.pivot.z;
      g.position.x = rec.position.x;
      g.position.y = rec.position.y;
      g.position.z = rec.position.z;
      copyQ(g.rotation, rec.rotation);
      g.prevPosition.x = pr.position.x;
      g.prevPosition.y = pr.position.y;
      g.prevPosition.z = pr.position.z;
      copyQ(g.prevRotation, pr.rotation);
    }
    for (const rep of this.replicas.values()) {
      rep.children.length = 0;
      if (!seen.has(rep.id)) {
        rep.removed = true;
        this.replicas.delete(rep.id);
      }
    }
    for (const rep of list) if (rep.parent !== null) rep.parent.children.push(rep);
    this.list = list;
  }
}

function copyQ(out: Quat, q: Quat): void {
  out.x = q.x;
  out.y = q.y;
  out.z = q.z;
  out.w = q.w;
}

/** Make the one joined player of `sim` client-driven, played by a LaggedClient with `lag` ticks of pose lag (and an optional uplink delay). */
export function attachClient(sim: Simulation, lag: number, control: PlayerControl = sim.soloPlayer, uplink: ((clientTick: number) => number) | null = null): LaggedClient {
  return new LaggedClient(sim, control, lag, uplink);
}
