/**
 * The client's own player (src/net/client/predict.ts, OwnPlayer) through the real stack: how its
 * ticks are paced against the server's (rotorTick, section 4), the order of a client tick (poses
 * before the motion, LESSONS 每个 tick 的顺序), the display after a correction (blend, jump,
 * reload, section 9), the look, landings, a body frozen next to a column the replica lacks
 * (LESSONS 船被弹飞), a windmill on a sailing ship whose blades sweep just over the player's head
 * (LESSONS 站在行驶的船上被风车误推), a block put into the helmsman's seat (LESSONS 舵手穿过方块),
 * and reports with NaN or Infinity (LESSONS 盒子坐标是无穷大).
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NY, PZ } from '../../src/core/dirs';
import { REPORT_DEBT_TICKS } from '../../src/entities/constants';
import { BLEND_MS, RELOAD_DISTANCE } from '../../src/net/client/predict';
import { boxOverlapsSolid } from '../../src/voxel/shape';
import { fill, LINKS, useOn } from './e2e-scenes';
import { assemble, buildRaft, dist, hdist, LAND, LAND_TOP, OWN_SEA, OWN_SEA_TOP, ownWorld, startRotor } from './own-scenes';

const T = LAND_TOP;
const S = OWN_SEA_TOP;

describe('pacing: the client ticks as the server does, each meant for the server tick that applies it', () => {
  it('rotorLead converges: the client tick of a report is the server tick that accepts it (150 ms, 20 ms jitter, 5% loss); the client never runs ahead', async () => {
    const r = await ownWorld(LAND, 'creative', LINKS[1]!.make(7));
    r.mark();
    const meant = new Map<number, number>();
    r.c.onReport = (rep, own) => meant.set(rep.seq, own.tick);
    const errs: number[] = [];
    let lowestCredit = Infinity;
    r.onTick(() => {
      const d = r.ctrl.player.remote!;
      lowestCredit = Math.min(lowestCredit, d.credit);
      const ack = d.lastSeq;
      const k = meant.get(ack);
      if (k !== undefined) errs.push(k - r.sim.ticks);
      meant.delete(ack);
    });
    const ticks0 = r.sim.ticks;
    const seq0 = r.c.own!.lastSeq;
    r.c.input.forward = 1;
    r.h.run(20_000);
    const late = errs.slice(-200);
    const mean = late.reduce((a, b) => a + b, 0) / late.length;
    expect(late.length).toBeGreaterThan(150);
    expect(Math.abs(mean)).toBeLessThan(0.75);
    expect(Math.max(...late.map(Math.abs))).toBeLessThanOrEqual(2);
    // As many client ticks as server ticks, within the queue's slack; never spending the debt.
    expect(Math.abs(r.c.own!.lastSeq - seq0 - (r.sim.ticks - ticks0))).toBeLessThan(15);
    expect(lowestCredit).toBeGreaterThan(-REPORT_DEBT_TICKS);
    expect(r.causes()).toEqual([]);
  }, 60_000);
});

describe('one client tick: the poses come before the motion', () => {
  it('standing still on a raft sailing in circles for 200 client ticks: the feet do not move on the deck (150 ms)', async () => {
    const r = await ownWorld(OWN_SEA, 'survival', LINKS[1]!.make(8));
    const ship = assemble(r.sim, buildRaft(r.sim, { x0: 10, z0: 0, x1: 16, z1: 6, y: S - 1, gunwale: true, helm: { x: 13, z: 1 } }));
    r.h.run(1000);
    r.teleport(13.5, S, 4.5, 1500);
    ship.throttle = 1;
    ship.rudder = 0.6;
    r.h.run(1500);
    // The order inside a client tick: setPoses, then the structure cache reads them, then the body moves.
    const order: string[] = [];
    const own = r.c.own!;
    const replica = own.replica;
    const setPoses = replica.setPoses.bind(replica);
    replica.setPoses = (a, b) => {
      order.push('poses');
      setPoses(a, b);
    };
    const beginCarry = own.body.beginCarry.bind(own.body);
    own.body.beginCarry = () => {
      order.push('cache');
      beginCarry();
    };
    const stepPlayer = own.body.stepPlayer.bind(own.body);
    own.body.stepPlayer = (p, n, f) => {
      order.push('move');
      stepPlayer(p, n, f);
    };
    let first: { x: number; y: number; z: number } | null = null;
    let worst = 0;
    let n = 0;
    r.c.onReport = (rep) => {
      if (rep.carrierId !== ship.id) return;
      n++;
      first ??= { ...rep.pos };
      worst = Math.max(worst, dist(first, rep.pos));
    };
    r.mark();
    r.runSteps(200);
    expect(n).toBeGreaterThanOrEqual(200);
    // (The body box stays upright while the raft rolls a little: no more than scenario 31 allows.)
    expect(worst).toBeLessThan(0.01);
    // Each tick: poses, cache, move (the frame's own display poses come after, between ticks).
    const ticks = order.join(' ').split('poses cache move');
    expect(ticks.length - 1).toBeGreaterThanOrEqual(200);
    expect(order.filter((x) => x === 'move').length).toBe(order.filter((x) => x === 'cache').length);
    expect(r.causes()).toEqual([]);
  }, 60_000);
});

describe('the display after a correction (section 9)', () => {
  it('under JUMP_DISTANCE: blended in BLEND_MS (the state at once); farther: a jump; beyond RELOAD_DISTANCE: a reload until the ready zone is in', async () => {
    // (Pristine columns take 0.5 s to generate: the reload lasts that long.)
    const r = await ownWorld(LAND, 'creative', {}, undefined, 2, 500);
    const own = (): NonNullable<typeof r.c.own> => r.c.own!;
    const ctrl = r.ctrl;
    const p0 = { ...ctrl.player.pos };
    // A small one.
    ctrl.teleport(p0.x + 0.5, p0.y, p0.z);
    r.h.runUntil(() => r.c.adopted.length > 1, 2000, 1);
    const small = r.c.adopted[r.c.adopted.length - 1]!;
    expect(small.display).toBe('blend');
    expect(small.distance).toBeCloseTo(0.5, 6);
    expect(own().player.pos.x).toBeCloseTo(p0.x + 0.5, 9); // the state at once
    const shown0 = own().displayPos(r.h.net.now);
    expect(hdist(shown0, own().player.pos)).toBeGreaterThan(0.2); // the picture starts near the old place
    r.h.run(BLEND_MS + 20);
    expect(hdist(own().displayPos(r.h.net.now), own().player.pos)).toBeLessThan(1e-6);
    expect(own().cameraJumped()).toBe(false);
    // A farther one: a jump.
    ctrl.teleport(p0.x + 10.5, p0.y, p0.z);
    r.h.runUntil(() => r.c.adopted.length > 2, 2000, 1);
    expect(r.c.adopted[2]!.display).toBe('jump');
    expect(own().cameraJumped()).toBe(true);
    expect(own().cameraJumped()).toBe(false);
    expect(hdist(own().displayPos(r.h.net.now), own().player.pos)).toBeLessThan(0.3);
    // A far one: the client reloads (frozen) until the columns around the new place are in.
    ctrl.teleport(p0.x + RELOAD_DISTANCE + 60, p0.y + 5, p0.z);
    r.h.runUntil(() => r.c.adopted.length > 3, 2000, 1);
    expect(r.c.adopted[3]!.display).toBe('reload');
    expect(own().reloading).toBe(true);
    const at = { ...own().player.pos };
    let moved = 0;
    r.c.onFrame = () => {
      if (own().reloading) moved = Math.max(moved, dist(own().player.pos, at));
    };
    r.h.runUntil(() => !own().reloading, 20_000, 5);
    r.c.onFrame = null;
    expect(moved).toBe(0); // frozen meanwhile (in mid-air too)
    r.h.run(1500);
    expect(own().player.pos.y).toBeCloseTo(p0.y, 6); // then it fell to the ground
    expect(r.c.correctionsSince(0, (c) => c.startsWith('check:'))).toEqual([]);
  }, 60_000);

  it('the first correction of a connection sets the look; later ones leave the held look alone', async () => {
    const r = await ownWorld(LAND, 'survival', {});
    const ctrl = r.ctrl;
    expect(r.c.input.yaw).toBe(ctrl.player.yaw);
    r.c.input.yaw = 1.25;
    r.c.input.pitch = -0.5;
    r.h.run(200);
    ctrl.teleport(ctrl.player.pos.x + 3, T, ctrl.player.pos.z);
    r.h.run(500);
    expect(r.c.input.yaw).toBe(1.25);
    expect(r.c.input.pitch).toBe(-0.5);
    expect(ctrl.player.yaw).toBeCloseTo(Math.fround(1.25), 6); // the server took it from the reports
  }, 60_000);
});

describe('landings: the reports count every landing of the body', () => {
  it('three jumps on flat land: three landings, every report of the server agreeing with its own landing', async () => {
    const r = await ownWorld(LAND, 'survival', {});
    const l0 = r.c.own!.landings;
    r.mark((k) => (r.c.input.jump = k === 5 || k === 30 || k === 55));
    r.runSteps(90);
    expect((r.c.own!.landings - l0) & 255).toBe(3);
    expect(r.ctrl.player.remote!.landings).toBe(r.c.own!.landings);
  }, 60_000);
});

describe('LESSONS 船被弹飞: next to a column the replica does not have yet, the body is frozen, not pushed', () => {
  it('teleported onto ground the client has not generated: held where it was put until the column is in, then it walks', async () => {
    // Pristine columns take 1.5 s to generate on this client (a busy worker pool).
    const r = await ownWorld(LAND, 'survival', {}, undefined, 2, 1500);
    r.c.input.forward = 1;
    // Within RELOAD_DISTANCE but outside the subscription circle of radius 2: column (2, 2).
    const to = { x: 32.5, y: T, z: 32.5 };
    r.ctrl.teleport(to.x, to.y, to.z);
    r.h.runUntil(() => r.c.adopted.length > 1, 3000, 1);
    const own = r.c.own!;
    expect(own.replica.world.isLoaded(Math.floor(to.x), Math.floor(to.z))).toBe(false);
    r.h.run(500);
    expect(dist(own.player.pos, to)).toBeLessThan(1e-9);
    r.h.runUntil(() => own.replica.world.isLoaded(Math.floor(to.x), Math.floor(to.z)), 10_000, 5);
    r.h.run(1000);
    expect(hdist(own.player.pos, to)).toBeGreaterThan(1);
    expect(r.c.correctionsSince(0, (c) => c.startsWith('check:') || c === 'fall')).toEqual([]);
  }, 60_000);
});

describe('LESSONS 站在行驶的船上被风车误推: a windmill on a sailing raft sweeps just over the head of a player standing under it', () => {
  it('150 ms: no crush, no check correction, no damage (the client poses the blades at rotorTick)', async () => {
    const r = await ownWorld(OWN_SEA, 'survival', LINKS[1]!.make(9));
    const sim = r.sim;
    const helm = buildRaft(sim, { x0: 10, z0: 0, x1: 16, z1: 9, y: S - 1, gunwale: true, helm: { x: 13, z: 1 } });
    // A mast with a bearing on its south side (facing south) and a cross of felt arms 3 long on
    // the hub: the lowest tip passes about 0.15 above the head of a player standing under the hub.
    fill(sim, 13, S, 5, 13, S + 5, 5, B.PLANKS_OAK);
    sim.worldGlue.add(13, S, 5, NY);
    sim.world.setCell(13, S + 5, 6, makeCell(B.BEARING, facingState(PZ)));
    sim.world.setCell(13, S + 5, 7, makeCell(B.WOOL_YELLOW));
    for (let a = 1; a <= 3; a++) {
      sim.world.setCell(13 + a, S + 5, 7, makeCell(B.WOOL_WHITE));
      sim.world.setCell(13 - a, S + 5, 7, makeCell(B.WOOL_WHITE));
      sim.world.setCell(13, S + 5 + a, 7, makeCell(B.WOOL_WHITE));
      sim.world.setCell(13, S + 5 - a, 7, makeCell(B.WOOL_WHITE));
    }
    sim.worldGlue.add(13, S + 5, 6, PZ);
    const ship = assemble(sim, helm);
    const started = sim.structures.startRotor(ship.grid, 13, S + 5, 6);
    if (!started.ok) throw new Error(started.reason);
    r.h.run(2000);
    r.teleport(13.5, S, 7.5, 1500);
    const hurts: string[] = [];
    sim.events.on((e) => {
      if (e.type === 'playerHurt') hurts.push(e.cause);
    });
    const p = r.ctrl.player;
    expect(p.carrierId).toBe(ship.id);
    ship.throttle = 1;
    ship.rudder = 0.3;
    r.mark();
    r.h.run(20_000);
    expect(r.causes()).toEqual([]);
    expect(hurts).toEqual([]);
    expect(p.remote!.squeezeCandidateTicks).toBe(0);
    expect(p.carrierId).toBe(ship.id);
  }, 60_000);
});

describe('LESSONS 舵手穿过方块: a block put into the helmsman\'s seat', () => {
  it('the server lets go of the wheel with a correction, and moves the player out of the block; the client ends up out of it too (150 ms)', async () => {
    const r = await ownWorld(OWN_SEA, 'survival', LINKS[1]!.make(10));
    const sim = r.sim;
    const helm = buildRaft(sim, { x0: 10, z0: 0, x1: 16, z1: 8, y: S - 1, gunwale: true, helm: { x: 13, z: 1 } });
    const c = r.ctrl;
    c.teleport(13.5, S, 3.5);
    r.h.run(1000);
    c.emptyHand();
    useOn(r.h, c, helm.x, helm.y, helm.z);
    useOn(r.h, c, helm.x, helm.y, helm.z);
    const ship = sim.structures.ships()[0]!;
    expect(c.player.steeringShipId).toBe(ship.id);
    r.h.run(1000);
    r.mark();
    // A world block appears where the seat is (the raft lies still).
    const seat = ship.grid.toWorld(c.player.seat);
    sim.world.setCell(Math.floor(seat.x), Math.floor(seat.y + 0.5), Math.floor(seat.z), makeCell(B.STONE));
    r.h.run(3000);
    expect(c.player.steeringShipId).toBe(0);
    expect(r.causes()[0]).toBe('unseat:blocked');
    expect(boxOverlapsSolid(sim.world, c.player.box())).toBe(false);
    expect(boxOverlapsSolid(r.c.own!.replica.world, r.c.own!.player.box())).toBe(false);
    expect(r.causes().filter((x) => x.startsWith('check:'))).toEqual([]);
  }, 60_000);
});

describe('LESSONS 盒子坐标是无穷大: reports with NaN or Infinity', () => {
  it('are refused with a correction; the server keeps ticking and the player stays where it was', async () => {
    const r = await ownWorld(LAND, 'survival', {});
    r.c.silent = true;
    r.h.run(500);
    const p = r.ctrl.player;
    const at = { ...p.pos };
    const own = r.c.own!;
    const epoch = p.remote!.epoch;
    let seq = own.lastSeq;
    for (const bad of [NaN, Infinity, -Infinity]) {
      seq++;
      r.c.net.sendMoveReport({ seq, epoch, viewTick: r.sim.ticks - 2, carrierId: 0, pos: { x: bad, y: T, z: 0.5 }, vel: { x: 0, y: bad, z: 0 }, yaw: 0, pitch: 0, onGround: true, sneaking: false, sprinting: false, flying: false, forward: 0, strafe: 0, sneak: false, landings: 0 });
      const t = r.sim.ticks;
      r.h.runUntil(() => r.sim.ticks > t + 1, 2000, 1);
    }
    expect(r.c.correctionsSince(0, (c) => c === 'check:garbage').length).toBeGreaterThanOrEqual(1);
    expect(dist(p.pos, at)).toBe(0);
    expect(Number.isFinite(p.pos.x)).toBe(true);
    const t = r.sim.ticks;
    r.h.run(1000);
    expect(r.sim.ticks).toBeGreaterThan(t + 15);
  }, 60_000);
});
