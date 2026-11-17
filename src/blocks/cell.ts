/**
 * A cell is a 16-bit value: block id in the low 10 bits, block state in the high 6 bits.
 * One block id per block TYPE; orientation, liquid level etc. live in the state bits
 * (docs/DESIGN.md: "方块 = id + 状态位。不要为每个朝向单独开一个 id").
 */
import type { Axis, Dir } from '../core/dirs';

export const ID_BITS = 10;
export const ID_MASK = 0x3ff;
export const STATE_SHIFT = 10;
export const STATE_MASK = 0x3f;
export const MAX_BLOCK_ID = ID_MASK;

/** The empty cell. */
export const AIR = 0;

export function cellId(cell: number): number {
  return cell & ID_MASK;
}
export function cellState(cell: number): number {
  return (cell >>> STATE_SHIFT) & STATE_MASK;
}
export function makeCell(id: number, state = 0): number {
  return (id & ID_MASK) | ((state & STATE_MASK) << STATE_SHIFT);
}
export function withState(cell: number, state: number): number {
  return (cell & ID_MASK) | ((state & STATE_MASK) << STATE_SHIFT);
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
