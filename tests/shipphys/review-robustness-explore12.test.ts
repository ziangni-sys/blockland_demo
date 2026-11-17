// Scratch exploration (reviewer). Will be removed.
import { describe, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { bigShip, fillWorld, finite, hullSamplePoints, launch, makeWorld, setup, terrainPenetration, tick } from './helpers';

describe('explore12', () => {
  for (const rudder of [1, -1]) {
    it(`long ship turning hard at full speed along a 1-thick pier (rudder ${rudder})`, () => {
      const world = makeWorld({ cx0: -4, cx1: 3, cz0: -6, cz1: 3 });
      // 1-thick pier along z at x = 7 (just east of the hull x in [-5,5)) and at x=-7 (west)
      fillWorld(world, 6, 36, -60, 6, 52, 20, B.COBBLE);
      fillWorld(world, -7, 36, -60, -7, 52, 20, B.COBBLE);
      const { dyn } = setup(world);
      const s = launch(bigShip(world, 1, 30, 10, 6, 1000, 46, -10), dyn);
      s.sails = 40;
      s.throttle = 1;
      let pen = 0;
      let crossed = false;
      const pts = hullSamplePoints(s);
      for (let t = 0; t < 300; t++) {
        if (t === 40) s.rudder = rudder;
        tick(dyn, [s], []);
        pen = Math.max(pen, terrainPenetration(world, s, pts));
        if (s.grid.position.x > 6 || s.grid.position.x < -7) crossed = true;
      }
      console.log(`rudder=${rudder}: max pen=${pen.toFixed(3)} crossed=${crossed} finite=${finite(s)} pos=(${s.grid.position.x.toFixed(2)},${s.grid.position.z.toFixed(2)})`);
    });
  }
});
