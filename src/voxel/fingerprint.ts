/**
 * Fingerprints of voxel contents, for comparing two copies of a world (a client's replica with
 * another page's, or with the server: window.__blocklands.game.debug.digest and serverProbe, used
 * by the browser scripts). Pure functions over the cells.
 *
 * Every layer counts (docs/SHAPES.md 13.4): two copies that differ only in a holes byte or a
 * second part hash differently. A layer without a non-zero entry adds nothing, so a column or a
 * structure of full blocks hashes exactly as it did before M2.3, and a null layer and an all-zero
 * one hash the same.
 */
import type { CellLayers } from '../blocks/cell';
import type { Chunk } from './chunk';
import type { StructureGrid } from './sgrid';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** Separator mixed in before the non-zero entries of the holes layer ('H'). */
const HOLES_TAG = 0x48;
/** Separator mixed in before the non-zero entries of the second-part layer ('P'). */
const PART2_TAG = 0x50;

/** FNV-1a step over the 4 bytes of a 32-bit value, little endian. */
function mix32(h: number, v: number): number {
  h = Math.imul(h ^ (v & 0xff), FNV_PRIME) >>> 0;
  h = Math.imul(h ^ ((v >>> 8) & 0xff), FNV_PRIME) >>> 0;
  h = Math.imul(h ^ ((v >>> 16) & 0xff), FNV_PRIME) >>> 0;
  return Math.imul(h ^ (v >>> 24), FNV_PRIME) >>> 0;
}

/**
 * Hash of a column's (or any volume's) layers: FNV-1a over the base layer, one step per entry;
 * then, if the holes layer has non-zero entries, the separator 0x48 and for each non-zero entry in
 * index order its index (4 bytes LE) and value (one step); then likewise the second-part layer
 * with separator 0x50 and the value as 4 bytes LE.
 */
export function layersHash(v: CellLayers): number {
  const base = v.base;
  let h = FNV_OFFSET;
  for (let i = 0; i < base.length; i++) h = Math.imul(h ^ base[i]!, FNV_PRIME) >>> 0;
  const holes = v.holes;
  if (holes !== null) {
    let tagged = false;
    for (let i = 0; i < holes.length; i++) {
      const x = holes[i]!;
      if (x === 0) continue;
      if (!tagged) {
        h = Math.imul(h ^ HOLES_TAG, FNV_PRIME) >>> 0;
        tagged = true;
      }
      h = mix32(h, i);
      h = Math.imul(h ^ x, FNV_PRIME) >>> 0;
    }
  }
  const part2 = v.part2;
  if (part2 !== null) {
    let tagged = false;
    for (let i = 0; i < part2.length; i++) {
      const x = part2[i]!;
      if (x === 0) continue;
      if (!tagged) {
        h = Math.imul(h ^ PART2_TAG, FNV_PRIME) >>> 0;
        tagged = true;
      }
      h = mix32(h, i);
      h = mix32(h, x);
    }
  }
  return h;
}

/** layersHash of a loaded column (all three layers, in storage order). */
export function columnHash(chunk: Chunk): number {
  return layersHash(chunk.layers());
}

/**
 * A structure's cells whatever its storage box: the sum (mod 2^32) of an FNV-1a over each
 * non-empty cell's local x, y, z and packed value (low 16 bits, bits 16-31, and the bits above
 * 2^32 when there are any), so the order the grid lists them in does not matter.
 */
export function gridHash(grid: StructureGrid): number {
  let sum = 0;
  grid.forEachCell((x, y, z, packed) => {
    let h = FNV_OFFSET;
    for (const v of [x, y, z]) {
      h = Math.imul(h ^ (v & 0xffff), FNV_PRIME) >>> 0;
      h = Math.imul(h ^ (v >>> 16), FNV_PRIME) >>> 0;
    }
    const low = packed % 0x100000000;
    h = Math.imul(h ^ (low & 0xffff), FNV_PRIME) >>> 0;
    h = Math.imul(h ^ (low >>> 16), FNV_PRIME) >>> 0;
    if (packed >= 0x100000000) h = Math.imul(h ^ Math.floor(packed / 0x100000000), FNV_PRIME) >>> 0;
    sum = (sum + h) >>> 0;
  });
  return sum;
}
