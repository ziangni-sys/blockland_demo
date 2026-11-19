/**
 * Allocation of rays (voxel/raycast.ts; the aim ray runs every tick on the server and every frame
 * on the client): a ray allocates its hit (GridHit and its point) and nothing else, whatever
 * partial cells it passes or hits, with default inlining and with inlining nearly off. The probe
 * (tests/voxel/ray-alloc-probe.ts) runs bundled in a fresh node process, see
 * tests/heap-probe-run.ts for why.
 *
 * Bytes per ray vary by a few boxed numbers (16 bytes each) with V8's feedback, so the cases are
 * compared with each other and with generous margins, not pinned. What the margins exclude: a
 * per-ray object for the octant walk (about 400 bytes, the first version of the octant walk); the
 * packed value of a two-part cell stored in an object field that held small integers (about 270
 * bytes per two-part hit); the world's ray copied into two fresh vectors when V8 does not inline
 * World.toLocal (about 200 bytes per world ray, seen through raycastGrids).
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { heapReport, INLINING_CONDITIONS, runHeapProbe } from '../heap-probe-run';

/** Slack over a reference case: a few boxed doubles whose boxing depends on V8's feedback. */
const SLACK = 64;

describe('rays allocate only their hit (bundled, both inlining conditions)', () => {
  it('full blocks, slabs, two-part cells, passing partial cells; World, rotated StructureGrid, raycastGrids', async () => {
    const result = await runHeapProbe(fileURLToPath(new URL('./ray-alloc-probe.ts', import.meta.url)));
    const report = heapReport(result);
    expect(Object.keys(result).length).toBe(INLINING_CONDITIONS.length);
    for (const c of Object.values(result)) {
      expect(Object.keys(c).length, report).toBe(15);
      // No hit: nothing at all, also through slabs and two-part cells (the profiler's own
      // plumbing is ~0.1 B per call).
      for (const k of ['world: miss through air', 'world: over three slabs, miss', 'world: through three two-part cells, miss']) expect(c[k], `${k}\n${report}`).toBeLessThan(1);
      // A world hit: the GridHit, its point and their boxed doubles (~220-260 bytes).
      const worldHit = c['world: full block hit']!;
      expect(worldHit, report).toBeLessThan(300);
      // Hits on and behind partial cells cost what a full block's does; a two-part hit adds the
      // packed cell, one heap number.
      for (const k of [
        'world: slab hit (cell face)',
        'world: slab top hit (inner face)',
        'world: over three slabs to a full block',
        'world: through three two-part cells to a full block',
        'world: two-part cell hit, lower part',
        'world: two-part cell hit, upper part',
      ])
        expect(c[k], `${k}\n${report}`).toBeLessThan(worldHit + SLACK);
      // The same in a rotated structure (its ray allocates its local origin and direction too).
      const shipHit = c['ship: full block hit']!;
      for (const k of ['ship: slab top hit (inner face)', 'ship: two-part cell hit']) expect(c[k], `${k}\n${report}`).toBeLessThan(shipHit + SLACK);
      // Over the world and a structure: the world's part costs its hit only, also where V8 does
      // not inline World.toLocal into a raycastGrid that sees both grid classes.
      expect(c['raycastGrids world+ship: world block hit'], report).toBeLessThan(c['raycastGrids ship only: miss']! + worldHit + 2 * SLACK);
    }
  }, 240_000);
});
