/**
 * End to end (package 6): the prediction and the server agree. On a perfect link a HeadlessClient
 * plays a long random input script; for every report the server accepts, the server's state of the
 * player after applying it equals the client's predicted state that the report came from, exactly:
 * the carrier, the feet in the carrier's frame, the velocity relative to it, the look, standing,
 * flying, sneaking and sprinting (velocity and look as the wire carries them, f32), and with no
 * carrier the world position too. On flat land with steps and walls, swimming at sea, and on the
 * deck of a raft sailing in circles. Nothing is ever corrected or refused.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { Rng } from '../../src/core/rng';
import type { MoveReport } from '../../src/entities/drive';
import { fill } from './e2e-scenes';
import { assemble, buildRaft, LAND, LAND_TOP, OWN_SEA, OWN_SEA_TOP, ownWorld, SEA_FLOOR, stat, type OwnRun } from './own-scenes';

interface Predicted {
  rep: MoveReport;
  world: { x: number; y: number; z: number };
  carrierId: number;
}

/** Random held input, changed every 4..30 client ticks. */
function randomScript(r: OwnRun, seed: number, swim: boolean): (k: number) => void {
  const rng = new Rng(seed);
  let next = 0;
  return (k) => {
    if (k < next) return;
    next = k + rng.int(4, 30);
    const i = r.c.input;
    i.forward = rng.int(-1, 1);
    i.strafe = rng.int(-1, 1);
    i.jump = rng.next() < (swim ? 0.5 : 0.25);
    i.sneak = rng.next() < (swim ? 0.3 : 0.15);
    i.sprint = rng.next() < 0.3;
    i.yaw += rng.range(-1.2, 1.2);
    i.pitch = rng.range(-1.2, 1.2);
  };
}

/** Record the predicted state behind every report, and compare the server's after every tick. */
function agreement(r: OwnRun, what: string): { compared: number; worst: string[] } {
  const sent = new Map<number, Predicted>();
  r.c.onReport = (rep, own) => {
    const p = own.player;
    sent.set(rep.seq, {
      rep: { ...rep, pos: { ...rep.pos }, vel: { ...rep.vel } },
      world: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
      carrierId: p.carrierId,
    });
  };
  const out = { compared: 0, worst: [] as string[] };
  let last = -1;
  r.onTick(() => {
    const p = r.ctrl.player;
    const d = p.remote!;
    if (d.lastSeq === last || !(d.lastSeq > 0)) return;
    last = d.lastSeq;
    const c = sent.get(d.lastSeq);
    if (c === undefined) return;
    out.compared++;
    const f = Math.fround;
    const want = c.rep;
    const diffs: string[] = [];
    const eq = (what: string, a: unknown, b: unknown): void => {
      if (a !== b) diffs.push(`${what} ${String(a)} != ${String(b)}`);
    };
    eq('carrier', d.carrierId, want.carrierId);
    eq('pos.x', d.pos.x, want.pos.x);
    eq('pos.y', d.pos.y, want.pos.y);
    eq('pos.z', d.pos.z, want.pos.z);
    eq('vel.x', d.vel.x, f(want.vel.x));
    eq('vel.y', d.vel.y, f(want.vel.y));
    eq('vel.z', d.vel.z, f(want.vel.z));
    eq('yaw', d.yaw, f(want.yaw));
    eq('pitch', d.pitch, Math.max(-Math.PI / 2, Math.min(Math.PI / 2, f(want.pitch))));
    eq('onGround', d.onGround, want.onGround);
    eq('flying', p.flying, want.flying);
    eq('sneaking', p.sneaking, want.sneaking);
    eq('sprinting', p.sprinting, want.sprinting);
    eq('carrier of the body', p.carrierId, c.carrierId);
    if (want.carrierId === 0) {
      eq('world.x', p.pos.x, c.world.x);
      eq('world.y', p.pos.y, c.world.y);
      eq('world.z', p.pos.z, c.world.z);
    }
    if (diffs.length > 0 && out.worst.length < 5) out.worst.push(`seq ${d.lastSeq}: ${diffs.join(', ')}`);
  });
  return out;
}

const STEPS = 1200;

describe('the prediction and the server agree exactly on a perfect link (package 6)', () => {
  it('on flat land with steps, walls and a pit: 1200 client ticks of random input', async () => {
    const r = await ownWorld(LAND, 'survival', {}, (sim) => {
      const T = LAND_TOP;
      for (let i = 0; i < 6; i++) fill(sim, -8 + i * 3, T, -10, -8 + i * 3, T + (i % 3), 10, B.COBBLE);
      fill(sim, 4, T - 3, -4, 7, T - 1, -1, B.AIR);
      fill(sim, -10, T, 6, 10, T + 2, 6, B.STONE);
    });
    const a = agreement(r, 'land');
    r.mark(randomScript(r, 101, false));
    r.runSteps(STEPS);
    stat(`agree\t${STEPS} client ticks: ${a.compared} reports compared, ${a.worst.length} differing, corrections ${JSON.stringify(r.causes())}`);
    expect(a.worst).toEqual([]);
    expect(a.compared).toBeGreaterThan(STEPS * 0.9);
    expect(r.causes()).toEqual([]);
    expect(r.rejected()).toBe(0);
  }, 120_000);

  it('swimming at sea, over a sunken reef: 1200 client ticks of random input', async () => {
    const r = await ownWorld(OWN_SEA, 'creative', {}, (sim) => fill(sim, -6, SEA_FLOOR, -6, -2, SEA_FLOOR + 6, 6, B.STONE));
    r.teleport(4.5, OWN_SEA_TOP - 3, 4.5, 1000);
    const a = agreement(r, 'sea');
    let wet = 0;
    r.onTick(() => {
      if (r.ctrl.player.wet > 0) wet++;
    });
    r.mark(randomScript(r, 202, true));
    r.runSteps(STEPS);
    stat(`agree\t${STEPS} client ticks: ${a.compared} reports compared, ${a.worst.length} differing, corrections ${JSON.stringify(r.causes())}`);
    expect(a.worst).toEqual([]);
    expect(a.compared).toBeGreaterThan(STEPS * 0.9);
    expect(r.causes()).toEqual([]);
    expect(r.rejected()).toBe(0);
    // It really swam.
    expect(wet).toBeGreaterThan(STEPS / 2);
  }, 120_000);

  it('on the deck of a raft sailing in circles (and off it, into the sea): 1200 client ticks of random input', async () => {
    // (Creative: a long swim after falling overboard would drown a survival player.)
    const r = await ownWorld(OWN_SEA, 'creative', {});
    const S = OWN_SEA_TOP;
    const ship = assemble(r.sim, buildRaft(r.sim, { x0: 10, z0: 0, x1: 18, z1: 8, y: S - 1, gunwale: true, helm: { x: 14, z: 2 } }));
    r.h.run(1000);
    r.teleport(14.5, S, 5.5, 1500);
    ship.throttle = 1;
    ship.rudder = 0.5;
    const a = agreement(r, 'raft');
    let carried = 0;
    r.onTick(() => {
      if (r.ctrl.player.carrierId === ship.id) carried++;
    });
    r.mark(randomScript(r, 303, false));
    r.runSteps(STEPS);
    stat(`agree\t${STEPS} client ticks: ${a.compared} reports compared, ${a.worst.length} differing, corrections ${JSON.stringify(r.causes())}`);
    expect([...r.causes(), ...a.worst]).toEqual([]);
    expect(a.compared).toBeGreaterThan(STEPS * 0.9);
    expect(carried).toBeGreaterThan(200);
    expect(r.causes()).toEqual([]);
    expect(r.rejected()).toBe(0);
  }, 120_000);
});
