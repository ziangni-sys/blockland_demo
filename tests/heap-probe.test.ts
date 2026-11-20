/**
 * The allocation probes' own harness (tests/heap-probe.ts, tests/heap-probe-run.ts) on cases with
 * a known answer. What matters most is the failing case: when a query allocates again, the test
 * guarding it must fail with the bytes per call in its message, not by the child process timing
 * out with nothing to say. The 24 structure queries of tests/voxel/struct-alloc-probe.ts, each
 * building a 1 KB box per call again, measured in full rounds of 200,000 sampled calls, ran past
 * the 120 s child timeout (the heap profile keeps one sample per 64 bytes, collected objects
 * included); measured by the short screening run each round starts with, they report their
 * bytes in about 15 s per inlining condition. This test pins that a heavy case is measured by
 * the screening runs alone.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CALLS, ROUNDS, SCREEN_CALLS } from './heap-probe';
import { heapReport, INLINING_CONDITIONS, runHeapProbeOutputs } from './heap-probe-run';

describe('allocation probe harness', () => {
  it('reports a case allocating 1 KB per call with its bytes, quickly, and a clean case as clean', async () => {
    const outputs = await runHeapProbeOutputs(fileURLToPath(new URL('./heap-probe-selfcheck-probe.ts', import.meta.url)));
    const report = heapReport(Object.fromEntries(Object.entries(outputs).map(([k, o]) => [k, o.bytesPerCall])));
    expect(Object.keys(outputs).length).toBe(INLINING_CONDITIONS.length);
    for (const { bytesPerCall, sampledCalls } of Object.values(outputs)) {
      // 128 doubles = 1024 bytes of elements, plus the array object and the elements' header.
      expect(bytesPerCall['a 1 KB array per call'], report).toBeGreaterThan(1000);
      expect(bytesPerCall['a 1 KB array per call'], report).toBeLessThan(2000);
      expect(bytesPerCall['nothing allocated'], report).toBeLessThan(1);
      // The heavy case ran under the profiler in short screening runs only, the clean one in a
      // long run (which is what can tell 0.05 B from 1 B per call).
      expect(sampledCalls['a 1 KB array per call'], report).toBeLessThanOrEqual(ROUNDS * SCREEN_CALLS);
      expect(sampledCalls['nothing allocated'], report).toBeGreaterThanOrEqual(CALLS);
    }
  }, 60_000);
});
