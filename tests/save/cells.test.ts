/**
 * save/cells.ts, the one implementation of Cell and CellVolume (docs/SHAPES.md 13.1): layered
 * volumes round-trip in both forms, the encoder's three rules (runs cut where the packed cell
 * changes; above PALETTE_LIMIT only the raw size keeps counting; the palette form only when
 * strictly smaller), and bounded decoding (n charged first, each extra layer's share charged just
 * before it is allocated, and only when a cell needs it).
 */
import { describe, expect, it } from 'vitest';
import { CELL_MULTI_BIT, makeCell, makePart, PACK_SCALE, type CellLayers } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { CHUNK_VOLUME } from '../../src/core/constants';
import { ByteReader, ByteWriter, SaveFormatError } from '../../src/save/bytes';
import { cellSize, PALETTE_LIMIT, readCellVolume, volumeCost, writeCell, writeCellVolume } from '../../src/save/cells';
import { LOWER, slab, UPPER } from '../shapes';

function put(l: CellLayers, i: number, packed: number): void {
  const v = packed % PACK_SCALE;
  const p2 = Math.floor(packed / PACK_SCALE);
  l.base[i] = v & 0xffff;
  const h = (v >>> 16) & 0xff;
  if (h !== 0 && l.holes === null) l.holes = new Uint8Array(l.base.length);
  if (l.holes !== null) l.holes[i] = h;
  if (p2 !== 0 && l.part2 === null) l.part2 = new Uint32Array(l.base.length);
  if (l.part2 !== null) l.part2[i] = p2;
}
const empty = (n: number): CellLayers => ({ base: new Uint16Array(n), holes: null, part2: null });

function encode(v: CellLayers): Uint8Array {
  const w = new ByteWriter();
  writeCellVolume(w, v);
  return w.finish();
}
function decode(bytes: Uint8Array, n: number, budget = { cells: volumeCost(n, true, true) }): CellLayers {
  const r = new ByteReader(bytes);
  const out = readCellVolume(r, n, budget);
  r.expectEnd();
  return out;
}

const SLAB = slab(B.STONE, LOWER);
const TWO = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER));

describe('CellVolume with layers', () => {
  it('a column with parts round-trips in the palette form; layers not needed stay null', () => {
    const v = empty(CHUNK_VOLUME);
    v.base.fill(makeCell(B.STONE), 0, 40 * 256);
    put(v, 40 * 256 + 3, SLAB);
    const holesOnly = decode(encode(v), CHUNK_VOLUME);
    expect(holesOnly.part2).toBeNull();
    expect(holesOnly).toEqual(v);
    put(v, 40 * 256 + 4, TWO);
    const bytes = encode(v);
    expect(bytes[0]).toBe(0); // palette
    expect(decode(bytes, CHUNK_VOLUME)).toEqual(v);
    // Full blocks only: both extra layers null.
    expect(decode(encode(empty(100)), 100)).toEqual(empty(100));
  });

  it('noise with parts (more distinct values than PALETTE_LIMIT) round-trips in the raw form', () => {
    const n = 7000;
    const value = (i: number): number => (i % 3 === 0 ? TWO : makePart(B.STONE, i % 64, 1 + (Math.floor(i / 64) % 200)));
    const v = empty(n);
    for (let i = 0; i < n; i++) put(v, i, value(i));
    const bytes = encode(v);
    expect(bytes[0]).toBe(1); // raw
    let raw = 1;
    for (let i = 0; i < n; i++) raw += cellSize(value(i));
    expect(bytes.length).toBe(raw);
    expect(decode(bytes, n)).toEqual(v);
  });

  it('rule 1: runs are cut where the PACKED cell changes (same base, other holes or second part = new run)', () => {
    const v = empty(30);
    v.base.fill(makeCell(B.STONE));
    for (let i = 10; i < 20; i++) put(v, i, makePart(B.STONE, 0, 0x01)); // same id and state, holes differ
    for (let i = 20; i < 30; i++) put(v, i, TWO);
    const bytes = encode(v);
    // palette of 3 entries, 3 runs: u8 enc, vu 3, 3 Cells, 3 one-byte tokens.
    expect(bytes[0]).toBe(0);
    expect(bytes[1]).toBe(3);
    expect(bytes.length).toBe(2 + cellSize(makeCell(B.STONE)) + cellSize(makePart(B.STONE, 0, 1)) + cellSize(TWO) + 3);
    expect(decode(bytes, 30)).toEqual(v);
  });

  it('rule 2: past PALETTE_LIMIT distinct packed cells the raw form is used, and its size still counts every run', () => {
    const n = (PALETTE_LIMIT + 1) * 3;
    const v = empty(n);
    // PALETTE_LIMIT + 1 distinct parts in runs of 3: only the holes and the state vary.
    for (let k = 0; k <= PALETTE_LIMIT; k++) for (let j = 0; j < 3; j++) put(v, k * 3 + j, makePart(B.STONE, k % 64, 1 + Math.floor(k / 64)));
    const bytes = encode(v);
    expect(bytes[0]).toBe(1);
    expect(decode(bytes, n)).toEqual(v);
    // One distinct value fewer: the palette again (it is smaller here).
    const w = empty(n - 3);
    for (let i = 0; i < w.base.length; i++) put(w, i, v.base[i]! | (v.holes![i]! << 16));
    expect(encode(w)[0]).toBe(0);
  });

  it('rule 3: the palette form only when strictly smaller (a tie is raw)', () => {
    // One run of 2 cells of a 1-byte value: palette = vu 1 + Cell 1 + token 1 = 3 bytes, raw = 2.
    const a = empty(2);
    a.base.fill(5);
    expect(encode(a)[0]).toBe(1);
    // Three cells: palette 3 bytes, raw 3 bytes: a tie, raw.
    const b = empty(3);
    b.base.fill(5);
    expect(encode(b)[0]).toBe(1);
    // Four cells: palette 3 < raw 4.
    const c = empty(4);
    c.base.fill(5);
    expect(encode(c)[0]).toBe(0);
  });

  it('the output depends on the content only: null and all-zero layers give the same bytes', () => {
    const v = empty(200);
    v.base.fill(makeCell(B.STONE));
    const zero: CellLayers = { base: v.base, holes: new Uint8Array(200), part2: new Uint32Array(200) };
    expect(encode(zero)).toEqual(encode(v));
  });

  it('the encoder refuses layers of the wrong length and cells with an invalid layout', () => {
    expect(() => encode({ base: new Uint16Array(4), holes: new Uint8Array(3), part2: null })).toThrow(RangeError);
    expect(() => encode({ base: new Uint16Array(4), holes: null, part2: new Uint32Array(5) })).toThrow(RangeError);
    expect(() => encode(empty(0))).toThrow(RangeError);
    const bad = empty(4);
    put(bad, 1, makePart(B.STONE, 0, 0xfe));
    bad.holes![1] = 0xff; // a part without octants
    expect(() => encode(bad)).toThrow(RangeError);
    const noId = empty(4);
    put(noId, 1, TWO);
    noId.part2![1] = makePart(0, 0, 0x0f); // a second part with id 0
    expect(() => encode(noId)).toThrow(RangeError);
  });
});

describe('CellVolume decoding is bounded', () => {
  it('volumeCost: n, plus half for holes, plus 2n for second parts', () => {
    expect(volumeCost(10, false, false)).toBe(10);
    expect(volumeCost(10, true, false)).toBe(15);
    expect(volumeCost(11, true, false)).toBe(17);
    expect(volumeCost(10, false, true)).toBe(30);
    expect(volumeCost(10, true, true)).toBe(35);
  });

  it('charges n first and a layer\'s share only when a cell needs that layer', () => {
    const n = 1000;
    const full = empty(n);
    full.base.fill(1);
    const b1 = { cells: 10_000 };
    decode(encode(full), n, b1);
    expect(b1.cells).toBe(10_000 - n);
    const holed = empty(n);
    holed.base.fill(1);
    put(holed, 7, SLAB);
    const b2 = { cells: 10_000 };
    decode(encode(holed), n, b2);
    expect(b2.cells).toBe(10_000 - volumeCost(n, true, false));
    const two = empty(n);
    put(two, 9, TWO);
    const b3 = { cells: 10_000 };
    decode(encode(two), n, b3);
    expect(b3.cells).toBe(10_000 - volumeCost(n, true, true));
  });

  it('a layer that does not fit the remaining budget fails before it is allocated', () => {
    const n = 1000;
    const two = empty(n);
    put(two, 9, TWO);
    const bytes = encode(two);
    // Enough for the base and the holes, not for the second parts.
    expect(() => decode(bytes, n, { cells: volumeCost(n, true, false) })).toThrow(/second parts .* exceed/);
    expect(() => decode(bytes, n, { cells: n })).toThrow(/holes .* exceed/);
    expect(() => decode(bytes, n, { cells: n - 1 })).toThrow(/exceeds what one message may carry/);
    expect(() => decode(bytes, n, { cells: volumeCost(n, true, true) })).not.toThrow();
  });

  it('an unused palette entry with holes allocates nothing', () => {
    const w = new ByteWriter();
    w.u8(0).varuint(2);
    writeCell(w, 1);
    writeCell(w, TWO); // listed, never used by a run
    w.varuint((10 - 1) * 2 + 0); // one run of 10 cells of entry 0
    const budget = { cells: 10 };
    const v = decode(w.finish(), 10, budget);
    expect(v).toEqual({ base: new Uint16Array(10).fill(1), holes: null, part2: null });
    expect(budget.cells).toBe(0);
  });

  it('malformed volumes fail with SaveFormatError', () => {
    const r = (f: (w: ByteWriter) => void, n: number): (() => CellLayers) => () => {
      const w = new ByteWriter();
      f(w);
      return decode(w.finish(), n);
    };
    expect(r((w) => w.u8(2), 4)).toThrow(SaveFormatError); // unknown encoding
    expect(r((w) => w.u8(0).varuint(0), 4)).toThrow(/palette size/);
    expect(r((w) => w.u8(0).varuint(5).varuint(1).varuint(1).varuint(1).varuint(1).varuint(1), 4)).toThrow(/palette size/);
    expect(r((w) => w.u8(0).varuint(1).varuint(CELL_MULTI_BIT | 1).varuint(0), 4)).toThrow(/second part/);
    expect(r((w) => w.u8(1).varuint(1).varuint(1), 4)).toThrow(/remaining bytes/);
    expect(r((w) => w.u8(0).varuint(1).varuint(1).varuint(4), 4)).toThrow(/overflows/);
  });
});
