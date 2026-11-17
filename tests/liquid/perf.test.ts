/**
 * Cost of liquid ticks with thousands of active cells. Bounds are deliberately loose (the
 * suite shares the machine with other work); the measured numbers are printed.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { pumpTicks } from '../../src/liquid/fluids';
import { FLOOR_Y, STONE, SURFACE, buildWorld, countLiquid, water, type CellFn, type FluidWorld } from './helpers';

const range6 = { minCx: 0, maxCx: 5, minCz: 0, maxCz: 5 };
const range4 = { minCx: 0, maxCx: 3, minCz: 0, maxCz: 3 };

interface Timing {
  ticks: number;
  avgMs: number;
  maxMs: number;
  /** Largest number of pending ticks seen in the queue (all due times). */
  peakQueue: number;
}

/** Pump until quiet, timing every world tick. */
function timeUntilQuiet(fw: FluidWorld): Timing {
  const { world, fluids } = fw;
  let ticks = 0;
  let total = 0;
  let maxMs = 0;
  let peakQueue = 0;
  while (world.ticks.size > 0) {
    const pending = world.ticks.size;
    const t0 = performance.now();
    pumpTicks(world, fluids, 1);
    const dt = performance.now() - t0;
    total += dt;
    ticks++;
    if (dt > maxMs) maxMs = dt;
    if (pending > peakQueue) peakQueue = pending;
    if (ticks > 10_000) throw new Error('did not settle');
  }
  return { ticks, avgMs: total / ticks, maxMs, peakQueue };
}

function best(runs: Timing[]): Timing {
  return runs.reduce((a, b) => (b.avgMs < a.avgMs ? b : a));
}

describe('liquid performance', () => {
  it('25 sources spreading at once (2825 cells) stay far below 2 ms per world tick on average', () => {
    const runs: Timing[] = [];
    for (let r = 0; r < 3; r++) {
      const fw = buildWorld((_x, y) => (y === FLOOR_Y ? STONE : 0), range6);
      for (const x of [16, 32, 48, 64, 80]) for (const z of [16, 32, 48, 64, 80]) fw.world.setCell(x, SURFACE, z, water());
      runs.push(timeUntilQuiet(fw));
      expect(countLiquid(fw.world, B.WATER)).toBe(25 * 113);
    }
    const t = best(runs);
    console.info(
      `[liquid] 25 sources: ${t.ticks} ticks, avg ${t.avgMs.toFixed(3)} ms/tick, max ${t.maxMs.toFixed(2)} ms, queue peak ${t.peakQueue}`,
    );
    expect(t.avgMs).toBeLessThan(2);
  });

  it('2025 flowing cells ticking in the same world tick', () => {
    const layer: CellFn = (x, y, z) =>
      y === FLOOR_Y ? STONE : y === SURFACE && x >= 10 && x < 55 && z >= 10 && z < 55 ? water(1) : 0;
    const runs: Timing[] = [];
    for (let r = 0; r < 3; r++) {
      const fw = buildWorld(layer, range4);
      for (const chunk of fw.world.chunks.values()) fw.fluids.rescheduleChunk(chunk);
      // Every cell of the layer is due in the very same world tick.
      const pending = fw.world.ticks.all();
      expect(pending.length).toBe(45 * 45);
      expect(new Set(pending.map((t) => t.at)).size).toBe(1);
      runs.push(timeUntilQuiet(fw));
      expect(countLiquid(fw.world)).toBe(0); // no source: it all drains
    }
    const t = best(runs);
    console.info(
      `[liquid] 2025-cell burst: ${t.ticks} ticks, avg ${t.avgMs.toFixed(3)} ms/tick, burst tick ${t.maxMs.toFixed(2)} ms`,
    );
    expect(t.avgMs).toBeLessThan(2);
  });
});
