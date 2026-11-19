/**
 * Adversarial review (correctness): crush / unstuck relocation must search for a free spot
 * over the world AND every structure that the search radius can reach (brief step d:
 * "nearestFreeOffset over the world and all nearby structures — the same overlap test as
 * pushing"; LESSONS 挪到空位后立刻又被挤).
 *
 * EntityManager.relocate() passes only mover.near to nearestFreeOffset, and mover.near holds
 * the structures within NEAR_MARGIN = 0.5 of the body, while the search radius is
 * CRUSH_SEARCH_RADIUS = 3 (UNSTUCK_SEARCH_RADIUS = 2). A structure 0.5..3 blocks away is
 * invisible to the search, so the body can be "relocated" straight into it.
 */
import { describe, expect, it } from 'vitest';
import { vec3 } from '../../src/core/math';
import { B, Bench, fill, inStructure, inWorld, makeCell } from './harness';

const UP = vec3(0, 1, 0);

describe('review: relocation ignores structures beyond the 0.5 gather margin', () => {
  it('a crushed player is relocated into a parked ship 1.2 blocks away', () => {
    const b = new Bench();
    fill(b.world, -20, 60, -20, 19, 60, 19, B.STONE);
    // Closed tube around cell (0, 61..62, -3): all 8 horizontal neighbours and a 3x3 roof.
    for (let x = -1; x <= 1; x++) {
      for (let z = -4; z <= -2; z++) {
        if (x === 0 && z === -3) continue;
        fill(b.world, x, 61, z, x, 62, z, B.STONE);
      }
    }
    fill(b.world, -1, 63, -4, 1, 63, -2, B.STONE);
    // The nearest free spot outside the tube is offset (-2, 0, 0) (x ascending inside the
    // first free shell). Park a tiny ship exactly there: its cells x in [-2, -1] are 1.2
    // blocks from the player's box (minX 0.2), i.e. outside the 0.5 gather margin.
    const parked = b.ship(3, [
      [-2, 61, -3, B.PLANKS_OAK],
      [-2, 62, -3, B.PLANKS_OAK],
    ]);
    // A vertical-axis blade (hub (0,61,0), blade along +X, 2 high) sweeps through the tube.
    const cells: Array<[number, number, number, number]> = [[0, 61, 0, B.PLANKS_OAK]];
    for (let x = 1; x <= 6; x++) {
      cells.push([x, 61, 0, B.CANVAS]);
      cells.push([x, 62, 0, B.CANVAS]);
    }
    const blade = b.rotor(10, null, [0, 61, 0], 2, cells);
    b.spin(blade, 1.2, UP);
    const p = b.entities.spawnPlayer('survival', 0.5, 61, -2.5);
    let crushTick = -1;
    for (let i = 0; i < 80 && crushTick < 0; i++) {
      b.tick();
      if (b.host.count('crush', p) > 0) crushTick = i;
    }
    expect(crushTick).toBeGreaterThan(0);
    expect(inWorld(b.world, p)).toBe(false);
    expect(inStructure(blade, p)).toBe(false);
    // The "free spot" must be free of the parked ship too.
    expect(inStructure(parked, p)).toBe(false);
  });

  it('a block placed into the body (unstuck) relocates the player into a ship hanging 1.2 blocks above', () => {
    const b = new Bench();
    fill(b.world, -20, 60, -20, 19, 60, 19, B.STONE);
    // 1x1 shaft two high around cell (0, 61..62, 0).
    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
        if (x === 0 && z === 0) continue;
        fill(b.world, x, 61, z, x, 64, z, B.STONE);
      }
    }
    // A ship cell at (0, 64, 0): 1.2 above the head (box top 62.8) -> not in the 0.5 margin.
    const hanging = b.ship(4, [[0, 64, 0, B.PLANKS_OAK]]);
    const p = b.entities.spawnPlayer('survival', 0.5, 61, 0.5);
    b.tick(3);
    expect(p.onGround).toBe(true);
    // A block appears in the head cell (placed / flowed / blockified): step aside.
    b.world.setCell(0, 62, 0, makeCell(B.STONE));
    b.tick();
    expect(inWorld(b.world, p)).toBe(false);
    expect(inStructure(hanging, p)).toBe(false);
  });
});
