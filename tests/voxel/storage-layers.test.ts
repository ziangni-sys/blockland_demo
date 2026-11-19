/**
 * The three storage layers of chunks and structure grids (docs/SHAPES.md 4.1-4.3): every write and
 * every reallocation keeps holes and second parts, a change of only the holes or only the second
 * part is one change event, layers are allocated on the first write that needs them and never freed
 * while the object lives (but handed out as null once all zero), and setCell refuses every value
 * that is not in canonical form.
 */
import { describe, expect, it } from 'vitest';
import { AIR, CELL_MULTI_BIT, makeCell, makePart, PACK_SCALE } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { CHUNK_VOLUME } from '../../src/core/constants';
import { Chunk } from '../../src/voxel/chunk';
import type { VoxelGrid } from '../../src/voxel/grid';
import { getPacked } from '../../src/voxel/parts';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';
import { EAST, LOWER, slab, UPPER, WEST } from '../shapes';

const STONE = makeCell(B.STONE);
/** A lower stone slab: a part with holes. */
const STONE_LOW = slab(B.STONE, LOWER);
/** Stone below, oak planks above: a two-part cell. */
const TWO = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER));
/** Two halves of one material: geometrically full, still two parts. */
const FILLED = canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.PLANKS_OAK, UPPER));
/** The same two halves with the other material on top (only the second part differs from TWO). */
const TWO_GLASS = canonCell(slab(B.STONE, LOWER), slab(B.GLASS, UPPER));
/** Stone below, planks above but the stone one octant smaller (only the first part's holes differ from TWO). */
const TWO_NOTCH = canonCell(slab(B.STONE, LOWER & ~1 & 0xff), slab(B.PLANKS_OAK, UPPER));

function world(): World {
  const w = new World();
  w.addChunk(new Chunk(0, 0));
  w.addChunk(new Chunk(1, 0));
  return w;
}

type Change = [number, number, number, number, number];
function record(g: World | StructureGrid): Change[] {
  const out: Change[] = [];
  g.onCellChange((x, y, z, o, n) => out.push([x, y, z, o, n]));
  return out;
}

/**
 * Every value setCell must refuse, with why: values >= FULL_LIMIT that break I1-I6 (and NaN-like
 * garbage). Values below FULL_LIMIT are full blocks and are never checked (see FULL_UNCHECKED).
 */
const NON_CANONICAL: Array<[string, number]> = [
  ['bit 24 without a second part (the tripwire: a copied getCell value)', TWO % PACK_SCALE],
  ['a second part without bit 24', (TWO % PACK_SCALE) - CELL_MULTI_BIT + Math.floor(TWO / PACK_SCALE) * PACK_SCALE],
  ['id 0 with holes', makePart(0, 0, 0x0f)],
  ['a part without octants', makePart(B.STONE, 0, 0xff)],
  ['holes on a block that cannot be cut', makePart(B.HELM, 0, 0x0f)],
  ['a full part beside a second part', (STONE | CELL_MULTI_BIT) + slab(B.DIRT, UPPER) * PACK_SCALE],
  ['overlapping parts', (slab(B.STONE, LOWER) | CELL_MULTI_BIT) + slab(B.DIRT, LOWER | 0x40) * PACK_SCALE],
  ['parts out of order', (slab(B.DIRT, UPPER) | CELL_MULTI_BIT) + slab(B.STONE, LOWER) * PACK_SCALE],
  ['a second part with id 0', (slab(B.STONE, LOWER) | CELL_MULTI_BIT) + makePart(0, 0, LOWER) * PACK_SCALE],
  ['not an integer', STONE_LOW + 0.5],
  ['NaN', NaN],
  ['2^49 and above', PACK_SCALE * 2 ** 24],
];

describe('World: three layers', () => {
  it('a part with holes, a two-part cell and a filled two-part cell read back whole; full blocks stay one read', () => {
    const w = world();
    expect(w.setCell(3, 40, 3, STONE_LOW)).toBe(true);
    expect(w.setCell(4, 40, 3, TWO)).toBe(true);
    expect(w.setCell(5, 40, 3, FILLED)).toBe(true);
    expect(w.setCell(20, 40, 3, STONE)).toBe(true);
    expect(w.getCell(3, 40, 3)).toBe(STONE_LOW);
    expect(w.getPart2(3, 40, 3)).toBe(0);
    expect(w.getCell(4, 40, 3)).toBe(TWO % PACK_SCALE);
    expect(w.getCell(4, 40, 3) & CELL_MULTI_BIT).toBe(CELL_MULTI_BIT);
    expect(w.getPart2(4, 40, 3)).toBe(slab(B.PLANKS_OAK, UPPER));
    expect([getPacked(w, 3, 40, 3), getPacked(w, 4, 40, 3), getPacked(w, 5, 40, 3), getPacked(w, 20, 40, 3)]).toEqual([STONE_LOW, TWO, FILLED, STONE]);
    // The chunk without parts keeps no extra layers; the other got exactly what it needed.
    expect([w.getChunk(1, 0)!.holes, w.getChunk(1, 0)!.part2]).toEqual([null, null]);
    expect(w.getChunk(0, 0)!.holes).not.toBeNull();
    expect(w.getChunk(0, 0)!.part2).not.toBeNull();
    // Out of range and unloaded: no second part.
    expect([w.getPart2(4, -1, 3), w.getPart2(4, 128, 3), w.getPart2(100, 40, 3)]).toEqual([0, 0, 0]);
  });

  it('a holes-only change and a second-part-only change each fire one event with the packed values; an unchanged write fires none', () => {
    const w = world();
    const log = record(w);
    w.setCell(1, 50, 1, TWO);
    expect(w.setCell(1, 50, 1, TWO_NOTCH)).toBe(true); // only the first part's holes
    expect(w.setCell(1, 50, 1, TWO_GLASS)).toBe(true);
    expect(log).toEqual([
      [1, 50, 1, 0, TWO],
      [1, 50, 1, TWO, TWO_NOTCH],
      [1, 50, 1, TWO_NOTCH, TWO_GLASS],
    ]);
    log.length = 0;
    expect(w.setCell(1, 50, 1, TWO_GLASS)).toBe(false);
    expect(w.setCell(1, 50, 1, TWO)).toBe(true); // only the second part
    expect(log).toEqual([[1, 50, 1, TWO_GLASS, TWO]]);
    expect(w.getChunk(0, 0)!.modified).toBe(true);
  });

  it('layers: allocated on the first write needing them; at count 0 still there (same reference) but handed out as null', () => {
    const w = world();
    const c = w.getChunk(0, 0)!;
    w.setCell(2, 30, 2, STONE);
    expect([c.holes, c.part2]).toEqual([null, null]);
    w.setCell(2, 30, 2, STONE_LOW);
    const holes = c.holes;
    expect(holes).not.toBeNull();
    expect(c.part2).toBeNull();
    w.setCell(2, 30, 2, TWO);
    const part2 = c.part2;
    expect(part2).not.toBeNull();
    w.setCell(2, 30, 2, STONE);
    expect(c.holes).toBe(holes);
    expect(c.part2).toBe(part2);
    expect(c.layers()).toEqual({ base: c.cells, holes: null, part2: null });
    // A full block written into a layered column takes the layered path and still works.
    expect(w.setCell(2, 31, 2, STONE)).toBe(true);
    expect(getPacked(w, 2, 31, 2)).toBe(STONE);
  });

  it('a Chunk built with all-zero layers takes them as null; with the wrong length it throws', () => {
    const c = new Chunk(0, 0, new Uint16Array(CHUNK_VOLUME), undefined, new Uint8Array(CHUNK_VOLUME), new Uint32Array(CHUNK_VOLUME));
    expect([c.holes, c.part2]).toEqual([null, null]);
    const holes = new Uint8Array(CHUNK_VOLUME);
    holes[7] = 0x0f;
    const d = new Chunk(0, 0, new Uint16Array(CHUNK_VOLUME), undefined, holes, null);
    expect(d.holes).toBe(holes);
    expect(d.layers().holes).toBe(holes);
    expect(() => new Chunk(0, 0, undefined, undefined, new Uint8Array(10))).toThrow();
    expect(() => new Chunk(0, 0, undefined, undefined, null, new Uint32Array(10))).toThrow();
  });

  it('setCell refuses every value that is not in canonical form, and changes nothing (columns with and without layers)', () => {
    for (const [why, v] of NON_CANONICAL) {
      const w = world();
      w.setCell(9, 60, 9, STONE_LOW); // a layered column
      const log = record(w);
      expect(() => w.setCell(9, 60, 9, v), why).toThrow(RangeError);
      expect(() => w.setCell(9, 61, 9, v), why).toThrow(RangeError);
      expect(() => w.setCell(9 + 16, 60, 9, v), why).toThrow(RangeError); // chunk (1, 0) has no layers
      expect(getPacked(w, 9, 60, 9), why).toBe(STONE_LOW);
      expect(getPacked(w, 9, 61, 9), why).toBe(0);
      expect(getPacked(w, 9 + 16, 60, 9), why).toBe(0);
      expect(log, why).toEqual([]);
    }
  });

  it('a full-block value is never checked, whatever layers the column has (1.3, 3.4): the same write behaves the same', () => {
    // 0x0400 is "id 0 with state", the one invalid value below FULL_LIMIT: trusted code never
    // makes it, untrusted input meets cellProblem first. A column without layers, one whose layers
    // are allocated but all zero again, and one with a two-part cell in that very cell all store it.
    const w = world();
    w.setCell(3, 50, 3, STONE_LOW);
    w.setCell(3, 50, 3, AIR); // chunk (0, 0) keeps its (now all-zero) holes layer
    w.setCell(4, 50, 4, TWO);
    expect(w.getChunk(0, 0)!.holes).not.toBeNull();
    const log = record(w);
    expect(w.setCell(3 + 16, 50, 3, 0x0400)).toBe(true); // no layers
    expect(w.setCell(3, 50, 3, 0x0400)).toBe(true); // all-zero layers
    expect(w.setCell(4, 50, 4, 0x0400)).toBe(true); // over a two-part cell: its layer entries go
    expect([w.getCell(3 + 16, 50, 3), w.getCell(3, 50, 3), w.getCell(4, 50, 4), w.getPart2(4, 50, 4)]).toEqual([0x0400, 0x0400, 0x0400, 0]);
    expect(log).toEqual([
      [3 + 16, 50, 3, AIR, 0x0400],
      [3, 50, 3, AIR, 0x0400],
      [4, 50, 4, TWO, 0x0400],
    ]);
    expect(w.getChunk(0, 0)!.layers()).toMatchObject({ holes: null, part2: null });
    // Whatever trusted-looking garbage below FULL_LIMIT arrives, a layered column stores exactly
    // what the M1 path stores (the 16-bit base entry) and never a holes byte or a second part.
    for (const v of [-1, -STONE_LOW, 3.7, 0xfffe]) {
      const plain = world();
      const layered = world();
      layered.setCell(5, 50, 5, TWO);
      expect(plain.setCell(5, 50, 5, v)).toBe(layered.setCell(5, 50, 5, v));
      expect(layered.getCell(5, 50, 5), String(v)).toBe(plain.getCell(5, 50, 5));
      expect(layered.getPart2(5, 50, 5), String(v)).toBe(0);
    }
  });

  it('unloaded chunks and the vertical range still refuse writes (false, no throw for valid values)', () => {
    const w = world();
    expect(w.setCell(100, 40, 3, TWO)).toBe(false);
    expect(w.setCell(3, -1, 3, TWO)).toBe(false);
    expect(w.setCell(3, 128, 3, TWO)).toBe(false);
  });
});

describe('StructureGrid: three layers', () => {
  const grid = (): StructureGrid => new StructureGrid(1, new World());

  it('round-trips parts through setCell, getCell / getPart2, forEachCell and count', () => {
    const g = grid();
    g.setCell(0, 0, 0, STONE);
    g.setCell(1, 0, 0, STONE_LOW);
    g.setCell(2, 0, 0, TWO);
    g.setCell(3, 0, 0, FILLED);
    expect(g.count).toBe(4); // a two-part cell counts once
    expect([getPacked(g, 0, 0, 0), getPacked(g, 1, 0, 0), getPacked(g, 2, 0, 0), getPacked(g, 3, 0, 0)]).toEqual([STONE, STONE_LOW, TWO, FILLED]);
    expect(g.getPart2(2, 0, 0)).toBe(slab(B.PLANKS_OAK, UPPER));
    expect(g.getPart2(50, 50, 50)).toBe(0);
    const seen: Array<[number, number]> = [];
    g.forEachCell((x, _y, _z, packed) => seen.push([x, packed]));
    expect(seen).toEqual([
      [0, STONE],
      [1, STONE_LOW],
      [2, TWO],
      [3, FILLED],
    ]);
    expect(g.layered).toBe(true);
    expect(g.cellBounds()).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 1, maxZ: 1 });
    // Removing every part: AIR, count down.
    g.setCell(2, 0, 0, 0);
    expect(g.count).toBe(3);
    expect(getPacked(g, 2, 0, 0)).toBe(0);
  });

  it('holes-only and second-part-only changes: one event each, packed values, version bumps', () => {
    const g = grid();
    const log = record(g);
    g.setCell(0, 0, 0, TWO);
    const v = g.version;
    expect(g.setCell(0, 0, 0, TWO_NOTCH)).toBe(true);
    expect(g.setCell(0, 0, 0, TWO_GLASS)).toBe(true);
    expect(g.setCell(0, 0, 0, TWO_GLASS)).toBe(false);
    expect(g.version).toBe(v + 2);
    expect(log).toEqual([
      [0, 0, 0, 0, TWO],
      [0, 0, 0, TWO, TWO_NOTCH],
      [0, 0, 0, TWO_NOTCH, TWO_GLASS],
    ]);
  });

  it('grow and resize carry the non-zero layers and drop the ones whose count is 0', () => {
    const g = grid();
    g.setCell(0, 0, 0, TWO);
    for (let i = 1; i <= 40; i++) g.setCell(i, 0, 0, STONE); // grows several times
    expect(getPacked(g, 0, 0, 0)).toBe(TWO);
    expect(g.storage().layers.part2).not.toBeNull();
    // A resize that cuts the two-part cell off drops both layers.
    g.resize(1, 0, 0, 40, 1, 1);
    expect(g.layered).toBe(false);
    expect(getPacked(g, 0, 0, 0)).toBe(0);
    expect(g.count).toBe(40);
    // Holes alone: a layer allocated, all zero again, then a grow: gone.
    g.setCell(5, 0, 0, STONE_LOW);
    expect(g.layered).toBe(true);
    g.setCell(5, 0, 0, STONE);
    expect(g.layered).toBe(true); // still allocated (never freed by a write)
    expect(g.storage().layers.holes).toBeNull(); // handed out as null
    g.setCell(-50, 0, 0, STONE); // grow: reallocation without the zero layer
    expect(g.layered).toBe(false);
    // Holes and a second part survive a grow in every direction.
    g.setCell(10, 0, 0, TWO_NOTCH);
    for (const [x, y, z] of [[-90, 0, 0], [0, 30, 0], [0, -30, 0], [0, 0, 30], [0, 0, -30], [90, 0, 0]] as const) g.setCell(x, y, z, STONE);
    expect(getPacked(g, 10, 0, 0)).toBe(TWO_NOTCH);
  });

  it('copyBox: a dense copy of the three layers; air outside the storage; a layer without entries in the box is null', () => {
    const g = grid();
    g.setCell(0, 0, 0, STONE);
    g.setCell(1, 0, 0, TWO);
    g.setCell(0, 1, 0, STONE_LOW);
    const all = g.copyBox(-1, 0, 0, 3, 2, 1); // one column of air at x = -1
    expect(Array.from(all.base)).toEqual([0, STONE, TWO % 0x10000, 0, STONE_LOW % 0x10000, 0]);
    expect(Array.from(all.holes!)).toEqual([0, 0, (TWO >>> 16) & 0xff, 0, 0xcc, 0]);
    expect(Array.from(all.part2!)).toEqual([0, 0, Math.floor(TWO / PACK_SCALE), 0, 0, 0]);
    const plain = g.copyBox(0, 0, 0, 1, 1, 1);
    expect(plain).toEqual({ base: Uint16Array.of(STONE), holes: null, part2: null });
    const holesOnly = g.copyBox(0, 1, 0, 1, 1, 1);
    expect(holesOnly.part2).toBeNull();
    expect(Array.from(holesOnly.holes!)).toEqual([0xcc]);
    expect(g.copyBox(100, 100, 100, 2, 2, 2)).toEqual({ base: new Uint16Array(8), holes: null, part2: null });
  });

  it('loadBox replaces everything, recounts, takes all-zero layers as null, and checks lengths; no events', () => {
    const g = grid();
    g.setCell(7, 7, 7, TWO); // replaced: nothing of it may survive
    const log = record(g);
    const v = g.version;
    g.loadBox(0, 0, 0, 2, 1, 1, { base: Uint16Array.of(STONE, 0), holes: new Uint8Array(2), part2: new Uint32Array(2) });
    expect(g.version).toBe(v + 1);
    expect(g.count).toBe(1);
    expect(g.layered).toBe(false);
    expect(getPacked(g, 7, 7, 7)).toBe(0);
    const src = g.copyBox(0, 0, 0, 2, 1, 1);
    expect(src).toEqual({ base: Uint16Array.of(STONE, 0), holes: null, part2: null });
    const layers = { base: Uint16Array.of(TWO % 0x10000, STONE_LOW % 0x10000), holes: Uint8Array.of((TWO >>> 16) & 0xff, 0xcc), part2: Uint32Array.of(Math.floor(TWO / PACK_SCALE), 0) };
    g.loadBox(-3, 2, 5, 1, 2, 1, layers);
    expect([getPacked(g, -3, 2, 5), getPacked(g, -3, 3, 5)]).toEqual([TWO, STONE_LOW]);
    layers.holes[0] = 0; // the grid has its own copy
    expect(getPacked(g, -3, 2, 5)).toBe(TWO);
    expect(log).toEqual([]);
    expect(() => g.loadBox(0, 0, 0, 2, 2, 1, { base: new Uint16Array(3), holes: null, part2: null })).toThrow(RangeError);
    expect(() => g.loadBox(0, 0, 0, 1, 1, 1, { base: new Uint16Array(1), holes: new Uint8Array(2), part2: null })).toThrow(RangeError);
    g.loadBox(0, 0, 0, 0, 0, 0, { base: new Uint16Array(0), holes: null, part2: null });
    expect(g.count).toBe(0);
    expect(g.cellBounds()).toBeNull();
  });

  it('storage(): the box and the layers by reference, zero-count layers as null; adoptStorage shares all three', () => {
    const g = grid();
    g.setCell(0, 0, 0, TWO);
    const st = g.storage();
    expect(st.layers.part2).not.toBeNull();
    expect(st.layers.base.length).toBe(st.sx * st.sy * st.sz);
    const i = -st.ox + -st.oz * st.sx + -st.oy * st.sx * st.sz;
    expect(st.layers.part2![i]).toBe(Math.floor(TWO / PACK_SCALE));
    const other = new StructureGrid(2, new World());
    other.adoptStorage(g);
    expect(getPacked(other, 0, 0, 0)).toBe(TWO);
    expect(other.count).toBe(1);
  });

  it('setCell refuses every non-canonical value before growing the storage', () => {
    for (const [why, v] of NON_CANONICAL) {
      const g = grid();
      g.setCell(0, 0, 0, STONE_LOW);
      const box = g.storage();
      const log = record(g);
      expect(() => g.setCell(1000, 0, 0, v), why).toThrow(RangeError);
      expect(() => g.setCell(0, 0, 0, v), why).toThrow(RangeError);
      expect(g.storage().sx, why).toBe(box.sx);
      expect(getPacked(g, 0, 0, 0), why).toBe(STONE_LOW);
      expect(log, why).toEqual([]);
      expect(() => grid().setCell(5, 0, 0, v), why).toThrow(RangeError); // a grid without layers
    }
  });

  it('a full-block value is never checked, with or without layers (1.3, 3.4); over a two-part cell it clears the layers', () => {
    const plain = grid();
    expect(plain.setCell(0, 0, 0, 0x0400)).toBe(true);
    const g = grid();
    g.setCell(0, 0, 0, TWO);
    const log = record(g);
    expect(g.setCell(0, 0, 0, 0x0400)).toBe(true);
    expect(g.setCell(1, 0, 0, 0x0400)).toBe(true);
    expect([getPacked(plain, 0, 0, 0), getPacked(g, 0, 0, 0), g.getPart2(0, 0, 0), getPacked(g, 1, 0, 0)]).toEqual([0x0400, 0x0400, 0, 0x0400]);
    expect(log).toEqual([
      [0, 0, 0, TWO, 0x0400],
      [1, 0, 0, AIR, 0x0400],
    ]);
    expect(g.layered).toBe(true); // layers are never freed ...
    expect(g.storage().layers).toMatchObject({ holes: null, part2: null }); // ... but hold nothing
  });

  it('a 2000-cell line of half slabs is still built in amortised O(1) per cell (layers grow with the box)', () => {
    const g = grid();
    const t0 = Date.now();
    for (let i = 0; i < 2000; i++) g.setCell(i, 0, 0, i % 2 === 0 ? slab(B.STONE, WEST) : canonCell(slab(B.STONE, WEST), slab(B.DIRT, EAST)));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(g.count).toBe(2000);
    expect(getPacked(g, 1999, 0, 0)).toBe(canonCell(slab(B.STONE, WEST), slab(B.DIRT, EAST)));
  });
});

describe('both grids behave the same (VoxelGrid contract)', () => {
  it('the same sequence of writes reads back the same on a World and a StructureGrid', () => {
    const grids: VoxelGrid[] = [world(), new StructureGrid(1, new World())];
    const seq = [STONE_LOW, TWO, FILLED, TWO_NOTCH, TWO_GLASS, STONE, 0, slab(B.GLASS, 0x01)];
    const reads = grids.map((g) => seq.map((v, k) => (g.setCell(k, 40, 0, v), getPacked(g, k, 40, 0))));
    expect(reads[0]).toEqual(seq);
    expect(reads[1]).toEqual(seq);
  });
});
