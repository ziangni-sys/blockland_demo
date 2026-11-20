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
 * (no replay): the first report of a new epoch moved one client tick from it. A correction never
 * leaves the body deeper in a structure than a report may dip into one: the server pushes it out
 * first, as every body is pushed (EntityManager.pushOutOfStructures), else the client's own push
 * on its first step would be a move no check allows, refused back to the same place every tick.
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
 *    as standing, so the fall goes on, nor does claiming to stand beside a wall (only what lies
 *    under the feet holds them up: standsOn). A report that rises above it, and a body whose
 *    reports stop in mid-air (REPORT_STALL_TICKS), falls on the server's own authority
 *    (EntityManager.fallOnServer: a correction 'fall' every tick until something holds it up or
 *    its client catches up);
 *  - not deep in world blocks or in the carrier's ('world', 'hull'; a carried body may overlap the
 *    world by its carrier's speed times the lag), unless it was as deep before or is caught there
 *    (the world holds it while its carrier moves into it: a squeeze, judged by the squeeze rules),
 *    nor through them on the way ('path': the straight path, a dog-leg as the mover takes it, or a
 *    staircase climbed at most a step at a time, sampled every REPORT_PATH_STEP);
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
 * A report that ends held up at the server's poses has landed there (heldEnd), whether it says it
 * stands or, a hair above a tread of a heeled deck, that it is in the air (then held up by what
 * lies under its footprint, or by the probe's widening only while it says it rises, no faster
 * than a jump: a body thrown up past the top of a wall, or falling past a ledge's rim, does not
 * land on it). It may be a step higher than the arc, and, where a staircase lies between its two
 * places (the staircase path passes), sqrt(2) times its horizontal displacement more: a staircase
 * on the half-cell lattice climbs at most one step per riser crossed, and the risers are at most
 * |dx| + |dz| <= sqrt(2) h apart (several lost reports in a row on a staircase; docs/SHAPES.md
 * 5.8). The envelope then starts again there, and the fall tracked so far ends there whatever the
 * report claims (else a client that never claimed to stand would never pay for a fall). A report
 * ending in the air, or onto a wall or terraces in open air, gets nothing of that.
 *
 * LANDINGS. Every report counts the landings of the client's body so far (mod 256). A report
 * that counts more landings than the last applied one, beyond its own (the first on the ground
 * after airborne ones), shows a landing the server never saw (reports lost or dropped). Two short
 * drops whose landing report was lost are not one long fall. The landing needs ground the body can
 * have reached in the gap (no higher than a jump and a step above the envelope's base) under
 * either place, down to the reachable fall below the lower one (when the new place is the higher
 * one, only if the old one has ground within the reachable fall below it, and under the new one
 * only within its own); the
 * vertical envelope starts again on the highest such ground, the take-off in any tick of the gap:
 * no higher than a jump from there (a client that counts landings in mid-air climbs nothing; nor
 * one beside a leaning mast: its face is no ground, ReportJudge.underLeaningWalls). The fall
 * tracked so far ends on that ground, the drop from the last place down to it included, and the
 * next fall starts there, less what the body may have walked down first (any height where a
 * staircase leads from one place to the other; as far as the floor of the tilted structure that
 * ground lies on descends between them), never below where the report ends
 * (EntityManager.updateClientDriven): a report counting a landing pays for the descent of its own
 * gap. A report that claims its own landing (after an airborne one) where nothing holds up its
 * end is such a landing too: the body landed on a tread's edge and walked off it in the same tick
 * (the rim it left, under the old place, is that ground). After such a landing, and after a report
 * that truly stood, a report that claims to stand where nothing holds it up keeps the latest
 * take-off open for one more report: the client's body stood on the edge when its tick began and
 * may jump in the next one.
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
  LAND_EVENT_HEIGHT,
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

/** Footprint inset steps (blocks) of standsOn(): how finely a wall beside the body is cut off its support probe. */
const SUPPORT_INSET_STEP = 0.05;

/**
 * How much thicker each slab of a support probe deeper than the standing one is than the depth
 * above it, on a tilted grid (ReportJudge.underLeaningWalls): a slab leaves out at most this
 * fraction more than a leaning wall's foot can reach at its top (or SUPPORT_INSET_STEP, if more).
 */
const LEAN_SLAB_GROWTH = 0.25;

/** What a slab of the support probe on a tilted grid holds (ReportJudge.clearOfLeaningWalls): support, none, or none and none deeper. */
const LEAN_SUPPORT = 0;
const LEAN_NONE = 1;
const LEAN_NEVER = 2;

/**
 * Height (blocks) the staircase path may still have to climb straight up to the higher end when
 * its samples reach it (stairClear's last leg): three half-block risers, and the depth by which a
 * sample may overlap a tread without being lifted (REPORT_HARD_TOLERANCE).
 */
const STAIR_LAST_LEG = 1.5 + REPORT_HARD_TOLERANCE + 1e-6;

/** What a body sample of the path checks overlaps (ReportJudge.sampleDepth): nothing, hard cells within the depth limits, or deeper. */
const SAMPLE_FREE = 0;
const SAMPLE_CLEAR = 1;
const SAMPLE_BLOCKED = 2;

/**
 * How a structure's walls lean: the horizontal displacement (world x and z, written into out.x and
 * out.z; out.y is 0) per block of rise along the grid axis nearest the world's vertical, taken
 * pointing up. Its length is the tangent of that axis's tilt. A grid of cubes turned by a quarter
 * turn about any axis is the same grid of cubes, so a structure turned by more than 45 degrees
 * about a horizontal axis stands on what were its walls, and its walls rise along another of its
 * axes: a drum turned 80 degrees leans by 10 for this, one turned 180 degrees (upside down) not at
 * all. 0 for an upright structure; at most sqrt(2) long (all three axes equally far from the
 * vertical), never infinite. Turned exactly 45 degrees about a horizontal axis, two axes are
 * equally near: the face on one side of the ridge is a floor, the other a wall (whichever axis
 * the comparison below picks).
 */
function leanOf(r: StructRec, out: Vec3): Vec3 {
  const q = r.q1;
  // The structure's local x, y and z axes in the world (the columns of its rotation): the one
  // whose world y is largest in size is the walls' axis.
  const xy = 2 * (q.x * q.y + q.w * q.z);
  const yy = 1 - 2 * (q.x * q.x + q.z * q.z);
  const zy = 2 * (q.y * q.z - q.w * q.x);
  const ax = Math.abs(xy);
  const ay = Math.abs(yy);
  const az = Math.abs(zy);
  let ux: number;
  let uy: number;
  let uz: number;
  if (ax > ay && ax > az) {
    ux = 1 - 2 * (q.y * q.y + q.z * q.z);
    uy = xy;
    uz = 2 * (q.x * q.z - q.w * q.y);
  } else if (ay > az) {
    ux = 2 * (q.x * q.y - q.w * q.z);
    uy = yy;
    uz = 2 * (q.y * q.z + q.w * q.x);
  } else {
    ux = 2 * (q.x * q.z + q.w * q.y);
    uy = zy;
    uz = 1 - 2 * (q.x * q.x + q.y * q.y);
  }
  // Per block of rise (uy may be negative: that axis points down; the ratio is the same pointing up).
  out.x = ux / uy;
  out.y = 0;
  out.z = uz / uy;
  return out;
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

/** The highest point of a jump (arcPeak of JUMP_SPEED): the most an arc that starts on the ground can rise. */
const JUMP_PEAK = arcPeak(JUMP_SPEED);

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
  /** Scratch box of standsOn(): the body above its feet. */
  private readonly ab: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  /** Scratch box of clearOfLeaningWalls(): a strip beside or under the footprint. */
  private readonly wb: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  /** Scratch of supported(): how a structure's walls lean (leanOf). */
  private readonly lean: Vec3 = vec3();
  /** What held the box up in the last supported() call that found support: a structure, or undefined for the world. */
  private supportBy: StructRec | undefined = undefined;
  // path test (pathClear): frame, body, depth limits, scratch
  private pathRec: StructRec | undefined = undefined;
  private pathBody: Player | null = null;
  private limWorld = 0;
  private limCarrier = 0;
  /** stairPath() of the current check's two places: 0 not yet evaluated, 1 clear, 2 not. */
  private stairs = 0;
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
  /**
   * The body landed where the report ends: the world or a structure holds up its feet at the
   * server's poses, whether or not the report says it stands (groundOk is this and the claim; for
   * a report that says it is in the air: under its footprint, or by the probe's widening while
   * it says it rises, no faster than a jump). The vertical envelope starts again there and the
   * fall tracked so far ends there (EntityManager.updateClientDriven; VERTICAL ENVELOPE).
   */
  heldEnd = false;
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
  /**
   * ... the world height of that ground (feet held up on it; -Infinity without such a landing),
   * the fall bookkeeping's split point (LANDINGS) ...
   */
  landedGround = -Infinity;
  /**
   * ... and how far below it the body may have walked down to before it left the ground again:
   * Infinity where a staircase leads from one place to the other (the staircase path passes), else
   * how far the floor of the tilted structure that ground lies on descends between the two places
   * (0 on the world's ground).
   */
  landedWalk = 0;
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
   * groundOk, heldEnd, envRise ... envPaid, landedUnseen for the caller to commit), else what failed.
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
    this.heldEnd = false;
    this.landedUnseen = false;
    this.landedGround = -Infinity;
    this.landedWalk = 0;
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
    // The upward speed it claims, relative to its carrier (world vertical).
    const vyUp = this.vw.y - cv.y;
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
      // copies by the lag at the carriers' speeds. Nothing more: the switch is the client's word,
      // and a report may claim one every tick (a flat block on top of this, granted at every
      // switch, let a client alternating the raft's frame and the world's climb 0.9 and move 1.2
      // per report beside a raft at rest).
      dx = w1.x - p.pos.x;
      dy = w1.y - p.pos.y;
      dz = w1.z - p.pos.z;
      switchSlack = (prevCarrierSpeed + newCarrierSpeed) * lag;
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
    // Depths in hard cells of the world and of the carrier, before and after: the 'world' and
    // 'hull' checks below, and the limits of the path checks (the staircase gate of the envelope
    // uses them before the path check proper).
    const worldTol = this.worldTolerance(rep.carrierId, newCarrierSpeed, lag);
    const wNew = hardDepth(this.world, nb);
    const wOld = hardDepth(this.world, boxAt(p, p.pos.x, p.pos.y, p.pos.z, this.oldBox));
    let cNew = 0;
    let cOld = 0;
    if (rec !== undefined) {
      cNew = hardDepth(rec.grid, nb);
      if (sameFrame) {
        curToWorld(rec, d.pos, w0);
        cOld = hardDepth(rec.grid, boxAt(p, w0.x, w0.y, w0.z, this.oldBox));
      }
    }
    // The path frame: local to the carrier when the report stays on it, else the world.
    this.limWorld = Math.max(worldTol, wOld, wNew) + 1e-6;
    this.limCarrier = Math.max(REPORT_HARD_TOLERANCE, cOld, cNew) + 1e-6;
    this.pathBody = p;
    this.pathRec = sameFrame ? rec : undefined;
    this.stairs = 0;
    const pathFrom = sameFrame && rec !== undefined ? d.pos : p.pos;
    const pathTo = sameFrame && rec !== undefined ? rep.pos : w1;
    // Held up at its end at the server's poses, the body has landed there (heldEnd), whether it
    // says it stands (groundOk) or that it is in the air: a body walking down a tread of a heeled
    // deck that slopes away from it leaves it for a tick now and then (the mover does not snap
    // down), a few hundredths above it and in the air by its own flag, and its climb is a
    // staircase's all the same. So, claimed or not, the envelope starts again there, and the fall
    // tracked so far ends there (EntityManager.updateClientDriven): a client that never claims to
    // stand pays for its falls as one that does. A claim to stand is held up by the support probe,
    // a little wider than the body (supported()). Saying it is in the air, the body is held up by
    // what lies under its footprint; by the probe's widening (a rim beside it) only while it says
    // it rises, no faster than a jump. A body rising past a rim in reports whose take-off the
    // server did not see must start the envelope again there (its own arcs fall by then): one
    // that climbs out of water by the water-exit lift (motion.ts WATER_EXIT_SPEED, jump held,
    // swimming into the wall) beside a ledge, or one hopping up steps with the jump key held. (The
    // hopper's client does count its touch-down on the lower tread, StepFacts.touchedDown, but the
    // ground of that landing is not always found: below the report's end the search stops at the
    // rim beside its feet, higher than the arcs reach; the old place may not lie over that tread;
    // and on a tilted staircase the riser beside the feet is a leaning wall, whose foot the
    // strips of underLeaningWalls leave out.) But a body thrown
    // up past the top of a wall faster than a jump, or falling past the rim of a ledge, does not
    // land on it: the envelope would start again with a jump slower than the blast's arc it goes
    // on along, and the fall would be cut in two (less damage). The claimed speed is the client's
    // word: it gets no more than claiming to stand at the same place would (the same probe), and
    // its fall ends there.
    const held = this.supported(nb, rec, 0);
    this.groundOk = rep.onGround && held;
    this.heldEnd = this.groundOk || (held && ((vyUp > 0 && vyUp <= JUMP_SPEED) || this.supported(nb, rec, 0, false)));
    // A report that claims to land (the previous accepted one was in the air; not the first of an
    // epoch) where nothing holds up its end: the body landed on the way and walked off again (it
    // moves vertically first, then horizontally, and a stair tread is half a block deep): treated
    // as a landing no report showed (LANDINGS; docs/SHAPES.md 5.8 item 4).
    const edgeLanding = rep.onGround && !this.groundOk && !d.reportedOnGround && !d.fresh;
    if (edgeLanding) unseen = true;
    // Ending held up, or on the ground of a landing no report showed, the body may have climbed a
    // staircase on the way: one step up per riser it crossed, and the risers of a staircase on the
    // half-cell lattice are at most |dx| + |dz| <= sqrt(2) h apart, whatever the staircase's
    // heading (docs/SHAPES.md 5.8 item 1). Only where a staircase lies between the two places: the
    // terrain on the way can be climbed a step at a time (stairClear). Else a report could hop
    // onto a wall sqrt(2) h higher than a jump in open air, where the vertical-first dog-leg
    // passes the path check.
    const stairClimb = (this.heldEnd || unseen) && h > 0 && this.stairPath(pathFrom, pathTo) ? Math.SQRT2 * h : 0;
    // The vertical envelope over the report's movement time (VERTICAL ENVELOPE): rising needs
    // something that lifted the body. A flying body is bound by the speed limits alone (the
    // envelope starts again when the report is accepted).
    let spanPeak = this.advanceArcs(d.envTop, d.envVy, d.envTopLate, d.envVyLate, d.envPeak, d.envHeld, ticks);
    let rise = d.envRise;
    let paid = d.envPaid;
    // A landing no report showed (LANDINGS) needs ground the body can have reached in the gap, no
    // higher than its arcs got in the gap plus a step and what a staircase between the two places
    // climbs (`highest`), never the face of a leaning wall (underLeaningWalls): under either place,
    // down to the reachable fall below the lower one; when the new place is the higher one, only if
    // the old one has ground within the reachable fall below it (the body rose from there), and
    // under the new one only within its own reachable fall. The envelope then starts again on the
    // highest such ground, with a jump from there in
    // any tick of the gap, and the fall tracked so far ends on it, the drop down to it included
    // (EntityManager.updateClientDriven): counting landings ends no fall early, and in mid-air it
    // climbs nothing. Under the higher place too, when that is the old one: a body that came down a
    // staircase to a wall leaning away from it, landed at its foot and jumped is a jump above the
    // deck there, beside the wall, whose foot the leaning-wall strips leave out at that height; the
    // tread it came from, under the old place, is ground it can have stood on. Not when the higher
    // place is the new one and nothing is within reach below the old: then the body rose from
    // mid-air, and a client counting landings as it rose beside a structure tilted 40 to 45 degrees
    // landed on the ends of its short masts and on its ridge, up to three blocks above the face it
    // stood on. (A body that climbed a staircase, landed on it
    // unseen and ends not held up at the server's poses, the deck rolling under it, came down on a
    // tread of that staircase; one that landed on a tread's edge and walked off it, an edge
    // landing, came down on the rim under the old place.) Ground farther below the report's end
    // than a jump from it reaches, with a step, the staircase's climb and what pushes, a carrier
    // switch and the slack allow, is not searched for: the envelope starting again there would
    // refuse the report all the same.
    if (unseen) {
      const ob = boxAt(p, p.pos.x, p.pos.y, p.pos.z, this.oldBox);
      const reach = (Math.max(0, -d.envVy) + GRAVITY * allow) * allow;
      const highest = p.pos.y - d.envRise + d.envPaid + spanPeak + STEP_HEIGHT + stairClimb + extra + switchSlack;
      // The lowest ground searched: the reachable fall below the lower place, and no lower than the
      // envelope could start again from and still pass the report.
      const lowest = Math.max(Math.min(ob.minY, nb.minY) - reach, nb.minY - (JUMP_PEAK + STEP_HEIGHT + stairClimb + extra + switchSlack + d.slack));
      let ground = -Infinity;
      // What the landing's ground lies on (supported(): a structure, or undefined for the world).
      let on: StructRec | undefined;
      const climb = nb.minY > ob.minY;
      if (!climb || this.supported(ob, rec, reach)) {
        // (Risen above the old place, the new one has ground within the reachable fall below it only.)
        const groundNew = this.groundUnder(nb, rec, climb ? Math.max(lowest, nb.minY - reach) : lowest, highest);
        on = this.supportBy;
        // (Under the old place only ground above that under the new one can matter.)
        const groundOld = this.groundUnder(ob, rec, groundNew > lowest ? groundNew : lowest, highest);
        if (groundOld > groundNew) on = this.supportBy;
        ground = Math.max(groundOld, groundNew);
      }
      if (ground > -Infinity) {
        this.landedUnseen = true;
        this.landedGround = ground;
        // Walking on from that ground, the body may have gone down a staircase between the two
        // places, or down the floor of the tilted structure the ground lies on (a deck heeling
        // away from where it landed): no fall either way.
        this.landedWalk = h > 0 && this.stairPath(pathFrom, pathTo) ? Infinity : on === undefined ? 0 : this.floorDescent(on, w1.x - p.pos.x, w1.z - p.pos.z);
        rise = p.pos.y - ground;
        paid = 0;
        spanPeak = this.advanceArcs(0, JUMP_SPEED, 0, JUMP_SPEED, JUMP_PEAK, true, ticks);
      }
    }
    // A report that claims to stand where nothing holds it up, right after a report that truly
    // stood or as an edge landing: the client's body stood on a tread's edge at the start of this
    // tick (its mover sets the ground flag before the horizontal move) and walked off it in the
    // same tick, so it may still take off in the next one. The latest take-off is kept open for
    // one more report (envHeld); the report after it, standing nowhere again, gets no more.
    if (rep.onGround && !this.groundOk && (d.onGround || (edgeLanding && this.landedUnseen))) {
      this.envTopLate = 0;
      this.envVyLate = JUMP_SPEED;
      this.envHeld = true;
    }
    this.envRise = rise + dy;
    this.envPaid = 0;
    if (!rep.flying) {
      // Where the arcs are now: the peak when it lies between the two take-offs, else the later
      // take-off's while both fall, the earlier one's while both rise.
      const nowPeak = rising(this.envVyLate) ? (rising(this.envVy) ? this.envTop : this.envPeak) : this.envTopLate;
      // Ending on what it landed on (heldEnd), the body may have come down on it at any tick of the
      // report (a step up and a staircase climbed included); ending in liquid, the liquid may have
      // slowed its fall; ending in the air, it is where gravity has it by now at the highest.
      const bound = this.heldEnd ? spanPeak + STEP_HEIGHT + stairClimb : this.inLiquid(p, w1) ? spanPeak : nowPeak;
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
    if (wNew > worldTol && wNew > wOld + 1e-6) return 'world';
    if (rec !== undefined) {
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
    if (!this.pathClear(pathFrom, pathTo)) return 'path';
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

  /**
   * The fall to settle for a client-driven player that has landed where it is now without saying
   * it stands (heldEnd of its report): `fell`, what it fell so far, plus the drop to what holds it
   * up under its footprint, to within 0.01. It comes down on that in a tick or two, and the drop
   * belongs to this fall, not to the next one (else a fall would be judged a few hundredths short
   * whenever the report before its landing ended within the support probe). The drop is at most
   * the probe's depth; it is not measured where it cannot matter (below LAND_EVENT_HEIGHT).
   */
  landingFall(p: Player, fell: number): number {
    const probe = SUPPORT_GAP + REPORT_SUPPORT_REACH;
    if (fell + probe < LAND_EVENT_HEIGHT) return fell;
    const b = boxAt(p, p.pos.x, p.pos.y, p.pos.z, this.sb);
    const carrier = p.carrierId !== 0 ? this.body.record(p.carrierId) : undefined;
    // supported() probes `probe + deeper` below the feet: the drop is where it starts to hold.
    let lo = -probe;
    let hi = 0;
    if (!this.supported(b, carrier, hi, false)) return fell;
    while (hi - lo > 0.01) {
      const mid = (lo + hi) * 0.5;
      if (this.supported(b, carrier, mid, false)) hi = mid;
      else lo = mid;
    }
    return fell + probe + lo;
  }

  /** Is the player, where it is now, held up: standing on something, in liquid (as last sampled) or flying? */
  heldUp(p: Player): boolean {
    if (p.flying || p.wet > 0 || p.inLava) return true;
    return this.supported(boxAt(p, p.pos.x, p.pos.y, p.pos.z, this.sb), p.carrierId !== 0 ? this.body.record(p.carrierId) : undefined, 0);
  }

  /**
   * Is a body box at the server's poses held up by the world, its carrier or another structure,
   * `deeper` blocks below it included (standsOn)? Probed a little deeper and wider than a body
   * stands (REPORT_SUPPORT_REACH): the box is world-aligned, and the server's pose of a deck that
   * rolls or turns tilts it against the deck a little differently than the client's copy did (a
   * rider at the very edge of a rolling deck); and the mover sets its ground flag before the
   * horizontal move, so a body that walks off a ledge still claims to stand a tick's walk beyond
   * its rim (in the world too: without the wider probe the shared mover's honest reports on flat
   * land with steps are judged airborne). `wide` false: the footprint only, not widened (a body
   * that says it is in the air and is not rising: check() heldEnd).
   */
  private supported(b: AABB, carrier: StructRec | undefined, deeper: number, wide = true): boolean {
    const gap = SUPPORT_GAP + REPORT_SUPPORT_REACH + deeper;
    const inset = wide ? -REPORT_SUPPORT_REACH : 0;
    if (this.standsOn(this.world, b, gap, inset, 0, 0)) {
      this.supportBy = undefined;
      return true;
    }
    if (carrier !== undefined) {
      const lean = leanOf(carrier, this.lean);
      if (this.standsOn(carrier.grid, b, gap, inset, lean.x, lean.z)) {
        this.supportBy = carrier;
        return true;
      }
    }
    const near = this.body.structuresNear(b, gap, this.near);
    for (let k = 0; k < near.length; k++) {
      const r = near[k]!;
      if (r === carrier || b.minY - gap >= r.maxY || b.minY <= r.minY) continue;
      const lean = leanOf(r, this.lean);
      if (this.standsOn(r.grid, b, gap, inset, lean.x, lean.z)) {
        this.supportBy = r;
        return true;
      }
    }
    return false;
  }

  /**
   * How far the floor of structure `r` descends over the horizontal world displacement (dx, dz):
   * its floors lie square to the grid axis nearest the vertical (leanOf), so going (dx, dz) along
   * one changes the height by -(lean . (dx, dz)). 0 where it rises.
   */
  private floorDescent(r: StructRec, dx: number, dz: number): number {
    const lean = leanOf(r, this.lean);
    const down = lean.x * dx + lean.z * dz;
    return down > 0 ? down : 0;
  }

  /**
   * Hard cells of `grid` under the feet of body box `b` (within `gap` below them, footprint inset
   * by `inset`) — under them, not beside them. A wall the body touches, comes within the probe's
   * widening of, or dips into (by up to REPORT_HARD_TOLERANCE, the world and hull checks'
   * allowance) reaches into the support probe as well, and would hold the body up at any height along it: a client could climb a wall at a
   * block per tick, or fall beside it unharmed, claiming to stand all the way. So where the body
   * box itself meets hard cells of the grid above its feet (from REPORT_SUPPORT_REACH up: a foot
   * dipping into the floor of a tilted deck is not a wall), the footprint is inset in steps of
   * SUPPORT_INSET_STEP until it no longer does, and only what lies under that footprint counts. A
   * body that dips deeper into a wall than REPORT_HARD_TOLERANCE is held up by nothing there.
   *
   * (`leanX`, `leanZ`): how the grid's walls lean (leanOf; 0, 0 for the world). A wall of a
   * tilted structure leans, and its foot may reach under the footprint although the wall stays
   * clear of the body above the feet: underLeaningWalls leaves out what such a foot can reach. On
   * the world and on upright structures walls are vertical: what clears the body clears the feet.
   */
  private standsOn(grid: VoxelGrid, b: AABB, gap: number, inset: number, leanX: number, leanZ: number): boolean {
    const a = this.ab;
    a.minX = b.minX;
    a.minZ = b.minZ;
    a.maxX = b.maxX;
    a.maxZ = b.maxZ;
    a.minY = a.maxY = b.maxY;
    // (The probe of hasSupportBelow is the box's footprint from its minY down by the depth.)
    const above = b.maxY - b.minY - REPORT_SUPPORT_REACH;
    const tilted = leanX !== 0 || leanZ !== 0;
    for (let k = 0; ; k++) {
      const i = inset + k * SUPPORT_INSET_STEP;
      if (i > REPORT_HARD_TOLERANCE + 1e-9) return false;
      // The probe only shrinks as the inset grows: nothing under this footprint, nothing under a smaller one.
      if (!hasSupportBelow(grid, b, gap, i)) return false;
      if (!(above > 0)) return true;
      if (!hasSupportBelow(grid, a, above, i)) return !tilted || this.underLeaningWalls(grid, b, gap, i, above, leanX, leanZ);
    }
  }

  /**
   * standsOn on a tilted grid, once the footprint inset by `i` is clear of hard cells above the
   * feet (from REPORT_SUPPORT_REACH up, `above` high): is there support within `gap` below the
   * feet under the part of that footprint that no leaning wall reaches into?
   *
   * A wall's foot reaches the farther under the feet the deeper below them it is: at depth d,
   * by the lean times (d + REPORT_SUPPORT_REACH) at most (clearOfLeaningWalls). So the probe is
   * cut into slabs, each with what a leaning wall reaches at its bottom left out: down to the
   * standing probe's depth (SUPPORT_GAP + REPORT_SUPPORT_REACH) one slab, below it slabs over which
   * that reach grows by SUPPORT_INSET_STEP or by LEAN_SLAB_GROWTH of itself, whichever is more.
   * The slabs are the same whatever the probe's depth (the last one is cut off at it, with its
   * whole reach left out), so what is left out at each depth is never less than a wall's foot can
   * reach there and does not depend on how deep the probe goes: what holds at one depth holds at
   * every deeper one, as the search for the ground of a landing nobody saw needs (supportDepth).
   * Leaving out the reach at the probe's bottom at every depth instead, a deep probe left nothing
   * under a body beside a leaning mast, the deck at its foot included; leaving out only the
   * standing probe's reach, the face of a mast leaning away from the body was found a few tenths
   * below the feet, and a client counting landings that never happened climbed it to its top, a
   * block a report.
   */
  private underLeaningWalls(grid: VoxelGrid, b: AABB, gap: number, i: number, above: number, leanX: number, leanZ: number): boolean {
    const stand = SUPPORT_GAP + REPORT_SUPPORT_REACH;
    if (gap <= stand) {
      const h = gap + REPORT_SUPPORT_REACH;
      return this.clearOfLeaningWalls(grid, b, 0, gap, i, above, leanX * h, leanZ * h, true) === LEAN_SUPPORT;
    }
    const fine = SUPPORT_INSET_STEP / Math.max(Math.abs(leanX), Math.abs(leanZ));
    // No hard cells above the feet within the reach of the slab the probe ends in: whatever lies
    // under the footprint counts (standsOn found some).
    let last = stand;
    while (last < gap) last += Math.max(fine, LEAN_SLAB_GROWTH * (last + REPORT_SUPPORT_REACH));
    if (!this.leaningWallNear(grid, b, i, above, leanX * (last + REPORT_SUPPORT_REACH), leanZ * (last + REPORT_SUPPORT_REACH))) return true;
    let top = 0;
    let bottom = stand;
    for (;;) {
      const h = bottom + REPORT_SUPPORT_REACH;
      const s = this.clearOfLeaningWalls(grid, b, top, (bottom < gap ? bottom : gap) - top, i, above, leanX * h, leanZ * h, false);
      if (s !== LEAN_NONE) return s === LEAN_SUPPORT;
      if (bottom >= gap) return false;
      top = bottom;
      bottom += Math.max(fine, LEAN_SLAB_GROWTH * h);
    }
  }

  /** Hard cells above the feet (from REPORT_SUPPORT_REACH up, `above` high) within the reach (dx, dz) beyond the sides of the footprint inset by `i` the walls lean toward? */
  private leaningWallNear(grid: VoxelGrid, b: AABB, i: number, above: number, dx: number, dz: number): boolean {
    return this.hardAbove(grid, b, above, b.minX + i - (dx < 0 ? 1e-6 - dx : 0), b.maxX - i + (dx > 0 ? dx + 1e-6 : 0), b.minZ + i - (dz < 0 ? 1e-6 - dz : 0), b.maxZ - i + (dz > 0 ? dz + 1e-6 : 0));
  }

  /**
   * One slab of underLeaningWalls: from `top` to `top + depth` below the feet, the footprint inset
   * by `i` clear of hard cells above the feet (from REPORT_SUPPORT_REACH up, `above` high). Is
   * there support in it under the part of the footprint that no leaning wall reaches into?
   * LEAN_SUPPORT, LEAN_NONE, or LEAN_NEVER: none, and nothing is left of the footprint in this or
   * any deeper slab (a side's strip with a wall beyond covers it). `whole`: the slab is the whole
   * probe, under whose footprint standsOn found support.
   *
   * The grid's solid material continues along the grid axis nearest the world's up (the walls'
   * axis), which leans from it: rising h, a line along that axis moves (`dx`, `dz`) * h / H
   * horizontally, where (`dx`, `dz`) is the displacement over the whole height H from the slab's
   * bottom to REPORT_SUPPORT_REACH above the feet (underLeaningWalls). A point of a column under
   * the feet within the slab whose solid material goes on up past REPORT_SUPPORT_REACH above them
   * (a wall, not a tread) meets that height displaced from where it was by at most (`dx`, `dz`),
   * in that direction; it is not inside the footprint there (the footprint is clear above the
   * feet), so it lies outside a side the walls lean toward, within the reach |dx| beyond the x
   * side, |dz| beyond the z side. Hence: where hard cells above the feet lie within the reach
   * beyond such a side, that side's strip as deep as the reach is left out; where they lie only
   * beyond the corner between the two such sides, that corner's rectangle. Hard cells beyond the
   * other sides cannot be the top of a column under the feet: a floor rising up the slope behind
   * the body, or a wall leaning over it, whose foot lies farther away than its top. What lies
   * under the rest is a tread or step whose top is below that height, however narrow the strip
   * of it under the feet (a body that has just stepped up stands on a few thousandths of a tread,
   * with the next riser at its corner; a body in the crease between a steep floor and a leaning
   * mast stands on the floor). This holds for the footprint widened by the probe's reach too (a
   * wall a little beyond the body leans into the widening).
   */
  private clearOfLeaningWalls(grid: VoxelGrid, b: AABB, top: number, depth: number, i: number, above: number, dx: number, dz: number, whole: boolean): number {
    const x0 = b.minX + i;
    const x1 = b.maxX - i;
    const z0 = b.minZ + i;
    const z1 = b.maxZ - i;
    // The reach beyond each side (with a millionth for rounding): only beyond the sides the walls
    // lean toward, at most one on each axis.
    const rx0 = dx < 0 ? 1e-6 - dx : 0;
    const rx1 = dx > 0 ? dx + 1e-6 : 0;
    const rz0 = dz < 0 ? 1e-6 - dz : 0;
    const rz1 = dz > 0 ? dz + 1e-6 : 0;
    if (!this.hardAbove(grid, b, above, x0 - rx0, x1 + rx1, z0 - rz0, z1 + rz1)) return whole || this.hardUnder(grid, b, top, depth, x0, x1, z0, z1) ? LEAN_SUPPORT : LEAN_NONE;
    // Support under the footprint without the strips on those sides is support under any part of
    // it the sides and the corner below leave (the usual answer beside a wall: two queries, not six).
    if (this.hardUnder(grid, b, top, depth, x0 + rx0, x1 - rx1, z0 + rz0, z1 - rz1)) return LEAN_SUPPORT;
    const wx0 = rx0 > 0 && this.hardAbove(grid, b, above, x0 - rx0, x0, z0, z1);
    const wx1 = rx1 > 0 && this.hardAbove(grid, b, above, x1, x1 + rx1, z0, z1);
    const wz0 = rz0 > 0 && this.hardAbove(grid, b, above, x0, x1, z0 - rz0, z0);
    const wz1 = rz1 > 0 && this.hardAbove(grid, b, above, x0, x1, z1, z1 + rz1);
    // The corner between the two sides the walls lean toward, when both are clear (else a side's
    // strip covers its rectangle). Only one of the four can be such a corner.
    const c00 = rx0 > 0 && rz0 > 0 && !wx0 && !wz0 && this.hardAbove(grid, b, above, x0 - rx0, x0, z0 - rz0, z0);
    const c01 = rx0 > 0 && rz1 > 0 && !wx0 && !wz1 && this.hardAbove(grid, b, above, x0 - rx0, x0, z1, z1 + rz1);
    const c10 = rx1 > 0 && rz0 > 0 && !wx1 && !wz0 && this.hardAbove(grid, b, above, x1, x1 + rx1, z0 - rz0, z0);
    const c11 = rx1 > 0 && rz1 > 0 && !wx1 && !wz1 && this.hardAbove(grid, b, above, x1, x1 + rx1, z1, z1 + rz1);
    const sx0 = wx0 ? x0 + rx0 : x0;
    const sx1 = wx1 ? x1 - rx1 : x1;
    const sz0 = wz0 ? z0 + rz0 : z0;
    const sz1 = wz1 ? z1 - rz1 : z1;
    // (The strips only widen in deeper slabs, and the walls beyond stay within their reach.)
    if (!(sx0 < sx1) || !(sz0 < sz1)) return LEAN_NEVER;
    // Without the corner's rectangle: the union of two crossing rectangles.
    const cz0 = c00 || c10 ? rz0 : 0;
    const cz1 = c01 || c11 ? rz1 : 0;
    const cx0 = c00 || c01 ? rx0 : 0;
    const cx1 = c10 || c11 ? rx1 : 0;
    return this.hardUnder(grid, b, top, depth, sx0, sx1, sz0 + cz0, sz1 - cz1) || this.hardUnder(grid, b, top, depth, sx0 + cx0, sx1 - cx1, sz0, sz1) ? LEAN_SUPPORT : LEAN_NONE;
  }

  /** Hard cells of `grid` over x0..x1, z0..z1 from REPORT_SUPPORT_REACH above the feet of `b` up to its top (`above` high)? */
  private hardAbove(grid: VoxelGrid, b: AABB, above: number, x0: number, x1: number, z0: number, z1: number): boolean {
    const a = this.wb;
    a.minX = x0;
    a.maxX = x1;
    a.minZ = z0;
    a.maxZ = z1;
    a.minY = a.maxY = b.maxY;
    return hasSupportBelow(grid, a, above, 0);
  }

  /** Hard cells of `grid` over x0..x1, z0..z1 from `top` to `top + depth` below the feet of `b` (none when the area is empty)? */
  private hardUnder(grid: VoxelGrid, b: AABB, top: number, depth: number, x0: number, x1: number, z0: number, z1: number): boolean {
    if (!(x0 < x1) || !(z0 < z1)) return false;
    const a = this.wb;
    a.minX = x0;
    a.maxX = x1;
    a.minZ = z0;
    a.maxZ = z1;
    a.minY = a.maxY = b.minY - top;
    return hasSupportBelow(grid, a, depth, 0);
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

  /**
   * The ground a body box came down on, for a landing nobody saw (check(), LANDINGS): the world
   * height its feet would be held up at (supportDepth below it; the surface itself lies up to the
   * standing probe's depth, SUPPORT_GAP + REPORT_SUPPORT_REACH, lower: a body that high above it
   * stands), if that is between `lowest` and `highest`; else -Infinity.
   */
  private groundUnder(b: AABB, carrier: StructRec | undefined, lowest: number, highest: number): number {
    const depth = this.supportDepth(b, carrier, b.minY - lowest);
    const y = b.minY - depth;
    return depth >= 0 && y <= highest ? y : -Infinity;
  }

  /**
   * How far below a body box at the server's poses the first thing that would hold it up lies
   * (supported() with `deeper`, to within 0.01): -1 when nothing does within `reach` below it.
   * (What holds at one depth holds at every deeper one, the face of a leaning wall at none:
   * underLeaningWalls.)
   */
  private supportDepth(b: AABB, carrier: StructRec | undefined, reach: number): number {
    // (The standing probe first: it asks no deep slabs, and it is the usual answer.)
    if (!(reach >= 0)) return -1;
    if (this.supported(b, carrier, 0)) return 0;
    if (!this.supported(b, carrier, reach)) return -1;
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
   * when the straight line, the vertical-first or the vertical-last dog-leg, one along the frame's
   * x or z axis first, or a staircase from the lower end to the higher one (stairClear) is.
   */
  private pathClear(a: Vec3, b: Vec3): boolean {
    if (this.legClear(a.x, a.y, a.z, b.x, b.y, b.z, false)) return true;
    if (this.dogLegClear(a, b, a.x, b.y, a.z) || this.dogLegClear(a, b, b.x, a.y, b.z) || this.dogLegClear(a, b, b.x, a.y, a.z) || this.dogLegClear(a, b, a.x, a.y, b.z)) return true;
    return this.stairPath(a, b);
  }

  /** stairClear from the lower of the two ends to the higher one, evaluated once per check (`stairs`). */
  private stairPath(a: Vec3, b: Vec3): boolean {
    if (this.stairs === 0) this.stairs = (a.y <= b.y ? this.stairClear(a, b) : this.stairClear(b, a)) ? 1 : 2;
    return this.stairs === 1;
  }

  /**
   * The staircase path from the lower end `lo` to the higher end `hi` (docs/SHAPES.md 5.8 item 3):
   * along the horizontal line from lo to below hi in samples of REPORT_PATH_STEP, starting at
   * lo.y; a blocked sample lifts the height by the smallest multiple of REPORT_PATH_STEP that
   * clears it, at most STEP_HEIGHT and never above hi.y (stepUp); the height never comes down;
   * then straight up to hi. So only a climb of at most one step at a time passes, under a ceiling
   * parallel to the treads too (where the vertical-first dog-leg hits the ceiling); walls and
   * cages do not. Not applicable (false) when the ends are level or one is right above the other.
   *
   * A sample that one step does not clear may still be reached round the corner, one horizontal
   * axis of the path frame at a time with a step on each leg: x first, then z, or z first, then x.
   * A line along or near the diagonal of a diagonal staircase (height 0.5 (i + j) on the
   * half-cell lattice) crosses an x riser and a z riser at the same sample, and the tread beyond
   * both is two steps above the one before them; the mover climbs them one riser at a time.
   * Without the corner no line within a few hundredths of that diagonal passed, nor about one in
   * eight walkable lines of any heading across such a staircase; an honest player whose path
   * follows the diagonal (as on a deck heeling about the staircase's other diagonal) got no
   * staircase allowance and was refused for check:rise after a few lost reports. The corner (x
   * of this sample and z of the previous one, or the other way round) must be clear at most a
   * step above the height so far, and the sample at most a step above the corner: a riser along
   * one axis is crossed by one leg, so a wall or the corner of a block needs as much as before.
   *
   * The last leg, straight up to hi, is at most STAIR_LAST_LEG (1.7): where no height within a
   * step frees a sample (stepUp), it may overlap a tread by up to REPORT_HARD_TOLERANCE without
   * being lifted, so the samples may graze the corners of treads (a spike, the rim of a hole) and
   * arrive a few risers below hi. In a fuzz of 14108 lines over random staircases, with spikes and
   * holes, no line a body can walk along needed more than 1.7. Without the bound the path passed
   * a report that ends beside a wall, or on its rim, with the feet at its top: nothing on the way
   * to climb, then the leg up the wall's face, and the staircase allowance let a report hop onto a
   * wall eight blocks high. The bound is not the path's depth limit, which on a moving carrier
   * holds the world's allowance (the carrier's speed times the lag, up to REPORT_LAG_LIMIT): a
   * client claiming two seconds of lag hopped onto the rim of a wall six blocks high on the deck
   * of a raft under way.
   */
  private stairClear(lo: Vec3, hi: Vec3): boolean {
    const dx = hi.x - lo.x;
    const dz = hi.z - lo.z;
    const n = Math.ceil(Math.sqrt(dx * dx + dz * dz) / REPORT_PATH_STEP);
    if (n === 0 || !(hi.y > lo.y)) return false;
    let y = lo.y;
    let px = lo.x;
    let pz = lo.z;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const x = lo.x + dx * t;
      const z = lo.z + dz * t;
      let y2 = this.stepUp(x, y, z, hi.y);
      if (Number.isNaN(y2)) {
        const xFirst = this.stepUp(x, y, pz, hi.y);
        if (!Number.isNaN(xFirst)) y2 = this.stepUp(x, xFirst, z, hi.y);
      }
      if (Number.isNaN(y2)) {
        const zFirst = this.stepUp(px, y, z, hi.y);
        if (!Number.isNaN(zFirst)) y2 = this.stepUp(x, zFirst, z, hi.y);
      }
      if (Number.isNaN(y2)) return false;
      y = y2;
      px = x;
      pz = z;
    }
    return hi.y - y <= STAIR_LAST_LEG && this.legClear(hi.x, y, hi.z, hi.x, hi.y, hi.z, false);
  }

  /**
   * The height the staircase path takes at the body sample (x, z) coming from height `y`
   * (stairClear): of the heights from `y` up in multiples of REPORT_PATH_STEP, at most STEP_HEIGHT
   * above it and never above `top`, the lowest at which the sample touches no hard cell, else the
   * lowest at which it is clear (overlaps hard cells within the depth limit); NaN when none is.
   * The mover steps up a riser that its box overlaps by any amount, also sideways: a body walking
   * up the edge of a staircase with a sliver of its footprint over the treads climbs every riser.
   * With only the depth limit, the samples of its path would overlap those treads by less than
   * the limit, stay low beside them, and leave the whole climb to the bounded last leg.
   */
  private stepUp(x: number, y: number, z: number, top: number): number {
    let clear = NaN;
    let y2 = y;
    for (let j = 1; ; j++) {
      const s = this.sampleDepth(x, y2, z);
      if (s === SAMPLE_FREE) return y2;
      if (s === SAMPLE_CLEAR && Number.isNaN(clear)) clear = y2;
      if (y2 === top || j * REPORT_PATH_STEP > STEP_HEIGHT + 1e-9) return clear;
      y2 = y + j * REPORT_PATH_STEP < top ? y + j * REPORT_PATH_STEP : top;
    }
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

  /** The body sample at (x, y, z) of the path frame is not deeper in hard cells than the depth limits. */
  private sampleClear(x: number, y: number, z: number): boolean {
    return this.sampleDepth(x, y, z) !== SAMPLE_BLOCKED;
  }

  /**
   * The body sample at (x, y, z) of the path frame (local to pathRec, else world): SAMPLE_FREE when
   * it overlaps no hard cell of the world or of pathRec, SAMPLE_CLEAR when it overlaps them no
   * deeper than limWorld / limCarrier, SAMPLE_BLOCKED when deeper.
   */
  private sampleDepth(x: number, y: number, z: number): number {
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
    let s = SAMPLE_FREE;
    if (boxOverlapsSolid(this.world, b)) {
      if (hardDepth(this.world, b) > this.limWorld) return SAMPLE_BLOCKED;
      s = SAMPLE_CLEAR;
    }
    if (r !== undefined && boxOverlapsSolid(r.grid, b)) {
      if (hardDepth(r.grid, b) > this.limCarrier) return SAMPLE_BLOCKED;
      s = SAMPLE_CLEAR;
    }
    return s;
  }
}
