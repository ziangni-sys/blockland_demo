/**
 * Performance budgets (brief): one step() for a 1000-cell ship averages < 1.5 ms, for a
 * 4000-cell ship < 6 ms. Measured on ticks the ship is actually simulated, after a warm-up:
 *  - sailing in circles (buoyancy + hydrodynamics every sub-step),
 *  - pressed against a wall at full throttle (contacts every sub-step),
 *  - landing on flat ground from a drop (the most contact-heavy case: the whole flat bottom
 *    touches the ground until the ship falls asleep).
 * The machine running the tests is shared (and vitest runs the other test files in parallel), so
 * the budget is checked on the CPU time of this thread (process.threadCpuUsage, wall time where
 * unavailable), which measures step() itself rather than how busy the host is, and each figure
 * is the best of three measurement windows. Wall time is logged alongside.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { bigShip, fillWorld, launch, makeWorld, setup, tick } from './helpers';

type Mode = 'sail' | 'wall';

const WINDOWS = 3;

/** CPU time of this thread in ms (wall time if the runtime cannot tell). */
const threadCpu = (process as { threadCpuUsage?: () => { user: number; system: number } }).threadCpuUsage;
function cpuNow(): number {
  if (threadCpu === undefined) return performance.now();
  const u = threadCpu.call(process);
  return (u.user + u.system) / 1000;
}

/** Time one tick: [cpu ms, wall ms]. */
function timed(fn: () => void, out: [number, number]): void {
  const c0 = cpuNow();
  const w0 = performance.now();
  fn();
  out[1] = performance.now() - w0;
  out[0] = cpuNow() - c0;
}

function measure(cells: number, len: number, wid: number, hgt: number, mode: Mode): number {
  const world = makeWorld({ cx0: -4, cx1: 3, cz0: -6, cz1: 3 });
  if (mode === 'wall') fillWorld(world, -40, 36, -40, 40, 56, -38, B.STONE);
  const { dyn } = setup(world);
  const s = launch(bigShip(world, 1, len, wid, hgt, cells, 46, mode === 'wall' ? -30 : 0), dyn);
  expect(s.grid.count).toBeGreaterThanOrEqual(cells);
  s.sails = 40;
  s.throttle = 1;
  s.rudder = mode === 'sail' ? 1 : 0;
  for (let t = 0; t < 60; t++) tick(dyn, [s]); // warm-up (JIT) and, for the wall, reach it
  let best = Infinity;
  let bestWall = Infinity;
  const tm: [number, number] = [0, 0];
  for (let w = 0; w < WINDOWS; w++) {
    let sum = 0;
    let sumWall = 0;
    let count = 0;
    for (let t = 0; t < 60; t++) {
      timed(() => tick(dyn, [s]), tm);
      if (dyn.getStats(s)!.simulated) {
        sum += tm[0];
        sumWall += tm[1];
        count++;
      }
    }
    expect(count).toBeGreaterThan(50);
    if (mode === 'wall') expect(dyn.getStats(s)!.terrainContacts).toBeGreaterThan(0);
    best = Math.min(best, sum / count);
    bestWall = Math.min(bestWall, sumWall / count);
  }
  console.log(`[shipphys perf] ${s.grid.count} cells, ${mode}: ${best.toFixed(3)} ms/tick cpu, ${bestWall.toFixed(3)} wall (best of ${WINDOWS})`);
  return best;
}

/** Dropped onto flat ground: average over the ticks with terrain contacts, until it sleeps. */
function landing(cells: number, len: number, wid: number, hgt: number): number {
  let best = Infinity;
  let bestWall = Infinity;
  const tm: [number, number] = [0, 0];
  for (let w = 0; w <= WINDOWS; w++) {
    const world = makeWorld({ cx0: -4, cx1: 3, cz0: -6, cz1: 3, floorTop: 40, waterTop: 0 });
    const { dyn } = setup(world);
    const s = launch(bigShip(world, 1, len, wid, hgt, cells, 43, 0), dyn);
    let sum = 0;
    let sumWall = 0;
    let count = 0;
    for (let t = 0; t < 200 && !s.asleep; t++) {
      timed(() => tick(dyn, [s]), tm);
      const st = dyn.getStats(s)!;
      if (st.simulated && st.terrainContacts > 0) {
        sum += tm[0];
        sumWall += tm[1];
        count++;
      }
    }
    expect(s.asleep).toBe(true);
    expect(count).toBeGreaterThan(20);
    if (w > 0) {
      // the first run warms the JIT up
      best = Math.min(best, sum / count);
      bestWall = Math.min(bestWall, sumWall / count);
    }
  }
  console.log(`[shipphys perf] ${cells} cells, landing: ${best.toFixed(3)} ms/tick cpu, ${bestWall.toFixed(3)} wall (best of ${WINDOWS})`);
  return best;
}

describe('performance budgets', () => {
  it('1000-cell ship: < 1.5 ms per tick', () => {
    expect(measure(1000, 30, 10, 6, 'sail')).toBeLessThan(1.5);
    expect(measure(1000, 30, 10, 6, 'wall')).toBeLessThan(1.5);
    expect(landing(1000, 30, 10, 6)).toBeLessThan(1.5);
  });

  it('4000-cell ship: < 6 ms per tick', () => {
    expect(measure(4000, 50, 16, 8, 'sail')).toBeLessThan(6);
    expect(measure(4000, 50, 16, 8, 'wall')).toBeLessThan(6);
    expect(landing(4000, 50, 16, 8)).toBeLessThan(6);
  });
});
