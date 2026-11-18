/**
 * A client-driven player joining a loaded world aboard a moving ship, before the first tick (the
 * host's own client, scenario 36): its correction is raised between ticks, the entities' structure
 * cache sees the ship then for the first time (EntityManager.settle), and the first tick must
 * measure ONE tick of the ship's motion (StructureCache.rebuild 'now', structs.ts).
 *
 * Found by scenario 30 (the save round trip in network mode): the cache took the ship's pose at
 * the start of the saved tick as its velocity base, so the first tick after the load measured two
 * ticks of motion as one: the player held aboard got twice the ship's velocity.
 */
import { describe, expect, it } from 'vitest';
import { vec3 } from '../../src/core/math';
import { exportSave } from '../../src/sim/persist';
import { loadSolo } from '../solo';
import { assemble, buildRaft, SEA_TOP, seaRun } from './scenes';

describe('joining a loaded world aboard a moving ship', () => {
  it('the first tick carries the client-driven player at the ship\'s velocity, not twice it', () => {
    const run = seaRun('creative', vec3(3.5, SEA_TOP, 3.5), null);
    const sim = run.sim;
    const helm = buildRaft(sim, { x0: 0, z0: 0, x1: 6, z1: 6, y: SEA_TOP - 1, helm: { x: 3, z: 1 } });
    sim.advance(2);
    const ship = assemble(sim, helm);
    sim.advance(20);
    ship.throttle = 1; // sails on under a remembered throttle, the player standing on its deck
    sim.advance(80);
    const p0 = sim.soloPlayer.player;
    expect(p0.carrierId).toBe(ship.id);
    expect(Math.hypot(ship.grid.linearVelocity.x, ship.grid.linearVelocity.z)).toBeGreaterThan(0.5);

    const loaded = loadSolo({ seed: 7001, mode: 'creative', generator: sim.generator, syncChunks: true, loadRadius: 3, rabbits: false }, exportSave(sim));
    const ctrl = loaded.soloPlayer;
    ctrl.setDrive('client'); // as NetServer does at the join: the correction is raised now, between ticks
    expect(ctrl.takeCorrection()?.cause).toBe('drive');
    loaded.tick();
    const p = ctrl.player;
    const s = loaded.structures.get(ship.id)!;
    expect(p.carrierId).toBe(s.id);
    // Held aboard (no report yet): it moves with the deck under its feet.
    const deck = s.grid.velocityAt(p.pos, vec3());
    expect(Math.hypot(p.carrierVel.x - deck.x, p.carrierVel.y - deck.y, p.carrierVel.z - deck.z)).toBeLessThan(0.05);
    expect(Math.hypot(p.vel.x - deck.x, p.vel.z - deck.z)).toBeLessThan(0.05);
  });
});
