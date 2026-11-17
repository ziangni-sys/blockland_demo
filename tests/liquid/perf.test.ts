/**
 * Cost of liquid ticks with thousands of active cells. Three readings per scenario, best of
 * three runs (the suite shares the machine with other work), all printed:
 *  - the average cost per world tick until quiet (the brief's bound: far below 2 ms);
 *  - the cost per liquid tick() call, over the world ticks that had liquid work only — this
 *    is what catches a per-cell regression, which idle ticks would otherwise dilute ~5x;
 *  - the most expensive single world tick (all cells due at once).
 * Bounds are loose; plain node runs about 3-4x faster than under vitest.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { FLOOR_Y, STONE, SURFACE, buildWorld, countLiquid, water, type CellFn, type FluidWorld } from './helpers';

const range6 = { minCx: 0, maxCx: 5, minCz: 0, maxCz: 5 };
const range4 = { minCx: 0, maxCx: 3, minCz: 0, maxCz: 3 };

/** Bound on the cost of one liquid tick() call, microseconds (measured ~1-3 under vitest). */
const MAX_US_PER_LIQUID_TICK = 10;
/** Bound on the most expensive world tick, ms (measured ~3-7 under vitest for ~2000 cells). */
const MAX_BURST_MS = 25;

interface Timing {
  ticks: number;
  avgMs: number;
  maxMs: number;
  /** Liquid tick() calls in total. */
  calls: number;
  /** Most tick() calls in one world tick. */
  peakCalls: number;
  /** Time per tick() call, measured over the world ticks that had any. */
  usPerCall: number;
}

/** Pump until quiet, timing every world tick (dispatching exactly as pumpTicks does). */
function timeUntilQuiet(fw: FluidWorld): Timing {
  const { world, fluids } = fw;
  let ticks = 0;
  let total = 0;
  let busy = 0;
  let maxMs = 0;
  let calls = 0;
  let peakCalls = 0;
  while (world.ticks.size > 0) {
    const t0 = performance.now();
    world.time++;
    const due = world.ticks.takeDue(world.time);
    for (let k = 0; k < due.length; k++) {
      const t = due[k]!;
      if (fluids.handles(t.id)) fluids.tick(t.x, t.y, t.z, t.id);
    }
    const dt = performance.now() - t0;
    total += dt;
    ticks++;
    if (due.length > 0) busy += dt;
    if (dt > maxMs) maxMs = dt;
    calls += due.length;
    if (due.length > peakCalls) peakCalls = due.length;
    if (ticks > 10_000) throw new Error('did not settle');
  }
  return { ticks, avgMs: total / ticks, maxMs, calls, peakCalls, usPerCall: (busy * 1000) / Math.max(1, calls) };
}

/** Best reading of each kind over several runs (noise only ever adds time). */
function best(runs: Timing[]): Timing {
  return {
    ...runs[0]!,
    avgMs: Math.min(...runs.map((r) => r.avgMs)),
    maxMs: Math.min(...runs.map((r) => r.maxMs)),
    usPerCall: Math.min(...runs.map((r) => r.usPerCall)),
  };
}

function report(name: string, t: Timing): void {
  console.info(
    `[liquid] ${name}: ${t.ticks} world ticks, ${t.calls} liquid ticks (peak ${t.peakCalls} in one), ` +
      `avg ${t.avgMs.toFixed(3)} ms/world tick, ${t.usPerCall.toFixed(2)} us/liquid tick, worst world tick ${t.maxMs.toFixed(2)} ms`,
  );
}

describe('liquid performance', () => {
  it('25 sources spreading at once (2825 cells)', () => {
    const runs: Timing[] = [];
    for (let r = 0; r < 3; r++) {
      const fw = buildWorld((_x, y) => (y === FLOOR_Y ? STONE : 0), range6);
      for (const x of [16, 32, 48, 64, 80]) for (const z of [16, 32, 48, 64, 80]) fw.world.setCell(x, SURFACE, z, water());
      runs.push(timeUntilQuiet(fw));
      expect(countLiquid(fw.world, B.WATER)).toBe(25 * 113);
    }
    const t = best(runs);
    report('25 sources', t);
    expect(t.peakCalls).toBeGreaterThan(1000);
    expect(t.avgMs).toBeLessThan(2);
    expect(t.usPerCall).toBeLessThan(MAX_US_PER_LIQUID_TICK);
    expect(t.maxMs).toBeLessThan(MAX_BURST_MS);
  });

  it('2025 flowing cells all due in the same world tick', () => {
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
    report('2025-cell burst', t);
    expect(t.peakCalls).toBeGreaterThanOrEqual(2025);
    expect(t.avgMs).toBeLessThan(2);
    expect(t.usPerCall).toBeLessThan(MAX_US_PER_LIQUID_TICK);
    expect(t.maxMs).toBeLessThan(MAX_BURST_MS);
  });
});
