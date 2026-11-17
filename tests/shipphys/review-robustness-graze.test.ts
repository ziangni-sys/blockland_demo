/**
 * Adversarial review (robustness lens): LESSONS 叶片侧面擦过船时船被猛踢. FAILS against the current
 * implementation; left in place for the fixer.
 *
 * A boat drifts at 0.3 block/s against the FLAT side of a spinning horizontal-axis rotor (a
 * water-wheel-like windmill): the blade face slides past the hull tangentially. The true overlap
 * is a few hundredths of a block and the only tangential coupling should be blade friction
 * (rotorFriction 0.3 times a normal impulse of ~0.3 block/s * mass), i.e. a fraction of a block/s.
 *
 * What happens: in the first contact tick the boat goes from (-0.3, 0, 0) to about
 * (+0.59, -0.93, -0.58) block/s (it even rebounds faster than it came in), and then one
 * persistent slop-depth contact drags it along the blade's sweep, accelerating it to ~5 block/s
 * in the blade plane. Cause: Prober.probe() credits SWEEP_BIAS (0.35 block) to exit faces that
 * point along the blade's relative sweep, so for a hull point that sits on the shared face (true
 * depth ~0) the leading/trailing face of the blade cell (depth up to 0.35) wins. The contact
 * NORMAL then points along the sweep, and the non-penetration row forces the hull to match the
 * blade's full sweep speed along it — the "kick" the LESSONS bullet describes. The stored depth
 * is the distance to that biased face, not the true (minimum) overlap.
 */
import { describe, expect, it } from 'vitest';
import { NZ, PX } from '../../src/core/dirs';
import { finite, launch, makeSea, newRotor, plankBoat, setup, tick } from './helpers';

describe('review: a blade face sliding past a hull does not fling it (LESSONS 叶片侧面擦过船时船被猛踢)', () => {
  it('boat drifting into the flat side of a spinning horizontal-axis rotor gets only a gentle push', () => {
    const world = makeSea();
    const { dyn, host } = setup(world);
    // axis +X, hub cell (0,50,3); a 7-long, 3-tall blade plate in the plane x in [0,1) along +Z
    const cells: Array<[number, number, number]> = [[0, 50, 3]];
    for (let z = 4; z <= 10; z++) for (let y = 49; y <= 51; y++) cells.push([0, y, z]);
    const rotor = newRotor(world, 100, 0, 50, 3, PX, cells);
    // boat east of the plate, its west face at x = 1 (flush with the plate's +X face), spanning the sweep
    const boat = launch(plankBoat(world, 1, 1, 47, -1, 4, 9, NZ), dyn);
    for (let t = 0; t < 60; t++) tick(dyn, [boat], [rotor], 0); // settle while the rotor is still
    boat.grid.linearVelocity.x = -0.3; // drift gently against the plate
    let contacts = 0;
    let maxTangential = 0;
    for (let t = 0; t < 120; t++) {
      tick(dyn, [boat], [rotor], 1); // blade tip speed ~7.5 block/s, all of it tangential to the contact face
      const v = boat.grid.linearVelocity;
      contacts += dyn.getStats(boat)!.rotorContacts;
      maxTangential = Math.max(maxTangential, Math.hypot(v.y, v.z));
      expect(finite(boat)).toBe(true);
    }
    expect(contacts).toBeGreaterThan(0);
    expect(host.drops).toHaveLength(0);
    // friction-only coupling should give a fraction of a block/s; 2 leaves generous room.
    // Currently ~5.3 block/s (blade tip ~7.5). With SWEEP_BIAS forced to 0 in a scratch copy of the
    // module the same scenario gives ~1.5, so the bias accounts for most of the kick.
    expect(maxTangential).toBeLessThan(2);
  });
});
