/**
 * Allocation check for blocks/shapes.ts queries that consumers call per face or per cell
 * (docs/SHAPES.md 2.3, 4.4, 15): quadrantOctant, faceCover, and solidFill / solidCover / partAt on
 * full blocks and single parts allocate nothing, with default inlining and with inlining nearly
 * off. The probe (tests/blocks/shapes-alloc-probe.ts) runs bundled in a fresh node process, see
 * tests/heap-probe-run.ts for why.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { heapReport, INLINING_CONDITIONS, runHeapProbe } from '../heap-probe-run';

describe('blocks/shapes per-face queries do not allocate (bundled, both inlining conditions)', () => {
  it('quadrantOctant, faceCover, solidFill, solidCover, partAt', async () => {
    const result = await runHeapProbe(fileURLToPath(new URL('./shapes-alloc-probe.ts', import.meta.url)));
    const report = heapReport(result);
    expect(Object.keys(result).length).toBe(INLINING_CONDITIONS.length);
    for (const cases of Object.values(result)) {
      expect(Object.keys(cases).length, report).toBe(5);
      for (const v of Object.values(cases)) expect(v, report).toBeLessThan(1);
    }
  }, 240_000);
});
