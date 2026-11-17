/**
 * Review (robustness): World-path box queries must terminate for non-finite box coordinates.
 *
 * Today a box with a -Infinity coordinate makes several World-path queries loop forever:
 * the candidate range starts at Math.floor(-Infinity) = -Infinity, `x++` never advances it,
 * and World.getCell(-Infinity, ...) maps (via -Infinity >> 4 === 0) onto the loaded chunk 0,
 * whose air never ends the scan. NaN boxes are already rejected (`!(max >= min)`); ±Infinity
 * slips through that guard. A single bad entity position would freeze the whole tab with no
 * exception to catch.
 *
 * To keep this file from hanging the suite, the world below throws once a query has read
 * more cells than any finite player-sized query could need. Each test therefore FAILS FAST
 * (with "cell read budget exceeded") instead of hanging, and passes once the queries reject
 * or clamp non-finite input.
 */
import { describe, expect, it } from 'vitest';
import { aabb, type AABB } from '../../src/core/math';
import { Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import {
  boxOverlapsSolid,
  columnHasSolidBelow,
  deepestPenetration,
  forEachSolidCellOverlapping,
  hasSupportBelow,
  nearestFreeOffset,
  resolvePenetration,
  sweepAxis,
} from '../../src/voxel/shape';

const READ_BUDGET = 200_000;

/** A world that refuses to be scanned forever. */
class BudgetWorld extends World {
  reads = 0;
  override getCell(x: number, y: number, z: number): number {
    if (++this.reads > READ_BUDGET) throw new Error('cell read budget exceeded (query does not terminate)');
    return super.getCell(x, y, z);
  }
}

function airWorld(): BudgetWorld {
  const w = new BudgetWorld(1);
  for (let cx = -2; cx <= 1; cx++) for (let cz = -2; cz <= 1; cz++) w.addChunk(new Chunk(cx, cz));
  w.takeDirtySections();
  return w;
}

/** Player-sized box floating in air, with one coordinate pushed to infinity. */
const boxes: Array<[string, AABB]> = [
  ['minX = -Infinity', aabb(-Infinity, 10, 0.2, 0.5, 11.8, 0.8)],
  ['minZ = -Infinity', aabb(0.2, 10, -Infinity, 0.8, 11.8, 0.5)],
  ['minX = -Infinity, maxX = +Infinity', aabb(-Infinity, 10, 0.2, Infinity, 11.8, 0.8)],
];

describe('review: World-path queries terminate for non-finite boxes', () => {
  for (const [label, b] of boxes) {
    it(`boxOverlapsSolid (${label})`, () => {
      const w = airWorld();
      expect(() => boxOverlapsSolid(w, b)).not.toThrow();
    });
    it(`forEachSolidCellOverlapping (${label})`, () => {
      const w = airWorld();
      expect(() => forEachSolidCellOverlapping(w, b, () => {})).not.toThrow();
    });
    it(`deepestPenetration / resolvePenetration (${label})`, () => {
      const w = airWorld();
      expect(() => deepestPenetration(w, b)).not.toThrow();
      w.reads = 0;
      expect(() => resolvePenetration(w, b)).not.toThrow();
    });
    it(`hasSupportBelow / columnHasSolidBelow (${label})`, () => {
      const w = airWorld();
      expect(() => hasSupportBelow(w, b, 0.05)).not.toThrow();
      w.reads = 0;
      expect(() => columnHasSolidBelow(w, b, 3)).not.toThrow();
    });
    it(`sweepAxis, every axis (${label})`, () => {
      const w = airWorld();
      for (const axis of [0, 1, 2] as const) {
        for (const d of [-0.5, 0.5]) {
          w.reads = 0;
          let r = 0;
          expect(() => {
            r = sweepAxis(w, b, axis, d);
          }).not.toThrow();
          expect(Number.isNaN(r)).toBe(false);
        }
      }
    });
    it(`nearestFreeOffset (${label})`, () => {
      const w = airWorld();
      expect(() => nearestFreeOffset([w], b, 1)).not.toThrow();
    });
  }
});
