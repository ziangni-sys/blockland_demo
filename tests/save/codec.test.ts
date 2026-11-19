import { describe, expect, it } from 'vitest';
import { CHUNK_VOLUME } from '../../src/core/constants';
import { Rng } from '../../src/core/rng';
import { axisState, CELL_MULTI_BIT, cellPrimary, cellSecond, liquidState, makeCell, makePart, PACK_SCALE } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { BLOCKS, CUTTABLE } from '../../src/blocks/registry';
import { canonCell } from '../../src/blocks/shapes';
import { Chunk, cellIndex } from '../../src/voxel/chunk';
import type { ScheduledTick } from '../../src/voxel/world';
import { ByteReader, ByteWriter, SaveFormatError } from '../../src/save/bytes';
import { cellSize, readCellVolume, volumeCost, writeCell, writeCellVolume } from '../../src/save/cells';
import {
  BLOB_MAGIC,
  SAVE_VERSION,
  SaveVersionError,
  beginBlob,
  decodeChunk,
  decodeMeta,
  decodeTicks,
  encodeChunk,
  encodeMeta,
  encodeTicks,
  isNewerSave,
  isOlderSave,
  openBlob,
  sealBlob,
  validateMeta,
  type WorldMeta,
} from '../../src/save/codec';
import { crc32 } from '../../src/save/crc32';

// Raw numeric cells keep the codec tests independent of the block table's evolution; decodeChunk
// checks every cell with cellProblem, so each of these is a registered id.
const STONE = 1;
const DIRT = 3;
const TURF = 4;
const SAND = 5;
const DEEPROCK = 7;
const LOG = 8;
const LEAVES = 12;
const ORE = 19;
const WATER = 40;

/**
 * Every registered block id that can be a stored content: not air (it carries no state bits) and
 * not the unloaded reading (cellProblem refuses it). And the ones that can be cut.
 */
const REGISTERED = BLOCKS.flatMap((d, id) => (d !== undefined && id !== 0 && id !== B.UNLOADED ? [id] : []));
const CUTTABLE_IDS = REGISTERED.filter((id) => CUTTABLE[id] === 1);

/** Write a packed cell (both parts) into a chunk's layers (Chunk.writeCell: no world, no events). */
function put(c: Chunk, lx: number, y: number, lz: number, packed: number): void {
  c.writeCell(cellIndex(lx, y, lz), cellPrimary(packed), cellSecond(packed));
}

/** The chunk's cells as the codec sees them (layers with no non-zero entry as null). */
function layersOf(c: Chunk): { base: Uint16Array; holes: Uint8Array | null; part2: Uint32Array | null } {
  const l = c.layers();
  return {
    base: l.base,
    holes: l.holes !== null && l.holes.some((v) => v !== 0) ? l.holes : null,
    part2: l.part2 !== null && l.part2.some((v) => v !== 0) ? l.part2 : null,
  };
}

/** Rolling terrain with ores, caves, a tree, a pond and state-carrying cells. */
function terrainChunk(cx: number, cz: number, seed = 1): Chunk {
  const c = new Chunk(cx, cz);
  const rng = new Rng(seed);
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const h = 60 + Math.round(3 * Math.sin((lx + cx * 16) * 0.3) + 2 * Math.cos((lz + cz * 16) * 0.25));
      for (let y = 0; y <= h; y++) {
        let cell: number;
        if (y === 0) cell = DEEPROCK;
        else if (y < h - 3) cell = rng.chance(0.015) ? ORE : STONE;
        else if (y < h) cell = DIRT;
        else cell = TURF;
        if (y > 20 && y < 26 && lx > 3 && lx < 10 && lz > 5 && lz < 12) cell = 0; // cave
        c.cells[cellIndex(lx, y, lz)] = cell;
      }
      if (lx > 10 && lz > 10) {
        // pond with flowing water levels in the state bits
        for (let y = h - 1; y <= h; y++) c.cells[cellIndex(lx, y, lz)] = makeCell(WATER, liquidState(lx - 10, false));
        c.cells[cellIndex(lx, h - 2, lz)] = SAND;
      }
    }
  }
  // a tree: vertical log column with axis state, leaves around
  for (let y = 64; y < 70; y++) c.cells[cellIndex(4, y, 4)] = makeCell(LOG, axisState(1));
  for (let x = 2; x <= 6; x++) for (let z = 2; z <= 6; z++) for (let y = 68; y < 71; y++) if (x !== 4 || z !== 4) c.cells[cellIndex(x, y, z)] = LEAVES;
  // a horizontal log (axis x) and a registered block using every state bit
  c.cells[cellIndex(8, 70, 8)] = makeCell(LOG, axisState(0));
  c.cells[cellIndex(9, 70, 8)] = makeCell(STONE, 63);
  return c;
}

/** Noise of registered full blocks with random state bits. */
function noiseChunk(seed: number): Chunk {
  const c = new Chunk(-3, 7);
  const rng = new Rng(seed);
  for (let i = 0; i < CHUNK_VOLUME; i++) c.cells[i] = makeCell(REGISTERED[rng.int(0, REGISTERED.length - 1)]!, rng.int(0, 63));
  return c;
}

/** A random valid part with holes, or a random valid two-part cell. */
function randomPartial(rng: Rng): number {
  const fa = rng.int(1, 254);
  const a = makePart(CUTTABLE_IDS[rng.int(0, CUTTABLE_IDS.length - 1)]!, rng.int(0, 63), ~fa & 0xff);
  if (rng.chance(0.5)) return a;
  const rest = ~fa & 0xff;
  let fb = 0;
  for (let o = 0; o < 8; o++) if ((rest >> o) & 1 && rng.chance(0.5)) fb |= 1 << o;
  if (fb === 0) fb = rest & -rest;
  return canonCell(a, makePart(CUTTABLE_IDS[rng.int(0, CUTTABLE_IDS.length - 1)]!, rng.int(0, 63), ~fb & 0xff));
}

/** Noise of registered full blocks, parts with holes and two-part cells. */
function partialNoiseChunk(seed: number): Chunk {
  const c = new Chunk(4, -2);
  const rng = new Rng(seed);
  for (let i = 0; i < CHUNK_VOLUME; i++) {
    const packed = rng.chance(0.4) ? randomPartial(rng) : makeCell(REGISTERED[rng.int(0, REGISTERED.length - 1)]!, rng.int(0, 63));
    put(c, i & 15, i >> 8, (i >> 4) & 15, packed);
  }
  return c;
}

/** Sum of the cells' Cell sizes: the size of the raw form's cells. */
function rawCellBytes(c: Chunk): number {
  const l = c.layers();
  let n = 0;
  for (let i = 0; i < CHUNK_VOLUME; i++) {
    const q = l.part2 !== null ? l.part2[i]! : 0;
    n += cellSize((l.base[i]! | (l.holes !== null ? l.holes[i]! << 16 : 0) | (q !== 0 ? CELL_MULTI_BIT : 0)) + q * PACK_SCALE);
  }
  return n;
}

function meta(over: Partial<WorldMeta> = {}): WorldMeta {
  return {
    id: 'w-123',
    name: '方块 Island ⛵',
    seed: 'windmill',
    seedHash: 0xdeadbeef,
    mode: 'survival',
    createdAt: 1_700_000_000_000,
    lastPlayed: 1_700_000_123_456.5,
    version: SAVE_VERSION,
    time: 123_456,
    ...over,
  };
}

/** A blob with a valid header and checksum around an arbitrary payload. */
function craft(magic: string, payload: (w: ByteWriter) => void, version = SAVE_VERSION): Uint8Array {
  const w = new ByteWriter();
  for (let i = 0; i < 4; i++) w.u8(magic.charCodeAt(i));
  w.varuint(version);
  payload(w);
  w.u32(crc32(w.subarray()));
  return w.finish();
}

describe('blob envelope', () => {
  it('round-trips and exposes the version', () => {
    const w = beginBlob('TEST');
    w.string('payload');
    const bytes = sealBlob(w);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('TEST');
    const { reader, version } = openBlob(bytes, 'TEST');
    expect(version).toBe(SAVE_VERSION);
    expect(reader.string()).toBe('payload');
    reader.expectEnd();
  });

  it('rejects wrong type, short input, newer versions and bad checksums', () => {
    const good = sealBlob(beginBlob('TEST').u32(5));
    expect(() => openBlob(good, 'OTHR')).toThrow(/wrong blob type/);
    expect(() => openBlob(new Uint8Array(3), 'TEST')).toThrow(/too short/);
    expect(() => openBlob(craft('TEST', (w) => w.u32(5), SAVE_VERSION + 1), 'TEST')).toThrow(/newer version/);
    expect(() => openBlob(craft('TEST', (w) => w.u32(5), 0), 'TEST')).toThrow(/format 0 is from an older version/);
    const bad = good.slice();
    bad[6] ^= 1;
    expect(() => openBlob(bad, 'TEST')).toThrow(/checksum/);
    expect(() => beginBlob('TOOLONG')).toThrow(RangeError);
  });

  it('reports intact newer data as SaveVersionError, distinct from corruption', () => {
    const newer = craft('TEST', (w) => w.u32(5), SAVE_VERSION + 2);
    let caught: unknown = null;
    try {
      openBlob(newer, 'TEST');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SaveVersionError);
    expect(caught).toBeInstanceOf(SaveFormatError); // generic handlers still catch it
    expect((caught as SaveVersionError).version).toBe(SAVE_VERSION + 2);
    expect((caught as Error).name).toBe('SaveVersionError');
    // Corruption is never mistaken for a newer version: not even a corrupted version byte,
    // because the checksum is verified before the version is trusted.
    const good = sealBlob(beginBlob('TEST').u32(5));
    for (const v of [0, 1, 2, 3, 0x7f, 0x80].filter((x) => x !== SAVE_VERSION)) {
      const bad = good.slice();
      bad[4] = v;
      expect(() => openBlob(bad, 'TEST')).toThrow(/checksum/);
      try {
        openBlob(bad, 'TEST');
      } catch (e) {
        expect(e).not.toBeInstanceOf(SaveVersionError);
      }
    }
  });

  it('isNewerSave flags worlds written by a newer build', () => {
    expect(isNewerSave({ version: SAVE_VERSION })).toBe(false);
    expect(isNewerSave({ version: 1 })).toBe(false);
    expect(isNewerSave({ version: SAVE_VERSION + 1 })).toBe(true);
  });

  it('no backward compatibility: intact blobs and worlds of an older format are refused (not as "newer")', () => {
    expect(SAVE_VERSION).toBeGreaterThan(1);
    for (let v = 1; v < SAVE_VERSION; v++) {
      const older = craft('TEST', (w) => w.u32(5), v);
      let caught: unknown = null;
      try {
        openBlob(older, 'TEST');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SaveFormatError);
      expect(caught).not.toBeInstanceOf(SaveVersionError);
      expect((caught as Error).message).toMatch(new RegExp(`format ${v} is from an older version of the game`));
      expect(isOlderSave({ version: v })).toBe(true);
    }
    expect(isOlderSave({ version: SAVE_VERSION })).toBe(false);
    expect(isOlderSave({ version: SAVE_VERSION + 1 })).toBe(false);
  });
});

describe('chunk codec', () => {
  it('round-trips layered terrain in well under 8 KB', () => {
    const c = terrainChunk(5, -9);
    const bytes = encodeChunk(c);
    expect(bytes.length).toBeLessThan(8 * 1024);
    const d = decodeChunk(bytes);
    expect(d.cx).toBe(5);
    expect(d.cz).toBe(-9);
    expect(d.layers).toEqual({ base: c.cells, holes: null, part2: null });
    expect(d.layers.base).not.toBe(c.cells);
    // the decoded layers build a valid Chunk
    const back = new Chunk(d.cx, d.cz, d.layers.base, undefined, d.layers.holes, d.layers.part2);
    expect(back.cells[cellIndex(4, 65, 4)]).toBe(makeCell(LOG, axisState(1)));
    expect(back.cells[cellIndex(9, 70, 8)]).toBe(makeCell(STONE, 63));
  });

  it('compresses uniform chunks to a few bytes', () => {
    const empty = new Chunk(0, 0);
    const e = encodeChunk(empty);
    expect(e.length).toBeLessThan(24);
    expect(decodeChunk(e).layers.base).toEqual(empty.cells);
    const full = new Chunk(1, 1);
    full.cells.fill(STONE);
    expect(decodeChunk(encodeChunk(full)).layers.base).toEqual(full.cells);
    const flat = new Chunk(2, 2);
    for (let y = 0; y < 50; y++) for (let i = 0; i < 256; i++) flat.cells[(y << 8) | i] = y === 0 ? DEEPROCK : y < 45 ? STONE : DIRT;
    expect(encodeChunk(flat).length).toBeLessThan(32);
    expect(decodeChunk(encodeChunk(flat)).layers.base).toEqual(flat.cells);
  });

  it('round-trips random noise and never exceeds the raw size (the cells\' Cell sizes + 16)', () => {
    for (const seed of [1, 2, 3]) {
      const c = noiseChunk(seed);
      const bytes = encodeChunk(c);
      expect(bytes.length).toBeLessThanOrEqual(rawCellBytes(c) + 16);
      const d = decodeChunk(bytes);
      expect(d.layers).toEqual({ base: c.cells, holes: null, part2: null });
      expect([d.cx, d.cz]).toEqual([-3, 7]);
    }
  });

  it('round-trips noise of parts with holes and two-part cells, within the raw size', () => {
    for (const seed of [4, 5]) {
      const c = partialNoiseChunk(seed);
      expect(c.holes).not.toBeNull();
      expect(c.part2).not.toBeNull();
      const bytes = encodeChunk(c);
      expect(bytes.length).toBeLessThanOrEqual(rawCellBytes(c) + 16);
      expect(decodeChunk(bytes).layers).toEqual(layersOf(c));
    }
  });

  it('round-trips low-entropy noise (few values, short runs) via whichever encoding is smaller', () => {
    const rng = new Rng(99);
    for (const values of [2, 5, 200, 3000]) {
      const c = new Chunk(0, 0);
      const pool = Array.from({ length: values }, (_, k) => makeCell(REGISTERED[k % REGISTERED.length]!, Math.floor(k / REGISTERED.length) % 64));
      for (let i = 0; i < CHUNK_VOLUME; i++) c.cells[i] = pool[rng.int(0, values - 1)]!;
      const bytes = encodeChunk(c);
      expect(bytes.length).toBeLessThanOrEqual(rawCellBytes(c) + 16);
      expect(decodeChunk(bytes).layers.base).toEqual(c.cells);
    }
  });

  it('round-trips a part with holes, a two-part cell and a two-part cell that fills its cell', () => {
    const c = terrainChunk(1, 1, 3);
    const slab = makePart(B.PLANKS_OAK, 0, 0xcc); // a lower half slab
    const two = canonCell(makePart(B.STONE, 0, 0xcc), makePart(B.GLASS, 0, 0x33)); // stone below, glass above
    const filled = canonCell(makePart(B.PLANKS_OAK, 0, 0xcc), makePart(B.PLANKS_OAK, 0, 0x33)); // two halves of one material
    put(c, 2, 90, 3, slab);
    put(c, 3, 90, 3, two);
    put(c, 4, 90, 3, filled);
    put(c, 15, 127, 15, makePart(B.STONE_BRICKS, 0, 0x7f)); // a single octant, top corner
    const d = decodeChunk(encodeChunk(c));
    expect(d.layers).toEqual(layersOf(c));
    const back = new Chunk(1, 1, d.layers.base, undefined, d.layers.holes, d.layers.part2);
    const at = (lx: number, y: number, lz: number): number => {
      const i = cellIndex(lx, y, lz);
      const q = back.part2 !== null ? back.part2[i]! : 0;
      return (back.cells[i]! | (back.holes !== null ? back.holes[i]! << 16 : 0) | (q !== 0 ? CELL_MULTI_BIT : 0)) + q * PACK_SCALE;
    };
    expect([at(2, 90, 3), at(3, 90, 3), at(4, 90, 3), at(15, 127, 15)]).toEqual([slab, two, filled, makePart(B.STONE_BRICKS, 0, 0x7f)]);
  });

  it('a layer allocated but all zero again encodes and decodes as if it never existed', () => {
    const c = terrainChunk(2, 2);
    const before = encodeChunk(c);
    put(c, 5, 80, 5, canonCell(makePart(B.STONE, 0, 0xcc), makePart(B.DIRT, 0, 0x33)));
    put(c, 5, 80, 5, 0);
    expect(c.holes).not.toBeNull(); // still allocated (the codec reads layers(), which hands out null)
    expect(encodeChunk(c)).toEqual(before);
    expect(decodeChunk(before).layers.holes).toBeNull();
  });

  it('size: each more separate half slab of the same kind costs at most 6 bytes', () => {
    const c = terrainChunk(0, 0, 7);
    const slab = makePart(B.PLANKS_OAK, 0, 0xcc);
    put(c, 1, 100, 1, slab);
    let prev = encodeChunk(c).length;
    for (let k = 1; k <= 12; k++) {
      // Not adjacent to each other (nor in one run): every other cell of every other row and layer.
      put(c, 1 + 2 * (k % 6), 100 + 2 * Math.floor(k / 6), 5 + 2 * (k % 4), slab);
      const now = encodeChunk(c).length;
      expect(now - prev, `slab ${k}`).toBeLessThanOrEqual(6);
      prev = now;
    }
  });

  it('size: a palette chunk of full blocks is the format-3 length - 2 x palette entries + their Cell sizes', () => {
    for (const c of [terrainChunk(5, -9), terrainChunk(-2, 3, 9)]) {
      // Format 3 (u16 palette entries), counted independently: header, u8 enc, vu P, P x u16, tokens, CRC.
      const palette: number[] = [];
      const index = new Map<number, number>();
      const runs: Array<[number, number]> = [];
      for (let i = 0; i < CHUNK_VOLUME; i++) {
        const v = c.cells[i]!;
        if (!index.has(v)) {
          index.set(v, palette.length);
          palette.push(v);
        }
        const last = runs[runs.length - 1];
        if (last !== undefined && palette[last[0]] === v) last[1]++;
        else runs.push([index.get(v)!, 1]);
      }
      const vu = (v: number): number => (v < 2 ** 7 ? 1 : v < 2 ** 14 ? 2 : v < 2 ** 21 ? 3 : v < 2 ** 28 ? 4 : 5);
      const vi = (v: number): number => vu(v >= 0 ? v * 2 : -v * 2 - 1);
      const bits = palette.length > 1 ? 32 - Math.clz32(palette.length - 1) : 0;
      const tokens = runs.reduce((n, [k, len]) => n + vu((len - 1) * 2 ** bits + k), 0);
      const format3 = 4 + vu(SAVE_VERSION) + vi(c.cx) + vi(c.cz) + 1 + vu(palette.length) + 2 * palette.length + tokens + 4;
      const expected = format3 - 2 * palette.length + palette.reduce((n, v) => n + cellSize(v), 0);
      expect(encodeChunk(c).length).toBe(expected);
    }
  });

  it('handles the extreme chunk coordinates chunkKey supports', () => {
    for (const [cx, cz] of [[-524288, 524287], [524287, -524288], [0, -1]] as const) {
      const c = new Chunk(cx, cz);
      c.cells[cellIndex(1, 2, 3)] = STONE;
      const d = decodeChunk(encodeChunk(c));
      expect([d.cx, d.cz]).toEqual([cx, cz]);
      expect(d.layers.base[cellIndex(1, 2, 3)]).toBe(STONE);
    }
    expect(() => encodeChunk(new Chunk(524288, 0))).toThrow(RangeError);
  });

  it('every single-byte corruption and every truncation throws SaveFormatError', () => {
    const c = terrainChunk(1, 2, 5);
    put(c, 3, 99, 3, canonCell(makePart(B.STONE, 0, 0xcc), makePart(B.DIRT, 0, 0x33)));
    const bytes = encodeChunk(c);
    for (let i = 0; i < bytes.length; i++) {
      for (const flip of [0x01, 0x80, 0xff]) {
        const bad = bytes.slice();
        bad[i] ^= flip;
        expect(() => decodeChunk(bad), `byte ${i} ^ ${flip}`).toThrow(SaveFormatError);
      }
    }
    for (let n = 0; n < bytes.length; n++) {
      expect(() => decodeChunk(bytes.subarray(0, n)), `truncated to ${n}`).toThrow(SaveFormatError);
    }
    const extended = new Uint8Array(bytes.length + 1);
    extended.set(bytes);
    expect(() => decodeChunk(extended)).toThrow(SaveFormatError);
  });

  it('rejects structurally invalid payloads even with a valid checksum', () => {
    const M = BLOB_MAGIC.chunk;
    const head = (w: ByteWriter): ByteWriter => w.varint(0).varint(0);
    // runs that do not cover the chunk
    expect(() => decodeChunk(craft(M, (w) => head(w).u8(0).varuint(1).varuint(5).varuint(100)))).toThrow(/unexpected end/);
    // run overflowing the chunk: palette of 2 (1 index bit), run of 32768 at offset 1
    expect(() => decodeChunk(craft(M, (w) => head(w).u8(0).varuint(2).varuint(1).varuint(3).varuint(0).varuint(32767 << 1)))).toThrow(/overflows/);
    // palette index out of range: palette of 3 (2 bits), index 3
    expect(() => decodeChunk(craft(M, (w) => head(w).u8(0).varuint(3).varuint(1).varuint(3).varuint(4).varuint(3)))).toThrow(/palette index/);
    // a token too big to be a run (the run-length part alone exceeds the chunk)
    for (const token of [32768, 2 ** 40, 2 ** 52]) {
      expect(() => decodeChunk(craft(M, (w) => head(w).u8(0).varuint(1).varuint(1).varuint(token)))).toThrow(/overflows/);
    }
    // a palette entry that is not a valid Cell (holes 0xff)
    expect(() => decodeChunk(craft(M, (w) => head(w).u8(0).varuint(1).varuint(makePart(1, 0, 0xff)).varuint(32767)))).toThrow(/without octants/);
    // empty palette
    expect(() => decodeChunk(craft(M, (w) => head(w).u8(0).varuint(0)))).toThrow(/palette size/);
    // trailing data after a complete chunk
    expect(() => decodeChunk(craft(M, (w) => head(w).u8(0).varuint(1).varuint(1).varuint(32767).u8(0)))).toThrow(/trailing/);
    // raw form cut short
    expect(() => decodeChunk(craft(M, (w) => {
      head(w).u8(1);
      for (let i = 0; i < 1000; i++) w.varuint(STONE);
    }))).toThrow(/remaining bytes/);
    expect(() => decodeChunk(craft(M, (w) => {
      head(w).u8(1);
      for (let i = 0; i < CHUNK_VOLUME - 1; i++) w.varuint(STONE);
      w.varuint(CELL_MULTI_BIT | STONE); // the last Cell's second part is missing
    }))).toThrow(/unexpected end/);
    // unknown encoding
    expect(() => decodeChunk(craft(M, (w) => head(w).u8(7)))).toThrow(/encoding 7/);
    // coordinates outside chunkKey's range
    expect(() => decodeChunk(craft(M, (w) => w.varint(600000).varint(0).u8(0).varuint(1).varuint(0).varuint(32767)))).toThrow(/coordinates/);
    // correct crafted payloads decode (sanity check of the helper): palette, and raw
    expect(decodeChunk(craft(M, (w) => head(w).u8(0).varuint(1).varuint(9).varuint(32767))).layers.base[100]).toBe(9);
    const raw = decodeChunk(craft(M, (w) => {
      head(w).u8(1);
      for (let i = 0; i < CHUNK_VOLUME; i++) writeCell(w, i === 7 ? makePart(B.STONE, 0, 0x0f) : 0);
    }));
    expect([raw.layers.base[7], raw.layers.holes![7], raw.layers.part2]).toEqual([B.STONE, 0x0f, null]);
  });

  it('rejects cells that are not valid (cellProblem) even when the layout and the checksum are', () => {
    const M = BLOB_MAGIC.chunk;
    const one = (cell: number) => craft(M, (w) => {
      w.varint(0).varint(0).u8(0).varuint(2);
      writeCell(w, 0);
      writeCell(w, cell);
      w.varuint(0 * 2 + 0).varuint((32766 * 2) + 1); // one air cell, then the rest of the column
    });
    expect(decodeChunk(one(makeCell(B.STONE))).layers.base[5]).toBe(B.STONE); // the helper is right
    const overlap = (CELL_MULTI_BIT | makePart(B.STONE, 0, 0xcc)) + makePart(B.DIRT, 0, 0xc8) * PACK_SCALE;
    expect(() => decodeChunk(one(overlap))).toThrow(/overlap/);
    expect(() => decodeChunk(one(makePart(B.HELM, 0, 0x0f)))).toThrow(/cannot be cut/);
    expect(() => decodeChunk(one(makeCell(999)))).toThrow(/unknown block id/);
    expect(() => decodeChunk(one((CELL_MULTI_BIT | makePart(B.STONE, 0, 0x33)) + makePart(B.DIRT, 0, 0xcc) * PACK_SCALE))).toThrow(/out of order/);
    expect(() => decodeChunk(one(0x0400))).toThrow(/id 0/);
    // The raw form too.
    const raw = craft(M, (w) => {
      w.varint(0).varint(0).u8(1);
      for (let i = 0; i < CHUNK_VOLUME; i++) writeCell(w, i === 9 ? makeCell(999) : 0);
    });
    expect(() => decodeChunk(raw)).toThrow(/unknown block id/);
    // Every palette entry is checked (13.3), also one that no run uses.
    const unused = craft(M, (w) => {
      w.varint(0).varint(0).u8(0).varuint(2);
      writeCell(w, 0);
      writeCell(w, makeCell(999));
      w.varuint((32767 * 2) + 0); // the whole column is entry 0 (air)
    });
    expect(() => decodeChunk(unused)).toThrow(/palette entry 1: unknown block id/);
  });

  it('checks each palette entry once (and each raw cell only where the value changes), not every cell', () => {
    const c = terrainChunk(2, 3, 9);
    put(c, 3, 99, 3, canonCell(makePart(B.STONE, 0, 0xcc), makePart(B.DIRT, 0, 0x33)));
    for (const raw of [false, true]) {
      const layers = c.layers();
      const w = new ByteWriter();
      if (raw) {
        // The raw form, built by hand: every cell as a Cell.
        w.u8(1);
        for (let i = 0; i < CHUNK_VOLUME; i++) {
          const q = layers.part2 !== null ? layers.part2[i]! : 0;
          writeCell(w, (layers.base[i]! | (layers.holes !== null ? layers.holes[i]! << 16 : 0) | (q !== 0 ? CELL_MULTI_BIT : 0)) + q * PACK_SCALE);
        }
      } else {
        writeCellVolume(w, layers);
      }
      const seen: number[] = [];
      const back = readCellVolume(new ByteReader(w.finish()), CHUNK_VOLUME, { cells: volumeCost(CHUNK_VOLUME, true, true) }, (v) => {
        seen.push(v);
        return null;
      });
      expect(back.base).toEqual(layers.base);
      let changes = 1;
      for (let i = 1; i < CHUNK_VOLUME; i++) if (layers.base[i] !== layers.base[i - 1] || layers.holes![i] !== layers.holes![i - 1]) changes++;
      if (raw) expect(seen.length).toBe(changes);
      else expect(seen.length).toBe(new Set(seen).size); // one call per palette entry
      expect(seen.length).toBeLessThan(raw ? 6000 : 100);
    }
  });

  it('rejects an unknown version and the wrong blob type', () => {
    const c = terrainChunk(0, 0);
    const bytes = encodeChunk(c);
    const newer = craft(BLOB_MAGIC.chunk, (w) => w.raw(bytes.subarray(5, bytes.length - 4)), SAVE_VERSION + 6);
    expect(() => decodeChunk(newer)).toThrow(SaveVersionError);
    expect(() => decodeChunk(newer)).toThrow(new RegExp(`newer version of the game \\(format ${SAVE_VERSION + 6}`));
    // The reviewer's case: a corrupted version byte in a real chunk is corruption, not "newer".
    const flipped = bytes.slice();
    flipped[4] = SAVE_VERSION + 1;
    expect(() => decodeChunk(flipped)).toThrow(/checksum/);
    expect(() => decodeChunk(encodeTicks([], 0))).toThrow(/wrong blob type/);
    expect(() => decodeChunk(encodeMeta(meta()))).toThrow(SaveFormatError);
  });

  it('is deterministic', () => {
    expect(encodeChunk(terrainChunk(3, 3))).toEqual(encodeChunk(terrainChunk(3, 3)));
    expect(encodeChunk(partialNoiseChunk(8))).toEqual(encodeChunk(partialNoiseChunk(8)));
  });
});

describe('tick codec', () => {
  const ticks: ScheduledTick[] = [
    { x: 10, y: 50, z: -3, id: WATER, at: 1005 },
    { x: 11, y: 50, z: -3, id: WATER, at: 1005 },
    { x: -4_000_000, y: 0, z: 4_000_000, id: 1023, at: 2000 },
    { x: 9, y: 127, z: -4, id: 41, at: 1030 },
    { x: 9, y: 127, z: -4, id: 41, at: 999 }, // overdue
    { x: 0, y: 1, z: 0, id: SAND, at: 1000 }, // due now
  ];

  it('stores remaining delays, so ticks survive a different world.time base', () => {
    const bytes = encodeTicks(ticks, 1000);
    const back = decodeTicks(bytes, 5);
    expect(back).toEqual([
      { x: 10, y: 50, z: -3, id: WATER, at: 10 },
      { x: 11, y: 50, z: -3, id: WATER, at: 10 },
      { x: -4_000_000, y: 0, z: 4_000_000, id: 1023, at: 1005 },
      { x: 9, y: 127, z: -4, id: 41, at: 35 },
      { x: 9, y: 127, z: -4, id: 41, at: 6 }, // clamped to delay 1
      { x: 0, y: 1, z: 0, id: SAND, at: 6 }, // clamped to delay 1
    ]);
    // same base: future ticks keep their exact time
    expect(decodeTicks(bytes, 1000)[0]!.at).toBe(1005);
  });

  it('preserves order and handles empty and large lists compactly', () => {
    expect(decodeTicks(encodeTicks([], 0), 0)).toEqual([]);
    const pool: ScheduledTick[] = [];
    for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) pool.push({ x: 100 + x, y: 60, z: 300 + z, id: WATER, at: 7 + ((x + z) & 3) });
    const bytes = encodeTicks(pool, 5);
    expect(bytes.length).toBeLessThan(pool.length * 5 + 32);
    expect(decodeTicks(bytes, 5)).toEqual(pool);
  });

  it('validates on encode and decode', () => {
    expect(() => encodeTicks([{ x: 0, y: 128, z: 0, id: 1, at: 1 }], 0)).toThrow(RangeError);
    expect(() => encodeTicks([{ x: 0.5, y: 1, z: 0, id: 1, at: 1 }], 0)).toThrow(RangeError);
    expect(() => encodeTicks([{ x: 0, y: 1, z: 0, id: 1024, at: 1 }], 0)).toThrow(RangeError);
    expect(() => encodeTicks([{ x: 0, y: 1, z: 2 ** 22, id: 1, at: 1 }], 0)).toThrow(RangeError);
    expect(() => encodeTicks([], 0.5)).toThrow(RangeError);
    const M = BLOB_MAGIC.ticks;
    expect(() => decodeTicks(craft(M, (w) => w.varuint(1).varint(0).varint(-1).varint(0).varuint(1).varuint(1)), 0)).toThrow(/y -1/);
    expect(() => decodeTicks(craft(M, (w) => w.varuint(1).varint(0).varint(1).varint(0).varuint(1).varuint(0)), 0)).toThrow(/delay/);
    expect(() => decodeTicks(craft(M, (w) => w.varuint(1).varint(0).varint(1).varint(0).varuint(5000).varuint(1)), 0)).toThrow(/block id/);
    expect(() => decodeTicks(craft(M, (w) => w.varuint(1000)), 0)).toThrow(/exceeds/);
    expect(() => decodeTicks(craft(M, (w) => w.varuint(0).u8(1)), 0)).toThrow(/trailing/);
    const good = encodeTicks(ticks, 1000);
    for (let n = 0; n < good.length; n++) expect(() => decodeTicks(good.subarray(0, n), 0)).toThrow(SaveFormatError);
  });
});

describe('meta codec', () => {
  it('round-trips every field', () => {
    const m = meta();
    expect(decodeMeta(encodeMeta(m))).toEqual(m);
    const c = meta({ mode: 'creative', name: '', seed: '', seedHash: 0, createdAt: 0, lastPlayed: 0, time: 0, version: 1 });
    expect(decodeMeta(encodeMeta(c))).toEqual(c);
    const big = meta({ seedHash: 0xffffffff, time: Number.MAX_SAFE_INTEGER, name: 'n'.repeat(256), id: 'i'.repeat(128) });
    expect(decodeMeta(encodeMeta(big))).toEqual(big);
  });

  it('drops unknown fields', () => {
    const withExtra = { ...meta(), extra: 'x' } as WorldMeta;
    expect(decodeMeta(encodeMeta(withExtra))).toEqual(meta());
  });

  it('rejects invalid meta on encode with TypeError', () => {
    const bad: Array<Partial<Record<keyof WorldMeta, unknown>>> = [
      { id: '' },
      { id: 'x'.repeat(129) },
      { id: 5 },
      { name: 'n'.repeat(257) },
      { seed: null },
      { seedHash: -1 },
      { seedHash: 2 ** 32 },
      { seedHash: 1.5 },
      { mode: 'hardcore' },
      { createdAt: NaN },
      { createdAt: -1 },
      { lastPlayed: Infinity },
      { version: 0 },
      { version: 1.5 },
      { time: -1 },
      { time: 2 ** 53 },
    ];
    for (const b of bad) {
      expect(() => encodeMeta({ ...meta(), ...b } as WorldMeta), JSON.stringify(b)).toThrow(TypeError);
      expect(() => validateMeta({ ...meta(), ...b }), JSON.stringify(b)).toThrow(TypeError);
    }
    expect(() => validateMeta(null)).toThrow(TypeError);
    expect(() => validateMeta(meta())).not.toThrow();
  });

  it('rejects invalid or corrupted meta bytes with SaveFormatError', () => {
    const M = BLOB_MAGIC.meta;
    const fields = (w: ByteWriter, mode: number, id = 'a', version = 1): ByteWriter =>
      w.string(id).string('n').string('s').u32(1).u8(mode).f64(1).f64(2).varuint(version).varuint(3);
    expect(decodeMeta(craft(M, (w) => fields(w, 1))).mode).toBe('survival');
    expect(() => decodeMeta(craft(M, (w) => fields(w, 2)))).toThrow(/game mode/);
    expect(() => decodeMeta(craft(M, (w) => fields(w, 0, '')))).toThrow(/id/);
    expect(() => decodeMeta(craft(M, (w) => fields(w, 0, 'a', 0)))).toThrow(/version/);
    expect(() => decodeMeta(craft(M, (w) => fields(w, 0).u8(0)))).toThrow(/trailing/);
    const good = encodeMeta(meta());
    for (let i = 0; i < good.length; i++) {
      const bad = good.slice();
      bad[i] ^= 0x10;
      expect(() => decodeMeta(bad)).toThrow(SaveFormatError);
    }
  });
});
