import { it } from 'vitest';
import { vec3 } from '../../src/core/math';
import { B, Bench, deck, fill, qfromYaw } from './harness';
it('debug pier', () => {
  const b = new Bench();
  fill(b.world, 6, 60, -2, 14, 60, 2, B.STONE);
  const ship = b.ship(1, deck(-5, -5, 5, 5, 60), vec3(0.5, 60.5, 0.5));
  b.drive(ship, () => ({ p: vec3(0.5, 60.5, 0.5), q: qfromYaw(0) }));
  const p = b.entities.createPlayer('survival', 3.5, 61, 0.5);
  b.tick(3);
  p.input.forward = 1;
  p.input.yaw = -Math.PI / 2;
  for (let i = 0; i < 20; i++) {
    b.tick();
    console.log(i, p.pos.x.toFixed(4), p.pos.y.toFixed(4), p.pos.z.toFixed(4), p.carrierId, p.onGround, p.onWorldGround, p.vel.x.toFixed(3));
  }
});
