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
 * structureObb, about 0.7 KB each, M1): the structure cases are reported (DRIVE_ALLOC_OUT), and
 * only what partial cells add on top of the same scene in whole cells is bounded where that is the
 * point of the case.
 *
 * docs/SHAPES.md 15 (P3): walking on half slabs and stairs < 256 B per tick (the world path with
 * partial cells, asserted). Sneaking on a deck of half slabs (the sneak guard's solidAtHalf probes)
 * and swimming beside a hull (the fluid samples' isDryHalf) are bounded as what partial cells add
 * over the same scene in whole cells: < 256 B per tick each (asserted; measured about +20 and
 * -30). Their absolute bytes are the structure queries' local boxes, as on any deck (M1 design;
 * the P3 fix report asks for a scratch box owned by the grid). The sneaking case needs the
 * structure's broadphase box to bound its solid octants on the half-cell lattice (entities/structs.ts
 * boundsTrim): a body standing on a deck of lower half slabs is then outside it, as on a planks
 * deck; with whole-cell bounds it was inside, and every tick asked three more structure queries
 * (+3.2 KB per tick).
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
  it('a player walking and jumping on land, and on half slabs and stairs: nothing but boxed numbers per tick', async () => {
    const code = await bundleProbe();
    const run = spawnSync(process.execPath, ['--input-type=module', '-'], { input: code, encoding: 'utf8', timeout: 120_000 });
    expect(run.status, run.stderr).toBe(0);
    const res = JSON.parse(run.stdout.trim().split('\n').pop()!) as {
      bytesPerCall: Record<string, number>;
      carried: number;
      sneakCarried: number[];
      sneakY: number[];
      slabWalkerXZ: number[];
      swimWet: boolean[];
    };
    const report = Object.entries(res.bytesPerCall)
      .map(([k, v]) => `${k}: ${v.toFixed(2)} B/tick`)
      .join('\n');
    const out = process.env.DRIVE_ALLOC_OUT;
    if (out) writeFileSync(out, report + '\n');
    expect(res.carried, 'the rider stood on the deck').toBe(5);
    expect(res.sneakCarried, 'the sneaking riders stayed on their decks').toEqual([11, 12]);
    expect(res.sneakY[0]!, 'on the slab top').toBeCloseTo(40.5, 4);
    expect(res.sneakY[1]!, 'on the planks top').toBeCloseTo(41, 4);
    expect(res.swimWet, 'the swimmers were in the water over the plates').toEqual([true, true]);
    const [wx, wz] = res.slabWalkerXZ as [number, number];
    expect(Math.abs(wx - 24.5) < 6 && Math.abs(wz - 8.5) < 6, 'the slab walker stayed on its field').toBe(true);
    const b = res.bytesPerCall;
    expect(b['walk on land']!, report).toBeLessThan(256);
    expect(b['walk on slabs and stairs']!, report).toBeLessThan(256);
    expect(b['sneak on a slab deck']! - b['sneak on a planks deck']!, report).toBeLessThan(256);
    expect(b['swim over a slab hull']! - b['swim over a planks hull']!, report).toBeLessThan(256);
  }, 120_000);
});
