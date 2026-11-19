/**
 * Hull analysis with partial cells (docs/SHAPES.md 12.1-12.3): the flood on the mixed graph of
 * whole-cell and octant nodes, the per-octant kinds and queries, volumes, mass, centre of mass and
 * inertia per part, the cavity list and the renderer's dry mask.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { BLOCKS } from '../../src/blocks/registry';
import { canonCell } from '../../src/blocks/shapes';
import { Rng } from '../../src/core/rng';
import {
  analyzeHull,
  displacesWater,
  DRY_MASK_MAX_TEXELS,
  dryMask,
  hullCavityCells,
  hullKindAt,
  hullOctantKind,
  isDryCell,
  isDryHalf,
  HULL_BILGE,
  HULL_MIXED,
  HULL_OPEN,
  HULL_SEALED,
  HULL_SOLID,
  type HullInfo,
} from '../../src/structures/hull';
import { Ship } from '../../src/structures/structure';
import { World } from '../../src/voxel/world';
import { EAST, LOWER, NORTH, partsAt, slab, SOUTH, UPPER, WEST } from '../shapes';
import { boatOf, fillGrid, randomCell, referenceKind, referenceKinds } from './shapes-helpers';

const P = makeCell(B.PLANKS_OAK);

function newShip(): Ship {
  return new Ship(1, new World(0));
}

/** Every octant of the hull box (and one cell around it) agrees with the dense reference. */
function expectMatchesReference(s: Ship, h: HullInfo): void {
  const r = referenceKinds(s.grid);
  for (let y = h.oy - 1; y <= h.oy + h.sy; y++) {
    for (let z = h.oz - 1; z <= h.oz + h.sz; z++) {
      for (let x = h.ox - 1; x <= h.ox + h.sx; x++) {
        let kinds = 0;
        for (let o = 0; o < 8; o++) {
          const k = hullOctantKind(h, x, y, z, o);
          if (k !== referenceKind(r, x, y, z, o)) throw new Error(`octant ${o} of ${x},${y},${z}: ${k} vs reference ${referenceKind(r, x, y, z, o)}`);
          kinds |= 1 << k;
        }
        const uniform = (kinds & (kinds - 1)) === 0;
        const partial = (kinds & (1 << HULL_SOLID)) !== 0 && !uniform;
        const k = hullKindAt(h, x, y, z);
        expect(k === HULL_MIXED).toBe(!uniform || partial);
        if (uniform) expect(k).toBe(31 - Math.clz32(kinds));
      }
    }
  }
}

/** Counts and volumes recomputed from the octant kinds. */
function expectConsistentTotals(h: HullInfo): void {
  const whole = [0, 0, 0, 0];
  const eighths = [0, 0, 0, 0];
  for (let y = h.oy; y < h.oy + h.sy; y++) {
    for (let z = h.oz; z < h.oz + h.sz; z++) {
      for (let x = h.ox; x < h.ox + h.sx; x++) {
        const k = hullKindAt(h, x, y, z);
        if (k !== HULL_MIXED) whole[k]!++;
        for (let o = 0; o < 8; o++) eighths[hullOctantKind(h, x, y, z, o)]!++;
      }
    }
  }
  expect(h.solidCount).toBe(whole[HULL_SOLID]);
  expect(h.bilgeCount).toBe(whole[HULL_BILGE]);
  expect(h.sealedCount).toBe(whole[HULL_SEALED]);
  expect(h.solidVolume).toBe(eighths[HULL_SOLID]! / 8);
  expect(h.bilgeVolume).toBe(eighths[HULL_BILGE]! / 8);
  expect(h.sealedVolume).toBe(eighths[HULL_SEALED]! / 8);
  expect(h.maxDisplacement).toBe(h.solidVolume + h.bilgeVolume + h.sealedVolume);
  for (let k = 1; k < h.mixedIndex.length; k++) expect(h.mixedIndex[k]!).toBeGreaterThan(h.mixedIndex[k - 1]!);
}

describe('hull flood on the mixed graph (12.3)', () => {
  it('equals the dense half-cell flood octant by octant, on random grids of full, partial and two-part cells', () => {
    const rng = new Rng(43);
    let mixed = 0;
    let bilge = 0;
    let sealed = 0;
    for (let trial = 0; trial < 60; trial++) {
      const s = newShip();
      const nx = rng.int(2, 6);
      const ny = rng.int(2, 5);
      const nz = rng.int(2, 6);
      for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) s.grid.setCell(x, y, z, randomCell(rng));
      if (s.grid.count === 0) continue;
      const h = analyzeHull(s.grid)!;
      expectMatchesReference(s, h);
      expectConsistentTotals(h);
      mixed += h.mixedIndex.length;
      bilge += h.bilgeVolume;
      sealed += h.sealedVolume;
    }
    // the random grids did exercise every kind
    expect(mixed).toBeGreaterThan(100);
    expect(bilge).toBeGreaterThan(5);
    expect(sealed).toBeGreaterThan(0);
  });

  it('equals the dense flood for random boats: closed walls with random partial cells (rims, gaps, decks)', () => {
    const rng = new Rng(7);
    let mixedWhole = 0;
    let sealed = 0;
    for (let trial = 0; trial < 40; trial++) {
      const s = newShip();
      const w = rng.int(3, 6);
      const d = rng.int(3, 6);
      const ht = rng.int(2, 4);
      // the rim course: full blocks, lower slabs or random partial cells
      const rim = rng.int(0, 2);
      for (let y = 0; y < ht; y++) {
        for (let z = 0; z < d; z++) {
          for (let x = 0; x < w; x++) {
            const wall = y === 0 || x === 0 || z === 0 || x === w - 1 || z === d - 1;
            if (!wall) continue;
            let c = rng.chance(0.2) ? randomCell(rng, 0.1, 0, 0.3) : P;
            if (y === ht - 1 && y > 0 && rim === 1) c = rng.chance(0.8) ? slab(B.PLANKS_OAK, LOWER) : P;
            if (y === ht - 1 && y > 0 && rim === 2) c = randomCell(rng, 0, 0.3, 0.2);
            s.grid.setCell(x, y, z, c);
          }
        }
      }
      if (rng.chance(0.5)) for (let z = 1; z < d - 1; z++) for (let x = 1; x < w - 1; x++) s.grid.setCell(x, ht, z, randomCell(rng, 0, 0.7, 0.1));
      const h = analyzeHull(s.grid)!;
      expectMatchesReference(s, h);
      expectConsistentTotals(h);
      sealed += h.sealedVolume;
      for (let k = 0; k < h.mixedIndex.length; k++) {
        const kinds = h.mixedKinds[k]!;
        let solid = false;
        for (let o = 0; o < 8; o++) if (((kinds >> (2 * o)) & 3) === HULL_SOLID) solid = true;
        if (!solid) mixedWhole++;
      }
    }
    // empty cells split by a spill line in their middle, and sealed holds, occurred
    expect(mixedWhole).toBeGreaterThan(10);
    expect(sealed).toBeGreaterThan(1);
  });

  it('a ship of full blocks has no mixed cell; its volumes are its counts', () => {
    const s = boatOf(new World(0), 1, 0, 10, 0, 6, 5, 3, P);
    s.grid.setCell(2, 11, 2, makeCell(B.TORCH));
    const h = analyzeHull(s.grid)!;
    expect(h.mixedIndex.length).toBe(0);
    expect(h.mixedKinds.length).toBe(0);
    expect(h.solidVolume).toBe(h.solidCount);
    expect(h.bilgeVolume).toBe(h.bilgeCount);
    expect(h.sealedVolume).toBe(h.sealedCount);
    expect(h.bilgeCount).toBe(4 * 3 * 2);
    expectMatchesReference(s, h);
  });

  it('a rim of lower slabs: the hold cells of the rim layer are bilge below and open above (they hold water to half a cell)', () => {
    const s = boatOf(new World(0), 1, 0, 10, 0, 5, 5, 3, P, slab(B.PLANKS_OAK, LOWER));
    const h = analyzeHull(s.grid)!;
    expectMatchesReference(s, h);
    // the lowest hold layer is bilge as a whole; the rim layer (y = 12) is mixed
    expect(hullKindAt(h, 2, 11, 2)).toBe(HULL_BILGE);
    expect(hullKindAt(h, 2, 12, 2)).toBe(HULL_MIXED);
    for (let o = 0; o < 8; o++) expect(hullOctantKind(h, 2, 12, 2, o)).toBe((o >> 1) & 1 ? HULL_OPEN : HULL_BILGE);
    // the rim cells themselves: hard below, open above
    for (let o = 0; o < 8; o++) expect(hullOctantKind(h, 0, 12, 2, o)).toBe((o >> 1) & 1 ? HULL_OPEN : HULL_SOLID);
    // queries per octant: the lower half is dry while the boat floats
    expect(h.floats).toBe(true);
    expect(isDryHalf(h, 4, 24, 4)).toBe(true); // octant 0 of (2, 12, 2)
    expect(isDryHalf(h, 5, 24, 5)).toBe(true);
    expect(isDryHalf(h, 4, 25, 4)).toBe(false); // upper half
    expect(isDryCell(h, 2, 12, 2)).toBe(false);
    expect(isDryCell(h, 2, 11, 2)).toBe(true);
    expect(displacesWater(h, 2, 12, 2)).toBe(false);
    expect(h.bilgeVolume).toBe(9 + 9 / 2);
    // a boat that cannot float: no dry octant
    h.floats = false;
    expect(isDryHalf(h, 4, 24, 4)).toBe(false);
    expect(isDryCell(h, 2, 11, 2)).toBe(false);
  });

  it('a rim of upper slabs leaves its own layer open: water comes in under the slabs; the layer below stays bilge', () => {
    const s = boatOf(new World(0), 1, 0, 10, 0, 5, 5, 3, P, slab(B.PLANKS_OAK, UPPER));
    const h = analyzeHull(s.grid)!;
    expectMatchesReference(s, h);
    expect(hullKindAt(h, 2, 11, 2)).toBe(HULL_BILGE);
    expect(hullKindAt(h, 2, 12, 2)).toBe(HULL_OPEN);
    for (let o = 0; o < 8; o++) expect(hullOctantKind(h, 0, 12, 2, o)).toBe((o >> 1) & 1 ? HULL_SOLID : HULL_OPEN);
  });

  it('a cabin roofed with upper slabs on walls that reach the roof layer is sealed, the empty lower half of the roof layer too', () => {
    const s = newShip();
    // walls and floor of planks, 5 x 5 footprint, y 0..3; roof layer y = 3 of upper slabs inside the walls
    for (let y = 0; y <= 3; y++) {
      for (let z = 0; z < 5; z++) {
        for (let x = 0; x < 5; x++) {
          const wall = y === 0 || x === 0 || z === 0 || x === 4 || z === 4;
          if (wall) s.grid.setCell(x, y, z, P);
          else if (y === 3) s.grid.setCell(x, y, z, slab(B.PLANKS_OAK, UPPER));
        }
      }
    }
    const h = analyzeHull(s.grid)!;
    expectMatchesReference(s, h);
    expect(hullKindAt(h, 2, 1, 2)).toBe(HULL_SEALED);
    expect(hullKindAt(h, 2, 2, 2)).toBe(HULL_SEALED);
    for (let o = 0; o < 8; o++) expect(hullOctantKind(h, 2, 3, 2, o)).toBe((o >> 1) & 1 ? HULL_SOLID : HULL_SEALED);
    expect(h.sealedVolume).toBe(18 + 9 / 2);
    h.floats = false;
    expect(isDryHalf(h, 4, 6, 4)).toBe(true); // sealed is dry even when the ship sinks
    expect(isDryCell(h, 2, 2, 2)).toBe(true);
  });

  it('a cabin enclosed by slabs (vertical slab walls, lower slab floor, upper slab roof) is sealed and dry; the outer halves of its walls are open', () => {
    const s = newShip();
    for (let y = 0; y <= 4; y++) {
      for (let z = 0; z <= 4; z++) {
        for (let x = 0; x <= 4; x++) {
          const ex = x === 0 || x === 4;
          const ez = z === 0 || z === 4;
          if (y === 0 || y === 4) {
            if (!ex && !ez) s.grid.setCell(x, y, z, slab(B.PLANKS_OAK, y === 0 ? UPPER : LOWER));
            else s.grid.setCell(x, y, z, P);
          } else if (ex && ez) {
            s.grid.setCell(x, y, z, P);
          } else if (ex) {
            s.grid.setCell(x, y, z, slab(B.PLANKS_OAK, x === 0 ? EAST : WEST));
          } else if (ez) {
            s.grid.setCell(x, y, z, slab(B.PLANKS_OAK, z === 0 ? SOUTH : NORTH));
          }
        }
      }
    }
    const h = analyzeHull(s.grid)!;
    expectMatchesReference(s, h);
    for (let y = 1; y <= 3; y++) for (let z = 1; z <= 3; z++) for (let x = 1; x <= 3; x++) expect(hullKindAt(h, x, y, z)).toBe(HULL_SEALED);
    // the west wall cell (0, 2, 2) is an east slab: its west half is outside (open), nothing inside it
    for (let o = 0; o < 8; o++) expect(hullOctantKind(h, 0, 2, 2, o)).toBe(o & 1 ? HULL_SOLID : HULL_OPEN);
    // the floor cell (2, 0, 2) is an upper slab: its lower half is outside
    for (let o = 0; o < 8; o++) expect(hullOctantKind(h, 2, 0, 2, o)).toBe((o >> 1) & 1 ? HULL_SOLID : HULL_OPEN);
    h.floats = false;
    for (let hy = 2; hy < 8; hy++) expect(isDryHalf(h, 5, hy, 5)).toBe(true);
    expect(isDryHalf(h, 0, 4, 4)).toBe(false);
  });

  it('a torch in a gap of a slab rim does not stop the water (soft blocks are whole-cell nodes)', () => {
    const s = boatOf(new World(0), 1, 0, 10, 0, 5, 5, 3, P, slab(B.PLANKS_OAK, LOWER));
    s.grid.setCell(0, 11, 2, makeCell(B.TORCH)); // a hole in the wall below the rim, with a torch in it
    const h = analyzeHull(s.grid)!;
    expectMatchesReference(s, h);
    expect(hullKindAt(h, 2, 11, 2)).toBe(HULL_OPEN);
    expect(h.bilgeVolume).toBe(0);
  });
});

describe('isDryHalf, isDryCell, displacesWater and hullCavityCells per octant (12.1)', () => {
  it('isDryCell is all eight isDryHalf; displacesWater is all eight octants hard or dry (random grids)', () => {
    const rng = new Rng(11);
    let dryCells = 0;
    let dryHalves = 0;
    for (let trial = 0; trial < 30; trial++) {
      const s = newShip();
      for (let y = 0; y < 4; y++) for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) s.grid.setCell(x, y, z, randomCell(rng, 0.3, 0.4, 0.1));
      if (s.grid.count === 0) continue;
      const h = analyzeHull(s.grid)!;
      for (const floats of [true, false]) {
        h.floats = floats;
        for (let y = h.oy; y < h.oy + h.sy; y++) {
          for (let z = h.oz; z < h.oz + h.sz; z++) {
            for (let x = h.ox; x < h.ox + h.sx; x++) {
              let allDry = true;
              let allDisp = true;
              for (let o = 0; o < 8; o++) {
                const d = isDryHalf(h, 2 * x + (o & 1), 2 * y + ((o >> 1) & 1), 2 * z + (o >> 2));
                const k = hullOctantKind(h, x, y, z, o);
                expect(d).toBe(k === HULL_SEALED || (k === HULL_BILGE && floats));
                if (d) dryHalves++;
                allDry &&= d;
                allDisp &&= d || k === HULL_SOLID;
              }
              expect(isDryCell(h, x, y, z)).toBe(allDry);
              expect(displacesWater(h, x, y, z)).toBe(allDisp);
              if (allDry) dryCells++;
            }
          }
        }
      }
    }
    expect(dryCells).toBeGreaterThan(0);
    expect(dryHalves).toBeGreaterThan(dryCells * 8);
  });

  it('isDryHalf takes negative half coordinates (arithmetic shift)', () => {
    const s = boatOf(new World(0), 1, -6, -3, -6, 5, 5, 3, P, slab(B.PLANKS_OAK, LOWER));
    const h = analyzeHull(s.grid)!;
    // hold cell (-4, -1, -4) is the rim layer: lower half bilge
    expect(hullKindAt(h, -4, -1, -4)).toBe(HULL_MIXED);
    expect(isDryHalf(h, -8, -2, -8)).toBe(true);
    expect(isDryHalf(h, -7, -2, -7)).toBe(true);
    expect(isDryHalf(h, -8, -1, -8)).toBe(false);
  });

  it('hullCavityCells: cells without a hard octant that have a bilge or sealed octant, in box order', () => {
    const s = boatOf(new World(0), 1, 0, 10, 0, 5, 5, 3, P, slab(B.PLANKS_OAK, LOWER));
    const h = analyzeHull(s.grid)!;
    const list = hullCavityCells(h);
    const got = new Set<string>();
    for (let i = 0; i < list.length; i += 3) got.add(`${list[i]},${list[i + 1]},${list[i + 2]}`);
    // the 3 x 3 hold at y 11 (bilge) and y 12 (lower half bilge); not the rim cells (hard octants)
    expect(list.length / 3).toBe(18);
    for (let z = 1; z <= 3; z++) for (let x = 1; x <= 3; x++) expect(got.has(`${x},11,${z}`) && got.has(`${x},12,${z}`)).toBe(true);
    // box order: y, then z, then x ascending
    for (let i = 3; i < list.length; i += 3) {
      const a = [list[i - 2]!, list[i - 1]!, list[i - 3]!];
      const b = [list[i + 1]!, list[i + 2]!, list[i]!];
      expect(a[0]! < b[0]! || (a[0] === b[0] && (a[1]! < b[1]! || (a[1] === b[1] && a[2]! < b[2]!)))).toBe(true);
    }
  });
});

describe('volumes, mass, centre of mass and inertia per part (12.2)', () => {
  it('a lower stone slab: mass density x 4/8 at the slab centroid, the inertia of a 1 x 0.5 x 1 box', () => {
    const s = newShip();
    s.grid.setCell(3, 7, -2, slab(B.STONE, LOWER));
    const h = analyzeHull(s.grid)!;
    const m = BLOCKS[B.STONE]!.density / 2;
    expect(h.mass).toBeCloseTo(m, 12);
    expect(h.com.x).toBeCloseTo(3.5, 12);
    expect(h.com.y).toBeCloseTo(7.25, 12);
    expect(h.com.z).toBeCloseTo(-1.5, 12);
    expect(h.inertia[0]).toBeCloseTo((m * (0.25 + 1)) / 12, 12);
    expect(h.inertia[4]).toBeCloseTo((m * (1 + 1)) / 12, 12);
    expect(h.inertia[8]).toBeCloseTo((m * (1 + 0.25)) / 12, 12);
    for (const i of [1, 2, 3, 5, 6, 7]) expect(h.inertia[i]).toBeCloseTo(0, 12);
    expect(h.solidVolume).toBe(0.5);
    expect(h.maxDisplacement).toBe(0.5);
    expect(h.floats).toBe(false); // 1.3 > 0.5
  });

  it('a two-part cell (stone below, planks above): masses add at their centroids', () => {
    const s = newShip();
    s.grid.setCell(0, 0, 0, canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER)));
    const h = analyzeHull(s.grid)!;
    const ms = BLOCKS[B.STONE]!.density / 2;
    const mp = BLOCKS[B.PLANKS_OAK]!.density / 2;
    expect(h.mass).toBeCloseTo(ms + mp, 12);
    expect(h.com.y).toBeCloseTo((ms * 0.25 + mp * 0.75) / (ms + mp), 12);
    expect(hullKindAt(h, 0, 0, 0)).toBe(HULL_SOLID); // geometrically full
    expect(h.solidCount).toBe(1);
  });

  it('a cell filled by two planks halves weighs and turns like one planks block', () => {
    const a = newShip();
    a.grid.setCell(0, 0, 0, canonCell(slab(B.PLANKS_OAK, NORTH), slab(B.PLANKS_OAK, SOUTH)));
    a.grid.setCell(1, 0, 0, P);
    const b = newShip();
    b.grid.setCell(0, 0, 0, P);
    b.grid.setCell(1, 0, 0, P);
    const ha = analyzeHull(a.grid)!;
    const hb = analyzeHull(b.grid)!;
    expect(ha.mass).toBeCloseTo(hb.mass, 12);
    expect(ha.com.x).toBeCloseTo(hb.com.x, 12);
    for (let i = 0; i < 9; i++) expect(ha.inertia[i]).toBeCloseTo(hb.inertia[i]!, 12);
  });

  it('random grids: mass, centre and inertia equal the sums over every part octant by octant', () => {
    const rng = new Rng(5);
    for (let trial = 0; trial < 20; trial++) {
      const s = newShip();
      for (let y = 0; y < 3; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) s.grid.setCell(x, y, z, randomCell(rng, 0.3, 0.3, 0.2));
      if (s.grid.count === 0) continue;
      const h = analyzeHull(s.grid)!;
      // octant point masses: density / 8 at each occupied octant centre, own term m / 24
      const pts: Array<[number, number, number, number]> = [];
      s.grid.forEachCell((x, y, z) => {
        for (const p of partsAt(s.grid, x, y, z)) {
          for (let o = 0; o < 8; o++) {
            if (((p.fill >> o) & 1) === 0) continue;
            pts.push([BLOCKS[p.id]!.density / 8, x + 0.25 + 0.5 * (o & 1), y + 0.25 + 0.5 * ((o >> 1) & 1), z + 0.25 + 0.5 * (o >> 2)]);
          }
        }
      });
      let m = 0;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const [pm, x, y, z] of pts) {
        m += pm;
        cx += pm * x;
        cy += pm * y;
        cz += pm * z;
      }
      cx /= m;
      cy /= m;
      cz /= m;
      const I = new Float64Array(9);
      for (const [pm, x, y, z] of pts) {
        const rx = x - cx;
        const ry = y - cy;
        const rz = z - cz;
        I[0] += pm * (ry * ry + rz * rz) + pm / 24;
        I[4] += pm * (rx * rx + rz * rz) + pm / 24;
        I[8] += pm * (rx * rx + ry * ry) + pm / 24;
        I[1] -= pm * rx * ry;
        I[2] -= pm * rx * rz;
        I[5] -= pm * ry * rz;
      }
      I[3] = I[1]!;
      I[6] = I[2]!;
      I[7] = I[5]!;
      expect(h.mass).toBeCloseTo(m, 10);
      expect(h.com.x).toBeCloseTo(cx, 10);
      expect(h.com.y).toBeCloseTo(cy, 10);
      expect(h.com.z).toBeCloseTo(cz, 10);
      for (let i = 0; i < 9; i++) expect(h.inertia[i]).toBeCloseTo(I[i]!, 9);
    }
  });

  it('floats compares the mass with the displacing volume: a raft of planks slabs floats, of stone slabs sinks', () => {
    const planks = newShip();
    fillGrid(planks.grid, 0, 0, 0, 6, 0, 8, slab(B.PLANKS_OAK, LOWER));
    const hp = analyzeHull(planks.grid)!;
    expect(hp.maxDisplacement).toBe(63 / 2);
    expect(hp.mass).toBeCloseTo((63 * BLOCKS[B.PLANKS_OAK]!.density) / 2, 12);
    expect(hp.floats).toBe(true);
    const stone = newShip();
    fillGrid(stone.grid, 0, 0, 0, 6, 0, 8, slab(B.STONE, LOWER));
    expect(analyzeHull(stone.grid)!.floats).toBe(false);
  });
});

describe('dryMask for the renderer (12.8)', () => {
  it('without mixed cells: one texel per cell, scale 1 (as before)', () => {
    const s = boatOf(new World(0), 1, 0, 10, 0, 5, 5, 3, P);
    const h = analyzeHull(s.grid)!;
    const d = dryMask(h)!;
    expect(d.scale).toBe(1);
    expect(d.mask.length).toBe(h.sx * h.sy * h.sz);
    expect(d.mask.reduce((a, b) => a + b, 0)).toBe(18);
  });

  it('with mixed cells: one texel per octant (scale 2), dry octants set, in DryVolume order', () => {
    const s = boatOf(new World(0), 1, 0, 10, 0, 5, 5, 3, P, slab(B.PLANKS_OAK, LOWER));
    const h = analyzeHull(s.grid)!;
    const d = dryMask(h)!;
    expect(d.scale).toBe(2);
    const tx = h.sx * 2;
    const tz = h.sz * 2;
    expect(d.mask.length).toBe(tx * tz * h.sy * 2);
    let n = 0;
    for (let y = 0; y < h.sy * 2; y++) {
      for (let z = 0; z < tz; z++) {
        for (let x = 0; x < tx; x++) {
          const v = d.mask[x + z * tx + y * tx * tz]!;
          n += v;
          expect(v).toBe(isDryHalf(h, x + 2 * h.ox, y + 2 * h.oy, z + 2 * h.oz) ? 1 : 0);
        }
      }
    }
    expect(n).toBe(8 * (h.bilgeVolume + h.sealedVolume));
    h.floats = false;
    expect(dryMask(h)).toBeNull();
  });

  it(`falls back to one texel per cell when 8 texels per cell would exceed ${DRY_MASK_MAX_TEXELS}: dry when no octant is open and one is dry`, () => {
    const s = boatOf(new World(0), 1, 0, 10, 0, 5, 5, 3, P, slab(B.PLANKS_OAK, LOWER));
    // a cabin roofed with upper slabs elsewhere on the ship: its roof cells are hard above, sealed below
    for (let y = 10; y <= 13; y++) {
      for (let z = 0; z < 4; z++) {
        for (let x = 10; x < 14; x++) {
          const wall = y === 10 || x === 10 || z === 0 || x === 13 || z === 3;
          if (wall) s.grid.setCell(x, y, z, P);
          else if (y === 13) s.grid.setCell(x, y, z, slab(B.PLANKS_OAK, UPPER));
        }
      }
    }
    s.grid.setCell(-60, 0, -60, P);
    s.grid.setCell(50, 60, 60, P);
    const h = analyzeHull(s.grid)!;
    expect(h.kind.length * 8).toBeGreaterThan(DRY_MASK_MAX_TEXELS);
    const d = dryMask(h)!;
    expect(d.scale).toBe(1);
    const at = (x: number, y: number, z: number): number => d.mask[x - h.ox + (z - h.oz) * h.sx + (y - h.oy) * h.sx * h.sz]!;
    expect(at(2, 11, 2)).toBe(1); // bilge
    expect(at(2, 12, 2)).toBe(0); // lower half bilge, upper half open
    expect(at(11, 13, 1)).toBe(1); // hard above, sealed below: no open octant
    expect(at(11, 12, 1)).toBe(1);
  });
});
