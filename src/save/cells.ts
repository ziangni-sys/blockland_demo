/**
 * The one implementation of the `Cell` and `CellVolume` byte layouts (docs/SHAPES.md 13.1,
 * docs/NETCODE.md section 14), shared by the protocol (net/codec.ts re-exports these functions)
 * and the save format (save/codec.ts chunks; structures/serialize.ts uses Cell only).
 *
 * Cell: `vu v`, and when `v & CELL_MULTI_BIT` a second `vu`, the second part. The value in memory
 * is the PACKED cell (blocks/cell.ts): v + second * 2^25. Both ends check the LAYOUT and never
 * truncate: v < 2^25; v's holes are not 0xff; a second part is in [1, 2^24), its holes are not
 * 0xff and its id is not 0. The encoder throws RangeError, the decoder fails through ByteReader
 * (SaveFormatError; net/codec.ts turns it into a ProtocolError). The SEMANTICS (registered ids,
 * holes only on cuttable blocks, disjoint parts, canonical order) are cellProblem's job where
 * cells enter storage.
 *
 * CellVolume(n): `u8 enc`; 0 = palette + runs: `vu P` (1..n, at most PALETTE_LIMIT), P x Cell
 * (first-appearance order), then `vu token` until n cells are covered, token = (len - 1) * 2^B +
 * index, B = bit length of P - 1 (multiplication, not bit operations: structure boxes can be
 * large); 1 = raw: n x Cell. In memory a volume is CellLayers; the palette key is the packed cell.
 *
 * Pure: no module-level state, no scratch shared between calls (LESSONS "临时向量被改写").
 */
import {
  CELL_LIMIT,
  CELL_MULTI_BIT,
  HOLES_MASK,
  HOLES_SHIFT,
  ID_MASK,
  PACK_SCALE,
  PART_LIMIT,
  type CellLayers,
} from '../blocks/cell';
import type { ByteReader, ByteWriter } from './bytes';

/** A CellVolume with more distinct values than this is written raw. */
export const PALETTE_LIMIT = 4096;

/**
 * What one message (or one save chunk) may still decode, in the units of volumeCost: a cell of
 * the base layer costs 1, the holes layer 1/2 per cell and the second-part layer 2 per cell.
 */
export interface CellBudget {
  cells: number;
}

const VOLUME_PALETTE = 0;
const VOLUME_RAW = 1;

/** Bytes of a varuint below 2^28 (every cell value and part is below 2^25). */
function varuintSize(v: number): number {
  return v < 0x80 ? 1 : v < 0x4000 ? 2 : v < 0x200000 ? 3 : v < 0x10000000 ? 4 : 5;
}

/** Bytes of a varuint of any safe integer (run tokens of large boxes can exceed 2^32). */
function tokenSize(v: number): number {
  if (v < 0x10000000) return varuintSize(v);
  let n = 1;
  while (v >= 128) {
    v = Math.floor(v / 128);
    n++;
  }
  return n;
}

/** Number of bits needed for the values 0..n (0 for n = 0). */
function bitLength(n: number): number {
  return n === 0 ? 0 : 32 - Math.clz32(n);
}

/** Bytes this Cell takes when written (1..8). Does not check the layout (writeCell does). */
export function cellSize(packed: number): number {
  if (packed < PACK_SCALE) return varuintSize(packed);
  return varuintSize(packed % PACK_SCALE) + varuintSize(Math.floor(packed / PACK_SCALE));
}

/**
 * Why a packed cell cannot be written as a Cell (writeCell would throw), or null when its layout
 * is valid. Layout only: a valid layout can still break I3-I6 or name an unknown id (cellProblem).
 */
export function layoutProblem(packed: number): string | null {
  if (!Number.isInteger(packed) || packed < 0 || packed >= PACK_SCALE * PART_LIMIT) return `cell ${packed} out of range`;
  const v = packed % PACK_SCALE;
  const p2 = Math.floor(packed / PACK_SCALE);
  if (((v >>> HOLES_SHIFT) & HOLES_MASK) === HOLES_MASK) return `cell ${packed}: a part without octants`;
  if (v >= CELL_MULTI_BIT) {
    // A missing second part (0, the tripwire: CELL_MULTI_BIT copied without its part) has id 0 too.
    if ((p2 & ID_MASK) === 0) return p2 === 0 ? `cell ${packed} has CELL_MULTI_BIT but no second part` : `cell ${packed}: a second part with id 0`;
    if (((p2 >>> HOLES_SHIFT) & HOLES_MASK) === HOLES_MASK) return `cell ${packed}: a second part without octants`;
  } else if (p2 !== 0) {
    return `cell ${packed} has a second part but no CELL_MULTI_BIT`;
  }
  return null;
}

/** Write a packed cell as a Cell. RangeError when its layout is invalid. */
export function writeCell(w: ByteWriter, packed: number): void {
  const problem = layoutProblem(packed);
  if (problem !== null) throw new RangeError(problem);
  if (packed < PACK_SCALE) {
    w.varuint(packed);
  } else {
    w.varuint(packed % PACK_SCALE);
    w.varuint(Math.floor(packed / PACK_SCALE));
  }
}

/** Read a Cell; returns the packed cell. Fails (SaveFormatError) on an invalid layout. */
export function readCell(r: ByteReader): number {
  const v = r.varuint();
  if (v >= CELL_LIMIT) r.fail(`cell value ${v} is not below 2^25`);
  if (((v >>> HOLES_SHIFT) & HOLES_MASK) === HOLES_MASK) r.fail(`cell value ${v} has a part without octants`);
  if (v < CELL_MULTI_BIT) return v;
  const p2 = r.varuint();
  if (p2 >= PART_LIMIT) r.fail(`second part ${p2} is not below 2^24`);
  // 0 (no second part after CELL_MULTI_BIT) has id 0 too.
  if ((p2 & ID_MASK) === 0) r.fail(p2 === 0 ? `second part 0 after CELL_MULTI_BIT` : `second part ${p2} has id 0`);
  if (((p2 >>> HOLES_SHIFT) & HOLES_MASK) === HOLES_MASK) r.fail(`second part ${p2} has no octants`);
  return v + p2 * PACK_SCALE;
}

/**
 * What decoding a volume of n cells may allocate, in CellBudget units: n for the base layer,
 * ceil(n / 2) for a holes layer, 2n for a second-part layer (proportional to their bytes). The
 * encoders (the replicator's packing, writeStructureRecord) charge the same, so both ends agree.
 */
export function volumeCost(n: number, hasHoles: boolean, hasPart2: boolean): number {
  return n + (hasHoles ? Math.ceil(n / 2) : 0) + (hasPart2 ? 2 * n : 0);
}

/**
 * Write a CellVolume of v.base.length cells (>= 1). The output is determined by the content:
 *  1. runs are cut where the packed cell changes; each run adds its raw size (length x cellSize)
 *     to rawBytes and is recorded as (palette index, length); a value enters the palette on its
 *     first appearance;
 *  2. once the palette would exceed PALETTE_LIMIT, runs are no longer recorded and the palette is
 *     left alone: only rawBytes keeps counting, and the volume is written raw;
 *  3. the palette form is used when its exact size is strictly below rawBytes, else raw.
 * The output is that of those rules, the work is arranged for speed (save of a terrain chunk):
 * pass 1 walks the cells and only records where each run starts (for full blocks, both extra
 * layers null, one load and one compare per cell); pass 2 walks the runs, reads each run's value
 * from its first cell and builds the palette. rawBytes is only summed when the choice needs it:
 * a Cell takes at least one byte, so rawBytes is at least n, a palette form below n wins without
 * it, and a dropped palette means raw anyway.
 * RangeError when a layer's length differs from base's or a cell's layout is invalid.
 */
export function writeCellVolume(w: ByteWriter, v: CellLayers): void {
  const base = v.base;
  const holes = v.holes;
  const part2 = v.part2;
  const n = base.length;
  if (n < 1) throw new RangeError(`CellVolume length out of range: ${n}`);
  if ((holes !== null && holes.length !== n) || (part2 !== null && part2.length !== n)) {
    throw new RangeError(`CellVolume layers do not match its ${n} cells`);
  }

  // Pass 1, per cell. Rule 1: a run ends where the packed cell changes. Only where each run
  // starts is recorded (run k covers [runStart[k], runStart[k + 1]), the last one ends at n).
  const flat = holes === null && part2 === null;
  const runStart: number[] = [0];
  if (flat) {
    let prev = base[0]!;
    for (let i = 1; i < n; i++) {
      const c = base[i]!;
      if (c === prev) continue;
      runStart.push(i);
      prev = c;
    }
  } else {
    let prev = packedAt(base, holes, part2, 0);
    for (let i = 1; i < n; i++) {
      const c = packedAt(base, holes, part2, i);
      if (c === prev) continue;
      runStart.push(i);
      prev = c;
    }
  }
  const runs = runStart.length;
  runStart.push(n);

  // Pass 2, per run: the palette index, until the palette is dropped.
  const paletteIndex = new Map<number, number>();
  const palette: number[] = [];
  const runIndex: number[] = [];
  let usePalette = true;
  for (let k = 0; k < runs; k++) {
    const at = runStart[k]!;
    const c = flat ? base[at]! : packedAt(base, holes, part2, at);
    let index = paletteIndex.get(c);
    if (index === undefined) {
      index = palette.length;
      // Rule 2: past PALETTE_LIMIT distinct values the palette is dropped and the volume goes raw.
      if (index >= PALETTE_LIMIT) {
        usePalette = false;
        break;
      }
      paletteIndex.set(c, index);
      palette.push(c);
    }
    runIndex.push(index);
  }

  // Rule 3: the palette form only when it is strictly smaller than the raw form. The palette has
  // at most 4096 entries, so the index takes at most 12 bits and the scale is a small integer;
  // the token is a product (not a shift) because a run of a large box can be longer than 2^19.
  let paletteBytes = Infinity;
  const scale = 1 << bitLength(palette.length - 1);
  if (usePalette) {
    paletteBytes = varuintSize(palette.length);
    for (let k = 0; k < palette.length; k++) paletteBytes += cellSize(palette[k]!);
    for (let k = 0; k < runs; k++) {
      const token = (runStart[k + 1]! - runStart[k]! - 1) * scale + runIndex[k]!;
      runIndex[k] = token; // the index is no longer needed, only the token
      paletteBytes += tokenSize(token);
    }
  }
  let palettePays = paletteBytes < n;
  if (usePalette && !palettePays) {
    let rawBytes = 0;
    for (let k = 0; k < runs; k++) {
      const at = runStart[k]!;
      rawBytes += (runStart[k + 1]! - at) * cellSize(flat ? base[at]! : packedAt(base, holes, part2, at));
    }
    palettePays = paletteBytes < rawBytes;
  }
  if (palettePays) {
    w.u8(VOLUME_PALETTE).varuint(palette.length);
    for (let k = 0; k < palette.length; k++) writeCell(w, palette[k]!);
    for (let k = 0; k < runs; k++) w.varuint(runIndex[k]!);
  } else {
    w.u8(VOLUME_RAW);
    if (flat) for (let i = 0; i < n; i++) writeCell(w, base[i]!);
    else for (let i = 0; i < n; i++) writeCell(w, packedAt(base, holes, part2, i));
  }
}

/** Packed cell i of a layered volume. */
function packedAt(base: Uint16Array, holes: Uint8Array | null, part2: Uint32Array | null, i: number): number {
  const q = part2 !== null ? part2[i]! : 0;
  return (base[i]! | (holes !== null ? holes[i]! << HOLES_SHIFT : 0) | (q !== 0 ? CELL_MULTI_BIT : 0)) + q * PACK_SCALE;
}

/**
 * Inverse of writeCellVolume for a volume of n cells. Charges n to the budget first and each
 * extra layer's share (volumeCost) just before allocating it, which happens only when a run or
 * raw cell needs it: a volume of full blocks decodes with both extra layers null. Fails
 * (SaveFormatError) on malformed input or an exhausted budget, before allocating.
 *
 * `check`, when given, is the semantic test of the caller (the save passes cellProblem, which
 * this module cannot import: it depends on blocks/cell.ts and save/bytes.ts only). It sees every
 * value the volume can store, each once where the encoding makes that cheap: each palette entry as
 * it is read, and each raw cell that differs from the raw cell before it. A non-null answer fails
 * the read with that reason (SaveFormatError), before the cells are filled.
 */
export function readCellVolume(r: ByteReader, n: number, budget: CellBudget, check?: (packed: number) => string | null): CellLayers {
  if (!(Number.isInteger(n) && n >= 1 && n <= budget.cells)) {
    r.fail(`cell volume of ${n} cells exceeds what one message may carry (${budget.cells} left)`);
  }
  budget.cells -= n;
  const enc = r.u8();
  if (enc !== VOLUME_PALETTE && enc !== VOLUME_RAW) return r.fail(`unknown cell volume encoding ${enc}`);
  let palette: number[] | null = null;
  if (enc === VOLUME_PALETTE) {
    const p = r.count(1);
    if (p < 1 || p > n || p > PALETTE_LIMIT) r.fail(`invalid palette size ${p}`);
    palette = [];
    for (let k = 0; k < p; k++) {
      const c = readCell(r);
      const problem = check !== undefined ? check(c) : null;
      if (problem !== null) r.fail(`palette entry ${k}: ${problem}`);
      palette.push(c);
    }
  } else if (n > r.remaining) {
    r.fail(`raw cell volume of ${n} cells exceeds the ${r.remaining} remaining bytes`);
  }
  const base = new Uint16Array(n);
  let holes: Uint8Array | null = null;
  let part2: Uint32Array | null = null;
  const holesShare = volumeCost(n, true, false) - n;
  const part2Share = volumeCost(n, false, true) - n;

  /** Fill [from, from + len) with the packed cell c, allocating a layer the first time it is needed. */
  const fill = (c: number, from: number, len: number): void => {
    const v = c < PACK_SCALE ? c : c % PACK_SCALE;
    const b = v & 0xffff;
    if (b !== 0) base.fill(b, from, from + len);
    if (v < 0x10000) return;
    const h = (v >>> HOLES_SHIFT) & HOLES_MASK;
    if (h !== 0) {
      if (holes === null) {
        if (holesShare > budget.cells) r.fail(`the holes of a ${n}-cell volume exceed what one message may carry (${budget.cells} left)`);
        budget.cells -= holesShare;
        holes = new Uint8Array(n);
      }
      holes.fill(h, from, from + len);
    }
    if (v >= CELL_MULTI_BIT) {
      if (part2 === null) {
        if (part2Share > budget.cells) r.fail(`the second parts of a ${n}-cell volume exceed what one message may carry (${budget.cells} left)`);
        budget.cells -= part2Share;
        part2 = new Uint32Array(n);
      }
      part2.fill(Math.floor(c / PACK_SCALE), from, from + len);
    }
  };

  if (palette !== null) {
    const p = palette.length;
    const scale = 2 ** bitLength(p - 1);
    let filled = 0;
    while (filled < n) {
      const token = r.varuint();
      const index = token % scale;
      const len = Math.floor(token / scale) + 1;
      if (index >= p) r.fail(`palette index ${index} out of range (palette has ${p})`);
      if (len > n - filled) r.fail(`run of ${len} cells overflows the volume (${filled} of ${n} filled)`);
      fill(palette[index]!, filled, len);
      filled += len;
    }
  } else {
    let prev = -1;
    for (let i = 0; i < n; i++) {
      const c = readCell(r);
      if (c !== prev && check !== undefined) {
        const problem = check(c);
        if (problem !== null) r.fail(`cell ${i}: ${problem}`);
        prev = c;
      }
      if (c !== 0) fill(c, i, 1);
    }
  }
  return { base, holes, part2 };
}
