import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { NY, NZ, PZ } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import {
  LAND_TOP,
  bodyIn,
  buildWindmill,
  copy,
  fill,
  hurtEvents,
  landSim,
  startWindmillByClicks,
  watchCrushes,
  watchEvents,
  type Cell3,
} from './g4-push-crush-helpers';

const T = LAND_TOP;

function landMill(sim: ReturnType<typeof landSim>): Cell3 {
  const canvas: Cell3[] = [
    [0, T + 1, 0],
    [0, T, 0],
  ];
  for (let x = 1; x <= 6; x++) canvas.push([x, T, 0], [x, T + 1, 0]);
  return buildWindmill(sim, [0, T + 2, 0], NY, canvas);
}

describe('explore', () => {
  it('free player', () => {
    const sim = landSim('survival', vec3(0.5, T, 3.5));
    const bearing = landMill(sim);
    sim.advance(2);
    const ev = watchEvents(sim);
    const crushes = watchCrushes(sim);
    const rotor = startWindmillByClicks(sim, bearing, PZ);
    const p0 = copy(sim.player.pos);
    for (let i = 0; i < 200; i++) {
      sim.tick();
      if (i % 10 === 0) console.log(i, rotor.angle.toFixed(3), rotor.angularSpeed.toFixed(3), sim.player.pos.x.toFixed(3), sim.player.pos.z.toFixed(3), bodyIn(rotor.grid, sim.player), sim.player.health);
    }
    console.log(p0, sim.player.pos, crushes, hurtEvents(ev));
  });
  it('caged player', () => {
    for (const mode of ['survival', 'creative'] as const) {
      const sim = landSim(mode, vec3(0.5, T, 3.5));
      const bearing = landMill(sim);
      sim.advance(2);
      const ev = watchEvents(sim);
      const crushes = watchCrushes(sim);
      const rotor = startWindmillByClicks(sim, bearing, PZ);
      fill(sim, -1, T, 3, -1, T + 1, 3, B.STONE);
      fill(sim, 1, T, 3, 1, T + 1, 3, B.STONE);
      fill(sim, 0, T, 2, 0, T + 1, 2, B.STONE);
      fill(sim, 0, T, 4, 0, T + 1, 4, B.STONE);
      fill(sim, -1, T + 2, 2, 1, T + 2, 4, B.STONE);
      const p0 = copy(sim.player.pos);
      for (let i = 0; i < 120 && crushes.length === 0; i++) sim.tick();
      console.log(mode, sim.ticks, p0, sim.player.pos, crushes, hurtEvents(ev), sim.player.health, rotor.angle);
    }
  });
});
void NZ;
void expect;
