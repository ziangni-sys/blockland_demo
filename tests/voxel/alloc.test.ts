/**
 * Allocation regression check for the World fast paths of shape.ts. The brief requires zero
 * heap allocation per call in boxOverlapsSolid / sweepAxis on the World; hasSupportBelow and
 * columnHasSolidBelow share the same scan and run just as often; deepestPenetration with `out`
 * allocates nothing on the World (docs/SHAPES.md 5.6). Full blocks and partial cells (half slabs),
 * with default inlining and with inlining nearly off (docs/SHAPES.md 4.4: an allocation-free
 * query must not depend on being inlined).
 *
 * Why a child process: inside vitest the module transform (imports become getter calls on
 * namespace objects) changes how V8 optimises shape.ts, and the original regression (~30 B
 * per FREE-box query from World.getCell inlined into a y-innermost loop) did not reproduce
 * there. tests/voxel/alloc-probe.ts is therefore bundled with rolldown (the bundler the
 * production build uses) and run in fresh node processes (tests/heap-probe-run.ts); it reports
 * sampled bytes per call.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { heapReport, INLINING_CONDITIONS, runHeapProbe } from '../heap-probe-run';

describe('World fast paths do not allocate (bundled, optimised code, both inlining conditions)', () => {
  it('boxOverlapsSolid / hasSupportBelow / columnHasSolidBelow / sweepAxis / deepestPenetration(out) on full blocks and half slabs', async () => {
    const result = await runHeapProbe(fileURLToPath(new URL('./alloc-probe.ts', import.meta.url)));
    const report = heapReport(result);
    expect(Object.keys(result).length).toBe(INLINING_CONDITIONS.length);
    for (const cases of Object.values(result)) {
      expect(Object.keys(cases).length, report).toBe(19);
      // The profiler's own plumbing costs a few KB per round (~0.02 B/call at 200k calls); one
      // boxed double costs >= 12 bytes, so even boxing on 1 call in 12 fails this bound.
      for (const v of Object.values(cases)) expect(v, report).toBeLessThan(1);
    }
  }, 240_000);
});
