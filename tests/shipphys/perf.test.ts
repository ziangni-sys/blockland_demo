/**
 * Performance budgets (brief): one step() for a 1000-cell ship averages < 1.5 ms, for a
 * 4000-cell ship < 6 ms. Measured on ticks the ship is actually simulated, after a warm-up,
 * while sailing in circles (buoyancy + hydrodynamics every sub-step) and while pressed against
 * a wall at full throttle (contacts every sub-step).
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { bigShip, fillWorld, launch, makeWorld, setup, tick } from './helpers';

type Mode = 'sail' | 'wall';

function measure(cells: number, len: number, wid: number, hgt: number, mode: Mode): { avg: number; count: number } {
  const world = makeWorld({ cx0: -4, cx1: 3, cz0: -6, cz1: 3 });
  if (mode === 'wall') fillWorld(world, -40, 36, -40, 40, 56, -38, B.STONE);
  const { dyn } = setup(world);
  const s = launch(bigShip(world, 1, len, wid, hgt, cells, 46, mode === 'wall' ? -30 : 0), dyn);
  expect(s.grid.count).toBeGreaterThanOrEqual(cells);
  s.sails = 40;
  s.throttle = 1;
  s.rudder = mode === 'sail' ? 1 : 0;
  for (let t = 0; t < 60; t++) tick(dyn, [s]); // warm-up (JIT) and, for the wall, reach it
  const times: number[] = [];
  for (let t = 0; t < 150; t++) {
    const t0 = performance.now();
    tick(dyn, [s]);
    const dt = performance.now() - t0;
    if (dyn.getStats(s)!.simulated) times.push(dt);
  }
  if (mode === 'wall') expect(dyn.getStats(s)!.terrainContacts).toBeGreaterThan(0);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`[shipphys perf] ${s.grid.count} cells, ${mode}: ${avg.toFixed(3)} ms/tick over ${times.length} ticks`);
  return { avg, count: times.length };
}

describe('performance budgets', () => {
  it('1000-cell ship: < 1.5 ms per tick', () => {
    const sail = measure(1000, 30, 10, 6, 'sail');
    const wall = measure(1000, 30, 10, 6, 'wall');
    expect(sail.count).toBeGreaterThan(100);
    expect(wall.count).toBeGreaterThan(100);
    expect(sail.avg).toBeLessThan(1.5);
    expect(wall.avg).toBeLessThan(1.5);
  });

  it('4000-cell ship: < 6 ms per tick', () => {
    const sail = measure(4000, 50, 16, 8, 'sail');
    const wall = measure(4000, 50, 16, 8, 'wall');
    expect(sail.avg).toBeLessThan(6);
    expect(wall.avg).toBeLessThan(6);
  });
});
