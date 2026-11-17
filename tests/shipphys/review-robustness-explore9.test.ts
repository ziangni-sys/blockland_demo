// Scratch exploration (reviewer). Will be removed.
import { describe, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { NZ, PY } from '../../src/core/dirs';
import { qfromAxisAngle, vec3 } from '../../src/core/math';
import { finite, launch, makeWorld, newRotor, plankBoat, setup, tick, hullSamplePoints } from './helpers';

describe('explore9', () => {
  for (const len of [20, 40, 60]) {
    it(`long blade ${len} sweeping a boat in open water`, () => {
      const world = makeWorld({ cx0: -6, cx1: 5, cz0: -6, cz1: 5 });
      const { dyn, host } = setup(world);
      const cells: Array<[number, number, number]> = [[0, 47, 0]];
      for (let x = 1; x <= len; x++) for (let y = 46; y <= 48; y++) cells.push([x, y, 0]);
      const r = newRotor(world, 100, 0, 47, 0, PY, cells, B.CANVAS);
      // boat near the blade tip, north of the blade line; blade (CCW) sweeps toward north at angle>0
      const boat = launch(plankBoat(world, 1, len - 4, 46, -5, 3, 3, NZ), dyn);
      const n0 = boat.grid.count;
      r.angle = -0.05;
      qfromAxisAngle(vec3(0, 1, 0), r.angle, r.grid.rotation);
      r.grid.snapshotPose();
      let maxSpeed = 0;
      let contacts = 0;
      let maxDepth = 0;
      for (let t = 0; t < 40; t++) {
        tick(dyn, [boat], [r], 1);
        const v = boat.grid.linearVelocity;
        maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));
        contacts += dyn.getStats(boat)!.rotorContacts;
        maxDepth = Math.max(maxDepth, dyn.getStats(boat)!.maxDepth);
      }
      // is the boat now on the far side of the blade line (blade passed through it)?
      const ang = r.angle;
      const p = boat.grid.position;
      const side = Math.sin(ang) * p.x + Math.cos(ang) * p.z; // signed distance-ish to the blade line
      console.log(`len=${len}: maxSpeed=${maxSpeed.toFixed(1)} contacts=${contacts} maxDepth=${maxDepth.toFixed(2)} cells lost=${n0 - boat.grid.count} drops=${host.drops.length} pos=(${p.x.toFixed(1)},${p.z.toFixed(1)}) side=${side.toFixed(2)} finite=${finite(boat)} pts=${hullSamplePoints(boat).length}`);
    });
  }
});
