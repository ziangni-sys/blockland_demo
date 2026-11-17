import { describe, it } from 'vitest';
import { vec3 } from '../../src/core/math';
import { B, Bench, fill, TICK_DT } from './harness';

const DT = TICK_DT;

describe('explore 7', () => {
  it('sneak on a spinning turntable', () => {
    for (const heading of [0, 1.0, 2.0, -1.2]) {
      const b = new Bench();
      fill(b.world, -20, 50, -20, 19, 50, 19, B.STONE); // ground far below (10 blocks)
      const cells: Array<[number, number, number, number]> = [];
      for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) cells.push([x, 60, z, B.PLANKS_OAK]);
      const r = b.rotor(5, null, [0, 60, 0], 2, cells);
      b.spin(r, 0.6, vec3(0, 1, 0));
      const p = b.entities.createPlayer('survival', 0.5, 61.01, 0.5);
      b.tick(5);
      p.input.sneak = true;
      p.input.forward = 1;
      let lost = -1;
      for (let i = 0; i < 300; i++) {
        p.input.yaw = heading + r.angle;
        b.tick();
        if (p.carrierId !== r.id && lost < 0) lost = i;
      }
      console.log('turntable sneak heading', heading, 'lost at', lost, 'y', p.pos.y.toFixed(2));
    }
  });
});
