/**
 * Adversarial review (correctness): buckets and ship holds.
 *
 * DESIGN 结构体里没有液体: "拿着桶瞄准结构体时，不会穿过它去舀或倒世界里的水" and liquids can never
 * be poured on a structure. LESSONS 船舱里冒出水面: the world water inside a floating hull is
 * deliberately NOT deleted (it is only hidden by the renderer, and isDryCell makes it dry for
 * bodies). So a player standing in the (dry) hold of a floating boat, aiming at the boat's
 * floor with a bucket, must never scoop that hidden world water, nor pour a source into the hold.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NZ, PY } from '../../src/core/dirs';
import { isDryCell } from '../../src/structures/hull';
import type { Ship } from '../../src/structures/structure';
import type { Simulation } from '../../src/sim/simulation';
import { SEA_TOP, fill, idAt, seaSim } from './helpers';

/**
 * A 5x5 plank boat built in the sea: floor at y = SEA_TOP - 2 (28), walls at 29 and 30,
 * a 3x3 open hold whose bottom row (y = 29) is sea water before (and after) assembly.
 * The helm stands on the floor at the hold's north-west corner.
 */
function boat(mode: 'creative' | 'survival'): { sim: Simulation; ship: Ship } {
  const sim = seaSim({ mode, spawn: { x: 2.5, y: SEA_TOP + 8, z: 12.5 } });
  const w = sim.world;
  fill(w, 0, SEA_TOP - 2, 0, 4, SEA_TOP - 2, 4, B.PLANKS_OAK); // floor (y 28)
  for (let y = SEA_TOP - 1; y <= SEA_TOP; y++) {
    for (let i = 0; i <= 4; i++) {
      w.setCell(i, y, 0, makeCell(B.PLANKS_OAK));
      w.setCell(i, y, 4, makeCell(B.PLANKS_OAK));
      w.setCell(0, y, i, makeCell(B.PLANKS_OAK));
      w.setCell(4, y, i, makeCell(B.PLANKS_OAK));
    }
  }
  w.setCell(1, SEA_TOP - 1, 1, makeCell(B.HELM, facingState(NZ)));
  const res = sim.structures.assembleShip(1, SEA_TOP - 1, 1);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error('assembly failed');
  return { sim, ship: res.structure };
}

describe('review: buckets never reach world water hidden inside a hull', () => {
  it('the hold of the floating boat really is below the waterline and dry', () => {
    const { sim, ship } = boat('survival');
    sim.advance(200); // settle
    const g = ship.grid;
    // Floor top (local y = 29) in world space is below the sea surface (y = 30).
    const floorTop = g.toWorld({ x: 2.5, y: SEA_TOP - 1, z: 2.5 });
    expect(floorTop.y).toBeLessThan(SEA_TOP);
    expect(ship.hull).not.toBeNull();
    expect(isDryCell(ship.hull!, 2, SEA_TOP - 1, 2)).toBe(true);
    // ...and the world water in the hold is still there (LESSONS: never deleted).
    const wc = g.toWorld({ x: 2.5, y: SEA_TOP - 1 + 0.05, z: 2.5 }); // just above the floor
    expect(Math.floor(wc.y)).toBe(SEA_TOP - 1);
    expect(idAt(sim.world, Math.floor(wc.x), Math.floor(wc.y), Math.floor(wc.z))).toBe(B.WATER);
  });

  it('an empty bucket aimed at the floor of the hold does not scoop the hidden world water', () => {
    const { sim, ship } = boat('survival');
    sim.advance(200);
    const g = ship.grid;
    const stand = g.toWorld({ x: 2.5, y: SEA_TOP - 1, z: 2.5 });
    sim.soloPlayer.teleport(stand.x, stand.y + 0.01, stand.z);
    sim.advance(5); // stands on the floor, carried by the boat
    sim.soloPlayer.hold(I.BUCKET, 1);
    // Aim at the top face of the floor cell right in front of the feet.
    sim.soloPlayer.lookAtCell(2, SEA_TOP - 2, 3, PY, ship.id);
    sim.soloPlayer.use();
    sim.tick();
    // What did the player aim at? The ship floor is what is visible.
    expect(sim.soloPlayer.player.inventory.selectedStack()).toEqual({ item: I.BUCKET, count: 1 });
  });

  it('a water bucket aimed at the floor of the hold does not pour a world source into the hull', () => {
    const { sim, ship } = boat('survival');
    sim.advance(200);
    const g = ship.grid;
    const stand = g.toWorld({ x: 2.5, y: SEA_TOP - 1, z: 2.5 });
    sim.soloPlayer.teleport(stand.x, stand.y + 0.01, stand.z);
    sim.advance(5);
    sim.soloPlayer.hold(I.BUCKET_WATER, 1);
    sim.soloPlayer.lookAtCell(2, SEA_TOP - 2, 3, PY, ship.id);
    sim.soloPlayer.use();
    sim.tick();
    expect(sim.soloPlayer.player.inventory.selectedStack()).toEqual({ item: I.BUCKET_WATER, count: 1 });
  });
});
