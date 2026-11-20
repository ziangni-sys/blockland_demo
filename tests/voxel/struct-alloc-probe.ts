/**
 * Child-process probe for tests/voxel/alloc.test.ts (not a test file itself): heap bytes per call
 * of the per-tick structure queries of voxel/shape.ts (boxOverlapsSolid, hasSupportBelow,
 * columnHasSolidBelow, deepestPenetration with `out`, with and without a lean) against a StructureGrid, measured by
 * tests/heap-probe.ts and run by tests/heap-probe-run.ts in both inlining conditions.
 *
 * Every such query sees the box in the grid's local space through a local box (shape.ts LocalObb).
 * The grid owns one for its queries to reuse (StructureGrid.queryBox), so a query allocates nothing:
 * not the local box, not its SAT axes (built once per box and kept), not the box coordinates (the
 * queries hand them on in objects, never as fresh doubles to another function).
 *
 * Two decks of 8 x 8 cells, the bodies' boxes on and around them: one of planks (full blocks: the M1
 * paths), one of lower half slabs with a two-cell wall of planks (a layered grid). Each deck in two
 * poses: turned 90 degrees about y (axis-aligned: no SAT) and heeled 9 degrees about x and turned
 * 0.4 about y (the SAT paths).
 */
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { qmul, vec3, type AABB } from '../../src/core/math';
import { boxOverlapsSolid, columnHasSolidBelow, deepestPenetration, hasSupportBelow, type Penetration, type PushOptions } from '../../src/voxel/shape';
import type { StructureGrid } from '../../src/voxel/sgrid';
import { measureCases } from '../heap-probe';
import { LOWER, slab } from '../shapes';
import { axisAngle, box, emptyWorld, structure } from './helpers';

const world = emptyWorld();
const PLANKS = makeCell(B.PLANKS_OAK);
const SLAB = slab(B.PLANKS_OAK, LOWER);

/** A deck (cells x 0..7, z 0..7 at y 0) of `floor` with a wall of planks two high along x = 7; the pivot at its top centre. */
function deck(id: number, floor: number, aligned: boolean): StructureGrid {
  const q = aligned ? axisAngle(0, 1, 0, Math.PI / 2) : qmul(axisAngle(0, 1, 0, 0.4), axisAngle(1, 0, 0, (9 * Math.PI) / 180));
  const g = structure(world, id, vec3(0, 40, 0), q, vec3(4, 1, 4));
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) g.setCell(x, 0, z, floor);
  for (let z = 0; z < 8; z++) for (let y = 1; y < 3; y++) g.setCell(7, y, z, PLANKS);
  return g;
}

/** Body boxes (0.6 x 1.8) on the deck's top surface (local y `top`) at local (x, z), `lift` above it, as world boxes. */
function bodies(g: StructureGrid, top: number, lift: number): AABB[] {
  const out: AABB[] = [];
  for (const [x, z] of [
    [2.5, 2.5],
    [4.1, 5.3],
    [6.2, 3.9],
  ] as const) {
    const c = g.toWorld(vec3(x, top + lift, z));
    out.push(box(c.x - 0.3, c.y, c.z - 0.3, c.x + 0.3, c.y + 1.8, c.z + 0.3));
  }
  return out;
}

const out: Penetration = { nx: 0, ny: 0, nz: 0, depth: 0, cx: 0, cy: 0, cz: 0, octant: 0 };
/** A lean (PushOptions.prefer) up and a little sideways, with a fractional weight (as the body mover passes). */
const LEAN: PushOptions = { prefer: vec3(0.28, 0.96, 0), preferWeight: 0.35 };

const cases: Record<string, (n: number) => number> = {};
let nextId = 1;
for (const [label, floor, top] of [
  ['planks', PLANKS, 1],
  ['half slabs', SLAB, 0.5],
] as const) {
  for (const aligned of [true, false]) {
    const g = deck(nextId++, floor, aligned);
    const pose = aligned ? 'aligned' : 'heeled';
    // Standing on the top (a hair above, as a body that settled), and sunk 0.05 into it.
    const on = bodies(g, top, 0.001);
    const sunk = bodies(g, top, -0.05);
    // One function per case so each gets its own optimised code and feedback.
    cases[`overlap, ${label} deck ${pose}, standing`] = (n) => {
      let s = 0;
      for (let i = 0; i < n; i++) if (boxOverlapsSolid(g, on[i % 3]!)) s++;
      return s;
    };
    cases[`overlap, ${label} deck ${pose}, sunk`] = (n) => {
      let s = 0;
      for (let i = 0; i < n; i++) if (boxOverlapsSolid(g, sunk[i % 3]!)) s++;
      return s;
    };
    cases[`hasSupportBelow, ${label} deck ${pose}`] = (n) => {
      let s = 0;
      for (let i = 0; i < n; i++) if (hasSupportBelow(g, on[i % 3]!, 0.08, 0.1)) s++;
      return s;
    };
    cases[`columnHasSolidBelow, ${label} deck ${pose}`] = (n) => {
      let s = 0;
      for (let i = 0; i < n; i++) if (columnHasSolidBelow(g, on[i % 3]!, 2.5, 0.1)) s++;
      return s;
    };
    cases[`deepestPenetration with out, ${label} deck ${pose}, sunk`] = (n) => {
      let s = 0;
      for (let i = 0; i < n; i++) if (deepestPenetration(g, sunk[i % 3]!, undefined, out) !== null) s++;
      return s + out.cx;
    };
    cases[`deepestPenetration with out and a lean, ${label} deck ${pose}, sunk`] = (n) => {
      let s = 0;
      for (let i = 0; i < n; i++) if (deepestPenetration(g, sunk[i % 3]!, LEAN, out) !== null) s++;
      return s + out.cx;
    };
  }
}

await measureCases(cases);
