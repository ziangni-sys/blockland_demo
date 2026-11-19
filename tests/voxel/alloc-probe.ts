/**
 * Child-process probe for tests/voxel/alloc.test.ts (not a test file itself): heap bytes per call
 * of the World fast paths of voxel/shape.ts, measured by tests/heap-probe.ts (bundled with
 * rolldown, V8's sampling heap profiler, best of several rounds of optimised code) and run by
 * tests/heap-probe-run.ts in both inlining conditions.
 *
 * Two groups of cases:
 *  - full blocks only (the M1 cases): all boxes, and every layer the sweeps below scan, lie inside
 *    chunk (0,0), which has no holes / second-part layers, so the M1 code paths run;
 *  - partial cells (docs/SHAPES.md 5.6 and section 15): a row of lower half slabs on a floor in
 *    chunk (-2,0), which has the layers: beside a slab, standing on a slab, sweeping along the row
 *    (not blocked), and the push-out with `out`.
 * Each group stays in one chunk, so World's single-entry chunk cache always hits (a miss
 * allocates inside World itself: a known contract issue, not this module's).
 */
import type { AABB } from '../../src/core/math';
import { B } from '../../src/blocks/defs';
import { boxOverlapsSolid, columnHasSolidBelow, deepestPenetration, hasSupportBelow, sweepAxis, type Penetration } from '../../src/voxel/shape';
import { measureCases } from '../heap-probe';
import { LOWER, slab } from '../shapes';
import { box, emptyWorld, fill } from './helpers';

const world = emptyWorld();
fill(world, -10, 0, -10, 10, 5, 10); // ground, top at y = 5
// Partial cells in chunk (-2, 0): a floor (top at 5) and a row of lower slabs on it along x
// (cells x -30..-20, z 4), top at 5.5.
fill(world, -31, 0, 1, -18, 5, 9);
for (let x = -30; x <= -20; x++) world.setCell(x, 5, 4, slab(B.STONE, LOWER));

const FREE: AABB[] = [box(2.2, 5, 2.2, 2.8, 6.8, 2.8), box(1.4, 5.3, 3.1, 2.2, 7.1, 3.7), box(7.7, 5.01, 4.7, 8.3, 6.81, 5.3)];
const SUNK: AABB[] = [box(2.2, 4.9, 2.2, 2.8, 6.7, 2.8), box(1.4, 4.3, 3.1, 2.2, 6.1, 3.7), box(7.7, 4.5, 4.7, 8.3, 6.3, 5.3)];
/** Bodies on the floor beside the slab row (their side on the row's face z = 4, or 0.1 away). */
const BESIDE: AABB[] = [box(-28.3, 5, 5, -27.7, 6.8, 5.6), box(-25.4, 5, 5.1, -24.8, 6.8, 5.7), box(-23.3, 5.2, 3.4, -22.7, 7, 4)];
/** Bodies standing on the slab row (feet at 5.5) and sunk into it. */
const ON: AABB[] = [box(-28.3, 5.5, 4.2, -27.7, 7.3, 4.8), box(-25.0, 5.5, 4.1, -24.4, 7.3, 4.7), box(-22.6, 5.5, 4.3, -22.0, 7.3, 4.9)];
const INTO: AABB[] = [box(-28.3, 5.45, 4.2, -27.7, 7.25, 4.8), box(-25.0, 5.3, 4.1, -24.4, 7.1, 4.7), box(-22.6, 5.4, 4.3, -22.0, 7.2, 4.9)];

const out: Penetration = { nx: 0, ny: 0, nz: 0, depth: 0, cx: 0, cy: 0, cz: 0, octant: 0 };

// One function per case so each gets its own optimised code and feedback.
await measureCases({
  'boxOverlapsSolid free': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (boxOverlapsSolid(world, FREE[i % 3]!)) s++;
    return s;
  },
  'boxOverlapsSolid sunk': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (boxOverlapsSolid(world, SUNK[i % 3]!)) s++;
    return s;
  },
  'hasSupportBelow free': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (hasSupportBelow(world, FREE[i % 3]!, 0.08, 0.1)) s++;
    return s;
  },
  'hasSupportBelow airborne': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (hasSupportBelow(world, FREE[i % 3]!, 0.005, 0.1)) s++;
    return s;
  },
  'columnHasSolidBelow free': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (columnHasSolidBelow(world, FREE[i % 3]!, 2.5, 0.1)) s++;
    return s;
  },
  // Sweeps: only unobstructed moves, which return `delta` itself. A sweep blocked short of a
  // whole cell returns a fresh fractional double, which any non-inlined function must box.
  'sweepAxis x free': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (sweepAxis(world, FREE[i % 3]!, 0, 0.5) === 0.5) s++;
    return s;
  },
  'sweepAxis -x free': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (sweepAxis(world, FREE[i % 3]!, 0, -0.5) === -0.5) s++;
    return s;
  },
  'sweepAxis z free': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (sweepAxis(world, FREE[i % 3]!, 2, 0.5) === 0.5) s++;
    return s;
  },
  'sweepAxis -z free': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (sweepAxis(world, FREE[i % 3]!, 2, -0.5) === -0.5) s++;
    return s;
  },
  'sweepAxis y up': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (sweepAxis(world, SUNK[i % 3]!, 1, 0.5) === 0.5) s++;
    return s;
  },
  'sweepAxis y down blocked at a whole cell': (n) => {
    let s = 0;
    // Feet exactly on the ground (minY = 5): blocked at once, the result is the literal 0.
    for (let i = 0; i < n; i++) if (sweepAxis(world, FREE[0]!, 1, -0.5) === 0) s++;
    return s;
  },
  'deepestPenetration with out, full blocks': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (deepestPenetration(world, SUNK[i % 3]!, undefined, out) !== null) s++;
    return s + out.cx;
  },
  // ---- partial cells
  'boxOverlapsSolid beside a slab row': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (boxOverlapsSolid(world, BESIDE[i % 3]!)) s++;
    return s;
  },
  'boxOverlapsSolid sunk into a slab': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (boxOverlapsSolid(world, INTO[i % 3]!)) s++;
    return s;
  },
  'hasSupportBelow on a slab top': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (hasSupportBelow(world, ON[i % 3]!, 0.08, 0.1)) s++;
    return s;
  },
  'sweepAxis along a slab row, on top (free)': (n) => {
    let s = 0;
    // (Literal deltas: a double chosen per call would be boxed by this loop, not by the query.)
    for (let i = 0; i < n; i++) if ((i & 1 ? sweepAxis(world, ON[i % 3]!, 0, 0.5) : sweepAxis(world, ON[i % 3]!, 0, -0.5)) !== 0.123) s++;
    return s;
  },
  'sweepAxis along a slab row, beside it (free)': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if ((i & 1 ? sweepAxis(world, BESIDE[i % 3]!, 0, 0.5) : sweepAxis(world, BESIDE[i % 3]!, 0, -0.5)) !== 0.123) s++;
    return s;
  },
  'sweepAxis y down blocked on a slab top': (n) => {
    let s = 0;
    // Feet exactly on the slabs (minY = 5.5): blocked at once, the literal 0.
    for (let i = 0; i < n; i++) if (sweepAxis(world, ON[i % 3]!, 1, -0.5) === 0) s++;
    return s;
  },
  'deepestPenetration with out, sunk into a slab': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (deepestPenetration(world, INTO[i % 3]!, undefined, out) !== null) s++;
    return s + out.octant;
  },
});
