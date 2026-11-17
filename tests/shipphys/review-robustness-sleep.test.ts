/**
 * Adversarial review (robustness lens): sleep / lifecycle gaps. These tests FAIL against the
 * current implementation; they are left in place for the fixer.
 *
 *  1. A ship asleep on another ship's deck never wakes when the cells it rests on are removed
 *     (mined) and the carrier stays quiet (resting on land, or barely affected): the carrier is
 *     refreshed and woken, the sleeper joins its solve as an IMMOVABLE obstacle (sleeper next to
 *     a quiet awake ship), nothing touches it any more, so it hovers in mid-air forever. The
 *     manager only wakes ships for WORLD cell changes (onWorldCell), never for another ship's
 *     cell changes, and the dynamics' wake rules (moving rotor / non-quiet ship / ship impulse)
 *     never fire here.
 *
 *  2. A ship left with no HARD cell (e.g. only a torch after its planks were destroyed by
 *     pinning or an explosion) is skipped by step() entirely (b.shape.solidCount === 0): it hangs
 *     in the air for ever, and its grid keeps reporting the velocity it had (the helm read-out and
 *     anything using velocityAt see a moving ship that never moves). The manager removes only
 *     ships with grid.count === 0, so nothing else cleans it up.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { launch, makeSea, makeWorld, newShip, run, setup, shipBox } from './helpers';

describe('review: a sleeping ship resting on another ship', () => {
  it('falls when the deck cells under it are mined (carrier resting on land)', () => {
    const world = makeWorld({ cx0: -2, cx1: 1, cz0: -2, cz1: 1, floorTop: 40, waterTop: 0 });
    const { dyn } = setup(world);
    const carrier = newShip(world, 1);
    shipBox(carrier, -4, 40, -4, 3, 40, 3, B.PLANKS_OAK); // 8x8 deck on the ground
    shipBox(carrier, -1, 41, -1, 0, 41, 0, B.PLANKS_OAK); // 2x2 platform on the deck
    launch(carrier, dyn);
    const crate = newShip(world, 2);
    shipBox(crate, -1, 42, -1, 0, 42, 0, B.PLANKS_OAK); // small ship resting on the platform
    launch(crate, dyn);
    run(dyn, [carrier, crate], 120);
    expect(carrier.asleep).toBe(true);
    expect(crate.asleep).toBe(true);

    // the player mines the platform: what the manager does is setCell + refresh every tick
    for (let x = -1; x <= 0; x++) for (let z = -1; z <= 0; z++) carrier.grid.setCell(x, 41, z, 0);
    dyn.refresh(carrier);
    const y0 = crate.grid.position.y;
    run(dyn, [carrier, crate], 60);
    // nothing holds it up any more: it must drop onto the deck (about one block)
    expect(crate.grid.position.y).toBeLessThan(y0 - 0.5);
  });
});

describe('review: a ship with no hard cell left', () => {
  it('does not keep reporting a velocity while hanging motionless in the air', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const s = newShip(world, 1);
    shipBox(s, 0, 52, 0, 2, 52, 2, B.PLANKS_OAK);
    s.grid.setCell(1, 53, 1, makeCell(B.TORCH)); // a torch on the deck
    launch(s, dyn);
    run(dyn, [s], 5); // falling
    for (let x = 0; x <= 2; x++) for (let z = 0; z <= 2; z++) s.grid.setCell(x, 52, z, 0); // planks destroyed
    dyn.refresh(s);
    const p0 = { ...s.grid.position };
    run(dyn, [s], 40);
    const moved = Math.hypot(s.grid.position.x - p0.x, s.grid.position.y - p0.y, s.grid.position.z - p0.z);
    const v = s.grid.linearVelocity;
    const speed = Math.hypot(v.x, v.y, v.z);
    // either it is simulated (it moves, e.g. falls) or its state says it is at rest
    expect(moved > 0.1 || speed === 0).toBe(true);
  });
});
