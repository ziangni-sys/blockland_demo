/**
 * Adversarial review (correctness lens): DynamicsOptions.waterDensity is a documented tuning option
 * ("Density of water on the BlockDef.density scale"), but several places assume it equals 1:
 * the float/sink verdict (mass < maxDisplacement), the "floating at equilibrium" sleep test
 * (|submerged - mass|), wetness / thrust effectiveness and the adaptive damping estimate.
 *
 * Expected to FAIL against the current implementation.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { NZ } from '../../src/core/dirs';
import { launch, makeSea, newShip, plankBoat, run, setup, shipBox } from './helpers';

describe('review: waterDensity != 1', () => {
  it('a floating boat still falls asleep with waterDensity = 1.1', () => {
    const world = makeSea();
    const { dyn } = setup(world, { waterDensity: 1.1 });
    const boat = launch(plankBoat(world, 1, -2, 47, -4, 5, 9, NZ), dyn);
    run(dyn, [boat], 400); // with the default density it sleeps after ~55 ticks
    const v = boat.grid.linearVelocity;
    expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(0.01); // it has settled ...
    expect(boat.asleep).toBe(true); // ... but submerged (31.9) != mass (35.1): never "floating"
  });

  it('a stone raft floats in water denser than stone and is treated as floating', () => {
    const world = makeSea();
    const { dyn } = setup(world, { waterDensity: 3 });
    const raft = newShip(world, 1);
    shipBox(raft, -2, 46, -2, 2, 46, 2, B.STONE); // density 2.6 < 3
    launch(raft, dyn);
    run(dyn, [raft], 300);
    // buoyancy (which does use waterDensity) keeps it up; the verdict must agree
    expect(raft.hull!.floats).toBe(true);
  });
});
