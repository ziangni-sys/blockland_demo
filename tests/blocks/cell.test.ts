/**
 * Cell values (docs/SHAPES.md 1.2) and the registry's material tables (1.4, 7.1).
 */
import { describe, expect, it } from 'vitest';
import { NZ, PX } from '../../src/core/dirs';
import {
  CELL_LIMIT,
  CELL_MULTI_BIT,
  FULL_LIMIT,
  HOLES_MASK,
  HOLES_SHIFT,
  ID_MASK,
  PACK_SCALE,
  PART_LIMIT,
  PART_MASK,
  STATE_MASK,
  STATE_SHIFT,
  cellId,
  cellPrimary,
  cellSecond,
  cellState,
  makeCell,
  makePart,
  packCell,
  partHoles,
  withHoles,
  withState,
} from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { BLOCKS, CUTTABLE, LIGHT_OPACITY, OPAQUE, registerBlock } from '../../src/blocks/registry';
import * as registry from '../../src/blocks/registry';
import { CELL_MULTI_BIT as PROTOCOL_MULTI_BIT } from '../../src/net/protocol';
import { LOWER, UPPER, slab, stairFill } from '../shapes';

describe('cell constants (1.2)', () => {
  it('have the specified values', () => {
    expect([ID_MASK, STATE_SHIFT, STATE_MASK, HOLES_SHIFT, HOLES_MASK]).toEqual([0x3ff, 10, 0x3f, 16, 0xff]);
    expect(CELL_MULTI_BIT).toBe(1 << 24);
    expect(PART_MASK).toBe(0xffffff);
    expect(PART_LIMIT).toBe(2 ** 24);
    expect(CELL_LIMIT).toBe(2 ** 25);
    expect(PACK_SCALE).toBe(2 ** 25);
    expect(FULL_LIMIT).toBe(2 ** 16);
    // The largest packed cell is exact in a double.
    expect(Number.isSafeInteger((CELL_LIMIT - 1) + (PART_LIMIT - 1) * PACK_SCALE)).toBe(true);
  });

  it('net/protocol re-exports CELL_MULTI_BIT from blocks/cell', () => {
    expect(PROTOCOL_MULTI_BIT).toBe(CELL_MULTI_BIT);
  });
});

describe('full blocks keep their M1 value', () => {
  it('makeCell is the 16-bit id + state value for every registered block and state', () => {
    for (const def of BLOCKS) {
      if (def === undefined) continue;
      for (let state = 0; state < 64; state++) {
        const c = makeCell(def.id, state);
        expect(c).toBe(def.id | (state << 10));
        expect(c).toBeLessThan(FULL_LIMIT);
        expect(makePart(def.id, state, 0)).toBe(c);
        expect(slab(def.id, 0xff, state)).toBe(c);
        expect(cellPrimary(c)).toBe(c);
        expect(cellSecond(c)).toBe(0);
        expect(packCell(c, 0)).toBe(c);
        expect(partHoles(c)).toBe(0);
      }
    }
    expect(makeCell(B.STONE)).toBe(1);
    expect(makeCell(B.UNLOADED)).toBe(1023);
  });
});

describe('part values', () => {
  it('makePart puts the holes in bits 16-23', () => {
    const p = makePart(B.PLANKS_OAK, 5, 0xcc);
    expect(p).toBe(B.PLANKS_OAK | (5 << 10) | (0xcc << 16));
    expect(cellId(p)).toBe(B.PLANKS_OAK);
    expect(cellState(p)).toBe(5);
    expect(partHoles(p)).toBe(0xcc);
    expect(p).toBeLessThan(PART_LIMIT);
    expect(slab(B.PLANKS_OAK, LOWER, 5)).toBe(p);
  });

  it('withState changes only the state bits; holes and CELL_MULTI_BIT stay', () => {
    const p = makePart(B.LOG_OAK, 1, 0x0f);
    expect(withState(p, 2)).toBe(makePart(B.LOG_OAK, 2, 0x0f));
    expect(withState(p | CELL_MULTI_BIT, 0)).toBe(makePart(B.LOG_OAK, 0, 0x0f) | CELL_MULTI_BIT);
    expect(withState(makeCell(B.WATER, 3), 9)).toBe(makeCell(B.WATER, 9));
    expect(withState(p, 0x7f)).toBe(makePart(B.LOG_OAK, 0x3f, 0x0f)); // state is masked
  });

  it('withHoles changes only the holes', () => {
    const p = makePart(B.LOG_OAK, 2, 0x0f);
    expect(withHoles(p, 0xf0)).toBe(makePart(B.LOG_OAK, 2, 0xf0));
    expect(withHoles(p | CELL_MULTI_BIT, 0)).toBe(makeCell(B.LOG_OAK, 2) | CELL_MULTI_BIT);
  });

  it('test helpers: slab and stairFill', () => {
    expect(stairFill(NZ)).toBe(0x3f);
    expect(stairFill(PX)).toBe(LOWER | 0x88);
    expect(() => stairFill(2)).toThrow(RangeError);
    expect(() => slab(B.STONE, 0)).toThrow(RangeError);
    expect(slab(B.STONE, UPPER)).toBe(makePart(B.STONE, 0, LOWER));
  });
});

describe('packed cells', () => {
  it('packCell, cellPrimary and cellSecond round trip', () => {
    const a = slab(B.STONE, LOWER);
    const b = slab(B.PLANKS_OAK, UPPER, 7);
    const packed = packCell(a | CELL_MULTI_BIT, b);
    expect(packed).toBe((a | CELL_MULTI_BIT) + b * 2 ** 25);
    expect(cellPrimary(packed)).toBe(a | CELL_MULTI_BIT);
    expect(cellSecond(packed)).toBe(b);
    // Bitwise reads see the first part.
    expect(packed & ID_MASK).toBe(B.STONE);
    expect((packed >>> 16) & 0xff).toBe(0xcc);
    expect(packed & CELL_MULTI_BIT).not.toBe(0);
    expect(packCell(a, 0)).toBe(a);
  });

  it('packCell throws when the cell and the second part disagree or are out of range', () => {
    const a = slab(B.STONE, LOWER);
    expect(() => packCell(a | CELL_MULTI_BIT, 0)).toThrow(RangeError); // the tripwire
    expect(() => packCell(a, slab(B.STONE, UPPER))).toThrow(RangeError);
    expect(() => packCell(CELL_LIMIT, 1)).toThrow(RangeError);
    expect(() => packCell(-1, 0)).toThrow(RangeError);
    expect(() => packCell(a | CELL_MULTI_BIT, PART_LIMIT)).toThrow(RangeError);
    expect(() => packCell(0.5, 0)).toThrow(RangeError);
  });
});

/** The lists of docs/SHAPES.md 1.4, by block key. */
const CUTTABLE_KEYS = [
  'stone', 'cobble', 'dirt', 'turf', 'obsidian', 'coal_ore', 'iron_ore', 'copper_ore', 'clay', 'snow_block', 'ice',
  'log_oak', 'log_pine', 'planks_oak', 'planks_pine', 'leaves_oak', 'leaves_pine', 'glass', 'stone_bricks', 'bricks',
  'sandstone', 'iron_block', 'lamp',
  'wool_white', 'wool_red', 'wool_orange', 'wool_yellow', 'wool_green', 'wool_blue', 'wool_purple', 'wool_black', 'canvas',
];
const NOT_CUTTABLE_KEYS = [
  'air', 'water', 'lava', 'sand', 'gravel', 'deeprock', 'helm', 'bearing', 'propeller', 'torch', 'tnt', 'cactus',
  'flower_red', 'flower_yellow', 'tall_grass', 'snow_layer', 'unloaded',
];

describe('registry (1.4, 7.1)', () => {
  it('CUTTABLE matches the lists of section 1.4 for every registered block', () => {
    const registered = BLOCKS.filter((d) => d !== undefined).map((d) => d.key).sort();
    expect([...CUTTABLE_KEYS, ...NOT_CUTTABLE_KEYS].sort()).toEqual(registered);
    for (const def of BLOCKS) {
      if (def === undefined) continue;
      expect(CUTTABLE[def.id], def.key).toBe(CUTTABLE_KEYS.includes(def.key) ? 1 : 0);
    }
    // Unregistered ids are not cuttable.
    expect(CUTTABLE[27]).toBe(0);
    expect(CUTTABLE.length).toBe(1024);
  });

  it('opaque and lightOpacity >= 15 agree for every block, and registerBlock enforces it', () => {
    for (const def of BLOCKS) {
      if (def === undefined) continue;
      expect(OPAQUE[def.id] === 1, def.key).toBe(LIGHT_OPACITY[def.id]! >= 15);
    }
    expect(() => registerBlock(900, 'test_half_opaque', { tiles: [], lightOpacity: 3 })).toThrow(/opaque/);
    expect(() => registerBlock(901, 'test_clear_wall', { tiles: [], opaque: false, lightOpacity: 15 })).toThrow(/opaque/);
    expect(BLOCKS[900]).toBeUndefined();
    expect(BLOCKS[901]).toBeUndefined();
  });

  it('the UNBREAKABLE table is gone', () => {
    expect('UNBREAKABLE' in registry).toBe(false);
  });
});
