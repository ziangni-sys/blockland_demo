/**
 * Binary building blocks for every save format: a growable little-endian writer and a
 * bounds-checked reader. Chunks, ticks, world meta — and later structures, glue and
 * entities — all serialise through these two classes.
 *
 * Wire conventions (fixed forever, saves depend on them):
 *  - fixed-width numbers are little-endian; f32/f64 are IEEE-754 (NaN payloads are not
 *    preserved, -0 and infinities are);
 *  - varuint = unsigned LEB128, canonical (shortest) form, values 0 .. 2^53-1 (8 bytes max);
 *  - varint = zigzag + LEB128 over the FULL safe-integer range (-(2^53-1) .. 2^53-1);
 *  - string = varuint UTF-8 byte length + UTF-8 bytes (lone surrogates are written as
 *    U+FFFD, exactly like TextEncoder);
 *  - bytes = varuint length + raw bytes;
 *  - u16Array / i32Array / f64Array = varuint ELEMENT count + little-endian elements.
 *
 * Error policy:
 *  - Writing an out-of-range value is a programming error -> RangeError, never silent
 *    truncation (a u8(300) that quietly stored 44 would be a save-corrupting bug).
 *  - Reading malformed or truncated data is a data error -> SaveFormatError with the
 *    reader's label and byte offset. The reader never reads out of bounds and never
 *    allocates more than the remaining input could describe, so a corrupted length field
 *    cannot trigger a giant allocation.
 *
 * Pure module: no DOM, no TextEncoder/TextDecoder (UTF-8 is done by hand, which is also
 * faster for the short strings saves contain).
 */

/** Thrown for any malformed, truncated, corrupted or unsupported save data. */
export class SaveFormatError extends Error {
  override readonly name = 'SaveFormatError';
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53 - 1
const TWO_POW_28 = 0x10000000;

/**
 * Host byte order, probed once. Typed-array bulk copies are only valid on little-endian
 * hosts (every browser platform in practice); big-endian hosts take the per-element path.
 */
const LITTLE_ENDIAN: boolean = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * True for any Uint8Array, including subclasses (Node's Buffer) and arrays created in another
 * realm (a worker or iframe), where `instanceof` alone would say no.
 */
export function isUint8Array(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array || Object.prototype.toString.call(v) === '[object Uint8Array]';
}

/** Plain view over the same memory (subclasses such as Node's Buffer override slice()). */
function plainView(bytes: Uint8Array): Uint8Array {
  return bytes.constructor === Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function describeValue(v: unknown): string {
  return typeof v === 'number' ? String(v) : `${typeof v} ${String(v)}`;
}

// ====================================================================== writer

/** Growable little-endian binary writer. All write methods return `this` for chaining. */
export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  /** @param capacity initial buffer size in bytes; the buffer doubles as needed. */
  constructor(capacity = 256) {
    const cap = Math.max(16, Math.floor(capacity) || 0);
    this.buf = new Uint8Array(cap);
    this.view = new DataView(this.buf.buffer);
  }

  /** Number of bytes written so far. */
  get length(): number {
    return this.pos;
  }

  /** Exact-size copy of everything written. The writer stays usable (and keeps its data). */
  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }

  /**
   * View of the written bytes [start, end) WITHOUT copying. Only valid until the next
   * write (growth reallocates). Use for checksums or hashing, never store it.
   */
  subarray(start = 0, end: number = this.pos): Uint8Array {
    return this.buf.subarray(start, Math.min(end, this.pos));
  }

  /** Forget everything written (keeps the allocated buffer for reuse). */
  reset(): this {
    this.pos = 0;
    return this;
  }

  // ------------------------------------------------------------ fixed width

  u8(v: number): this {
    if ((v & 0xff) !== v) throw new RangeError(`u8 out of range: ${describeValue(v)}`);
    if (this.pos + 1 > this.buf.length) this.grow(1);
    this.buf[this.pos++] = v;
    return this;
  }

  u16(v: number): this {
    if ((v & 0xffff) !== v) throw new RangeError(`u16 out of range: ${describeValue(v)}`);
    if (this.pos + 2 > this.buf.length) this.grow(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }

  u32(v: number): this {
    if (v >>> 0 !== v) throw new RangeError(`u32 out of range: ${describeValue(v)}`);
    if (this.pos + 4 > this.buf.length) this.grow(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  i32(v: number): this {
    if ((v | 0) !== v) throw new RangeError(`i32 out of range: ${describeValue(v)}`);
    if (this.pos + 4 > this.buf.length) this.grow(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  /** Any number; rounds to the nearest float32 (Math.fround semantics). */
  f32(v: number): this {
    if (typeof v !== 'number') throw new RangeError(`f32 expects a number, got ${describeValue(v)}`);
    if (this.pos + 4 > this.buf.length) this.grow(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  /** Any number, stored exactly (including -0, infinities and NaN). */
  f64(v: number): this {
    if (typeof v !== 'number') throw new RangeError(`f64 expects a number, got ${describeValue(v)}`);
    if (this.pos + 8 > this.buf.length) this.grow(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }

  bool(v: boolean): this {
    if (this.pos + 1 > this.buf.length) this.grow(1);
    this.buf[this.pos++] = v ? 1 : 0;
    return this;
  }

  // ------------------------------------------------------------ variable length

  /** Unsigned LEB128, 0 .. 2^53-1. 1 byte below 128, 2 below 16384, 3 below 2^21 ... */
  varuint(v: number): this {
    if (!(v >= 0 && v <= MAX_SAFE) || Math.floor(v) !== v) {
      throw new RangeError(`varuint out of range (0..2^53-1 integer): ${describeValue(v)}`);
    }
    if (this.pos + 8 > this.buf.length) this.grow(8);
    const buf = this.buf;
    let pos = this.pos;
    // Above 31 bits bitwise ops would wrap, so peel those groups off arithmetically.
    while (v >= 0x80000000) {
      buf[pos++] = (v % 128) | 0x80;
      v = Math.floor(v / 128);
    }
    while (v >= 0x80) {
      buf[pos++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    buf[pos++] = v;
    this.pos = pos;
    return this;
  }

  /**
   * Signed zigzag LEB128 over the whole safe-integer range: 0,-1,1,-2,2 ... map to
   * 0,1,2,3,4. Small magnitudes of either sign cost one byte (-64 .. 63).
   */
  varint(v: number): this {
    if (!Number.isSafeInteger(v)) throw new RangeError(`varint out of range (safe integer): ${describeValue(v)}`);
    if (v >= -0x40000000 && v < 0x40000000) {
      // (v << 1) ^ (v >> 31) fits in 31 bits here: the classic zigzag in int32 arithmetic.
      return this.varuint((v << 1) ^ (v >> 31));
    }
    // zigzag(v) = 2k + s needs up to 54 bits, which a double cannot hold when odd. Emit its
    // LEB128 without ever forming it: the first group is (k mod 64) << 1 | s and the rest
    // is exactly the LEB128 of floor(k / 64), with k = v >= 0 ? v : -v - 1.
    const s = v < 0 ? 1 : 0;
    const k = s ? -v - 1 : v;
    if (this.pos + 1 > this.buf.length) this.grow(1);
    this.buf[this.pos++] = ((k % 64) * 2 + s) | 0x80; // k >= 2^30 - 1, so more groups follow
    return this.varuint(Math.floor(k / 64));
  }

  /** UTF-8 string with a varuint byte-length prefix. */
  string(s: string): this {
    if (typeof s !== 'string') throw new RangeError(`string expects a string, got ${describeValue(s)}`);
    const n = utf8Length(s);
    this.varuint(n);
    if (this.pos + n > this.buf.length) this.grow(n);
    this.pos = utf8Encode(s, this.buf, this.pos);
    return this;
  }

  /** Byte array with a varuint length prefix. */
  bytes(b: Uint8Array): this {
    if (!isUint8Array(b)) throw new RangeError(`bytes expects a Uint8Array, got ${describeValue(b)}`);
    this.varuint(b.length);
    return this.raw(b);
  }

  /** Raw bytes, no prefix (magic numbers, pre-framed data). */
  raw(b: Uint8Array): this {
    if (!isUint8Array(b)) throw new RangeError(`raw expects a Uint8Array, got ${describeValue(b)}`);
    const n = b.length;
    if (this.pos + n > this.buf.length) this.grow(n);
    this.buf.set(b, this.pos);
    this.pos += n;
    return this;
  }

  // ------------------------------------------------------------ arrays

  /** varuint element count + little-endian uint16 elements. Plain arrays are range-checked. */
  u16Array(values: ArrayLike<number>): this {
    const n = values.length;
    if (!(values instanceof Uint16Array)) {
      for (let i = 0; i < n; i++) {
        const v = values[i]!;
        if ((v & 0xffff) !== v) throw new RangeError(`u16Array[${i}] out of range: ${describeValue(v)}`);
      }
    }
    this.varuint(n);
    const bytes = n * 2;
    if (this.pos + bytes > this.buf.length) this.grow(bytes);
    if (LITTLE_ENDIAN && values instanceof Uint16Array) {
      this.buf.set(new Uint8Array(values.buffer, values.byteOffset, bytes), this.pos);
    } else {
      const view = this.view;
      for (let i = 0, p = this.pos; i < n; i++, p += 2) view.setUint16(p, values[i]!, true);
    }
    this.pos += bytes;
    return this;
  }

  /** varuint element count + little-endian int32 elements. Plain arrays are range-checked. */
  i32Array(values: ArrayLike<number>): this {
    const n = values.length;
    if (!(values instanceof Int32Array)) {
      for (let i = 0; i < n; i++) {
        const v = values[i]!;
        if ((v | 0) !== v) throw new RangeError(`i32Array[${i}] out of range: ${describeValue(v)}`);
      }
    }
    this.varuint(n);
    const bytes = n * 4;
    if (this.pos + bytes > this.buf.length) this.grow(bytes);
    if (LITTLE_ENDIAN && values instanceof Int32Array) {
      this.buf.set(new Uint8Array(values.buffer, values.byteOffset, bytes), this.pos);
    } else {
      const view = this.view;
      for (let i = 0, p = this.pos; i < n; i++, p += 4) view.setInt32(p, values[i]!, true);
    }
    this.pos += bytes;
    return this;
  }

  /** varuint element count + little-endian float64 elements (exact). */
  f64Array(values: ArrayLike<number>): this {
    const n = values.length;
    if (!(values instanceof Float64Array)) {
      for (let i = 0; i < n; i++) {
        const v = values[i];
        if (typeof v !== 'number') throw new RangeError(`f64Array[${i}] is not a number: ${describeValue(v)}`);
      }
    }
    this.varuint(n);
    const bytes = n * 8;
    if (this.pos + bytes > this.buf.length) this.grow(bytes);
    if (LITTLE_ENDIAN && values instanceof Float64Array) {
      this.buf.set(new Uint8Array(values.buffer, values.byteOffset, bytes), this.pos);
    } else {
      const view = this.view;
      for (let i = 0, p = this.pos; i < n; i++, p += 8) view.setFloat64(p, values[i]!, true);
    }
    this.pos += bytes;
    return this;
  }

  // ------------------------------------------------------------ internals

  /** Make room for `n` more bytes (amortised doubling). Kept out of line so hot paths stay small. */
  private grow(n: number): void {
    const need = this.pos + n;
    let cap = this.buf.length * 2;
    if (cap < need) cap = need;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
}

// ====================================================================== reader

/** Bounds-checked little-endian reader. Every malformed input throws SaveFormatError. */
export class ByteReader {
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private readonly end: number;
  private pos = 0;
  /** Prefix for error messages, e.g. "chunk" or "world meta". */
  readonly label: string;

  /**
   * @param bytes data to read; it is NOT copied, so do not mutate it while reading.
   * @param label names the data in error messages.
   */
  constructor(bytes: Uint8Array, label = 'data') {
    if (!isUint8Array(bytes)) throw new SaveFormatError(`${label}: expected a Uint8Array, got ${describeValue(bytes)}`);
    this.buf = plainView(bytes);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.end = this.buf.length;
    this.label = label;
  }

  /** Current read offset in bytes. */
  get position(): number {
    return this.pos;
  }
  /** Total input length in bytes. */
  get length(): number {
    return this.end;
  }
  /** Bytes left to read. */
  get remaining(): number {
    return this.end - this.pos;
  }
  /** True when every byte has been consumed. */
  eof(): boolean {
    return this.pos >= this.end;
  }

  /** Throw a SaveFormatError tagged with this reader's label and current offset. */
  fail(message: string): never {
    throw new SaveFormatError(`${this.label}: ${message} (at byte ${this.pos} of ${this.end})`);
  }

  /** Require that the input has been fully consumed (catches trailing garbage). */
  expectEnd(): void {
    if (this.pos !== this.end) this.fail(`${this.end - this.pos} unexpected trailing byte(s)`);
  }

  /** Advance without reading. */
  skip(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > this.end - this.pos) this.overrun('skip', n);
    this.pos += n;
  }

  // ------------------------------------------------------------ fixed width

  u8(): number {
    if (this.pos + 1 > this.end) this.overrun('u8', 1);
    return this.buf[this.pos++]!;
  }
  u16(): number {
    const p = this.pos;
    if (p + 2 > this.end) this.overrun('u16', 2);
    this.pos = p + 2;
    return this.view.getUint16(p, true);
  }
  u32(): number {
    const p = this.pos;
    if (p + 4 > this.end) this.overrun('u32', 4);
    this.pos = p + 4;
    return this.view.getUint32(p, true);
  }
  i32(): number {
    const p = this.pos;
    if (p + 4 > this.end) this.overrun('i32', 4);
    this.pos = p + 4;
    return this.view.getInt32(p, true);
  }
  f32(): number {
    const p = this.pos;
    if (p + 4 > this.end) this.overrun('f32', 4);
    this.pos = p + 4;
    return this.view.getFloat32(p, true);
  }
  f64(): number {
    const p = this.pos;
    if (p + 8 > this.end) this.overrun('f64', 8);
    this.pos = p + 8;
    return this.view.getFloat64(p, true);
  }
  /** Strict: only the bytes 0 and 1 are accepted. */
  bool(): boolean {
    if (this.pos + 1 > this.end) this.overrun('bool', 1);
    const b = this.buf[this.pos]!;
    if (b > 1) this.fail(`invalid bool byte ${b}`);
    this.pos++;
    return b === 1;
  }

  // ------------------------------------------------------------ variable length

  /** Unsigned LEB128. Rejects overlong / non-canonical encodings and values above 2^53-1. */
  varuint(): number {
    const buf = this.buf;
    const end = this.end;
    let pos = this.pos;
    if (pos >= end) this.overrun('varuint', 1);
    let b = buf[pos++]!;
    if (b < 0x80) {
      this.pos = pos;
      return b;
    }
    let result = b & 0x7f;
    let shift = 7;
    let mul = TWO_POW_28;
    for (;;) {
      if (pos >= end) {
        this.pos = pos;
        this.fail('truncated varuint');
      }
      b = buf[pos++]!;
      if (shift < 28) {
        result |= (b & 0x7f) << shift; // stays below 2^28: no sign trouble
      } else {
        // 2^53 - 1 needs exactly 4 bits in the 8th group; anything more (or a 9th group) overflows.
        if (shift === 49 && b > 0x0f) {
          this.pos = pos - 1;
          this.fail('varuint exceeds 2^53-1');
        }
        result += (b & 0x7f) * mul;
        mul *= 128;
      }
      if (b < 0x80) {
        if (b === 0) {
          this.pos = pos - 1;
          this.fail('non-canonical varuint (redundant zero group)');
        }
        this.pos = pos;
        return result;
      }
      shift += 7;
    }
  }

  /** Signed zigzag LEB128 (see ByteWriter.varint). */
  varint(): number {
    if (this.pos >= this.end) this.overrun('varint', 1);
    const b0 = this.buf[this.pos]!;
    if (b0 < 0x80) {
      this.pos++;
      return (b0 >>> 1) ^ -(b0 & 1);
    }
    this.pos++;
    const start = this.pos;
    const q = this.varuint();
    if (q === 0) {
      this.pos = start;
      this.fail('non-canonical varint (redundant zero group)');
    }
    const s = b0 & 1;
    const k = q * 64 + ((b0 >>> 1) & 0x3f);
    if (k > MAX_SAFE - s) {
      this.pos = start - 1;
      this.fail('varint outside the safe integer range');
    }
    return s ? -k - 1 : k;
  }

  /**
   * Read a varuint element count and reject counts that could not possibly fit in the
   * remaining input at `minBytesEach` bytes per element. Use it before allocating arrays
   * or looping over records, so corrupted counts fail fast instead of allocating gigabytes.
   * Pair with ByteWriter.varuint(count).
   */
  count(minBytesEach = 1): number {
    const at = this.pos;
    const n = this.varuint();
    const left = this.end - this.pos;
    if (n * minBytesEach > left) {
      this.pos = at;
      this.fail(`count ${n} (x${minBytesEach} bytes) exceeds the ${left} remaining bytes`);
    }
    return n;
  }

  /** UTF-8 string with varuint byte length. Invalid UTF-8 is rejected, not replaced. */
  string(): string {
    const n = this.count(1);
    const start = this.pos;
    const s = utf8Decode(this.buf, start, start + n);
    if (typeof s === 'number') {
      this.pos = s;
      this.fail('invalid UTF-8 in string');
    }
    this.pos = start + n;
    return s;
  }

  /** Length-prefixed bytes as a fresh copy (safe to keep and mutate). */
  bytes(): Uint8Array {
    const n = this.count(1);
    const p = this.pos;
    this.pos = p + n;
    return this.buf.slice(p, p + n);
  }

  /**
   * Length-prefixed bytes as a view into the input WITHOUT copying. Cheaper for nested
   * sections that are decoded immediately; never keep it beyond the input's lifetime.
   */
  bytesView(): Uint8Array {
    const n = this.count(1);
    const p = this.pos;
    this.pos = p + n;
    return this.buf.subarray(p, p + n);
  }

  /** Next `n` raw bytes as a view (no length prefix, no copy). */
  rawView(n: number): Uint8Array {
    if (!Number.isInteger(n) || n < 0 || n > this.end - this.pos) this.overrun('raw bytes', n);
    const p = this.pos;
    this.pos = p + n;
    return this.buf.subarray(p, p + n);
  }

  // ------------------------------------------------------------ arrays

  u16Array(): Uint16Array {
    const n = this.count(2);
    const out = new Uint16Array(n);
    this.copyElements(out, n, 2);
    return out;
  }
  i32Array(): Int32Array {
    const n = this.count(4);
    const out = new Int32Array(n);
    this.copyElements(out, n, 4);
    return out;
  }
  f64Array(): Float64Array {
    const n = this.count(8);
    const out = new Float64Array(n);
    this.copyElements(out, n, 8);
    return out;
  }

  // ------------------------------------------------------------ internals

  /** Fill a freshly allocated typed array from the input (count already validated). */
  private copyElements(out: Uint16Array | Int32Array | Float64Array, n: number, size: 2 | 4 | 8): void {
    const p = this.pos;
    const bytes = n * size;
    if (LITTLE_ENDIAN) {
      // Byte copy into the (always aligned) destination: works for any source alignment.
      new Uint8Array(out.buffer, out.byteOffset, bytes).set(this.buf.subarray(p, p + bytes));
    } else {
      const view = this.view;
      if (size === 2) for (let i = 0; i < n; i++) out[i] = view.getUint16(p + i * 2, true);
      else if (size === 4) for (let i = 0; i < n; i++) out[i] = view.getInt32(p + i * 4, true);
      else for (let i = 0; i < n; i++) out[i] = view.getFloat64(p + i * 8, true);
    }
    this.pos = p + bytes;
  }

  private overrun(what: string, need: number): never {
    this.fail(`unexpected end of data reading ${what} (need ${need} byte(s), ${this.end - this.pos} left)`);
  }
}

// ====================================================================== UTF-8

/** Exact UTF-8 byte length of `s`, counting each lone surrogate as U+FFFD (3 bytes). */
export function utf8Length(s: string): number {
  const len = s.length;
  let n = 0;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < len) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else {
        n += 3;
      }
    } else {
      n += 3;
    }
  }
  return n;
}

/** Encode `s` into `out` at `pos` (caller guarantees room). Returns the new position. */
function utf8Encode(s: string, out: Uint8Array, pos: number): number {
  const len = s.length;
  for (let i = 0; i < len; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      out[pos++] = c;
      continue;
    }
    if (c < 0x800) {
      out[pos++] = 0xc0 | (c >> 6);
      out[pos++] = 0x80 | (c & 0x3f);
      continue;
    }
    if (c >= 0xd800 && c <= 0xdfff) {
      const d = i + 1 < len ? s.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        out[pos++] = 0xf0 | (cp >> 18);
        out[pos++] = 0x80 | ((cp >> 12) & 0x3f);
        out[pos++] = 0x80 | ((cp >> 6) & 0x3f);
        out[pos++] = 0x80 | (cp & 0x3f);
        i++;
        continue;
      }
      c = 0xfffd; // lone surrogate
    }
    out[pos++] = 0xe0 | (c >> 12);
    out[pos++] = 0x80 | ((c >> 6) & 0x3f);
    out[pos++] = 0x80 | (c & 0x3f);
  }
  return pos;
}

/** Flush decoded code units to a string every this many units (far below engine arg limits). */
const FROM_CHAR_CHUNK = 4096;

/**
 * Strict UTF-8 decode of bytes[start, end). Returns the string, or the byte offset of the
 * first invalid sequence (overlong forms, surrogate code points, values above U+10FFFF,
 * stray or missing continuation bytes are all invalid).
 *
 * Code units go into a plain array flushed through String.fromCharCode.apply: measured ~3x
 * faster than a Uint16Array + apply for the short strings saves contain.
 */
function utf8Decode(bytes: Uint8Array, start: number, end: number): string | number {
  if (start === end) return '';
  const units: number[] = [];
  let out = '';
  let i = start;
  while (i < end) {
    const b0 = bytes[i]!;
    if (b0 < 0x80) {
      units.push(b0);
      i++;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      if (i + 1 >= end) return i;
      const b1 = bytes[i + 1]!;
      if ((b1 & 0xc0) !== 0x80) return i;
      units.push(((b0 & 0x1f) << 6) | (b1 & 0x3f));
      i += 2;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      if (i + 2 >= end) return i;
      const b1 = bytes[i + 1]!;
      const b2 = bytes[i + 2]!;
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) return i;
      if (b0 === 0xe0 && b1 < 0xa0) return i; // overlong
      if (b0 === 0xed && b1 > 0x9f) return i; // UTF-16 surrogate code point
      units.push(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
      i += 3;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      if (i + 3 >= end) return i;
      const b1 = bytes[i + 1]!;
      const b2 = bytes[i + 2]!;
      const b3 = bytes[i + 3]!;
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) return i;
      if (b0 === 0xf0 && b1 < 0x90) return i; // overlong
      if (b0 === 0xf4 && b1 > 0x8f) return i; // above U+10FFFF
      const cp = (((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)) - 0x10000;
      units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      i += 4;
    } else {
      return i; // 0x80..0xc1 (stray continuation / overlong lead) or 0xf5..0xff
    }
    if (units.length >= FROM_CHAR_CHUNK) {
      out += String.fromCharCode.apply(null, units);
      units.length = 0;
    }
  }
  return out + String.fromCharCode.apply(null, units);
}
