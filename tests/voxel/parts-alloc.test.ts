/**
 * Allocation check for the per-tick point queries of voxel/parts.ts (docs/SHAPES.md 4.4, 15):
 * solidAtHalf and solidFillAt allocate nothing on full blocks, holed single parts and two-part
 * cells, in the World and in a StructureGrid, with default inlining and with inlining nearly off.
 * The probe (tests/voxel/parts-alloc-probe.ts) runs bundled in a fresh node process, see
 * tests/heap-probe-run.ts for why.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { heapReport, INLINING_CONDITIONS, runHeapProbe } from '../heap-probe-run';

describe('voxel/parts point queries do not allocate (bundled, both inlining conditions)', () => {
  it('solidAtHalf / solidFillAt on full blocks, half slabs and two-part cells, World and StructureGrid', async () => {
    const result = await runHeapProbe(fileURLToPath(new URL('./parts-alloc-probe.ts', import.meta.url)));
    const report = heapReport(result);
    expect(Object.keys(result).length).toBe(INLINING_CONDITIONS.length);
    for (const cases of Object.values(result)) {
      expect(Object.keys(cases).length, report).toBe(10);
      // One boxed double costs >= 12 bytes; the profiler's own plumbing ~0.02 B/call.
      for (const v of Object.values(cases)) expect(v, report).toBeLessThan(1);
    }
  }, 240_000);
});
