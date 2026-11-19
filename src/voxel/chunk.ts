/**
 * One chunk column: 16 x WORLD_HEIGHT x 16 cells plus light.
 *
 * The cells are stored in three layers (docs/SHAPES.md section 4.1): the base layer `cells`
 * (id + state of the first part, 16 bits, exactly the M1 array), and two layers allocated on
 * demand the first time a cell with holes or a second part is written: `holes` (holes of the
 * first part) and `part2` (the second part's value). A layer, once allocated, stays for the
 * life of the Chunk object even when every entry is 0 again; `layers()` hands a layer out as
 * null when its count of non-zero entries is 0, so encoders and digests see null and all-zero
 * the same way. Only World writes the layers (through writeCell).
 */
import { CHUNK_SIZE, CHUNK_VOLUME, SECTIONS_PER_CHUNK, WORLD_HEIGHT } from '../core/constants';
import { HOLES_MASK, HOLES_SHIFT, type CellLayers } from '../blocks/cell';

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
  /** Base layer: id + state of each cell's first part, index = lx | lz<<4 | y<<8. */
  readonly cells: Uint16Array;
  /**
   * Holes of each cell's first part (same index), null until a cell with holes is written.
   * Never set back to null while the Chunk lives (see the file comment). Written only by World.
   */
  holes: Uint8Array | null;
  /**
   * Value of each cell's second part (same index; 0 = none), null until a two-part cell is
   * written. Never set back to null while the Chunk lives. Written only by World.
   */
  part2: Uint32Array | null;
  /** Light, same index: high nibble = sky light, low nibble = block light. */
  readonly light: Uint8Array;
  /**
   * Per column (index lx | lz<<4): 1 + the highest y at which the sky falling straight down stops
   * (the cell's medium has lightOpacity > 0, or the face between y and y + 1 is closed by the
   * opaque covers of the two cells), 0 when it never stops. Maintained by the light module
   * (docs/SHAPES.md 7.1).
   */
  readonly heightmap: Uint8Array;
  /** True once the chunk differs from pristine generator output and must be saved. */
  modified = false;
  /** True once initial lighting has been computed. */
  lit = false;
  /** Non-zero entries of `holes` / `part2`. */
  private holesCount = 0;
  private part2Count = 0;

  /**
   * `new Chunk(cx, cz, cells)` is a column of full blocks only (generator output). The optional
   * layers are taken over without copying; a layer whose entries are all 0 is taken as null.
   */
  constructor(
    cx: number,
    cz: number,
    cells?: Uint16Array,
    light?: Uint8Array,
    holes?: Uint8Array | null,
    part2?: Uint32Array | null,
  ) {
    this.cx = cx;
    this.cz = cz;
    this.cells = cells ?? new Uint16Array(CHUNK_VOLUME);
    this.light = light ?? new Uint8Array(CHUNK_VOLUME);
    this.heightmap = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    if (
      this.cells.length !== CHUNK_VOLUME ||
      this.light.length !== CHUNK_VOLUME ||
      (holes != null && holes.length !== CHUNK_VOLUME) ||
      (part2 != null && part2.length !== CHUNK_VOLUME)
    ) {
      throw new Error('chunk buffer size mismatch');
    }
    this.holesCount = holes != null ? countNonZero(holes) : 0;
    this.holes = this.holesCount > 0 ? holes! : null;
    this.part2Count = part2 != null ? countNonZero(part2) : 0;
    this.part2 = this.part2Count > 0 ? part2! : null;
  }

  /** The three layers by reference (no copy); a layer with no non-zero entry is null. */
  layers(): CellLayers {
    return {
      base: this.cells,
      holes: this.holesCount > 0 ? this.holes : null,
      part2: this.part2Count > 0 ? this.part2 : null,
    };
  }

  /**
   * Store cell `i` in the three layers: `cell` is a cell value (first part + CELL_MULTI_BIT),
   * `p2` the second part (0 = none). Allocates a layer the first time it gets a non-zero entry
   * and keeps the counts; never frees a layer. For World.setCell only: no validation, no events.
   */
  writeCell(i: number, cell: number, p2: number): void {
    this.cells[i] = cell & 0xffff;
    const h = (cell >>> HOLES_SHIFT) & HOLES_MASK;
    let holes = this.holes;
    if (holes === null && h !== 0) holes = this.holes = new Uint8Array(CHUNK_VOLUME);
    if (holes !== null) {
      const was = holes[i]!;
      if (was !== h) {
        holes[i] = h;
        this.holesCount += was === 0 ? 1 : h === 0 ? -1 : 0;
      }
    }
    let part2 = this.part2;
    if (part2 === null && p2 !== 0) part2 = this.part2 = new Uint32Array(CHUNK_VOLUME);
    if (part2 !== null) {
      const was = part2[i]!;
      if (was !== p2) {
        part2[i] = p2;
        this.part2Count += was === 0 ? 1 : p2 === 0 ? -1 : 0;
      }
    }
  }
}

function countNonZero(a: Uint8Array | Uint32Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== 0) n++;
  return n;
}

export { WORLD_HEIGHT };
