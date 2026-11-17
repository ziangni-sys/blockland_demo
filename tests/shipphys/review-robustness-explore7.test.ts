// Scratch exploration (reviewer). Will be removed.
import { describe, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { vec3 } from '../../src/core/math';
import { launch, makeWorld, newShip, rotateShip, setup, shipBox, addHelm } from './helpers';

describe('explore7', () => {
  for (const [len, wid] of [[50, 80], [200, 20], [400, 10]] as const) {
    it(`long thin raft ${len}x${wid} yawed 45`, () => {
      const world = makeWorld({ cx0: -16, cx1: 15, cz0: -16, cz1: 15 });
      const { dyn } = setup(world);
      const s = newShip(world, 1);
      shipBox(s, -(wid >> 1), 47, -(len >> 1), -(wid >> 1) + wid - 1, 47, -(len >> 1) + len - 1, B.PLANKS_OAK);
      addHelm(s, 0, 48, 0, 5);
      launch(s, dyn);
      rotateShip(s, vec3(0, 1, 0), Math.PI / 4);
      s.rudder = 0.01;
      const times: number[] = [];
      for (let t = 0; t < 60; t++) {
        s.grid.snapshotPose();
        const t0 = performance.now();
        dyn.step([s], []);
        if (t >= 20) times.push(performance.now() - t0);
      }
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      console.log(`[review perf] raft ${len}x${wid} (${s.grid.count} cells) yawed 45: ${avg.toFixed(3)} ms/tick simulated=${dyn.getStats(s)!.simulated}`);
    });
  }
});
