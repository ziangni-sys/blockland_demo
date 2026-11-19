/**
 * Client-driven players on the server (DESIGN 联机: 自己角色的移动由客户端计算并上报，服务器做合理性
 * 校验；站在船上时上报的是相对那条船的位置).
 *
 * A player is either SERVER-DRIVEN (the server moves it from its input, as always) or
 * CLIENT-DRIVEN: its client moves it with its own BodyMover against its copy of the world and the
 * structures and reports the result every client tick (MoveReport). The server does not move a
 * client-driven player itself; it checks each report (ReportJudge) and applies the ones that pass,
 * and it stays the authority on everything else: vitals, falls, squeezes, the helm seat.
 *
 * FRAMES. A report on a carrier is in the carrier's frame: position local to the carrier, velocity
 * relative to the carrier in its local axes, yaw relative to its heading. The server converts with
 * ITS present pose of that carrier. The client's copy of a moving ship lags the server's; a
 * world-frame report from a deck would be off by the ship's speed times the lag, the carrier-frame
 * one is not.
 *
 * EPOCHS AND CORRECTIONS. Whenever the server moves a client-driven player on its own authority
 * (a failed check, riders released by a blockify / dock / re-grid, seated at a helm or let go of
 * it, respawn, teleport, death, a squeeze or unstuck relocation, a blast's knock-back, flight
 * ended by a mode change) it raises the player's epoch and records a Correction: the authoritative
 * state in the same frames as a report. Reports of an older epoch are dropped silently; the client
 * adopts the correction and reports with the new epoch from then on. The correction's state is the
 * player's state at the end of the server tick in which it was raised (or at once, when raised
 * between ticks); until reports of the new epoch arrive the server holds the player there (riding
 * its carrier). The pending correction is per-player state (PlayerControl.correction /
 * takeCorrection); a later package sends it. The client adopts a correction by taking its state
 * (no replay): the first report of a new epoch moved one client tick from it.
 *
 * LAG. A report's `viewTick` is the server tick its client's copies of the ships showed when it
 * moved (the renderTick of that step); (server tick - viewTick) / TPS, clamped to
 * [REPORT_MAX_LAG, REPORT_LAG_LIMIT], is the lag the checks allow for: how far the server's poses
 * lead the copies the client moved against (NETCODE section 9).
 *
 * CHECKS (ReportJudge.check; a failure is a correction 'check:<what>', never a kick):
 *  - movement time: each report claims its seq gap in client ticks, granted from a credit that
 *    refills one per server tick (REPORT_CREDIT_TICKS at most) and may run REPORT_DEBT_TICKS into
 *    debt (reports arriving bunched when the uplink delay drops); a client faster than the server's
 *    clock is corrected once the debt is spent;
 *  - speed relative to the carrier ('speed'): within the movement limits for the granted time, plus
 *    what may move the body besides its legs — momentum (a carrier left, a knock-back, flight
 *    ended), other structures (as fast as one near the body moved over the report's lag: the
 *    client's copy may still move after the server's stopped), the world scraping it along its
 *    moving carrier; on a carrier switch, both carriers' speeds times the lag (the client placed
 *    the body by its copies, the server by its present poses); excess beyond that is drawn from a
 *    slack budget (REPORT_SLACK_BURST, refilled at REPORT_SLACK_RATE), so no sustained speed-up
 *    hides in it;
 *  - the vertical envelope ('rise', see VERTICAL ENVELOPE): a body nothing holds up (ground or deck
 *    under its feet at the server's poses, liquid, flight) rises no higher than a jump (or the
 *    upward speed it was given) under gravity allows; claiming to stand in mid-air does not count
 *    as standing, so the fall goes on. A report that rises above it, and a body whose reports stop
 *    in mid-air (REPORT_STALL_TICKS), falls on the server's own authority
 *    (EntityManager.fallOnServer: a correction 'fall' every tick until something holds it up or
 *    its client catches up);
 *  - not deep in world blocks or in the carrier's ('world', 'hull'; a carried body may overlap the
 *    world by its carrier's speed times the lag), unless it was as deep before or is caught there
 *    (the world holds it while its carrier moves into it: a squeeze, judged by the squeeze rules),
 *    nor through them on the way ('path': the straight path, or a dog-leg as the mover takes it,
 *    sampled every REPORT_PATH_STEP);
 *  - plus: garbage, flight only in creative, a claimed carrier near the reported feet.
 *
 * VERTICAL ENVELOPE. Its base is where something last held the body up (or a correction put it);
 * envRise sums the accepted vertical displacements since. From the base the body follows an arc:
 * a jump (or the upward speed it was given) under gravity, the motion model's step. A body held
 * up at the base may take off in any tick until the next accepted report: the reports of the
 * ticks it stood in after the base may be lost, so its arc may start up to that many ticks late.
 * The envelope is the highest of those arcs: the earliest take-off's while both ends still rise,
 * the latest one's once both fall, the arc's peak in between. A report above it (beyond what
 * pushes and a carrier switch allow) draws the excess from the slack once: the overshoot is
 * carried on in envRise, and a later report is charged only for an increase of it (envPaid),
 * so the slack pays for a small departure from the arc once and a sustained climb all the way.
 *
 * LANDINGS. Every report counts the landings of the client's body so far (mod 256). A report
 * that counts more landings than the last applied one, beyond its own (the first on the ground
 * after airborne ones), shows a landing the server never saw (reports lost or dropped): the fall
 * tracked so far ends there, judged by what was tracked, and the next fall starts at this report
 * (EntityManager.updateClientDriven). Two short drops whose landing report was lost are not one
 * long fall. The landing needs ground within the reachable fall below the lower of the two
 * places, and the vertical envelope starts again on that ground, the take-off in any tick of the
 * gap: no higher than a jump from there (a client that counts landings in mid-air climbs nothing).
 *
 * SEAT. A seated player's body is the server's: it follows the seat and is pushed off it on the
 * server whatever the drive mode. From a seated client's reports only the stick axes (helm), the
 * sneak key (docking) and the look are used.
 *
 * ACCEPTED REPORTS. The last REPORT_HISTORY accepted reports are remembered as the server took them
 * (ClientDrive.recordAccepted, at acceptance): carrier, feet and velocity relative to the carrier;
 * a seated player's are its seat's. The intents find their eyes there (NETCODE section 10, check 2):
 * only a report the server accepted, never one it merely received, refused or dropped.
 */
import { TICK_DT } from '../core/constants';
import { qrotate, qrotateInv, vec3, type AABB, type Vec3 } from '../core/math';
import type { VoxelGrid } from '../voxel/grid';
import { boxOverlapsSolid, deepestPenetration, hasSupportBelow, MAX_BOX_COORD } from '../voxel/shape';
import type { BodyMover } from './body';
import {
  FLY_SPEED,
  FLY_SPRINT_MULTIPLIER,
  FLY_VERTICAL_SPEED,
  GRAVITY,
  JUMP_SPEED,
  MAX_INHERITED_SPEED,
  REPORT_CARRIER_REACH,
  REPORT_CREDIT_TICKS,
  REPORT_HARD_TOLERANCE,
  REPORT_HISTORY,
  REPORT_LAG_LIMIT,
  REPORT_MAX_LAG,
  REPORT_PATH_STEP,
  REPORT_SLACK_BURST,
  REPORT_SUPPORT_REACH,
  REPORT_VIEW_RATE,
  SPRINT_SPEED,
  SQUEEZE_DEPTH,
  SQUEEZE_PREFER_WEIGHT,
  STEP_HEIGHT,
  SUPPORT_GAP,
  TERMINAL_SPEED,
} from './constants';
import { Player } from './entity';
import { boxAt } from './physics';
import { curToLocal, curToWorld, headingOf, pointVelocity, type StructRec } from './structs';

export type DriveMode = 'server' | 'client';

/** One client tick of a client-driven player, as its client reports it. */
export interface MoveReport {
  /** Increases by one every client tick (across epochs). */
  seq: number;
  /** The epoch of the last correction the client adopted. */
  epoch: number;
  /** Structure carrying the player, 0 = none. */
  carrierId: number;
  /** Feet: local to the carrier, or world when carrierId is 0. */
  readonly pos: Vec3;
  /** Velocity relative to the carrier in its local axes (world velocity when carrierId is 0). */
  readonly vel: Vec3;
  /** Look yaw relative to the carrier's heading (world yaw when carrierId is 0), and pitch. */
  yaw: number;
  pitch: number;
  onGround: boolean;
  sneaking: boolean;
  sprinting: boolean;
  flying: boolean;
  /** Held input the server still needs: the stick axes (steering a helm) and the sneak key (docking). */
  forward: number;
  strafe: number;
  sneak: boolean;
  /** The server tick the client's copies of the ships showed for this step (its renderTick, floored): see LAG. */
  viewTick: number;
  /** Landings of the client's body so far, mod 256: see LANDINGS. */
  landings: number;
}

/** The authoritative state of a client-driven player, in the frames of a report (see the file comment). */
export interface Correction {
  epoch: number;
  /** Why the server moved the player (diagnostics, tests): 'check:<what>', 'release', 'seat', 'unseat:<cause>', 'respawn', 'teleport', 'death', 'crush', 'unstick', 'knock', 'mode', 'drive'. */
  cause: string;
  carrierId: number;
  readonly pos: Vec3;
  readonly vel: Vec3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  flying: boolean;
  /** The ship whose wheel the player holds (0 = none) and its seat (feet, local to that ship). */
  seatShipId: number;
  readonly seat: Vec3;
}

export function emptyReport(): MoveReport {
  return {
    seq: 0,
    epoch: 0,
    carrierId: 0,
    pos: vec3(),
    vel: vec3(),
    yaw: 0,
    pitch: 0,
    onGround: false,
    sneaking: false,
    sprinting: false,
    flying: false,
    forward: 0,
    strafe: 0,
    sneak: false,
    viewTick: 0,
    landings: 0,
  };
}

export function copyReport(src: MoveReport, out: MoveReport): MoveReport {
  out.seq = src.seq;
  out.epoch = src.epoch;
  out.carrierId = src.carrierId;
  out.pos.x = src.pos.x;
  out.pos.y = src.pos.y;
  out.pos.z = src.pos.z;
  out.vel.x = src.vel.x;
  out.vel.y = src.vel.y;
  out.vel.z = src.vel.z;
  out.yaw = src.yaw;
  out.pitch = src.pitch;
  out.onGround = src.onGround;
  out.sneaking = src.sneaking;
  out.sprinting = src.sprinting;
  out.flying = src.flying;
  out.forward = src.forward;
  out.strafe = src.strafe;
  out.sneak = src.sneak;
  out.viewTick = src.viewTick;
  out.landings = src.landings;
  return out;
}

/** The lag (seconds) the checks allow for a report of `viewTick` applied in server tick `tick` (see LAG). */
export function reportLag(tick: number, viewTick: number): number {
  const lag = (tick - viewTick) * TICK_DT;
  // (NaN, from a garbage viewTick, gets the least.)
  return lag > REPORT_LAG_LIMIT ? REPORT_LAG_LIMIT : lag > REPORT_MAX_LAG ? lag : REPORT_MAX_LAG;
}

/** Ticks of structure motion the checks remember (the largest lag, REPORT_LAG_LIMIT). */
const SPEED_MEMORY_TICKS = Math.ceil(REPORT_LAG_LIMIT / TICK_DT);

/** An accepted report as the server took it (see ACCEPTED REPORTS). */
export interface AcceptedReport {
  readonly seq: number;
  /** The epoch it was accepted in. */
  readonly epoch: number;
  /** 0 = the world; pos and vel are local to that structure otherwise. */
  readonly carrierId: number;
  /** Feet. */
  readonly pos: Vec3;
  /** Velocity relative to the carrier, in its local axes (blocks per second). */
  readonly vel: Vec3;
}

interface AcceptedSlot {
  seq: number;
  epoch: number;
  carrierId: number;
  readonly pos: Vec3;
  readonly vel: Vec3;
}

function emptyCorrection(): Correction {
  return { epoch: 0, cause: '', carrierId: 0, pos: vec3(), vel: vec3(), yaw: 0, pitch: 0, onGround: false, flying: false, seatShipId: 0, seat: vec3() };
}

/** Server-side state of a client-driven player (Player.remote). */
export class ClientDrive {
  /** Current epoch: reports must carry it. Starts at 1 (the switch to client driving is itself a correction). */
  epoch = 0;
  /** Highest accepted report sequence number. */
  lastSeq = -Infinity;
  /** Reports received since the last tick (oldest first), copies (EntityManager.submitReport). */
  readonly queue: MoveReport[] = [];
  /** Spare report objects (the queue recycles them). */
  readonly spare: MoveReport[] = [];

  // ---- the reference: the last accepted state (or the last correction), in the report frames
  carrierId = 0;
  readonly pos: Vec3 = vec3();
  readonly vel: Vec3 = vec3();
  yaw = 0;
  pitch = 0;
  onGround = false;

  /** The reference flew (the last accepted report, or the correction). */
  flying = false;
  /**
   * No report of the current epoch was accepted yet. The client adopts a correction by taking its
   * state (no replay), so the first report of an epoch moved one client tick from it, whatever
   * its seq gap says.
   */
  fresh = true;

  /** Movement time in store (ticks): server ticks passed minus client ticks reported; in [-REPORT_DEBT_TICKS, REPORT_CREDIT_TICKS]. */
  credit = REPORT_CREDIT_TICKS;
  /** Distance (blocks) reports may still exceed their allowances by; REPORT_SLACK_BURST at most, refills at REPORT_SLACK_RATE. */
  slack = REPORT_SLACK_BURST;
  /** Speed (blocks/s) the body may still have from a carrier it left, a knock-back or flight it ended; decays. */
  inherit = 0;
  /** viewTick of the last accepted report (-1 before the first), and the lag (seconds, see LAG) the checks allowed it. */
  viewTick = -1;
  lag = REPORT_MAX_LAG;
  /** Server tick at which the last correction was settled (its state taken). */
  settledTick = 0;
  /** `landings` of the last accepted report, and whether that report claimed to stand (see LANDINGS). */
  landings = 0;
  reportedOnGround = false;
  /**
   * Per tick (the last REPORT_LAG_LIMIT): the fastest motion (blocks/s, relative to the body's
   * carrier) of a structure near the body, and the speed of its carrier at it. Over a report's lag,
   * the client's lagging copy may still move like that after the server's stopped (a ship ramming a
   * pier stops dead on the server first, and carries its rider into what it stopped at).
   */
  private readonly pushRing = new Float64Array(SPEED_MEMORY_TICKS);
  private readonly carrierRing = new Float64Array(SPEED_MEMORY_TICKS);
  private ringAt = 0;

  /** This tick's structure speed near the body and carrier speed at it. */
  recordSpeeds(push: number, carrier: number): void {
    this.ringAt = (this.ringAt + 1) % this.pushRing.length;
    this.pushRing[this.ringAt] = push;
    this.carrierRing[this.ringAt] = carrier;
  }

  /** Fastest structure motion near the body over the last `lag` seconds (recordSpeeds). */
  pushWithin(lag: number): number {
    return this.ringMax(this.pushRing, lag);
  }

  /** Fastest speed of the body's carrier at it over the last `lag` seconds (recordSpeeds). */
  carrierWithin(lag: number): number {
    return this.ringMax(this.carrierRing, lag);
  }

  private ringMax(ring: Float64Array, lag: number): number {
    const n = Math.min(ring.length, Math.ceil(lag / TICK_DT - 1e-9));
    let m = 0;
    for (let k = 0, i = this.ringAt; k < n; k++, i = i === 0 ? ring.length - 1 : i - 1) if (ring[i]! > m) m = ring[i]!;
    return m;
  }

  // ---- vertical envelope: nothing lifts a body that nothing holds up (ground, liquid, flight)
  /** Height (blocks) the reference rose above the envelope's base, where something last held it up (accepted vertical displacements summed). */
  envRise = 0;
  /**
   * The arcs the body may be on: from the base, a jump (or the upward speed it was given) under
   * gravity, taken off at any tick of a window (see VERTICAL ENVELOPE). The earliest take-off's
   * arc: its height above the base by now and its upward speed (blocks/s) ...
   */
  envTop = 0;
  envVy = JUMP_SPEED;
  /** ... the latest take-off's arc ... */
  envTopLate = 0;
  envVyLate = JUMP_SPEED;
  /** ... the highest point of the arc ... */
  envPeak = arcPeak(JUMP_SPEED);
  /** ... and whether the body is still held up at the base (the reference is): its take-off may still come in any tick up to the next accepted report. */
  envHeld = true;
  /** How far the reference is above the envelope: overshoot the slack already paid for, which envRise carries on (only an increase is charged again). */
  envPaid = 0;

  /** Ticks since a report was last accepted (or the reference last set by a correction). */
  idleTicks = 0;
  /**
   * The server moves the body itself, with no input, until something holds it up or a report of
   * the current epoch is accepted: its reports stopped in mid-air (REPORT_STALL_TICKS), or one rose
   * above the envelope. Every tick it moves the body is a correction ('fall').
   */
  takeover = false;
  /** Consecutive ticks the reported body was squeezed (see EntityManager squeeze judgement). */
  squeezeTicks = 0;
  /** Direction (world, unit) of the last fast structure motion through the body, relative to its carrier ... */
  readonly pushDir: Vec3 = vec3();
  /** ... remembered for this many more ticks (the client's copy may still be moving that way). */
  pushDirTicks = 0;

  /** The last REPORT_HISTORY accepted reports (see ACCEPTED REPORTS): a ring, `acceptedAt` the newest, `acceptedCount` filled. */
  private readonly acceptedRing: AcceptedSlot[] = Array.from({ length: REPORT_HISTORY }, () => ({ seq: 0, epoch: 0, carrierId: 0, pos: vec3(), vel: vec3() }));
  private acceptedAt = REPORT_HISTORY - 1;
  private acceptedCount = 0;

  /** Remember the report `seq`, accepted in the present epoch, as the server took it (EntityManager, at acceptance). */
  recordAccepted(seq: number, carrierId: number, pos: Readonly<Vec3>, vel: Readonly<Vec3>): void {
    this.acceptedAt = (this.acceptedAt + 1) % REPORT_HISTORY;
    const r = this.acceptedRing[this.acceptedAt]!;
    r.seq = seq;
    r.epoch = this.epoch;
    r.carrierId = carrierId;
    r.pos.x = pos.x;
    r.pos.y = pos.y;
    r.pos.z = pos.z;
    r.vel.x = vel.x;
    r.vel.y = vel.y;
    r.vel.z = vel.z;
    if (this.acceptedCount < REPORT_HISTORY) this.acceptedCount++;
  }

  /** The accepted report `seq` if it is of the present epoch and still remembered, else null. Valid until the next recordAccepted. */
  acceptedReport(seq: number): AcceptedReport | null {
    const ring = this.acceptedRing;
    // Newest first: seqs fall and epochs never rise going back.
    for (let k = 0, i = this.acceptedAt; k < this.acceptedCount; k++, i = i === 0 ? ring.length - 1 : i - 1) {
      const r = ring[i]!;
      if (r.epoch !== this.epoch || r.seq < seq) return null;
      if (r.seq === seq) return r;
    }
    return null;
  }

  /** The newest accepted report of the present epoch, or null (none accepted since the last correction). Valid until the next recordAccepted. */
  lastAccepted(): AcceptedReport | null {
    if (this.acceptedCount === 0) return null;
    const r = this.acceptedRing[this.acceptedAt]!;
    return r.epoch === this.epoch ? r : null;
  }

  /** A correction was raised and not yet taken. */
  pending = false;
  /** The pending correction holds a state the server made (not merely a refused report's reference): the vertical envelope starts again there. */
  serverMoved = false;
  /** The pending correction may still change (raised in this tick, not taken): settled at the end of the tick. */
  dirty = false;
  readonly correction: Correction = emptyCorrection();

  // ---- statistics (tests, tuning)
  accepted = 0;
  dropped = 0;
  rejected = 0;
  /** Ticks in which the reported body overlapped some structure's hard cells at the server's poses. */
  overlapTicks = 0;
  /** ... by more than SQUEEZE_DEPTH (before the push-out judgement). */
  deepOverlapTicks = 0;
  /** Longest run of consecutive deep-overlap ticks (what "deeper than SQUEEZE_DEPTH for N ticks" alone would judge). */
  longestDeepRun = 0;
  /** Longest run of ticks in which the usual push-out alone could not clear it (the judgement without the lean along the motion). */
  longestPlainStuckRun = 0;
  /** Ticks in which neither push-out cleared it (squeeze candidates). */
  squeezeCandidateTicks = 0;
  /** Longest run of squeeze candidate ticks. */
  longestSqueezeRun = 0;
  deepRun = 0;
  plainStuckRun = 0;

  /**
   * The vertical envelope starts again where something holds the body up (`held`: it may take off
   * in any tick until the next report) or where a correction put it, with upward speed `vy` at most.
   */
  resetEnvelope(vy: number, held: boolean): void {
    this.envRise = 0;
    this.envTop = 0;
    this.envVy = vy;
    this.envTopLate = 0;
    this.envVyLate = vy;
    this.envPeak = arcPeak(vy);
    this.envHeld = held;
    this.envPaid = 0;
  }
}

/** Does an arc with upward speed `vy` (blocks/s) still rise in the next tick (the motion model's gravity step)? */
function rising(vy: number): boolean {
  let v1 = vy - GRAVITY * TICK_DT;
  if (v1 < -TERMINAL_SPEED) v1 = -TERMINAL_SPEED;
  return vy + v1 > 0;
}

/** The highest point (blocks above its start) of an arc that starts with upward speed `vy`, tick by tick. */
function arcPeak(vy: number): number {
  let top = 0;
  // (Bounded: every step takes GRAVITY * TICK_DT off the speed.)
  for (let i = 0; i < 1000 && rising(vy); i++) {
    const v1 = vy - GRAVITY * TICK_DT;
    top += (vy + v1) * 0.5 * TICK_DT;
    vy = v1;
  }
  return top;
}

/**
 * The vertical envelope `ticks` ticks on, from (top, vy): the motion model's gravity step
 * (entities/motion.ts: average of the old and new speed, terminal speed), so the highest body
 * the controller can produce stays exactly on it. Writes out.top / out.vy, and out.peak: the
 * highest the envelope got on the way (a body that lands may have done so at any of those ticks).
 */
function advanceEnvelope(top: number, vy: number, ticks: number, out: { top: number; vy: number; peak: number }): void {
  let peak = top;
  for (let i = 0; i < ticks; i++) {
    let v1 = vy - GRAVITY * TICK_DT;
    if (v1 < -TERMINAL_SPEED) v1 = -TERMINAL_SPEED;
    top += (vy + v1) * 0.5 * TICK_DT;
    vy = v1;
    if (top > peak) peak = top;
  }
  out.top = top;
  out.vy = vy;
  out.peak = peak;
}

/**
 * Penetration of a box into a grid's hard cells: the push depth of the worst cell, Infinity when it
 * is embedded without any exposed face, 0 when it overlaps nothing.
 */
export function hardDepth(grid: VoxelGrid, box: AABB): number {
  // (The world's overlap test is allocation-free and the usual answer is "nothing".)
  if (grid.isWorld && !boxOverlapsSolid(grid, box)) return 0;
  const pen = deepestPenetration(grid, box);
  if (pen !== null) return pen.depth;
  return boxOverlapsSolid(grid, box) ? Infinity : 0;
}

function finite3(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Checks a report may fail, as they appear in correction causes ('check:<what>'). */
export type CheckFailure = 'garbage' | 'flying' | 'carrier' | 'velocity' | 'speed' | 'rise' | 'world' | 'hull' | 'path';

/**
 * Converts between report frames and the server's world, and checks reports. One per entity
 * manager; all scratch is on the instance.
 */
export class ReportJudge {
  private readonly body: BodyMover;
  private readonly world: VoxelGrid;
  private readonly near: StructRec[] = [];
  private readonly box: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  private readonly oldBox: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  private readonly w0: Vec3 = vec3();
  private readonly w1: Vec3 = vec3();
  private readonly v: Vec3 = vec3();
  private readonly vw: Vec3 = vec3();
  private readonly c: Vec3 = vec3();
  private readonly sc: Vec3 = vec3();
  private readonly sv: Vec3 = vec3();
  private readonly sb: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  private readonly env = { top: 0, vy: 0, peak: 0 };
  /** Scratch body: the squeeze judgement's copy of a player, and the liquid probe. */
  private readonly ghost = new Player(1, 'survival');
  private ghostIntoWorld = false;
  private readonly gb: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  // path test (pathClear): frame, body, depth limits, scratch
  private pathRec: StructRec | undefined = undefined;
  private pathBody: Player | null = null;
  private limWorld = 0;
  private limCarrier = 0;
  private readonly pl: Vec3 = vec3();
  private readonly pw: Vec3 = vec3();
  private readonly pbox: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

  /** Speed of the carrier at the body (world, blocks/s), set by toWorld(). */
  carrierSpeed = 0;
  // ---- set by a check() that passed
  /** The summed speeds of both carriers at the body when the carrier changed (an upper bound of the velocity the body may carry over), else 0. */
  switchSpeed = 0;
  /** Slack (blocks) the report used up. */
  slackUsed = 0;
  /** The report stands on something: it says so, and the world or a structure holds up its feet at the server's poses. */
  groundOk = false;
  /** The vertical envelope advanced to the report (ClientDrive.envRise ... envPaid). */
  envRise = 0;
  envTop = 0;
  envVy = 0;
  envTopLate = 0;
  envVyLate = 0;
  envPeak = 0;
  envHeld = false;
  envPaid = 0;
  /** The report showed a landing the server did not see (see LANDINGS), and ground near enough below for it. */
  landedUnseen = false;
  /** The report's lag (seconds, reportLag). */
  lag = REPORT_MAX_LAG;

  constructor(body: BodyMover, world: VoxelGrid) {
    this.body = body;
    this.world = world;
  }

  /**
   * World feet / velocity / yaw of a state given in report frames, at the server's present poses.
   * Writes pos, carrierVel, vel (world) into `out*`; returns the world yaw, or NaN when the
   * carrier has no record (it is gone).
   */
  toWorld(carrierId: number, pos: Vec3, vel: Vec3, yaw: number, outPos: Vec3, outCarrierVel: Vec3, outVel: Vec3): number {
    if (carrierId === 0) {
      outPos.x = pos.x;
      outPos.y = pos.y;
      outPos.z = pos.z;
      outCarrierVel.x = outCarrierVel.y = outCarrierVel.z = 0;
      outVel.x = vel.x;
      outVel.y = vel.y;
      outVel.z = vel.z;
      this.carrierSpeed = 0;
      return yaw;
    }
    const r = this.body.record(carrierId);
    if (r === undefined) return NaN;
    curToWorld(r, pos, outPos);
    pointVelocity(r, outPos, outCarrierVel);
    qrotate(r.q1, vel, outVel);
    outVel.x += outCarrierVel.x;
    outVel.y += outCarrierVel.y;
    outVel.z += outCarrierVel.z;
    const cv = outCarrierVel;
    this.carrierSpeed = Math.sqrt(cv.x * cv.x + cv.y * cv.y + cv.z * cv.z);
    return yaw + headingOf(r.q1);
  }

  /**
   * The player's present state in report frames (carrier = p.carrierId, if it still has a
   * record; else the world). Writes into `out` (a Correction or the drive's reference).
   */
  toReportFrame(p: Player, out: { carrierId: number; pos: Vec3; vel: Vec3; yaw: number }): void {
    const r = p.carrierId !== 0 ? this.body.record(p.carrierId) : undefined;
    if (r === undefined) {
      out.carrierId = 0;
      out.pos.x = p.pos.x;
      out.pos.y = p.pos.y;
      out.pos.z = p.pos.z;
      out.vel.x = p.vel.x;
      out.vel.y = p.vel.y;
      out.vel.z = p.vel.z;
      out.yaw = p.yaw;
      return;
    }
    out.carrierId = r.id;
    curToLocal(r, p.pos, out.pos);
    const v = this.v;
    v.x = p.vel.x - p.carrierVel.x;
    v.y = p.vel.y - p.carrierVel.y;
    v.z = p.vel.z - p.carrierVel.z;
    qrotateInv(r.q1, v, out.vel);
    out.yaw = p.yaw - headingOf(r.q1);
  }

  /**
   * Check a report against the drive's reference (the last accepted state, its world position
   * being p.pos right now). Returns null when it passes (and sets switchSpeed, slackUsed,
   * groundOk, envRise, envTop, envVy, landedUnseen for the caller to commit), else what failed.
   * `ticks` is the movement time (in ticks) granted to this report, `tick` the server's present
   * tick (the report's lag, reportLag, is set into `lag`); `unseen`: its landings count shows a
   * landing no report showed.
   */
  check(p: Player, d: ClientDrive, rep: MoveReport, ticks: number, tick: number, unseen: boolean): CheckFailure | null {
    const lag = reportLag(tick, rep.viewTick);
    this.lag = lag;
    this.switchSpeed = 0;
    this.slackUsed = 0;
    this.groundOk = false;
    this.landedUnseen = false;
    // Garbage.
    if (!finite3(rep.pos) || !finite3(rep.vel) || !Number.isFinite(rep.yaw) || !Number.isFinite(rep.pitch)) return 'garbage';
    if (Math.abs(rep.pos.x) > MAX_BOX_COORD || Math.abs(rep.pos.y) > MAX_BOX_COORD || Math.abs(rep.pos.z) > MAX_BOX_COORD) return 'garbage';
    if (!Number.isSafeInteger(rep.carrierId) || rep.carrierId < 0) return 'garbage';
    // Flight only where the player may fly.
    if (rep.flying && p.mode !== 'creative') return 'flying';
    // The claimed carrier exists and is near the reported feet (in its own frame).
    let rec: StructRec | undefined;
    if (rep.carrierId !== 0) {
      rec = this.body.record(rep.carrierId);
      if (rec === undefined) return 'carrier';
      const b = rec.grid.cellBounds();
      if (b === null) return 'carrier';
      const q = rep.pos;
      const m = REPORT_CARRIER_REACH;
      if (q.x < b.minX - m || q.x > b.maxX + m || q.y < b.minY - m || q.y > b.maxY + m || q.z < b.minZ - m || q.z > b.maxZ + m) return 'carrier';
    }
    // Where the report puts the body at the server's present poses.
    const w1 = this.w1;
    const cv = this.c;
    this.toWorld(rep.carrierId, rep.pos, rep.vel, rep.yaw, w1, cv, this.vw);
    const allow = ticks * TICK_DT;
    // The view time (seconds) the client's copies of the structures moved through between the
    // reference and this report (viewTick): at least the movement time, at most REPORT_VIEW_RATE
    // times it (after a stalled channel a client's copies catch up at that pace). That motion
    // happened on the server between `lag` and `lag + viewed` ago: what the checks remember of
    // structure speeds near the body goes back that far.
    // The first report of an epoch: its client took the correction's state a round trip after
    // the server settled it, and the structures moved on meanwhile (a blade sweeps into the spot a
    // squeeze moved the body to): the time since the correction, at most the lag.
    const viewed = d.fresh
      ? Math.min(lag, Math.max(allow, (tick - d.settledTick) * TICK_DT))
      : d.viewTick < 0
        ? allow
        : Math.min((REPORT_VIEW_RATE * ticks + 1) * TICK_DT, Math.max(allow, (rep.viewTick - d.viewTick) * TICK_DT));
    const memory = lag + viewed + TICK_DT;
    // (As fast as the carrier moved lately: the client's copy may still move like that.)
    const newCarrierSpeed = Math.max(this.carrierSpeed, d.carrierWithin(memory));
    // Velocity: no faster than anything can make a body.
    const vh = Math.sqrt(rep.vel.x * rep.vel.x + rep.vel.z * rep.vel.z);
    if (vh > MAX_INHERITED_SPEED + FLY_SPEED * FLY_SPRINT_MULTIPLIER || Math.abs(rep.vel.y) > TERMINAL_SPEED + MAX_INHERITED_SPEED) return 'velocity';
    // Speed relative to the carrier: the displacement from the reference.
    const w0 = this.w0;
    let dx: number;
    let dy: number;
    let dz: number;
    let switchSlack = 0;
    const sameFrame = rep.carrierId === d.carrierId;
    const prevCarrierSpeed = d.carrierId !== 0 ? Math.max(this.speedAt(d.carrierId, p.pos), d.carrierWithin(memory)) : 0;
    if (sameFrame) {
      // Same frame: the local displacement, turned into world axes by the present pose.
      w0.x = rep.pos.x - d.pos.x;
      w0.y = rep.pos.y - d.pos.y;
      w0.z = rep.pos.z - d.pos.z;
      if (rec !== undefined) qrotate(rec.q1, w0, w0);
      dx = w0.x;
      dy = w0.y;
      dz = w0.z;
    } else {
      // A carrier switch: compared in the world at the server's poses, which lead the client's
      // copies by the lag at the carriers' speeds.
      dx = w1.x - p.pos.x;
      dy = w1.y - p.pos.y;
      dz = w1.z - p.pos.z;
      switchSlack = (prevCarrierSpeed + newCarrierSpeed) * lag + 1;
    }
    const nb = boxAt(p, w1.x, w1.y, w1.z, this.box);
    // What may move the body besides its own legs: another structure pushing it (as fast as one
    // near it moved in the remembered time: the client's copy may still be moving), or the world
    // scraping it along its moving carrier (in the carrier's frame the world passes at the
    // carrier's speed); both for the view time.
    let push = Math.max(this.structureSpeed(p, w1, rep.carrierId, cv), d.pushWithin(memory));
    if (rec !== undefined && newCarrierSpeed > push && this.nearWorld(nb, 0.05 + newCarrierSpeed * (allow + lag))) push = newCarrierSpeed;
    // A body that just stopped flying still has the flight's speed (its momentum goes into
    // d.inherit when the report is accepted).
    const own = rep.flying || d.flying ? FLY_SPEED * FLY_SPRINT_MULTIPLIER : SPRINT_SPEED;
    const extra = d.inherit * allow + push * viewed;
    const hMax = own * allow + extra + switchSlack;
    const upMax = Math.max(JUMP_SPEED, FLY_VERTICAL_SPEED) * allow + extra + STEP_HEIGHT + switchSlack;
    const downMax = TERMINAL_SPEED * allow + extra + switchSlack;
    const h = Math.sqrt(dx * dx + dz * dz);
    let excess = (h > hMax ? h - hMax : 0) + (dy > upMax ? dy - upMax : -dy > downMax ? -dy - downMax : 0);
    if (excess > d.slack) return 'speed';
    // Standing on something: claimed, and true at the server's poses (else it keeps falling).
    this.groundOk = rep.onGround && this.supported(nb, rec, 0);
    // The vertical envelope over the report's movement time (VERTICAL ENVELOPE): rising needs
    // something that lifted the body. A flying body is bound by the speed limits alone (the
    // envelope starts again when the report is accepted).
    let spanPeak = this.advanceArcs(d.envTop, d.envVy, d.envTopLate, d.envVyLate, d.envPeak, d.envHeld, ticks);
    let rise = d.envRise;
    let paid = d.envPaid;
    // A landing no report showed (LANDINGS) needs ground the body can have reached in the gap
    // below the lower of its two places (a client cannot end a fall early by counting landings).
    // The envelope then starts again on the highest ground under either place that the body can
    // have come down on (no higher than its arcs got in the gap, plus a step), with a jump from
    // there in any tick of the gap.
    if (unseen) {
      const ob = boxAt(p, p.pos.x, p.pos.y, p.pos.z, this.oldBox);
      const reach = (Math.max(0, -d.envVy) + GRAVITY * allow) * allow;
      if (this.supported(ob.minY <= nb.minY ? ob : nb, rec, reach)) {
        const highest = p.pos.y - d.envRise + d.envPaid + spanPeak + STEP_HEIGHT + extra + switchSlack;
        const ground = Math.max(this.groundUnder(ob, rec, reach, highest), this.groundUnder(nb, rec, reach, highest));
        if (ground > -Infinity) {
          this.landedUnseen = true;
          rise = p.pos.y - ground;
          paid = 0;
          spanPeak = this.advanceArcs(0, JUMP_SPEED, 0, JUMP_SPEED, arcPeak(JUMP_SPEED), true, ticks);
        }
      }
    }
    this.envRise = rise + dy;
    this.envPaid = 0;
    if (!rep.flying) {
      // Where the arcs are now: the peak when it lies between the two take-offs, else the later
      // take-off's while both fall, the earlier one's while both rise.
      const nowPeak = rising(this.envVyLate) ? (rising(this.envVy) ? this.envTop : this.envPeak) : this.envTopLate;
      // Ending on something, the body may have come down on it at any tick of the report (a
      // step up included); ending in liquid, the liquid may have slowed its fall; ending in the
      // air, it is where gravity has it by now at the highest.
      const bound = this.groundOk ? spanPeak + STEP_HEIGHT : this.inLiquid(p, w1) ? spanPeak : nowPeak;
      const top = bound + extra + switchSlack;
      // Overshoot is drawn from the slack once: the part already paid for (carried on in envRise)
      // is not charged again while the body goes on along the arc.
      const over = this.envRise > top ? this.envRise - top : 0;
      if (over > paid) excess += over - paid;
      if (excess > d.slack) return 'rise';
      // What pushes or a carrier switch (both carriers' poses lead the client's copies) allowed
      // above the arc is not carried on: the body goes on along the arc from where it is. What
      // the slack paid for is (so no sustained climb hides in it).
      if (this.envRise > bound) this.envRise = Math.max(bound, this.envRise - extra - switchSlack);
      this.envPaid = over;
    }
    this.slackUsed = excess;
    // Not deep inside hard cells of the world or of the carrier — unless the body was as deep
    // before (then it did not move in by itself: that is a squeeze or a block put into it, the
    // squeeze and unstuck rules handle it).
    const worldTol = this.worldTolerance(rep.carrierId, newCarrierSpeed, lag);
    const wNew = hardDepth(this.world, nb);
    const wOld = hardDepth(this.world, boxAt(p, p.pos.x, p.pos.y, p.pos.z, this.oldBox));
    if (wNew > worldTol && wNew > wOld + 1e-6) return 'world';
    let cNew = 0;
    let cOld = 0;
    if (rec !== undefined) {
      cNew = hardDepth(rec.grid, nb);
      if (sameFrame) {
        curToWorld(rec, d.pos, w0);
        cOld = hardDepth(rec.grid, boxAt(p, w0.x, w0.y, w0.z, this.oldBox));
      }
      if (cNew > REPORT_HARD_TOLERANCE && cNew > cOld + 1e-6) {
        // Deeper in its carrier than before. Walked in — unless it is caught: the world (or
        // another structure) holds it while the carrier moves into it, e.g. a deck rider scraped
        // back against a bridge until the helm reaches it. The server cannot push it out either
        // then, and the squeeze rules judge it (EntityManager.judgeSqueeze).
        const g = this.ghost;
        g.pos.x = w1.x;
        g.pos.y = w1.y;
        g.pos.z = w1.z;
        g.vel.x = this.vw.x;
        g.vel.y = this.vw.y;
        g.vel.z = this.vw.z;
        g.carrierVel.x = cv.x;
        g.carrierVel.y = cv.y;
        g.carrierVel.z = cv.z;
        g.carrierId = rec.id;
        g.onGround = rep.onGround;
        if (!this.pushedStuck(p, null, REPORT_HARD_TOLERANCE)) return 'hull';
      }
    }
    // Nor through them on the way.
    this.limWorld = Math.max(worldTol, wOld, wNew) + 1e-6;
    this.limCarrier = Math.max(REPORT_HARD_TOLERANCE, cOld, cNew) + 1e-6;
    this.pathBody = p;
    if (sameFrame && rec !== undefined) {
      this.pathRec = rec;
      if (!this.pathClear(d.pos, rep.pos)) return 'path';
    } else {
      this.pathRec = undefined;
      if (!this.pathClear(p.pos, w1)) return 'path';
    }
    return null;
  }

  /**
   * Squeeze test of a body (EntityManager.judgeSqueeze): push a copy of `src` out of the
   * structures at the server's present poses (the push every body gets, body.ts pushOut; with
   * `lean`, deep pushes lean hard that way). Stuck when a structure still overlaps the copy by
   * more than SQUEEZE_DEPTH, or when the push could only free it by moving it that much deeper
   * into world blocks it already overlapped (a body carried a little into a wall by the server's
   * leading pose of its deck slides along those cells: the world sweep ignores cells a box
   * already overlaps). The copy is left where the push put it (ghostPos).
   */
  ghostStuck(src: Player, lean: Vec3 | null): boolean {
    const g = this.ghost;
    g.pos.x = src.pos.x;
    g.pos.y = src.pos.y;
    g.pos.z = src.pos.z;
    g.vel.x = src.vel.x;
    g.vel.y = src.vel.y;
    g.vel.z = src.vel.z;
    g.carrierVel.x = src.carrierVel.x;
    g.carrierVel.y = src.carrierVel.y;
    g.carrierVel.z = src.carrierVel.z;
    g.carrierId = src.carrierId;
    g.onGround = src.onGround;
    return this.pushedStuck(src, lean, SQUEEZE_DEPTH);
  }

  /** Where the last ghostStuck() push left the copy; false when it went into world blocks to get there (start a free-spot search from the body itself then). */
  ghostEnd(out: Vec3): boolean {
    out.x = this.ghost.pos.x;
    out.y = this.ghost.pos.y;
    out.z = this.ghost.pos.z;
    return !this.ghostIntoWorld;
  }

  /** The ghost (placed) pushed out: still overlapping a structure, or pushed into the world, by more than `depth`. */
  private pushedStuck(dims: Player, lean: Vec3 | null, depth: number): boolean {
    const g = this.ghost;
    g.halfWidth = dims.halfWidth;
    g.height = dims.height;
    const w0 = hardDepth(this.world, g.box(this.gb));
    const still = this.body.pushOut(g, lean, SQUEEZE_PREFER_WEIGHT);
    const gb = g.box(this.gb);
    const w1 = hardDepth(this.world, gb);
    this.ghostIntoWorld = w1 > w0 + 1e-6;
    if (w1 > w0 + depth) return true;
    const r = still !== 0 ? this.body.record(still) : undefined;
    return r !== undefined && hardDepth(r.grid, gb) > depth;
  }

  /** Does a box grown by `margin` overlap world blocks? */
  private nearWorld(b: AABB, margin: number): boolean {
    const e = this.gb;
    e.minX = b.minX - margin;
    e.minY = b.minY - margin;
    e.minZ = b.minZ - margin;
    e.maxX = b.maxX + margin;
    e.maxY = b.maxY + margin;
    e.maxZ = b.maxZ + margin;
    return boxOverlapsSolid(this.world, e);
  }

  /** Is the body, at world feet `at`, in any liquid (water or lava)? */
  private inLiquid(dims: Player, at: Vec3): boolean {
    const g = this.ghost;
    g.halfWidth = dims.halfWidth;
    g.height = dims.height;
    g.pos.x = at.x;
    g.pos.y = at.y;
    g.pos.z = at.z;
    // (Wet already: sampling a dry body records a liquid entry in the mover's step facts.)
    g.wet = 1;
    this.body.sampleFluids(g);
    return g.wet > 0 || g.inLava;
  }

  /** World-overlap a body may have without counting as inside the world, for a report of lag `lag` (seconds). */
  worldTolerance(carrierId: number, carrierSpeed: number, lag: number): number {
    // A carried body is placed by the server's pose of its carrier, which leads the client's copy:
    // a deck carrying it past a wall puts it into the wall by up to the carrier's speed times the lag.
    return carrierId === 0 ? REPORT_HARD_TOLERANCE : REPORT_HARD_TOLERANCE + carrierSpeed * lag;
  }

  /** World speed of structure `id`'s material at a world point (0 when it has no record). */
  speedAt(id: number, at: Vec3): number {
    const r = this.body.record(id);
    if (r === undefined) return 0;
    const v = pointVelocity(r, at, this.v);
    return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  }

  /**
   * Fastest motion, relative to the carrier, of any structure (other than the carrier) near the
   * body at world feet `at`: what pushes can add to the body's own speed.
   */
  structureSpeed(p: Player, at: Vec3, carrierId: number, carrierVel: Vec3): number {
    const b = boxAt(p, at.x, at.y, at.z, this.sb);
    const near = this.body.structuresNear(b, 1, this.near);
    let max = 0;
    const c = this.sc;
    c.x = at.x;
    c.y = at.y + p.height * 0.5;
    c.z = at.z;
    for (let k = 0; k < near.length; k++) {
      const r = near[k]!;
      if (r.id === carrierId) continue;
      const v = pointVelocity(r, c, this.sv);
      const sx = v.x - carrierVel.x;
      const sy = v.y - carrierVel.y;
      const sz = v.z - carrierVel.z;
      const s = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (s > max) max = s;
    }
    return max;
  }

  /** Is the player, where it is now, held up: standing on something, in liquid (as last sampled) or flying? */
  heldUp(p: Player): boolean {
    if (p.flying || p.wet > 0 || p.inLava) return true;
    return this.supported(boxAt(p, p.pos.x, p.pos.y, p.pos.z, this.sb), p.carrierId !== 0 ? this.body.record(p.carrierId) : undefined, 0);
  }

  /**
   * Is a body box at the server's poses held up by the world, its carrier or another structure,
   * `deeper` blocks below it included? Probed a little deeper and wider than a body stands
   * (REPORT_SUPPORT_REACH): the box is world-aligned, and the server's pose of a deck that rolls or
   * turns tilts it against the deck a little differently than the client's copy did (a rider at
   * the very edge of a rolling deck).
   */
  private supported(b: AABB, carrier: StructRec | undefined, deeper: number): boolean {
    const gap = SUPPORT_GAP + REPORT_SUPPORT_REACH + deeper;
    const inset = -REPORT_SUPPORT_REACH;
    if (hasSupportBelow(this.world, b, gap, inset)) return true;
    if (carrier !== undefined && hasSupportBelow(carrier.grid, b, gap, inset)) return true;
    const near = this.body.structuresNear(b, gap, this.near);
    for (let k = 0; k < near.length; k++) {
      const r = near[k]!;
      if (r === carrier || b.minY - gap >= r.maxY || b.minY <= r.minY) continue;
      if (hasSupportBelow(r.grid, b, gap, inset)) return true;
    }
    return false;
  }

  /**
   * The vertical envelope's arcs (VERTICAL ENVELOPE) `ticks` ticks on: the earliest take-off's from
   * (top, vy), the latest one's from (topLate, vyLate), or, when `held`, taking off in the last of
   * those ticks. Writes envTop ... envHeld; returns the highest the arcs got on the way: the arc's
   * peak when one of them passed it, else the higher of the two (an arc rises, then falls).
   */
  private advanceArcs(top: number, vy: number, topLate: number, vyLate: number, peak: number, held: boolean, ticks: number): number {
    const late = held ? Math.min(1, ticks) : ticks;
    advanceEnvelope(top, vy, ticks, this.env);
    this.envTop = this.env.top;
    this.envVy = this.env.vy;
    const peakEarly = this.env.peak;
    advanceEnvelope(topLate, vyLate, late, this.env);
    this.envTopLate = this.env.top;
    this.envVyLate = this.env.vy;
    this.envPeak = peak;
    this.envHeld = held && late === 0;
    return rising(vyLate) && !rising(this.envVy) ? peak : Math.max(peakEarly, this.env.peak);
  }

  /** World height of the first thing under a body box (within `reach`) that would hold it up, if no higher than `highest`; else -Infinity. */
  private groundUnder(b: AABB, carrier: StructRec | undefined, reach: number, highest: number): number {
    const depth = this.supportDepth(b, carrier, reach);
    const y = b.minY - depth;
    return depth >= 0 && y <= highest ? y : -Infinity;
  }

  /**
   * How far below a body box at the server's poses the first thing that would hold it up lies
   * (supported() with `deeper`, to within 0.01): -1 when nothing does within `reach` below it.
   */
  private supportDepth(b: AABB, carrier: StructRec | undefined, reach: number): number {
    if (!(reach >= 0) || !this.supported(b, carrier, reach)) return -1;
    if (this.supported(b, carrier, 0)) return 0;
    let lo = 0;
    let hi = reach;
    while (hi - lo > 0.01) {
      const mid = (lo + hi) * 0.5;
      if (this.supported(b, carrier, mid)) hi = mid;
      else lo = mid;
    }
    return lo;
  }

  /**
   * May the body get from `a` to `b` (in the path frame: local to pathRec, else world) without
   * passing through hard cells of the world or of pathRec deeper than limWorld / limCarrier? The
   * client's mover moves a tick's displacement axis by axis (vertical first, then horizontal) and
   * steps up ledges, and over several ticks (reports lost) it may have slid along a wall and then
   * gone round its end, so a corner it went round may lie on the straight line: the path is clear
   * when the straight line, the vertical-first or the vertical-last dog-leg, or one along the
   * frame's x or z axis first, is.
   */
  private pathClear(a: Vec3, b: Vec3): boolean {
    if (this.legClear(a.x, a.y, a.z, b.x, b.y, b.z, false)) return true;
    return this.dogLegClear(a, b, a.x, b.y, a.z) || this.dogLegClear(a, b, b.x, a.y, b.z) || this.dogLegClear(a, b, b.x, a.y, a.z) || this.dogLegClear(a, b, a.x, a.y, b.z);
  }

  /** The path from `a` to `b` by way of the corner (cx, cy, cz). */
  private dogLegClear(a: Vec3, b: Vec3, cx: number, cy: number, cz: number): boolean {
    return this.legClear(a.x, a.y, a.z, cx, cy, cz, true) && this.legClear(cx, cy, cz, b.x, b.y, b.z, false);
  }

  /** Samples of a straight leg, every REPORT_PATH_STEP, without its start (and without its end unless `end`). */
  private legClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, end: boolean): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const n = Math.ceil(Math.sqrt(dx * dx + dy * dy + dz * dz) / REPORT_PATH_STEP);
    const last = end ? n : n - 1;
    for (let k = 1; k <= last; k++) {
      const t = k / n;
      if (!this.sampleClear(ax + dx * t, ay + dy * t, az + dz * t)) return false;
    }
    return true;
  }

  private sampleClear(x: number, y: number, z: number): boolean {
    const r = this.pathRec;
    const w = this.pw;
    if (r !== undefined) {
      const l = this.pl;
      l.x = x;
      l.y = y;
      l.z = z;
      curToWorld(r, l, w);
    } else {
      w.x = x;
      w.y = y;
      w.z = z;
    }
    const b = boxAt(this.pathBody!, w.x, w.y, w.z, this.pbox);
    if (boxOverlapsSolid(this.world, b) && hardDepth(this.world, b) > this.limWorld) return false;
    return r === undefined || !boxOverlapsSolid(r.grid, b) || !(hardDepth(r.grid, b) > this.limCarrier);
  }
}
