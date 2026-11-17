/** One chunk column: 16 x WORLD_HEIGHT x 16 cells plus light. */
import { CHUNK_SIZE, CHUNK_VOLUME, SECTIONS_PER_CHUNK, WORLD_HEIGHT } from '../core/constants';

/** Index of a cell inside a chunk. lx, lz in 0..15, y in 0..WORLD_HEIGHT-1. */
export function cellIndex(lx: number, y: number, lz: number): number {
  return lx | (lz << 4) | (y << 8);
}

const KEY_BIAS = 0x80000; // supports chunk coords in [-524288, 524287]
const KEY_MUL = 0x100000;

/** Numeric map key of a chunk column. */
export function chunkKey(cx: number, cz: number): number {
  return (cx + KEY_BIAS) * KEY_MUL + (cz + KEY_BIAS);
}
export function chunkKeyX(key: number): number {
  return Math.floor(key / KEY_MUL) - KEY_BIAS;
}
export function chunkKeyZ(key: number): number {
  return (key % KEY_MUL) - KEY_BIAS;
}
/** Numeric key of a 16^3 mesh section (sy = section index 0..SECTIONS_PER_CHUNK-1). */
export function sectionKey(cx: number, sy: number, cz: number): number {
  return chunkKey(cx, cz) * SECTIONS_PER_CHUNK + sy;
}
export function sectionKeyParts(key: number): { cx: number; sy: number; cz: number } {
  const sy = key % SECTIONS_PER_CHUNK;
  const ck = Math.floor(key / SECTIONS_PER_CHUNK);
  return { cx: chunkKeyX(ck), sy, cz: chunkKeyZ(ck) };
}

export class Chunk {
  readonly cx: number;
  readonly cz: number;
  /** Cells, index = lx | lz<<4 | y<<8. */
  readonly cells: Uint16Array;
  /** Light, same index: high nibble = sky light, low nibble = block light. */
  readonly light: Uint8Array;
  /**
   * Per column (index lx | lz<<4): y of the highest cell with lightOpacity > 0, plus 1
   * (0 when the column is empty). Maintained by the light module.
   */
  readonly heightmap: Uint8Array;
  /** True once the chunk differs from pristine generator output and must be saved. */
  modified = false;
  /** True once initial lighting has been computed. */
  lit = false;

  constructor(cx: number, cz: number, cells?: Uint16Array, light?: Uint8Array) {
    this.cx = cx;
    this.cz = cz;
    this.cells = cells ?? new Uint16Array(CHUNK_VOLUME);
    this.light = light ?? new Uint8Array(CHUNK_VOLUME);
    this.heightmap = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    if (this.cells.length !== CHUNK_VOLUME || this.light.length !== CHUNK_VOLUME) {
      throw new Error('chunk buffer size mismatch');
    }
  }

  get(lx: number, y: number, lz: number): number {
    return this.cells[lx | (lz << 4) | (y << 8)]!;
  }
  set(lx: number, y: number, lz: number, cell: number): void {
    this.cells[lx | (lz << 4) | (y << 8)] = cell;
  }
}

export { WORLD_HEIGHT };
