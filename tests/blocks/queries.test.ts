/**
 * The value queries of docs/SHAPES.md section 3 (and the rotation of 2.5): a reference
 * implementation written from the specification's text (no fast paths) compared against
 * src/blocks/shapes.ts on every full-block value and on random layout-valid values; the light
 * examples of 7.1; the merge / carve properties over every pair of fills; the canonical order
 * (also after rotation); the tripwire on every function; totality.
 */
import { describe, expect, it } from 'vitest';
import { ALL_DIRS, NX, NY, PX, PY, PZ, type Dir } from '../../src/core/dirs';
import { Rng } from '../../src/core/rng';
import { CELL_MULTI_BIT, FULL_LIMIT, ID_MASK, PACK_SCALE, PART_MASK, makeCell, makePart } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { BLOCKS, CUTTABLE, EMIT, LIGHT_OPACITY, OPAQUE, SOLID } from '../../src/blocks/registry';
import {
  FILL_VOLUME,
  MERGE_LIMIT,
  MERGE_OK,
  MERGE_OVERLAP,
  canonCell,
  cellFill,
  cellProblem,
  cellsTouch,
  emitInto,
  faceCover,
  lightEmit,
  lightOpacity,
  lightOpen,
  mergeCells,
  mergeProblem,
  opaqueCover,
  opaqueFill,
  otherPart,
  partAt,
  partCount,
  rotateFill,
  rotatePacked,
  rotatePart,
  solidCover,
  solidFill,
  topCovered,
  volume8,
  withOctant,
  withoutOctant,
  withoutPartAt,
} from '../../src/blocks/shapes';
import { rotCell, rotCompose, type GridRot } from '../../src/structures/orient';
import { EAST, LOWER, NORTH, SOUTH, UPPER, WEST, slab, stairFill } from '../shapes';

// ---------------------------------------------------------------------------- reference

/** The parts of a packed cell, read bit by bit (section 3 "全域性"). */
function partsOf(c: number): number[] {
  const p1 = (c % PACK_SCALE) & PART_MASK;
  const p2 = Math.floor(c / PACK_SCALE);
  const out: number[] = [];
  if ((p1 & ID_MASK) !== 0) out.push(p1);
  if (p2 !== 0) out.push(p2);
  return out;
}
const fill = (p: number): number => ~(p >>> 16) & 0xff;
const id = (p: number): number => p & ID_MASK;
const union = (c: number, keep: (p: number) => boolean): number => partsOf(c).filter(keep).reduce((m, p) => m | fill(p), 0);

const ref = {
  solidFill: (c: number): number => union(c, (p) => SOLID[id(p)] === 1),
  opaqueFill: (c: number): number => union(c, (p) => OPAQUE[id(p)] === 1),
  cellFill: (c: number): number => partsOf(c).reduce((m, p) => m | (CUTTABLE[id(p)] === 1 ? fill(p) : 0xff), 0),
  partCount: (c: number): number => partsOf(c).length,
  partAt: (c: number, o: number): number => partsOf(c).find((p) => (fill(p) & (1 << o)) !== 0) ?? 0,
  lightOpacity(c: number): number {
    const below = partsOf(c).map((p) => LIGHT_OPACITY[id(p)]!).filter((v) => v < 15);
    if (below.length > 0) return Math.max(...below);
    return ref.opaqueFill(c) === 0xff ? 15 : 0;
  },
  lightEmit: (c: number): number => Math.max(0, ...partsOf(c).map((p) => EMIT[id(p)]!)),
  emitInto(dst: number, src: number, d: Dir): number {
    const oc = faceCover(ref.opaqueFill(dst), d);
    const lit = partsOf(src).filter((p) => (faceCover(fill(p), (d ^ 1) as Dir) & ~oc & 15) !== 0);
    return Math.max(0, ...lit.map((p) => EMIT[id(p)]!));
  },
};

/** Compare every 3.1 / 3.2 query against the reference on one value (and a neighbour value). */
function checkAgainstReference(c: number, n: number): void {
  expect(solidFill(c)).toBe(ref.solidFill(c));
  expect(opaqueFill(c)).toBe(ref.opaqueFill(c));
  expect(cellFill(c)).toBe(ref.cellFill(c));
  expect(partCount(c)).toBe(ref.partCount(c));
  expect(volume8(c)).toBe(FILL_VOLUME[ref.solidFill(c)]);
  expect(lightOpacity(c)).toBe(ref.lightOpacity(c));
  expect(lightEmit(c)).toBe(ref.lightEmit(c));
  expect(topCovered(c)).toBe(faceCover(ref.solidFill(c), PY) === 15);
  for (let o = 0; o < 8; o++) {
    const p = ref.partAt(c, o);
    expect(partAt(c, o)).toBe(p);
    const others = partsOf(c);
    const i = others.indexOf(p);
    expect(otherPart(c, o)).toBe(p === 0 || others.length < 2 ? 0 : others[1 - i]!);
  }
  for (const d of ALL_DIRS) {
    expect(solidCover(c, d)).toBe(faceCover(ref.solidFill(c), d));
    expect(opaqueCover(c, d)).toBe(faceCover(ref.opaqueFill(c), d));
    const e = (d ^ 1) as Dir;
    expect(cellsTouch(c, n, d)).toBe((faceCover(ref.solidFill(c), d) & faceCover(ref.solidFill(n), e)) !== 0);
    expect(lightOpen(c, n, d)).toBe((faceCover(ref.opaqueFill(c), d) | faceCover(ref.opaqueFill(n), e)) !== 15);
    expect(emitInto(c, n, d)).toBe(ref.emitInto(c, n, d));
  }
}

const REGISTERED = BLOCKS.filter((d) => d !== undefined).map((d) => d.id);
const CUTTABLE_IDS = REGISTERED.filter((i) => CUTTABLE[i] === 1);
const UNREGISTERED = [27, 99, 500, 1022];

/** A random value that passes the Cell layout check (13.1), often semantically invalid. */
function layoutValid(rng: Rng): number {
  const pickId = (allowZero: boolean): number => {
    const r = rng.next();
    if (allowZero && r < 0.1) return 0;
    if (r < 0.6) return CUTTABLE_IDS[rng.int(0, CUTTABLE_IDS.length - 1)]!;
    if (r < 0.85) return REGISTERED[rng.int(0, REGISTERED.length - 1)]!;
    return UNREGISTERED[rng.int(0, UNREGISTERED.length - 1)]!;
  };
  const holes = (): number => (rng.chance(0.2) ? 0 : rng.int(0, 254));
  const first = makePart(pickId(true), rng.int(0, 63), holes());
  if (rng.chance(0.4)) return first;
  return (first | CELL_MULTI_BIT) + makePart(pickId(false), rng.int(0, 63), holes()) * PACK_SCALE;
}

// ---------------------------------------------------------------------------- 3.1 / 3.2

describe('3.1 and 3.2 queries equal their definitions', () => {
  it('on every full-block value (fast paths)', () => {
    const neighbours = [0, makeCell(B.STONE), makeCell(B.GLASS), makeCell(B.LAMP), slab(B.STONE, UPPER), slab(B.LAMP, EAST)];
    for (let i = 0; i < 1024; i++) {
      for (const state of [0, 1, 63]) {
        const c = makeCell(i, state);
        checkAgainstReference(c, neighbours[(i + state) % neighbours.length]!);
      }
    }
  });

  it('on random layout-valid values, never throwing (totality)', () => {
    const rng = new Rng(2307);
    for (let k = 0; k < 4000; k++) {
      const a = layoutValid(rng);
      const b = layoutValid(rng);
      checkAgainstReference(a, b);
      checkAgainstReference(b, a);
      expect([MERGE_OK, MERGE_OVERLAP, MERGE_LIMIT]).toContain(mergeProblem(a, b));
      expect(typeof (cellProblem(a) ?? '')).toBe('string');
    }
  });

  it('examples of 3.1', () => {
    const lower = slab(B.STONE, LOWER);
    const two = canonCell(slab(B.STONE, LOWER), slab(B.GLASS, UPPER));
    expect(solidFill(makeCell(B.STONE))).toBe(0xff);
    expect(solidFill(0)).toBe(0);
    expect(solidFill(makeCell(B.WATER))).toBe(0);
    expect(solidFill(makeCell(B.TORCH))).toBe(0);
    expect(solidFill(makeCell(B.HELM))).toBe(0xff);
    expect(solidFill(makeCell(B.SAND))).toBe(0xff);
    expect(solidFill(lower)).toBe(LOWER);
    expect(solidFill(two)).toBe(0xff);
    expect(opaqueFill(two)).toBe(LOWER);
    expect(cellFill(makeCell(B.WATER))).toBe(0xff);
    expect(cellFill(makeCell(B.TORCH))).toBe(0xff);
    expect(cellFill(0)).toBe(0);
    expect(cellFill(lower)).toBe(LOWER);
    expect(partCount(0)).toBe(0);
    expect(partCount(lower)).toBe(1);
    expect(partCount(two)).toBe(2);
    expect(partAt(makeCell(B.HELM, 3), 6)).toBe(makeCell(B.HELM, 3));
    expect(partAt(0, 0)).toBe(0);
    expect(partAt(two, 7)).toBe(slab(B.GLASS, UPPER));
    expect(otherPart(two, 7)).toBe(slab(B.STONE, LOWER));
    expect(otherPart(two, 0)).toBe(slab(B.GLASS, UPPER));
    expect(otherPart(lower, 0)).toBe(0);
    expect(otherPart(lower, 7)).toBe(0);
    expect(volume8(slab(B.STONE, stairFill(NX)))).toBe(6);
    expect(volume8(makeCell(B.WATER))).toBe(0);
  });

  it('examples of 3.2: support and touching', () => {
    const upper = slab(B.PLANKS_OAK, UPPER);
    const lower = slab(B.PLANKS_OAK, LOWER);
    expect(topCovered(makeCell(B.STONE))).toBe(true);
    expect(topCovered(makeCell(B.GLASS))).toBe(true);
    expect(topCovered(makeCell(B.TORCH))).toBe(false);
    expect(topCovered(lower)).toBe(false);
    expect(topCovered(upper)).toBe(true);
    expect(topCovered(canonCell(slab(B.STONE, WEST), slab(B.PLANKS_OAK, EAST)))).toBe(true);
    // Scenario 42: an upper slab on an upper slab does not touch.
    expect(cellsTouch(upper, upper, PY)).toBe(false);
    expect(cellsTouch(lower, upper, PY)).toBe(false);
    expect(cellsTouch(upper, lower, PY)).toBe(true);
    // Lower and upper slab side by side meet along a line only.
    expect(cellsTouch(lower, upper, PX)).toBe(false);
    expect(cellsTouch(lower, lower, PX)).toBe(true);
    expect(cellsTouch(makeCell(B.STONE), slab(B.STONE, WEST), PX)).toBe(true);
    expect(cellsTouch(makeCell(B.STONE), slab(B.STONE, EAST), PX)).toBe(false);
    expect(cellsTouch(makeCell(B.HELM), makeCell(B.STONE), NY)).toBe(true);
  });
});

describe('light queries (7.1)', () => {
  const stone = makeCell(B.STONE);
  const air = 0;
  const lower = slab(B.STONE, LOWER);
  const upper = slab(B.STONE, UPPER);

  it('full blocks reduce to M1', () => {
    for (const i of REGISTERED) {
      const c = makeCell(i);
      expect(lightOpacity(c)).toBe(LIGHT_OPACITY[i]);
      expect(lightEmit(c)).toBe(EMIT[i]);
      for (const j of REGISTERED) {
        const n = makeCell(j);
        expect(lightOpen(c, n, PX)).toBe(OPAQUE[i] === 0 && OPAQUE[j] === 0);
        expect(emitInto(c, n, PX)).toBe(OPAQUE[i] === 1 ? 0 : EMIT[j]);
      }
    }
  });

  it('opacity of partial cells: the largest non-opaque part, else 15 only when opaque fills the cell', () => {
    expect(lightOpacity(lower)).toBe(0);
    expect(lightOpacity(slab(B.ICE, LOWER))).toBe(2);
    expect(lightOpacity(canonCell(lower, slab(B.ICE, UPPER)))).toBe(2);
    expect(lightOpacity(canonCell(slab(B.GLASS, LOWER), upper))).toBe(0);
    expect(lightOpacity(canonCell(lower, slab(B.LAMP, UPPER)))).toBe(15);
    expect(lightOpacity(canonCell(lower, slab(B.STONE, 0x0c)))).toBe(0);
  });

  it('roofs of scenario 44', () => {
    // Lower-slab roof: the top is open and op = 0, so sky light falls in; its bottom is sealed.
    expect(lightOpen(lower, air, PY)).toBe(true);
    expect(lightOpacity(lower)).toBe(0);
    expect(lightOpen(lower, air, NY)).toBe(false);
    // Upper-slab roof: sealed against the cell above; open below.
    expect(lightOpen(upper, air, PY)).toBe(false);
    expect(lightOpen(upper, air, NY)).toBe(true);
    // An upper slab on a wall that does not reach its layer: the side gap is open.
    expect(lightOpen(upper, air, PX)).toBe(true);
    // Alternating lower and upper slabs: each covers half the shared face, together sealed.
    expect(lightOpen(lower, upper, PX)).toBe(false);
    expect(lightOpen(upper, lower, PZ)).toBe(false);
    // Neither side alone covers the face.
    expect(opaqueCover(lower, PX)).not.toBe(15);
    expect(opaqueCover(upper, NX)).not.toBe(15);
    // Vertical slabs stacked in line let light through; offset by half a cell, sealed.
    const west = slab(B.STONE, WEST);
    const east = slab(B.STONE, EAST);
    expect(lightOpen(west, west, PY)).toBe(true);
    expect(lightOpen(east, west, PY)).toBe(false);
    expect(lightOpen(west, east, NY)).toBe(false);
  });

  it('a stone lower slab under a lamp upper slab lights its sides and top, not below', () => {
    const cell = canonCell(lower, slab(B.LAMP, UPPER));
    expect(lightEmit(cell)).toBe(15);
    // Bottom: covered by stone, nothing shines down.
    expect(lightOpen(air, cell, PY)).toBe(false);
    expect(emitInto(air, cell, PY)).toBe(0);
    // Sides: sealed by stone + lamp, but the lamp touches the upper two quadrants: 15 (the
    // neighbour then takes 15 - cost 1 = 14).
    for (const d of [PX, NX, PZ, 5] as Dir[]) {
      const toCell = (d ^ 1) as Dir;
      expect(lightOpen(air, cell, toCell)).toBe(false);
      expect(emitInto(air, cell, toCell)).toBe(15);
    }
    // Top: the lamp covers it.
    expect(emitInto(air, cell, NY)).toBe(15);
    // Upside down: dark above, lit below.
    const flipped = canonCell(slab(B.LAMP, LOWER), upper);
    expect(emitInto(air, flipped, NY)).toBe(0);
    expect(emitInto(air, flipped, PY)).toBe(15);
    // A neighbour that covers the lamp's quadrants with opaque material receives nothing.
    expect(emitInto(upper, cell, NX)).toBe(0);
    expect(emitInto(lower, cell, NX)).toBe(15);
  });

  it('a lamp slab shines through its own empty half', () => {
    const lamp = slab(B.LAMP, WEST);
    expect(lightOpen(air, lamp, NX)).toBe(true); // the east face of the lamp cell is open
    expect(emitInto(air, lamp, PY)).toBe(15); // touches the shared face with two quadrants
    expect(emitInto(stone, lamp, PY)).toBe(0);
  });
});

// ---------------------------------------------------------------------------- 3.3

/** Every unordered pair of disjoint non-empty fills (3025 of them), as [a, b]. */
function disjointPairs(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let a = 1; a < 256; a++) for (let b = a + 1; b < 256; b++) if ((a & b) === 0) out.push([a, b]);
  return out;
}
const lowestOctant = (f: number): number => Math.log2(f & -f);

describe('3.3 merging and splitting', () => {
  it('there are 3025 disjoint pairs', () => {
    expect(disjointPairs()).toHaveLength(3025);
  });

  it('mergeProblem / mergeCells over every pair of fills: canonical result, volume conserved', () => {
    for (let fa = 1; fa < 256; fa++) {
      const dest = slab(B.STONE, fa);
      for (let fb = 1; fb < 256; fb++) {
        const incoming = slab(B.PLANKS_OAK, fb, 3);
        const problem = mergeProblem(dest, incoming);
        if ((fa & fb) !== 0) {
          expect(problem).toBe(MERGE_OVERLAP);
          expect(() => mergeCells(dest, incoming)).toThrow(RangeError);
          continue;
        }
        expect(problem).toBe(MERGE_OK);
        const m = mergeCells(dest, incoming);
        expect(cellProblem(m)).toBeNull();
        expect(volume8(m)).toBe(FILL_VOLUME[fa]! + FILL_VOLUME[fb]!);
        expect(solidFill(m)).toBe(fa | fb);
        expect(partCount(m)).toBe(2);
        expect(m).toBe(mergeCells(incoming, dest)); // order comes from geometry, not from who arrived first
        expect(partAt(m, lowestOctant(fa | fb))).toBe(m & PART_MASK);
        // A third part never fits: it overlaps, or the cell already holds two.
        const rest = ~(fa | fb) & 0xff;
        if (rest !== 0) {
          expect(mergeProblem(m, slab(B.GLASS, rest))).toBe(MERGE_LIMIT);
          expect(() => mergeCells(m, slab(B.GLASS, rest))).toThrow(RangeError);
        }
        expect(mergeProblem(m, slab(B.GLASS, 1 << lowestOctant(fa)))).toBe(MERGE_OVERLAP);
      }
    }
  });

  it('mergeProblem order of rules: soft or empty targets, models and uncuttable blocks', () => {
    const half = slab(B.STONE, LOWER);
    for (const soft of [0, makeCell(B.WATER, 3), makeCell(B.TORCH), makeCell(B.TALL_GRASS), makeCell(B.SNOW_LAYER, 2)]) {
      expect(mergeProblem(soft, half)).toBe(MERGE_OK);
      expect(mergeCells(soft, half)).toBe(half);
      expect(mergeCells(soft, makeCell(B.HELM))).toBe(makeCell(B.HELM));
    }
    for (const hard of [makeCell(B.STONE), makeCell(B.HELM), makeCell(B.SAND), makeCell(B.TNT), makeCell(B.CACTUS)]) {
      expect(mergeProblem(hard, slab(B.STONE, 1))).toBe(MERGE_OVERLAP);
    }
    // Models and non-cuttable blocks never share a cell with a part.
    expect(mergeProblem(half, makeCell(B.TORCH))).toBe(MERGE_OVERLAP);
    expect(mergeProblem(half, makeCell(B.WATER))).toBe(MERGE_OVERLAP);
    expect(mergeProblem(half, makeCell(B.SAND))).toBe(MERGE_OVERLAP);
    expect(mergeProblem(half, 0)).toBe(MERGE_OK);
    expect(mergeCells(half, 0)).toBe(half);
    // Two slabs of the same material stay two parts (one item each).
    const same = mergeCells(slab(B.PLANKS_OAK, LOWER), slab(B.PLANKS_OAK, UPPER));
    expect(partCount(same)).toBe(2);
    expect(same).toBeGreaterThanOrEqual(FULL_LIMIT);
    expect(same & CELL_MULTI_BIT).not.toBe(0);
  });

  it('canonCell: the part with the lowest occupied octant comes first, whatever the argument order', () => {
    for (const [a, b] of disjointPairs()) {
      const pa = slab(B.STONE, a);
      const pb = slab(B.GLASS, b);
      const c = canonCell(pa, pb);
      expect(canonCell(pb, pa)).toBe(c);
      expect(cellProblem(c)).toBeNull();
      expect(c & PART_MASK).toBe(lowestOctant(a) < lowestOctant(b) ? pa : pb);
    }
    expect(canonCell(0, 0)).toBe(0);
    expect(canonCell(slab(B.STONE, LOWER), 0)).toBe(slab(B.STONE, LOWER));
    expect(canonCell(0, makeCell(B.TORCH))).toBe(makeCell(B.TORCH));
    expect(() => canonCell(slab(B.STONE, LOWER), slab(B.STONE, 0x3f))).toThrow(RangeError); // overlap
    expect(() => canonCell(makePart(B.SAND, 0, UPPER), 0)).toThrow(RangeError); // holes on an uncuttable block
    expect(() => canonCell(makePart(B.HELM, 0, UPPER), slab(B.STONE, UPPER))).toThrow(RangeError);
    expect(() => canonCell(makePart(B.STONE, 0, 0xff), 0)).toThrow(RangeError); // no octant
    expect(() => canonCell(0x0400, 0)).toThrow(RangeError); // id 0 with state
  });

  it('withoutOctant over every pair and octant: canonical, one octant less, parts removed when empty', () => {
    const cases: number[] = [];
    for (let f = 1; f < 256; f++) cases.push(slab(B.STONE, f));
    for (const [a, b] of disjointPairs()) cases.push(canonCell(slab(B.STONE, a), slab(B.PLANKS_PINE, b)));
    for (const c of cases) {
      for (let o = 0; o < 8; o++) {
        const r = withoutOctant(c, o);
        expect(cellProblem(r)).toBeNull();
        if ((solidFill(c) & (1 << o)) === 0) {
          expect(r).toBe(c);
          continue;
        }
        expect(solidFill(r)).toBe(solidFill(c) & ~(1 << o));
        expect(volume8(r)).toBe(volume8(c) - 1);
        const p = partAt(c, o);
        expect(partCount(r)).toBe(partCount(c) - (fill(p) === 1 << o ? 1 : 0));
        // withOctant puts it back into the same part.
        const po = lowestOctant(fill(p) & ~(1 << o) || 1 << o);
        if (fill(p) !== 1 << o) expect(withOctant(r, po, o)).toBe(c);
      }
    }
    expect(withoutOctant(makeCell(B.STONE), 3)).toBe(makePart(B.STONE, 0, 1 << 3));
    expect(withoutOctant(slab(B.STONE, 0x01), 0)).toBe(0);
    expect(() => withoutOctant(makeCell(B.HELM), 0)).toThrow(RangeError);
    expect(() => withoutOctant(makeCell(B.STONE), 8)).toThrow(RangeError);
  });

  it('withOctant over every pair and empty octant: canonical, one octant more, full part = full block', () => {
    for (const [a, b] of disjointPairs()) {
      const c = canonCell(slab(B.STONE, a), slab(B.PLANKS_PINE, b, 4));
      const empty = ~(a | b) & 0xff;
      for (let o = 0; o < 8; o++) {
        if ((empty & (1 << o)) === 0) {
          expect(() => withOctant(c, lowestOctant(a), o)).toThrow(RangeError);
          continue;
        }
        for (const po of [lowestOctant(a), lowestOctant(b)]) {
          const r = withOctant(c, po, o);
          expect(cellProblem(r)).toBeNull();
          expect(volume8(r)).toBe(volume8(c) + 1);
          expect(partAt(r, o)).toBe(partAt(r, po));
          expect(id(partAt(r, o))).toBe(id(partAt(c, po)));
          expect(withoutOctant(r, o)).toBe(c);
        }
      }
    }
    let c = slab(B.STONE, 0x01);
    for (let o = 1; o < 8; o++) c = withOctant(c, 0, o);
    expect(c).toBe(makeCell(B.STONE));
    expect(() => withOctant(0, 0, 1)).toThrow(RangeError); // no part at partOctant
    expect(() => withOctant(slab(B.STONE, LOWER), 2, 3)).toThrow(RangeError); // partOctant empty
  });

  it('withoutPartAt removes the part holding the octant', () => {
    const lower = slab(B.STONE, LOWER);
    const upper = slab(B.GLASS, UPPER);
    const two = canonCell(lower, upper);
    expect(withoutPartAt(two, 0)).toBe(upper);
    expect(withoutPartAt(two, 7)).toBe(lower);
    expect(cellProblem(withoutPartAt(two, 0))).toBeNull();
    expect(withoutPartAt(makeCell(B.STONE), 5)).toBe(0);
    expect(withoutPartAt(makeCell(B.TORCH), 5)).toBe(0);
    expect(withoutPartAt(lower, 7)).toBe(lower); // empty octant: unchanged
    expect(withoutPartAt(0, 0)).toBe(0);
    for (const [a, b] of disjointPairs()) {
      const c = canonCell(slab(B.STONE, a), slab(B.GLASS, b));
      expect(withoutPartAt(c, lowestOctant(a))).toBe(slab(B.GLASS, b));
      expect(withoutPartAt(c, lowestOctant(b))).toBe(slab(B.STONE, a));
    }
  });
});

// ---------------------------------------------------------------------------- 2.5 rotation

const ALL_ROTS: GridRot[] = [];
for (let ax = 0; ax < 6; ax++) {
  for (let ay = 0; ay < 6; ay++) {
    if (ax >> 1 === ay >> 1) continue;
    for (let az = 0; az < 6; az++) {
      if (az >> 1 === ax >> 1 || az >> 1 === ay >> 1) continue;
      // Keep the right-handed one: x cross y = z.
      const r = { ax, ay, az } as GridRot;
      const v = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      const [x, y, z] = [v[ax]!, v[ay]!, v[az]!];
      const c = [x[1]! * y[2]! - x[2]! * y[1]!, x[2]! * y[0]! - x[0]! * y[2]!, x[0]! * y[1]! - x[1]! * y[0]!];
      if (c[0] === z[0] && c[1] === z[1] && c[2] === z[2]) ALL_ROTS.push(r);
    }
  }
}

describe('2.5 rotating parts and packed cells', () => {
  it('there are 24 rotations', () => {
    expect(ALL_ROTS).toHaveLength(24);
  });

  it('on full blocks rotatePart equals the M1 rotCell for every block, state and rotation', () => {
    for (const r of ALL_ROTS) {
      for (const i of REGISTERED) {
        for (let s = 0; s < 64; s++) {
          const c = makeCell(i, s);
          expect(rotatePart(c, r.ax, r.ay, r.az)).toBe(rotCell(r, c));
          expect(rotatePacked(c, r.ax, r.ay, r.az)).toBe(rotCell(r, c));
        }
      }
    }
    expect(rotatePacked(makeCell(B.STONE), 5, 2, 0)).toBe(makeCell(B.STONE));
  });

  it('state and holes rotate independently', () => {
    for (const r of ALL_ROTS) {
      for (let f = 1; f < 255; f++) {
        for (const [blk, s] of [[B.LOG_OAK, 2], [B.PLANKS_OAK, 9], [B.LOG_PINE, 0]] as const) {
          const p = slab(blk, f, s);
          const q = rotatePart(p, r.ax, r.ay, r.az);
          expect(fill(q)).toBe(rotateFill(f, r.ax, r.ay));
          expect(q & 0xffff).toBe(rotCell(r, makeCell(blk, s)));
        }
      }
    }
  });

  it('rotatePacked re-sorts the parts (I6) and composes', () => {
    let swapsSeen = 0;
    for (const [a, b] of disjointPairs()) {
      const pa = slab(B.LOG_OAK, a, 0);
      const pb = slab(B.PLANKS_OAK, b);
      const c = canonCell(pa, pb);
      let swapped = false;
      for (const r of ALL_ROTS) {
        const rc = rotatePacked(c, r.ax, r.ay, r.az);
        expect(cellProblem(rc)).toBeNull();
        expect(rc).toBe(canonCell(rotatePart(pa, r.ax, r.ay, r.az), rotatePart(pb, r.ax, r.ay, r.az)));
        if (id(rc) !== id(c)) swapped = true;
      }
      if (swapped) swapsSeen++;
    }
    // Every disjoint pair has a rotation that swaps the order (section 1.3).
    expect(swapsSeen).toBe(3025);
    const rng = new Rng(5);
    for (let k = 0; k < 500; k++) {
      const [a, b] = disjointPairs()[rng.int(0, 3024)]!;
      const c = canonCell(slab(B.LOG_PINE, a, 1), slab(B.STONE, b));
      const r1 = ALL_ROTS[rng.int(0, 23)]!;
      const r2 = ALL_ROTS[rng.int(0, 23)]!;
      const both = rotCompose(r2, r1);
      expect(rotatePacked(rotatePacked(c, r1.ax, r1.ay, r1.az), r2.ax, r2.ay, r2.az)).toBe(rotatePacked(c, both.ax, both.ay, both.az));
    }
  });

  it('rotatePart refuses values that are not parts', () => {
    expect(() => rotatePart(makeCell(B.STONE) | CELL_MULTI_BIT, 0, 2, 4)).toThrow(RangeError);
    expect(() => rotatePart(-1, 0, 2, 4)).toThrow(RangeError);
    expect(() => rotatePart(1, 0, 1, 4)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------- tripwire

describe('the tripwire (1.2)', () => {
  const ok = slab(B.STONE, LOWER);
  const wires = [makePart(B.STONE, 0, UPPER) | CELL_MULTI_BIT, makeCell(B.STONE) | CELL_MULTI_BIT, CELL_MULTI_BIT];
  const calls: Array<[string, (t: number) => unknown]> = [
    ['solidFill', (t) => solidFill(t)],
    ['opaqueFill', (t) => opaqueFill(t)],
    ['cellFill', (t) => cellFill(t)],
    ['partCount', (t) => partCount(t)],
    ['partAt', (t) => partAt(t, 7)],
    ['otherPart', (t) => otherPart(t, 0)],
    ['volume8', (t) => volume8(t)],
    ['solidCover', (t) => solidCover(t, PY)],
    ['opaqueCover', (t) => opaqueCover(t, NY)],
    ['topCovered', (t) => topCovered(t)],
    ['cellsTouch a', (t) => cellsTouch(t, ok, PX)],
    ['cellsTouch b', (t) => cellsTouch(ok, t, PX)],
    ['lightOpacity', (t) => lightOpacity(t)],
    ['lightEmit', (t) => lightEmit(t)],
    ['lightOpen a', (t) => lightOpen(t, ok, PX)],
    ['lightOpen b', (t) => lightOpen(ok, t, PX)],
    ['emitInto dst', (t) => emitInto(t, ok, PX)],
    ['emitInto src', (t) => emitInto(0, t, PX)],
    ['mergeProblem dest', (t) => mergeProblem(t, 0)],
    ['mergeProblem incoming', (t) => mergeProblem(ok, t)],
    ['mergeProblem incoming into air', (t) => mergeProblem(0, t)],
    ['mergeCells dest', (t) => mergeCells(t, 0)],
    ['mergeCells incoming', (t) => mergeCells(0, t)],
    ['canonCell a', (t) => canonCell(t, 0)],
    ['canonCell b', (t) => canonCell(0, t)],
    ['withoutOctant', (t) => withoutOctant(t, 7)],
    ['withoutPartAt', (t) => withoutPartAt(t, 7)],
    ['withOctant', (t) => withOctant(t, 7, 0)],
    ['rotatePacked', (t) => rotatePacked(t, 0, 2, 4)],
    ['rotatePart', (t) => rotatePart(t, 0, 2, 4)],
  ];
  it.each(calls)('%s throws RangeError on CELL_MULTI_BIT without a second part', (_name, call) => {
    for (const t of wires) expect(() => call(t)).toThrow(RangeError);
  });
  it('cellProblem reports it instead of throwing', () => {
    for (const t of wires) expect(cellProblem(t)).toMatch(/CELL_MULTI_BIT/);
  });
});
