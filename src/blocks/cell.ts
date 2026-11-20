/**
 * Cell values (docs/SHAPES.md section 1). A cell is split into 2x2x2 octants; a PART is one
 * material (block id + state) plus the octants it fills; a cell holds at most two parts.
 *
 * Three numeric forms:
 *  - PART value (< 2^24): bits 0-9 block id, 10-15 block state, 16-23 HOLES (the octants the
 *    part does NOT fill; octant o = ox | oy << 1 | oz << 2). A full block has holes 0, so its
 *    part value is the plain 16-bit value of M1: makeCell(id, state) is unchanged.
 *  - CELL value (< 2^25): the first part's value plus CELL_MULTI_BIT (bit 24) when the cell
 *    also has a second part. This is what VoxelGrid.getCell returns (the hot path).
 *  - PACKED cell (< 2^49, exact in a double): cell value + second part * PACK_SCALE. Every
 *    place that treats "one cell as one number" (setCell, change events, protocol, ...) uses it.
 *
 * Bitwise reads of a packed cell see the first part (`packed & ID_MASK`, `(packed >>> 16) &
 * 0xff`, `packed & CELL_MULTI_BIT`), because bitwise operators take the low 32 bits.
 * A value with bit 24 set and no second part (in [2^24, 2^25)) is the TRIPWIRE: setCell, the
 * codec and the shape and contact predicates throw RangeError on it, so code that copies
 * `getCell` instead of the whole packed cell fails on the first two-part cell instead of losing
 * data. (Predicates that read only the block id do not look at the bit.)
 *
 * Block state: one block id per block TYPE; orientation, liquid level etc. live in the state
 * bits (docs/DESIGN.md: "方块 = id + 状态位。不要为每个朝向单独开一个 id").
 */
import type { Axis, Dir } from '../core/dirs';

export const ID_BITS = 10;
export const ID_MASK = 0x3ff;
export const STATE_SHIFT = 10;
export const STATE_MASK = 0x3f;
export const MAX_BLOCK_ID = ID_MASK;
/** Bit position of a part's holes byte. */
export const HOLES_SHIFT = 16;
export const HOLES_MASK = 0xff;
/** Cell bit 24: this cell also has a second part (net/protocol.ts re-exports it). */
export const CELL_MULTI_BIT = 1 << 24;
/** The part bits of a cell value (id, state, holes): `cell & PART_MASK` drops CELL_MULTI_BIT. */
export const PART_MASK = 0xffffff;
/** Every part value is below this. */
export const PART_LIMIT = 1 << 24;
/** Every cell value (what getCell returns) is below this. */
export const CELL_LIMIT = 1 << 25;
/** packed = cell + part2 * PACK_SCALE. */
export const PACK_SCALE = 2 ** 25;
/** A value below this has no holes and no second part: a full block (or air) exactly as in M1. */
export const FULL_LIMIT = 1 << 16;

/** The empty cell. */
export const AIR = 0;

/**
 * The three layers of a dense volume of cells, shared by chunks, structures, the mesher's input,
 * the protocol and saves (docs/SHAPES.md section 4.1).
 */
export interface CellLayers {
  /** id + state, 16 bits. The index order is the holder's (chunk: lx | lz << 4 | y << 8; box: (x-minX) + (z-minZ)*sx + (y-minY)*sx*sz). */
  base: Uint16Array;
  /** Holes of the first part. null = all 0. */
  holes: Uint8Array | null;
  /** Part value of the second part. null = no two-part cell. part2[i] !== 0 implies holes[i] !== 0. */
  part2: Uint32Array | null;
}

export function cellId(cell: number): number {
  return cell & ID_MASK;
}
export function cellState(cell: number): number {
  return (cell >>> STATE_SHIFT) & STATE_MASK;
}
/** A full block (no holes): the M1 16-bit value. */
export function makeCell(id: number, state = 0): number {
  return (id & ID_MASK) | ((state & STATE_MASK) << STATE_SHIFT);
}
/** A part value with holes (the octants it does not fill). Fields are masked to their widths. */
export function makePart(id: number, state: number, holes: number): number {
  return (id & ID_MASK) | ((state & STATE_MASK) << STATE_SHIFT) | ((holes & HOLES_MASK) << HOLES_SHIFT);
}
/** The holes of a part (or of the first part of a cell or packed cell). */
export function partHoles(part: number): number {
  return (part >>> HOLES_SHIFT) & HOLES_MASK;
}
/** Replace only the state bits; holes and CELL_MULTI_BIT are kept. Takes a part or cell value. */
export function withState(part: number, state: number): number {
  return (part & ~(STATE_MASK << STATE_SHIFT)) | ((state & STATE_MASK) << STATE_SHIFT);
}
/** Replace only the holes; id, state and CELL_MULTI_BIT are kept. Takes a part or cell value. */
export function withHoles(part: number, holes: number): number {
  return (part & ~(HOLES_MASK << HOLES_SHIFT)) | ((holes & HOLES_MASK) << HOLES_SHIFT);
}
/**
 * The packed cell of a cell value and its second part (0 = none). Throws RangeError when they
 * disagree (CELL_MULTI_BIT set without a second part, or a second part without the bit) or
 * either is out of range.
 */
export function packCell(cell: number, part2: number): number {
  if (!Number.isInteger(cell) || cell < 0 || cell >= CELL_LIMIT) throw new RangeError(`cell value out of range: ${cell}`);
  if (!Number.isInteger(part2) || part2 < 0 || part2 >= PART_LIMIT) throw new RangeError(`second part out of range: ${part2}`);
  if ((cell >= CELL_MULTI_BIT) !== (part2 !== 0)) {
    throw new RangeError(part2 === 0 ? `cell ${cell} has CELL_MULTI_BIT but no second part` : `second part ${part2} without CELL_MULTI_BIT in cell ${cell}`);
  }
  return cell + part2 * PACK_SCALE;
}
/** The cell value of a packed cell, with CELL_MULTI_BIT (equals what getCell returns). */
export function cellPrimary(packed: number): number {
  return packed % PACK_SCALE;
}
/** The second part of a packed cell; 0 when there is none. */
export function cellSecond(packed: number): number {
  return Math.floor(packed / PACK_SCALE);
}

// ------------------------------------------------------------ state layouts
// Which layout a block uses is given by BlockDef.stateKind.

/** stateKind 'axis' (logs): state & 3 = axis the log runs along (0 x, 1 y, 2 z). */
export function stateAxis(state: number): Axis {
  const a = state & 3;
  return (a > 2 ? 1 : a) as Axis;
}
export function axisState(axis: Axis): number {
  return axis;
}

/**
 * stateKind 'facing' (bearing, propeller, helm): state & 7 = Dir the block's FRONT faces.
 *  - bearing: front = the face the rotor attaches to; back (opposite) = mounting face.
 *  - propeller: front = thrust face pointing away from the hull; back = mounting face.
 *  - helm: front = horizontal direction the helmsman LOOKS when steering (the ship's bow);
 *    always one of the 4 horizontal dirs. Mounting face is below.
 */
export function stateFacing(state: number): Dir {
  const d = state & 7;
  return (d > 5 ? 0 : d) as Dir;
}
export function facingState(dir: Dir): number {
  return dir;
}

/**
 * stateKind 'liquid': state & 7 = level, state & 8 = falling.
 * level 0 = source. level 1..7 = flowing, larger level = less liquid (amount = 8 - level).
 * falling = fed from above (renders/acts as a full column).
 */
export const LIQUID_FALLING = 8;
export function liquidLevel(state: number): number {
  return state & 7;
}
export function liquidFalling(state: number): boolean {
  return (state & LIQUID_FALLING) !== 0;
}
/** Amount of liquid 1..8 (8 = source or falling column). */
export function liquidAmount(state: number): number {
  return (state & LIQUID_FALLING) !== 0 ? 8 : 8 - (state & 7);
}
export function liquidState(level: number, falling: boolean): number {
  return (level & 7) | (falling ? LIQUID_FALLING : 0);
}
export function isLiquidSource(state: number): boolean {
  return (state & 15) === 0;
}

/** stateKind 'layers' (snow): state & 7 = layer count - 1 (1..8 layers, each 1/8 block). */
export function stateLayers(state: number): number {
  return (state & 7) + 1;
}
export function layersState(layers: number): number {
  return (layers - 1) & 7;
}
