/**
 * Full cubes: plain (one tile per face), logs (stateKind 'axis') and facing cubes
 * (bearing). This is the hot path: most faces of a terrain section come through here.
 */
import * as cellBits from '../../blocks/cell';
import type { MeshContext } from './builder';
import * as tables from './tables';

// Hot-path imports are bound to module-local constants once, at module init. Module
// runners that implement ES live bindings as getter calls (the Vite/Vitest SSR transform)
// would otherwise pay a call per table read inside the meshing loops; bundles are unaffected.
const { ID_MASK, STATE_MASK, STATE_SHIFT, stateAxis, stateFacing } = cellBits;
const { BASE_FLAGS, FACE_TILE, FACING_ROT, GROUP, INFO, INFO_SELF_CULL, LOG_ROT, SH_AXIS, SH_BEARING, TILE_SLOT } = tables;

/**
 * Emit the visible faces of a full cube. A face is skipped when the neighbour covers it
 * (any OPAQUE cube does), or when both cells are the same self-culling non-opaque cube
 * (glass-glass, ice-ice, leaves-leaves).
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
    let tile: number;
    let rot = 0;
    if (shape === SH_AXIS) {
      const axis = stateAxis(state);
      tile = TILE_SLOT[id * 3 + (d >> 1 === axis ? 1 : 0)]!;
      rot = LOG_ROT[axis * 6 + d]!;
    } else if (shape === SH_BEARING) {
      const f = stateFacing(state);
      tile = TILE_SLOT[id * 3 + (d === f ? 0 : d === (f ^ 1) ? 1 : 2)]!;
      rot = FACING_ROT[f * 6 + d]!;
    } else {
      tile = FACE_TILE[id * 6 + d]!;
    }
    ctx.boxFace(ctx.groups[GROUP[id]!]!, p, x, y, z, d, tile, rot, BASE_FLAGS[id]!, true);
  }
}
