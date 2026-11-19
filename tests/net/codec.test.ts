/**
 * The protocol codec (docs/NETCODE.md section 14, tests of package 3 in section 16): every message
 * round-trips with random content, the basic types quantise as specified, Cell carries both parts
 * of a cell and refuses invalid layouts on both ends (docs/SHAPES.md 13.1), CellVolume is no larger
 * than the save encoding on real terrain and carries the holes and second-part layers, and the size
 * limits are the same on both ends.
 */
import { describe, expect, it } from 'vitest';
import { CHUNK_VOLUME, SHIP_MAX_CELLS, STRUCTURE_MAX_BOX_CELLS } from '../../src/core/constants';
import { Chunk } from '../../src/voxel/chunk';
import { CELL_MULTI_BIT, makeCell, makePart, PACK_SCALE, type CellLayers } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { encodeChunk } from '../../src/save/codec';
import { ByteReader, ByteWriter, SaveFormatError } from '../../src/save/bytes';
import { TerrainGenerator } from '../../src/worldgen/generator';
import {
  ProtocolError,
  decodeCellVolume,
  decodeClientMessage,
  decodeServerMessage,
  encodeCellVolume,
  encodeClientMessage,
  encodeServerMessage,
  packSamples,
  cellSize,
  readAng16,
  readCell,
  readHelloBuild,
  readI8,
  readI16,
  readMessage,
  readPitch16,
  readPos32,
  readRot64,
  writeAng16,
  writeCell,
  writeMessage,
  writePitch16,
  writePos32,
  writeRot64,
} from '../../src/net/codec';
import {
  MAX_BATCH_CELLS,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_COORD,
  MAX_HELLO_BYTES,
  MAX_PREVIEW_CELLS,
  MAX_RELIABLE_BYTES,
  MAX_STRUCTURE_BOX_CELLS,
  MAX_UNRELIABLE_BYTES,
  MESSAGE_CHANNEL,
  MSG,
  PALETTE_LIMIT,
  emptyTickBatch,
  type ClientMessage,
  type EntitySample,
  type SamplesMsg,
  type ServerMessage,
  type ShipSample,
  type StructureRecord,
  type TickBatchMsg,
} from '../../src/net/protocol';
import { RELIABLE, UNRELIABLE } from '../../src/net/transport';
import { Gen } from './gen';

/** Fills of the lower and upper half, and the holes of a lower half slab. */
const LOWER = 0x33;
const UPPER = 0xcc;
const LOWER_HOLES = ~LOWER & 0xff;

function roundTripClient(m: ClientMessage): Uint8Array {
  const bytes = encodeClientMessage(m);
  expect(bytes[0]).toBe(MSG[m.type]);
  const back = decodeClientMessage(bytes, MESSAGE_CHANNEL[m.type]);
  expect(back).toEqual(m);
  expect(encodeClientMessage(back)).toEqual(bytes);
  return bytes;
}

function roundTripServer(m: ServerMessage): Uint8Array {
  const bytes = encodeServerMessage(m);
  expect(bytes[0]).toBe(MSG[m.type]);
  const back = decodeServerMessage(bytes, MESSAGE_CHANNEL[m.type]);
  expect(back).toEqual(m);
  expect(encodeServerMessage(back)).toEqual(bytes);
  return bytes;
}

function reader(write: (w: ByteWriter) => void): ByteReader {
  const w = new ByteWriter();
  write(w);
  return new ByteReader(w.finish());
}

describe('every message round-trips with random content', () => {
  it('client -> server messages (300 random sets)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      for (const m of new Gen(seed).clientMessages()) roundTripClient(m);
    }
  });

  it('server -> client messages, TickBatch with random sections (200 random sets)', () => {
    const seenSections = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      for (const m of new Gen(1000 + seed).serverMessages()) {
        roundTripServer(m);
        if (m.type === 'tickBatch') {
          for (const [k, v] of Object.entries(m)) if (Array.isArray(v) ? v.length > 0 : v !== null) seenSections.add(k);
          for (const k of Object.keys(m.private ?? {})) seenSections.add(`private.${k}`);
          for (const k of Object.keys(m.private?.view ?? {})) seenSections.add(`view.${k}`);
          for (const k of Object.keys(m.globals ?? {})) seenSections.add(`globals.${k}`);
        }
      }
    }
    // Every section, private field, view field and global was exercised.
    expect(seenSections.size).toBe(2 /* type, tick */ + 13 + 7 + 5 + 6);
  });

  it('an empty TickBatch is 6 bytes (ticks below 2^21, 29 hours)', () => {
    expect(roundTripServer(emptyTickBatch(0)).length).toBe(4);
    expect(roundTripServer(emptyTickBatch((1 << 21) - 1)).length).toBe(6);
    expect(roundTripServer(emptyTickBatch(Number.MAX_SAFE_INTEGER)).length).toBe(11);
  });

  it('Aim sends one target when use and mine are the same, and decodes two separate objects', () => {
    const t = new Gen(5).target();
    const same = roundTripClient({ type: 'aim', seq: 1, moveSeq: 2, use: t, mine: { ...t } });
    const other = roundTripClient({ type: 'aim', seq: 1, moveSeq: 2, use: t, mine: { ...t, face: ((t.face + 1) % 6) as typeof t.face } });
    expect(other.length).toBeGreaterThan(same.length + 5);
    const back = decodeClientMessage(same, RELIABLE);
    if (back.type !== 'aim') throw new Error('type');
    expect(back.mine).not.toBe(back.use);
    expect(roundTripClient({ type: 'aim', seq: 1, moveSeq: 2, use: null, mine: null }).length).toBe(5);
    // The non-canonical form (flag clear, same target repeated) is refused.
    const w = new ByteWriter();
    w.u8(MSG.aim).varuint(1).varuint(2).bool(false).bool(false).bool(false);
    expect(() => decodeClientMessage(w.finish(), RELIABLE)).toThrow(ProtocolError);
  });

  it('a Correction carries the seat exactly when the player holds a wheel', () => {
    const g = new Gen(9);
    const batch = emptyTickBatch(10);
    batch.private = { correction: { ...g.correction(), seatShipId: 0, seat: null } };
    const unseated = roundTripServer(batch).length;
    batch.private = { correction: { ...batch.private.correction!, seatShipId: 7, seat: { x: 1.25, y: 2, z: -3 } } };
    expect(roundTripServer(batch).length).toBe(unseated + 24);
    batch.private = { correction: { ...batch.private.correction!, seatShipId: 0 } };
    expect(() => encodeServerMessage(batch)).toThrow(RangeError);
  });
});

describe('basic types', () => {
  it('Cell: full blocks keep their 1-3 bytes; parts with holes and two-part cells round-trip', () => {
    const size = (v: number): number => {
      const w = new ByteWriter();
      writeCell(w, v);
      return w.length;
    };
    const rt = (v: number): number => readCell(reader((w) => writeCell(w, v)));
    expect(size(0)).toBe(1);
    expect(size(127)).toBe(1);
    expect(size(128)).toBe(2);
    expect(size(0xffff)).toBe(3);
    const holed = makePart(B.STONE, 0, LOWER_HOLES);
    // A part with holes: 3 bytes while the holes byte is below 0x20, else 4.
    expect(size(makePart(B.STONE, 0, 0x1f))).toBe(3);
    expect(size(holed)).toBe(4);
    expect(size(makePart(B.PLANKS_OAK, 63, 0xfe))).toBe(4);
    // A two-part cell: the first number has bit 24 (4 bytes), the second part takes 3 or 4.
    const two = canonCell(makePart(B.STONE, 0, UPPER), makePart(B.PLANKS_OAK, 0, LOWER));
    expect(two).toBeGreaterThan(2 ** 25);
    expect(size(two)).toBe(4 + 4);
    expect(size(canonCell(makePart(B.STONE, 0, 0xfe), makePart(B.DIRT, 0, 0x01)))).toBe(4 + 3);
    for (const v of [0, 127, 0xffff, holed, two, makePart(1023, 63, 0xfe), (makePart(1, 0, 1) | CELL_MULTI_BIT) + makePart(1023, 63, 0xfe) * PACK_SCALE]) {
      expect(rt(v)).toBe(v);
      expect(size(v)).toBe(cellSize(v));
    }
  });

  it('a lone holed cell in a chunk delta costs at most 7 bytes, a lone two-part cell at most 11 (section 15)', () => {
    // Worst values: holes >= 0x20 make a part >= 2^21 (a 4-byte varuint), and the first value of
    // a two-part cell carries CELL_MULTI_BIT (4 bytes) before its second part (4 bytes); the index
    // difference of a lone cell is at most 3 bytes (any index >= 16384, i.e. y >= 64).
    const holed = makePart(B.STONE, 0, 0xfe);
    const two = canonCell(makePart(B.STONE, 0, 0xfe), makePart(B.PLANKS_OAK, 0, 0x21)); // fills 0x01 and 0xde
    const size = (cells: Array<[number, number]>): number => {
      const b = emptyTickBatch(9);
      b.chunkDeltas = [{ cx: -3, cz: 7, cells, glue: [] }];
      return encodeServerMessage(b).length;
    };
    const empty = size([]);
    for (const index of [0, 16384, 32767]) {
      const idx = index === 0 ? 1 : 3;
      expect(size([[index, holed]]) - empty, `holed at ${index}`).toBe(idx + 4);
      expect(size([[index, two]]) - empty, `two-part at ${index}`).toBe(idx + 8);
      expect(size([[index, holed]]) - empty).toBeLessThanOrEqual(7);
      expect(size([[index, two]]) - empty).toBeLessThanOrEqual(11);
    }
  });

  it('Cell: the encoder refuses every invalid layout (RangeError), never truncating', () => {
    const write = (v: number): void => writeCell(new ByteWriter(), v);
    expect(() => write(-1)).toThrow(RangeError);
    expect(() => write(1.5)).toThrow(RangeError);
    expect(() => write(2 ** 49)).toThrow(RangeError);
    expect(() => write(CELL_MULTI_BIT | 5)).toThrow(/CELL_MULTI_BIT but no second part/); // the tripwire: bit 24 without a second part
    expect(() => write(makePart(1, 0, 0xff))).toThrow(RangeError); // a part without octants
    expect(() => write((1 | CELL_MULTI_BIT) + makePart(2, 0, 0xff) * PACK_SCALE)).toThrow(RangeError); // second part without octants
    expect(() => write((1 | CELL_MULTI_BIT) + makePart(0, 3, 0x0f) * PACK_SCALE)).toThrow(RangeError); // second part with id 0
    expect(() => write(5 + 7 * PACK_SCALE)).toThrow(RangeError); // a second part without bit 24
  });

  it('Cell: the decoder refuses every invalid layout (SaveFormatError; a ProtocolError in a message)', () => {
    expect(() => readCell(reader((w) => w.varuint(2 ** 25)))).toThrow(SaveFormatError);
    expect(() => readCell(reader((w) => w.varuint(2 ** 25 + 5).varuint(makePart(B.STONE, 0, 0x0f))))).toThrow(/not below 2\^25/);
    expect(() => readCell(reader((w) => w.varuint(makePart(1, 0, 0xff))))).toThrow(SaveFormatError);
    expect(() => readCell(reader((w) => w.varuint(CELL_MULTI_BIT | 5).varuint(0)))).toThrow(SaveFormatError);
    expect(() => readCell(reader((w) => w.varuint(CELL_MULTI_BIT | 5).varuint(2 ** 24)))).toThrow(SaveFormatError);
    expect(() => readCell(reader((w) => w.varuint(CELL_MULTI_BIT | 5).varuint(2 ** 24 + makePart(B.DIRT, 0, 0x0f))))).toThrow(/not below 2\^24/);
    expect(() => readCell(reader((w) => w.varuint(CELL_MULTI_BIT | 5).varuint(makePart(2, 0, 0xff))))).toThrow(SaveFormatError);
    expect(() => readCell(reader((w) => w.varuint(CELL_MULTI_BIT | 5).varuint(makePart(0, 1, 0x0f))))).toThrow(SaveFormatError);
    expect(() => readCell(reader((w) => w.varuint(CELL_MULTI_BIT | 5)))).toThrow(SaveFormatError); // the second part is missing
    // In a message: a protocol error, never a truncated cell.
    const batch = emptyTickBatch(1);
    batch.chunkDeltas = [{ cx: 0, cz: 0, cells: [[3, 0xffff]], glue: [] }];
    const bytes = encodeServerMessage(batch);
    const w = new ByteWriter();
    w.raw(bytes.subarray(0, bytes.length - 4)).varuint(2 ** 25).varuint(0);
    expect(() => decodeServerMessage(w.finish(), RELIABLE)).toThrow(ProtocolError);
  });

  it('a falling block and a flat generator layer carry a full block, a block event one part: both ends check', () => {
    const holed = makePart(B.STONE, 0, LOWER_HOLES);
    const two = canonCell(makePart(B.STONE, 0, UPPER), makePart(B.PLANKS_OAK, 0, LOWER));
    const falling = (cell: number): TickBatchMsg => ({ ...emptyTickBatch(2), entitySpawns: [{ id: 4, kind: 'falling', carrierId: 0, pos: { x: 1, y: 2, z: 3 }, yaw: 0, cell }] });
    roundTripServer(falling(makeCell(B.SAND)));
    expect(() => encodeServerMessage(falling(holed))).toThrow(RangeError);
    const event = (cell: number): TickBatchMsg => ({ ...emptyTickBatch(2), events: [{ type: 'blockBroken', gridId: 0, x: 1, y: 2, z: 3, cell }] });
    roundTripServer(event(holed));
    expect(() => encodeServerMessage(event(two))).toThrow(RangeError);
    const flat = (cell: number): ServerMessage => ({
      type: 'welcome', entityId: 1, generator: { kind: 'flat', seed: 1, layers: [{ cell, thickness: 3 }] }, worldTime: 0, dayOffset: 0,
      rules: { defaultMode: 'creative', dropsEnabled: false }, isHost: true, roomOpen: false, players: [],
    });
    roundTripServer(flat(makeCell(B.STONE)));
    expect(() => encodeServerMessage(flat(holed))).toThrow(RangeError);
    // The decoders refuse what the encoders refuse: patch the last Cell of a valid message.
    // (In both messages the Cell is the last field.)
    const patch = (bytes: Uint8Array, tail: number, cell: (w: ByteWriter) => void): Uint8Array => {
      const w = new ByteWriter();
      w.raw(bytes.subarray(0, bytes.length - tail));
      cell(w);
      return w.finish();
    };
    const fb = encodeServerMessage(falling(makeCell(B.SAND)));
    expect(() => decodeServerMessage(patch(fb, 1, (w) => w.varuint(holed)), RELIABLE)).toThrow(/not a full block/);
    const ev = encodeServerMessage(event(1));
    expect(() => decodeServerMessage(patch(ev, 1, (w) => writeCell(w, two)), RELIABLE)).toThrow(/not one part/);
  });

  it('i8 and i16 never use -128 / -32768', () => {
    expect(readI8(reader((w) => w.u8(0x81)))).toBe(-127);
    expect(() => readI8(reader((w) => w.u8(0x80)))).toThrow(SaveFormatError);
    expect(readI16(reader((w) => w.u16(0x8001)))).toBe(-32767);
    expect(() => readI16(reader((w) => w.u16(0x8000)))).toThrow(SaveFormatError);
  });

  it('Pos32: 1/512 block, over the whole world range', () => {
    const rt = (v: number): number => readPos32(reader((w) => writePos32(w, v)));
    expect(rt(1.001)).toBe(Math.round(1.001 * 512) / 512);
    expect(rt(-4_194_304)).toBe(-4_194_304);
    expect(rt(4_194_303.998)).toBeCloseTo(4_194_303.998, 2);
    expect(() => rt(4_194_304)).toThrow(RangeError);
    expect(() => rt(Number.NaN)).toThrow(RangeError);
    for (const v of [0.3, -12.7, 1234.5678]) expect(Math.abs(rt(v) - v)).toBeLessThanOrEqual(1 / 1024);
  });

  it('Rot64: unit quaternions within 3e-5 per component, read back normalised, zero refused', () => {
    const g = new Gen(3);
    for (let i = 0; i < 500; i++) {
      const a = [g.f64(), g.f64(), g.f64(), g.f64()];
      const len = Math.hypot(...a);
      const q = { x: a[0]! / len, y: a[1]! / len, z: a[2]! / len, w: a[3]! / len };
      const w = new ByteWriter();
      writeRot64(w, q);
      expect(w.length).toBe(8);
      const back = readRot64(new ByteReader(w.finish()));
      expect(Math.hypot(back.x, back.y, back.z, back.w)).toBeCloseTo(1, 12);
      for (const k of ['x', 'y', 'z', 'w'] as const) expect(Math.abs(back[k] - q[k])).toBeLessThan(3e-5);
    }
    expect(() => readRot64(reader((w) => w.u16(0).u16(0).u16(0).u16(0)))).toThrow(SaveFormatError);
    expect(() => writeRot64(new ByteWriter(), { x: 2, y: 0, z: 0, w: 0 })).toThrow(RangeError);
  });

  it('Ang16 wraps to [0, 2pi) in steps of 2pi/65536; pitch is clamped to +-pi/2', () => {
    const ang = (a: number): number => readAng16(reader((w) => writeAng16(w, a)));
    expect(ang(0)).toBe(0);
    expect(ang(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2, 4);
    expect(ang(2 * Math.PI + 0.25)).toBeCloseTo(0.25, 4);
    expect(ang(2 * Math.PI - 1e-9)).toBe(0);
    expect(() => ang(Infinity)).toThrow(RangeError);
    const pitch = (p: number): number => readPitch16(reader((w) => writePitch16(w, p)));
    expect(pitch(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12);
    expect(pitch(3)).toBeCloseTo(Math.PI / 2, 12);
    expect(pitch(-0.4)).toBeCloseTo(-0.4, 4);
  });

  it('Message: any parameter name becomes an own property; duplicates are refused', () => {
    const w = new ByteWriter();
    w.string('k').varuint(2).string('__proto__').u8(0).f64(3).string('constructor').u8(1).string('x');
    const m = readMessage(new ByteReader(w.finish()));
    expect(Object.keys(m.params!)).toEqual(['__proto__', 'constructor']);
    expect(m.params!['__proto__']).toBe(3);
    expect(Object.getPrototypeOf(m.params)).toBe(Object.prototype);
    const again = new ByteWriter();
    writeMessage(again, m);
    expect(readMessage(new ByteReader(again.finish()))).toEqual(m);
    const dup = new ByteWriter();
    dup.string('k').varuint(2).string('a').u8(0).f64(1).string('a').u8(0).f64(2);
    expect(() => readMessage(new ByteReader(dup.finish()))).toThrow(SaveFormatError);
  });
});

describe('CellVolume', () => {
  const full = (base: Uint16Array): CellLayers => ({ base, holes: null, part2: null });

  it('on real terrain is no larger than the save encoding + 4 bytes, and round-trips', () => {
    const gen = new TerrainGenerator(12345);
    for (let cx = -6; cx < 6; cx++) {
      for (let cz = -6; cz < 6; cz++) {
        const cells = gen.generate(cx, cz);
        const net = encodeCellVolume(full(cells));
        const save = encodeChunk(new Chunk(cx, cz, cells));
        expect(net.length, `chunk ${cx},${cz}`).toBeLessThanOrEqual(save.length + 4);
        expect(decodeCellVolume(net, CHUNK_VOLUME)).toEqual(full(cells));
      }
    }
  });

  it('falls back to raw cells when run-length would not be smaller, and above PALETTE_LIMIT values', () => {
    const noise = new Uint16Array(CHUNK_VOLUME);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 120; // all 1-byte cells, no runs
    const raw = encodeCellVolume(full(noise));
    expect(raw[0]).toBe(1);
    expect(raw.length).toBe(1 + CHUNK_VOLUME);
    expect(decodeCellVolume(raw, CHUNK_VOLUME)).toEqual(full(noise));

    const many = new Uint16Array(CHUNK_VOLUME);
    for (let i = 0; i < many.length; i++) many[i] = Math.floor(i / 7) % (PALETTE_LIMIT + 1); // runs of 7, 4097 values
    const enc = encodeCellVolume(full(many));
    expect(enc[0]).toBe(1);
    expect(decodeCellVolume(enc, CHUNK_VOLUME)).toEqual(full(many));
    many.fill(0, 7 * PALETTE_LIMIT); // now exactly 4096 values: run-length again
    expect(encodeCellVolume(full(many))[0]).toBe(0);
    expect(decodeCellVolume(encodeCellVolume(full(many)), CHUNK_VOLUME)).toEqual(full(many));
  });

  it('handles run tokens above 2^32 (structure boxes up to MAX_STRUCTURE_BOX_CELLS)', () => {
    const cells = new Uint16Array(MAX_STRUCTURE_BOX_CELLS);
    for (let i = 0; i < 4096; i++) cells[i * 13] = i; // palette of 4096: B = 12
    cells.fill(5, 4096 * 13); // one run of ~2 million cells: token ~ 2^33
    const enc = encodeCellVolume(full(cells));
    expect(enc[0]).toBe(0);
    expect(enc.length).toBeLessThan(40_000);
    const back = decodeCellVolume(enc, MAX_STRUCTURE_BOX_CELLS);
    // (toEqual over 2 million elements is slow: compare the bytes.)
    expect(Buffer.from(back.base.buffer).equals(Buffer.from(cells.buffer))).toBe(true);
    expect(back.holes).toBeNull();
    expect(back.part2).toBeNull();
  });

  it('a whole column of one value is 6 bytes', () => {
    expect(encodeCellVolume(full(new Uint16Array(CHUNK_VOLUME))).length).toBe(1 + 1 + 1 + 3);
  });
});

describe('limits are the same on both ends', () => {
  it('Hello at most MAX_HELLO_BYTES, other client messages at most MAX_CLIENT_MESSAGE_BYTES', () => {
    const hello = (name: string): ClientMessage => ({ type: 'hello', build: 'test', playerKey: 'k'.repeat(32), name, viewRadius: 9 });
    // id 1 + build 5 + key 33 + name (2 + n) + radius 1 = 42 + n bytes.
    const fits = encodeClientMessage(hello('n'.repeat(MAX_HELLO_BYTES - 42)));
    expect(fits.length).toBe(MAX_HELLO_BYTES);
    expect(() => encodeClientMessage(hello('n'.repeat(MAX_HELLO_BYTES - 41)))).toThrow(RangeError);
    const w = new ByteWriter();
    w.raw(fits.subarray(0, 39)).string('n'.repeat(MAX_HELLO_BYTES - 41)).u8(9);
    expect(w.length).toBe(MAX_HELLO_BYTES + 1);
    expect(() => decodeClientMessage(w.finish(), RELIABLE)).toThrow(/Hello of 513 bytes/);

    const long: ClientMessage = { type: 'hostCommand', seq: 1, command: { kind: 'kick', entityId: 1 } };
    expect(encodeClientMessage(long).length).toBeLessThan(MAX_CLIENT_MESSAGE_BYTES);
    const big = new Uint8Array(MAX_CLIENT_MESSAGE_BYTES + 1);
    big[0] = MSG.bye;
    expect(() => decodeClientMessage(big, RELIABLE)).toThrow(/exceeds 2048/);
  });

  it('unreliable messages above MAX_UNRELIABLE_BYTES are refused; packSamples splits them', () => {
    const g = new Gen(77);
    const ships: ShipSample[] = g.list(() => ({ id: g.id(), pose: g.pose() }), 10, 10);
    const entities: EntitySample[] = g.list(() => g.entitySample(), 120, 120);
    expect(() => encodeServerMessage({ type: 'samples', tick: 5, seq: 0, ships, entities })).toThrow(RangeError);
    const parts = packSamples(5, 40, ships, entities);
    expect(parts.length).toBeGreaterThan(1);
    const back = parts.map((b) => decodeServerMessage(b, UNRELIABLE) as SamplesMsg);
    for (const [i, b] of parts.entries()) {
      expect(b.length).toBeLessThanOrEqual(MAX_UNRELIABLE_BYTES);
      expect(back[i]!.seq).toBe(40 + i);
      expect(back[i]!.tick).toBe(5);
    }
    // Everything arrives, in the order given; all but the last message are nearly full.
    expect(back.flatMap((m) => m.ships)).toEqual(ships);
    expect(back.flatMap((m) => m.entities)).toEqual(entities);
    for (const b of parts.slice(0, -1)) expect(b.length).toBeGreaterThan(MAX_UNRELIABLE_BYTES - 40);
    expect(packSamples(5, 0, [], [])).toEqual([]);
    expect(packSamples(5, 0, ships.slice(0, 1), []).length).toBe(1);
  });

  it('messages on the wrong channel, unknown ids and the other direction\'s ids are protocol errors', () => {
    const ping = encodeClientMessage({ type: 'ping', clientMs: 5, rttMs: 140 });
    expect(decodeClientMessage(ping, UNRELIABLE)).toEqual({ type: 'ping', clientMs: 5, rttMs: 140 });
    expect(() => decodeClientMessage(ping, RELIABLE)).toThrow(/wrong channel/);
    expect(() => decodeClientMessage(Uint8Array.of(0x7f), RELIABLE)).toThrow(ProtocolError);
    expect(() => decodeClientMessage(Uint8Array.of(MSG.kick, 1, 0), RELIABLE)).toThrow(ProtocolError);
    expect(() => decodeServerMessage(Uint8Array.of(MSG.bye), RELIABLE)).toThrow(ProtocolError);
    expect(() => decodeServerMessage(new Uint8Array(0), RELIABLE)).toThrow(ProtocolError);
    expect(() => decodeClientMessage(Uint8Array.of(MSG.bye, 0), RELIABLE)).toThrow(/trailing/);
  });

  it('the parts that never change: Hello starts with id + build, Refuse is u8 reason + str detail with reason 1 = build', () => {
    const hello = encodeClientMessage({ type: 'hello', build: 'abc123', playerKey: 'k', name: 'n', viewRadius: 3 });
    expect([...hello.subarray(0, 8)]).toEqual([0x01, 6, ...new TextEncoder().encode('abc123')]);
    // Another build's Hello may continue in any way: its build is still readable.
    expect(readHelloBuild(Uint8Array.of(0x01, 3, 0x78, 0x79, 0x7a, 0xff, 0xff, 0xff))).toBe('xyz');
    expect(() => readHelloBuild(Uint8Array.of(0x02))).toThrow(ProtocolError);
    expect(() => readHelloBuild(Uint8Array.of(0x01, 5, 0x61))).toThrow(ProtocolError);
    const refuse = encodeServerMessage({ type: 'refuse', reason: 'build', detail: 'hi' });
    expect([...refuse]).toEqual([0x82, 1, 2, 0x68, 0x69]);
  });

  it('the box limit is the game rule STRUCTURE_MAX_BOX_CELLS = 2^21, not a second number', () => {
    expect(MAX_STRUCTURE_BOX_CELLS).toBe(STRUCTURE_MAX_BOX_CELLS);
    expect(MAX_STRUCTURE_BOX_CELLS).toBe(2 ** 21);
  });

  it('a structure box of one cell more than MAX_STRUCTURE_BOX_CELLS is refused on both ends', () => {
    const g = new Gen(2);
    const rec = g.structureRecord();
    // 2^21 + 1 = 3 x 699051.
    const [sx, sy, sz] = [699051, 3, 1];
    expect(sx * sy * sz).toBe(MAX_STRUCTURE_BOX_CELLS + 1);
    const over = { ...rec, minX: 0, minY: 0, minZ: 0, sx, sy, sz, cells: { base: new Uint16Array(sx * sy * sz), holes: null, part2: null } } as StructureRecord;
    expect(() => encodeServerMessage({ ...emptyTickBatch(1), structureSpawns: [over] })).toThrow(/structure box volume/);
    // The same header by hand, followed by a CellVolume of one run that would cover it.
    const w = new ByteWriter();
    w.u8(MSG.tickBatch).varuint(1).u16(1 << 4).varuint(1).u8(0).varuint(5).varuint(0);
    w.varint(0).varint(0).varint(0).varuint(sx).varuint(sy).varuint(sz);
    w.u8(0).varuint(1).varuint(1).varuint(sx * sy * sz - 1);
    w.raw(new Uint8Array(200));
    expect(() => decodeServerMessage(w.finish(), RELIABLE)).toThrow(/too large/);
  });

  it('a structure box above MAX_STRUCTURE_BOX_CELLS is refused before anything is allocated', () => {
    const g = new Gen(1);
    const rec = g.structureRecord();
    const huge = { ...rec, minX: 0, minY: 0, minZ: 0, sx: 4096, sy: 4096, sz: 2, cells: { base: new Uint16Array(0), holes: null, part2: null } } as StructureRecord;
    const batch = { ...emptyTickBatch(1), structureSpawns: [huge] };
    expect(() => encodeServerMessage(batch)).toThrow(RangeError);
    // The same box crafted by hand: kind, id, parent, min, then a 2^60 cell box.
    const w = new ByteWriter();
    w.u8(MSG.tickBatch).varuint(1).u16(1 << 4).varuint(1).u8(0).varuint(5).varuint(0);
    w.varint(0).varint(0).varint(0).varuint(2 ** 20).varuint(2 ** 20).varuint(2 ** 20);
    w.raw(new Uint8Array(200));
    expect(() => decodeServerMessage(w.finish(), RELIABLE)).toThrow(/too large/);
  });

  it('a 4000-cell ship round-trips; a ship in the largest box round-trips as a whole record', () => {
    const g = new Gen(21);
    // SHIP_MAX_CELLS solid cells of varied blocks (a 20 x 10 x 20 hull).
    const hull = new Uint16Array(20 * 10 * 20);
    for (let i = 0; i < hull.length; i++) hull[i] = 1 + ((i * 7) % 40);
    expect(hull.length).toBe(SHIP_MAX_CELLS);
    let rec = g.structureRecord();
    while (rec.kind !== 'ship') rec = g.structureRecord();
    const ship: StructureRecord = { ...rec, minX: -10, minY: 60, minZ: 4000, sx: 20, sy: 10, sz: 20, cells: { base: hull, holes: null, part2: null } };
    roundTripServer({ ...emptyTickBatch(9), structureSpawns: [ship] });

    // A thin frame (an x arm, a z arm, a y mast) whose box is exactly MAX_STRUCTURE_BOX_CELLS.
    const [sx, sy, sz] = [256, 64, 128];
    expect(sx * sy * sz).toBe(MAX_STRUCTURE_BOX_CELLS);
    const cells = new Uint16Array(MAX_STRUCTURE_BOX_CELLS);
    for (let x = 0; x < sx; x++) cells[x] = 3;
    for (let z = 0; z < sz; z++) cells[z * sx] = 4;
    for (let y = 0; y < sy; y++) cells[y * sx * sz] = 5;
    const frame: StructureRecord = { ...ship, sx, sy, sz, cells: { base: cells, holes: null, part2: null } };
    const batch = { ...emptyTickBatch(9), structureSpawns: [frame] };
    const bytes = encodeServerMessage(batch);
    const back = decodeServerMessage(bytes, RELIABLE) as TickBatchMsg;
    const got = back.structureSpawns[0]!;
    // (toEqual over 2 million cells is slow: compare the bytes, then the rest.)
    expect(Buffer.from(got.cells.base.buffer).equals(Buffer.from(cells.buffer))).toBe(true);
    expect([got.cells.holes, got.cells.part2]).toEqual([null, null]);
    expect({ ...got, cells: null }).toEqual({ ...frame, cells: null });
    expect(encodeServerMessage(back)).toEqual(bytes);
  });

  it('an assembly preview: MAX_PREVIEW_CELLS cells in a MAX_STRUCTURE_BOX_CELLS box round-trip; more is refused on both ends', () => {
    // Cells along the first rows of a 2048 x 1 x 1024 box (256 KiB of bitmap) and its far corner.
    const [side, depth] = [2048, 1024];
    expect(side * depth).toBe(MAX_STRUCTURE_BOX_CELLS);
    const diagonal = (n: number, dx = 0): Int32Array => {
      const c = new Int32Array(3 * n);
      for (let i = 0; i < n; i++) {
        // In bitmap order: y, then z, then x.
        if (i === n - 1) c.set([side - 1 + dx, 7, depth - 1 - 50], 3 * i);
        else c.set([(i % side) + dx, 7, Math.floor(i / side) - 50], 3 * i);
      }
      return c;
    };
    const batch = (cells: Int32Array): TickBatchMsg => ({ ...emptyTickBatch(3), private: { view: { preview: { gridId: 0, kind: 'ship', cells } } } });
    const bytes = roundTripServer(batch(diagonal(MAX_PREVIEW_CELLS)));
    expect(bytes.length).toBeGreaterThan(MAX_STRUCTURE_BOX_CELLS / 8);
    expect(bytes.length).toBeLessThan(MAX_RELIABLE_BYTES);
    expect(() => encodeServerMessage(batch(diagonal(MAX_PREVIEW_CELLS + 1)))).toThrow(/MAX_PREVIEW_CELLS/);
    // One more set bit in the encoded bitmap (it ends the message; that byte held no cell).
    const more = bytes.slice();
    more[more.length - 2]! |= 1;
    expect(() => decodeServerMessage(more, RELIABLE)).toThrow(/MAX_PREVIEW_CELLS/);
    // A box one cell wider, and a far corner beyond MAX_COORD.
    expect(() => encodeServerMessage(batch(diagonal(2, 0).map((v, i) => (i === 3 ? side : v))))).toThrow(/MAX_STRUCTURE_BOX_CELLS/);
    expect(() => encodeServerMessage(batch(Int32Array.of(MAX_COORD - 1, 0, 0, MAX_COORD + 1, 0, 0)))).toThrow(RangeError);
  });

  it('a TickBatch of exactly MAX_RELIABLE_BYTES round-trips; one byte more is refused on both ends', () => {
    const toast = (n: number): TickBatchMsg => ({
      ...emptyTickBatch(100_000),
      private: { events: [{ type: 'toast', message: { key: 'k'.repeat(n) }, kind: 'info' }] },
    });
    // Message length = overhead + n (the string's length prefix is 4 bytes for every n used here).
    const overhead = encodeServerMessage(toast(1 << 21)).length - (1 << 21);
    const n = MAX_RELIABLE_BYTES - overhead;
    const fits = encodeServerMessage(toast(n));
    expect(fits.length).toBe(MAX_RELIABLE_BYTES);
    expect(decodeServerMessage(fits, RELIABLE)).toEqual(toast(n));
    expect(() => encodeServerMessage(toast(n + 1))).toThrow(/exceeds its limit/);
    const longer = new Uint8Array(MAX_RELIABLE_BYTES + 1);
    longer.set(fits);
    expect(() => decodeServerMessage(longer, RELIABLE)).toThrow(/exceeds the channel limit/);
  });

  it(`all CellVolumes of one TickBatch describe at most MAX_BATCH_CELLS cells (${MAX_BATCH_CELLS / CHUNK_VOLUME} columns)`, () => {
    const columns = MAX_BATCH_CELLS / CHUNK_VOLUME;
    const one = encodeCellVolume({ base: new Uint16Array(CHUNK_VOLUME).fill(1), holes: null, part2: null });
    const craft = (n: number): Uint8Array => {
      const w = new ByteWriter();
      w.u8(MSG.tickBatch).varuint(1).u16(1 << 1).varuint(n);
      for (let i = 0; i < n; i++) w.varint(i).varint(0).u8(1).raw(one).varuint(0);
      return w.finish();
    };
    const fits = decodeServerMessage(craft(columns), RELIABLE) as TickBatchMsg;
    expect(fits.snapshots.length).toBe(columns);
    expect(() => decodeServerMessage(craft(columns + 1), RELIABLE)).toThrow(/exceeds what one message may carry/);
    const cells: CellLayers = { base: new Uint16Array(CHUNK_VOLUME).fill(1), holes: null, part2: null };
    const batch = { ...emptyTickBatch(1), snapshots: Array.from({ length: columns + 1 }, (_, i) => ({ cx: i, cz: 0, cells, glue: [] })) };
    expect(() => encodeServerMessage(batch)).toThrow(/MAX_BATCH_CELLS/);
  });
});
