/**
 * Pure preparation of the tile texture array before upload (no three.js import; tested).
 *
 *  1. Row flip. TileTextureData stores row 0 as the TOP of each tile image, but mesh uv
 *     v = 0 is the BOTTOM of the tile. Both GPU backends map texture coordinate v = 0 to the
 *     first row in memory, so flipping rows once at upload makes v = 0 sample the bottom row
 *     with no per-fragment work.
 *  2. Colour dilation into fully transparent texels. The GPU builds the mip chain with a box
 *     filter on straight (non-premultiplied) alpha, so a transparent texel's RGB leaks into
 *     every mip. Artists usually leave it black, which gives cutout leaves and plants dark
 *     fringes at a distance. Each transparent texel instead takes the average colour of its
 *     nearest opaque neighbours (alpha stays 0, so nothing changes at full resolution).
 */
import type { TileTextureData } from '../backend';

/** How many rings of transparent texels receive a dilated colour (enough for 16 px mips). */
const DILATE_PASSES = 4;

/** Returns a new pixel buffer: rows flipped per layer, transparent texels colour-dilated. */
export function prepareTilePixels(tiles: TileTextureData): Uint8Array {
  const { size, count, pixels } = tiles;
  const layerBytes = size * size * 4;
  if (pixels.length < layerBytes * count) {
    throw new Error(`tile pixels too short: ${pixels.length} < ${layerBytes * count}`);
  }
  const out = new Uint8Array(layerBytes * count);
  const rowBytes = size * 4;
  for (let l = 0; l < count; l++) {
    const base = l * layerBytes;
    for (let row = 0; row < size; row++) {
      const src = base + row * rowBytes;
      const dst = base + (size - 1 - row) * rowBytes;
      out.set(pixels.subarray(src, src + rowBytes), dst);
    }
  }
  // Scratch "has colour" mask, reused for every layer.
  const known = new Uint8Array(size * size);
  const next = new Uint8Array(size * size);
  for (let l = 0; l < count; l++) dilateLayer(out, l * layerBytes, size, known, next);
  return out;
}

function dilateLayer(px: Uint8Array, base: number, size: number, known: Uint8Array, next: Uint8Array): void {
  const n = size * size;
  let transparent = 0;
  for (let i = 0; i < n; i++) {
    const a = px[base + i * 4 + 3]!;
    known[i] = a > 0 ? 1 : 0;
    if (a === 0) transparent++;
  }
  if (transparent === 0 || transparent === n) return;
  for (let pass = 0; pass < DILATE_PASSES; pass++) {
    next.set(known);
    let changed = false;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = x + y * size;
        if (known[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= size) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if ((dx === 0 && dy === 0) || xx < 0 || xx >= size) continue;
            const j = xx + yy * size;
            if (!known[j]) continue;
            const o = base + j * 4;
            r += px[o]!;
            g += px[o + 1]!;
            b += px[o + 2]!;
            c++;
          }
        }
        if (c > 0) {
          const o = base + i * 4;
          px[o] = Math.round(r / c);
          px[o + 1] = Math.round(g / c);
          px[o + 2] = Math.round(b / c);
          next[i] = 1;
          changed = true;
        }
      }
    }
    known.set(next);
    if (!changed) break;
  }
}

/** Number of mip levels of a square power-of-two tile (16 px -> 5). */
export function mipLevelCount(size: number): number {
  return Math.floor(Math.log2(Math.max(1, size))) + 1;
}
