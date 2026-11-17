// Scratch exploration (reviewer). Will be removed.
import { describe, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { PY } from '../../src/core/dirs';
import { qfromAxisAngle, vec3 } from '../../src/core/math';
import type { Rotor, Ship } from '../../src/structures/structure';
import {
  fillWorld,
  finite,
  hullSamplePoints,
  launch,
  makeSea,
  newRotor,
  plankBoat,
  setup,
  terrainPenetration,
  tick,
} from './helpers';

function blade(world: Parameters<typeof newRotor>[0], hx: number, hz: number, startAngle: number, len = 7): Rotor {
  const cells: Array<[number, number, number]> = [[hx, 47, hz]];
  for (let x = hx + 1; x <= hx + len; x++) for (let y = 46; y <= 49; y++) cells.push([x, y, hz]);
  const r = newRotor(world, 100, hx, 47, hz, PY, cells);
  r.angle = startAngle;
  qfromAxisAngle(vec3(0, 1, 0), startAngle, r.grid.rotation);
  r.grid.snapshotPose();
  return r;
}

describe('explore', () => {
  it('diagonal blade push along a long wall', () => {
    for (const start of [100, 110, 120, 130, 150]) {
      const world = makeSea();
      fillWorld(world, -9, 36, -40, -7, 52, 40, B.STONE); // west wall face x = -6
      const { dyn, host } = setup(world);
      // boat x in [-6,-3), z in [-6,-3)
      const boat = launch(plankBoat(world, 1, -6, 46, -6, 3, 3), dyn);
      const cells = boat.grid.count;
      const rotor = blade(world, 0, 0, (start * Math.PI) / 180, 8);
      let pinned = 0;
      let contacts = 0;
      let pen = 0;
      const z0 = boat.grid.position.z;
      for (let t = 0; t < 80; t++) {
        tick(dyn, [boat], [rotor], 1);
        const st = dyn.getStats(boat)!;
        pinned += st.pinned;
        contacts += st.rotorContacts;
        pen = Math.max(pen, terrainPenetration(world, boat, hullSamplePoints(boat)));
        if (start === 120 && t < 60) {
          const g = boat.grid;
          console.log(`  t=${t} ang=${(rotor.angle*180/Math.PI).toFixed(0)} pos=(${g.position.x.toFixed(2)},${g.position.z.toFixed(2)}) v=(${g.linearVelocity.x.toFixed(2)},${g.linearVelocity.z.toFixed(2)}) w=${g.angularVelocity.y.toFixed(2)} ter=${st.terrainContacts} rot=${st.rotorContacts} pinned=${st.pinned} destroyed=${st.destroyed} cells=${g.count}`);
        }
      }
      console.log(
        `start=${start} contacts=${contacts} pinned=${pinned} destroyed=${cells - boat.grid.count} drops=${host.drops.length} dz=${(boat.grid.position.z - z0).toFixed(2)} x=${boat.grid.position.x.toFixed(2)} pen=${pen.toFixed(3)} finite=${finite(boat)}`,
      );
    }
  });
});
