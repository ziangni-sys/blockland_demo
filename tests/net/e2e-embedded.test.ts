/**
 * A block put into a client-driven player's body that does not carry it (EntityManager
 * judgeWorldStuck): the server moves the player out at once, as it moves a server-driven one
 * (BodyMover: any overlap with the world), and the client carries on from there.
 *
 * Found by scenario 30 (the acceptance tests in network mode): a player swimming at the surface
 * when a pier is built around it (its feet ~0.15 into the new block, inside REPORT_HARD_TOLERANCE)
 * was left there by the server; the client, which does not relocate, sank on into the block, and
 * every one of its reports was refused ('check:world') back to the same place, forever.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { aabb } from '../../src/core/math';
import { Simulation } from '../../src/sim/simulation';
import { boxOverlapsSolid } from '../../src/voxel/shape';
import { FlatGenerator } from '../../src/worldgen/generator';
import { NetHarness } from './harness';

/** Sea: water 20..29, first air at y = 30. */
const SEA_TOP = 30;

function sea(): Simulation {
  return new Simulation({
    seed: 3,
    mode: 'creative',
    generator: new FlatGenerator([
      { id: B.DEEPROCK, thickness: 1 },
      { id: B.STONE, thickness: 19 },
      { id: B.WATER, thickness: 10 },
    ]),
    syncChunks: true,
    loadRadius: 2,
    rabbits: false,
    spawn: { x: 2.5, y: SEA_TOP, z: 7.5 },
  });
}

describe('a block put into a client-driven body (judgeWorldStuck)', () => {
  it('a shallow overlap with the world: the server moves the player out, the client follows, no report is refused', () => {
    const sim = sea();
    const h = new NetHarness({ lockstep: true, starterItems: false });
    h.serve(sim);
    const c = h.addClient('me', {}, { local: true, viewRadius: 2 });
    h.ticks(2);
    expect(c.own).not.toBeNull();
    const p = sim.players.get('me')!.player;
    // Dropping into the water at the spawn: the feet just below the top of the surface water cells
    // (y 29), within REPORT_HARD_TOLERANCE of it (the report check alone lets such an overlap be).
    h.runUntil(() => SEA_TOP - p.pos.y > 0 && SEA_TOP - p.pos.y < 0.2, 2000);
    // A pier is built around the swimmer: rubble from the sea floor up to the surface layer.
    for (let y = 20; y < SEA_TOP; y++) for (let z = 6; z <= 8; z++) for (let x = 0; x <= 4; x++) sim.world.setCell(x, y, z, makeCell(B.COBBLE));
    expect(boxOverlapsSolid(sim.world, p.box(aabb()))).toBe(true);
    const from = h.sim.ticks;
    h.ticks(10);
    // Out of the block (on top of the pier), on the server and on the client.
    expect(boxOverlapsSolid(sim.world, p.box(aabb()))).toBe(false);
    expect(p.pos.y).toBeGreaterThanOrEqual(SEA_TOP - 1e-9);
    expect(c.own!.player.pos.y).toBeCloseTo(p.pos.y, 9);
    expect(c.correctionsSince(from - 1)).toEqual(['unstick']);
    // And it stays put: no correction any more.
    const later = h.sim.ticks;
    h.ticks(20);
    expect(c.correctionsSince(later)).toEqual([]);
  });
});
