/**
 * REVIEW (robustness / API): smaller footguns of the interaction surface.
 */
import { describe, expect, it } from 'vitest';
import { liquidState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { FLAT_TOP, flatSim, idAt } from './helpers';

const T = FLAT_TOP;

describe('review: scripted control and interaction edge cases', () => {
  it('a bucket in hand does not stop left-click mining at a liquid source', () => {
    // The mining ray is the bucket ray (targetableOrLiquidSource): attacking with a bucket hits the
    // water itself, shows "This block cannot be mined" and the block under the water cannot be dug.
    const sim = flatSim({ mode: 'creative' });
    sim.advance(2);
    // a water source in a one-cell pit right in front of the player's feet
    sim.world.setCell(0, T - 1, -1, makeCell(B.WATER, liquidState(0, false)));
    sim.tick();
    sim.lookAt(0.5, T - 1, -0.5); // down through the water, at the top of the dirt under it
    sim.tick();
    expect(sim.targetCell()).toMatchObject({ x: 0, y: T - 2, z: -1 }); // empty hand: the dirt
    sim.hold(I.BUCKET, 1);
    sim.player.input.attack = true;
    sim.attack();
    sim.tick();
    sim.player.input.attack = false;
    expect(sim.view.hint?.key).not.toBe('hint.unbreakable');
    expect(idAt(sim.world, 0, T - 2, -1)).toBe(B.AIR);
  });
});
