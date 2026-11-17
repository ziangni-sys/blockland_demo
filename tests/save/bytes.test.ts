import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter, SaveFormatError, utf8Length } from '../../src/save/bytes';
import { crc32 } from '../../src/save/crc32';
import { Rng } from '../../src/core/rng';

const MAX = Number.MAX_SAFE_INTEGER;

function bytesOf(fn: (w: ByteWriter) => void): number[] {
  const w = new ByteWriter();
  fn(w);
  return [...w.finish()];
}

/** Reference zigzag LEB128 in BigInt arithmetic (exact for any integer). */
function refVarint(v: number): number[] {
  let z = v >= 0 ? BigInt(v) * 2n : -BigInt(v) * 2n - 1n;
  const out: number[] = [];
  do {
    let b = Number(z & 0x7fn);
    z >>= 7n;
    if (z > 0n) b |= 0x80;
    out.push(b);
  } while (z > 0n);
  return out;
}
function refVaruint(v: number): number[] {
  let z = BigInt(v);
  const out: number[] = [];
  do {
    let b = Number(z & 0x7fn);
    z >>= 7n;
    if (z > 0n) b |= 0x80;
    out.push(b);
  } while (z > 0n);
  return out;
}

describe('ByteWriter / ByteReader round trips', () => {
  it('fixed-width integers at their edges', () => {
    const w = new ByteWriter(16);
    const u8s = [0, 1, 127, 128, 255];
    const u16s = [0, 1, 255, 256, 65535];
    const u32s = [0, 1, 65536, 2 ** 31, 2 ** 32 - 1];
    const i32s = [0, -1, 1, -(2 ** 31), 2 ** 31 - 1];
    for (const v of u8s) w.u8(v);
    for (const v of u16s) w.u16(v);
    for (const v of u32s) w.u32(v);
    for (const v of i32s) w.i32(v);
    const r = new ByteReader(w.finish());
    for (const v of u8s) expect(r.u8()).toBe(v);
    for (const v of u16s) expect(r.u16()).toBe(v);
    for (const v of u32s) expect(r.u32()).toBe(v);
    for (const v of i32s) expect(r.i32()).toBe(v);
    expect(r.eof()).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it('is little-endian on the wire', () => {
    expect(bytesOf((w) => w.u16(0x1234))).toEqual([0x34, 0x12]);
    expect(bytesOf((w) => w.u32(0x12345678))).toEqual([0x78, 0x56, 0x34, 0x12]);
    expect(bytesOf((w) => w.i32(-2))).toEqual([0xfe, 0xff, 0xff, 0xff]);
    expect(bytesOf((w) => w.f64(1))).toEqual([0, 0, 0, 0, 0, 0, 0xf0, 0x3f]);
  });

  it('floats keep NaN, -0, infinities and extremes', () => {
    const f64s = [0, -0, 1.5, Math.PI, -1e308, Number.MAX_VALUE, Number.MIN_VALUE, Infinity, -Infinity, NaN];
    const f32s = [0, -0, 1.5, 0.1, 3.4028234663852886e38, 1.401298464324817e-45, Infinity, -Infinity, NaN];
    const w = new ByteWriter();
    for (const v of f64s) w.f64(v);
    for (const v of f32s) w.f32(v);
    const r = new ByteReader(w.finish());
    for (const v of f64s) expect(Object.is(r.f64(), v)).toBe(true);
    for (const v of f32s) expect(Object.is(r.f32(), Math.fround(v))).toBe(true);
  });

  it('bools are strict', () => {
    const r = new ByteReader(new ByteWriter().bool(true).bool(false).finish());
    expect(r.bool()).toBe(true);
    expect(r.bool()).toBe(false);
    expect(() => new ByteReader(Uint8Array.of(2)).bool()).toThrow(SaveFormatError);
  });

  it('varuint edge values and exact encodings', () => {
    const values = [0, 1, 127, 128, 255, 300, 16383, 16384, 2 ** 21 - 1, 2 ** 21, 2 ** 28 - 1, 2 ** 28, 2 ** 31 - 1,
      2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 35, 2 ** 42 + 12345, 2 ** 49 - 1, 2 ** 49, 2 ** 52 + 1, MAX];
    const w = new ByteWriter(8);
    for (const v of values) w.varuint(v);
    const r = new ByteReader(w.finish());
    for (const v of values) expect(r.varuint()).toBe(v);
    expect(r.eof()).toBe(true);
    for (const v of values) expect(bytesOf((x) => x.varuint(v))).toEqual(refVaruint(v));
    expect(bytesOf((x) => x.varuint(300))).toEqual([0xac, 0x02]);
    expect(bytesOf((x) => x.varuint(MAX)).length).toBe(8);
  });

  it('varint covers the whole safe-integer range with standard zigzag bytes', () => {
    const values = [0, -0, 1, -1, 63, -64, 64, -65, 8191, -8192, 2 ** 30 - 1, -(2 ** 30), 2 ** 30, -(2 ** 30) - 1,
      2 ** 31, -(2 ** 31), 2 ** 40 + 7, -(2 ** 40) - 7, 2 ** 52, -(2 ** 52), MAX, -MAX, MAX - 1, -MAX + 1];
    const w = new ByteWriter(4);
    for (const v of values) w.varint(v);
    const r = new ByteReader(w.finish());
    for (const v of values) expect(r.varint()).toBe(v === 0 ? 0 : v);
    for (const v of values) expect(bytesOf((x) => x.varint(v))).toEqual(refVarint(v));
    expect(bytesOf((x) => x.varint(-1))).toEqual([0x01]);
    expect(bytesOf((x) => x.varint(1))).toEqual([0x02]);
    expect(bytesOf((x) => x.varint(-64))).toEqual([0x7f]);
    expect(bytesOf((x) => x.varint(64))).toEqual([0x80, 0x01]);
  });

  it('varint/varuint agree with a BigInt reference on random values of every magnitude', () => {
    const rng = new Rng(1234);
    const w = new ByteWriter();
    const vals: number[] = [];
    for (let i = 0; i < 4000; i++) {
      const bits = rng.int(0, 53);
      const mag = Math.min(MAX, Math.floor(rng.next() * 2 ** bits));
      vals.push(rng.chance(0.5) ? -mag : mag);
    }
    for (const v of vals) {
      w.varint(v);
      w.varuint(Math.abs(v));
    }
    const r = new ByteReader(w.finish());
    for (const v of vals) {
      expect(r.varint()).toBe(v === 0 ? 0 : v);
      expect(r.varuint()).toBe(Math.abs(v));
    }
    for (let i = 0; i < 300; i++) {
      expect(bytesOf((x) => x.varint(vals[i]!))).toEqual(refVarint(vals[i]!));
    }
  });

  it('strings: empty, ASCII, CJK, astral, long', () => {
    const long = 'Blocklands 方块 🧱 '.repeat(5000);
    const values = ['', 'a', 'hello world', '方块大陆', '🧱⛵🌬️', 'mixed ä ö ü ß é', '\u0000nul\u0000', '￿ࠀ߿', long];
    const w = new ByteWriter(4);
    for (const s of values) w.string(s);
    const r = new ByteReader(w.finish());
    for (const s of values) expect(r.string()).toBe(s);
    expect(r.eof()).toBe(true);
    expect(bytesOf((x) => x.string('é'))).toEqual([2, 0xc3, 0xa9]);
    expect(bytesOf((x) => x.string('🧱'))).toEqual([4, 0xf0, 0x9f, 0xa7, 0xb1]);
    expect(utf8Length(long)).toBe(Buffer.byteLength(long, 'utf8'));
  });

  it('strings: lone surrogates become U+FFFD like TextEncoder', () => {
    for (const s of ['a\ud800b', '\udc00', 'x\ud83d', '\ud83d💩']) {
      const enc = new ByteWriter().string(s).finish();
      expect([...enc.subarray(1)]).toEqual([...new TextEncoder().encode(s)]);
      expect(new ByteReader(enc).string()).toBe(new TextDecoder().decode(new TextEncoder().encode(s)));
    }
  });

  it('bytes and typed arrays, including empty ones', () => {
    const blob = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 255);
    const u16 = Uint16Array.of(0, 1, 65535, 4660);
    const i32 = Int32Array.of(0, -1, 2147483647, -2147483648);
    const f64 = Float64Array.of(0, -0, NaN, Infinity, -Infinity, 1e-300, Math.E);
    const w = new ByteWriter(8)
      .bytes(new Uint8Array(0))
      .bytes(blob)
      .u16Array(new Uint16Array(0))
      .u16Array(u16)
      .u16Array([1, 2, 3])
      .i32Array(new Int32Array(0))
      .i32Array(i32)
      .i32Array([-5, 5])
      .f64Array(new Float64Array(0))
      .f64Array(f64)
      .f64Array([0.5, -0.25]);
    const r = new ByteReader(w.finish());
    expect(r.bytes()).toEqual(new Uint8Array(0));
    expect(r.bytes()).toEqual(blob);
    expect(r.u16Array()).toEqual(new Uint16Array(0));
    expect(r.u16Array()).toEqual(u16);
    expect([...r.u16Array()]).toEqual([1, 2, 3]);
    expect(r.i32Array()).toEqual(new Int32Array(0));
    expect(r.i32Array()).toEqual(i32);
    expect([...r.i32Array()]).toEqual([-5, 5]);
    expect(r.f64Array()).toEqual(new Float64Array(0));
    const f = r.f64Array();
    expect(f.length).toBe(f64.length);
    for (let i = 0; i < f.length; i++) expect(Object.is(f[i], f64[i])).toBe(true);
    expect([...r.f64Array()]).toEqual([0.5, -0.25]);
    expect(r.eof()).toBe(true);
  });

  it('typed array writes honour subarray views of a larger buffer', () => {
    const base = Uint16Array.from({ length: 64 }, (_, i) => i * 1000);
    const view = base.subarray(5, 9);
    const r = new ByteReader(new ByteWriter().u16Array(view).finish());
    expect([...r.u16Array()]).toEqual([5000, 6000, 7000, 8000]);
  });

  it('reads correctly from an unaligned view into a larger buffer', () => {
    const payload = new ByteWriter().u8(9).u32(0xdeadbeef).f64(-2.5).u16Array(Uint16Array.of(7, 8)).finish();
    const big = new Uint8Array(payload.length + 10);
    big.fill(0xee);
    big.set(payload, 3);
    const r = new ByteReader(big.subarray(3, 3 + payload.length));
    expect(r.u8()).toBe(9);
    expect(r.u32()).toBe(0xdeadbeef);
    expect(r.f64()).toBe(-2.5);
    expect([...r.u16Array()]).toEqual([7, 8]);
    expect(r.eof()).toBe(true);
  });

  it('reader copies are independent from the input, views are not', () => {
    const src = new ByteWriter().bytes(Uint8Array.of(1, 2, 3)).bytes(Uint8Array.of(4, 5)).finish();
    const r = new ByteReader(src);
    const copy = r.bytes();
    const view = r.bytesView();
    src[1] = 99;
    src[5] = 77;
    expect([...copy]).toEqual([1, 2, 3]);
    expect(view[0]).toBe(77);
  });

  it('grows past the initial capacity and finish() is an exact-size copy', () => {
    const w = new ByteWriter(1);
    for (let i = 0; i < 10000; i++) w.u32(i);
    expect(w.length).toBe(40000);
    const out = w.finish();
    expect(out.length).toBe(40000);
    expect(out.buffer.byteLength).toBe(40000);
    out[0] = 0xff;
    expect(w.subarray(0, 1)[0]).toBe(0);
    w.u8(1);
    expect(w.length).toBe(40001);
    const r = new ByteReader(w.finish());
    for (let i = 0; i < 10000; i++) expect(r.u32()).toBe(i);
    expect(r.u8()).toBe(1);
    expect(w.reset().length).toBe(0);
  });

  it('accepts Node Buffers without aliasing their slices', () => {
    const buf = Buffer.from(new ByteWriter().bytes(Uint8Array.of(1, 2)).finish());
    const r = new ByteReader(buf);
    const b = r.bytes();
    buf[1] = 50;
    expect([...b]).toEqual([1, 2]);
  });
});

describe('ByteWriter rejects values it cannot store', () => {
  it('throws RangeError instead of truncating', () => {
    const w = new ByteWriter();
    expect(() => w.u8(256)).toThrow(RangeError);
    expect(() => w.u8(-1)).toThrow(RangeError);
    expect(() => w.u8(1.5)).toThrow(RangeError);
    expect(() => w.u8(NaN)).toThrow(RangeError);
    expect(() => w.u16(65536)).toThrow(RangeError);
    expect(() => w.u32(-1)).toThrow(RangeError);
    expect(() => w.u32(2 ** 32)).toThrow(RangeError);
    expect(() => w.i32(2 ** 31)).toThrow(RangeError);
    expect(() => w.i32(0.5)).toThrow(RangeError);
    expect(() => w.varuint(-1)).toThrow(RangeError);
    expect(() => w.varuint(2 ** 53)).toThrow(RangeError);
    expect(() => w.varuint(1.5)).toThrow(RangeError);
    expect(() => w.varuint(NaN)).toThrow(RangeError);
    expect(() => w.varuint(Infinity)).toThrow(RangeError);
    expect(() => w.varint(MAX + 1)).toThrow(RangeError);
    expect(() => w.varint(-MAX - 2)).toThrow(RangeError);
    expect(() => w.varint(0.5)).toThrow(RangeError);
    expect(() => w.u16Array([1, 70000])).toThrow(RangeError);
    expect(() => w.i32Array([2 ** 31])).toThrow(RangeError);
    expect(w.length).toBe(0); // nothing half-written
  });
});

describe('ByteReader rejects malformed input', () => {
  const record = (): Uint8Array =>
    new ByteWriter()
      .u8(1)
      .u16(2)
      .u32(3)
      .i32(-4)
      .f32(5)
      .f64(6)
      .varuint(2 ** 40)
      .varint(-(2 ** 45))
      .bool(true)
      .string('héllo 🧱')
      .bytes(Uint8Array.of(1, 2, 3))
      .u16Array(Uint16Array.of(1, 2))
      .i32Array(Int32Array.of(-1))
      .f64Array(Float64Array.of(0.5))
      .finish();
  const readAll = (b: Uint8Array): void => {
    const r = new ByteReader(b, 'rec');
    r.u8();
    r.u16();
    r.u32();
    r.i32();
    r.f32();
    r.f64();
    r.varuint();
    r.varint();
    r.bool();
    r.string();
    r.bytes();
    r.u16Array();
    r.i32Array();
    r.f64Array();
    r.expectEnd();
  };

  it('every truncation of a record throws SaveFormatError', () => {
    const full = record();
    expect(() => readAll(full)).not.toThrow();
    for (let n = 0; n < full.length; n++) {
      expect(() => readAll(full.subarray(0, n)), `truncated to ${n}`).toThrow(SaveFormatError);
    }
  });

  it('error messages carry the label and offset', () => {
    expect(() => new ByteReader(Uint8Array.of(1), 'glue').u32()).toThrow(/^glue: unexpected end of data reading u32.*at byte 0 of 1/);
  });

  it('trailing bytes are reported by expectEnd', () => {
    const r = new ByteReader(Uint8Array.of(1, 2));
    r.u8();
    expect(() => r.expectEnd()).toThrow(SaveFormatError);
  });

  it('rejects overlong, non-canonical and oversized varuints', () => {
    const bad = (bytes: number[]): (() => number) => () => new ByteReader(Uint8Array.from(bytes)).varuint();
    expect(bad([0x80])).toThrow(/truncated/);
    expect(bad([0x80, 0x00])).toThrow(/non-canonical/);
    expect(bad([0xff, 0xff, 0x00])).toThrow(/non-canonical/);
    // 2^53 exactly: eighth group = 0x10
    expect(bad([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10])).toThrow(/exceeds/);
    // nine groups
    expect(bad([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x8f, 0x01])).toThrow(/exceeds/);
    // max allowed decodes fine
    expect(bad([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f])()).toBe(MAX);
  });

  it('rejects non-canonical and out-of-range varints', () => {
    const bad = (bytes: number[]): (() => number) => () => new ByteReader(Uint8Array.from(bytes)).varint();
    expect(bad([0x82, 0x00])).toThrow(/non-canonical/);
    // zigzag 2^54 - 1 would be -(2^53): outside the safe range
    expect(bad([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f])).toThrow(SaveFormatError);
    expect(bad(refVarint(-MAX))()).toBe(-MAX);
    expect(bad(refVarint(MAX))()).toBe(MAX);
  });

  it('rejects invalid UTF-8', () => {
    const str = (body: number[]): (() => string) => () => new ByteReader(Uint8Array.from([body.length, ...body])).string();
    expect(str([0x80])).toThrow(/UTF-8/); // stray continuation
    expect(str([0xc0, 0xaf])).toThrow(/UTF-8/); // overlong '/'
    expect(str([0xc3])).toThrow(/UTF-8/); // truncated 2-byte
    expect(str([0xe0, 0x80, 0xaf])).toThrow(/UTF-8/); // overlong 3-byte
    expect(str([0xed, 0xa0, 0x80])).toThrow(/UTF-8/); // encoded surrogate
    expect(str([0xf0, 0x80, 0x80, 0xaf])).toThrow(/UTF-8/); // overlong 4-byte
    expect(str([0xf4, 0x90, 0x80, 0x80])).toThrow(/UTF-8/); // > U+10FFFF
    expect(str([0xf5, 0x80, 0x80, 0x80])).toThrow(/UTF-8/);
    expect(str([0xe4, 0xb8])).toThrow(/UTF-8/); // truncated 3-byte
    expect(str([0x61, 0xe4, 0x41, 0x80])).toThrow(/UTF-8/); // bad continuation
    expect(str([0xf4, 0x8f, 0xbf, 0xbf])()).toBe('\u{10ffff}');
  });

  it('a huge corrupted count fails fast without allocating', () => {
    const huge = new ByteWriter().varuint(2 ** 50).u8(1).finish();
    expect(() => new ByteReader(huge).u16Array()).toThrow(/exceeds/);
    expect(() => new ByteReader(huge).f64Array()).toThrow(/exceeds/);
    expect(() => new ByteReader(huge).string()).toThrow(/exceeds/);
    expect(() => new ByteReader(huge).bytes()).toThrow(/exceeds/);
    expect(() => new ByteReader(huge).count(1)).toThrow(SaveFormatError);
    // A count that fits exactly is fine
    expect(new ByteReader(new ByteWriter().varuint(2).u16(1).u16(2).finish()).count(2)).toBe(2);
    // A per-element minimum below 1 would accept any count (a 2^50-iteration loop): misuse.
    expect(() => new ByteReader(huge).count(0)).toThrow(RangeError);
    expect(() => new ByteReader(huge).count(NaN)).toThrow(RangeError);
  });

  it('skip and rawView are bounds-checked', () => {
    const r = new ByteReader(Uint8Array.of(1, 2, 3));
    expect(() => r.skip(4)).toThrow(SaveFormatError);
    expect(() => r.skip(-1)).toThrow(SaveFormatError);
    expect(() => r.skip(0.5)).toThrow(SaveFormatError);
    r.skip(1);
    expect([...r.rawView(2)]).toEqual([2, 3]);
    expect(() => r.rawView(1)).toThrow(SaveFormatError);
  });

  it('refuses non-binary input', () => {
    expect(() => new ByteReader('abc' as unknown as Uint8Array)).toThrow(SaveFormatError);
  });
});

describe('crc32', () => {
  it('matches the standard check value and zlib', async () => {
    const enc = new TextEncoder();
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    const { crc32: zcrc } = await import('node:zlib');
    const rng = new Rng(7);
    for (const len of [1, 2, 3, 4, 5, 7, 8, 63, 64, 65, 1000, 65536]) {
      const b = Uint8Array.from({ length: len }, () => rng.nextU32() & 255);
      if (typeof zcrc === 'function') expect(crc32(b)).toBe(zcrc(b));
      // range form equals the subarray form
      expect(crc32(b, 1, len - 1)).toBe(crc32(b.subarray(1, len - 1)));
    }
  });
});
