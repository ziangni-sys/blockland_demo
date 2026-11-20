/**
 * The local box a StructureGrid keeps for its shape queries (StructureGrid.queryBox, voxel/shape.ts
 * takeObb / releaseObb). Every structure query sees the world box through a local box of about 0.85
 * to 1.4 KB; the grid's own one is reused query after query instead of one per query. Two rules
 * make that safe:
 *  - a query gives the box back when it is done, also when a callback it runs throws;
 *  - a query made while another query of the same grid holds the box (from the callback of
 *    forEachSolidCellOverlapping or nearestFreeOffset's extraTest) builds a box of its own, so it
 *    cannot change the box the outer query is still reading (its candidate range, its centre).
 * The nested queries below use boxes elsewhere on the deck than the outer one: had they rebuilt the
 * outer query's box, its loop would go on over their cell range.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { qmul, vec3, type AABB, type Vec3 } from '../../src/core/math';
import {
  boxOverlapsSolid,
  columnHasSolidBelow,
  deepestPenetration,
  forEachSolidCellOverlapping,
  hasSupportBelow,
  nearestFreeOffset,
  resolvePenetration,
} from '../../src/voxel/shape';
import type { StructureGrid } from '../../src/voxel/sgrid';
import { LOWER, slab, stairFill } from '../shapes';
import { PX } from '../../src/core/dirs';
import { axisAngle, box, emptyWorld, structure } from './helpers';

const PLANKS = makeCell(B.PLANKS_OAK);

/** A 6 x 6 deck of `floor` at local y 0 with a wall of stairs along x = 5 (cells x 0..5, z 0..5), turned `aligned` 90 degrees about y, else heeled 12 degrees and turned 0.3. */
function deck(id: number, floor: number, aligned: boolean): StructureGrid {
  const world = emptyWorld();
  const q = aligned ? axisAngle(0, 1, 0, Math.PI / 2) : qmul(axisAngle(0, 1, 0, 0.3), axisAngle(1, 0, 1, (12 * Math.PI) / 180));
  const g = structure(world, id, vec3(0.3, 30, -0.2), q, vec3(3, 1, 3));
  for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) g.setCell(x, 0, z, floor);
  for (let z = 0; z < 6; z++) g.setCell(5, 1, z, slab(B.BRICKS, stairFill(PX)));
  return g;
}

/** World boxes (body sized) around local points of the deck: on it, sunk into it, against the stairs, above it. */
function boxes(g: StructureGrid): AABB[] {
  const out: AABB[] = [];
  for (const [x, y, z] of [
    [1.5, 1.01, 1.5],
    [2.2, 0.3, 3.7],
    [4.75, 1.1, 2.5],
    [3.4, 0.45, 0.6],
    [0.4, 2.5, 4.4],
    [4.2, 1.3, 4.9],
  ] as const) {
    const c = g.toWorld(vec3(x, y, z));
    out.push(box(c.x - 0.3, c.y, c.z - 0.3, c.x + 0.3, c.y + 1.8, c.z + 0.3));
  }
  return out;
}

/** Every per-box query's answer, as one string (penetrations and resolutions with their numbers). */
function answers(g: StructureGrid, bs: readonly AABB[]): string[] {
  return bs.map((b) => {
    const pen = deepestPenetration(g, b, { prefer: vec3(0, 1, 0), preferWeight: 0.3 });
    const res = resolvePenetration(g, b, 8);
    return JSON.stringify([
      boxOverlapsSolid(g, b),
      hasSupportBelow(g, b, 0.08, 0.1),
      columnHasSolidBelow(g, b, 1.5, 0.05),
      pen === null ? null : [pen.nx, pen.ny, pen.nz, pen.depth, pen.cx, pen.cy, pen.cz, pen.octant],
      [res.dx, res.dy, res.dz, res.resolved, res.iterations],
    ]);
  });
}

/** The cells forEachSolidCellOverlapping visits for `b`, in order. */
function visits(g: StructureGrid, b: AABB, during?: () => void): string[] {
  const out: string[] = [];
  forEachSolidCellOverlapping(g, b, (x, y, z, packed, octants) => {
    out.push(`${x},${y},${z}:${packed}:${octants}`);
    during?.();
  });
  return out;
}

const DECKS: Array<[string, number, boolean]> = [
  ['planks, aligned', PLANKS, true],
  ['planks, heeled', PLANKS, false],
  ['half slabs, aligned', slab(B.PLANKS_OAK, LOWER), true],
  ['half slabs, heeled', slab(B.PLANKS_OAK, LOWER), false],
];

describe('a structure grid keeps one local box for its queries (StructureGrid.queryBox)', () => {
  it('every query takes the grid box and gives it back: the same box serves query after query; an empty grid takes none', () => {
    const g = deck(1, slab(B.PLANKS_OAK, LOWER), false);
    const bs = boxes(g);
    expect(g.queryBox).toBe(null);
    boxOverlapsSolid(g, bs[0]!);
    const own = g.queryBox;
    expect(own).not.toBe(null);
    const runs: Array<[string, () => unknown]> = [
      ['boxOverlapsSolid', () => boxOverlapsSolid(g, bs[1]!)],
      ['hasSupportBelow', () => hasSupportBelow(g, bs[0]!, 0.08, 0.1)],
      ['columnHasSolidBelow', () => columnHasSolidBelow(g, bs[4]!, 3, 0)],
      ['deepestPenetration', () => deepestPenetration(g, bs[1]!)],
      ['resolvePenetration', () => resolvePenetration(g, bs[1]!)],
      ['forEachSolidCellOverlapping', () => visits(g, bs[2]!)],
      ['forEachSolidCellOverlapping, stopped by its callback', () => forEachSolidCellOverlapping(g, bs[2]!, () => true)],
      ['nearestFreeOffset', () => nearestFreeOffset([g.parent, g], bs[1]!, 2)],
      ['nearestFreeOffset, out of reach', () => nearestFreeOffset([g], box(500, 30, 500, 501, 32, 501), 1)],
    ];
    for (const [name, run] of runs) {
      run();
      expect(g.queryBoxBusy, name).toBe(false);
      expect(g.queryBox, name).toBe(own);
    }
    const empty = deck(2, PLANKS, false);
    for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) for (let y = 0; y < 2; y++) empty.setCell(x, y, z, 0);
    expect(boxOverlapsSolid(empty, bs[0]!)).toBe(false);
    expect(nearestFreeOffset([empty], bs[0]!, 1)).toEqual(vec3(0, 0, 0));
    expect(empty.queryBox).toBe(null);
  });

  it('a callback that throws still gives the box back', () => {
    const g = deck(3, PLANKS, false);
    const bs = boxes(g);
    expect(() =>
      forEachSolidCellOverlapping(g, bs[1]!, () => {
        throw new Error('callback');
      }),
    ).toThrow('callback');
    expect(g.queryBoxBusy).toBe(false);
    expect(() =>
      nearestFreeOffset([g], bs[1]!, 2, () => {
        throw new Error('extraTest');
      }),
    ).toThrow('extraTest');
    expect(g.queryBoxBusy).toBe(false);
  });

  for (const [name, floor, aligned] of DECKS) {
    it(`${name}: queries made from inside forEachSolidCellOverlapping (nested twice) and nearestFreeOffset on the same grid answer as they do alone, and the outer query visits what it visits alone`, () => {
      const g = deck(10, floor, aligned);
      const bs = boxes(g);
      const alone = answers(g, bs);
      const outerAlone = visits(g, bs[1]!);
      const innerAlone = visits(g, bs[2]!);
      expect(outerAlone.length).toBeGreaterThan(1);
      expect(innerAlone.length).toBeGreaterThan(0);
      // Nested once: every query from the outer callback; nested twice: a second iteration inside it.
      const nestedAnswers: string[][] = [];
      const innerVisits: string[][] = [];
      const outer = visits(g, bs[1]!, () => {
        nestedAnswers.push(answers(g, bs));
        innerVisits.push(visits(g, bs[2]!, () => nestedAnswers.push(answers(g, bs))));
      });
      expect(outer).toEqual(outerAlone);
      for (const v of innerVisits) expect(v).toEqual(innerAlone);
      for (const a of nestedAnswers) expect(a).toEqual(alone);
      expect(g.queryBoxBusy).toBe(false);

      // nearestFreeOffset holds the grid's box over its whole search; its extraTest queries the grid.
      const accept = (c: AABB): boolean => c.minY > bs[1]!.minY + 0.2;
      const plain = nearestFreeOffset([g], bs[1]!, 3, accept);
      const seen: string[][] = [];
      const nested = nearestFreeOffset([g], bs[1]!, 3, (c) => {
        if (seen.length < 40) seen.push(answers(g, bs));
        return accept(c);
      });
      expect(plain).not.toBe(null);
      expect(nested as Vec3).toEqual(plain as Vec3);
      expect(seen.length).toBeGreaterThan(0);
      for (const a of seen) expect(a).toEqual(alone);
      expect(g.queryBoxBusy).toBe(false);
    });
  }
});
