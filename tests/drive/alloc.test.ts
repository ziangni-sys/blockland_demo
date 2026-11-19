/**
 * The body mover creates no objects per tick (tests/drive/alloc-probe.ts, bundled and run in a
 * fresh node process like tests/voxel/alloc.test.ts): no vectors, arrays, closures or maps; the
 * structure cache reuses its records, its id map and its arrays.
 *
 * What the sampling profiler still sees on land (~190 B per tick) are numbers: V8 boxes a computed
 * fractional double passed to (or returned from) a function it did not inline, and the step passes
 * such doubles to the voxel queries (sweepAxis(grid, box, axis, delta) ...) and between the
 * collider's own steps. The bound below sits just above that, so any per-tick object (a pose
 * vector, a sort closure, a re-grown array — what the old structure cache allocated) fails it.
 * Against a structure the voxel queries also allocate their local box per query (voxel/shape.ts
 * structureObb); that case is only reported (DRIVE_ALLOC_OUT).
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

async function bundleProbe(): Promise<string> {
  const { rolldown } = await import('rolldown');
  const bundle = await rolldown({ input: fileURLToPath(new URL('./alloc-probe.ts', import.meta.url)), platform: 'node', logLevel: 'silent' });
  try {
    const { output } = await bundle.generate({ format: 'esm' });
    return output[0].code;
  } finally {
    await bundle.close();
  }
}

describe('the body mover creates no objects per tick (bundled, optimised code)', () => {
  it('a player walking and jumping on land: nothing but boxed numbers per tick', async () => {
    const code = await bundleProbe();
    const run = spawnSync(process.execPath, ['--input-type=module', '-'], { input: code, encoding: 'utf8', timeout: 120_000 });
    expect(run.status, run.stderr).toBe(0);
    const res = JSON.parse(run.stdout.trim().split('\n').pop()!) as { bytesPerCall: Record<string, number>; carried: number };
    const report = Object.entries(res.bytesPerCall)
      .map(([k, v]) => `${k}: ${v.toFixed(2)} B/tick`)
      .join('\n');
    const out = process.env.DRIVE_ALLOC_OUT;
    if (out) writeFileSync(out, report + '\n');
    expect(res.carried, 'the rider stood on the deck').toBe(5);
    expect(res.bytesPerCall['walk on land']!, report).toBeLessThan(256);
  }, 120_000);
});
