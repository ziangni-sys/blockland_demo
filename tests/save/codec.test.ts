import { describe, expect, it } from 'vitest';
import { CHUNK_VOLUME } from '../../src/core/constants';
import { Rng } from '../../src/core/rng';
import { axisState, liquidState, makeCell } from '../../src/blocks/cell';
import { Chunk, cellIndex } from '../../src/voxel/chunk';
import type { ScheduledTick } from '../../src/voxel/world';
import { ByteWriter, SaveFormatError } from '../../src/save/bytes';
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

// Raw numeric cells keep the codec tests independent of the block table's evolution.
const STONE = 1;
const DIRT = 3;
const TURF = 4;
const SAND = 5;
const DEEPROCK = 7;
const LOG = 8;
const LEAVES = 12;
const ORE = 19;
const WATER = 40;

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
        c.set(lx, y, lz, cell);
      }
      if (lx > 10 && lz > 10) {
        // pond with flowing water levels in the state bits
        for (let y = h - 1; y <= h; y++) c.set(lx, y, lz, makeCell(WATER, liquidState(lx - 10, false)));
        c.set(lx, h - 2, lz, SAND);
      }
    }
  }
  // a tree: vertical log column with axis state, leaves around
  for (let y = 64; y < 70; y++) c.set(4, y, 4, makeCell(LOG, axisState(1)));
  for (let x = 2; x <= 6; x++) for (let z = 2; z <= 6; z++) for (let y = 68; y < 71; y++) if (x !== 4 || z !== 4) c.set(x, y, z, LEAVES);
  // a horizontal log (axis x) and a cell using every state bit
  c.set(8, 70, 8, makeCell(LOG, axisState(0)));
  c.set(9, 70, 8, 0xffff);
  return c;
}

function noiseChunk(seed: number): Chunk {
  const c = new Chunk(-3, 7);
  const rng = new Rng(seed);
  for (let i = 0; i < CHUNK_VOLUME; i++) c.cells[i] = rng.nextU32() & 0xffff;
  return c;
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
    expect(d.cells).toEqual(c.cells);
    expect(d.cells).not.toBe(c.cells);
    // the decoded cells build a valid Chunk
    const back = new Chunk(d.cx, d.cz, d.cells);
    expect(back.get(4, 65, 4)).toBe(makeCell(LOG, axisState(1)));
    expect(back.get(9, 70, 8)).toBe(0xffff);
  });

  it('compresses uniform chunks to a few bytes', () => {
    const empty = new Chunk(0, 0);
    const e = encodeChunk(empty);
    expect(e.length).toBeLessThan(24);
    expect(decodeChunk(e).cells).toEqual(empty.cells);
    const full = new Chunk(1, 1);
    full.cells.fill(STONE);
    expect(decodeChunk(encodeChunk(full)).cells).toEqual(full.cells);
    const flat = new Chunk(2, 2);
    for (let y = 0; y < 50; y++) for (let i = 0; i < 256; i++) flat.cells[(y << 8) | i] = y === 0 ? DEEPROCK : y < 45 ? STONE : DIRT;
    expect(encodeChunk(flat).length).toBeLessThan(32);
    expect(decodeChunk(encodeChunk(flat)).cells).toEqual(flat.cells);
  });

  it('round-trips random noise and never exceeds raw size', () => {
    for (const seed of [1, 2, 3]) {
      const c = noiseChunk(seed);
      const bytes = encodeChunk(c);
      expect(bytes.length).toBeLessThanOrEqual(CHUNK_VOLUME * 2 + 16);
      const d = decodeChunk(bytes);
      expect(d.cells).toEqual(c.cells);
      expect([d.cx, d.cz]).toEqual([-3, 7]);
    }
  });

  it('round-trips low-entropy noise (few values, short runs) via whichever encoding is smaller', () => {
    const rng = new Rng(99);
    for (const values of [2, 5, 200, 3000]) {
      const c = new Chunk(0, 0);
      for (let i = 0; i < CHUNK_VOLUME; i++) c.cells[i] = rng.int(0, values - 1) * 37;
      const bytes = encodeChunk(c);
      expect(bytes.length).toBeLessThanOrEqual(CHUNK_VOLUME * 2 + 16);
      expect(decodeChunk(bytes).cells).toEqual(c.cells);
    }
  });

  it('handles the extreme chunk coordinates chunkKey supports', () => {
    for (const [cx, cz] of [[-524288, 524287], [524287, -524288], [0, -1]] as const) {
      const c = new Chunk(cx, cz);
      c.set(1, 2, 3, STONE);
      const d = decodeChunk(encodeChunk(c));
      expect([d.cx, d.cz]).toEqual([cx, cz]);
      expect(d.cells[cellIndex(1, 2, 3)]).toBe(STONE);
    }
    expect(() => encodeChunk(new Chunk(524288, 0))).toThrow(RangeError);
  });

  it('every single-byte corruption and every truncation throws SaveFormatError', () => {
    const bytes = encodeChunk(terrainChunk(1, 2, 5));
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
    expect(() => decodeChunk(craft(M, (w) => head(w).u8(0).varuint(1).u16(5).varuint(100)))).toThrow(/unexpected end/);
    // run overflowing the chunk: palette of 2 (1 index bit), run of 32768 at offset 1
    expect(() =>
      decodeChunk(craft(M, (w) => head(w).u8(0).varuint(2).u16(1).u16(2).varuint(0).varuint(32767 << 1))),
    ).toThrow(/overflows/);
    // palette index out of range: palette of 3 (2 bits), index 3
    expect(() => decodeChunk(craft(M, (w) => head(w).u8(0).varuint(3).u16(1).u16(2).u16(3).varuint(3)))).toThrow(
      /palette index/,
    );
    // token too big to be a run
    expect(() => decodeChunk(craft(M, (w) => head(w).u8(0).varuint(1).u16(1).varuint(2 ** 40)))).toThrow(/token/);
    // empty palette
    expect(() => decodeChunk(craft(M, (w) => head(w).u8(0).varuint(0)))).toThrow(/palette size/);
    // trailing data after a complete chunk
    expect(() => decodeChunk(craft(M, (w) => head(w).u8(0).varuint(1).u16(1).varuint(32767).u8(0)))).toThrow(/trailing/);
    // raw with the wrong cell count
    expect(() => decodeChunk(craft(M, (w) => head(w).u8(1).u16Array(new Uint16Array(10))))).toThrow(/raw chunk/);
    // unknown encoding
    expect(() => decodeChunk(craft(M, (w) => head(w).u8(7)))).toThrow(/encoding 7/);
    // coordinates outside chunkKey's range
    expect(() =>
      decodeChunk(craft(M, (w) => w.varint(600000).varint(0).u8(0).varuint(1).u16(0).varuint(32767))),
    ).toThrow(/coordinates/);
    // a correct crafted payload decodes (sanity check of the helper)
    expect(decodeChunk(craft(M, (w) => head(w).u8(0).varuint(1).u16(9).varuint(32767))).cells[100]).toBe(9);
  });

  it('rejects an unknown version and the wrong blob type', () => {
    const c = terrainChunk(0, 0);
    const bytes = encodeChunk(c);
    const newer = craft(BLOB_MAGIC.chunk, (w) => w.raw(bytes.subarray(5, bytes.length - 4)), SAVE_VERSION + 6);
    expect(() => decodeChunk(newer)).toThrow(SaveVersionError);
    expect(() => decodeChunk(newer)).toThrow(new RegExp(`newer version of the game \\(format ${SAVE_VERSION + 6}`));
    // The reviewer's case: a corrupted version byte in a real chunk is corruption, not "newer".
    const flipped = bytes.slice();
    flipped[4] = 3;
    expect(() => decodeChunk(flipped)).toThrow(/checksum/);
    expect(() => decodeChunk(encodeTicks([], 0))).toThrow(/wrong blob type/);
    expect(() => decodeChunk(encodeMeta(meta()))).toThrow(SaveFormatError);
  });

  it('is deterministic', () => {
    expect(encodeChunk(terrainChunk(3, 3))).toEqual(encodeChunk(terrainChunk(3, 3)));
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
