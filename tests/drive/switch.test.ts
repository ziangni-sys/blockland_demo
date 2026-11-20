/**
 * Carrier switches of an honest client (the lagged client harness). Boarding a raft under way from
 * a pier and leaving it again, and jumping between two rafts under way in opposite directions, with
 * 400 to 800 ms of pose lag, every report delivered: the client placed the body by its copies, which
 * lag the server's poses by the report's lag, so in the world at the server's poses the report of a
 * switch is off by the carriers' speeds at the body times that lag (drive.ts check(), switchSlack:
 * the carrier left and the carrier boarded, times the report's own lag, not the least lag the checks
 * assume; half of it, or the least lag, refuses the switches at 800 ms). And the first report of a
 * body the server placed into a structure: the server pushes it out first.
 */
import { describe, expect, it } from 'vitest';
import { NZ, PZ } from '../../src/core/dirs';
import { qfromAxisAngle, vec3 } from '../../src/core/math';
import { slab } from '../shapes';
import { attachClient } from './client';
import { pinned } from './pinned';
import { assemble, B, buildRaft, fill, SEA_TOP, seaRun } from './scenes';

/** World yaw looking along (dx, dz). */
const yawOf = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

/**
 * A stone pier (x -7..-2, its top a half block above the water, about as high as the raft's deck
 * floats) and an 8 by 12 raft beside it (x 0..7), under way along the pier at about 2.5 blocks a
 * second. The player starts on the pier abreast of the raft; for `ticks` ticks it sprint-jumps
 * east onto the raft for 14 ticks, rests 20, sprint-jumps west back onto the pier for 14, rests 20.
 * Returns the corrections and how often the client's body changed carrier.
 */
function shuttle(lag: number, ticks: number): { causes: string[]; switches: number; speed: number } {
  const run = seaRun('survival', vec3(-2.5, SEA_TOP, 0.5), lag);
  const sim = run.sim;
  const w = sim.world;
  fill(w, -7, SEA_TOP - 2, -40, -2, SEA_TOP - 2, 40, B.STONE);
  for (let x = -7; x <= -2; x++) for (let z = -40; z <= 40; z++) w.setCell(x, SEA_TOP - 1, z, slab(B.STONE, 0x33));
  const ship = assemble(sim, buildRaft(sim, { x0: 0, z0: -5, x1: 7, z1: 6, y: SEA_TOP - 1, helm: { x: 6, z: 5 } }));
  for (let t = 0; t < 60; t++) sim.tick();
  ship.throttle = 1;
  for (let t = 0; t < 50; t++) sim.tick();
  const mid = ship.grid.toWorld(vec3(4, SEA_TOP, 0.5));
  sim.soloPlayer.teleport(-1.7, SEA_TOP - 0.5 + 0.02, mid.z - 1.5);
  for (let t = 0; t < 12 + lag; t++) sim.tick();
  const client = run.client!;
  const ctl = sim.soloPlayer;
  const inp = ctl.player.input;
  const c0 = client.stats.corrections.length;
  let switches = 0;
  let carrier = client.player.carrierId;
  for (let t = 0; t < ticks; t++) {
    const k = t % 68;
    const east = k < 34;
    const moving = k < 14 || (k >= 34 && k < 48);
    inp.yaw = yawOf(east ? 1 : -1, 0);
    inp.forward = moving ? 1 : 0;
    inp.sprint = moving;
    inp.jump = moving;
    sim.tick();
    if (client.player.carrierId !== carrier) {
      carrier = client.player.carrierId;
      switches++;
    }
  }
  const v = ship.grid.velocityAt(ship.grid.position);
  return { causes: client.stats.corrections.slice(c0).map((c) => c.cause), switches, speed: Math.hypot(v.x, v.z) };
}

describe('a body the server places into the overhang of a mast on a steeply tilted structure', () => {
  /**
   * A teleport puts the client-driven body beside the mast of a structure at rest tilted 32 or 35 degrees,
   * on the side the mast leans over: the mast is in the body. The client's first step from the
   * correction would push it out (0.8 here) and attach it to the deck, a carrier switch farther than
   * one tick of legs and the slack: refused, and the correction put it back, every tick without end
   * (the slack is spent only by accepted reports). The server pushes the body out itself before it
   * settles the correction (EntityManager.pushOutOfStructures), as its push of a copy does for the
   * squeeze judgement.
   */
  it('teleported there, then walking, the structure tilted 32 and 35 degrees: only the teleport, nothing refused, and the body ends on the deck', () => {
    for (const deg of [32, 35]) {
      // Tilted about x, the mast leans toward +z: over the spot touching its +z side.
      const P = pinned(qfromAxisAngle(vec3(1, 0, 0), (deg * Math.PI) / 180));
      const sim = P.run.sim;
      const ctl = sim.soloPlayer;
      const client = attachClient(sim, 0);
      const w = P.onFace(0, 0.8, 0.05);
      ctl.teleport(w.x, w.y, w.z);
      const r0 = ctl.player.remote!.rejected;
      const away = P.onFace(0, 2.4, 0);
      for (let t = 0; t < 60; t++) {
        ctl.lookAt(away.x, away.y + 1.6, away.z);
        ctl.player.input.forward = t >= 20 ? 0.5 : 0;
        sim.tick();
      }
      const what = `${deg} degrees: ${JSON.stringify(client.causes())}`;
      expect(client.causes(), what).toEqual(['teleport']);
      expect(ctl.player.remote!.rejected - r0, what).toBe(0);
      expect(ctl.player.carrierId, what).toBe(P.ship.id);
    }
  });
});

describe('a carrier switch beside a raft under way, every report delivered', () => {
  for (const lag of [8, 12, 16])
    it(`onto the raft from the pier and back, ${lag * 50} ms of pose lag: nothing corrected`, () => {
      const r = shuttle(lag, 136);
      expect(r.speed, 'the raft is under way').toBeGreaterThan(2);
      expect(r.switches, JSON.stringify(r)).toBeGreaterThanOrEqual(4);
      expect(r.causes, JSON.stringify(r)).toEqual([]);
    });
});

/**
 * Two 6 by 12 rafts side by side (x 0..5 and 7..12), under way in opposite directions, about 2.5
 * blocks a second each. The player starts on the first, abreast of where they overlap; for `ticks`
 * ticks it sprint-jumps east onto the second raft for 14 ticks, rests 20, west back for 14, rests 20.
 */
function rafts(lag: number, ticks: number): { causes: string[]; switches: number; speeds: number[] } {
  const run = seaRun('survival', vec3(3.5, SEA_TOP, 0.5), lag);
  const sim = run.sim;
  // (Bows opposite ways: astern a raft is slower.)
  const a = assemble(sim, buildRaft(sim, { x0: 0, z0: -5, x1: 5, z1: 6, y: SEA_TOP - 1, helm: { x: 0, z: 6, facing: NZ } }));
  const b = assemble(sim, buildRaft(sim, { x0: 7, z0: -5, x1: 12, z1: 6, y: SEA_TOP - 1, helm: { x: 12, z: -5, facing: PZ } }));
  for (let t = 0; t < 60; t++) sim.tick();
  a.throttle = 1;
  b.throttle = 1;
  for (let t = 0; t < 30; t++) sim.tick();
  const za = a.grid.toWorld(vec3(3, SEA_TOP, 0.5));
  const zb = b.grid.toWorld(vec3(9, SEA_TOP, 0.5));
  const la = a.grid.toLocal(vec3(za.x, za.y, (za.z + zb.z) / 2));
  const s = a.grid.toWorld(vec3(4.6, la.y, Math.max(-4, Math.min(5.5, la.z))));
  sim.soloPlayer.teleport(s.x, s.y + 0.02, s.z);
  for (let t = 0; t < 12 + lag; t++) sim.tick();
  const client = run.client!;
  const inp = sim.soloPlayer.player.input;
  const c0 = client.stats.corrections.length;
  let switches = 0;
  let carrier = client.player.carrierId;
  for (let t = 0; t < ticks; t++) {
    const k = t % 68;
    const east = k < 34;
    const moving = k < 14 || (k >= 34 && k < 48);
    inp.yaw = yawOf(east ? 1 : -1, 0);
    inp.forward = moving ? 1 : 0;
    inp.sprint = moving;
    inp.jump = moving;
    sim.tick();
    if (client.player.carrierId !== carrier) {
      carrier = client.player.carrierId;
      switches++;
    }
  }
  const speed = (g: typeof a.grid) => {
    const v = g.velocityAt(g.position);
    return Math.hypot(v.x, v.z);
  };
  return { causes: client.stats.corrections.slice(c0).map((c) => c.cause), switches, speeds: [speed(a.grid), speed(b.grid)] };
}

describe('a carrier switch between two rafts under way in opposite directions, every report delivered', () => {
  for (const lag of [8, 12, 16])
    it(`from one to the other and back, ${lag * 50} ms of pose lag: nothing corrected (the speeds of both rafts count, the one left and the one boarded)`, () => {
      // (One round trip: closing at 5 blocks a second, they pass each other in about two and a half seconds.)
      const r = rafts(lag, 68);
      expect(Math.min(...r.speeds), JSON.stringify(r)).toBeGreaterThan(2);
      expect(r.switches, JSON.stringify(r)).toBeGreaterThanOrEqual(2);
      expect(r.causes, JSON.stringify(r)).toEqual([]);
    });
});

