/**
 * Full cubes: plain (one tile per face), logs (stateKind 'axis') and facing cubes
 * (bearing). This is the hot path: most faces of a terrain section come through here.
 *
 * Cut cube materials (parts with holes, second parts; docs/SHAPES.md 8.2) are emitted here too,
 * one quarter face per octant face, and so is any face of a whole cube that has a partial cell in
 * front of it. A face whose own cell and whose nine cells in front are all without parts goes
 * through exactly M1's code (emitCube, or the M1 branch of emitCubeMixed).
 */
import * as cellBits from '../../blocks/cell';
import * as blockShapes from '../../blocks/shapes';
import type { MeshContext } from './builder';
import * as tables from './tables';

// Hot-path imports are bound to module-local constants once, at module init. Module
// runners that implement ES live bindings as getter calls (the Vite/Vitest SSR transform)
// would otherwise pay a call per table read inside the meshing loops; bundles are unaffected.
const { ID_MASK, HOLES_SHIFT, STATE_MASK, STATE_SHIFT, stateAxis, stateFacing } = cellBits;
const { HALF_FILL } = blockShapes;
const {
  BASE_FLAGS,
  FACE_R_AXIS,
  FACE_TILE,
  FACE_U_AXIS,
  FACING_ROT,
  GROUP,
  INFO,
  INFO_SELF_CULL,
  LOG_ROT,
  SHAPE,
  SH_AXIS,
  SH_BEARING,
  SH_CUBE,
  TILE_SLOT,
} = tables;

/** Tile of face d of a cube-family block (shape SH_CUBE / SH_AXIS / SH_BEARING) in state `state`. */
function cubeTile(id: number, shape: number, state: number, d: number): number {
  if (shape === SH_AXIS) return TILE_SLOT[id * 3 + (d >> 1 === stateAxis(state) ? 1 : 0)]!;
  if (shape === SH_BEARING) {
    const f = stateFacing(state);
    return TILE_SLOT[id * 3 + (d === f ? 0 : d === (f ^ 1) ? 1 : 2)]!;
  }
  return FACE_TILE[id * 6 + d]!;
}

/** Quarter turns of the tile on face d (logs turn the bark grain along the axis, bearings point the top at the front). */
function cubeRot(shape: number, state: number, d: number): number {
  if (shape === SH_AXIS) return LOG_ROT[stateAxis(state) * 6 + d]!;
  if (shape === SH_BEARING) return FACING_ROT[stateFacing(state) * 6 + d]!;
  return 0;
}

/** Shape code is one of the cube family (the only shapes a cut part can have). */
export function isCubeShape(shape: number): boolean {
  return shape === SH_CUBE || shape === SH_AXIS || shape === SH_BEARING;
}

/**
 * Emit the visible faces of a full cube. A face is skipped when the neighbour covers it
 * (any OPAQUE cube does), or when both cells are the same self-culling non-opaque cube
 * (glass-glass, ice-ice, leaves-leaves). M1's code: used for every cube of a job without
 * layers, and in a layered job for a cube with no partial cell among its 26 neighbours.
 */
export function emitCube(ctx: MeshContext, p: number, x: number, y: number, z: number, cell: number, id: number, shape: number): void {
  const cells = ctx.cells;
  const ds = ctx.dirStride;
  const selfCull = (INFO[id]! & INFO_SELF_CULL) !== 0;
  let started = false;
  let state = 0;
  for (let d = 0; d < 6; d++) {
    const nid = cells[p + ds[d]!]! & ID_MASK;
    if ((INFO[nid]! & (1 << (d ^ 1))) !== 0) continue;
    if (selfCull && nid === id) continue;
    if (!started) {
      // Deferred until the first visible face: buried cubes cost six table reads only.
      started = true;
      ctx.setBox(0, 0, 0, 1, 1, 1);
      ctx.useUvRect = false;
      state = (cell >>> STATE_SHIFT) & STATE_MASK;
    }
    ctx.boxFace(ctx.groups[GROUP[id]!]!, p, x, y, z, d, cubeTile(id, shape, state, d), cubeRot(shape, state, d), BASE_FLAGS[id]!, true);
  }
}

/**
 * True when none of the nine cells in front of face d of the cell at padded index p (the cell
 * p + d and its eight neighbours in that layer: the cells M1 samples for the face's corners) is
 * partial. Layered jobs only.
 */
function frontClear(ctx: MeshContext, p: number, d: number): boolean {
  const partial = ctx.partial;
  const f = p + ctx.dirStride[d]!;
  const sr = ctx.axisStride[FACE_R_AXIS[d]!]!;
  const su = ctx.axisStride[FACE_U_AXIS[d]!]!;
  for (let b = -1; b <= 1; b++) {
    const row = f + b * su;
    if ((partial[row - sr]! | partial[row]! | partial[row + sr]!) !== 0) return false;
  }
  return true;
}

/**
 * A whole cube (no holes, no second part) of a layered job with a partial cell among its 26
 * neighbours. The path is chosen per face (docs/SHAPES.md 8.2): a face whose nine cells in front
 * are all without parts is M1's face, byte for byte; any other face is drawn quadrant by quadrant
 * through the octant path (emitPartFace with the four octants on that side).
 */
export function emitCubeMixed(ctx: MeshContext, p: number, x: number, y: number, z: number, cell: number, id: number, shape: number): void {
  const cells = ctx.cells;
  const ds = ctx.dirStride;
  const selfCull = (INFO[id]! & INFO_SELF_CULL) !== 0;
  const state = (cell >>> STATE_SHIFT) & STATE_MASK;
  for (let d = 0; d < 6; d++) {
    if (!frontClear(ctx, p, d)) {
      emitPartFace(ctx, p, x, y, z, id, shape, state, HALF_FILL[d]!, d);
      continue;
    }
    const nid = cells[p + ds[d]!]! & ID_MASK;
    if ((INFO[nid]! & (1 << (d ^ 1))) !== 0) continue;
    if (selfCull && nid === id) continue;
    ctx.setBox(0, 0, 0, 1, 1, 1);
    ctx.useUvRect = false;
    ctx.boxFace(ctx.groups[GROUP[id]!]!, p, x, y, z, d, cubeTile(id, shape, state, d), cubeRot(shape, state, d), BASE_FLAGS[id]!, true);
  }
}

/**
 * The quarter faces toward Dir d of the octants `fill` of a cube-family part (material id in
 * state `state`) in the cell at padded index p (docs/SHAPES.md 8.2). For each octant o, the
 * octant A across its face d (in this cell, or in the neighbour for an octant on the d side)
 * decides:
 *   1. A is held by opaque material                                   -> not drawn;
 *   2. A is held by the same id and that id culls itself (glass, ice,
 *      leaves: INFO_SELF_CULL)                                        -> not drawn;
 *   3. A lies in a neighbour cell without parts whose INFO says it
 *      covers its face toward us (a snow-like slab's bottom; every
 *      opaque cube, already caught by 1)                              -> not drawn;
 *   4. otherwise drawn, as one 0.5 x 0.5 quad (MeshContext.quarterFace).
 * The same rules hold between the two parts of a cell. The tile is the material's tile for
 * direction d (top, side or bottom; logs rotated as usual), sub-rectangle from the position.
 */
export function emitPartFace(ctx: MeshContext, p: number, x: number, y: number, z: number, id: number, shape: number, state: number, fill: number, d: number): void {
  const opq = ctx.opq;
  const partial = ctx.partial;
  const cells = ctx.cells;
  const selfCull = (INFO[id]! & INFO_SELF_CULL) !== 0;
  const bit = 1 << (d >> 1);
  const positive = (d & 1) === 0;
  const nb = p + ctx.dirStride[d]!;
  const coverBit = 1 << (d ^ 1);
  let tile = -1;
  let rot = 0;
  for (let o = 0; o < 8; o++) {
    if (((fill >> o) & 1) === 0) continue;
    const onFace = ((o & bit) !== 0) === positive;
    const q = onFace ? nb : p;
    const oa = o ^ bit;
    if (((opq[q]! >> oa) & 1) !== 0) continue;
    if (selfCull && ctx.idAt(q, oa) === id) continue;
    if (onFace && partial[q] === 0 && (INFO[cells[q]! & ID_MASK]! & coverBit) !== 0) continue;
    if (tile < 0) {
      tile = cubeTile(id, shape, state, d);
      rot = cubeRot(shape, state, d);
    }
    ctx.quarterFace(ctx.groups[GROUP[id]!]!, p, x, y, z, o, d, tile, rot, BASE_FLAGS[id]!);
  }
}

/**
 * Emit one cube-family part of a partial cell (a part value: id, state, holes): every quarter face
 * of every octant it holds, direction by direction (docs/SHAPES.md 8.2: the faces of a partial
 * cell always take the octant path).
 */
export function emitPart(ctx: MeshContext, p: number, x: number, y: number, z: number, part: number): void {
  const id = part & ID_MASK;
  const shape = SHAPE[id]!;
  const state = (part >>> STATE_SHIFT) & STATE_MASK;
  const fill = ~(part >>> HOLES_SHIFT) & 0xff;
  for (let d = 0; d < 6; d++) emitPartFace(ctx, p, x, y, z, id, shape, state, fill, d);
}
