/**
 * The server's queue of movement reports (src/net/server/moves.ts, NETCODE section 8): order by
 * seq, stale epochs skipped without using the tick's turn, catching up, the overflow, the
 * history package 7 reads, the move ack, the view lag, and the steering timeout (section 3).
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ } from '../../src/core/dirs';
import { emptyReport, type MoveReport } from '../../src/entities/drive';
import { MOVE_HISTORY, STEER_TIMEOUT_TICKS } from '../../src/net/protocol';
import { MoveQueue, QUEUE_LIMIT } from '../../src/net/server/moves';
import type { PlayerControl } from '../../src/sim/players';
import { Simulation } from '../../src/sim/simulation';
import { FlatGenerator } from '../../src/worldgen/generator';

const TOP = 35;

/** A flat world with player 'a', client-driven, standing at (0.5, TOP, 0.5); the queue knows it. */
function world(): { sim: Simulation; q: MoveQueue; a: PlayerControl } {
  const sim = new Simulation({ seed: 3, mode: 'survival', generator: new FlatGenerator(), syncChunks: true, loadRadius: 2, rabbits: false });
  const a = sim.join('a');
  a.setDrive('client');
  a.takeCorrection();
  const q = new MoveQueue(sim);
  q.join('a');
  sim.advance(2);
  return { sim, q, a };
}

/** A standing report at x (epoch, seq). */
function report(seq: number, epoch: number, x: number, sim: Simulation): MoveReport {
  const r = emptyReport();
  r.seq = seq;
  r.epoch = epoch;
  r.viewTick = sim.ticks - 2;
  r.pos.x = x;
  r.pos.y = TOP;
  r.pos.z = 0.5;
  r.onGround = true;
  return r;
}

/** One server tick as ServerHost runs it: the queue hands over, then the simulation ticks. */
function tick(sim: Simulation, q: MoveQueue): void {
  q.beforeTick();
  sim.tick();
}

describe('the movement report queue (package 6)', () => {
  it('one report a tick in seq order; late and out-of-order ones are dropped, so the player never moves back', () => {
    const { sim, q, a } = world();
    const e = a.player.remote!.epoch;
    q.receive('a', report(1, e, 0.5, sim));
    q.receive('a', report(3, e, 0.7, sim));
    q.receive('a', report(2, e, 0.6, sim)); // arrives after 3: dropped
    q.receive('a', report(3, e, 0.9, sim)); // a duplicate: dropped
    expect(q.stats('a')!.late).toBe(2);
    tick(sim, q);
    expect(a.player.pos.x).toBe(0.5);
    expect(q.moveAck('a')).toBe(1);
    tick(sim, q);
    expect(a.player.pos.x).toBeCloseTo(0.7, 12);
    expect(q.moveAck('a')).toBe(3);
    tick(sim, q);
    expect(q.moveAck('a')).toBeNull(); // nothing accepted in this tick
    expect(q.stats('a')!.handed).toBe(2);
  });

  it('reports of an older epoch are skipped and do not use up the tick: the next valid one is handed over at once', () => {
    const { sim, q, a } = world();
    const e = a.player.remote!.epoch;
    q.receive('a', report(1, e, 0.5, sim));
    tick(sim, q);
    a.teleport(4.5, TOP, 0.5); // a correction: epoch e + 1
    a.takeCorrection();
    for (let s = 2; s <= 5; s++) q.receive('a', report(s, e, 0.5 + s * 0.05, sim)); // sent before the client adopted it
    q.receive('a', report(6, e + 1, 4.55, sim));
    tick(sim, q);
    expect(q.stats('a')!.stale).toBe(4);
    expect(a.player.pos.x).toBeCloseTo(4.55, 12);
    expect(q.moveAck('a')).toBe(6);
    expect(a.player.remote!.dropped).toBe(0); // package 2 never saw the stale ones
  });

  it('more than two waiting: two a tick until caught up; more than QUEUE_LIMIT: the oldest go', () => {
    const { sim, q, a } = world();
    const e = a.player.remote!.epoch;
    for (let s = 1; s <= 5; s++) q.receive('a', report(s, e, 0.5 + s * 0.01, sim));
    tick(sim, q); // 5 waiting: 2 handed
    expect(q.moveAck('a')).toBe(2);
    tick(sim, q); // 3 waiting: 2 handed
    expect(q.moveAck('a')).toBe(4);
    tick(sim, q); // 1 waiting: 1 handed
    expect(q.moveAck('a')).toBe(5);
    expect(q.stats('a')!.catchUps).toBe(2);
    for (let s = 6; s <= 6 + QUEUE_LIMIT + 3; s++) q.receive('a', report(s, e, 0.6, sim));
    tick(sim, q);
    expect(q.stats('a')!.overflow).toBe(4);
    expect(q.moveAck('a')).toBe(6 + 4 + 1); // the oldest 4 dropped, then two handed
    expect(a.player.remote!.rejected).toBe(0);
  });

  it('the history keeps the last MOVE_HISTORY reports received (seq, carrier, feet, sneaking); report(seq) falls back to the newest', () => {
    const { sim, q, a } = world();
    const e = a.player.remote!.epoch;
    for (let s = 1; s <= MOVE_HISTORY + 5; s++) {
      const r = report(s, e, 0.5, sim);
      r.sneaking = s % 2 === 0;
      r.pos.z = s;
      q.receive('a', r);
    }
    const h = q.history('a');
    expect(h.length).toBe(MOVE_HISTORY);
    expect(h[0]!.seq).toBe(6);
    expect(h[h.length - 1]!.seq).toBe(MOVE_HISTORY + 5);
    expect(q.report('a', 10)).toEqual({ seq: 10, carrierId: 0, pos: { x: 0.5, y: TOP, z: 10 }, sneaking: true });
    expect(q.report('a', 2)!.seq).toBe(MOVE_HISTORY + 5);
    expect(q.report('b', 2)).toBeNull();
  });

  it('the view lag is the present tick minus the viewTick of the last accepted report', () => {
    const { sim, q, a } = world();
    expect(q.viewLag('a')).toBeNull();
    const r = report(1, a.player.remote!.epoch, 0.5, sim);
    r.viewTick = sim.ticks - 6;
    q.receive('a', r);
    tick(sim, q);
    expect(q.viewLag('a')).toBe(7);
    tick(sim, q);
    expect(q.viewLag('a')).toBe(8);
  });

  it('a seated helmsman whose client sends nothing for STEER_TIMEOUT_TICKS lets go of the wheel; not before its first report', () => {
    const { sim, q, a } = world();
    // A raft with a helm on flat land does not matter for the timeout: a ship anywhere will do.
    for (let x = 3; x <= 6; x++) for (let z = 3; z <= 6; z++) sim.world.setCell(x, TOP, z, makeCell(B.PLANKS_OAK));
    sim.world.setCell(4, TOP + 1, 4, makeCell(B.HELM, facingState(NZ)));
    const res = sim.structures.assembleShip(4, TOP + 1, 4);
    if (!res.ok) throw new Error(res.reason);
    const ship = res.structure;
    expect(sim.entities.startSteering(a.player, ship, 4, TOP + 1, 4)).toBe(true);
    a.takeCorrection();
    ship.throttle = 1;
    // No report ever: the client is still loading; the helmsman keeps the wheel.
    for (let i = 0; i < STEER_TIMEOUT_TICKS + 20; i++) tick(sim, q);
    expect(a.player.steeringShipId).toBe(ship.id);
    // Reports, then silence.
    const e = a.player.remote!.epoch;
    for (let s = 1; s <= 5; s++) {
      const r = report(s, e, 0.5, sim);
      r.forward = 1;
      q.receive('a', r);
      tick(sim, q);
    }
    for (let i = 0; i < STEER_TIMEOUT_TICKS - 1; i++) tick(sim, q);
    expect(a.player.steeringShipId).toBe(ship.id);
    tick(sim, q);
    expect(a.player.steeringShipId).toBe(0);
    expect(ship.throttle).toBe(0);
    expect(a.takeCorrection()?.cause).toBe('unseat:timeout');
  });

  it('a player that left is forgotten: its reports are ignored', () => {
    const { sim, q, a } = world();
    q.leave('a');
    q.receive('a', report(1, a.player.remote!.epoch, 0.9, sim));
    tick(sim, q);
    expect(a.player.pos.x).toBe(0.5);
    expect(q.stats('a')).toBeNull();
    expect(q.moveAck('a')).toBeNull();
  });
});
