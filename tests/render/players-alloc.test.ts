/**
 * The other players' path creates no objects per frame (tests/render/players-alloc-probe.ts,
 * bundled and run in a fresh node process like tests/drive/alloc.test.ts): the view builder's
 * entries, motion tracks and light samples are pooled, and the renderer's player views, their
 * walk, postures, held items and name tags reuse their objects (a tag's texture is made once per
 * text). What the sampling profiler still sees are numbers: V8 boxes a fractional double passed to
 * a function it did not inline (three's Vector3.set / Euler.set calls of every part of the model,
 * the world's light lookups), about 40 B per entry in the view builder and 100 to 200 B per player
 * in the renderer, measured over four players. The bounds (128 B per entry, 256 B per player, the
 * per-tick bound of tests/drive/alloc.test.ts) sit above that: a per-frame array, map or label
 * texture per player, or several vectors, fail them.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

async function bundleProbe(): Promise<string> {
  const { rolldown } = await import('rolldown');
  const bundle = await rolldown({ input: fileURLToPath(new URL('./players-alloc-probe.ts', import.meta.url)), platform: 'node', logLevel: 'silent' });
  try {
    const { output } = await bundle.generate({ format: 'esm' });
    return output[0].code;
  } finally {
    await bundle.close();
  }
}

describe('the other players cost no objects per frame (bundled, optimised code)', () => {
  it('view builder and renderer: nothing but boxed numbers per frame', async () => {
    const code = await bundleProbe();
    const run = spawnSync(process.execPath, ['--input-type=module', '-'], { input: code, encoding: 'utf8', timeout: 180_000 });
    expect(run.status, run.stderr).toBe(0);
    const res = JSON.parse(run.stdout.trim().split('\n').pop()!) as { bytesPerCall: Record<string, number>; labels: number };
    const report = Object.entries(res.bytesPerCall)
      .map(([k, v]) => `${k}: ${v.toFixed(2)} B/frame`)
      .join('\n');
    const out = process.env.PLAYERS_ALLOC_OUT;
    if (out) writeFileSync(out, report + '\n');
    expect(res.labels).toBe(3);
    // Four entries / players per frame.
    expect(res.bytesPerCall['view builder']!, report).toBeLessThan(4 * 128);
    expect(res.bytesPerCall.renderer!, report).toBeLessThan(4 * 256);
  }, 240_000);
});
