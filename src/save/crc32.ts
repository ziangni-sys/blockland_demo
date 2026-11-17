/**
 * CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) — the same checksum as zlib, PNG
 * and ZIP, so values can be cross-checked with any standard tool.
 *
 * Every save blob ends with the CRC of everything before it. IndexedDB itself almost never
 * corrupts data, but a checksum turns the rare bad write, a half-copied export file or a
 * codec bug into a clean SaveFormatError instead of a world full of wrong blocks.
 *
 * Implementation: slicing-by-4 (four 256-entry tables, 4 KB). It processes a word per
 * step and is ~3x faster than the byte-wise loop, which matters for raw (incompressible)
 * 64 KB chunks.
 */

/** T[k][n] = CRC contribution of byte n followed by k zero bytes. Immutable after creation. */
const TABLES: Int32Array = buildTables();

function buildTables(): Int32Array {
  const t = new Int32Array(4 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n]!;
    for (let k = 1; k < 4; k++) {
      c = t[c & 0xff]! ^ (c >>> 8);
      t[k * 256 + n] = c;
    }
  }
  return t;
}

/**
 * CRC-32 of bytes[start, end). Returns an unsigned 32-bit integer.
 * `start`/`end` are clamped to the array like `subarray` does.
 */
export function crc32(bytes: Uint8Array, start = 0, end: number = bytes.length): number {
  const t = TABLES;
  let i = Math.max(0, Math.min(start, bytes.length)) | 0;
  const stop = Math.max(i, Math.min(end, bytes.length)) | 0;
  let c = -1;
  const wordEnd = stop - 3;
  for (; i < wordEnd; i += 4) {
    c ^= bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24);
    c =
      t[768 + (c & 0xff)]! ^
      t[512 + ((c >>> 8) & 0xff)]! ^
      t[256 + ((c >>> 16) & 0xff)]! ^
      t[c >>> 24]!;
  }
  for (; i < stop; i++) c = t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
