/**
 * Immutable lookup tables for the mesher: per-block-id render classification and the
 * face-frame constants every shape emitter shares.
 *
 * The per-id tables are derived ONCE, at module load, from the block registry. The
 * side-effect import of blocks/defs guarantees the registry is populated before that —
 * also inside a Worker, where nothing else would have loaded the block table. Blocks are
 * only ever registered by defs.ts at import time, so the tables never go stale.
 */
import '../../blocks/defs';
import { MAX_BLOCK_ID } from '../../blocks/cell';
import { NY, PY } from '../../core/dirs';
import { BLOCKS, type RenderLayer } from '../../blocks/registry';
import { VFLAG_EMISSIVE, VFLAG_PLANT } from '../types';

// ------------------------------------------------------------------ shape codes

export const SH_NONE = 0;
/** Full cube, one tile per face. */
export const SH_CUBE = 1;
/** Full cube with stateKind 'axis' (logs): [side, end]. */
export const SH_AXIS = 2;
/** Full cube with a facing: [front, back, side]. */
export const SH_BEARING = 3;
export const SH_CROSS = 4;
export const SH_TORCH = 5;
export const SH_LAYERS = 6;
export const SH_CACTUS = 7;
export const SH_HELM = 8;
export const SH_PROPELLER = 9;
export const SH_LIQUID = 10;

// ------------------------------------------------------------------ draw groups

export const G_OPAQUE = 0;
export const G_CUTOUT = 1;
export const G_TRANSLUCENT = 2;

// ------------------------------------------------------------------ INFO bits
// One byte per block id, read for every neighbour test in the hot loop.

/** Bits 0..5: the block fully and opaquely covers its own face in Dir d (bit d). */
export const COVER_ALL = 0x3f;
/** Casts ambient occlusion and is skipped by smooth lighting (OPAQUE cubes only). */
export const INFO_OCCLUDER = 0x40;
/**
 * Non-opaque full cube whose face against another cell of the SAME id is skipped
 * (glass, ice, leaves): the shared face would be invisible or just noise.
 */
export const INFO_SELF_CULL = 0x80;

const ID_COUNT = MAX_BLOCK_ID + 1;

/** Shape code per block id (SH_*). Unregistered ids are SH_NONE: they draw nothing. */
export const SHAPE: Uint8Array = new Uint8Array(ID_COUNT);
/** Draw group per block id (G_*), from BlockDef.layer. */
export const GROUP: Uint8Array = new Uint8Array(ID_COUNT);
/** Neighbour classification bits per block id (COVER bits | INFO_OCCLUDER | INFO_SELF_CULL). */
export const INFO: Uint8Array = new Uint8Array(ID_COUNT);
/** Vertex flags every face of the block carries (emissive for light emitters, plant for crosses). */
export const BASE_FLAGS: Uint8Array = new Uint8Array(ID_COUNT);
/**
 * Bit d: when a liquid lies across this block's face d (and does not cover it, which no
 * liquid does), the block itself draws geometry filling that whole face, facing the liquid.
 * The liquid then needs no inside copy of its own face on that plane — the block's face is
 * what a swimmer sees there — and emitting one anyway would put two coplanar faces on the
 * same plane, facing the same way, which z-fight. Full cubes seal all six faces; a cactus
 * its top and bottom; a snow-like slab its bottom (a FULL stack seals every face, which is
 * state-dependent and checked by the liquid emitter). Another liquid counts as sealing
 * every face: its facing geometry lies on the shared plane too, and lava-water contact is
 * transient anyway (the liquid simulation hardens the lava).
 */
export const SEALS_LIQUID: Uint8Array = new Uint8Array(ID_COUNT);
/** Tile per face for SH_CUBE blocks, index id * 6 + dir. */
export const FACE_TILE: Uint16Array = new Uint16Array(ID_COUNT * 6);
/**
 * Up to three tile slots per block (meaning per shape: see the table at the top of
 * blocks/defs.ts), index id * 3 + slot. Missing slots repeat slot 0 so a short `tiles`
 * array can never produce an out-of-range read.
 */
export const TILE_SLOT: Uint16Array = new Uint16Array(ID_COUNT * 3);

function groupOf(layer: RenderLayer): number {
  return layer === 'translucent' ? G_TRANSLUCENT : layer === 'cutout' ? G_CUTOUT : G_OPAQUE;
}

function shapeOf(shape: string, stateKind: string): number {
  switch (shape) {
    case 'cube':
      return stateKind === 'axis' ? SH_AXIS : SH_CUBE;
    case 'bearing':
      return SH_BEARING;
    case 'cross':
      return SH_CROSS;
    case 'torch':
      return SH_TORCH;
    case 'layers':
      return SH_LAYERS;
    case 'cactus':
      return SH_CACTUS;
    case 'helm':
      return SH_HELM;
    case 'propeller':
      return SH_PROPELLER;
    case 'liquid':
      return SH_LIQUID;
    default:
      return SH_NONE;
  }
}

function fillTables(): void {
  for (let id = 0; id < ID_COUNT; id++) {
    const def = BLOCKS[id];
    if (!def) continue;
    const tiles = def.tileIds;
    // A block without tiles has nothing to draw with; treating it as 'none' keeps every
    // tile read in range without a check in the hot loop.
    const shape = tiles.length === 0 ? SH_NONE : shapeOf(def.shape, def.stateKind);
    SHAPE[id] = shape;
    GROUP[id] = groupOf(def.layer);

    let info = 0;
    if (def.opaque) {
      info = COVER_ALL | INFO_OCCLUDER;
    } else {
      // A snow-like slab rendered in the opaque pass hides the face below it completely.
      if (shape === SH_LAYERS && def.layer === 'opaque') info |= 1 << NY;
      if (shape === SH_CUBE || shape === SH_AXIS || shape === SH_BEARING) info |= INFO_SELF_CULL;
    }
    INFO[id] = info;

    SEALS_LIQUID[id] =
      shape === SH_CUBE || shape === SH_AXIS || shape === SH_BEARING || shape === SH_LIQUID
        ? COVER_ALL
        : shape === SH_CACTUS
          ? (1 << PY) | (1 << NY)
          : shape === SH_LAYERS
            ? 1 << NY
            : 0;

    BASE_FLAGS[id] = (def.emit > 0 ? VFLAG_EMISSIVE : 0) | (shape === SH_CROSS ? VFLAG_PLANT : 0);

    const n = tiles.length;
    for (let d = 0; d < 6; d++) FACE_TILE[id * 6 + d] = n === 0 ? 0 : tiles[Math.min(d, n - 1)]!;
    for (let s = 0; s < 3; s++) TILE_SLOT[id * 3 + s] = n === 0 ? 0 : tiles[s < n ? s : 0]!;
  }
}
fillTables();

// ------------------------------------------------------------------ face frames
//
// Every face d has a frame (R, U, N): R is the direction in which u grows, U the direction
// in which v grows, N = R x U the outward normal. Seen from outside, R points right and U
// points up, so the corner order (u,v) = (0,0) (1,0) (1,1) (0,1) is counter-clockwise.
//
//   d   face   R    U    origin of (u,v)=(0,0) in the cell
//   0   +X     -Z   +Y   (1,0,1)
//   1   -X     +Z   +Y   (0,0,0)
//   2   +Y     +X   -Z   (0,1,1)
//   3   -Y     +X   +Z   (0,0,0)
//   4   +Z     +X   +Y   (0,0,1)
//   5   -Z     -X   +Y   (1,0,0)

/** Axis (0 x, 1 y, 2 z) of R per face. */
export const FACE_R_AXIS: readonly number[] = [2, 2, 0, 0, 0, 0];
/** Sign of R per face. */
export const FACE_R_SIGN: readonly number[] = [-1, 1, 1, 1, 1, -1];
/** Axis of U per face. */
export const FACE_U_AXIS: readonly number[] = [1, 1, 2, 2, 1, 1];
/** Sign of U per face. */
export const FACE_U_SIGN: readonly number[] = [1, 1, -1, 1, 1, 1];

/** (u, v) of quad corner k. */
export const CORNER_U: readonly number[] = [0, 1, 1, 0];
export const CORNER_V: readonly number[] = [0, 0, 1, 1];

/**
 * For face d and corner k (index d * 4 + k): bit a set = the corner sits on the HIGH side
 * of the box along axis a (bit 0 x, bit 1 y, bit 2 z). Lets a box face pick its corner
 * coordinates from (lo, hi) without branching on the frame.
 */
export const FACE_CORNER_HI: Uint8Array = (() => {
  const t = new Uint8Array(24);
  for (let d = 0; d < 6; d++) {
    const na = d >> 1;
    const ra = FACE_R_AXIS[d]!;
    const ua = FACE_U_AXIS[d]!;
    for (let k = 0; k < 4; k++) {
      let bits = 0;
      if ((d & 1) === 0) bits |= 1 << na;
      if (FACE_R_SIGN[d]! > 0 === (CORNER_U[k] === 1)) bits |= 1 << ra;
      if (FACE_U_SIGN[d]! > 0 === (CORNER_V[k] === 1)) bits |= 1 << ua;
      t[d * 4 + k] = bits;
    }
  }
  return t;
})();

/** Unit normal per face, as signed bytes. */
export const FACE_NX: readonly number[] = [127, -127, 0, 0, 0, 0];
export const FACE_NY: readonly number[] = [0, 0, 127, -127, 0, 0];
export const FACE_NZ: readonly number[] = [0, 0, 0, 0, 127, -127];

// ------------------------------------------------------------------ texture rotation

/**
 * Quarter turns r that make a face's texture "up" (its v direction) point along a given
 * vector: r = 0 -> U, 1 -> R, 2 -> -U, 3 -> -R (see rotateUv in builder.ts). For a cell
 * axis/direction lying in the face plane exactly one r matches.
 */
function rotTowards(d: number, axis: number, sign: number): number {
  if (FACE_U_AXIS[d] === axis) return FACE_U_SIGN[d] === sign ? 0 : 2;
  if (FACE_R_AXIS[d] === axis) return FACE_R_SIGN[d] === sign ? 1 : 3;
  return 0; // direction is the face normal: no meaningful rotation
}

/**
 * Logs (index axis * 6 + d): side faces rotated so the bark grain (the tile's v direction)
 * runs along the log axis. Faces perpendicular to the axis (the end tiles) are unrotated.
 */
export const LOG_ROT: Uint8Array = (() => {
  const t = new Uint8Array(18);
  for (let axis = 0; axis < 3; axis++) {
    for (let d = 0; d < 6; d++) t[axis * 6 + d] = d >> 1 === axis ? 0 : rotTowards(d, axis, 1);
  }
  return t;
})();

/**
 * Facing cubes (index facing * 6 + d): the four side faces are rotated so the tile's top
 * points toward the front face. Front and back faces are unrotated.
 */
export const FACING_ROT: Uint8Array = (() => {
  const t = new Uint8Array(36);
  for (let f = 0; f < 6; f++) {
    const axis = f >> 1;
    const sign = (f & 1) === 0 ? 1 : -1;
    for (let d = 0; d < 6; d++) t[f * 6 + d] = d >> 1 === axis ? 0 : rotTowards(d, axis, sign);
  }
  return t;
})();

// ------------------------------------------------------------------ light / AO encoding

/**
 * AO byte per occlusion level (0 = both sides blocked .. 3 = open): linear, level * 85, so
 * ao / 255 is the vertex's openness 0..1. The mesher deliberately applies NO brightness
 * curve: the renderer owns the look and maps openness to brightness itself
 * (render/three/lighting.ts aoFactor). Pre-curving here as well would apply the curve twice.
 */
export const AO_BYTE: readonly number[] = [0, 85, 170, 255];

/**
 * Rounded average of `count` light levels scaled to a byte: AVG_LIGHT[count * 61 + sum]
 * = round(sum * 17 / count), count 1..4, sum 0..60.
 */
export const AVG_LIGHT: Uint8Array = (() => {
  const t = new Uint8Array(5 * 61);
  for (let c = 1; c <= 4; c++) {
    for (let s = 0; s <= 60; s++) t[c * 61 + s] = Math.min(255, Math.round((s * 17) / c));
  }
  return t;
})();
