/**
 * The per-frame overlay and camera paths over partial cells create no objects (docs/SHAPES.md
 * 8.6: geometry is kept per mask, nothing is allocated per frame; 4.4: per-frame code never forms
 * the packed value of a two-part cell). tests/client/shapes-alloc-probe.ts measures each path over
 * partial cells and the same path over whole blocks, bundled and run in a fresh node process in
 * both inlining conditions (tests/heap-probe-run.ts).
 *
 * Bound: a partial path costs at most 1 byte per call more than its whole-block twin; that is the
 * check of this package's rule. Every path but the whole camera placement also stays under 64
 * bytes per call: what the sampling profiler sees on the whole-block paths are boxed numbers (16
 * bytes each: a fractional double passed to or returned from a function V8 did not inline, such as
 * the distance a sweep returns, and three's own matrix code in the layer case), at most three of
 * them; geometry, a typed array or an array per element per call is far above it. The camera
 * placement (ViewBuilder.updateCamera, 'back') passes a dozen doubles between its functions and
 * boxes several of them; over whole blocks it boxes what it boxed before shapes existed (measured
 * against the M1 baseline, see the P8b-2 report), so it is bounded by its whole-block twin only.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { heapReport, runHeapProbe } from '../heap-probe-run';

describe('overlays and camera over partial cells: no objects per frame (bundled, optimised code)', () => {
  it('partial paths cost what whole-block paths cost', async () => {
    const result = await runHeapProbe(fileURLToPath(new URL('./shapes-alloc-probe.ts', import.meta.url)));
    const report = heapReport(result);
    for (const cases of Object.values(result)) {
      for (const [name, bytes] of Object.entries(cases)) if (!name.startsWith('camera')) expect(bytes, `${name}\n${report}`).toBeLessThan(64);
      for (const pair of ['overlays', 'sweep', 'clearance', 'camera', 'light', 'layer']) {
        expect(cases[`${pair} partial`]! - cases[`${pair} whole`]!, `${pair}\n${report}`).toBeLessThan(1);
      }
    }
  }, 300_000);
});
