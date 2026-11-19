/**
 * The transition rules of docs/SHAPES.md 16.3 that live in sim/interact.ts (P2's part of it):
 * the hands read the targeted cell as its whole packed cell (resolve, recheck, offhandGlue,
 * breakBlock), so the value they keep and compare is the same one the ray hands out; breaking a
 * two-part cell removes the whole cell, drops and reports its first part only (no CELL_MULTI_BIT).
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { canonCell } from '../../src/blocks/shapes';
import { PZ } from '../../src/core/dirs';
import { getPacked } from '../../src/voxel/parts';
import { LOWER, slab, UPPER } from '../shapes';
import { EventLog, FLAT_TOP, flatSim, items } from './helpers';

const T = FLAT_TOP;
/** Planks below, stone above: a two-part cell whose first part is planks (glueable). */
const TWO = canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.STONE, UPPER));

describe('the hands keep the packed cell (16.3)', () => {
  it('survival: the timed glue on a face of a two-part cell runs to the end (the value the press kept matches the hit every tick)', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, T, -2, TWO);
    sim.soloPlayer.hold(I.GLUE, 3);
    sim.soloPlayer.lookAtCell(0, T, -2, PZ);
    sim.soloPlayer.player.input.use = true;
    sim.soloPlayer.use();
    sim.tick();
    expect(sim.soloPlayer.view.gluing).not.toBeNull();
    sim.advance(200);
    expect(sim.worldGlue.has(0, T, -2, PZ)).toBe(true);
    expect(sim.soloPlayer.player.inventory.count(I.GLUE)).toBe(2);
  });

  it('survival: mining a two-part cell takes it whole; one drop and one blockBroken, both of the first part', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, T, -2, TWO);
    const log = new EventLog(sim);
    sim.soloPlayer.emptyHand();
    expect(sim.soloPlayer.mine(0, T, -2, PZ)).toBe(true);
    expect(getPacked(sim.world, 0, T, -2)).toBe(0);
    expect(log.of('blockBroken').map((e) => e.cell)).toEqual([slab(B.PLANKS_OAK, LOWER)]);
    sim.advance(5);
    expect(items(sim, B.PLANKS_OAK).count).toBe(1);
    expect(items(sim, B.STONE).count).toBe(0);
  });

  it('a full block mined in survival reports and drops exactly as before', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, T, -2, makeCell(B.PLANKS_OAK));
    const log = new EventLog(sim);
    sim.soloPlayer.emptyHand();
    expect(sim.soloPlayer.mine(0, T, -2, PZ)).toBe(true);
    expect(log.of('blockBroken').map((e) => e.cell)).toEqual([makeCell(B.PLANKS_OAK)]);
  });
});
