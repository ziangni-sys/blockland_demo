/**
 * The body mover creates no objects per tick (tests/drive/alloc-probe.ts, bundled and run in a
 * fresh node process like tests/voxel/alloc.test.ts): no vectors, arrays, closures or maps; the
 * structure cache reuses its records, its id map and its arrays.
 *
 * What the sampling profiler still sees on land (~100 B per tick) are numbers: V8 boxes a computed
 * fractional double passed to (or returned from) a function it did not inline, and the step passes
 * such doubles to the voxel queries (sweepAxis(grid, box, axis, delta) ...) and between the
 * collider's own steps. The bound below sits above that, so any per-tick object (a pose vector, a
 * sort closure, a re-grown array — what the old structure cache allocated) fails it.
 *
 * Against a structure the voxel queries allocate nothing either: each StructureGrid keeps the local
 * box its queries see the world box through (StructureGrid.queryBox; it used to be built per query,
 * about 0.85 KB, 1.4 KB with the SAT axes of a tilted grid, as in M1). So the deck cases are bounded in
 * absolute bytes too (docs/SHAPES.md 15): standing and walking on a moving deck, sneaking on a deck
 * of half slabs and on one of planks (the sneak guard's solidAtHalf probes), swimming over a hull of
 * half slabs and one of planks (the fluid samples' isDryHalf), each at the next step above what is
 * left (the mover's boxed numbers, the carry); and what partial cells add over the same scene in
 * whole cells stays < 256 B per tick. The sneaking case needs the structure's broadphase box to
 * bound its solid octants on the half-cell lattice (entities/structs.ts boundsTrim): a body standing
 * on a deck of lower half slabs is then outside it, as on a planks deck.
 *
 * The server's judgement of a client-driven player's move report (entities/drive.ts ReportJudge.check)
 * is measured the same way, per report: a jump in the world (boxed numbers only, < 768 B); standing
 * on a deck heeling 9 degrees in the open, and against its deck house on the side the deck's walls
 * lean toward, where the support probe's insets and the leaning-wall rule (clearOfLeaningWalls) ask
 * the deck more structure queries; and a report counting a landing no report showed, beside a mast
 * leaning away from the body on a raft heeling 7.5 degrees, whose ground search probes deeper than
 * the standing probe, slab by slab (underLeaningWalls): a few hundred structure queries. What is
 * left there is drive.ts's own (see the bounds).
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
  it('a player walking and jumping on land, and on half slabs and stairs: nothing but boxed numbers per tick; judging a move report: the same in the world, the leaning-wall rule bounded on a heeled deck', async () => {
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
      judgeVerdicts: Array<string | null>;
      mastLandedUnseen: boolean;
      deckWalker: { carried: number; local: number[] };
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
    expect(res.judgeVerdicts, 'the judged reports pass').toEqual([null, null, null, null]);
    expect(res.mastLandedUnseen, 'the report beside the mast landed where no report showed it').toBe(true);
    const [wx, wz] = res.slabWalkerXZ as [number, number];
    expect(Math.abs(wx - 24.5) < 6 && Math.abs(wz - 8.5) < 6, 'the slab walker stayed on its field').toBe(true);
    const [dx, dy, dz] = res.deckWalker.local as [number, number, number];
    expect(res.deckWalker.carried, 'the deck walker stayed on its deck').toBe(6);
    expect(dx > 4 && dx < 12 && dz > 4 && dz < 12 && Math.abs(dy - 21) < 0.01, 'the deck walker stayed on its deck').toBe(true);
    const b = res.bytesPerCall;
    // In the world: boxed numbers only (measured 101 and 107 B).
    expect(b['walk on land']!, report).toBeLessThan(256);
    expect(b['walk on slabs and stairs']!, report).toBeLessThan(256);
    // On decks: the structure queries allocate nothing (their local box is the grid's own); what is
    // left are the same boxed numbers as on land, plus the carry (measured: standing 242 to 259 B,
    // walking 261 to 278, sneaking 377 to 395, swimming 149 to 168; before the grid kept its box
    // 2.6 to 4.4 KB). The sneak guard's and the fluid samples' point queries on partial cells add
    // little over the same scene in whole cells (docs/SHAPES.md 15), and stay bounded as such.
    expect(b['stand on a moving deck']!, report).toBeLessThan(384);
    expect(b['walk on a moving deck']!, report).toBeLessThan(384);
    expect(b['sneak on a slab deck']!, report).toBeLessThan(512);
    expect(b['sneak on a planks deck']!, report).toBeLessThan(512);
    expect(b['swim over a slab hull']!, report).toBeLessThan(256);
    expect(b['swim over a planks hull']!, report).toBeLessThan(256);
    expect(b['sneak on a slab deck']! - b['sneak on a planks deck']!, report).toBeLessThan(256);
    expect(b['swim over a slab hull']! - b['swim over a planks hull']!, report).toBeLessThan(256);
    // Judging a report: in the world nothing but boxed numbers (measured 260 to 440 B). On a heeled
    // deck the checks ask the deck dozens of structure queries (the support probe's insets, the
    // leaning-wall rule's strips; the search for the ground of a landing nobody saw a few hundred):
    // what is left is drive.ts's own (a Penetration per hardDepth, numbers passed between its
    // helpers). Measured: in the open 726 to 904 B, beside the wall 943 to 1186 B, the landing beside
    // the mast 5.8 to 6.0 KB (before the grid kept its box: 7.4 KB, 18.8 KB and 235 KB).
    expect(b['judge a jump in the world']!, report).toBeLessThan(768);
    expect(b['judge standing on a heeled deck']!, report).toBeLessThan(1536);
    expect(b['judge standing on a heeled deck beside a wall']!, report).toBeLessThan(1536);
    expect(b['judge a landing nobody saw beside a leaning mast']!, report).toBeLessThan(8192);
  }, 120_000);
});
