// Scratch exploration (reviewer). Will be removed.
import { describe, it } from 'vitest';
import { NZ, PY } from '../../src/core/dirs';
import { launch, makeSea, newRotor, plankBoat, setup, tick } from './helpers';

describe('explore8', () => {
  it('boat parked against a stopped rotor blade', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    // blade plate along x from 1..7 at z=0, y 46..49 (a stopped windmill)
    const cells: Array<[number, number, number]> = [[0, 47, 0]];
    for (let x = 1; x <= 7; x++) for (let y = 46; y <= 49; y++) cells.push([x, y, 0]);
    const r = newRotor(world, 100, 0, 47, 0, PY, cells);
    const boat = launch(plankBoat(world, 1, 2, 47, 3, 4, 6, NZ), dyn); // bow toward the blade (z=1..)
    boat.throttle = 1;
    let contacts = 0;
    for (let t = 0; t < 100; t++) tick(dyn, [boat], [r], 0);
    boat.throttle = 0;
    let asleep = 0;
    for (let t = 0; t < 400; t++) {
      tick(dyn, [boat], [r], 0);
      if (t >= 200) {
        if (boat.asleep) asleep++;
        contacts += dyn.getStats(boat)!.rotorContacts;
      }
    }
    const v = boat.grid.linearVelocity;
    console.log(`stopped rotor: asleep ${asleep}/200 rotorContacts(last200)=${contacts} z=${boat.grid.position.z.toFixed(3)} v=${Math.hypot(v.x, v.y, v.z).toFixed(4)} restTicks=${boat.restTicks}`);
  });
});
