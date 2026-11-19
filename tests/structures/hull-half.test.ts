/**
 * What P2 delivers early in structures/hull.ts (docs/SHAPES.md 12.1): isDryHalf takes integer
 * half-cell coordinates and, until the hull analysis works per octant, answers isDryCell of the
 * cell holding them, so the four callers switched to it (entities/fluids.ts, client/view.ts,
 * sim/rays.ts, sim/explosion.ts) behave bit for bit as before; hullCavityCells moved here unchanged.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { Rng } from '../../src/core/rng';
import { analyzeHull, hullCavityCells, hullKindAt, isDryCell, isDryHalf, HULL_BILGE, HULL_SEALED } from '../../src/structures/hull';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';

/** A closed 5 x 4 x 5 box of planks (a sealed cavity inside) beside an open-topped tub (bilge). */
function hullGrid(): StructureGrid {
  const g = new StructureGrid(1, new World());
  const P = makeCell(B.PLANKS_OAK);
  for (let x = -3; x <= 1; x++) for (let y = -1; y <= 2; y++) for (let z = -2; z <= 2; z++) {
    const shell = x === -3 || x === 1 || y === -1 || y === 2 || z === -2 || z === 2;
    if (shell) g.setCell(x, y, z, P);
  }
  for (let x = 2; x <= 6; x++) for (let y = -1; y <= 1; y++) for (let z = -2; z <= 2; z++) {
    const wall = x === 2 || x === 6 || y === -1 || z === -2 || z === 2;
    if (wall) g.setCell(x, y, z, P);
  }
  return g;
}

describe('isDryHalf', () => {
  it('equals isDryCell at the floored point for any point, negative coordinates included', () => {
    const h = analyzeHull(hullGrid())!;
    expect(h.sealedCount).toBeGreaterThan(0);
    expect(h.bilgeCount).toBeGreaterThan(0);
    const rng = new Rng(3);
    let dry = 0;
    for (let i = 0; i < 20_000; i++) {
      const p = { x: rng.range(-5, 8), y: rng.range(-3, 4), z: rng.range(-4, 4) };
      const a = isDryHalf(h, Math.floor(p.x * 2), Math.floor(p.y * 2), Math.floor(p.z * 2));
      const b = isDryCell(h, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      expect(a).toBe(b);
      if (a) dry++;
    }
    expect(dry).toBeGreaterThan(100);
    // The eight octants of a dry cell are all dry; of a solid cell none.
    for (let o = 0; o < 8; o++) {
      expect(isDryHalf(h, -2 * 2 + (o & 1), 0 + ((o >> 1) & 1), 0 + ((o >> 2) & 1))).toBe(true);
      expect(isDryHalf(h, -3 * 2 + (o & 1), 0 + ((o >> 1) & 1), 0 + ((o >> 2) & 1))).toBe(false);
    }
  });
});

describe('hullCavityCells (moved from assembly.ts)', () => {
  it('lists every bilge and sealed cell once, as x,y,z triples', () => {
    const h = analyzeHull(hullGrid())!;
    const list = hullCavityCells(h);
    expect(list.length).toBe(3 * (h.bilgeCount + h.sealedCount));
    const seen = new Set<string>();
    for (let i = 0; i < list.length; i += 3) {
      const k = hullKindAt(h, list[i]!, list[i + 1]!, list[i + 2]!);
      expect(k === HULL_BILGE || k === HULL_SEALED).toBe(true);
      seen.add(`${list[i]},${list[i + 1]},${list[i + 2]}`);
    }
    expect(seen.size).toBe(h.bilgeCount + h.sealedCount);
  });
});
