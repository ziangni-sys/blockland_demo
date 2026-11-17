/**
 * Review (correctness): ticks whose outcome needs NO data from an unloaded chunk are still
 * deferred whole when a horizontal neighbour chunk is missing. A source (or a falling cell
 * fed from above) over a hole only falls straight down inside its own column, so nothing
 * about that decision depends on the missing chunk — yet the liquid hangs in mid-air at the
 * edge of the loaded area until the neighbour loads.
 */
import { describe, expect, it } from 'vitest';
import { cellState, liquidFalling } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { FLOOR_Y, SURFACE, buildWorld, countLiquid, platform, pumpUntilQuiet, water } from './helpers';

describe('review: liquid at the edge of the loaded area', () => {
  it('a mid-air source on a border column (neighbour chunk unloaded) still falls down its own column', () => {
    // Chunks (0,0) and (1,0) loaded; the row cz = 1 (z >= 16) is not.
    const fw = buildWorld(platform, { minCx: 0, maxCx: 1, minCz: 0, maxCz: 0 });
    const { world } = fw;
    world.setCell(16, 30, 15, water()); // z = 15: its +Z neighbour lies in the unloaded chunk (1, 1)
    pumpUntilQuiet(fw);
    // Falling is decided by the column alone (below is air, inside the loaded chunk), so the
    // column y = SURFACE .. 29 must fill with falling water even though sideways spreading
    // has to wait for the neighbour.
    for (let y = SURFACE; y < 30; y++) {
      const c = world.getCell(16, y, 15);
      expect(c & 0x3ff, `y = ${y}`).toBe(B.WATER);
      expect(liquidFalling(cellState(c)), `y = ${y}`).toBe(true);
    }
    expect(countLiquid(world)).toBeGreaterThanOrEqual(30 - SURFACE + 1);
    expect(world.getCell(16, FLOOR_Y, 15) & 0x3ff).toBe(B.STONE);
  });
});
