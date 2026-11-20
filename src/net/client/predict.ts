/**
 * The client's own player (docs/NETCODE.md sections 4 and 9): OwnPlayer.
 *
 * The client moves its own player itself, against its replica, with the movement code the server
 * uses for every body (entities/body.ts BodyMover, relocate off: squeezes and relocations are the
 * server's), reports every client tick (MoveReport, unreliable) and adopts the server's
 * corrections. It is the authority on its own motion: the server only speaks when it moved the
 * player on its own authority or refused a report (entities/drive.ts), and then the client takes
 * the corrected state as it is (no replay of inputs) and reports with the correction's epoch from
 * then on.
 *
 * DRIVING. The embedding code (the page, tests/net/harness.ts HeadlessClient) owns the held input
 * (HeldInput: the keys and the look, kept across reconnections), creates one OwnPlayer per
 * connection once NetClient is ready, and calls:
 *  - onBatch(batch) from NetClient.onBatch: a correction in the batch is adopted at the next
 *    client tick;
 *  - frame(now, clock) after every NetClient.frame(now): the client ticks that are due, then the
 *    replica back at the frame's poses, then the display state (displayPos, cameraJumped, reloading).
 * Package 7 reads lastSeq (an intent's moveSeq) and the eyes of the player; package 9 reads the
 * display state and writes the held input.
 *
 * PACING (sections 4, 9). Client tick k runs when rotorTick reaches k: rotorTick is the server tick
 * at which a report sent now is applied there (measured, ServerClock.rotorLead), so the client ticks
 * as fast as the server's clock, never faster (package 2 corrects a client that runs ahead once
 * REPORT_DEBT_TICKS of debt are spent), and tick k sees the rotors exactly where the server's tick k
 * has them when it applies the report (the blade that pushes the player is where the server's is).
 * More than MAX_STEPS_PER_FRAME due in one frame (a long frame, a jump of rotorLead): the rest are
 * dropped, like the server's catch-up; a clock that went back (a host stall ended, the page's pause
 * reset it) starts over from where it is. Either way the first tick after the gap takes the frame's
 * renderTick and puts the player back in its carrier's frame where the last tick left it (reanchor).
 *
 * ONE CLIENT TICK k (section 9, "在行驶的船上"), in the server's order (LESSONS 每个 tick 的顺序):
 *  1. the replica's poses for this tick: rotors at rotorTick k, ships at this tick's renderTick (the
 *     frame's renderTick shifted back by the frame's rotorTick - k, never before the previous
 *     tick's, never more than REPORT_VIEW_RATE ticks after it: consecutive ticks see the ships one
 *     tick apart, so the carrier velocities are right, and after a stalled reliable channel the
 *     copies catch up gradually instead of carrying the player off its deck in one jump);
 *  2. the structure cache reads them (beginCarry); a waiting correction is adopted here, converted
 *     with these poses (its carrier as the client shows it: no compensation for the lag), else
 *     the player is carried by its carrier, or follows its seat while it steers;
 *  3. the body's own step from the held input (stepPlayer; double-tap jump flies in creative);
 *  4. the view yaw follows a turning carrier: the held look turns by what the carriers turned the
 *     player (Player.carriedYaw, section 9 item 6);
 *  5. the report: seq, epoch, viewTick = floor(this tick's renderTick), the carrier and the feet and
 *     velocity in its frame, the look relative to its heading, the flags, the stick axes and sneak
 *     key (steering, docking), the landings counted so far (the mover's touch-downs: a step that
 *     ends on the ground after one that did not, StepFacts.touchedDown).
 * The body is frozen (no step, and no report: the client is not moving it, and the server holds it,
 * or lets it fall when nothing holds it up, as before the client was ready) while dead, while a
 * reload after a far correction is under way, while a correction waits for its carrier to reach
 * the replica, and while the column under its feet is not in the replica (LESSONS 船被弹飞: never
 * fall into the unknown). A frozen rider still rides along with its carrier. Its seq still counts
 * the client ticks.
 *
 * DISPLAY (section 9). The player is shown "now": between the last two client ticks by the
 * fraction of rotorTick past the last one, in its carrier's frame (placed with the carrier's display
 * pose, so it stays on the deck). A correction less than JUMP_DISTANCE from the prediction is
 * blended over BLEND_MS in the carrier's frame (only the picture: the state is the correction's at
 * once); farther, the picture jumps (cameraJumped()); farther than RELOAD_DISTANCE (respawn, a far
 * teleport) the client reloads: `reloading` until the ready zone around the new place is in the
 * replica (sections 3, 9).
 *
 * LOOK. The look is the client's: the held input's, which the page writes. Corrections leave it
 * alone (the server never moves the look), except the first one of a connection, which tells
 * where the player looks after joining.
 */
import { qrotate, qrotateInv, vec3, wrapAngle, type Vec3 } from '../../core/math';
import { BodyMover, sanitizeInput, takeJumpPresses, type BodyHost, type BodyStructure } from '../../entities/body';
import { REPORT_VIEW_RATE } from '../../entities/constants';
import { emptyReport } from '../../entities/drive';
import { Player } from '../../entities/entity';
import { carryPoint, curToLocal, curToWorld, headingOf, pointVelocity } from '../../entities/structs';
import { CHUNK_SHIFT } from '../../core/constants';
import type { World } from '../../voxel/world';
import type { NetCorrection, NetMoveReport, TickBatchMsg } from '../protocol';
import type { ServerClock } from './clock';
import type { ClientReplica } from './replica';

/** A correction closer than this (blocks) to the prediction is blended (section 9) ... */
export const JUMP_DISTANCE = 1;
/** ... over this long (ms). */
export const BLEND_MS = 100;
/** A correction farther than this (blocks) reloads (section 9). */
export const RELOAD_DISTANCE = 48;
/** Client ticks run in one frame at most. */
export const MAX_STEPS_PER_FRAME = 5;

/** What the player holds (keys, look): the page writes it, OwnPlayer reads it every client tick. */
export interface HeldInput {
  /** -1..1, forward = +1. */
  forward: number;
  /** -1..1, right = +1. */
  strafe: number;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
  /** World look (radians, ARCHITECTURE 朝向); OwnPlayer turns it with the carrier. */
  yaw: number;
  pitch: number;
  /** Jump key presses since the last client tick (double-tap toggles flight); OwnPlayer takes them. */
  jumpPresses: number;
}

export function emptyHeldInput(): HeldInput {
  return { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0, pitch: 0, jumpPresses: 0 };
}

/** How a correction was shown. */
export type CorrectionDisplay = 'blend' | 'jump' | 'reload';

/** A correction the client adopted (onCorrection). */
export interface AdoptedCorrection {
  readonly correction: NetCorrection;
  /** World distance (blocks) between the prediction and the corrected place, at the poses of the client tick that adopted it. */
  readonly distance: number;
  readonly display: CorrectionDisplay;
  /** The client tick (seq of its report) that adopted it. */
  readonly seq: number;
}

export interface OwnPlayerOptions {
  /** Subscription radius (the ready zone of a reload, section 3). */
  viewRadius: number;
  /** Called at every client tick before the held input is read (a scripted player sets it there); `seq` = the tick's report. */
  beforeStep?: (seq: number) => void;
  /** Called for every adopted correction. */
  onCorrection?: (c: AdoptedCorrection) => void;
}

/** Where the display state of a client tick puts the player: its carrier and its feet in that frame. */
interface Shown {
  carrierId: number;
  readonly local: Vec3;
}

export class OwnPlayer implements BodyHost {
  /** The client's own copy of its player. */
  readonly player: Player;
  readonly body: BodyMover;
  /** Seq of the last report sent (seqs count client ticks; a frozen tick sends none). */
  lastSeq = 0;
  /** The client tick being run or last run: the rotorTick it posed the rotors at (the server tick its report is meant for). */
  tick = -Infinity;
  /** Epoch of the last adopted correction. */
  epoch = 0;
  /** Landings of the body so far, mod 256 (the reports carry it). */
  landings = 0;
  /** A far correction is being reloaded (the page shows its loading screen): the body is frozen. */
  reloading = false;

  private pending: NetCorrection | null;
  /** Client ticks run so far (the seq of the last one). */
  private ticks = 0;
  private adoptedAny = false;
  /** Last client tick run (rotorTick), and its renderTick. */
  private lastTick: number | null = null;
  private lastRender = -Infinity;
  private cameraJump = false;
  private readonly rep: NetMoveReport = emptyReport();
  // display
  private prevShown: Shown = { carrierId: 0, local: vec3() };
  private curShown: Shown = { carrierId: 0, local: vec3() };
  private alpha = 1;
  private blendCarrier = 0;
  private readonly blend: Vec3 = vec3();
  private blendAt = -Infinity;
  // scratch (per instance, ARCHITECTURE rule 5)
  private readonly t1: Vec3 = vec3();
  private readonly t2: Vec3 = vec3();

  constructor(
    readonly replica: ClientReplica,
    /** The held input (owned by the page; kept across connections). */
    readonly input: HeldInput,
    private readonly send: (r: NetMoveReport) => void,
    private readonly opts: OwnPlayerOptions,
  ) {
    const vitals = replica.state.private.vitals;
    this.player = new Player(replica.ownEntityId, vitals?.mode ?? replica.state.rules.defaultMode);
    this.body = new BodyMover(this, { relocate: false });
    // The latest correction (the join's, or a later one) puts the player where the server has it.
    this.pending = replica.state.private.correction;
  }

  // ------------------------------------------------------------------ BodyHost

  get world(): World {
    return this.replica.world;
  }

  structures(): readonly BodyStructure[] {
    return this.replica.structures();
  }

  // ------------------------------------------------------------------ driving

  /**
   * The first correction (the join's) has been adopted. Before that, at most until the first client
   * tick after the OwnPlayer was made, the player's state is not where the server has it.
   */
  get placed(): boolean {
    return this.adoptedAny;
  }

  /** A batch was applied (NetClient.onBatch): its correction is adopted at the next client tick. */
  onBatch(b: TickBatchMsg): void {
    const c = b.private?.correction;
    if (c !== undefined && c.epoch > (this.pending?.epoch ?? this.epoch)) this.pending = c;
  }

  /** After NetClient.frame(now): run the client ticks that are due (see PACING), then pose the replica for display again. */
  frame(now: number, clock: ServerClock): void {
    const render = clock.renderTick;
    const rotor = clock.rotorTick;
    if (!Number.isFinite(render) || !Number.isFinite(rotor)) return;
    const due = Math.floor(rotor);
    // Client ticks were skipped (a stall, a hidden page, a clock that went back): the body was not
    // moved meanwhile, and the poses of the last tick run may be gone from the replica's rings.
    let gap = false;
    if (this.lastTick === null) this.lastTick = due - 1;
    else if (due < this.lastTick - MAX_STEPS_PER_FRAME || due - this.lastTick > MAX_STEPS_PER_FRAME) {
      this.lastTick = due - Math.min(MAX_STEPS_PER_FRAME, Math.max(1, due - this.lastTick));
      gap = true;
    }
    for (let k = this.lastTick + 1; k <= due; k++) {
      // This tick's renderTick: one tick apart from the previous one, never past the frame's, never
      // back, and catching up at most REPORT_VIEW_RATE ticks a tick (a stalled channel let the
      // frame's run ahead: one jump would carry a rider off its deck). After skipped ticks it starts
      // over from the frame's, the player re-anchored in its carrier's frame (see SKIPPED TICKS).
      let r = render - (rotor - k);
      if (this.lastRender !== -Infinity && !gap) {
        if (r > this.lastRender + REPORT_VIEW_RATE) r = this.lastRender + REPORT_VIEW_RATE;
        if (r < this.lastRender) r = this.lastRender;
      }
      if (r > render) r = render;
      this.step(r, k, now, gap);
      gap = false;
      this.lastRender = r;
      this.lastTick = k;
    }
    this.alpha = Math.min(1, Math.max(0, rotor - this.lastTick));
    this.replica.setPoses(render, rotor);
  }

  // ------------------------------------------------------------------ display

  /**
   * Where the player is shown now (feet, world), between the last two client ticks in its
   * carrier's frame, placed with the carrier's display pose, plus what is left of a blend.
   */
  displayPos(now: number, out: Vec3 = vec3()): Vec3 {
    const a = this.prevShown;
    const b = this.curShown;
    const l = this.t2;
    const f = a.carrierId === b.carrierId ? this.alpha : 1;
    l.x = a.local.x + (b.local.x - a.local.x) * f;
    l.y = a.local.y + (b.local.y - a.local.y) * f;
    l.z = a.local.z + (b.local.z - a.local.z) * f;
    const k = 1 - (now - this.blendAt) / BLEND_MS;
    if (k > 0 && this.blendCarrier === b.carrierId) {
      l.x += this.blend.x * k;
      l.y += this.blend.y * k;
      l.z += this.blend.z * k;
    }
    if (b.carrierId === 0) return copy3(out, l);
    const s = this.replica.state.structures.get(b.carrierId);
    return s === undefined ? copy3(out, this.player.pos) : s.structure.grid.toWorld(l, out);
  }

  /** The carrier the player is shown on (0 = none). */
  get displayCarrierId(): number {
    return this.curShown.carrierId;
  }

  /** A correction made the picture jump since the last call (the camera jumps with it). */
  cameraJumped(): boolean {
    const j = this.cameraJump;
    this.cameraJump = false;
    return j;
  }

  // ------------------------------------------------------------------ one client tick

  private step(renderTick: number, rotorTick: number, now: number, reanchor: boolean): void {
    const replica = this.replica;
    const body = this.body;
    const p = this.player;
    const seq = ++this.ticks;
    this.tick = rotorTick;
    if (reanchor) this.reanchor(renderTick, rotorTick);
    replica.setPoses(renderTick, rotorTick);
    body.beginCarry();
    const vitals = replica.state.private.vitals;
    if (vitals !== null) {
      p.mode = vitals.mode;
      p.dead = vitals.dead;
    }
    let adopted = false;
    if (this.pending !== null && this.adopt(this.pending, seq, now)) {
      this.pending = null;
      adopted = true;
    }
    if (this.reloading) {
      const cx = Math.floor(p.pos.x) >> CHUNK_SHIFT;
      const cz = Math.floor(p.pos.z) >> CHUNK_SHIFT;
      if (replica.readyZoneLoaded(cx, cz, this.opts.viewRadius)) this.reloading = false;
    }
    this.opts.beforeStep?.(seq);
    const h = this.input;
    const inp = p.input;
    inp.forward = h.forward;
    inp.strafe = h.strafe;
    inp.jump = h.jump;
    inp.sneak = h.sneak;
    inp.sprint = h.sprint;
    inp.yaw = h.yaw;
    inp.pitch = h.pitch;
    inp.jumpPresses = h.jumpPresses;
    h.jumpPresses = 0;
    sanitizeInput(p);
    const frozen = p.dead || this.reloading || this.pending !== null || !replica.world.isLoaded(Math.floor(p.pos.x), Math.floor(p.pos.z));
    if (frozen) {
      inp.jumpPresses = 0;
      // A frozen rider still rides along (no sweeps: the world around may be missing).
      const r = p.carrierId !== 0 && !adopted ? body.record(p.carrierId) : undefined;
      if (r !== undefined) carryPoint(r, p.pos, p.pos);
    } else {
      p.carryBlocked = false;
      if (!adopted) {
        if (p.steeringShipId !== 0) {
          if (body.followSeat(p) !== 'seated' && p.carrierId !== 0) body.carryRider(p);
        } else if (p.carrierId !== 0) body.carryRider(p);
      }
      body.beginStep(p);
      const presses = takeJumpPresses(p);
      if (p.mode !== 'creative') p.flying = false;
      body.stepPlayer(p, presses, p.mode === 'creative');
      if (body.facts.touchedDown) this.landings = (this.landings + 1) & 255;
    }
    body.endTick();
    // The view follows a turning carrier (section 9 item 6).
    h.yaw += p.takeCarriedYaw();
    if (!frozen) this.report(seq, renderTick);
    this.shown();
  }

  /**
   * SKIPPED TICKS: the player keeps its place in its carrier's frame across the gap (the server,
   * without reports, carries it along): feet, own velocity and heading relative to the carrier, as
   * the last client tick left them, are put back on the carrier at its pose one tick before this
   * tick's. That pose becomes the structure cache's base (carry and velocity), so this tick carries
   * one tick of real motion. Carrying the player from the last tick's pose instead would carry it
   * through the whole gap at once (off the deck: MAX_CARRY_STEP), or, catching up REPORT_VIEW_RATE
   * ticks a tick, through poses older than the replica keeps (SAMPLE_BUFFER_TICKS), which clamp.
   */
  private reanchor(renderTick: number, rotorTick: number): void {
    const body = this.body;
    const p = this.player;
    const was = p.carrierId !== 0 ? body.record(p.carrierId) : undefined;
    const local = this.t1;
    const vel = this.t2;
    let heading = 0;
    if (was !== undefined) {
      curToLocal(was, p.pos, local);
      vel.x = p.vel.x - p.carrierVel.x;
      vel.y = p.vel.y - p.carrierVel.y;
      vel.z = p.vel.z - p.carrierVel.z;
      qrotateInv(was.q1, vel, vel);
      heading = headingOf(was.q1);
    }
    this.replica.setPoses(renderTick - 1, rotorTick - 1);
    body.reset();
    body.beginCarry('now');
    body.endTick();
    const r = was !== undefined ? body.record(p.carrierId) : undefined;
    if (r === undefined) return; // not carried, or the carrier is gone (the carry lets go of it)
    curToWorld(r, local, p.pos);
    qrotate(r.q1, vel, p.vel);
    p.carrierVel.x = p.carrierVel.y = p.carrierVel.z = 0;
    const turned = wrapAngle(headingOf(r.q1) - heading);
    p.yaw += turned;
    this.input.yaw += turned;
  }

  /** Adopt a correction at this client tick's poses; false while its carrier is not in the replica. */
  private adopt(c: NetCorrection, seq: number, now: number): boolean {
    const body = this.body;
    const p = this.player;
    const r = c.carrierId !== 0 ? body.record(c.carrierId) : undefined;
    if (c.carrierId !== 0 && r === undefined) return false;
    // Where the prediction has the player at these poses: carried from the last tick's.
    const was = body.record(p.carrierId);
    const before = p.carrierId !== 0 && was !== undefined ? carryPoint(was, p.pos, this.t1) : copy3(this.t1, p.pos);
    this.epoch = c.epoch;
    p.steeringShipId = c.seatShipId;
    if (c.seat !== null) copy3(p.seat, c.seat);
    p.flying = c.flying;
    p.onGround = c.onGround;
    p.fallDistance = 0;
    if (r === undefined) {
      p.carrierId = 0;
      copy3(p.pos, c.pos);
      p.carrierVel.x = p.carrierVel.y = p.carrierVel.z = 0;
      copy3(p.vel, c.vel);
    } else {
      p.carrierId = r.id;
      curToWorld(r, c.pos, p.pos);
      // The carrier's velocity at the feet: the replica's motion over the last client tick.
      pointVelocity(r, p.pos, p.carrierVel);
      const v = qrotate(r.q1, c.vel, this.t2);
      p.vel.x = p.carrierVel.x + v.x;
      p.vel.y = p.carrierVel.y + v.y;
      p.vel.z = p.carrierVel.z + v.z;
    }
    if (!this.adoptedAny) {
      // Where the player looks after joining.
      this.adoptedAny = true;
      this.input.yaw = r === undefined ? c.yaw : c.yaw + headingOf(r.q1);
      this.input.pitch = c.pitch;
      p.yaw = this.input.yaw;
      p.pitch = c.pitch;
      this.restartShown();
      this.opts.onCorrection?.({ correction: c, distance: 0, display: 'jump', seq });
      return true;
    }
    const dx = before.x - p.pos.x;
    const dy = before.y - p.pos.y;
    const dz = before.z - p.pos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let display: CorrectionDisplay;
    if (distance < JUMP_DISTANCE) {
      display = 'blend';
      // The picture starts where the prediction was, in the new carrier's frame, and blends to the correction.
      const d = this.blend;
      d.x = dx;
      d.y = dy;
      d.z = dz;
      if (r !== undefined) qrotateInv(r.q1, d, d);
      this.blendCarrier = p.carrierId;
      this.blendAt = now;
    } else {
      display = distance > RELOAD_DISTANCE ? 'reload' : 'jump';
      this.cameraJump = true;
      this.blendAt = -Infinity;
      if (display === 'reload') this.reloading = true;
    }
    // The picture of this tick moves on from the corrected state (a blend adds the rest).
    this.restartShown();
    this.opts.onCorrection?.({ correction: c, distance, display, seq });
    return true;
  }

  /** Send this client tick's report (see ONE CLIENT TICK, 5). */
  private report(seq: number, renderTick: number): void {
    const p = this.player;
    const rep = this.rep;
    this.lastSeq = seq;
    rep.seq = seq;
    rep.epoch = this.epoch;
    rep.viewTick = Math.max(0, Math.floor(renderTick));
    const r = p.carrierId !== 0 ? this.body.record(p.carrierId) : undefined;
    if (r !== undefined) {
      rep.carrierId = r.id;
      curToLocal(r, p.pos, rep.pos);
      const v = this.t2;
      v.x = p.vel.x - p.carrierVel.x;
      v.y = p.vel.y - p.carrierVel.y;
      v.z = p.vel.z - p.carrierVel.z;
      qrotateInv(r.q1, v, rep.vel);
      rep.yaw = p.yaw - headingOf(r.q1);
    } else {
      rep.carrierId = 0;
      copy3(rep.pos, p.pos);
      copy3(rep.vel, p.vel);
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
    rep.landings = this.landings;
    this.send(rep);
  }

  /** The display state starts over at the player's present state (no streak from the old one). */
  private restartShown(): void {
    this.shown();
    this.prevShown.carrierId = this.curShown.carrierId;
    copy3(this.prevShown.local, this.curShown.local);
  }

  /** The display state of the client tick that just ran (its carrier frame at this tick's poses). */
  private shown(): void {
    const prev = this.prevShown;
    this.prevShown = this.curShown;
    this.curShown = prev;
    const p = this.player;
    const r = p.carrierId !== 0 ? this.body.record(p.carrierId) : undefined;
    prev.carrierId = r !== undefined ? r.id : 0;
    if (r !== undefined) curToLocal(r, p.pos, prev.local);
    else copy3(prev.local, p.pos);
  }
}

function copy3(out: Vec3, v: Readonly<Vec3>): Vec3 {
  out.x = v.x;
  out.y = v.y;
  out.z = v.z;
  return out;
}
