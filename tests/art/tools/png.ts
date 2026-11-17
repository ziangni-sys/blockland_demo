/**
 * Minimal PNG encoder (RGBA8, no interlace, filter 0) built on node:zlib. Tooling only.
 */
import { deflateSync } from 'node:zlib';

function crcTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}

function crc32(table: Uint32Array, bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(table: Uint32Array, type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 8);
  out.writeUInt32BE(crc32(table, out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encodes width x height RGBA8 pixels (row 0 = top) as a PNG file. */
export function encodePng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Buffer {
  if (rgba.length !== width * height * 4) throw new Error('pixel buffer size mismatch');
  const table = crcTable();
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk(table, 'IHDR', ihdr),
    chunk(table, 'IDAT', deflateSync(raw, { level: 9 })),
    chunk(table, 'IEND', new Uint8Array(0)),
  ]);
}
