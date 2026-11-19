/**
 * Movement reports on the server (docs/NETCODE.md section 8 "远程玩家的位置来源", sections 3, 9):
 * MoveQueue, NetServer's MoveSink.
 *
 * Reports arrive with jitter (two in one tick, none in the next); handed to the simulation as
 * they come, the player would move in fits and starts for everyone else. So every player has a
 * queue, and every tick hands the simulation (package 2: PlayerControl.submitReport, checked and
 * applied in the entity step) one report:
 *  - receive: a report whose seq is not above every seq received so far is dropped (late, out of
 *    order); the rest go to the tail, so the queue is ordered by seq and the player never moves back;
 *  - beforeTick: reports of an epoch that is not the player's present one (sent before the client
 *    adopted the last correction) are dropped first and do not use up the tick's turn; then more
 *    than QUEUE_LIMIT waiting lose the oldest; then one is handed over, two while more than
 *    QUEUE_CATCH_UP wait (catching up). Package 2 checks epoch and seq again.
 * The cost is about one tick more of delay for the player on the server (the client's rotorLead
 * measures it, net/client/clock.ts). Reports lost or dropped never merge two falls: package 2
 * counts the client's landings (entities/drive.ts LANDINGS).
 *
 * For package 7 (section 10, check 2), the reports package 2 ACCEPTED, as it took them: accepted()
 * and newest() read the history package 2 records at acceptance (entities/drive.ts ACCEPTED
 * REPORTS). Never a report merely received here: it is not checked until the tick's entity step,
 * and a forged one would lend its eyes to an intent applied before that.
 *
 * Also kept per player:
 *  - its view lag (section 4: viewLag(), the ticks between the server's present tick and the
 *    viewTick of the last report package 2 accepted);
 *  - moveAck: the seq of the last report package 2 accepted in the tick (the Replicator's ClientFeed);
 *  - the steering timeout (section 3): a seated, client-driven helmsman whose client sent no
 *    report for STEER_TIMEOUT_TICKS ticks lets go of the wheel (cause 'timeout'), so a ship does
 *    not sail on for a page that went to the background or froze. The count starts at the
 *    client's first report: until then it is loading (section 3, ready), and the server holds the
 *    player where it is (a host who joins a loaded world at the wheel keeps it). The host's own
 *    page is exempt while the room is closed: in single player a page that stalls for a few
 *    seconds (a long frame, a garbage collection) would otherwise lose the wheel, and a hidden
 *    page pauses the world anyway. With the room open the rule holds for the host too.
 */
import { copyReport, emptyReport, type AcceptedReport, type MoveReport } from '../../entities/drive';
import type { Simulation } from '../../sim/simulation';
import type { PlayerKey } from '../../sim/view';
import { STEER_TIMEOUT_TICKS, type NetMoveReport } from '../protocol';

/** Two reports are handed over in a tick while more than this many wait. */
export const QUEUE_CATCH_UP = 2;
/** More than this many waiting: the oldest are dropped. */
export const QUEUE_LIMIT = 10;

/** What happened to one player's reports (tests, the debug panel). */
export interface MoveStats {
  received: number;
  /** Dropped on arrival: not newer than one received before. */
  late: number;
  /** Dropped before the hand-over: an epoch that was not the present one. */
  stale: number;
  /** Dropped because more than QUEUE_LIMIT waited. */
  overflow: number;
  /** Handed to the simulation. */
  handed: number;
  /** Ticks in which two were handed over. */
  catchUps: number;
}

class PlayerMoves {
  /** The host's own page (netserver: a local connection). */
  constructor(readonly local: boolean) {}
  readonly queue: MoveReport[] = [];
  readonly spare: MoveReport[] = [];
  /** Highest seq received. */
  newest = -Infinity;
  /** A report arrived since the last beforeTick. */
  heard = false;
  /** Ticks since the last report arrived; null before the first. */
  silent: number | null = null;
  /** Package 2's last accepted seq when this tick began (moveAck: what it accepted in the tick). */
  ackBefore = -Infinity;
  readonly stats: MoveStats = { received: 0, late: 0, stale: 0, overflow: 0, handed: 0, catchUps: 0 };
}

export class MoveQueue {
  private readonly players = new Map<PlayerKey, PlayerMoves>();

  constructor(private readonly sim: Simulation) {}

  // ------------------------------------------------------------------ MoveSink

  join(key: PlayerKey, local: boolean): void {
    this.players.set(key, new PlayerMoves(local));
  }

  leave(key: PlayerKey): void {
    this.players.delete(key);
  }

  receive(key: PlayerKey, report: NetMoveReport): void {
    const m = this.players.get(key);
    if (m === undefined) return;
    m.heard = true;
    m.stats.received++;
    if (!(report.seq > m.newest)) {
      m.stats.late++;
      return;
    }
    m.newest = report.seq;
    m.queue.push(copyReport(report, m.spare.pop() ?? emptyReport()));
  }

  beforeTick(roomOpen: boolean): void {
    for (const [key, m] of this.players) {
      const ctrl = this.sim.players.get(key);
      if (ctrl === undefined) continue;
      const p = ctrl.player;
      const d = p.remote;
      if (m.heard) m.silent = 0;
      else if (m.silent !== null) m.silent++;
      m.heard = false;
      m.ackBefore = d !== null ? d.lastSeq : -Infinity;
      // Section 3: the helmsman's client went quiet.
      const timed = roomOpen || !m.local;
      if (timed && d !== null && p.steeringShipId !== 0 && m.silent !== null && m.silent >= STEER_TIMEOUT_TICKS) this.sim.entities.stopSteering(p, 'timeout');
      const q = m.queue;
      const epoch = d !== null ? d.epoch : NaN;
      let drop = 0;
      while (drop < q.length && q[drop]!.epoch !== epoch) drop++;
      m.stats.stale += drop;
      if (q.length - drop > QUEUE_LIMIT) {
        m.stats.overflow += q.length - drop - QUEUE_LIMIT;
        drop = q.length - QUEUE_LIMIT;
      }
      for (let i = 0; i < drop; i++) m.spare.push(q[i]!);
      if (drop > 0) q.splice(0, drop);
      const n = q.length > QUEUE_CATCH_UP ? 2 : Math.min(1, q.length);
      if (n === 2) m.stats.catchUps++;
      for (let i = 0; i < n; i++) {
        const r = q.shift()!;
        ctrl.submitReport(r);
        m.spare.push(r);
        m.stats.handed++;
      }
    }
  }

  /** The seq of the last report package 2 accepted in this tick for `key`, or null when it accepted none (ClientFeed.moveAck). */
  moveAck(key: PlayerKey): number | null {
    const m = this.players.get(key);
    const d = this.sim.players.get(key)?.player.remote ?? null;
    if (m === undefined || d === null || !(d.lastSeq > m.ackBefore)) return null;
    return d.lastSeq;
  }

  // ------------------------------------------------------------------ for package 7 and tests

  /** `key`'s report `seq` as package 2 accepted it, if it is of the present epoch and still remembered; else null (ClientDrive.acceptedReport). */
  accepted(key: PlayerKey, seq: number): AcceptedReport | null {
    return this.sim.players.get(key)?.player.remote?.acceptedReport(seq) ?? null;
  }

  /** The newest report package 2 accepted from `key` in the present epoch, or null: none since the last correction (ClientDrive.lastAccepted). */
  newest(key: PlayerKey): AcceptedReport | null {
    return this.sim.players.get(key)?.player.remote?.lastAccepted() ?? null;
  }

  /** `key`'s view lag in ticks (section 4: present tick - viewTick of the last accepted report), null before one was accepted. */
  viewLag(key: PlayerKey): number | null {
    const d = this.sim.players.get(key)?.player.remote ?? null;
    return d === null || d.viewTick < 0 ? null : this.sim.ticks - d.viewTick;
  }

  /** What happened to `key`'s reports so far (this connection), or null. */
  stats(key: PlayerKey): Readonly<MoveStats> | null {
    return this.players.get(key)?.stats ?? null;
  }
}
