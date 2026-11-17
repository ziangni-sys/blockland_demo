// Scratch exploration (reviewer). Will be removed.
import { describe, it } from 'vitest';
import { NZ, PX } from '../../src/core/dirs';
import { launch, makeSea, newRotor, plankBoat, setup, tick } from './helpers';

describe('explore10', () => {
  for (const drift of [0, -0.3, -1]) {
    it(`blade flat face grazing a boat side, drift ${drift}`, () => {
      const world = makeSea();
      const { dyn, host } = setup(world);
      // horizontal-axis rotor (axis +X), hub cell (0,50,3); blade plate in the plane x=0 along +Z, 3 tall in y
      const cells: Array<[number, number, number]> = [[0, 50, 3]];
      for (let z = 4; z <= 10; z++) for (let y = 49; y <= 51; y++) cells.push([0, y, z]);
      const r = newRotor(world, 100, 0, 50, 3, PX, cells);
      const boat = launch(plankBoat(world, 1, 1, 47, -1, 4, 9, NZ), dyn); // x in [1,5): flush with the plate's +X face
      // let it settle
      for (let t = 0; t < 60; t++) tick(dyn, [boat], [r], 0);
      const v0 = { ...boat.grid.linearVelocity };
      boat.grid.linearVelocity.x = drift;
      let maxVy = 0;
      let maxVyz = 0;
      let contacts = 0;
      let maxDepth = 0;
      for (let t = 0; t < 120; t++) {
        tick(dyn, [boat], [r], 1);
        const v = boat.grid.linearVelocity;
        maxVy = Math.max(maxVy, Math.abs(v.y));
        maxVyz = Math.max(maxVyz, Math.hypot(v.y, v.z));
        contacts += dyn.getStats(boat)!.rotorContacts;
        maxDepth = Math.max(maxDepth, dyn.getStats(boat)!.maxDepth);
      }
      console.log(`drift=${drift}: settled v=(${v0.x.toFixed(3)},${v0.y.toFixed(3)}) contacts=${contacts} max|vy|=${maxVy.toFixed(2)} max|vyz|=${maxVyz.toFixed(2)} maxDepth=${maxDepth.toFixed(3)} x=${boat.grid.position.x.toFixed(2)} y=${boat.grid.position.y.toFixed(2)} cellsLost=${0} drops=${host.drops.length}`);
    });
  }
});
