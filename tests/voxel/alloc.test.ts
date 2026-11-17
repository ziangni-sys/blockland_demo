/**
 * Allocation regression check for the World fast paths of shape.ts. The brief requires zero
 * heap allocation per call in boxOverlapsSolid / sweepAxis on the World; hasSupportBelow and
 * columnHasSolidBelow share the same scan and run just as often.
 *
 * Why a child process: inside vitest the module transform (imports become getter calls on
 * namespace objects) changes how V8 optimises shape.ts, and the original regression (~30 B
 * per FREE-box query from World.getCell inlined into a y-innermost loop) did not reproduce
 * there. tests/voxel/alloc-probe.ts is therefore bundled with rolldown (the bundler the
 * production build uses) and run in a fresh node process; it reports sampled bytes per call.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

async function bundleProbe(): Promise<string> {
  // rolldown is vite 8's bundler; imported lazily so a broken toolchain fails this test only.
  const { rolldown } = await import('rolldown');
  const bundle = await rolldown({ input: fileURLToPath(new URL('./alloc-probe.ts', import.meta.url)), platform: 'node', logLevel: 'silent' });
  try {
    const { output } = await bundle.generate({ format: 'esm' });
    return output[0].code;
  } finally {
    await bundle.close();
  }
}

describe('World fast paths do not allocate (bundled, optimised code)', () => {
  it('boxOverlapsSolid / hasSupportBelow / columnHasSolidBelow / sweepAxis on free, sunk and airborne boxes', async () => {
    const code = await bundleProbe();
    const run = spawnSync(process.execPath, ['--input-type=module', '-'], { input: code, encoding: 'utf8', timeout: 60_000 });
    expect(run.status, run.stderr).toBe(0);
    const { bytesPerCall } = JSON.parse(run.stdout.trim().split('\n').pop()!) as { bytesPerCall: Record<string, number> };
    const report = Object.entries(bytesPerCall)
      .map(([k, v]) => `${k}: ${v.toFixed(2)} B/call`)
      .join('\n');
    expect(Object.keys(bytesPerCall).length).toBeGreaterThanOrEqual(9);
    // Sampling noise from the profiler's own promise plumbing is ~0.01 B/call at 100k calls;
    // one boxed double per call would be >= 12.
    for (const v of Object.values(bytesPerCall)) expect(v, report).toBeLessThan(0.25);
  }, 60_000);
});
