/**
 * voxel/parts.ts (docs/SHAPES.md 4.4): whole-cell reads and writes on any VoxelGrid. Each
 * modification is one setCell (one change event) computed with the value functions of
 * blocks/shapes.ts; point queries take integer half-cell coordinates.
 */
import { describe, expect, it } from 'vitest';
import { makeCell, makePart } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { BLOCKS, CUTTABLE } from '../../src/blocks/registry';
import { canonCell, MERGE_LIMIT, MERGE_OK, MERGE_OVERLAP, solidFill } from '../../src/blocks/shapes';
import { Rng } from '../../src/core/rng';
import { Chunk } from '../../src/voxel/chunk';
import { SET_DEFAULT, SET_STRUCTURE_MOVE, type VoxelGrid } from '../../src/voxel/grid';
import {
  addPartAt,
  checkCanonical,
  copyCell,
  getPacked,
  removeOctantAt,
  removePartAt,
  restoreOctantAt,
  solidAtHalf,
  solidFillAt,
} from '../../src/voxel/parts';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';
import { LOWER, partLabels, partsAt, putPart, slab, UPPER } from '../shapes';

const STONE = makeCell(B.STONE);

function grids(): Array<[string, VoxelGrid]> {
  const w = new World();
  for (let cx = -1; cx <= 0; cx++) for (let cz = -1; cz <= 0; cz++) w.addChunk(new Chunk(cx, cz));
  return [
    ['world', w],
    ['structure', new StructureGrid(1, new World())],
  ];
}

function events(g: VoxelGrid): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  (g as World).onCellChange((_x, _y, _z, o, n) => out.push([o, n]));
  return out;
}

for (const [name, make] of [['World', () => grids()[0]![1]], ['StructureGrid', () => grids()[1]![1]]] as const) {
  describe(`voxel/parts.ts on a ${name}`, () => {
    it('getPacked and copyCell carry both parts; a copy of getCell alone trips the wire', () => {
      const g = make();
      const two = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER));
      g.setCell(-3, 40, -3, two);
      expect(getPacked(g, -3, 40, -3)).toBe(two);
      expect(copyCell(g, -3, 40, -3, g, -4, 40, -3)).toBe(true);
      expect(getPacked(g, -4, 40, -3)).toBe(two);
      // The mistake the tripwire exists for: copying the cell value without the second part.
      expect(() => g.setCell(-5, 40, -3, g.getCell(-3, 40, -3))).toThrow(RangeError);
    });

    it('addPartAt merges with one event, returns mergeProblem and writes only on MERGE_OK', () => {
      const g = make();
      const log = events(g);
      expect(addPartAt(g, 0, 40, 0, slab(B.STONE, LOWER))).toBe(MERGE_OK); // into air
      expect(addPartAt(g, 0, 40, 0, slab(B.PLANKS_OAK, UPPER))).toBe(MERGE_OK);
      expect(log).toHaveLength(2);
      expect(partsAt(g, 0, 40, 0)).toEqual([
        { id: B.STONE, state: 0, fill: LOWER },
        { id: B.PLANKS_OAK, state: 0, fill: UPPER },
      ]);
      expect(addPartAt(g, 0, 40, 0, slab(B.GLASS, 0x01))).toBe(MERGE_OVERLAP);
      g.setCell(1, 40, 0, canonCell(slab(B.STONE, 0x01), slab(B.DIRT, 0x80)));
      expect(addPartAt(g, 1, 40, 0, slab(B.GLASS, 0x02))).toBe(MERGE_LIMIT);
      g.setCell(2, 40, 0, STONE);
      expect(addPartAt(g, 2, 40, 0, slab(B.GLASS, 0x02))).toBe(MERGE_OVERLAP); // a full block
      // A soft target is overwritten (whether it drops is the caller's business).
      g.setCell(3, 40, 0, makeCell(B.TORCH));
      expect(addPartAt(g, 3, 40, 0, slab(B.STONE, LOWER))).toBe(MERGE_OK);
      expect(getPacked(g, 3, 40, 0)).toBe(slab(B.STONE, LOWER));
      expect(log).toHaveLength(2 + 3 + 1); // two merges, three setup writes, the torch overwrite: the refused merges wrote nothing
      expect(partLabels(g, { minX: 0, minY: 40, minZ: 0, maxX: 4, maxY: 41, maxZ: 1 })).toEqual([
        '0,40,0:stone[33]+planks_oak[cc]',
        '1,40,0:stone[01]+dirt[80]',
        '2,40,0:stone[ff]',
        '3,40,0:stone[33]',
      ]);
      expect(() => putPart(g, 0, 40, 0, slab(B.GLASS, 0x01))).toThrow(/does not fit/);
    });

    it('removePartAt removes the part holding the octant (the other one stays first), one event; 0 for an empty octant', () => {
      const g = make();
      g.setCell(0, 40, 0, canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER)));
      const log = events(g);
      expect(removePartAt(g, 0, 40, 0, 0)).toBe(slab(B.STONE, LOWER));
      expect(getPacked(g, 0, 40, 0)).toBe(slab(B.PLANKS_OAK, UPPER));
      expect(removePartAt(g, 0, 40, 0, 0)).toBe(0); // octant 0 is empty now
      expect(removePartAt(g, 0, 40, 0, 7)).toBe(slab(B.PLANKS_OAK, UPPER));
      expect(getPacked(g, 0, 40, 0)).toBe(0);
      expect(log).toHaveLength(2);
      g.setCell(1, 40, 0, STONE);
      expect(removePartAt(g, 1, 40, 0, 5)).toBe(STONE); // a full block goes whole
      expect(() => removePartAt(g, 1, 40, 0, 8)).toThrow(RangeError);
    });

    it('removeOctantAt and restoreOctantAt carve and refill one octant; a part carved empty disappears', () => {
      const g = make();
      g.setCell(0, 40, 0, STONE);
      expect(removeOctantAt(g, 0, 40, 0, 7)).toBe(true);
      expect(getPacked(g, 0, 40, 0)).toBe(slab(B.STONE, 0x7f));
      expect(removeOctantAt(g, 0, 40, 0, 7)).toBe(false); // already empty
      expect(restoreOctantAt(g, 0, 40, 0, 0, 7)).toBe(true);
      expect(getPacked(g, 0, 40, 0)).toBe(STONE); // filled back to a full block
      expect(restoreOctantAt(g, 0, 40, 0, 0, 7)).toBe(false); // octant 7 is not empty
      g.setCell(1, 40, 0, slab(B.STONE, 0x01));
      expect(restoreOctantAt(g, 1, 40, 0, 7, 6)).toBe(false); // octant 7 holds no part
      expect(removeOctantAt(g, 1, 40, 0, 0)).toBe(true);
      expect(getPacked(g, 1, 40, 0)).toBe(0);
      g.setCell(2, 40, 0, makeCell(B.HELM));
      expect(() => removeOctantAt(g, 2, 40, 0, 0)).toThrow(RangeError); // a helm cannot be cut
    });

    it('solidFillAt and solidAtHalf read hard octants, from integer half-cell coordinates (negative ones too)', () => {
      const g = make();
      g.setCell(-1, 40, -1, slab(B.STONE, LOWER));
      g.setCell(-2, 40, -1, canonCell(slab(B.STONE, 0x01), slab(B.GLASS, 0x80)));
      g.setCell(-3, 40, -1, makeCell(B.TORCH));
      g.setCell(-4, 40, -1, STONE);
      expect(solidFillAt(g, -1, 40, -1)).toBe(LOWER);
      expect(solidFillAt(g, -2, 40, -1)).toBe(solidFill(canonCell(slab(B.STONE, 0x01), slab(B.GLASS, 0x80))));
      expect(solidFillAt(g, -3, 40, -1)).toBe(0);
      expect(solidFillAt(g, -4, 40, -1)).toBe(0xff);
      // Cell (-1, 40, -1): half-cells -2..-1, 80..81, -2..-1. The lower half is hard, the upper is not.
      expect(solidAtHalf(g, -2, 80, -2)).toBe(true);
      expect(solidAtHalf(g, -1, 80, -1)).toBe(true);
      expect(solidAtHalf(g, -2, 81, -2)).toBe(false);
      expect(solidAtHalf(g, -1, 81, -1)).toBe(false);
      // The point (-0.3, 40.2, -0.7) of that cell, the way callers floor (2 * coordinate).
      expect(solidAtHalf(g, Math.floor(-0.3 * 2), Math.floor(40.2 * 2), Math.floor(-0.7 * 2))).toBe(true);
      expect(solidAtHalf(g, Math.floor(-0.3 * 2), Math.floor(40.7 * 2), Math.floor(-0.7 * 2))).toBe(false);
      // Full blocks and soft blocks: every octant the same.
      for (let o = 0; o < 8; o++) {
        expect(solidAtHalf(g, -8 + (o & 1), 80 + ((o >> 1) & 1), -2 + ((o >> 2) & 1))).toBe(true);
        expect(solidAtHalf(g, -6 + (o & 1), 80 + ((o >> 1) & 1), -2 + ((o >> 2) & 1))).toBe(false);
      }
    });

    it('solidFillAt / solidAtHalf equal solidFill of the packed cell for every cuttable pair and every full block', () => {
      // solidFillAt reads the two layers as integers instead of forming the packed value (so it
      // never boxes, section 4.4); this pins it to the value-level definition.
      const g = make();
      const cuttable: number[] = [];
      for (let id = 1; id < BLOCKS.length; id++) if (BLOCKS[id] && CUTTABLE[id]) cuttable.push(id);
      const rng = new Rng(7);
      const values: number[] = [];
      for (let id = 1; id < BLOCKS.length; id++) if (BLOCKS[id] && id !== B.UNLOADED) values.push(makeCell(id));
      for (let k = 0; k < 400; k++) {
        const a = cuttable[rng.int(0, cuttable.length - 1)]!;
        const b = cuttable[rng.int(0, cuttable.length - 1)]!;
        const fa = rng.int(1, 254);
        const fb = ~fa & 0xff & rng.int(1, 255);
        values.push(slab(a, fa));
        if (fb !== 0) values.push(canonCell(slab(a, fa), slab(b, fb)));
      }
      for (const v of values) {
        g.setCell(2, 41, 2, v);
        const want = solidFill(v);
        expect(solidFillAt(g, 2, 41, 2), `value ${v}`).toBe(want);
        for (let o = 0; o < 8; o++) expect(solidAtHalf(g, 4 + (o & 1), 82 + ((o >> 1) & 1), 4 + ((o >> 2) & 1))).toBe(((want >> o) & 1) === 1);
      }
    });

    it('copyCell passes the flags on to the destination setCell (assembly moves cells with SET_STRUCTURE_MOVE)', () => {
      const g = make();
      const two = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER));
      g.setCell(-3, 40, -3, two);
      const seen: number[] = [];
      (g as World).onCellChange((_x, _y, _z, _o, _n, flags) => seen.push(flags));
      expect(copyCell(g, -3, 40, -3, g, -4, 40, -3, SET_STRUCTURE_MOVE)).toBe(true);
      expect(copyCell(g, -3, 40, -3, g, -5, 40, -3)).toBe(true);
      expect(seen).toEqual([SET_STRUCTURE_MOVE, SET_DEFAULT]);
    });
  });
}

describe('voxel/parts.ts writes refused by the grid', () => {
  it('removePartAt returns 0 and changes nothing when the World refuses the write (unloaded column)', () => {
    // A grid whose getCell sees a cell but whose setCell refuses, like a World whose column was
    // unloaded between the read and the write: the caller must not drop an item for a part that
    // is still there.
    const w = new World();
    w.addChunk(new Chunk(0, 0));
    const two = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER));
    w.setCell(1, 40, 1, two);
    const refusing: VoxelGrid = Object.assign(Object.create(w) as World, { setCell: () => false });
    expect(removePartAt(refusing, 1, 40, 1, 0)).toBe(0);
    expect(getPacked(w, 1, 40, 1)).toBe(two);
    // And on the real World: a column that is not loaded reads air and is refused too.
    expect(removePartAt(w, 40, 40, 40, 0)).toBe(0);
    expect(w.setCell(40, 40, 40, STONE)).toBe(false);
  });
});

describe('checkCanonical', () => {
  it('accepts every canonical value and refuses the rest', () => {
    for (const v of [0, STONE, slab(B.STONE, LOWER), canonCell(slab(B.STONE, LOWER), slab(B.DIRT, UPPER)), makeCell(999)]) expect(() => checkCanonical(v)).not.toThrow();
    const two = canonCell(slab(B.STONE, LOWER), slab(B.DIRT, UPPER));
    for (const v of [two % 2 ** 25, 0x0400, slab(B.HELM, LOWER), makePart(B.STONE, 0, 0xff), -1, 0.5, 2 ** 49, (slab(B.DIRT, UPPER) | (1 << 24)) + slab(B.STONE, LOWER) * 2 ** 25]) {
      expect(() => checkCanonical(v), String(v)).toThrow(RangeError);
    }
  });
});
