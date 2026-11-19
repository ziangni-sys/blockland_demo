/**
 * Liquid performance with partial cells around the liquid (docs/SHAPES.md section 15: "液体：性能
 * 测试的场景四周换成半砖", the same budgets as the full-block scenarios of perf.test.ts). The floor
 * under the water is made of upper slabs and two-part cells, so every chunk carries the holes and
 * second-part layers (World.getCell takes its layered path), and walls of partial cells stand in
 * the flow. The liquid engine itself reads only the base layer (invariant I7). Best of three runs,
 * as in perf.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { LOWER, UPPER, WEST, slab } from '../shapes';
import { FLOOR_Y, SURFACE, buildWorld, countLiquid, water, type CellFn, type FluidWorld } from './helpers';

const range6 = { minCx: 0, maxCx: 5, minCz: 0, maxCz: 5 };
const range4 = { minCx: 0, maxCx: 3, minCz: 0, maxCz: 3 };

/** The budgets of perf.test.ts. */
const MAX_US_PER_LIQUID_TICK = 10;
const MAX_BURST_MS = 25;

const UPPER_SLAB = slab(B.STONE, UPPER);
const TWO_PART = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER));
/** Floor of partial cells: upper slabs and two-part cells in a checkerboard (both layers allocated). */
const floorCell = (x: number, z: number): number => (((x ^ z) & 1) === 0 ? UPPER_SLAB : TWO_PART);
const WALL = slab(B.PLANKS_OAK, WEST);

interface Timing {
  ticks: number;
  avgMs: number;
  maxMs: number;
  calls: number;
  peakCalls: number;
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
    `[liquid/parts] ${name}: ${t.ticks} world ticks, ${t.calls} liquid ticks (peak ${t.peakCalls} in one), ` +
      `avg ${t.avgMs.toFixed(3)} ms/world tick, ${t.usPerCall.toFixed(2)} us/liquid tick, worst world tick ${t.maxMs.toFixed(2)} ms`,
  );
}

describe('liquid performance among partial cells', () => {
  it('25 sources spreading at once over a floor of slabs and two-part cells (2825 cells)', () => {
    const runs: Timing[] = [];
    for (let r = 0; r < 3; r++) {
      const fw = buildWorld((x, y, z) => (y === FLOOR_Y ? floorCell(x, z) : 0), range6);
      for (const x of [16, 32, 48, 64, 80]) for (const z of [16, 32, 48, 64, 80]) fw.world.setCell(x, SURFACE, z, water());
      runs.push(timeUntilQuiet(fw));
      // Partial cells are hard ground: the same diamonds as on full stone.
      expect(countLiquid(fw.world, B.WATER)).toBe(25 * 113);
    }
    const t = best(runs);
    report('25 sources', t);
    expect(t.peakCalls).toBeGreaterThan(1000);
    expect(t.avgMs).toBeLessThan(2);
    expect(t.usPerCall).toBeLessThan(MAX_US_PER_LIQUID_TICK);
    expect(t.maxMs).toBeLessThan(MAX_BURST_MS);
  });

  it('2025 flowing cells all due in the same world tick, walled in by partial cells, over a floor of them', () => {
    const inside = (x: number, z: number): boolean => x >= 10 && x < 55 && z >= 10 && z < 55;
    const layer: CellFn = (x, y, z) => {
      if (y === FLOOR_Y) return floorCell(x, z);
      if (y !== SURFACE) return 0;
      if (inside(x, z)) return water(1);
      return inside(x + 1, z) || inside(x - 1, z) || inside(x, z + 1) || inside(x, z - 1) ? WALL : 0;
    };
    const runs: Timing[] = [];
    for (let r = 0; r < 3; r++) {
      const fw = buildWorld(layer, range4);
      for (const chunk of fw.world.chunks.values()) fw.fluids.rescheduleChunk(chunk);
      const pending = fw.world.ticks.all();
      expect(pending.length).toBe(45 * 45);
      expect(new Set(pending.map((t) => t.at)).size).toBe(1);
      runs.push(timeUntilQuiet(fw));
      expect(countLiquid(fw.world)).toBe(0);
    }
    const t = best(runs);
    report('2025-cell burst', t);
    expect(t.peakCalls).toBeGreaterThanOrEqual(2025);
    expect(t.avgMs).toBeLessThan(2);
    expect(t.usPerCall).toBeLessThan(MAX_US_PER_LIQUID_TICK);
    expect(t.maxMs).toBeLessThan(MAX_BURST_MS);
  });
});
