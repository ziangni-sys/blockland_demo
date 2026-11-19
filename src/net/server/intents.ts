/**
 * Intents on the server (docs/NETCODE.md section 10): IntentQueue, NetServer's IntentSink.
 *
 * Everything a client does to the world besides moving arrives as an intent on the reliable
 * channel, every intent with the next number of one sequence. The client chooses its targets
 * itself (its rays on its replica); the server checks each target and carries the intent out with
 * the simulation's own interaction code (sim/interact.ts, sim/players.ts PlayerControl): it writes
 * the player's input (buttons, presses, slot, sneak), claims the checked targets for its hands
 * (PlayerControl.claimAim: a client-driven player's hands act on them instead of casting rays),
 * or calls a command.
 *
 * QUEUE AND PACING. Per player, intents wait in a queue ordered by seq (one seen before, or below
 * the last processed, is dropped). At the start of every tick (beforeTick, after the movement
 * reports reached the simulation, and before sim.tick()), first the standing claimed aim is checked
 * again (below), then the queue is applied in order: up to and including the first PRESS (Use,
 * Attack, SwapHands, and DropCursor, which spawns an item), or INTENTS_PER_TICK others (Aim not
 * counted; an Aim directly followed by another is not even checked); the rest waits for the next
 * tick. SetViewRadius takes effect at most once every VIEW_RADIUS_INTERVAL_TICKS (the newest value
 * waits). Every press then acts on its own target and the held item of its moment, never on an Aim
 * or an inventory action that came after it. Nothing is ever dropped: a burst that arrives together
 * after a stall (retransmissions, a guest's link back after seconds) is worked off a tick at a time
 * (a lost AttackRelease would hold the button down for good). More than INTENT_QUEUE_LIMIT waiting
 * disconnects the client (receive() returns false: NetServer kicks it, protocol_error).
 *
 * THE CHECKS of a target (check()):
 *  1. the grid exists (gridById), and the part of its cell that contains the octant the client
 *     hit (`sub`) is there and has the id of the part the client saw at that octant (the target's
 *     `cell`, docs/SHAPES.md 6.2 and 6.3: a helm mined and replaced meanwhile is not clicked as
 *     cobble, a block the client never saw is not mined; another player chiselling the other part
 *     of the cell, or other octants of this one, does not matter), and that part suits the ray of
 *     the held item (sim/rays.ts rayPredicate; a bucket's world liquid source must not be all
 *     inside a hull: cellDisplaced). Read from the grid's layers and the target's fields
 *     (sim/interact.ts partAtCell, claimedPart): this runs every tick for the claimed aim and
 *     never forms or passes the packed value of a two-part cell (docs/SHAPES.md 4.4);
 *  2. reach: the eyes are those of the movement report `moveSeq` as package 2 ACCEPTED it, in the
 *     player's present epoch (moves.ts accepted(): the feet, carrier and velocity package 2 took,
 *     a seated player's seat; never a report merely received, which package 2 checks only in the
 *     coming entity step: a forged one would lend its eyes). When it is not there — not checked
 *     yet (it usually arrives with the intent), refused, dropped, lost, too old, or from before a
 *     correction — the newest accepted report of the present epoch, and without one, right after a
 *     correction, the player as the server holds it. The eyes are its feet plus the eye height,
 *     converted from its carrier's frame with the server's present poses into the target grid;
 *     from there the nearest point of the cell (the whole cell, whatever part is aimed at) is at most REACH + REACH_SLACK + min(5, (|v_rel| * viewLag + |v_own| * m) / TPS) away, where
 *     viewLag is the player's present view lag (ticks), v_rel the velocity of the target grid
 *     relative to the eyes' carrier (or the world) at the eyes, v_own the report's own velocity
 *     relative to its carrier, and m 1 when the eyes are those of the report `moveSeq` (the client
 *     aimed between two steps), else viewLag (at least the client ticks between the two reports).
 * No occlusion check (friends do not cheat each other). A target that fails is NO target: the
 * intent is carried out as if the client had aimed at nothing; no toast (the client's target may
 * just have been out of date), a count in the stats.
 *
 * THE CLAIMED AIM. Aim stores the client's use and mining targets as sent; they are checked when
 * applied (the eyes of its moveSeq) and again at the start of every later tick (the newest accepted
 * report's eyes, m = viewLag): one that fails is no target for that tick (mining and a timed glue operation
 * stop), and checked again the next. A press carries its own target, which becomes the claimed one
 * for its ray from its tick on (it is where the client aimed when it clicked).
 *
 * DEAD PLAYERS: presses, PickBlock and ReleaseHelm are consumed without effect; releases, Aim, the
 * inventory actions and Respawn work as always (the simulation lets go of both buttons at death and
 * respawn). THE ACK (intentAck, the Replicator's ClientFeed): the highest seq processed, so a batch's
 * inventory is the result of every intent up to its ack (the client's InventoryPredictor replays
 * the rest). HOST COMMANDS: only from the host's connection (NetServer join's `host`); from anyone
 * else a toast 'toast.host.only'. Kick (package 11) asks NetServer to end that guest's connection
 * with Kick('kicked') (kicks(), drained after beforeTick): never the host's own player; the
 * player leaves at the start of the next tick like any ended connection. SetCell (a debug command,
 * docs/SHAPES.md 14.1) writes a cell bypassing the interaction rules, so it is checked here
 * (setCellProblem) and refused with 'toast.host.setCell'.
 */
import { AIR, cellSecond, FULL_LIMIT, ID_MASK, PART_MASK } from '../../blocks/cell';
import { CELL_UNLOADED } from '../../blocks/defs';
import { isItem } from '../../blocks/items';
import { BLOCKS, LIQUID } from '../../blocks/registry';
import { cellProblem } from '../../blocks/shapes';
import { TPS, WORLD_HEIGHT } from '../../core/constants';
import { vec3, type Vec3 } from '../../core/math';
import type { AcceptedReport } from '../../entities/drive';
import type { Player } from '../../entities/entity';
import { claimedPart, partAtCell } from '../../sim/interact';
import { msg } from '../../sim/messages';
import type { PlayerControl } from '../../sim/players';
import { REACH, cellDisplaced, rayKindOf, rayPredicate, type RayKind } from '../../sim/rays';
import type { Simulation } from '../../sim/simulation';
import type { AimTarget, PlayerKey } from '../../sim/view';
import { HOTBAR_SLOTS, MAIN_SLOTS } from '../../entities/inventory';
import type { VoxelGrid } from '../../voxel/grid';
import { getPacked } from '../../voxel/parts';
import { boxCellsWith } from '../../structures/collect';
import { canJoinStructure } from '../../structures/stick';
import { Ship } from '../../structures/structure';
import {
  INTENT_QUEUE_LIMIT,
  INTENTS_PER_TICK,
  MAX_VIEW_RADIUS,
  REACH_SLACK,
  SIM_RADIUS_CAP,
  VIEW_RADIUS_INTERVAL_TICKS,
  type HostCommand,
  type IntentMessage,
  type Target,
} from '../protocol';
import type { Replicator } from './replicator';

/** Most extra reach (blocks) the lag allowance of check 2 gives. */
export const MAX_LAG_REACH = 5;
/** A teleport host command stays within the world's coordinate range (Pos32, NETCODE section 14). */
const MAX_TELEPORT = 4_194_303;
/** A Give host command adds at most this many items (the inventory holds no more of anything). */
const MAX_GIVE = 64 * (HOTBAR_SLOTS + MAIN_SLOTS + 1);

/** What the intents read of the movement reports (net/server/moves.ts MoveQueue): the eyes of check 2. */
export interface MoveHistory {
  /** `key`'s report `seq` as package 2 accepted it, if it is of the present epoch and still remembered; else null. */
  accepted(key: PlayerKey, seq: number): AcceptedReport | null;
  /** The newest report package 2 accepted from `key` in the present epoch, or null. */
  newest(key: PlayerKey): AcceptedReport | null;
  /** `key`'s view lag in ticks (section 4), null before a report was accepted. */
  viewLag(key: PlayerKey): number | null;
}

/** Why a target was taken as no target (check()). */
export type TargetFailure = 'grid' | 'cell' | 'ray' | 'reach';

/** What happened to one player's intents (tests, the debug panel). */
export interface IntentStats {
  received: number;
  /** Dropped on arrival: a seq seen before or not above the last processed. */
  duplicate: number;
  applied: number;
  /** Ticks that stopped at a press with more intents waiting, or at INTENTS_PER_TICK. */
  deferredTicks: number;
  /** Most intents waiting at once. */
  maxQueue: number;
  /** Targets of intents taken as no target, by reason. */
  readonly failed: Record<TargetFailure, number>;
  /** Claimed targets that failed when checked again at the start of a tick (no target for that tick), by reason. */
  readonly aimFailed: Record<TargetFailure, number>;
  /** Presses, PickBlock and ReleaseHelm of a dead player, consumed. */
  deadConsumed: number;
  /** Host commands from a guest, refused. */
  hostRefused: number;
}

class PlayerIntents {
  /** Waiting intents by seq ascending, from `head` on. */
  readonly queue: IntentMessage[] = [];
  head = 0;
  /** Highest seq processed, null before the first. */
  ack: number | null = null;
  /** The standing claimed aim as the client sent it. */
  use: Target | null = null;
  mine: Target | null = null;
  /** A SetViewRadius waiting for its turn (applyRadius), and the tick the last one took effect. */
  radius: number | null = null;
  radiusTick = -Infinity;
  readonly stats: IntentStats = {
    received: 0,
    duplicate: 0,
    applied: 0,
    deferredTicks: 0,
    maxQueue: 0,
    failed: { grid: 0, cell: 0, ray: 0, reach: 0 },
    aimFailed: { grid: 0, cell: 0, ray: 0, reach: 0 },
    deadConsumed: 0,
    hostRefused: 0,
  };
  constructor(readonly host: boolean) {}

  get waiting(): number {
    return this.queue.length - this.head;
  }
}

/** The protocol's Target as the simulation's AimTarget (`sub`: the octant hit, docs/SHAPES.md 6.3). */
function aimTarget(t: Target): AimTarget {
  return { gridId: t.gridId, x: t.x, y: t.y, z: t.z, face: t.face, sub: t.sub, cell: t.cell };
}

function heldItem(p: Player): number {
  const s = p.inventory.selectedStack();
  return s !== null && s.count > 0 ? s.item : -1;
}

export class IntentQueue {
  private readonly players = new Map<PlayerKey, PlayerIntents>();
  /** Identities a host command removed in this tick (kicks()). */
  private kicked: PlayerKey[] = [];
  // Scratch (per instance, ARCHITECTURE rule 5).
  private readonly eye: Vec3 = vec3();
  private readonly local: Vec3 = vec3();
  private readonly v1: Vec3 = vec3();
  private readonly v2: Vec3 = vec3();

  constructor(
    private readonly sim: Simulation,
    private readonly moves: MoveHistory,
    private readonly replicator: Replicator,
  ) {}

  // ------------------------------------------------------------------ IntentSink

  join(key: PlayerKey, host: boolean): void {
    this.players.set(key, new PlayerIntents(host));
  }

  leave(key: PlayerKey): void {
    this.players.delete(key);
  }

  receive(key: PlayerKey, intent: IntentMessage): boolean {
    const st = this.players.get(key);
    if (st === undefined) return true;
    st.stats.received++;
    const q = st.queue;
    const seq = intent.seq;
    if (st.ack !== null && seq <= st.ack) {
      st.stats.duplicate++;
      return true;
    }
    // In order on the reliable channel: almost always the tail.
    let i = q.length;
    while (i > st.head && q[i - 1]!.seq > seq) i--;
    if (i > st.head && q[i - 1]!.seq === seq) {
      st.stats.duplicate++;
      return true;
    }
    q.splice(i, 0, intent);
    st.stats.maxQueue = Math.max(st.stats.maxQueue, st.waiting);
    return st.waiting <= INTENT_QUEUE_LIMIT;
  }

  beforeTick(): void {
    for (const ctrl of this.sim.players.online()) {
      const st = this.players.get(ctrl.key);
      if (st === undefined) continue;
      this.recheckAim(ctrl, st);
      this.applyRadius(ctrl, st);
      this.applyQueued(ctrl, st);
    }
  }

  intentAck(key: PlayerKey): number | null {
    return this.players.get(key)?.ack ?? null;
  }

  kicks(): PlayerKey[] {
    const out = this.kicked;
    this.kicked = [];
    return out;
  }

  // ------------------------------------------------------------------ queries (tests, debug panel)

  /** What happened to `key`'s intents (this connection), or null. */
  stats(key: PlayerKey): Readonly<IntentStats> | null {
    return this.players.get(key)?.stats ?? null;
  }

  /** Intents of `key` waiting for a later tick. */
  waiting(key: PlayerKey): number {
    return this.players.get(key)?.waiting ?? 0;
  }

  /**
   * Check a target (see THE CHECKS in the header) for the ray `kind`, with the eyes of the accepted
   * report `moveSeq` of `key` (null: the newest accepted, m = viewLag). Null when it stands, else why not.
   */
  check(key: PlayerKey, t: Target, kind: RayKind, moveSeq: number | null): TargetFailure | null {
    const ctrl = this.sim.players.get(key);
    if (ctrl === undefined) return 'grid';
    const sim = this.sim;
    const grid = sim.structures.gridById(t.gridId);
    if (grid === undefined) return 'grid';
    // The part now at the claimed octant has the id of the part the client saw there; an empty
    // octant (0) passes this only against a claimed empty one, and every ray predicate rejects air.
    // A full block (or air) on both sides, every cell of a world without parts, is compared
    // directly, the part being the cell itself (air is id 0, which every ray predicate rejects):
    // what partAtCell and claimedPart would answer, without the two calls on this per-tick path.
    let part = grid.getCell(t.x, t.y, t.z);
    if (part < FULL_LIMIT && t.cell < FULL_LIMIT) {
      if (((part ^ t.cell) & ID_MASK) !== 0) return 'cell';
    } else {
      part = partAtCell(grid, t.x, t.y, t.z, t.sub);
      if ((part & ID_MASK) !== (claimedPart(t) & ID_MASK)) return 'cell';
    }
    if (!rayPredicate(kind)(part)) return 'ray';
    if (kind === 'bucket' && grid.isWorld && LIQUID[part & ID_MASK] !== 0 && cellDisplaced(sim.interaction.rayScene().ships, t.x, t.y, t.z)) return 'ray';
    // 2. Reach.
    const rec = this.eyeReport(ctrl, moveSeq);
    const found = rec !== null && moveSeq !== null && rec.seq === moveSeq;
    const viewLag = Math.max(0, this.moves.viewLag(key) ?? 0);
    const eye = this.eye;
    const carrier = this.eyes(ctrl.player, rec, eye);
    const l = grid.toLocal(eye, this.local);
    const dx = Math.max(t.x - l.x, 0, l.x - (t.x + 1));
    const dy = Math.max(t.y - l.y, 0, l.y - (t.y + 1));
    const dz = Math.max(t.z - l.z, 0, l.z - (t.z + 1));
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let vRel = 0;
    if (carrier !== grid) {
      const a = grid.velocityAt(eye, this.v1);
      const b = carrier.velocityAt(eye, this.v2);
      vRel = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    }
    const vOwn = rec === null ? 0 : Math.hypot(rec.vel.x, rec.vel.y, rec.vel.z);
    const m = found ? 1 : viewLag;
    const allowed = REACH + REACH_SLACK + Math.min(MAX_LAG_REACH, (vRel * viewLag + vOwn * m) / TPS);
    return d <= allowed ? null : 'reach';
  }

  // ------------------------------------------------------------------ the tick

  /** The standing claimed aim, checked again with the newest accepted report's eyes (THE CLAIMED AIM). */
  private recheckAim(ctrl: PlayerControl, st: PlayerIntents): void {
    if (st.use === null && st.mine === null) return;
    const use = this.checked(ctrl, st, st.use, rayKindOf(heldItem(ctrl.player)), null, true);
    const mine = this.checked(ctrl, st, st.mine, 'plain', null, true);
    ctrl.claimAim(use, mine);
  }

  private applyQueued(ctrl: PlayerControl, st: PlayerIntents): void {
    const q = st.queue;
    let counted = 0;
    while (st.head < q.length) {
      const m = q[st.head]!;
      if (m.type !== 'aim' && counted >= INTENTS_PER_TICK) {
        st.stats.deferredTicks++;
        break;
      }
      st.head++;
      if (m.type !== 'aim') counted++;
      // An Aim followed by another is overwritten before anything uses it: not checked (package 13:
      // a burst of Aims costs one check).
      const press = m.type === 'aim' && q[st.head]?.type === 'aim' ? false : this.apply(ctrl, st, m);
      st.ack = m.seq;
      st.stats.applied++;
      if (press) {
        if (st.head < q.length) st.stats.deferredTicks++;
        break;
      }
    }
    if (st.head === q.length) {
      q.length = 0;
      st.head = 0;
    } else if (st.head > 256) {
      q.splice(0, st.head);
      st.head = 0;
    }
  }

  /** Carry out one intent (section 10's table). True for a press: the tick's turn ends with it. */
  private apply(ctrl: PlayerControl, st: PlayerIntents, m: IntentMessage): boolean {
    const p = ctrl.player;
    const input = p.input;
    switch (m.type) {
      case 'aim': {
        st.use = m.use;
        st.mine = m.mine;
        ctrl.claimAim(this.checked(ctrl, st, m.use, rayKindOf(heldItem(p)), m.moveSeq, false), this.checked(ctrl, st, m.mine, 'plain', m.moveSeq, false));
        return false;
      }
      case 'use':
        if (p.dead) return this.consumed(st, true);
        this.select(p, m.slot);
        input.sneak = m.sneak;
        input.slabMode = m.slabMode;
        st.use = m.target;
        ctrl.claimUseTarget(this.checked(ctrl, st, m.target, rayKindOf(heldItem(p)), m.moveSeq, false));
        input.usePresses++;
        input.use = true;
        return true;
      case 'useRelease':
        input.use = false;
        return false;
      case 'attack':
        if (p.dead) return this.consumed(st, true);
        this.select(p, m.slot);
        st.mine = m.target;
        ctrl.claimMineTarget(this.checked(ctrl, st, m.target, 'plain', m.moveSeq, false));
        input.attackPresses++;
        input.attack = true;
        return true;
      case 'attackRelease':
        input.attack = false;
        return false;
      case 'swapHands':
        if (p.dead) return this.consumed(st, true);
        input.swapPresses++;
        return true;
      case 'selectSlot':
        this.select(p, m.slot);
        return false;
      case 'pickBlock': {
        if (p.dead) return this.consumed(st, false);
        const t = this.checked(ctrl, st, m.target, rayKindOf(heldItem(p)), m.moveSeq, false);
        if (t !== null) ctrl.pickBlock(t);
        return false;
      }
      case 'invClick':
        p.inventory.slotClick(m.area, m.index, m.button, m.shift);
        return false;
      case 'creativePick':
        if (p.mode === 'creative' && isItem(m.item)) p.inventory.creativePick(m.item, m.shift);
        return false;
      case 'dropCursor':
        // Paced like a press (package 13): one drop a tick, so creative pick + drop cannot spawn
        // items faster than clicks place blocks.
        ctrl.dropCursorStack();
        return true;
      case 'closeInventory':
        ctrl.closeInventory();
        return false;
      case 'releaseHelm':
        if (p.dead) return this.consumed(st, false);
        ctrl.releaseHelm();
        return false;
      case 'respawn':
        ctrl.respawn();
        return false;
      case 'setViewRadius':
        st.radius = Math.max(0, Math.min(MAX_VIEW_RADIUS, m.radius));
        this.applyRadius(ctrl, st);
        return false;
      case 'hostCommand':
        if (!st.host) {
          st.stats.hostRefused++;
          this.sim.events.emit({ type: 'toast', player: ctrl.key, message: msg('toast.host.only'), kind: 'warn' });
          return false;
        }
        this.hostCommand(ctrl, m.command);
        return false;
    }
  }

  /**
   * The newest SetViewRadius takes effect at most once every VIEW_RADIUS_INTERVAL_TICKS (package
   * 13): every change resubscribes columns and loads or drops the simulation's, and a client
   * flipping its radius every tick would keep the server generating and its own share of the
   * uplink full. The value waits (beforeTick tries again), the ack does not.
   */
  private applyRadius(ctrl: PlayerControl, st: PlayerIntents): void {
    const r = st.radius;
    if (r === null || this.sim.ticks - st.radiusTick < VIEW_RADIUS_INTERVAL_TICKS) return;
    st.radius = null;
    st.radiusTick = this.sim.ticks;
    this.replicator.setViewRadius(ctrl.key, r);
    ctrl.viewRadius = Math.min(r, SIM_RADIUS_CAP);
  }

  private consumed(st: PlayerIntents, press: boolean): boolean {
    st.stats.deadConsumed++;
    return press;
  }

  /** The hotbar slot (the client's selection) into the input and the inventory at once (later intents of the tick see it). */
  private select(p: Player, slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= p.inventory.hotbar.length) return;
    p.input.slot = slot;
    p.inventory.selected = slot;
  }

  /** `t` checked (check()) as the simulation's target, or null; counts the failures. */
  private checked(ctrl: PlayerControl, st: PlayerIntents, t: Target | null, kind: RayKind, moveSeq: number | null, again: boolean): AimTarget | null {
    if (t === null) return null;
    const fail = this.check(ctrl.key, t, kind, moveSeq);
    if (fail === null) return aimTarget(t);
    if (again) st.stats.aimFailed[fail]++;
    else st.stats.failed[fail]++;
    return null;
  }

  /**
   * The accepted report whose eyes check 2 takes: `moveSeq` if package 2 accepted it in the present
   * epoch; else the newest accepted in the present epoch. Null when there is none (just joined, or
   * right after a correction: the server holds the player at the corrected state).
   */
  private eyeReport(ctrl: PlayerControl, moveSeq: number | null): AcceptedReport | null {
    const r = moveSeq !== null ? this.moves.accepted(ctrl.key, moveSeq) : null;
    return r ?? this.moves.newest(ctrl.key);
  }

  /** The world point of the eyes of report `rec` (its carrier at the server's present pose); returns the grid it is carried by. */
  private eyes(p: Player, rec: AcceptedReport | null, out: Vec3): VoxelGrid {
    const sim = this.sim;
    let carrier = rec === null ? undefined : sim.structures.gridById(rec.carrierId);
    if (rec === null || carrier === undefined) {
      // No report to take, or its carrier is gone: the player as the server has it.
      carrier = p.carrierId !== 0 ? (sim.structures.gridById(p.carrierId) ?? sim.world) : sim.world;
      out.x = p.pos.x;
      out.y = p.pos.y;
      out.z = p.pos.z;
    } else {
      carrier.toWorld(rec.pos, out);
    }
    out.y += p.eyeHeight;
    return carrier;
  }

  private hostCommand(ctrl: PlayerControl, c: HostCommand): void {
    const sim = this.sim;
    switch (c.kind) {
      case 'setRules':
        sim.setRules(c.rules);
        return;
      case 'setPlayerMode': {
        const target = c.entityId === 0 ? ctrl : sim.players.online().find((o) => o.entityId === c.entityId);
        target?.setMode(c.mode);
        return;
      }
      case 'setDayTime':
        sim.setDayTime(c.t);
        return;
      case 'teleport':
        if ([c.x, c.y, c.z].every((v) => Number.isFinite(v) && Math.abs(v) <= MAX_TELEPORT)) ctrl.teleport(c.x, c.y, c.z);
        return;
      case 'give':
        if (isItem(c.item) && c.count >= 1) ctrl.giveItem(c.item, Math.min(c.count, MAX_GIVE));
        return;
      case 'kick': {
        const target = sim.players.online().find((o) => o.entityId === c.entityId);
        if (target === undefined || target.key === ctrl.key || this.players.get(target.key)?.host !== false) return;
        if (!this.kicked.includes(target.key)) this.kicked.push(target.key);
        return;
      }
      case 'setCell': {
        const grid = this.setCellTarget(c);
        if (grid === null) {
          sim.events.emit({ type: 'toast', player: ctrl.key, message: msg('toast.host.setCell'), kind: 'warn' });
          return;
        }
        // An ordinary write: the hooks run (the last cell of a structure written as air goes the way mining it would).
        grid.setCell(c.x, c.y, c.z, c.cell);
        return;
      }
    }
  }

  /**
   * The grid a SetCell may write, or null when one of the checks of docs/SHAPES.md 14.1 fails:
   *  1. the cell is valid (cellProblem) and the grid is the world or a live structure;
   *  2. neither the cell there now nor the new one is a functional block (helm, bearing,
   *     propeller): breaking a helm must release its helmsman, a bearing carries a rotor, and the
   *     command has none of those flows;
   *  3. world: 0 <= y < WORLD_HEIGHT and the column is loaded;
   *  4. structure: it is editable (not a spinning rotor); every part of a non-empty cell may
   *     join a structure (canJoinStructure: no liquid, no unbreakable block, as placing by
   *     hand refuses them); and an empty cell written non-empty stays within the assembly limits
   *     (cell count, tight box), as placing a block does; otherwise StructureGrid.setCell would
   *     grow the storage to reach any coordinate.
   */
  private setCellTarget(c: Extract<HostCommand, { kind: 'setCell' }>): VoxelGrid | null {
    const sim = this.sim;
    if (cellProblem(c.cell) !== null) return null;
    const grid = sim.structures.gridById(c.gridId);
    if (grid === undefined) return null;
    const { x, y, z } = c;
    if (grid.isWorld) {
      if (y < 0 || y >= WORLD_HEIGHT || grid.getCell(x, y, z) === CELL_UNLOADED) return null;
    }
    const now = getPacked(grid, x, y, z);
    if (isFunctionalPacked(now) || isFunctionalPacked(c.cell)) return null;
    const s = sim.structures.structureOf(grid);
    if (s !== null) {
      if (!s.editable) return null;
      if (c.cell !== AIR && !canJoinPacked(c.cell)) return null;
      if (now === AIR && c.cell !== AIR) {
        const max = s instanceof Ship ? sim.shipMaxCells : sim.rotorMaxCells;
        if (s.grid.count >= max || boxCellsWith(s.grid.cellBounds(), x, y, z) > sim.structureMaxBoxCells) return null;
      }
    }
    return grid;
  }
}

/** Every part of the (non-empty) packed cell may be part of a structure. */
function canJoinPacked(packed: number): boolean {
  const second = cellSecond(packed);
  return canJoinStructure(packed & PART_MASK) && (second === 0 || canJoinStructure(second));
}

/** A part of the packed cell is a functional block (helm, bearing, propeller: BlockDef.func). */
function isFunctionalPacked(packed: number): boolean {
  return isFunctionalPart(packed & PART_MASK) || isFunctionalPart(cellSecond(packed));
}
function isFunctionalPart(part: number): boolean {
  const id = part & ID_MASK;
  return id !== AIR && (BLOCKS[id]?.func ?? 'none') !== 'none';
}
