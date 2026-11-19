/**
 * REVIEW (robustness): buckets look through a ship's open hold and scoop / pour the WORLD water
 * that sits inside the hull (DESIGN 结构体里没有液体: "拿着桶瞄准结构体时，不会穿过它去舀或倒世界里的水";
 * liquids can never be placed in or on a structure).
 *
 * After assembly the hold of an open boat keeps (or is refilled with) world water sources; the
 * hull keeps it dry and the renderer clips it away (LESSONS 船舱里冒出水面). The bucket ray uses
 * targetableOrLiquidSource over sim.grids(): the ship's AIR cells are transparent, so the first
 * thing it meets is that invisible world water. explosion.ts already treats such water as
 * displaced by the hull (isDryCell); interact.ts does not.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NZ } from '../../src/core/dirs';
import type { Simulation } from '../../src/sim/simulation';
import { SEA_TOP, countId, fill, idAt, seaSim } from './helpers';

/**
 * An open plank boat built in the sea: floor y=27, walls y=28..30, interior x1..3 z1..5 holds
 * world water at y=28..29 (the sea surface cell is y=29). Assembled, dynamics off so it stays put;
 * the player hovers above the stern wall looking down into the hold.
 */
function boat(): { sim: Simulation; shipId: number } {
  const sim = seaSim({ mode: 'survival', spawn: { x: 2.5, y: SEA_TOP + 1, z: 0.5 } });
  const w = sim.world;
  fill(w, 0, 27, 0, 4, 27, 6, B.PLANKS_OAK);
  for (let y = 28; y <= 30; y++) {
    for (let x = 0; x <= 4; x++) {
      w.setCell(x, y, 0, makeCell(B.PLANKS_OAK));
      w.setCell(x, y, 6, makeCell(B.PLANKS_OAK));
    }
    for (let z = 0; z <= 6; z++) {
      w.setCell(0, y, z, makeCell(B.PLANKS_OAK));
      w.setCell(4, y, z, makeCell(B.PLANKS_OAK));
    }
  }
  w.setCell(2, 31, 6, makeCell(B.HELM, facingState(NZ)));
  sim.advance(2);
  const res = sim.structures.assembleShip(2, 31, 6);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error('assembly failed');
  sim.structures.dynamics = null;
  sim.soloPlayer.teleport(2.5, 31, 0.5);
  sim.soloPlayer.player.flying = true;
  sim.advance(2);
  // Precondition of the scene: the hold is empty in the ship grid, world water is inside it.
  expect(idAt(res.structure.grid, 2, 29, 3)).toBe(B.AIR);
  expect(idAt(w, 2, 29, 3)).toBe(B.WATER);
  return { sim, shipId: res.structure.id };
}

describe('review: buckets and the world water inside a ship hold', () => {
  it('an empty bucket aimed into the dry hold does not scoop the hidden world water', () => {
    const { sim } = boat();
    sim.soloPlayer.hold(I.BUCKET, 1);
    sim.soloPlayer.lookAt(2.5, 29.9, 3.5);
    sim.tick();
    const before = sim.world.getCell(2, 29, 3);
    sim.soloPlayer.use();
    sim.tick();
    expect(sim.world.getCell(2, 29, 3)).toBe(before);
    expect(sim.soloPlayer.player.inventory.selectedStack()?.item).toBe(I.BUCKET);
  });

  it('a water bucket aimed into the dry hold does not pour into the structure', () => {
    const { sim } = boat();
    const w = sim.world;
    const wet = countId(w, B.WATER, 1, 28, 1, 3, 31, 5);
    sim.soloPlayer.hold(I.BUCKET_WATER, 1);
    sim.soloPlayer.lookAt(2.5, 29.9, 3.5);
    sim.tick();
    sim.soloPlayer.use();
    sim.tick();
    expect(idAt(w, 2, 30, 3)).toBe(B.AIR);
    expect(countId(w, B.WATER, 1, 28, 1, 3, 31, 5)).toBe(wet);
    expect(sim.soloPlayer.player.inventory.selectedStack()?.item).toBe(I.BUCKET_WATER);
  });
});
