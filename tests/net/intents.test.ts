/**
 * The server's intents (src/net/server/intents.ts, NETCODE section 10), on a Simulation with the
 * real MoveQueue and Replicator, ticked as ServerHost ticks: the queue by seq and the pacing (up to
 * the first press or INTENTS_PER_TICK others, Aim not counted), the queue limit, the two checks (the
 * cell the client saw; the reach from the eyes of the referenced report, with the lag allowance),
 * the claimed aim checked again every tick, dead players, the ack, host commands.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { quadrantOctant } from '../../src/blocks/shapes';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NZ, PY, type Dir } from '../../src/core/dirs';
import { emptyReport, type MoveReport } from '../../src/entities/drive';
import { INTENT_QUEUE_LIMIT, INTENTS_PER_TICK, REACH_SLACK, type IntentMessage, type Target } from '../../src/net/protocol';
import { IntentQueue, MAX_LAG_REACH } from '../../src/net/server/intents';
import { MoveQueue } from '../../src/net/server/moves';
import { Replicator } from '../../src/net/server/replicator';
import { REACH } from '../../src/sim/rays';
import type { PlayerControl } from '../../src/sim/players';
import { Simulation } from '../../src/sim/simulation';
import type { SimEvent } from '../../src/sim/view';
import { FlatGenerator } from '../../src/worldgen/generator';

const TOP = 35;

interface World {
  sim: Simulation;
  moves: MoveQueue;
  q: IntentQueue;
  a: PlayerControl;
  events: SimEvent[];
  /** Movement reports sent so far (seq). */
  seq: number;
}

/** A flat world (creative), player 'a' client-driven at (0.5, TOP, 0.5); the queues know it. */
function world(host = true, mode: 'creative' | 'survival' = 'creative'): World {
  const sim = new Simulation({ seed: 3, mode, generator: new FlatGenerator(), syncChunks: true, loadRadius: 2, rabbits: false });
  const a = sim.join('a');
  a.setDrive('client');
  a.takeCorrection();
  const moves = new MoveQueue(sim);
  const q = new IntentQueue(sim, moves, new Replicator(sim));
  moves.join('a', host);
  q.join('a', host);
  const events: SimEvent[] = [];
  sim.events.on((e) => events.push(e));
  const w: World = { sim, moves, q, a, events, seq: 0 };
  report(w, 0.5, 0.5);
  tick(w);
  return w;
}

/** A movement report standing at (x, TOP, z) with velocity (vx, 0, 0), of `epoch` (default: the present one). */
function report(w: World, x: number, z: number, vx = 0, epoch = w.a.player.remote!.epoch): MoveReport {
  const r = emptyReport();
  r.seq = ++w.seq;
  r.epoch = epoch;
  r.viewTick = w.sim.ticks;
  r.pos.x = x;
  r.pos.y = TOP;
  r.pos.z = z;
  r.vel.x = vx;
  r.onGround = true;
  w.moves.receive('a', r);
  return r;
}

/** One server tick as ServerHost runs it. */
function tick(w: World, n = 1): void {
  for (let i = 0; i < n; i++) {
    w.moves.beforeTick(false);
    w.q.beforeTick();
    w.sim.tick();
  }
}

/** The target a client sends for face `face` of a world cell: the octant hit lies behind that face (docs/SHAPES.md 6.3). */
function target(w: World, x: number, y: number, z: number, face: Dir = PY): Target {
  return { gridId: 0, x, y, z, face, sub: quadrantOctant(face, 0), cell: w.sim.world.getCell(x, y, z) };
}

let intentSeq = 0;
/** An intent without its seq (send() numbers it unless it carries one). */
type Unseq<M> = M extends unknown ? Omit<M, 'seq'> & { seq?: number } : never;
function send(w: World, m: Unseq<IntentMessage>): boolean {
  return w.q.receive('a', { ...m, seq: m.seq ?? ++intentSeq } as IntentMessage);
}

describe('the server\'s intents (package 7)', () => {
  it('a click: Use with its target writes the slot, the sneak key and the press; the block is placed; the ack follows', () => {
    const w = world();
    const { sim, a } = w;
    a.player.inventory.hotbar[3] = { item: B.PLANKS_OAK, count: 64 };
    const s0 = ++intentSeq;
    send(w, { type: 'use', seq: s0, moveSeq: w.seq, slot: 3, sneak: false, slabMode: 0, target: target(w, 2, TOP - 1, 0) });
    send(w, { type: 'useRelease', seq: s0 + 1 });
    intentSeq = s0 + 1;
    tick(w);
    expect(sim.world.getCell(2, TOP, 0) & 1023).toBe(B.PLANKS_OAK);
    expect(a.player.inventory.selected).toBe(3);
    expect(w.q.intentAck('a')).toBe(s0); // stopped at the press
    expect(a.player.input.use).toBe(true);
    tick(w);
    expect(w.q.intentAck('a')).toBe(s0 + 1);
    expect(a.player.input.use).toBe(false);
  });

  it('pacing: up to and including the first press, or INTENTS_PER_TICK others (Aim not counted); nothing is dropped', () => {
    const w = world();
    const start = intentSeq;
    // 20 slot selections, an aim between them, then a press, then 3 more.
    for (let i = 0; i < 20; i++) send(w, { type: 'selectSlot', slot: i % 9 });
    for (let i = 0; i < 5; i++) send(w, { type: 'aim', moveSeq: w.seq, use: null, mine: null });
    send(w, { type: 'swapHands' });
    send(w, { type: 'swapHands' });
    send(w, { type: 'selectSlot', slot: 4 });
    tick(w);
    expect(w.q.intentAck('a')).toBe(start + INTENTS_PER_TICK);
    tick(w);
    // The other 4 selections, the 5 aims (free) and the first press.
    expect(w.q.intentAck('a')).toBe(start + 20 + 5 + 1);
    tick(w);
    expect(w.q.intentAck('a')).toBe(start + 20 + 5 + 2); // one press a tick
    tick(w);
    expect(w.q.intentAck('a')).toBe(start + 20 + 5 + 3);
    expect(w.q.waiting('a')).toBe(0);
    expect(w.a.player.inventory.selected).toBe(4);
  });

  it('seq order: duplicates and old seqs are dropped; one arriving early waits in its place', () => {
    const w = world();
    const s = intentSeq;
    send(w, { type: 'selectSlot', slot: 1, seq: s + 2 });
    send(w, { type: 'selectSlot', slot: 5, seq: s + 1 });
    send(w, { type: 'selectSlot', slot: 1, seq: s + 2 }); // duplicate
    intentSeq = s + 2;
    tick(w);
    expect(w.a.player.inventory.selected).toBe(1); // 5 then 1
    send(w, { type: 'selectSlot', slot: 7, seq: s + 1 }); // old
    tick(w);
    expect(w.a.player.inventory.selected).toBe(1);
    expect(w.q.stats('a')!.duplicate).toBe(2);
  });

  it('the queue limit: more than INTENT_QUEUE_LIMIT waiting refuses (the connection is kicked)', () => {
    const w = world();
    for (let i = 0; i < INTENT_QUEUE_LIMIT; i++) expect(send(w, { type: 'swapHands' })).toBe(true);
    expect(send(w, { type: 'swapHands' })).toBe(false);
  });

  it('check 1: the grid, the cell the client saw, the held item\'s ray', () => {
    const w = world();
    const { sim, q } = w;
    sim.world.setCell(2, TOP, 0, makeCell(B.HELM, facingState(NZ)));
    const t = target(w, 2, TOP, 0);
    expect(q.check('a', t, 'plain', w.seq)).toBeNull();
    expect(q.check('a', { ...t, gridId: 99 }, 'plain', w.seq)).toBe('grid');
    sim.world.setCell(2, TOP, 0, makeCell(B.COBBLE));
    expect(q.check('a', t, 'plain', w.seq)).toBe('cell');
    sim.world.setCell(2, TOP, 0, makeCell(B.TORCH));
    expect(q.check('a', target(w, 2, TOP, 0), 'plain', w.seq)).toBeNull();
    expect(q.check('a', target(w, 2, TOP, 0), 'glue', w.seq)).toBe('ray'); // soft: the glue ray passes it
    expect(q.check('a', target(w, 2, TOP + 1, 0), 'plain', w.seq)).toBe('ray'); // air
  });

  it('check 2: the reach from the referenced report\'s eyes, with REACH_SLACK and the lag allowance', () => {
    const w = world();
    const { sim, q } = w;
    // The eyes at (0.5, TOP + 1.62, 0.5); a block whose nearest point is exactly REACH + REACH_SLACK away along x.
    const far = REACH + REACH_SLACK;
    const x = Math.ceil(0.5 + far); // its near face at x
    for (const bx of [x - 1, x, x + 1]) sim.world.setCell(bx, TOP + 1, 0, makeCell(B.STONE));
    const dx = (bx: number): number => bx - 0.5;
    const ok = (bx: number): boolean => dx(bx) <= far;
    const seq = w.seq;
    for (const bx of [x - 1, x, x + 1]) expect(q.check('a', target(w, bx, TOP + 1, 0), 'plain', seq) === null, `x ${bx}`).toBe(ok(bx));
    // A report moving at 10 blocks/s: one tick of it more (m = 1, the report was found)...
    const moving = report(w, 0.5, 0.5, 10);
    tick(w); // accepted: viewLag = 1 tick
    const lag = w.moves.viewLag('a')!;
    expect(lag).toBe(1);
    const allow = far + Math.min(MAX_LAG_REACH, (10 * 1) / 20);
    for (let bx = x - 1; bx <= x + 2; bx++) sim.world.setCell(bx, TOP + 1, 0, makeCell(B.STONE));
    for (let bx = x - 1; bx <= x + 2; bx++) expect(q.check('a', target(w, bx, TOP + 1, 0), 'plain', moving.seq) === null, `moving x ${bx}`).toBe(dx(bx) <= allow);
    // ... and a report no longer in the history: the newest instead, m = viewLag.
    expect(q.check('a', target(w, x, TOP + 1, 0), 'plain', 123456) === null).toBe(dx(x) <= far + Math.min(MAX_LAG_REACH, (10 * lag) / 20));
  });

  it('a press whose moveSeq still names a report from before a correction is checked from where the correction put the player', () => {
    const w = world();
    const { sim, a } = w;
    const before = report(w, 0.5, 0.5);
    tick(w);
    expect(w.moves.accepted('a', before.seq)).not.toBeNull();
    // Teleported; the client adopted the correction and clicks before its next report (moveSeq is the old one).
    a.teleport(20.5, TOP, 0.5);
    a.takeCorrection();
    sim.world.setCell(22, TOP, 0, makeCell(B.STONE));
    sim.world.setCell(2, TOP, 0, makeCell(B.STONE));
    expect(w.moves.accepted('a', before.seq)).toBeNull();
    expect(w.q.check('a', target(w, 22, TOP, 0), 'plain', before.seq)).toBeNull();
    expect(w.q.check('a', target(w, 2, TOP, 0), 'plain', before.seq)).toBe('reach');
    send(w, { type: 'attack', moveSeq: before.seq, slot: 0, target: target(w, 22, TOP, 0) });
    send(w, { type: 'attackRelease' });
    tick(w, 2);
    expect(sim.world.getCell(22, TOP, 0) & 1023).toBe(B.AIR);
  });

  it('a target whose cell changed before the intent arrived is no target: the Use with planks places nothing', () => {
    const w = world();
    const { sim, a } = w;
    sim.world.setCell(2, TOP, 0, makeCell(B.HELM, facingState(NZ)));
    a.player.inventory.hotbar[0] = { item: B.PLANKS_OAK, count: 64 };
    const t = target(w, 2, TOP, 0);
    sim.world.setCell(2, TOP, 0, makeCell(B.COBBLE)); // replaced on the server meanwhile
    send(w, { type: 'use', moveSeq: w.seq, slot: 0, sneak: false, slabMode: 0, target: t });
    tick(w);
    expect(sim.world.getCell(2, TOP + 1, 0) & 1023).toBe(B.AIR);
    expect(a.view.preview).toBeNull();
    expect(w.q.stats('a')!.failed.cell).toBe(1);
  });

  it('the claimed aim is checked again every tick: out of reach it is no target (mining stops), back in reach it stands again', () => {
    const w = world(true, 'survival');
    const { sim, a } = w;
    sim.world.setCell(3, TOP, 0, makeCell(B.STONE));
    const t = target(w, 3, TOP, 0);
    send(w, { type: 'aim', moveSeq: w.seq, use: t, mine: t });
    send(w, { type: 'attack', moveSeq: w.seq, slot: 0, target: t });
    tick(w, 5);
    expect(a.view.mining?.progress).toBeCloseTo(5 / 30, 5);
    // Teleported far away (a correction: no accepted report of the new epoch yet, so the eyes are
    // the player's as the server holds it): the claim fails the reach.
    a.teleport(20.5, TOP, 0.5);
    tick(w);
    expect(a.mineTargetCell()).toBeNull();
    expect(a.view.mining).toBeNull();
    expect(w.q.stats('a')!.aimFailed.reach).toBeGreaterThan(0);
    a.teleport(0.5, TOP, 0.5);
    tick(w);
    expect(a.mineTargetCell()).toMatchObject({ x: 3 });
    // The client's next report, of the new epoch, accepted: its eyes from then on.
    report(w, 0.5, 0.5);
    tick(w, 2);
    expect(w.moves.newest('a')!.seq).toBe(w.seq);
    expect(a.mineTargetCell()).toMatchObject({ x: 3 });
  });

  it('the eyes are only ever those of a report package 2 accepted: a forged report far away lends none (it is refused in the entity step after the intent)', () => {
    const w = world(true, 'creative');
    const { sim, a } = w;
    const near = report(w, 0.5, 0.5);
    tick(w);
    expect(w.moves.accepted('a', near.seq)).not.toBeNull();
    sim.world.setCell(20, TOP, 22, makeCell(B.BRICKS));
    const t = target(w, 20, TOP, 22);
    // A stale epoch (never handed to package 2), then the present one (refused by package 2 in the entity step).
    for (const present of [false, true]) {
      const forged = report(w, 20.5, 20.5, 0, present ? a.player.remote!.epoch : 0);
      const failed = w.q.stats('a')!.failed.reach;
      send(w, { type: 'attack', moveSeq: forged.seq, slot: 0, target: t });
      send(w, { type: 'attackRelease' });
      expect(w.q.check('a', t, 'plain', forged.seq)).toBe('reach');
      tick(w, 2);
      expect(w.q.stats('a')!.failed.reach).toBe(failed + 1);
      expect(sim.world.getCell(20, TOP, 22) & 1023).toBe(B.BRICKS);
      expect(w.moves.accepted('a', forged.seq)).toBeNull();
      expect(a.player.pos.x).toBeLessThan(2);
      if (!present) {
        expect(w.moves.stats('a')!.stale).toBe(1);
        continue;
      }
      // The server refused the report: a correction; the client adopts it and reports from there.
      const c = a.takeCorrection();
      expect(c?.cause).toBe('check:speed');
      report(w, c!.pos.x, c!.pos.z);
      tick(w);
      expect(w.moves.newest('a')!.seq).toBe(w.seq);
    }
  });

  it('dead players: presses, PickBlock and ReleaseHelm are consumed; releases, inventory actions and Respawn work; death lets go of the buttons', () => {
    const w = world(true, 'survival');
    const { sim, a } = w;
    a.player.inventory.hotbar[0] = { item: B.DIRT, count: 5 };
    a.player.input.attack = true;
    sim.entities.kill(a.player, 'test');
    expect(a.player.input.attack).toBe(false);
    const before = a.player.inventory.hotbar[0];
    send(w, { type: 'swapHands' });
    send(w, { type: 'attack', moveSeq: w.seq, slot: 0, target: null });
    send(w, { type: 'releaseHelm' });
    send(w, { type: 'invClick', area: 'hotbar', index: 0, button: 0, shift: false });
    tick(w, 3);
    expect(a.player.inventory.offhand).toBeNull(); // no swap
    expect(a.player.inventory.cursor).toEqual(before); // the click worked
    expect(a.player.input.attack).toBe(false);
    expect(w.q.stats('a')!.deadConsumed).toBe(3);
    send(w, { type: 'respawn' });
    tick(w);
    expect(a.player.dead).toBe(false);
  });

  it('host commands from the host\'s connection (NaN, Infinity and unknown items ignored: LESSONS 盒子坐标是无穷大); from a guest only a toast', () => {
    const w = world(true);
    const { sim, a } = w;
    send(w, { type: 'hostCommand', command: { kind: 'setRules', rules: { defaultMode: 'survival', dropsEnabled: true } } });
    send(w, { type: 'hostCommand', command: { kind: 'setPlayerMode', entityId: 0, mode: 'survival' } });
    send(w, { type: 'hostCommand', command: { kind: 'setDayTime', t: 0.5 } });
    send(w, { type: 'hostCommand', command: { kind: 'give', item: I.GLUE, count: 3 } });
    send(w, { type: 'hostCommand', command: { kind: 'teleport', x: 5.5, y: TOP, z: 5.5 } });
    send(w, { type: 'hostCommand', command: { kind: 'teleport', x: Number.NaN, y: TOP, z: 5.5 } });
    send(w, { type: 'hostCommand', command: { kind: 'teleport', x: 1, y: Number.POSITIVE_INFINITY, z: 5.5 } });
    send(w, { type: 'hostCommand', command: { kind: 'setDayTime', t: Number.NaN } });
    send(w, { type: 'hostCommand', command: { kind: 'give', item: 99999, count: 3 } });
    tick(w);
    expect(sim.rules).toEqual({ defaultMode: 'survival', dropsEnabled: true });
    expect(a.player.mode).toBe('survival');
    expect(sim.dayTime).toBeCloseTo(0.5, 2);
    expect(a.player.inventory.count(I.GLUE)).toBe(3);
    expect(a.player.pos).toMatchObject({ x: 5.5, z: 5.5 });
    // A guest.
    const g = world(false);
    g.events.length = 0;
    g.q.receive('a', { type: 'hostCommand', seq: ++intentSeq, command: { kind: 'setPlayerMode', entityId: 0, mode: 'survival' } });
    tick(g);
    expect(g.a.player.mode).toBe('creative');
    expect(g.events.filter((e) => e.type === 'toast').map((e) => (e as { message: { key: string } }).message.key)).toEqual(['toast.host.only']);
    expect(g.q.stats('a')!.hostRefused).toBe(1);
  });
});
