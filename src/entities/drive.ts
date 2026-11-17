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
 * CHECKS (ReportJudge.check; a failure is a correction 'check:<what>', never a kick):
 *  - movement time: each report claims its seq gap in client ticks, granted from a credit that
 *    refills one per server tick (REPORT_CREDIT_TICKS at most) and may run REPORT_DEBT_TICKS into
 *    debt (reports arriving bunched when the uplink delay drops); a client faster than the server's
 *    clock is corrected once the debt is spent;
 *  - speed relative to the carrier ('speed'): within the movement limits for the granted time, plus
 *    what may move the body besides its legs — momentum (a carrier left, a knock-back, flight
 *    ended), other structures (as fast as one near the body moved over the last REPORT_MAX_LAG: the
 *    client's copy may still move after the server's stopped), the world scraping it along its
 *    moving carrier; excess beyond that is drawn from a slack budget (REPORT_SLACK_BURST, refilled
 *    at REPORT_SLACK_RATE), so no sustained speed-up hides in it;
 *  - the vertical envelope ('rise'): a body nothing holds up (ground or deck under its feet at the
 *    server's poses, liquid, flight) rises no higher than a jump (or the upward speed it was given)
 *    under gravity allows; claiming to stand in mid-air does not count as standing, so the fall
 *    goes on. A report that rises above it, and a body whose reports stop in mid-air
 *    (REPORT_STALL_TICKS), falls on the server's own authority (EntityManager.fallOnServer: a
 *    correction 'fall' every tick until something holds it up or its client catches up);
 *  - not deep in world blocks or in the carrier's ('world', 'hull'), unless it was as deep before or
 *    is caught there (the world holds it while its carrier moves into it: a squeeze, judged by the
 *    squeeze rules), nor through them on the way ('path': the straight path, or a dog-leg as the
 *    mover takes it, sampled every REPORT_PATH_STEP);
 *  - plus: garbage, flight only in creative, a claimed carrier near the reported feet.
 *
 * SEAT. A seated player's body is the server's: it follows the seat and is pushed off it on the
 * server whatever the drive mode. From a seated client's reports only the stick axes (helm), the
 * sneak key (docking) and the look are used.
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
  REPORT_DEBT_TICKS,
  REPORT_HARD_TOLERANCE,
  REPORT_MAX_LAG,
  REPORT_PATH_STEP,
  REPORT_SLACK_BURST,
  REPORT_SUPPORT_REACH,
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
  return out;
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
  /**
   * Fastest motion (blocks/s, relative to the body's carrier) of a structure near the body over
   * the last REPORT_MAX_LAG: the client's lagging copy may still move like that after the server's
   * stopped (a ship ramming a pier stops dead on the server first).
   */
  pushRecent = 0;
  /**
   * Fastest speed of the body's carrier at the body over the last REPORT_MAX_LAG (blocks/s): a ship
   * that stopped dead on the server still sails on the client's copy, and carries the body into
   * what the server's ship already stopped at.
   */
  carrierRecent = 0;
  /** The per-tick speeds behind pushRecent / carrierRecent (rings of REPORT_DEBT_TICKS ticks). */
  private readonly pushRing = new Float64Array(REPORT_DEBT_TICKS);
  private readonly carrierRing = new Float64Array(REPORT_DEBT_TICKS);
  private ringAt = 0;

  /** This tick's structure speed near the body and carrier speed at it: pushRecent / carrierRecent become the maxima of the last REPORT_MAX_LAG. */
  recordSpeeds(push: number, carrier: number): void {
    const n = this.pushRing.length;
    this.ringAt = (this.ringAt + 1) % n;
    this.pushRing[this.ringAt] = push;
    this.carrierRing[this.ringAt] = carrier;
    let mp = 0;
    let mc = 0;
    for (let i = 0; i < n; i++) {
      if (this.pushRing[i]! > mp) mp = this.pushRing[i]!;
      if (this.carrierRing[i]! > mc) mc = this.carrierRing[i]!;
    }
    this.pushRecent = mp;
    this.carrierRecent = mc;
  }

  // ---- vertical envelope: nothing lifts a body that nothing holds up (ground, liquid, flight)
  /** Height (blocks) the reference rose above where something last held it up (accepted vertical displacements summed). */
  envRise = 0;
  /** Highest it may be by now above that point: a jump (or the upward speed it was given) under gravity since. */
  envTop = 0;
  /** Largest upward speed (blocks/s) it may have by now. */
  envVy = JUMP_SPEED;

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
   * The vertical envelope starts again where something holds the body up (or a correction put
   * it), with upward speed `vy` at most.
   */
  resetEnvelope(vy: number): void {
    this.envRise = 0;
    this.envTop = 0;
    this.envVy = vy;
  }
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
  private readonly pa: Vec3 = vec3();
  private readonly pb: Vec3 = vec3();
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
  /** Vertical displacement of the report (the carrier frame's up, or the world's on a carrier switch). */
  dy = 0;
  /** The vertical envelope advanced to the report (DriveState.envTop / envVy). */
  envTop = 0;
  envVy = 0;

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
   * groundOk, dy, envTop, envVy for the caller to commit), else what failed. `ticks` is the
   * movement time (in ticks) granted to this report.
   */
  check(p: Player, d: ClientDrive, rep: MoveReport, ticks: number): CheckFailure | null {
    this.switchSpeed = 0;
    this.slackUsed = 0;
    this.groundOk = false;
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
    // (As fast as the carrier moved lately: the client's copy may still move like that.)
    const newCarrierSpeed = Math.max(this.carrierSpeed, d.carrierRecent);
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
    const prevCarrierSpeed = d.carrierId !== 0 ? Math.max(this.speedAt(d.carrierId, p.pos), d.carrierRecent) : 0;
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
      // copies by up to REPORT_MAX_LAG at the carriers' speeds.
      dx = w1.x - p.pos.x;
      dy = w1.y - p.pos.y;
      dz = w1.z - p.pos.z;
      switchSlack = (prevCarrierSpeed + newCarrierSpeed) * REPORT_MAX_LAG + 1;
    }
    this.dy = dy;
    const nb = boxAt(p, w1.x, w1.y, w1.z, this.box);
    const allow = ticks * TICK_DT;
    // What may move the body besides its own legs: another structure pushing it (as fast as one
    // near it moved lately: the client's copy may still be moving), or the world scraping it
    // along its moving carrier (in the carrier's frame the world passes at the carrier's speed).
    let push = Math.max(this.structureSpeed(p, w1, rep.carrierId, cv), d.pushRecent);
    if (rec !== undefined && newCarrierSpeed > push && this.nearWorld(nb, 0.05 + newCarrierSpeed * (allow + REPORT_MAX_LAG))) push = newCarrierSpeed;
    // A body that just stopped flying still has the flight's speed (its momentum goes into
    // d.inherit when the report is accepted).
    const own = rep.flying || d.flying ? FLY_SPEED * FLY_SPRINT_MULTIPLIER : SPRINT_SPEED;
    const extra = d.inherit + push;
    const hMax = (own + extra) * allow + switchSlack;
    const upMax = (Math.max(JUMP_SPEED, FLY_VERTICAL_SPEED) + extra) * allow + STEP_HEIGHT + switchSlack;
    const downMax = (TERMINAL_SPEED + extra) * allow + switchSlack;
    const h = Math.sqrt(dx * dx + dz * dz);
    let excess = (h > hMax ? h - hMax : 0) + (dy > upMax ? dy - upMax : -dy > downMax ? -dy - downMax : 0);
    if (excess > d.slack) return 'speed';
    // Standing on something: claimed, and true at the server's poses (else it keeps falling).
    this.groundOk = rep.onGround && this.supported(nb, rec);
    // The vertical envelope: rising needs something that lifted the body. A flying body is bound
    // by the speed limits alone (the envelope starts again when the report is accepted).
    advanceEnvelope(d.envTop, d.envVy, ticks, this.env);
    this.envTop = this.env.top;
    this.envVy = this.env.vy;
    if (!rep.flying) {
      // Ending on something, the body may have come down on it at any tick of the report (a
      // step up included); ending in liquid, the liquid may have slowed its fall; ending in the
      // air, it is where gravity has it by now at the highest.
      const bound = this.groundOk ? this.env.peak + STEP_HEIGHT : this.inLiquid(p, w1) ? this.env.peak : this.env.top;
      const top = bound + extra * allow + switchSlack;
      const rise = d.envRise + dy;
      if (rise > top) excess += rise - top;
      if (excess > d.slack) return 'rise';
    }
    this.slackUsed = excess;
    // Not deep inside hard cells of the world or of the carrier — unless the body was as deep
    // before (then it did not move in by itself: that is a squeeze or a block put into it, the
    // squeeze and unstuck rules handle it).
    const worldTol = this.worldTolerance(rep.carrierId, newCarrierSpeed);
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

  /** World-overlap a body may have without counting as inside the world (see worldTolerance). */
  worldTolerance(carrierId: number, carrierSpeed: number): number {
    // A carried body is placed by the server's pose of its carrier, which leads the client's copy:
    // a deck carrying it past a wall puts it into the wall by up to the carrier's speed times the lag.
    return carrierId === 0 ? REPORT_HARD_TOLERANCE : REPORT_HARD_TOLERANCE + carrierSpeed * REPORT_MAX_LAG;
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
    return this.supported(boxAt(p, p.pos.x, p.pos.y, p.pos.z, this.sb), p.carrierId !== 0 ? this.body.record(p.carrierId) : undefined);
  }

  /**
   * Is a body box at the server's poses held up by the world, its carrier or another structure?
   * Probed a little deeper and wider than a body stands (REPORT_SUPPORT_REACH): the box is
   * world-aligned, and the server's pose of a deck that rolls or turns tilts it against the deck
   * a little differently than the client's copy did (a rider at the very edge of a rolling deck).
   */
  private supported(b: AABB, carrier: StructRec | undefined): boolean {
    const gap = SUPPORT_GAP + REPORT_SUPPORT_REACH;
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
   * May the body get from `a` to `b` (in the path frame: local to pathRec, else world) without
   * passing through hard cells of the world or of pathRec deeper than limWorld / limCarrier? The
   * client's mover moves a tick's displacement axis by axis (vertical first, then horizontal) and
   * steps up ledges, so a corner it went round may lie on the straight line: the path is clear
   * when the straight line, the vertical-first or the vertical-last dog-leg is.
   */
  private pathClear(a: Vec3, b: Vec3): boolean {
    if (this.legClear(a.x, a.y, a.z, b.x, b.y, b.z, false)) return true;
    const ma = this.pa;
    ma.x = a.x;
    ma.y = b.y;
    ma.z = a.z;
    if (this.legClear(a.x, a.y, a.z, ma.x, ma.y, ma.z, true) && this.legClear(ma.x, ma.y, ma.z, b.x, b.y, b.z, false)) return true;
    const mb = this.pb;
    mb.x = b.x;
    mb.y = a.y;
    mb.z = b.z;
    return this.legClear(a.x, a.y, a.z, mb.x, mb.y, mb.z, true) && this.legClear(mb.x, mb.y, mb.z, b.x, b.y, b.z, false);
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
