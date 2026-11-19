/**
 * cellProblem (docs/SHAPES.md 3.4): one valid and one invalid example per invariant of 1.3,
 * plus the numeric range and registration checks. It never throws.
 */
import { describe, expect, it } from 'vitest';
import { CELL_MULTI_BIT, PACK_SCALE, makeCell, makePart } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell, cellProblem } from '../../src/blocks/shapes';
import { EAST, LOWER, UPPER, WEST, slab } from '../shapes';

/** A packed cell built without any checks. */
const raw = (first: number, second: number): number => (second === 0 ? first : (first | CELL_MULTI_BIT) + second * PACK_SCALE);

describe('cellProblem', () => {
  it('accepts canonical cells', () => {
    const good = [
      0,
      makeCell(B.STONE),
      makeCell(B.WATER, 9),
      makeCell(B.HELM, 3),
      slab(B.STONE, LOWER),
      slab(B.LOG_OAK, 0x01, 2),
      canonCell(slab(B.STONE, LOWER), slab(B.GLASS, UPPER)),
      canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.PLANKS_OAK, UPPER)),
      canonCell(slab(B.WOOL_RED, 0x80), slab(B.CANVAS, 0x01)),
    ];
    for (const c of good) expect(cellProblem(c), String(c)).toBeNull();
  });

  it('range: a non-negative integer below 2^49', () => {
    for (const c of [-1, 0.5, NaN, Infinity, 2 ** 49, 2 ** 53]) expect(cellProblem(c)).toMatch(/not a cell value/);
    expect(cellProblem('1' as unknown as number)).toMatch(/not a cell value/);
  });

  it('I1: id 0 only for the value 0 (0x0400 = id 0 with state)', () => {
    expect(cellProblem(0x0400)).toMatch(/id 0/);
    expect(cellProblem(makePart(0, 0, 0x0f))).toMatch(/id 0/);
    expect(cellProblem(raw(makePart(0, 0, LOWER), slab(B.STONE, LOWER)))).toMatch(/id 0/);
    expect(cellProblem(0)).toBeNull();
  });

  it('I2: no part without octants', () => {
    expect(cellProblem(makePart(B.STONE, 0, 0xff))).toMatch(/no octant/);
    expect(cellProblem(raw(slab(B.STONE, LOWER), makePart(B.GLASS, 0, 0xff)))).toMatch(/no octant/);
    expect(cellProblem(makePart(B.STONE, 0, 0xfe))).toBeNull();
  });

  it('I3: holes only on cuttable materials', () => {
    for (const blk of [B.SAND, B.HELM, B.TORCH, B.WATER, B.TNT, B.DEEPROCK, B.CACTUS]) {
      expect(cellProblem(makePart(blk, 0, UPPER))).toMatch(/cannot be cut/);
      expect(cellProblem(makeCell(blk))).toBeNull();
    }
    expect(cellProblem(makePart(B.LAMP, 0, UPPER))).toBeNull();
  });

  it('I4: CELL_MULTI_BIT exactly when there is a second part, whose id is not 0', () => {
    expect(cellProblem(slab(B.STONE, LOWER) | CELL_MULTI_BIT)).toMatch(/CELL_MULTI_BIT without a second part/);
    expect(cellProblem(slab(B.STONE, LOWER) + slab(B.GLASS, UPPER) * PACK_SCALE)).toMatch(/without CELL_MULTI_BIT/);
    expect(cellProblem(raw(slab(B.STONE, LOWER), makePart(0, 1, LOWER)))).toMatch(/second part has id 0/);
    expect(cellProblem(raw(slab(B.STONE, LOWER), slab(B.GLASS, UPPER)))).toBeNull();
  });

  it('I5: two parts are both cuttable, both have holes, and do not overlap', () => {
    expect(cellProblem(raw(slab(B.STONE, LOWER), slab(B.GLASS, 0x3c)))).toMatch(/overlap/);
    expect(cellProblem(raw(makeCell(B.STONE), slab(B.GLASS, UPPER)))).toMatch(/full part/);
    expect(cellProblem(raw(slab(B.STONE, 0x01), makeCell(B.HELM)))).toMatch(/full part/);
    expect(cellProblem(raw(slab(B.STONE, LOWER), makePart(B.SAND, 0, LOWER)))).toMatch(/cannot be cut/);
    expect(cellProblem(raw(slab(B.STONE, WEST), slab(B.GLASS, EAST)))).toBeNull();
  });

  it('I6: the first part holds the lowest occupied octant', () => {
    expect(cellProblem(raw(slab(B.GLASS, UPPER), slab(B.STONE, LOWER)))).toMatch(/out of order/);
    expect(cellProblem(raw(slab(B.STONE, LOWER), slab(B.GLASS, UPPER)))).toBeNull();
    // Same materials, swapped geometry.
    expect(cellProblem(raw(slab(B.STONE, 0x80), slab(B.STONE, 0x01)))).toMatch(/out of order/);
  });

  it('ids must be registered (both parts)', () => {
    expect(cellProblem(makeCell(27))).toMatch(/unknown block id 27/);
    expect(cellProblem(makeCell(1022, 5))).toMatch(/unknown block id 1022/);
    expect(cellProblem(raw(slab(B.STONE, LOWER), makePart(27, 0, LOWER)))).toMatch(/unknown block id 27/);
  });

  it('the unloaded reading (B.UNLOADED) is never a content, with or without state bits', () => {
    expect(cellProblem(makeCell(B.UNLOADED))).toMatch(/unloaded reading/);
    expect(cellProblem(makeCell(B.UNLOADED, 3))).toMatch(/unloaded reading/);
    // The block is not cuttable, so a holed part of it is refused as well (either reason is fine).
    expect(cellProblem(raw(makePart(B.UNLOADED, 0, 0x0f), 0))).not.toBeNull();
  });

  it('state bits are not checked (as before M2.3)', () => {
    expect(cellProblem(makeCell(B.STONE, 63))).toBeNull();
    expect(cellProblem(makeCell(B.HELM, 7))).toBeNull();
  });
});
